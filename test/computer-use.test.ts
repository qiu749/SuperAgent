/**
 * Computer Use 视觉桌面引擎测试（SPEC-v3 §7 M9，test/computer-use.test.ts）：
 * - 坐标归一化（Qwen 千分比 / 0..1 归一化 / 1280x800 逻辑像素 → Retina 物理像素）与红圈准星 PNG 合成；
 * - SoM mark_id 零误差点击、高危点击红圈准星审批停机、连续 3 步 aHash 死循环熔断、种子技能包幂等初始化；
 * - /computer-assist/:token 远程接管页（截图轮询 / 点按转发 / 完成后清追问卡并唤醒 Worker）。
 */
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig, type Config } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore, toConvId } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";
import { startHttp } from "../src/http/server.ts";
import {
	MockComputerDriver,
	computeVisualHash,
	drawCrosshairPng,
	encodeRgbaPng,
	hammingDistance,
	logicalToPhysical,
	normalizePointToLogical,
} from "../src/engine/env/computer-env.ts";

function makeCfg(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-cua-"));
	const cfg = loadConfig();
	cfg.dataDir = dataDir;
	cfg.appDbPath = join(dataDir, "app.sqlite");
	cfg.piDbPath = join(dataDir, "pi.sqlite");
	cfg.wecom.dryRun = true;
	cfg.allowedUsers = ["u1"];
	cfg.feishu.enabled = false;
	cfg.modelProvider = "faux";
	cfg.routerModel = "router-test";
	cfg.workerModel = "worker-test";
	cfg.mem0Mode = "off";
	cfg.acceptMode = "auto";
	cfg.maxWorkers = 3;
	cfg.computerDriver = "mock";
	cfg.port = 0;
	return cfg;
}

describe("M9：Computer Use 视觉桌面引擎（SPEC-v3 §2）", () => {
	let core!: WeAgentCore;
	let cfg!: Config;
	let cleanup!: () => Promise<void>;

	beforeEach(async () => {
		cfg = makeCfg();
		const db = await openAppDb(cfg.appDbPath);
		core = new WeAgentCore(cfg, db);
		await openHarness(core);
		await core.start();
		cleanup = () => db.destroy();
	});

	afterEach(async () => {
		await core.stop().catch(() => {});
		await cleanup();
	});

	it("坐标制式自适应（Qwen 1000 千分比 / 0..1 归一化 / 1280x800 逻辑像素 → Retina 2x 物理像素）与红圈准星 PNG 合成", () => {
		const size = { physicalWidth: 2560, physicalHeight: 1600, logicalWidth: 1280, logicalHeight: 800 };
		// 1. Qwen Flash / UI-TARS 千分比 (500, 500) → 逻辑 (640, 400) → 物理 (1280, 800)
		const p1000 = normalizePointToLogical(500, 500, "1000", size);
		expect(p1000).toEqual({ x: 640, y: 400 });
		expect(logicalToPhysical(p1000.x, p1000.y, size)).toEqual({ x: 1280, y: 800 });

		// 2. [0, 1] 归一化浮点自动识别
		const pNorm = normalizePointToLogical(0.5, 0.25, undefined, size);
		expect(pNorm).toEqual({ x: 640, y: 200 });

		// 3. 红圈准星 PNG 叠加与 64-bit 视觉指纹
		const base = encodeRgbaPng(160, 100, new Uint8Array(160 * 100 * 4).fill(220));
		const crosshair = drawCrosshairPng(base, 640, 400, { width: 1280, height: 800 });
		expect(crosshair.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
		expect(hammingDistance(computeVisualHash(base), computeVisualHash(base))).toBe(0);
	});

	it("SoM mark_id 零误差点击 + 高危按钮红圈准星截图审批停机 + 连续 3 步死循环熔断 + 种子技能包幂等", async () => {
		// 1. 种子技能幂等初始化（4 个办公技能）
		const seeded1 = await core.seedBuiltinSkills();
		expect(seeded1).toHaveLength(4);
		expect(seeded1).toContain("office/weekly-report");
		const seeded2 = await core.seedBuiltinSkills();
		expect(seeded2).toHaveLength(0); // 幂等不重复创建

		// 2. 创建任务并验证 SoM mark_id 点击与高危点击审批
		const { trigger } = await core.insertTrigger({
			source: "wecom",
			userId: "u1",
			strength: "explicit",
			text: "在报销客户端里点查询然后提交报销",
		});
		await core.routeAccept(trigger.id, "桌面报销操作", "收到", "computer test", "medium", [], BACKGROUND_CONTEXT, true);
		const task = (await core.db.selectFrom("tasks").selectAll().executeTakeFirst())!;
		const convId = toConvId(task.conv_id);
		const mockDriver = core.computer as MockComputerDriver;

		// (a) 先截图拿 SoM 控件树 (#1 查询报表, #2 搜索框, #3 确认提交报销)
		const shotRes = await core.computerAction(convId, { action: "screenshot" }, BACKGROUND_CONTEXT);
		expect(shotRes.observation).toContain("[#1]");
		expect(shotRes.observation).toContain("[#3] (AXButton) \"确认提交报销\"");

		// (b) 点击普通按钮 mark_id=1（查询报表 @ 逻辑 230,138 → 物理 460,276）直接执行不停机
		const clickNormal = await core.computerAction(convId, { action: "click", mark_id: 1 }, BACKGROUND_CONTEXT);
		expect(clickNormal.observation).toContain("已执行 click");
		expect(mockDriver.actionsLog.some((a) => a.type === "click" && a.x === 460 && a.y === 276)).toBe(true);
		expect(core.shouldTerminateRound(convId)).toBe(false);

		// (c) 点击高危按钮 mark_id=3（标题含"确认提交报销"）→ 自动合成红圈准星 PNG + 创建 computer.click 草稿 + 标记本轮停机！
		const clickRisk = await core.computerAction(convId, { action: "click", mark_id: 3 }, BACKGROUND_CONTEXT);
		expect(clickRisk.observation).toContain("红圈十字准星预览图并提交审批 #A001");
		expect(core.shouldTerminateRound(convId)).toBe(true);
		const ap = await core.db.selectFrom("approvals").where("id", "=", "A001").selectAll().executeTakeFirst();
		expect(ap?.action_type).toBe("computer.click");
		expect(ap?.status).toBe("pending");
		const payload = JSON.parse(ap!.payload) as { physicalX: number; physicalY: number; crosshairFrame: string };
		expect(payload.physicalX).toBe(2060); // 1030 * 2
		expect(payload.physicalY).toBe(1404); // 702 * 2
		expect(existsSync(join(cfg.dataDir, "trajectories", String(task.id), "frames", payload.crosshairFrame))).toBe(true);

		// 用户批准 A001 → 宿主机真正执行物理点击 (2060, 1404)
		await core.actions.onCardEvent("ap:A001:approve");
		expect(mockDriver.actionsLog.some((a) => a.type === "click" && a.x === 2060 && a.y === 1404)).toBe(true);

		// (d) 冻结屏幕画面：连续 3 次操作画面完全不变 → 自动阻断并推送远程桌面接管追问卡
		mockDriver.freezeScreen = true;
		await core.computerAction(convId, { action: "click", mark_id: 1 }, BACKGROUND_CONTEXT);
		await core.computerAction(convId, { action: "click", mark_id: 1 }, BACKGROUND_CONTEXT);
		const thirdFrozen = await core.computerAction(convId, { action: "click", mark_id: 1 }, BACKGROUND_CONTEXT);
		expect(thirdFrozen.observation).toContain("连续 3 步桌面操作后画面无任何变化");
		expect(thirdFrozen.details?.stuckDetected).toBe(true);
	});

	it("/computer-assist/:token 远程接管页：截图轮询、点按坐标转发与完成后清追问卡唤醒 Worker", async () => {
		const { server } = startHttp(core);
		await new Promise((r) => setTimeout(r, 150));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 8000;
		const baseUrl = `http://127.0.0.1:${port}`;
		const mockDriver = core.computer as MockComputerDriver;

		try {
			// 准备一个处于 waiting_user（死循环熔断）状态的任务
			const { trigger } = await core.insertTrigger({
				source: "wecom",
				userId: "u1",
				strength: "explicit",
				text: "操作桌面客户端",
			});
			await core.routeAccept(trigger.id, "桌面接管演示", "收到", "assist test", "medium", [], BACKGROUND_CONTEXT, true);
			const task = (await core.db.selectFrom("tasks").selectAll().executeTakeFirst())!;
			const convId = toConvId(task.conv_id);
			mockDriver.freezeScreen = true;
			await core.computerAction(convId, { action: "click", mark_id: 1 }, BACKGROUND_CONTEXT);
			await core.computerAction(convId, { action: "click", mark_id: 1 }, BACKGROUND_CONTEXT);
			const stuck = await core.computerAction(convId, { action: "click", mark_id: 1 }, BACKGROUND_CONTEXT);
			const takeoverUrl = String(stuck.details?.takeoverUrl);
			expect(takeoverUrl).toContain("/computer-assist/");
			const token = takeoverUrl.split("/").pop()!;
			const stuckAskId = String(stuck.details?.askId);
			expect((await core.db.selectFrom("tasks").selectAll().executeTakeFirst())?.stage).toBe("waiting_user");

			// 1. 接管页 HTML 可访问；无效 token 的 state.json 拒绝
			const page = await fetch(`${baseUrl}/computer-assist/${token}`);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("我已处理完成");
			const bad = await fetch(`${baseUrl}/computer-assist/bad.token/state.json`);
			expect(bad.status).toBe(403);

			// 2. state.json 返回桌面截图；action.json 点按把归一化坐标转成物理像素点击
			const state = (await (await fetch(`${baseUrl}/computer-assist/${token}/state.json`)).json()) as { screenshot: string };
			expect(state.screenshot.length).toBeGreaterThan(100);
			mockDriver.actionsLog.length = 0;
			await fetch(`${baseUrl}/computer-assist/${token}/action.json`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "click", x: 0.5, y: 0.5 }),
			});
			// 逻辑空间中心 (640, 400) → Retina 2x 物理 (1280, 800)
			expect(mockDriver.actionsLog.some((a) => a.type === "click" && a.x === 1280 && a.y === 800)).toBe(true);

			// 3. 点【我已处理完成】→ 追问卡清掉、任务回到 working、Worker 被唤醒
			const doneRes = (await (
				await fetch(`${baseUrl}/computer-assist/${token}/action.json`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ op: "done" }),
				})
			).json()) as { ok: boolean; done: boolean };
			expect(doneRes.ok).toBe(true);
			const ask = await core.db.selectFrom("asks").where("id", "=", stuckAskId).selectAll().executeTakeFirst();
			expect(ask?.status).toBe("answered");
			expect((await core.db.selectFrom("tasks").selectAll().executeTakeFirst())?.stage).toBe("working");
		} finally {
			server.close();
		}
	});
});
