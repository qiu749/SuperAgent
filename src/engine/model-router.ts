/**
 * 多模型分级路由与每日成本熔断器（ModelRouter & CostGuard，SPEC-v3 §3.3 M10）：
 * - 按 5 类角色（router / worker_default / worker_reasoning / vision_cua / curator）路由最匹配的模型（支持现有 Command Code / Goat 订阅与 Qwen Flash）；
 * - 实时记账 token_usage_ledger（prompt_tokens / completion_tokens / cost_usd）；
 * - 双道熔断护栏：
 *   1) 单任务上限（maxTaskCostUsd，默认 $1.50）；
 *   2) 全天硬上限（dailyCostLimitUsd，默认 $8.00），超限时自动暂停后台 Curator 与非紧急传感器。
 */
import { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import type { Config } from "../config.ts";
import type { Db } from "../app/db.ts";

export type ModelRole =
	| "router"
	| "worker_default"
	| "worker_reasoning"
	| "vision_cua"
	| "curator";

export type RoleModelSpec = {
	role: ModelRole;
	provider: string;
	modelId: string;
	inputPricePer1MUsd: number;
	outputPricePer1MUsd: number;
};

export type BudgetCheckResult = {
	allowed: boolean;
	reason?: string;
	dailySpentUsd: number;
	dailyLimitUsd: number;
	taskSpentUsd: number;
	taskLimitUsd: number;
};

export class ModelRouter {
	/** 每会话已同步到的 pi journal 水位线（进程内缓存；重启后靠 ext_entry_id UNIQUE 去重重扫）。 */
	private readonly watermarks = new Map<string, number>();

	constructor(
		private readonly db: Kysely<Db>,
		private readonly cfg: Config,
	) {}

	/** 根据角色返回推荐的模型规格与单价（美元 / 百万 Token）。 */
	resolveRole(role: ModelRole): RoleModelSpec {
		const provider = this.cfg.modelProvider;
		switch (role) {
			case "router":
			case "curator":
				return {
					role,
					provider,
					modelId: this.cfg.routerModel,
					inputPricePer1MUsd: 0.15,
					outputPricePer1MUsd: 0.6,
				};
			case "vision_cua":
				return {
					role,
					provider,
					modelId: this.cfg.visionModel || this.cfg.workerModel,
					inputPricePer1MUsd: 0.4,
					outputPricePer1MUsd: 1.2,
				};
			case "worker_reasoning":
				return {
					role,
					provider,
					modelId: this.cfg.workerModel,
					inputPricePer1MUsd: 1.0,
					outputPricePer1MUsd: 4.0,
				};
			case "worker_default":
			default:
				return {
					role: "worker_default",
					provider,
					modelId: this.cfg.workerModel,
					inputPricePer1MUsd: 0.5,
					outputPricePer1MUsd: 2.0,
				};
		}
	}

	/** 记录一次模型调用的 Token 消耗并自动计算估算成本。 */
	async recordUsage(input: {
		taskId: number | null;
		conversationId: string;
		role: ModelRole;
		modelId?: string;
		promptTokens: number;
		completionTokens: number;
		overrideCostUsd?: number;
	}): Promise<{ costUsd: number }> {
		const spec = this.resolveRole(input.role);
		const costUsd =
			input.overrideCostUsd !== undefined
				? input.overrideCostUsd
				: Number(
						(
							(input.promptTokens / 1_000_000) * spec.inputPricePer1MUsd +
							(input.completionTokens / 1_000_000) * spec.outputPricePer1MUsd
						).toFixed(6),
					);
		await this.db
			.insertInto("token_usage_ledger")
			.values({
				task_id: input.taskId,
				conversation_id: input.conversationId,
				role: input.role,
				model_id: input.modelId ?? spec.modelId,
				prompt_tokens: input.promptTokens,
				completion_tokens: input.completionTokens,
				cost_usd: costUsd,
				created_at: Date.now(),
			})
			.execute();
		return { costUsd };
	}

	/** 检查当前全天预算与单任务预算是否超限。 */
	async checkBudget(taskId: number | null): Promise<BudgetCheckResult> {
		const startOfDay = new Date();
		startOfDay.setHours(0, 0, 0, 0);
		const todayRows = await this.db
			.selectFrom("token_usage_ledger")
			.where("created_at", ">=", startOfDay.getTime())
			.selectAll()
			.execute();
		const dailySpentUsd = Number(todayRows.reduce((s, r) => s + r.cost_usd, 0).toFixed(6));

		let taskSpentUsd = 0;
		if (taskId !== null) {
			const taskRows = await this.db
				.selectFrom("token_usage_ledger")
				.where("task_id", "=", taskId)
				.selectAll()
				.execute();
			taskSpentUsd = Number(taskRows.reduce((s, r) => s + r.cost_usd, 0).toFixed(6));
		}

		if (taskId !== null && taskSpentUsd >= this.cfg.maxTaskCostUsd) {
			return {
				allowed: false,
				reason: `单任务成本已达上限 ($${taskSpentUsd.toFixed(2)} >= $${this.cfg.maxTaskCostUsd.toFixed(2)})`,
				dailySpentUsd,
				dailyLimitUsd: this.cfg.dailyCostLimitUsd,
				taskSpentUsd,
				taskLimitUsd: this.cfg.maxTaskCostUsd,
			};
		}

		if (dailySpentUsd >= this.cfg.dailyCostLimitUsd) {
			return {
				allowed: false,
				reason: `今日累计成本已达熔断上限 ($${dailySpentUsd.toFixed(2)} >= $${this.cfg.dailyCostLimitUsd.toFixed(2)})`,
				dailySpentUsd,
				dailyLimitUsd: this.cfg.dailyCostLimitUsd,
				taskSpentUsd,
				taskLimitUsd: this.cfg.maxTaskCostUsd,
			};
		}

		return {
			allowed: true,
			dailySpentUsd,
			dailyLimitUsd: this.cfg.dailyCostLimitUsd,
			taskSpentUsd,
			taskLimitUsd: this.cfg.maxTaskCostUsd,
		};
	}

	/** 汇总今日与近 7 天按模型角色拆分的 Token 与成本账单（供 H5 面板展示）。 */
	async getSummary() {
		const now = Date.now();
		const sevenDaysAgo = now - 7 * 24 * 3600_000;
		const startOfDay = new Date();
		startOfDay.setHours(0, 0, 0, 0);

		const rows = await this.db
			.selectFrom("token_usage_ledger")
			.where("created_at", ">=", sevenDaysAgo)
			.selectAll()
			.execute();

		let todayCostUsd = 0;
		let todayPromptTokens = 0;
		let todayCompletionTokens = 0;
		const byRole: Record<string, { promptTokens: number; completionTokens: number; costUsd: number; calls: number }> = {};

		for (const r of rows) {
			if (r.created_at >= startOfDay.getTime()) {
				todayCostUsd += r.cost_usd;
				todayPromptTokens += r.prompt_tokens;
				todayCompletionTokens += r.completion_tokens;
			}
			const bucket = byRole[r.role] ?? { promptTokens: 0, completionTokens: 0, costUsd: 0, calls: 0 };
			bucket.promptTokens += r.prompt_tokens;
			bucket.completionTokens += r.completion_tokens;
			bucket.costUsd = Number((bucket.costUsd + r.cost_usd).toFixed(6));
			bucket.calls += 1;
			byRole[r.role] = bucket;
		}

		return {
			todayCostUsd: Number(todayCostUsd.toFixed(6)),
			dailyCostLimitUsd: this.cfg.dailyCostLimitUsd,
			maxTaskCostUsd: this.cfg.maxTaskCostUsd,
			todayPromptTokens,
			todayCompletionTokens,
			byRole,
		};
	}

	/**
	 * 模型调用记账钩子（SPEC-v3 §3.3）：增量扫描 pi.sqlite journal 中该会话新增的 assistant 条目，
	 * 把每条消息的 usage（prompt/completion tokens 与真实成本）写入 token_usage_ledger。
	 * 幂等：ext_entry_id = `{conv}:{entryId}:{model}` 唯一索引去重，进程重启重扫不会重复记账。
	 * 供应商未报成本（如本地/faux 模型）时按角色单价表估算。
	 */
	async syncConversationUsage(
		convKey: string,
		opts: { taskId: number | null; role: ModelRole },
	): Promise<{ recorded: number }> {
		const convNum = Number(convKey);
		if (!Number.isFinite(convNum) || convNum <= 0) return { recorded: 0 };
		const watermark = this.watermarks.get(convKey) ?? 0;

		let store: DatabaseSync;
		try {
			store = new DatabaseSync(this.cfg.piDbPath, { readOnly: true });
		} catch {
			return { recorded: 0 };
		}

		type Bucket = { input: number; output: number; cost: number; lastEntryId: number };
		const byModel = new Map<string, Bucket>();
		try {
			const rows = store
				.prepare("SELECT id, record FROM entries WHERE conversation_id = ? AND id > ? ORDER BY id ASC")
				.all(convNum, watermark) as { id: number; record: string }[];
			let maxEntryId = watermark;
			for (const row of rows) {
				if (row.id > maxEntryId) maxEntryId = row.id;
				let rec: { model?: { role?: string; model?: string; responseModel?: string; usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } }[] };
				try {
					rec = JSON.parse(row.record);
				} catch {
					continue;
				}
				for (const m of rec.model ?? []) {
					if (m.role !== "assistant" || !m.usage) continue;
					const modelId = m.model || m.responseModel || "unknown";
					const bucket = byModel.get(modelId) ?? { input: 0, output: 0, cost: 0, lastEntryId: row.id };
					bucket.input += m.usage.input ?? 0;
					bucket.output += m.usage.output ?? 0;
					bucket.cost += m.usage.cost?.total ?? 0;
					bucket.lastEntryId = row.id;
					byModel.set(modelId, bucket);
				}
			}
			if (maxEntryId > watermark) this.watermarks.set(convKey, maxEntryId);
		} finally {
			store.close();
		}

		let recorded = 0;
		const spec = this.resolveRole(opts.role);
		for (const [modelId, bucket] of byModel) {
			if (bucket.input + bucket.output === 0) continue;
			// 供应商报了真实成本就用真实值；缺失（如本地/faux 模型）时按角色单价估算，保证 CostGuard 有数可看
			const costUsd =
				bucket.cost > 0
					? Number(bucket.cost.toFixed(6))
					: Number(
							(
								(bucket.input / 1_000_000) * spec.inputPricePer1MUsd +
								(bucket.output / 1_000_000) * spec.outputPricePer1MUsd
							).toFixed(6),
						);
			await this.db
				.insertInto("token_usage_ledger")
				.values({
					task_id: opts.taskId,
					conversation_id: convKey,
					role: opts.role,
					model_id: modelId,
					prompt_tokens: bucket.input,
					completion_tokens: bucket.output,
					cost_usd: costUsd,
					created_at: Date.now(),
					ext_entry_id: `${convNum}:${bucket.lastEntryId}:${modelId}`,
				})
				.onConflict((oc) => oc.doNothing())
				.execute();
			recorded += 1;
		}
		return { recorded };
	}
}
