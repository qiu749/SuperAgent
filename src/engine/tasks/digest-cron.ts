/**
 * weagent.digest-cron（SPEC-v2 §7.3）：工作日在 DIGEST_TIMES 时点扫描各用户 pending_digest
 * 草稿，合并成一张批量摘要卡推送（0 条静默结束）。持久化睡眠，进程重启自动恢复倒计时。
 * 与 weagent.cron 同款 defineTask + sleepUntil 模式；fire 幂等由 outbox dedupKey（digest:{user}:{slot}）保证。
 */
import { defineTask } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";

export const DIGEST_TASK_NAME = "weagent.digest-cron";

export type DigestCheckpoint = { phase: "sleep"; until: number } | { phase: "fire"; slot: number };

/** 计算下一个批量摘要时点（毫秒时间戳）。times 为 "HH:MM" 列表，仅工作日（周一~周五）触发。 */
export function nextDigestFireMs(times: string[], from = Date.now()): number {
	const list = (times.length > 0 ? times : ["10:00", "17:00"])
		.map((t) => {
			const [h, m] = t.split(":").map(Number);
			return { h, m };
		})
		.sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));
	const start = new Date(from);
	for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
		const day = new Date(start);
		day.setDate(day.getDate() + dayOffset);
		const dow = day.getDay();
		if (dow === 0 || dow === 6) continue;
		for (const { h, m } of list) {
			const t = new Date(day);
			t.setHours(h, m, 0, 0);
			if (t.getTime() > from) return t.getTime();
		}
	}
	return from + 24 * 3600_000;
}

export type DigestInput = Record<string, never>;

export function createDigestCronTask(host: WeAgentHost) {
	return defineTask<DigestInput, DigestCheckpoint, { done: boolean }, object>({
		name: DIGEST_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "sleep", until: nextDigestFireMs(host.digestTimes()) }),
		phases: {
			sleep: async (task, runtime, ctx) => {
				await runtime.sleepUntil(task.state.checkpoint.until, { phase: "fire", slot: task.state.checkpoint.until }, ctx);
			},
			fire: async (task, runtime, ctx) => {
				const slot = task.state.checkpoint.slot;
				await host.fireDigestBatch(slot, ctx);
				const next = nextDigestFireMs(host.digestTimes(), slot + 1);
				await runtime.commit(
					() => ({ status: "sleeping", until: next, checkpoint: { phase: "sleep", until: next } as DigestCheckpoint }),
					ctx,
				);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "digest_disabled" } }), ctx);
		},
	});
}
