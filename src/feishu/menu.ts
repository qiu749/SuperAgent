/**
 * 飞书机器人菜单（聊天输入框打 "/" 或点机器人菜单键弹出的联想列表）。
 *
 * 为什么默认没有：斜杠联想是飞书的「机器人菜单」能力，需在开发者后台配置；
 * 且菜单没有开放 API（/open-apis/application/v6/bots/menus 等路径均不存在，实测 404），
 * 只能后台手动配一次（本脚本会打印精确步骤）。
 *
 * 三种响应动作与我们的管线对接：
 * - 「发消息」型：点击即把命令文本（如 /tasks）发进会话 → 既有 dispatcher 管线直接处理，零代码；
 * - 「事件」型：推送 application.bot.menu_v6 事件（携带 event_key）→ connector 侧注册的
 *   onMenuEvent 处理器映射回斜杠命令（BOT_MENU_EVENT 前缀 wa_cmd:）；
 * - 「跳转链接」型：直达 H5 待办面板。
 */
export const BOT_MENU_EVENT = "application.bot.menu_v6";

/** connector 用：把菜单 event_key 还原成斜杠命令文本（如 wa_cmd:tasks → /tasks）。 */
export function menuKeyToCommand(eventKey: string): string | null {
	return eventKey.startsWith("wa_cmd:") ? `/${eventKey.slice("wa_cmd:".length)}` : null;
}

/** 推荐的后台菜单配置（打印给 setup 流程）。 */
export const RECOMMENDED_MENU_ITEMS: { label: string; action: string; value: string }[] = [
	{ label: "待办面板", action: "跳转链接", value: "<PANEL_BASE_URL>/panel" },
	{ label: "任务列表", action: "发消息", value: "/tasks" },
	{ label: "技能库", action: "发消息", value: "/skills" },
	{ label: "我的记忆", action: "发消息", value: "/memory" },
	{ label: "定时任务", action: "发消息", value: "/cron" },
	{ label: "切换模式", action: "发消息", value: "/mode" },
	{ label: "帮助", action: "发消息", value: "/help" },
];

export function printBotMenuGuide(panelBase: string): void {
	console.log("\n———— 让飞书输入框弹出斜杠选项（机器人菜单，仅支持单聊）————");
	console.log("机器人菜单无开放 API（实测 404），请在开发者后台手动配置一次：");
	console.log("  开发者后台 → 你的应用 → 应用能力 → 机器人 → 菜单栏 → 开启并添加菜单项：\n");
	console.log("  菜单名称        响应动作     内容");
	for (const item of RECOMMENDED_MENU_ITEMS) {
		console.log(`  ${item.label.padEnd(8)} ${item.action.padEnd(6)}   ${item.value.replace("<PANEL_BASE_URL>", panelBase)}`);
	}
	console.log("\n  · 「发消息」型点击后自动把命令文本发进会话，WeAgent 直接执行（推荐）");
	console.log("  · 「事件」型请填 event_key（wa_cmd:tasks 等），WeAgent 已内置接收处理");
	console.log("  · 配好后聊天输入 / 或点输入框左侧菜单键即可弹出\n");
}
