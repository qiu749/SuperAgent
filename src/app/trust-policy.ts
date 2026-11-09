/**
 * TrustPolicyEngine（SPEC-v2 §7.2 渐进式自动放权）：
 * - 每次"无修改直接批准"累计 consecutive_approvals；修改/拒绝清零；
 * - 达阈值推一张轻量升级询问卡（trust:{policy}:upgrade / keep）；
 * - mode=auto_notify：同类草稿宿主机直接执行 + 事后轻量通知（通知卡带一键撤回降级）；
 * - mode=digest：进早晚报批量摘要池（pending_digest）；
 * - mode=always_ask（默认）：单卡审批。
 * policyId = "{user_id}:{action_type}:{scope_key}"；按钮 key 里用 base64url 编码避免冒号冲突。
 */
import type { Kysely } from "kysely";
import type { Config } from "../config.ts";
import type { Db, TrustPoliciesTable } from "./db.ts";

export type TrustMode = TrustPoliciesTable["mode"];

/** 按钮等单值字段里的安全编码（base64url 无冒号/斜杠）。 */
export function encodePolicyId(policyId: string): string {
	return Buffer.from(policyId, "utf8").toString("base64url");
}

export function decodePolicyId(encoded: string): string {
	return Buffer.from(encoded, "base64url").toString("utf8");
}

export function policyIdOf(userId: string, actionType: string, scopeKey: string): string {
	return `${userId}:${actionType}:${scopeKey}`;
}

export class TrustPolicyEngine {
	constructor(
		private readonly db: Kysely<Db>,
		private readonly cfg: Config,
	) {}

	async get(userId: string, actionType: string, scopeKey: string): Promise<TrustPoliciesTable | undefined> {
		return this.db
			.selectFrom("trust_policies")
			.where("id", "=", policyIdOf(userId, actionType, scopeKey))
			.selectAll()
			.executeTakeFirst();
	}

	async getOrCreate(userId: string, actionType: string, scopeKey: string): Promise<TrustPoliciesTable> {
		const id = policyIdOf(userId, actionType, scopeKey);
		const existing = await this.db.selectFrom("trust_policies").where("id", "=", id).selectAll().executeTakeFirst();
		if (existing) return existing;
		const row: TrustPoliciesTable = {
			id,
			user_id: userId,
			action_type: actionType,
			scope_key: scopeKey,
			consecutive_approvals: 0,
			mode: "always_ask",
			prompted_upgrade: 0,
			updated_at: Date.now(),
		};
		await this.db.insertInto("trust_policies").values(row).execute();
		return row;
	}

	/**
	 * 这条新草稿走哪条路（SPEC-v2 §7.2 flowchart）：
	 * auto_notify（已放权）→ 自动执行；policy=digest 或 urgency=digest → 批量池；否则 always_ask。
	 */
	async decide(userId: string, actionType: string, scopeKey: string, urgency: "immediate" | "digest"): Promise<TrustMode> {
		const policy = await this.get(userId, actionType, scopeKey);
		if (policy?.mode === "auto_notify") return "auto_notify";
		if (policy?.mode === "digest" || urgency === "digest") return "digest";
		return "always_ask";
	}

	/** 无修改直接批准：累计；达到阈值且尚未询问过 → 返回应推升级询问卡。 */
	async recordPlainApprove(userId: string, actionType: string, scopeKey: string): Promise<{ count: number; shouldPromptUpgrade: boolean }> {
		const policy = await this.getOrCreate(userId, actionType, scopeKey);
		if (policy.mode !== "always_ask") return { count: policy.consecutive_approvals, shouldPromptUpgrade: false };
		const count = policy.consecutive_approvals + 1;
		const shouldPromptUpgrade = count >= this.cfg.trustAutoThreshold && policy.prompted_upgrade === 0;
		await this.db
			.updateTable("trust_policies")
			.set({ consecutive_approvals: count, prompted_upgrade: shouldPromptUpgrade ? 1 : policy.prompted_upgrade, updated_at: Date.now() })
			.where("id", "=", policy.id)
			.execute();
		return { count, shouldPromptUpgrade };
	}

	/** 用户点了【修改】后批准修改稿 / 拒绝 / 卡片过期：清零计数。 */
	async recordEditOrReject(userId: string, actionType: string, scopeKey: string): Promise<void> {
		const policy = await this.get(userId, actionType, scopeKey);
		if (!policy || policy.consecutive_approvals === 0) return;
		await this.db
			.updateTable("trust_policies")
			.set({ consecutive_approvals: 0, updated_at: Date.now() })
			.where("id", "=", policy.id)
			.execute();
	}

	/** 升级询问卡上的选择：upgrade → auto_notify；keep → 保持 always_ask 且不再重复询问。 */
	async setUpgradeChoice(userId: string, actionType: string, scopeKey: string, upgrade: boolean): Promise<TrustMode> {
		const policy = await this.getOrCreate(userId, actionType, scopeKey);
		const mode: TrustMode = upgrade ? "auto_notify" : "always_ask";
		await this.db
			.updateTable("trust_policies")
			.set({ mode, consecutive_approvals: 0, prompted_upgrade: 1, updated_at: Date.now() })
			.where("id", "=", policy.id)
			.execute();
		return mode;
	}

	/** 一键后悔药：降级回 always_ask 并允许未来再次询问升级。 */
	async downgrade(userId: string, actionType: string, scopeKey: string): Promise<void> {
		const policy = await this.getOrCreate(userId, actionType, scopeKey);
		await this.db
			.updateTable("trust_policies")
			.set({ mode: "always_ask", consecutive_approvals: 0, prompted_upgrade: 0, updated_at: Date.now() })
			.where("id", "=", policy.id)
			.execute();
	}

	async setMode(userId: string, actionType: string, scopeKey: string, mode: TrustMode): Promise<void> {
		const policy = await this.getOrCreate(userId, actionType, scopeKey);
		await this.db
			.updateTable("trust_policies")
			.set({ mode, consecutive_approvals: 0, prompted_upgrade: 0, updated_at: Date.now() })
			.where("id", "=", policy.id)
			.execute();
	}

	async listByUser(userId: string): Promise<TrustPoliciesTable[]> {
		return this.db.selectFrom("trust_policies").where("user_id", "=", userId).orderBy("updated_at", "desc").selectAll().execute();
	}
}
