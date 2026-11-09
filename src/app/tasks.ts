/**
 * 任务生命周期与 worker_report 处理（SPEC §6.1/§12）。
 * 纯 app.sqlite 行级操作 + 任务卡片渲染；IM 副作用由调用方（WeAgentCore）注入。
 */
import { type Kysely } from "kysely";
import type { Db, TaskStage } from "./db.ts";
import type { Budget } from "../engine/host.ts";
import { truncateWords } from "../util/text.ts";

export type WorkerReportRow = {
	state: string;
	summary: string;
	humanAction?: string;
	reportPath?: string;
};

export function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function getTask(db: Kysely<Db>, taskId: number) {
	return db.selectFrom("tasks").where("id", "=", taskId).selectAll().executeTakeFirst();
}

export async function getTaskByConv(db: Kysely<Db>, convId: string) {
	return db.selectFrom("tasks").where("conv_id", "=", convId).selectAll().executeTakeFirst();
}

export async function setStage(db: Kysely<Db>, taskId: number, stage: TaskStage): Promise<void> {
	await db.updateTable("tasks").set({ stage, updated_at: Date.now() }).where("id", "=", taskId).execute();
}

export async function activeTasks(db: Kysely<Db>, userId: string, limit = 12) {
	return db
		.selectFrom("tasks")
		.where("user_id", "=", userId)
		.where("stage", "!=", "dropped")
		.orderBy("updated_at", "desc")
		.limit(limit)
		.selectAll()
		.execute();
}

function formatRelativeAge(updatedAt: number, now = Date.now()): string {
	const diffSec = Math.max(0, Math.round((now - updatedAt) / 1000));
	if (diffSec < 10) return "刚刚";
	if (diffSec < 60) return `${diffSec}秒前`;
	const diffMin = Math.round(diffSec / 60);
	if (diffMin < 60) return `${diffMin}分钟前`;
	const diffHr = Math.round(diffMin / 60);
	if (diffHr < 24) return `${diffHr}小时前`;
	return `${Math.round(diffHr / 24)}天前`;
}

/** Router section "active-tasks" 的任务卡片列表（保留完整标点与结尾追问提示，附相对更新时间）。 */
export function renderTaskCards(tasks: Awaited<ReturnType<typeof activeTasks>>): string {
	if (tasks.length === 0) return "（当前没有活跃任务）";
	const now = Date.now();
	return tasks
		.map((t) => {
			const report = t.latest_report ? (JSON.parse(t.latest_report) as WorkerReportRow) : null;
			const age = formatRelativeAge(t.updated_at, now);
			const summaryText = report?.summary
				? report.summary.length <= 220
					? report.summary
					: `${truncateWords(report.summary, 80)}…`
				: "";
			const reportLine = report ? `｜最新汇报(${report.state})：${summaryText}` : "";
			return `- 任务 #${t.id}「${t.title}」状态 ${t.stage}（${age}更新）${reportLine}`;
		})
		.join("\n");
}

export const STAGE_LABELS: Record<TaskStage, string> = {
	queued: "排队中",
	working: "执行中",
	waiting_approval: "等待审批",
	waiting_user: "等待你的回复",
	paused_budget: "预算暂停",
	ready: "已完成",
	dropped: "已静默关单",
	failed: "已失败",
	cancelled: "已取消",
};

export function taskSummaryLine(t: { id: number; title: string; stage: TaskStage; budget: Budget | string }): string {
	return `#${t.id}「${t.title}」${STAGE_LABELS[t.stage] ?? t.stage}`;
}
