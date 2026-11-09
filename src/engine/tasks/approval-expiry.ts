/**
 * weagent.approval-expiry（SPEC §7/§12）：每条待审批草稿一个 Pi Durable 任务，
 * 睡到过期时刻；醒来后由宿主把草稿标记 expired 并通知 Worker 与用户。
 * 用户决定（批准/拒绝）后任务被 abort，正常终局。
 */
import { defineTask } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";

export const APPROVAL_EXPIRY_TASK_NAME = "weagent.approval-expiry";

export type ApprovalExpiryInput = {
	approvalId: string;
	until: number;
};

export type ApprovalExpiryCheckpoint =
	| { phase: "sleep"; until: number }
	| { phase: "fire" };

export function createApprovalExpiryTask(host: WeAgentHost) {
	return defineTask<ApprovalExpiryInput, ApprovalExpiryCheckpoint, { expired: boolean }, object>({
		name: APPROVAL_EXPIRY_TASK_NAME,
		version: 1,
		initial: (input) => ({ phase: "sleep", until: input.until }),
		phases: {
			sleep: async (task, runtime, ctx) => {
				await runtime.sleepUntil(task.state.checkpoint.until, { phase: "fire" }, ctx);
			},
			fire: async (_task, runtime, ctx) => {
				// 醒来（=过期）：宿主侧 CAS（仅 pending 会被置 expired），幂等。
				await host.expireApproval(_task.input.approvalId, ctx);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { expired: true } } }), ctx);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "decided" } }), ctx);
		},
	});
}
