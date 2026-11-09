/**
 * 分词计数与 IM 文本限制（SPEC §5/§8）。
 * 中文按字/词计、英文按词计，与 dsh-superagent 的 wordCount 语义一致（Intl.Segmenter word-like 段）。
 */

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

/** 切词：CJK 字逐字成词，拉丁词按段。 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	for (const segment of segmenter.segment(text)) {
		if (!segment.isWordLike) continue;
		if (CJK_RE.test(segment.segment)) tokens.push(...segment.segment.split(""));
		else tokens.push(segment.segment);
	}
	return tokens;
}

/** 词数（中文按字计、英文按词计；标点与空白不计）。 */
export function wordCount(text: string): number {
	return tokenize(text).length;
}

export const NOTE_WORDS = 30; // Router 路由注记上限（SPEC §5）
export const ACK_WORDS = 50; // 接单回执上限（SPEC §5）
export const IM_WORDS = 100; // 普通聊天消息上限（SPEC §8）

/** 校验路由注记 ≤ 30 词；返回错误文案，合法返回 undefined。 */
export function checkNoteWords(text: string): string | undefined {
	const count = wordCount(text);
	if (count > NOTE_WORDS) {
		return `note 超过 ${NOTE_WORDS} 词（当前 ${count} 词）。只允许路由背景或跨任务约束，请压缩；不要拆成多条。`;
	}
	return undefined;
}

/** 校验接单回执 ≤ 50 词。 */
export function checkAckWords(text: string): string | undefined {
	const count = wordCount(text);
	if (count > ACK_WORDS) {
		return `acknowledgement 超过 ${ACK_WORDS} 词（当前 ${count} 词）。请一句话讲清处理对象与预期产出。`;
	}
	return undefined;
}

/** 校验普通 IM 消息 ≤ 100 词；长内容必须写文件作为附件发送。 */
export function checkImWords(text: string): string | undefined {
	const count = wordCount(text);
	if (count > IM_WORDS) {
		return `IM 消息 ${count} 词，超过 ${IM_WORDS} 词硬上限。请只发一句话结论，详细内容写入 .md 文件后作为附件发送；不要拆成多条消息刷屏。`;
	}
	return undefined;
}

/** 截断到指定词数以内（用于报告摘要首行等兜底场景）。 */
export function truncateWords(text: string, maxWords: number): string {
	const toks = tokenize(text).slice(0, maxWords);
	let out = "";
	let prevLatin = false;
	for (const t of toks) {
		const latin = /[A-Za-z0-9]/.test(t[0] ?? "");
		if (out && latin && prevLatin) out += " ";
		out += t;
		prevLatin = latin;
	}
	return out.trim();
}
