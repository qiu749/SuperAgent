/**
 * WeAgentHost：业务宿主接口（engine 层唯一依赖）。
 * SPEC §13：所有 @earendil-works/pi-* API 调用封装在 src/engine/ 内；
 * 扩展（工具/section/hook）只通过本接口回调业务层，不直接触碰 app.sqlite 或 Harness。
 */
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { MemoryItem } from "../app/memory.ts";
import type { SkillMeta, SkillOp } from "../app/skills.ts";
import type { KbChunkHit, ChunkItem } from "../app/knowledge.ts";
import type { ComputerActionInput } from "./extensions/computer.ts";
import type { SubworkerTaskSpec } from "./extensions/subworker.ts";

export type Budget = "small" | "medium" | "large";

export type WorkerReport = {
	state: "progress" | "ready" | "blocked" | "failed" | "dropped";
	summary: string;
	/** blocked 时必填：一次只问一个具体问题。 */
	humanAction?: string;
	/** ready 时可选：完整报告文件路径（写文件作为附件发送）。 */
	reportPath?: string;
};

export type TaskSummary = {
	id: number;
	title: string;
	stage: string;
	budget: Budget;
	latestReport: { state: string; summary: string } | null;
};

/** 引擎扩展回调宿主的接口。所有方法都允许抛错；错误文案会原样作为工具错误返回给模型。 */
export interface WeAgentHost {
	// ---------- Router 工具 ----------

	/** accept：新建任务（幂等 by trigger_id）。群聊线程自动建订阅；attachInboxFiles 绑定收件箱文件到任务工作区。 */
	routeAccept(triggerId: string, title: string, acknowledgement: string, note: string, budget: Budget, attachInboxFiles: string[], ctx: Context, force?: boolean): Promise<{ observation: string }>;
	/** attach：把补充/跟进消息转达给现有任务（若已结束且非人工 stop，则原地唤醒）。 */
	routeAttach(triggerId: string, taskId: number, ctx: Context, note?: string): Promise<{ observation: string }>;
	/** stop：中止指定任务。 */
	routeStop(triggerId: string, taskId: number, ctx: Context): Promise<{ observation: string }>;
	/** ignore：忽略噪音或未命中规则的外部事件；observe 模式下 accept 会降级为 would_accept 记录。 */
	routeIgnore(triggerId: string, reason: string, ctx: Context): Promise<{ observation: string }>;
	/** 向运行中的 Worker 传递来自其他任务的简短事实（≤100 词）。 */
	ticketNote(taskId: number, text: string, ctx: Context): Promise<{ observation: string }>;
	/** Worker thread_unrelated：群聊话题偏离 → 退订该线程（SPEC-v2 §3.3）。 */
	threadUnrelated(conversationId: ConversationId, threadKey: string, reason: string): Promise<{ observation: string }>;
	/** section 渲染：用户最近 10 分钟未绑定任务的收件箱文件（无则 undefined）。 */
	renderRecentInbox(conversationId: ConversationId): Promise<string | undefined>;

	// ---------- Router / Worker 共享：记忆（Mem0 防投毒入口见 Memory） ----------

	memorySearch(userId: string, query: string, topK: number): Promise<MemoryItem[]>;
	memoryRemember(userId: string, fact: string, source: "user" | "explicit" | "report"): Promise<string>;
	memoryList(userId: string): Promise<MemoryItem[]>;
	memoryForget(userId: string, memoryId: string): Promise<string>;

	// ---------- Router：cron 与轻量只读 ----------

	cronCreate(userId: string, expr: string, prompt: string, ctx: Context): Promise<{ id: string; observation: string }>;
	cronList(userId: string): Promise<string>;
	cronDelete(userId: string, id: string, ctx: Context): Promise<{ observation: string }>;
	// ---- 由 Durable 任务回调（engine/tasks/*） ----
	/** cron 任务到点：生成 Trigger 并提交 Router（source_msg_id 幂等）。 */
	fireCronTrigger(input: { jobId: string; userId: string; prompt: string; expr: string; slot: number }, ctx: Context): Promise<void>;
	/** cron 任务睡眠前检查任务是否仍启用。 */
	cronEnabled(jobId: string): Promise<boolean>;
	/** 审批过期任务醒来：CAS 把 pending 置为 expired 并通知。 */
	expireApproval(approvalId: string, ctx: Context): Promise<void>;
	/** 轻量只读工具示例：读本地日程（DATA_DIR/calendar.json）。 */
	readCalendar(userId: string): Promise<string>;

	// ---------- section 渲染 ----------

	/** 当前用户的活跃/待审批/刚结束任务卡片列表（Router section "active-tasks"）。 */
	activeTasksCard(userId: string): Promise<string>;
	/** 当前用户聊天窗口最近的消息时间线（含 Worker 直接发出的汇报/回执与用户消息，供 Router 识别「切换内容」等短句接续）。 */
	recentChatContext(userId: string): Promise<string | undefined>;
	/** 会话最近一条用户输入原文（Mem0 检索 query 用）。 */
	latestUserText(conversationId: ConversationId, ctx: Context): Promise<string | undefined>;
	/** 由会话 ID 反查所属用户（Router 会话查 users.router_conv_id；Worker 会话查 tasks.conv_id）。 */
	userIdForConversation(conversationId: ConversationId): Promise<string | undefined>;
	/** Router afterRun 回调：按回执/影子模式规则决定是否投递 Router 的文本回答。 */
	deliverRouterReply(conversationId: ConversationId, answerText: string): Promise<void>;

	// ---------- Worker 工具 ----------

	/** 会话上下文：由 conversationId 反查任务与用户（worker 工具都需要）。workspace = 任务工作目录绝对路径（bash/read/write 的路径基准）。 */
	workerContext(
		conversationId: ConversationId,
	): Promise<{ taskId: number; userId: string; taskTitle: string; routingNote?: string; recentDialogue?: string; workspace: string } | undefined>;
	/** 任务的来源线程标识（trigger.thread_key；群聊任务用它退订）。 */
	taskThreadKey(taskId: number): Promise<string | undefined>;
	/**
	 * 草稿工具：写 approvals 表并按信任策略路由（SPEC-v2 §7.2）：
	 * auto_notify → 宿主机直接执行 + 事后通知（不停机）；digest/urgency=digest → pending_digest 池；
	 * always_ask（默认）→ 单卡审批 + 停机。幂等（同参数同 id）。
	 */
	proposeAction(input: { conversationId: ConversationId; actionType: string; payload: Record<string, unknown>; preview: string; isFinal: boolean; scopeKey?: string; urgency?: "immediate" | "digest" }, ctx: Context): Promise<{ approvalId: string; observation: string }>;
	/** 结构化收尾汇报（SPEC §6.1 五态）。 */
	workerReport(input: { conversationId: ConversationId; report: WorkerReport }, ctx: Context): Promise<{ observation: string }>;
	/** 越界退回：每个 trigger_id 最多一次。 */
	triggerHandback(input: { conversationId: ConversationId; triggerId: string; reason: string }, ctx: Context): Promise<{ observation: string }>;
	/** 追问卡片：一次只问一个具体问题。 */
	askUser(input: { conversationId: ConversationId; question: string; options: string[] }, ctx: Context): Promise<{ askId: string; observation: string }>;
	/** 把长报告写入任务产物目录，返回文件路径（IM 只发短摘要）。 */
	writeTaskArtifact(taskId: number, filename: string, content: string): Promise<string>;

	// ---------- 重度执行环境（SPEC-v2 §9） ----------

	/** request_browser_login：截图+卡片+远程协助链接推送，本轮结束等用户完成后唤醒。 */
	requestBrowserLogin(input: { conversationId: ConversationId; url: string; siteName: string }, ctx: Context): Promise<{ observation: string }>;
	/** delegate_coding：按 REPOS 配置准备 git worktree 隔离工作区，返回给 Worker 的执行指引。 */
	delegateCoding(input: { conversationId: ConversationId; repoKey: string; instruction: string }, ctx: Context): Promise<{ observation: string }>;
	/** 浏览器登录完成回调（br:{token}:done 卡片）：唤醒等待中的 Worker。 */
	completeBrowserLogin(token: string, responseCode?: string): Promise<{ handled: boolean; message: string }>;

	// ---------- 批量摘要（digest-cron 回调，SPEC-v2 §7.3） ----------

	/** digest 时点配置（"HH:MM" 列表）。 */
	digestTimes(): string[];
	/** digest-cron 到点：给每个有 pending_digest 草稿的用户合并推送批量摘要卡（幂等 by slot）。 */
	fireDigestBatch(slot: number, ctx: Context): Promise<void>;

	// ---------- v3.0：主动传感器与技能巡检（durable cron 回调，SPEC-v3 §3.1/§4.2） ----------

	/** calendar-prep 传感器到点：扫描 15 分钟内开始的日程并入站 immediate 事件（幂等），返回本次新触发数。 */
	fireCalendarSensor(ctx: Context): Promise<number>;
	/** skill-hygiene-cron 到点：僵尸技能归档 + 低分技能派 Curator 自动 patch。 */
	fireSkillHygiene(ctx: Context): Promise<{ archived: string[]; patched: string[] }>;

	// ---------- 技能与习惯（SPEC-v2 §8） ----------

	/** 技能索引（name + description 列表）。 */
	skillsList(): Promise<SkillMeta[]>;
	/** 读取 SKILL.md 或支持文件；复盘分叉上下文中登记已读（先读后写守卫）。 */
	skillView(conversationId: ConversationId, name: string, filePath?: string): Promise<{ path: string; content: string }>;
	/** 原子批量技能操作（复盘分叉上下文启用先读后写；返回逐条结果说明）。 */
	skillManage(conversationId: ConversationId, operations: SkillOp[]): Promise<{ observation: string }>;
	/** section 渲染：技能轻量索引（无技能时 undefined）。 */
	renderSkillsIndex(conversationId: ConversationId): Promise<string | undefined>;
	/** section 渲染：已学到的用户习惯（无习惯时 undefined）。 */
	renderLearnedHabits(conversationId: ConversationId): Promise<string | undefined>;

	// ---------- 后台复盘分叉（SPEC-v2 §8.3） ----------

	/** 任务轮次终态后派生 Curator 复盘会话（白名单工具，复用父上下文命中前缀缓存）。 */
	startBackgroundReview(input: { taskId: number; userId: string; conversationId: ConversationId; taskTitle: string; summary: string }, ctx: Context): Promise<void>;
	/** 新用户消息到达：2 秒内抢占中止该用户的全部活跃复盘（绝不阻塞前台）。 */
	cancelBackgroundReviewsForUser(userId: string): void;
	/** 一次性补全调用（习惯提炼等宿主内部小任务；复用 router 模型）。 */
	completeOnce(userId: string, prompt: string): Promise<string>;

	// ---------- v3.0：Computer Use / Hybrid RAG / Sub-Worker ----------

	/** Computer Use 视觉桌面动作（支持 mark_id SoM 与多制式坐标、红圈准星审批停机、aHash 死循环检测）。 */
	computerAction(
		conversationId: ConversationId,
		input: ComputerActionInput,
		ctx: Context,
	): Promise<{ observation: string; imageBase64?: string; details?: Record<string, unknown> }>;

	/** 全局桌面互斥锁：保证同一时刻只有一个后台任务操作鼠标/键盘，防止多任务互抢焦点。 */
	withDesktopLock<T>(taskId: number | null, fn: () => Promise<T>): Promise<T>;
	/** 记录来自 MCP Computer Use 工具的截屏帧到任务轨迹（供 H5 时光机回放）。 */
	recordMcpDesktopFrame(input: {
		conversationId: ConversationId;
		toolName: string;
		args: Record<string, unknown>;
		imageBase64?: string;
		mimeType?: string;
	}): Promise<void>;

	/** 本地混合知识库检索（BM25 + 向量余弦 RRF 融合）。 */
	kbSearch(query: string, topK: number): Promise<KbChunkHit[]>;
	/** 读取指定知识库文档切片。 */
	kbReadDoc(docId: number, startChunk: number, endChunk: number): Promise<{ title: string; chunks: ChunkItem[] } | null>;
	/** 将文件切片入库本地混合知识库。 */
	kbIngestFile(conversationId: ConversationId, filePath: string, title?: string): Promise<{ observation: string }>;

	/** 派生只读并发子代理分治执行（Map-Reduce）。 */
	spawnSubworkers(
		conversationId: ConversationId,
		subtasks: SubworkerTaskSpec[],
		concurrency: number,
		ctx: Context,
	): Promise<{ observation: string; results: { id: string; title: string; summary: string }[] }>;

	// ---------- 停机兜底（SPEC §0 警告 3） ----------

	/** 本会话本轮已产生"应停机"结果（待审批草稿 / 待回复追问 / 终态 report / 退回）。 */
	markRoundTerminator(conversationId: ConversationId | string): void;
	/** afterTool 兜底读取。 */
	shouldTerminateRound(conversationId: ConversationId | string): boolean;
	/** 该调用是否为"应停机"工具（worker_report 按参数区分 progress 与终态；propose_action 在 auto_notify 放权执行时不停机）。 */
	isTerminatorCall(conversationId: ConversationId | string, name: string, args: unknown): boolean;
}
