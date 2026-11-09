/**
 * H5 轨迹时光机、知识库、技能遥测、成本账单与主动传感器 API 路由（SPEC-v3 §5.3 M12）。
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { WeAgentCore } from "../app/core.ts";

export function trajectoryAndV3Routes(core: WeAgentCore): Hono {
	const app = new Hono();

	// ---------- 1. 主动感知网关 Webhook（公开入站，支持 sensorId；配置 SENSOR_WEBHOOK_SECRET 时强制 HMAC-SHA256 验签） ----------

	app.post("/webhooks/sensor/:sensorId", async (c) => {
		const sensorId = c.req.param("sensorId");
		const rawBody = await c.req.text();
		const secret = core.cfg.sensorWebhookSecret;
		if (secret) {
			const provided = c.req.header("x-weagent-signature") ?? c.req.header("x-signature") ?? "";
			const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
			if (provided.replace(/^sha256=/, "") !== expected) {
				return c.json({ error: "invalid_signature" }, 401);
			}
		}
		const body = JSON.parse(rawBody || "{}") as {
			external_event_id?: string;
			user_id?: string;
			title?: string;
			summary?: string;
			urgency?: "immediate" | "digest";
			payload?: Record<string, unknown>;
		};
		if (!body.title && !body.summary) {
			return c.json({ error: "title or summary required" }, 400);
		}
		const r = await core.sensors.ingest({
			sensorId,
			externalEventId: body.external_event_id || `se_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			userId: body.user_id,
			sourceTitle: body.title || sensorId,
			summary: body.summary || body.title || "",
			suggestedUrgency: body.urgency ?? "immediate",
			payload: body.payload,
		});
		return c.json({ ok: true, ...r });
	});

	// ---------- 2. H5 轨迹时光机与任意节点 Fork 重跑 ----------

	app.get("/api/panel/tasks/:id/trajectory", async (c) => {
		const taskId = Number.parseInt(c.req.param("id"), 10);
		const bundle = await core.trajectory.getTaskTrajectory(taskId);
		if (!bundle) return c.json({ error: "not_found" }, 404);
		return c.json(bundle);
	});

	app.post("/api/panel/tasks/:id/fork", async (c) => {
		const taskId = Number.parseInt(c.req.param("id"), 10);
		const body = (await c.req.json().catch(() => ({}))) as { atSeq?: number; overridePrompt?: string };
		if (!body.overridePrompt?.trim()) {
			return c.json({ error: "overridePrompt 必填" }, 400);
		}
		try {
			const res = await core.trajectory.forkTaskFromTrajectory(taskId, {
				atSeq: body.atSeq ?? 1,
				overridePrompt: body.overridePrompt.trim(),
			});
			return c.json({ ok: true, ...res });
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	app.get("/api/panel/tasks/:id/frames/:frameName", async (c) => {
		const taskId = Number.parseInt(c.req.param("id"), 10);
		const frameName = c.req.param("frameName").replace(/[^a-zA-Z0-9._-]/g, "");
		const filePath = join(core.cfg.dataDir, "trajectories", String(taskId), "frames", frameName);
		if (!existsSync(filePath)) return c.text("frame not found", 404);
		const buf = readFileSync(filePath);
		return c.body(buf, 200, { "content-type": "image/png" });
	});

	// ---------- 3. 成本账单与传感器监控 ----------

	app.get("/api/panel/cost/summary", async (c) => {
		const [summary, sensors] = await Promise.all([
			core.modelRouter.getSummary(),
			core.sensors.listRecent(20),
		]);
		return c.json({ ...summary, recentSensors: sensors });
	});

	// ---------- 4. 技能健康度遥测与外部技能安全安装 ----------

	app.get("/api/panel/skills/telemetry", async (c) => {
		const health = await core.skillHygiene.getHealthReport();
		return c.json({ skills: health });
	});

	app.post("/api/panel/skills/install", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { name?: string; url?: string; rawMarkdown?: string };
		try {
			const r = await core.skillHygiene.installExternalSkill(body);
			return c.json({ ok: true, ...r });
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	// 一键回滚（SPEC-v3 §5.3）：回滚到该技能最近一次 ledger 记录之前的状态
	app.post("/api/panel/skills/rollback", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { name?: string };
		if (!body.name?.trim()) return c.json({ error: "name 必填" }, 400);
		try {
			const entry = core.skills.latestLedgerEntryFor(body.name.trim());
			if (!entry) return c.json({ error: `技能 ${body.name} 没有 ledger 变更记录可回滚` }, 404);
			const message = await core.skills.rollback(entry.id);
			return c.json({ ok: true, message, entryId: entry.id });
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	// ---------- 5. 本地混合知识库（Local Hybrid RAG） ----------

	app.get("/api/panel/kb/docs", async (c) => {
		const docs = await core.knowledge.listDocuments();
		return c.json({ docs });
	});

	app.post("/api/panel/kb/docs", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { title?: string; content?: string; sourcePath?: string };
		if (!body.content?.trim()) return c.json({ error: "content 必填" }, 400);
		const title = body.title?.trim() || "面板录入文档";
		const sourcePath = body.sourcePath?.trim() || `panel://${Date.now()}_${title}`;
		const r = await core.knowledge.ingestText({ sourcePath, title, content: body.content });
		return c.json({ ok: true, ...r });
	});

	app.get("/api/panel/kb/search", async (c) => {
		const q = c.req.query("q") || "";
		if (!q.trim()) return c.json({ hits: [] });
		const hits = await core.knowledge.search(q, 8);
		return c.json({ hits });
	});

	return app;
}
