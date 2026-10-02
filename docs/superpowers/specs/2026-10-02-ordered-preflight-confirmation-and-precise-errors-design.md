# 有序预检、确认复检与精确错误需求

日期：2026-10-02

状态：已批准（用户于 2026-10-02 授权完成计划并实施，过程自动确认）

## 1. 这份文档是什么

本文只从已批准的 `docs/superpowers/specs/2026-08-09-ordered-workflows-and-precise-errors-design.md` 抽出 **当前 `main` 还没实现** 的需求。实现基线是今天的 `main`：对账模块、schema v2、`failure_code`、`submission_disposition` 和现有启动顺序都保留。

不使用 `feature/ordered-workflows-precise-errors` 上的代码。那份实现对着 8 月 9 日的旧执行路径，不能当作本文的做法。

旧 spec 仍是历史设计。本文审阅通过后，只有下面三块以本文为准。旧 spec 里已经由对账设计接手的部分，不转入本文。

本次修订补齐同一策略确认的互斥与条件写入、市场强制刷新，以及恢复监控的启动步骤。下文第 5 节取代此前“初始检查通过后，任何复检失败都无条件写入失效”的表述；持锁期间出现状态或订单异常变化必须按完整性错误阻止执行。

## 2. 要做的三件事

1. 预检按固定顺序检查，第一个失败就停止，并且不再发起后续读取。
2. 确认时同步重跑这套预检。重检失败则把这次预览标为失效，不开始下单。
3. 启动、HTTP、预检、确认和状态界面上，给操作员看的错误要写清对象、期望、实际和中文说明。

## 3. 明确不做

以下内容在旧 spec 里有，但 **不是** 本文需求。`main` 已有对应能力，或已由 `docs/superpowers/specs/2026-09-05-hedge-reconciliation-module-design.md` 规定：

- 不替换 `HedgeReconciliation`。进入 `HEDGED`、`FAILED`、`HEDGE_INCOMPLETE`、`WAITING_HEDGE`，以及决定补 GTC，仍只走对账。
- 不把提交确定性改回旧 spec 的 `NOT_SUBMITTED` / `UNKNOWN`。继续使用 `submission_disposition`。
- 不把 `FAILED` / `HEDGE_INCOMPLETE` 的 `failure_code` 换成整份失败 JSON。
- 不采用旧 spec 的「旧库拒绝、不迁移、`user_version = 1`」。schema 仍从当前 v2 向前迁移。
- 不把网关改成「先准备、再提交」，也不重写协调器、监控器里的恢复流程。
- 不为执行中的订单新增旧 spec 的 `issue` 历史。
- 不改资金费率同步的业务规则。

## 4. 有序预检

来源：旧 spec 第 7 节。

首次预检严格按下面顺序执行。任一步失败，不得开始后续读取，不得创建策略，不得写 SQLite。

1. 检查执行模式、两个交易所不同、symbol 格式、请求数量格式。
2. 检查现货和合约交易所都已配置。
3. 加载并检查现货市场存在、身份正确且可交易。
4. 加载并检查合约市场存在、身份正确且可交易。
5. 检查两个市场基础资产相同，且都以 USDT 计价。
6. 检查合约持仓模式。实际不是 `hedged` 时立即返回。
7. 检查保证金模式可确认为 `isolated` 或 `cross`。
8. 检查空头杠杆为有限正数。
9. 计算共同有效数量，并检查数量精度、合约乘数及最小/最大数量。
10. 读取现货参考价并检查现货名义金额范围。
11. 读取合约参考价并检查合约名义金额范围。
12. 读取并检查现货 USDT 余额。
13. 读取并检查合约保证金。

首次预检和确认复检都必须在第 3、4 步分别绕过对应 CCXT 实例已经完成的市场缓存，使用 `loadMarkets(true)` 或语义等价的强制刷新，并等待成功后才检查市场。同一轮预检按现货、合约顺序各刷新一次；CCXT 可以合并尚未完成的强制刷新请求，但不得以已完成的旧缓存代替刷新。市场身份、规则及共同有效数量必须来自本轮刷新得到的规范化快照。刷新失败、市场缺失或无法证明刷新成功时立即停止，不得回退旧缓存。该要求保证绕过本地缓存，不承诺交易所服务端数据没有延迟。

市场加载分为同一份快照上的三个校验阶段：第 3、4 步只验证市场存在、身份和 active；第 9 步才验证 precision mode、数量/价格精度、合约乘数和数量上下限；第 10、11 步分别验证对应市场的名义金额规则。后两阶段仅解析本轮已捕获的元数据，不重新加载市场。账户与价格读取绑定该快照的交易所 symbol，不得内部再次解析完整市场规则而抢先暴露后续失败。现有执行/恢复使用的完整市场加载继续严格验证全部规则。Bitget Classic 现货零最小量兼容仍须具备原有正最小名义金额证据，该特例的适用性属于数量检查。

OKX 账户检查先读持仓模式。实际为 `one-way` 时，只返回这一失败，不再读取持仓列表、保证金模式或杠杆。只有 `hedged` 才继续读持仓，并解析保证金模式与空头杠杆。

价格、余额、账户设置不得再用一次 `Promise.all` 并行读取。

## 5. 确认复检与预检失效

来源：旧 spec 第 8 节，以及第 4 节里只与新状态有关的部分。

### 5.1 确认所有权与检查顺序

HTTP 请求字段校验通过后，确认入口先取得该策略现有的 `strategy-operation-owner` 操作锁，再读取策略。该锁与协调器、监控续跑共用，覆盖“初读策略 → 完整异步复检 → 执行认领或失效事务提交”的整个区间，并在所有退出路径中通过 `finally` 释放。交易所读取期间只持有进程内操作锁，不保持 SQLite 写事务。

未取得操作锁时立即返回 `409 / STRATEGY_OPERATION_BUSY`，不读取策略、不发起复检、不写库、不排队执行。错误对象指向该策略的操作所有权，期望为 `available`，实际为 `busy`，不得把锁忙伪装成已观察到 `EXECUTING`，也不自动重试。

持锁后，确认接口同步执行：

1. 检查策略存在。
2. 检查状态为 `PENDING_CONFIRMATION`。`EXECUTING` 及其他状态都不得再被 HTTP 确认接口受理。监控器对已处于 `EXECUTING` 或 `WAITING_HEDGE` 的任务继续调用现有执行入口，这不是一次新的确认。
3. 检查策略没有任何订单，且没有既有失败记录。`PENDING_CONFIRMATION` 携带订单或失败记录属于存储完整性异常，返回 `500 / STORAGE_RECORD_INVALID`，不发起复检或改写状态。
4. 重新执行第 4 节的完整有序预检。
5. 比较市场身份、市场规则、共同有效数量、持仓模式、保证金模式和杠杆是否仍与预检快照一致。
6. 用最新参考价重新计算资金要求，并确认最新余额仍然足够。
7. 全部通过后，按第 5.2 节的条件写入事务原子变为 `EXECUTING`。
8. 事务成功提交后释放操作锁，返回 `202`，再调度后台执行。不得在仍持有确认操作锁时调用协调器，避免执行入口因锁忙而跳过。后台执行与监控继续进入现有对账流程，并由共享操作锁防止重复下单。

价格和余额不要求等于旧快照，但最新值必须证明订单仍满足市场和资金条件。

### 5.2 条件写入与失败语义

策略存在、状态及无订单/无失败检查通过之后，持锁期间的业务复检失败、外部读取失败或未知值，都尝试在同一事务中变为 `PREFLIGHT_INVALIDATED` 并保存第 6 节的完整精确失败，不创建订单。失效事务提交成功后，本次确认返回 `409`，错误体保留该次复检的具体原因，状态接口返回同一份失败；操作员必须重新预检。

执行认领与失效写入必须具有相同的提交前置条件：事务内确认策略仍为 `PENDING_CONFIRMATION`、没有任何订单、两类失败记录均为空，且策略身份与预检快照仍与本次读取时一致；条件成立才能执行状态 CAS。失效状态与完整精确失败必须一起提交或一起回滚。原子性不能仅依赖 HTTP 初读检查或进程内操作锁。

持有共享操作锁且生产数据库由单进程独占时，上述前置条件意外不成立，或状态 CAS 没有恰好更新一条记录，都属于存储完整性异常，返回 `500 / STORAGE_TRANSITION_REJECTED`。错误指出失败的条件及安全的实际证据，不得解释为正常确认竞争，也不得声称已经失效、保留了旧状态或已经受理；不覆盖现有数据、不创建订单、不排队执行。初读时已经观察到非待确认状态返回 `409`，与此类异常区分。

SQL 执行或提交失败返回 `500 / STORAGE_OPERATION_FAILED`。事务应回滚，未提交的状态和失败记录不得部分落库；只有能够证明回滚成功且仍为 `PENDING_CONFIRMATION` 时，才可声称保留了原状态。若回滚或回读也失败，错误必须明确结果无法确认，不得伪称状态不变。所有存储失败路径都不得返回 `202` 或排队执行。

### 5.3 状态与恢复边界

`PREFLIGHT_INVALIDATED` 是终态，表示确认复检失败且没有订单。它不改变对账模块对 `EXECUTING`、`WAITING_HEDGE`、`HEDGED`、`HEDGE_INCOMPLETE`、`FAILED` 的写入权。`PENDING_CONFIRMATION` 仍然不得有订单。

这个新状态和它的精确失败必须经 schema 迁移落在当前 v2 之上，重启后状态接口仍能读到。`FAILED` 与 `HEDGE_INCOMPLETE` 继续使用现有 `failure_code`。

## 6. 操作员可见的精确错误

来源：旧 spec 第 3、6、13、14、15 节中，与启动、HTTP、预检和确认有关的部分。

给操作员看的错误使用这一种结构。中文 `message` 由错误工厂按错误码和结构字段生成，调用方不得另写一句和字段矛盾的说明。

```ts
interface ErrorDetail {
  readonly code: string;
  readonly phase: 'startup' | 'request' | 'preflight' | 'confirmation' | 'storage';
  readonly subject: ErrorSubject;
  readonly expected: SafeDiagnosticValue;
  readonly actual: SafeDiagnosticValue;
  readonly message: string;
  readonly occurredAt: string;
}
```

`ErrorSubject` 只表示配置项、HTTP 字段、交易所、市场、账户设置、策略或数据库对象。标识字段有固定长度上限。`SafeDiagnosticValue` 只允许 `string | number | boolean | null | readonly string[]`。凭证的实际值只能是 `missing` 或 `present-but-invalid`，不得传入原值。

原始 `cause`、stack、第三方消息和属性不得写入 SQLite、HTTP 响应、交易事件或界面。未知异常在所属边界转成精确错误，例如说明期望成功读取、实际为哪一类失败，不得原样透传。

HTTP 错误体为 `{ "requestId", "error": ErrorDetail }`。状态码：

- `400`：请求语法或字段格式错误。
- `403`：Host 或 Origin 安全边界失败。
- `404`：策略不存在。
- `409`：策略操作锁被占用、策略状态不允许确认，或确认复检已成功写入预检失效。
- `422`：业务预检条件不满足。
- `500`：已经转换成安全说明的内部失败。

Fastify/AJV 的校验错误要变成上述结构，指出字段路径、期望结构和安全的实际类型或值，不把原始校验对象返回给客户端。Host 或 Origin 失败后不得读取、缓存或解析请求 body。

状态接口在 `PREFLIGHT_INVALIDATED` 时返回该策略的精确失败。界面用中文标签展示消息、阶段、对象、期望和实际，服务端内容只通过 `textContent` 写入。

本阶段至少使用这些错误码，且一个码只描述一种失败：

- 启动与配置：`CONFIG_FIELD_MISSING`、`CONFIG_FIELD_INVALID`、`DATABASE_OPEN_FAILED`、`DATABASE_SCHEMA_VERSION_MISMATCH`、`DATABASE_OWNERSHIP_BUSY`、`DATABASE_OWNERSHIP_UNAVAILABLE`、`SERVICE_COMPONENT_FAILED`、`SERVICE_LISTEN_FAILED`。
- HTTP：`REQUEST_FORBIDDEN`、`REQUEST_BODY_INVALID`、`REQUEST_FIELD_INVALID`、`STRATEGY_NOT_FOUND`、`STRATEGY_STATE_MISMATCH`、`STRATEGY_OPERATION_BUSY`。
- 预检与确认：`EXCHANGE_NOT_CONFIGURED`、`MARKET_UNAVAILABLE`、`MARKET_IDENTITY_MISMATCH`、`MARKET_INACTIVE`、`MARKET_RULE_INVALID`、`ACCOUNT_SETTINGS_UNAVAILABLE`、`ACCOUNT_SETTINGS_CONFLICT`、`ACCOUNT_POSITION_MODE_MISMATCH`、`ACCOUNT_MARGIN_MODE_MISMATCH`、`ACCOUNT_LEVERAGE_MISMATCH`、`QUANTITY_INVALID`、`QUANTITY_NOT_REPRESENTABLE`、`QUANTITY_OUT_OF_RANGE`、`PRICE_UNAVAILABLE`、`PRICE_INVALID`、`NOTIONAL_OUT_OF_RANGE`、`BALANCE_UNAVAILABLE`、`BALANCE_INSUFFICIENT`、`PREFLIGHT_INVALIDATED`。
- 存储：`STORAGE_OPERATION_FAILED`、`STORAGE_RECORD_INVALID`、`STORAGE_TRANSITION_REJECTED`。

对账已经使用的 `failure_code` 和 pending reason 保持原意。本文不另造一套码去描述同一件对账失败。

启动顺序保持当前 `main`，不改回旧 spec 那份省略了独占锁和资金费率的清单：

1. 配置：资金费率间隔、交易所集合、凭证、数据库路径、`HOST`、`PORT`。凭证错误只报告字段缺失或安全类别。
2. 创建数据库父目录。
3. 打开数据库。
4. 取得 SQLite 独占所有权。
5. 初始化 schema 和仓储。
6. 构造资金费率组件、网关、预检、对账、协调器、监控和 HTTP。
7. 启动恢复监控：注册定时任务并发起首次恢复，不等待整轮恢复完成。
8. 绑定监听地址。
9. 监听成功后再启动资金费率同步。

前一步失败不得执行后续步骤。数据库、schema 或所有权失败时，不得启动恢复、HTTP 或资金费率同步。这些失败使用上面的精确错误。

监控启动或监听失败时，沿用当前幂等清理顺序：停止资金费率组件、停止监控并等待已启动的恢复退出、关闭 HTTP，最后关闭数据库释放独占所有权。清理中某一步失败仍须尝试后续清理，且不得覆盖导致启动失败的精确错误。监听失败不得启动资金费率同步；已启动的恢复按现有执行及对账流程退出。单个策略的异步恢复失败继续遵循现有监控规则，不改成同步启动失败。

下列内容不得进入精确错误、HTTP、SQLite、交易事件或界面：API key、secret、password、完整环境变量、Authorization、Cookie 或其他请求头、CCXT 原始请求和响应、SQLite 原始损坏载荷、cause 链和 stack。日志仍然只是旁路；日志失败不得改变 HTTP、数据库、策略状态或下单。

## 7. 验收

测试使用 fake gateway、临时或内存 SQLite、临时环境值。不得读取真实 `.env`，不得访问真实交易所。

必须证明：

- 预检按第 4 节的顺序执行，首个失败后没有后续读取。
- OKX 持仓模式为 `one-way` 时，不再读取持仓、保证金模式、杠杆、价格或余额。
- 首次预检失败不写策略。
- 首次预检与确认复检按现货、合约顺序各强制刷新一次市场。fake CCXT 先缓存旧规则，再改变上游规则；确认必须读到变化并使预检失效。分别覆盖市场身份、可交易状态、数量/价格精度、合约乘数及数量/名义金额限制变化。
- 已有市场缓存时刷新失败也必须立即停止，不得回退旧缓存或继续读取后续账户、价格、余额。首次预检不写策略，确认复检在失效事务成功时进入 `PREFLIGHT_INVALIDATED`。
- 失败的确认请求不认领策略、不规划订单、不提交订单、不返回 `202`；锁忙拒绝不阻止当前持锁操作按其自身规则继续。
- 用可控延迟覆盖并发确认：首个持锁请求分别复检成功、业务失败、读取失败；竞争请求一律得到精确的 `409 / STRATEGY_OPERATION_BUSY`，且没有额外复检、状态写入或执行调度。所有持锁路径最终释放操作锁；锁空闲且先前确认已提交时，再次请求按实际状态返回 `409`，执行仍持锁时则返回操作锁忙。
- 持锁期间注入状态变化、订单出现、失败记录出现、策略/预检快照变化及 CAS 零更新，均得到 `500 / STORAGE_TRANSITION_REJECTED`，不覆盖已有数据、不声称正常竞争或确认成功。
- 复检失败原子进入 `PREFLIGHT_INVALIDATED`，并保存完整精确失败；事务失败且成功回滚时原状态仍为 `PENDING_CONFIRMATION`，无部分失败记录。回滚或回读失败时明确结果无法确认，不返回 `202` 或调度执行。
- HTTP 对 `EXECUTING` 再次确认得到 `409`，且不重复受理。监控器仍能续跑已经处于 `EXECUTING` 或 `WAITING_HEDGE` 的任务。
- 确认成功后才变为 `EXECUTING` 并返回 `202`，释放确认操作锁后才调度协调器；与监控同时续跑也只提交一次。事务提交后、后台调度前中断，重启监控仍能恢复该 `EXECUTING` 策略；之后的成交与终态仍由对账模块决定。
- 上述范围内的错误都有对象、期望、实际和中文消息，且不含凭证或原始响应。
- `PREFLIGHT_INVALIDATED` 及其精确失败在重启后仍能由状态接口和界面读到。
- 启动调用顺序包含“组件构造 → 启动恢复监控 → HTTP 监听 → 资金费率同步”。监控启动失败不监听，监听失败不启动资金费率同步；两者都执行幂等清理，等待恢复退出后才关闭数据库，清理异常不覆盖启动错误。
