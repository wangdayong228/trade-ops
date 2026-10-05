# Fail-fast 错误证据修订设计与检查记录

日期：2026-10-05

状态：已批准（用户于 2026-10-05 确认“按照推荐方案继续”）。实施与验证进度见同日 implementation plan；下文第 2、3 节是修改前的调查证据。

## 1. 需求与现行设计的关系

用户要求检查整个项目并完善不符合 `fail-fast-with-evidence` 的地方。验收标准是：失败输出指出本次失败的检查、实际情况与要求；包装保留可见的原始消息、堆栈和错误链；互斥失败可以区分；前置检查失败立即停止；秘密不进入输出。

基线提交为 `805f6cf`。本次调查开始时工作区干净。

现行设计中存在需要明确替代的规则：

- [2026-10-02 已批准设计第 6 节](2026-10-02-ordered-preflight-confirmation-and-precise-errors-design.md#6-操作员可见的精确错误) 禁止第三方消息、cause、stack 进入 SQLite、HTTP、交易事件和界面；对应 plan 的 Task 1 要求未知异常只按类别转换。当前 `object-failure` 行为及相关测试遵循这一旧要求，却不满足本次错误证据要求。
- [2026-09-06 资金费率设计第 8.2 节及第 10 节](2026-09-06-funding-rate-history-sync-design.md) 要求固定的重试耗尽错误及受限错误日志。需要保留类型化控制流，同时修订丢弃原因和截断证据的部分。
- 2026-08-09 设计覆盖执行/恢复错误的目标，但 2026-10-02 设计明确只抽取部分范围；不能直接将未实施的旧整套执行设计当成本次 implementation plan。

本文仅替代与错误证据丢失有关的旧规则，不改变交易状态、提交确定性、对账写入权、恢复拓扑、权限检查、数量算法、数据库事务及网络重试资格。

## 2. 检查发现

路径及行号对应上述基线。静态发现说明可见的证据缺口，不等于已经证明交易结果错误。

| 编号 | 路径、符号 | 已确认的问题 | 技能条款 |
| --- | --- | --- | --- |
| F1 | `src/errors/trade-ops-error.ts:862` `safeFailureCategory`；`src/config/environment-loader.ts:38` `environmentLoadFailure`；`src/main.ts:209` `startupFailure`；`src/http/server.ts:232` `operationFailure` | 不同原生异常统一成为 `object-failure`。包装没有保留 cause，文件权限、磁盘故障或第三方返回的具体原因在此不可恢复。 | 2、4 |
| F2 | `src/logging/logger.ts:238` `safeError` | 只提取最外层 type/message/code/stack，丢失 cause；最外层堆栈不能代替内层消息及堆栈。 | 2、4 |
| F3 | `src/funding-rates/funding-rate-events.ts:239` `boundedErrorField`、`allowlistedError` | 每个错误字段按 512 UTF-8 字节截断；位于末尾的状态、响应内容或调用栈被无条件舍弃。 | 2、4、6 |
| F4 | `public/app.js:1526` `requestJson`、`:1549` `operatorFailureMessage` | fetch 的具体异常被替换为“网络请求失败”；响应验证的具体异常被替换为“响应结构无效”。 | 1、2、4 |
| F5 | `public/app.js:1442` `boundedOperatorLine` | 每行最多显示 256 字符，结构化错误的实际值和要求即使已经到达浏览器也可能不可见。 | 2、6 |
| F6 | `src/domain/quantity-normalizer.ts` `normalizeCommonBaseQuantity`；`src/strategy/preflight-service.ts:555` `effectiveQuantity` | 归一数量为零、低于现货最小量、低于合约最小量共用一句错误；预检再固定归因于现货，并把原请求量当作实际量。计算精度超限也会被误报为数量范围失败。 | 1、2、3、4 |
| F7 | `src/storage/sqlite-funding-rate-repository.ts:136` `schemaError`；`prepareFundingSchema`、`assertTableContract`、`createBitgetScanTable` | 已有事务、列合同不匹配、外键问题、初始化执行失败等共用 `SQLite funding rate schema initialization failed`，且 catch 再次丢弃原因。 | 2、3、4 |
| F8 | `src/storage/sqlite-funding-rate-repository.ts:302` `corruptHistory` 及基础字段校验；`src/storage/sqlite-strategy-repository.ts` `invalid`、schema 校验 | 多处只有字段名或“unsupported value”，缺实际值和具体要求；外层校验包装进一步丢弃内层检查。策略 schema 的多个失败也共用 `schema-shape-invalid`。 | 2、3、4 |
| F9 | `src/storage/sqlite-strategy-repository.ts:2624` `runConfirmationOperation` | 事务失败只保存失败类别；回滚回读失败时最初的事务异常也消失。需要同时报告原操作失败和回滚验证结果，保留现有仓储失效保护。 | 2、4 |
| F10 | `src/strategy/hedge-reconciliation-evidence.ts:172` `invalidTopology`、`inspectLocalTopology` | 角色集合非法、WAITING_HEDGE 缺 GTC、市价腿数量不一致、GTC 顺序非法都只有 `INVALID_LOCAL_TOPOLOGY`，不能判断实际触发的检查。 | 2、3 |
| F11 | `src/strategy/hedge-reconciliation-evidence.ts` 订单查询 catch；`src/exchanges/ccxt-exchange-gateway.ts` `normalizeOrder` | 查询异常折叠为 `ORDER_LOOKUP_FAILED`；订单 symbol、ID、方向、数量等不匹配消息缺 expected/actual，具体错误还会被外层覆盖。 | 2、3、4 |
| F12 | `src/strategy/hedge-coordinator.ts` GTC 最终量价检查与账户读取失败路径 | 量化调用异常和非正量化结果共用 `PRICE_QUANTIZATION_FAILED`，缺当前原因/值；账户读取失败缺原异常证据。 | 2、3、4 |
| F13 | `src/funding-rates/funding-rate-exchange-worker.ts:93` 请求重试耗尽分支 | 最后一次 NetworkError 被无 cause 的 `FundingRequestRetryExhaustedError` 替代。前面重试事件不能代替最后一次失败的证据。 | 2、4 |
| F14 | `src/funding-rates/funding-rate-record.ts:33` `invalid`；`src/funding-rates/funding-rate-market-sync.ts:469` 页校验及两交易所游标校验 | 记录校验只有字段与要求；页内 identity、timestamp、raw JSON/hash，以及请求/响应游标不一致缺少实际观测值，部分互斥条件合并。资金费率现行设计第 10 节已经要求这些 expected/actual。 | 2、3、4 |
| F15 | `src/strategy/hedge-reconciliation.ts:465` `parsedMarketRules`、`:985` `authorizeGtc` | 规则解析把多个字段错误都变成 null；随后加载失败、身份错误、规则错误共用 `MARKET_RULES_UNAVAILABLE`。量化调用失败、非正数和不对齐共用 `PRICE_QUANTIZATION_FAILED`。 | 2、3、4 |
| F16 | `src/strategy/hedge-reconciliation-evidence.ts:239` `remoteEvidenceMismatch`、`:378` 快照验证 catch；`src/strategy/hedge-coordinator.ts:440` `warnRejectedSubmissions` | 远端不一致只有两个未标注字段名的值，不能确定比较哪一项；快照验证与并发提交 rejection 的具体原因被丢弃。 | 2、3、4 |

已经包含定位对象和 expected/actual 的错误保留原样，不为形式统一而重写。

F1/F2/F3/F13 中部分行为被旧设计或测试显式要求；它们是与本次技能的差异，不能一概说成违反当时已批准设计。F6、F10、F11、F14、F15、F16 的检查字段/实际值不足则已有当前领域设计和 `code-rules.md` 支持。只读调查覆盖了应用源目录及浏览器错误边界；这份清单没有宣称穷尽所有可能运行时抛出值，也没有证明所有失败路径均已通过动态测试。

## 3. 已执行的安全复现

环境：TypeScript 构建成功；本机默认 Node 为 v26.0.0，已安装的 better-sqlite3 使用 Node ABI 115，因此 SQLite 探针改用已有的 `/usr/local/bin/node` v20.11.1。没有安装或重建依赖。

| 命令/探针 | exit status | 关键结果 |
| --- | --- | --- |
| `npm run build` | 0 | `tsc -p tsconfig.json` 成功 |
| 默认 Node 26 执行包含内存 SQLite 的调查探针 | 1 | `ERR_DLOPEN_FAILED`：原生模块 ABI 115 与运行时 ABI 147 不匹配；不是业务测试结果 |
| `/usr/local/bin/node --input-type=module` 执行以下探针集合 | 0 | 8 项证据丢失断言成立；这是复现既有缺陷，不是修复后测试通过 |

探针只使用合成错误、注入 loader、`:memory:` SQLite，以及 VM 中提取的纯浏览器错误处理函数，未启动服务、未读取真实 `.env`、未访问交易所。

以下命令用于基线提交 `805f6cf` 的仓库根目录，记录修改前的证据丢失；修复后以实施计划中的回归测试验收，不再期望这些旧缺陷断言成立：

```sh
npm run build
/usr/local/bin/node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { safeFailureCategory } from './dist/src/errors/trade-ops-error.js';
import { safeError } from './dist/src/logging/logger.js';
import { loadEnvironmentFile } from './dist/src/config/environment-loader.js';
import { normalizeCommonBaseQuantity } from './dist/src/domain/quantity-normalizer.js';
import { SqliteFundingRateRepository } from './dist/src/storage/sqlite-funding-rate-repository.js';

const permission = Object.assign(new Error('EACCES: open /synthetic/config'), { code: 'EACCES' });
const disk = Object.assign(new Error('ENOSPC: open /synthetic/config'), { code: 'ENOSPC' });
assert.equal(safeFailureCategory(permission), safeFailureCategory(disk));
assert.throws(() => loadEnvironmentFile({ processEnv: {}, load: () => ({ error: permission }) }),
  error => error.detail.actual === 'object-failure' && error.cause === undefined);
assert.equal(JSON.stringify(safeError(new Error('operation failed', { cause: permission }))).includes('EACCES'), false);

const rules = { amountStep: '1', contractSize: '1', minBaseAmount: '0' };
const quantityErrors = [];
for (const minimum of ['0', '1.5']) {
  try {
    normalizeCommonBaseQuantity({ requestedBaseQuantity: minimum === '0' ? '0.5' : '1.5',
      spot: rules, swap: { ...rules, minBaseAmount: minimum } });
  } catch (error) { quantityErrors.push(error.message); }
}
assert.equal(quantityErrors.length, 2);
assert.equal(quantityErrors[0], quantityErrors[1]);

const schemaErrors = [];
for (const prepare of [db => db.exec('BEGIN'), db => db.exec('CREATE TABLE funding_rate_history (wrong TEXT)')]) {
  const db = new Database(':memory:');
  try { prepare(db); new SqliteFundingRateRepository(db); }
  catch (error) { schemaErrors.push(error.message); }
  finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }
}
assert.equal(schemaErrors.length, 2);
assert.equal(schemaErrors[0], schemaErrors[1]);

const app = readFileSync('public/app.js', 'utf8');
const browser = vm.createContext({ fetch: async () => { throw new Error('synthetic connection reset'); } });
vm.runInContext(app.slice(app.indexOf('const operatorErrorLineLimit'), app.indexOf('async function refreshStatus')), browser);
const network = await vm.runInContext("requestJson('预检', '/synthetic', {}, 201).catch(e => e.message)", browser);
assert.equal(network.includes('connection reset'), false);
assert.equal(vm.runInContext("operatorFailureMessage('预检', new Error('snapshot symbol mismatch'))", browser).includes('symbol'), false);
assert.equal(vm.runInContext("boundedOperatorLine('实际', 'x'.repeat(300) + 'terminal-evidence')", browser).includes('terminal-evidence'), false);
console.log('8 existing evidence-loss checks reproduced');
JS
```

## 4. 建议采用的修订方案

### 4.1 方案比较

| 方案 | 完整性 | 业务复杂度 | 实现复杂度 |
| --- | --- | --- | --- |
| 只补文案和安全类别 | 不足：原始错误链和外部失败正文仍丢失 | 不增加 | 低，但不满足本次需求 |
| 在现有错误边界增加安全证据投影，并逐项补齐失败检查（推荐） | 覆盖实际值、原因链、外部响应与展示 | 保留现有状态和控制流 | 扩展现有错误/日志能力，无新依赖或服务 |
| 每个 catch 各自拼接原始异常及脱敏 | 可以完整，但容易产生遗漏与安全差异 | 保留现有状态 | 各模块重复处理 cause、循环、凭证和输出规则 |

推荐第二项。复用既有错误工厂和日志入口，不引入通用工作流框架；不需要新的第三方库。

### 4.2 失败对象与原因链

- 保留现有业务错误码、phase、subject、expected、actual 及名义错误类型。每个失败检查提供实际观测值与要求，不把操作名作为原因。
- 原生异常在内存包装时保留 cause。嵌套原因和聚合异常逐项保留；遇到循环用明确循环引用标记结束，不能静默丢弃分支。
- 输出边界对诊断字段进行白名单投影和脱敏。只访问允许的数据属性，不执行未知 getter、Proxy trap 或 `toJSON`，不 spread 任意错误对象。
- 允许输出经过脱敏的具体消息、错误码和外部失败状态/错误正文；不输出请求鉴权头、完整请求对象、完整环境、私钥、种子和完整源码正文。正文中的敏感键及已配置凭证必须脱敏。
- 对不可安全读取的字段指出实际状态，如访问器不可读或 Proxy 对象；不能因为安全投影失败就把原来的失败说成成功。
- 完整堆栈与原因链在同一次失败的操作者输出中保留。堆栈可只出现在该失败的结构化日志中；HTTP/界面必须至少保留具体失败及安全原因证据，不能要求用户去寻找另一条不相关日志。
- 持久化前只能写入完成脱敏的诊断数据。实现计划必须覆盖 `preflightFailure` 的写入/读取和 HTTP/UI 验证一致性；旧无新增诊断字段的合法记录仍然可读，不做破坏性 schema 重置。

### 4.3 各边界的补齐

- 启动、环境文件、HTTP、预检和确认：最初失败的检查与原始原因在包装后仍可见。事务与回滚验证都失败时逐项保留，不用回读错误覆盖事务错误，也不声称状态未变。
- 数量归一：分别指出归一后为零、现货 minimum、合约 minimum 及计算资源边界；actual 使用对应阶段的真实数量/精度，对象使用实际失败市场。数量计算公式和舍入行为保持。
- SQLite：schema 错误给出表/列/索引/外键或事务条件、expected 和 actual；行校验给出市场/记录定位和字段证据。无需回显完整 SQL 正文或原始行。
- 对账/执行：现有 reason 可以继续承担控制流职责，但诊断中要有本次具体检查、订单角色/标识和 expected/actual；查询 fallback 两次失败时保留两次失败及顺序，不改变提交或恢复决策。
- 资金费率：请求耗尽保留最后一次错误及已有重试上下文；页解析和持久化失败不能仅剩通用 summary。补充证据可位于同次 `funding_task_incomplete` 输出，不将稳定 failure code 当成完整诊断。
- 浏览器：网络、JSON 解析和结构校验保留具体原因、HTTP 状态和失败字段；首行突出失败点。保留 `textContent` 渲染及失败后清除可操作策略状态的行为。
- 删除仅为简洁设置的错误证据截断。输入合同的长度校验仍可作为前置条件，但必须指出实际长度和限制；不能先丢弃已取得的错误证据再声称输出完整。

### 4.4 Fail-fast 与既有恢复策略

- 每个必要前置条件失败后不进入本次操作的后续检查或副作用，不添加重试掩盖坏输入、错误账户设置、schema 或完整性错误。
- 资金费率已批准的 `NetworkError` 重试是外部暂时故障策略，不是前置条件检查重试；次数、间隔和错误类型识别保持。
- 已批准的按 client order ID 查询、提交不确定恢复、stale generation 丢弃和关闭资源清理保持原有语义。错误报告本身不得触发重复下单、重新认领或数据库写入。
- 执行前账户设置 drift 的终态策略在不同历史文档中存在差异。本次只补其诊断，不以“改善错误”名义选择另一种状态转换；若要改变该行为须单独裁决。

## 5. 实施验收与风险矩阵

实施依据为同日独立 implementation plan，按以下交付单元执行 TDD；每项先看到预期失败，再修改实现。

| 交付单元 | 必须验证的行为 | 相关测试 |
| --- | --- | --- |
| 错误投影/日志 | 两种原始错误可区分；cause 与聚合错误可见；长消息末尾仍在；秘密全部排除；恶意 getter/Proxy 不执行；循环有标记 | `tests/errors/trade-ops-error.test.ts`、`tests/logging/logger.test.ts`、`tests/http/public-error.test.ts` |
| 启动/HTTP/确认 | EACCES/ENOSPC、第三方响应状态/正文能够定位；包装及阶段转换不丢证据；HTTP、完成日志、持久化失败一致；原错误不能被清理异常覆盖 | `tests/config/environment-loader.test.ts`、`tests/main.test.ts`、`tests/http/server.test.ts`、`tests/strategy/confirmation-service.test.ts` |
| 数量/网关/对账 | 归一到零和两腿 minimum 可区分；正确 actual 与市场；快照每项 invariant 含两值；查询 fallback 原因链完整；零额外下单/后续读取 | `tests/domain/quantity-normalizer.test.ts`、`tests/exchanges/ccxt-gateway.test.ts`、`tests/strategy/preflight-service.test.ts`、`tests/strategy/hedge-reconciliation.test.ts`、`tests/strategy/hedge-coordinator.test.ts` |
| SQLite/资金费率 | schema 互斥失败可区分；记录缺字段/非法值不合并；事务失败与回读失败同时保留；重试耗尽保留最后一次错误；停止/恢复语义不变 | `tests/storage/sqlite-repository.test.ts`、`tests/storage/sqlite-funding-rate-repository.test.ts`、`tests/funding-rates/funding-rate-events.test.ts`、`tests/funding-rates/funding-rate-sync-service.test.ts`、`tests/funding-rates/funding-rate-market-sync.test.ts` |
| 浏览器 | 网络、解析、字段校验及 HTTP 错误可区分；256 字符后仍可读取证据；恶意 HTML 只作文本；失败清理预览和确认状态 | `tests/http/server.test.ts` 中既有 VM 浏览器测试 |

所有执行与验证继续使用 fake gateway、内存/临时 SQLite 和临时环境；禁止真实交易所 API、真实凭证、真实 `.env` 及业务数据库。一次仅一个 agent 写 source/tests。

最终验证使用与原生依赖 ABI 115 匹配且支持 CCXT CommonJS 测试依赖的 Node 20.20.2：`npm exec --yes --package=node@20.20.2 -- npm test`，以及 `git diff --check`；针对受影响资金/权限路径做只读 defect-first review。第 3 节调查结果不能代替实施后的完整回归。
