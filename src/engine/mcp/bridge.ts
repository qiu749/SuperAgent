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
	/** 允许直接执行、不转审批草稿的工具列表（适合 Computer Use 等多步交互工具）。 */
	direct?: string[];
	/** 强制转审批草稿的工具列表（优先级高于 direct 与 readOnlyHint）。 */
	requireApproval?: string[];
	/** 是否使用全局桌面互斥锁串行化调用，并替代内置 legacy computer_action。 */
	desktopMutex?: boolean;
};

type McpConfigFile = {
	servers?: McpServerConfig[];
};

type ServerEntry = {
	config: McpServerConfig;
	client: McpClient;
	toolNames: string[];
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
				this.servers.push({ config: server, client, toolNames: [] });
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

	/** 是否已成功接入外部桌面控制 MCP（接入后自动替代内置 legacy computer_action）。 */
	hasDesktopTools(): boolean {
		return this.servers.some((s) => s.config.desktopMutex === true || s.config.name === "computer-use" || s.config.name === "computer_use");
	}

	/** 供面板展示已连接的 MCP 服务与工具数量。 */
	summary(): { name: string; toolCount: number; tools: string[]; desktopMutex: boolean }[] {
		return this.servers.map((s) => ({
			name: s.config.name,
			toolCount: s.toolNames.length,
			tools: s.toolNames,
			desktopMutex: s.config.desktopMutex === true,
		}));
	}

	/** 供 ActionExecutor 在草稿批准后调用。 */
	async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const entry = this.servers.find((s) => s.config.name === serverName);
		if (!entry) return { ok: false, error: `MCP server ${serverName} 未连接` };
		const exec = () => entry.client.callTool(toolName, args);
		const result = entry.config.desktopMutex && this.hostRef ? await this.hostRef.withDesktopLock(null, exec) : await exec();
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
				entry.toolNames = [];
				for (const t of list) {
					if (entry.config.allow && !entry.config.allow.includes(t.name)) continue;
					entry.toolNames.push(t.name);
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
		const forcedApproval = entry.config.requireApproval?.includes(tool.name) === true;
		const readOnly = tool.annotations?.readOnlyHint === true;
		const directAllowed = !forcedApproval && (readOnly || entry.config.direct?.includes(tool.name) === true);
		const actionType = `mcp:${entry.config.name}:${tool.name}`;
		const define = defineTool;
		return define({
			name: safeName,
			description: `[MCP ${entry.config.name}/${tool.name}]${directAllowed ? "（直接执行）" : "（不可逆：调用会生成审批草稿，批准后由宿主机执行）"} ${tool.description ?? ""}`.trim(),
			parameters: (tool.inputSchema as never) ?? obj({ input: unknownSchema({ description: "工具参数" }) }),
			replay: readOnly ? "safe" : "unsafe",
			execute: async (args, api, context) => {
				if (directAllowed) {
					const host = this.hostRef;
					const wc = host ? await host.workerContext(api.conversationId) : undefined;
					const exec = () => entry.client.callTool(tool.name, args as Record<string, unknown>);
					const result = entry.config.desktopMutex && host ? await host.withDesktopLock(wc?.taskId ?? null, exec) : await exec();
					const content = toLlmContent(result);
					const output = content.map((c) => {
						if (c.type === "image") {
							return { type: "image" as const, data: c.data, mimeType: c.mimeType };
						}
						return { type: "text" as const, text: c.text };
					});
					if (entry.config.desktopMutex && host) {
						const firstImg = content.find((c): c is { type: "image"; data: string; mimeType: string } => c.type === "image");
						void host
							.recordMcpDesktopFrame({
								conversationId: api.conversationId,
								toolName: tool.name,
								args: (args as Record<string, unknown>) ?? {},
								imageBase64: firstImg?.data,
								mimeType: firstImg?.mimeType,
							})
							.catch(() => {});
					}
					return {
						isError: result.isError,
						output: output.length > 0 ? output : [{ type: "text" as const, text: "(空返回)" }],
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
