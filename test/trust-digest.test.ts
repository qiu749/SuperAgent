/**
 * M8 审批进化集成测试（SPEC-v2 §7.2/§7.3，fauxProvider 编排）：
 * - 连续无修改批准累计 → 达阈值推升级询问卡 → 升级 auto_notify 后自动执行（Worker 不停机）；
 * - 修改后批准/拒绝清零计数；
 * - urgency=digest 入批量摘要池 → digest 卡 → 一键全部批准；
 * - 一键撤回降级；digest 0 条静默。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type Config } from "../src/config.ts";
import { openAppDb } from "../src/app/db.ts";
import { WeAgentCore } from "../src/app/core.ts";
import { openHarness } from "../src/engine/harness.ts";
import { nextDigestFireMs } from "../src/engine/tasks/digest-cron.ts";
import { decodePolicyId, encodePolicyId, policyIdOf } from "../src/app/trust-policy.ts";

function makeCfg(): Config {
	const dataDir = mkdtempSync(join(tmpdir(), "weagent-trust-"));
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
	cfg.maxWorkers = 3;
	cfg.trustAutoThreshold = 2;
	return cfg;
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15000, stepMs = 100): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v !== undefined && v !== null && v !== false) return v as T;
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

describe("M8 信任放权与批量摘要（fauxProvider）", () => {
	let core!: WeAgentCore;
	let cfg!: Config;
	let cleanup!: () => Promise<void>;

	beforeEach(async () => {
		cfg = makeCfg();
		const db = await openAppDb(cfg.appDbPath);
		core = new WeAgentCore(cfg, db);
		await openHarness(core);
		await core.start();
		cleanup = () => db.destroy();
	});

	afterEach(async () => {
		await core.stop();
		await cleanup();
	});

	/**
	 * Worker 编排：每条 trigger 文本只 propose 一次（send_email @ domain:corp.com，payload 递增防幂等撞车）；
	 * 修改意见 → 重拟；系统通知/已 propose 过 → ready 收尾。
	 */
	function script(): { proposals: number[] } {
		const trace = { proposals: [] as number[] };
		const proposedFor = new Set<string>();
		let n = 0;
		const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
			core.faux!.appendResponses([handler as never]);
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
			const text = typeof lastUser?.content === "string" ? lastUser.content : "";
			if (model.id === cfg.routerModel) {
				const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
				if (m) {
					return fauxAssistantMessage(
						fauxToolCall("route_decision", {
							decisions: [{ kind: "accept", trigger_id: m[1], title: "调研 MCP 邮件生态", acknowledgement: "收到，开始调研并整理对比表", budget: "medium" }],
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Router 直答。");
			}
			const propose = () => {
				n += 1;
				trace.proposals.push(n);
				return fauxAssistantMessage(
					fauxToolCall("propose_action", {
						action_type: "send_email",
						scope_key: "domain:corp.com",
						payload: { to: "boss@corp.com", subject: `周报#${n}`, body: "本周完成…" },
						preview: `把周报#${n}发给 boss@corp.com`,
						is_final: false,
					}),
					{ stopReason: "toolUse" },
				);
			};
			const ready = () => fauxAssistantMessage(fauxToolCall("worker_report", { state: "ready", summary: "全部步骤完成，结论已就绪" }), { stopReason: "toolUse" });
			if (text.startsWith("【用户修改意见")) return propose();
			if (text.startsWith("[系统通知]")) return ready();
			// 同一条触发文本只 propose 一次（auto_notify 放权轮模型会被再次调用）
			const key = text.slice(0, 80);
			if (proposedFor.has(key)) return ready();
			proposedFor.add(key);
			return propose();
		};
		core.faux!.setResponses([handler as never]);
		return trace;
	}

	async function approvalCardKeys(): Promise<string[]> {
		const rows = await core.db.selectFrom("outbox").where("kind", "=", "approval-card").selectAll().execute();
		return rows.map((r) => {
			const card = (JSON.parse(r.payload) as { card: { template_card: { button_list: { key: string }[] } } }).card;
			return card.template_card.button_list.map((b) => b.key).join("|");
		});
	}

	async function lastOutboxOfKind(kind: string) {
		const rows = await core.db.selectFrom("outbox").where("kind", "=", kind).selectAll().orderBy("id", "desc").selectAll().execute();
		return rows[0];
	}

	it("连续批准达阈值 → 升级卡 → auto_notify 自动执行不停机 → 撤回降级恢复逐次审批", async () => {
		script();
		// 任务 1：propose → 批准（计数 1，未达阈值）
		await core.dispatcher.onUserText("u1", "帮我调研 MCP 生态的邮件 server", "m-1");
		await waitFor(async () => (await core.db.selectFrom("approvals").selectAll().execute())[0]);
		let keys = await approvalCardKeys();
		expect(keys[0]).toContain("ap:A001:approve");
		await core.actions.onCardEvent("ap:A001:approve");
		let policy = await core.db.selectFrom("trust_policies").selectAll().executeTakeFirst();
		expect(policy?.consecutive_approvals).toBe(1);
		expect((await core.db.selectFrom("outbox").where("kind", "=", "trust-card").selectAll().execute()).length).toBe(0);

		// 任务 2：propose → 批准（计数 2 达阈值 → 升级询问卡）
		await core.dispatcher.onUserText("u1", "再帮我发一版周报给老板", "m-2");
		await waitFor(async () => (await core.db.selectFrom("approvals").where("id", "=", "A002").selectAll().executeTakeFirst())?.status === "pending");
		await core.actions.onCardEvent("ap:A002:approve");
		policy = await core.db.selectFrom("trust_policies").selectAll().executeTakeFirst();
		expect(policy?.consecutive_approvals).toBe(2);
		const trustCard = await waitFor(async () => lastOutboxOfKind("trust-card"));
		const trustKey = ((JSON.parse(trustCard.payload) as { card: { template_card: { button_list: { key: string }[] } } }).card.template_card.button_list).map((b) => b.key);
		expect(trustKey.some((k) => k.endsWith(":upgrade"))).toBe(true);

		// 点击【升级为自动执行】→ mode=auto_notify
		const upgradeKey = trustKey.find((k) => k.endsWith(":upgrade"))!;
		await core.actions.onCardEvent(upgradeKey);
		policy = await core.db.selectFrom("trust_policies").selectAll().executeTakeFirst();
		expect(policy?.mode).toBe("auto_notify");

		// 任务 3：propose_action 被直接自动执行（approved + notify-card），Worker 不停机继续 → ready
		await core.dispatcher.onUserText("u1", "第三版周报也发一下", "m-3");
		await waitFor(async () => (await core.db.selectFrom("tasks").where("id", "=", 3).selectAll().executeTakeFirst())?.stage === "ready");
		const autoRow = await core.db.selectFrom("approvals").where("id", "=", "A003").selectAll().executeTakeFirst();
		expect(autoRow?.status).toBe("approved");
		expect(autoRow?.scope_key).toBe("domain:corp.com");
		expect((JSON.parse(autoRow!.exec_result!) as { ok: boolean }).ok).toBe(true);
		const notify = await lastOutboxOfKind("notify-card");
		expect(notify).toBeDefined();
		// 自动执行不产生新的待审批卡
		const pending = await core.db.selectFrom("approvals").where("status", "=", "pending").selectAll().execute();
		expect(pending).toHaveLength(0);

		// 一键后悔药：撤回 → 恢复 always_ask，再次 propose 重新走审批卡
		const downgradeKey = ((JSON.parse(notify.payload) as { card: { template_card: { button_list: { key: string }[] } } }).card.template_card.button_list)
			.map((b) => b.key)
			.find((k) => k.endsWith(":downgrade"))!;
		await core.actions.onCardEvent(downgradeKey);
		policy = await core.db.selectFrom("trust_policies").selectAll().executeTakeFirst();
		expect(policy?.mode).toBe("always_ask");
		await core.dispatcher.onUserText("u1", "最后一版周报", "m-4");
		await waitFor(async () => (await core.db.selectFrom("approvals").where("id", "=", "A004").selectAll().executeTakeFirst())?.status === "pending");
		expect((await approvalCardKeys()).some((k) => k.includes("ap:A004:approve"))).toBe(true);
	});

	it("修改后批准：新稿带 previous_approval_id 与 user_edit_feedback，旧稿 superseded，计数清零", async () => {
		script();
		await core.dispatcher.onUserText("u1", "帮我调研 MCP 生态的邮件 server", "m-1");
		await waitFor(async () => (await core.db.selectFrom("approvals").selectAll().execute())[0]);
		// 点【修改】→ 输入修改意见 → Worker 重拟
		await core.actions.onCardEvent("ap:A001:edit");
		await core.dispatcher.onUserText("u1", "收件人改成 boss2@corp.com，语气正式一点");
		const v2 = await waitFor(async () => (await core.db.selectFrom("approvals").where("id", "=", "A002").selectAll().executeTakeFirst()) ?? undefined);
		expect(v2.previous_approval_id).toBe("A001");
		expect(v2.user_edit_feedback).toContain("boss2@corp.com");
		const old = await core.db.selectFrom("approvals").where("id", "=", "A001").selectAll().executeTakeFirst();
		expect(old?.status).toBe("superseded");
		// 批准修改稿：计数清零而非 +1（下一次批准后应为 1 而不是 2，不触发升级卡）
		await core.actions.onCardEvent("ap:A002:approve");
		let policy = await core.db.selectFrom("trust_policies").selectAll().executeTakeFirst();
		expect(policy?.consecutive_approvals ?? 0).toBe(0);
		// 新任务一次普通提案 → 批准 → 计数应为 1
		await core.dispatcher.onUserText("u1", "再帮我发一版周报给老板", "m-2");
		await waitFor(async () => (await core.db.selectFrom("approvals").where("id", "=", "A003").selectAll().executeTakeFirst())?.status === "pending");
		await core.actions.onCardEvent("ap:A003:approve");
		policy = await core.db.selectFrom("trust_policies").selectAll().executeTakeFirst();
		expect(policy?.consecutive_approvals).toBe(1);
		expect((await core.db.selectFrom("outbox").where("kind", "=", "trust-card").selectAll().execute()).length).toBe(0);
	});

	it("urgency=digest 入批量摘要池 → digest 卡 → 一键全部批准执行；0 条时静默", async () => {
		// 专门编排：worker 直接提交 digest 草稿（is_final=true）
		const handler = (ctx: { messages: { role: string; content: unknown }[] }, _o: unknown, _s: unknown, model: { id: string }) => {
			core.faux!.appendResponses([handler as never]);
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user") as { content: unknown } | undefined;
			const text = typeof lastUser?.content === "string" ? lastUser.content : "";
			if (model.id === cfg.routerModel) {
				const m = /\[trigger (t_[a-z0-9]+)/.exec(text);
				if (m) {
					return fauxAssistantMessage(
						fauxToolCall("route_decision", {
							decisions: [{ kind: "accept", trigger_id: m[1], title: "调研 MCP 邮件生态", acknowledgement: "收到，开始调研", budget: "medium" }],
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Router 直答。");
			}
			return fauxAssistantMessage(
				fauxToolCall("propose_action", {
					action_type: "send_email",
					scope_key: "domain:corp.com",
					urgency: "digest",
					payload: { to: "boss@corp.com", subject: "周报", body: "本周完成…" },
					preview: "把周报发给 boss@corp.com（digest）",
					is_final: true,
				}),
				{ stopReason: "toolUse" },
			);
		};
		core.faux!.setResponses([handler as never]);

		// 0 条时 fire 静默：不产生任何 outbox 行
		const outboxBefore = (await core.db.selectFrom("outbox").selectAll().execute()).length;
		await core.fireDigestBatch(1, null as never);
		expect((await core.db.selectFrom("outbox").selectAll().execute()).length).toBe(outboxBefore);

		await core.dispatcher.onUserText("u1", "帮我调研 MCP 生态的邮件 server", "m-1");
		const dg = await waitFor(async () => (await core.db.selectFrom("approvals").where("id", "=", "A001").selectAll().executeTakeFirst()) ?? undefined);
		expect(dg.status).toBe("pending_digest");
		expect(dg.urgency).toBe("digest");
		// 不推单卡
		expect((await core.db.selectFrom("outbox").where("kind", "=", "approval-card").selectAll().execute()).length).toBe(0);

		// digest 时点：合并成批量摘要卡
		await core.fireDigestBatch(1, null as never);
		const digestCardRow = await waitFor(async () => lastOutboxOfKind("digest-card"));
		const buttons = (JSON.parse(digestCardRow.payload) as { card: { template_card: { button_list: { key: string }[] } } }).card.template_card.button_list;
		const approveAll = buttons.find((b) => b.key.startsWith("digest:"))!;
		expect(approveAll.key.endsWith(":approve_all")).toBe(true);

		// 幂等：同 slot 重复 fire 不重发
		await core.fireDigestBatch(1, null as never);
		const digestCount = (await core.db.selectFrom("outbox").where("kind", "=", "digest-card").selectAll().execute()).length;
		expect(digestCount).toBe(1);

		// 一键全部批准 → 执行 + 任务 ready
		await core.actions.onCardEvent(approveAll.key);
		const done = await core.db.selectFrom("approvals").where("id", "=", "A001").selectAll().executeTakeFirst();
		expect(done?.status).toBe("approved");
		expect((JSON.parse(done!.exec_result!) as { ok: boolean }).ok).toBe(true);
		const task = await core.db.selectFrom("tasks").selectAll().executeTakeFirst();
		expect(task?.stage).toBe("ready");
	});

	it("nextDigestFireMs：跳过周末、按 HH:MM 升序取下一时点", () => {
		// 周五 18:00 → 下一个时点是下周一 10:00
		const friday = new Date("2026-11-06T18:00:00");
		const next = new Date(nextDigestFireMs(["17:00", "10:00"], friday.getTime()));
		expect(next.getDay()).toBe(1);
		expect(next.getHours()).toBe(10);
		// 周三 09:00 → 当天 10:00
		const wednesday = new Date("2026-11-04T09:00:00");
		const next2 = new Date(nextDigestFireMs(["10:00", "17:00"], wednesday.getTime()));
		expect(next2.getDay()).toBe(3);
		expect(next2.getHours()).toBe(10);
		// 空配置回退默认 10:00/17:00
		const next3 = new Date(nextDigestFireMs([], wednesday.getTime()));
		expect(next3.getHours()).toBe(10);
	});

	it("policyId 编码往返：base64url 无冒号，可安全用于按钮 key", () => {
		const pid = policyIdOf("u1", "mcp:filesystem:write_file", "domain:corp.com");
		const enc = encodePolicyId(pid);
		expect(enc.includes(":")).toBe(false);
		expect(decodePolicyId(enc)).toBe(pid);
	});
});
