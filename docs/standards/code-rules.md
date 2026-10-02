# Code Rules

1. **先检查，再执行**：入口按固定顺序 fail-fast；必要条件全部通过后才执行。只读入口仅在检查能提高错误准确性时检查。

   > 示例：合约预检先检查持仓模式；实际为 `one-way` 时立即返回，仅为 `hedged` 时继续。

2. **错误必须精确**：包含定位所需的对象、期望与实际情况，且不得泄露敏感信息。

   > 示例：`OKX BTC/USDT 持仓模式检查失败：期望 hedged 模式，实际为 one-way 模式`，不得返回 `invalid account settings`。

3. API 错误日志必须包含请求信息，至少应该有 method path query body
   如 `{"level":40,"time":1786254863135,"service":"trade-ops","version":"1.0.0","reqId":"req-9","res":{"statusCode":422},"responseTime":1202.4819170000264,"httpError":{"code":"PREFLIGHT_REJECTED","message":"Preflight checks did not pass","error":{"type":"Error","message":"confirmed account settings require isolated or cross margin mode","stack":"Error: confirmed account settings require isolated or cross margin mode\n    at confirmedAccountSettings (file:///Users/dayong/myspace/mywork/trade-ops/dist/src/strategy/preflight-service.js:71:15)\n    at PreflightService.run (file:///Users/dayong/myspace/mywork/trade-ops/dist/src/strategy/preflight-service.js:156:27)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)\n    at async Object.<anonymous> (file:///Users/dayong/myspace/mywork/trade-ops/dist/src/http/server.js:622:23)"}},"httpRequest":{"method":"POST","url":"/api/hedges/preflight","body":{"spotExchangeId":"bitget","contractExchangeId":"okx","symbol":"BTC/USDT","requestedBaseQuantity":"1","mode":"CONTRACT_FIRST"},"truncated":false,"originalByteLength":126},"msg":"request completed"}`

4. **对冲必须完全对账**：对账是重中之重。凡会推进对冲状态的路径（协调器执行/续跑、订单监控、重启恢复），在进入 `HEDGED`、`FAILED`、`HEDGE_INCOMPLETE` 或决定补 GTC 之前，必须完成完全对账：本地策略状态、本地订单与交易所快照在角色、数量、状态上一致，并核对两腿成交量、对残差给出唯一解释（已对冲 / 需补 GTC / 明确失败）。不得在对账未完成时宣称对冲完成或结束任务。

   > 示例：并发开仓现货成交 `1`、合约成交 `0.6` 时，必须先对账再对合约补 `0.4` 的 GTC；不得直接标为 `HEDGED`，也不得在未查回两腿订单时标为 `FAILED`。