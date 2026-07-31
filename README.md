# trade-ops

trade-ops 是一个只在本机回环地址提供 HTTP 操作界面的跨交易所对冲开仓服务。本期只支持 Bitget 与 OKX，在一个 Node.js 进程、一个 SQLite 数据库、一个协调器和一个监控器中完成“开空合约，同时买现货”。平空并卖出现货尚未实现。

## 运行要求

- Node.js 24 或更高版本。
- Bitget 和 OKX 账户均已配置 USDT 现货与 USDT 线性永续合约。
- 每个 API key 必须具有读取和交易权限，必须关闭提现权限。
- 服务只能以单进程运行。不得让两个进程、两个容器或两台机器同时打开同一个数据库并执行策略；本期没有跨进程协调能力。

安装、检查和启动：

```bash
npm install
npm test
npm run build
npm start
```

`npm start` 运行已经构建的 `dist/src/main.js`，因此修改源码后应先执行 `npm run build`。默认界面地址是 `http://127.0.0.1:3000/`。

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
| `TRADING_DATABASE_PATH` | `./data/trade-ops.sqlite` | SQLite 文件路径。相对路径以启动进程的当前工作目录为基准；父目录会自动创建。 |
| `HOST` | `127.0.0.1` | 只接受数字形式 `127.0.0.1` 或 `::1`。不接受 `localhost`、主机名、空白、`0.0.0.0`、`::` 或任何外部地址。 |
| `PORT` | `3000` | 只接受规范十进制整数 `1` 到 `65535`；不接受空白、前导零、小数、指数或符号。 |

示例（不要把真实值提交到版本库）：

```bash
export TRADING_EXCHANGES=bitget,okx
export TRADING_BITGET_API_KEY=...
export TRADING_BITGET_SECRET=...
export TRADING_BITGET_PASSWORD=...
export TRADING_OKX_API_KEY=...
export TRADING_OKX_SECRET=...
export TRADING_OKX_PASSWORD=...
export TRADING_DATABASE_PATH=/var/lib/trade-ops/trade-ops.sqlite
export HOST=127.0.0.1
export PORT=3000
npm start
```

生产环境应使用专用系统用户和进程管理器注入凭证，不要把凭证写进仓库、SQLite 或普通日志。建议数据库使用绝对路径，例如 `/var/lib/trade-ops/trade-ops.sqlite`；目录仅允许服务用户访问（建议 `0700`），数据库及备份仅允许服务用户读写（建议 `0600`）。备份前停止服务并等待正常关闭，随后把主 SQLite 文件作为一个一致的离线文件备份；不要在仍有 `-wal`/`-shm` 活动写入时只复制主文件。恢复备份前先保留当前数据库的只读副本。

## 三种执行模式

三种模式都以预检得到的共同可交易基础币数量为目标，忽略交易手续费：

- `CONTRACT_FIRST`（合约优先）：先提交合约市价开空单。只有取得该订单的实际正成交量和实际平均成交价后，才按这个实际成交量在现货交易所挂买入 GTC 限价单；第二腿价格取第一腿实际平均成交价，并按第二个交易所规则量化。
- `SPOT_FIRST`（现货优先）：先提交现货市价买单。只有取得该订单的实际正成交量和实际平均成交价后，才按这个实际成交量在合约交易所挂开空 GTC 限价单；第二腿价格取第一腿实际平均成交价，并按第二个交易所规则量化。
- `CONCURRENT`（并发）：同时提交现货市价买单和合约市价开空单。若两边实际正成交量相等，策略完成；若不相等，在成交量较小的一侧挂一张 GTC 限价单，数量严格等于两边实际成交量之差，价格取成交量较大一侧的实际平均成交价，并按较小一侧交易所规则量化。

这里的“同时”是同一进程中的并发请求，不是交易所原子成交。策略只使用本策略订单的实际成交量，不用委托量代替成交量。

## GTC、状态与人工处理

GTC 对冲单可能无限期保持未成交或部分成交。本期不会自动撤单、改价、重新提交、回滚、平仓或追单，也不会因为等待时间过长而改变订单。操作员必须在两个交易所持续关注真实订单和仓位；交易所侧的撤单或拒单会使策略进入 `HEDGE_INCOMPLETE`。

遇到 `HEDGE_INCOMPLETE` 时：

1. 在界面记录本策略展示的两家交易所、所有 client order ID 和 exchange order ID。
2. 分别登录 Bitget 与 OKX，核对这些订单的状态、实际成交量、方向，以及现货余额和合约空头仓位。
3. 对照界面的实际现货买入量、实际合约开空量和未匹配数量。
4. 在本服务之外人工决定补单、撤单或调整仓位。本期不提供自动修复、自动回滚或自动平仓。

每次预检成功后，先记录界面“执行状态”中的策略 ID。服务重启后，监控器会立即读取同一个 SQLite 数据库：

1. 重新打开本地界面，在“加载已有策略”中输入原策略 ID 并点击“加载策略”。
2. 如果状态是 `EXECUTING` 或 `PENDING_CONFIRMATION`，重新核对加载出的完整预检快照和订单 ID，重新勾选风险确认，再点击“确认开仓”。协调器会按已持久化的 client order ID 恢复已有意图，不会有意创建第二个同角色订单。
3. 如果状态是 `WAITING_HEDGE`，确认按钮会保持禁用；监控器会自动继续观察 GTC，操作员只需在界面刷新状态。成交后可推进到 `HEDGED`。
4. `HEDGED`、`HEDGE_INCOMPLETE` 和 `FAILED` 只能加载查看，不能再次确认。

本地 API `GET /api/hedges/:id` 可作为界面不可用时的诊断备选；`POST /api/hedges/:id/confirm` 仍要求精确 JSON `{ "riskAcknowledged": true }`，并且必须携带与原始回环 `Host` 完整匹配的 HTTP `Origin`（包括端口），它不是绕过风险确认的后门。优先使用界面完成恢复和确认。

## 本地 HTTP 安全边界

服务只提供明文 HTTP，并且只绑定 `127.0.0.1` 或 `::1`。请求还会校验原始 `Host`；所有 `POST` 请求都必须提供同源的回环 `Origin`，并与原始 `Host` 的主机及端口精确匹配。服务不信任 `Forwarded` 或 `X-Forwarded-*`，以降低 DNS rebinding 和代理头欺骗风险。不要用反向代理把它暴露到局域网或公网。

界面上的风险勾选只是一次本地显式确认门槛，不是身份认证、用户鉴权，也不能证明操作确实由某个人完成。任何能在本机进程权限和回环网络边界内发请求的程序，都可能调用本地 API；应同时使用操作系统账户、文件权限和本机访问控制保护服务。

## 测试边界

自动化测试使用 fake 交易所网关和临时或内存 SQLite，不读取真实凭证、不访问真实交易所、不提交真实订单，也不使用真实资金。当前验证没有声称运行过交易所 sandbox；接入真实账户前必须由操作员独立核对账户模式、权限、市场规则和风险。
