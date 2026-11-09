/**
 * 本地混合知识库 / 主动传感器 / 成本熔断测试（SPEC-v3 §7 M10，test/knowledge-sensors.test.ts）：
 * - Local Hybrid RAG（Markdown 切片 + sha256 幂等 + BM25/向量 RRF 融合检索）；
 * - 主动感知网关：digest 静默入池 vs immediate 幂等去重、sensor.calendar-prep 会前 15 分钟扫描；
 * - 传感器 Webhook HMAC-SHA256 验签（SENSOR_WEBHOOK_SECRET）；
 * - ModelRouter 成本记账与单任务/全天预算熔断、[预算熔断] 追问卡追加/停止。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig, type Config } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";
import { startHttp } from "../src/http/server.ts";
import { nextScanMs } from "../src/engine/tasks/calendar-sensor.ts";

function makeCfg(acceptMode: Config["acceptMode"] = "auto"): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-kb-"));
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
	cfg.acceptMode = acceptMode;
	cfg.maxWorkers = 3;
	cfg.computerDriver = "mock";
	cfg.port = 0;
	return cfg;
}

describe("M10：Hybrid RAG + 主动传感器 + 成本熔断（SPEC-v3 §3）", () => {
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
		await core.stop().catch(() => {});
		await cleanup();
	});

	it("Local Hybrid RAG：切片入库、sha256 幂等跳过与 BM25+向量 RRF 混合检索", async () => {
		const r1 = await core.knowledge.ingestText({
			sourcePath: "docs/architecture.md",
			title: "系统架构规范",
			content: "# 网关层\n采用 Hono 处理企微回调。\n\n# 存储层\n使用 SQLite WAL 模式与 FTS5 混合检索，订单号规则为 ORD-2026-9981。",
		});
		expect(r1.updated).toBe(true);
		expect(r1.chunkCount).toBe(2);
		// 相同内容二次入库 sha256 幂等跳过
		const r2 = await core.knowledge.ingestText({
			sourcePath: "docs/architecture.md",
			title: "系统架构规范",
			content: "# 网关层\n采用 Hono 处理企微回调。\n\n# 存储层\n使用 SQLite WAL 模式与 FTS5 混合检索，订单号规则为 ORD-2026-9981。",
		});
		expect(r2.updated).toBe(false);

		const hits = await core.knowledge.search("ORD-2026-9981 存储层用什么", 3);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]!.content).toContain("ORD-2026-9981");
		expect(hits[0]!.headingPath).toContain("存储层");
	});

	it("主动传感器：digest 静默入池、幂等去重与 calendar-prep 会前 15 分钟窗口扫描", async () => {
		// 1. digest 事件：静默入池零 Router 消耗；重复摄入幂等
		const sDigest = await core.sensors.ingest({
			sensorId: "github-ci",
			externalEventId: "evt-100",
			sourceTitle: "Dependabot 低优提醒",
			summary: "次要依赖更新",
			suggestedUrgency: "digest",
		});
		expect(sDigest.routedTo).toBe("digest");
		expect(sDigest.duplicate).toBe(false);
		const sDup = await core.sensors.ingest({
			sensorId: "github-ci",
			externalEventId: "evt-100",
			sourceTitle: "Dependabot 低优提醒",
			summary: "次要依赖更新",
			suggestedUrgency: "digest",
		});
		expect(sDup.duplicate).toBe(true);

		// 2. calendar-prep：10 分钟后的日程命中窗口，1 小时后的不命中；同一日程重扫幂等
		const in10min = new Date(Date.now() + 10 * 60_000).toISOString();
		const in1hour = new Date(Date.now() + 60 * 60_000).toISOString();
		writeFileSync(
			join(cfg.dataDir, "calendar.json"),
			JSON.stringify([
				{ title: "与供应商对齐交付节奏", start: in10min, location: "线上" },
				{ title: "远期评审会", start: in1hour },
			]),
		);
		const fired1 = await core.fireCalendarSensor({} as never);
		expect(fired1).toBe(1);
		const fired2 = await core.fireCalendarSensor({} as never);
		expect(fired2).toBe(0); // 同一日程 5 分钟重扫幂等去重
		const sensorRows = await core.db.selectFrom("sensor_events").where("sensor_id", "=", "calendar-prep").selectAll().execute();
		expect(sensorRows).toHaveLength(1);
		expect(sensorRows[0]!.external_event_id).toContain("calprep:");

		// 3. 5 分钟扫描边界函数
		const base = Date.UTC(2026, 10, 9, 9, 2, 0);
		expect(nextScanMs(base) % (5 * 60_000)).toBe(0);
		expect(nextScanMs(base)).toBeGreaterThan(base);
	});

	it("传感器 Webhook：配置 SENSOR_WEBHOOK_SECRET 后强制 HMAC-SHA256 验签，未配置时放行", async () => {
		core.cfg.sensorWebhookSecret = "s3cret";
		const { server } = startHttp(core);
		await new Promise((r) => setTimeout(r, 150));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 8000;
		const baseUrl = `http://127.0.0.1:${port}`;
		const payload = JSON.stringify({ external_event_id: "evt-hmac-1", title: "[GitHub] PR #42 CI 失败", summary: "main 红了", urgency: "digest" });
		const sig = createHmac("sha256", "s3cret").update(payload).digest("hex");

		try {
			// 无签名 → 401；错误签名 → 401；正确签名 → 200 且入账
			const noSig = await fetch(`${baseUrl}/webhooks/sensor/github-webhook`, { method: "POST", body: payload, headers: { "content-type": "application/json" } });
			expect(noSig.status).toBe(401);
			const badSig = await fetch(`${baseUrl}/webhooks/sensor/github-webhook`, { method: "POST", body: payload, headers: { "content-type": "application/json", "x-weagent-signature": "sha256=deadbeef" } });
			expect(badSig.status).toBe(401);
			const good = await fetch(`${baseUrl}/webhooks/sensor/github-webhook`, { method: "POST", body: payload, headers: { "content-type": "application/json", "x-weagent-signature": `sha256=${sig}` } });
			expect(good.status).toBe(200);
			const body = (await good.json()) as { ok: boolean; duplicate: boolean };
			expect(body.ok).toBe(true);
			// 同一事件重放仍 200 且标记 duplicate（幂等）
			const replay = (await (await fetch(`${baseUrl}/webhooks/sensor/github-webhook`, { method: "POST", body: payload, headers: { "content-type": "application/json", "x-weagent-signature": `sha256=${sig}` } })).json()) as { duplicate: boolean };
			expect(replay.duplicate).toBe(true);
		} finally {
			server.close();
			core.cfg.sensorWebhookSecret = "";
		}
	});

	it("ModelRouter 成本记账、单任务熔断追问卡（追加预算恢复 / 停止关单）", async () => {
		// 1. 记账与预算检查（0.5 * $1 + 0.3 * $4 = $1.70 > maxTaskCostUsd $1.50）
		await core.modelRouter.recordUsage({
			taskId: 99,
			conversationId: "1",
			role: "worker_reasoning",
			promptTokens: 500_000,
			completionTokens: 300_000,
		});
		const taskBudget = await core.modelRouter.checkBudget(99);
		expect(taskBudget.allowed).toBe(false);
		expect(taskBudget.reason).toContain("单任务成本已达上限");
		const summary = await core.modelRouter.getSummary();
		expect(summary.todayCostUsd).toBeCloseTo(1.7, 2);
		expect(summary.byRole.worker_reasoning?.calls).toBe(1);

		// 2. 建 working 任务 → 熔断触发 [预算熔断] 追问卡 + waiting_user
		const { trigger } = await core.insertTrigger({ source: "wecom", userId: "u1", strength: "explicit", text: "跑一个长任务" });
		await core.routeAccept(trigger.id, "长任务", "收到", "budget test", "large", [], BACKGROUND_CONTEXT, true);
		await new Promise((r) => setTimeout(r, 400)); // 等后台首轮跑完（faux 无响应即刻报错结束），轮末自动熔断先于手工用例执行
		const task = (await core.db.selectFrom("tasks").selectAll().executeTakeFirst())!;
		await core.modelRouter.recordUsage({ taskId: task.id, conversationId: String(task.conv_id), role: "worker_default", promptTokens: 1_000_000, completionTokens: 1_000_000, overrideCostUsd: 1.8 });
		const fused = await core.enforceTaskBudget(task.id);
		expect(fused).toBe(true);
		let t = (await core.db.selectFrom("tasks").selectAll().executeTakeFirst())!;
		expect(t.stage).toBe("waiting_user");
		const ask = (await core.db.selectFrom("asks").selectAll().execute())![0]!;
		expect(ask.question).toContain("[预算熔断]");
		expect(ask.status).toBe("pending");

		// 3. 用户点【追加预算继续】→ 恢复 working 且本轮不再重复熔断
		const handled = await core.handleBudgetAskAnswer(ask.id, "追加预算继续");
		expect(handled).toBe(true);
		t = (await core.db.selectFrom("tasks").selectAll().executeTakeFirst())!;
		expect(t.stage).toBe("working");
		expect(await core.enforceTaskBudget(task.id)).toBe(false);

		// 4. 非预算追问卡 → handleBudgetAskAnswer 返回 false（走通用路径）
		expect(await core.handleBudgetAskAnswer("K999", "随便")).toBe(false);

		// 5. 第二个任务走【停止任务】选项 → 关单
		const t2Trigger = await core.insertTrigger({ source: "wecom", userId: "u1", strength: "explicit", text: "另一个长任务" });
		await core.routeAccept(t2Trigger.trigger.id, "长任务二", "收到", "budget test 2", "large", [], BACKGROUND_CONTEXT, true);
		await new Promise((r) => setTimeout(r, 400));
		const task2 = (await core.db.selectFrom("tasks").where("id", "!=", task.id).selectAll().executeTakeFirst())!;
		await core.modelRouter.recordUsage({ taskId: task2.id, conversationId: String(task2.conv_id), role: "worker_default", promptTokens: 1_000_000, completionTokens: 1_000_000, overrideCostUsd: 1.8 });
		expect(await core.enforceTaskBudget(task2.id)).toBe(true);
		const ask2 = (await core.db.selectFrom("asks").where("status", "=", "pending").selectAll().executeTakeFirst())!;
		expect(await core.handleBudgetAskAnswer(ask2.id, "停止任务")).toBe(true);
		const t2 = await core.db.selectFrom("tasks").where("id", "=", task2.id).selectAll().executeTakeFirst();
		expect(t2?.stage).toBe("cancelled");
	});

	it("Worker 轮末自动记账：syncConversationUsage 从 pi journal 增量写入 token_usage_ledger 且重扫幂等", async () => {
		const { trigger } = await core.insertTrigger({ source: "wecom", userId: "u1", strength: "explicit", text: "记账演示任务" });
		await core.routeAccept(trigger.id, "记账任务", "收到", "ledger test", "medium", [], BACKGROUND_CONTEXT, true);
		await new Promise((r) => setTimeout(r, 400)); // 等后台首轮结束（轮末钩子会先同步一次）
		const task = (await core.db.selectFrom("tasks").selectAll().executeTakeFirst())!;

		// 直接向 pi.sqlite journal 播种一条带真实 usage 的 assistant 条目（模拟供应商记账，
		// fauxAssistantMessage 携带的 DEFAULT_USAGE 全为 0 会被记账钩子跳过）
		const convNum = Number(task.conv_id);
		const pi = new DatabaseSync(cfg.piDbPath);
		const seedEntry = {
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					model: "test/worker-flash",
					usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
				},
			],
		};
		pi.prepare("INSERT INTO entries (conversation_id, head, commit_seq, record) VALUES (?, NULL, 0, ?)").run(convNum, JSON.stringify(seedEntry));
		pi.close();

		const r1 = await core.modelRouter.syncConversationUsage(String(task.conv_id), { taskId: task.id, role: "worker_default" });
		expect(r1.recorded).toBe(1);
		const rows1 = await core.db.selectFrom("token_usage_ledger").where("task_id", "=", task.id).selectAll().execute();
		expect(rows1.length).toBe(1);
		expect(rows1[0]!.model_id).toBe("test/worker-flash");
		expect(rows1[0]!.prompt_tokens).toBe(1200);
		expect(rows1[0]!.completion_tokens).toBe(300);
		expect(rows1[0]!.cost_usd).toBeCloseTo(0.003, 6);
		// 重扫（模拟进程重启后水位线丢失）：ext_entry_id 唯一索引去重，账本不翻倍
		const r2 = await core.modelRouter.syncConversationUsage(String(task.conv_id), { taskId: task.id, role: "worker_default" });
		expect(r2.recorded).toBe(0);
		const rows2 = await core.db.selectFrom("token_usage_ledger").where("task_id", "=", task.id).selectAll().execute();
		expect(rows2).toHaveLength(1);
		// 记账后预算检查可用（金额为正）
		const check = await core.modelRouter.checkBudget(task.id);
		expect(check.allowed).toBe(true);
		expect(check.taskSpentUsd).toBeGreaterThan(0);
	});
});
