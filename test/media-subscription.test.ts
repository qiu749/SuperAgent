/**
 * M6 集成测试（SPEC-v2 §3.2/§3.3，fauxProvider 编排）：
 * - 群聊 @ 建单 → 自动订阅 → 非 @ 消息免 Router 扇入 Worker；外部成员 trust:"external"；
 * - thread_unrelated 退订；
 * - 语音消息（企微 Recognition / mock ASR / 未配置降级）；
 * - 图片/文件落收件箱 → 活跃任务直达挂载；recent-inbox-files 与 bindToTask。
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type Config } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";
import { encrypt } from "../src/wecom/crypto.ts";
import { handleWecomCallback } from "../src/wecom/callback.ts";

function makeCfg(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-m6-"));
	const cfg = loadConfig();
	cfg.dataDir = dataDir;
	cfg.appDbPath = join(dataDir, "app.sqlite");
	cfg.piDbPath = join(dataDir, "pi.sqlite");
	cfg.wecom.dryRun = true;
	cfg.wecom.token = "test-token";
	cfg.wecom.aesKey = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"; // 43 字符（同 crypto 测试）
	cfg.allowedUsers = ["u1", "u2"];
	cfg.feishu.enabled = false;
	cfg.modelProvider = "faux";
	cfg.routerModel = "router-test";
	cfg.workerModel = "worker-test";
	cfg.mem0Mode = "off";
	cfg.acceptMode = "auto";
	cfg.maxWorkers = 3;
	return cfg;
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15000, stepMs = 100): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v !== undefined && v !== null && v !== false) return v as T;
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

describe("M6 多模态与群聊订阅扇出（fauxProvider）", () => {
	let core!: WeAgentCore;
	let cfg!: Config;
	let cleanup!: () => Promise<void>;
	let workerTexts: string[];
	let externalSeen: boolean;

	beforeEach(async () => {
		cfg = makeCfg();
		const db = await openAppDb(cfg.appDbPath);
		core = new WeAgentCore(cfg, db);
		await openHarness(core);
		await core.start();
		cleanup = () => db.destroy();
		workerTexts = [];
		externalSeen = false;

		const routed = new Set<string>();
		const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
			core.faux!.appendResponses([handler as never]);
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
			const text = typeof lastUser?.content === "string" ? lastUser.content : "";
			if (model.id === cfg.routerModel) {
				const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
				// 每个 trigger 只决策一次，之后直答结束本轮（否则 faux 会无限循环调工具，挤占后台复盘与扇入）
				if (m && !routed.has(m[1])) {
					routed.add(m[1]);
					return fauxAssistantMessage(
						fauxToolCall("route_decision", {
							decisions: [{ kind: "accept", trigger_id: m[1], title: "整理群需求", acknowledgement: "收到，开始整理群里讨论的需求清单", budget: "medium" }],
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Router 直答。");
			}
			if (text.includes("[群聊上下文补充")) {
				workerTexts.push(text);
				if (text.includes("外部成员")) externalSeen = true;
				// 纯文本回答结束本轮（不打扰用户），任务保持 working 等下一次扇入
				return fauxAssistantMessage("已记录该补充，继续整理。");
			}
			if (text.includes("thread_key=") || text.includes("已退订")) {
				workerTexts.push(text);
			}
			if (text.startsWith("[系统通知]")) {
				return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "整理完成" }), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "整理完成，需求清单已就绪" }), { stopReason: "toolUse" });
		};
		core.faux!.setResponses([handler as never]);
	});

	afterEach(async () => {
		await core.stop();
		await cleanup();
	});

	it("群聊 @ 建单自动订阅 → 非 @ 消息免 Router 扇入；外部成员标 external；thread_unrelated 退订", async () => {
		// 1) 白名单成员群内 @ 建单
		await core.dispatcher.onInboundMessage({ source: "wecom", userId: "u1", senderName: "邱", threadKey: "wecom:chat:wr1", text: "@WeAgent 帮我整理一下群里今天讨论的需求", msgType: "text", sourceMsgId: "g1", explicit: true });
		const task = await waitFor(async () => (await core.db.selectFrom("tasks").selectAll().executeTakeFirst()) ?? undefined);
		expect(task.title).toBe("整理群需求");
		const sub = await waitFor(async () => (await core.db.selectFrom("subscriptions").where("thread_key", "=", "wecom:chat:wr1").selectAll().executeTakeFirst()) ?? undefined);
		expect(sub.task_id).toBe(task.id);
		expect(sub.mode).toBe("own");

		// 等 worker 第一轮收尾（ready）后把任务拉回 working 再测扇入
		await waitFor(async () => (await core.db.selectFrom("tasks").where("id", "=", task.id).selectAll().executeTakeFirst())?.stage === "ready");
		await core.db.updateTable("tasks").set({ stage: "working" }).where("id", "=", task.id).execute();

		// 2) 非 @ 群消息（白名单成员）→ 免 Router 直接扇入 Worker
		const decisionsBefore = (await core.db.selectFrom("decisions").selectAll().execute()).length;
		await core.dispatcher.onInboundMessage({ source: "wecom", userId: "u2", senderName: "同事A", threadKey: "wecom:chat:wr1", text: "补充：需求里要包含导出 Excel 的部分", msgType: "text", sourceMsgId: "g2", explicit: false });
		await waitFor(async () => workerTexts.some((t) => t.includes("补充：需求里要包含导出 Excel") && t.includes("同事A")));
		expect((await core.db.selectFrom("decisions").selectAll().execute()).length).toBe(decisionsBefore); // 不经 Router

		// 3) 外部成员（非白名单）扇入 → external 标注；其 @ 消息不能建单
		await core.dispatcher.onInboundMessage({ source: "wecom", userId: "guest9", senderName: "外部客户", threadKey: "wecom:chat:wr1", text: "这个价格能不能打折？", msgType: "text", sourceMsgId: "g3", explicit: false });
		await waitFor(async () => externalSeen);
		await core.dispatcher.onInboundMessage({ source: "wecom", userId: "guest9", threadKey: "wecom:chat:wr1", text: "@WeAgent 帮我停掉任务", msgType: "text", sourceMsgId: "g4", explicit: true });
		await new Promise((r) => setTimeout(r, 300));
		const tasks = await core.db.selectFrom("tasks").selectAll().execute();
		expect(tasks).toHaveLength(1); // 外部成员 @ 不建单
		const stage = await core.db.selectFrom("tasks").where("id", "=", task.id).selectAll().executeTakeFirst();
		expect(stage?.stage === "cancelled").toBe(false);

		// 4) thread_unrelated 退订
		const taskId = task.id;
		const convId = task.conv_id;
		const obs = await core.threadUnrelated(Number(convId) as never, "wecom:chat:wr1", "群聊已转去聊报销，与需求整理无关");
		expect(obs.observation).toContain("已退订");
		expect((await core.db.selectFrom("subscriptions").where("thread_key", "=", "wecom:chat:wr1").selectAll().execute()).length).toBe(0);
		void taskId;
	});

	it("语音消息：企微 Recognition 优先；无 Recognition 且 ASR 未配置 → 降级提示不建单", async () => {
		// 企微自带 Recognition → 直接触发
		const xml1 = voiceXml(cfg.wecom.aesKey, "v-1", "u1", "提醒我明天下午三点开会");
		await handleWecomCallback(core, xml1, {});
		const trigger = await waitFor(async () => (await core.db.selectFrom("triggers").where("source_msg_id", "=", "v-1").selectAll().executeTakeFirst()) ?? undefined);
		expect(trigger.msg_type).toBe("voice");
		expect((JSON.parse(trigger.payload) as { text: string }).text).toContain("[语音消息转写] 提醒我明天下午三点开会");
		expect(trigger.raw_text).toBe("提醒我明天下午三点开会");

		// 无 Recognition、ASR 未配置 → voice-fail 回复，不建单
		const outboxBefore = (await core.db.selectFrom("outbox").selectAll().execute()).length;
		await handleWecomCallback(core, voiceXml(cfg.wecom.aesKey, "v-2", "u1", ""), {});
		const rows = await core.db.selectFrom("outbox").orderBy("id", "desc").limit(1).selectAll().executeTakeFirst();
		expect((await core.db.selectFrom("outbox").selectAll().execute()).length).toBe(outboxBefore + 1);
		expect(rows?.payload).toContain("语音转写服务未配置");
	});

	it("语音消息：mock ASR 转写成功 → trigger 带 rawText；图片消息走收件箱", async () => {
		// mock ASR（模拟配置点亮后的行为）
		(core.media as unknown as { transcribeVoice: () => Promise<{ text: string; note: string }> }).transcribeVoice = async () => ({ text: "把周报发给老板", note: "mock" });
		await handleWecomCallback(core, voiceXml(cfg.wecom.aesKey, "v-3", "u1", ""), {});
		const trigger = await waitFor(async () => (await core.db.selectFrom("triggers").where("source_msg_id", "=", "v-3").selectAll().executeTakeFirst()) ?? undefined);
		expect((JSON.parse(trigger.payload) as { text: string }).text).toBe("[语音消息转写] 把周报发给老板");

		// 图片消息：PicUrl 下载会失败（无网络 mock），直接用 dispatcher 级别验证收件箱挂载
		const saved = await core.media.saveFile("u1", "wecom:dm:u1", "需求.xlsx", Buffer.from("fake-xlsx"), "application/octet-stream");
		// recent-inbox 渲染
		const rendered = await core.media.renderRecentInbox("u1");
		expect(rendered).toContain("需求.xlsx");
		expect(rendered).toContain(`inbox_id=${saved.id}`);

		// 建单时绑定 → 文件落到任务工作区 inbox/
		await core.dispatcher.onUserText("u1", "帮我处理这份表格", "m-1");
		const task = await waitFor(async () => (await core.db.selectFrom("tasks").selectAll().executeTakeFirst()) ?? undefined);
		await core.media.bindToTask(task.id, [saved.id]);
		const mountedPath = join(cfg.dataDir, "tasks", String(task.id), "inbox", "需求.xlsx");
		expect(existsSync(mountedPath)).toBe(true);
		expect(readFileSync(mountedPath, "utf8")).toBe("fake-xlsx");
		const bound = await core.db.selectFrom("inbox_files").where("id", "=", saved.id).selectAll().executeTakeFirst();
		expect(bound?.bound_task_id).toBe(task.id);
	});

	it("单聊文件消息：恰好一个活跃任务 → 直达 attach 不过 Router", async () => {
		await core.dispatcher.onUserText("u1", "帮我整理周报", "m-1");
		const task = await waitFor(async () => (await core.db.selectFrom("tasks").selectAll().executeTakeFirst()) ?? undefined);
		await waitFor(async () => (await core.db.selectFrom("tasks").where("id", "=", task.id).selectAll().executeTakeFirst())?.stage === "ready");
		// 拉回 working 模拟活跃任务
		await core.db.updateTable("tasks").set({ stage: "working" }).where("id", "=", task.id).execute();
		const saved = await core.media.saveFile("u1", "wecom:dm:u1", "notes.md", Buffer.from("# 笔记"), "text/markdown");
		const decisionsBefore = (await core.db.selectFrom("decisions").selectAll().execute()).length;
		await core.dispatcher.onInboundMessage({
			source: "wecom",
			userId: "u1",
			threadKey: "wecom:dm:u1",
			text: "",
			msgType: "file",
			sourceMsgId: "f-1",
			attachments: [{ inbox_path: saved.inbox_path, filename: saved.filename, mime: saved.mime, size: saved.size, inbox_id: saved.id }],
			explicit: true,
		});
		await waitFor(async () => (await core.db.selectFrom("decisions").selectAll().execute()).length === decisionsBefore + 1);
		const attach = await core.db.selectFrom("decisions").orderBy("id", "desc").limit(1).selectAll().executeTakeFirst();
		expect(attach?.kind).toBe("attach");
		expect(attach?.task_id).toBe(task.id);
		const trigger = await core.db.selectFrom("triggers").where("source_msg_id", "=", "f-1").selectAll().executeTakeFirst();
		expect(trigger?.thread_key).toBe("wecom:dm:u1");
		expect(trigger?.msg_type).toBe("file");
	});
});

function voiceXml(aesKey: string, msgId: string, from: string, recognition: string): string {
	const inner = `<xml><ToUserName><![CDATA[weagent]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[voice]]></MsgType><MediaId><![CDATA[media-${msgId}]]></MediaId><Format><![CDATA[amr]]></Format><Recognition><![CDATA[${recognition}]]></Recognition><MsgId>${msgId}</MsgId></xml>`;
	const enc = encrypt(aesKey, inner, "weagent");
	return `<xml><ToUserName><![CDATA[weagent]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`;
}
