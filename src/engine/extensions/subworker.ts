/**
 * Sub-Worker 并行分治扩展（Map-Reduce Subagents，SPEC-v3 §4.1 M11）：
 * - 提供 spawn_subworkers 工具，允许主 Worker 派生最多 5 个只读并发子会话处理子任务；
 * - 子会话禁止调用 propose_action 等外部副作用工具，最大 6 轮推理，仅向主 Worker 返回精炼结构化结论（≤600 字），
 *   防止多源网页调研或批量文档对比撑爆主 Worker 上下文。
 */
import { arr, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";

export const SUBWORKER_EXTENSION_NAME = "weagent-subworker";

export type SubworkerTaskSpec = {
	id: string;
	title: string;
	prompt: string;
	tools_profile?: "read_only_research" | "kb_and_code";
};

export function createSubworkerExtension(host: WeAgentHost) {
	const spawnSubworkers = defineTool({
		name: "spawn_subworkers",
		description:
			"派生多个并行只读子代理（Sub-Workers）分头完成独立子任务（如同时调研多个开源库、对比多份文档），最后将精炼结论汇总返回给你。单次最多 5 个子任务；子代理仅具只读检索/计算权限，不能直接提审批草稿。",
		parameters: obj({
			subtasks: arr(
				obj({
					id: str({ description: "子任务短标识（如 sub-1）", minLength: 1, maxLength: 40 }),
					title: str({ description: "子任务标题", minLength: 1, maxLength: 120 }),
					prompt: str({ description: "给子代理的具体指令与输出格式要求", minLength: 1, maxLength: 2000 }),
					tools_profile: opt(oneOf(["read_only_research", "kb_and_code"])),
				}),
				{ minItems: 1, maxItems: 5 },
			),
			concurrency: opt(num({ description: "最大并发数（默认 3，上限 5）" })),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			try {
				const r = await host.spawnSubworkers(
					api.conversationId,
					args.subtasks as SubworkerTaskSpec[],
					Math.min(5, Math.max(1, args.concurrency ?? 3)),
					ctx,
				);
				return { output: [{ type: "text", text: r.observation }], details: { results: r.results } };
			} catch (err) {
				return { isError: true, output: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
			}
		},
	});

	return defineExtension({
		name: SUBWORKER_EXTENSION_NAME,
		tools: [spawnSubworkers],
	});
}
