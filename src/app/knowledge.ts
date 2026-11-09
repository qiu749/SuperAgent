/**
 * 个人本地混合知识库（Local Hybrid RAG，SPEC-v3 §3.2 M10）：
 * - 纯 SQLite 单文件闭环（kb_documents + kb_chunks），零外部重型向量库依赖；
 * - 按 Markdown 标题层级与段落边界智能切分（目标 400~800 字符，重叠 80 字符），按文件 sha256 增量幂等更新；
 * - RRF（Reciprocal Rank Fusion）混合检索：
 *   路 A：中英文二元/三元字符 N-gram + 词项 BM25 全文检索（对专有名词、单号、函数名极准）；
 *   路 B：余弦相似度向量检索（支持外部 Embedding 或本地确定性哈希特征向量）；
 *   Score_RRF(d) = 1 / (60 + rank_bm25(d)) + 1 / (60 + rank_vec(d))。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Kysely } from "kysely";
import type { Db } from "./db.ts";

export type KbChunkHit = {
	chunkId: number;
	docId: number;
	docTitle: string;
	sourcePath: string;
	chunkIndex: number;
	headingPath: string;
	content: string;
	rrfScore: number;
	bm25Rank?: number;
	vecRank?: number;
};

export type ChunkItem = {
	chunkIndex: number;
	headingPath: string;
	content: string;
};

const TARGET_CHUNK_CHARS = 550;
const OVERLAP_CHARS = 80;
const RRF_K = 60;

/** 按 Markdown 标题层级（# / ## / ###）与自然段切分文档，保留章节路径。 */
export function chunkMarkdownDocument(rawText: string, maxChars = TARGET_CHUNK_CHARS): ChunkItem[] {
	const lines = rawText.replace(/\r\n/g, "\n").split("\n");
	const sections: { headingPath: string; body: string }[] = [];
	const headingStack: { level: number; text: string }[] = [];
	let currentLines: string[] = [];

	const currentHeadingPath = () => headingStack.map((h) => h.text).join(" > ");

	const flushSection = () => {
		const body = currentLines.join("\n").trim();
		if (body.length > 0) {
			sections.push({ headingPath: currentHeadingPath(), body });
		}
		currentLines = [];
	};

	for (const line of lines) {
		const m = /^(#{1,4})\s+(.+)$/.exec(line.trim());
		if (m) {
			flushSection();
			const level = m[1]!.length;
			const title = m[2]!.trim();
			while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
				headingStack.pop();
			}
			headingStack.push({ level, text: title });
			currentLines.push(line);
		} else {
			currentLines.push(line);
		}
	}
	flushSection();

	const chunks: ChunkItem[] = [];
	let idx = 0;
	for (const sec of sections) {
		if (sec.body.length <= maxChars) {
			chunks.push({ chunkIndex: idx++, headingPath: sec.headingPath, content: sec.body });
			continue;
		}
		let pos = 0;
		while (pos < sec.body.length) {
			const end = Math.min(sec.body.length, pos + maxChars);
			const slice = sec.body.slice(pos, end).trim();
			if (slice) {
				chunks.push({ chunkIndex: idx++, headingPath: sec.headingPath, content: slice });
			}
			if (end >= sec.body.length) break;
			pos = Math.max(pos + 1, end - OVERLAP_CHARS);
		}
	}
	return chunks;
}

/**
 * 计算文本的 64 维归一化语义特征向量（支持中英文词根/字符二元组 Feature Hashing，
 * 当未配置远程 Embedding API 时提供零外部依赖的确定性余弦检索）。
 */
export function computeLocalEmbedding(text: string, dims = 64): number[] {
	const vec = new Float64Array(dims);
	const tokens = extractTokensAndGrams(text);
	for (const tok of tokens) {
		let h = 2166136261;
		for (let i = 0; i < tok.length; i++) {
			h ^= tok.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		const bucket = Math.abs(h) % dims;
		const sign = (h & 1) === 0 ? 1 : -1;
		vec[bucket] += sign;
	}
	let norm = 0;
	for (let i = 0; i < dims; i++) norm += vec[i]! * vec[i]!;
	norm = Math.sqrt(norm) || 1;
	return Array.from(vec, (v) => Number((v / norm).toFixed(5)));
}

export function cosineSimilarity(a: number[], b: number[]): number {
	const len = Math.min(a.length, b.length);
	if (len === 0) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < len; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	return dot / (Math.sqrt(na * nb) || 1);
}

/** 提取中英文词元与 CJK 二元语法（Bigrams），兼顾精确代号匹配与中文语义词组。 */
export function extractTokensAndGrams(text: string): string[] {
	const lower = text.toLowerCase();
	const out: string[] = [];
	for (const m of lower.matchAll(/[a-z0-9_.-]{2,}/g)) {
		out.push(m[0]);
	}
	const cjkRuns = lower.match(/[\u4e00-\u9fa5]+/g) ?? [];
	for (const run of cjkRuns) {
		if (run.length === 1) {
			out.push(run);
		} else {
			for (let i = 0; i < run.length - 1; i++) {
				out.push(run.slice(i, i + 2));
			}
		}
	}
	return out;
}

export class KnowledgeBase {
	constructor(private readonly db: Kysely<Db>) {}

	/**
	 * 入库或增量更新一篇文档（按 sha256 幂等：内容未变直接跳过重写）。
	 */
	async ingestText(input: {
		sourcePath: string;
		title: string;
		content: string;
		mimeType?: string;
	}): Promise<{ docId: number; chunkCount: number; updated: boolean }> {
		const sha256 = createHash("sha256").update(input.content, "utf8").digest("hex");
		const existing = await this.db
			.selectFrom("kb_documents")
			.where("source_path", "=", input.sourcePath)
			.selectAll()
			.executeTakeFirst();
		if (existing && existing.sha256 === sha256) {
			return { docId: existing.id, chunkCount: existing.chunk_count, updated: false };
		}

		const chunks = chunkMarkdownDocument(input.content);
		const now = Date.now();
		let docId: number;

		if (existing) {
			docId = existing.id;
			await this.db
				.updateTable("kb_documents")
				.set({
					title: input.title,
					sha256,
					mime_type: input.mimeType ?? "text/markdown",
					chunk_count: chunks.length,
					indexed_at: now,
				})
				.where("id", "=", docId)
				.execute();
			await this.db.deleteFrom("kb_chunks").where("doc_id", "=", docId).execute();
		} else {
			await this.db
				.insertInto("kb_documents")
				.values({
					source_path: input.sourcePath,
					title: input.title,
					sha256,
					mime_type: input.mimeType ?? "text/markdown",
					chunk_count: chunks.length,
					indexed_at: now,
				})
				.execute();
			const inserted = await this.db
				.selectFrom("kb_documents")
				.where("source_path", "=", input.sourcePath)
				.selectAll()
				.executeTakeFirstOrThrow();
			docId = inserted.id;
		}

		for (const ch of chunks) {
			const emb = computeLocalEmbedding(`${input.title} ${ch.headingPath} ${ch.content}`);
			await this.db
				.insertInto("kb_chunks")
				.values({
					doc_id: docId,
					chunk_index: ch.chunkIndex,
					heading_path: ch.headingPath,
					content: ch.content,
					embedding_json: JSON.stringify(emb),
					created_at: now,
				})
				.execute();
		}

		return { docId, chunkCount: chunks.length, updated: true };
	}

	/** 从本地磁盘文件入库。 */
	async ingestFile(filePath: string, title?: string): Promise<{ docId: number; chunkCount: number; updated: boolean }> {
		if (!existsSync(filePath)) throw new Error(`知识库入库文件不存在：${filePath}`);
		const content = readFileSync(filePath, "utf8");
		const docTitle = title?.trim() || filePath.split("/").pop() || "未命名文档";
		return this.ingestText({ sourcePath: filePath, title: docTitle, content });
	}

	/**
	 * RRF（Reciprocal Rank Fusion）混合检索：
	 * 融合 BM25 关键词排名与向量余弦相似度排名。
	 */
	async search(query: string, topK = 5): Promise<KbChunkHit[]> {
		const docs = await this.db.selectFrom("kb_documents").selectAll().execute();
		if (docs.length === 0) return [];
		const docMap = new Map(docs.map((d) => [d.id, d]));
		const allChunks = await this.db.selectFrom("kb_chunks").selectAll().execute();
		if (allChunks.length === 0) return [];

		const qTokens = extractTokensAndGrams(query);
		const qEmb = computeLocalEmbedding(query);

		// 1. 计算每个 chunk 的 BM25 分数与向量余弦分数
		const avgLen = allChunks.reduce((acc, c) => acc + c.content.length, 0) / allChunks.length || 1;
		const df = new Map<string, number>();
		const chunkTokenSets = new Map<number, Map<string, number>>();

		for (const c of allChunks) {
			const toks = extractTokensAndGrams(`${c.heading_path} ${c.content}`);
			const tf = new Map<string, number>();
			for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
			chunkTokenSets.set(c.id, tf);
			for (const uniq of tf.keys()) df.set(uniq, (df.get(uniq) ?? 0) + 1);
		}

		const N = allChunks.length;
		const bm25Scores: { id: number; score: number }[] = [];
		const vecScores: { id: number; score: number }[] = [];

		for (const c of allChunks) {
			const tfMap = chunkTokenSets.get(c.id)!;
			let bm25 = 0;
			const dl = c.content.length;
			for (const qt of qTokens) {
				const f = tfMap.get(qt) ?? 0;
				if (f === 0) continue;
				const nq = df.get(qt) ?? 0;
				const idf = Math.log(1 + (N - nq + 0.5) / (nq + 0.5));
				const k1 = 1.5;
				const b = 0.75;
				bm25 += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgLen))));
			}
			// 子串直接包含加权（对专有单号/代号兜底）
			if (c.content.toLowerCase().includes(query.trim().toLowerCase())) {
				bm25 += 3.0;
			}
			bm25Scores.push({ id: c.id, score: bm25 });

			const emb = c.embedding_json ? (JSON.parse(c.embedding_json) as number[]) : [];
			const sim = emb.length > 0 ? cosineSimilarity(qEmb, emb) : 0;
			vecScores.push({ id: c.id, score: sim });
		}

		bm25Scores.sort((a, b) => b.score - a.score);
		vecScores.sort((a, b) => b.score - a.score);

		const bm25RankMap = new Map<number, number>();
		bm25Scores.forEach((item, idx) => {
			if (item.score > 0) bm25RankMap.set(item.id, idx + 1);
		});
		const vecRankMap = new Map<number, number>();
		vecScores.forEach((item, idx) => {
			if (item.score > 0) vecRankMap.set(item.id, idx + 1);
		});

		// 2. RRF 融合打分
		const scored: KbChunkHit[] = [];
		for (const c of allChunks) {
			const rBm25 = bm25RankMap.get(c.id);
			const rVec = vecRankMap.get(c.id);
			if (rBm25 === undefined && (rVec === undefined || rVec > 10)) continue;
			const scoreBm25 = rBm25 !== undefined ? 1 / (RRF_K + rBm25) : 0;
			const scoreVec = rVec !== undefined ? 1 / (RRF_K + rVec) : 0;
			const rrfScore = scoreBm25 + scoreVec;
			const doc = docMap.get(c.doc_id);
			if (!doc) continue;
			scored.push({
				chunkId: c.id,
				docId: c.doc_id,
				docTitle: doc.title,
				sourcePath: doc.source_path,
				chunkIndex: c.chunk_index,
				headingPath: c.heading_path,
				content: c.content,
				rrfScore: Number(rrfScore.toFixed(6)),
				bm25Rank: rBm25,
				vecRank: rVec,
			});
		}

		scored.sort((a, b) => b.rrfScore - a.rrfScore);
		return scored.slice(0, topK);
	}

	/** 按文档 ID 与切片范围读取完整上下文。 */
	async readDocChunks(docId: number, startChunk = 0, endChunk = 5): Promise<{ title: string; chunks: ChunkItem[] } | null> {
		const doc = await this.db.selectFrom("kb_documents").where("id", "=", docId).selectAll().executeTakeFirst();
		if (!doc) return null;
		const rows = await this.db
			.selectFrom("kb_chunks")
			.where("doc_id", "=", docId)
			.where("chunk_index", ">=", startChunk)
			.where("chunk_index", "<=", endChunk)
			.orderBy("chunk_index", "asc")
			.selectAll()
			.execute();
		return {
			title: doc.title,
			chunks: rows.map((r) => ({ chunkIndex: r.chunk_index, headingPath: r.heading_path, content: r.content })),
		};
	}

	async listDocuments() {
		return this.db.selectFrom("kb_documents").orderBy("indexed_at", "desc").selectAll().execute();
	}
}
