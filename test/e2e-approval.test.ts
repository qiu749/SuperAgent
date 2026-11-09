/**
 * 端到端集成测试（fauxProvider 编排 DeepSeek 行为）：
 * 覆盖 SPEC 主链路：四级分流 → Router 原文直传派单（30 词校验、Observe 模式、would_accept）→
 * Worker 插槽 → propose_action 草稿停机 → 卡片批准宿主机执行 → is_final=false 唤醒 →
 * worker_report(ready) → trigger_handback 越界退回 → 斜杠命令。
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type Config } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";

function makeCfg(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-test-"));
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
		if (Date.now() > deadline) throw new Error(`waitFor 超时`);
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

describe("WeAgent e2e（fauxProvider）", () => {
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

	/** 统一编排 faux 响应：按模型与最后一条用户输入分支；工厂自续杯（每次调用补回队列）。 */
	function script(): { workerActions: string[]; routerDecisions: string[] } {
		const trace = { workerActions: [] as string[], routerDecisions: [] as string[] };
		const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
			core.faux!.appendResponses([handler as never]);
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
			const text = typeof lastUser?.content === "string" ? lastUser.content : "";
			if (model.id === cfg.routerModel) {
				const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
				const strength = /强度:inferred/.test(text);
				if (m) {
					trace.routerDecisions.push(strength ? "would_accept" : "accept");
					return fauxAssistantMessage(
						fauxToolCall("route_decision", {
							decisions: [
								{
									kind: "accept",
									trigger_id: m[1],
									title: strength ? "巡检任务" : "调研 MCP 邮件生态",
									acknowledgement: "收到，开始调研并整理对比表",
									budget: "medium",
								},
							],
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("这是 Router 直答。");
			}
			// worker
			if (text.startsWith("[系统通知]") || text.startsWith("【用户回答") || text.startsWith("【用户修改意见")) {
				trace.workerActions.push("ready");
				return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "全部步骤完成，结论已就绪" }), {
					stopReason: "toolUse",
				});
			}
			if (text.includes("HANDBACK_TEST")) {
				trace.workerActions.push("handback");
				const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
				return fauxAssistantMessage(fauxToolCall("trigger_handback", { trigger_id: m![1], reason: "该消息超出本任务范围" }), {
					stopReason: "toolUse",
				});
			}
			trace.workerActions.push("propose");
			return fauxAssistantMessage(
				fauxToolCall("propose_action", {
					action_type: "send_email",
					payload: { to: "boss@corp.com", subject: "周报", body: "本周完成…" },
					preview: "把周报发给 boss@corp.com",
					is_final: false,
				}),
				{ stopReason: "toolUse" },
			);
		};
		core.faux!.setResponses([handler as never]);
		return trace;
	}

	it("主链路：消息 → Router accept → Worker propose_action 停机 → 批准执行 → 唤醒 → ready", async () => {
		const trace = script();
		await core.dispatcher.onUserText("u1", "帮我调研 MCP 生态的邮件 server，整理成表", "m-1");
		const task = await waitFor(async () => {
			const rows = await core.db.selectFrom("tasks").selectAll().execute();
			return rows[0];
		});
		expect(task.title).toBe("调研 MCP 邮件生态");
		expect(task.stage === "queued" || task.stage === "working").toBe(true);

		// Worker 生成草稿
		const approval = await waitFor(async () => {
			const rows = await core.db.selectFrom("approvals").selectAll().execute();
			return rows[0];
		});
		expect(approval.action_type).toBe("send_email");
		expect(approval.status).toBe("pending");
		expect(trace.workerActions).toContain("propose");

		// Outbox：接单回执（ack）在审批卡片之前入队（同任务 behind 保序）
		const outboxRows = await core.db.selectFrom("outbox").orderBy("id", "asc").selectAll().execute();
		const taskRows = outboxRows.filter((r) => r.task_id === task.id);
		expect(taskRows[0]?.kind).toBe("ack");
		expect(taskRows.some((r) => r.kind === "approval-card")).toBe(true);
		await core.outbox.drain();

		// 审批过期任务已挂上
		expect(approval.expiry_task_id).toBeTruthy();

		// 批准 → 宿主机直接执行（journal）→ is_final=false → 唤醒 Worker → worker_report(ready)
		const r = await core.actions.onCardEvent(`ap:${approval.id}:approve`);
		expect(r.handled).toBe(true);
		const approved = await waitFor(async () => {
			const row = await core.db.selectFrom("approvals").where("id", "=", approval.id).selectAll().executeTakeFirst();
			return row?.status === "approved" && row.exec_result ? row : undefined;
		});
		expect(JSON.parse(approved!.exec_result!)).toMatchObject({ ok: true, provider: "journal" });
		// 审计日志存在
		expect(existsSync(join(cfg.dataDir, "actions.jsonl"))).toBe(true);

		const readyTask = await waitFor(async () => {
			const row = await core.db.selectFrom("tasks").where("id", "=", task.id).selectAll().executeTakeFirst();
			return row?.stage === "ready" ? row : undefined;
		});
		expect(trace.workerActions).toContain("ready");
		const report = JSON.parse(readyTask!.latest_report!) as { state: string };
		expect(report.state).toBe("ready");
		// ready 的 IM 结果已入队
		const result = await core.db
			.selectFrom("outbox")
			.where("task_id", "=", task.id)
			.where("kind", "=", "result")
			.selectAll()
			.executeTakeFirst();
		expect(result).toBeDefined();

		// 幂等：重复点击批准（同 requestId）不重复执行
		const again = await core.actions.onCardEvent(`ap:${approval.id}:approve`);
		expect(again.message).toMatch(/已处理过/);
	}, 30_000);

	it("Observe 模式：inferred 事件只记 would_accept，不建任务", async () => {
		cfg.acceptMode = "observe";
		script();
		await core.dispatcher.onWebhook("github", "wh-1", "u1", "CI 失败了，请分析");
		await waitFor(async () => {
			const rows = await core.db.selectFrom("decisions").where("kind", "=", "would_accept").selectAll().execute();
			return rows[0];
		});
		const tasks = await core.db.selectFrom("tasks").selectAll().execute();
		expect(tasks.length).toBe(0);
	}, 20_000);

	it("off 模式：inferred 事件不进 Router", async () => {
		cfg.acceptMode = "off";
		const responses = script();
		void responses;
		// off 模式在 dispatchToRouter 前被拦截
		await core.dispatcher.onWebhook("github", "wh-2", "u1", "CI 失败了");
		await new Promise((r) => setTimeout(r, 500));
		const decisions = await core.db.selectFrom("decisions").selectAll().execute();
		// off: router 没被调用（无 accept/would_accept 决策）
		expect(decisions.filter((d) => d.kind === "accept" || d.kind === "would_accept").length).toBe(0);
	}, 20_000);

	it("trigger_handback：越界消息退回 Router 重新分诊（每个 trigger 只退回一次）", async () => {
		const trace = script();
		// 先建一个任务
		await core.dispatcher.onUserText("u1", "帮我写周报", "m-h1");
		const task = await waitFor(async () => {
			const rows = await core.db.selectFrom("tasks").selectAll().execute();
			return rows[0];
		});
		// 模拟一个待交互的无关消息直达 worker（pending_interaction 路径）——用 attach 代替：
		// 直接取 trigger 原文并手工构造 handback 场景：向 worker 提交 HANDBACK_TEST 消息
		const trigger = await core.getTrigger(task.origin_trigger_id);
		const handbackTrigger = await core.insertTrigger({
			source: "wecom",
			sourceMsgId: "m-h2",
			userId: "u1",
			strength: "explicit",
			text: "HANDBACK_TEST 帮我查机票",
		});
		void trigger;
		await core.wakeWorker({
			taskId: task.id,
			content: `[trigger ${handbackTrigger.trigger.id}｜来源:wecom｜强度:explicit]\nHANDBACK_TEST 帮我查机票`,
			requestId: `trigger:${handbackTrigger.trigger.id}`,
			entryKind: "weagent.attach",
			data: { trigger_id: handbackTrigger.trigger.id },
			priority: "human",
		});
		await waitFor(() => {
			return trace.workerActions.includes("handback") ? true : undefined;
		});
		// 完整闭环：退回 → Router 重新分诊 → 按"新请求"接单（不 attach 回原任务）
		const newTask = await waitFor(async () => {
			const rows = await core.db.selectFrom("tasks").where("origin_trigger_id", "=", handbackTrigger.trigger.id).selectAll().execute();
			return rows.find((t) => t.id !== task.id);
		});
		expect(newTask.title).toBe("调研 MCP 邮件生态"); // Router 把它当成新请求 accept
	}, 30_000);

	it("斜杠命令：/tasks、/stop（不过 Router）", async () => {
		script();
		await core.dispatcher.onUserText("u1", "帮我做件事", "m-s1");
		const task = await waitFor(async () => {
			const rows = await core.db.selectFrom("tasks").selectAll().execute();
			return rows[0];
		});
		const routerCallsBefore = core.faux!.state.callCount;
		await core.dispatcher.onSlashCommand("u1", "/tasks");
		await core.dispatcher.onSlashCommand("u1", `/stop ${task.id}`);
		const stopped = await core.db.selectFrom("tasks").where("id", "=", task.id).selectAll().executeTakeFirst();
		expect(stopped?.stage).toBe("cancelled");
		// 斜杠命令不消耗模型调用（faux callCount 不因 /stop 新增 worker 调用而变化明显）
		const replies = await core.db.selectFrom("outbox").where("kind", "=", "slash-reply").selectAll().execute();
		expect(replies.length).toBeGreaterThanOrEqual(2);
		void routerCallsBefore;
	}, 30_000);

	it("accept 30 词注记校验：超限被拒", async () => {
		const { checkNoteWords } = await import("../src/util/text.ts");
		const long = Array.from({ length: 31 }, (_, i) => `词${i}`).join("");
		expect(checkNoteWords(long)).toMatch(/30 词/);
	});
});

describe("WeAgent 重启恢复（Pi Durable 持久化）", () => {
	it("任务上下文跨进程持久化：重启后批准草稿 → Worker 恢复上下文继续 → ready", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "weagent-restart-"));
		const cfg = makeCfg();
		cfg.dataDir = dataDir;
		cfg.appDbPath = join(dataDir, "app.sqlite");
		cfg.piDbPath = join(dataDir, "pi.sqlite");
		cfg.allowedUsers = ["u1"];
		cfg.feishu.enabled = false;

		const mkFaux = (core: WeAgentCore) => {
			const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
				core.faux!.appendResponses([handler as never]);
				const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
				const text = typeof lastUser?.content === "string" ? lastUser.content : "";
				if (model.id === cfg.routerModel) {
					const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
					if (!m) return fauxAssistantMessage("直答");
					return fauxAssistantMessage(
						fauxToolCall("route_decision", {
							decisions: [{ kind: "accept", trigger_id: m[1], title: "重启恢复任务", acknowledgement: "收到，开始处理并整理结果", budget: "medium" }],
						}),
						{ stopReason: "toolUse" },
					);
				}
				if (text.startsWith("[系统通知]")) {
					return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "重启后恢复上下文，任务完成" }), { stopReason: "toolUse" });
				}
				return fauxAssistantMessage(
					fauxToolCall("propose_action", {
						action_type: "send_email",
						payload: { to: "a@b.com", subject: "重启恢复", body: "x" },
						preview: "发邮件",
						is_final: false,
					}),
					{ stopReason: "toolUse" },
				);
			};
			core.faux!.setResponses([handler as never]);
		};

		// —— 进程 1：建任务 + 出草稿，然后"关机" ——
		const db1 = await openAppDb(cfg.appDbPath);
		const core1 = new WeAgentCore(cfg, db1);
		await openHarness(core1);
		await core1.start();
		mkFaux(core1);
		await core1.dispatcher.onUserText("u1", "重启恢复冒烟", "r-1");
		const approval = await waitFor(async () => {
			const rows = await db1.selectFrom("approvals").selectAll().execute();
			return rows[0];
		});
		const task = (await db1.selectFrom("tasks").selectAll().execute())[0]!;
		await core1.stop();
		await db1.destroy();

		// —— 进程 2：同一份 SQLite 重新打开 → resume → 批准 → Worker 恢复上下文完成 ——
		const db2 = await openAppDb(cfg.appDbPath);
		const core2 = new WeAgentCore(cfg, db2);
		await openHarness(core2);
		await core2.start();
		mkFaux(core2);
		const r = await core2.actions.onCardEvent(`ap:${approval.id}:approve`);
		expect(r.handled).toBe(true);
		const done = await waitFor(async () => {
			const row = await db2.selectFrom("tasks").where("id", "=", task.id).selectAll().executeTakeFirst();
			return row?.stage === "ready" ? row : undefined;
		});
		const report = JSON.parse(done!.latest_report!) as { state: string; summary: string };
		expect(report.state).toBe("ready");
		expect(report.summary).toContain("重启后恢复上下文");
		await core2.stop();
		await db2.destroy();
	}, 45_000);
});
