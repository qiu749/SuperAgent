/**
 * weagent.skill-hygiene-cron（SPEC-v3 §4.2）：每周日 03:00 的技能夜间大扫除。
 * 1) 僵尸技能归档：超过 60 天未命中且未 pinned 的技能移入 .archive/（runNightlyHygiene）；
 * 2) 低分技能诊治：views >= 3 且打回率 > 40% 的技能，拉最近 5 条用户反馈派后台 Curator 自动 patch。
 * 与 weagent.digest-cron 同款 defineTask + sleepUntil 持久化模式。
 */
import { defineTask } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";

export const SKILL_HYGIENE_TASK_NAME = "weagent.skill-hygiene-cron";

/** 下一个周日 03:00（毫秒时间戳）。 */
export function nextSundayThreeAm(from = Date.now()): number {
	const start = new Date(from);
	for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
		const day = new Date(start);
		day.setDate(day.getDate() + dayOffset);
		if (day.getDay() !== 0) continue;
		const t = new Date(day);
		t.setHours(3, 0, 0, 0);
		if (t.getTime() > from) return t.getTime();
	}
	return from + 7 * 24 * 3600_000;
}

export type SkillHygieneCheckpoint = { phase: "sleep"; until: number } | { phase: "fire"; slot: number };

export type SkillHygieneInput = Record<string, never>;

export function createSkillHygieneCronTask(host: WeAgentHost) {
	return defineTask<SkillHygieneInput, SkillHygieneCheckpoint, { done: boolean }, object>({
		name: SKILL_HYGIENE_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "sleep", until: nextSundayThreeAm() }),
		phases: {
			sleep: async (task, runtime, ctx) => {
				await runtime.sleepUntil(task.state.checkpoint.until, { phase: "fire", slot: task.state.checkpoint.until }, ctx);
			},
			fire: async (task, runtime, ctx) => {
				const slot = task.state.checkpoint.slot;
				await host.fireSkillHygiene(ctx);
				const next = nextSundayThreeAm(slot + 1);
				await runtime.commit(
					() => ({ status: "sleeping", until: next, checkpoint: { phase: "sleep", until: next } as SkillHygieneCheckpoint }),
					ctx,
				);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "hygiene_disabled" } }), ctx);
		},
	});
}
