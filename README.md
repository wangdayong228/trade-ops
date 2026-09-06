# trade-ops

trade-ops 是一个只在本机回环地址提供 HTTP 操作界面的跨交易所对冲开仓服务。本期只支持 Bitget 与 OKX，在一个 Node.js 进程、一个 SQLite 数据库、一个协调器和一个监控器中完成“开空合约，同时买现货”。平空并卖出现货尚未实现。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [操作员使用说明](docs/usage/operator-guide.md) | 本机界面逐步操作、执行模式、状态与恢复、错误诊断 |
| [功能清单](docs/manual/feature_list.md) | 非规范愿望清单（含未实现项） |
| `docs/superpowers/` | 历史设计与实现计划，不是当前操作契约 |

## 运行要求

- Node.js 20 或更高版本。
- Bitget 和 OKX 账户均已配置 USDT 现货与 USDT 线性永续合约。
- 合约账户必须已经处于双向持仓（hedged/long-short）模式；单向持仓模式会在预检阶段被拒绝，服务不会自动切换账户设置。
- 预检确认的合约保证金模式、双向持仓模式和杠杆是不可变的执行约束。执行或恢复入口会先对账已有订单；只有当本轮对账授权一笔新订单时，服务才会在提交前重新读取合约账户设置。设置未知、发生漂移或无法确认时不会继续创建新订单，但不会阻断已有订单的查回和终态化；服务始终不会自动修改这些设置。
- OKX 空仓账户即使处于双向持仓模式，也无法唯一证明当前保证金模式和空头杠杆；这种情况下服务按 `unknown` 处理并拒绝预检/执行，不会擅自默认 `cross` 或 `isolated`。需要账户中存在合约数量为正、且可无歧义读取设置的空头仓位；零合约占位行仍视为空仓。
- 每个 API key 必须具有读取和交易权限，必须关闭提现权限。
- 服务只能以单进程运行。不得让两个进程、两个容器或两台机器同时打开同一个数据库并执行对冲任务；本期没有跨进程协调能力。

安装、检查和启动：

```bash
npm install
cp .env.example .env
npm test
npm run build
npm start
```

`npm start` 运行已经构建的 `dist/src/main.js`，因此修改源码后应先执行 `npm run build`。默认界面地址是 `http://127.0.0.1:3000/`。界面操作见 [操作员使用说明](docs/usage/operator-guide.md)。

## 环境变量

以下六个凭证变量都是必填项：

| 变量 | 含义 |
| --- | --- |
| `TRADING_BITGET_API_KEY` | Bitget API key |
| `TRADING_BITGET_SECRET` | Bitget API secret |
| `TRADING_BITGET_PASSWORD` | Bitget API passphrase/password |
| `TRADING_OKX_API_KEY` | OKX API key |
| `TRADING_OKX_SECRET` | OKX API secret |
| `TRADING_OKX_PASSWORD` | OKX API passphrase/password |

其他配置：

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| `TRADING_EXCHANGES` | 无 | 必填；本期集合必须恰好是 `bitget,okx`。逗号两侧空白会被去除；空项、重复项、未知交易所或只配置一家都会拒绝启动。 |
| `FUNDING_RATE_SYNC_INTERVAL_MS` | `3600000` | 资金费率市场发现、增量和失败重试的调度周期，单位为毫秒。只接受规范十进制整数 `60000` 到 `86400000`；不接受空白、符号、前导零、小数或指数。 |
| `TRADING_DATABASE_PATH` | `./data/trade-ops.sqlite` | 本地 SQLite 文件路径。拒绝 `:memory:` 和 `file:` URI；相对路径以启动进程的当前工作目录为基准，父目录会自动创建。 |
| `HOST` | `127.0.0.1` | 只接受数字形式 `127.0.0.1` 或 `::1`。不接受 `localhost`、主机名、空白、`0.0.0.0`、`::` 或任何外部地址。 |
| `PORT` | `3000` | 只接受规范十进制整数 `1` 到 `65535`；不接受空白、前导零、小数、指数或符号。 |

本地启动时，先复制示例并只在本机填写真实值：

```bash
cp .env.example .env
npm run build
npm start
```

默认入口会从启动进程的当前工作目录自动加载可选的 `.env`。已经存在的系统环境变量优先，`.env` 不会覆盖它们；如果所有配置都由进程管理器或 shell 注入，`.env` 不存在也允许继续启动。显式调用 `composeService({ env })` 的测试或嵌入场景不会读取 `.env`。不要把包含真实凭证的 `.env` 提交到版本库。

生产环境应使用专用系统用户和进程管理器注入凭证，不要把凭证写进仓库、SQLite 或普通日志。建议数据库使用绝对路径，例如 `/var/lib/trade-ops/trade-ops.sqlite`；目录仅允许服务用户访问（建议 `0700`），数据库及备份仅允许服务用户读写（建议 `0600`）。备份前停止服务并等待正常关闭，随后把主 SQLite 文件作为一个一致的离线文件备份；不要在仍有 `-wal`/`-shm` 活动写入时只复制主文件。恢复备份前先保留当前数据库的只读副本。

数据库必须位于正确支持 SQLite/VFS 文件锁的本地文件系统，不支持 NFS、SMB 或其他网络挂载。同一个数据库文件同一时刻只能由一个 trade-ops 进程持有；服务运行时，其他 SQLite 工具也不能并行读取。检查、迁移和备份前必须先停止服务并等待数据库关闭。进程崩溃后，新实例通过 SQLite 原生锁接管并执行恢复；应用不创建或清理 PID 文件或独立 lock 文件。

## 资金费率历史同步

服务在 HTTP 监听成功后启动一条只读、与订单执行隔离的资金费率链路。交易所固定为 Bitget 和 OKX；新市场只有同时满足 `active=true`、`swap=true`、`future=false`、`contract=true`、`linear=true`、`inverse=false`、`quote=USDT`、`settle=USDT` 才进入同步。Bitget 还要求 raw 产品为 `symbolType=perpetual` 且 `symbolStatus=normal`；OKX 要求 `instType=SWAP`、`ctType=linear`、`state=live`，且 quote 与 settle 的 raw 币种一致。状态缺失、未知或身份冲突时，本轮发现按不完整处理：不新增或停用市场，不猜测为 active，并保留已知市场供后续安全重试。

系统只保存公共历史接口返回的已结算费率：Bitget 读取 raw `fundingRate`，OKX 只读取 raw `realizedRate`。当前预计费率、下一期预测费率和实时未结算快照均不保存；OKX 同一响应中的预测 `fundingRate` 也不会写库。费率以严格验证后的原始十进制字符串保存，不经过 JavaScript `number`。

每个新发现的目标 market 独立回填接口当前可见历史，完成后立即执行增量，不等待其他 market；后续按 `FUNDING_RATE_SYNC_INTERVAL_MS` 调度，默认每小时一次。active market 每 24 小时从头执行一次全可见范围复核，以发现迟到记录和修订。market 明确变为 inactive 后停止普通增量，但必须先完成最后一次全范围复核；以后再次明确 active 时，必须先成功完成专用 reactivation 全范围任务，才能恢复普通增量。

这里的“完整”只表示已经按该交易所的终止规则遍历本次接口可见范围，并且只验证到持久化的 `last_caught_up_cutoff_ms`。OKX 必须继续翻页直到成功取得显式空页；Bitget 必须在固定 cutoff 下取得连续两轮完整扫描集合一致和相同空终点。Bitget 没有公布历史保留期；OKX 公开说明最多约三个月，但没有给出可据此推导精确起点的日历边界。服务不宣称覆盖合约上市以来、cutoff 之后或交易所未返回的记录。

资金费率使用独立、无 API key、secret 或 password 的 CCXT 公共客户端；它不会获得交易 gateway、账户设置、持仓或订单能力。远端请求失败只更新资金费率同步状态，不推进或重试订单，也不改变对冲状态。临时网络类失败最多额外重试三次，间隔为 1、2、4 秒；响应结构、身份、分页或数据完整性错误不会用盲目立即重试掩盖。

数据与现有业务表共用 `TRADING_DATABASE_PATH` 指向的 SQLite 文件，但只写入三张独立持久表：`funding_rate_history` 保存当前版本，`funding_rate_revisions` 永久保存应用观察到的旧版本，`funding_rate_sync_state` 分别保存全范围 `coverage` 与增量 `incremental` 状态。首期不自动删除这些记录，也不提供页面、HTTP 查询或导出入口，因此数据库文件会持续增长，备份和容量规划必须包含这些表。

诊断时应分别查看 `coverage_status` 的 `PENDING`/`BACKFILLING`/`CAUGHT_UP`/`INCOMPLETE` 与 `incremental_status` 的 `IDLE`/`RUNNING`/`INCOMPLETE`，不能用增量成功覆盖一次全范围失败。关键 stdout 结构化事件包括 `funding_market_discovery_completed`/`funding_market_discovery_incomplete`、`funding_coverage_started`/`funding_coverage_completed`、`funding_page_committed`、`funding_incremental_completed`/`funding_incremental_blocked`、`funding_request_retry`、`funding_task_incomplete`、`funding_rate_revised` 和 `funding_sync_fatal`。事件只记录 allowlist 内的 exchange、market、generation、cutoff、游标、计数和脱敏错误上下文，不记录凭证、headers 或完整原始错误对象。

## stdout JSON 日志

服务把启动、HTTP、后台恢复和逐笔订单生命周期记录为一行一条的 Pino JSON，并统一写到 stdout。启动时会记录 `.env` 是否加载、服务开始监听或失败的具体安全原因；正常关闭会记录完整的停止生命周期。

每个新订单及其后续有效状态变化使用以下事件名：

- `order_planned`
- `order_submit_started`
- `order_submit_succeeded`
- `order_submit_uncertain`
- `order_rejected_before_submit`
- `order_status_changed`
- `order_terminal`

交易事件只允许输出对冲任务/订单关联 ID、执行模式与状态、交易所、symbol、订单角色/类型/方向、委托量/成交量/剩余量、限价/成交均价、GTC、仓位方向、保证金模式、订单状态，以及有限的失败码和错误类型/错误码。相同的轮询快照不会重复记录；`closed`、`canceled`、`rejected` 等可靠终态会额外记录 `order_terminal`。

每个完成的 HTTP 请求只记录一条 `request completed`：状态码低于 `400` 时为 `info`，且不带失败请求快照；`4xx` 为 `warn`，`5xx` 为 `error`。失败日志带 `httpError`，以及 `httpRequest` 快照（`method`、包含 query 的 `url`、`body`、`truncated`、`originalByteLength`）。Host/Origin 会在任何 body 观察或 parser 运行前检查；该边界早拒绝的 `403` 不读取或缓存攻击 payload，日志 body 为 `null`。

全局 Fastify body 解析上限显式为 `1 MiB`，原始 body 观察另有固定 `1 MiB` 安全预算；两者职责不同，路由显式配置更大的解析上限也不会扩大观察预算。若无效 body 超过观察预算且没有可用的 parsed body，日志 body 降级为 `[Unavailable]`，不会记录前缀。最终可记录的完整 body 会先替换当前已配置的敏感值，再按 UTF-8 最多 `8192` 字节截断；`1 MiB` 是原始观察安全预算，`8192` 是最终日志输出上限。任何请求 headers（包括 Authorization/Cookie）和响应 body 都不记录，也不记录原始 CCXT 请求/响应、完整环境变量、任意错误属性或 cause 链；`httpError.error` 只允许经过配置敏感值替换的类型、消息、字符串错误码和 stack。

失败的预检请求不会向 SQLite 写入对冲任务。同步请求失败不会再额外记录 `unhandled_http_request_failure`；确认接口返回 `202` 后的后台执行不属于该 HTTP 完成日志，异步失败仍单独记录 `background_confirmation_failed`。日志是旁路行为：stdout 写入失败不会改变 SQLite 状态、触发重试或重复下单。

应用本身不创建日志文件，也不负责保留或轮转。需要持久化时，由 systemd、Docker 或其他进程管理器采集 stdout，并在外部配置访问权限、保留期和轮转策略；不要把日志文件放入仓库。

如何对照界面错误与日志做诊断，见 [操作员使用说明 · 界面错误与日志](docs/usage/operator-guide.md#界面错误与日志)。

## 执行模式与操作恢复（摘要）

界面提供三种模式：`CONTRACT_FIRST`、`SPOT_FIRST`、`CONCURRENT`。模式语义、GTC 等待、对冲状态机、重启后用对冲任务 ID 加载，以及 `HEDGE_INCOMPLETE` 人工处理步骤，见 [操作员使用说明](docs/usage/operator-guide.md)。

## 本地 HTTP 安全边界

服务只提供明文 HTTP，并且只绑定 `127.0.0.1` 或 `::1`。请求还会校验原始 `Host`；所有 `POST` 请求都必须提供同源的回环 `Origin`，并与原始 `Host` 的主机及端口精确匹配。服务不信任 `Forwarded` 或 `X-Forwarded-*`，以降低 DNS rebinding 和代理头欺骗风险。不要用反向代理把它暴露到局域网或公网。

界面上的风险勾选只是一次本地显式确认门槛，不是身份认证、用户鉴权，也不能证明操作确实由某个人完成。任何能在本机进程权限和回环网络边界内发请求的程序，都可能调用本地 API；应同时使用操作系统账户、文件权限和本机访问控制保护服务。

## 测试边界

自动化测试使用 fake 交易所网关和临时或内存 SQLite，不读取真实凭证、不访问真实交易所、不提交真实订单，也不使用真实资金。当前验证没有声称运行过交易所 sandbox；接入真实账户前必须由操作员独立核对账户模式、权限、市场规则和风险。
