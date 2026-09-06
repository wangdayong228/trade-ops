# Bitget 与 OKX 资金费率历史同步设计

## 1. 文档状态与适用范围

本设计已于 2026-09-06 经用户确认。用户进一步授权：后续设计项若能够由现有源码、官方接口语义和已确认不变量证明正确，则按正确性原则自动确认；证据不足或存在业务取舍时必须停止并请求裁决。

本文件是“获取 Bitget 与 OKX 所有 active USDT 线性永续合约的已结算资金费率并存入 SQLite”任务唯一适用的 design。仓库中其他 `docs/superpowers/specs/` 文件不适用于本任务，也不因本设计而失效。本设计没有替代既有资金费率 spec，因为仓库此前不存在该功能的 spec 或实现。

后续 implementation plan、代码、测试和运维文档必须以本设计为目标行为依据。若实现需要扩大交易所、市场类型、数据口径、接口或页面范围，必须先修改本设计并重新确认。

2026-09-06 implementation-plan 风险审查证明：锁定的 CCXT 4.5.68 `loadMarkets(true)` 会额外加载 currencies，并在 Bitget/OKX 内部通过 `Promise.all` 并发加载多个非目标市场类别，无法满足本设计的“同一交易所最多一个实际公共请求”、逐请求限流/重试和精确请求日志不变量。依据用户已授权的正确性自动确认，本设计改为使用同一无凭证 CCXT client 的 generated raw 公共方法各执行一个目标产品发现请求；该变更不扩大交易所或市场范围。

2026-09-06 Task 7 风险审查复现：只比较 `incremental_generation` 而不持久化任务启动时的冻结边界，会接受复制后伪造 `frozenBoundaryMs` 的 data-only lease，并可能在真实边界出现前静默结束增量任务。依据同一正确性授权，本设计将 `incremental_frozen_boundary_ms` 纳入 generation-scoped 持久 task provenance；所有资格、页面和终态入口必须比较完整 provenance。

2026-09-06 Task 8 外部源码核对证明：重试边界依赖 CCXT `4.5.68` 的 ESM `NetworkError` 原型身份和该版本的继承树，而运行时导出的版本字符串存在上游不一致，不能作为绑定证据。依据同一正确性授权，`package.json` 与 `package-lock.json` 的直接依赖声明都必须精确固定为 `4.5.68`；生产和测试必须从同一 ESM 入口导入错误类型，不得接受 caret 漂移、CommonJS 交叉实例或仅同名的伪造错误。

同次 Task 8 仓库调查还固定三个生命周期边界：`stop()` 一旦被调用，后续 `start()` 永久 no-op 且不得访问 repository；discovery 已排队或运行时到来的周期 tick 只由同一去重 key 合并，不累计补偿任务，完成后由下一正常 tick 再调度；两个 worker 都报告内部 fatal 时，服务在双 root 完全 quiescent 后按固定 `bitget`、`okx` 顺序选择首个错误上报。

## 2. 目标

在现有单进程 trade-ops 服务中新增一条与交易执行隔离的只读资金费率同步链路：

1. 发现 Bitget 与 OKX 当前明确 active 的 USDT 线性永续合约；
2. 对每个目标合约回填交易所当前公共历史接口能够返回、且位于本次固定覆盖截止时间以内的全部已结算资金费率；
3. 每个合约完成回填后，每小时增量同步新的已结算记录；
4. 通过精确十进制、幂等写入、已观察修订留痕、分页覆盖状态、周期复核和断点恢复，避免把漏数、重复、修订或失败误报为完整；
5. 使用现有 SQLite 文件中的独立表持久化，不改变任何对冲状态、订单行为或交易账户设置。

“全部历史”在本设计中只表示：**已经按对应交易所的终止规则成功遍历本次接口可见范围，并且完整性声明只截止到该任务开始前固定、持久化的 cutoff**。cutoff 之后的已结算记录即使被顺带保存，也不属于该次声明。Bitget 未公开历史保留期；OKX 只公开最多约三个月历史，且未明确是滚动 90 天还是三个自然月。因此系统不得宣称覆盖合约上市以来的绝对完整历史或服务端未返回的数据。

## 3. 已确认的业务口径

### 3.1 交易所与市场

- 交易所固定为 `bitget` 与 `okx`。
- 只接受由 raw 产品配置按锁定 CCXT 语义构造、且同时满足以下条件的市场观察：
  - `active === true`；
  - `swap === true`；
  - `future === false`；
  - `contract === true`；
  - `linear === true`；
  - `inverse === false`；
  - `quote === "USDT"`；
  - `settle === "USDT"`。
- `active` 缺失或无法证明为 `true` 时不得猜测为 active。
- 每轮重新发现市场。新出现的目标合约进入回填；已经纳入回填的合约即使后来变为 inactive，也继续完成其仍可获取的历史和最后一次全范围复核，成功后不再执行增量或周期复核。
- 已完成最后复核的市场后来又被明确观察为 active 时，视为重新激活：在市场发现事务中清除“inactive 最后复核已完成”标记并设置“重新激活全范围待完成”，重新执行专用 reactivation 全范围任务；只有该任务成功后才恢复增量与周期复核。
- 某个既有市场从本轮 raw 产品配置响应中消失时，不得据此猜测其已下线；本轮市场发现标记为不完整，保留已有状态并在后续重试。

### 3.2 数据类型

- 只保存历史接口返回的**已结算资金费率**。
- 不采集、不保存当前预计费率、下一期预测费率或实时未结算快照。
- Bitget 使用历史记录的原始 `fundingRate`。
- OKX 使用历史记录的原始 `realizedRate`；不得把同一响应中的预测 `fundingRate` 当作已结算费率。
- 费率保持交易所返回的十进制字符串表示，先用 `decimal.js` 严格验证为有限十进制，再原样保存其去除首尾空白后的字符串；不得经过 JavaScript `number` 再写库。
- 资金费率允许为正数、零或负数；缺失、空白、非字符串、畸形或非有限值一律拒绝，绝不转换为 `0`。
- 结算时间必须是可解析为非负安全整数的 Unix 毫秒时间戳，并能转换为有效 UTC 时间。

### 3.3 保留与访问

- 首期不自动删除已结算记录、修订记录或同步状态。
- 使用现有 `TRADING_DATABASE_PATH` 指向的 SQLite 文件，但使用独立资金费率表。
- 首期不新增页面、HTTP 查询接口、导出接口或通知系统。
- 通过结构化运行日志和 SQLite 同步状态提供可诊断性。
- revision 表只保证保存应用再次观察到的内容变化。active 市场通过周期性全范围复核扩大可观察范围；inactive 市场完成最后一次复核后不再请求，因此系统不得宣称能够发现交易所在停止同步后才发生的修订。

## 4. 外部语义证据与限制

仓库通过 `package.json` 和 `package-lock.json` 的精确直接依赖共同锁定并安装 CCXT `4.5.68`。两家交易所均有公共历史资金费率接口，但分页规则不同，且当前 CCXT 自动分页不能证明满足本设计的完整性要求。错误分类以该版本 ESM 源码和类原型为准，不使用 CCXT 运行时导出的版本字符串。

### 4.1 Bitget Classic V2

- 市场发现使用公共端点 `GET /api/v2/mix/market/contracts`，只传 `productType=USDT-FUTURES` 且不传可选 symbol。该端点当前没有 cursor、page 或 limit 参数，一次返回该 product type 的接口可见产品列表；当前限流为 20 次/秒/IP。
- 使用公共端点 `GET /api/v2/mix/market/history-fund-rate`。
- `symbol` 与 `productType` 必填。
- `pageNo` 为页码；`pageSize` 默认 20、最大 100。
- 官方未说明保留期、最大页号、稳定快照语义和结果排序。
- 请求无需认证；官方当前说明限流为 20 次/秒/IP。
- CCXT `fetchFundingRateHistory(..., { paginate: true })` 使用页码自动分页，但永久保存页码断点会因新结算记录插入导致页面位置漂移，不能作为跨进程恢复依据。

### 4.2 OKX V5

- 市场发现使用公共端点 `GET /api/v5/public/instruments`，只传 `instType=SWAP`。该端点当前没有 cursor、page 或 limit 参数，一次返回该 instrument type 的接口可见 open-contract 列表；当前限流为 20 次/2 秒，规则为 IP + Instrument Type。
- 使用公共端点 `GET /api/v5/public/funding-rate-history`。
- `instId` 必填。
- `after` 用于请求比给定 `fundingTime` 更旧的数据；每页 `limit` 最大 400。
- 官方说明最多返回约三个月历史；精确日历边界未明确。
- 请求无需认证；官方当前说明限流为 10 次/2 秒，规则为 IP + Instrument ID。
- CCXT `fetchFundingRateHistory(..., { paginate: true })` 在 `4.5.68` 中以固定 `8h` 构造分页窗口。OKX 支持动态 1/2/4/8 小时周期，因此该自动分页对短周期合约可能跳过时间区间，不得使用。

### 4.3 结论

生产实现继续使用 CCXT 的 generated raw 公共请求方法、`safeCurrencyCode`、HTTP 请求基础设施、错误类型和基础限流能力，但不使用 `loadMarkets/fetchMarkets`。Bitget、OKX 两个专用适配器显式控制单次市场发现、历史单页请求、字段解析、覆盖检查和断点语义。不引入两家交易所的官方 SDK，也不自行实现底层 HTTP 客户端。

参考资料：

- Bitget 历史资金费率：<https://www.bitget.com/api-doc/classic/contract/market/Get-History-Funding-Rate>
- Bitget 合约配置：<https://www.bitget.com/api-doc/classic/contract/market/Get-All-Symbols-Contracts>
- Bitget 公共接口说明：<https://www.bitget.com/api-doc/classic/quickStart/intro>
- OKX Funding Rate History：<https://app.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate-history>
- OKX Instruments：<https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments>
- OKX Pagination：<https://www.okx.com/docs-v5/trick_en/>
- CCXT Funding Rate Manual：<https://github.com/ccxt/ccxt/wiki/manual#funding-rate>
- 本地 CCXT Bitget 实现：`node_modules/ccxt/js/src/bitget.js` 的 `fetchFundingRateHistory()`
- 本地 CCXT OKX 实现：`node_modules/ccxt/js/src/okx.js` 的 `fetchFundingRateHistory()`

## 5. 架构

新增链路如下：

```text
FundingRateSyncService
├── BitgetFundingRateSource -> 无凭证 CCXT Bitget 公共客户端
├── OkxFundingRateSource    -> 无凭证 CCXT OKX 公共客户端
└── SqliteFundingRateRepository -> 现有 SQLite 连接中的独立表
```

### 5.1 `FundingRateSource`

定义只读窄接口，职责仅包括：

- 每轮直接请求目标 raw 产品配置端点，并返回结构符合 USDT 线性永续口径且 `active` 明确为 boolean 的市场观察；新市场只有 `active === true` 才能进入同步，已知市场的 `active === false` 用于触发最后复核；
- 为单个目标市场请求一页历史已结算资金费率；
- 返回该页记录、当前分页位置和构造下一页所需信息；
- 提供脱敏且精确的请求元数据，用于错误日志。

该接口不包含凭证、余额、账户设置、价格、订单或持仓能力。现有 `ExchangeGateway` 和 `ExchangeRegistry` 不扩展资金费率方法，避免资金数据失败影响交易执行替身和状态机。

请求 executor 的结果必须通过显式名义类型区分，不允许按 error message、`name` 字符串或任意属性猜测。`FundingRequestCanceledError` 只表示同步器停止导致的正常取消；market task 必须原样传播同一实例，不能写 `INCOMPLETE` 或失败事件。`FundingRequestRetryExhaustedError` 只表示临时网络错误已经完成规定次数的重试；coverage 与 incremental task 分别将其持久化为固定的 `REQUEST_RETRY_EXHAUSTED`。这两个类型不接收 raw error、response、headers 或 credentials，也不暴露可变附加字段。executor 的每次实际重试通过显式 retry observer 把 attempt、delay 和当次 raw error 交还调用 task；task 立即经既有 allowlist/脱敏事件边界记录，observer 不得直接持久化或传播 raw error。其他 executor/source rejection 仍归类为 `SOURCE_RESPONSE_INVALID`。

市场发现不得调用 `loadMarkets/fetchMarkets/fetchCurrencies` 或读取 CCXT market cache。每轮必须经与历史页面相同的单所串行请求 executor，直接调用一次目标 generated raw 方法；因此发现调用本身就是强制刷新，并能对实际 endpoint/query 逐请求执行 spacing、重试和日志。结构匹配但 active 状态缺失/未知、market ID 重复或 unified symbol 身份冲突时，本轮发现不完整；可以继续同步此前已知市场，但不能新增、停用或宣称完整发现。新发现的 inactive 市场不建立同步状态。

币种代码使用同一 CCXT client 的 `safeCurrencyCode` 规范化，不手写 common-currency 映射。进入映射前的 raw market ID、base、quote、settle 候选以及映射后的 base、quote、settle 都必须是无首尾空白的非空字符串；`safeCurrencyCode` 返回空值、非字符串或空白时整轮失败。unified symbol 只能由已验证代码精确构造为 `${base}/${quote}:${settle}`，不能接受 CCXT 对缺失值的字符串插值结果。Bitget 观察只来自 `productType=USDT-FUTURES` 响应：settle 按锁定 CCXT 逻辑依次选择 support-margin list 中的 base、quote、首项，`symbolType=perpetual` 才是 swap；只有官方 `symbolStatus=normal` 明确 active，`listed/maintain/limit_open/restrictedAPI/off` 明确 inactive，缺失或未知状态使整轮不完整。OKX 观察只来自 `instType=SWAP` 响应：base/quote 从恰好两段非空的 `uly` 得出，settle 来自 `settleCcy`，`ctType=linear` 必须与 raw `quoteId=settleId`、`baseId!=settleId` 一致；只有 `state=live` 明确 active，`suspend/rebase/post_only/preopen/test` 明确 inactive，缺失或未知状态使整轮不完整。

### 5.2 交易所适配器

- `BitgetFundingRateSource` 使用无凭证 CCXT Bitget 客户端：发现调用 generated `publicMixGetV2MixMarketContracts({ productType: 'USDT-FUTURES' })`；历史调用 generated `publicMixGetV2MixMarketHistoryFundRate()`，固定 Classic V2，显式传入 `symbol`、`productType=USDT-FUTURES`、`pageNo` 与 `pageSize=100`。
- `OkxFundingRateSource` 使用无凭证 CCXT OKX 客户端：发现调用 generated `publicGetPublicInstruments({ instType: 'SWAP' })`；历史调用 generated `publicGetPublicFundingRateHistory()`，显式传入 `instId`、可选 `after` 与 `limit=400`。
- 两个适配器直接验证公共响应 envelope 和每条 raw record，再产生领域记录；不得先通过 CCXT unified `number` 字段丢失十进制表示。
- 适配器只接受响应中的 market ID 与请求 market ID 精确一致的记录；额外市场、缺失 ID 或身份冲突使本页失败。
- 两个发现端点的文档都没有分页参数，因此一次成功响应定义为“本轮接口可见列表”，而不是交易所绝对全量快照。若未来出现分页参数、截断标记或响应结构变化，旧实现必须 fail-closed 并先更新设计，不得静默假设单页仍完整。

### 5.3 `FundingRateSyncService`

负责：

- 启动时市场发现；
- 每个交易所一个串行 worker；
- 单市场历史回填和每小时增量同步；
- 页面级重试、保守限流、任务去重和优雅停止；
- 将成功页面交给仓储原子提交；
- 将失败隔离到交易所和 market ID，并保持可恢复状态。

Bitget 与 OKX worker 可以彼此并行。同一交易所任何时刻只允许一个资金费率公共请求，包括市场发现和历史分页；同一市场任何时刻只允许一个同步任务。

### 5.4 `SqliteFundingRateRepository`

独立于 `StrategyRepository`，但复用 `composeService()` 打开的同一 SQLite 连接。它只负责资金费率 schema、严格读写、页面原子提交、修订留痕和同步状态，不推进任何 `StrategyState`。

## 6. 数据模型

首期新增三张表，不修改 `strategies`、`strategy_orders` 或 `order_events`。

为精确验证 Bitget 两轮扫描集合，repository 可以在当前 SQLite 连接中创建连接级 `TEMP` staging 表。该表不是持久业务表，不计入上述三张表；它只保存当前进程的扫描 ID、自然键和规范化内容，进程中断后丢失，恢复时必须重新执行完整验证，不能据临时数据推进持久状态。

### 6.1 `funding_rate_history`

保存交易所当前认定的每个结算事件最新版本。核心字段：

- `exchange_id`：只允许 `bitget`、`okx`；
- `exchange_market_id`：交易所原始 market ID；
- `symbol`：CCXT unified symbol；
- `funding_timestamp_ms`：结算时间 Unix 毫秒整数；
- `funding_rate`：验证后的原始十进制字符串；
- `raw_json`：该条公共历史记录经过确定性 key 排序后的 JSON；
- `content_hash`：对影响记录语义的规范化内容计算的 SHA-256；
- `first_observed_at`、`last_observed_at`：UTC ISO 时间。

自然主键固定为：

```text
(exchange_id, exchange_market_id, funding_timestamp_ms)
```

`symbol` 是查询和展示属性，不单独承担身份。结算时间相同但 market ID 不同的记录不得合并。

规范化内容固定包含 exchange ID、exchange market ID、unified symbol、结算时间、原始费率字符串和规范化 raw JSON，不包含观察时间。`content_hash` 只用于索引和诊断；判定内容相同仍须比较规范化字段本身，不得仅凭哈希相等跳过修订。

### 6.2 `funding_rate_revisions`

保存主表被交易所后续数据替代前的旧版本。除自增 ID 和 `replaced_at` 外，保留旧版本的身份、symbol、费率、raw JSON、content hash 及观察时间。

该表通过 SQLite trigger 禁止 UPDATE 和 DELETE。首次发现记录不产生 revision；完全相同的重复观察也不产生 revision。只有同一自然键的规范化内容发生变化时，才在同一事务中先保存旧版本，再更新主表，并记录结构化告警。

### 6.3 `funding_rate_sync_state`

每个 `(exchange_id, exchange_market_id)` 一行，保存：

- unified symbol、最近一次明确发现的 active 状态、状态观察时间和 active/inactive 转换时间；
- 全范围覆盖状态 `coverage_status`：`PENDING`、`BACKFILLING`、`CAUGHT_UP` 或 `INCOMPLETE`；
- 增量健康状态 `incremental_status`：`IDLE`、`RUNNING` 或 `INCOMPLETE`；
- 作为 fencing token 的单调递增 `coverage_generation` 与 `incremental_generation`；
- 当前 coverage task 实例的不可变 Bitget 必见边界或 OKX 初始 `after`；二者与该 task 的 `coverage_generation` 一同持久化，页面写入不得改变；
- 当前 incremental task 实例不可变的 `incremental_frozen_boundary_ms`；它与该 task 的 `incremental_generation` 一同持久化，空历史时允许为 `NULL`，页面写入不得随 `latest_funding_timestamp_ms` 前移；
- 已观察的最早、最新结算时间；
- 当前或最近一次全范围任务固定的 `coverage_cutoff_ms`；
- 最近一次成功全范围验证对应的 `last_caught_up_cutoff_ms`；
- OKX 上一已提交非空页的重叠恢复锚点及其 `coverage_generation`；
- 持久化的“重新激活后必须先完成全范围任务”标记；
- 当前或最近一次覆盖任务类型，以及覆盖任务与增量任务各自的开始、结束、最后成功时间、有限且脱敏的错误码与错误摘要；
- 最后一次确认穷尽时间和更新时间；
- inactive 最后复核成功时间；市场重新激活时该字段原子清空。

`coverage_status` 语义：

- `PENDING`：市场已发现但尚未成功提交历史页面；
- `BACKFILLING`：首次回填、恢复回填、周期复核或 inactive 最后复核正在执行，或者上次进程在该类任务期间退出；
- `CAUGHT_UP`：满足对应交易所的全范围终止证明，并且只声明已验证到持久化的 `last_caught_up_cutoff_ms`；
- `INCOMPLETE`：全范围任务的请求、解析、分页推进、集合收敛或持久化失败，当前不能宣称全范围任务成功。

`incremental_status` 语义：

- `IDLE`：增量任务未在执行；是否曾成功由独立时间字段判断；
- `RUNNING`：增量任务正在执行，或者上次进程在增量任务期间退出；
- `INCOMPLETE`：增量任务失败，但不改变全范围覆盖结论。

每个新建或中断后重建的全范围 task 实例，在第一次网络请求前都必须在同一个短事务中递增 `coverage_generation`。新任务同时设置 `coverage_status=BACKFILLING`，固定并持久化本次 `coverage_cutoff_ms`、任务类型和 task 启动时的交易所恢复字段，并清空上一 generation 的其他临时分页字段；中断恢复则先验证遗留状态和锚点属于旧 generation，保留原 cutoff/任务类型，将当前安全恢复边界固定为新 generation 的不可变 task 启动字段，并把仍需使用的 OKX 可变锚点原子重绑到新 generation。任务 lease 不携带无行为意义的“是否恢复”标志，只携带当前 generation 和持久化的 task 启动恢复字段。每个页面提交、错误转换和完成转换都必须在事务内比较 lease 的 generation、任务类型、cutoff 以及完整 task 启动恢复字段；任一不匹配时整次操作失败且旧任务被丢弃。任务成功时，原子设置 `coverage_status=CAUGHT_UP`，把同一 cutoff 写入 `last_caught_up_cutoff_ms`，并保存穷尽证据。后续全范围失败可以把 `coverage_status` 设为 `INCOMPLETE`，但不得删除或覆盖此前的 `last_caught_up_cutoff_ms` 和穷尽证据；这些旧证据只能表述为历史成功，不能表述为本次成功。

每个新建或中断后重建的增量 task 实例，也必须在第一次网络请求前通过同一个短事务递增 `incremental_generation`，并把该事务快照中的 `latest_funding_timestamp_ms` 原样写入 `incremental_frozen_boundary_ms`；空历史的 `NULL` 和时间戳 `0` 都是有区别的合法边界。task lease 只携带该 generation 与持久边界。资格检查、页面提交、完成、失败和取消都必须以 SQLite `IS` 做 null-safe 完整比较；任一字段不匹配都视为 stale，且记录、revision 与状态零写入。页面提交只能更新全局 oldest/latest，不能改变冻结边界。增量明确进入 `IDLE`/`INCOMPLETE`，或市场状态转换取消其 `RUNNING` 状态时，必须在同一成功 CAS 中清空冻结边界。中断恢复不复用旧边界，而是递增 generation 并从当时已持久化的 latest 重新冻结。

增量任务只更新 `incremental_status`、增量时间和增量错误字段，不得修改 `coverage_status`、`coverage_cutoff_ms`、`last_caught_up_cutoff_ms` 或全范围错误。除第 7.4 节明确 inactive 后取消未完成增量的生命周期转换外，增量成功是把 `incremental_status` 从 `RUNNING`/`INCOMPLETE` 恢复为 `IDLE` 的唯一正常路径；即使写入了新记录，也不能清除全范围 `INCOMPLETE`。全范围状态只能由同类全范围任务改变，其中 `INCOMPLETE` 只能由后续满足对应终止证明的全范围任务恢复为 `CAUGHT_UP`。

进程启动时遇到遗留 `BACKFILLING` 或 `RUNNING` 必须分别按中断处理并进入对应安全恢复，不得当作成功。意外中断的全范围任务只有在旧 generation、任务类型、cutoff 和交易所恢复字段相互一致时，才保留同一 `coverage_cutoff_ms` 并在带注入恢复时间的事务中递增 `coverage_generation`、更新 `updated_at`、重新固定 task 启动恢复字段；任何缺失、generation 不匹配或 generation 无法安全递增都 fail-closed。已经明确写入 `INCOMPLETE`、`CAUGHT_UP` 或其他结束状态的任务不再恢复；下一次调度必须创建新 generation 和新 cutoff。市场只有至少一次成功进入过 `CAUGHT_UP`（即存在 `last_caught_up_cutoff_ms` 和穷尽证据）、当前明确 active 且“重新激活全范围待完成”标记为 false 后，才有资格执行普通增量；后来周期复核失败时，普通增量仍可继续，但两类状态和错误必须分别报告。

### 6.4 数据约束

- 所有枚举、非空字符串、时间戳、UTC ISO 时间和 JSON 都在写入前验证，并由 SQLite `CHECK`/主键/外键或 trigger 尽量二次约束。
- `coverage_generation` 与 `incremental_generation` 从 0 开始，只允许非负安全整数；创建新任务或恢复中断任务时若无法安全加 1 必须 fail-closed，不得回绕或复用旧 generation。
- 所有覆盖写操作都必须提供期望 generation、任务类型、cutoff 和 task 启动恢复字段，并受 repository 事务级完整相等检查保护；任一不匹配时连页面记录也不得部分写入。
- 所有增量资格与写操作都必须提供期望 generation 和冻结边界，并与持久 task provenance 做 null-safe 完整相等检查；`RUNNING` 之外的状态不得保留冻结边界，非空冻结边界不得大于当前持久 latest。
- `funding_rate` 使用 TEXT，禁止 SQLite REAL。

- 资金费率同步在 Task 9 装配前没有可启动的已发布生产路径，因此首期 schema 直接包含该列，不为中间开发版本的资金费率表提供迁移。现有业务数据库没有资金费率表时由完整新 schema 创建；若检测到部分或旧开发 schema，继续按既有 schema 指纹策略拒绝启动，不自动猜测迁移。
- raw JSON 只保存单条公共记录，不保存 headers、凭证、完整错误对象或私有响应。
- `coverage_status=CAUGHT_UP` 必须同时满足 `coverage_cutoff_ms = last_caught_up_cutoff_ms`，且 generation、cutoff、穷尽时间和覆盖成功时间均有效；`PENDING` 不得伪造这些成功证据。OKX 恢复锚点非空时，其 generation 必须等于当前 `coverage_generation`。inactive 最后复核成功时间只有在最近明确状态为 inactive 且同一事务进入 `CAUGHT_UP` 时才能写入；重新激活待完成标记只能由对应 reactivation 全范围任务成功时原子清除。
- 仓储读取不信任 SQLite 数据。非法枚举、非法时间、非法十进制、非法 JSON 或状态字段矛盾必须产生包含 exchange 和 market 定位信息的精确错误，不返回部分可信对象。

## 7. 分页与完整性算法

### 7.1 共通规则

每个目标市场按交易所适配器显式逐页同步：

1. 新建全范围任务先在短事务中递增 generation、清空旧恢复字段，并固定、持久化本次 `coverage_cutoff_ms`、任务类型、task 启动恢复字段和 `BACKFILLING` 状态；恢复遗留 `BACKFILLING` 也先验证并递增 generation，但保留原 cutoff/任务类型并原子重绑安全恢复位置；新建或恢复增量任务则递增 `incremental_generation`，设置 `RUNNING` 并原子持久化当时 latest 作为冻结边界；
2. 发起单页公共请求；
3. 验证响应 envelope、market 身份、每条费率和结算时间；
4. 对页面记录按结算时间排序并在内存去重；同一自然键在同页出现不同内容时整页失败；
5. 验证分页位置确实朝更旧的范围推进；
6. 在一个短 SQLite 事务中提交全部记录、必要修订和对应类型的同步断点；
7. 事务成功后才允许请求下一页。

请求失败、限流、超时、非法数据、重复异常、分页不推进或 SQLite 失败都不是结束条件。OKX 首次回填只有成功请求明确的下一页并取得空数据才能进入 `CAUGHT_UP`；Bitget 还必须满足第 7.2 节的双扫描收敛条件。

返回条数少于 page size 不能单独作为结束条件。系统仍必须显式请求下一页。

### 7.2 Bitget 回填与恢复

- 新市场从 `pageNo=1` 开始，按页号递增，直到成功取得空页。
- `pageNo` 只允许作为同一短时运行中的临时位置，不作为可信的跨进程断点。
- 中断或重启后从第 1 页重新扫描并幂等写入，直到重新遇到已保存的最旧覆盖边界，然后继续向更旧页面扫描。
- 如果已保存边界不再出现、页面无法继续推进、接口报出未证明为终点的页号限制，必须把 `coverage_status` 设为 `INCOMPLETE`，不得跳过或猜测完成。
- 单次扫描到空页不能证明页码遍历期间没有因头部插入、删除或重排漏掉页内记录。第一次完整扫描开始前，以注入时钟的有效 Unix 毫秒值固定并持久化 `coverage_cutoff_ms`；该扫描到达空页后，立即从第 1 页执行下一轮完整扫描，并精确比较两轮中 `funding_timestamp_ms <= coverage_cutoff_ms` 的规范化记录集合。成功进入 `CAUGHT_UP` 时必须把该 cutoff 同时写入 `last_caught_up_cutoff_ms` 并保存穷尽证据。
- 每轮扫描的截止时间内集合写入连接级 TEMP staging 表，并与页面数据一同按页原子提交。只有连续两轮都到达空页，且通过双向集合差集确认截止时间内的自然键和完整规范化内容逐项相同，才能进入 `CAUGHT_UP`。不得只比较 count、最早/最晚时间、页号或哈希。
- `funding_timestamp_ms > coverage_cutoff_ms` 的已结算记录仍按正常规则验证和保存，但不参与两轮集合相等判断，也不属于本次 `CAUGHT_UP` 声明。日志、状态和文档必须表述为“验证至 `last_caught_up_cutoff_ms`”，不得暗示验证了 cutoff 之后的记录。
- 两轮集合不同时，当前轮成为新的比较基准并继续完整扫描；单次任务最多执行三轮。三轮内不能得到连续两轮一致结果时把 `coverage_status` 标记为 `INCOMPLETE`，等待下一调度周期重新从第 1 页收敛，不能阻塞其他市场。
- 空市场也必须连续两轮都取得空首页后才能进入 `CAUGHT_UP`。
- 每页响应条数超过请求 page size 时视为非法响应；TEMP 集合按单个市场和最多三轮生命周期清理，不能被其他市场或并行交易所复用。

### 7.3 OKX 回填与恢复

- 与 Bitget 一样，全范围任务在首个请求前用注入时钟固定并持久化 `coverage_cutoff_ms`。返回的已结算记录可以正常保存，但全范围成功声明只覆盖 `funding_timestamp_ms <= coverage_cutoff_ms` 的本次游标遍历事实。
- 首页不传 `after`，后续使用本页最小 `fundingTime` 作为下一页 `after`。
- 请求携带 `after=A` 时，响应中的每个 `fundingTime` 都必须严格小于 `A`；非空页产生的下一 `after` 为该页最小时间，且也必须严格小于 `A`。任一条件不满足都视为游标不推进并把 `coverage_status` 设为 `INCOMPLETE`。
- 每次提交非空页时，必须同时持久化该页最大 `fundingTime` 作为下一次跨进程恢复使用的 `after` 重叠锚点，并将锚点绑定当前 `coverage_generation`。恢复时只有遗留状态确为 `BACKFILLING` 且锚点 generation 完全匹配才可使用该锚点；恢复事务递增 generation，把该锚点同时固定为新 task 不可变的初始 `after` 并将可变锚点重绑新 generation。它会重读上一已提交页的大部分记录，再继续向更旧范围推进。只保存或直接使用全局最旧时间会跳过重叠，因此禁止。
- 恢复后的第一个非空页允许全部是已经提交的重叠记录，例如崩溃前最后一页少于 limit 时；只要所有时间都严格小于本次请求的 `after`，就用该页最小时间继续。不得因为没有出现早于数据库全局最旧时间的新记录而误判不推进。
- 每个新 generation 必须在设置 `BACKFILLING` 和新 cutoff 的同一事务中清空旧 OKX 锚点；因此即使新任务在首页提交前崩溃，重启后也必须以不带 `after` 的首页恢复。进入任一明确结束状态后，旧锚点不再具有恢复资格。
- 成功取得空页后，只能把 `coverage_status` 标记为 `CAUGHT_UP`，将本次 cutoff 写入 `last_caught_up_cutoff_ms`，并表述为“已遍历 OKX 本次接口可见窗口中截止该 cutoff 的范围”；不能把约三个月的文档上限表述为精确起点或绝对完整历史。

### 7.4 增量同步

- 单个市场完成回填后立即加入每小时增量队列，不等待其他市场。
- 增量任务在首个请求前的启动事务中读取并持久化“任务开始前本地最新自然键”作为 generation-scoped 重叠边界，再从交易所最新页向旧页扫描；本轮页面写入产生的新 latest 不得移动该边界。任务创建和每次 repository 操作都必须认证 lease 中的 generation 与冻结边界；复制后伪造边界的 lease 必须在任何请求或写入前 fail-closed。遇到冻结边界后，至少再成功读取一页重叠数据才停止。
- 若任务开始时本地无记录，或扫描中直到显式空页都没有重新观察到冻结边界，则继续按交易所分页规则直到显式空页；只能更新增量健康状态，不得据一次增量遍历提升或清除全范围覆盖状态。
- 增量任务中断或进程重启后丢弃内存分页位置，从最新页重新扫描并幂等写入；不得把增量页码或游标当作无需重叠的持久断点。
- 增量同步发现早于本地最新时间但自然键未知的记录时必须写入，不能只保留 `timestamp > latest` 的数据。
- 发现同一自然键内容变化时执行修订事务。
- 增量任务失败只把 `incremental_status` 设为 `INCOMPLETE`；成功完成规定重叠后只把它恢复为 `IDLE`。两种转换都不得改写任何覆盖状态、cutoff、穷尽证据或覆盖错误。
- `funding_incremental_completed` 的 `inserted/unchanged/revised` 是本次增量 task 所有已成功提交非空页的累计值，不是最后一页的局部值；空终止页不计数。累计值只在页面事务提交成功后增加，中断恢复的新 generation 从零重新累计。
- 明确 false 到 true 的重新激活转换必须持久化 reactivation 待完成标记并删除普通增量队列资格。只有任务类型为 reactivation、generation 在该 active 转换后创建且成功进入 `CAUGHT_UP` 的全范围事务，才可清除该标记；失败、旧 generation 成功、普通增量成功或其他任务类型都不得清除。进程重启后若标记仍在，必须先重建 reactivation 全范围任务，且在其成功前不得发出任何普通增量请求。
- 每个 active 市场除每小时增量外，每 24 小时安排一次从首页到显式空页的全可见范围复核；Bitget 的复核继续使用第 7.2 节双扫描收敛条件，OKX 重新遍历其当时可见窗口。复核会发现浅层增量重叠范围之外的迟到记录和修订。
- 全范围复核失败时只把 `coverage_status` 设为 `INCOMPLETE`，并保留此前 `last_caught_up_cutoff_ms` 和穷尽证据；每小时增量仍可继续。后续增量成功只恢复 `incremental_status=IDLE`，不得清除覆盖错误，也不得把旧的覆盖成功时间表述为当前复核成功。
- 市场首次明确变为 inactive 后不再创建普通增量任务；同一串行 worker 在发现事务提交后移除尚未继续的增量任务，若其状态为 `RUNNING` 则改回 `IDLE`，但不更新增量成功时间。随后必须完成一次最后的全范围复核。复核成功后停止该市场后续请求并永久保留历史；后续未再观察到的交易所修订不在保证范围内。

### 7.5 无法证明的外部缺口

动态资金周期、交易所保留策略和服务端数据遗漏使应用无法仅凭相邻时间戳证明交易所未漏记录。因此应用只声明分页覆盖事实，不把固定 8 小时或其他猜测作为连续性证明。所有完整性状态都必须带 exchange、market、最早时间、`last_caught_up_cutoff_ms` 和确认时间边界；cutoff 之后即使已有部分记录，也不属于该次完整性声明。

## 8. 调度、限流与生命周期

### 8.1 调度

- 服务 HTTP 监听成功后，资金费率同步器异步启动，立即执行市场发现和回填；此后每个同步 interval 强制刷新一次市场。`composeService()` 和组件构造期间不得联网。
- 每个交易所一个串行 worker，两个交易所可并行。
- 市场发现也必须作为对应交易所 worker 的任务执行；它与该交易所的历史页面请求共享“最多一个在途请求”约束，不得在独立 timer 回调中直接联网。
- 单个市场先回填、后增量；同一市场不并行执行两类任务。
- worker 在页面边界调度。市场发现、到期增量、首次/恢复回填和周期复核使用持久轮转游标：每个非空类别都取得一次执行机会后，任何类别才能取得下一轮机会；历史任务的一次机会为一页，发现任务的一次机会为一次目标 raw 产品配置请求及完整响应校验。同一历史类别内的 market 使用 FIFO，一页完成后续页排到队尾。由此任何持续任务都不能饿死发现、增量、回填或复核，单个长市场也不能饿死同类其他市场。
- 历史任务队列按 exchange、market ID 和任务类型去重，发现任务按 exchange 和发现类型去重。同一调度周期尚未完成时不再添加相同任务。
- discovery 已排队或运行时到来的 timer tick 由上述 key 去重并直接合并，不记录补偿 backlog；该任务完成后只由下一次正常 timer tick 再次入队。
- 普通增量入队资格必须同时检查：当前明确 active、至少一次成功覆盖、无 reactivation 待完成标记且无 inactive 最后复核待完成条件。该持久化谓词在启动恢复和每轮调度都使用，不能仅依赖内存队列；周期复核失败后的重试任务已排队时，普通增量仍可按页面边界与其串行交错执行。
- 已排队增量在每次公共请求前必须重新读取并检查同一资格谓词；资格失效时不发请求，丢弃该任务并按第 7.4 节完成生命周期状态转换。覆盖任务在每次请求前也检查其 fencing generation，失配时不发请求并丢弃旧任务。
- 已完成市场的下一次增量时间按最后一次尝试结束时间加 interval 计算；三次临时重试耗尽后也等待一个完整 interval，避免因 `last_success` 仍然过旧而形成热循环。服务重启后，已到期任务立即进入队列。
- active 市场的下一次全范围复核时间按最近一次成功全范围任务时间加 24 小时计算，首次成功回填也作为起点；队列积压时不重复添加同一复核任务。inactive 的最后复核不受 24 小时等待限制，其成功标记必须与 `coverage_status=CAUGHT_UP` 和 cutoff 在同一事务提交。
- 全范围复核失败后按本次复核尝试结束时间加 `FUNDING_RATE_SYNC_INTERVAL_MS` 重试，不因旧的成功时间已经过期而立即重新入队形成热循环。
- `FUNDING_RATE_SYNC_INTERVAL_MS` 是规范十进制整数，允许 `60000` 到 `86400000`，默认 `3600000`。缺失使用默认值；空白、符号、前导零、小数、指数、非安全整数或越界值在构造任何 gateway 或打开 SQLite 前拒绝启动。

### 8.2 请求边界

- 资金费率 CCXT 客户端不接收任何 API key、secret 或 password，只配置 `enableRateLimit: true` 和 15 秒请求超时。
- 在 CCXT 限流之外，每个交易所适配器使用独立保守节流；同一交易所始终只有一个在途请求。节流值必须在 implementation plan 中绑定当前官方限制和可复现测试，不得凭感觉提高吞吐。
- 临时网络、超时或限流错误立即重试最多 3 次，等待 1、2、4 秒；仍失败时，全范围任务只标记 `coverage_status=INCOMPLETE`，增量任务只标记 `incremental_status=INCOMPLETE`，随后移到其他市场并在下一调度周期重试。
- 解析、身份、分页或数据完整性错误不通过盲目立即重试掩盖；记录到对应任务类型的独立错误字段并保持 fail-closed，下一周期重新从安全边界尝试。
- worker 的 request executor 只能捕获当前 CCXT `NetworkError` 类型执行上述重试；第四次 attempt 仍失败时抛固定的 `FundingRequestRetryExhaustedError`。停止发生在未发送 attempt、可取消 spacing/backoff 或底层请求失败返回之后时抛固定的 `FundingRequestCanceledError`；已经成功返回的在途请求仍完成该页验证与原子提交。market task 通过这两个名义类型决定“无状态写入取消”或 `REQUEST_RETRY_EXHAUSTED`，不得检查 message 文本。
- retry observer 是 `FundingRequestExecutor.execute` 的必填调用参数。它只接收当前 attempt 的受限序号、下一次 delay 和 raw error，并由 coverage、incremental 或 discovery 调用方补齐自身上下文后送入 non-throwing、allowlisted event sink；observer 或日志失败不得改变重试、分页或持久化结果。

### 8.3 启动失败与运行失败

- 配置、schema、repository 或同步器构造失败时拒绝启动，并按现有构造失败路径关闭已经打开的 SQLite。
- 远端公共接口运行失败不得推进对冲状态，也不关闭现有交易 HTTP 服务；只影响对应资金费率市场的同步状态。
- SQLite 页面事务失败时整页回滚且不推进断点。同步器停止信任本次操作结果，记录错误并等待安全重试。
- worker 未被任务边界吸收的内部 fatal 必须触发另一 worker 停止，但服务仍等待两个完整 root quiescent。若两个 root 都报告内部 fatal，最终按固定 `bitget`、`okx` 顺序选择首个错误，不按竞态完成顺序决定。

### 8.4 关闭

关闭顺序固定为：

1. 同步器取消所有调度 timer 和可取消的退避等待，并停止派发新页面；
2. 等待市场发现任务以及 Bitget、OKX 两个完整 worker root Promise 结束；root Promise 必须覆盖队列循环、在途请求、不可取消的底层等待和页面事务；
3. 停止现有订单监控器；
4. 关闭 HTTP server；
5. 关闭 SQLite；
6. 移除 signal listener。

多次 `shutdown()` 继续共享同一个 Promise。监听失败或启动期间收到 signal 时也必须经过同一幂等关闭路径。同步器停止后不得再访问 SQLite。`stop()` 即使需要报告内部错误，也必须先完成所有 root Promise 的 quiescence；只有已经证明同步器不会再访问仓储，关闭流程才可继续关闭 SQLite。

`stop()` 在 `start()` 前调用也会把同步器永久置为 stopped；其后任何 `start()` 都是同步 no-op，不建立 timer/root、不请求 source，也不访问 repository。重复 `start()` 与重复 `stop()` 同样不得创建额外生命周期。

`FundingRateSyncService.start()` 只能在 `await listen(...)` 成功返回且同一同步控制分支确认 `shutdownPromise === null` 后同步调用。如果 signal 在 listen 未完成时已经启动 shutdown，则 listen 后不得启动同步器，也不得访问已经关闭的 SQLite。该检查与 `start()` 调用之间不得出现可让 signal handler 插入的 `await`。

## 9. 事务与状态顺序

网络请求绝不位于 SQLite 事务内。成功响应的固定顺序为：

```text
请求页面
  -> 完整解析并验证页面
  -> 开启短事务
     -> 插入新结算记录
     -> 对变化记录写不可变 revision 后更新主表
     -> 更新该 market 的 oldest/latest 和同步状态
  -> 提交事务
  -> 才允许推进内存分页位置或请求下一页
```

任一写入失败必须整页回滚。不得出现“记录已写但断点未推进”或“断点已推进但记录未写”的可见状态。

单个市场失败不回滚其他市场已经验证并提交的数据；全局大事务会跨网络长期持锁且丢失安全进度，因此禁止。逐行提交再单独更新断点会制造状态分裂，因此也禁止。

## 10. 日志与错误

结构化日志至少覆盖：

- 同步器启动与停止；
- 市场发现结果摘要；
- 页面提交摘要；
- 单市场回填穷尽；
- 增量同步完成；
- 重试与最终 `INCOMPLETE`，并明确是 `coverage_status` 还是 `incremental_status`；
- 同一结算记录出现修订；
- 同步器无法继续的 SQLite 或生命周期错误。

每条全范围开始、完成或失败日志必须包含固定的 `coverage_cutoff_ms`；成功日志还必须包含相同的 `last_caught_up_cutoff_ms`，并使用“验证至该 cutoff”的措辞。不得因页面中保存了 cutoff 之后的记录而把完成范围扩大到这些记录。

全范围日志还必须包含 `coverage_generation` 和任务类型；OKX 恢复日志必须说明是否使用锚点及锚点 generation，generation 不匹配错误必须记录期望值与实际值。重新激活期间的日志必须明确普通增量被持久化条件阻止，而不是仅报告内存队列为空。

错误必须包含定位所需的 `exchangeId`、`exchangeMarketId`、unified symbol、阶段、页号或游标、期望与实际情况，不得包含凭证、headers、完整环境变量或私有账户数据。

公共 API 错误日志还必须包含经过结构化和脱敏的请求信息：

- HTTP method；
- path；
- query；
- body（这些历史接口固定为 `null`）。

不得记录完整 CCXT error 对象的任意属性、原始 headers 或未经约束的响应。日志失败不得改变数据库、分页、重试或对冲行为。

## 11. 正确性不变量

实现和测试必须共同证明：

1. 资金费率链路不能访问任何私有 endpoint，也不能获得交易凭证。
2. 只有明确 active 的 USDT 线性永续合约进入新市场同步范围。
3. OKX 已结算费率只来自 `realizedRate`；Bitget 只来自历史 `fundingRate`。
4. 费率不经过 JavaScript `number` 持久化，缺失值不变成零。
5. 每个成功页面的记录、修订和断点原子提交。
6. 全范围事务失败、请求失败、非法数据和游标不推进都不能进入 `CAUGHT_UP`；增量成功不能清除全范围失败。
7. OKX 只有显式空的下一页表示已完成本次游标遍历；Bitget 还必须在固定截止时间下取得连续两轮完整集合一致和相同空终点。两者的 `CAUGHT_UP` 都只验证至持久化的 `last_caught_up_cutoff_ms`。
8. Bitget 跨进程恢复不信任持久化页码；OKX 恢复包含重叠页，并以响应时间严格小于请求 `after` 证明游标推进，而不要求重叠页必须出现数据库尚未保存的更旧记录。
9. 相同自然键和相同内容幂等；相同自然键和不同内容保留旧版本并更新主版本。
10. 单市场失败不阻塞其他已完成市场的增量同步。
11. 同一交易所串行请求，同一市场任务不重叠。
12. shutdown 返回后不存在仍可能访问 SQLite 的资金费率任务。
13. 任何“完整”声明都限定为交易所接口可见范围和持久化 cutoff，不扩张为 cutoff 之后、上市以来或服务端未返回的数据。
14. 资金费率失败不推进或重试任何订单，不改变对冲状态。
15. 每轮市场发现直接调用一条锁定的 generated raw 公共方法，既不使用 CCXT 市场缓存，也不触发 currencies 或其他产品类型请求；OKX 跨进程恢复使用已持久化的上一页重叠锚点。
16. active 市场的全范围复核不会被持续增量饿死；inactive 市场完成最后复核后不再承诺发现新修订。
17. signal 在 listen 期间触发 shutdown 时同步器永不启动；`stop()` 返回时 timer、退避、发现任务和 worker root Promise 全部结束。
18. 同一交易所的市场发现与历史页面请求不并发；明确重新激活的市场会清除旧的 inactive 完成标记并重新建立覆盖。
19. 新 OKX 覆盖 generation 不得复用旧 generation 的恢复锚点；新任务首页提交前崩溃后仍从无 `after` 的首页恢复。
20. reactivation 待完成标记持久存在，且只有该 active 转换之后创建的 reactivation 全范围任务成功才能清除；此前普通增量请求数必须为零。
21. 新 coverage generation 会拒绝旧任务的所有页面和状态提交；incremental generation 与持久冻结边界共同构成不可伪造的 task provenance，任何不匹配都会在请求或写入前 fail-closed；被状态转换取消的增量会在下一页请求前重新检查持久资格。

## 12. 测试设计

后续实现必须先按 TDD 创建预期失败测试，并确认失败原因正是目标行为缺失。测试只使用 fake source/CCXT 客户端、虚拟时钟、内存或临时 SQLite 和临时环境值。

### 12.1 适配器测试

- Bitget 发现只调用 `publicMixGetV2MixMarketContracts({ productType: 'USDT-FUTURES' })`，OKX 发现只调用 `publicGetPublicInstruments({ instType: 'SWAP' })`，每轮各自恰好一条实际 HTTP 请求；
- 两所发现不得调用 `loadMarkets/fetchMarkets/fetchCurrencies`，不得读取 CCXT market cache；
- Bitget `symbolType/symbolStatus/supportMarginCoins` 与 OKX `instType/ctType/state/uly/settleCcy` 的完整映射条件及每个反例；raw 或 normalized market/base/quote/settle 缺失、非字符串、空白，状态缺失或未知，重复 ID 或身份冲突都使整轮 fail-closed；
- 发现统一币种代码只经 CCXT `safeCurrencyCode`，目标集合严格限定为 raw endpoint 当前返回的 active USDT 线性永续，不宣称不可观察的交易所绝对全集；
- Bitget Classic V2 请求 method/path/query、页号、page size 和 raw 字段解析；
- OKX V5 请求 method/path/query、`after`、limit 和 `realizedRate` 解析；
- 正、零、负费率以及极小/极大有限十进制保持原始字符串；
- 缺失、空白、number、`NaN`、Infinity、畸形 rate 拒绝；
- 非安全时间戳、market ID 不匹配、非法 envelope、同页冲突拒绝；
- 不调用 `paginate:true`，不构造含凭证客户端；
- 限流、超时和错误请求元数据不泄露敏感信息。

### 12.2 仓储测试

- 三表 schema、约束、自然主键和 revision 不可变 trigger；
- Bitget TEMP scan staging 的进程内隔离、双向精确集合比较、页面原子写入和中断后不可恢复语义；
- 新记录、完全重复记录和内容修订；
- 页面多行与状态断点原子提交；
- 中途 constraint/trigger 故障整页回滚；
- coverage fencing generation 失配时页面记录、修订和状态均零写入；
- incremental 冻结边界在 start/restart 中与 generation 原子持久化，页面推进保持不变；伪造边界在 currentness、page、complete、fail、cancel 入口均 stale 且零写入，终态与市场转换原子清空；
- `coverage_status` 与 `incremental_status` 的合法独立转换、错误字段隔离、cutoff/generation/冻结边界/OKX 锚点关系，以及 reactivation 与 inactive 最后复核标记的一致性约束；
- 损坏的 decimal、timestamp、JSON、枚举和矛盾状态读取时 fail-closed；
- 不修改既有策略/订单表及其记录。

### 12.3 同步服务测试

- 两个交易所可并行、单个交易所的市场发现与历史页面请求严格串行；
- Bitget 空页终止、重启从第一页重扫、覆盖边界后继续；
- Bitget 页间头部插入、删除和重排导致首轮漏行时不能进入 `CAUGHT_UP`；只有固定截止时间下连续两轮精确集合一致才完成，三轮不收敛则 `INCOMPLETE`；
- Bitget 两轮中 cutoff 之后的记录发生变化不影响截止时间内集合比较；成功状态和日志仍只声明验证至持久化 cutoff；
- OKX `after` 单调向旧推进、所有返回时间严格小于请求 `after`，恢复短尾页即使只有已保存的重叠记录也能继续到显式空页；
- OKX 旧任务留下锚点后，新 generation 在首页提交前崩溃；重启必须以无 `after` 首页恢复，旧 generation 锚点不匹配时 fail-closed；
- 短页继续请求下一页，错误或不推进不视为结束；
- 单市场回填完成后进入增量，不等待其他市场；
- 到期增量在页边界优先，失败市场不阻塞其他市场；
- 增量重叠页、边界内未知旧记录和修订均被保存；
- 增量停止边界在任务开始事务中持久冻结，不会被本轮首页写入推进；伪造的 generation/边界组合在 task 创建前零副作用拒绝；空库或边界未重现时继续到显式空页，但不改变覆盖状态；
- active 市场 24 小时全范围复核能发现第三页及更旧的迟到记录/修订；inactive 市场最后复核后停止且保证范围表述准确；
- 全范围复核在深页失败后，即使下一次浅层增量成功写入记录，`coverage_status` 和覆盖错误仍保持 `INCOMPLETE`，只有新的全范围成功才能清除；
- 三次临时重试、退避时序和下一周期恢复；
- 调度去重、周期不重叠、inactive/new/missing/reactivated 市场处理，以及持续过载下发现、增量、回填、复核四类队列都有进展；
- reactivation 标记跨重启保留，专用全范围任务成功前普通增量请求为零，失败或旧任务成功不能错误清除该标记；
- 市场状态转换发生在分页任务两页之间时，旧 coverage generation 不能再写库，失去资格的增量不能再发下一页请求；
- stop-during-discovery、stop-during-backoff、stop-during-request、stop-during-transaction 和 timer 到期竞态；`stop()` 等待完整 root Promise 后不再访问仓储。

### 12.4 装配与生命周期测试

- interval 配置默认值、边界和所有非法表示；
- 配置失败发生在 gateway/数据库构造前；
- `composeService()` 构造不加载市场、不联网；
- HTTP 监听成功后才启动同步器；
- signal 在 listen pending 期间关闭资源、随后 listen resolve 时同步器仍从未启动且资金费率 repository 零调用；
- 构造/监听失败和 signal shutdown 的精确资源关闭顺序；
- 资金费率运行失败不改变对冲 repository、协调器或 monitor；
- 现有完整测试套件回归通过。

不得读取仓库 `.env`、不得打开 `data/**`、不得调用任何真实交易所 API（包括公共接口）、不得使用真实账户或提交/取消订单。

## 13. 运维文档

实现完成后更新 README，至少说明：

- 支持的交易所和市场口径；
- 只保存已结算历史，不保存实时预测值；
- `FUNDING_RATE_SYNC_INTERVAL_MS` 默认值和合法范围；
- 启动回填、逐市场进入增量、状态和重试语义；
- Bitget 未知保留期与 OKX 约三个月限制；
- SQLite 数据永久保留及预计持续增长；
- 资金费率采集只使用公共无凭证客户端；
- 日志诊断方法，以及“接口可见范围、仅验证至持久化 cutoff”的限定含义。

操作员文档只有在资金费率行为与现有对冲操作流程产生直接运维关系时才更新；首期没有页面或操作入口，不增加无用操作步骤。

## 14. 非目标

- Binance、Bybit 或其他交易所；
- USDC、币本位、反向、交割合约或 inactive 新市场；
- 当前预计费率、实时快照、下一期预测费率；
- 页面、查询 API、导出、告警、自动清理或 retention 配置；
- 跨进程 worker、分布式锁、消息队列或外部调度器；
- 使用 Bitget UTA V3、交易所官方 SDK 或自行实现 HTTP transport；
- 修补、fork 或升级 CCXT；
- 根据固定资金周期猜测缺失记录；
- 访问真实交易所做验收；
- 对冲开仓、平仓、补单、账户模式、杠杆或订单恢复的任何行为变化。

## 15. 完成标准

后续实现只有同时满足以下条件，才可宣称完成：

- Bitget 与 OKX 所有成功发现的 active USDT 线性永续市场都拥有独立同步状态；
- 每轮发现分别只调用一条锁定的 raw 产品配置接口，并以其完整响应定义当轮 API 可见目标集合；不触发 currencies、其他产品类别或 CCXT 市场缓存；
- 每个市场能安全回填至接口显式空页，并在完成后每小时增量同步；
- 已结算费率字段、单位、符号和时间戳严格符合交易所证据；
- 不使用 CCXT 自动分页，不把 unified JS number 作为持久化费率来源；
- 页面数据、修订和断点原子提交，故障时不出现状态分裂；
- Bitget 页码漂移和 OKX 游标恢复均按本设计重叠策略处理；
- OKX 恢复锚点与 coverage generation 绑定，新任务不会复用旧锚点；
- 重复记录幂等，再次观察到的交易所修订可审计，旧版本不可变，未再观察的 inactive 市场修订不被夸大为已覆盖；
- 覆盖错误、游标异常和非法数据保持 `coverage_status=INCOMPLETE`；增量成功不能掩盖覆盖失败，两类状态和错误互不覆盖；
- 重新激活市场在专用全范围任务成功前不会恢复普通增量；
- Bitget 只有截止时间内双扫描集合收敛才确认穷尽；两所成功声明都只验证至持久化 cutoff；active 市场全范围复核可发现浅层重叠之外的迟到记录和修订；
- 两所 worker 的并发、单所串行、有界公平调度和完整 root Promise 关闭等待由确定性测试证明；
- signal-during-listen 路径不会在 SQLite 关闭后启动同步器；
- 现有交易链路接口、状态和订单行为没有改变；
- README 与实现语义一致；
- 所有批准的聚焦测试和完整验证命令通过；
- 验证过程未读取真实凭证、未调用任何真实交易所接口、未使用真实业务 SQLite。
