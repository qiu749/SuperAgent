/**
 * 浏览器远程协助页（SPEC-v2 §9.1 模式 B）：/browser-assist/:token
 * HMAC 签名 token（5 分钟 TTL），手机上轮询最新截图、点击坐标/键盘输入转发到
 * playwright page（轮询式，无 WS 依赖），点【我已登录完成】唤醒 Worker。
 */
import { Hono } from "hono";
import pino from "pino";
import type { WeAgentCore } from "../app/core.ts";

const log = pino({ level: process.env.LOG_LEVEL || "info" }).child({ mod: "browser-assist" });

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>WeAgent 浏览器协助</title>
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
  <button class="ghost" onclick="refresh()">刷新截图</button>
  <input id="kb" placeholder="输入文字后回车发送">
  <button class="ghost" onclick="send({op:'key',key:'Enter'})">⏎</button>
  <button class="primary" onclick="done()">我已登录完成</button>
</div>
<div id="stage"><img id="shot" alt="加载中…"></div>
<div id="tip">在截图上点击即转发坐标；输入框可代输文字。</div>
<script>
const token = location.pathname.split("/").pop();
let busy = false;
async function refresh(){
  const r = await fetch('/browser-assist/'+token+'/state.json');
  if (!r.ok) { document.getElementById('tip').textContent = '链接无效或已过期'; return; }
  const j = await r.json();
  document.getElementById('shot').src = 'data:image/png;base64,' + j.screenshot;
  if (j.done) document.getElementById('tip').textContent = '已完成，正在通知助理…';
}
document.getElementById('shot').addEventListener('click', async (e) => {
  if (busy) return;
  const rect = e.target.getBoundingClientRect();
  // 截图坐标按 390x844 viewport 归一化映射
  const x = Math.round((e.clientX - rect.left) / rect.width * (e.target.naturalWidth || rect.width));
  const y = Math.round((e.clientY - rect.top) / rect.height * (e.target.naturalHeight || rect.height));
  busy = true; await send({op:'click', x, y}); setTimeout(()=>{busy=false; refresh();}, 800);
});
document.getElementById('kb').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') { const v = e.target.value; e.target.value=''; await send({op:'type', text: v}); await send({op:'key', key:'Enter'}); refresh(); }
});
async function send(body){
  await fetch('/browser-assist/'+token+'/action.json', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
}
async function done(){ await send({op:'done'}); document.getElementById('tip').textContent='已通知助理继续任务，本页可关闭。'; }
refresh(); setInterval(refresh, 4000);
</script></body></html>`;

export function browserAssistRoutes(core: WeAgentCore): Hono {
	const app = new Hono();

	app.get("/browser-assist/:token", (c) => c.html(PAGE));

	app.get("/browser-assist/:token/state.json", async (c) => {
		const claims = core.assistTokens.verify(c.req.param("token"));
		if (!claims) return c.json({ error: "invalid_or_expired" }, 403);
		try {
			const shot = await core.browsers.screenshot(claims.userId);
			return c.json({ screenshot: shot.toString("base64"), done: false });
		} catch (err) {
			log.warn({ err }, "协助页截图失败");
			return c.json({ error: "screenshot_failed" }, 500);
		}
	});

	app.post("/browser-assist/:token/action.json", async (c) => {
		const token = c.req.param("token");
		const claims = core.assistTokens.verify(token);
		if (!claims) return c.json({ error: "invalid_or_expired" }, 403);
		const body = (await c.req.json()) as { op: string; x?: number; y?: number; text?: string; key?: string };
		try {
			if (body.op === "done") {
				await core.completeBrowserLogin(token);
				return c.json({ ok: true, done: true });
			}
			if (body.op === "click" && Number.isFinite(body.x) && Number.isFinite(body.y)) {
				await core.browsers.click(claims.userId, body.x!, body.y!);
			} else if (body.op === "type" && body.text) {
				await core.browsers.type(claims.userId, body.text);
			} else if (body.op === "key" && body.key) {
				await core.browsers.press(claims.userId, body.key);
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
