/**
 * MCP 桥（SPEC §13 engine/mcp/bridge.ts）：@earendil-works/pi-mcp 客户端 →
 * pi-durable ToolRegistration 桥接。只读工具（readOnlyHint）直接执行（replay safe）；
 * 不可逆工具自动转草稿：调用时生成 propose_action 审批（action_type = mcp:<server>:<tool>），
 * 用户批准后由 ActionExecutor 经 bridge.callTool 真正执行。
 */
import { existsSync, readFileSync } from "node:fs";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, unknown as unknownSchema } from "@earendil-works/pi-schema";
import pino from "pino";
import type { Config } from "../../config.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "mcp-bridge" });

export type McpServerConfig = {
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	headers?: Record<string, string>;
	/** 只透传这些工具（省略 = 全部）。 */
	allow?: string[];
};

type McpConfigFile = {
	servers?: McpServerConfig[];
};

type ServerEntry = {
	config: McpServerConfig;
	client: McpClient;
};

export class McpBridge {
	private readonly servers: ServerEntry[] = [];
	extension: Extension | null = null;

	constructor(private readonly cfg: Config) {}

	async start(): Promise<void> {
		const path = this.cfg.mcpConfigPath;
		if (!path || !existsSync(path)) {
			log.info("未配置 MCP（mcp 配置文件不存在），跳过");
			return;
		}
		let file: McpConfigFile;
		try {
			if (path.endsWith(".yaml") || path.endsWith(".yml")) {
				const yaml = await import("js-yaml");
				file = yaml.load(readFileSync(path, "utf8")) as McpConfigFile;
			} else {
				file = JSON.parse(readFileSync(path, "utf8")) as McpConfigFile;
			}
		} catch (err) {
			log.error({ path, err }, "MCP 配置解析失败");
			return;
		}
		for (const server of file.servers ?? []) {
			try {
				const client = new McpClient({ name: "weagent", version: "0.4.0" });
				if (server.url) {
					await client.connect(new StreamableHttpTransport({ url: server.url, headers: server.headers }));
				} else if (server.command) {
					await client.connect(new StdioTransport({ command: server.command, args: server.args ?? [] }));
				} else {
					continue;
				}
				this.servers.push({ config: server, client });
				log.info({ server: server.name }, "MCP server 已连接");
			} catch (err) {
				log.error({ server: server.name, err }, "MCP server 连接失败（跳过）");
			}
		}
		this.extension = await this.buildExtension();
	}

	async stop(): Promise<void> {
		await Promise.allSettled(this.servers.map((s) => s.client.close()));
	}

	/** 供 ActionExecutor 在草稿批准后调用。 */
	async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const entry = this.servers.find((s) => s.config.name === serverName);
		if (!entry) return { ok: false, error: `MCP server ${serverName} 未连接` };
		const result = await entry.client.callTool(toolName, args);
		const content = toLlmContent(result);
		const text = content
			.filter((c) => c.type === "text")
			.map((c) => (c as { text: string }).text)
			.join("\n");
		return { ok: !result.isError, text, structured: result.structuredContent ?? null };
	}

	private async buildExtension(): Promise<Extension> {
		const tools: ToolRegistration[] = [];
		for (const entry of this.servers) {
			try {
				const list = await entry.client.listTools();
				for (const t of list) {
					if (entry.config.allow && !entry.config.allow.includes(t.name)) continue;
					tools.push(this.bridgeTool(entry, t));
				}
			} catch (err) {
				log.error({ server: entry.config.name, err }, "列出 MCP 工具失败");
			}
		}
		return defineExtension({ name: MCP_EXTENSION_NAME, tools });
	}

	private bridgeTool(entry: ServerEntry, tool: { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): ToolRegistration {
		const safeName = `mcp_${entry.config.name}_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
		const readOnly = tool.annotations?.readOnlyHint === true;
		const actionType = `mcp:${entry.config.name}:${tool.name}`;
		const define = defineTool;
		return define({
			name: safeName,
			description: `[MCP ${entry.config.name}/${tool.name}]${readOnly ? "（只读，直接执行）" : "（不可逆：调用会生成审批草稿，批准后由宿主机执行）"} ${tool.description ?? ""}`.trim(),
			parameters: (tool.inputSchema as never) ?? obj({ input: unknownSchema({ description: "工具参数" }) }),
			replay: readOnly ? "safe" : "unsafe",
			execute: async (args, api, context) => {
				if (readOnly) {
					const result = await entry.client.callTool(tool.name, args as Record<string, unknown>);
					const content = toLlmContent(result);
					return {
						isError: result.isError,
						output: content.map((c) => (c.type === "text" ? { type: "text" as const, text: c.text } : { type: "text" as const, text: "[图片]" })),
					};
				}
				// 不可逆 → 自动转草稿（SPEC §13 mcp/bridge.ts）
				const host = this.hostRef;
				if (!host) return { isError: true, output: [{ type: "text", text: "宿主未就绪，无法生成审批草稿。" }] };
				const wc = await host.workerContext(api.conversationId);
				if (!wc) return { isError: true, output: [{ type: "text", text: "MCP 写操作只能在任务 Worker 会话中调用。" }] };
				const preview = `MCP ${entry.config.name}/${tool.name}：${JSON.stringify(args).slice(0, 300)}`;
				const draft = await host.proposeAction({ conversationId: api.conversationId, actionType, payload: args as Record<string, unknown>, preview, isFinal: true }, context);
				return {
					output: [{ type: "text", text: `已生成审批草稿 ${draft.approvalId}（MCP ${entry.config.name}/${tool.name}）。本轮结束，等待用户批准后由宿主机执行。` }],
				};
			},
		});
	}

	/** 由 engine/harness 注入。 */
	hostRef: import("../host.ts").WeAgentHost | null = null;
}

export const MCP_EXTENSION_NAME = "weagent-mcp";
