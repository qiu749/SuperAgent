/**
 * 企业微信消息卡片 JSON 模板（SPEC §3/§7）：审批卡片、追问卡片。
 * 按钮事件回调携带 task_id / response_code（一次性），由 ActionExecutor 消费。
 */

export type CardButton = {
	key: string;
	name: string;
};

/** 审批卡片（button_interaction）：批准 / 拒绝 / 修改。 */
export function approvalCard(opts: {
	approvalId: string;
	taskId: number;
	title: string;
	actionType: string;
	preview: string;
	buttons?: CardButton[];
}): Record<string, unknown> {
	const buttons: CardButton[] = opts.buttons ?? [
		{ key: `ap:${opts.approvalId}:approve`, name: "批准" },
		{ key: `ap:${opts.approvalId}:reject`, name: "拒绝" },
		{ key: `ap:${opts.approvalId}:edit`, name: "修改" },
	];
	return {
		msgtype: "template_card",
		agentid: undefined, // 由 client 统一填 agentid
		template_card: {
			card_type: "button_interaction",
			source: {
				icon_url: "",
				desc: `任务 #${opts.taskId}`,
			},
			main_title: {
				title: `待审批 #${opts.approvalId}：${opts.title}`,
			},
			emphasize_content: {
				title: opts.actionType,
				desc: opts.preview.slice(0, 400),
			},
			sub_title_text: opts.preview.slice(0, 800),
			horizontal_content_list: [
				{ keyname: "任务", value: `#${opts.taskId}` },
				{ keyname: "动作", value: opts.actionType },
				{ keyname: "编号", value: opts.approvalId },
			],
			button_list: buttons.map((b, i) => ({
				text: b.name,
				style: i === 0 ? "primary" : "default",
				key: b.key,
			})),
			task_id: `weagent_ap_${opts.approvalId}`,
		},
	};
}

/** 追问卡片：一次只问一个具体问题，带可选快捷选项。 */
export function askCard(opts: { askId: string; taskId: number; question: string; options?: string[] }): Record<string, unknown> {
	const buttons: CardButton[] = [
		...(opts.options ?? []).slice(0, 3).map((opt, i) => ({ key: `ask:${opts.askId}:${i}`, name: opt })),
	];
	return {
		msgtype: "template_card",
		agentid: undefined,
		template_card: {
			card_type: "button_interaction",
			source: { icon_url: "", desc: `任务 #${opts.taskId} 需要你的输入` },
			main_title: { title: "需要你拍板" },
			sub_title_text: opts.question.slice(0, 800),
			horizontal_content_list: [
				{ keyname: "任务", value: `#${opts.taskId}` },
				{ keyname: "追问", value: opts.askId },
			],
			button_list: buttons.map((b, i) => ({
				text: b.name,
				style: i === 0 ? "primary" : "default",
				key: b.key,
			})),
			task_id: `weagent_ask_${opts.askId}`,
		},
	};
}

/** 卡片状态更新后的替换文本。 */
export function cardUpdateText(status: string): string {
	switch (status) {
		case "approved":
			return "已批准并执行 ✅";
		case "rejected":
			return "已拒绝 ❌";
		case "expired":
			return "已过期 ⏰";
		case "pending_edit":
			return "请直接在下方输入修改意见 ✏️";
		case "answered":
			return "已收到你的回答 ✅";
		default:
			return status;
	}
}

// ========== v1.0 M8：信任放权与批量摘要卡 ==========

/**
 * auto_notify 事后轻量通知卡（SPEC-v2 §7.2）：动作已被放权自动执行，
 * 底部带一键后悔药【撤回自动放权】。
 */
export function notifyCard(opts: { approvalId: string; actionType: string; scopeKey: string; encodedPolicy: string; preview: string; execSummary: string }): Record<string, unknown> {
	return {
		msgtype: "template_card",
		agentid: undefined,
		template_card: {
			card_type: "button_interaction",
			source: { icon_url: "", desc: "自动放权执行" },
			main_title: { title: `已自动执行 ${opts.actionType}（无需审批）` },
			sub_title_text: opts.execSummary.slice(0, 800),
			horizontal_content_list: [
				{ keyname: "动作", value: opts.actionType },
				{ keyname: "范围", value: opts.scopeKey },
				{ keyname: "编号", value: opts.approvalId },
			],
			button_list: [
				{
					text: "撤回自动放权（以后仍需我审批）",
					style: "default",
					key: `trust:${opts.encodedPolicy}:downgrade`,
				},
			],
			task_id: `weagent_notify_${opts.approvalId}`,
		},
	};
}

/** 达到连续批准阈值后的升级询问卡（SPEC-v2 §7.2）。 */
export function trustUpgradeCard(opts: { encodedPolicy: string; actionType: string; scopeKey: string; count: number }): Record<string, unknown> {
	return {
		msgtype: "template_card",
		agentid: undefined,
		template_card: {
			card_type: "button_interaction",
			source: { icon_url: "", desc: "渐进放权" },
			main_title: { title: `你已连续 ${opts.count} 次直接批准该类动作` },
			sub_title_text: `${opts.actionType} @ ${opts.scopeKey}：是否升级为自动执行并事后通知？随时可在面板或通知卡里撤回。`,
			button_list: [
				{ text: "升级为自动执行", style: "primary", key: `trust:${opts.encodedPolicy}:upgrade` },
				{ text: "保持每次审批", style: "default", key: `trust:${opts.encodedPolicy}:keep` },
			],
			task_id: `weagent_trust_${opts.encodedPolicy.slice(0, 24)}`,
		},
	};
}

/**
 * 早晚报批量摘要卡（SPEC-v2 §7.3）：列出前 5 条预览 + 总数，
 * 一键全部批准，或打开 H5 待办面板逐条处理。
 */
export function digestCard(opts: { encodedBatch: string; items: { approvalId: string; actionType: string; preview: string }[]; total: number; panelUrl?: string }): Record<string, unknown> {
	const lines = opts.items
		.slice(0, 5)
		.map((it) => ({ keyname: it.approvalId, value: `${it.actionType}：${it.preview.slice(0, 60)}` }));
	return {
		msgtype: "template_card",
		agentid: undefined,
		template_card: {
			card_type: "button_interaction",
			source: { icon_url: "", desc: "批量摘要" },
			main_title: { title: `待拍板草稿（${opts.total} 条）` },
			sub_title_text: "这些动作已按你的设置进入批量摘要池，未自动执行。",
			horizontal_content_list: lines,
			button_list: [
				{ text: `一键全部批准 (${opts.total} 条)`, style: "primary", key: `digest:${opts.encodedBatch}:approve_all` },
				// url 型按钮（type=1）直接打开 H5 待办面板
				...(opts.panelUrl ? [{ text: "打开待办面板逐条处理", style: "default", type: 1, url: opts.panelUrl }] : []),
			],
			task_id: `weagent_digest_${opts.encodedBatch.slice(0, 24)}`,
		},
	};
}

/** 浏览器登录协助卡（SPEC-v2 §9.1）：截图已单独发图；完成点按钮，或打开远程协助页。 */
export function browserLoginCard(opts: { token: string; siteName: string; assistUrl: string }): Record<string, unknown> {
	return {
		msgtype: "template_card",
		agentid: undefined,
		template_card: {
			card_type: "button_interaction",
			source: { icon_url: "", desc: "登录协助" },
			main_title: { title: `需要你登录 ${opts.siteName}` },
			sub_title_text: "上面已发送登录页面截图：可直接扫码/登录；或打开远程协助页代点代输（5 分钟内有效）。",
			button_list: [
				{ text: "我已登录完成", style: "primary", key: `br:${opts.token}:done` },
				...(opts.assistUrl ? [{ text: "打开远程协助页", style: "default", type: 1, url: opts.assistUrl }] : []),
			],
			task_id: `weagent_br_${opts.token.slice(0, 24)}`,
		},
	};
}
