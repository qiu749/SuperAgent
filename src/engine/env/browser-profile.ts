/**
 * 持久化浏览器登录池（SPEC-v2 §9.1 M9）：
 * - 每用户专属 Profile 目录 launchPersistentContext，Cookie/LocalStorage 长期复用（扫码一次，长期可用）；
 * - request_browser_login 交互闭环：截图发企微/飞书 → 用户扫码/登录 → 卡片【我已登录完成】或
 *   远程协助页（/browser-assist/:token，HMAC 签名 5 分钟 TTL）转发点击与键盘输入 → 唤醒 Worker。
 * Playwright 二进制缺失时抛出带修复指引的错误（优雅降级，不影响其他任务）。
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Config } from "../../config.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "browser-profile" });

/** 浏览器会话（每用户一个，惰性创建，进程生命周期内复用）。 */
export type BrowserSession = {
	userId: string;
	// playwright-core 类型在此文件外不可靠（引擎层唯一依赖点），用结构化最小接口
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	context: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	page: any;
};

export class BrowserPool {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private pw: any = null;
	private readonly sessions = new Map<string, BrowserSession>();

	constructor(private readonly cfg: Config) {}

	/** 解析 Chromium 可执行文件：显式配置 → ms-playwright 缓存探测。 */
	resolveExecutable(): string {
		if (this.cfg.playwrightExecutablePath && existsSync(this.cfg.playwrightExecutablePath)) {
			return this.cfg.playwrightExecutablePath;
		}
		const candidates = [
			join(process.env.HOME ?? "", "Library/Caches/ms-playwright"),
			join(process.env.HOME ?? "", ".cache/ms-playwright"),
		];
		for (const dir of candidates) {
			if (!existsSync(dir)) continue;
			for (const entry of readdirSync(dir)) {
				if (!entry.startsWith("chromium")) continue;
				// 兼容多种官方缓存布局：
				// chromium-<build>/chrome-mac[-arm64]/Chromium.app/Contents/MacOS/Chromium（完整版）
				// chromium_headless_shell-<build>/chrome-headless-shell-mac-arm64/chrome-headless-shell（无头 shell）
				for (const sub of ["chrome-mac-arm64", "chrome-mac", "chrome-headless-shell-mac-arm64"]) {
					for (const name of [
						"Chromium.app/Contents/MacOS/Chromium",
						"chrome-headless-shell",
						"headless_shell",
					]) {
						const p = join(dir, entry, sub, name);
						if (existsSync(p)) return p;
					}
				}
			}
		}
		throw new Error(
			"未找到 Chromium 浏览器。请设置 PLAYWRIGHT_EXECUTABLE_PATH，或在项目内执行 `npm i playwright && npx playwright install chromium` 安装浏览器后重试。",
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async playwright(): Promise<any> {
		if (!this.pw) {
			this.pw = await import("playwright-core");
		}
		return this.pw;
	}

	/** 取（或创建）用户的持久化浏览器会话（支持 BROWSER_CDP_URL 直连宿主机已登录浏览器）。 */
	async session(userId: string): Promise<BrowserSession> {
		const existing = this.sessions.get(userId);
		if (existing) return existing;
		const pw = await this.playwright();
		if (this.cfg.browserCdpUrl) {
			const browser = await pw.chromium.connectOverCDP(this.cfg.browserCdpUrl);
			const context = browser.contexts()[0] ?? (await browser.newContext());
			const page = context.pages()[0] ?? (await context.newPage());
			const session: BrowserSession = { userId, context, page };
			this.sessions.set(userId, session);
			log.info({ userId, cdpUrl: this.cfg.browserCdpUrl }, "已通过 CDP WebBridge 复用本地已登录浏览器");
			return session;
		}
		const executablePath = this.resolveExecutable();
		const dir = join(this.cfg.browserProfilesDir, userId.replace(/[^\w.-]/g, "_"));
		mkdirSync(dir, { recursive: true });
		const context = await pw.chromium.launchPersistentContext(dir, {
			executablePath,
			headless: true,
			viewport: { width: 390, height: 844 }, // 手机比例，便于远程协助页操作
			args: ["--no-sandbox"],
		});
		const page = context.pages()[0] ?? (await context.newPage());
		const session: BrowserSession = { userId, context, page };
		this.sessions.set(userId, session);
		log.info({ userId, dir }, "持久化浏览器会话已创建");
		return session;
	}

	async navigate(userId: string, url: string): Promise<BrowserSession> {
		const s = await this.session(userId);
		await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
		return s;
	}

	async screenshot(userId: string): Promise<Buffer> {
		const s = await this.session(userId);
		return Buffer.from(await s.page.screenshot({ type: "png" }));
	}

	async click(userId: string, x: number, y: number): Promise<void> {
		const s = await this.session(userId);
		await s.page.mouse.click(x, y);
	}

	async type(userId: string, text: string): Promise<void> {
		const s = await this.session(userId);
		await s.page.keyboard.type(text, { delay: 30 });
	}

	async press(userId: string, key: string): Promise<void> {
		const s = await this.session(userId);
		await s.page.keyboard.press(key);
	}

	/** 关闭某用户会话（Profile 已持久化到磁盘，Cookie 下次仍在）。 */
	async close(userId: string): Promise<void> {
		const s = this.sessions.get(userId);
		if (!s) return;
		this.sessions.delete(userId);
		await s.context.close().catch(() => {});
	}

	async closeAll(): Promise<void> {
		for (const userId of [...this.sessions.keys()]) await this.close(userId);
	}
}

// ---------- 一次性远程协助 Token（HMAC 签名，5 分钟 TTL，SPEC-v2 §9.1 模式 B） ----------

export type AssistClaims = { userId: string; taskId: number; exp: number };

export class AssistTokens {
	constructor(private readonly secret: string) {}

	sign(claims: AssistClaims): string {
		const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
		const sig = createHmac("sha256", this.secret).update(body).digest("base64url");
		return `${body}.${sig}`;
	}

	verify(token: string): AssistClaims | null {
		const [body, sig] = token.split(".");
		if (!body || !sig) return null;
		const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
		const a = Buffer.from(sig);
		const b = Buffer.from(expected);
		if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
		try {
			const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AssistClaims;
			if (claims.exp < Date.now()) return null;
			return claims;
		} catch {
			return null;
		}
	}

	newToken(userId: string, taskId: number, ttlMs = 5 * 60_000): string {
		return this.sign({ userId, taskId, exp: Date.now() + ttlMs });
	}
}

export function newAssistId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 16);
}
