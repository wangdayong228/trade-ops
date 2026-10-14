| 决策主题 | 已确认决策 | 来源 | 确认日期 |
| --- | --- | --- | --- |
| 状态汇总契约 | GET /api/status 只返回 generatedAt、status、service{phase,startedAt,uptimeMs}、database、funding{status,intervalMs,lastFatal,exchanges[{exchangeId,counts{total,active,inactive,coverage,incremental},discovery}]}，去掉 markets，并同步状态页与测试，使刷新稳定落在 10 秒超时内。 | 用户明确回答 | 2026-10-14 |
