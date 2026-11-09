/**
 * 媒体预处理（SPEC-v2 §3.2 M6，渠道无关核心）：
 * - 语音：ffmpeg 转 MP3 → OpenAI 兼容 /v1/audio/transcriptions（ASR_BASE_URL/ASR_API_KEY/ASR_MODEL）；
 * - 图片：Photon（pi-durable/images/node）压缩至 ≤2000x2000；
 * - 文件：落盘 /data/inbox/{user_id}/ → inbox_files 表；
 * - recentUnbound / bindToTask：recent-inbox-files section 与任务挂载。
 * 所有失败路径都不抛出业务异常（语音未配置 → 返回提示文本，图片压缩失败 → 保存原图）。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pino from "pino";
import type { WeAgentCore } from "./core.ts";
import type { InboxFilesTable } from "./db.ts";
import { newId } from "./tasks.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "media" });

const IMAGE_LIMITS = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 } as const;

export type VoiceTranscribeResult = { text: string | null; note: string };

export class MediaService {
	constructor(private readonly core: WeAgentCore) {}

	private inboxDir(userId: string): string {
		return join(this.core.cfg.dataDir, "inbox", userId.replace(/[^\w.-]/g, "_"));
	}

	// ---------- 文件与图片 ----------

	async saveFile(userId: string, threadKey: string, filename: string, content: Buffer, mime: string): Promise<InboxFilesTable> {
		const dir = this.inboxDir(userId);
		mkdirSync(dir, { recursive: true });
		const safe = basename(filename).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_") || "file.bin";
		const path = join(dir, `${randomUUID().slice(0, 8)}_${safe}`);
		writeFileSync(path, content);
		const row: InboxFilesTable = {
			id: newId("ib"),
			user_id: userId,
			thread_key: threadKey,
			filename: safe,
			mime,
			size: content.length,
			inbox_path: path,
			bound_task_id: null,
			created_at: Date.now(),
		};
		await this.core.db.insertInto("inbox_files").values(row).execute();
		log.info({ userId, filename: safe, size: content.length }, "收件箱文件已保存");
		return row;
	}

	/** 图片落盘：Photon 压缩至 ≤2000x2000（失败保存原图）。返回行与处理备注。 */
	async saveImage(userId: string, threadKey: string, filename: string, content: Buffer, mime: string): Promise<{ row: InboxFilesTable; note: string }> {
		let bytes = content;
		let note = "";
		try {
			const { createNodePhotonImages } = await import("@earendil-works/pi-durable/images/node");
			const processor = await createNodePhotonImages({ worker: false });
			const prepared = await processor.prepare(new Uint8Array(content), mime || "image/jpeg", IMAGE_LIMITS);
			if (prepared) {
				bytes = Buffer.from(prepared.data, "base64");
				note = prepared.resized ? `已压缩 ${prepared.resized.from.width}x${prepared.resized.from.height} → ${prepared.resized.to.width}x${prepared.resized.to.height}` : "尺寸合规未压缩";
			} else {
				note = "图片无法解码，保存原图";
			}
		} catch (err) {
			log.warn({ err }, "Photon 压缩失败，保存原图");
			note = "压缩失败，保存原图";
		}
		const row = await this.saveFile(userId, threadKey, filename, bytes, mime || "image/jpeg");
		return { row, note };
	}

	// ---------- 语音（ffmpeg + ASR） ----------

	/**
	 * 语音转写：AMR → MP3（ffmpeg）→ ASR。asrReady() 为 false 时返回明确提示。
	 * wecomRecognition 优先（企微回调自带 Recognition 字段时无需 ASR）。
	 */
	async transcribeVoice(audio: Buffer, wecomRecognition?: string): Promise<VoiceTranscribeResult> {
		const recognition = (wecomRecognition ?? "").trim();
		if (recognition) return { text: recognition, note: "企微自带转写" };
		if (!this.asrReady()) {
			return { text: null, note: "语音转写服务未配置（需要 ASR_BASE_URL / ASR_API_KEY）" };
		}
		try {
			const mp3 = await this.ffmpegToMp3(audio);
			const text = await this.asrRequest(mp3);
			if (!text) return { text: null, note: "ASR 返回空结果" };
			return { text, note: "ASR 转写" };
		} catch (err) {
			log.warn({ err }, "语音转写失败");
			return { text: null, note: `语音转写失败：${err instanceof Error ? err.message : String(err)}` };
		}
	}

	asrReady(): boolean {
		const { baseUrl, apiKey } = this.core.cfg.asr;
		return !!(baseUrl && apiKey);
	}

	private ffmpegToMp3(input: Buffer): Promise<Buffer> {
		const dir = mkdtempSync(join(tmpdir(), "weagent-voice-"));
		const src = join(dir, "in.amr");
		const dst = join(dir, "out.mp3");
		writeFileSync(src, input);
		return new Promise((resolve, reject) => {
			const ff = spawn(this.core.cfg.ffmpegPath, ["-y", "-i", src, "-ar", "16000", "-ac", "1", "-b:a", "64k", dst], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			ff.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
			const timer = setTimeout(() => ff.kill("SIGKILL"), 30_000);
			ff.on("error", (err) => {
				clearTimeout(timer);
				reject(new Error(`ffmpeg 不可用（${this.core.cfg.ffmpegPath}）：${err.message}`));
			});
			ff.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0 && existsSync(dst)) resolve(readFileSync(dst));
				else reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-200)}`));
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					/* 忽略 */
				}
			});
		});
	}

	private async asrRequest(mp3: Buffer): Promise<string | null> {
		const { baseUrl, apiKey, model } = this.core.cfg.asr;
		const url = `${baseUrl.replace(/\/$/, "")}/audio/transcriptions`;
		const form = new FormData();
		form.append("file", new Blob([new Uint8Array(mp3)], { type: "audio/mpeg" }), "audio.mp3");
		form.append("model", model);
		const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form });
		if (!res.ok) throw new Error(`ASR HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		const body = (await res.json()) as { text?: string };
		return (body.text ?? "").trim() || null;
	}

	// ---------- recent-inbox-files 与任务挂载 ----------

	/** 用户最近 windowMs 内未绑定任务的收件箱文件（recent-inbox-files section）。 */
	async recentUnbound(userId: string, windowMs = 10 * 60_000): Promise<InboxFilesTable[]> {
		const rows = await this.core.db.selectFrom("inbox_files").where("user_id", "=", userId).where("bound_task_id", "is", null).orderBy("created_at", "desc").limit(10).selectAll().execute();
		return rows.filter((r) => Date.now() - r.created_at <= windowMs);
	}

	async renderRecentInbox(userId: string): Promise<string | undefined> {
		const rows = await this.recentUnbound(userId);
		if (rows.length === 0) return undefined;
		return [
			"用户最近上传但尚未绑定任务的收件箱文件（route_decision accept 时可用 attach_inbox_files 绑定，派发后自动挂载到任务工作区 inbox/）：",
			...rows.map((r) => `- ${r.filename} (${r.size}B, inbox_id=${r.id})`),
		].join("\n");
	}

	/** 把收件箱文件挂载到任务工作区 /data/tasks/{id}/inbox/ 并标记已绑定。 */
	async bindToTask(taskId: number, inboxIds: string[]): Promise<string[]> {
		const out: string[] = [];
		for (const id of inboxIds) {
			const row = await this.core.db.selectFrom("inbox_files").where("id", "=", id).selectAll().executeTakeFirst();
			if (!row || row.bound_task_id) continue;
			const dir = join(this.core.cfg.dataDir, "tasks", String(taskId), "inbox");
			mkdirSync(dir, { recursive: true });
			const dest = join(dir, row.filename);
			try {
				copyFileSync(row.inbox_path, dest);
			} catch (err) {
				log.warn({ inboxId: id, err }, "挂载收件箱文件失败");
				continue;
			}
			await this.core.db.updateTable("inbox_files").set({ bound_task_id: taskId }).where("id", "=", id).execute();
			out.push(dest);
		}
		return out;
	}
}
