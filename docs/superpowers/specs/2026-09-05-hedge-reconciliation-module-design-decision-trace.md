| 决策主题 | 已确认决策 | 来源 | 确认日期 |
| --- | --- | --- | --- |
| 测试约定 | 对账测试独立为 tests/strategy/hedge-reconciliation.test.ts，使用 fake 网关与临时或内存 SQLite。先红后绿。覆盖查所失败/部分成功、planned 找不到、无市价腿、市价仍 open、等量 HEDGED、1 对 0.6 的 need_gtc、已有 open GTC、GTC 拒撤、双零 NO_FILL、缺均价。旧协调器/监控器测试改为断言未经 run 不能终态或补 GTC。 | 用户明确回答 | 2026-09-05 |
