/**
 * Pi Durable Harness 初始化（SPEC §13 engine/harness.ts）：
 * DeepSeek 注册（faux 回退）、Registry 装配、沙箱 env 构建。
 * 本目录是唯一允许 import @earendil-works/pi-* 的业务入口（扩展与任务内部除外）。
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRegistry, Harness, type Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import pino from "pino";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { WeAgentCore } from "../app/core.ts";
import { getTaskByConv } from "../app/tasks.ts";
import { createRouterExtension } from "./extensions/router.ts";
import { createWorkerExtension } from "./extensions/worker.ts";
import { createMem0Extension } from "./extensions/mem0.ts";
import { createSkillsExtension } from "./extensions/skills.ts";
import { createCodeModeExtension } from "./extensions/codemode.ts";
import { createComputerExtension } from "./extensions/computer.ts";
import { createKnowledgeExtension } from "./extensions/knowledge.ts";
import { createSubworkerExtension } from "./extensions/subworker.ts";
import { createCronTask } from "./tasks/cron.ts";
import { createApprovalExpiryTask } from "./tasks/approval-expiry.ts";
import { createDigestCronTask } from "./tasks/digest-cron.ts";
import { createCalendarSensorTask } from "./tasks/calendar-sensor.ts";
import { createSkillHygieneCronTask } from "./tasks/skill-hygiene-cron.ts";
import { McpBridge } from "./mcp/bridge.ts";
import { DockerEnv } from "./env/docker-env.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "harness" });

/** 引擎任务扩展：weagent.cron + weagent.approval-expiry + weagent.digest-cron + v3 传感器/巡检（按名解析，与会话选择无关）。 */
function engineTasksExtension(core: WeAgentCore): Extension {
	return {
		name: "weagent-engine-tasks",
		tasks: [
			createCronTask(core),
			createApprovalExpiryTask(core),
			createDigestCronTask(core),
			createCalendarSensorTask(core),
			createSkillHygieneCronTask(core),
		],
	};
}

export async function openHarness(core: WeAgentCore): Promise<Harness> {
	// ---------- 模型 ----------
	const models = createModels();
	if (core.cfg.modelProvider === "deepseek") {
		const baseUrl = process.env.DEEPSEEK_BASE_URL || "";
		if (baseUrl && !baseUrl.includes("api.deepseek.com")) {
			// DeepSeek 兼容中转站（如 SiliconFlow）：openai-completions API，
			// 模型目录跟随 cfg.routerModel / cfg.workerModel 的真实 ID（从官方模板克隆字段）。
			const { createProvider, envApiKeyAuth } = await import("@earendil-works/pi-ai");
			const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
			const template = deepseekProvider().getModels()[0]!;
			const mkModel = (id: string) => ({ ...template, id, name: id, baseUrl });
			models.setProvider(
				createProvider({
					id: "deepseek",
					name: "DeepSeek",
					baseUrl,
					auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
					models: [mkModel(core.cfg.routerModel), mkModel(core.cfg.workerModel)],
					api: openAICompletionsApi(),
				}),
			);
			log.info({ baseUrl, router: core.cfg.routerModel, worker: core.cfg.workerModel }, "使用 DeepSeek 兼容中转站");
		} else {
			models.setProvider(deepseekProvider());
		}
	} else {
		const faux = fauxProvider({
			models: [
				{ id: core.cfg.routerModel, contextWindow: 128_000 },
				{ id: core.cfg.workerModel, contextWindow: 128_000 },
			],
		});
		models.setProvider(faux.provider);
		core.faux = faux;
		log.warn("未配置 DEEPSEEK_API_KEY，使用 fauxProvider（本地调试）");
	}

	// ---------- Registry ----------
	const registry = createRegistry();
	const routerExt = createRouterExtension(core);
	const workerExt = createWorkerExtension(core, { key: process.env.TAVILY_API_KEY, provider: process.env.SEARCH_PROVIDER || "tavily" });
	const mem0Ext = createMem0Extension(core);
	const skillsExt = createSkillsExtension(core);
	const codemodeExt = createCodeModeExtension();
	const computerExt = createComputerExtension(core);
	const knowledgeExt = createKnowledgeExtension(core);
	const subworkerExt = createSubworkerExtension(core);
	registry.install(engineTasksExtension(core));
	registry.install(routerExt);
	registry.install(workerExt);
	registry.install(mem0Ext);
	registry.install(skillsExt);
	registry.install(codemodeExt);
	registry.install(computerExt);
	registry.install(knowledgeExt);
	registry.install(subworkerExt);
	registry.install(CodingTools);

	const bridge = new McpBridge(core.cfg);
	bridge.hostRef = core;
	await bridge.start();
	core.mcp = bridge;
	const mcpExt = bridge.extension;
	if (mcpExt) registry.install(mcpExt);
	core.extensions = {
		router: routerExt,
		worker: workerExt,
		mem0: mem0Ext,
		skills: skillsExt,
		codemode: codemodeExt,
		computer: computerExt,
		knowledge: knowledgeExt,
		subworker: subworkerExt,
		coding: CodingTools as Extension,
		mcp: mcpExt ?? null,
	};

	// ---------- Harness ----------
	const harness = await Harness.open(await openNodeSqliteStorage(core.cfg.piDbPath), {
		models,
		registry,
		env: (target) => buildEnv(core, String(target.conversationId)),
	}, BACKGROUND_CONTEXT);
	core.attachHarness(harness);
	return harness;
}

/** Worker 会话 → Docker 沙箱（回退本地 Node env）；Router 会话 → 无环境。 */
async function buildEnv(core: WeAgentCore, conversationId: string): Promise<ExecutionEnv | undefined> {
	const task = await getTaskByConv(core.db, conversationId);
	if (!task) return undefined;
	const hostDir = resolve(core.cfg.dataDir, "tasks", String(task.id));
	mkdirSync(hostDir, { recursive: true });
	try {
		return await DockerEnv.create(core.cfg.sandboxImage, hostDir, String(task.id));
	} catch (err) {
		log.warn({ taskId: task.id, err: err instanceof Error ? err.message : String(err) }, "Docker 沙箱不可用，回退本地 Node 沙箱（cwd=任务目录）");
		return new NodeExecutionEnv({ cwd: hostDir });
	}
}
