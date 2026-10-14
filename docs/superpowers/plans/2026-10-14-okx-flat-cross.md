# OKX 无有效空头全仓设置实施计划

> 使用 executing-plans 在当前会话执行，main 是 source/tests 的唯一写入者。

**目标：** 落实本次用户明确的 OKX 默认 cross 行为，并通过只读杠杆查询保证后续预检、确认和开空可完成。

**依据：** `../specs/2026-10-14-okx-flat-cross-design.md`；用户本次修改指令授权实现其行为，具体只读查询是保留现有正杠杆前置条件所必需的实现。

**架构：** 改动限定在 OKX profile 的无有效空头分支、CCXT 接口可选查询参数和已捕获市场 ID 的传递。复用确认、执行保护及订单参数转换。

**技术栈：** 沿用 Node.js >=20、TypeScript、CCXT 4.5.68、decimal.js、node:test、better-sqlite3，无新依赖。

## 约束

- 保持 positionMode → marginMode → leverage 首错顺序，所有外部查询只读。
- 不使用真实凭证、.env、业务数据库或任何真实交易所 API。
- 不更改 Bitget、确认锁、漂移比较、数量算法、存储格式。
- 在当前干净 checkout 的独立分支实施；用户后续明确授权提交并合并到本地 main，不推送。

## Task 1：实现并验证全仓备用读取

文件：`src/exchanges/profiles/okx-profile.ts`、`src/exchanges/ccxt-exchange-gateway.ts`、`src/exchanges/exchange-profile.ts`、`tests/exchanges/ccxt-gateway.test.ts`、README、`docs/usage/operator-guide.md`。

- [x] RED：调整旧空仓阻断测试，覆盖 spec 风险矩阵、查询参数与调用顺序、精确失败证据；离线运行 CCXT parser 和 request builder；添加真实预检/确认/协调器 + 内存 SQLite 链路及漂移测试。
- [x] 运行 `npm run build && node --test dist/tests/exchanges/ccxt-gateway.test.js`，确认新增行为因 unknown 或缺少全仓杠杆读取失败。
- [x] GREEN：为 `CcxtExchangeLike.fetchLeverage` 增加可选 params；在无有效空头分支只读查询 cross，校验返回 symbol、marginMode 和 shortLeverage；保留有效空头分支和错误证据。
- [x] 同步 README 与 operator-guide，说明默认 cross 与真实正杠杆要求、失败情况和原有漂移保护；旧计划注明适用范围被替代。
- [x] 运行定向测试及 `npm test`，记录命令、exit status、通过数量；完成独立只读代码审查，处理实证问题。
- [x] 完成 consistency-check 与 post-verification-check，核对所有勾选与实际产物，报告剩余限制。

## 执行证据

实施前：`OkxProfile.fetchAccountSettings` 无有效空头返回 unknown/null；`confirmedAccountSettings` 强制要求正杠杆，因此单独改 marginMode 不完整。锁定 CCXT 的 `fetchLeverage` 支持显式 cross；`createOrderRequest` 已有 tdMode 映射。TypeScript 7.0.2 可用。初始 Node v26.0.0 与现有 better-sqlite3 的 ABI 115 不匹配；改用已安装的 Node v20.19.4，内存 SQLite 检查通过，不变更依赖。


- 基线：`npm run build && node --test --test-reporter=dot dist/tests/exchanges/ccxt-gateway.test.js`，exit 0。
- RED：构建 exit 0；`/Users/dayong/.nvm/versions/node/v20.19.4/bin/node --test dist/tests/exchanges/ccxt-gateway.test.js`，exit 1，313 项中 44 项失败，核心原因为无有效空头仍返回 unknown，未查询全仓杠杆。
- GREEN：`PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH npm run build && /Users/dayong/.nvm/versions/node/v20.19.4/bin/node --test dist/tests/exchanges/ccxt-gateway.test.js`，exit 0，313/313 通过。
- 完整回归：`PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH npm test`，exit 0，1701/1701 通过、0 skipped。
- `git diff --check`，exit 0。
- 测试夹具纠正：执行前漂移的既有行为是保留 EXECUTING、无 failureCode、记录 `hedge_submission_guard_changed` 且不创建订单；新测试已按源码及既有回归测试验证这一合同，不改变生产逻辑。


审查修正：锁定 CCXT 的 safeSymbol 会在原始 instId 缺失或不识别时回退到请求市场。两处 gateway 账户读取入口须把本轮已捕获的 market ID 传给 profile，校验杠杆响应 info 中每条 instId 与之匹配，再读取模式/杠杆；无原始身份数据也拒绝。不从 symbol 推导 ID、不重新加载市场。覆盖真实 CCXT parser 回退、空原始信息、多行身份混杂和绑定快照 ID 的离线测试。

- 审查 P1 的 RED：构建 exit 0；`/Users/dayong/.nvm/versions/node/v20.19.4/bin/node --test --test-name-pattern='OKX cross fallback: (rejects raw instrument|requires raw instrument|raw instrument check)' dist/tests/exchanges/ccxt-gateway.test.js`，exit 1，8 个身份校验用例因 Missing expected rejection 失败，1 个合法绑定用例通过。
- 修正后完整回归：`PATH=/Users/dayong/.nvm/versions/node/v20.19.4/bin:$PATH npm test`，exit 0，1710/1710 通过、0 skipped；空 info 数组的诊断另外明确为 array length=0。


## 最终审查与一致性

独立 risk_reviewer 使用 gpt-5.6-sol / xhigh 完成只读审查，提出的唯一 P1（归一化 symbol 掩盖原始 instId 不匹配）已按失败测试修复并复核。原复现现返回 ACCOUNT_SETTINGS_CONFLICT，身份定向测试 9/9 通过，无新增 actionable finding。最终源码（包含 array length=0 诊断）再次执行上述完整 npm test，exit 0，1710/1710，0 skipped。

Consistency Checklist：
- ✅ 会话：遵循本次默认 cross、有效空头优先、只读设置查询要求；未恢复被拒绝的默认杠杆/跳过检查做法；交易安全边界保持。
- ✅ 纵向：本 spec/plan 的范围、行为、风险矩阵与结果一致；symbol、原始 market ID、保证金模式和杠杆含义一致。
- ✅ 横向：实现与计划一致；ExchangeProfile 新增 market ID 已传递到两处调用者；Bitget 接收额外参数但行为未改；未创建 PR，无描述偏差。
- ✅ 配置：无新增配置、环境变量或依赖，现有模板无须调整；验证使用匹配 SQLite ABI 的 Node20.19.4。
- ✅ 文档：README/operator-guide 与最终默认 cross、真实正杠杆要求、原始市场身份校验一致；旧 spec/plan 的空仓规则注明已被替代。

post-verification-check：逐项重读计划并核对代码、测试输出和审查结果。共 6 个复选框，原已勾选 4 个，本次勾选 2 个，剩余 0 个。

验证仅覆盖离线假网关、内存/临时数据库及锁定 CCXT 的本地转换逻辑；没有访问真实交易所、凭证、.env 或业务数据库。实施完成时先保留本地分支 fix/okx-flat-cross 供查看；用户后续明确授权 commit 并合并到本地 main，按 finishing-a-development-branch 执行，合并后再运行完整回归，不推送。
