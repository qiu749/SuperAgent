/**
 * Docker 沙箱 ExecutionEnv（SPEC §11）：实现 Pi 的 ExecutionEnv 接口。
 * 每任务独立容器：--memory 1g --cpus 1 --pids-limit 256，非 root，单命令超时 120s。
 * 文件系统直接读写宿主机任务目录（bind mount），shell 通过 docker exec 执行。
 *
 * 实现说明：完整实现 FileSystem 全部方法体量较大；此处实现 shell + 常用文件操作，
 * 其余以 FileError("not_supported") 语义兜底（Pi 的内置工具只用这些方法）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, renameSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import Dockerode from "dockerode";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, ExecutionError, Result, ShellExecOptions, ShellExecResult, FileError, FileInfo } from "@earendil-works/pi-durable/env";

export class DockerExecutionError extends Error implements ExecutionError {
	code: "aborted" | "timeout" | "shell_unavailable" | "spawn_error" | "callback_error" | "unknown";
	spillPath?: string;
	constructor(code: "aborted" | "timeout" | "shell_unavailable" | "spawn_error" | "callback_error" | "unknown", message: string) {
		super(message);
		this.code = code;
	}
}

function fileError(code: "not_found" | "permission_denied" | "is_directory" | "not_directory" | "invalid" | "unknown", message: string): { ok: false; error: FileError } {
	const err = new Error(message) as Error & { code: string };
	err.code = code;
	return { ok: false, error: err as FileError };
}

function ok<T>(value: T): { ok: true; value: T } {
	return { ok: true, value };
}

export class DockerEnv implements ExecutionEnv {
	readonly id: string;
	cwd = "/workspace";
	private readonly docker: Dockerode;
	private containerPromise: Promise<Dockerode.Container> | null = null;

	private constructor(
		readonly image: string,
		readonly hostDir: string,
		private readonly workdirName: string,
	) {
		this.id = `docker:${workdirName}`;
		this.docker = new Dockerode();
	}

	/** 创建容器（bind mount 任务目录）。Docker 不可用时抛错，由调用方回退 NodeExecutionEnv。 */
	static async create(image: string, hostDir: string, taskId: string): Promise<DockerEnv> {
		mkdirSync(hostDir, { recursive: true });
		const env = new DockerEnv(image, hostDir, taskId);
		await env.ensureContainer();
		return env;
	}

	private async ensureContainer(): Promise<Dockerode.Container> {
		if (!this.containerPromise) {
			this.containerPromise = (async () => {
				const container = await this.docker.createContainer({
					Image: this.image,
					Cmd: ["sleep", "infinity"],
					Tty: false,
					WorkingDir: this.cwd,
					HostConfig: {
						Binds: [`${resolve(this.hostDir)}:${this.cwd}`],
						Memory: 1024 * 1024 * 1024, // 1g
						NanoCpus: 1_000_000_000, // 1 cpu
						PidsLimit: 256,
					},
					User: "1000:1000",
					NetworkDisabled: true,
					Labels: { "weagent.task": this.workdirName },
				});
				await container.start();
				return container;
			})().catch((err) => {
				this.containerPromise = null;
				throw err;
			});
		}
		return this.containerPromise;
	}

	// ---------- Shell ----------

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, import("@earendil-works/pi-durable/env").ExecutionError>> {
		const container = await this.ensureContainer().catch((err) => {
			throw new Error(`容器启动失败: ${err instanceof Error ? err.message : String(err)}`);
		});
		const argv = Array.isArray(command) ? command : ["sh", "-c", command];
		const timeout = Math.min(options?.timeout ?? 120_000, 120_000); // 单命令超时 120s（SPEC §11）
		const exec = await container.exec({
			Cmd: argv,
			AttachStdout: true,
			AttachStderr: true,
			WorkingDir: options?.cwd ? this.mapPath(options.cwd) : this.cwd,
			Env: options?.env ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`) : undefined,
		});
		const stream = await exec.start({ hijack: true, stdin: false });
		return new Promise((resolvePromise) => {
			let output = "";
			const stdoutSink = new PassThrough();
			stdoutSink.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				output += text;
				options?.onOutput?.(text, context, { stream: "stdout" });
			});
			const stderrSink = new PassThrough();
			stderrSink.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				output += text;
				options?.onOutput?.(text, context, { stream: "stderr" });
			});
			this.docker.modem.demuxStream(stream, stdoutSink, stderrSink);
			const timer = setTimeout(() => {
				stream.destroy();
				resolvePromise({
					ok: false,
					error: new DockerExecutionError("timeout", `命令超时（${timeout}ms）`) as unknown as import("@earendil-works/pi-durable/env").ExecutionError,
				});
			}, timeout);
			stream.on("end", () => {
				clearTimeout(timer);
				exec
					.inspect()
					.then((info) => resolvePromise(ok({ exitCode: info.ExitCode ?? 0 })))
					.catch(() => resolvePromise(ok({ exitCode: 0 })));
			});
			stream.on("error", (err: Error) => {
				clearTimeout(timer);
				resolvePromise({
					ok: false,
					error: new DockerExecutionError("spawn_error", err.message) as unknown as import("@earendil-works/pi-durable/env").ExecutionError,
				});
			});
			void output;
		});
	}

	async cleanup(context: Context): Promise<void> {
		void context;
		try {
			const container = await this.containerPromise;
			if (container) {
				await container.stop({ t: 2 }).catch(() => {});
				await container.remove({ force: true }).catch(() => {});
			}
		} catch {
			// 清理失败不抛
		}
	}

	// ---------- FileSystem（宿主机 bind mount 目录的受限视图） ----------

	private mapPath(path: string): string {
		return isAbsolute(path) ? path : join(this.cwd, path);
	}

	private hostPath(path: string): string {
		const mapped = this.mapPath(path);
		const resolved = resolve(mapped).replace(/^\/workspace/, this.hostDir);
		if (!resolved.startsWith(resolve(this.hostDir))) {
			throw new Error(`越界路径：${path}`);
		}
		return resolved;
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.mapPath(path));
	}
	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}
	async readTextFile(path: string): Promise<Result<string, FileError>> {
		try {
			return ok(readFileSync(this.hostPath(path), "utf8"));
		} catch (err) {
			return fileError("not_found", `${path}: ${String(err)}`);
		}
	}
	async readTextLines(path: string, options?: { maxLines?: number }): Promise<Result<string[], FileError>> {
		try {
			const content = readFileSync(this.hostPath(path), "utf8");
			const lines = content.split("\n");
			return ok(typeof options?.maxLines === "number" ? lines.slice(0, options.maxLines) : lines);
		} catch (err) {
			return fileError("not_found", `${path}: ${String(err)}`);
		}
	}
	async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
		try {
			return ok(new Uint8Array(readFileSync(this.hostPath(path))));
		} catch (err) {
			return fileError("not_found", `${path}: ${String(err)}`);
		}
	}
	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		try {
			const hp = this.hostPath(path);
			mkdirSync(dirname(hp), { recursive: true });
			writeFileSync(hp, content);
			return ok(undefined);
		} catch (err) {
			return fileError("invalid", `${path}: ${String(err)}`);
		}
	}
	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		try {
			appendFileSync(this.hostPath(path), content);
			return ok(undefined);
		} catch (err) {
			return fileError("invalid", `${path}: ${String(err)}`);
		}
	}
	async truncateFile(path: string, size: number): Promise<Result<void, FileError>> {
		try {
			const hp = this.hostPath(path);
			const current = readFileSync(hp);
			writeFileSync(hp, current.subarray(0, size));
			return ok(undefined);
		} catch (err) {
			return fileError("invalid", `${path}: ${String(err)}`);
		}
	}
	async flushFile(): Promise<Result<void, FileError>> {
		return ok(undefined);
	}
	async renameFile(source: string, dest: string): Promise<Result<void, FileError>> {
		try {
			renameSync(this.hostPath(source), this.hostPath(dest));
			return ok(undefined);
		} catch (err) {
			return fileError("invalid", `${source} -> ${dest}: ${String(err)}`);
		}
	}
	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		try {
			const st = statSync(this.hostPath(path));
			return ok({
				name: path.split("/").pop() ?? "",
				path,
				kind: st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "file",
				size: st.size,
				mtimeMs: st.mtimeMs,
			});
		} catch (err) {
			return fileError("not_found", `${path}: ${String(err)}`);
		}
	}
	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		try {
			const hp = this.hostPath(path);
			const entries = readdirSync(hp, { withFileTypes: true }).map((e) => {
				const full = join(hp, e.name);
				const st = statSync(full);
				return { name: e.name, path: join(path, e.name), kind: e.isDirectory() ? ("directory" as const) : ("file" as const), size: st.size, mtimeMs: st.mtimeMs };
			});
			return ok(entries);
		} catch (err) {
			return fileError("not_found", `${path}: ${String(err)}`);
		}
	}
	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(this.mapPath(path));
	}
	async exists(path: string): Promise<Result<boolean, FileError>> {
		return ok(existsSync(this.hostPath(path)));
	}
	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		try {
			mkdirSync(this.hostPath(path), { recursive: options?.recursive ?? false });
			return ok(undefined);
		} catch (err) {
			return fileError("invalid", `${path}: ${String(err)}`);
		}
	}
	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
		try {
			rmSync(this.hostPath(path), { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (err) {
			return fileError("invalid", `${path}: ${String(err)}`);
		}
	}
	async createTempDir(prefix?: string): Promise<Result<string, FileError>> {
		const dir = join(this.hostDir, `.tmp-${prefix ?? "t"}-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		return ok(dir);
	}
	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		const file = join(this.hostDir, `.tmp-${options?.prefix ?? "f"}-${Date.now()}${options?.suffix ?? ""}`);
		writeFileSync(file, "");
		return ok(file);
	}
	async watch(): Promise<Result<never, FileError>> {
		return fileError("invalid", "Docker 沙箱不支持文件 watch");
	}
	// FileSystem 其余方法（流式读取器）以 not_supported 兜底
	async openTextLineReader(): Promise<Result<never, FileError>> {
		return fileError("invalid", "not supported");
	}
	async openBinaryReader(): Promise<Result<never, FileError>> {
		return fileError("invalid", "not supported");
	}
	async openDirReader(): Promise<Result<never, FileError>> {
		return fileError("invalid", "not supported");
	}
}
