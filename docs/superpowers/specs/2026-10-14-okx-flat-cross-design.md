# OKX 无有效空头时使用全仓设置

## 依据与范围

本次用户明确要求：仅当 OKX `positionMode` 已确认为 `hedged` 且不存在 symbol 匹配、contracts 为有限正数、side 为 `short` 的持仓时，将保证金模式视为 `cross`，继续预检及合约开空；有有效空头时继续从持仓读取并校验一致性。不得自动修改账户或杠杆，Bitget、确认锁和漂移拦截保持。

本设计替代 `2026-08-01-final-execution-safety-hardening-design.md` 第 5 节空仓规则及 `2026-10-14-account-settings-evidence.md` 中“无有效空头必须返回 unknown”的范围及相关测试要求；其余诊断、安全要求继续适用。沿用 `2026-10-02-ordered-preflight-confirmation-and-precise-errors-design.md` 的顺序预检与确认合同。

## 技术栈

全部沿用：Node.js >=20 / TypeScript（实现）、CCXT 4.5.68（绑定交易所适配器）、decimal.js（有限正数校验）、node:test（离线测试）、better-sqlite3（仅测试内存数据库）。版本以现有 package-lock.json 为准，无新增依赖或配置。

## 行为

1. 先读取持仓模式。不是 `hedged` 时立即返回原有失败，不读取持仓或杠杆。
2. 保持既有有效空头筛选条件。有有效空头时保持保证金模式、杠杆解析、缺失处理与冲突拒绝，不查询备用杠杆。
3. 无有效空头时选择 `cross`，只读调用 `fetchLeverage(exchangeSymbol, { marginMode: 'cross' })`。不能保留 `leverage: null` 放行，也不能凭空设置杠杆，因为余额预检、确认和执行保护都需要真实的有限正杠杆。
4. 返回的杠杆必须绑定同一 symbol，且非空 info 数组的每条原始 instId 必须与本轮市场 ID 一致，保证金模式必须为 cross，`shortLeverage` 必须为有限正数；失败沿用具体账户错误和安全字段证据，不继续读取价格/余额。网络错误保留原因，由现有上层分类。
5. 预检结果仍是三项账户设置；确认时重新读取并比较，执行前继续检查漂移。首次开仓后出现的有效空头必须与已确认设置一致。
6. 下单继续使用既有 `marginMode` → CCXT `tdMode` 转换和 `positionSide: short`，不调用 `setMarginMode`、`setPositionMode` 或 `setLeverage`。

## 方案选择与依据

采用在 OKX profile 的无有效空头分支读取全仓杠杆；完整满足请求且复用既有校验链。仅改 marginMode 会被下一项杠杆检查阻断；跳过杠杆检查或默认杠杆会改变资金校验和漂移合同，均不采用。无需修改协调器、确认服务或存储格式。

已核对本地锁定 CCXT 源码 `okx.fetchLeverage` / `parseLeverage`：查询参数转为 `instId` 与 `mgnMode`；cross 的 net 杠杆映射到 `shortLeverage`。`createOrderRequest` 将 `marginMode` 转为 `tdMode`。独立测试将拦截查询 transport 并运行真实 parser / request builder，不连接真实交易所。

## 验收与风险矩阵

| 场景 | 结果 |
| --- | --- |
| 空列表、仅多头、其他 symbol、零/负数/无效/非有限 contracts | cross + 只读查询得到的有效杠杆，后续预检可继续 |
| 有效 short（数值或字符串正数量）及无关持仓 | 仅使用有效 short，保留 cross/isolated 与一致性校验 |
| 模式 one-way/unknown | 不查询持仓或杠杆 |
| 杠杆查询返回错误 symbol / margin mode / 缺失或非法 shortLeverage | 精确拒绝，不读取价格/余额或下单 |
| 杠杆请求抛错 | 原因可见、无重试、无后续读取或下单 |
| 预检与确认均无有效空头 | 锁定 cross 与杠杆，开空订单携带 tdMode=cross、posSide=short |
| 确认前/执行前出现不同保证金模式或杠杆 | 既有漂移机制阻断 |
| Bitget、确认并发锁、已有持仓冲突 | 回归通过 |

所有验证仅使用假网关、拦截的 CCXT 请求、内存/临时数据库；不读真实 .env、凭证、数据库，不访问任何真实交易所 API。


审查修正：锁定 CCXT 的 safeSymbol 会在原始 instId 缺失或不识别时回退到请求市场。两处 gateway 账户读取入口须把本轮已捕获的 market ID 传给 profile，校验杠杆响应 info 中每条 instId 与之匹配，再读取模式/杠杆；无原始身份数据也拒绝。不从 symbol 推导 ID、不重新加载市场。覆盖真实 CCXT parser 回退、空原始信息、多行身份混杂和绑定快照 ID 的离线测试。
