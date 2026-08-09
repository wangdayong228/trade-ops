# Bitget Classic v2 现货零最小数量兼容设计

## 1. 目标与已选方案

本设计采用用户已批准的**方案 A：仅兼容 Bitget Classic v2 现货**。

目标是在 `CcxtExchangeGateway.resolveMarket()` 解析 Bitget Classic v2 现货市场时，识别 CCXT 因上游废弃字段而映射出的特定零最小数量，并把应用使用的有效 `minimumAmount` 设为 `amountStep`。由此产生的 `minBaseAmount` 是**应用侧最小可表达正数量**，不是 Bitget 官方最小数量，也不得在代码、错误或文档中称为“官方最小量”。

该兼容只修复市场规则加载被 `limits.amount.min = 0` 阻断的问题。Bitget 官方以 `minTradeUSDT` 表达最低交易额；该限制仍通过现有 `minQuoteNotional`、预检和下单前二次校验完整保留。

## 2. 背景与证据

### 2.1 Bitget Classic v2 官方语义

Bitget Classic v2 `GET /api/v2/spot/public/symbols` 的示例现货对象包含：

```json
{
  "symbol": "BTCUSDT",
  "baseCoin": "BTC",
  "quoteCoin": "USDT",
  "minTradeAmount": "0",
  "quantityPrecision": "6",
  "minTradeUSDT": "1",
  "status": "online"
}
```

官方字段说明明确指出：

- `minTradeAmount`：最低订单数量，已废弃，应参考 `minTradeUSDT`；
- `quantityPrecision`：数量精度；
- `minTradeUSDT`：最低交易额，单位 USDT。

Classic v2 `POST /api/v2/spot/trade/place-order` 说明 `size` 的小数位由 Symbol Info 提供；它没有把 `quantityPrecision` 定义为官方最低下单数量。

### 2.2 CCXT 4.5.68 映射

本仓库锁文件当前解析到 CCXT `4.5.68`。其本地 `bitget.js` 的 Classic 默认市场路径：

- 现货调用 `/api/v2/spot/public/symbols`；
- `precision.amount` 由 `quantityPrecision` 经 `parsePrecision` 转成 `10^-quantityPrecision`；
- `limits.amount.min` 从 `minTradeNum` 或 `minTradeAmount` 取得；Classic v2 示例因此映射为 `0`；
- USDT 市场的 `limits.cost.min` 从 `minTradeUSDT` 取得；
- 原始交易所对象保留在统一市场的 `info` 中。

因此，`precision.amount = 0.000001` 表达数量步长，而 `limits.cost.min = 1` 表达最低 USDT 名义金额。不能把废弃的 `minTradeAmount = 0` 当作有效正最低数量，也不能把 `quantityPrecision` 冒充官方最低数量。

### 2.3 当前应用行为

`resolveMarket()` 当前要求 `selected.limits.amount.min` 为有限正十进制。值为 `0` 时，`decimalString(..., 'minimum amount limit')` fail-closed，导致符合上述映射的 Bitget Classic v2 现货无法加载。

后续链路已经分别承担所需职责：

- `amountStep` 控制可表达数量和共同数量归一化；
- `minBaseAmount` 控制基础资产数量下限；
- `minQuoteNotional` 控制最低 USDT 名义金额；
- `prepareCreateOrder()` 在真正调用 CCXT `createOrder` 前再次校验数量、精度和名义金额。

本设计只在 `resolveMarket()` 的特定元数据解释处兼容，不扩散例外。

## 3. 范围

唯一生产行为改动位于 `src/exchanges/ccxt-exchange-gateway.ts` 的市场解析边界，后续 TDD 主要修改 `tests/exchanges/ccxt-gateway.test.ts`。

兼容分支必须同时满足以下全部条件：

1. gateway 的 `exchangeId` **严格等于** `bitget`；
2. 请求的 `kind` **严格等于** `spot`；
3. 已选市场已经通过现有现货身份检查，且 `selected.quote` **严格等于** `USDT`；
4. `selected.info` 是非 `null`、非数组的普通可索引对象；
5. `selected.info.minTradeAmount` 是 `number` 或 `string`，可被安全解析为有限十进制，且数值**恰好等于零**；
6. `selected.limits.amount.min` 是 `number` 或 `string`，可被安全解析为有限十进制，且数值**恰好等于零**；
7. 已按现有规则解析出的 `amountStep` 是有限正数；
8. `selected.limits.cost.min` 是 `number` 或 `string`，可被安全解析为有限正数。

只有八项全部成立，才令：

```text
effective minimumAmount = amountStep
minBaseAmount = exchangeAmountToBase(amountStep, "1") = amountStep
minQuoteNotional = parsed selected.limits.cost.min
```

这里的双零一致性是必要条件：原始 Classic v2 对象和 CCXT 统一映射必须互相印证。任一来源单独为零都不足以放宽 fail-closed。

## 4. 安全解析契约

`selected.info` 的静态类型是 `unknown`。实现不得直接断言任意属性可信，也不得通过宽泛类型转换后无条件读取。

应使用局部、无副作用的窄化/解析逻辑：

1. 先验证值是对象、非 `null`、非数组；
2. 再以 `Record<string, unknown>` 读取**唯一需要的** `minTradeAmount`；
3. 只接受原始类型 `number | string`；
4. string 去除首尾空白后不得为空；
5. 使用与现有 `decimalString` 一致的精确十进制解析能力；
6. 要求结果有限，并以十进制数值比较 `eq(0)`，不得使用 JavaScript `Number(...)`、真假值或字符串字面量比较决定零。

允许的原始零示例包括：`0`、`-0`、`"0"`、`"0.0"`、`" 0e10 "`。它们均是精确十进制零。拒绝：`undefined`、`null`、`""`、仅空白、布尔值、对象、数组、`NaN`、`Infinity`、`"NaN"`、`"Infinity"` 和畸形十进制。

统一 `limits.amount.min` 使用同样的数值零判定。`amountStep` 与 `limits.cost.min` 则必须通过现有有限正十进制契约；零、负数、非有限、缺失和畸形值均拒绝。

辅助逻辑只服务于此兼容判定；不新增公共领域类型、`source` 字段或通用交易所元数据框架。

## 5. 市场规则解析决策

### 5.1 决策顺序

`resolveMarket()` 的顺序固定为：

1. 按现有逻辑选择并验证 active、USDT、spot/swap 身份；
2. 按现有逻辑将 `selected.precision.amount` 解析为有限正 `amountStep`；
3. 检查是否满足第 3 节的全部 Classic v2 兼容条件；
4. 若满足，使用 `amountStep` 作为有效 `minimumAmount`；
5. 若不满足，继续调用现有的正数 `minimum amount limit` 解析逻辑；因此零值及其他无效值照旧抛错；
6. 按现有逻辑计算 `minBaseAmount`、最大数量范围、价格步长和 quote-notional 范围；
7. 返回现有 `MarketRules` 结构。

### 5.2 非零 minimum

`selected.limits.amount.min` 为有限正数时，完全保留当前逻辑，不读取 `info.minTradeAmount` 来覆盖它。即使原始 `minTradeAmount` 为 `0`，统一 minimum 只要非零，就使用该统一正值。

该规则防止兼容分支覆盖 CCXT 后续修复、交易所新字段或测试注入的可信正最小数量。

### 5.3 Quote-notional 保留

兼容成立要求 `limits.cost.min` 已存在且为有限正数，并继续原样形成 `minQuoteNotional`。不得因为把有效 `minimumAmount` 设为 `amountStep` 而删除、置零、替换或弱化最低名义金额。

`limits.cost.max` 与 amount 最大值仍按现有逻辑解析和比较。若最小名义金额大于最大名义金额，继续 fail-closed。

## 6. 数据流

```text
CCXT loadMarkets()
  -> 选择 active Bitget BTC/USDT spot
  -> 验证 TICK_SIZE precision mode
  -> precision.amount 解析为 amountStep (> 0)
  -> 安全读取 info.minTradeAmount
  -> 同时验证 raw min = 0、unified amount.min = 0、USDT、cost.min > 0
      -> 全部满足：effective minimumAmount = amountStep
      -> 任一不满足：走原有 positive minimumAmount 解析（零/无效即拒绝）
  -> contractSize = 1
  -> minBaseAmount = effective minimumAmount
  -> cost.min 解析并保留为 minQuoteNotional
  -> 返回不变的 MarketRules
  -> quantity normalizer 按 amountStep 计算共同可表达数量
  -> preflight 按 minQuoteNotional 与参考价验证名义金额
  -> prepareCreateOrder 再校验 minBaseAmount、精度与 minQuoteNotional
  -> 只有全部通过才调用 CCXT createOrder
```

该数据流不新增缓存或持久化，也不改变市场快照向预检和下单链路的传递方式。

## 7. 错误处理与 fail-closed

兼容判定不是“遇到零就修正”。以下情况必须继续沿现有 `resolveMarket()` 错误路径拒绝市场：

- exchange 不是 Bitget；
- kind 不是 spot，包括 Bitget swap；
- quote 不是 USDT；
- `selected.info` 缺失、为 `null`、数组或其他非对象；
- `info.minTradeAmount` 缺失、空、类型不符、畸形、非有限、负数或正数；
- `limits.amount.min` 缺失、空、畸形、非有限、负数或正数以外的情况；其中正数按原逻辑接受，只有零才需要兼容证据；
- raw minimum 与 unified minimum 不同时为精确零；
- `amountStep` 缺失、零、负数、畸形或非有限；
- `limits.cost.min` 缺失、零、负数、畸形或非有限；
- 其他现有市场身份、范围或精度校验失败。

错误继续使用现有同步抛错/Promise rejection 语义。兼容判定失败时不应吞掉异常、猜测默认值或返回部分 `MarketRules`。`createOrder()` 仍把所有提交前准备失败包装为 `NoOrderSubmittedError`，且不得调用 CCXT `createOrder`。

## 8. 不变项

以下组件和行为明确不变：

- 不修改 `MarketRules` 类型，不新增 `source`、compatibility 或 provenance 字段；
- 不修改 `src/domain/quantity-normalizer.ts`；
- 不改变共同步长、向下取整、最大数量或零数量拒绝行为；
- 不修改 `src/strategy/preflight-service.ts`；
- 不改变 spot/contract 各自参考价下的最低/最高名义金额检查；
- 不改变 `prepareCreateOrder()` 的基础数量校验、`amountToPrecision` 精确一致性检查、ticker 选择或 quote-notional 二次校验；
- 不改变订单参数、市场买入/卖出语义、client order ID、恢复拓扑或响应归一化；
- 不改变数据库 schema、事务、写入时序或任何 SQLite 行；
- 不改变 OKX 的任何规则；
- 不兼容 Bitget swap、future、margin 特例或未来 UTA 市场结构。

## 9. 非目标

- 不声明 Bitget 存在等于 `amountStep` 的官方最低基础资产数量。
- 不根据当前价格推导动态最低数量；官方最低约束仍是 USDT 名义金额。
- 不直接解析 `quantityPrecision` 来重建 step；使用已经由 CCXT 映射并经应用校验的 `precision.amount`。
- 不兼容任意交易所的 `limits.amount.min = 0`。
- 不以 symbol 命名、字段巧合或 `info` 中任意其他属性猜测 Classic v2。
- 不支持或提前设计 Bitget UTA；UTA 需要独立官方证据、spec 和测试。
- 不升级、patch 或 fork CCXT。
- 不新增依赖、配置开关、日志事件、指标、数据库字段或运维文档改动。
- 不访问真实交易所、真实账户、真实凭证或真实业务 SQLite。

## 10. TDD 测试矩阵（RED → GREEN）

后续实现先在 `tests/exchanges/ccxt-gateway.test.ts` 添加失败测试并确认因当前零 minimum 拒绝而 RED，再做最小生产改动使其 GREEN。

### 10.1 正向兼容

1. Bitget spot、USDT、raw `minTradeAmount: "0"`、unified `amount.min: 0`、正 `precision.amount`、正 `cost.min`：`loadMarket()` 成功，`minBaseAmount === amountStep`，`minQuoteNotional` 保留。
2. raw minimum 为 number `0`：同样成功。
3. raw 与 unified minimum 使用其他精确零表示（如 `"0.0"`、`-0`），仍只按十进制数值零处理。
4. `createOrder()` 使用该市场时：低于 `amountStep` 或不能精确表示的数量在 CCXT create 调用前拒绝；满足 step 但低于 `minQuoteNotional` 的订单在 create 调用前拒绝；满足两者时保持既有提交参数。

### 10.2 非零与隔离

5. Bitget spot 的 unified `amount.min` 为有限正数时，继续使用该正数，不被 raw zero 覆盖。
6. OKX spot 的 unified zero 即使伪造相同 `info` 也继续拒绝。
7. Bitget swap 的 unified zero 即使 `info.minTradeAmount` 为零也继续拒绝。
8. 非 USDT Bitget spot 不进入兼容分支（现有市场选择本身应拒绝）。
9. 模拟 UTA/非 Classic 原始对象（缺少明确 Classic 零字段）继续拒绝。

### 10.3 fail-closed 参数矩阵

10. `info` 分别为 `undefined`、`null`、数组、字符串、数字：拒绝。
11. raw `minTradeAmount` 分别为缺失、空字符串、空白、`null`、布尔、对象、数组、负数、正数、`NaN`、`Infinity`、对应字符串和畸形字符串：零 unified minimum 不得被兼容。
12. unified `amount.min` 分别为缺失、空、负数、`NaN`、`Infinity`、畸形值：拒绝。
13. `precision.amount` 分别为缺失、零、负数、`NaN`、`Infinity`、畸形值：即使双零和正 cost 同时存在也拒绝。
14. `limits.cost.min` 分别为缺失、零、负数、`NaN`、`Infinity`、畸形值：即使双零和正 step 同时存在也拒绝。
15. raw zero 但 unified positive：使用 unified positive；raw positive/invalid 但 unified zero：拒绝。
16. 保留既有最大数量、quote-notional 范围和 precision mode 失败测试。

### 10.4 下游回归

`tests/domain/quantity-normalizer.test.ts` 已覆盖零市场 minimum、step、边界和共同数量行为；本设计不要求改动归一化器测试。`tests/strategy/preflight-service.test.ts` 已覆盖名义金额最小值边界；本设计不要求改动预检测试。若实现过程中发现现有覆盖无法证明“不变项”，只允许在后续 plan 明确批准后增加回归断言，不得改变这些模块的生产行为。

每个 RED 测试必须因本设计指定的缺失行为失败，而不是 fixture 身份错误或无关异常。GREEN 后运行聚焦 gateway 测试，再运行仓库批准的完整验证命令。

## 11. 安全边界

- 所有测试使用 `CcxtExchangeLike` fake 和内存 fixture；不得构造生产 gateway 以加载凭证。
- 不读取 `.env`，不打印、复制或推断凭证。
- 不调用 Bitget、OKX 或任何真实交易所 API，包括公开行情接口。
- 不提交、取消订单或改变账户设置、杠杆、仓位模式。
- 不读取或写入真实业务 SQLite；本改动本身不得产生任何数据库访问。
- 对外部 `info` 和统一市场数值一律视为不可信输入；只有严格同时满足白名单条件才应用兼容。
- 任何不确定性都回到现有 fail-closed 路径，不扩大订单放行面。

## 12. 实施边界

最小实现应仅包含：

1. `ccxt-exchange-gateway.ts` 内部用于安全识别 Classic v2 双零证据的私有局部逻辑；
2. `resolveMarket()` 中选择有效 `minimumAmount` 的窄分支；
3. `ccxt-gateway.test.ts` 中上述 TDD 矩阵的必要 fixture 和断言。

不得借机重构 gateway、抽象所有交易所规则、修改领域接口或移动现有校验职责。若后续实现发现必须突破这些边界，应停止并回到 spec 审批，而不是自行扩大范围。

## 13. 完成标准

后续实现只有同时满足以下条件才可视为符合本设计：

- 合法 Bitget Classic v2 USDT 现货双零映射能成功加载；
- 返回的 `amountStep` 不变，`minBaseAmount` 等于该 step，并明确只代表应用侧最小可表达正数量；
- 正 `limits.cost.min` 被原样保留为 `minQuoteNotional`；
- 最低 USDT 名义金额仍在预检和 `prepareCreateOrder()` 中校验；
- 非零 unified minimum 完全保持原逻辑；
- 任一白名单条件不满足时继续 fail-closed；
- OKX、Bitget swap 和未来 UTA 不获得该兼容；
- `MarketRules`、归一化器、preflight、createOrder 二次校验和数据库均无行为扩展或弱化；
- RED 测试先因目标行为缺失而失败，最小改动后 GREEN；
- 聚焦测试和仓库完整验证通过，且未触达真实凭证、交易所或业务数据库；
- spec、后续 plan、代码和测试对“应用侧最小可表达正数量”及适用条件表述一致。

## 14. 参考资料

- Bitget Classic v2 — Get Symbol Info：<https://www.bitget.com/api-doc/classic/spot/market/Get-Symbols>
- Bitget Classic v2 — Place Order：<https://www.bitget.com/api-doc/classic/spot/trade/Place-Order>
- 本地 CCXT 4.5.68：`node_modules/ccxt/js/src/bitget.js`，`fetchMarkets()` / `fetchDefaultMarkets()` 的 Classic 现货解析与 unified market 映射
- 应用市场解析：`src/exchanges/ccxt-exchange-gateway.ts`，`decimalString()` / `resolveMarket()` / `prepareCreateOrder()`
- 数量归一化：`src/domain/quantity-normalizer.ts`
- 预检名义金额：`src/strategy/preflight-service.ts`
