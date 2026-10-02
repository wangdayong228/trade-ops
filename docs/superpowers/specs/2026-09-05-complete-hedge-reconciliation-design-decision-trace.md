| 决策主题 | 已确认决策 | 来源 | 确认日期 |
| --- | --- | --- | --- |
| 完全对账定义 | 进入 HEDGED、FAILED、HEDGE_INCOMPLETE 或决定补 GTC 之前，必须做到本地策略状态、本地订单与交易所快照在角色、数量、状态上一致，并核对两腿成交量、对残差给出唯一解释：已对冲、需补 GTC、或明确失败。对账未完成时不得转入这些终态，也不得宣称完成。WAITING_HEDGE 只表示市场腿对账后已挂出 GTC，GTC 成交后仍须再做完全对账。 | 已批准 spec：docs/superpowers/specs/2026-09-05-complete-hedge-reconciliation-design.md#3. 完全对账 | 2026-09-05 |
| 对账模块本期范围 | 本期做本任务成交量对账的独立最后关卡，不核对交易所余额或持仓。 | 用户明确回答 | 2026-09-05 |
| 对账数据来源 | 进入 HEDGED 前必须按本任务的 client/exchange order ID 向交易所再查一遍订单，用查到的快照独立加总。查不到或查询失败则不准进入 HEDGED。 | 用户明确回答 | 2026-09-05 |
| HEDGED 写入权 | 只有对账模块能把状态写成 HEDGED。协调器下完第二腿、监控器刷新后都只能调用对账模块；它先查所、再独立加总，通过才完结。协调器与监控器不得再各自标完成。 | 用户明确回答 | 2026-09-05 |
| 对账模块独占入口 | 只有对账模块能转入 HEDGED、FAILED、HEDGE_INCOMPLETE；也只有它返回「需补 GTC」后协调器才能挂差额单。协调器与监控器不得自行终态或自行决定补 GTC。 | 用户明确回答 | 2026-09-05 |
| 对账模块结构 | 采用独立对账关卡：HedgeReconciliation.settle 负责查所、落库、解释残差并独占写入终态；需补 GTC 时只返回授权，由协调器下单后再 settle。对账模块不下单。 | 用户明确回答 | 2026-09-05 |
| 对账模块简单边界 | 入口为 HedgeReconciliation.run(strategyId)。模块查所后自己 attachOrderSnapshot 落库。WAITING_HEDGE 由模块在 GTC 已在所上且未完全成交时写入。need_gtc 只返回角色、数量、参考价，限价量化和 submit 仍在协调器。本期不改 HTTP/UI、状态枚举、订单角色。实现另写 docs/superpowers/specs/2026-09-05-hedge-reconciliation-module-design.md，不扩大原则 spec 的只改 code-rules 范围。 | 用户明确回答 | 2026-09-05 |
| 残差唯一解释 | run 按固定顺序只落一种结论：1) 查所/落库/三方不一致则 pending，不写终态、不需补 GTC；2) 市价腿未到可靠终态（closed，或 canceled 且成交可信）则 pending；3) 已有 GTC 则只评估该单：open 写 WAITING_HEDGE，完全成交且两腿对齐写 HEDGED，拒单/撤单/量不一致写 HEDGE_INCOMPLETE，不再返回 need_gtc；4) 无 GTC 且市价均可靠终态时，两腿正成交且相等则 HEDGED，双零则 FAILED/NO_FILL，有残差且大侧有正均价则 need_gtc，缺均价则 HEDGE_INCOMPLETE/MISSING_AVERAGE_PRICE，拒单无成交则 FAILED/ORDER_SUBMISSION_FAILED，其余畸形按是否有正成交写 HEDGE_INCOMPLETE 或 FAILED。顺序模式同样走此表。忽略手续费。协调器与监控器不再各自解释残差。 | 用户明确回答 | 2026-09-05 |
| run 调用约定 | run 自己不抢锁，调用方必须已持有 tryAcquireStrategyOperation。查所部分成功则成功快照先落库，整次仍 pending。planned 且所上找不到则为 pending，不当失败。run 可记对账结论日志；逐笔 order_* 事件仍由提交/监控路径记录。 | 用户明确回答 | 2026-09-05 |
| need_gtc 提交路径 | 监控器仍只调用 confirmAndExecute。协调器先 run()：need_gtc 则只提交当次授权的一张 GTC 再 run()；pending 或模块已写入终态/WAITING_HEDGE 则返回；尚无市价腿则按模式提交市价再 run()。任何 GTC 必须来自当次 run() 的 need_gtc。尚无市价腿时 run 不得给出 need_gtc 或 HEDGED，只表示等待市价提交。 | 用户明确回答 | 2026-09-05 |
| 测试约定 | 对账测试独立为 tests/strategy/hedge-reconciliation.test.ts，使用 fake 网关与临时或内存 SQLite。先红后绿。覆盖查所失败/部分成功、planned 找不到、无市价腿、市价仍 open、等量 HEDGED、1 对 0.6 的 need_gtc、已有 open GTC、GTC 拒撤、双零 NO_FILL、缺均价。旧协调器/监控器测试改为断言未经 run 不能终态或补 GTC。 | 用户明确回答 | 2026-09-05 |
