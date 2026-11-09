import { describe, expect, it } from "vitest";
import { WorkerSlots } from "../src/app/worker-slots.ts";

describe("WorkerSlots（SPEC §6.2 人类优先 +1 紧急槽位）", () => {
	it("常规槽位满载后，人类交互可用 +1 紧急槽立即执行", async () => {
		const slots = new WorkerSlots(2);
		const r1 = await slots.acquire("t1", "background", "new");
		const r2 = await slots.acquire("t2", "background", "new");
		expect(slots.usedSlots).toBe(2);
		let humanRan = false;
		const humanP = slots.acquire("human-1", "human", "wake").then((rel) => {
			humanRan = true;
			return rel;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(humanRan).toBe(true); // 未排队，直接用紧急槽
		(await humanP)();
		r1();
		r2();
	});

	it("后台新任务必须排队等常规槽", async () => {
		const slots = new WorkerSlots(1);
		const r1 = await slots.acquire("t1", "background", "new");
		let newRan = false;
		const p = slots.acquire("t2", "background", "new").then((rel) => {
			newRan = true;
			return rel;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(newRan).toBe(false);
		r1();
		await p;
		expect(newRan).toBe(true);
	});

	it("常规槽释放时，唤醒已有任务优先于启动新任务", async () => {
		const slots = new WorkerSlots(1);
		const r1 = await slots.acquire("t1", "background", "new");
		const order: string[] = [];
		const wakeP = slots.acquire("wake", "background", "wake").then((rel) => {
			order.push("wake");
			return rel;
		});
		const newP = slots.acquire("new", "background", "new").then((rel) => {
			order.push("new");
			return rel;
		});
		await new Promise((r) => setTimeout(r, 10));
		r1();
		const relWake = await wakeP;
		expect(order).toEqual(["wake"]); // 唤醒先拿到空出的槽位
		relWake();
		const relNew = await newP;
		expect(order).toEqual(["wake", "new"]);
		relNew();
	});

	it("紧急槽位同时至多 1 个，且不计入后台排队容量", async () => {
		const slots = new WorkerSlots(1);
		const r1 = await slots.acquire("t1", "background", "new");
		let h1 = false;
		let h2 = false;
		const relH1P = slots.acquire("h1", "human", "wake").then((rel) => {
			h1 = true;
			return rel;
		});
		const relH2P = slots.acquire("h2", "human", "wake").then((rel) => {
			h2 = true;
			return rel;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(h1).toBe(true);
		expect(h2).toBe(false); // 紧急槽被 h1 占用，h2 排队（human 优先，槽位释放后第一个进）
		expect(slots.stats.emergencyInUse).toBe(true);
		const relH1 = await relH1P;
		relH1(); // 释放常规槽 t1 之后 h2 才能进
		r1();
		const relH2 = await relH2P;
		expect(h2).toBe(true);
		relH2();
	});
});
