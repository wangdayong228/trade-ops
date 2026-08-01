# Dotenv 与结构化交易日志设计

## 1. 背景与根因

当前 `npm start` 直接执行 `node dist/src/main.js`。Node.js 不会自动读取项目根目录的 `.env`，因此即使文件包含全部交易配置，`process.env` 中仍可能没有任何 `TRADING_*` 变量。现有入口捕获启动异常后又丢弃原始错误，只输出固定的 `trade-ops service startup failed`，操作员无法区分配置、数据库、监听或其他启动故障。

HTTP 层已经通过 Fastify 使用 Pino，并配置了部分请求字段脱敏，但启动阶段没有同一套 logger；后台交易失败和未处理 HTTP 错误也只记录固定文案。订单的提交与状态变化没有形成可关联的结构化审计事件。

项目最初把 Node.js 24 LTS 选作运行时基线，但当前代码没有使用 Node 24 独占能力。当前直接依赖支持 Node 20，现有安全加固设计也要求在 Node 20 与 Node 24 上验证测试发现行为。因此本次把声明的最低版本调整为 Node.js 20，而不是增加一个没有实际技术依据的 Node 24 启动拦截。

## 2. 目标

- 应用启动时主动、静默地读取项目根目录 `.env`。
- 保持由 shell、容器或进程管理器注入环境变量的部署方式，并让这些变量优先于 `.env`。
- 启动、HTTP、后台任务和交易事件统一输出一行一条的 Pino JSON 到 stdout。
- 为每张订单记录可关联的完整生命周期与必要交易字段。
- 记录可诊断的失败原因，同时保证凭证、认证材料和原始交易所载荷不会进入日志。
- 日志故障不得改变交易执行、恢复或幂等语义；SQLite 继续作为权威状态源。

## 3. 非目标

- 不由应用写日志文件、轮转、压缩或上传日志；这些职责交给进程管理器或部署平台。
- 不把日志作为订单恢复、仓位计算或业务判断的数据源。
- 不记录完整 CCXT 请求、响应、HTTP body、请求头或 `process.env`。
- 不在本次引入远程日志服务、指标系统、追踪系统或日志查询界面。
- 不为日志目的修改下单、对冲、状态机或恢复业务规则。

## 4. 技术选择

### 4.1 环境变量

使用 `dotenv`，而不是 Node.js 20 中仍处于实验阶段的 `process.loadEnvFile()`。`dotenv` 作为应用直接依赖，在当前 Node 20 运行时上提供成熟、明确的加载行为。

环境加载器调用 `dotenv.config({ quiet: true })`，避免 dotenv 自身向 stdout 写入非 JSON 提示。默认路径固定为启动进程当前工作目录下的 `.env`，与现有相对数据库路径和 README 启动方式保持一致。

加载规则：

1. `.env` 中的值不得覆盖已经存在于 `process.env` 的值。
2. `.env` 不存在时继续启动，随后由现有配置校验判断系统环境变量是否完整。
3. `.env` 存在但无法读取时，保留原始错误作为启动失败原因。
4. 环境加载日志只记录是否找到并加载文件，不记录变量名称、数量或值。
5. 测试或嵌入式调用显式传入 `options.env` 时，不读取 `.env`，保持依赖注入和测试隔离。

### 4.2 日志

使用 Pino 作为统一 logger，并把 Pino 声明为应用的直接依赖。应用创建一个根 logger；Fastify 使用该 logger 的子 logger，交易事件记录器也从根 logger 创建带固定组件字段的子 logger。

日志固定写到 stdout，默认级别为 `info`。本次不增加可配置日志级别，避免引入尚未确认的环境变量和运维分支。错误事件使用 `error`，启动无法继续使用 `fatal`，正常生命周期与交易事件使用 `info`。

## 5. 组件与职责

### 5.1 Environment Loader

环境加载器是独立、可测试的启动组件。它只负责调用 dotenv 并把结果归类为 `loaded` 或 `missing`；它不理解交易所变量，也不执行运行时配置校验。非“文件不存在”的读取错误直接抛出。

默认入口在组合服务前调用加载器。`composeService({ env })`、`loadRuntimeConfig(env)` 和网关测试继续使用显式环境对象，不产生文件系统依赖。

### 5.2 Root Logger

根 logger 负责：

- Pino JSON stdout 输出；
- 固定服务名与版本字段；
- Fastify 请求敏感路径脱敏；
- 安全错误序列化；
- 创建 `bootstrap`、`http` 和 `trade` 子 logger。

安全错误序列化只保留错误类型、错误码、经凭证值替换后的消息和调用栈。它不会序列化任意可枚举属性、请求配置、响应对象或嵌套 `cause`。已加载的 API key、secret 和 password 会作为仅存在于内存中的替换集合，用固定的 `[Redacted]` 替换错误消息与调用栈中的精确匹配值。

### 5.3 Trade Event Logger

领域层只依赖一个窄接口，不直接依赖 Pino：

```ts
interface TradeEventSink {
  record(event: TradeEvent): void;
}
```

`TradeEvent` 是判别联合，只允许各事件需要的白名单字段。Pino 适配器负责加入时间、服务与组件字段。测试可注入内存 sink，不需要解析控制台输出。

日志是旁路行为。`record` 不向协调器或监控器传播输出异常；logger 输出故障不能中止交易、改变 SQLite 状态或触发重试。日志不可用时也绝不能据此重复提交订单。

### 5.4 交易事件生产者

`HedgeCoordinator` 在订单意图持久化、调用交易所和保存返回快照的确定边界发送事件。`OrderMonitor` 在恢复查询得到有意义的新快照并持久化后发送状态事件。交易所网关不直接记录原始请求或响应。

相同订单的重复轮询只有在状态、成交量、剩余量、成交均价或 exchange order ID 至少一项发生变化时才记录 `order_status_changed`。可靠终态额外记录一次 `order_terminal`。现有确定性 client order ID 和策略 ID 用于跨事件关联。

## 6. 启动数据流

默认入口按以下顺序执行：

1. 创建 bootstrap logger。
2. 尝试加载 `.env`，记录 `environment_loaded` 或 `environment_file_missing`。
3. 从最终的 `process.env` 加载并校验运行时配置。
4. 从已校验凭证构造仅供错误文本替换使用的敏感值集合。
5. 组合数据库、交易所网关、仓储、协调器、监控器和 Fastify。
6. 记录 `service_starting`，启动监控器并监听回环地址。
7. 成功监听后记录 `service_started`，包含 host、port、数据库路径和交易所 ID，但不包含凭证。
8. 收到信号时记录 `service_stopping`；所有资源关闭后记录 `service_stopped`。
9. 任一步失败时记录 `service_startup_failed`，包含安全错误字段并设置非零退出码。

显式传入 `RunOptions.env` 的程序化调用跳过第 2 步，直接使用调用方环境对象。

## 7. 订单事件与字段

每张订单可能产生以下事件：

- `order_planned`：确定性订单意图已经成功写入 SQLite，尚未调用交易所。
- `order_submit_started`：本地校验通过，即将调用交易所创建订单。
- `order_submit_succeeded`：交易所返回的规范化订单快照已经成功保存。
- `order_submit_uncertain`：调用可能已经产生外部副作用，但结果无法确认；恢复只查询相同 client order ID。
- `order_rejected_before_submit`：网关证明错误发生在实际创建调用之前。
- `order_status_changed`：已持久化快照出现有意义变化。
- `order_terminal`：订单进入可靠终态；已有成交即使订单取消也按真实成交记录。

事件按适用情况只允许以下业务字段：

- `strategyId`、`mode`、`strategyState`、`failureCode`；
- `role`、`exchangeId`、`symbol`、`kind`、`type`、`side`、`positionSide`、`marginMode`、`timeInForce`；
- `clientOrderId`、`exchangeOrderId`；
- `requestedBaseQuantity`、`filledBaseQuantity`、`remainingBaseQuantity`；
- `price`、`averagePrice`、`status`；
- 事件时间和规范化错误摘要。

禁止将下列数据传给事件 sink：API key、secret、password、签名、authorization/cookie header、完整请求 body、完整 CCXT 请求或响应、完整环境对象、SQLite 行对象。

## 8. HTTP 与后台错误

Fastify 复用根 logger，并保留请求头与常见嵌套凭证路径的 Pino redaction。默认请求日志可以记录 method、URL、状态码、响应时间和 request ID，但不记录请求 body。

后台确认任务失败时记录安全错误摘要和 `strategyId`。未处理 HTTP 异常记录安全错误摘要、request ID、method 和 URL；返回客户端的响应继续使用固定、安全的错误消息。预检拒绝等预期业务结果不按系统错误记录，避免用正常拒绝淹没错误日志。

## 9. 错误处理与交易安全

- 环境或配置失败发生在网关、数据库、监控器和 HTTP 监听创建之前。
- 日志字段组装不得调用交易所或读取额外业务状态。
- `order_submit_started` 只在本地校验完成后、真正外部调用前记录；它不代表交易所已经接单。
- `order_submit_succeeded` 只在规范化快照持久化后记录。
- 不确定提交必须记录为 `order_submit_uncertain`，不得被误记为成功或本地拒绝。
- 日志输出失败不改变现有确定性订单意图、恢复拓扑或角色唯一约束。
- 关闭日志不得延迟或取代监控器、Fastify 和 SQLite 的正常关闭顺序。

## 10. 测试策略

所有行为变更按测试驱动方式实现。

环境加载测试覆盖：

- `.env` 值进入目标环境；
- 已存在的系统变量优先；
- `.env` 不存在时继续；
- 非文件不存在错误被传播；
- 显式传入 `env` 时不读取文件；
- dotenv 不向 stdout 产生非 JSON 输出。

日志测试覆盖：

- 启动配置失败保留具体错误原因和非零退出状态；
- 日志为逐行可解析 JSON；
- 启动成功与关闭事件包含必要非敏感配置；
- API key、secret、password、签名和认证头不会出现在任何捕获输出；
- 错误消息或调用栈意外包含已知凭证值时会被替换；
- HTTP 与后台任务错误包含关联 ID 和安全错误摘要。

交易事件测试覆盖：

- 各执行模式中的每张订单具有 planned、submit 和结果事件；
- 不确定提交、本地预提交拒绝、恢复查询和可靠终态使用正确事件；
- 数量、价格、状态与订单 ID 来自已经规范化并持久化的数据；
- 相同轮询快照不重复记录，成交或状态变化会记录；
- 事件 sink 抛错不改变订单提交次数、策略状态或恢复行为；
- 原始 CCXT 对象和非白名单字段无法进入类型化事件。

完成聚焦测试后，在当前 Node 20 运行时执行完整 `npm test`，并执行构建、启动失败路径及 `.env` 加载的进程级验证。验证命令不得启动可能恢复真实订单的生产配置；进程级验证必须使用临时 `.env`、临时 SQLite 和不会触达真实交易所的失败前置条件。

## 11. 文档与依赖变更

- `package.json` 的 Node 要求改为 `>=20`。
- `dotenv` 和 `pino` 成为直接运行时依赖，并更新 lockfile。
- `.env.example` 保留全部支持变量与安全占位值。
- README 改为先复制 `.env.example` 到 `.env`，说明 `npm start` 会主动加载文件、系统环境变量优先，以及 `.env` 可缺省。
- README 增加 JSON stdout 日志说明、交易字段范围、敏感数据禁记规则，以及由进程管理器负责持久化和轮转的要求。

## 12. 完成标准

- 使用当前 Node 20 运行时，`.env` 中的完整有效配置能被默认入口读取。
- 缺少或无效配置时，stdout 至少包含一个不泄密的 `service_startup_failed` JSON 事件和具体错误原因。
- 正常启动、监听、停止以及每张订单的关键生命周期都有可关联 JSON 事件。
- 日志捕获测试证明凭证和禁止字段不出现在输出中。
- 日志故障测试证明订单幂等、SQLite 状态与恢复规则不受影响。
- 完整构建与测试通过，README、`.env.example`、代码和依赖声明一致。
