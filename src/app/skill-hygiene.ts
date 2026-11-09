/**
 * 技能健康度遥测与夜间巡检（Skill Telemetry & Nightly Hygiene，SPEC-v3 §4.2 M11）：
 * - 记录每个 SKILL.md 被 skill_view 后的任务审批表现（views_count / first_try_approve_count / edit_or_reject_count）；
 * - runNightlyHygiene：
 *   1) 归档超过 60 天未命中且非 pinned 的僵尸技能（移入 .archive/）；
 *   2) 识别高频被打回（views >= 3 且打回率 > 40%）的待优化技能清单；
 * - installExternalSkill：从 URL 或原始 Markdown 安装外部开源 SKILL.md，强制通过 scanContent 静态安全扫描后原子入库。
 */
import type { Kysely } from "kysely";
import pino from "pino";
import type { Db } from "./db.ts";
import { parseFrontmatter, scanContent, type SkillStore } from "./skills.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "skill-hygiene" });

const STALE_SKILL_DAYS = 60;

export type SkillHealthRow = {
	skillName: string;
	description: string;
	pinned: boolean;
	viewsCount: number;
	firstTryApproveCount: number;
	editOrRejectCount: number;
	firstTryRate: number;
	rejectRate: number;
	lastUsedAt: number;
	needsRewrite: boolean;
};

export class SkillHygieneService {
	/** 任务内调用过的技能集合：taskId → Set<skillName> */
	private readonly taskSkillsUsed = new Map<number, Set<string>>();

	constructor(
		private readonly db: Kysely<Db>,
		private readonly store: SkillStore,
	) {}

	/** 当 Worker 调用 skill_view 时记录一次命中。 */
	async recordSkillView(skillName: string, taskId?: number | null): Promise<void> {
		const now = Date.now();
		if (taskId) {
			const set = this.taskSkillsUsed.get(taskId) ?? new Set<string>();
			set.add(skillName);
			this.taskSkillsUsed.set(taskId, set);
		}
		const existing = await this.db
			.selectFrom("skill_telemetry")
			.where("skill_name", "=", skillName)
			.selectAll()
			.executeTakeFirst();
		if (existing) {
			await this.db
				.updateTable("skill_telemetry")
				.set({
					views_count: existing.views_count + 1,
					last_used_at: now,
					last_task_id: taskId ?? existing.last_task_id,
					updated_at: now,
				})
				.where("skill_name", "=", skillName)
				.execute();
		} else {
			await this.db
				.insertInto("skill_telemetry")
				.values({
					skill_name: skillName,
					views_count: 1,
					first_try_approve_count: 0,
					edit_or_reject_count: 0,
					last_used_at: now,
					last_task_id: taskId ?? null,
					updated_at: now,
				})
				.execute();
		}
	}

	/** 当任务草稿被用户审批（一次通过 vs 修改/拒绝）时，归因更新本任务使用过的技能遥测。 */
	async recordTaskApprovalOutcome(taskId: number, outcome: "approved_first_try" | "edited_or_rejected"): Promise<void> {
		let skills = [...(this.taskSkillsUsed.get(taskId) ?? [])];
		if (skills.length === 0) {
			const rows = await this.db.selectFrom("skill_telemetry").where("last_task_id", "=", taskId).selectAll().execute();
			skills = rows.map((r) => r.skill_name);
		}
		if (skills.length === 0) return;

		const now = Date.now();
		for (const name of skills) {
			const existing = await this.db
				.selectFrom("skill_telemetry")
				.where("skill_name", "=", name)
				.selectAll()
				.executeTakeFirst();
			if (!existing) continue;
			await this.db
				.updateTable("skill_telemetry")
				.set({
					first_try_approve_count:
						outcome === "approved_first_try" ? existing.first_try_approve_count + 1 : existing.first_try_approve_count,
					edit_or_reject_count:
						outcome === "edited_or_rejected" ? existing.edit_or_reject_count + 1 : existing.edit_or_reject_count,
					updated_at: now,
				})
				.where("skill_name", "=", name)
				.execute();
		}
	}

	/** 获取所有技能的健康度指标列表（供 H5 面板与夜间巡检使用）。 */
	async getHealthReport(): Promise<SkillHealthRow[]> {
		const metas = this.store.listSkills();
		const rows = await this.db.selectFrom("skill_telemetry").selectAll().execute();
		const teleMap = new Map(rows.map((r) => [r.skill_name, r]));

		return metas.map((m) => {
			const t = teleMap.get(m.name);
			const views = t?.views_count ?? 0;
			const ok = t?.first_try_approve_count ?? 0;
			const bad = t?.edit_or_reject_count ?? 0;
			const totalDecided = ok + bad;
			const firstTryRate = totalDecided > 0 ? Number((ok / totalDecided).toFixed(2)) : 1;
			const rejectRate = views > 0 ? Number((bad / views).toFixed(2)) : 0;
			return {
				skillName: m.name,
				description: m.description,
				pinned: m.pinned,
				viewsCount: views,
				firstTryApproveCount: ok,
				editOrRejectCount: bad,
				firstTryRate,
				rejectRate,
				lastUsedAt: t?.last_used_at ?? 0,
				needsRewrite: views >= 3 && rejectRate > 0.4,
			};
		});
	}

	/**
	 * 夜间巡检（Nightly Hygiene）：
	 * - 归档超过 staleDays 天未使用且未 pinned 的僵尸技能；
	 * - 返回已归档列表与需要重写的高打回率技能列表。
	 */
	async runNightlyHygiene(opts?: { now?: number; staleDays?: number }): Promise<{
		archivedSkills: string[];
		needsRewriteSkills: string[];
	}> {
		const now = opts?.now ?? Date.now();
		const cutoff = now - (opts?.staleDays ?? STALE_SKILL_DAYS) * 24 * 3600_000;
		const report = await this.getHealthReport();
		const archivedSkills: string[] = [];
		const needsRewriteSkills: string[] = [];

		for (const item of report) {
			if (item.needsRewrite) {
				needsRewriteSkills.push(item.skillName);
			}
			if (!item.pinned && item.lastUsedAt > 0 && item.lastUsedAt < cutoff) {
				try {
					await this.store.manage([{ name: item.skillName, action: "delete" }], { actor: "user" });
					archivedSkills.push(item.skillName);
				} catch (err) {
					log.warn({ skill: item.skillName, err }, "僵尸技能归档失败");
				}
			}
		}
		return { archivedSkills, needsRewriteSkills };
	}

	/**
	 * 外部技能安全安装（/skills install <url> 或直接传入 Markdown 正文）：
	 * 强制先过 skills_guard (scanContent) 静态扫描，拦截投毒/外传脚本。
	 */
	async installExternalSkill(input: {
		name?: string;
		url?: string;
		rawMarkdown?: string;
	}): Promise<{ skillName: string; description: string }> {
		let content = input.rawMarkdown ?? "";
		if (!content && input.url) {
			const res = await fetch(input.url);
			if (!res.ok) throw new Error(`拉取远程技能失败：HTTP ${res.status}`);
			content = await res.text();
		}
		if (!content.trim()) throw new Error("技能内容为空");

		const verdict = scanContent(content, "SKILL.md");
		if (verdict.level === "dangerous") {
			throw new Error(`外部技能被 skills_guard 静态安全扫描拦截：\n${verdict.findings.join("\n")}`);
		}

		const fm = parseFrontmatter(content);
		if (!fm || !fm.name || !fm.description) {
			throw new Error("外部技能缺少合法的 YAML frontmatter（需包含 name 与 Use when 开头的 description）");
		}
		const skillName = input.name?.trim() || (fm.category ? `${fm.category}/${fm.name}` : fm.name);
		await this.store.manage(
			[{ name: skillName, action: "create", category: fm.category, content }],
			{ actor: "user" },
		);
		return { skillName, description: fm.description };
	}
}
