/**
 * Code Mode 扩展（SPEC-v2 §6.3 M7）：把 pi-durable 的 codemode 工具装配到 Worker 会话。
 * Worker 可在单轮内生成一段 JS 脚本，在 QuickJS WASM 沙箱里并发/循环调用只读工具
 * （web_search / web_fetch / recall / MCP 只读工具），替代多轮串行调用。
 *
 * 安全护栏（SPEC-v2 §6.3）：沙箱会暴露会话全部 callable 工具，因此宿主侧另有三道防线：
 * 1. core.proposeRoundLimit：单会话挂起草稿数硬上限（防脚本失控刷审批卡）；
 * 2. WORKER_RULES_TEXT：终止型工具（propose_action/worker_report/trigger_handback/ask_user）禁入脚本；
 * 3. InlineCodemodeSandbox 运行在调用线程、无 Node 内建权限，脚本唯一能力是调工具。
 */
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { InlineCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { Extension } from "@earendil-works/pi-durable";

export const CODEMODE_EXTENSION_NAME = "weagent-codemode";

export function createCodeModeExtension(): Extension {
	// 生产（Node 主进程）用 worker 线程沙箱；vitest 的 worker 线程内嵌套 worker 会挂起，退回 Inline。
	const sandbox = process.env.VITEST ? new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }) : new CodemodeSandbox();
	return createCodemodeExtension({
		sandbox,
		namespaces: [
			{ name: "web", prefix: "web_", description: "联网搜索（web_search）与网页抓取（web_fetch）" },
			{ name: "memory", prefix: "memory_", description: "长期记忆语义检索（memory_search）" },
			{ name: "mcp", prefix: "mcp_", description: "MCP 工具（只读工具可在脚本内直接调用，写操作会转审批草稿）" },
			{ name: "skills", prefix: "skill", description: "技能库查询（skills_list / skill_view）" },
		],
	});
}
