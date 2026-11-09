/**
 * 浏览器能力探针（独立进程）：验证本机 Chromium 可解析、playwright-core 可真实拉起
 * 持久化上下文并截图。stdout 含 PROBE OK 即通过（不进 git，供真机联调用）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { BrowserPool } from "../src/engine/env/browser-profile.ts";

async function main(): Promise<void> {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-browser-probe-"));
	const cfg = loadConfig();
	cfg.dataDir = dataDir;
	cfg.browserProfilesDir = join(dataDir, "browser-profiles");
	const pool = new BrowserPool(cfg);

	const exe = pool.resolveExecutable();
	console.log(`exec: ${exe}`);

	const session = await pool.session("probe-user");
	await session.page.setContent("<h1>WeAgent 浏览器探针</h1><button>按钮</button>");
	const shot = await pool.screenshot("probe-user");
	console.log(`screenshot: ${shot.length} bytes`);
	await pool.click("probe-user", 100, 50);
	await pool.close("probe-user");
	console.log("PROBE OK: chromium launched, navigated, screenshotted, closed");
	process.exit(0);
}

main().catch((err) => {
	console.log(`PROBE FAIL: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
