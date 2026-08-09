# HTTP 完成日志错误详情设计

## 1. 目标

每个已完成 HTTP 请求仍只输出一条普通 `request completed` 日志。最终状态为 `4xx` 或 `5xx` 时，这条唯一完成日志同时包含：

- 稳定、经过脱敏的 `httpError`；
- 尽量完整、经过脱敏的 `httpRequest` 失败请求快照；
- `4xx` 使用 `warn`，`5xx` 使用 `error`。

成功及重定向请求继续使用 `info`，不增加 `httpError` 或 `httpRequest`。HTTP 状态、响应 JSON、交易流程、持久化和后台执行行为保持不变。

## 2. 已批准的最小方案

接管 Fastify 自动完成日志，在响应完成后的统一生命周期位置输出唯一的 `request completed`。已知失败路径只把稳定 HTTP 错误语义写入请求级上下文；请求快照由统一的请求捕获边界建立，不允许各失败路径自行拼装或另写日志。

该方案只有四项新增职责：

1. 在任何 body 观察或 parser 运行前执行 Host/Origin 请求边界检查，拒绝时不读取或缓存 payload；
2. 对通过边界的请求，在独立的 `1 MiB` 原始 body 观察安全预算内捕获 method、原始 request URL 和 body；
3. 输出前对错误详情和请求快照执行同一套配置敏感值替换，并对最终 body 日志表示执行 `8192` 字节上限截断；
4. 在唯一完成日志中按最终状态决定级别与字段。

不新增依赖、日志总线、旁路失败事件或响应解析逻辑。

## 3. 范围

覆盖 `buildServer` 创建的全部 HTTP 请求，以及所有最终 `4xx/5xx`，包括：

- schema 校验和无效 JSON 的 `400`；
- 本地边界拒绝的 `403`；
- 业务或框架产生的 `404`；
- 预检拒绝的 `422`；
- 未处理异常的 `500`；
- Fastify、插件和未来路由产生的其他最终失败状态。

本设计同时覆盖脱敏、body 截断、请求隔离、日志故障隔离、事件去重，以及无效 JSON 的原始 body 捕获。

## 4. 非目标与硬边界

- 不改变 HTTP 状态、响应 body、公开错误字段或浏览器展示。
- 不记录任何请求 headers；包括 authorization、cookie、origin、host 和转发 headers。
- 不记录响应 body、原始交易所 request/response/config、环境对象、SQLite 行或完整错误对象/cause 链。
- 不从响应 body 反推错误语义。
- 不新增 `http_request_failed`、`unhandled_http_request_failure` 或其他旁路 HTTP 失败事件。
- 不改变预检、确认、订单提交、恢复、幂等、事务或策略状态机。
- 失败预检不新增任何数据库写入；日志捕获与输出均不得触发持久化。
- 不调用真实交易所 API，不读取工作区 `.env`，不使用真实业务 SQLite。

## 5. 唯一完成日志

关闭 Fastify 自动请求完成日志，在 `onResponse`（或该 Fastify 版本等价的响应完成钩子）输出一条 `msg: "request completed"`。

基础兼容字段保持为：

```json
{
  "level": 40,
  "reqId": "req-3",
  "res": { "statusCode": 422 },
  "responseTime": 12.4,
  "msg": "request completed"
}
```

级别和附加字段只由最终状态决定：

- `< 400`：`info`，不得出现 `httpError` 或 `httpRequest`；
- `400–499`：`warn`，必须出现 `httpError` 和 `httpRequest`；
- `>= 500`：`error`，必须出现 `httpError` 和 `httpRequest`。

每个进入响应完成钩子的请求恰好一条完成日志。已知错误路径不得直接输出同义完成/失败事件。连接在响应完成前中断时，不猜测补写“已完成”日志。

## 6. `httpError` 契约

失败日志包含：

```json
{
  "httpError": {
    "code": "PREFLIGHT_REJECTED",
    "message": "Preflight checks did not pass",
    "error": {
      "type": "AuthenticationError",
      "message": "authentication failed: [Redacted]",
      "code": "40101",
      "stack": "AuthenticationError: ..."
    }
  }
}
```

约束：

- `code` 和 `message` 是本次 HTTP 失败的稳定语义；
- 可选 `error` 只来自现有 `safeError`，仅允许 `type`、`message`、字符串 `code`、`stack`；
- 不把原异常交给 logger，不展开任意属性，不遍历完整 `cause`；
- 没有底层异常时省略 `error`，不伪造 Error、stack 或 cause；
- 摘要失败时仍保留稳定 `code/message`。

已知映射保持：

- `400`：`INVALID_REQUEST / Request validation failed`；
- `403`：`FORBIDDEN / Request forbidden`；
- 业务 `404`：`STRATEGY_NOT_FOUND / Strategy not found`；
- `422`：`PREFLIGHT_REJECTED / Preflight checks did not pass`；
- `500`：`INTERNAL_ERROR / Internal server error`。

没有请求级错误摘要的其他 `4xx/5xx` 使用：

- `code: HTTP_ERROR`；
- `message: HTTP request failed with status <statusCode>`。

兜底只读取最终状态码，不读取响应 body。

## 7. `httpRequest` 失败请求快照

所有最终 `4xx/5xx` 的唯一完成日志必须包含：

```json
{
  "httpRequest": {
    "method": "POST",
    "url": "/api/hedges/preflight?dryRun=false",
    "body": {
      "symbol": "BTC/USDT"
    },
    "truncated": false,
    "originalByteLength": 21
  }
}
```

字段语义：

- `method`：Fastify 看到的请求 method；
- `url`：请求进入服务端时的完整原始 request URL/request-target，保留 query，不规范化、不删除参数、不按参数名过滤；不使用 Host、Origin 或转发 headers 拼接绝对 URL；
- `body`：尽量保留请求 body。正常解析时优先保留 JSON 兼容的结构化值；无效 JSON 或 parsed body 不可用时保留捕获到的原始 UTF-8 文本；无 body（包括 Host/Origin 边界早拒绝）时使用 `null`；若原始 body 超过捕获安全预算且没有可用 parsed body，则使用 `[Unavailable]`，不得记录原始前缀；
- `truncated`：body 的脱敏后 UTF-8 表示是否因上限被截断；
- `originalByteLength`：body 完成敏感值替换后、截断前的 UTF-8 字节数。

`method` 和 `url` 不受 body 字节上限影响。URL 必须包含完整 query，但其中命中的配置敏感值仍替换为 `[Redacted]`。HTTP 解析器自身拒绝的超限/非法 URL 只能记录框架实际提供给请求生命周期的值，不尝试从 socket 或 headers 重建。

### 7.1 body 表示与截断

默认 body 上限为 UTF-8 `8192` 字节，作为实现中的命名常量；本次不增加运行时配置或环境变量。

处理顺序固定为：

1. 选择结构化 parsed body；若不可用则选择原始 body 文本；无 body 则选择 `null`；
2. 转换为可安全记录的 JSON 兼容表示；
3. 对所有可输出字符串（包括结构化对象的键和值）做配置敏感值精确子串替换；
4. 计算脱敏后、未截断表示的 `originalByteLength`；
5. 超过 `8192` 字节时，在 UTF-8 字符边界截断，并设置 `truncated: true`。

未截断的结构化 body 保持 JSON 对象、数组、标量或 `null`。超限 body 允许退化为该脱敏后紧凑 JSON/文本的 UTF-8 安全前缀字符串；此时 `truncated` 明确表明它不再是完整结构。不得为维持结构而静默删除任意字段。

截断必须发生在脱敏之后，避免敏感值跨截断边界而逃逸。`originalByteLength` 也按脱敏后表示计算，避免通过长度暴露被替换凭证的原始长度。截断结果不得产生损坏的 UTF-8 或孤立 surrogate。

### 7.2 原始 body 捕获

无效 JSON 在 Fastify 完成解析前失败，此时 `request.body` 可能不存在。因此，通过 Host/Origin 边界的请求必须在 content-type parser 之前、以透明方式观察 request payload，不能只依赖 parsed body。Host/Origin 检查必须位于 `onRequest` 或等价的 pre-body 生命周期阶段，先于任何 body 观察与 parser；该边界拒绝时直接返回 `403`，`httpRequest.body` 为 `null`，且不得读取、缓存或记录攻击 payload。

原始字节观察由专用生产单元 `src/http/request-body-capture.ts` 承担。该单元导出 `RAW_REQUEST_BODY_CAPTURE_LIMIT`、`createRequestBodyCapture()` 和 `createRequestBodyCaptureTransform()`：前者建立小型请求捕获状态单元，后者把该状态单元接入透明 `Transform`。捕获结果只有三种明确状态：`complete` 表示预算内完整保留并报告总字节数，`unavailable` 表示超预算或捕获失败且不得再暴露任何已存前缀，`released` 表示原始字节已主动释放且 append 不得重新启动捕获。`release()` 必须幂等；结果不得暴露可修改的内部存储。

该专用单元只负责按顺序观察、计数、预算降级、释放和透明转发，不负责 Fastify 请求关联、Host/Origin 决策、parsed-body 选择、脱敏或日志表示。`server.ts` 仍负责为每个已通过边界的请求建立并关联一个捕获实例，在 parsed body 可用时调用 `release()`，并在请求生命周期结束时清理关联状态。透明 transform 必须把原始 chunk 原样、按顺序交给下游；即使捕获观察抛错，也不得改变 parser stream。

全局 Fastify `bodyLimit` 显式设为 `1 MiB`（`1_048_576` 字节），原始 body 捕获也使用独立、固定的 `1 MiB`（`1_048_576` 字节）安全预算。两者职责不同：全局 `bodyLimit` 约束默认请求解析；捕获预算只限制旁路观测所保留的原始字节。路由可以显式设置更大的 `bodyLimit`，但不得扩大捕获预算。

捕获边界必须：

- 不改变下游接收到的字节、顺序、背压和解析错误；
- 不改变 content-type 行为、schema 校验或响应；全局解析上限只是把既有默认值显式固定为 `1 MiB`；
- 最多保留 `1 MiB` 原始字节，同时继续透明转发并统计是否超过预算；
- 一旦 parsed body 可用，立即释放原始字节，只保留 parsed body 路径所需状态；否则最迟在生命周期结束后释放；
- 仅把失败日志需要的安全表示送入 logger；
- 对无法解码、流中断、捕获失败或超出捕获预算安全降级，不抛回请求链。

对于有效 JSON，日志优先使用 parsed 结构；对于未超过捕获预算的无效 JSON，使用完整捕获的原始 UTF-8 文本。若原始字节不是有效 UTF-8，采用 Node.js 的确定性 UTF-8 replacement-character 解码，不记录 base64 或二进制转储。若 payload 超过捕获预算且 parser 未产生可用 parsed body（例如 route-level `bodyLimit: 2 MiB` 下约 `1.1 MiB` 的 malformed JSON），`body` 必须为 `[Unavailable]`，不得输出捕获前缀：只有完整输入才能先完成敏感值替换，再执行最终日志截断。该 `1 MiB` 捕获预算与最终日志 body 的 `8192` 字节输出上限互不替代。

## 8. 脱敏规则

脱敏数据源只能是注入的 `secretProvider()` 返回值。规则为：

- 丢弃空字符串；
- 对每个非空配置敏感值执行大小写敏感的精确子串全量替换；
- 替换文本固定为 `[Redacted]`；
- 应覆盖 `httpError` 的全部可输出字符串，以及 `httpRequest.method/url/body` 的全部可输出字符串；
- 不按字段名做额外启发式脱敏，不删除 query/body 字段，不泛化屏蔽普通业务值。

当多个敏感值重叠时，先按 UTF-8 字节长度从长到短替换，再使用稳定次序，避免短值破坏长值匹配。该排序只是确保精确替换完整，不新增模式匹配。

`secretProvider` 抛错时，不得输出未经脱敏的快照或底层异常。失败日志退化为稳定 `httpError.code/message`，`httpRequest` 只保留安全常量占位：method/url/body 分别为 `[Unavailable]`、`[Unavailable]`、`[Unavailable]`，并以该 body 占位计算截断元数据。响应和交易行为不得受影响。

## 9. 请求级上下文与数据流

每个请求拥有生命周期内的隔离上下文，保存：

- 可选稳定 HTTP 错误摘要；
- 原始 body 捕获状态；
- 解析后的 body 引用或其安全快照所需信息。

数据流：

1. 请求进入 `onRequest` 时先捕获 method/原始 URL 并检查 Host/Origin；拒绝则在任何 body 观察/parser 前返回 `403`，body 快照固定为 `null`；
2. 仅对通过边界的请求透明观察原始 body，最多保留独立 `1 MiB` 捕获预算，同时 Fastify 按显式全局 `1 MiB` 或 route-level 覆盖值正常解析；
3. parsed body 可用后立即释放原始字节；Fastify 随后正常校验和执行 handler；
4. 已知失败路径只记住稳定错误语义及可选异常；
5. 响应完成时，以最终状态为准；成功直接写基础完成日志；失败才构造、脱敏和执行最终 `8192` 字节截断的 `httpError/httpRequest`；超过捕获预算且无 parsed body 时使用 `[Unavailable]`；
6. 通过非抛出日志边界输出一次并释放剩余请求数据。

不得使用跨请求共享的可变“当前请求/错误/body”变量。可以使用 request decoration、闭包内 `WeakMap` 或等价请求关联存储。

## 10. 失败路径要求

- `400` schema 校验：记录 parsed body（即使校验失败）及完整 URL query；错误摘要不包含 `validation` 数组。
- `400` 无效 JSON：记录原始无效 JSON 文本及完整 URL query。
- `403` 请求边界拒绝：Host/Origin 必须在 body 观察/parser 前拒绝；记录 method、URL，body 固定为 `null`，不得读取、缓存或记录攻击 payload，且绝不记录导致拒绝的 headers。
- 业务 `404`：记录稳定业务错误；框架 `404` 使用 `HTTP_ERROR`，两者均有请求快照。
- `422` 预检拒绝：记录输入请求快照；不新增或改变 SQLite 写入，失败预检仍不落库。
- `500`：在唯一 `error` 级完成日志中记录详情；移除同一请求的 `unhandled_http_request_failure`。
- 其他 `4xx/5xx`：使用 HTTP 兜底和同一请求快照，不新增旁路事件。

响应完成后的 `background_confirmation_failed` 等异步事件不属于 HTTP 完成日志，保持现状。

## 11. 故障隔离

请求快照和日志属于旁路观测。以下任何失败都不得改变响应、handler 次数、持久化或交易状态：

- payload 捕获、UTF-8 解码或 JSON 安全转换失败；
- `secretProvider` 或敏感值排序/替换失败；
- 错误摘要、body 序列化、字节计数或截断失败；
- 请求级上下文读写失败；
- logger 同步抛错或返回 rejected thenable。

快照局部处理失败时优先使用安全的 `[Unavailable]` 值；无法保证脱敏时不得输出原始内容。日志失败不重试响应、不重跑 handler、不触发订单重试/恢复、不写数据库。

## 12. 测试策略

后续实现严格按 TDD，至少覆盖：

1. 成功与重定向：唯一 `info` 完成日志，无 `httpError/httpRequest`；
2. `4xx/5xx`：分别唯一 `warn/error`，同时含 `httpError/httpRequest`；
3. URL：query 完整保留，普通值不因字段名被删除，注入的敏感值全部替换；
4. body：对象、数组、标量、空 body、schema 失败 body、无效 JSON 原始文本；
5. 双重上限：独立 `1 MiB` raw capture 安全预算；最终日志 body 的 8192 字节边界、8193 字节、多字节字符、脱敏后再计数/截断、`truncated/originalByteLength`；
6. 脱敏：错误 message/stack、URL query、body 键和值、重复和重叠敏感值；
7. 禁止内容：所有 headers、响应 body、任意 error 属性、cause、原始交易所载荷均不出现；
8. 已知 400/403/业务 404/422/500 和框架/其他失败兜底；
9. 无效 JSON 捕获不改变既有 `400` 响应，成功解析不改变 schema 行为；parsed body 可用后原始字节立即释放；
10. 并发请求快照不串线；
11. `secretProvider`、捕获、序列化和 logger 故障安全降级；
12. 失败预检后仓库无新增记录，成功路径持久化和后台事件保持原行为；
13. `500` 不再产生 `unhandled_http_request_failure`，无其他新 HTTP 失败事件；
14. Host/Origin 非法且 payload 为无效/超大内容时仍在 body 观察/parser 前早拒绝为 `403`，body 为 `null` 且攻击 payload 未被读取或缓存；
15. 测试 route-level `bodyLimit: 2 MiB`：约 `1.1 MiB` 的有效 JSON 可由 parsed body 路径记录，约 `1.1 MiB` 的 malformed JSON 因超过 raw capture 预算而以 `[Unavailable]` 降级，不输出原始前缀。

所有测试使用 real Pino capture、fake gateway、注入的临时敏感值和 `:memory:`/临时 SQLite；不得读取 `.env` 或访问交易所。

## 13. 运维文档一致性

实现完成后 README 和 operator guide 必须一致说明：

- 唯一完成日志及 info/warn/error 分级；
- 失败日志包含 `httpError` 和 `httpRequest(method/url/body/truncated/originalByteLength)`；
- URL 含 query；Host/Origin 在 body 读取前早拒绝且 `403` body 为 `null`；
- `1 MiB` raw capture 安全预算与 `8192` 字节最终日志上限职责不同，route-level 更大解析上限不扩大 capture 预算，超预算且无 parsed body 时使用 `[Unavailable]`；
- headers 与响应 body 永不记录；
- 成功日志不增加快照；
- `unhandled_http_request_failure` 不再作为旁路事件，后台异步事件仍独立存在。

## 14. 完成标准

- 每个已完成请求恰好一条 `request completed`；
- 成功/重定向为 `info` 且无失败快照，`4xx` 为 `warn`，`5xx` 为 `error`；
- 每个最终 `4xx/5xx` 都有 `httpError` 和尽量完整的 `httpRequest`；
- method、含 query 的完整原始 URL、有效结构化 body 或捕获预算内的无效 JSON 原始文本被正确记录；
- Host/Origin 在任何 body 观察/parser 前拒绝，早拒绝 `403` 的 body 为 `null` 且攻击 payload 不被读取或缓存；
- 全局 Fastify `bodyLimit` 显式为 `1 MiB`；独立 raw capture 预算固定为 `1 MiB`，route-level 更大上限不扩大该预算，超预算且无 parsed body 时安全降级为 `[Unavailable]`；
- parsed body 可用后立即释放 raw；仅配置敏感值被精确替换，最终 body 日志表示按脱敏后 UTF-8 8192 字节安全截断；
- `truncated` 与 `originalByteLength` 语义和边界测试通过；
- headers、响应 body、未白名单错误数据和原始交易所载荷不进入日志；
- 失败预检不落库；日志失败不改变 HTTP、持久化或交易行为；
- 无新增依赖、无新增旁路 HTTP 失败事件，spec、plan、代码、测试和运维文档一致。
