/**
 * 飞书接入（长连接模式，免公网/免备案，SPEC 渠道层隔离的第二个实现）：
 * - LarkChannel WebSocket：归一化 message / cardAction 事件 → Dispatcher / ActionExecutor；
 * - Messenger 接口实现：text / markdown / 交互卡片 / 卡片状态更新 / 文件上传发送。
 * 按钮复用企微侧同一套 action key（ap:{id}:approve 等），业务层零改动。
 */

import { LarkChannel, type CardActionEvent, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import pino from "pino";
import type { Config } from "../config.ts";
import type { WeAgentCore } from "../app/core.ts";
import type { Messenger } from "../wecom/client.ts";
import { BOT_MENU_EVENT } from "./menu.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "feishu" });

// ---------- 飞书交互卡片模板（对应 wecom/cards.ts） ----------

type FeishuCard = {
	config: { wide_screen_mode: true };
	header: { title: { tag: "plain_text"; content: string }; template: string };
	elements: Record<string, unknown>[];
};

function md(text: string): Record<string, unknown> {
	return { tag: "div", text: { tag: "lark_md", content: text } };
}

function buttons(list: { key: string; name: string; primary?: boolean }[]): Record<string, unknown> {
	return {
		tag: "action",
		actions: list.map((b) => ({
			tag: "button",
			text: { tag: "plain_text", content: b.name },
			type: b.primary ? "primary" : "default",
			value: { key: b.key },
		})),
	};
}

export function approvalCardFeishu(opts: { approvalId: string; taskId: number; title: string; actionType: string; preview: string }): FeishuCard {
	return {
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: `待审批 #${opts.approvalId}｜任务 #${opts.taskId}` }, template: "orange" },
		elements: [
			md(`**${opts.actionType}**\n${opts.preview.slice(0, 600)}`),
			buttons([
				{ key: `ap:${opts.approvalId}:approve`, name: "批准", primary: true },
				{ key: `ap:${opts.approvalId}:reject`, name: "拒绝" },
				{ key: `ap:${opts.approvalId}:edit`, name: "修改" },
			]),
			{ tag: "note", elements: [{ tag: "plain_text", content: `任务「${opts.title}」的对外动作草稿，批准后由系统直接执行` }] },
		],
	};
}

export function askCardFeishu(opts: { askId: string; taskId: number; question: string; options?: string[] }): FeishuCard {
	const btns = (opts.options ?? []).slice(0, 3).map((opt, i) => ({ key: `ask:${opts.askId}:${i}`, name: opt, primary: i === 0 }));
	return {
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: `需要你拍板｜任务 #${opts.taskId}` }, template: "blue" },
		elements: [md(opts.question.slice(0, 600)), ...(btns.length ? [buttons(btns)] : [])],
	};
}

/** 给已发送的卡片叠加状态横幅（批准/拒绝/过期），并移除失效按钮。 */
export function withStatus(card: FeishuCard, text: string): FeishuCard {
	const template = text.includes("拒绝") || text.includes("❌") ? "red" : text.includes("过期") ? "grey" : "green";
	return {
		config: card.config,
		header: { ...card.header, template },
		elements: [md(`**${text}**`), ...card.elements.filter((e) => e["tag"] !== "action")],
	};
}

// ========== v1.0 M8：信任放权与批量摘要卡（飞书版，按钮 key 与企微一致） ==========

/** auto_notify 事后轻量通知卡（带一键撤回降级）。 */
export function notifyCardFeishu(opts: { approvalId: string; actionType: string; scopeKey: string; encodedPolicy: string; execSummary: string }): FeishuCard {
	return {
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: `已自动执行 ${opts.actionType}（无需审批）` }, template: "green" },
		elements: [
			md(opts.execSummary.slice(0, 600)),
			md(`**动作** ${opts.actionType}　**范围** ${opts.scopeKey}　**编号** ${opts.approvalId}`),
			buttons([{ key: `trust:${opts.encodedPolicy}:downgrade`, name: "撤回自动放权（以后仍需我审批）" }]),
		],
	};
}

/** 达到连续批准阈值后的升级询问卡。 */
export function trustUpgradeCardFeishu(opts: { encodedPolicy: string; actionType: string; scopeKey: string; count: number }): FeishuCard {
	return {
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: `你已连续 ${opts.count} 次直接批准该类动作` }, template: "orange" },
		elements: [
			md(`${opts.actionType} @ ${opts.scopeKey}：是否升级为自动执行并事后通知？随时可撤回。`),
			buttons([
				{ key: `trust:${opts.encodedPolicy}:upgrade`, name: "升级为自动执行", primary: true },
				{ key: `trust:${opts.encodedPolicy}:keep`, name: "保持每次审批" },
			]),
		],
	};
}

/** 早晚报批量摘要卡。 */
export function digestCardFeishu(opts: { encodedBatch: string; items: { approvalId: string; actionType: string; preview: string }[]; total: number; panelUrl?: string }): FeishuCard {
	const lines = opts.items
		.slice(0, 5)
		.map((it) => md(`**${it.approvalId}** ${it.actionType}：${it.preview.slice(0, 60)}`));
	return {
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: `待拍板草稿（${opts.total} 条）` }, template: "blue" },
		elements: [
			md("这些动作已按你的设置进入批量摘要池，未自动执行。"),
			...lines,
			buttons([{ key: `digest:${opts.encodedBatch}:approve_all`, name: `一键全部批准 (${opts.total} 条)`, primary: true }]),
			...(opts.panelUrl ? [md(`[打开待办面板逐条处理](${opts.panelUrl})`)] : []),
		],
	};
}

/** 浏览器登录协助卡（截图已单独发图）。 */
export function browserLoginCardFeishu(opts: { token: string; siteName: string; assistUrl: string }): FeishuCard {
	return {
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: `需要你登录 ${opts.siteName}` }, template: "orange" },
		elements: [
			md("登录页截图已单独发送：可直接扫码/登录；或打开远程协助页代点代输（5 分钟内有效）。"),
			buttons([{ key: `br:${opts.token}:done`, name: "我已登录完成", primary: true }]),
			...(opts.assistUrl ? [md(`[打开远程协助页](${opts.assistUrl})`)] : []),
		],
	};
}

// ---------- FeishuClient（Messenger 实现） ----------

export class FeishuClient implements Messenger {
	readonly kind = "feishu" as const;
	readonly dryRun = false;
	private readonly channel: LarkChannel;
	/** message_id → 已发送卡片（用于 updateCard 状态叠加；重启后丢失则回退发文本）。 */
	private readonly sentCards = new Map<string, FeishuCard>();

	private readonly cfg: Config;

	constructor(cfg: Config) {
		this.cfg = cfg;
		this.channel = new LarkChannel({
			appId: cfg.feishu.appId,
			appSecret: cfg.feishu.appSecret,
			transport: "websocket",
			loggerLevel: (process.env.FEISHU_LOG_LEVEL as never) ?? "warn",
			source: "weagent",
		});
	}

	/** 启动长连接并接入事件（由 connector 调用）。 */
	async start(handlers: {
		/** 文本消息（单聊恒 explicit；群聊 @ 机器人 explicit）。 */
		onInbound: (input: {
			userId: string;
			senderName?: string;
			threadKey: string;
			text: string;
			msgType: "text" | "voice" | "image" | "file";
			sourceMsgId?: string;
			explicit: boolean;
		}) => Promise<void>;
		/** 资源消息：客户端完成 downloadResource 后交给 connector 走统一媒体管线。 */
		onResource: (input: {
			userId: string;
			senderName?: string;
			threadKey: string;
			resourceType: "image" | "file" | "audio" | "video" | "sticker";
			fileName?: string;
			content: Buffer;
			sourceMsgId: string;
			explicit: boolean;
		}) => Promise<void>;
		onCardAction: (key: string, operatorOpenId: string) => Promise<unknown>;
	}): Promise<void> {
		this.channel.on({
			message: async (msg: NormalizedMessage) => {
				await this.handleMessage(msg, handlers);
			},
			cardAction: async (evt: CardActionEvent) => {
				await this.handleCardAction(evt, handlers.onCardAction);
			},
		});
		await this.channel.connect();
		log.info("飞书长连接已建立");
	}

	private async handleMessage(
		msg: NormalizedMessage,
		handlers: NonNullable<Parameters<FeishuClient["start"]>[0]>,
	): Promise<void> {
		try {
			const botId = this.channel.botIdentity?.openId;
			if (botId && msg.senderId === botId) return; // 忽略机器人自己的消息
			const isGroup = msg.chatType === "group";
			const threadKey = isGroup ? `feishu:group:${msg.chatId}` : `feishu:p2p:${msg.senderId}`;
			const explicit = !isGroup || msg.mentionedBot;
			const meta = { userId: msg.senderId, senderName: msg.senderName, threadKey, explicit };

			// 语音/图片/文件：消息资源端点下载 → connector 统一媒体管线（与企微同构）
			if (msg.rawContentType !== "text") {
				const res = msg.resources?.[0];
				if (!res) {
					log.info({ type: msg.rawContentType, from: msg.senderId }, "无可下载资源的消息，忽略");
					return;
				}
				log.info({ type: res.type, from: msg.senderId, messageId: msg.messageId }, "收到飞书资源消息");
				const buf = await this.downloadMessageResource(msg.messageId, res.fileKey, res.type);
				await handlers.onResource({ ...meta, resourceType: res.type, fileName: res.fileName, content: buf, sourceMsgId: msg.messageId });
				return;
			}

			log.info({ from: msg.senderId, messageId: msg.messageId, group: isGroup }, "收到飞书消息");
			// 群聊 @ 机器人的消息去掉 @ 片段噪声
			const text = isGroup ? msg.content.replace(/@[^\s，,。:：]*/g, "").trim() : msg.content.trim();
			await handlers.onInbound({ ...meta, text: text || msg.content.trim(), msgType: "text", sourceMsgId: msg.messageId });
		} catch (err) {
			log.error({ err }, "处理飞书消息失败");
		}
	}

	private async handleCardAction(evt: CardActionEvent, onCardAction: (key: string, operatorOpenId: string) => Promise<unknown>): Promise<void> {
		try {
			const key = (evt.action.value as { key?: string } | null)?.key;
			if (!key) return;
			log.info({ key, by: evt.operator.openId }, "飞书卡片按钮");
			await onCardAction(key, evt.operator.openId);
		} catch (err) {
			log.error({ err }, "处理飞书卡片按钮失败");
		}
	}

	async sendText(userId: string, content: string): Promise<{ ok: true }> {
		await this.channel.send(userId, { text: content.slice(0, 2000) });
		return { ok: true };
	}

	async sendMarkdown(userId: string, content: string): Promise<{ ok: true }> {
		await this.channel.send(userId, { markdown: content.slice(0, 4000) });
		return { ok: true };
	}

	/** 发交互卡片；返回 messageId 作为后续 update 的句柄（存入 response_code 列）。 */
	async sendTemplateCard(userId: string, card: Record<string, unknown>): Promise<{ ok: true; responseCode?: string }> {
		const r = await this.channel.send(userId, { card });
		if (r?.messageId) this.sentCards.set(r.messageId, card as FeishuCard);
		return { ok: true, responseCode: r?.messageId };
	}

	/** 卡片状态更新：优先原卡叠加状态横幅；卡片缓存丢失则回退发一条文本。 */
	async updateTemplateCard(responseCode: string, text: string): Promise<{ ok: true }> {
		const card = this.sentCards.get(responseCode);
		if (card) {
			try {
				await this.channel.updateCard(responseCode, withStatus(card, text));
				return { ok: true };
			} catch (err) {
				log.warn({ responseCode, err }, "飞书卡片更新失败，回退文本");
			}
		}
		await this.channel.send(text.split("|")[0]?.trim() ? responseCode : responseCode, { text: `【状态更新】${text}` }).catch(() => {});
		return { ok: true };
	}

	async sendFile(userId: string, filename: string, content: Buffer): Promise<{ ok: true }> {
		await this.channel.send(userId, { file: { source: content, fileName: filename } });
		return { ok: true };
	}

	/**
	 * 接收机器人菜单点击事件（application.bot.menu_v6，LarkChannel 类型未覆盖，
	 * 通过其运行时 EventDispatcher 注册任意事件 key）。
	 */
	onMenuEvent(handler: (eventKey: string, operatorOpenId: string) => Promise<void>): void {
		const raw = this.channel as unknown as { dispatcher?: { register(handles: Record<string, unknown>): void } };
		if (!raw.dispatcher) {
			log.warn("LarkChannel 运行时 dispatcher 不可用，菜单点击事件将无法接收");
			return;
		}
		raw.dispatcher.register({
			[BOT_MENU_EVENT]: async (data: {
				event?: {
					event_key?: string;
					operator?: { operator_id?: { open_id?: string; union_id?: string; user_id?: string } } | { open_id?: string };
				};
			}) => {
				try {
					const key = data?.event?.event_key ?? "";
					const op = data?.event?.operator as { operator_id?: { open_id?: string }; open_id?: string } | undefined;
					const openId = op?.operator_id?.open_id ?? op?.open_id ?? "";
					await handler(key, openId);
				} catch (err) {
					log.error({ err }, "处理飞书菜单点击失败");
				}
			},
		});
	}

	/** 发送图片（v1.0 M9 扫码协助等）。 */
	async sendImage(userId: string, filename: string, content: Buffer): Promise<{ ok: true }> {
		await this.channel.send(userId, { image: { source: content } });
		return { ok: true };
	}

	/**
	 * 下载消息附件（v1.0 M6）：走消息资源端点 /im/v1/messages/{id}/resources/{file_key}。
	 * 注意不能用 LarkChannel.downloadResource（im/v1/images/{key}）——对消息内图片返回 400/234001。
	 */
	async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file" | "audio" | "video" | "sticker"): Promise<Buffer> {
		const dlType = type === "image" ? "image" : "file";
		const token = await this.tenantToken();
		const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${dlType}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`下载消息资源失败: HTTP ${res.status} ${body.slice(0, 160)}`);
		}
		return Buffer.from(await res.arrayBuffer());
	}

	/** tenant_access_token（内存缓存，提前 5 分钟刷新；媒体下载等自带 fetch 用）。 */
	private async tenantToken(): Promise<string> {
		const cached = this.token;
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ app_id: this.cfg.feishu.appId, app_secret: this.cfg.feishu.appSecret }),
		});
		const body = (await res.json()) as { tenant_access_token?: string; code?: number; msg?: string };
		if (!body.tenant_access_token) throw new Error(`获取 tenant_access_token 失败: ${body.code} ${body.msg}`);
		this.token = { value: body.tenant_access_token, expiresAt: Date.now() + 110 * 60_000 };
		return body.tenant_access_token;
	}
	private token: { value: string; expiresAt: number } | null = null;
}
