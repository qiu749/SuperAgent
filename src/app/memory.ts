/**
 * Mem0 长期记忆封装（SPEC §10）：
 * - 自动读：search Top 10 注入 System Prompt（section "user-memory"）；
 * - 主动工具：remember / recall / forget；
 * - 防投毒：只允许用户亲口说的话、显式 remember、以及 worker_report(ready) 结论写入库；
 *   外部网页/邮件/Webhook 内容严禁写入。
 *
 * 三种模式：oss（mem0ai/oss 本地）、cloud（MemoryClient）、off（无凭据时的 no-op）。
 */
import { mkdirSync } from "node:fs";
import pino from "pino";
import type { Config } from "../config.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "memory" });

export type MemoryItem = { id: string; memory: string; score?: number };

export interface MemoryStore {
	add(userId: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
	search(userId: string, query: string, topK?: number): Promise<MemoryItem[]>;
	getAll(userId: string): Promise<MemoryItem[]>;
	delete(memoryId: string): Promise<void>;
}

/** 无凭据 / off 模式：会话级内存存储（无持久化，进程重启即失），让 /memory 与 H5 面板在本地调试时仍可用。 */
class NullMemory implements MemoryStore {
	private readonly items = new Map<string, { id: string; memory: string; userId: string }>();

	async add(userId: string, memory: string): Promise<void> {
		this.items.set(`${userId}:${this.items.size}`, { id: `mem_${Math.random().toString(36).slice(2, 10)}`, memory, userId });
	}
	private byUser(userId: string) {
		return [...this.items.values()].filter((i) => i.userId === userId);
	}
	async search(userId: string, query: string, topK: number): Promise<MemoryItem[]> {
		const q = query.toLowerCase();
		return this.byUser(userId)
			.filter((i) => !q || i.memory.toLowerCase().includes(q))
			.slice(0, topK)
			.map((i) => ({ id: i.id, memory: i.memory }));
	}
	async getAll(userId: string): Promise<MemoryItem[]> {
		return this.byUser(userId).map((i) => ({ id: i.id, memory: i.memory }));
	}
	async delete(id: string): Promise<void> {
		for (const [key, item] of this.items) {
			if (item.id === id) this.items.delete(key);
		}
	}
}

/** OSS 本地模式（mem0ai/oss）：OpenAI 兼容 embedder + 本地向量库。 */
async function createOssMemory(cfg: Config): Promise<MemoryStore> {
	const { Memory } = await import("mem0ai/oss");
	mkdirSync(cfg.mem0Dir, { recursive: true }); // mem0 的本地 sqlite（向量库/历史库）需要父目录已存在
	const config: Record<string, unknown> = {
		version: "v1.1",
		embedder: {
			provider: "openai",
			config: {
				baseURL: cfg.embeddingBaseUrl || undefined,
				apiKey: cfg.embeddingApiKey || process.env.OPENAI_API_KEY || "",
				model: cfg.embeddingModel,
			},
		},
		vectorStore: {
			provider: "memory",
			config: { collectionName: "weagent", dbPath: `${cfg.mem0Dir}/vectors.db` },
		},
		llm: {
			// 跟随 DEEPSEEK_BASE_URL（DeepSeek 官方或任意 OpenAI 兼容中转），提炼模型用轻量的 Router 模型
			provider: "openai",
			config: {
				baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
				apiKey: cfg.deepseekApiKey,
				model: cfg.routerModel,
			},
		},
		historyDbPath: `${cfg.mem0Dir}/history.db`,

	};
	const memory = new Memory(config as never);
	return {
		async add(userId, text, metadata) {
			await memory.add(text, { userId, metadata, infer: true });
		},
		async search(userId, query, topK = 10) {
			const res = (await memory.search(query, { topK, filters: { user_id: userId } })) as {
				results?: { id: string; memory: string; score?: number }[];
			};
			return (res.results ?? []).map((r) => ({ id: r.id, memory: r.memory, score: r.score }));
		},
		async getAll(userId) {
			const res = (await memory.getAll({ filters: { user_id: userId } })) as {
				results?: { id: string; memory: string; score?: number }[];
			};
			return (res.results ?? []).map((r) => ({ id: r.id, memory: r.memory, score: r.score }));
		},
		async delete(memoryId) {
			await memory.delete(memoryId);
		},
	};
}

/** 云端模式（MemoryClient）。 */
async function createCloudMemory(cfg: Config): Promise<MemoryStore> {
	const { MemoryClient } = await import("mem0ai");
	const client = new MemoryClient({ apiKey: cfg.mem0ApiKey });
	return {
		async add(userId, text, metadata) {
			await client.add([{ role: "user", content: text }], { userId, metadata });
		},
		async search(userId, query, topK = 10) {
			const res = await client.search(query, { filters: { user_id: userId }, topK });
			return (res.results ?? []).map((m) => ({
				id: String(m.id),
				memory: String(m.memory ?? ""),
				score: m.score,
			}));
		},
		async getAll(userId) {
			const res = await client.getAll({ filters: { user_id: userId } });
			return (res.results ?? []).map((m) => ({ id: String(m.id), memory: String(m.memory ?? "") }));
		},
		async delete(memoryId) {
			await client.delete(memoryId);
		},
	};
}

export class Memory {
	store: MemoryStore;
	private ready: Promise<void>;

	constructor(cfg: Config) {
		this.store = new NullMemory();
		// init 期间的所有读写都排队等它完成，避免启动头几秒静默落入 no-op
		this.ready = this.init(cfg).catch((err) => log.error({ err }, "Mem0 初始化失败，记忆功能降级为 no-op"));
	}

	private async init(cfg: Config): Promise<void> {
		if (cfg.mem0Mode === "off") {
			log.info("Mem0 关闭（MEM0_MODE=off）");
			return;
		}
		if (cfg.mem0Mode === "cloud") {
			if (!cfg.mem0ApiKey) {
				log.warn("MEM0_MODE=cloud 但缺少 MEM0_API_KEY，记忆功能降级为 no-op");
				return;
			}
			this.store = await createCloudMemory(cfg);
		} else {
			if (!cfg.embeddingApiKey && !process.env.OPENAI_API_KEY) {
				log.warn("Mem0 oss 模式缺少 EMBEDDING_API_KEY/OPENAI_API_KEY，记忆功能降级为 no-op");
				return;
			}
			this.store = await createOssMemory(cfg);
		}
		log.info({ mode: cfg.mem0Mode }, "Mem0 就绪");
	}

	/**
	 * 防投毒入口（SPEC §10）：只允许四个来源写入。
	 * - `user`：用户在 Router 里亲口说的话；
	 * - `explicit`：显式 remember 工具调用；
	 * - `report`：worker_report(ready) 的最终结论；
	 * - `habit`：审批【修改】Diff 提炼的习惯（v1.0 M7，宿主机侧生成，非外部内容）。
	 * 其他来源（网页、邮件、Webhook 外部内容）一律拒绝。
	 */
	async addTrusted(userId: string, text: string, source: "user" | "explicit" | "report" | "habit", metadata?: Record<string, unknown>): Promise<void> {
		await this.ready;
		const clean = text.trim();
		if (!clean) return;
		if (clean.length > 4000) {
			log.warn({ userId }, "记忆写入过长被拒绝");
			return;
		}
		try {
			await this.store.add(userId, clean, { source, ...metadata });
			log.info({ userId, source }, "记忆已写入");
		} catch (err) {
			// 记忆提炼失败（如上游 LLM 抖动）绝不能阻塞业务收尾路径
			log.warn({ userId, source, err: err instanceof Error ? err.message : String(err) }, "Mem0 写入失败（已忽略，不影响业务）");
		}
	}

	async search(userId: string, query: string, topK = 10): Promise<MemoryItem[]> {
		await this.ready;
		return this.store.search(userId, query, topK);
	}

	async listAll(userId: string): Promise<MemoryItem[]> {
		await this.ready;
		return this.store.getAll(userId);
	}

	async forget(userId: string, memoryId: string): Promise<boolean> {
		const all = await this.store.getAll(userId);
		if (!all.some((m) => m.id === memoryId)) return false;
		await this.store.delete(memoryId);
		return true;
	}
}
