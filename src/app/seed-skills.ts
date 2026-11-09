/**
 * 开箱即用办公种子技能包（SPEC-v3 §2.5 M9）：
 * - 解决首次启动 /data/skills/ 为空的冷启动问题；
 * - 幂等注入 4 个高频办公种子技能（office/weekly-report、office/meeting-minutes、research/web-briefing、devops/pr-review）；
 * - 通过 /data/skills/.seed_manifest.json 追踪已播种条目，若用户后续修改、禁用或归档，绝不覆盖。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { SkillStore } from "./skills.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "seed-skills" });

export type SeedSkillDef = {
	name: string;
	category: string;
	content: string;
	templates?: Record<string, string>;
};

export const BUILTIN_SEED_SKILLS: SeedSkillDef[] = [
	{
		name: "office/weekly-report",
		category: "office",
		content: [
			"---",
			"name: weekly-report",
			'description: Use when summarizing weekly or daily work progress, git commits, or completed tasks into a structured report.',
			"category: office",
			"---",
			"",
			"# 周报与日报生成标准流程",
			"",
			"## 执行步骤",
			"1. 优先收集客观事实来源（本周完成的任务列表、Git 提交记录、日历会议或用户提供的要点），严禁编造数据。",
			"2. 按「核心产出 → 关键指标/里程碑 → 风险与阻塞 → 下周计划」四段式组织，每条要点控制在 1~2 句话以内。",
			"3. 涉及跨部门协作或延期风险时，必须显式标出需要谁配合及预计解决时间点。",
			"4. 详细排版参考支持模板 `templates/weekly.md`。",
		].join("\n"),
		templates: {
			"templates/weekly.md": [
				"# 本周工作周报",
				"",
				"## 1. 核心进展与交付",
				"- **[项目/模块]**：完成事项与量化结果",
				"",
				"## 2. 风险与需协调事项",
				"- 无 / [具体卡点与责任人]",
				"",
				"## 3. 下周重点计划",
				"- [ ] 计划事项 1",
			].join("\n"),
		},
	},
	{
		name: "office/meeting-minutes",
		category: "office",
		content: [
			"---",
			"name: meeting-minutes",
			'description: Use when converting voice transcripts, group chat logs, or raw meeting notes into structured minutes and action items.',
			"category: office",
			"---",
			"",
			"# 会议纪要提炼与待办拆解规范",
			"",
			"## 执行步骤",
			"1. 先过滤寒暄与重复口水话，提炼本次会议的 **核心结论（Decisions）**（不超过 5 条）。",
			"2. 将所有待办事项（Action Items）拆解为表格或清单，每项必须包含：**事项内容、负责人（Owner）、截止时间（DDL）**；若原文未提截止时间，标注为「待确认」。",
			"3. 如需将待办同步至日历或群聊，必须调用 `propose_action` 生成草稿交用户审批，严禁直接群发。",
		].join("\n"),
	},
	{
		name: "research/web-briefing",
		category: "research",
		content: [
			"---",
			"name: web-briefing",
			'description: Use when researching competitors, products, or technical solutions across multiple web sources into a comparison table.',
			"category: research",
			"---",
			"",
			"# 多源网页调研与对比简报流程",
			"",
			"## 执行步骤",
			"1. 若调研目标超过 2 个独立站点或开源项目，优先使用 `spawn_subworkers` 或 `execute_code` 并行拉取，避免单线程逐页串行消耗上下文。",
			"2. 统一对比维度（定位、核心架构、定价/开源协议、优缺点、适用场景），输出 Markdown 对比矩阵表。",
			"3. 关键结论后必须附带真实来源 URL，无法核实的数据标注「未公开」。",
		].join("\n"),
	},
	{
		name: "devops/pr-review",
		category: "devops",
		content: [
			"---",
			"name: pr-review",
			'description: Use when reviewing git diffs, pull requests, or code patches for bugs, security risks, and regressions.',
			"category: devops",
			"---",
			"",
			"# 代码变更与 PR 审查清单",
			"",
			"## 审查优先级",
			"1. **阻断级缺陷（Blocker）**：SQL/命令注入、越权访问、未处理的并发竞态、破坏向后兼容的 Schema 变更。",
			"2. **状态与幂等性**：外部回调、重试逻辑与数据库写入是否满足幂等（重复触发不产生脏数据）。",
			"3. **单测覆盖**：新增分支与边界条件是否包含可运行的自动化测试。",
		].join("\n"),
	},
];

/**
 * 幂等播种内置技能包：仅在技能尚未播种且目录不存在时创建。
 * 返回本次新创建的技能名称列表。
 */
export async function ensureSeedSkills(store: SkillStore): Promise<string[]> {
	const manifestPath = join(store.root, ".seed_manifest.json");
	let seeded: Record<string, number> = {};
	if (existsSync(manifestPath)) {
		try {
			seeded = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, number>;
		} catch {
			seeded = {};
		}
	}
	const existingNames = new Set(store.listSkills().map((s) => s.name));
	const created: string[] = [];

	for (const def of BUILTIN_SEED_SKILLS) {
		if (seeded[def.name] || existingNames.has(def.name)) {
			seeded[def.name] = seeded[def.name] ?? Date.now();
			continue;
		}
		try {
			await store.manage(
				[
					{ name: def.name, action: "create", category: def.category, content: def.content },
					...Object.entries(def.templates ?? {}).map(([file_path, content]) => ({
						name: def.name,
						action: "write_file" as const,
						file_path,
						content,
					})),
				],
				{ actor: "user" },
			);
			seeded[def.name] = Date.now();
			created.push(def.name);
		} catch (err) {
			log.warn({ skill: def.name, err }, "种子技能初始化跳过");
		}
	}

	writeFileSync(manifestPath, JSON.stringify(seeded, null, 2));
	if (created.length > 0) {
		log.info({ created }, "办公种子技能包初始化完成");
	}
	return created;
}
