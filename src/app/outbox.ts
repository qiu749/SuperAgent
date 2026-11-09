/**
 * Outbox 通知发件箱（SPEC §8）：
 * 1. dedup_key 幂等（同 key 只入队一次）；
 * 2. 同任务严格保序：发送前检查是否存在同 task_id 更早入队、未送达且连续失败 < 3 次的消息（behind），有则等待；
 * 3. IM 普通文本 100 词硬上限校验（长内容须走文件附件）；
 * 4. 5s 起指数退避至 300s；连续失败 3 次记入 HealthBoard 并继续退避重试。
 */
import { type Generated, type Kysely } from "kysely";
import pino from "pino";
import type { Db, OutboxStatus } from "./db.ts";
import { checkImWords } from "../util/text.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "outbox" });

export const OUTBOX_MAX_ATTEMPTS_BEFORE_ALERT = 3;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 300_000;

/** 出站载荷。 */
export type OutboxPayload =
	| { type: "text"; text: string }
	| { type: "markdown"; text: string }
	| { type: "card"; card: Record<string, unknown> }
	| { type: "card_update"; responseCode: string; text: string }
	| { type: "file"; filename: string; contentBase64: string };

export type EnqueueInput = {
	dedupKey: string;
	taskId: number | null;
	userId: string;
	kind: string;
	payload: OutboxPayload;
};

/** 入队时做 100 词校验的载荷类型（card/card_update/file 不受词数限制）。 */
function validateWords(kind: string, payload: OutboxPayload): string | undefined {
	if (payload.type !== "text" && payload.type !== "markdown") return undefined;
	if (kind === "ack" && payload.type === "text") return undefined; // 回执按 50 词在 Router 工具层校验
	if (kind === "slash-reply") return undefined; // 斜杠命令的确定性输出（任务列表/帮助等）不受模型防刷屏上限约束
	const err = checkImWords(payload.text);
	if (err) return `${kind}: ${err}`;
	return undefined;
}

export class Outbox {
	private timer: NodeJS.Timeout | null = null;
	private draining = false;
	private closed = false;
	/** 连续失败 ≥3 次的 task/message 记录，供 HealthBoard 展示。 */
	readonly healthAlerts: { key: string; attempts: number; error: string; at: number }[] = [];

	constructor(
		private readonly db: Kysely<Db>,
		private readonly send: (userId: string, payload: OutboxPayload) => Promise<SendOutcome>,
		private readonly opts: { /** 测试用：入队不自动触发后台发送 */ manual?: boolean } = {},
	) {}

	/** 入队（幂等：dedup_key 冲突时直接返回已有行）。 */
	async enqueue(input: EnqueueInput): Promise<{ id: number; duplicate: boolean }> {
		const wordErr = validateWords(input.kind, input.payload);
		if (wordErr) throw new Error(`outbox 拒收：${wordErr}`);
		const existing = await this.db
			.selectFrom("outbox")
			.where("dedup_key", "=", input.dedupKey)
			.select(["id"])
			.executeTakeFirst();
		if (existing) return { id: existing.id, duplicate: true };
		const row = {
			dedup_key: input.dedupKey,
			task_id: input.taskId,
			user_id: input.userId,
			kind: input.kind,
			payload: JSON.stringify(input.payload),
			status: "pending" as OutboxStatus,
			attempts: 0,
			next_retry_at: 0,
			sent_at: null,
			created_at: Date.now(),
		};
		await this.db.insertInto("outbox").values(row).execute();
		const inserted = await this.db
			.selectFrom("outbox")
			.where("dedup_key", "=", input.dedupKey)
			.select(["id"])
			.executeTakeFirst();
		log.info({ id: inserted?.id, kind: input.kind, task: input.taskId }, "outbox 入队");
		if (!this.opts.manual) this.kick();
		return { id: inserted?.id ?? 0, duplicate: false };
	}

	/** 后台发送循环；测试可手动调 drain()。 */
	start(intervalMs = 500): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.kick(), intervalMs).unref();
	}

	/** 停止后台循环并拒绝后续发送。 */
	close(): void {
		this.closed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	kick(): void {
		if (this.draining || this.closed) return;
		void this.drain().catch((err) => {
			if (!this.closed) log.error({ err }, "outbox 后台发送异常");
		});
	}

	/** 扫描可发消息（同任务 behind 保序），逐条发送。互斥：并发调用直接返回 0。 */
	async drain(): Promise<number> {
		if (this.draining || this.closed) return 0;
		this.draining = true;
		try {
			return await this.drainInternal();
		} finally {
			this.draining = false;
		}
	}

	private async drainInternal(): Promise<number> {
		const now = Date.now();
		const rows = await this.db
			.selectFrom("outbox")
			.where("status", "in", ["pending", "failed"])
			.where("next_retry_at", "<=", now)
			.selectAll()
			.orderBy("id", "asc")
			.limit(200)
			.execute();
		let sent = 0;
		for (const row of rows) {
			if (await this.hasBehind(row.task_id, row.id)) continue;
			const payload = JSON.parse(row.payload) as OutboxPayload;
			try {
				await this.send(row.user_id, payload);
				await this.db
					.updateTable("outbox")
					.set({ status: "sent", sent_at: Date.now(), attempts: row.attempts + 1 })
					.where("id", "=", row.id)
					.execute();
				sent++;
			} catch (err) {
				const attempts = row.attempts + 1;
				const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempts);
				await this.db
					.updateTable("outbox")
					.set({ status: "failed", attempts, next_retry_at: Date.now() + backoff })
					.where("id", "=", row.id)
					.execute();
				const message = err instanceof Error ? err.message : String(err);
				if (attempts >= OUTBOX_MAX_ATTEMPTS_BEFORE_ALERT) {
					if (!this.healthAlerts.some((a) => a.key === row.dedup_key)) {
						this.healthAlerts.push({ key: row.dedup_key, attempts, error: message, at: Date.now() });
						log.error({ key: row.dedup_key, attempts, error: message }, "outbox 连续失败，记入健康告警");
					}
				}
				log.warn({ key: row.dedup_key, attempts, backoff, error: message }, "outbox 发送失败，退避重试");
				// 达到告警阈值（不再阻塞 behind 判定）的行继续放行后面消息；否则本轮停止前进（保守保序）
				if (attempts >= OUTBOX_MAX_ATTEMPTS_BEFORE_ALERT) continue;
				break;
			}
		}
		return sent;
	}

	/** behind 检查：同任务更早入队、尚未送达且连续失败 < 3 次的消息存在 → 本条必须等待。 */
	private async hasBehind(taskId: number | null, id: number): Promise<boolean> {
		if (taskId === null) return false;
		const behind = await this.db
			.selectFrom("outbox")
			.where("task_id", "=", taskId)
			.where("id", "<", id)
			.where("status", "in", ["pending", "failed"])
			.where("attempts", "<", OUTBOX_MAX_ATTEMPTS_BEFORE_ALERT)
			.select(["id"])
			.limit(1)
			.executeTakeFirst();
		return behind !== undefined;
	}
}

export type SendOutcome = { ok: true; responseCode?: string };
