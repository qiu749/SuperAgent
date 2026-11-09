/**
 * 企微回调处理（SPEC §3/§13 wecom/callback.ts + v1.0 §3.2/§3.3）：
 * XML 解析 → 验签/解密 → triggers 表入库去重 → 分流。
 * v1.0：语音（企微 Recognition 优先，缺省走 ffmpeg+ASR）、图片（PicUrl 下载 + Photon 压缩）、
 * 文件（media/get 下载）与群聊消息（ChatId → wecom:chat:{chatid}，@ 判 explicit）。
 */
import { XMLParser } from "fast-xml-parser";
import pino from "pino";
import type { TriggerAttachment, WeAgentCore } from "../app/core.ts";
import { verifySignature, decrypt } from "./crypto.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "wecom-callback" });
const xml = new XMLParser({ ignoreAttributes: false, trimValues: true });

/** 解析并处理一次回调 POST；失败只记日志（对外永远快速 200 空串）。 */
export async function handleWecomCallback(core: WeAgentCore, bodyText: string, query: { msg_signature?: string; timestamp?: string; nonce?: string }): Promise<void> {
	try {
		const doc = xml.parse(bodyText) as { xml?: Record<string, string> };
		const envelope = doc.xml ?? {};
		const encrypt = envelope.Encrypt ?? "";
		if (!encrypt) return;
		if (query.msg_signature && !verifySignature(core.cfg.wecom.token, query.timestamp ?? "", query.nonce ?? "", encrypt, query.msg_signature)) {
			log.warn("企微回调验签失败");
			return;
		}
		const { message } = decrypt(core.cfg.wecom.aesKey, encrypt);
		const msg = xml.parse(message) as { xml: Record<string, string | number> };
		const fields = msg.xml ?? {};
		await handleWecomMessage(core, fields);
	} catch (err) {
		log.error({ err }, "企微回调处理失败");
	}
}

/** 企微消息 → 分流（文本 / 卡片按钮事件 / 语音 / 图片 / 文件 / 群聊，SPEC §3 + SPEC-v2 §3.2/§3.3）。 */
async function handleWecomMessage(core: WeAgentCore, fields: Record<string, string | number>): Promise<void> {
	const msgType = String(fields.MsgType ?? "");
	const msgId = fields.MsgId !== undefined ? String(fields.MsgId) : undefined;
	if (msgType === "event") {
		const event = String(fields.Event ?? "");
		if (event === "template_card_event") {
			const buttonKey = String(fields.EventKey ?? "");
			const responseCode = String(fields.ResponseCode ?? "");
			const result = await core.actions.onCardEvent(buttonKey, responseCode || undefined);
			log.info({ buttonKey, result }, "卡片按钮事件");
		}
		return;
	}
	const from = String(fields.FromUserName ?? "");
	if (!from) return;
	// 群聊：ChatId 存在即群消息；thread_key = wecom:chat:{chatid}
	const chatId = fields.ChatId !== undefined ? String(fields.ChatId) : "";
	const threadKey = chatId ? `wecom:chat:${chatId}` : `wecom:dm:${from}`;
	const senderName = String(fields.SenderName ?? from) || from;

	if (msgType === "text") {
		const content = String(fields.Content ?? "").trim();
		if (!content) return;
		// 群聊里只有 @ 机器人的消息才显式建单；单聊恒显式
		const explicit = !chatId || content.includes("@");
		await core.dispatcher.onInboundMessage({
			source: "wecom",
			userId: from,
			senderName,
			threadKey,
			text: content,
			msgType: "text",
			sourceMsgId: msgId,
			explicit,
		});
		return;
	}

	if (msgType === "voice") {
		const mediaId = String(fields.MediaId ?? "");
		const recognition = String(fields.Recognition ?? "").trim();
		log.info({ from, chatId, recognition: recognition ? "provided" : "none" }, "收到语音消息");
		let text = recognition;
		let transcriptNote = "";
		if (!text && mediaId) {
			try {
				const client = core.messenger as import("./client.ts").WeComClient;
				const amr = await client.downloadMedia(mediaId);
				const r = await core.media.transcribeVoice(amr);
				text = r.text ?? "";
				transcriptNote = r.note;
			} catch (err) {
				log.warn({ err }, "语音下载/转写失败");
				transcriptNote = `语音处理失败：${err instanceof Error ? err.message : String(err)}`;
			}
		}
		if (!text) {
			await core.outbox.enqueue({
				dedupKey: `voice-fail:${msgId ?? `${from}:${Date.now()}`}`,
				taskId: null,
				userId: from,
				kind: "slash-reply",
				payload: { type: "text", text: `⚠️ ${transcriptNote || "语音转写失败"}。请直接打字描述你的需求，或配置 ASR_BASE_URL/ASR_API_KEY 后重试。` },
			});
			return;
		}
		await core.dispatcher.onInboundMessage({
			source: "wecom",
			userId: from,
			senderName,
			threadKey,
			text: `[语音消息转写] ${text}`,
			msgType: "voice",
			rawText: text,
			sourceMsgId: msgId,
			explicit: !chatId,
		});
		return;
	}

	if (msgType === "image" || msgType === "file") {
		const mediaId = String(fields.MediaId ?? "");
		const picUrl = msgType === "image" ? String(fields.PicUrl ?? "") : "";
		const filename = msgType === "file" ? String(fields.FileName ?? "") || "file.bin" : "image.jpg";
		if (!mediaId && !picUrl) return;
		try {
			let buf: Buffer;
			if (picUrl) {
				const res = await fetch(picUrl, { redirect: "follow" });
				if (!res.ok) throw new Error(`下载图片 HTTP ${res.status}`);
				buf = Buffer.from(await res.arrayBuffer());
			} else {
				const client = core.messenger as import("./client.ts").WeComClient;
				buf = await client.downloadMedia(mediaId);
			}
			const attachment = await saveAttachment(core, from, threadKey, filename, buf, msgType === "image" ? "image/jpeg" : "application/octet-stream");
			const hint = `[用户上传${msgType === "image" ? "图片" : "文件"} ${attachment.filename}（${attachment.size}B，inbox_id=${attachment.inbox_id}，已入收件箱；有任务需要时用 attach_inbox_files 绑定）]`;
			await core.dispatcher.onInboundMessage({
				source: "wecom",
				userId: from,
				senderName,
				threadKey,
				text: `${hint} ${String(fields.Content ?? "").trim()}`.trim(),
				msgType,
				sourceMsgId: msgId,
				attachments: [attachment],
				explicit: !chatId,
			});
		} catch (err) {
			log.warn({ err, msgType }, "附件下载/保存失败");
		}
		return;
	}

	log.info({ msgType }, "忽略的消息类型");
}

/** 附件落收件箱（图片走 Photon 压缩）；返回 trigger 附件元数据。 */
async function saveAttachment(core: WeAgentCore, userId: string, threadKey: string, filename: string, buf: Buffer, mime: string): Promise<TriggerAttachment> {
	if (mime.startsWith("image/")) {
		const { row, note } = await core.media.saveImage(userId, threadKey, filename, buf, mime);
		log.info({ filename, note }, "图片已入收件箱");
		return { inbox_path: row.inbox_path, filename: row.filename, mime: row.mime, size: row.size, inbox_id: row.id };
	}
	const row = await core.media.saveFile(userId, threadKey, filename, buf, mime);
	return { inbox_path: row.inbox_path, filename: row.filename, mime: row.mime, size: row.size, inbox_id: row.id };
}
