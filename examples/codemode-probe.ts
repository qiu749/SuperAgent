/**
 * codemode 全链路冒烟探针（独立进程，验证生产形态下的 QuickJS 沙箱编排）：
 * 消息 → Router accept → Worker 在沙箱里用一段 JS 调用只读工具（recall）→ worker_report(ready)。
 * 用法：node --experimental-transform-types examples/codemode-probe.ts（stdout 含 PROBE OK = 通过）。
 * 说明：vitest 的模块加载环境下 pi-durable CodemodeCall 的最终 commit 会挂起，因此本探针
 * 独立成进程（与 spike.ts 同款模式），vitest 用例负责拉起并断言其退出码与输出。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

async function main(): Promise<void> {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-codemode-probe-"));
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

	const db = await openAppDb(cfg.appDbPath);
	const core = new WeAgentCore(cfg, db);
	await openHarness(core);
	await core.start();

	let workerCalls = 0;
	const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
		core.faux!.appendResponses([handler as never]);
		const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
		const text = typeof lastUser?.content === "string" ? lastUser.content : "";
		if (model.id === cfg.routerModel) {
			const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
			if (m) {
				return fauxAssistantMessage(
					fauxToolCall("route_decision", { decisions: [{ kind: "accept", trigger_id: m[1], title: "探针任务", acknowledgement: "收到，开始调研并整理结论", budget: "medium" }] }),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("直答。");
		}
		workerCalls += 1;
		if (workerCalls === 1) {
			return fauxAssistantMessage(
				fauxToolCall("codemode", { code: 'const a = await tools.recall({ query: "测试查询", top_k: 3 });\nreturn `got:${typeof a}:${String(a).slice(0, 60)}`;' }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "probe done" }), { stopReason: "toolUse" });
	};
	core.faux!.setResponses([handler as never]);

	const guard = setTimeout(() => {
		console.log("PROBE TIMEOUT");
		process.exit(2);
	}, 30_000);

	await core.dispatcher.onUserText("u1", "帮我调研", "m-1");
	const deadline = Date.now() + 25_000;
	for (;;) {
		const rows = await db.selectFrom("tasks").selectAll().execute();
		if (rows[0]?.stage === "ready") break;
		if (Date.now() > deadline) {
			console.log(`PROBE FAIL: task stage=${rows[0]?.stage ?? "none"}`);
			process.exit(3);
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	clearTimeout(guard);
	console.log("PROBE OK: task ready");
	await core.stop();
	process.exit(0);
}

main().catch((err) => {
	console.log(`PROBE FAIL: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
