# 飞书渠道 v1.0 真机测试用例清单

> 前置：服务已启动（`npm start`，日志在 `/tmp/weagent-server.log`）、`FEISHU_APP_ID` 已配置、`ALLOWED_USERS` 含你的 open_id、`DEEPSEEK_API_KEY` 已点亮。
> 验证手段：① 飞书收到的消息/卡片 ② `http://127.0.0.1:8000/panel` 面板 ③ `tail -f /tmp/weagent-server.log` ④ `sqlite3 data/app.sqlite`。

## A. 单聊主链路（P0）

| # | 步骤 | 预期 |
|---|---|---|
| A1 | 飞书单聊发「帮我调研一下 MCP 生态的邮件 server，整理成对比表」 | ① 秒回 ack 回执（含任务号）② 数十秒后 ready 结果 + .md 报告文件 ③ 面板「任务」页出现该任务（stage=ready）④ 日志有 `已提交 Router` 与 `worker_report` |
| A2 | 同上完成后发「把对比表再补充一列价格」 | Router 判 attach → 原任务唤醒续跑，**不建新单**（日志 `attach`，任务号不变） |
| A3 | 发一句闲聊「今天天气怎么样」 | Router 轻量直答（不开任务）；或判 ignore 说明原因 |
| A4 | 发「我偏好邮件正文不超过 3 段」 | 语义记忆写入；后续任务日志可见 `记忆已写入`；面板「记忆」页出现该条 |

## B. 斜杠命令（P0，不过模型、秒回）

| # | 步骤 | 预期 |
|---|---|---|
| B0 | 先做一次性配置（机器人菜单无开放 API，需在开发者后台手动配）：开发者后台 → 应用能力 → 机器人 → 菜单栏 → 添加 7 项（待办面板=跳转链接 → `<PANEL_BASE_URL>`/panel；任务列表/技能库/我的记忆/定时任务/切换模式/帮助 = **发消息**型，内容分别为 /tasks /skills /memory /cron /mode /help）→ 发布版本 | 聊天输入 `/` 或点输入框左侧菜单键 → **弹出选项列表**；点「任务列表」等价于发 /tasks，直接收到执行结果（「事件」型菜单项（event_key=wa_cmd:xxx）也已内置接收处理） |
|---|---|---|
| B1 | 发 `/tasks` | 列出最近任务与状态 |
| B2 | 发 `/stop <任务号>` | 任务取消 + 会话中止 |
| B3 | 发 `/mode` → `/mode auto` → `/mode observe` | 模式切换回执；面板「规则」页模式同步变化 |
| B4 | 发 `/skills` | 技能索引（空库时提示会自动沉淀） |
| B5 | 发 `/memory` | 记忆列表 |

## C. 审批闭环（P0，v0.4 基础 + v1.0 修改关联）

| # | 步骤 | 预期 |
|---|---|---|
| C1 | 发「帮我给 boss@corp.com 发封周报邮件，说明本周进展」 | Worker `propose_action` → 飞书审批卡片（批准/拒绝/修改三按钮）|
| C2 | 点【批准】 | 秒回「已批准并执行 ✅」卡片更新 + 审计日志 `data/actions.jsonl` 新增一行 |
| C3 | 新草稿点【修改】→ 直接打字「收件人改成 boss2@corp.com，语气正式些」 | Worker 重拟 → **新卡片**；批准后面板「记忆 → 学到的习惯」出现一条规则（含 boss2@corp.com）|
| C4 | 点【拒绝】 | Worker 收到拒绝通知，卡片变「已拒绝 ❌」 |

## D. 渐进放权 + 批量摘要（P1，M8）

> 建议 `.env` 临时加 `TRUST_AUTO_THRESHOLD=2` 并重启，避免连点 10 次。

| # | 步骤 | 预期 |
|---|---|---|
| D1 | 连续 2 次「同 scope_key 的草稿」无修改点【批准】 | 第 2 次后收到**升级询问卡**（升级为自动执行 / 保持每次审批）|
| D2 | 点【升级为自动执行】→ 再触发同类动作 | 不再出审批卡，直接执行 + 收到**事后通知卡**（带撤回按钮）；任务不中断继续跑 |
| D3 | 点通知卡【撤回自动放权】 | 恢复每次审批；再触发重新出审批卡 |
| D4 | 面板「规则」页把该 action_type 设为「进摘要」→ 触发同类动作 | 不推单卡，草稿进入摘要池（面板拍板页可见「摘要池」pill）；工作日 10:00/17:00 收到**批量摘要卡**，点【一键全部批准】全部执行 |
| D5 | 面板拍板页打开草稿「查看/编辑参数」→ 改 JSON 后批准 | 以**修改后**的参数执行（对比 exec_result）；同时沉淀习惯 |

## E. 语音 / 图片 / 文件（P1，M6）

| # | 步骤 | 预期 |
|---|---|---|
| E1 | 发一条语音（**未配 ASR**） | 收到提示「语音转写服务未配置…请打字描述」；不建单 |
| E2 | `.env` 配 `ASR_BASE_URL=https://api.siliconflow.cn/v1` + `ASR_API_KEY=sk-mq…`（SiliconFlow，SenseVoiceSmall）重启后发语音 | 转写成功 → 按 A1 链路建单；日志 `收到飞书资源消息` + trigger `msg_type=voice` |
| E3 | 发一张图片 + 文字「分析这张截图里的数据」 | 图片入收件箱（`data/inbox/ou_…/`）→ Router 单内可引用；日志 trigger 带 attachments |
| E4 | 有活跃任务时直接发一个 .md/.xlsx 文件 | **免 Router 直达**该任务（日志 `attach`，decisions kind=attach），任务工作区 `data/tasks/<id>/inbox/` 出现该文件 |
| E5 | 无活跃任务发文件 | 进 Router 分诊；accept 后文件自动挂载到新任务 inbox |

## F. 群聊订阅扇出（P1，M6）

> 需要把机器人拉进一个测试群（开发者后台确认 `im.message.receive_v1` 与资源读取权限已开）。

| # | 步骤 | 预期 |
|---|---|---|
| F1 | 群里 @机器人 说「帮我整理群里今天讨论的需求」 | 建单 + ack；`subscriptions` 表新增 `(feishu:group:<chat_id>, <task_id>, own)` |
| F2 | 群里（自己，不 @）继续说「补充：要支持导出 Excel」 | **免 @ 免 Router** 直达该任务 Worker（日志 `群聊消息已扇出`） |
| F3 | 让一个**不在白名单**的同事在群里发言 | 消息以「外部成员，仅供参考」标注扇入；其 @机器人 的消息**不建单、不能停单** |
| F4 | 群里话题跑偏（如闲聊报销）后等 Worker 判断 | Worker 调 `thread_unrelated` → 退订；之后群消息不再扇入（日志 `群聊订阅已退订`） |

## G. 浏览器登录（P1，M9，Chromium 已实测可用）

| # | 步骤 | 预期 |
|---|---|---|
| G1 | 发「帮我打开 https://example.com 截图看看内容」（或任一需登录的内网页） | 收到登录页**截图图片** + 登录协助卡片（我已登录完成 / 远程协助链接） |
| G2 | 点开远程协助页（5 分钟有效）| 手机上能看到实时截图，可点击坐标、代输文字、回车 |
| G3 | 点【我已登录完成】 | 收到「登录状态已保存，正在继续任务」；Worker 被唤醒继续；`data/browser-profiles/<user>/` 出现 Profile 目录，下次免登录 |

## H. 面板 × 飞书跨渠道一致性（P1，M10）

| # | 步骤 | 预期 |
|---|---|---|
| H1 | 飞书里触发一张审批卡 → 打开 `/panel` 拍板页 | 同一张草稿出现在面板（可改参数） |
| H2 | 在面板点【批准】 | 飞书侧原卡片状态更新为「已批准并执行 ✅」 |
| H3 | 面板「任务」页点【查看轨迹】 | 渲染该任务的完整对话/工具调用轨迹 |
| H4 | 面板「规则」切 `off` → 飞书发 webhook 类事件 | 面板影子日志新增 would_accept；点【补建任务】→ 真正建单 |

## I. 边界与降级（P2）

| # | 步骤 | 预期 |
|---|---|---|
| I1 | 非白名单账号单聊机器人 | 完全忽略（日志 `非白名单用户，忽略`） |
| I2 | 发 30 秒长语音 / 20MB 大文件 | 有明确结果（转写成功或降级提示），进程不崩 |
| I3 | 杀掉进程重启（`pkill -f src/main.ts && npm start`） | 飞书 WS 自动重连；未处理 trigger 重新提交 Router（日志 `重启恢复`）；pending 审批的过期倒计时重建 |

## 快速核对命令

```bash
tail -f /tmp/weagent-server.log | grep -E "feishu|Router|propose|扇出"   # 关键链路日志
sqlite3 data/app.sqlite "select id,thread_key,msg_type from triggers order by created_at desc limit 5;"
sqlite3 data/app.sqlite "select id,status,urgency,scope_key from approvals order by created_at desc limit 5;"
sqlite3 data/app.sqlite "select * from subscriptions;"
open http://127.0.0.1:8000/panel
```

**已知前置开关**：E2 语音需配 ASR key；F 群聊需机器人入群且开通 `im.message.receive_v1` + `im:resource:read`（资源下载）权限；D4 批量摘要卡默认工作日 10:00/17:00 触发（`DIGEST_TIMES` 可改）。
