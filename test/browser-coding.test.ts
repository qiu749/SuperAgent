/**
 * M9 集成测试（SPEC-v2 §9）：git worktree 编码工作区、gh PR 执行器优雅降级、
 * 远程协助 token 签名/校验、浏览器可执行文件探测。
 */
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type Config } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";

function makeCfg(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-m9-"));
	const cfg = loadConfig();
	cfg.dataDir = dataDir;
	cfg.appDbPath = join(dataDir, "app.sqlite");
	cfg.piDbPath = join(dataDir, "pi.sqlite");
	cfg.wecom.dryRun = true;
	cfg.allowedUsers = ["u1"];
	cfg.feishu.enabled = false;
	cfg.modelProvider = "faux";
	cfg.routerModel = "router-test";
	cfg.workerModel = "worker-test";
	cfg.mem0Mode = "off";
	cfg.acceptMode = "auto";
	cfg.maxWorkers = 3;
	return cfg;
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15000, stepMs = 100): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v !== undefined && v !== null && v !== false) return v as T;
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

describe("M9 浏览器与编码子 Agent", () => {
	let core!: WeAgentCore;
	let cfg!: Config;
	let cleanup!: () => Promise<void>;

	beforeEach(async () => {
		cfg = makeCfg();
		const db = await openAppDb(cfg.appDbPath);
		core = new WeAgentCore(cfg, db);
		await openHarness(core);
		await core.start();
		cleanup = () => db.destroy();
	});

	afterEach(async () => {
		await core.stop();
		await cleanup();
	});

	it("delegate_coding：REPOS 配置 + git worktree 隔离工作区（幂等复用）", async () => {
		// 准备一个真实 git 仓库
		const repo = mkdtempSync(join(tmpdir(), "weagent-repo-"));
		const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
		run(["init", "-q"]);
		run(["config", "user.email", "t@t"]);
		run(["config", "user.name", "t"]);
		writeFileSync(join(repo, "README.md"), "# demo\n");
		run(["add", "."]);
		run(["commit", "-qm", "init"]);
		// 修正默认分支名（git init 默认 master/main 因版本而异）
		const head = run(["rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();

		const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
			core.faux!.appendResponses([handler as never]);
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
			const text = typeof lastUser?.content === "string" ? lastUser.content : "";
			if (model.id === cfg.routerModel) {
				const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
				if (m) {
					return fauxAssistantMessage(
						fauxToolCall("route_decision", { decisions: [{ kind: "accept", trigger_id: m[1], title: "修 bug", acknowledgement: "收到，开始修复并跑单测", budget: "medium" }] }),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("直答。");
			}
			return fauxAssistantMessage(
				fauxToolCall("delegate_coding", { repo_key: "demo", instruction: "把 README 标题改成 v1" }),
				{ stopReason: "toolUse" },
			);
		};
		core.faux!.setResponses([handler as never]);
		cfg.repos = { demo: { path: repo } };

		await core.dispatcher.onUserText("u1", "帮我修一下 demo 仓库的文档", "m-1");
		await waitFor(async () => existsSync(join(cfg.dataDir, "tasks/1/repo/README.md")));
		// worktree 与源仓库隔离：README 相同、分支为 weagent/task-1
		const wt = join(cfg.dataDir, "tasks/1/repo");
		expect(readFileSync(join(wt, "README.md"), "utf8")).toContain("# demo");
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt, stdio: "pipe" }).toString().trim();
		expect(branch).toBe(`weagent/task-1`);
		void head;
		// 幂等：再次 delegate 不报错
		const obs = await core.delegateCoding({ conversationId: Number((await core.db.selectFrom("tasks").selectAll().executeTakeFirst())!.conv_id) as never, repoKey: "demo", instruction: "再来一次" }, null as never);
		expect(obs.observation).toContain("工作区已就绪");
	});

	it("github_create_pr 执行器：gh 缺失时优雅降级返回明确错误", async () => {
		const exec = await core.actions.executePayload("github_create_pr", { repo: "owner/name", head: "weagent/task-1", title: "t", body: "b" }, "A000");
		expect(exec.ok).toBe(false);
		expect(String(exec.error)).toContain("gh");
	});

	it("远程协助 token：签名往返、过期拒绝、篡改拒绝", () => {
		const token = core.assistTokens.newToken("u1", 7, 60_000);
		const claims = core.assistTokens.verify(token);
		expect(claims?.userId).toBe("u1");
		expect(claims?.taskId).toBe(7);
		// 篡改
		expect(core.assistTokens.verify(`${token}x`)).toBeNull();
		// 过期
		const expired = core.assistTokens.sign({ userId: "u1", taskId: 7, exp: Date.now() - 1 });
		expect(core.assistTokens.verify(expired)).toBeNull();
	});

	it("浏览器可执行文件探测：本机有 ms-playwright 缓存则可解析；无缓存时报错信息带修复指引", () => {
		try {
			const path = core.browsers.resolveExecutable();
			expect(existsSync(path)).toBe(true);
		} catch (err) {
			expect(String(err)).toContain("PLAYWRIGHT_EXECUTABLE_PATH");
		}
	});
});
