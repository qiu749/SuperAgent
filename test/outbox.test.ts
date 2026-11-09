import { describe, expect, it } from "vitest";
import { openAppDb } from "../src/app/db.ts";
import { Outbox, type OutboxPayload } from "../src/app/outbox.ts";

type SendLog = { userId: string; payload: OutboxPayload }[];

function makeOutbox(db: Awaited<ReturnType<typeof openAppDb>>, failFirst = 0) {
	const log: SendLog = [];
	let calls = 0;
	const outbox = new Outbox(db, async (userId, payload) => {
		calls++;
		if (calls <= failFirst) throw new Error(`模拟发送失败 #${calls}`);
		log.push({ userId, payload });
		return { ok: true };
	}, { manual: true });
	return { outbox, log };
}

describe("Outbox（SPEC §8）", () => {
	it("dedup_key 幂等：同 key 只入队一次", async () => {
		const db = await openAppDb(":memory:");
		const { outbox } = makeOutbox(db);
		const a = await outbox.enqueue({ dedupKey: "k1", taskId: null, userId: "u", kind: "ack", payload: { type: "text", text: "收到（任务 #1）" } });
		const b = await outbox.enqueue({ dedupKey: "k1", taskId: null, userId: "u", kind: "ack", payload: { type: "text", text: "收到（任务 #1）" } });
		expect(b.duplicate).toBe(true);
		expect(b.id).toBe(a.id);
		outbox.close();
		await db.destroy();
	});

	it("IM 消息 100 词硬上限：超限拒收（card/file 不受限制）", async () => {
		const db = await openAppDb(":memory:");
		const { outbox } = makeOutbox(db);
		const long = Array.from({ length: 101 }, () => "词").join("");
		await expect(
			outbox.enqueue({ dedupKey: "k2", taskId: null, userId: "u", kind: "result", payload: { type: "text", text: long } }),
		).rejects.toThrow(/100 词/);
		await expect(
			outbox.enqueue({ dedupKey: "k3", taskId: null, userId: "u", kind: "approval-card", payload: { type: "card", card: { big: long } } }),
		).resolves.toBeDefined();
		outbox.close();
		await db.destroy();
	});

	it("同任务 behind 保序：回执先于结果送达；不同任务互不阻塞", async () => {
		const db = await openAppDb(":memory:");
		const { outbox, log } = makeOutbox(db);
		await outbox.enqueue({ dedupKey: "t1-ack", taskId: 1, userId: "u", kind: "ack", payload: { type: "text", text: "收到，开始处理任务 #1" } });
		await outbox.enqueue({ dedupKey: "t1-card", taskId: 1, userId: "u", kind: "approval-card", payload: { type: "card", card: {} } });
		await outbox.enqueue({ dedupKey: "t2-ack", taskId: 2, userId: "u", kind: "ack", payload: { type: "text", text: "任务 #2 独立送达" } });
		await outbox.drain();
		const texts = log.map((x) => (x.payload.type === "text" ? x.payload.text : "<card>"));
		expect(texts[0]).toBe("收到，开始处理任务 #1");
		expect(texts).toContain("<card>");
		// t2 不被 t1 的 behind 挡住
		expect(texts).toContain("任务 #2 独立送达");
		expect(log.length).toBe(3);
		outbox.close();
		await db.destroy();
	});

	it("发送失败指数退避；连续 3 次失败记健康告警；不再阻塞同任务后续消息", async () => {
		const db = await openAppDb(":memory:");
		const { outbox, log } = makeOutbox(db, 3);
		const resetBackoff = async () => {
			await db.updateTable("outbox").set({ next_retry_at: 0 }).where("status", "=", "failed").execute();
		};
		await outbox.enqueue({ dedupKey: "f1", taskId: 3, userId: "u", kind: "ack", payload: { type: "text", text: "第一条（前 3 次失败）" } });
		await outbox.enqueue({ dedupKey: "f2", taskId: 3, userId: "u", kind: "result", payload: { type: "text", text: "第二条（起初被 behind 挡住）" } });
		// 轮次 1：f1 失败（attempts=1），f2 被 behind 挡住
		await outbox.drain();
		expect(log.length).toBe(0);
		expect(outbox.healthAlerts.length).toBe(0);
		// 轮次 2：f1 失败（attempts=2）
		await resetBackoff();
		await outbox.drain();
		expect(outbox.healthAlerts.length).toBe(0);
		// 轮次 3：f1 失败（attempts=3）→ 记告警；f1 不再阻塞 f2，f2 直接送出
		await resetBackoff();
		await outbox.drain();
		expect(outbox.healthAlerts.length).toBe(1);
		// 轮次 4：f1 成功
		await resetBackoff();
		await outbox.drain();
		const texts = log.map((x) => (x.payload.type === "text" ? x.payload.text : ""));
		expect(texts[0]).toBe("第二条（起初被 behind 挡住）");
		expect(texts).toContain("第一条（前 3 次失败）");
		outbox.close();
		await db.destroy();
	});
});
