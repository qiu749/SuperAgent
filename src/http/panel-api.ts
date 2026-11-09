/**
 * H5 待办中心 API（SPEC-v2 §10 M10）：企微 OAuth 免登 + HMAC 会话 Cookie；
 * overview（待拍板置顶）、草稿拍板（可原地改 payload）、批量批准、任务轨迹（读 pi.sqlite）、
 * 记忆/习惯/技能管理、信任放权策略、Observe 影子日志与一键补建。
 * 设计哲学（005-panel.md）：先列"等人拍板的事"，健康态零占位。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import pino from "pino";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { WeAgentCore } from "../app/core.ts";
import type { TrustMode } from "../app/trust-policy.ts";
import { trajectoryAndV3Routes } from "./trajectory-api.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "panel-api" });

const COOKIE = "wa_panel";

function signSession(secret: string, userId: string): string {
	const body = Buffer.from(userId, "utf8").toString("base64url");
	return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function verifySession(secret: string, value: string | undefined): string | null {
	if (!value) return null;
	const [body, sig] = value.split(".");
	if (!body || !sig) return null;
	const expected = createHmac("sha256", secret).update(body).digest("base64url");
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	return Buffer.from(body, "base64url").toString("utf8");
}

export function panelRoutes(core: WeAgentCore): Hono<{ Variables: { panelUser: string } }> {
	const app = new Hono<{ Variables: { panelUser: string } }>();

	// ---------- 免登（企微 OAuth2；dryRun 下 dev 免登） ----------

	app.get("/api/panel/auth", async (c) => {
		const q = c.req.query();
		let userId: string | null = null;
		if (core.cfg.wecom.dryRun) {
			// 本地调试：无真实 OAuth，dev_user 或首个白名单用户
			userId = q.dev_user || core.cfg.allowedUsers[0] || "dev";
		} else if (q.code) {
			try {
				const client = core.messenger as import("../wecom/client.ts").WeComClient;
				const token = await client.accessToken();
				const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(q.code)}`);
				const body = (await res.json()) as { userid?: string; errcode?: number };
				userId = body.userid ?? null;
			} catch (err) {
				log.warn({ err }, "企微 OAuth 免登失败");
			}
		}
		if (!userId) {
			// 浏览器直接访问时给出可见的失败页（而不是白屏/裸 JSON）
			if ((c.req.header("accept") ?? "").includes("text/html")) {
				return c.html(`<!doctype html><meta charset="utf-8"><body style="font:15px -apple-system,sans-serif;padding:40px">登录失败：未获取到企微 OAuth code。<a href="/panel">返回面板重试</a></body>`, 401);
			}
			return c.json({ error: "unauthorized" }, 401);
		}
		await core.ensureUser(userId);
		const cookie = signSession(core.cfg.panelSecret, userId);
		// 登录成功：种下会话 Cookie 后必须跳回面板（否则用户会停在空响应页上）
		return c.body(null, 303, {
			"set-cookie": `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
			location: q.redirect || "/panel",
		});
	});

	// ---------- 会话校验（其余 /api/panel/* 全部需要） ----------

	app.use("/api/panel/*", async (c, next) => {
		if (c.req.path === "/api/panel/auth") return next();
		const userId = verifySession(core.cfg.panelSecret, c.req.header("cookie")?.split(";").map((s) => s.trim().split("=")).find(([k]) => k === COOKIE)?.[1]);
		if (!userId) return c.json({ error: "unauthorized" }, 401);
		c.set("panelUser", userId);
		await next();
	});

	// ---------- Overview（置顶：等人拍板的事） ----------

	app.get("/api/panel/overview", async (c) => {
		const userId = c.get("panelUser") as string;
		const tasks = await core.db.selectFrom("tasks").where("user_id", "=", userId).selectAll().execute();
		const taskIds = new Set(tasks.map((t) => t.id));
		const approvals = (await core.db.selectFrom("approvals").where("status", "in", ["pending", "pending_digest"]).selectAll().execute())
			.filter((a) => taskIds.has(a.task_id))
			.map((a) => ({
				id: a.id,
				taskId: a.task_id,
				taskTitle: tasks.find((t) => t.id === a.task_id)?.title ?? "",
				actionType: a.action_type,
				scopeKey: a.scope_key,
				urgency: a.urgency,
				status: a.status,
				preview: a.preview,
				payload: JSON.parse(a.payload) as unknown,
				createdAt: a.created_at,
			}));
		const asks = (await core.db.selectFrom("asks").where("status", "=", "pending").selectAll().execute())
			.filter((k) => taskIds.has(k.task_id))
			.map((k) => ({ id: k.id, taskId: k.task_id, question: k.question, options: k.options ? (JSON.parse(k.options) as string[]) : [] }));
		return c.json({
			pendingApprovals: approvals,
			pendingAsks: asks,
			healthProblems: core.outbox.healthAlerts,
			workerSlots: { ...core.slots.stats, used: core.slots.usedSlots, capacity: core.cfg.maxWorkers },
			acceptMode: core.cfg.acceptMode,
			digestCount: approvals.filter((a) => a.status === "pending_digest").length,
		});
	});

	// ---------- 拍板（可原地改 payload 后批准） ----------

	app.post("/api/panel/approvals/:id/decide", async (c) => {
		const id = c.req.param("id");
		const body = (await c.req.json().catch(() => ({}))) as { action?: string; payload?: Record<string, unknown> };
		const action = body.action ?? "approve";
		if (body.payload) {
			const row = await core.db.selectFrom("approvals").where("id", "=", id).selectAll().executeTakeFirst();
			if (!row) return c.json({ error: "not_found" }, 404);
			if (!["pending", "pending_digest"].includes(row.status)) return c.json({ error: `已处理过（${row.status}）` }, 409);
			await core.db.updateTable("approvals").set({ payload: JSON.stringify(body.payload) }).where("id", "=", id).execute();
			// 面板上原地改过参数 = 一次修改（习惯提炼同样适用）
			await core.db.updateTable("approvals").set({ user_edit_feedback: row.user_edit_feedback ?? "（面板上修改了参数）" }).where("id", "=", id).execute();
		}
		const r = await core.actions.onCardEvent(`ap:${id}:${action}`);
		return c.json(r);
	});

	app.post("/api/panel/approvals/batch-approve", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
		const ids = body.ids ?? [];
		const results: { id: string; message: string }[] = [];
		for (const id of ids) {
			const r = await core.actions.onCardEvent(`ap:${id}:approve`);
			results.push({ id, message: r.message });
		}
		return c.json({ results });
	});

	// ---------- 任务与轨迹 ----------

	app.get("/api/panel/tasks", async (c) => {
		const userId = c.get("panelUser") as string;
		const rows = await core.db.selectFrom("tasks").where("user_id", "=", userId).orderBy("updated_at", "desc").limit(50).selectAll().execute();
		return c.json(rows.map((t) => ({ ...t, latest_report: t.latest_report ? JSON.parse(t.latest_report) : null })));
	});

	app.get("/api/panel/tasks/:id/transcript", async (c) => {
		const userId = c.get("panelUser") as string;
		const taskId = Number.parseInt(c.req.param("id"), 10);
		const task = await core.db.selectFrom("tasks").where("id", "=", taskId).where("user_id", "=", userId).selectAll().executeTakeFirst();
		if (!task) return c.json({ error: "not_found" }, 404);
		return c.json(renderTranscript(core.cfg.piDbPath, task.conv_id));
	});

	/** 面板重试（复用 retry:{taskId} 按钮通道）。 */
	app.post("/api/panel/tasks/:id/retry", async (c) => {
		const taskId = Number.parseInt(c.req.param("id"), 10);
		const task = await core.db.selectFrom("tasks").where("id", "=", taskId).selectAll().executeTakeFirst();
		if (!task || task.user_id !== (c.get("panelUser") as string)) return c.json({ error: "not_found" }, 404);
		const r = await core.actions.onCardEvent(`retry:${taskId}`);
		return c.json(r);
	});

	/** 面板停止（对齐 /stop 斜杠命令语义）。 */
	app.post("/api/panel/tasks/:id/stop", async (c) => {
		const userId = c.get("panelUser") as string;
		const taskId = Number.parseInt(c.req.param("id"), 10);
		const task = await core.db.selectFrom("tasks").where("id", "=", taskId).where("user_id", "=", userId).selectAll().executeTakeFirst();
		if (!task) return c.json({ error: "not_found" }, 404);
		await core.db.updateTable("tasks").set({ stage: "cancelled", updated_at: Date.now() }).where("id", "=", taskId).execute();
		const conv = await core.harness.conversation(Number(task.conv_id) as never, BACKGROUND_CONTEXT);
		if (conv) void conv.abort(BACKGROUND_CONTEXT).catch(() => {});
		return c.json({ ok: true, message: `已停止任务 #${taskId}` });
	});

	/** 面板回答追问（复用 ask:{id}:{i} 按钮通道）。 */
	app.post("/api/panel/asks/:id/answer", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { optionIndex?: number };
		const r = await core.actions.onCardEvent(`ask:${c.req.param("id")}:${body.optionIndex ?? 0}`);
		return c.json(r);
	});

	// ---------- 记忆 / 习惯 / 技能 ----------

	app.get("/api/panel/memories", async (c) => {
		const userId = c.get("panelUser") as string;
		const [memories, habits, skills] = await Promise.all([
			core.memoryList(userId),
			core.db.selectFrom("learned_habits").where("user_id", "=", userId).orderBy("created_at", "desc").limit(50).selectAll().execute(),
			core.db.selectFrom("skills").orderBy("created_at", "desc").limit(100).selectAll().execute(),
		]);
		return c.json({
			memories,
			habits: habits.map((h) => ({ id: h.id, actionType: h.action_type, rule: h.rule_text, enabled: h.enabled === 1, createdAt: h.created_at })),
			skills: skills.map((s) => ({ slug: s.slug, description: s.description, status: s.status, filePath: s.file_path })),
		});
	});

	app.post("/api/panel/memories", async (c) => {
		const userId = c.get("panelUser") as string;
		const body = (await c.req.json().catch(() => ({}))) as { text?: string };
		if (!body.text?.trim()) return c.json({ error: "text required" }, 400);
		await core.memory.addTrusted(userId, body.text.trim(), "explicit");
		return c.json({ ok: true });
	});

	app.delete("/api/panel/memories/:id", async (c) => {
		const userId = c.get("panelUser") as string;
		const ok = await core.memory.forget(userId, c.req.param("id"));
		return c.json({ ok }, ok ? 200 : 404);
	});

	// ---------- 信任放权 ----------

	app.get("/api/panel/trust-policies", async (c) => {
		const userId = c.get("panelUser") as string;
		return c.json(await core.trust.listByUser(userId));
	});

	app.patch("/api/panel/trust-policies", async (c) => {
		const userId = c.get("panelUser") as string;
		const body = (await c.req.json().catch(() => ({}))) as { id?: string; mode?: TrustMode };
		if (!body.id || !body.mode || !["always_ask", "digest", "auto_notify"].includes(body.mode)) {
			return c.json({ error: "id 与 mode（always_ask|digest|auto_notify）必填" }, 400);
		}
		const policy = await core.db.selectFrom("trust_policies").where("id", "=", body.id).where("user_id", "=", userId).selectAll().executeTakeFirst();
		if (!policy) return c.json({ error: "not_found" }, 404);
		await core.trust.setMode(policy.user_id, policy.action_type, policy.scope_key, body.mode);
		return c.json({ ok: true });
	});

	// ---------- Observe 影子日志 ----------

	app.get("/api/panel/observe", async (c) => {
		const userId = c.get("panelUser") as string;
		const wouldAccept = await core.db.selectFrom("decisions").where("kind", "=", "would_accept").orderBy("created_at", "desc").limit(50).selectAll().execute();
		const triggerIds = wouldAccept.map((d) => d.trigger_id);
		const triggers = triggerIds.length > 0 ? await core.db.selectFrom("triggers").where("id", "in", triggerIds).selectAll().execute() : [];
		return c.json({
			acceptMode: core.cfg.acceptMode,
			wouldAccept: wouldAccept.map((d) => {
				const t = triggers.find((x) => x.id === d.trigger_id);
				return {
					decisionId: d.id,
					triggerId: d.trigger_id,
					reason: d.reason,
					createdAt: d.created_at,
					text: t ? (JSON.parse(t.payload) as { text: string }).text : "",
					alreadyAccepted: !!t?.disposition,
				};
			}),
		});
	});

	app.patch("/api/panel/observe", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { acceptMode?: string };
		if (!body.acceptMode || !["off", "observe", "auto"].includes(body.acceptMode)) return c.json({ error: "acceptMode 必填（off|observe|auto）" }, 400);
		core.cfg.acceptMode = body.acceptMode as "off" | "observe" | "auto";
		return c.json({ ok: true, acceptMode: core.cfg.acceptMode });
	});

	/** 一键补建任务：把 would_accept 影子决策真正建单。 */
	app.post("/api/panel/observe/:triggerId/promote", async (c) => {
		const triggerId = c.req.param("triggerId");
		const trigger = await core.getTrigger(triggerId);
		if (!trigger) return c.json({ error: "not_found" }, 404);
		const existing = await core.db.selectFrom("tasks").where("origin_trigger_id", "=", triggerId).selectAll().executeTakeFirst();
		if (existing) return c.json({ ok: true, taskId: existing.id, message: "任务已存在" });
		const text = (JSON.parse(trigger.payload) as { text: string }).text;
		const r = await core.routeAccept(triggerId, text.slice(0, 40) || "补建任务", "已从影子日志补建任务，开始处理", "panel promote", "medium", [], BACKGROUND_CONTEXT as Context, true);
		return c.json({ ok: true, message: r.observation });
	});

	// ---------- v3.0 轨迹时光机、知识库、技能遥测、成本账单与主动传感器 ----------
	app.route("/", trajectoryAndV3Routes(core));

	return app;
}

// ---------- 静态页（web/index.html，无构建步骤） ----------

export function panelStaticRoutes(): Hono {
	const app = new Hono();
	app.get("/panel", async (c) => {
		try {
			const { fileURLToPath } = await import("node:url");
			const html = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../../web/index.html", import.meta.url)), "utf8");
			return c.html(html);
		} catch {
			return c.text("面板前端缺失（web/index.html）", 500);
		}
	});
	app.get("/", (c) => c.redirect("/panel"));
	return app;
}

// ---------- pi.sqlite 轨迹渲染 ----------

export function renderTranscript(piDbPath: string, convId: string): { lines: { role: string; text: string; tool?: string; ts?: number }[] } {
	const lines: { role: string; text: string; tool?: string; ts?: number }[] = [];
	let store: DatabaseSync;
	try {
		store = new DatabaseSync(piDbPath, { readOnly: true });
	} catch {
		return { lines: [{ role: "system", text: "pi.sqlite 无法读取" }] };
	}
	try {
		const rows = store.prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id ASC").all(Number(convId)) as { record: string }[];
		for (const row of rows) {
			let rec: { kind?: string; model?: { role?: string; content?: unknown; toolName?: string; timestamp?: number }[] };
			try {
				rec = JSON.parse(row.record);
			} catch {
				continue;
			}
			for (const m of rec.model ?? []) {
				const ts = typeof m.timestamp === "number" ? m.timestamp : undefined;
				const text = extractText(m.content);
				if (m.role === "user" && text) lines.push({ role: "user", text: text.slice(0, 2000), ts });
				else if (m.role === "assistant" && text) lines.push({ role: "assistant", text: text.slice(0, 2000), ts });
				else if (m.role === "toolResult") {
					lines.push({ role: "tool", tool: m.toolName ?? "tool", text: text.slice(0, 400), ts });
				}
			}
		}
	} finally {
		store.close();
	}
	return { lines };
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: string; text?: string } => typeof c === "object" && c !== null)
			.map((c) => ("text" in c ? String(c.text) : ""))
			.join(" ")
			.trim();
	}
	return "";
}
