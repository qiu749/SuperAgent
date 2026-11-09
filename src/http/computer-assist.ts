/**
 * 桌面远程接管页（SPEC-v3 §2.4）：/computer-assist/:token
 * 连续 3 步 aHash 无变化熔断后推送的 10 分钟签名链接：手机上轮询桌面实时截图、
 * 点按/键盘输入转发给 ComputerDriver（轮询式，无 WS 依赖），点【我已处理完成】清追问卡并唤醒 Worker。
 * 复用 browser-assist 的 HMAC AssistTokens（同 secret、5 分钟 TTL）。
 */
import { Hono } from "hono";
import pino from "pino";
import type { WeAgentCore } from "../app/core.ts";
import { logicalToPhysical, normalizePointToLogical } from "../engine/env/computer-env.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "computer-assist" });

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>WeAgent 桌面接管</title>
<style>
  body{margin:0;font:14px -apple-system,sans-serif;background:#111;color:#eee}
  #bar{padding:8px 12px;display:flex;gap:8px;align-items:center;background:#1c1c1e;position:sticky;top:0}
  button{border:0;border-radius:8px;padding:8px 14px;font-size:14px}
  .primary{background:#0a84ff;color:#fff}
  .ghost{background:#333;color:#eee}
  #stage{position:relative}
  #shot{width:100%;display:block}
  #tip{padding:8px 12px;color:#999}
  input{flex:1;border:0;border-radius:8px;padding:8px 10px;background:#2c2c2e;color:#eee}
</style></head>
<body>
<div id="bar">
  <button class="ghost" onclick="refresh()">刷新画面</button>
  <input id="kb" placeholder="代输文字后回车">
  <button class="ghost" onclick="send({op:'key',key:'Return'})">回车</button>
  <button class="primary" onclick="done()">我已处理完成</button>
</div>
<div id="stage"><img id="shot" alt="加载中…"></div>
<div id="tip">在截图上点按即转发到桌面；遇到验证码/扫码可手动处理后点完成。</div>
<script>
const token = location.pathname.split("/").pop();
let busy = false;
async function refresh(){
  const r = await fetch('/computer-assist/'+token+'/state.json');
  if (!r.ok) { document.getElementById('tip').textContent = '链接无效或已过期'; return; }
  const j = await r.json();
  document.getElementById('shot').src = 'data:image/png;base64,' + j.screenshot;
}
document.getElementById('shot').addEventListener('click', async (e) => {
  if (busy) return;
  const rect = e.target.getBoundingClientRect();
  // 归一化 [0,1] 坐标，服务端按当前屏幕尺寸换算物理像素
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  busy = true; await send({op:'click', x, y}); setTimeout(()=>{busy=false; refresh();}, 800);
});
document.getElementById('kb').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') { const v = e.target.value; e.target.value=''; await send({op:'type', text: v}); await send({op:'key', key:'Return'}); refresh(); }
});
async function send(body){
  await fetch('/computer-assist/'+token+'/action.json', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
}
async function done(){ await send({op:'done'}); document.getElementById('tip').textContent='已通知助理继续任务，本页可关闭。'; }
refresh(); setInterval(refresh, 4000);
</script></body></html>`;

export function computerAssistRoutes(core: WeAgentCore): Hono {
	const app = new Hono();

	app.get("/computer-assist/:token", (c) => c.html(PAGE));

	app.get("/computer-assist/:token/state.json", async (c) => {
		const claims = core.assistTokens.verify(c.req.param("token"));
		if (!claims) return c.json({ error: "invalid_or_expired" }, 403);
		try {
			const shot = await core.computer.screenshot({ withSoM: false });
			return c.json({ screenshot: shot.pngBuffer.toString("base64"), done: false });
		} catch (err) {
			log.warn({ err }, "桌面接管页截图失败");
			return c.json({ error: "screenshot_failed" }, 500);
		}
	});

	app.post("/computer-assist/:token/action.json", async (c) => {
		const token = c.req.param("token");
		const claims = core.assistTokens.verify(token);
		if (!claims) return c.json({ error: "invalid_or_expired" }, 403);
		const body = (await c.req.json()) as { op: string; x?: number; y?: number; text?: string; key?: string };
		try {
			if (body.op === "done") {
				const r = await core.completeComputerAssist(token);
				return c.json({ ok: true, done: true, message: r.message });
			}
			const size = await core.computer.getScreenSize();
			if (body.op === "click" && Number.isFinite(body.x) && Number.isFinite(body.y)) {
				// 页面传归一化 [0,1] 坐标 → 逻辑空间 → 物理像素（复用 §2.2 多制式归一化）
				const logical = normalizePointToLogical(body.x!, body.y!, "normalized", size);
				const phys = logicalToPhysical(logical.x, logical.y, size);
				await core.computer.click(phys.x, phys.y, "left");
			} else if (body.op === "type" && body.text) {
				await core.computer.type(body.text);
			} else if (body.op === "key" && body.key) {
				await core.computer.key(body.key);
			} else {
				return c.json({ error: "bad_op" }, 400);
			}
			return c.json({ ok: true });
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
		}
	});

	return app;
}
