/**
 * 飞书长连接启动器（免公网/免备案）：WS 出站连飞书开放平台。
 * v0.4：单聊消息 → Dispatcher，卡片按钮 → ActionExecutor。
 * v1.0 M6：群聊（@ 机器人建单/订阅、非 @ 扇出）、语音（ASR）/图片（Photon）/文件（收件箱）统一管线。
 */
import pino from "pino";
import type { TriggerAttachment, WeAgentCore } from "../app/core.ts";
import { FeishuClient } from "./client.ts";
import { menuKeyToCommand } from "./menu.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "feishu-connector" });

export async function startFeishuConnector(core: WeAgentCore): Promise<void> {
	if (!core.cfg.feishu.enabled) return;
	if (core.messenger.kind !== "feishu") {
		log.warn("FEISHU_APP_ID 已配置但出站通道不是飞书（不应发生），跳过连接");
		return;
	}
	const client = core.messenger as FeishuClient;
	await client.start({
		onInbound: async (input) => {
			await core.dispatcher.onInboundMessage({ source: "feishu", ...input });
		},
		onResource: async (input) => {
			try {
				let attachments: TriggerAttachment[] | undefined;
				let text = "";
				let msgType: "voice" | "image" | "file" = "file";
				if (input.resourceType === "audio") {
					const r = await core.media.transcribeVoice(input.content);
					if (!r.text) {
						log.warn({ note: r.note }, "飞书语音转写失败");
						await core.outbox.enqueue({
							dedupKey: `voice-fail:${input.sourceMsgId}`,
							taskId: null,
							userId: input.userId,
							kind: "slash-reply",
							payload: { type: "text", text: `⚠️ ${r.note}。请直接打字描述你的需求，或配置 ASR_BASE_URL/ASR_API_KEY 后重试。` },
						});
						return;
					}
					text = `[语音消息转写] ${r.text}`;
					msgType = "voice";
				} else if (input.resourceType === "image") {
					const { row } = await core.media.saveImage(input.userId, input.threadKey, input.fileName ?? "image.jpg", input.content, "image/jpeg");
					attachments = [{ inbox_path: row.inbox_path, filename: row.filename, mime: row.mime, size: row.size, inbox_id: row.id }];
					msgType = "image";
					text = `[用户上传图片 ${row.filename}（${row.size}B，inbox_id=${row.id}，已入收件箱；有任务需要时用 attach_inbox_files 绑定）] ${text}`;
				} else {
					const row = await core.media.saveFile(input.userId, input.threadKey, input.fileName ?? "file.bin", input.content, "application/octet-stream");
					attachments = [{ inbox_path: row.inbox_path, filename: row.filename, mime: row.mime, size: row.size, inbox_id: row.id }];
					msgType = "file";
					text = `[用户上传文件 ${row.filename}（${row.size}B，inbox_id=${row.id}，已入收件箱；有任务需要时用 attach_inbox_files 绑定）] ${text}`;
				}
				await core.dispatcher.onInboundMessage({ source: "feishu", userId: input.userId, senderName: input.senderName, threadKey: input.threadKey, text, msgType, sourceMsgId: input.sourceMsgId, attachments, explicit: input.explicit });
			} catch (err) {
				log.error({ err }, "飞书资源消息处理失败");
			}
		},
		onCardAction: async (key) => {
			const r = await core.actions.onCardEvent(key);
			log.info({ key, message: r.message }, "卡片动作完成");
			return r;
		},
	});
	// 机器人菜单「事件」型项：event_key（wa_cmd:xxx）映射回斜杠命令管线
	client.onMenuEvent(async (eventKey, operatorOpenId) => {
		const cmd = menuKeyToCommand(eventKey);
		if (!cmd || !operatorOpenId) {
			log.info({ eventKey }, "未映射的菜单事件，忽略");
			return;
		}
		log.info({ openId: operatorOpenId, cmd }, "飞书菜单点击 → 斜杠命令");
		await core.dispatcher.onUserText(operatorOpenId, cmd, `menu:${Date.now()}`);
	});
	if (core.cfg.allowedUsers.length === 0) {
		log.warn("ALLOWED_USERS 为空：白名单校验依赖 dryRun 模式，上线前请填入飞书 open_id");
	}
}
