/**
 * ActionExecutor（SPEC §7）：卡片按钮事件处理 + 宿主机直接执行已批准的草稿 payload。
 * - CAS 状态机（pending → approved/rejected/pending_edit/expired），重复点击幂等；
 * - 批准后宿主机直接调外部 API（不过大模型，~0.2s），结果写 exec_result；
 * - is_final=false 时经 WorkerSlots（+1 紧急槽）唤醒 Worker 继续后续步骤；
 * - MCP 不可逆工具的草稿在此经 bridge 真正执行。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import pino from "pino";
import type { WeAgentCore } from "./core.ts";
import { setStage } from "./tasks.ts";
import { decodePolicyId, encodePolicyId, policyIdOf } from "./trust-policy.ts";
import { digestCard, trustUpgradeCard } from "../wecom/cards.ts";
import { digestCardFeishu, trustUpgradeCardFeishu } from "../feishu/client.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "action-executor" });

export type CardEventResult = { handled: boolean; message: string };

export class ActionExecutor {
	constructor(private readonly core: WeAgentCore) {}

	/** 卡片按钮事件入口（level 1，不过 Router）。buttonKey 形如 ap:A001:approve / ask:K001:0 / retry:12 / trust:{enc}:upgrade / digest:{enc}:approve_all。 */
	async onCardEvent(buttonKey: string, responseCode?: string): Promise<CardEventResult> {
		const parts = buttonKey.split(":");
		const [kind, id, action] = parts;
		if (kind === "ap" && id && action) return this.onApproval(id, action, responseCode);
		if (kind === "ask" && id) return this.onAskOption(id, Number.parseInt(action ?? "-1", 10), responseCode);
		if (kind === "retry" && id) return this.onRetry(Number.parseInt(id, 10));
		if (kind === "trust" && id && action) return this.onTrustButton(id, action);
		if (kind === "digest" && id && action) return this.onDigestButton(id, action);
		if (kind === "br" && id && action === "done") return this.core.completeBrowserLogin(id, responseCode);
		return { handled: false, message: `未知按钮 ${buttonKey}` };
	}

	// ---------- 审批 ----------

	private async onApproval(approvalId: string, action: string, responseCode?: string): Promise<CardEventResult> {
		const row = await this.core.db.selectFrom("approvals").where("id", "=", approvalId).selectAll().executeTakeFirst();
		if (!row) return { handled: true, message: `审批 ${approvalId} 不存在` };
		const rc = responseCode ?? row.response_code ?? undefined;

		if (action === "approve") {
			// CAS（单进程 SQLite）：读-改-写，重复点击幂等（pending_digest 由面板/批量卡走同一通道）
			const current = await this.core.db.selectFrom("approvals").where("id", "=", approvalId).selectAll().executeTakeFirst();
			if (!current || !["pending", "pending_edit", "pending_digest"].includes(current.status)) return { handled: true, message: `${approvalId} 已处理过（幂等）` };
			await this.core.db.updateTable("approvals").set({ status: "approved", decided_at: Date.now() }).where("id", "=", approvalId).execute();

			log.info({ approvalId, actionType: row.action_type }, "已批准，宿主机直接执行");
			let exec: Record<string, unknown>;
			try {
				exec = await this.executePayload(row.action_type, JSON.parse(row.payload) as Record<string, unknown>, approvalId);
			} catch (err) {
				exec = { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
			await this.core.db.updateTable("approvals").set({ exec_result: JSON.stringify(exec) }).where("id", "=", approvalId).execute();
			this.core.auditAction({ type: "approval_execute", approvalId, actionType: row.action_type, result: exec });

			// 信任放权计数（SPEC-v2 §7.2）：无修改直接批准 +1；修改后批准/拒绝清零
			const taskUserId = (await this.taskUser(row.task_id)) ?? "";
			if (taskUserId && ["pending", "pending_digest"].includes(current.status) && !current.previous_approval_id) {
				const { count, shouldPromptUpgrade } = await this.core.trust.recordPlainApprove(taskUserId, row.action_type, row.scope_key);
				if (shouldPromptUpgrade) await this.enqueueTrustUpgradeCard(taskUserId, row.action_type, row.scope_key, count);
				await this.core.skillHygiene.recordTaskApprovalOutcome(row.task_id, "approved_first_try");
			} else if (taskUserId && (current.previous_approval_id || current.status === "pending_edit")) {
				await this.core.trust.recordEditOrReject(taskUserId, row.action_type, row.scope_key);
				await this.core.skillHygiene.recordTaskApprovalOutcome(row.task_id, "edited_or_rejected");
			}
			// 习惯提炼（SPEC-v2 §8）：修改后批准的草稿 → Diff + 意见原话 → learned_habits（失败静默）
			if (current.previous_approval_id) void this.core.habits.fromApproval({ ...row, previous_approval_id: current.previous_approval_id, user_edit_feedback: current.user_edit_feedback });

			if (rc) {
				await this.core.outbox.enqueue({
					dedupKey: `card-upd:${approvalId}:approved`,
					taskId: row.task_id,
					userId: taskUserId,
					kind: "card-update",
					payload: { type: "card_update", responseCode: rc, text: "已批准并执行 ✅" },
				});
			}
			// 取消过期倒计时
			if (row.expiry_task_id) void this.core.harness.abortTask(Number(row.expiry_task_id) as never, BACKGROUND_CONTEXT).catch(() => {});

			if (row.is_final === 1) {
				await setStage(this.core.db, row.task_id, "ready");
				return { handled: true, message: `${approvalId} 已执行完成` };
			}
			// 后续还有步骤：经 WorkerSlots（+1 紧急槽）唤醒 Worker（SPEC §7 步骤 6）
			await setStage(this.core.db, row.task_id, "working");
			await this.core.wakeWorker({
				taskId: row.task_id,
				content: `[系统通知] 草稿 ${approvalId}（${row.action_type}）已执行，结果: ${JSON.stringify(exec).slice(0, 300)}。请继续后续步骤，完成后用 worker_report 收尾。`,
				requestId: `ap:${approvalId}`,
				entryKind: "weagent.system",
				data: { approval_id: approvalId, exec: exec },
				priority: "human",
			});
			return { handled: true, message: `${approvalId} 已执行，Worker 已唤醒继续` };
		}

		if (action === "reject") {
			const current = await this.core.db.selectFrom("approvals").where("id", "=", approvalId).selectAll().executeTakeFirst();
			if (!current || !["pending", "pending_edit", "pending_digest"].includes(current.status)) return { handled: true, message: `${approvalId} 已处理过（幂等）` };
			await this.core.db.updateTable("approvals").set({ status: "rejected", decided_at: Date.now() }).where("id", "=", approvalId).execute();
			const rejectUser = (await this.taskUser(row.task_id)) ?? "";
			if (rejectUser) await this.core.trust.recordEditOrReject(rejectUser, row.action_type, row.scope_key);
			await this.core.skillHygiene.recordTaskApprovalOutcome(row.task_id, "edited_or_rejected");
			if (rc) {
				await this.core.outbox.enqueue({
					dedupKey: `card-upd:${approvalId}:rejected`,
					taskId: row.task_id,
					userId: (await this.taskUser(row.task_id)) ?? "",
					kind: "card-update",
					payload: { type: "card_update", responseCode: rc, text: "已拒绝 ❌" },
				});
			}
			if (row.expiry_task_id) void this.core.harness.abortTask(Number(row.expiry_task_id) as never, BACKGROUND_CONTEXT).catch(() => {});
			await setStage(this.core.db, row.task_id, "working");
			await this.core.wakeWorker({
				taskId: row.task_id,
				content: `[系统通知] 用户拒绝了 ${approvalId}。请终止（worker_report failed/dropped）或调整方案后重新 propose_action。`,
				requestId: `ap:${approvalId}:rejected`,
				entryKind: "weagent.system",
				priority: "human",
			});
			return { handled: true, message: `${approvalId} 已拒绝` };
		}

		if (action === "edit") {
			const current = await this.core.db.selectFrom("approvals").where("id", "=", approvalId).selectAll().executeTakeFirst();
			if (!current || current.status !== "pending") return { handled: true, message: `${approvalId} 已处理过（幂等）` };
			await this.core.db.updateTable("approvals").set({ status: "pending_edit" }).where("id", "=", approvalId).execute();
			if (rc) {
				await this.core.outbox.enqueue({
					dedupKey: `card-upd:${approvalId}:edit`,
					taskId: row.task_id,
					userId: (await this.taskUser(row.task_id)) ?? "",
					kind: "card-update",
					payload: { type: "card_update", responseCode: rc, text: "请直接在下方输入修改意见 ✏️" },
				});
			}
			const userId = await this.taskUser(row.task_id);
			if (userId) {
				await this.core.db
					.updateTable("users")
					.set({ pending_interaction: JSON.stringify({ kind: "approval_edit", id: approvalId }) })
					.where("user_id", "=", userId)
					.execute();
			}
			return { handled: true, message: `${approvalId} 等待修改意见` };
		}

		return { handled: true, message: `未知审批动作 ${action}` };
	}

	// ---------- 追问选项 ----------

	private async onAskOption(askId: string, optionIndex: number, responseCode?: string): Promise<CardEventResult> {
		const row = await this.core.db.selectFrom("asks").where("id", "=", askId).selectAll().executeTakeFirst();
		if (!row) return { handled: true, message: `追问 ${askId} 不存在` };
		if (row.status !== "pending") return { handled: true, message: `${askId} 已回答过（幂等）` };
		const options = row.options ? (JSON.parse(row.options) as string[]) : [];
		const answer = options[optionIndex] ?? `选项${optionIndex}`;
		// 预算熔断追问卡走专用路径（追加 → 放行恢复；停止 → 关单），其余追问按通用流程唤醒 Worker
		if (await this.core.handleBudgetAskAnswer(askId, answer)) {
			return { handled: true, message: `${askId} 已处理（预算熔断决定：${answer}）` };
		}
		await this.core.db.updateTable("asks").set({ status: "answered", answer }).where("id", "=", askId).execute();
		const rc = responseCode ?? row.response_code;
		if (rc) {
			await this.core.outbox.enqueue({
				dedupKey: `card-upd:${askId}:answered`,
				taskId: row.task_id,
				userId: (await this.taskUser(row.task_id)) ?? "",
				kind: "card-update",
				payload: { type: "card_update", responseCode: rc, text: "已收到你的回答 ✅" },
			});
		}
		const userId = await this.taskUser(row.task_id);
		if (userId) {
			await this.core.db.updateTable("users").set({ pending_interaction: null }).where("user_id", "=", userId).execute();
		}
		await setStage(this.core.db, row.task_id, "working");
		await this.core.wakeWorker({
			taskId: row.task_id,
			content: `【用户回答｜追问 ${askId}】\n${answer}`,
			requestId: `ask:${askId}`,
			entryKind: "weagent.followup",
			data: { kind: "ask", ask_id: askId },
			priority: "human",
		});
		return { handled: true, message: `${askId} 已回答：${answer}` };
	}

	// ---------- 失败重试 ----------

	private async onRetry(taskId: number): Promise<CardEventResult> {
		const task = await this.core.db.selectFrom("tasks").where("id", "=", taskId).selectAll().executeTakeFirst();
		if (!task) return { handled: true, message: `任务 #${taskId} 不存在` };
		await setStage(this.core.db, taskId, "working");
		await this.core.wakeWorker({
			taskId,
			content: `[系统通知] 用户要求重试任务 #${taskId}。请从上次的失败点继续。`,
			requestId: `retry:${taskId}:${Date.now()}`,
			entryKind: "weagent.system",
			priority: "human",
		});
		return { handled: true, message: `任务 #${taskId} 重试中` };
	}

	// ---------- 信任放权按钮（SPEC-v2 §7.2：upgrade / keep / downgrade） ----------

	private async onTrustButton(encodedPolicy: string, action: string): Promise<CardEventResult> {
		const policyId = decodePolicyId(encodedPolicy);
		const policy = await this.core.db.selectFrom("trust_policies").where("id", "=", policyId).selectAll().executeTakeFirst();
		if (!policy) return { handled: true, message: `信任策略 ${policyId} 不存在` };
		if (action === "upgrade") {
			await this.core.trust.setUpgradeChoice(policy.user_id, policy.action_type, policy.scope_key, true);
			await this.replyText(policy.user_id, `✅ 已升级：${policy.action_type} @ ${policy.scope_key} 以后自动执行并事后通知，不再逐条审批。`);
			return { handled: true, message: "已升级为 auto_notify" };
		}
		if (action === "keep") {
			await this.core.trust.setUpgradeChoice(policy.user_id, policy.action_type, policy.scope_key, false);
			await this.replyText(policy.user_id, `好的，${policy.action_type} @ ${policy.scope_key} 保持每次审批，不再询问。`);
			return { handled: true, message: "保持 always_ask" };
		}
		if (action === "downgrade") {
			await this.core.trust.downgrade(policy.user_id, policy.action_type, policy.scope_key);
			await this.replyText(policy.user_id, `✅ 已撤回自动放权：${policy.action_type} @ ${policy.scope_key} 以后仍需逐次审批。`);
			return { handled: true, message: "已降级回 always_ask" };
		}
		return { handled: true, message: `未知信任策略动作 ${action}` };
	}

	// ---------- 批量摘要卡按钮（SPEC-v2 §7.3：digest:{enc}:approve_all） ----------

	private async onDigestButton(encodedBatch: string, action: string): Promise<CardEventResult> {
		if (action !== "approve_all") return { handled: true, message: `未知批量摘要动作 ${action}` };
		let userId: string;
		try {
			userId = (JSON.parse(decodePolicyId(encodedBatch)) as { u: string }).u;
		} catch {
			return { handled: true, message: "批量摘要卡标识损坏" };
		}
		const rows = await this.core.db.selectFrom("approvals").where("status", "=", "pending_digest").selectAll().execute();
		const tasks = rows.length > 0 ? await this.core.db.selectFrom("tasks").where("id", "in", [...new Set(rows.map((r) => r.task_id))]).selectAll().execute() : [];
		const mine = rows.filter((r) => tasks.find((t) => t.id === r.task_id)?.user_id === userId);
		if (mine.length === 0) return { handled: true, message: "没有待处理的批量草稿（可能已处理）" };

		const results: string[] = [];
		for (const row of mine) {
			const current = await this.core.db.selectFrom("approvals").where("id", "=", row.id).selectAll().executeTakeFirst();
			if (!current || current.status !== "pending_digest") {
				results.push(`${row.id} 已处理过`);
				continue;
			}
			await this.core.db.updateTable("approvals").set({ status: "approved", decided_at: Date.now() }).where("id", "=", row.id).execute();
			let exec: Record<string, unknown>;
			try {
				exec = await this.executePayload(row.action_type, JSON.parse(row.payload) as Record<string, unknown>, row.id);
			} catch (err) {
				exec = { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
			await this.core.db.updateTable("approvals").set({ exec_result: JSON.stringify(exec) }).where("id", "=", row.id).execute();
			this.core.auditAction({ type: "digest_batch_execute", approvalId: row.id, actionType: row.action_type, result: exec });
			if (row.is_final === 1) {
				await setStage(this.core.db, row.task_id, "ready");
			} else {
				await setStage(this.core.db, row.task_id, "working");
				await this.core.wakeWorker({
					taskId: row.task_id,
					content: `[系统通知] 批量摘要中的草稿 ${row.id}（${row.action_type}）已执行，结果: ${JSON.stringify(exec).slice(0, 300)}。请继续后续步骤。`,
					requestId: `digest:${row.id}`,
					entryKind: "weagent.system",
					priority: "human",
				});
			}
			results.push(`${row.id} ${exec.ok ? "✅" : "❌"}`);
		}
		await this.replyText(userId, `已批量批准 ${mine.length} 条草稿：${results.join("、")}`);
		return { handled: true, message: `批量批准 ${mine.length} 条` };
	}

	/** 达阈值后的升级询问卡（双渠道）。 */
	private async enqueueTrustUpgradeCard(userId: string, actionType: string, scopeKey: string, count: number): Promise<void> {
		const encoded = encodePolicyId(policyIdOf(userId, actionType, scopeKey));
		const card =
			this.core.messenger.kind === "feishu"
				? trustUpgradeCardFeishu({ encodedPolicy: encoded, actionType, scopeKey, count })
				: trustUpgradeCard({ encodedPolicy: encoded, actionType, scopeKey, count });
		await this.core.outbox.enqueue({
			dedupKey: `trust-upgrade:${encoded}:${count}`,
			taskId: null,
			userId,
			kind: "trust-card",
			payload: { type: "card", card },
		});
	}

	/** 简短文本回复（按钮点击的确认，不经任务 outbox 保序）。 */
	private async replyText(userId: string, text: string): Promise<void> {
		await this.core.outbox.enqueue({
			dedupKey: `btn-reply:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
			taskId: null,
			userId,
			kind: "slash-reply",
			payload: { type: "text", text },
		});
	}

	// ---------- 宿主机直接执行草稿 payload（SPEC §7 步骤 4） ----------

	async executePayload(actionType: string, payload: Record<string, unknown>, approvalId: string): Promise<Record<string, unknown>> {
		if (actionType.startsWith("mcp:")) {
			const [, server, tool] = actionType.split(":");
			const bridge = this.core.mcp;
			if (!bridge) return { ok: false, error: "MCP 未启用" };
			return bridge.callTool(server, tool, payload);
		}
		switch (actionType) {
			case "send_email": {
				// v0.4：写入本地发件日志（journal provider）；接入 SMTP 后替换实现
				this.core.auditAction({ type: "email", approvalId, ...payload });
				return { ok: true, provider: "journal", detail: "已记录到发件日志（v0.4 未接 SMTP）" };
			}
			case "create_event": {
				const path = join(this.core.cfg.dataDir, "calendar.json");
				const events = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]) : [];
				events.push(payload);
				writeFileSync(path, JSON.stringify(events, null, 2));
				return { ok: true, detail: "已写入日历" };
			}
			case "wecom_send_text": {
				const to = String(payload.to ?? "");
				const text = String(payload.text ?? "");
				await this.core.messenger.sendText(to, text);
				return { ok: true };
			}
			case "computer.click": {
				const px = Number(payload.physicalX ?? payload.logicalX ?? 0);
				const py = Number(payload.physicalY ?? payload.logicalY ?? 0);
				const button = (payload.button as "left" | "right" | "double") ?? "left";
				await this.core.computer.click(px, py, button);
				this.core.auditAction({ type: "computer.click", approvalId, physicalX: px, physicalY: py, button, targetLabel: payload.targetLabel });
				return { ok: true, clickedAt: { x: px, y: py }, button, targetLabel: payload.targetLabel };
			}
			case "github_create_pr": {
				// v1.0 M9：经 gh CLI 创建 PR（需宿主机安装并登录 gh）；失败返回明确错误供 Worker 调整
				const { execFile } = await import("node:child_process");
				const repo = String(payload.repo ?? "");
				const head = String(payload.head ?? "");
				const title = String(payload.title ?? "");
				if (!repo || !head || !title) return { ok: false, error: "github_create_pr 需要 payload.repo / payload.head / payload.title" };
				const run = (args: string[]) =>
					new Promise<string>((resolve, reject) => {
						execFile("gh", args, { timeout: 60_000 }, (err, stdout, stderr) =>
							err ? reject(new Error(String(stderr || err.message).slice(-300))) : resolve(String(stdout)),
						);
					});
				try {
					const out = await run(["pr", "create", "--repo", repo, "--head", head, "--title", title, "--body", String(payload.body ?? "")]);
					return { ok: true, detail: out.trim().slice(0, 300) || "PR 已创建" };
				} catch (err) {
					return { ok: false, error: `gh CLI 执行失败（需安装 gh 并 gh auth login）：${err instanceof Error ? err.message : String(err)}` };
				}
			}
			default:
				this.core.auditAction({ type: actionType, approvalId, payload });
				return { ok: true, provider: "journal", detail: `未知动作类型 ${actionType}，已记录审计日志` };
		}
	}

	private async taskUser(taskId: number): Promise<string | undefined> {
		const task = await this.core.db.selectFrom("tasks").where("id", "=", taskId).selectAll().executeTakeFirst();
		return task?.user_id;
	}
}
