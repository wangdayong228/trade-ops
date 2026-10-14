# 状态接口汇总快照调整

## 依据与适用范围

用户于 2026-10-14 明确要求 GET /api/status 只返回汇总快照、移除各交易所 markets，并同步状态页和测试，刷新须落在现有 10 秒超时内。本文落实该已确认契约，替代 2026-10-06-runtime-status-design.md 中的市场明细输出、市场表格/搜索及按明细核验计数要求；其他生命周期、发现、错误证据、只读与安全约束继续有效。

## 技术栈与实现选择

沿用已确认的 Node.js >=20、TypeScript、Fastify 5、better-sqlite3 12、原生 HTML/CSS/JavaScript 与 node:test。没有新增依赖、配置、数据库结构或待确认技术选型。验证使用已安装的 Node 20.19.4（兼容当前 SQLite 原生模块）。

采用现有 repository.listMarketStates 的严格校验结果计算计数，移除逐市场公开字段投影、脱敏、JSON 输出及页面校验/渲染。两交易所的读取保持同步、使用现有独占连接；损坏状态仍返回错误。SQL 专用聚合会绕过现有跨字段完整性校验；新增缓存会引入时效与失效规则。这两种方案均非本次必要改动。

本地基线（内存 SQLite、每交易所输入 2,000 条发现记录，实际共 2,000 个已知市场）：读取约 25 ms，旧接口三次约 127/93/87 ms，响应 1,385,729 bytes。未复现生产 10 秒超时；本次通过消除明细传输和渲染成本、增加重复刷新回归测试验证性能余量，不宣称消除任意主机负载或网络延迟。

## 契约与页面

成功响应仅含以下字段，原有字段取值及枚举保持：

```text
generatedAt
status
service { phase, startedAt, uptimeMs }
database
funding {
  status, intervalMs, lastFatal,
  exchanges [{ exchangeId, counts { total, active, inactive, coverage, incremental }, discovery }]
}
```

coverage 包含 PENDING/BACKFILLING/CAUGHT_UP/INCOMPLETE；incremental 包含 IDLE/RUNNING/INCOMPLETE，零值也必须存在。始终返回 Bitget、OKX 两项；counts 统计所有已知市场（含 inactive），discovery 继续表示本进程观测结果。

状态页保留服务、同步器、两交易所计数与发现诊断；删除市场表格、搜索、筛选及专属样式。客户端保留字段、枚举、非负安全整数、时间、错误证据和 readiness/fatal/discovery 一致性校验，并要求 active+inactive=total、coverage 全部分类合计=total、incremental 全部分类合计=total。失败时保留最后可信快照并标记过期。

继续每次请求结束后 10 秒调度刷新、10 秒请求超时、请求串行、隐藏暂停/恢复立即刷新和 textContent 安全渲染。

## 验收与风险矩阵

| 风险 | 验证 |
| --- | --- |
| 契约仍泄露/输出明细 | 空与非空响应检查精确键集合、无 markets、响应大小不随明细体积增长 |
| 计数丢失状态或混淆两交易所 | 混合 active/inactive 与独立 coverage/incremental，覆盖所有分类与零值 |
| 汇总错误冒充健康 | 三组计数矛盾/非法数字拒绝覆盖旧快照；repository 损坏仍报错 |
| 删除表格导致页面中断 | 测试 DOM 仅提供 HTML 中真实存在的 ID；汇总无 markets 正常渲染 |
| 刷新回退 | 4,000 个市场、重复 HTTP→解析→校验→渲染刷新，各次 <10,000 ms；响应 <10 KB（无长错误证据的基准样本） |
| 诊断/安全退化 | 保留 fatal/discovery 脱敏、Host/CSP/no-store、无写入/网关调用及轮询生命周期回归 |

验证仅用 fake gateways/sources、内存 SQLite、临时环境值；不运行生产入口或读取真实凭证/数据库，不调用交易所。
