# 账户设置归一化证据修复计划

## 依据与授权

用户于本次会话要求按 `fail-fast-with-evidence` 检查并修复 `marginMode: unknown` 的证据丢失。本修复落实已批准的 `2026-10-05-fail-fast-with-evidence-design.md` 第 4.2–4.4 节及其计划的网关、预检、执行诊断要求；不重新设计交易行为。main 单独写入 source/tests，最后独立只读审查。

## 范围与约束

- 检查 OKX/Bitget 账户设置归一化、预检/确认错误输出、执行前账户保护日志；不宣称完成全仓库穷尽审计。
- 沿用 TypeScript、Node.js、CCXT 4.5.68、node:test、现有 `ErrorEvidence` 及脱敏投影，无新依赖。
- 保留 `unknown`/`null` 的阻断语义及成功返回值。不能用默认 cross/isolated 放行空仓。
- 不把原来的无效设置返回改成异常，避免把执行保护的 `ACCOUNT_SETTINGS_CHANGED` 改为 `ACCOUNT_SETTINGS_UNAVAILABLE`。
- 复用 `AccountSettings` 的可选证据承载首个失败检查。无效字段原值、缺失状态和筛选持仓事实可见；证据只取指定字段，不复制完整 `info`、凭证、完整响应对象。
- `positionMode → marginMode → leverage` 保持优先级。失败后不读取后续账户字段、不继续预检价格/余额，不添加重试或副作用。
- 有效持仓的选择、杠杆冲突判断、交易状态转换、订单提交及恢复逻辑保持。已有合法策略记录仍按原有三项账户字段存储。
- 测试仅用模拟 gateway、合成字段、内存或临时 SQLite；禁止真实 `.env`、凭证、交易所 API、业务数据库。工作分支 `fix/account-settings-evidence`；实施阶段保留本地改动，用户后续明确授权提交并合并到本地 `main`，不推送。

## 实施步骤

### 1. 失败测试与风险矩阵

文件：`tests/exchanges/ccxt-gateway.test.ts`、`tests/strategy/hedge-coordinator.test.ts`、`tests/http/server.test.ts`。

- [x] RED：OKX 空列表、仅多头、零仓位、市场不匹配、无效数量必须区分；有效空头的 marginMode 缺失、null、空字符串、非法枚举不得都只显示 unknown。
- [x] RED：OKX/Bitget 非法持仓模式、缺失/非法杠杆输出原始字段和值；多个互斥原值逐个测试。保留现有合法值、冲突和执行分类断言。
- [x] RED：早期失败不读取后续字段；HTTP 422、确认阶段与执行保护日志保留证据；敏感键、配置秘密被脱敏，长证据末尾保留。
- [x] 构建并运行聚焦用例，记录因证据缺失而失败的结果。

### 2. 最小修复

文件：`src/domain/types.ts`、`src/exchanges/exchange-profile.ts`、`src/exchanges/profiles/{okx,bitget}-profile.ts`、`src/strategy/{preflight-service,hedge-coordinator}.ts`。

- [x] 在 `AccountSettings` 增加可选 `evidence?: ErrorEvidence`；通过现有 `diagnosticValue` 和 `redactEvidenceText` 表达选定字段，不遍历任意对象。
- [x] OKX 无有效空头时记录返回数、匹配市场数、有效持仓数和每行 symbol/side/contracts；归一化字段失败保留字段路径和原始值。原已抛出的杠杆错误补证据与解析 cause。
- [x] Bitget 按既有预检顺序产生第一项字段证据，在前项失败时不读取后续字段。
- [x] 预检的三个账户失败附带证据，确认阶段继续使用现有阶段转换与持久化投影；执行保护日志附带当前设置证据，保持原有 reason/state。
- [x] GREEN：更新旧的“只返回哨兵”断言以验证新增证据，保留原设置值、零副作用与秘密排除断言。

独立核对 CCXT 4.5.68 的 `okx.parsePosition` / `bitget.parseLeverage` 后，证据追加对应白名单 raw 字段：OKX `info.instId/posSide/pos/mgnMode/lever`，Bitget `info.marginMode/crossedMarginLeverage/isolatedShortLever`。只读 own data descriptor，访问器与 Proxy 显式标为不可读。OKX 在既有筛选回调捕获原始行索引，证据遍历使用内部数组，不读取外部数组的 `map/indexOf`。这些补充不改变接受条件。

### 3. 验证与审查

- [x] `npm run build`。
- [x] 使用已安装 Node 20.20.2 运行 exchange、preflight、confirmation、coordinator、HTTP 和 logging 相关测试。
- [x] `PATH=/Users/dayong/.npm/_npx/185e25162edaacfb/node_modules/node/bin:$PATH npm test`，以及 `git diff --check`。
- [x] 独立只读审查错误证据、秘密排除、失败顺序、执行分类及持久化兼容；修复确认的问题并验证。
- [x] `consistency-check`、`post-verification-check`；记录命令、退出码、结果及实际检查范围。

## 结果记录

实施前证据：`OkxProfile.fetchAccountSettings` 将持仓筛选无结果、非法 marginMode 均合并为 unknown；Bitget 的归一化函数丢弃非法字段原值；预检和执行保护只消费归一字段，无法恢复原因。既有已批准设计要求保留证据，因此本次补充这些遗漏。

| 阶段 | 精确命令 | exit | 关键结果 |
| --- | --- | --- | --- |
| 首批 RED | `npm run build`；`/Users/dayong/.npm/_npx/185e25162edaacfb/node_modules/node/bin/node --test --test-name-pattern='account evidence:' dist/tests/exchanges/ccxt-gateway.test.js dist/tests/strategy/hedge-coordinator.test.js dist/tests/http/server.test.js` | 0；1 | 38 项因证据丢失/后续字段被读取而失败；日志 `/tmp/trade-ops-account-evidence-red.log` |
| raw/安全读取 RED | `npm run build`；`/Users/dayong/.npm/_npx/185e25162edaacfb/node_modules/node/bin/node --test --test-name-pattern='account evidence: (pinned Bitget\|OKX retains raw\|OKX mode diagnostics\|discarded OKX)' dist/tests/exchanges/ccxt-gateway.test.js` | 0；1 | 5 项 raw 证据缺失、2 项 getter 导致错误分类变化；日志 `/tmp/trade-ops-account-evidence-raw-red.log` |
| 外部数组 RED | `npm run build`；`/Users/dayong/.npm/_npx/185e25162edaacfb/node_modules/node/bin/node --test --test-name-pattern='account evidence: OKX diagnostics do not call' dist/tests/exchanges/ccxt-gateway.test.js` | 0；1 | 2 项外部数组诊断方法 getter 被调用；日志 `/tmp/trade-ops-account-evidence-array-red.log` |
| 最终完整回归 | `PATH=/Users/dayong/.npm/_npx/185e25162edaacfb/node_modules/node/bin:$PATH npm test` | 0 | 构建成功，1662 tests / 1662 pass / 0 fail / 0 skipped，含新增 50 项；日志 `/tmp/trade-ops-account-evidence-full.log` |
| 补丁检查 | `git diff --check` | 0 | 无空白错误 |

所有执行均未读取真实 `.env`、凭证或业务数据库，未调用交易所 API。测试中 CCXT 实例仅运行本地解析方法；HTTP 使用 Fastify inject，浏览器使用已有 VM harness，数据库为测试专用内存/临时 SQLite。

独立 `risk_reviewer` 采用 gpt-5.6-sol / xhigh（工具不提供 AGENTS 中的 gpt-5.6 标识，已披露）。两项 Important 问题均经 RED/GREEN 修复：诊断字段 getter、外部数组 map/indexOf getter 会覆盖原失败。最终复审无剩余 Critical/Important；复审命令 `/Users/dayong/.npm/_npx/185e25162edaacfb/node_modules/node/bin/node --test dist/tests/exchanges/ccxt-gateway.test.js dist/tests/strategy/hedge-coordinator.test.js dist/tests/http/server.test.js` exit 0，626/626 pass；四类纯离线 getter probes 及 `git diff --check` exit 0。有效归一字段继续沿用锁定 CCXT 的既有解释，不改变接受条件。

一致性清单：

- ✅ 会话：落实用户要求的账户错误证据修复，未引入空仓放行、默认保证金或新交易行为，遵守本地测试边界。
- ✅ 纵向：本计划范围、接口、步骤、结果一致，unknown/null 继续表示不能确认。
- ✅ 横向：profile → AccountSettings.evidence → 预检/确认/HTTP/UI/执行日志一致；成功账户快照只保留原三个字段，既有 SQLite 成功数据合同不变。
- ✅ 配置：无新配置项、依赖或环境差异；Node 20.20.2 匹配现有 SQLite 原生模块。
- ✅ 文档：README、操作员说明与测试输出相符；未创建 PR，最终报告以当前本地 diff 为准。

结论：一致性通过。post-verification-check 重读全部 14 个 checkbox，原已完成 12 项，本轮关闭审查及一致性 2 项，剩余 0 项。修复完成时改动保留在 `fix/account-settings-evidence`；用户随后明确要求 commit 并合并到本地 `main`，集成结果以 Git 记录为准。
