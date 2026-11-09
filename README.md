# WeAgent：企业微信常驻 Personal Agent

融合 **Grok Bot**（持久化沙箱/浏览器登录态 + 人工审批）、**DeepSeek Super-agent**（Router/Worker 分离 + 注意力管理 + Observe 观察模式 + 群聊线程订阅）、**Pi Durable**（日志化持久化与崩溃恢复运行时 + Code Mode WASM 沙箱）、**Hermes Agent**（`SKILL.md` 程序性记忆自进化 + 后台复盘分叉 + 四道安全守卫）与 **Mem0**（声明式长期记忆）的企业微信个人数字助理。

## 文档索引

### Phase 1 基座版（v0.4，与当前 `src/` 代码实现一一对应）
- [PRD.md](./PRD.md)（同 [`docs/PRD.md`](./docs/PRD.md)）：v0.4 核心基座产品需求文档（Router/Worker 分离、Observe 观察模式、Draft 草稿审批、Outbox 水位线与 Pi Durable 崩溃恢复）
- [SPEC.md](./SPEC.md)（同 [`docs/SPEC.md`](./docs/SPEC.md)）：v0.4 核心基座技术规格文档

### Phase 2 演进版（v2 / v1.0，含 Hermes 技能沉淀与六大演进特性，已落地 `src/`）
- [PRD-v2.md](./PRD-v2.md)（同 [`docs/PRD-v2.md`](./docs/PRD-v2.md)）：下一代产品需求文档（新增 Hermes 程序性技能自进化、渐进式自动放权、早晚报 Digest、Pi Code Mode、Playwright 远程扫码与企微多模态/群聊订阅）
- [SPEC-v2.md](./SPEC-v2.md)（同 [`docs/SPEC-v2.md`](./docs/SPEC-v2.md)）：下一代完整技术规格文档：
  - **第 0–7 节**：Pi Durable 验证结论、全景架构、企微语音/文件/群聊 `Subscription` 扇出、四级入站分流、Router（原文直传 + 30 词注记限制）、Worker（`worker_report` 五态汇报 + `trigger_handback` 越界退回 + `WorkerSlots` +1 紧急槽 + Pi Code Mode）、Draft 草稿审批与渐进式自动放权 + 早晚报批量摘要卡
  - **第 8 节**：Hermes 式自进化技能系统（`skills_list / skill_view / skill_manage` 渐进式披露、每轮结束 `conversation.fork()` 后台复盘、四级演进优先级、5 类禁入黑名单、Read-Before-Write 先读后写守卫、`skills_guard` 静态扫描、`.curator_ledger.jsonl` SHA-256 审计账本与一键回滚）
  - **第 9–12 节**：Playwright 持久化浏览器与手机远程扫码协助、企微 OAuth H5 极简待办中心面板、完整 `app.sqlite` 表结构与代码目录树

### Phase 3 全栈数字分身版（v3.0，Computer Use + Hybrid RAG + H5 轨迹时光机）
- [SPEC-v3.md](./SPEC-v3.md)（同 [`docs/SPEC-v3.md`](./docs/SPEC-v3.md)）：v3.0 完整技术规格说明书：
  - **阶段一**：Computer Use 视觉桌面引擎（`1280x800` 坐标归一化、红圈十字准星截图审批、aHash 死循环检测与 `noVNC` 手机接管）+ 4 个开箱即用办公种子技能包
  - **阶段二**：多源主动感知网关（Webhook / 日历会前 15 分钟速览）+ 个人本地混合知识库（SQLite FTS5 + 向量余弦 + RRF 融合）+ 五级模型角色路由与每日成本熔断器
  - **阶段三**：`spawn_subworkers` 只读并发子代理分治（Map-Reduce）+ 技能健康度遥测（一次通过率统计、周度夜间巡检、`/skills install` 静态扫描入库）
  - **阶段四**：**H5 轨迹时光机（Trajectory Time-Machine）**——融合 Pi Durable Journal 事件流与视觉截图帧的步进回放 + **任意历史节点 `conversation.fork()` 分叉重跑**

- [examples/spike.ts](./examples/spike.ts)：Pi Durable 崩溃恢复与审批停机/唤醒验证脚本

## 快速开始

```bash
cp .env.example .env
npm install
npm run spike:crash
npm run spike:approval
```
