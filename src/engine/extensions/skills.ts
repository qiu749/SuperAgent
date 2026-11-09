/**
 * 技能与习惯扩展（SPEC-v2 §8 M7）：
 * - 工具 skills_list / skill_view / skill_manage（原子批量，先读后写守卫在宿主侧按复盘上下文启用）；
 * - section skills-index（轻量索引，~2k tokens）与 learned-habits（已学到的用户习惯）。
 * 装配到 Worker 会话与后台复盘分叉（分叉只挂本扩展 + mem0，天然满足工具白名单）。
 */
import { arr, bool as boolSchema, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";

export const SKILLS_EXTENSION_NAME = "weagent-skills";
export const SKILLS_INDEX_KEY = "skills-index";
export const LEARNED_HABITS_KEY = "learned-habits";

export function createSkillsExtension(host: WeAgentHost) {
	const skillsList = defineTool({
		name: "skills_list",
		description: "列出技能库中所有启用技能的 name 与一句话 description（渐进式披露：先看索引，再按需加载）。",
		parameters: obj({}),
		replay: "safe",
		execute: async () => {
			const list = await host.skillsList();
			if (list.length === 0) return { output: [{ type: "text", text: "（技能库为空）" }] };
			return { output: [{ type: "text", text: list.map((s) => `- ${s.name}：${s.description}${s.pinned ? "（pinned）" : ""}`).join("\n") }] };
		},
	});

	const skillView = defineTool({
		name: "skill_view",
		description:
			"读取一个技能的完整 SKILL.md 或支持文件（file_path 如 references/api.md、templates/report.md）。写 patch 前必须先调用本工具获取最新全文（先读后写守卫）。",
		parameters: obj({
			name: str({ minLength: 1, maxLength: 130 }),
			file_path: opt(str({ maxLength: 200 })),
		}),
		replay: "safe",
		execute: async (args, api) => {
			try {
				const r = await host.skillView(api.conversationId, args.name, args.file_path);
				return { output: [{ type: "text", text: r.content }], details: { path: r.path } };
			} catch (err) {
				return { isError: true, output: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
			}
		},
	});

	const skillManage = defineTool({
		name: "skill_manage",
		description:
			"对技能库做原子批量操作（任一步失败整批回滚）：create（新建，description 必须以 \"Use when <触发条件>.\" 开头）、patch（old_string/new_string 精准替换或 content 全文重写）、write_file/remove_file（references/templates/scripts/assets 内支持文件，≤1MiB）、delete（必须 absorbed_into 指向存在的合并目标）。写已有文件前必须先 skill_view。",
		parameters: obj({
			operations: arr(
				obj({
					name: str({ description: "技能名（可含一级 category 前缀，如 writing/weekly-report）", minLength: 1, maxLength: 130 }),
					action: oneOf(["create", "patch", "write_file", "remove_file", "delete"]),
					content: opt(str({ maxLength: 100_000 })),
					category: opt(str({ maxLength: 60 })),
					old_string: opt(str({ maxLength: 20_000 })),
					new_string: opt(str({ maxLength: 20_000 })),
					replace_all: opt(boolSchema()),
					file_path: opt(str({ maxLength: 200 })),
					absorbed_into: opt(str({ maxLength: 130 })),
				}),
				{ maxItems: 10 },
			),
		}),
		replay: "safe",
		execute: async (args, api) => {
			try {
				const r = await host.skillManage(api.conversationId, args.operations as never);
				return { output: [{ type: "text", text: r.observation }] };
			} catch (err) {
				return { isError: true, output: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
			}
		},
	});

	const tools: ToolRegistration[] = [skillsList, skillView, skillManage];

	const sections = [
		section(SKILLS_INDEX_KEY, async (input) => host.renderSkillsIndex(input.conversationId)),
		section(LEARNED_HABITS_KEY, async (input) => host.renderLearnedHabits(input.conversationId)),
	];

	return defineExtension({ name: SKILLS_EXTENSION_NAME, tools, sections });
}
