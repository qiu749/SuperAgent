/**
 * weagent.cron（SPEC §9）：Pi Durable 持久化定时任务。
 * defineTask + runtime.sleepUntil：进程重启后自动恢复睡眠倒计时；到点生成一条 Trigger
 * 提交给 Router（trigger_id 幂等去重）。巡检类任务无事发生时由 Worker 报 dropped 静默关单。
 */
import { CronExpressionParser } from "cron-parser";
import { defineTask } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";

export const CRON_TASK_NAME = "weagent.cron";

export type CronInput = {
	jobId: string;
	userId: string;
	expr: string;
	prompt: string;
};

export type CronCheckpoint =
	| { phase: "sleep"; until: number }
	| { phase: "fire"; slot: number };

/** 计算下一次触发时间戳（毫秒）。表达式非法时抛错。 */
export function nextFireMs(expr: string, from = Date.now()): number {
	const it = CronExpressionParser.parse(expr, { currentDate: new Date(from) });
	return it.next().getTime();
}

export function createCronTask(host: WeAgentHost) {
	return defineTask<CronInput, CronCheckpoint, { done: boolean }, object>({
		name: CRON_TASK_NAME,
		version: 1,
		initial: (input) => ({ phase: "sleep", until: nextFireMs(input.expr) }),
		phases: {
			sleep: async (task, runtime, ctx) => {
				if (!(await host.cronEnabled(task.input.jobId))) {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { done: true } } }), ctx);
					return;
				}
				await runtime.sleepUntil(task.state.checkpoint.until, { phase: "fire", slot: task.state.checkpoint.until }, ctx);
			},
			fire: async (task, runtime, ctx) => {
				const slot = task.state.checkpoint.slot;
				// 生成 Trigger（source_msg_id = cron:{jobId}:{slot}，宿主侧幂等去重）→ 提交 Router。
				// 重复 fire（崩溃重放）会被 trigger 去重挡住，不会重复建任务。
				await host.fireCronTrigger({ jobId: task.input.jobId, userId: task.input.userId, prompt: task.input.prompt, expr: task.input.expr, slot }, ctx);
				let next: number;
				try {
					next = nextFireMs(task.input.expr, slot + 1);
				} catch {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { done: true } } }), ctx);
					return;
				}
				await runtime.commit(
					() => ({ status: "sleeping", until: next, checkpoint: { phase: "sleep", until: next } as CronCheckpoint }),
					ctx,
				);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "cron_deleted" } }), ctx);
		},
	});
}
