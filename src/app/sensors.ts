/**
 * 多源主动感知网关（Proactive Sensors Gateway，SPEC-v3 §3.1 M10）：
 * - 统一接入外部主动信号（GitHub PR/CI Webhook、VIP 邮件提醒、日历会前 15 分钟背景速览等）；
 * - 基于 sensor_events(sensor_id, external_event_id) 严格幂等去重；
 * - 按 suggestedUrgency 分级分流：
 *   1) "immediate" → 写入 triggers 并唤醒 Router 分诊；
 *   2) "digest" → 记入 sensor_events 账本并静默进入早晚报摘要池（零 Router Token 消耗）。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import pino from "pino";
import type { WeAgentCore } from "./core.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "sensors" });

export type SensorEventInput = {
	sensorId: string;
	externalEventId: string;
	userId?: string;
	sourceTitle: string;
	summary: string;
	payload?: Record<string, unknown>;
	suggestedUrgency?: "immediate" | "digest";
};

export type SensorIngestResult = {
	duplicate: boolean;
	routedTo: "router" | "digest" | "ignored_off_mode";
	triggerId?: string;
};

export class SensorGateway {
	constructor(private readonly core: WeAgentCore) {}

	/**
	 * 统一摄入一条主动传感器事件。
	 */
	async ingest(input: SensorEventInput): Promise<SensorIngestResult> {
		const sensorId = input.sensorId.trim();
		const externalEventId = input.externalEventId.trim();
		if (!sensorId || !externalEventId) {
			throw new Error("sensorId 与 externalEventId 不能为空");
		}
		const existing = await this.core.db
			.selectFrom("sensor_events")
			.where("sensor_id", "=", sensorId)
			.where("external_event_id", "=", externalEventId)
			.selectAll()
			.executeTakeFirst();
		if (existing) {
			return {
				duplicate: true,
				routedTo: existing.urgency === "digest" ? "digest" : "router",
				triggerId: existing.trigger_id ?? undefined,
			};
		}

		const urgency = input.suggestedUrgency ?? "immediate";
		const userId = input.userId || this.core.cfg.allowedUsers[0] || "owner";
		const now = Date.now();

		// 低优 digest 事件：记录账本，不唤醒 Router（零 Token 消耗）
		if (urgency === "digest") {
			await this.core.db
				.insertInto("sensor_events")
				.values({
					sensor_id: sensorId,
					external_event_id: externalEventId,
					title: input.sourceTitle,
					urgency: "digest",
					trigger_id: null,
					created_at: now,
				})
				.execute();
			log.info({ sensorId, externalEventId, title: input.sourceTitle }, "低优传感器事件已静默归入早晚报池");
			return { duplicate: false, routedTo: "digest" };
		}

		// immediate 事件：生成 inferred trigger 并按 acceptMode 分流
		const text = `[主动感知｜${sensorId}] ${input.sourceTitle}\n${input.summary}`;
		const { trigger } = await this.core.insertTrigger({
			source: `sensor:${sensorId}`,
			sourceMsgId: `sensor:${sensorId}:${externalEventId}`,
			userId,
			strength: "inferred",
			text,
			msgType: "event",
		});

		await this.core.db
			.insertInto("sensor_events")
			.values({
				sensor_id: sensorId,
				external_event_id: externalEventId,
				title: input.sourceTitle,
				urgency: "immediate",
				trigger_id: trigger.id,
				created_at: now,
			})
			.execute();

		if (this.core.cfg.acceptMode === "off") {
			await this.core.recordDecision(trigger.id, "ignore", null, "accept_mode_off");
			return { duplicate: false, routedTo: "ignored_off_mode", triggerId: trigger.id };
		}

		// 若当日预算已熔断，自动降级为不唤醒 Router
		const budgetCheck = await this.core.modelRouter.checkBudget(null);
		if (!budgetCheck.allowed) {
			await this.core.recordDecision(trigger.id, "ignore", null, `cost_guard_tripped: ${budgetCheck.reason}`);
			return { duplicate: false, routedTo: "digest", triggerId: trigger.id };
		}

		await this.core.dispatcher.dispatchToRouter(trigger, BACKGROUND_CONTEXT);
		return { duplicate: false, routedTo: "router", triggerId: trigger.id };
	}

	async listRecent(limit = 30) {
		return this.core.db.selectFrom("sensor_events").orderBy("created_at", "desc").limit(limit).selectAll().execute();
	}
}
