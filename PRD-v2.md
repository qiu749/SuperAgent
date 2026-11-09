# PRD：企业微信 Personal Agent（WeAgent）v1.0

> [!NOTE]
> 本文档在 v0.4 核心基座（Phase 1）之上，完整纳入了 **v1.0 六大进化能力（Phase 2）**：
> 1. **审批进化**：渐进式信任放权（Trust Escalation）+ 早晚报批量摘要卡（Batch Digest）
> 2. **自进化记忆与技能**：从审批【修改】Diff 中自动学习惯 + 高频任务自动沉淀 `SKILL.md`
> 3. **Pi Code Mode 加速**：用 WASM 沙箱脚本替代多轮串行工具调用
> 4. **重度执行环境**：持久化浏览器登录态（手机扫码一次、长期复用）+ `git worktree` 外挂编码子 Agent
> 5. **企业微信多模态与群聊**：语音条直接派单、文件/图片自动挂载工作区、群聊线程订阅（Subscription Fan-out）
> 6. **企微 H5 极简待办面板**：对齐 DeepSeek `005-panel.md`（“健康状态不占空间，置顶只放等你拍板的事”）

---

## 1. 背景与定位

参考 **Grok Bot**（常驻云电脑、跨应用登录态、人工审批）、**DeepSeek Super-agent**（Router/Worker 分离、把人类注意力视为最稀缺资源、Observe 观察模式、线程订阅）与 **Pi Durable + Mem0**，在**企业微信**上打造一个真正的常驻个人数字助理：

- **一句话定位**：住进企业微信的数字分身——交代给它的事在后台自主干完，平时不刷屏，只在需要你拍板时推卡片，而且每次被你修改过一次就会记住你的习惯。
- **北极星指标**：
  $$\text{注意力杠杆率} = \frac{\text{每日替用户完成的独立任务与自动化动作数}}{\text{用户付出的交互次数（发消息 + 点卡片 + 改草稿）}}$$

### 版本分期目标

| 阶段 | 核心目标 |
|---|---|
| **Phase 1（v0.4 核心基座）** | 跑通企业微信单聊 → 四级入站分流 → Router（原文直传 + 30 词注记）→ Worker（`worker_report` 五态汇报 + `trigger_handback` 越界退回 + `WorkerSlots` +1 紧急槽）→ Draft 草稿审批与 0.3s 宿主机执行 → Mem0 基础记忆 → Outbox 同任务保序 |
| **Phase 2（v1.0 智能进化）** | 跑通渐进式自动放权与批量审批卡 → 审批 Diff 提炼习惯与 `SKILL.md` 自动沉淀 → Pi Code Mode 提速 → 持久化浏览器扫码登录与编码子 Agent → 企微语音/文件/群聊订阅 → 企微 H5 待办面板 |

---

## 2. 核心用户场景（User Stories）

### Phase 1 基础场景（P0/P1）

| # | 场景 | 示例 | 阶段 |
|---|---|---|---|
| S1 | 异步长任务委派 | “调研 MCP 生态成熟的邮件 server，整理成对比表” → 秒回具体回执，10 分钟后推送精简结论 + `.md` 附件 | Phase 1 |
| S2 | 快速查询（记忆+轻量工具） | “明天几点开会？” → Router 自动检索 Mem0 记忆 + 调只读日历工具，2 秒内直接回答，不开 Worker | Phase 1 |
| S3 | Draft 草稿即时审批 | Worker 拟好邮件草稿 → 推卡片【批准】【拒绝】【修改】→ 点【批准】后宿主机 0.3s 直接发送 | Phase 1 |
| S4 | 定时巡检与静默关单 | “每小时检查一次线上报错日志” → 无异常时 Worker 调 `worker_report(dropped)` 静默结束，绝不发废话打扰 | Phase 1 |
| S5 | 修改中途突然换话题 | 点了邮件卡片【修改】后发“算了先帮我查明天去北京的机票” → Worker 调 `trigger_handback` 退回 Router 新建机票任务 | Phase 1 |
| S6 | 外部事件观察模式 | 接入 GitHub Webhook，默认 `observe` 模式只记 `would_accept` 日志，确认判断准确后再切 `auto` | Phase 1 |

### Phase 2 进化场景（v1.0 新增）

| # | 场景 | 示例 | 阶段 |
|---|---|---|---|
| **S7** | **渐进式自动放权** | 给内部团队发日报提醒连续 10 次未修改直接点【批准】→ 自动弹窗询问“是否升级为自动发送并事后通知？” | Phase 2 |
| **S8** | **早晚报批量审批卡** | 白天 Worker 产出了 5 封非紧急的客户跟进邮件草稿，不零散打断，17:00 合成一张摘要卡支持【一键全批】 | Phase 2 |
| **S9** | **改一次就写进 Skill（Hermes 后台复盘）** | 你在审批卡片点【修改】把称呼改成“王总好”或吐槽“表格太啰嗦” → 任务结束后后台自动 Fork 复盘会话，用 `skill_manage(patch)` 把这条规矩打补丁写进对应类别的 `SKILL.md` | Phase 2 |
| **S10** | **Hermes 式四级技能自演进与 `/learn`** | 跑通复杂流程或排障后，后台复盘按“1.补丁当前 Skill → 2.补丁已有大类 Skill → 3.写 `references/templates/scripts` 支持文件 → 4.新建类别级 Skill”自动沉淀，也支持发 `/learn <文档/链接>` 手动提炼 | Phase 2 |
| **S11** | **语音/文件随手甩** | 走路时发一条 15 秒语音 + 转发一份 PDF 合同：“帮我看看这份合同里的付款条款有没有坑” → 自动转写语音、挂载 PDF 并分析 | Phase 2 |
| **S12** | **无 API 网站扫码代操作** | “去内部 OA 系统帮我把上周报销单状态截图发我” → 首次推安全远程浏览器链接让你手机扫一次码，之后长期复用 Cookie 自动跑 | Phase 2 |
| **S13** | **群聊 `@` 与上下文订阅** | 在项目群 `@WeAgent 跟踪一下这个崩溃问题` → 自动建单并订阅该群后续讨论，同事补充的日志自动同步给 Worker | Phase 2 |
| **S14** | **H5 待办中心一屏拍板** | 点开企微工作台“WeAgent 待办”，置顶看到 2 个待批草稿 + 1 个追问，30 秒内集中批完 | Phase 2 |

---

## 3. 功能需求详述

### F1 企业微信全模态接入与群聊订阅
- **F1.1 单聊与群聊回调**：支持企业微信自建应用接收文本、语音（`voice`）、图片（`image`）、文件（`file`）、模板卡片按钮事件（`template_card_event`）。
- **F1.2 语音自动转写（v1.0）**：收到语音条后自动下载媒体文件，调用 ASR 模型转为文本，以 `[语音转写] ...` 进入分流器，原语音存档备查。
- **F1.3 文件与图片工作区挂载（v1.0）**：收到文件/图片后自动下载至用户的临时收件箱 `/data/inbox/{user_id}/`；当创建或关联到某个任务 `#id` 时，硬链接至 `/data/tasks/{id}/inbox/`，图片通过 Photon WASM 自动缩放解码供多模态模型直接读取。
- **F1.4 群聊订阅扇出（Subscription Fan-out，v1.0）**：
  - 在群聊中仅当被白名单成员 `@`（或命中主动规则）时才由 Router 创建任务，并将该任务订阅（`subscribe`）到该群聊线程；
  - 订阅生效期间，群内后续相关讨论作为上下文输入（`context input`）自动扇出给该任务的 Worker，无需每次 `@`；但群内普通成员的消息不具备修改权限或停止任务的授权强度（`Mandate` 隔离）。
- **F1.5 保序与短消息约束**：Outbox 对同一任务的消息强制保序（`behind` 检查，确保回执永远先于结果送达）；聊天框文本消息硬限 ≤ 100 词，长报告一律发 `.md` 附件或卡片链接。

### F2 Router（常驻分诊、原文直传、Observe 模式）
- **F2.1 四级入站分流**：卡片按钮、斜杠命令、修改态回复由网关直接定位目标 Worker（不过 Router）；自然语言、语音转写文本、Webhook、Cron、以及被 Worker `handback` 退回的消息进入 Router。
- **F2.2 轻量直答**：自动注入 Mem0 Top 10 记忆 + 挂载 `< 1s` 的轻量只读工具（如查日程、查任务、查记忆），简单问题 2 秒内直接回答。
- **F2.3 原文直传与 30 词紧箍咒**：派单时宿主机将用户原始消息全文及附件路径直接注入 Worker；Router 附加的 `note` 代码级强校验 ≤ 30 词，严禁替 Worker 编写实现计划。
- **F2.4 外部事件 Observe 模式**：对 Webhook / 群聊非 `@` 消息提供 `off | observe（默认）| auto` 三档开关，`observe` 下只记录 `would_accept` 影子日志供用户在面板审计。

### F3 Worker（Pi Code Mode、沙箱、浏览器登录态、编码子 Agent）
- **F3.1 独立会话与 `WorkerSlots`（+1 紧急槽）**：每任务独立 Pi Conversation；常规槽位 `MAX_WORKERS=3`，另设 +1 人类优先紧急槽位处理审批唤醒与追问回复。
- **F3.2 结构化五态汇报（`worker_report`）**：强制以 `progress`（仅内部记录，不发 IM）、`ready`（交付）、`blocked`（带单个具体问题）、`failed`、`dropped`（无事发生静默关单，不发 IM）收尾。
- **F3.3 越界退回（`trigger_handback`）**：直达消息超出当前任务范围时一键退回 Router。
- **F3.4 Pi Code Mode 批量工具编排（v1.0）**：启用 `@earendil-works/pi-durable/codemode`，允许模型编写 JS/TS 脚本在 QuickJS WASM 沙箱内一次性循环调用只读工具（搜索、查询、过滤、计算），将 10+ 轮串行工具调用压缩为 1 轮。
- **F3.5 持久化浏览器与扫码协助（v1.0）**：
  - 为用户维护持久化的 Chromium Profile，支持操作无 API 的内部系统或网页；
  - 遇到登录态失效或需验证码/扫码时，Worker 调用 `request_browser_login(url, site)`，生成带一次性签名的远程页面链接推送到企业微信，用户扫码完成后唤醒 Worker 继续执行。
- **F3.6 外挂编码子 Agent（v1.0）**：针对代码修改任务，通过 `prepare` 钩子自动执行 `git worktree` 创建隔离分支目录，调用沙箱内编码 Agent 完成修改、跑通测试并生成 PR 草稿。

### F4 审批进化（Draft 模式 + 批量摘要卡 + 渐进式放权）
- **F4.1 Draft 草稿与 0.3s 宿主机执行**：不可逆动作统一调 `propose_action` 生成结构化草稿并停机（`terminate: true`）；点【批准】后不过大模型，由宿主机直接读取 JSON 执行并更新卡片。
- **F4.2 紧急度分级与早晚报批量摘要卡（Batch Digest，v1.0）**：
  - 草稿分 `immediate`（立即推单卡）与 `digest`（进入待批池）；
  - 每日定时将待批池中的草稿汇总为一张“待批摘要卡”推送，支持【一键全部批准】或跳入 H5 面板逐条审阅。
- **F4.3 渐进式自动放权（Trust Escalation，v1.0）**：
  - 按 `action_type + scope_pattern`（如“发送邮件给 `@mycompany.com` 内部同事”）统计用户连续未修改直接批准的次数；
  - 连续批准满 $N$ 次（默认 10 次）后，自动询问用户是否将该模式升级为 `auto_notify`（自动执行并事后发一条静默通知）；用户随时可在面板一键降级回 `always_ask`。

### F5 记忆与 Hermes 式自进化技能库（Declarative Mem0 + Procedural `SKILL.md`）
- **F5.1 声明式记忆与程序性记忆明确分工**：
  - **Mem0（声明式）**：只存“用户是谁（偏好、身份）”与“环境事实（路径、配置、联系人）”；严格隔离外部 `<external_data>` 防投毒。
  - **Skills（程序性 `/data/skills/[category/]<name>/SKILL.md`）**：存“如何按这位用户的规矩把这一类任务做对”，支持携带 `references/`、`templates/`、`scripts/`、`assets/` 四类支持文件。
- **F5.2 渐进式披露（Progressive Disclosure）**：
  - System Prompt 仅注入所有启用 Skill 的 `name + 一句话 description`（前 57 字符为自包含触发条件）；
  - Agent 按需通过 `skill_view(name, file_path?)` 动态加载完整 `SKILL.md` 或支持文件。
- **F5.3 每轮后台复盘分叉（Background Review Fork，复刻 Hermes `background_review.py`）**：
  - 每次 Worker 任务结束或审批【修改】完成，利用 Pi Durable `conversation.fork()` 在后台拉起静默复盘子会话（直接命中父会话 Prompt Prefix Cache）；若用户发来新消息，立即抢占取消后台复盘（Foreground Preemption）。
  - **四级更新优先级**：(1) 优先 `patch` 本轮刚加载过的 Skill → (2) `patch` 已有的大类（Umbrella）Skill → (3) 在已有大类下通过 `write_file` 新增 `references/`、`templates/` 或可复用的 `scripts/` → (4) 最后才新建类别级 Skill（严禁建一次性任务名 Skill）。
  - **5 类禁入黑名单（`_DO_NOT_CAPTURE_BLOCK`）**：严禁写入环境缺包等临时错误、严禁写入“某工具坏了/不能用”的负面断言、严禁写入未验证成功的死胡同尝试。
- **F5.4 `/learn` 主动提炼与四道安全守卫**：
  - 支持 `/learn <URL/文件路径/任务号>` 手动提炼技能；
  - 代码级强制执行：(1) **先读后写守卫**（`patch` 前必须在本次复盘内调过 `skill_view`）、(2) **静态安全扫描**（`skills_guard` 拦截配置篡改与上下文外泄）、(3) **SHA-256 审计账本与一键回滚**（`.curator_ledger.jsonl` + `.curator_backups/blobs/`）、(4) **所有权与归档保护**（禁删用户/置顶 Skill，合并时仅移入 `.archive/`）。

### F6 企业微信 H5 极简待办中心（对齐 DeepSeek `005-panel.md`，v1.0）
- **F6.1 企微免登**：基于企业微信网页授权（OAuth2）自动识别当前白名单用户身份。
- **F6.2 四大极简视图**：
  1. **待我拍板（Attention）**：置顶列出待批草稿（带 Diff 预览、批量批准）与待答复追问；无待办时完全折叠。
  2. **任务看板（Tickets）**：按状态查看任务、查看 Pi Durable 完整执行轨迹、手动 Stop / Retry。
  3. **记忆、习惯与放权（Brain）**：可视化查看/删除 Mem0 记忆、审批学到的习惯、已沉淀的 `SKILL.md` 以及自动放权规则。
  4. **主动规则与影子日志（Observe）**：切换 `off | observe | auto`，审阅 `Observe` 模式下的 `would_accept` 记录并一键转正。

---

## 4. 成功标准与里程碑规划

| 阶段 | 里程碑 | 内容 | 预估工期 |
|---|---|---|---|
| **Phase 1 (v0.4)** | M0–M5 | 企微单聊 + 四级分流 + Router/Worker + `worker_report` / `handback` / `WorkerSlots` + Draft 单卡审批 + Mem0 基础版 + Durable Cron + Docker 沙箱 | **7 天** |
| **Phase 2 (v1.0)** | **M6** | **企微多模态与群聊**：语音 ASR 转写、文件/图片工作区挂载、群聊 `@` 与 `Subscription` 线程订阅扇出 | **1.5 天** |
| **Phase 2 (v1.0)** | **M7** | **Pi Code Mode + 自进化记忆**：接入 `@earendil-works/pi-durable/codemode`；实现审批修改 Diff → 习惯提炼 + 高频任务 → `SKILL.md` 生成器 | **2 天** |
| **Phase 2 (v1.0)** | **M8** | **审批进化**：`trust_policies` 渐进式放权统计与升级卡 + `digest` 早晚报批量审批卡 | **1.5 天** |
| **Phase 2 (v1.0)** | **M9** | **重度执行环境**：持久化 Chromium Profile + 手机远程扫码登录协助链接 + `git worktree` 外挂编码子 Agent | **2 天** |
| **Phase 2 (v1.0)** | **M10** | **企微 H5 待办中心面板**：OAuth 免登 + 待办拍板/轨迹回放/记忆管理/Observe 审计四合一轻量前端 | **2 天** |
