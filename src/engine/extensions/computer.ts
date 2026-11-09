/**
 * Computer Use 扩展（SPEC-v3 §2.2-2.4 M9）：
 * - 提供 computer_action 工具（Tier 3 视觉桌面兜底，排在 Code Mode 与 Playwright 之后）；
 * - 支持双模定位：
 *   1) 首选 mark_id（Set-of-Mark 数字角标 #1, #2...，由 macOS AXUIElement 辅助功能树提供，零像素漂移）；
 *   2) 兜底 (x, y) + coord_space（兼容 logical 1280x800、Qwen Flash 千分比 1000、normalized 0..1）；
 * - 危险点击（risk_level=high_risk_commit 或按钮标题含"提交/发送/删除/支付"）自动绘制红圈十字准星 PNG 并转入草稿审批停机；
 * - 连续 3 步操作画面感知哈希（aHash）无变化时，自动阻断盲点并返回远程接管链接。
 */
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";

export const COMPUTER_EXTENSION_NAME = "weagent-computer";

export const COMPUTER_ACTIONS = [
	"screenshot",
	"click",
	"double_click",
	"right_click",
	"move",
	"drag",
	"type",
	"key",
	"scroll",
	"wait",
] as const;

export type ComputerActionInput = {
	action: (typeof COMPUTER_ACTIONS)[number];
	mark_id?: number;
	x?: number;
	y?: number;
	coord_space?: "logical" | "1000" | "normalized";
	to_x?: number;
	to_y?: number;
	text?: string;
	key?: string;
	scroll_dy?: number;
	risk_level?: "read_only" | "normal_input" | "high_risk_commit";
	intent_summary?: string;
};

export function createComputerExtension(host: WeAgentHost) {
	const computerAction = defineTool({
		name: "computer_action",
		description:
			"操作桌面 GUI 界面（Tier 3 视觉桌面引擎，仅在 CLI/Code Mode 和 Playwright 无法完成的原生客户端或复杂弹窗时使用）。优先传入 screenshot 返回的 mark_id（#1, #2... 零误差点击）；无 mark_id 时再传 (x, y) 坐标。涉及提交/发送/删除/付款等不可逆点击时请设置 risk_level=\"high_risk_commit\"，宿主会自动生成红圈十字准星截图发企微审批。",
		parameters: obj({
			action: oneOf(COMPUTER_ACTIONS),
			mark_id: opt(num({ description: "首选：screenshot 返回的 SoM 数字控件编号（如 1 代表 [#1]），零像素误差" })),
			x: opt(num({ description: "兜底横坐标（无 mark_id 时使用）" })),
			y: opt(num({ description: "兜底纵坐标（无 mark_id 时使用）" })),
			coord_space: opt(oneOf(["logical", "1000", "normalized"], { description: "坐标空间：logical(默认 1280x800)、1000(Qwen 千分比 0..1000)、normalized(0..1)" })),
			to_x: opt(num({ description: "drag 终点横坐标" })),
			to_y: opt(num({ description: "drag 终点纵坐标" })),
			text: opt(str({ description: "type 输入的文本", maxLength: 2000 })),
			key: opt(str({ description: "key 快捷键组合，如 Return / Escape / Command+C", maxLength: 100 })),
			scroll_dy: opt(num({ description: "纵向滚动量（正数向下，负数向上）" })),
			risk_level: opt(oneOf(["read_only", "normal_input", "high_risk_commit"], { description: "动作风险等级；high_risk_commit 会触发红圈准星截图审批" })),
			intent_summary: opt(str({ description: "当前步骤一句话意图说明（如：点击『确认报销提交』按钮）", maxLength: 300 })),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			try {
				const r = await host.computerAction(api.conversationId, args as ComputerActionInput, ctx);
				if (r.imageBase64) {
					return {
						output: [
							{ type: "text", text: r.observation },
							{ type: "image", data: r.imageBase64, mimeType: "image/png" },
						],
					};
				}
				return { output: [{ type: "text", text: r.observation }] };
			} catch (err) {
				return { isError: true, output: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
			}
		},
	});

	return defineExtension({
		name: COMPUTER_EXTENSION_NAME,
		tools: [computerAction],
	});
}
