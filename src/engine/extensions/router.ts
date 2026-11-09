/**
 * Router 扩展（SPEC §5）：route_decision（批量、30 词注记硬限制、原文直传）、
 * ticket_note、cron_*、轻量只读工具与 router-rules section。
 *
 * 核心铁律：Router 严禁扩写用户需求——派单只传 trigger_id，宿主机自动把
 * 用户原始消息全文原封不动交给 Worker（本文件不出现原文）。
 */
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { AssistantEntry, defineExtension, defineTool, GenerationTask, hook, section, type ToolRegistration } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";
import { checkAckWords, checkNoteWords } from "../../util/text.ts";

export const ROUTER_EXTENSION_NAME = "weagent-router";
export const ROUTER_RULES_KEY = "router-rules";
export const ACTIVE_TASKS_KEY = "active-tasks";
export const RECENT_CHAT_KEY = "recent-chat-context";
export const RECENT_INBOX_KEY = "recent-inbox-files";

type RouteDecision = {
	kind: "accept" | "attach" | "stop" | "ignore";
	trigger_id: string;
	task_id?: number;
	title?: string;
	acknowledgement?: string;
	note?: string;
	budget?: "small" | "medium" | "large";
	attach_inbox_files?: string[];
	reason?: string;
};

export function createRouterExtension(host: WeAgentHost) {
	const routeDecision = defineTool({
		name: "route_decision",
		description:
			"对一张或多张候选卡（每个 trigger_id 一项）做出路由决定。批量候选可在一次调用里逐项处理。accept=新建任务；attach=转达给现有任务；stop=停止任务；ignore=忽略。严禁把用户一句话扩写成实现计划或验收标准——你只路由，方案由 Worker 依据原文制定。",
		parameters: obj({
			decisions: arr(
				obj({
					kind: oneOf(["accept", "attach", "stop", "ignore"] as const),
					trigger_id: str({ minLength: 1 }),
					task_id: opt(int({ minimum: 1 })),
					title: opt(str({ description: "accept：≤200 字符的短标题，只概括原始请求", maxLength: 200 })),
					acknowledgement: opt(
						str({
							description:
								"accept 必填：≤50 词的一句话具体回执，指明处理对象与预期产出，如「收到，开始调研 MCP 邮件生态并整理对比表（任务 #3）」。禁止「好的我来处理」这种空话。",
							maxLength: 300,
						}),
					),
					note: opt(
						str({
							description:
								"accept/attach 可选：≤30 词的路由背景或跨任务约束（代码级校验）。严禁写实现步骤、验收标准或替换原文。",
							maxLength: 400,
						}),
					),
					budget: opt(oneOf(["small", "medium", "large"] as const)),
					attach_inbox_files: opt(arr(str({ minLength: 1, maxLength: 64 }), { description: "accept 可选：要绑定到本任务的收件箱文件 inbox_id 列表（见 recent-inbox-files section）", maxItems: 5 })),
					reason: opt(str({ description: "ignore/stop：原因，≤500 字符", maxLength: 500 })),
				}),
			),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const userId = await host.userIdForConversation(api.conversationId);
			if (!userId) return { output: [{ type: "text", text: "错误：Router 会话没有归属用户。" }] };
			const lines: string[] = [];
			for (const [i, d] of args.decisions.entries()) {
				const item = d as RouteDecision;
				try {
					lines.push(`#${i + 1} ${item.trigger_id}: ${await applyDecision(host, userId, item, ctx)}`);
				} catch (err) {
					lines.push(`#${i + 1} ${item.trigger_id}: 拒绝 —— ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return { output: [{ type: "text", text: lines.join("\n") || "（空决定）" }] };
		},
	});

	const ticketNote = defineTool({
		name: "ticket_note",
		description: "向正在运行的某任务的 Worker 传递一条来自其他任务的简短事实（≤100 词，仅作上下文参考，不是指令）。",
		parameters: obj({
			task_id: int({ minimum: 1 }),
			text: str({ description: "≤100 词的事实", minLength: 1, maxLength: 600 }),
		}),
		replay: "safe",
		execute: async (args, _api, ctx) => {
			const r = await host.ticketNote(args.task_id, args.text, ctx);
			return { output: [{ type: "text", text: r.observation }] };
		},
	});

	const cronCreate = defineTool({
		name: "cron_create",
		description: "创建持久化定时任务（进程重启后自动恢复）。到点后该 prompt 会作为触发器交给 Router 分诊。",
		parameters: obj({
			expr: str({ description: "5 段 cron 表达式（本地时区），如「0 9 * * 1-5」", minLength: 9, maxLength: 100 }),
			prompt: str({ description: "到点后交给 Router 的任务描述", minLength: 1, maxLength: 1000 }),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const userId = await host.userIdForConversation(api.conversationId);
			if (!userId) return { output: [{ type: "text", text: "错误：Router 会话没有归属用户。" }] };
			const r = await host.cronCreate(userId, args.expr, args.prompt, ctx);
			return { output: [{ type: "text", text: r.observation }] };
		},
	});

	const cronList = defineTool({
		name: "cron_list",
		description: "列出当前用户的定时任务。",
		parameters: obj({}),
		replay: "safe",
		execute: async (_args, api) => {
			const userId = await host.userIdForConversation(api.conversationId);
			if (!userId) return { output: [{ type: "text", text: "错误：Router 会话没有归属用户。" }] };
			return { output: [{ type: "text", text: await host.cronList(userId) }] };
		},
	});

	const cronDelete = defineTool({
		name: "cron_delete",
		description: "删除一个定时任务。",
		parameters: obj({ id: str({ minLength: 1 }) }),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const userId = await host.userIdForConversation(api.conversationId);
			if (!userId) return { output: [{ type: "text", text: "错误：Router 会话没有归属用户。" }] };
			const r = await host.cronDelete(userId, args.id, ctx);
			return { output: [{ type: "text", text: r.observation }] };
		},
	});

	const getCalendar = defineTool({
		name: "get_calendar_events",
		description: "读取用户日程（轻量只读，来自 DATA_DIR/calendar.json；接入真实日历后由 MCP 工具替换）。用于「明天几点开会？」这类 2 秒直答。",
		parameters: obj({}),
		replay: "safe",
		execute: async (_args, api) => {
			const userId = await host.userIdForConversation(api.conversationId);
			if (!userId) return { output: [{ type: "text", text: "错误：Router 会话没有归属用户。" }] };
			return { output: [{ type: "text", text: await host.readCalendar(userId) }] };
		},
	});

	const routerRules = section(ROUTER_RULES_KEY, () => ROUTER_RULES_TEXT);
	const activeTasks = section(ACTIVE_TASKS_KEY, async (input) => {
		try {
			const userId = await host.userIdForConversation(input.conversationId);
			if (!userId) return undefined;
			return await host.activeTasksCard(userId);
		} catch {
			return undefined;
		}
	});
	// 聊天窗口最近消息流（含后台 Worker 直接发出的完成汇报与回执），供 Router 识别「切换内容」「暂停」等紧接上一条消息的短句接续
	const recentChat = section(RECENT_CHAT_KEY, async (input) => {
		try {
			const userId = await host.userIdForConversation(input.conversationId);
			if (!userId) return undefined;
			return await host.recentChatContext(userId);
		} catch {
			return undefined;
		}
	});
	// v1.0 M6：最近 10 分钟上传未绑定任务的收件箱文件（accept 时可用 attach_inbox_files 绑定）
	const recentInbox = section(RECENT_INBOX_KEY, async (input) => {
		try {
			return await host.renderRecentInbox(input.conversationId);
		} catch {
			return undefined;
		}
	});

	// Router 最终回答投递（SPEC §5 直答场景）：accept/attach/stop 有回执 → 抑制；
	// inferred 触发 → 影子模式不打扰；普通直答 → Outbox 发送（100 词校验在 Outbox）。
	const replyDelivery = hook(GenerationTask, {
		afterRun: async (run, api, ctx) => {
			try {
				const entry = await api.entry(run.answer, ctx);
				if (!entry) return;
				if (!AssistantEntry.is(entry)) return;
				const msg = entry.model?.[0];
				if (!msg || msg.role !== "assistant") return;
				const text = Array.isArray(msg.content)
					? msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n")
					: "";
				if (text.trim()) await host.deliverRouterReply(api.conversationId, text);
			} catch {
				// 投递失败不影响 Router 本身
			}
			return undefined;
		},
	});

	return defineExtension({
		name: ROUTER_EXTENSION_NAME,
		tools: [routeDecision, ticketNote, cronCreate, cronList, cronDelete, getCalendar] as ToolRegistration[],
		sections: [routerRules, activeTasks, recentChat, recentInbox],
		hooks: [replyDelivery],
	});
}

async function applyDecision(host: WeAgentHost, userId: string, d: RouteDecision, ctx: Parameters<WeAgentHost["routeAccept"]>[6]): Promise<string> {
	switch (d.kind) {
		case "accept": {
			if (!d.title) throw new Error("accept 缺少 title");
			if (!d.acknowledgement?.trim()) throw new Error("accept 缺少 acknowledgement（必填的具体回执）");
			if (/^(好的|收到|明白|ok|okay|我来处理|马上处理)[。!！.~\s]*$/i.test(d.acknowledgement.trim())) {
				throw new Error("acknowledgement 是空话：必须指明处理对象和预期产出");
			}
			const safeAck = d.acknowledgement.trim().slice(0, 140);
			const safeNote = (d.note ?? "").trim().slice(0, 120);
			const r = await host.routeAccept(d.trigger_id, d.title, safeAck, safeNote, d.budget ?? "medium", d.attach_inbox_files ?? [], ctx);
			return r.observation;
		}
		case "attach": {
			if (!d.task_id) throw new Error("attach 缺少 task_id");
			const safeNote = (d.note ?? "").trim().slice(0, 120);
			const r = await host.routeAttach(d.trigger_id, d.task_id, ctx, safeNote);
			return r.observation;
		}
		case "stop": {
			if (!d.task_id) throw new Error("stop 缺少 task_id");
			const r = await host.routeStop(d.trigger_id, d.task_id, ctx);
			return r.observation;
		}
		case "ignore": {
			if (!d.reason?.trim()) throw new Error("ignore 必须说明 reason");
			const r = await host.routeIgnore(d.trigger_id, d.reason, ctx);
			return r.observation;
		}
	}
}

export const ROUTER_RULES_TEXT = `# 角色
你是企业微信/飞书用户的常驻数字助理（Router）。你的职责是分诊与快答：把需要实际执行的事务派给后台 Worker，把简单问题直接回答掉。你面前有候选卡（trigger）列表，每张卡带 trigger_id 与原文引用。

# 铁律（原文直传、上下文接续与防重复建单）
- 严禁替 Worker 写方案：不要扩写用户需求为实现计划、步骤清单或验收标准。派单时只给 trigger_id，宿主机会把用户的原始消息全文原封不动交给 Worker。
- accept 必须给具体回执（≤50 词，指明处理对象与预期产出），禁止空话。
- note ≤30 词，只允许路由背景或跨任务约束。
- **严禁重复新建同类任务（防重铁律）**：
  - 当用户重复派发、催促、说「继续 xxx」或微调同一个目标的指令（如先发「给熊喵喵发微信」，又发「继续给熊喵喵发微信」「在macbook打开微信给熊喵喵发我爱你」「现在发」）时，只要 \`<active-tasks>\` 中已经存在相同目标的任务（无论状态是 \`working\`、\`waiting_user\`、\`waiting_approval\`、\`ready\` 还是 \`cancelled\`），**必须调用 \`route_decision(kind="attach", task_id=已有任务号)\` 复用该任务**，绝不允许再用 \`accept\` 新建第二个重复任务！
  - 调用了 \`route_decision\`（accept/attach/stop）之后，宿主机已经自动向用户发送了回执，你**不要**再在正文中重复输出大段解释。
- **上下文自然接续（优先检查 recent-chat-context 与 active-tasks）**：
  - 后台 Worker 的完成汇报（如「✅ 任务 #5 完成：…需要暂停、搜索或切换内容随时说」）是直接发到用户聊天窗口的，见 \`<recent-chat-context>\` 时间线。
  - 当用户发送简短的后续动作指令（如「切换内容」「暂停」「下一个」「继续」「换一个」「搜索 xxx」）时，**必须先对照 \`<recent-chat-context>\` 中刚刚发给用户的上一条任务汇报**！若该短句明显是在回应刚汇报完（状态 ready）或正在运行（状态 working）的某任务（即使没写 #任务号），**必须直接调用 \`route_decision(kind="attach", task_id=该任务号)\` 原地唤醒该任务继续执行**，严禁反问「你想切换什么内容？」或漏调 \`route_decision\`！
  - 当用户发送跨软件纠偏消息（如先发「在抖音给熊喵喵发送：我爱你宝宝」，紧接着发「错了，是微信里」）而你决定 stop 旧任务并 accept 新任务时，**必须在 accept 的 \`note\` 中把前一条消息的关键上下文（如收件人与要发送的原话）补齐**。
- 只有在与现有任务无关的全新独立话题时，才用 accept 新建任务；刚被某任务 handback 退回的消息，严禁再 attach 回那个任务。
- Webhook/巡检等 inferred 事件先判断是否命中用户预设规则；未命中或无需人类介入一律 ignore 并说明原因。
- 能用轻量只读工具（get_calendar_events）+ 记忆直接回答的问题，不要开任务。
- 用户要求停止某任务时用 stop；用户闲聊/感谢用 ignore。` as const;
