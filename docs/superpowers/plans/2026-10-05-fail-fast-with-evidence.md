# Fail-fast 错误证据实施计划

> 执行方：采用单写入者和独立风险审查；根据用户对耗时的反馈，main 直接集中完成后续实现，减少代理等待与交接；保留 TDD 和必要验证。用户已确认推荐方案并继续实施，不重复请求实施授权。

**目标：** 修复已批准 spec 的 F1–F16，让同次失败输出保留具体检查、实际值、要求及脱敏后的原因链。

**架构：** 扩展现有错误工厂和日志投影。共享证据投影模块只负责安全提取与脱敏，领域模块负责提供精确的检查和值；UI 与持久化消费同一证据合同。

**技术栈：** TypeScript、Node 20、Fastify、CCXT 4.5.68、better-sqlite3、node:test；无新依赖。

## 全局约束

- 唯一新需求依据：`docs/superpowers/specs/2026-10-05-fail-fast-with-evidence-design.md`，已由用户批准。原领域设计的交易与状态不变量继续适用。
- 工作分支 `fix/fail-fast-evidence`；当前目录初始仅有本任务设计文档，无用户 source/tests 改动。
- 禁止真实 credentials、`.env`、交易所 API、业务 SQLite；使用注入环境、fake 和临时数据库。
- 同时仅一个 agent 修改 source/tests。只读调查/审查可以并行；child 不再委派，不提交或推送。
- 不修改交易状态转换、公式、重试资格/次数、事务顺序、恢复拓扑、权限规则和 SQL schema 版本。
- 旧记录不含新增可选证据时仍可读取。原错误码继续承担控制流职责，不以第三方消息判断业务状态。
- RED 必须为指定证据缺失而失败；GREEN 后跑受影响测试。更新旧“丢失证据”断言时保留全部秘密排除断言。
- 验证使用 Node 20（ABI 115）匹配 better-sqlite3；完整回归使用支持 CCXT CommonJS 依赖的较新 Node 20 补丁版，具体版本与路径在进度中记录。
- 不自动 commit、push 或合并；保留本地可审查 diff。

## 接口约定

Task 1 提供共享文件 `src/errors/error-evidence.ts`：

```ts
interface ErrorEvidence {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly status?: string | number;
  readonly body?: string;
  readonly cause?: ErrorEvidence;
  readonly errors?: readonly ErrorEvidence[];
}
function errorEvidence(error: unknown, secrets?: readonly string[], includeStack?: boolean): ErrorEvidence;
function redactEvidenceText(value: string, secrets?: readonly string[]): string;
function diagnosticValue(value: unknown): string;
```

`errorEvidence` 默认保留 stack，仅投影白名单数据属性，不执行 getter/Proxy/toJSON，支持 cause、AggregateError、外部 status/body。脱敏覆盖配置值、敏感键/鉴权内容和私钥文本；消息/原因链不因显示长度截断，循环用明确标记。

Task 1 在 `trade-ops-error.ts` 添加 `ErrorInput.evidence?: ErrorEvidence`、`ErrorDetail.evidence?: ErrorEvidence`，并扩展：

```ts
createTradeOpsError(input: ErrorInput, secrets?: readonly string[], options?: ErrorOptions): TradeOpsError;
projectTradeOpsError(error: TradeOpsError, secrets?: readonly string[], includeStack?: boolean): ErrorDetail;
```

工厂接受的 evidence 必须严格验证为普通数据树并冻结；不允许任意属性/访问器。旧无 evidence 的消息生成规则保持；有 evidence 时消息包含具体原因，仍由工厂唯一生成。`withErrorPhase` 保留原错误和堆栈；`projectTradeOpsError` 从内存 cause 构造安全证据，供 HTTP、日志和持久化共用。`safeFailureCategory` 可继续是控制/安全类别，不单独充当完整诊断。日志 `safeError` 委托共享投影。锁定 CCXT 源码核对证明多数异常仅有 name/message/stack；完整消息含远端 JSON 或 HTTP 状态，不能丢弃，也不能推断不存在的结构化字段或从可变 last_* 缓存补齐。上游已经丢失的状态/原因不得伪造。

## Task 1：共享证据投影和可信错误合同（F1、F2）

**文件：** 新增 `src/errors/error-evidence.ts`、`tests/errors/error-evidence.test.ts`；修改 `src/errors/trade-ops-error.ts`、`src/logging/logger.ts` 及对应 tests。

- [x] RED：合成 EACCES 与 ENOSPC、嵌套 cause、AggregateError、循环原因、非 Error 抛出值、末尾含证据的长消息、HTTP status/body；秘密/敏感键、恶意 getter/Proxy/toJSON 反例；工厂阶段转换与持久化 round-trip。
- [x] 运行：`npm run build && node --test dist/tests/errors/*.test.js dist/tests/logging/logger.test.js`，保存预期失败证据。
- [x] GREEN：实现上述接口；未知不可安全读取的字段明确标记；完整保留未敏感的证据；兼容旧合法 detail。
- [x] 同命令验证、主代理审核任务 diff，记录结果。

## Task 2：启动、HTTP、确认、浏览器输出（F1、F4、F5）

**文件：** `src/config/environment-loader.ts`、`src/main.ts`、`src/storage/sqlite-process-owner.ts`、`src/http/public-error.ts`、`src/http/server.ts`、`src/strategy/preflight-service.ts`、`src/strategy/confirmation-service.ts`、`public/app.js`；对应 config/main/http/strategy tests。

- [x] RED：给 fake loader/gateway/repository 注入有 cause/status/body 的错误；断言同一次返回/完成日志保留具体原因、秘密不出现；确认失败写库后重读证据；UI 断言网络原因、JSON/结构校验字段与大于 256 字符证据。
- [x] 运行：`npm run build && node --test dist/tests/config/*.test.js dist/tests/main.test.js dist/tests/storage/sqlite-process-owner.test.js dist/tests/http/*.test.js dist/tests/strategy/preflight-service.test.js dist/tests/strategy/confirmation-service.test.js`。
- [x] GREEN：各包装点传 `{ cause: error }`，HTTP/public projection 使用 Task 1 接口，完成日志保存完整安全堆栈。确认服务新增可选 `secretProvider: () => readonly string[]` 构造参数，main 注入现有配置值 provider，写入失效前投影；原始 cause 不落库。UI 严格验证可选 evidence 并以 textContent 展示，移除显示截断，保留失败清理。
- [x] 同命令验证；核对所有阶段转换、持久化重建和接口字段复制点没有漏掉 evidence；任务审查。

## Task 3：数量归一与订单快照（F6、F11 的网关部分）

**文件：** `src/domain/quantity-normalizer.ts`、`src/strategy/preflight-service.ts`、`src/exchanges/ccxt-exchange-gateway.ts`、`src/exchanges/exchange-gateway.ts`、相关 `src/exchanges/profiles/bitget-profile.ts` 直接错误；domain/preflight/gateway tests。

- [x] RED：请求 `1.5`、共同步长 `1`、swap minimum `1.5`、spot minimum `0`：必须报告 swap、实际 `1`、要求至少 `1.5`；另测归一到零、现货 minimum、上限裁剪后小于另一腿 minimum、计算资源限制，失败后无价格/余额读取。
- [x] RED：逐项改变返回订单的 exchange/client ID、symbol、type、side、requested/filled/remaining，断言具体字段、expected/actual 以及无额外提交。
- [x] GREEN：归一模块抛带 field/expected/actual 的领域错误，预检按真实失败字段映射既有码；只拆校验条件和补证据，不改数值计算。快照互斥检查逐项诊断；NoOrderSubmittedError 保留既有 reason 和控制意义，但携带导致未提交的原始 cause；基础数量换算错误也补齐 operands/actual。
- [x] 验证：`npm run build && node --test dist/tests/domain/quantity-normalizer.test.js dist/tests/strategy/preflight-service.test.js dist/tests/exchanges/ccxt-gateway.test.js dist/tests/exchanges/exchange-gateway.test.js`；任务审查。

## Task 4：对账和协调器（F10、F11、F12、F15、F16）

**文件：** `src/strategy/hedge-reconciliation-evidence.ts`、`src/strategy/hedge-reconciliation.ts`、`src/strategy/hedge-coordinator.ts`、必要的 `src/logging/logger.ts`/`trade-events.ts` allowlist；对应 strategy/logging tests。

- [x] RED：四种 local topology 失败各有 check/expected/actual；远端不一致有字段名；两次 lookup 失败原因均存在；snapshot validation 原因保持；规则各字段与量化 throw/非正/off-step 可区分；并发 rejection 可见。
- [x] GREEN：扩展现有 pending/observation 的可选证据并透传到当前同次失败事件。用 Task 1 投影输出，不泄漏 raw objects；不修改 reason/state/reconciliation 权限或 warn 去重规则；STATE_WRITE_CONFLICT 同次输出保留写入异常。对账为确认敞口而需要的其余独立观察继续遵循已批准完整对账规则，首个失败阻止策略/GTC 推进，不把观察集合改成提前退出。
- [x] 验证：`npm run build && node --test dist/tests/strategy/hedge-reconciliation.test.js dist/tests/strategy/hedge-coordinator.test.js dist/tests/strategy/order-monitor.test.js dist/tests/logging/*.test.js dist/tests/acceptance/hedge-opening.test.js`；任务审查。

## Task 5：SQLite 校验和事务异常（F7、F8、F9）

**文件：** `src/storage/sqlite-strategy-repository.ts`、`src/storage/sqlite-funding-rate-repository.ts`、必要的 repository 错误类型；storage tests。

- [x] RED：已有事务、列/索引/外键/schema 元数据差异、原始 SQLite 操作错误输出可区分；坏历史/策略记录定位到字段及两值；事务失败与回滚验证失败同时出现在 cause/聚合证据中，仓储继续 fail-closed。
- [x] GREEN：每个 schema/记录失败生成具体上下文，catch 保留 cause；确认 poison 保存原事务错误和回读错误；稳定状态转换和 SQL 执行顺序保持。
- [x] 验证：`npm run build && node --test dist/tests/storage/*.test.js dist/tests/strategy/confirmation-service.test.js`；任务审查。

## Task 6：资金费率记录、分页、重试与事件（F3、F13、F14）

**文件：** `src/funding-rates/funding-rate-record.ts`、`funding-rate-market-sync.ts`、`funding-rate-source.ts`、`funding-rate-exchange-worker.ts`、`funding-rate-events.ts`，必要的 discovery/source/sync-service 错误包装；funding-rate tests。

- [x] RED：rate/timestamp/identity/raw hash/page cursor/anchor 每个拒绝含实际证据；最后一次重试错误和之前原因存在于最终异常；大于 512 字节的安全证据完整；秘密和 headers 排除；失败页无持久化或下一页读取。
- [x] GREEN：稳定 failure code 与名义错误类型保持，补 cause 与具体校验值，事件复用共享投影并移除错误证据截断；不改变重试 observer 行为及次数。
- [x] 验证：`npm run build && node --test dist/tests/funding-rates/*.test.js dist/tests/storage/sqlite-funding-rate-repository.test.js`；任务审查。

## Task 7：完整验证、文档同步及最终审查

- [x] 扫描源目录的 catch/固定错误/显示截断，逐项对照 spec F1–F16；修复遗漏或记录可证明的保留理由。补充扫描已定位 exchange-registry 的 gateway identity 缺实际值、order-monitor 的 timer range 缺输入/上限；只补已有错误的证据，不增加校验条件。
- [x] 更新受影响旧 spec 的规则指向新 spec，补 README 中操作员错误行为，保持历史决定可追溯。
- [x] `PATH=/Users/dayong/.npm/_npx/185e25162edaacfb/node_modules/node/bin:$PATH npm test` exit 0；`git diff --check` exit 0；结果写入本计划（直接使用已安装 Node 20.20.2，与原 npm exec 命令运行时相同）。
- [x] 只读风险审查覆盖秘密泄漏、首错停止、重复提交、状态/SQL 顺序及旧数据读取；有缺陷先修复并跑覆盖检查。
- [x] `consistency-check` 与 `post-verification-check`，更新清单；最终报告改动、验证和剩余限制，不宣布未验证内容。

## 进度与证据

计划于 2026-10-05 基于用户已确认推荐方案制定；以下为按时间追加的执行记录；旧的“进行中”表示当时状态，最终状态以后文最终验证及清单为准。

- 初始基线：`PATH=/usr/local/bin:$PATH npm test` exit 1，1,443 项中 1,442 pass、1 fail。唯一失败为 pinned ESM NetworkError 测试中的 CCXT CommonJS 加载，Node 20.11.1 报 `ERR_REQUIRE_ESM`；正在使用 ABI 相同的新 Node 20 补丁版验证。

- 兼容运行时基线：`npm exec --yes --package=node@20.20.2 -- npm test` exit 0，1,443 tests pass，0 fail。运行时路径 `/Users/dayong/.npm/_npx/185e25162edaacfb/node_modules/node/bin/node`；输出 `/tmp/trade-ops-evidence-node20-baseline.log`。

- Task 1：初始 RED 构建成功，52 tests / 41 pass / 11 预期 fail（Node 20.11.1）；实现与 self-review 后 Node 20.20.2 聚焦 58 tests / 58 pass / 0 fail。实现报告 `.superpowers/sdd/evidence-task-1-report.md`，最终日志 `/tmp/trade-ops-evidence-task1-green.log`。只读审查进行中，尚未标记 Task 1 完成。

- Task1复审修复：Node20.20.2 build exit0；focused 67tests/67pass/0fail；scoped diffcheck exit0；裸Node默认formatter下真实stack保留和descriptor恢复探针exit0。固定patch `/tmp/trade-ops-evidence-task-1-rereview.patch`，独立复审进行中。

- Task1完成：Node20.20.2 build+focused73tests/73pass/0fail exit0，scoped diffcheck exit0；closure review Spec compliance Compliant、Task quality Approved。报告 `.superpowers/sdd/evidence-task-1-report.md` 与 `evidence-task-1-closure-review.md`，固定patch `/tmp/trade-ops-evidence-task-1-closure-review.patch`。同一stored evidence跨phase/native cause的重复展示留给最终质量审查；foreign prototype transplant限制已记录。

- Task2 GREEN：Node20.20.2 build exit0；focused471tests/471pass/0fail exit0；scoped diffcheck exit0，报告 `.superpowers/sdd/evidence-task-2-report.md`。固定增量包 `/tmp/trade-ops-evidence-task-2-review.patch`（15文件3610行）交独立风险审查，尚未标完成。

- Task3 RED：Node20.20.2 build exit0；focused339tests/296pass/43预期fail exit1，diffcheck exit0。报告 `.superpowers/sdd/evidence-task-3-red.md`；quantity、preflight、gateway、conversion仅测试改动，生产尚未实施。Task2审查3项Important正在返工准备。


## 最终验证与任务闭环（2026-10-05）

- 最终运行时：Node 20.20.2、npm 11.12.1、TypeScript 7.0.2，工具均已检查可执行。
- 完整命令：`PATH=/Users/dayong/.npm/_npx/185e25162edaacfb/node_modules/node/bin:$PATH npm test`。exit 0，构建成功；1584 tests / 1584 pass / 0 fail / 0 skipped，日志 `/tmp/evidence-full-final.log`。该完整检查包含 Task 2–6 所列全部测试路径。
- `git diff --check` exit 0。无新依赖或配置项；没有提交、推送或合并。
- Task 2 最终非法 ID 诊断由 Task 3 reviewer 关闭；Task 3 初次组合 GREEN 617/617。
- Task 4 RED 44 个缺证据失败，初次 GREEN 243/243；审查发现 arithmetic 固定顶层描述与实际 cause 矛盾，已去掉错误描述并新增 precision 1000012 回归。
- Task 5 RED 9 个失败，初次 GREEN 341/341；最终补齐元数据及 pragma readback，迁移双失败保持主错误码；仓储 poison 有相同错误/证据与零 SQL 断言，回读不一致分支有原 cause 回归。
- Task 6 初次 GREEN 328/328；unknown cursor 的不安全转换经 RED 修复，最终共享 formatter 与真实页回归证明零用户回调。双 worker fatal 事件分别保留原因，停止顺序不变。
- Task 7 初次 GREEN 523/523，状态关系/游标补充组合 GREEN 788/788；最终全量结果见上。
- `affected-path-review` skill 本机缺失；使用 `requesting-code-review` 和独立 `risk_reviewer` 检查整分支受影响路径，不跳过最终审查。最终报告：`.superpowers/sdd/evidence-whole-branch-review.md`。

### 最终扫描的覆盖与保留理由

| 发现 | 实现与验证对应 |
| --- | --- |
| F1、F2 | `error-evidence.ts` 安全投影；`trade-ops-error.ts` 可信原因链；环境、启动、HTTP、确认及日志测试覆盖脱敏和传播。 |
| F3、F13、F14 | 资金费率事件移除证据截断；耗尽异常保留有序失败；record/page/checkpoint 的诊断及失败后零 commit/下一页读取。 |
| F4、F5 | 浏览器网络/解析/字段诊断与完整纯文本展示；HTTP VM 测试覆盖长消息、恶意文本和失败状态清理。 |
| F6、F11 | 数量归一真实市场、有效数量及资源边界；网关快照字段和值；pre-create 与 post-create 提交确定性测试。 |
| F7、F8、F9 | schema、行、状态关系、SQL 原始 cause、迁移/恢复双失败和 poison；临时/内存 SQLite 测试。 |
| F10、F12、F15、F16 | 对账 topology、远端字段、规则/量化与协调器 rejection；保留所有独立观察和交易状态约束。 |

- 为保持可信工厂已存 evidence，增加 `projectErrorEvidence` 入口：日志和包含 `TradeOpsError` 的任意 cause/聚合树使用该入口；基础 `errorEvidence` 负责通用安全提取。各输出边界重新脱敏，HTTP/持久化去掉堆栈，同次失败日志保留安全堆栈。
- JSON 解析器可能把原始输入片段写入 SyntaxError；这些分支按敏感信息例外保留字段、类别、长度及安全位置，不输出原始 JSON/SQL/行正文。schema 的锁定定义检查报告对象和匹配事实，不复制完整 SQL。
- 观察器和日志 sink 的异常隔离保留：日志失败不得改变下单、重试或 SQL 状态，也不递归记录日志自身的失败。未知属性读取/投影失败使用明确不可读标记；领域 parse helpers 的 null 返回由调用方补具体字段和值。
- stale generation、主动取消、确定未提交等名义异常继续承担控制流；不以错误诊断改写 recovery、重试资格或状态转换。稳定 failure summary 不替代同次事件的完整诊断。
- 原 HTTP 请求快照的 8192 字节预算、输入长度合同、client order ID 的 SHA-256 截取保留；这些不是错误证据的展示截断。
- 只验证本地 fake、合成输入和临时数据库；没有探测真实 exchange API 或业务账户。锁定 CCXT 源码中不存在的 HTTP 字段不推断、不伪造。
- 已知运行时边界：将其他 VM realm 的原生 Error 人为重挂当前 realm 原型时，公开 API 无法完整证明其 stack formatter 所属 realm。仓库生产路径没有创建或接收该 VM 对象的入口；不将普通 getter/Proxy/formatter 回归的通过扩大为对此特殊构造的保证。


## 一致性与计划清单核验

- ✅ 会话：遵守用户已批准的推荐方案；没有恢复被否决的方案；遵守单 writer、无真实交易访问及本地 diff 的约束。
- ✅ 纵向：本计划、spec 及任务报告的历史状态与最终状态已区分；evidence、cause、稳定 code 和 stack 的术语一致。
- ✅ 横向：实现覆盖 F1–F16；新增可选证据已贯穿工厂、阶段转换、HTTP、UI、日志和确认失效持久化；无 PR/commit，因此没有待同步的 PR 描述。
- ✅ 配置：无新增环境变量、依赖或配置模板；验证使用现有 Node 20.20.2，不需要多环境配置同步。
- ✅ 文档：README/操作员说明与实际投影行为一致；两份旧 spec 明确错误规则的替代关系；相对文档链接检查无失效。
- 最终独立整分支风险审查：无 Critical、Important 或 Minor actionable finding；Task 4/5 的五项 finding 全部关闭。代码与测试 56 文件 hash 均与最终冻结包一致。
- Post-verification：总计 26 项；此前已勾选 9 项，本轮按实现、RED/GREEN 日志和审查结论新增勾选 17 项；未勾选 0 项。
- 结论：7 个 Task 已完成；全量验证为 1584/1584 pass；已知验证边界见上一节及独立审查报告。
