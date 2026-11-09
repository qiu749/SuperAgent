/**
 * H5 轨迹时光机与任意节点分叉重跑测试（SPEC-v3 §7 M12，test/trajectory-fork.test.ts）：
 * - /api/panel/tasks/:id/trajectory 完整时间轴（trigger / llm_turn / tool_call / approval / subworker_group 节点）；
 * - POST /api/panel/tasks/:id/fork 从指定历史序号 conversation.fork() 克隆子任务并注入修正指令重跑；
 * - 成本账单 /api/panel/cost/summary、技能遥测 /api/panel/skills/telemetry 与一键回滚、知识库面板 API。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig, type Config } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore, toConvId } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";
import { startHttp } from "../src/http/server.ts";

function makeCfg(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-tm-"));
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
	cfg.computerDriver = "mock";
	cfg.port = 0;
	return cfg;
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15000, stepMs = 80): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v !== undefined && v !== null && v !== false) return v as T;
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

describe("M12：H5 轨迹时光机 & Fork 重跑（SPEC-v3 §5）", () => {
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

	it("轨迹时间轴完整组装 + 任意历史节点 conversation.fork() 分叉重跑端到端", async () => {
		const { server } = startHttp(core);
		await new Promise((r) => setTimeout(r, 150));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 8000;
		const baseUrl = `http://127.0.0.1:${port}`;

		try {
			const authRes = await fetch(`${baseUrl}/api/panel/auth?dev_user=u1`, { redirect: "manual" });
			const cookie = (authRes.headers.get("set-cookie") ?? "").split(";")[0]!;

			const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
				core.faux!.appendResponses([handler as never]);
				const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
				const text = typeof lastUser?.content === "string" ? lastUser.content : "";
				if (model.id === cfg.routerModel) {
					if (text.startsWith("[Sub-Worker 只读子任务")) {
						return fauxAssistantMessage(`子任务调研结论：${text.slice(0, 40)}`);
					}
					const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
					if (m) {
						return fauxAssistantMessage(
							fauxToolCall("route_decision", {
								decisions: [{ kind: "accept", trigger_id: m[1], title: "多源架构对比", acknowledgement: "收到，开始对比", budget: "medium" }],
							}),
							{ stopReason: "toolUse" },
						);
					}
					return fauxAssistantMessage("Router 直答");
				}
				if (text.startsWith("[时光机分叉修正指令")) {
					return fauxAssistantMessage(
						fauxToolCall("worker_report", { state: "ready", summary: "已按分叉修正指令改查 v2 表并完成任务" }),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "初始分支已完成" }), { stopReason: "toolUse" });
			};
			core.faux!.setResponses([handler as never]);

			await core.dispatcher.onUserText("u1", "对比 A 和 B 两个方案", "m-tm-1");
			const task1 = await waitFor(async () => {
				const t = await core.db.selectFrom("tasks").where("id", "=", 1).selectAll().executeTakeFirst();
				return t?.stage === "ready" ? t : undefined;
			});

			// Sub-Worker 分治节点进轨迹
			await core.spawnSubworkers(
				toConvId(task1.conv_id),
				[
					{ id: "sub-a", title: "调研方案 A", prompt: "分析方案 A 的延迟" },
					{ id: "sub-b", title: "调研方案 B", prompt: "分析方案 B 的吞吐" },
				],
				2,
				BACKGROUND_CONTEXT,
			);

			// H5 时光机拉取任务 #1 的完整轨迹
			const trajRes = await fetch(`${baseUrl}/api/panel/tasks/1/trajectory`, { headers: { cookie } });
			expect(trajRes.status).toBe(200);
			const bundle = (await trajRes.json()) as {
				totalNodes: number;
				totalCostUsd: number;
				nodes: { seq: number; kind: string; title: string; piEventId?: number }[];
			};
			expect(bundle.totalNodes).toBeGreaterThanOrEqual(3);
			expect(bundle.nodes.some((n) => n.kind === "subworker_group")).toBe(true);
			expect(bundle.nodes.every((n) => typeof n.seq === "number" && n.piEventId !== undefined)).toBe(true);

			// 从任务 #1 的第 2 步分叉重跑
			const forkRes = await fetch(`${baseUrl}/api/panel/tasks/1/fork`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie },
				body: JSON.stringify({ atSeq: 2, overridePrompt: "不要查旧表，改查 orders_v2 表" }),
			});
			expect(forkRes.status).toBe(200);
			const forkBody = (await forkRes.json()) as { ok: boolean; newTaskId: number; parentTaskId: number; forkedAtSeq: number };
			expect(forkBody.ok).toBe(true);
			expect(forkBody.parentTaskId).toBe(1);
			expect(forkBody.forkedAtSeq).toBe(2);

			// 等待分叉任务跑完 ready，核对 parent_task_id / forked_at_seq / 新指令生效
			const forkedTask = await waitFor(async () => {
				const t = await core.db.selectFrom("tasks").where("id", "=", forkBody.newTaskId).selectAll().executeTakeFirst();
				return t?.stage === "ready" ? t : undefined;
			});
			expect(forkedTask.parent_task_id).toBe(1);
			expect(forkedTask.forked_at_seq).toBe(2);
			expect(forkedTask.latest_report).toContain("已按分叉修正指令改查 v2 表并完成任务");
		} finally {
			server.close();
		}
	});

	it("看板 API：成本账单（含 Worker 轮末自动记账）、技能遥测与一键回滚、知识库文档/检索", async () => {
		const { server } = startHttp(core);
		await new Promise((r) => setTimeout(r, 150));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 8000;
		const baseUrl = `http://127.0.0.1:${port}`;

		try {
			const authRes = await fetch(`${baseUrl}/api/panel/auth?dev_user=u1`, { redirect: "manual" });
			const cookie = (authRes.headers.get("set-cookie") ?? "").split(";")[0]!;

			const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
				core.faux!.appendResponses([handler as never]);
				const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
				const text = typeof lastUser?.content === "string" ? lastUser.content : "";
				if (model.id === cfg.routerModel) {
					const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
					if (m) {
						return fauxAssistantMessage(
							fauxToolCall("route_decision", {
								decisions: [{ kind: "accept", trigger_id: m[1], title: "记账看板演示", acknowledgement: "收到，开始整理本周要点", budget: "medium" }],
							}),
							{ stopReason: "toolUse" },
						);
					}
					return fauxAssistantMessage("Router 直答");
				}
				return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "看板演示完成" }), { stopReason: "toolUse" });
			};
			core.faux!.setResponses([handler as never]);
			await core.dispatcher.onUserText("u1", "整理本周要点", "m-cost-1");
			await waitFor(async () => {
				const t = await core.db.selectFrom("tasks").where("id", "=", 1).selectAll().executeTakeFirst();
				return t?.stage === "ready" ? t : undefined;
			});

			// 1. 成本账单：Worker 轮末自动记账已把 faux usage 写入 ledger（角色 = worker_default）
			const cost = (await (await fetch(`${baseUrl}/api/panel/cost/summary`, { headers: { cookie } })).json()) as {
				todayCostUsd: number;
				byRole: Record<string, { calls: number; costUsd: number }>;
				recentSensors: unknown[];
			};
			expect(cost.byRole.worker_default?.calls).toBeGreaterThan(0);
			expect(cost.todayCostUsd).toBeGreaterThan(0);

			// 2. 技能遥测 + 一键回滚：安装技能 → patch 一版 → 回滚
			await core.skillHygiene.installExternalSkill({
				rawMarkdown: "---\nname: rollback-demo\ndescription: Use when demonstrating rollback.\ncategory: office\n---\n\n# v1\n初始版本。\n",
			});
			await core.skills.manage([{ name: "office/rollback-demo", action: "patch", content: "---\nname: rollback-demo\ndescription: Use when demonstrating rollback.\ncategory: office\n---\n\n# v2\n修订版本。\n" }], { actor: "user" });
			const tele = (await (await fetch(`${baseUrl}/api/panel/skills/telemetry`, { headers: { cookie } })).json()) as {
				skills: { skillName: string; firstTryRate: number }[];
			};
			expect(tele.skills.some((s) => s.skillName === "office/rollback-demo")).toBe(true);
			const rb = (await (
				await fetch(`${baseUrl}/api/panel/skills/rollback`, {
					method: "POST",
					headers: { "content-type": "application/json", cookie },
					body: JSON.stringify({ name: "office/rollback-demo" }),
				})
			).json()) as { ok: boolean; message: string };
			expect(rb.ok).toBe(true);
			const { readFileSync } = await import("node:fs");
			const skillMd = readFileSync(join(cfg.dataDir, "skills", "office", "rollback-demo", "SKILL.md"), "utf8");
			expect(skillMd).toContain("初始版本");
			expect(skillMd).not.toContain("修订版本");

			// 3. 知识库面板 API：入库 → 列表 → 检索
			await core.knowledge.ingestText({ sourcePath: "panel://demo", title: "面板文档", content: "# 标题\n面板检索关键词 QWERTY-777。" });
			const docs = (await (await fetch(`${baseUrl}/api/panel/kb/docs`, { headers: { cookie } })).json()) as { docs: { title: string }[] };
			expect(docs.docs.some((d) => d.title === "面板文档")).toBe(true);
			const search = (await (await fetch(`${baseUrl}/api/panel/kb/search?q=QWERTY-777`, { headers: { cookie } })).json()) as { hits: { content: string }[] };
			expect(search.hits.length).toBeGreaterThan(0);
		} finally {
			server.close();
		}
	});
});
