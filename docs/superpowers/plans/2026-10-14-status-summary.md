# 状态汇总快照实施计划

> **For agentic workers:** 使用 executing-plans 在当前会话逐项执行。目标与范围来自用户明确要求及 `../specs/2026-10-14-status-summary-design.md`。

**Goal:** GET /api/status 与状态页只消费汇总快照，在 10 秒超时内完成重复刷新。

**Architecture:** 保留 RuntimeStatus 对严格 repository 状态的同步读取和计数，删除 markets 投影。状态页只校验和展示汇总数据，保留轮询及失败保留快照逻辑。

**Tech Stack:** Node.js >=20、TypeScript、Fastify 5、better-sqlite3 12、原生 HTML/CSS/JavaScript、node:test；不新增依赖。

## 全局约束

- 以本任务 spec 替代旧状态设计的明细展示部分，其余语义保持。
- 无真实凭证、环境文件、交易所 API、业务数据库访问。
- 构建和测试命令前缀：`PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH`。
- 仅修改状态投影、页面、相关测试及状态文档；不改交易或资金同步执行路径。

## Task 1：汇总契约与页面同步

**Files:** `src/operations/runtime-status.ts`、`public/status.js`、`public/status.html`、`public/status.css`、`tests/http/runtime-status.test.ts`、`tests/http/status-ui.test.ts`。

**Interfaces:** RuntimeStatus.snapshot() 返回 spec 指定字段；GET /api/status 原样输出；validateSnapshot 接受不含 markets 的汇总数据，renderSnapshot 渲染现有 service/exchange 容器。

- [x] 更新测试：检查精确响应键、全部状态分类计数、无 markets；DOM fixture 从 HTML 提取实际 ID；混合计数与矛盾汇总、错误安全渲染；增加 4,000 市场五次端到端模拟刷新，记录每次耗时并断言 <10,000 ms 与响应 <10 KB。
- [x] 运行 `npm run build && node --test dist/tests/http/runtime-status.test.js dist/tests/http/status-ui.test.js`；确认旧实现因额外 markets、前端依赖 markets/已删除 DOM、响应过大而失败。
- [x] 删除 marketStatus 与 markets 映射；保留 counts、discovery、health、lastFatal。
- [x] 删除客户端明细验证、marketRows、筛选监听、表格 HTML 和专属 CSS；以三组总和校验替代按市场逐条核验，失败调用现有 invalid(field, expected, actual)。
- [x] 重跑同一定向命令，确认全部通过并记录刷新耗时。

## Task 2：文档与整体核验

**Files:** `README.md`、`docs/usage/operator-guide.md`、本 spec/plan 与相邻决策记录。

- [x] 同步 API 与操作说明：仅汇总，去掉逐市场查询/搜索承诺，保留持久状态与当前进程观测的区别。
- [x] 运行 `npm test`、`git diff --check`；只用上述安全 fixtures。
- [x] 复核受影响契约和边界，完成 verification-before-completion、consistency-check、post-verification-check；把改动带回用户当前工作区，不自动提交。

## 验证记录

基线：原始工作区定向构建和测试 exit 0，28 passed / 0 failed；2,000 已知市场旧响应约 1.39 MB；新增测试明确创建并断言 4,000 个已知市场。


- 红灯：定向 build exit 0、测试 exit 1，旧实现返回多余 markets，页面拒绝无 markets 的汇总；4,000 已知市场响应 2,770,509 bytes 超过 10 KB 断言。混合状态用例先补齐 repository 要求的成功覆盖证据，再确认仅因 markets 仍存在而失败。
- 绿灯：`PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH npm run build && PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH node --test dist/tests/http/runtime-status.test.js dist/tests/http/status-ui.test.js`，exit 0，35 passed / 0 failed；五次模拟刷新 48.7/42.9/50.3/36.6/36.5 ms，响应均为 925 bytes。
- 全量：`PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH npm test`，exit 0，1,717 passed / 0 failed / 0 skipped。全量并行负载中的五次性能样本为 211.8/65.8/70.3/61.7/53.5 ms。
- `git diff --check`，exit 0。
- 独立 risk_reviewer 只读审查未发现具体引入缺陷；复跑定向测试 exit 0，35 passed。ordinary complexity、indirect risk；指定旧模型名不可用，已披露替代为 gpt-5.6-sol/high。
- 真实浏览器：ego-browser 打开临时 loopback 服务器的 /status.html，服务器只用 fake gateways/sources 与内存 SQLite 的 4,000 合成市场。连续五次点击刷新→DOM 更新→requestAnimationFrame 为 1049.1/1042.4/1014.1/1019.2/1040.9 ms；stale=false，无明细表，页面截图确认布局正常。浏览器空间与临时服务均已关闭。
- 性能结论只适用于上述样本；repository 仍逐市场做严格校验，生产磁盘负载与网络未实测。

- 当前工作区回迁：12 个文件逐字节相同；重新运行上述构建与定向测试命令，exit 0，35 passed / 0 failed；五次刷新 53.6/37.3/37.1/40.7/39.2 ms，响应均 925 bytes。
- consistency-check：会话、纵向、跨产物、配置、文档均一致；API/页面/测试同步，旧 spec 标记局部替代，无新增配置。
- post-verification-check：共 8 项，核对前已勾选 7 项，本次新增勾选 1 项，剩余 0 项。实现阶段在当前工作区保留未提交改动。

## Main 整合

2026-10-14 用户后续明确要求合入 main，授权提交上述已完成改动。此时当前分支已是 main，采用直接本地提交；实施阶段“不自动提交”的限制由这次明确授权取代。提交前在当前工作区运行 `PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH npm test`，exit 0，1,717 passed / 0 failed / 0 skipped；`git diff --check` exit 0。
