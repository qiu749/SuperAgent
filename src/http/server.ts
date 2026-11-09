/**
 * HTTP 网关（SPEC §3/§13）：企微回调（验签/解密/入库/立即 200）、webhook 接入、
 * 健康面板、本地调试接口（模拟用户消息与卡片点击）。
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pino from "pino";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { WeAgentCore } from "../app/core.ts";
import { decrypt, verifySignature } from "../wecom/crypto.ts";
import { handleWecomCallback } from "../wecom/callback.ts";
import { browserAssistRoutes } from "./browser-assist.ts";
import { computerAssistRoutes } from "./computer-assist.ts";
import { panelRoutes, panelStaticRoutes } from "./panel-api.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "http" });

export function createHttpServer(core: WeAgentCore) {
	const app = new Hono();

	// ---------- 浏览器/桌面远程协助（v1.0 M9 / v3.0 §2.4）与 H5 待办面板（v1.0 M10） ----------
	app.route("/", browserAssistRoutes(core));
	app.route("/", computerAssistRoutes(core));
	app.route("/", panelRoutes(core));
	app.route("/", panelStaticRoutes());

	// ---------- 企微回调（SPEC §3） ----------

	app.get("/wecom/callback", async (c) => {
		const q = c.req.query();
		const msg = q.msg_signature && q.timestamp && q.nonce && q.echostr
			? (() => {
					if (!verifySignature(core.cfg.wecom.token, q.timestamp, q.nonce, q.echostr, q.msg_signature)) return null;
					try {
						return decrypt(core.cfg.wecom.aesKey, q.echostr).message;
					} catch {
						return null;
					}
				})()
			: q.echostr ?? "";
		// 验证失败返回空串（企微会重试）
		return c.text(msg ?? "");
	});

	app.post("/wecom/callback", async (c) => {
		const q = c.req.query();
		const bodyText = await c.req.text();
		await handleWecomCallback(core, bodyText, q);
		// 立即返回空串（后续全部异步处理，SPEC §3）
		return c.text("");
	});

	// ---------- 外部 Webhook（inferred，SPEC §4.1） ----------

	app.post("/webhook/:source", async (c) => {
		const source = c.req.param("source");
		const body = (await c.req.json().catch(() => ({}))) as { event_id?: string; user_id?: string; text?: string };
		if (!body.text) return c.json({ error: "text required" }, 400);
		const userId = body.user_id || core.cfg.allowedUsers[0] || "owner";
		await core.dispatcher.onWebhook(source, body.event_id || `wh-${Date.now()}`, userId, body.text);
		return c.json({ ok: true });
	});

	// ---------- 健康面板 ----------

	app.get("/health", (c) =>
		c.json({
			ok: true,
			acceptMode: core.cfg.acceptMode,
			dryRun: core.cfg.wecom.dryRun,
			slots: core.slots.stats,
			usedSlots: core.slots.usedSlots,
			outboxAlerts: core.outbox.healthAlerts,
		}),
	);

	app.get("/debug/tasks", async (c) => {
		const rows = await core.db.selectFrom("tasks").orderBy("updated_at", "desc").limit(50).selectAll().execute();
		return c.json(rows.map((t) => ({ ...t, latest_report: t.latest_report ? JSON.parse(t.latest_report) : null })));
	});

	app.get("/debug/outbox", async (c) => {
		const rows = await core.db.selectFrom("outbox").orderBy("id", "desc").limit(50).selectAll().execute();
		return c.json(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })));
	});

	// ---------- 本地调试 ----------

	app.post("/debug/message", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { user_id?: string; text?: string; msg_id?: string };
		if (!body.text) return c.json({ error: "text required" }, 400);
		const userId = body.user_id || core.cfg.allowedUsers[0] || "debug";
		await core.dispatcher.onUserText(userId, body.text, body.msg_id ?? `debug-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		return c.json({ ok: true });
	});

	app.post("/debug/card", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { key?: string; response_code?: string };
		if (!body.key) return c.json({ error: "key required" }, 400);
		const r = await core.actions.onCardEvent(body.key, body.response_code);
		return c.json(r);
	});

	const server = serve({ fetch: app.fetch, port: core.cfg.port });
	log.info({ port: core.cfg.port }, "HTTP 网关已启动");
	return { server, app };
}

export function startHttp(core: WeAgentCore, ctx: Context = BACKGROUND_CONTEXT) {
	void ctx;
	return createHttpServer(core);
}
