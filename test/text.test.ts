import { describe, expect, it } from "vitest";
import { checkAckWords, checkImWords, checkNoteWords, truncateWords, wordCount } from "../src/util/text.ts";
import { renderTaskCards } from "../src/app/tasks.ts";

describe("wordCount（中英混合分词计数）", () => {
	it("英文按词计", () => {
		expect(wordCount("hello world foo")).toBe(3);
	});

	it("中文按字计（更严格的上界）", () => {
		expect(wordCount("收到，开始调研邮件生态")).toBe(10);
	});

	it("中英混合", () => {
		expect(wordCount("调研 MCP 生态")).toBe(5);
	});

	it("标点与空白不计", () => {
		expect(wordCount("好的，收到！")).toBe(4);
	});
});

describe("限额校验（SPEC §5/§8）", () => {
	it("路由注记 30 词上限", () => {
		const ok = "仅作背景：该客户昨天也提过类似需求"; // 短
		expect(checkNoteWords(ok)).toBeUndefined();
		const long = Array.from({ length: 31 }, (_, i) => `词${i}`).join("");
		expect(checkNoteWords(long)).toMatch(/30 词/);
	});

	it("回执 50 词上限", () => {
		expect(checkAckWords("收到，开始调研 MCP 邮件生态并整理对比表")).toBeUndefined();
		const long = "长".repeat(51);
		expect(checkAckWords(long)).toMatch(/50 词/);
	});

	it("IM 消息 100 词上限", () => {
		expect(checkImWords("任务完成，报告见附件")).toBeUndefined();
		const long = Array.from({ length: 101 }, () => "词").join("");
		expect(checkImWords(long)).toMatch(/100 词/);
	});
});

describe("truncateWords", () => {
	it("按词截断", () => {
		expect(truncateWords("hello world foo bar", 2)).toBe("hello world");
	});
});

describe("renderTaskCards（保留完整汇报结尾与相对时间，防 Router 上下文断片）", () => {
	it("完整保留 ≤220 字汇报与标点（如结尾『需要暂停、搜索或切换内容随时说。』）", () => {
		const card = renderTaskCards([
			{
				id: 5,
				user_id: "u1",
				origin_trigger_id: "t1",
				title: "在Mac上打开抖音",
				routing_note: "",
				conv_id: "100",
				latest_sub_id: null,
				stage: "ready",
				latest_report: JSON.stringify({
					state: "ready",
					summary: "已在 Mac 上打开抖音客户端，当前已切到前台，正在播放一条足球战术分析的视频（@金戈足球战术，08:19/09:30）。需要暂停、搜索或切换内容随时说。",
				}),
				budget: "medium",
				created_at: Date.now() - 35_000,
				updated_at: Date.now() - 30_000,
				parent_task_id: null,
				forked_at_seq: null,
			},
		]);
		expect(card).toContain("需要暂停、搜索或切换内容随时说。");
		expect(card).toContain("秒前更新");
	});
});
