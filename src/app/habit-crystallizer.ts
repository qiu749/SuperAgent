/**
 * HabitCrystallizer（SPEC-v2 §8 M7）：审批【修改】→ 批准后，把 Diff（旧 payload → 新 payload）
 * 与用户修改意见原话提炼成一条可复用习惯规则（祈使句 + Why，≤100 字），落 learned_habits 表
 * 并写入 Mem0（source="habit"，供语义检索注入后续任务的 Worker 上下文）。提炼失败静默跳过。
 */
import pino from "pino";
import { newId, getTask } from "./tasks.ts";
import type { ApprovalsTable } from "./db.ts";
import type { WeAgentCore } from "./core.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "habit-crystallizer" });

/** 顶层字段级 diff 摘要（避免把整个 payload 塞给提炼模型）。 */
export function payloadDiff(before: string | undefined, after: string): string[] {
	const changes: string[] = [];
	let a: Record<string, unknown> = {};
	try {
		a = before ? (JSON.parse(before) as Record<string, unknown>) : {};
	} catch {
		/* 忽略 */
	}
	let b: Record<string, unknown> = {};
	try {
		b = JSON.parse(after) as Record<string, unknown>;
	} catch {
		return changes;
	}
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
	for (const k of keys) {
		const av = JSON.stringify(a[k] ?? null);
		const bv = JSON.stringify(b[k] ?? null);
		if (av !== bv) changes.push(`${k}: ${av.slice(0, 60)} → ${bv.slice(0, 60)}`);
	}
	return changes;
}

export class HabitCrystallizer {
	constructor(private readonly core: WeAgentCore) {}

	async fromApproval(row: ApprovalsTable): Promise<void> {
		if (!row.previous_approval_id || !row.user_edit_feedback) return;
		try {
			const task = await getTask(this.core.db, row.task_id);
			if (!task) return;
			const old = await this.core.db.selectFrom("approvals").where("id", "=", row.previous_approval_id).selectAll().executeTakeFirst();
			const changes = payloadDiff(old?.payload, row.payload);
			if (changes.length === 0 && row.user_edit_feedback.length < 4) return;
			const rule = (await this.core.completeOnce(task.user_id, buildExtractionPrompt(row, changes))).trim();
			// 基本卫生校验：空、过长、疑似拒答
			if (!rule || rule.length > 200 || /^(无|没有|不需要|无需)/.test(rule)) {
				log.info({ approvalId: row.id, rule: rule.slice(0, 60) }, "提炼结果不构成习惯规则，跳过");
				return;
			}
			const habitId = newId("h");
			await this.core.db
				.insertInto("learned_habits")
				.values({
					id: habitId,
					user_id: task.user_id,
					action_type: row.action_type,
					rule_text: rule,
					from_approval_id: row.id,
					mem0_id: null,
					enabled: 1,
					created_at: Date.now(),
				})
				.execute();
			await this.core.memory.addTrusted(task.user_id, rule, "habit", { taskId: row.task_id, actionType: row.action_type });
			log.info({ habitId, approvalId: row.id }, "已沉淀习惯规则");
		} catch (err) {
			log.warn({ approvalId: row.id, err }, "习惯提炼失败（不影响业务）");
		}
	}
}

function buildExtractionPrompt(row: ApprovalsTable, changes: string[]): string {
	return [
		"你是一次审批修改的习惯提炼器。用户刚修改并批准了一个对外动作草稿。请把这次修改提炼成一条可复用的规则，写给未来执行同类任务的助理看。",
		"硬性要求：",
		"- 一条规则，祈使句动作 + 一句话机理原因（Why）；",
		"- ≤100 字；只输出规则文本本身，不要任何前后缀、引号或解释；",
		"- 严禁写成流水账/日期/工单号；严禁对工具能力做负面断言（如\"XX工具不能用\"）。",
		`动作类型：${row.action_type}`,
		`修改前后的差异：${changes.length > 0 ? changes.join("；") : "（payload 顶层无差异，意见偏风格）"}`,
		`用户修改意见原话：${row.user_edit_feedback}`,
	].join("\n");
}
