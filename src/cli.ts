/**
 * 本地模拟调试 CLI（SPEC M0）：不依赖企微，直接驱动 Dispatcher。
 * 用法：npm run cli
 *   输入任意文本 → 模拟用户消息
 *   /tasks /stop <n> /memory /cron /mode /help → 斜杠命令
 *   /card ap:A001:approve → 模拟卡片按钮点击
 *   /quit 退出
 */
import { createInterface } from "node:readline/promises";
import pino from "pino";
import { loadConfig } from "./config.ts";
import { openAppDb } from "./app/db.ts";
import { WeAgentCore } from "./app/core.ts";
import { openHarness } from "./engine/harness.ts";

const log = pino({ level: process.env.LOG_LEVEL || "warn" });

async function main(): Promise<void> {
	const cfg = loadConfig();
	cfg.wecom.dryRun = true; // CLI 一律 dryRun
	const db = await openAppDb(cfg.appDbPath);
	const core = new WeAgentCore(cfg, db);
	await openHarness(core);
	await core.start();
	const userId = cfg.allowedUsers[0] || "debug";
	await core.ensureUser(userId);

	console.log(`WeAgent CLI（dryRun，用户 ${userId}）。输入消息模拟企微单聊；/card <key> 模拟按钮；/quit 退出。`);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let seq = 0;
	for (;;) {
		const line = (await rl.question("› ")).trim();
		if (!line) continue;
		if (line === "/quit") break;
		if (line.startsWith("/card ")) {
			const key = line.slice(6).trim();
			const r = await core.actions.onCardEvent(key);
			console.log(`[card] ${JSON.stringify(r)}`);
			continue;
		}
		seq++;
		await core.dispatcher.onUserText(userId, line, `cli-${seq}`);
	}
	rl.close();
	await core.stop();
}

main().catch((err) => {
	log.error({ err }, "CLI 启动失败");
	process.exit(1);
});
