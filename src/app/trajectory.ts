/**
 * H5 轨迹时光机与任意节点分叉重跑服务（Trajectory Time-Machine & Fork Replay，SPEC-v3 §5 M12）：
 * - 统一融合 pi.sqlite 的底层 Journal 事件流（带真实 entry.id 供 conversation.fork 使用）
 *   与 app.sqlite 的业务时间轴节点（Router 决策、审批卡点、Sub-Worker 并发组、Computer Use 截图与红圈准星图）；
 * - 支持 forkTaskFromTrajectory(taskId, { atSeq, overridePrompt })：
 *   从指定历史步序号克隆出新任务分支（parent_task_id, forked_at_seq），注入用户的修正提示词重跑。
 */
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Extension } from "@earendil-works/pi-durable";
import pino from "pino";
import type { WeAgentCore } from "./core.ts";
import { toConvId } from "./core.ts";
import { getTask } from "./tasks.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "trajectory" });

export type TrajectoryNodeKind =
	| "trigger_inbound"
	| "router_decision"
	| "user_input"
	| "llm_turn"
	| "tool_call"
	| "computer_frame"
	| "subworker_group"
	| "approval_gate"
	| "worker_report"
	| "skill_crystallized";

export type TrajectoryNode = {
	seq: number;
	nodeId: string;
	piEventId?: number;
	conversationId: string;
	kind: TrajectoryNodeKind;
	timestamp: number;
	durationMs?: number;
	title: string;
	detail: Record<string, unknown>;
	screenshotUrl?: string;
	costUsd?: number;
	tokens?: { prompt: number; completion: number };
};

export type TaskTrajectoryBundle = {
	taskId: number;
	title: string;
	stage: string;
	parentTaskId: number | null;
	forkedAtSeq: number | null;
	totalNodes: number;
	totalCostUsd: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	nodes: TrajectoryNode[];
};

export class TrajectoryService {
	constructor(private readonly core: WeAgentCore) {}

	/** 记录一条业务/视觉轨迹节点到 trajectory_events 表。 */
	async recordEvent(input: {
		taskId: number;
		conversationId: string;
		kind: TrajectoryNodeKind;
		title: string;
		detail?: Record<string, unknown>;
		piEventId?: number | null;
		screenshotPath?: string | null;
		durationMs?: number | null;
		promptTokens?: number;
		completionTokens?: number;
		costUsd?: number;
	}): Promise<number> {
		const existing = await this.core.db
			.selectFrom("trajectory_events")
			.where("task_id", "=", input.taskId)
			.orderBy("seq", "desc")
			.select("seq")
			.executeTakeFirst();
		const nextSeq = (existing?.seq ?? 0) + 1;
		await this.core.db
			.insertInto("trajectory_events")
			.values({
				task_id: input.taskId,
				seq: nextSeq,
				node_id: `tn_${input.taskId}_${nextSeq}`,
				pi_event_id: input.piEventId ?? null,
				conversation_id: input.conversationId,
				kind: input.kind,
				title: input.title,
				detail_json: JSON.stringify(input.detail ?? {}),
				screenshot_path: input.screenshotPath ?? null,
				duration_ms: input.durationMs ?? null,
				prompt_tokens: input.promptTokens ?? 0,
				completion_tokens: input.completionTokens ?? 0,
				cost_usd: input.costUsd ?? 0,
				created_at: Date.now(),
			})
			.execute();
		return nextSeq;
	}

	/**
	 * 组装指定任务的完整时间轴（融合 pi.sqlite entries + trajectory_events + approvals）。
	 */
	async getTaskTrajectory(taskId: number): Promise<TaskTrajectoryBundle | null> {
		const task = await getTask(this.core.db, taskId);
		if (!task) return null;

		const rawNodes: Omit<TrajectoryNode, "seq">[] = [];

		// 1. 起始触发器与 Router 分诊节点
		const trigger = await this.core.getTrigger(task.origin_trigger_id);
		if (trigger) {
			const payload = JSON.parse(trigger.payload) as { text: string };
			rawNodes.push({
				nodeId: `trig_${trigger.id}`,
				conversationId: task.conv_id,
				kind: "trigger_inbound",
				timestamp: trigger.created_at,
				title: `入站触发 (${trigger.source} / ${trigger.strength})`,
				detail: { triggerId: trigger.id, text: payload.text, threadKey: trigger.thread_key },
			});
		}

		// 2. 读取 pi.sqlite 中的真实底层会话 Journal（带 entry.id 作为 piEventId）
		const piNodes = this.readPiJournalNodes(this.core.cfg.piDbPath, task.conv_id);
		rawNodes.push(...piNodes);

		// 3. 读取业务扩展轨迹表 trajectory_events（含 Computer Use 截图帧、红圈准星、Sub-Worker 汇总等）
		const customRows = await this.core.db
			.selectFrom("trajectory_events")
			.where("task_id", "=", taskId)
			.orderBy("created_at", "asc")
			.orderBy("seq", "asc")
			.selectAll()
			.execute();

		for (const row of customRows) {
			const frameName = row.screenshot_path ? row.screenshot_path.split("/").pop() : undefined;
			rawNodes.push({
				nodeId: row.node_id,
				piEventId: row.pi_event_id ?? undefined,
				conversationId: row.conversation_id,
				kind: row.kind as TrajectoryNodeKind,
				timestamp: row.created_at,
				durationMs: row.duration_ms ?? undefined,
				title: row.title,
				detail: JSON.parse(row.detail_json) as Record<string, unknown>,
				screenshotUrl: frameName ? `/api/panel/tasks/${taskId}/frames/${encodeURIComponent(frameName)}` : undefined,
				costUsd: row.cost_usd || undefined,
				tokens:
					row.prompt_tokens || row.completion_tokens
						? { prompt: row.prompt_tokens, completion: row.completion_tokens }
						: undefined,
			});
		}

		// 4. 读取审批卡点记录
		const approvals = await this.core.db
			.selectFrom("approvals")
			.where("task_id", "=", taskId)
			.orderBy("created_at", "asc")
			.selectAll()
			.execute();
		for (const ap of approvals) {
			const payloadObj = JSON.parse(ap.payload) as Record<string, unknown>;
			const frameFile = typeof payloadObj.crosshairFrame === "string" ? payloadObj.crosshairFrame : undefined;
			rawNodes.push({
				nodeId: `ap_${ap.id}`,
				conversationId: ap.conv_id,
				kind: "approval_gate",
				timestamp: ap.created_at,
				title: `草稿审批 #${ap.id} [${ap.action_type}] → ${ap.status}`,
				detail: {
					approvalId: ap.id,
					actionType: ap.action_type,
					status: ap.status,
					preview: ap.preview,
					payload: payloadObj,
					userEditFeedback: ap.user_edit_feedback,
				},
				screenshotUrl: frameFile ? `/api/panel/tasks/${taskId}/frames/${encodeURIComponent(frameFile)}` : undefined,
			});
		}

		// 按时间戳稳定排序并赋予连续序号 1..N，同时为没有 piEventId 的节点继承最近的前驱 piEventId（确保任意一步都可 fork）
		rawNodes.sort((a, b) => a.timestamp - b.timestamp);
		let lastPiEventId: number | undefined;
		for (const n of rawNodes) {
			if (n.piEventId !== undefined) {
				lastPiEventId = n.piEventId;
				break;
			}
		}

		const nodes: TrajectoryNode[] = rawNodes.map((n, idx) => {
			if (n.piEventId !== undefined) lastPiEventId = n.piEventId;
			return {
				...n,
				seq: idx + 1,
				piEventId: n.piEventId ?? lastPiEventId,
			};
		});

		// 汇总任务成本账单
		const usageRows = await this.core.db
			.selectFrom("token_usage_ledger")
			.where("task_id", "=", taskId)
			.selectAll()
			.execute();
		const totalCostUsd = Number(usageRows.reduce((s, r) => s + r.cost_usd, 0).toFixed(6));
		const totalPromptTokens = usageRows.reduce((s, r) => s + r.prompt_tokens, 0);
		const totalCompletionTokens = usageRows.reduce((s, r) => s + r.completion_tokens, 0);

		return {
			taskId: task.id,
			title: task.title,
			stage: task.stage,
			parentTaskId: (task as { parent_task_id?: number | null }).parent_task_id ?? null,
			forkedAtSeq: (task as { forked_at_seq?: number | null }).forked_at_seq ?? null,
			totalNodes: nodes.length,
			totalCostUsd,
			totalPromptTokens,
			totalCompletionTokens,
			nodes,
		};
	}

	/**
	 * 从任务 #taskId 的指定时间轴节点序号 atSeq 分叉出新任务并注入修正指令重跑（SPEC-v3 §5.2）。
	 */
	async forkTaskFromTrajectory(
		taskId: number,
		input: { atSeq: number; overridePrompt: string },
		ctx: Context = BACKGROUND_CONTEXT,
	): Promise<{ newTaskId: number; parentTaskId: number; forkedAtSeq: number; forkedPiEventId: number }> {
		const task = await getTask(this.core.db, taskId);
		if (!task) throw new Error(`任务 #${taskId} 不存在`);
		const bundle = await this.getTaskTrajectory(taskId);
		if (!bundle || bundle.nodes.length === 0) throw new Error(`任务 #${taskId} 尚无轨迹节点可供分叉`);

		const targetNode =
			bundle.nodes.find((n) => n.seq === input.atSeq) ??
			bundle.nodes[Math.min(bundle.nodes.length - 1, Math.max(0, input.atSeq - 1))]!;

		const parentConv = await this.core.harness.conversation(toConvId(task.conv_id), ctx);
		if (!parentConv) throw new Error(`父任务会话 ${task.conv_id} 不存在`);

		const entriesPage = await parentConv.entries({ order: "ascending" }, 200, undefined, ctx);
		if (entriesPage.items.length === 0) throw new Error(`父任务会话没有任何持久化条目`);

		const chosenPiEventId =
			targetNode.piEventId && entriesPage.items.some((e) => Number(e.id) === targetNode.piEventId)
				? targetNode.piEventId
				: Number(entriesPage.items[entriesPage.items.length - 1]!.id);

		const forkConv = await parentConv.fork(
			chosenPiEventId as never,
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: { provider: this.core.cfg.modelProvider, modelId: this.core.cfg.workerModel },
					extensions: [
						this.core.extensions.worker,
						this.core.extensions.mem0,
						this.core.extensions.skills,
						this.core.extensions.codemode,
						this.core.extensions.coding,
						this.core.extensions.computer,
						this.core.extensions.knowledge,
						this.core.extensions.subworker,
						this.core.extensions.mcp,
					].filter(Boolean) as Extension[],
				},
			},
			ctx,
		);

		const now = Date.now();
		const forkTitle = `${task.title} (Fork @#${targetNode.seq})`;
		await this.core.db
			.insertInto("tasks")
			.values({
				user_id: task.user_id,
				origin_trigger_id: task.origin_trigger_id,
				title: forkTitle,
				routing_note: `forked from #${taskId} @ seq ${targetNode.seq}`,
				conv_id: String(forkConv.id),
				latest_sub_id: null,
				stage: "working",
				latest_report: null,
				budget: task.budget,
				parent_task_id: taskId,
				forked_at_seq: targetNode.seq,
				created_at: now,
				updated_at: now,
			})
			.execute();

		const newTask = await this.core.db
			.selectFrom("tasks")
			.where("conv_id", "=", String(forkConv.id))
			.selectAll()
			.executeTakeFirstOrThrow();

		await this.recordEvent({
			taskId: newTask.id,
			conversationId: String(forkConv.id),
			kind: "user_input",
			title: `从父任务 #${taskId} 第 ${targetNode.seq} 步分叉重跑`,
			piEventId: chosenPiEventId,
			detail: {
				parentTaskId: taskId,
				forkedAtSeq: targetNode.seq,
				overridePrompt: input.overridePrompt,
			},
		});

		await this.core.wakeWorker({
			taskId: newTask.id,
			content: `[时光机分叉修正指令｜自步骤 #${targetNode.seq} 重跑]\n${input.overridePrompt}`,
			requestId: `fork:${taskId}:${targetNode.seq}:${now}`,
			entryKind: "weagent.fork",
			data: { parent_task_id: taskId, forked_at_seq: targetNode.seq },
			priority: "human",
		});

		log.info({ parentTaskId: taskId, newTaskId: newTask.id, atSeq: targetNode.seq }, "已从历史轨迹节点分叉重跑");
		return {
			newTaskId: newTask.id,
			parentTaskId: taskId,
			forkedAtSeq: targetNode.seq,
			forkedPiEventId: chosenPiEventId,
		};
	}

	private readPiJournalNodes(piDbPath: string, convId: string): Omit<TrajectoryNode, "seq">[] {
		const out: Omit<TrajectoryNode, "seq">[] = [];
		let store: DatabaseSync;
		try {
			store = new DatabaseSync(piDbPath, { readOnly: true });
		} catch {
			return out;
		}
		try {
			const rows = store
				.prepare("SELECT id, record FROM entries WHERE conversation_id = ? ORDER BY id ASC")
				.all(Number(convId)) as { id: number; record: string }[];
			for (const row of rows) {
				let rec: {
					kind?: string;
					createdAt?: number;
					model?: {
						role?: string;
						content?: unknown;
						toolName?: string;
						timestamp?: number;
					}[];
				};
				try {
					rec = JSON.parse(row.record);
				} catch {
					continue;
				}
				for (const m of rec.model ?? []) {
					const ts = typeof m.timestamp === "number" ? m.timestamp : (rec.createdAt ?? Date.now());
					const text = extractContentText(m.content);
					const toolCalls = extractToolCalls(m.content);
					if (m.role === "user" && text) {
						out.push({
							nodeId: `pi_${row.id}_u`,
							piEventId: Number(row.id),
							conversationId: convId,
							kind: "user_input",
							timestamp: ts,
							title: `输入: ${text.slice(0, 60)}`,
							detail: { role: "user", text: text.slice(0, 2000) },
						});
					} else if (m.role === "assistant") {
						const summary =
							toolCalls.length > 0
								? `调用工具: ${toolCalls.map((tc) => tc.name).join(", ")}`
								: `模型回复: ${text.slice(0, 60) || "(空)"}`;
						out.push({
							nodeId: `pi_${row.id}_a`,
							piEventId: Number(row.id),
							conversationId: convId,
							kind: "llm_turn",
							timestamp: ts,
							title: summary,
							detail: { role: "assistant", text: text.slice(0, 2000), toolCalls },
						});
					} else if (m.role === "toolResult") {
						out.push({
							nodeId: `pi_${row.id}_tr`,
							piEventId: Number(row.id),
							conversationId: convId,
							kind: "tool_call",
							timestamp: ts,
							title: `工具结果 [${m.toolName ?? "tool"}]: ${text.slice(0, 60)}`,
							detail: { toolName: m.toolName ?? "tool", result: text.slice(0, 1500) },
						});
					}
				}
			}
		} finally {
			store.close();
		}
		return out;
	}
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: string; text?: string } => typeof c === "object" && c !== null)
			.map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
			.filter(Boolean)
			.join(" ")
			.trim();
	}
	return "";
}

function extractToolCalls(content: unknown): { name: string; arguments?: unknown }[] {
	if (!Array.isArray(content)) return [];
	const out: { name: string; arguments?: unknown }[] = [];
	for (const item of content) {
		if (typeof item === "object" && item !== null && "type" in item && (item as { type: string }).type === "toolCall") {
			const tc = item as { name?: string; arguments?: unknown };
			if (tc.name) out.push({ name: tc.name, arguments: tc.arguments });
		}
	}
	return out;
}
