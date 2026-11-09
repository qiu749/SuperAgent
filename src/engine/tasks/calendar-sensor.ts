/**
 * weagent.sensor-calendar（SPEC-v3 §3.1 sensor.calendar-prep）：
 * 每 5 分钟检查 DATA_DIR/calendar.json 中 15 分钟内即将开始的日程，
 * 通过 SensorGateway 入站 immediate 事件唤醒 Router/Worker 生成《会前 1 页纸速览卡》。
 * 幂等由 sensor_events(sensor_id, external_event_id) 唯一键保证（externalEventId = calprep:{start}:{title}）。
 * 与 weagent.digest-cron 同款 defineTask + sleepUntil 持久化模式，进程重启自动恢复倒计时。
 */
import { defineTask } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";

export const CALENDAR_SENSOR_TASK_NAME = "weagent.sensor-calendar";

const SCAN_INTERVAL_MS = 5 * 60_000;

/** 下一个 5 分钟整点边界（毫秒时间戳）。 */
export function nextScanMs(from = Date.now()): number {
	return Math.ceil((from + 1) / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS;
}

export type CalendarSensorCheckpoint = { phase: "sleep"; until: number } | { phase: "fire"; slot: number };

export type CalendarSensorInput = Record<string, never>;

export function createCalendarSensorTask(host: WeAgentHost) {
	return defineTask<CalendarSensorInput, CalendarSensorCheckpoint, { done: boolean }, object>({
		name: CALENDAR_SENSOR_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "sleep", until: nextScanMs() }),
		phases: {
			sleep: async (task, runtime, ctx) => {
				await runtime.sleepUntil(task.state.checkpoint.until, { phase: "fire", slot: task.state.checkpoint.until }, ctx);
			},
			fire: async (task, runtime, ctx) => {
				const slot = task.state.checkpoint.slot;
				await host.fireCalendarSensor(ctx);
				const next = nextScanMs(slot + 1);
				await runtime.commit(
					() => ({ status: "sleeping", until: next, checkpoint: { phase: "sleep", until: next } as CalendarSensorCheckpoint }),
					ctx,
				);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "sensor_disabled" } }), ctx);
		},
	});
}
