/**
 * M10 H5 待办中心 API 集成测试（SPEC-v2 §10）：dev 免登 → overview →
 * 改 payload 批准 → 批量批准 → 轨迹 → 记忆/习惯 → 放权策略 → Observe 影子日志与一键补建。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type Config } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";
import { startHttp } from "../src/http/server.ts";

function makeCfg(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-panel-"));
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
	cfg.acceptMode = "observe";
	cfg.maxWorkers = 3;
	cfg.port = 0; // 随机端口
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

describe("M10 H5 待办面板 API", () => {
	let core!: WeAgentCore;
	let cfg!: Config;
	let cleanup!: () => Promise<void>;
	let cookie = "";
	let baseUrl = "";

	beforeEach(async () => {
		cfg = makeCfg();
		const db = await openAppDb(cfg.appDbPath);
		core = new WeAgentCore(cfg, db);
		await openHarness(core);
		await core.start();
		const { server } = startHttp(core);
		await new Promise((r) => setTimeout(r, 200));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 8000;
		baseUrl = `http://127.0.0.1:${port}`;
		cleanup = async () => {
			server.close();
			await db.destroy();
		};
	});

	afterEach(async () => {
		await core.stop().catch(() => {});
		await cleanup();
	});

	function script(): void {
		const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
			core.faux!.appendResponses([handler as never]);
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
			const text = typeof lastUser?.content === "string" ? lastUser.content : "";
			if (model.id === cfg.routerModel) {
				const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
				if (m) {
					return fauxAssistantMessage(
						fauxToolCall("route_decision", { decisions: [{ kind: "accept", trigger_id: m[1], title: "调研 MCP 邮件生态", acknowledgement: "收到，开始调研并整理对比表", budget: "medium" }] }),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Router 直答。");
			}
			if (text.startsWith("[系统通知]")) {
				return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "完成" }), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(
				fauxToolCall("propose_action", {
					action_type: "send_email",
					scope_key: "domain:corp.com",
					payload: { to: "boss@corp.com", subject: "周报", body: "本周完成…" },
					preview: "把周报发给 boss@corp.com",
					is_final: true,
				}),
				{ stopReason: "toolUse" },
			);
		};
		core.faux!.setResponses([handler as never]);
	}

	async function api(path: string, opts: RequestInit = {}) {
		const r = await fetch(`${baseUrl}${path}`, { headers: { "content-type": "application/json", cookie }, ...opts });
		return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
	}

	it("免登 → overview 拍板 → 改 payload 批准 → 轨迹与记忆 → 放权与 Observe 补建", async () => {
		// 未登录 → 401
		expect((await api("/api/panel/overview")).status).toBe(401);
		// dev 免登（dryRun）：303 种 Cookie 后跳回 /panel
		const authRes = await fetch(`${baseUrl}/api/panel/auth?dev_user=u1`, { redirect: "manual" });
		expect(authRes.status).toBe(303);
		expect(authRes.headers.get("location")).toBe("/panel");
		cookie = (authRes.headers.get("set-cookie") ?? "").split(";")[0];
		expect(cookie).toContain("wa_panel=");

		// 造一个待审批草稿（observe 模式下 inferred 记 would_accept；先切 auto 走完整流）
		script();
		await api("/api/panel/observe", { method: "PATCH", body: JSON.stringify({ acceptMode: "auto" }) });
		await core.dispatcher.onUserText("u1", "帮我调研 MCP 生态的邮件 server", "m-1");
		await waitFor(async () => (await core.db.selectFrom("approvals").selectAll().executeTakeFirst()) ?? undefined);

		// overview 置顶显示草稿
		const overview = (await api("/api/panel/overview")).body as unknown as { pendingApprovals: { id: string; payload: Record<string, unknown>; preview: string }[]; workerSlots: Record<string, number> };
		expect(overview.pendingApprovals).toHaveLength(1);
		const ap = overview.pendingApprovals[0];
		expect(ap.id).toBe("A001");
		expect(core.slots.usedSlots).toBeLessThanOrEqual(3);

		// 原地改 payload 后批准 → 执行用的就是新参数
		const modified = { ...ap.payload, to: "boss2@corp.com" };
		const decided = await api(`/api/panel/approvals/${ap.id}/decide`, { method: "POST", body: JSON.stringify({ action: "approve", payload: modified }) });
		expect(decided.status).toBe(200);
		const row = await core.db.selectFrom("approvals").where("id", "=", "A001").selectAll().executeTakeFirst();
		expect(row?.status).toBe("approved");
		expect((JSON.parse(row!.payload!) as { to: string }).to).toBe("boss2@corp.com");
		expect(row!.user_edit_feedback).toContain("面板");

		// 批量批准（空操作幂等）
		const batch = await api("/api/panel/approvals/batch-approve", { method: "POST", body: JSON.stringify({ ids: ["A001"] }) });
		expect((batch.body as { results: unknown[] }).results).toHaveLength(1);

		// 任务与轨迹
		const tasks = (await api("/api/panel/tasks")).body as unknown as { id: number; title: string }[];
		expect(tasks[0].title).toBe("调研 MCP 邮件生态");
		const trace = (await api(`/api/panel/tasks/${tasks[0].id}/transcript`)).body as unknown as { lines: { role: string; text: string; tool?: string }[] };
		expect(trace.lines.length).toBeGreaterThan(0);
		expect(trace.lines.some((l) => l.role === "tool" && l.tool === "propose_action")).toBe(true);

		// 记忆：新增 + 列表
		await api("/api/panel/memories", { method: "POST", body: JSON.stringify({ text: "用户偏好邮件正文控制在 3 段内" }) });
		const mem = (await api("/api/panel/memories")).body as unknown as { memories: { id: string; memory: string }[]; habits: unknown[]; skills: unknown[] };
		expect(mem.memories.some((m) => m.memory.includes("3 段内"))).toBe(true);
		expect(Array.isArray(mem.habits)).toBe(true);
		expect(Array.isArray(mem.skills)).toBe(true);

		// 放权策略：批准过一次 A001 → 计数 1，可在面板切换模式
		const policies = (await api("/api/panel/trust-policies")).body as unknown as { id: string; mode: string; consecutive_approvals: number }[];
		const policy = policies.find((p) => p.consecutive_approvals >= 1);
		expect(policy).toBeDefined();
		const patched = await api("/api/panel/trust-policies", { method: "PATCH", body: JSON.stringify({ id: policy!.id, mode: "digest" }) });
		expect(patched.status).toBe(200);
		expect(((await api("/api/panel/trust-policies")).body as unknown as { mode: string }[])[0].mode).toBe("digest");

		// Observe：影子日志（把 acceptMode 切回 observe 后喂一条 inferred webhook）
		await api("/api/panel/observe", { method: "PATCH", body: JSON.stringify({ acceptMode: "observe" }) });
		await core.dispatcher.onWebhook("github", `wh-${Date.now()}`, "u1", "CI 挂了帮我看看");
		await waitFor(async () => (await core.db.selectFrom("decisions").where("kind", "=", "would_accept").selectAll().execute()).length > 0);
		const observe = (await api("/api/panel/observe")).body as unknown as { acceptMode: string; wouldAccept: { triggerId: string; text: string }[] };
		expect(observe.acceptMode).toBe("observe");
		const shadow = observe.wouldAccept[0];
		expect(shadow.text).toContain("CI 挂了");

		// 一键补建 → 真正建单
		const promote = await api(`/api/panel/observe/${shadow.triggerId}/promote`, { method: "POST", body: "{}" });
		expect(promote.status).toBe(200);
		await waitFor(async () => (await core.db.selectFrom("tasks").selectAll().execute()).length === 2);
		const tasks2 = (await api("/api/panel/tasks")).body as unknown as { id: number }[];
		expect(tasks2).toHaveLength(2);

		// 静态页可访问
		const page = await fetch(`${baseUrl}/panel`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("WeAgent 待办中心");
	});
});
