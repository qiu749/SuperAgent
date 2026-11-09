/**
 * M7 集成测试（SPEC-v2 §6.3/§8，fauxProvider 编排）：
 * - Code Mode：Worker 在 QuickJS WASM 沙箱内用一段 JS 批量调用只读工具（recall）；
 * - 习惯提炼：审批【修改】→ 批准 → Diff 提炼规则落 learned_habits；
 * - 后台复盘分叉：任务 ready 后 Curator 自动沉淀 SKILL.md（fork → skill_manage → 落盘 + 索引表）。
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type Config } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";

function makeCfg(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-m7-"));
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

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 20000, stepMs = 120): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v !== undefined && v !== null && v !== false) return v as T;
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

describe("M7 Code Mode / 习惯 / 后台复盘（fauxProvider）", () => {
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

	/** 复盘 Curator 自动沉淀技能的全链路编排。 */
	it("后台复盘分叉：任务 ready → Curator skill_manage create → SKILL.md 落盘 + skills 表登记", async () => {
		const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
			core.faux!.appendResponses([handler as never]);
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
			const text = typeof lastUser?.content === "string" ? lastUser.content : "";
			if (model.id === cfg.routerModel) {
				if (text.includes("你是后台复盘 Curator")) {
					// 第一次被调用：创建一个类别级技能
					return fauxAssistantMessage(
						fauxToolCall("skill_manage", {
							operations: [
								{
									name: "research/web-search",
									action: "create",
									content: "---\nname: web-search\ndescription: Use when 需要联网调研. 先 web_search 拿线索，再 web_fetch 深读，最后写 .md 报告.\n---\n\n# 步骤\n1. web_search\n2. web_fetch\n3. 写报告\n",
								},
							],
						}),
						{ stopReason: "toolUse" },
					);
				}
				const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
				if (m) {
					return fauxAssistantMessage(
						fauxToolCall("route_decision", {
							decisions: [{ kind: "accept", trigger_id: m[1], title: "调研 MCP 邮件生态", acknowledgement: "收到，开始调研", budget: "medium" }],
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Router 直答。");
			}
			return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "调研完成，结论已就绪" }), { stopReason: "toolUse" });
		};
		core.faux!.setResponses([handler as never]);

		await core.dispatcher.onUserText("u1", "帮我调研 MCP 生态的邮件 server", "m-1");
		await waitFor(async () => (await core.db.selectFrom("tasks").selectAll().executeTakeFirst())?.stage === "ready");
		// 复盘分叉异步跑完：SKILL.md 落盘 + skills 表登记
		const skillFile = join(core.cfg.dataDir, "skills/research/web-search/SKILL.md");
		await waitFor(async () => existsSync(skillFile));
		expect(readFileSync(skillFile, "utf8")).toContain("Use when");
		const row = await waitFor(async () => (await core.db.selectFrom("skills").where("slug", "=", "research/web-search").selectAll().executeTakeFirst()) ?? undefined);
		expect(row?.status).toBe("active");
		// ledger 有审计记录
		const ledger = readFileSync(join(core.cfg.dataDir, "skills/.curator_ledger.jsonl"), "utf8");
		expect(ledger).toContain("research/web-search");
		// 复盘会话结束后 activeReviews 清空
		await waitFor(async () => (core as unknown as { activeReviews: Map<string, unknown> }).activeReviews.size === 0);
	});

	it("习惯提炼：审批【修改】→ 批准 → Diff+意见原话提炼规则落 learned_habits", async () => {
		const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
			core.faux!.appendResponses([handler as never]);
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
			const text = typeof lastUser?.content === "string" ? lastUser.content : "";
			if (model.id === cfg.routerModel) {
				if (text.includes("习惯提炼器")) {
					return fauxAssistantMessage("周报邮件固定发往 boss2@corp.com，因为用户明确把收件人从 boss@ 改成了 boss2@。");
				}
				const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
				if (m) {
					return fauxAssistantMessage(
						fauxToolCall("route_decision", {
							decisions: [{ kind: "accept", trigger_id: m[1], title: "调研 MCP 邮件生态", acknowledgement: "收到，开始调研", budget: "medium" }],
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Router 直答。");
			}
			if (text.startsWith("【用户修改意见")) {
				return fauxAssistantMessage(
					fauxToolCall("propose_action", {
						action_type: "send_email",
						scope_key: "domain:corp.com",
						payload: { to: "boss2@corp.com", subject: "周报", body: "本周完成…" },
						preview: "把周报发给 boss2@corp.com",
						is_final: false,
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (text.startsWith("[系统通知]")) {
				return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "全部步骤完成" }), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(
				fauxToolCall("propose_action", {
					action_type: "send_email",
					scope_key: "domain:corp.com",
					payload: { to: "boss@corp.com", subject: "周报", body: "本周完成…" },
					preview: "把周报发给 boss@corp.com",
					is_final: false,
				}),
				{ stopReason: "toolUse" },
			);
		};
		core.faux!.setResponses([handler as never]);

		await core.dispatcher.onUserText("u1", "帮我发周报", "m-1");
		await waitFor(async () => (await core.db.selectFrom("approvals").selectAll().execute())[0]);
		await core.actions.onCardEvent("ap:A001:edit");
		await core.dispatcher.onUserText("u1", "收件人改成 boss2@corp.com，以后都发这个邮箱");
		const v2 = await waitFor(async () => (await core.db.selectFrom("approvals").where("id", "=", "A002").selectAll().executeTakeFirst()) ?? undefined);
		expect(v2.previous_approval_id).toBe("A001");
		await core.actions.onCardEvent("ap:A002:approve");
		const habit = await waitFor(async () => (await core.db.selectFrom("learned_habits").selectAll().executeTakeFirst()) ?? undefined);
		expect(habit?.rule_text).toContain("boss2@corp.com");
		expect(habit?.action_type).toBe("send_email");
		expect(habit?.from_approval_id).toBe("A002");
	});

	it("Code Mode：QuickJS 沙箱里一段 JS 调用只读工具并完成任务（独立进程探针，生产形态）", { timeout: 90_000 }, async () => {
		// vitest 模块环境下 pi-durable CodemodeCall 的最终 commit 会挂起（沙箱本体在 vitest 内正常，
		// 纯 Node 全链路也正常——见 examples/codemode-probe.ts 头注释），因此用独立子进程验证生产形态。
		const { execFile } = await import("node:child_process");
		const root = new URL("..", import.meta.url).pathname;
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				process.execPath,
				["--experimental-transform-types", join(root, "examples/codemode-probe.ts")],
				{ timeout: 80_000, encoding: "utf8", cwd: root },
				(err, out) => {
					if (err && !out.includes("PROBE")) return reject(err);
					resolve(String(out));
				},
			);
		});
		expect(stdout).toContain("PROBE OK: task ready");
	});
});
