| 决策主题 | 已确认决策 | 来源 | 确认日期 |
| --- | --- | --- | --- |
| 剩余决策授权 | 后续未决实现项只要符合正确性优先原则即可由执行方自动确认并继续，不再逐项等待确认。 | 用户明确回答 | 2026-09-06 |
| 历史与周期 | 首期逐市场回填公共接口当前可见的全部历史记录，默认每小时增量同步；完整仅表示按交易所分页语义证明接口可见范围已穷尽。 | 已批准 spec：2026-09-06-funding-rate-history-sync-design.md#3.3-保留与访问 | 2026-09-06 |
| 同步范围 | 首期同步 Bitget 与 OKX 本轮公共接口可见的所有明确 active USDT 线性永续市场，不宣称不可观察的交易所绝对全集。 | 已批准 spec：2026-09-06-funding-rate-history-sync-design.md#3.1-交易所与市场 | 2026-09-06 |
| 请求结果分类 | 请求执行使用显式名义类型区分正常取消与重试耗尽；取消原样传播且不写失败状态，重试耗尽写 REQUEST_RETRY_EXHAUSTED，其他请求或源 rejection 写 SOURCE_RESPONSE_INVALID；每次重试经必填 observer 和安全事件边界记录。 | 已批准 spec：2026-09-06-funding-rate-history-sync-design.md#8.2-请求边界 | 2026-09-06 |
| CCXT 错误类型锁定 | package.json 与 package-lock.json 都精确固定 4.5.68；生产和测试只以同一 ESM 入口的 NetworkError 原型身份分类，不使用运行时版本字符串、CommonJS 交叉实例或同名伪造错误。 | 已批准 spec：2026-09-06-funding-rate-history-sync-design.md#4-外部语义证据与限制 | 2026-09-06 |
| 同步器生命周期边界 | stop 后 start 永久 no-op；运行中 discovery 的重复 tick 合并且不积压；双 worker 同时 fatal 时在完整 join 后按 bitget、okx 固定顺序选择错误。 | 已批准 spec：2026-09-06-funding-rate-history-sync-design.md#8-调度限流与生命周期 | 2026-09-06 |
| 增量完成计数 | funding_incremental_completed 的 inserted、unchanged、revised 是本次 generation 所有已提交非空页的累计值，失败页、空终止页和 stale 页不计数。 | 已批准 spec：2026-09-06-funding-rate-history-sync-design.md#7.4-增量同步 | 2026-09-06 |
| 数据口径 | 只保存已经结算的历史资金费率，Bitget 使用 raw fundingRate，OKX 使用 raw realizedRate，不保存当前、预测或下一期未结算费率。 | 已批准 spec：2026-09-06-funding-rate-history-sync-design.md#3.2-数据类型 | 2026-09-06 |
| 覆盖恢复 fencing | 每个新建或中断恢复的 coverage task 都在首次请求前递增 generation；Bitget 必见边界或 OKX 初始 after 作为该 generation 的不可变持久 task 启动字段，所有 repository 写入口比较完整 lease，中断恢复保留 cutoff 和任务类型但不复用旧 generation。 | 已批准 spec：2026-09-06-funding-rate-history-sync-design.md#6.3-funding_rate_sync_state | 2026-09-06 |
| 增量冻结边界 fencing | incremental task 的 generation 与任务启动事务冻结的 latest 一同持久化；资格、页面和所有终态入口 null-safe 比较完整 provenance，页面推进不移动边界，终态/市场转换清空，伪造边界在请求或写入前 fail-closed。 | 已批准 spec：2026-09-06-funding-rate-history-sync-design.md#6.3-funding_rate_sync_state | 2026-09-06 |
