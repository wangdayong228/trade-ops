# 运行状态观测实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在线查看服务健康与资金费率同步状态。

**Architecture:** 同进程 RuntimeStatus 将既有同步事件观测与 funding repository 的持久状态组合为只读快照；Fastify 提供健康和状态入口，独立静态页面展示快照。

**Tech Stack:** 现有 TypeScript、Fastify、better-sqlite3、Node test runner、原生浏览器 JS/CSS，无新依赖。

## 依据与全局约束

- 适用 spec：`docs/superpowers/specs/2026-10-06-runtime-status-design.md`。用户“好的，落实”授权本范围实现与必要验证；计划为该范围的执行分解。
- 遵守 `docs/standards/code-rules.md`；所有运行验证使用假网关、假源、临时环境和内存/临时 DB。
- 不读取真实 `.env`，不访问任何交易所 API，不启动生产入口。
- 在 `feat/runtime-status` 分支实施，工作区起始干净；主 agent 单写，调查和审查 agent 只读。初次交付保留工作区；用户随后明确授权 commit 并合并到本地 `main`，不推送远端。
- 使用 Node 20.19.4，与已安装 SQLite native addon 的 ABI 115 匹配；命令前置 `PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH`。
- 按 global-conventions，计划只记录实现边界和验证，具体实现留在源码；每个 task 先记录预期失败再实现。

## Task 1：状态快照、健康入口与生命周期

**Files:** 新建 `src/operations/runtime-status.ts`、`src/http/status-routes.ts`、`tests/http/runtime-status.test.ts`；修改 `src/main.ts`、`src/http/server.ts`、`tests/main.test.ts`。

**Interfaces:** RuntimeStatus 接收只读 `Pick<FundingRateRepository, 'listMarketStates'>`、数据库检查回调、时钟、同步周期、secretProvider；实现 `FundingRateEventSink.record`、`setPhase`、`health`、`snapshot`。buildServer 增加可选 runtimeStatus，未装配时健康 ready/status 503；composeService 始终装配。RunnableComposition 可选持有同一 runtimeStatus，现有生命周期替身不需新增强制能力。

- [x] 编写失败测试：实际 compose + 内存 DB 下新路由从 404 变为可用；启动前 ready 503，启动后 200，shutdown 等待期间 503；健康无 exchange 调用。
- [x] 覆盖风险矩阵：空 DB/发现未执行，发现成功/失败/恢复，持久 BACKFILLING/INCOMPLETE 和独立增量，fatal 后 stopped，DB 关闭、repository 失败，错误脱敏与无 stack，非本地 Host、no-store、只读不增调用/不写 DB。
- [x] 运行 `npm run build && node --test dist/tests/http/runtime-status.test.js`，确认预期红灯。
- [x] 实现状态观测、严格字段投影、路由和 startService 生命周期；通过事件 fanout 保留已有 sink，以行为断言替代旧 sink 引用相等测试。
- [x] 运行上述测试及 `node --test dist/tests/main.test.js dist/tests/funding-rates/funding-rate-sync-service.test.js dist/tests/http/server.test.js`。

## Task 2：只读状态页面

**Files:** 新建 `public/status.html`、`public/status.js`、`public/status.css`、`tests/http/status-ui.test.ts`；修改 `public/index.html`。

**Interfaces:** 页面只消费 `GET /api/status`；运行状态、发现结果、统计、市场明细和错误详情以公开 DTO 展示。共用原 styles.css，增补状态页局部样式。

- [x] 编写浏览器脚本行为测试：空/正常/失败快照、请求超时和串行轮询、失败后旧数据标记、市场过滤、恶意文本只显示为文本、页面隐藏/离开停止轮询。
- [x] 运行 `npm run build && node --test dist/tests/http/status-ui.test.js` 确认预期红灯。
- [x] 实现中文页面、首页链接和纯只读脚本；10 秒刷新与超时，完整错误详情使用安全 DOM，未知或缺失响应状态报错。
- [x] 运行 UI 与 HTTP 定向测试，用 ego-browser 访问仅假数据的本地 fixture 做桌面/窄屏和刷新检查。

## Task 3：文档、审查与收尾

**Files:** 更新 `README.md`、`docs/usage/operator-guide.md`、旧 funding spec 的范围修订说明，以及本计划的完成证据。

- [x] 文档列出页面/API/health 路径、返回语义、时间单位、重启后的内存状态、持久状态注意事项和失败定位办法。
- [x] 使用 risk_reviewer 做受影响路径只读审查，按证据修复确认的问题并补回归测试。
- [x] `npm test` 全量回归、`node --check public/status.js`、`git diff --check`；命令 exit 0，记录关键结果。
- [x] 通过 verification-before-completion、consistency-check、post-verification-check，核对 spec/plan/接口/页面/文档，记录仍存在的限制。

## 完成证据（2026-10-06）

- 环境检查：Node 26 与既有 better-sqlite3 的 ABI 115 不兼容；切换已安装 Node 20.19.4 后，内存 SQLite `SELECT 1` 成功。没有修改依赖版本或 native addon。
- 基线：`PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH npm test`，exit 0，1584 passed / 0 failed。
- 初始 API 红灯：`npm run build && node --test dist/tests/http/runtime-status.test.js`（同一 Node 20 PATH），exit 1；新入口返回 404，未分发的日志 sink 抛错，均为目标功能缺失。实现后包含 main、同步服务与 HTTP 的定向回归 exit 0，426 passed。
- 初始 UI 红灯：`npm run build && node --test dist/tests/http/status-ui.test.js`（Node 20），exit 1；首页缺少链接、状态脚本缺失。实现后目标行为通过。
- 审查回归：按已证实问题先补失败测试再修复，覆盖服务运行起点、快速暂停/恢复竞态、短数据库文件名对市场身份和请求诊断的破坏、八种自相矛盾快照。数据库路径的过度脱敏要求经 code-rules 核对后按 spec 安全段明确修订，凭证脱敏不变。
- 最终定向：`PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH node --test dist/tests/http/runtime-status.test.js dist/tests/http/status-ui.test.js`，exit 0，28 passed / 0 failed。risk_reviewer 复核确认此前问题全部关闭。
- 最终全量：`PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH npm test`，exit 0，1612 passed / 0 failed / 0 skipped（含 TypeScript 构建）。
- `node --check public/status.js`、`git diff --check` 均 exit 0。
- ego-browser 使用 `tests/support/runtime-status-fixture.ts` 的 fake sources/gateways 与内存 SQLite，在本机临时端口检查桌面和 390px 窄屏、市场筛选、手动刷新、失败快照标记及恢复；页面无横向溢出。Ego click 对刷新按钮的工具回执报 disabled，DOM 检查显示按钮可用，使用 Enter 成功触发一次 click 和状态请求。快切竞态额外由确定性 JS 测试覆盖。
- 浏览器 TaskSpace 和假数据预览服务均已关闭。未启动生产服务、读取真实 `.env`/业务数据库或访问交易所。
- 一致性检查：会话授权范围、spec/plan、前后端 DTO、现有配置和 README/操作手册一致。初次交付未创建 PR、commit 或 push；后续按用户明确授权提交并合并到本地 `main`。
- post-verification：共 13 个执行复选框，此前已完成 9 个，本次核对并勾选 4 个，剩余 0 个。历史回填、增量与交易执行语义保持原批准设计；Prometheus/Grafana、历史数据导出和外部告警不在本次范围。
