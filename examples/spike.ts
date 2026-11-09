// WeAgent × Pi Durable spike
// 用法: node spike.ts <mode>
//   crash-a  : 提交任务 → 工具执行中途 process.exit(1)
//   crash-b  : 重开同一 sqlite → resume → 验证续跑
//   appr-a   : 触发不可逆工具 → 被 hook 拦截为"待审批" → run 结束
//   appr-b   : (新进程) 模拟卡片点击批准 → 提交 follow-up → 工具真正执行
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const mode = process.argv[2];
const log = (...a: unknown[]) => console.log(`[${mode}]`, ...a);
const STATE = "./state.json"; // 宿主自己的状态（模拟 WeAgent 的 app DB）
const state: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { approvals: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

// ---------- 工具 ----------
const research = defineTool({
	name: "research",
	description: "长时间调研（可安全重放）",
	parameters: obj({ topic: str() }),
	replay: "safe",
	execute: async (args, api) => {
		appendFileSync("./research-runs.log", `run ${Date.now()} ${args.topic}\n`);
		api.output("step1...\n");
		await new Promise((r) => setTimeout(r, 3000)); // crash-a 会在这期间退出
		api.output("step2...\n");
		return { output: [{ type: "text", text: `调研结论: ${args.topic} 很成熟` }] };
	},
});

const sendEmail = defineTool({
	name: "send_email",
	description: "发送邮件（不可逆）",
	parameters: obj({ to: str(), subject: str(), body: str() }),
	execute: async (args) => {
		appendFileSync("./emails-sent.log", `SENT to=${args.to} subject=${args.subject}\n`);
		return { output: [{ type: "text", text: `已发送给 ${args.to}` }] };
	},
});

// ---------- 审批 hook ----------
const IRREVERSIBLE = new Set(["send_email"]);
const hashArgs = (name: string, a: unknown) => createHash("sha256").update(name + JSON.stringify(a)).digest("hex").slice(0, 12);

const Approval = defineExtension({
	name: "approval",
	hooks: [
		hook(ToolTask, {
			beforeTool: (call: any) => {
				if (!IRREVERSIBLE.has(call.name)) return undefined;
				const id = hashArgs(call.name, call.arguments);
				const ap = state.approvals[id];
				if (ap?.status === "approved") return undefined; // 已批准：放行（参数哈希一致才放行）
				if (!ap) {
					state.approvals[id] = { status: "pending", tool: call.name, args: call.arguments };
					save();
					log(`📨 推送审批卡片 approval=${id}`, call.arguments);
				}
				return { block: `PENDING_APPROVAL:${id} 已提交用户审批，请停止并等待用户决定。` };
			},
			afterTool: (_call: any, result: any) => {
				const blocked = result.diagnostics?.some((d: any) => d.code === "blocked");
				return blocked ? { ...result, control: { terminate: true } } : result;
			},
		}),
	],
});

// ---------- Harness ----------
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const m = faux.getModel();
const registry = createRegistry();
registry.install(defineExtension({ name: "tools", tools: [research, sendEmail] }));
registry.install(Approval);

const harness = await Harness.open(await openNodeSqliteStorage("./session.sqlite"), { models, registry }, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: m.provider, modelId: m.id } } });

async function lastAnswer(settled: any) {
	if (settled.status === "done" && settled.type === "input") {
		// settled.answer 即已提交的最终回答 entry id
		const page: any = await root.entries({ minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, ctx);
		return JSON.stringify(page.items?.[0]?.model?.[0]?.content ?? page);
	}
	return `status=${settled.status} reason=${JSON.stringify(settled.reason ?? settled)}`;
}

if (mode === "crash-a") {
	faux.setResponses([fauxAssistantMessage(fauxToolCall("research", { topic: "MCP 邮件 server" }), { stopReason: "toolUse" })]);
	const sub = await root.submit({ type: "input", content: "帮我调研 MCP 邮件 server", requestId: "task-1" }, ctx);
	state.sub = sub.id; save();
	log("submitted", sub.id, "→ 1.5s 后模拟崩溃");
	setTimeout(() => { log("💥 crash"); process.exit(1); }, 1500);
} else if (mode === "crash-b") {
	faux.setResponses([fauxAssistantMessage("任务完成：MCP 邮件 server 生态很成熟。")]);
	harness.resume();
	const sub = await harness.submission(state.sub, ctx);
	const settled = await sub!.wait(ctx);
	log("answer:", await lastAnswer(settled));
	log("research 执行次数:", readFileSync("./research-runs.log", "utf8").trim().split("\n").length);
	await harness.close(ctx);
} else if (mode === "appr-a") {
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("send_email", { to: "boss@corp.com", subject: "周报", body: "本周完成..." }), { stopReason: "toolUse" }),
		fauxAssistantMessage("(不应被调用：blocked 后应 terminate)"),
	]);
	const sub = await root.submit({ type: "input", content: "把周报发给老板", requestId: "task-2" }, ctx);
	const settled = await sub.wait(ctx);
	log("run 结束:", await lastAnswer(settled));
	log("模型被调用次数:", faux.state.callCount, "（期望 1）");
	log("emails-sent.log 存在?", existsSync("./emails-sent.log"));
	await harness.close(ctx);
} else if (mode === "appr-b") {
	// 新进程：模拟用户点击【批准】
	const [id] = Object.keys(state.approvals);
	state.approvals[id].status = "approved"; save();
	log(`✅ 用户批准 approval=${id}`);
	const a = state.approvals[id];
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall(a.tool, a.args), { stopReason: "toolUse" }),
		fauxAssistantMessage("邮件已发送给老板。"),
	]);
	const sub = await root.submit({ type: "input", content: `[system] 审批 ${id} 已被用户批准，请执行。`, requestId: `approval-${id}` }, ctx);
	const settled = await sub.wait(ctx);
	log("answer:", await lastAnswer(settled));
	log("emails-sent.log:", readFileSync("./emails-sent.log", "utf8").trim());
	// 幂等：重复点击 = 同 requestId 再提交
	const again = await root.submit({ type: "input", content: `[system] 审批 ${id} 已被用户批准，请执行。`, requestId: `approval-${id}` }, ctx);
	log("重复点击幂等:", again.id === sub.id);
	await harness.close(ctx);
}
