/**
 * 个人本地混合知识库扩展（SPEC-v3 §3.2 M10）：
 * - kb_search：BM25 + 向量余弦 RRF 混合检索个人文档库；
 * - kb_read_doc：按需读取指定文档相邻切片上下文；
 * - kb_ingest_file：把工作区或收件箱文件索引入库。
 */
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { WeAgentHost } from "../host.ts";

export const KNOWLEDGE_EXTENSION_NAME = "weagent-knowledge";

export function createKnowledgeExtension(host: WeAgentHost) {
	const kbSearch = defineTool({
		name: "kb_search",
		description: "在个人本地混合知识库（Hybrid RAG：BM25 关键词 + 语义向量 RRF 融合）中检索相关文档切片。",
		parameters: obj({
			query: str({ description: "检索关键词或自然语言问题", minLength: 1, maxLength: 400 }),
			top_k: opt(num({ description: "返回条数（默认 5，最大 15）" })),
		}),
		replay: "safe",
		execute: async (args) => {
			const hits = await host.kbSearch(args.query, Math.min(15, Math.max(1, args.top_k ?? 5)));
			if (hits.length === 0) return { output: [{ type: "text", text: "（本地知识库未命中相关内容）" }] };
			const formatted = hits
				.map(
					(h, i) =>
						`[${i + 1}] 文档 #${h.docId}《${h.docTitle}》(${h.headingPath || "正文"}, chunk #${h.chunkIndex}, RRF=${h.rrfScore})\n${h.content}`,
				)
				.join("\n\n---\n\n");
			return { output: [{ type: "text", text: formatted }] };
		},
	});

	const kbReadDoc = defineTool({
		name: "kb_read_doc",
		description: "按文档 ID 与起止 chunk 序号展开读取个人知识库中某篇文档的连续段落。",
		parameters: obj({
			doc_id: num({ description: "kb_search 返回的文档 ID (docId)" }),
			start_chunk: opt(num({ description: "起始切片序号（默认 0）" })),
			end_chunk: opt(num({ description: "结束切片序号（默认 5）" })),
		}),
		replay: "safe",
		execute: async (args) => {
			const res = await host.kbReadDoc(args.doc_id, args.start_chunk ?? 0, args.end_chunk ?? 5);
			if (!res) return { isError: true, output: [{ type: "text", text: `文档 #${args.doc_id} 不存在` }] };
			const text = [
				`# 《${res.title}》`,
				...res.chunks.map((c) => `## [Chunk #${c.chunkIndex}] ${c.headingPath}\n${c.content}`),
			].join("\n\n");
			return { output: [{ type: "text", text }] };
		},
	});

	const kbIngestFile = defineTool({
		name: "kb_ingest_file",
		description: "将本地文件（如用户刚发来的 Markdown/TXT/CSV 文档）切片并索引进个人本地知识库（按 sha256 增量去重）。",
		parameters: obj({
			file_path: str({ description: "文件绝对路径或相对于任务工作目录的路径", minLength: 1, maxLength: 500 }),
			title: opt(str({ description: "文档标题（省略则用文件名）", maxLength: 200 })),
		}),
		replay: "safe",
		execute: async (args, api) => {
			try {
				const r = await host.kbIngestFile(api.conversationId, args.file_path, args.title);
				return { output: [{ type: "text", text: r.observation }] };
			} catch (err) {
				return { isError: true, output: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
			}
		},
	});

	return defineExtension({
		name: KNOWLEDGE_EXTENSION_NAME,
		tools: [kbSearch, kbReadDoc, kbIngestFile],
	});
}
