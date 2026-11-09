/**
 * 业务数据库 app.sqlite（SPEC §12）：node:sqlite + Kysely（类型安全 SQL），WAL 模式。
 * 存触发器、任务索引、审批草稿、追问、cron 索引与通知发件箱（outbox）。
 */
import { DatabaseSync } from "node:sqlite";
import { type Generated } from "kysely";
import {
	type Dialect,
	type DatabaseConnection,
	type Driver,
	Kysely,
	Migrator,
	type Migration,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import pino from "pino";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "app-db" });

// ---------- 类型化表 ----------

export interface UsersTable {
	user_id: string;
	name: string;
	router_conv_id: string | null;
	/** { kind: "approval_edit" | "ask", id: string } | null */
	pending_interaction: string | null;
	created_at: number;
}

export interface TriggersTable {
	id: string;
	source: string;
	source_msg_id: string | null;
	user_id: string;
	strength: "explicit" | "inferred";
	payload: string;
	disposition: string | null;
	/** v1.0：线程标识 wecom:dm:{user} / wecom:chat:{chatid} / feishu:p2p:{open_id} / feishu:group:{chat_id}；001 旧行补默认 ''。 */
	thread_key: string;
	/** v1.0：text | voice | image | file | event。 */
	msg_type: string;
	/** v1.0：文本正文或语音 ASR 转写结果。 */
	raw_text: string | null;
	/** v1.0：JSON [{ inbox_path, filename, mime, size }]。 */
	attachments: string | null;
	created_at: number;
}

/** v1.0 M6：群聊/线程订阅（Subscription Fan-out）。 */
export interface SubscriptionsTable {
	thread_key: string;
	task_id: number;
	mode: "own" | "context_only";
	created_at: number;
}

/** v1.0：收件箱文件（语音/图片/文件落盘后的索引，供 recent-inbox-files 与任务挂载）。 */
export interface InboxFilesTable {
	id: string;
	user_id: string;
	thread_key: string;
	filename: string;
	mime: string;
	size: number;
	inbox_path: string;
	bound_task_id: number | null;
	created_at: number;
}

export interface DecisionsTable {
	id: string;
	trigger_id: string;
	kind: "accept" | "attach" | "stop" | "ignore" | "would_accept";
	task_id: number | null;
	reason: string;
	created_at: number;
}

export type TaskStage =
	| "queued"
	| "working"
	| "waiting_approval"
	| "waiting_user"
	| "paused_budget"
	| "ready"
	| "dropped"
	| "failed"
	| "cancelled";

export interface TasksTable {
	id: Generated<number>;
	user_id: string;
	origin_trigger_id: string;
	title: string;
	routing_note: string;
	conv_id: string;
	latest_sub_id: string | null;
	stage: TaskStage;
	latest_report: string | null;
	budget: "small" | "medium" | "large";
	/** v3.0 M12：轨迹时光机分叉父任务 ID。 */
	parent_task_id?: number | null;
	/** v3.0 M12：从父任务哪个轨迹序号分叉而来。 */
	forked_at_seq?: number | null;
	created_at: number;
	updated_at: number;
}

export type ApprovalStatus = "pending" | "pending_digest" | "approved" | "rejected" | "expired" | "superseded" | "pending_edit";

export interface ApprovalsTable {
	id: string;
	task_id: number;
	conv_id: string;
	action_type: string;
	/** v1.0 M8：信任策略匹配键（domain:example.com / repo:owner/name / '*'）。 */
	scope_key: string;
	/** v1.0 M8：immediate（立即推卡）| digest（进早晚报池）。 */
	urgency: "immediate" | "digest";
	payload: string;
	preview: string;
	is_final: number;
	status: ApprovalStatus;
	/** v1.0 M7：【修改】后重拟的新草稿指向旧草稿 ID，用于 Diff 习惯学习。 */
	previous_approval_id: string | null;
	/** v1.0 M7：用户修改意见原话。 */
	user_edit_feedback: string | null;
	response_code: string | null;
	exec_result: string | null;
	expiry_task_id: string | null;
	created_at: number;
	decided_at: number | null;
}

/** v1.0 M8：渐进式信任放权策略。 */
export interface TrustPoliciesTable {
	id: string; // "{user_id}:{action_type}:{scope_key}"
	user_id: string;
	action_type: string;
	scope_key: string;
	consecutive_approvals: number;
	mode: "always_ask" | "digest" | "auto_notify";
	prompted_upgrade: number;
	updated_at: number;
}

/** v1.0 M7：审批修改中学到的习惯（同时写入 Mem0 供语义检索）。 */
export interface LearnedHabitsTable {
	id: string;
	user_id: string;
	action_type: string;
	rule_text: string;
	from_approval_id: string | null;
	mem0_id: string | null;
	enabled: number;
	created_at: number;
}

/** v1.0 M7：沉淀的 SKILL.md 索引（实体文件在 /data/skills/{slug}/）。 */
export interface SkillsTable {
	slug: string;
	user_id: string;
	name: string;
	description: string;
	file_path: string;
	source_task_ids: string; // JSON array
	status: "draft" | "active" | "disabled";
	created_at: number;
}

/** v3.0 M12：轨迹事件表（记录业务级时间轴节点、Computer Use 截图帧与 Token 成本）。 */
export interface TrajectoryEventsTable {
	id: Generated<number>;
	task_id: number;
	seq: number;
	node_id: string;
	pi_event_id: number | null;
	conversation_id: string;
	kind: string;
	title: string;
	detail_json: string;
	screenshot_path: string | null;
	duration_ms: number | null;
	prompt_tokens: number;
	completion_tokens: number;
	cost_usd: number;
	created_at: number;
}

/** v3.0 M10：模型 Token 与成本账本表（ModelRouter & CostGuard）。 */
export interface TokenUsageLedgerTable {
	id: Generated<number>;
	task_id: number | null;
	conversation_id: string;
	role: string;
	model_id: string;
	prompt_tokens: number;
	completion_tokens: number;
	cost_usd: number;
	created_at: number;
	/** pi.sqlite journal 来源条目去重键（`{conv}:{entryId}:{model}`），手工记账为 NULL（SPEC-v3 §6 之外的幂等补充列）。 */
	ext_entry_id: string | null;
}

/** v3.0 M10：个人知识库文档表（Local Hybrid RAG）。 */
export interface KbDocumentsTable {
	id: Generated<number>;
	source_path: string;
	title: string;
	sha256: string;
	mime_type: string;
	chunk_count: number;
	indexed_at: number;
}

/** v3.0 M10：个人知识库切片表。 */
export interface KbChunksTable {
	id: Generated<number>;
	doc_id: number;
	chunk_index: number;
	heading_path: string;
	content: string;
	embedding_json: string | null;
	created_at: number;
}

/** v3.0 M11：技能健康度遥测表（Skill Telemetry & Hygiene）。 */
export interface SkillTelemetryTable {
	skill_name: string;
	views_count: number;
	first_try_approve_count: number;
	edit_or_reject_count: number;
	last_used_at: number;
	last_task_id: number | null;
	updated_at: number;
}

/** v3.0 M10：主动传感器事件幂等账本（Proactive Sensors）。 */
export interface SensorEventsTable {
	id: Generated<number>;
	sensor_id: string;
	external_event_id: string;
	title: string;
	urgency: string;
	trigger_id: string | null;
	created_at: number;
}

export interface AsksTable {
	id: string;
	task_id: number;
	conv_id: string;
	question: string;
	options: string | null;
	status: "pending" | "answered";
	answer: string | null;
	response_code: string | null;
	created_at: number;
}

export interface CronJobsTable {
	id: string;
	user_id: string;
	expr: string;
	prompt: string;
	enabled: number;
	pi_task_id: string | null;
	created_at: number;
}

export type OutboxStatus = "pending" | "sent" | "failed" | "dropped";

export interface OutboxTable {
	id: Generated<number>;
	dedup_key: string;
	task_id: number | null;
	user_id: string;
	kind: string;
	payload: string;
	status: OutboxStatus;
	attempts: number;
	next_retry_at: number;
	sent_at: number | null;
	created_at: number;
}

export interface Db {
	users: UsersTable;
	triggers: TriggersTable;
	decisions: DecisionsTable;
	tasks: TasksTable;
	approvals: ApprovalsTable;
	asks: AsksTable;
	cron_jobs: CronJobsTable;
	outbox: OutboxTable;
	subscriptions: SubscriptionsTable;
	inbox_files: InboxFilesTable;
	trust_policies: TrustPoliciesTable;
	learned_habits: LearnedHabitsTable;
	skills: SkillsTable;
	trajectory_events: TrajectoryEventsTable;
	token_usage_ledger: TokenUsageLedgerTable;
	kb_documents: KbDocumentsTable;
	kb_chunks: KbChunksTable;
	skill_telemetry: SkillTelemetryTable;
	sensor_events: SensorEventsTable;
}

// ---------- node:sqlite Dialect ----------

class NodeSqliteDriver implements Driver {
	constructor(private readonly database: DatabaseSync) {}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		const database = this.database;
		return {
			async executeQuery<O>(compiledQuery: { sql: string; parameters: readonly unknown[] }): Promise<{ rows: O[] }> {
				const stmt = database.prepare(compiledQuery.sql);
				const params = compiledQuery.parameters.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : (p as never))) as never[];
				const isRead = /^\s*(select|with|values)/i.test(compiledQuery.sql) || /\breturning\b/i.test(compiledQuery.sql);
				if (isRead) {
					return { rows: stmt.all(...params) as O[] };
				}
				stmt.run(...params);
				return { rows: [] as O[] };
			},
			async *streamQuery() {
				throw new Error("node:sqlite driver 不支持 streamQuery");
			},
		};
	}

	async beginTransaction(): Promise<void> {
		this.database.exec("begin");
	}
	async commitTransaction(): Promise<void> {
		this.database.exec("commit");
	}
	async rollbackTransaction(): Promise<void> {
		this.database.exec("rollback");
	}
	async releaseConnection(): Promise<void> {}
	async destroy(): Promise<void> {}
}

const nodeSqliteDialect = (database: DatabaseSync): Dialect => ({
	createAdapter: () => new SqliteAdapter(),
	createDriver: () => new NodeSqliteDriver(database),
	createIntrospector: (db) => new SqliteIntrospector(db),
	createQueryCompiler: () => new SqliteQueryCompiler(),
});

// ---------- 建表 ----------

const MIGRATIONS: Record<string, Migration> = {
	"001_init": {
		async up(db: Kysely<unknown>) {
			await db.schema
				.createTable("users")
				.addColumn("user_id", "text", (c) => c.primaryKey())
				.addColumn("name", "text", (c) => c.notNull().defaultTo(""))
				.addColumn("router_conv_id", "text")
				.addColumn("pending_interaction", "text")
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("triggers")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("source", "text", (c) => c.notNull())
				.addColumn("source_msg_id", "text")
				.addColumn("user_id", "text", (c) => c.notNull())
				.addColumn("strength", "text", (c) => c.notNull())
				.addColumn("payload", "text", (c) => c.notNull())
				.addColumn("disposition", "text")
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema.createIndex("idx_triggers_msg").on("triggers").column("source_msg_id").unique().execute();
			await db.schema
				.createTable("decisions")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("trigger_id", "text", (c) => c.notNull())
				.addColumn("kind", "text", (c) => c.notNull())
				.addColumn("task_id", "integer")
				.addColumn("reason", "text", (c) => c.notNull().defaultTo(""))
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("tasks")
				.addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
				.addColumn("user_id", "text", (c) => c.notNull())
				.addColumn("origin_trigger_id", "text", (c) => c.notNull())
				.addColumn("title", "text", (c) => c.notNull())
				.addColumn("routing_note", "text", (c) => c.notNull().defaultTo(""))
				.addColumn("conv_id", "text", (c) => c.notNull().unique())
				.addColumn("latest_sub_id", "text")
				.addColumn("stage", "text", (c) => c.notNull().defaultTo("queued"))
				.addColumn("latest_report", "text")
				.addColumn("budget", "text", (c) => c.notNull().defaultTo("medium"))
				.addColumn("created_at", "integer", (c) => c.notNull())
				.addColumn("updated_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("approvals")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("task_id", "integer", (c) => c.notNull())
				.addColumn("conv_id", "text", (c) => c.notNull())
				.addColumn("action_type", "text", (c) => c.notNull())
				.addColumn("payload", "text", (c) => c.notNull())
				.addColumn("preview", "text", (c) => c.notNull().defaultTo(""))
				.addColumn("is_final", "integer", (c) => c.notNull().defaultTo(1))
				.addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
				.addColumn("response_code", "text")
				.addColumn("exec_result", "text")
				.addColumn("expiry_task_id", "text")
				.addColumn("created_at", "integer", (c) => c.notNull())
				.addColumn("decided_at", "integer")
				.execute();
			await db.schema
				.createTable("asks")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("task_id", "integer", (c) => c.notNull())
				.addColumn("conv_id", "text", (c) => c.notNull())
				.addColumn("question", "text", (c) => c.notNull())
				.addColumn("options", "text")
				.addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
				.addColumn("answer", "text")
				.addColumn("response_code", "text")
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("cron_jobs")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("user_id", "text", (c) => c.notNull())
				.addColumn("expr", "text", (c) => c.notNull())
				.addColumn("prompt", "text", (c) => c.notNull())
				.addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
				.addColumn("pi_task_id", "text")
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("outbox")
				.addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
				.addColumn("dedup_key", "text", (c) => c.notNull().unique())
				.addColumn("task_id", "integer")
				.addColumn("user_id", "text", (c) => c.notNull())
				.addColumn("kind", "text", (c) => c.notNull())
				.addColumn("payload", "text", (c) => c.notNull())
				.addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
				.addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("next_retry_at", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("sent_at", "integer")
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
		},
	},
	// v1.0（SPEC-v2 §3/§7/§8/§11）：多模态触发器列、订阅扇出、信任放权、习惯与技能、收件箱。
	// inbox_files 表为 SPEC §11 之外的必要补充（recent-inbox-files section 与任务挂载需要持久层）。
	// 注意：SQLite 的 ALTER TABLE 一次只能 ADD 一列，必须逐列执行。
	"002_v1": {
		async up(db: Kysely<unknown>) {
			await db.schema.alterTable("triggers").addColumn("thread_key", "text", (c) => c.notNull().defaultTo("")).execute();
			await db.schema.alterTable("triggers").addColumn("msg_type", "text", (c) => c.notNull().defaultTo("text")).execute();
			await db.schema.alterTable("triggers").addColumn("raw_text", "text").execute();
			await db.schema.alterTable("triggers").addColumn("attachments", "text").execute();
			await db.schema.alterTable("approvals").addColumn("scope_key", "text", (c) => c.notNull().defaultTo("*")).execute();
			await db.schema.alterTable("approvals").addColumn("urgency", "text", (c) => c.notNull().defaultTo("immediate")).execute();
			await db.schema.alterTable("approvals").addColumn("previous_approval_id", "text").execute();
			await db.schema.alterTable("approvals").addColumn("user_edit_feedback", "text").execute();
			await db.schema
				.createTable("subscriptions")
				.addColumn("thread_key", "text", (c) => c.notNull())
				.addColumn("task_id", "integer", (c) => c.notNull())
				.addColumn("mode", "text", (c) => c.notNull().defaultTo("own"))
				.addColumn("created_at", "integer", (c) => c.notNull())
				.addPrimaryKeyConstraint("pk_subscriptions", ["thread_key", "task_id"])
				.execute();
			await db.schema
				.createIndex("idx_subscriptions_task").on("subscriptions").column("task_id").execute();
			await db.schema
				.createTable("inbox_files")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("user_id", "text", (c) => c.notNull())
				.addColumn("thread_key", "text", (c) => c.notNull().defaultTo(""))
				.addColumn("filename", "text", (c) => c.notNull())
				.addColumn("mime", "text", (c) => c.notNull().defaultTo(""))
				.addColumn("size", "integer", (c) => c.notNull())
				.addColumn("inbox_path", "text", (c) => c.notNull())
				.addColumn("bound_task_id", "integer")
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema.createIndex("idx_inbox_user_time").on("inbox_files").columns(["user_id", "created_at"]).execute();
			await db.schema
				.createTable("trust_policies")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("user_id", "text", (c) => c.notNull())
				.addColumn("action_type", "text", (c) => c.notNull())
				.addColumn("scope_key", "text", (c) => c.notNull())
				.addColumn("consecutive_approvals", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("mode", "text", (c) => c.notNull().defaultTo("always_ask"))
				.addColumn("prompted_upgrade", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("updated_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("learned_habits")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("user_id", "text", (c) => c.notNull())
				.addColumn("action_type", "text", (c) => c.notNull())
				.addColumn("rule_text", "text", (c) => c.notNull())
				.addColumn("from_approval_id", "text")
				.addColumn("mem0_id", "text")
				.addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("skills")
				.addColumn("slug", "text", (c) => c.primaryKey())
				.addColumn("user_id", "text", (c) => c.notNull())
				.addColumn("name", "text", (c) => c.notNull())
				.addColumn("description", "text", (c) => c.notNull())
				.addColumn("file_path", "text", (c) => c.notNull())
				.addColumn("source_task_ids", "text", (c) => c.notNull().defaultTo("[]"))
				.addColumn("status", "text", (c) => c.notNull().defaultTo("active"))
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
		},
	},
	// v3.0（SPEC-v3 §6）：轨迹时光机、多模型成本账本、本地 Hybrid RAG 知识库、技能遥测与主动传感器幂等账本。
	"003_v3": {
		async up(db: Kysely<unknown>) {
			await db.schema.alterTable("tasks").addColumn("parent_task_id", "integer").execute();
			await db.schema.alterTable("tasks").addColumn("forked_at_seq", "integer").execute();

			await db.schema
				.createTable("trajectory_events")
				.addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
				.addColumn("task_id", "integer", (c) => c.notNull())
				.addColumn("seq", "integer", (c) => c.notNull())
				.addColumn("node_id", "text", (c) => c.notNull())
				.addColumn("pi_event_id", "integer")
				.addColumn("conversation_id", "text", (c) => c.notNull())
				.addColumn("kind", "text", (c) => c.notNull())
				.addColumn("title", "text", (c) => c.notNull())
				.addColumn("detail_json", "text", (c) => c.notNull().defaultTo("{}"))
				.addColumn("screenshot_path", "text")
				.addColumn("duration_ms", "integer")
				.addColumn("prompt_tokens", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("completion_tokens", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("cost_usd", "real", (c) => c.notNull().defaultTo(0))
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema.createIndex("idx_traj_task_seq").on("trajectory_events").columns(["task_id", "seq"]).execute();

			await db.schema
				.createTable("token_usage_ledger")
				.addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
				.addColumn("task_id", "integer")
				.addColumn("conversation_id", "text", (c) => c.notNull())
				.addColumn("role", "text", (c) => c.notNull())
				.addColumn("model_id", "text", (c) => c.notNull())
				.addColumn("prompt_tokens", "integer", (c) => c.notNull())
				.addColumn("completion_tokens", "integer", (c) => c.notNull())
				.addColumn("cost_usd", "real", (c) => c.notNull())
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema.createIndex("idx_cost_created").on("token_usage_ledger").column("created_at").execute();

			await db.schema
				.createTable("kb_documents")
				.addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
				.addColumn("source_path", "text", (c) => c.notNull().unique())
				.addColumn("title", "text", (c) => c.notNull())
				.addColumn("sha256", "text", (c) => c.notNull())
				.addColumn("mime_type", "text", (c) => c.notNull().defaultTo("text/markdown"))
				.addColumn("chunk_count", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("indexed_at", "integer", (c) => c.notNull())
				.execute();

			await db.schema
				.createTable("kb_chunks")
				.addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
				.addColumn("doc_id", "integer", (c) => c.notNull())
				.addColumn("chunk_index", "integer", (c) => c.notNull())
				.addColumn("heading_path", "text", (c) => c.notNull().defaultTo(""))
				.addColumn("content", "text", (c) => c.notNull())
				.addColumn("embedding_json", "text")
				.addColumn("created_at", "integer", (c) => c.notNull())
				.execute();
			await db.schema.createIndex("idx_kb_chunks_doc").on("kb_chunks").columns(["doc_id", "chunk_index"]).execute();

			await db.schema
				.createTable("skill_telemetry")
				.addColumn("skill_name", "text", (c) => c.primaryKey())
				.addColumn("views_count", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("first_try_approve_count", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("edit_or_reject_count", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("last_used_at", "integer", (c) => c.notNull().defaultTo(0))
				.addColumn("last_task_id", "integer")
				.addColumn("updated_at", "integer", (c) => c.notNull())
				.execute();

			await db.schema
				.createTable("sensor_events")
				.addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
				.addColumn("sensor_id", "text", (c) => c.notNull())
				.addColumn("external_event_id", "text", (c) => c.notNull())
				.addColumn("title", "text", (c) => c.notNull())
				.addColumn("urgency", "text", (c) => c.notNull())
				.addColumn("trigger_id", "text")
				.addColumn("created_at", "integer", (c) => c.notNull())
				.addUniqueConstraint("uq_sensor_event", ["sensor_id", "external_event_id"])
				.execute();
		},
	},
	// v3.0 补丁：token_usage_ledger 增加 pi journal 来源去重列（ext_entry_id），
	// 让 syncConversationUsage 在进程重启后重扫 journal 也不会重复记账（SPEC §6 之外的幂等补充）。
	"004_v3_ledger_dedup": {
		async up(db: Kysely<unknown>) {
			await db.schema.alterTable("token_usage_ledger").addColumn("ext_entry_id", "text").execute();
			await db.schema
				.createIndex("idx_ledger_ext_entry")
				.on("token_usage_ledger")
				.columns(["conversation_id", "ext_entry_id"])
				.unique()
				.execute();
		},
	},
};

export async function openAppDb(path: string): Promise<Kysely<Db>> {
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	const kysely = new Kysely<Db>({ dialect: nodeSqliteDialect(db) });
	const migrator = new Migrator({
		db: kysely as never,
		provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
	});
	const result = await migrator.migrateToLatest();
	if (result.error) {
		log.error({ error: result.error }, "迁移失败");
		throw result.error;
	}
	return kysely;
}
