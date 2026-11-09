/**
 * 企业微信出站客户端（SPEC §3）：token 缓存 + 提前 5 分钟单飞刷新；文本 / Markdown /
 * 模板卡片 / update_template_card（一次性 response_code）/ 文件上传与发送。
 * dryRun 模式（无企微凭据）下所有调用只打日志，供本地调试与测试。
 */
import pino from "pino";
import type { Config } from "../config.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "wecom-client" });

const BASE = "https://qyapi.weixin.qq.com";
const TOKEN_TTL_MS = 5 * 60 * 1000; // 提前 5 分钟刷新

export type SendResult = { ok: boolean; msgId?: string; responseCode?: string; error?: string; dryRun?: boolean };

/**
 * 渠道出站接口（渠道层隔离）：WeComClient 与 FeishuClient 的公共形状。
 * Outbox / ActionExecutor 只依赖此接口；responseCode 为卡片状态更新的句柄
 * （企微=一次性 response_code，飞书=message_id）。
 */
export interface Messenger {
	readonly kind: "wecom" | "feishu";
	readonly dryRun: boolean;
	sendText(userId: string, content: string): Promise<SendResult>;
	sendMarkdown(userId: string, content: string): Promise<SendResult>;
	sendTemplateCard(userId: string, card: Record<string, unknown>): Promise<SendResult>;
	updateTemplateCard(responseCode: string, text: string): Promise<SendResult>;
	/** 上传并发送文件（filename 必须不含路径分隔符）。 */
	sendFile(userId: string, filename: string, content: Buffer): Promise<SendResult>;
	/** 上传并发送图片（浏览器登录二维码等，v1.0 M9）。 */
	sendImage(userId: string, filename: string, content: Buffer): Promise<SendResult>;
}

export class WeComClient implements Messenger {
	readonly kind = "wecom" as const;
	private readonly cfg: Config;
	private token: { value: string; expiresAt: number } | null = null;
	private refreshing: Promise<string> | null = null;

	constructor(cfg: Config) {
		this.cfg = cfg;
	}

	get dryRun(): boolean {
		return this.cfg.wecom.dryRun;
	}

	/** access_token：内存缓存 + 提前 5 分钟单飞刷新（SPEC §3）。 */
	async accessToken(force = false): Promise<string> {
		if (this.cfg.wecom.dryRun) return "dry-run-token";
		const now = Date.now();
		if (!force && this.token && this.token.expiresAt > now) return this.token.value;
		if (this.refreshing) return this.refreshing;
		this.refreshing = (async () => {
			const url = `${BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.cfg.wecom.corpId)}&corpsecret=${encodeURIComponent(this.cfg.wecom.secret)}`;
			const res = await fetch(url);
			const body = (await res.json()) as { access_token?: string; expires_in?: number; errmsg?: string; errcode?: number };
			if (!body.access_token) {
				throw new Error(`获取 access_token 失败: ${body.errcode} ${body.errmsg}`);
			}
			this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000 - TOKEN_TTL_MS };
			return body.access_token;
		})().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	private async post<T>(path: string, payload: unknown, retryOnToken = true): Promise<T> {
		const token = await this.accessToken();
		const res = await fetch(`${BASE}${path}?access_token=${encodeURIComponent(token)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		const body = (await res.json()) as { errcode?: number; errmsg?: string };
		// 40014/42001：token 失效 → 强制刷新重试一次（SPEC §3）。
		if ((body.errcode === 40014 || body.errcode === 42001) && retryOnToken) {
			await this.accessToken(true);
			return this.post<T>(path, payload, false);
		}
		if (body.errcode && body.errcode !== 0) {
			throw new Error(`企微接口 ${path} 失败: ${body.errcode} ${body.errmsg}`);
		}
		return body as T;
	}

	/** 发文本（≤2048B）。 */
	async sendText(userId: string, content: string): Promise<SendResult> {
		if (content.length > 2048) content = content.slice(0, 2000) + "…";
		return this.send({ msgtype: "text", text: { content }, touser: userId });
	}

	/** 发 Markdown（≤4096B）。 */
	async sendMarkdown(userId: string, content: string): Promise<SendResult> {
		if (content.length > 4096) content = content.slice(0, 4000) + "…";
		return this.send({ msgtype: "markdown", markdown: { content }, touser: userId });
	}

	/** 发模板卡片（审批/追问）。返回一次性 response_code 供后续 update。 */
	async sendTemplateCard(userId: string, card: Record<string, unknown>): Promise<SendResult> {
		const payload = { ...card, agentid: this.cfg.wecom.agentId, touser: userId };
		const body = await this.post<{ errcode: number; response_code?: string }>("/cgi-bin/message/send", payload);
		return { ok: true, responseCode: body.response_code };
	}

	/** 消费一次性 response_code 更新卡片状态（SPEC §3/§7）。 */
	async updateTemplateCard(responseCode: string, text: string): Promise<SendResult> {
		if (this.cfg.wecom.dryRun) {
			log.info({ responseCode, text }, "[dryRun] update_template_card");
			return { ok: true, dryRun: true };
		}
		await this.post("/cgi-bin/message/update_template_card", {
			response_code: responseCode,
			enable_id_trans: 0,
			button_selection: { text },
		});
		return { ok: true };
	}

	/** 上传并发送文件（Messenger 接口）。 */
	async sendFile(userId: string, filename: string, content: Buffer): Promise<SendResult> {
		const mediaId = await this.uploadMedia(filename, content, "file");
		return this.send({ msgtype: "file", file: { media_id: mediaId }, touser: userId });
	}

	/** 上传并发送图片（Messenger 接口，v1.0 M9 扫码协助）。 */
	async sendImage(userId: string, filename: string, content: Buffer): Promise<SendResult> {
		const mediaId = await this.uploadMedia(filename, content, "image");
		return this.send({ msgtype: "image", image: { media_id: mediaId }, touser: userId });
	}

	/** 下载临时素材（语音 amr / 图片 / 文件，v1.0 M6）。 */
	async downloadMedia(mediaId: string): Promise<Buffer> {
		if (this.cfg.wecom.dryRun) {
			log.info({ mediaId }, "[dryRun] download media");
			return Buffer.from(`dry-media:${mediaId}`);
		}
		const token = await this.accessToken();
		const res = await fetch(`${BASE}/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`);
		const contentType = res.headers.get("content-type") ?? "";
		const buf = Buffer.from(await res.arrayBuffer());
		// 出错时企微返回 JSON 而不是文件流
		if (contentType.includes("application/json") || (buf[0] === 0x7b && buf[1] === 0x22)) {
			const body = JSON.parse(buf.toString("utf8")) as { errcode?: number; errmsg?: string };
			throw new Error(`下载素材失败: ${body.errcode} ${body.errmsg}`);
		}
		return buf;
	}

	/** 上传临时文件返回 media_id。 */
	private async uploadMedia(filename: string, content: Buffer, type: "file" | "image"): Promise<string> {
		if (this.cfg.wecom.dryRun) {
			log.info({ filename, bytes: content.length, type }, "[dryRun] upload media");
			return `dry-media-${Date.now()}`;
		}
		const token = await this.accessToken();
		const form = new FormData();
		form.append("media", new Blob([new Uint8Array(content)], { type: "application/octet-stream" }), filename);
		const res = await fetch(`${BASE}/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`, {
			method: "POST",
			body: form,
		});
		const body = (await res.json()) as { media_id?: string; errcode?: number; errmsg?: string };
		if (!body.media_id) throw new Error(`上传文件失败: ${body.errcode} ${body.errmsg}`);
		return body.media_id;
	}

	private async send(payload: Record<string, unknown>): Promise<SendResult> {
		if (this.cfg.wecom.dryRun) {
			log.info({ payload }, "[dryRun] send message");
			return { ok: true, dryRun: true };
		}
		const body = await this.post<{ msgid?: string; response_code?: string }>("/cgi-bin/message/send", {
			...payload,
			agentid: this.cfg.wecom.agentId,
		});
		return { ok: true, msgId: body.msgid, responseCode: body.response_code };
	}
}
