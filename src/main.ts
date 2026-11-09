/**
 * 启动顺序（SPEC §13）：appDb → mem0 → harness.open → resume → http。
 */
import pino from "pino";
import { loadConfig } from "./config.ts";
import { openAppDb } from "./app/db.ts";
import { WeAgentCore } from "./app/core.ts";
import { openHarness } from "./engine/harness.ts";
import { startHttp } from "./http/server.ts";
import { startFeishuConnector } from "./feishu/connector.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "main" });

async function main(): Promise<void> {
	const cfg = loadConfig();
	log.info({ dataDir: cfg.dataDir, acceptMode: cfg.acceptMode }, "WeAgent v0.4 启动中");

	// 1. appDb
	const db = await openAppDb(cfg.appDbPath);
	// 2. core（内含 mem0 初始化）
	const core = new WeAgentCore(cfg, db);
	// 3. harness.open（DeepSeek/faux + Registry + MCP 桥）
	await openHarness(core);
	// 4. resume（恢复睡眠任务 + 排队任务对账）
	await core.start();
	// 5. http
	const { server } = startHttp(core);
	// 6. 飞书长连接（配置了 FEISHU_APP_ID 即启用）
	await startFeishuConnector(core);

	const shutdown = async () => {
		log.info("正在关闭…");
		server.close();
		await core.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
	log.error({ err }, "启动失败");
	process.exit(1);
});
