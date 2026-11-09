/**
 * 飞书应用扫码注册（npm run feishu:setup）：
 * 终端打印授权链接/二维码 → 飞书 App 扫码确认 → SDK 自动创建/更新应用
 * （预填机器人能力、im 消息收发权限、消息事件 + 卡片回调订阅）→ 凭据写回 .env。
 * 已有应用时传入 appId 走更新流程（新增增量权限）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as lark from "@larksuiteoapi/node-sdk";
import pino from "pino";
import { printBotMenuGuide } from "./menu.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "feishu-setup" });

function readEnvValue(key: string): string {
	try {
		const line = readFileSync(".env", "utf8")
			.split("\n")
			.find((l) => l.startsWith(`${key}=`));
		return line ? line.slice(key.length + 1).trim() : "";
	} catch {
		return "";
	}
}

function writeEnvValues(values: Record<string, string>): void {
	let raw = readFileSync(".env", "utf8");
	for (const [key, value] of Object.entries(values)) {
		const re = new RegExp(`^${key}=.*$`, "m");
		raw = re.test(raw) ? raw.replace(re, `${key}=${value}`) : `${raw}\n${key}=${value}`;
	}
	writeFileSync(".env", raw);
}

async function main(): Promise<void> {
	const existingAppId = readEnvValue("FEISHU_APP_ID").replace(/=.*$/, "") && readEnvValue("FEISHU_APP_ID");
	console.log(existingAppId ? `已有应用 ${existingAppId}，将走增量更新（新增权限/事件）…` : "将创建新的飞书自建应用…");

	const result = await lark.registerApp({
		...(existingAppId ? { appId: existingAppId } : {}),
		onQRCodeReady(info) {
			console.log("\n📱 请用飞书 App 扫码（或直接点击链接）：");
			console.log(`   ${info.url}`);
			console.log(`   链接 ${info.expireIn} 秒后过期；过期重跑本命令即可。\n`);
			console.log("扫码确认页会显示 WeAgent 需要的增量配置：");
			console.log("  · 机器人能力");
			console.log("  · 权限：im:message（收发消息）、im:resource（文件）、im:chat");
			console.log("  · 事件：接收消息 im.message.receive_v1");
			console.log("  · 回调：卡片按钮 card.action.trigger");
		},
		onStatusChange(info) {
			if (info.status === "slow_down") console.log("…轮询限流，稍候");
		},
	});

	writeEnvValues({ FEISHU_APP_ID: result.client_id, FEISHU_APP_SECRET: result.client_secret });
	console.log("\n✅ 应用配置完成，凭据已写入 .env：");
	console.log(`   FEISHU_APP_ID=${result.client_id}`);
	console.log(`   FEISHU_APP_SECRET=${"*".repeat(8)}${result.client_secret.slice(-4)}`);
	printBotMenuGuide(readEnvValue("PANEL_BASE_URL") || "http://localhost:8000");
	console.log("下一步：npm run dev 启动 → 飞书里给机器人发消息。");
	console.log("若机器人搜不到，去开发者后台「版本管理与发布」发布一个版本。");
	void log;
	process.exit(0);
}

main().catch((err: { code?: string; description?: string }) => {
	console.error(`注册失败: ${err.code ?? ""} ${err.description ?? err}`);
	process.exit(1);
});
