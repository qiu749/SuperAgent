import { readFileSync } from "node:fs";

/** 运行配置：.env → 环境变量 → 默认值（SPEC §2/§3 与 .env.example 对应）。 */

function loadDotEnv(): void {
	// 零依赖 .env 解析（KEY=VALUE，# 注释，容忍引号）。
	try {
		const raw = readFileSync(".env", "utf8");
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq <= 0) continue;
			const key = t.slice(0, eq).trim();
			let value = t.slice(eq + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!(key in process.env)) process.env[key] = value;
		}
	} catch {
		// 无 .env 时静默（CI/测试环境）。
	}
}
loadDotEnv();

const int = (key: string, dflt: number): number => {
	const v = process.env[key];
	if (!v) return dflt;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : dflt;
};
const bool = (key: string, dflt: boolean): boolean => {
	const v = process.env[key];
	if (v === undefined || v === "") return dflt;
	return v === "1" || v === "true" || v === "yes";
};

export interface Config {
	port: number;
	dataDir: string;
	appDbPath: string;
	piDbPath: string;
	mem0Dir: string;

	// 飞书（长连接接入，可选；配置即启用，优先于企微回调）
	feishu: {
		appId: string;
		appSecret: string;
		enabled: boolean;
	};

	// 共享白名单（企微=UserID，飞书=open_id；空数组+dryRun=本地调试全放行）
	allowedUsers: string[];

	// 企微
	wecom: {
		corpId: string;
		agentId: number;
		secret: string;
		token: string;
		aesKey: string;
		/** 白名单用户 UserID；空数组表示本地调试模式（不校验、不发真实消息）。 */
		allowedUsers: string[];
		/** 无企微凭据时的本地调试模式：回调可用、出站只打日志。 */
		dryRun: boolean;
	};

	// 入站门控
	acceptMode: "off" | "observe" | "auto";
	approveExpiryMinutes: number;

	// 模型
	deepseekApiKey: string;
	/** deepseek（生产）或 faux（本地调试/测试）。 */
	modelProvider: string;
	routerModel: string;
	workerModel: string;

	// 并发
	maxWorkers: number;

	// 记忆
	mem0Mode: "oss" | "cloud" | "off";
	mem0ApiKey: string;
	embeddingBaseUrl: string;
	embeddingApiKey: string;
	embeddingModel: string;

	// 沙箱与外部
	sandboxImage: string;
	mcpConfigPath: string;
	logLevel: string;

	// v1.0 M6：语音 ASR（OpenAI 兼容 /v1/audio/transcriptions，如硅基流动 SenseVoiceSmall）与 ffmpeg
	asr: { baseUrl: string; apiKey: string; model: string };
	ffmpegPath: string;

	// v1.0 M8：批量摘要卡时点（工作日，"HH:MM" 逗号分隔）与信任放权阈值
	digestTimes: string[];
	trustAutoThreshold: number;

	// v1.0 M9：持久化浏览器与编码子 Agent
	browserProfilesDir: string;
	playwrightExecutablePath: string;
	/** 仓库配置：{ "repo-key": { path, prepare } }，prepare 缺省用 git worktree 模板。 */
	repos: Record<string, { path: string; prepare?: string }>;

	// v1.0 M10：H5 面板会话签名密钥与对外可达基址（ digest 卡/远程协助链接用）
	panelSecret: string;
	panelBaseUrl: string;

	// v3.0：Computer Use / 多模型成本治理 / CDP 直连
	visionModel: string;
	dailyCostLimitUsd: number;
	maxTaskCostUsd: number;
	browserCdpUrl: string;
	computerDriver: "macos-native" | "xvfb-docker" | "mock";
	/** 主动传感器 Webhook HMAC-SHA256 密钥（空 = 不校验签名，仅限内网调试）。 */
	sensorWebhookSecret: string;
}

export function loadConfig(): Config {
	const dataDir = process.env.DATA_DIR || "./data";
	const corpId = process.env.WECOM_CORP_ID || "";
	const secret = process.env.WECOM_SECRET || "";
	const mode = (process.env.ACCEPT_MODE || "observe").toLowerCase();
	const mem0ModeRaw = (process.env.MEM0_MODE || "oss").toLowerCase();

	const allowedUsers = (process.env.ALLOWED_USERS || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const feishuAppId = process.env.FEISHU_APP_ID || "";
	const feishuAppSecret = process.env.FEISHU_APP_SECRET || "";

	const cfg: Config = {
		port: int("PORT", 8000),
		allowedUsers,
		dataDir,
		appDbPath: `${dataDir}/app.sqlite`,
		piDbPath: `${dataDir}/pi.sqlite`,
		mem0Dir: `${dataDir}/mem0`,
		feishu: {
			appId: feishuAppId,
			appSecret: feishuAppSecret,
			enabled: !!(feishuAppId && feishuAppSecret),
		},
		wecom: {
			corpId,
			agentId: int("WECOM_AGENT_ID", 1000002),
			secret,
			token: process.env.WECOM_TOKEN || "",
			aesKey: process.env.WECOM_AES_KEY || "",
			allowedUsers,
			dryRun: !(corpId && secret) || isPlaceholder(corpId) || isPlaceholder(secret) || isPlaceholder(process.env.WECOM_AES_KEY || ""),
		},
		acceptMode: mode === "off" || mode === "auto" ? (mode as "off" | "auto") : "observe",
		approveExpiryMinutes: int("APPROVE_EXPIRY_MINUTES", 24 * 60),
		deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
		modelProvider: hasKey(process.env.DEEPSEEK_API_KEY) ? "deepseek" : process.env.LLM_PROVIDER || "faux",
		routerModel: process.env.ROUTER_MODEL || "deepseek-flash",
		workerModel: process.env.WORKER_MODEL || "deepseek-v4-pro",
		maxWorkers: Math.max(1, int("MAX_WORKERS", 3)),
		mem0Mode: mem0ModeRaw === "cloud" || mem0ModeRaw === "off" ? (mem0ModeRaw as "cloud" | "off") : "oss",
		mem0ApiKey: process.env.MEM0_API_KEY || "",
		embeddingBaseUrl: process.env.EMBEDDING_BASE_URL || "",
		embeddingApiKey: process.env.EMBEDDING_API_KEY || "",
		embeddingModel: process.env.EMBEDDING_MODEL || "BAAI/bge-m3",
		sandboxImage: process.env.SANDBOX_IMAGE || "weagent-sandbox:latest",
		mcpConfigPath: process.env.MCP_CONFIG || "./mcp.yaml",
		logLevel: process.env.LOG_LEVEL || "info",
		asr: {
			baseUrl: process.env.ASR_BASE_URL || "",
			apiKey: process.env.ASR_API_KEY || "",
			model: process.env.ASR_MODEL || "FunAudioLLM/SenseVoiceSmall",
		},
		ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
		digestTimes: (process.env.DIGEST_TIMES || "10:00,17:00")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => /^\d{1,2}:\d{2}$/.test(s)),
		trustAutoThreshold: Math.max(2, int("TRUST_AUTO_THRESHOLD", 10)),
		browserProfilesDir: process.env.BROWSER_PROFILES_DIR || `${dataDir}/browser-profiles`,
		playwrightExecutablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "",
		repos: parseRepos(process.env.REPOS),
		panelSecret: process.env.PANEL_SECRET || "weagent-panel-dev-secret",
		panelBaseUrl: (process.env.PANEL_BASE_URL || `http://localhost:${int("PORT", 8000)}`).replace(/\/$/, ""),
		visionModel: process.env.VISION_MODEL || "qwen-vl-max",
		dailyCostLimitUsd: Number.parseFloat(process.env.DAILY_COST_LIMIT_USD || "8.0") || 8.0,
		maxTaskCostUsd: Number.parseFloat(process.env.MAX_TASK_COST_USD || "1.5") || 1.5,
		browserCdpUrl: process.env.BROWSER_CDP_URL || "",
		computerDriver: (process.env.COMPUTER_DRIVER as Config["computerDriver"]) || "macos-native",
		sensorWebhookSecret: process.env.SENSOR_WEBHOOK_SECRET || "",
	};
	return cfg;
}

/** REPOS 环境变量：JSON {"key": {"path": "/abs/path", "prepare": "optional shell"}}；坏 JSON 静默忽略。 */
function parseRepos(raw: string | undefined): Record<string, { path: string; prepare?: string }> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as Record<string, { path?: string; prepare?: string }>;
		const out: Record<string, { path: string; prepare?: string }> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (value?.path) out[key] = { path: value.path, prepare: value.prepare };
		}
		return out;
	} catch {
		return {};
	}
}

/** 是否为可运行大模型（缺 key 时走 faux，供本地调试与测试）。 */
export function hasLlm(cfg: Config): boolean {
	return cfg.deepseekApiKey.length > 0;
}

function hasKey(v: string | undefined): boolean {
	return !!v && v.length > 0;
}

/** 企微占位值（.env.example 默认值）不算已配置。 */
function isPlaceholder(v: string): boolean {
	return /xxxx|your_|^\s*$/.test(v);
}
