# 对冲完全对账模块实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 强制每个生产 SQLite 文件由单个服务进程独占，并新增唯一的 `HedgeReconciliation.run(strategyId)` 对账关卡，让所有终态、`WAITING_HEDGE` 和差额 GTC 授权都由完整、精确、可恢复且幂等的订单证据推导。

**Architecture:** 服务先用仓储所使用的同一个 SQLite 连接取得进程级原生独占锁，成功后才初始化 WAL/schema、构造 gateway 和启动恢复；连接关闭即释放所有权，不引入锁文件、租约或新依赖。随后升级 SQLite 仓储，使每张订单都有持久化提交结论，并让快照附加具备语义幂等和 CAS 结果；独立证据收集器与 `HedgeReconciliation` 再完成查所、精确残差、互斥决策和状态 CAS。协调器只消费同一次持锁调用返回的提交授权，监控器只把可恢复任务交给协调器。

**Tech Stack:** TypeScript 7、Node.js 20.11.1、`decimal.js` 10、`better-sqlite3` 12、Node.js `node:test`、现有 `ExchangeGateway` fake 与内存 SQLite。

## Global Constraints

- 设计来源固定为 `docs/superpowers/specs/2026-09-05-hedge-reconciliation-module-design.md`，状态为“已批准”；决策来源固定为同目录的 `2026-09-05-hedge-reconciliation-module-design-decision-trace.md`。
- 所有设计、实现和审查必须遵守 `docs/standards/code-rules.md`，尤其是“先检查，再执行”“错误必须精确”“对冲必须完全对账”。
- 这是直接资金风险改动：订单提交、重复提交防护、策略状态、数量与价格精度、SQLite 事务顺序和恢复行为都必须先红后绿。
- 不读取或打印真实凭证，不读取仓库真实 `.env`，不调用任何真实交易所 API，包括公开行情接口，不打开真实业务 SQLite。
- 所有测试只使用 fake gateway、临时或内存 SQLite、临时环境值，以及发生在交易所访问之前的失败条件。
- 每个生产 SQLite 文件只允许一个服务进程；必须在首次 WAL/schema 访问和 gateway 构造前完成 `locking_mode=EXCLUSIVE` 与 `BEGIN EXCLUSIVE; COMMIT`，失败即关闭连接并终止启动。
- 生产 `TRADING_DATABASE_PATH` 拒绝 `:memory:` 和 `file:` URI，且必须位于支持 SQLite/VFS 文件锁的本地文件系统；网络文件系统不受支持，也不增加不可靠的路径猜测。
- SQLite 独占锁不替代进程内 strategy operation lock 或仓储状态 CAS；三层约束分别防止跨进程、同进程和状态竞争。
- 不新增策略状态或订单角色；对账模块不得调用 `createOrder`、撤单、改价、账户设置修改或余额/持仓查询。
- `run` 不获取进程锁；调用方必须持有 `tryAcquireStrategyOperation` 对应的锁。数据库状态写仍使用仓储 CAS。
- 数量、价格、名义金额和残差不得使用 JavaScript `number` 运算，不得通过舍入残差取得可交易数量。
- 只允许 `src/strategy/hedge-reconciliation.ts` 写 `HEDGED`、`FAILED`、`HEDGE_INCOMPLETE`、`WAITING_HEDGE`。
- 当前工作区的 `better-sqlite3` 按 Node 20 ABI 构建；所有计划内命令使用 `PATH=/usr/local/bin:$PATH`，该路径当前为 Node `v20.11.1`。
- 每个任务只暂存该任务列出的文件，不提交或改写用户已有的 `AGENTS.md`、`docs/standards/` 和其他未跟踪 superpowers 文档。

---

## 文件结构与职责

| 文件 | 责任 | 变更方式 |
| --- | --- | --- |
| `src/storage/sqlite-process-owner.ts` | SQLite 原生独占所有权、固定错误分类和安全消息 | 新建 |
| `src/storage/strategy-repository.ts` | 提交结论、快照附加结果、类型化仓储错误和 CAS 接口 | 修改 |
| `src/storage/schema.ts` | 新库 v2 schema、提交证据约束、迁移元数据和触发器 | 修改 |
| `src/storage/sqlite-strategy-repository.ts` | v1 到 v2 原子迁移、旧数据回填、提交证据 CAS、语义快照 CAS | 修改 |
| `src/logging/logger.ts` | 对账 warning 及脱敏结构化字段白名单 | 修改 |
| `src/exchanges/exchange-gateway.ts` | `NoOrderSubmittedError` 的安全、闭集失败原因 | 修改 |
| `src/exchanges/ccxt-exchange-gateway.ts` | 在底层 create 前区分明确不可交易请求与未分类失败 | 修改 |
| `src/strategy/hedge-reconciliation-evidence.ts` | 本地拓扑预检、交易所查回、快照附加、订单生命周期事件 | 新建 |
| `src/strategy/hedge-reconciliation.ts` | 公共结果联合、精确残差、可交易性、互斥决策、状态 CAS 和结论日志 | 新建 |
| `src/strategy/hedge-coordinator.ts` | 持锁调用 `run`，只按当次结果规划和提交新订单，持久化确定未提交事实 | 修改 |
| `src/strategy/order-monitor.ts` | 恢复调度、同策略调用去重、错误隔离，仅调用 `confirmAndExecute` | 修改 |
| `src/main.ts` | 配置校验后先取得 SQLite 所有权，再初始化仓储、gateway、reconciliation、协调器和监控器 | 修改 |
| `README.md` | 一库单进程、本地文件系统和离线检查/备份约束 | 修改 |
| `tests/storage/sqlite-process-owner.test.ts` | 独占模式、真实子进程竞争、正常释放和崩溃接管 | 新建 |
| `tests/support/sqlite-owner-child.ts` | 不被测试 glob 直接执行的 SQLite owner/contender 子进程 fixture | 新建 |
| `tests/support/sqlite-service-contender-child.ts` | 使用临时配置与 fake gateway 验证竞争服务在组件构造前失败 | 新建 |
| `tests/storage/sqlite-repository.test.ts` | v1 迁移、证据 CAS、快照幂等、约束与回滚测试 | 修改 |
| `tests/logging/logger.test.ts` | warning、字段白名单、脱敏和非抛错测试 | 修改 |
| `tests/exchanges/exchange-gateway.test.ts` | 确定未提交原因载体测试 | 修改 |
| `tests/exchanges/ccxt-gateway.test.ts` | 底层 create 前不可交易分类及零外部提交测试 | 修改 |
| `tests/strategy/hedge-reconciliation.test.ts` | 新模块全部证据和互斥决策矩阵 | 新建 |
| `tests/strategy/hedge-coordinator.test.ts` | 当次授权、账户守卫、确定/不确定提交和禁止直接终态测试 | 修改 |
| `tests/strategy/order-monitor.test.ts` | 仅转发、恢复、去重、计时器和错误隔离测试 | 修改并删除旧分类测试 |
| `tests/main.test.ts` | 所有权启动顺序、失败释放、依赖装配与同一事件 sink 所有权测试 | 修改 |
| `tests/http/server.test.ts` | 构造器与 `OperationalLog` 测试替身的机械适配；HTTP 响应不暴露提交证据 | 修改 |
| `tests/logging/trade-events.test.ts` | `StrategyOrderRecord` 新必填字段的机械适配 | 修改 |
| `tests/acceptance/hedge-opening.test.ts` | 新 repository 与 monitor 重启恢复验收 | 修改 |

不新增通用 decimal 工具。精确上下文只留在 `hedge-reconciliation.ts`，避免其他模块误用共享 `Decimal` 配置。`hedge-reconciliation-evidence.ts` 是新模块的 I/O 子组件，不从 `main.ts` 或协调器直接调用。

## 接口锁定

任务 1 产出的 SQLite 进程所有权合同是生产组合入口的唯一可用接口：

```ts
import type Database from 'better-sqlite3';

export type SqliteOwnershipFailureCode =
  | 'DATABASE_OWNERSHIP_BUSY'
  | 'DATABASE_OWNERSHIP_UNAVAILABLE';

export class SqliteOwnershipError extends Error {
  readonly name = 'SqliteOwnershipError';

  constructor(
    readonly code: SqliteOwnershipFailureCode,
    readonly databasePath: string
  ) {
    super(code === 'DATABASE_OWNERSHIP_BUSY'
      ? `SQLite database ownership is busy: ${databasePath}`
      : [
          'SQLite database exclusive ownership is unavailable:',
          databasePath
        ].join(' '));
  }
}

export function claimSqliteProcessOwnership(
  database: Database.Database,
  databasePath: string
): void;
```

任务 2 产出的仓储接口是后续任务唯一可用的持久化合同：

```ts
export type OrderSubmissionDisposition =
  | 'SUBMISSION_UNCERTAIN'
  | 'DEFINITELY_NOT_SUBMITTED'
  | 'REMOTE_OBSERVED';

export type OrderSubmissionFailureCode =
  | 'ORDER_SUBMISSION_FAILED'
  | 'HEDGE_RESIDUAL_NOT_TRADABLE';

export type SnapshotAttachmentResult = 'attached' | 'unchanged';

export interface StrategyOrderRecord {
  readonly id: string;
  readonly strategyId: string;
  readonly role: OrderRole;
  readonly exchangeId: string;
  readonly clientOrderId: string;
  readonly exchangeOrderId: string | null;
  readonly request: OrderRequest;
  readonly snapshot: OrderSnapshot | null;
  readonly status: StrategyOrderStatus;
  readonly submissionDisposition: OrderSubmissionDisposition;
  readonly submissionFailureCode: OrderSubmissionFailureCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StrategyRepository {
  attachOrderSnapshot(
    strategyOrderId: string,
    snapshot: OrderSnapshot
  ): SnapshotAttachmentResult;
  markDefinitelyNotSubmitted(
    strategyOrderId: string,
    failureCode: OrderSubmissionFailureCode
  ): boolean;
}
```

任务 5 产出的公共对账合同是协调器唯一可消费的判别联合：

```ts
export type ReconciliationPendingReason =
  | 'INVALID_LOCAL_TOPOLOGY'
  | 'ORDER_LOOKUP_FAILED'
  | 'ORDER_NOT_FOUND'
  | 'SUBMISSION_UNCERTAIN'
  | 'ORDER_SNAPSHOT_INVALID'
  | 'ORDER_EVIDENCE_MISMATCH'
  | 'SNAPSHOT_WRITE_CONFLICT'
  | 'MARKET_ORDER_ACTIVE'
  | 'GTC_STATUS_UNKNOWN'
  | 'MARKET_RULES_UNAVAILABLE'
  | 'PRICE_QUANTIZATION_FAILED'
  | 'EXACT_ARITHMETIC_UNAVAILABLE'
  | 'STATE_WRITE_CONFLICT';

export type ReconciliationResult =
  | {
      readonly kind: 'written';
      readonly state: 'HEDGED' | 'WAITING_HEDGE';
    }
  | {
      readonly kind: 'written';
      readonly state: 'FAILED' | 'HEDGE_INCOMPLETE';
      readonly failureCode: StrategyFailureCode;
    }
  | {
      readonly kind: 'observed_state';
      readonly state: StrategyState;
    }
  | ({
      readonly kind: 'pending';
      readonly reason: ReconciliationPendingReason;
    } & ReconciliationDiagnostic)
  | { readonly kind: 'waiting_gtc' }
  | { readonly kind: 'awaiting_market_submission' }
  | {
      readonly kind: 'need_gtc';
      readonly role: 'SPOT_HEDGE_GTC' | 'CONTRACT_HEDGE_GTC';
      readonly baseQuantity: string;
      readonly referencePrice: string;
    };

export interface ReconciliationRunner {
  run(strategyId: string): Promise<ReconciliationResult>;
}
```

## 直接资金风险矩阵

| 风险 | 阻断性测试 | 独立交叉信号 |
| --- | --- | --- |
| 两个服务进程基于不同订单证据终态化或补 GTC | 真实子进程同时抢同一临时 SQLite，恰好一个取得所有权；竞争者在 gateway、恢复和监听前得到 `DATABASE_OWNERSHIP_BUSY` | SQLite 官方 `locking_mode`/WAL 语义；本地 Node 20 子进程探针验证 owner 持有时 `SQLITE_BUSY`、关闭后接管成功 |
| 旧库不接受新失败码或迁移破坏外键 | 从 v1 schema 构造内存库，迁移后写 `HEDGE_RESIDUAL_NOT_TRADABLE`，再跑 `foreign_key_check` | `/usr/bin/sqlite3` 内存探针已验证“关闭外键、事务重建父表、改名、恢复外键”后子表仍引用 `strategies` |
| schema 事务内切 WAL 失败，或旧程序污染未知版本库 | 临时文件新库验证事务前进入 `wal`；版本 99 临时库拒绝后 fingerprint 与原 `delete` journal mode 都不变 | `better-sqlite3` 临时文件探针验证 `BEGIN` 内切 WAL 会报错，而 WAL 模式会跨关闭持久化 |
| 已有意图被当成确定未提交而重复下单 | 旧 `planned` 行回填为 `SUBMISSION_UNCERTAIN`；lookup `null` 仍 pending；create 计数保持 0 | 重启后新 repository 实例读取同一临时库，结论不依赖进程内存 |
| 一条腿已成交时错误终态或错误补单 | 查所部分失败、active/unknown、单边 rejected 分别阻断状态写和 GTC | 手算 `1 - 0.6 = 0.4`，并断言唯一授权角色为 `CONTRACT_HEDGE_GTC` |
| 部分成交 GTC 使用了错误残差 | 请求 `0.4`、成交 `0.1`、剩余 `0.3` 的 open/closed/canceled 矩阵 | 分别手算补单前残差 `0.4` 和当前残差 `0.3`，两项断言不能互换 |
| 小数精度丢失导致误报 HEDGED | 超过 40 位有效数字、极端指数、共享 `Decimal.set` 污染测试 | 同一字符串使用 `BigInt` 缩放手算差值，与模块结果交叉比较 |
| 残差舍入造成不足或过度对冲 | `amountStep * contractSize = 0.003`、残差 `0.002`，以及 min/max/notional 边界三点测试 | 对比现有 `ExchangeGateway` 的整合约与精度保护；fake `createOrder` 调用数必须为 0 |
| 状态 CAS 未命中却返回 written | transition `false`、throw、竞争者写目标/其他状态四种测试 | 重读持久化策略状态，不接受内存中的目标状态作为成功证据 |
| 重复轮询制造重复审计 | 同语义、仅 `updatedAt` 不同的快照重复 run，DB 事件和 trade event 计数不增长 | 直接读取 `order_events` 数量并与捕获的 `TradeEventSink` 数量比较 |
| 账户漂移阻断已有订单恢复 | `WAITING_HEDGE` 下账户查询失败，仍查回 closed GTC 并 HEDGED | fake 账户查询调用数应为 0，fake create 调用数也为 0 |
| 旧授权跨轮次重复使用 | 首轮 `need_gtc` 后守卫失败，下一轮返回 pending，不创建订单 | 每轮 scripted runner 调用序列与 `createdRequests` 精确计数 |

---

### Task 1: 在任何恢复或交易组件之前独占生产 SQLite

**Files:**
- Create: `src/storage/sqlite-process-owner.ts`
- Modify: `src/main.ts:1-330`
- Create: `tests/storage/sqlite-process-owner.test.ts`
- Create: `tests/support/sqlite-owner-child.ts`
- Create: `tests/support/sqlite-service-contender-child.ts`
- Modify: `tests/main.test.ts:1-370`
- Modify: `README.md:47-70`

**Interfaces:**
- Consumes: `better-sqlite3` 的连接级 `pragma/exec/close`，现有 `ComposeServiceOptions.databaseFactory` 与启动失败关闭路径。
- Produces: `SqliteOwnershipFailureCode`、`SqliteOwnershipError`、`claimSqliteProcessOwnership(database, databasePath): void`；Task 7 的最终 `main.ts` 装配必须保留该调用顺序。

权威语义固定取自 [SQLite `locking_mode`](https://www.sqlite.org/pragma.html#pragma_locking_mode) 与 [WAL exclusive mode](https://www.sqlite.org/wal.html#use_of_wal_without_shared_memory)：设置模式本身不等于持锁，第一次写才取得并保留排他锁，连接关闭释放；因此禁止删掉显式空写事务或把 claim 移到 `journal_mode=WAL` 之后。

- [x] **Step 1: 写所有权错误、调用顺序和真实子进程竞争的红测试**

创建 `tests/support/sqlite-owner-child.ts`。该文件不是 `*.test.ts`，只由父测试 fork；它不得导入 `main.ts`、加载 `.env` 或构造 gateway：

```ts
/// <reference types="node" />

import Database from 'better-sqlite3';
import {
  claimSqliteProcessOwnership,
  SqliteOwnershipError
} from '../../src/storage/sqlite-process-owner.js';

type ChildAction = 'claim' | 'hold' | 'read';

interface ChildResult {
  readonly kind: 'owned' | 'read' | 'rejected';
  readonly code?: string;
}

function send(result: ChildResult): void {
  if (process.send === undefined) {
    throw new Error('sqlite owner child requires an IPC channel');
  }
  process.send(result);
}

const [databasePath, action] = process.argv.slice(2) as [
  string | undefined,
  ChildAction | undefined
];
if (databasePath === undefined || action === undefined) {
  throw new Error('sqlite owner child requires path and action');
}

const database = new Database(databasePath, { timeout: 0 });
try {
  if (action === 'read') {
    database.prepare('SELECT count(*) FROM sqlite_schema').get();
    send({ kind: 'read' });
    database.close();
    process.disconnect?.();
  } else {
    claimSqliteProcessOwnership(database, databasePath);
    database.pragma('journal_mode = WAL');
    send({ kind: 'owned' });
    if (action === 'claim') {
      database.close();
      process.disconnect?.();
    } else {
      process.once('message', (message: unknown) => {
        if (message !== 'release') {
          process.exitCode = 1;
        }
        database.close();
        process.disconnect?.();
      });
    }
  }
} catch (error) {
  send({
    kind: 'rejected',
    code: error instanceof SqliteOwnershipError
      ? error.code
      : 'UNEXPECTED_SAFE_TEST_FAILURE'
  });
  database.close();
  process.disconnect?.();
}
```

创建 `tests/storage/sqlite-process-owner.test.ts`，使用 `mkdtemp`、`fork`、IPC 消息和 `close` 事件，不用固定 sleep。父测试辅助函数固定为：

```ts
/// <reference types="node" />

import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import {
  claimSqliteProcessOwnership,
  SqliteOwnershipError
} from '../../src/storage/sqlite-process-owner.js';

interface ChildResult {
  readonly kind: 'owned' | 'read' | 'rejected';
  readonly code?: string;
}

function startChild(
  databasePath: string,
  action: 'claim' | 'hold' | 'read'
): ChildProcess {
  return fork(
    resolve('dist/tests/support/sqlite-owner-child.js'),
    [databasePath, action],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
}

function nextIpcResult<T>(child: ChildProcess): Promise<T> {
  return new Promise<T>((resolveResult, rejectResult) => {
    const cleanup = (): void => {
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
    };
    const onMessage = (message: unknown): void => {
      cleanup();
      resolveResult(message as T);
    };
    const onError = (): void => {
      cleanup();
      rejectResult(new Error('SQLite test child failed before IPC result'));
    };
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      cleanup();
      rejectResult(new Error(
        `SQLite test child closed before IPC result: ${code}/${signal}`
      ));
    };
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function nextResult(child: ChildProcess): Promise<ChildResult> {
  return nextIpcResult<ChildResult>(child);
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'close');
}

async function temporaryDatabase(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-owner-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'trade-ops.sqlite');
  const seed = new Database(databasePath, { timeout: 0 });
  seed.exec('CREATE TABLE ownership_probe (id INTEGER PRIMARY KEY)');
  seed.close();
  return databasePath;
}
```

加入以下完整高风险测试；每个已启动 child 都在 `t.after` 中检查并终止，避免失败断言留下持锁进程：

```ts
test('does not treat the exclusive pragma as acquired ownership', {
  timeout: 10_000
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const owner = new Database(databasePath, { timeout: 0 });
  t.after(() => {
    if (owner.open) owner.close();
  });

  assert.equal(
    owner.pragma('main.locking_mode = EXCLUSIVE', { simple: true }),
    'exclusive'
  );
  const reader = startChild(databasePath, 'read');
  t.after(() => {
    if (reader.exitCode === null && reader.signalCode === null) reader.kill();
  });

  assert.deepEqual(await nextResult(reader), { kind: 'read' });
  await waitForClose(reader);
});

test('allows exactly one process to own a SQLite file', {
  timeout: 10_000
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const owner = startChild(databasePath, 'hold');
  t.after(() => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
  });
  assert.deepEqual(await nextResult(owner), { kind: 'owned' });

  const contender = startChild(databasePath, 'claim');
  t.after(() => {
    if (contender.exitCode === null && contender.signalCode === null) {
      contender.kill();
    }
  });
  assert.deepEqual(await nextResult(contender), {
    kind: 'rejected',
    code: 'DATABASE_OWNERSHIP_BUSY'
  });
  await waitForClose(contender);

  owner.send('release');
  await waitForClose(owner);
  const successor = startChild(databasePath, 'claim');
  t.after(() => {
    if (successor.exitCode === null && successor.signalCode === null) {
      successor.kill();
    }
  });
  assert.deepEqual(await nextResult(successor), { kind: 'owned' });
  await waitForClose(successor);
});

test('releases SQLite ownership after an owner process is killed', {
  timeout: 10_000
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const owner = startChild(databasePath, 'hold');
  const ownerClosed = once(owner, 'close');
  t.after(() => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
  });
  assert.deepEqual(await nextResult(owner), { kind: 'owned' });
  assert.equal(owner.kill('SIGKILL'), true);
  await ownerClosed;

  const successor = startChild(databasePath, 'claim');
  t.after(() => {
    if (successor.exitCode === null && successor.signalCode === null) {
      successor.kill();
    }
  });
  assert.deepEqual(await nextResult(successor), { kind: 'owned' });
  await waitForClose(successor);
});

test('classifies ownership failures without retaining SQLite messages', () => {
  for (const sqliteCode of ['SQLITE_BUSY', 'SQLITE_LOCKED'] as const) {
    const lockedDatabase = {
      pragma: () => 'exclusive',
      exec: () => {
        throw Object.assign(new Error('secret sqlite detail'), {
          code: sqliteCode
        });
      }
    } as unknown as Database.Database;
    assert.throws(
      () => claimSqliteProcessOwnership(
        lockedDatabase,
        '/safe/service.sqlite'
      ),
      (error: unknown) => {
        assert.ok(error instanceof SqliteOwnershipError);
        assert.equal(error.code, 'DATABASE_OWNERSHIP_BUSY');
        assert.equal(error.databasePath, '/safe/service.sqlite');
        assert.doesNotMatch(error.message, /secret sqlite detail/);
        return true;
      }
    );
  }

  const unsupported = {
    pragma: () => 'normal',
    exec: () => { throw new Error('must not execute'); }
  } as unknown as Database.Database;
  assert.throws(
    () => claimSqliteProcessOwnership(unsupported, '/safe/service.sqlite'),
    (error: unknown) => error instanceof SqliteOwnershipError
      && error.code === 'DATABASE_OWNERSHIP_UNAVAILABLE'
  );

  const unavailable = {
    pragma: () => 'exclusive',
    exec: () => { throw new Error('private filesystem detail'); }
  } as unknown as Database.Database;
  assert.throws(
    () => claimSqliteProcessOwnership(
      unavailable,
      '/safe/service.sqlite'
    ),
    (error: unknown) => error instanceof SqliteOwnershipError
      && error.code === 'DATABASE_OWNERSHIP_UNAVAILABLE'
      && !error.message.includes('private filesystem detail')
  );
});
```

- [x] **Step 2: 运行所有权测试并确认模块缺失**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/storage/sqlite-process-owner.test.js
```

Expected: FAIL；TypeScript 报 `src/storage/sqlite-process-owner.js` 不存在。不能接受由 child 路径、IPC 或 fixture 清理错误造成的红灯。

- [x] **Step 3: 实现最小 SQLite 所有权模块**

创建 `src/storage/sqlite-process-owner.ts`，不保存原始 cause，不提供 release 方法：

```ts
import type Database from 'better-sqlite3';

export type SqliteOwnershipFailureCode =
  | 'DATABASE_OWNERSHIP_BUSY'
  | 'DATABASE_OWNERSHIP_UNAVAILABLE';

export class SqliteOwnershipError extends Error {
  readonly name = 'SqliteOwnershipError';

  constructor(
    readonly code: SqliteOwnershipFailureCode,
    readonly databasePath: string
  ) {
    super(code === 'DATABASE_OWNERSHIP_BUSY'
      ? `SQLite database ownership is busy: ${databasePath}`
      : [
          'SQLite database exclusive ownership is unavailable:',
          databasePath
        ].join(' '));
  }
}

function sqliteErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

function isSqliteContentionCode(code: string | undefined): boolean {
  return code === 'SQLITE_BUSY'
    || code?.startsWith('SQLITE_BUSY_') === true
    || code === 'SQLITE_LOCKED'
    || code?.startsWith('SQLITE_LOCKED_') === true;
}

export function claimSqliteProcessOwnership(
  database: Database.Database,
  databasePath: string
): void {
  try {
    const mode = database.pragma(
      'main.locking_mode = EXCLUSIVE',
      { simple: true }
    );
    if (mode !== 'exclusive') {
      throw new SqliteOwnershipError(
        'DATABASE_OWNERSHIP_UNAVAILABLE',
        databasePath
      );
    }
    database.exec('BEGIN EXCLUSIVE; COMMIT');
  } catch (error) {
    if (error instanceof SqliteOwnershipError) throw error;
    const code = sqliteErrorCode(error);
    throw new SqliteOwnershipError(
      isSqliteContentionCode(code)
        ? 'DATABASE_OWNERSHIP_BUSY'
        : 'DATABASE_OWNERSHIP_UNAVAILABLE',
      databasePath
    );
  }
}
```

- [x] **Step 4: 运行真实子进程所有权测试**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/storage/sqlite-process-owner.test.js
```

Expected: PASS；4 tests，0 failures；低层进程竞争得到 `DATABASE_OWNERSHIP_BUSY`，正常关闭和 `SIGKILL` 后均可接管。

- [x] **Step 5: 写配置、组合顺序和失败释放的红测试**

创建 `tests/support/sqlite-service-contender-child.ts`。它只使用显式临时环境和 `FakeExchangeGateway`，通过注入的监听函数运行完整 `run()`；不得读取 `.env` 或访问任何交易所：

```ts
/// <reference types="node" />

import { EventEmitter } from 'node:events';
import { run } from '../../src/main.js';
import {
  SqliteOwnershipError
} from '../../src/storage/sqlite-process-owner.js';
import { OrderMonitor } from '../../src/strategy/order-monitor.js';
import { FakeExchangeGateway } from './fake-exchange-gateway.js';

const [databasePath] = process.argv.slice(2);
if (databasePath === undefined || process.send === undefined) {
  throw new Error('sqlite contender child requires path and IPC');
}

interface ServiceContenderResult {
  readonly kind: 'startup_rejected' | 'unexpectedly_started';
  readonly code?: string;
  readonly gatewayConstructions: number;
  readonly recoveryStarts: number;
  readonly monitorStarts: number;
  readonly listenCalls: number;
}

class ChildSignalTarget extends EventEmitter {
  exitCode: number | undefined;
}

function send(result: ServiceContenderResult): void {
  if (process.send === undefined) {
    throw new Error('sqlite contender child lost its IPC channel');
  }
  process.send(result);
}

let gatewayConstructions = 0;
let recoveryStarts = 0;
let monitorStarts = 0;
let listenCalls = 0;
const originalStart = OrderMonitor.prototype.start;
const originalRecover = OrderMonitor.prototype.recover;
OrderMonitor.prototype.start = function (
  this: OrderMonitor,
  intervalMs: number
): () => void {
  monitorStarts += 1;
  return originalStart.call(this, intervalMs);
};
OrderMonitor.prototype.recover = async function (
  this: OrderMonitor
): Promise<void> {
  recoveryStarts += 1;
  await originalRecover.call(this);
};

try {
  const started = await run({
    env: {
      TRADING_EXCHANGES: 'bitget,okx',
      TRADING_BITGET_API_KEY: 'fixture-bitget-key',
      TRADING_BITGET_SECRET: 'fixture-bitget-secret',
      TRADING_BITGET_PASSWORD: 'fixture-bitget-password',
      TRADING_OKX_API_KEY: 'fixture-okx-key',
      TRADING_OKX_SECRET: 'fixture-okx-secret',
      TRADING_OKX_PASSWORD: 'fixture-okx-password',
      TRADING_DATABASE_PATH: databasePath
    },
    gatewayFactory: (exchangeId) => {
      gatewayConstructions += 1;
      return new FakeExchangeGateway(exchangeId);
    },
    signalTarget: new ChildSignalTarget(),
    listen: async () => {
      listenCalls += 1;
    },
    logger: false
  });
  await started.shutdown();
  send({
    kind: 'unexpectedly_started',
    gatewayConstructions,
    recoveryStarts,
    monitorStarts,
    listenCalls
  });
} catch (error) {
  send({
    kind: 'startup_rejected',
    code: error instanceof SqliteOwnershipError
      ? error.code
      : 'UNEXPECTED_SAFE_STARTUP_FAILURE',
    gatewayConstructions,
    recoveryStarts,
    monitorStarts,
    listenCalls
  });
} finally {
  OrderMonitor.prototype.start = originalStart;
  OrderMonitor.prototype.recover = originalRecover;
}
process.disconnect?.();
```

在 `tests/storage/sqlite-process-owner.test.ts` 增加专用结果类型、helper 和真实竞争服务测试；这些计数必须由 contender 进程返回，不得依赖父进程内存：

```ts
interface ServiceContenderResult {
  readonly kind: 'startup_rejected' | 'unexpectedly_started';
  readonly code?: string;
  readonly gatewayConstructions: number;
  readonly recoveryStarts: number;
  readonly monitorStarts: number;
  readonly listenCalls: number;
}

function startServiceContender(databasePath: string): ChildProcess {
  return fork(
    resolve('dist/tests/support/sqlite-service-contender-child.js'),
    [databasePath],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
}

function nextServiceResult(
  child: ChildProcess
): Promise<ServiceContenderResult> {
  return nextIpcResult<ServiceContenderResult>(child);
}

test('rejects a competing service before gateway or recovery startup', {
  timeout: 10_000
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const owner = startChild(databasePath, 'hold');
  t.after(() => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
  });
  assert.deepEqual(await nextResult(owner), { kind: 'owned' });

  const contender = startServiceContender(databasePath);
  t.after(() => {
    if (contender.exitCode === null && contender.signalCode === null) {
      contender.kill();
    }
  });
  assert.deepEqual(await nextServiceResult(contender), {
    kind: 'startup_rejected',
    code: 'DATABASE_OWNERSHIP_BUSY',
    gatewayConstructions: 0,
    recoveryStarts: 0,
    monitorStarts: 0,
    listenCalls: 0
  });
  await waitForClose(contender);
  owner.send('release');
  await waitForClose(owner);
});
```

在 `tests/main.test.ts` 导入 `claimSqliteProcessOwnership` 与 `SqliteOwnershipError`，加入配置拒绝矩阵：

```ts
for (const databasePath of [
  ':memory:',
  ' :memory: ',
  'file:trade-ops.sqlite',
  'FILE:trade-ops.sqlite?mode=memory&cache=shared'
] as const) {
  test(`rejects non-file production database path ${databasePath}`, () => {
    let gatewayConstructions = 0;
    let databaseConstructions = 0;
    assert.throws(
      () => composeService({
        env: { ...VALID_ENV, TRADING_DATABASE_PATH: databasePath },
        gatewayFactory: (exchangeId) => {
          gatewayConstructions += 1;
          return new FakeExchangeGateway(exchangeId);
        },
        databaseFactory: () => {
          databaseConstructions += 1;
          throw new Error('database factory must not be called');
        },
        logger: false
      }),
      /^Error: invalid TRADING_DATABASE_PATH configuration$/
    );
    assert.equal(databaseConstructions, 0);
    assert.equal(gatewayConstructions, 0);
  });
}
```

加入真实临时文件的组合测试：

```ts
test('claims SQLite before gateway construction and releases after close', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-owner-'));
  const databasePath = join(directory, 'trade-ops.sqlite');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const env = { ...VALID_ENV, TRADING_DATABASE_PATH: databasePath };
  const owner = composeService({
    env,
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    logger: false
  });
  let ownerClosed = false;
  t.after(async () => {
    if (!ownerClosed) {
      await owner.server.close();
      if (owner.database.open) owner.database.close();
    }
  });

  let blockedGatewayConstructions = 0;
  assert.throws(
    () => composeService({
      env,
      gatewayFactory: (exchangeId) => {
        blockedGatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      logger: false
    }),
    (error: unknown) => error instanceof SqliteOwnershipError
      && error.code === 'DATABASE_OWNERSHIP_BUSY'
  );
  assert.equal(blockedGatewayConstructions, 0);

  await owner.server.close();
  owner.database.close();
  ownerClosed = true;
  const successor = composeService({
    env,
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    logger: false
  });
  await successor.server.close();
  successor.database.close();
});

test('releases claimed ownership when gateway construction fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-main-owner-'));
  const databasePath = join(directory, 'trade-ops.sqlite');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const env = { ...VALID_ENV, TRADING_DATABASE_PATH: databasePath };

  assert.throws(
    () => composeService({
      env,
      gatewayFactory: () => { throw new Error('gateway construction failed'); },
      logger: false
    }),
    /^Error: gateway construction failed$/
  );
  const successor = composeService({
    env,
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    logger: false
  });
  await successor.server.close();
  successor.database.close();
});
```

用以下三个测试替换旧的 `gateway construction failure happens before opening SQLite` 和原 schema fake，精确证明每条失败路径只关闭一次：

```ts
test('opens and claims SQLite before gateway construction', () => {
  let databaseConstructions = 0;
  let database: Database.Database | undefined;

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      databaseFactory: () => {
        databaseConstructions += 1;
        database = new Database(':memory:', { timeout: 0 });
        return database;
      },
      gatewayFactory: () => {
        throw new Error('gateway construction failed');
      },
      logger: false
    }),
    /^Error: gateway construction failed$/
  );
  assert.equal(databaseConstructions, 1);
  assert.equal(database?.open, false);
});

test('closes SQLite once when exclusive ownership is busy', () => {
  let closes = 0;
  let gatewayConstructions = 0;
  const database = {
    pragma(): string { return 'exclusive'; },
    exec(): never {
      throw Object.assign(new Error('raw busy detail'), {
        code: 'SQLITE_BUSY'
      });
    },
    close(): void { closes += 1; }
  } as unknown as Database.Database;

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      databaseFactory: () => database,
      gatewayFactory: (exchangeId) => {
        gatewayConstructions += 1;
        return new FakeExchangeGateway(exchangeId);
      },
      logger: false
    }),
    (error: unknown) => error instanceof SqliteOwnershipError
      && error.code === 'DATABASE_OWNERSHIP_BUSY'
      && !error.message.includes('raw busy detail')
  );
  assert.equal(gatewayConstructions, 0);
  assert.equal(closes, 1);
});

test('closes an owned database once when schema construction fails', () => {
  let closes = 0;
  const statements: string[] = [];
  const database = {
    pragma(): string { return 'exclusive'; },
    exec(statement: string) {
      statements.push(statement);
      if (statements.length === 2) {
        throw new Error('schema unavailable');
      }
      return this;
    },
    close() {
      closes += 1;
      return this;
    }
  } as unknown as Database.Database;

  assert.throws(
    () => composeService({
      env: VALID_ENV,
      databaseFactory: () => database,
      gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
      logger: false
    }),
    /^Error: schema unavailable$/
  );
  assert.equal(statements[0], 'BEGIN EXCLUSIVE; COMMIT');
  assert.equal(closes, 1);
});

// 与既有的 shutdown/close 失败测试放在一起。
test('releases SQLite ownership when server close fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-ops-stop-owner-'));
  const databasePath = join(directory, 'trade-ops.sqlite');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const database = new Database(databasePath, { timeout: 0 });
  claimSqliteProcessOwnership(database, databasePath);
  t.after(() => {
    if (database.open) database.close();
  });

  const started = await startService({
    config: { host: '127.0.0.1', port: 3000 },
    monitor: {
      start: () => () => {},
      stop: async () => {}
    },
    server: {
      listen: async () => 'unused',
      close: async () => { throw new Error('server close failed'); }
    },
    database
  }, {
    signalTarget: new SignalTarget(),
    listen: async () => {}
  });
  await assert.rejects(started.shutdown(), /^Error: server close failed$/);
  assert.equal(database.open, false);

  const successor = new Database(databasePath, { timeout: 0 });
  assert.doesNotThrow(() => {
    claimSqliteProcessOwnership(successor, databasePath);
  });
  successor.close();
});
```

- [x] **Step 6: 运行 main 测试并确认启动顺序仍旧错误**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/storage/sqlite-process-owner.test.js dist/tests/main.test.js
```

Expected: FAIL；低层所有权用例仍通过，但竞争服务、配置路径或 main 顺序用例失败：当前配置接受内存/URI 路径，且 gateway 在数据库所有权之前构造。

- [x] **Step 7: 重排生产组合并记录运维约束**

在 `src/main.ts` 导入 `claimSqliteProcessOwnership`，配置路径校验固定为：

```ts
function databasePath(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_DATABASE_PATH;
  const trimmed = raw.trim();
  if (
    trimmed === ''
    || raw.includes('\0')
    || trimmed === ':memory:'
    || /^file:/i.test(trimmed)
  ) {
    return invalidConfiguration('TRADING_DATABASE_PATH');
  }
  return trimmed;
}

function defaultDatabaseFactory(path: string): Database.Database {
  return new Database(path, { timeout: 0 });
}
```

`composeService` 必须把 database open、claim 和 repository 放在 gateway 构造之前；整个后续构造位于同一个 `try/catch` 内：

```ts
const config = loadRuntimeConfig(env);
mkdirSync(dirname(resolve(config.databasePath)), {
  recursive: true,
  mode: 0o700
});
const databaseFactory = options.databaseFactory ?? defaultDatabaseFactory;
const database = databaseFactory(config.databasePath);
try {
  claimSqliteProcessOwnership(database, config.databasePath);
  const clock = options.clock ?? (() => new Date());
  const repository = new SqliteStrategyRepository(database, clock);

  const gatewayFactory = options.gatewayFactory ?? defaultGatewayFactory;
  const gateways = new Map<string, ExchangeGateway>();
  for (const exchangeId of config.exchangeIds) {
    const credentials = config.credentials.get(exchangeId);
    if (credentials === undefined) {
      throw new Error(
        `missing credentials for configured exchange ${exchangeId}`
      );
    }
    gateways.set(
      exchangeId,
      gatewayFactory(exchangeId, credentials, env)
    );
  }
  const registry = new ExchangeRegistry(gateways);
  const preflightService = new PreflightService(registry, clock);
  const operationalLog = nonThrowingOperationalLog(
    options.operationalLog
      ?? (options.loggerInstance === undefined
        ? undefined
        : createOperationalLog(
            options.loggerInstance,
            () => configuredSecretValues(env)
          ))
  );
  const tradeEvents = options.tradeEvents
    ?? (options.loggerInstance === undefined
      ? NOOP_TRADE_EVENT_SINK
      : new PinoTradeEventSink(
          options.loggerInstance.child({ component: 'trade' }),
          () => configuredSecretValues(env)
        ));
  const coordinator = new HedgeCoordinator(
    registry,
    repository,
    tradeEvents
  );
  const monitor = new OrderMonitor(
    registry,
    repository,
    coordinator,
    tradeEvents,
    operationalLog
  );
  const server = buildServer({
    registry,
    preflightService,
    repository,
    coordinator,
    secretProvider: () => configuredSecretValues(env),
    ...(options.loggerInstance === undefined
      ? (options.logger === undefined ? {} : { logger: options.logger })
      : { loggerInstance: options.loggerInstance as FastifyBaseLogger }),
    ...(operationalLog === undefined ? {} : { operationalLog }),
    ...(options.publicDirectory === undefined
      ? {}
      : { publicDirectory: options.publicDirectory })
  });
  return {
    config,
    database,
    registry,
    repository,
    preflightService,
    coordinator,
    monitor,
    server
  };
} catch (error) {
  return closeDatabaseAfterConstructionFailure(database, error);
}
```

这是 `composeService` 的完整构造顺序。不得在 `SqliteStrategyRepository` 内隐式 claim，因为 repository 单元测试需要显式控制连接，而生产所有权属于组合入口；传入的 `databaseFactory` 合同也必须返回尚未执行 SQL 的新连接。

README 的 `TRADING_DATABASE_PATH` 行改为：

```markdown
| `TRADING_DATABASE_PATH` | `./data/trade-ops.sqlite` | 本地 SQLite 文件路径。拒绝 `:memory:` 和 `file:` URI；相对路径以启动进程的当前工作目录为基准，父目录会自动创建。 |
```

生产部署段追加以下原文：

```markdown
数据库必须位于正确支持 SQLite/VFS 文件锁的本地文件系统，不支持 NFS、SMB 或其他网络挂载。同一个数据库文件同一时刻只能由一个 trade-ops 进程持有；服务运行时，其他 SQLite 工具也不能并行读取。检查、迁移和备份前必须先停止服务并等待数据库关闭。进程崩溃后，新实例通过 SQLite 原生锁接管并执行恢复；应用不创建或清理 PID 文件或独立 lock 文件。
```

- [x] **Step 8: 运行所有权与组合回归并提交**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/storage/sqlite-process-owner.test.js dist/tests/main.test.js
```

Expected: PASS；所有权套件 5 tests 与 main 回归全部通过且无残留 child；第二组合的 gateway、恢复、`monitor.start`、`listen` 计数均为零，owner 关闭后 successor 成功。

```bash
git add src/storage/sqlite-process-owner.ts src/main.ts tests/storage/sqlite-process-owner.test.ts tests/support/sqlite-owner-child.ts tests/support/sqlite-service-contender-child.ts tests/main.test.ts README.md
git commit -m "feat: enforce exclusive SQLite process ownership"
```

---

### Task 2: 持久化订单提交证据并让快照附加语义幂等

**Files:**
- Modify: `src/storage/strategy-repository.ts:18-90`
- Modify: `src/storage/schema.ts:1-120`
- Modify: `src/storage/sqlite-strategy-repository.ts:42-114, 199-237, 990-1123, 1178-1183, 1295-1349, 1467-1623`
- Modify: `tests/storage/sqlite-repository.test.ts`
- Modify: `tests/logging/trade-events.test.ts:42-75, 151-170`
- Modify: `tests/strategy/order-monitor.test.ts:404-463, 1969-2150`
- Modify: `tests/strategy/hedge-coordinator.test.ts:3060-3095`

**Interfaces:**
- Consumes: Task 1 已独占的生产连接，以及现有 `StrategyRepository`、`StrategyOrderRecord`、`validatedSnapshot`、SQLite 状态 CAS 与不可变 `order_events`；仓储本身不得再次 claim 或新开连接。
- Produces: `OrderSubmissionDisposition`、`OrderSubmissionFailureCode`、`SnapshotAttachmentResult`、`OrderSnapshotValidationError`、`OrderSnapshotWriteConflictError`、`markDefinitelyNotSubmitted(id, failureCode): boolean`。

- [x] **Step 1: 写 v1 迁移、提交证据 CAS 和语义快照的失败测试**

在 `tests/storage/sqlite-repository.test.ts` 扩展临时文件 import：

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

在 `tests/storage/sqlite-repository.test.ts` 增加下列完整 v1 schema fixture；它逐列固定当前 v1 定义，不从 v2 schema 做字符串替换：

```ts
const LEGACY_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE strategies (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN (
      'PENDING_CONFIRMATION', 'EXECUTING', 'WAITING_HEDGE',
      'HEDGED', 'HEDGE_INCOMPLETE', 'FAILED'
    )),
    mode TEXT NOT NULL CHECK (mode IN (
      'CONCURRENT', 'CONTRACT_FIRST', 'SPOT_FIRST'
    )),
    spot_exchange_id TEXT NOT NULL,
    contract_exchange_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    requested_base_quantity TEXT NOT NULL,
    effective_base_quantity TEXT NOT NULL,
    preflight_json TEXT NOT NULL,
    failure_code TEXT CHECK (
      failure_code IS NULL OR failure_code IN (
        'ORDER_SUBMISSION_FAILED', 'ORDER_SUBMISSION_UNKNOWN',
        'ORDER_NOT_FOUND', 'NO_FILL', 'MISSING_AVERAGE_PRICE',
        'HEDGE_ORDER_REJECTED', 'HEDGE_ORDER_CANCELED',
        'ORDER_RECONCILIATION_FAILED', 'INCONSISTENT_ORDER_STATE'
      )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (state IN ('HEDGE_INCOMPLETE', 'FAILED') AND failure_code IS NOT NULL)
      OR
      (state NOT IN ('HEDGE_INCOMPLETE', 'FAILED') AND failure_code IS NULL)
    )
  );
  CREATE TABLE strategy_orders (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    role TEXT NOT NULL CHECK (role IN (
      'SPOT_MARKET', 'CONTRACT_MARKET',
      'SPOT_HEDGE_GTC', 'CONTRACT_HEDGE_GTC'
    )),
    exchange_id TEXT NOT NULL,
    client_order_id TEXT NOT NULL UNIQUE,
    exchange_order_id TEXT,
    request_json TEXT NOT NULL,
    snapshot_json TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'planned', 'open', 'closed', 'canceled', 'rejected', 'unknown'
    )),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(strategy_id, role),
    CHECK (
      (status = 'planned' AND snapshot_json IS NULL
        AND exchange_order_id IS NULL)
      OR
      (status <> 'planned' AND snapshot_json IS NOT NULL
        AND exchange_order_id IS NOT NULL)
    )
  );
  CREATE TABLE order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_order_id TEXT NOT NULL REFERENCES strategy_orders(id),
    snapshot_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX strategies_recoverable_idx
    ON strategies(state, created_at);
  CREATE INDEX strategy_orders_strategy_idx
    ON strategy_orders(strategy_id, created_at);
  CREATE INDEX order_events_order_idx
    ON order_events(strategy_order_id, id);
  CREATE TRIGGER order_events_no_update
  BEFORE UPDATE ON order_events
  BEGIN
    SELECT RAISE(ABORT, 'order events are immutable');
  END;
  CREATE TRIGGER order_events_no_delete
  BEFORE DELETE ON order_events
  BEGIN
    SELECT RAISE(ABORT, 'order events are immutable');
  END;
`;

function legacyDatabase(t: TestContext): Database.Database {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(LEGACY_SCHEMA);
  return database;
}

function seedLegacyExecutingStrategy(
  database: Database.Database,
  strategyId: string
): void {
  const preview = preflight();
  database.prepare(`
    INSERT INTO strategies (
      id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
      requested_base_quantity, effective_base_quantity, preflight_json,
      failure_code, created_at, updated_at
    ) VALUES (?, 'EXECUTING', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    strategyId,
    preview.mode,
    preview.spotExchangeId,
    preview.contractExchangeId,
    preview.symbol,
    preview.requestedBaseQuantity,
    preview.effectiveBaseQuantity,
    JSON.stringify(preview),
    preview.createdAt,
    preview.createdAt
  );
}

function seedLegacyPlannedOrder(
  database: Database.Database,
  strategyId: string,
  orderId: string
): void {
  const request = requestFor(strategyId, 'CONTRACT_MARKET');
  database.prepare(`
    INSERT INTO strategy_orders (
      id, strategy_id, role, exchange_id, client_order_id,
      exchange_order_id, request_json, snapshot_json, status,
      created_at, updated_at
    ) VALUES (?, ?, 'CONTRACT_MARKET', 'okx', ?, NULL, ?, NULL,
      'planned', ?, ?)
  `).run(
    orderId,
    strategyId,
    request.clientOrderId,
    JSON.stringify(request),
    '2026-07-26T00:00:00.000Z',
    '2026-07-26T00:00:00.000Z'
  );
}

function seedLegacyObservedOrder(
  database: Database.Database,
  strategyId: string,
  orderId: string
): void {
  const request = requestFor(strategyId, 'SPOT_HEDGE_GTC', {
    baseQuantity: '0.4'
  });
  const snapshot = snapshotFor(request, 'bitget', {
    exchangeOrderId: 'legacy-observed-exchange-order',
    requestedBaseQuantity: '0.4',
    remainingBaseQuantity: '0.4'
  });
  database.prepare(`
    INSERT INTO strategy_orders (
      id, strategy_id, role, exchange_id, client_order_id,
      exchange_order_id, request_json, snapshot_json, status,
      created_at, updated_at
    ) VALUES (?, ?, 'SPOT_HEDGE_GTC', 'bitget', ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    orderId,
    strategyId,
    request.clientOrderId,
    snapshot.exchangeOrderId,
    JSON.stringify(request),
    JSON.stringify(snapshot),
    '2026-07-26T00:00:00.000Z',
    snapshot.updatedAt
  );
  database.prepare(`
    INSERT INTO order_events (strategy_order_id, snapshot_json, recorded_at)
    VALUES (?, ?, ?)
  `).run(orderId, JSON.stringify(snapshot), snapshot.updatedAt);
}

function legacyFingerprint(database: Database.Database): string {
  return JSON.stringify({
    schema: database.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all(),
    strategies: database.prepare('SELECT * FROM strategies ORDER BY id').all(),
    orders: database.prepare('SELECT * FROM strategy_orders ORDER BY id').all(),
    events: database.prepare('SELECT * FROM order_events ORDER BY id').all()
  });
}

function makeMalformedLegacyStrategies(database: Database.Database): void {
  database.pragma('foreign_keys = OFF');
  database.exec(`
    CREATE TABLE strategies_bad (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      mode TEXT NOT NULL,
      spot_exchange_id TEXT NOT NULL,
      contract_exchange_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      requested_base_quantity TEXT NOT NULL,
      effective_base_quantity TEXT NOT NULL,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO strategies_bad
    SELECT
      id, state, mode, spot_exchange_id, contract_exchange_id, symbol,
      requested_base_quantity, effective_base_quantity, failure_code,
      created_at, updated_at
    FROM strategies;
    DROP TABLE strategies;
    ALTER TABLE strategies_bad RENAME TO strategies;
    CREATE INDEX strategies_recoverable_idx
      ON strategies(state, created_at);
  `);
  database.pragma('foreign_keys = ON');
}
```

用这些 fixture 加入以下测试：

先删除现有 `fails construction when foreign keys cannot be enabled in an active transaction` 用例；它把实现锁在旧的 `foreign keys required` 文本。下面的 `rejects migration inside an external transaction without taking ownership of it` 是其严格替代：固定统一安全错误、调用方事务仍打开、schema 和数据零变化。

```ts
test('creates a fresh file database in WAL before installing v2 schema', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-schema-'));
  const database = new Database(join(directory, 'strategies.sqlite'));
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  new SqliteStrategyRepository(database);

  assert.equal(
    database.pragma('journal_mode', { simple: true }),
    'wal'
  );
  assert.deepEqual(database.prepare(`
    SELECT singleton, version FROM strategy_schema_metadata
  `).all(), [{ singleton: 1, version: 2 }]);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('migrates v1 failure constraints and order submission evidence atomically', (t) => {
  const database = legacyDatabase(t);
  seedLegacyExecutingStrategy(database, 'legacy-strategy');
  seedLegacyPlannedOrder(database, 'legacy-strategy', 'planned-order');
  seedLegacyObservedOrder(database, 'legacy-strategy', 'observed-order');

  const repository = new SqliteStrategyRepository(database);
  const [planned, observed] = repository.listOrders('legacy-strategy');

  assert.equal(planned?.submissionDisposition, 'SUBMISSION_UNCERTAIN');
  assert.equal(planned?.submissionFailureCode, null);
  assert.equal(observed?.submissionDisposition, 'REMOTE_OBSERVED');
  assert.equal(observed?.submissionFailureCode, null);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(
    repository.transition(
      'legacy-strategy',
      ['EXECUTING'],
      'HEDGE_INCOMPLETE',
      'HEDGE_RESIDUAL_NOT_TRADABLE'
    ),
    true
  );
});

test('persists definite no-submit evidence with a single compare-and-set', (t) => {
  const { repository } = setup(t);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const order = repository.planOrder(
    strategyId,
    'CONTRACT_MARKET',
    requestFor(strategyId, 'CONTRACT_MARKET')
  );

  assert.equal(
    repository.markDefinitelyNotSubmitted(order.id, 'ORDER_SUBMISSION_FAILED'),
    true
  );
  assert.equal(
    repository.markDefinitelyNotSubmitted(order.id, 'ORDER_SUBMISSION_FAILED'),
    false
  );
  assert.deepEqual(
    repository.listOrders(strategyId).map((row) => ({
      disposition: row.submissionDisposition,
      failureCode: row.submissionFailureCode
    })),
    [{
      disposition: 'DEFINITELY_NOT_SUBMITTED',
      failureCode: 'ORDER_SUBMISSION_FAILED'
    }]
  );
});

test('attaches only semantic snapshot changes and promotes evidence atomically', (t) => {
  const { repository } = setup(t);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const order = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  const first = snapshotFor(request, 'bitget');
  const timestampOnly = {
    ...first,
    updatedAt: '2026-07-26T00:02:00.000Z'
  };

  assert.equal(repository.attachOrderSnapshot(order.id, first), 'attached');
  assert.equal(
    repository.attachOrderSnapshot(order.id, timestampOnly),
    'unchanged'
  );
  assert.equal(repository.listOrderEvents(order.id).length, 1);
  assert.equal(
    repository.listOrders(strategyId)[0]?.submissionDisposition,
    'REMOTE_OBSERVED'
  );
});
```

加入约束矩阵和已有快照的 CAS 测试：

```ts
test('never marks a remotely observed order as definitely not submitted', (t) => {
  const { repository } = setup(t);
  const strategyId = repository.createPending(preflight()).id;
  assert.equal(repository.claimForExecution(strategyId), true);
  const request = requestFor(strategyId, 'SPOT_MARKET');
  const order = repository.planOrder(strategyId, 'SPOT_MARKET', request);
  assert.equal(
    repository.attachOrderSnapshot(order.id, snapshotFor(request, 'bitget')),
    'attached'
  );

  assert.equal(repository.markDefinitelyNotSubmitted(
    order.id,
    'ORDER_SUBMISSION_FAILED'
  ), false);
  const persisted = repository.listOrders(strategyId)[0];
  assert.equal(persisted?.submissionDisposition, 'REMOTE_OBSERVED');
  assert.equal(persisted?.submissionFailureCode, null);
});

function evidenceConstraintFixture(
  t: TestContext,
  schema: 'fresh v2' | 'migrated v1'
) {
  if (schema === 'fresh v2') {
    const { database, repository } = setup(t);
    const strategyId = repository.createPending(preflight()).id;
    assert.equal(repository.claimForExecution(strategyId), true);
    return {
      database,
      repository,
      strategyId,
      order: repository.planOrder(
        strategyId,
        'CONTRACT_MARKET',
        requestFor(strategyId, 'CONTRACT_MARKET')
      )
    };
  }

  const database = legacyDatabase(t);
  const strategyId = 'migrated-constraint-strategy';
  seedLegacyExecutingStrategy(database, strategyId);
  seedLegacyPlannedOrder(database, strategyId, 'migrated-planned-order');
  const repository = new SqliteStrategyRepository(database);
  const [order] = repository.listOrders(strategyId);
  assert.ok(order);
  return { database, repository, strategyId, order };
}

for (const schema of ['fresh v2', 'migrated v1'] as const) {
  test(`enforces submission evidence constraints for ${schema}`, (t) => {
    const {
      database,
      repository,
      strategyId,
      order
    } = evidenceConstraintFixture(t, schema);

    for (const statement of [
      `UPDATE strategy_orders
       SET submission_failure_code = 'ORDER_SUBMISSION_FAILED'
       WHERE id = ?`,
      `UPDATE strategy_orders
       SET submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
       WHERE id = ?`,
      `UPDATE strategy_orders
       SET submission_disposition = 'REMOTE_OBSERVED'
       WHERE id = ?`
    ]) {
      assert.throws(
        () => database.prepare(statement).run(order.id),
        /constraint|submission evidence/i
      );
    }

    const insertRequest = requestFor(strategyId, 'SPOT_MARKET');
    const insertSnapshot = snapshotFor(insertRequest, 'bitget', {
      status: 'open',
      remainingBaseQuantity: insertRequest.baseQuantity
    });
    const invalidInserts = [
      {
        status: 'planned',
        exchangeOrderId: null,
        snapshotJson: null,
        disposition: 'DEFINITELY_NOT_SUBMITTED',
        failureCode: null
      },
      {
        status: 'planned',
        exchangeOrderId: null,
        snapshotJson: null,
        disposition: 'SUBMISSION_UNCERTAIN',
        failureCode: 'ORDER_SUBMISSION_FAILED'
      },
      {
        status: 'planned',
        exchangeOrderId: null,
        snapshotJson: null,
        disposition: 'REMOTE_OBSERVED',
        failureCode: null
      },
      {
        status: 'open',
        exchangeOrderId: insertSnapshot.exchangeOrderId,
        snapshotJson: JSON.stringify(insertSnapshot),
        disposition: 'SUBMISSION_UNCERTAIN',
        failureCode: null
      },
      {
        status: 'open',
        exchangeOrderId: insertSnapshot.exchangeOrderId,
        snapshotJson: JSON.stringify(insertSnapshot),
        disposition: 'DEFINITELY_NOT_SUBMITTED',
        failureCode: 'HEDGE_RESIDUAL_NOT_TRADABLE'
      }
    ] as const;

    for (const [index, invalid] of invalidInserts.entries()) {
      assert.throws(
        () => database.prepare(`
          INSERT INTO strategy_orders (
            id, strategy_id, role, exchange_id, client_order_id,
            exchange_order_id, request_json, snapshot_json, status,
            submission_disposition, submission_failure_code,
            created_at, updated_at
          ) VALUES (?, ?, 'SPOT_MARKET', 'bitget', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `invalid-evidence-${index}`,
          strategyId,
          insertRequest.clientOrderId,
          invalid.exchangeOrderId,
          JSON.stringify(insertRequest),
          invalid.snapshotJson,
          invalid.status,
          invalid.disposition,
          invalid.failureCode,
          '2026-07-26T00:00:00.000Z',
          '2026-07-26T00:00:00.000Z'
        ),
        /constraint|submission evidence/i
      );
    }

    const request = requestFor(strategyId, 'CONTRACT_MARKET');
    assert.equal(
      repository.attachOrderSnapshot(
        order.id,
        snapshotFor(request, 'okx')
      ),
      'attached'
    );
    for (const statement of [
      `UPDATE strategy_orders
       SET submission_disposition = 'SUBMISSION_UNCERTAIN'
       WHERE id = ?`,
      `UPDATE strategy_orders
       SET status = 'planned', snapshot_json = NULL, exchange_order_id = NULL
       WHERE id = ?`
    ]) {
      assert.throws(
        () => database.prepare(statement).run(order.id),
        /constraint|submission evidence/i
      );
    }
    const persisted = repository.listOrders(strategyId)
      .find(({ id }) => id === order.id);
    assert.ok(persisted);
    assert.equal(persisted.status, 'open');
    assert.equal(persisted.submissionDisposition, 'REMOTE_OBSERVED');
    assert.notEqual(persisted.snapshot, null);
    assert.equal(repository.listOrderEvents(order.id).length, 1);
  });
}

test('rejects an unknown schema version without modifying the database', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-ops-unknown-schema-'));
  const database = new Database(join(directory, 'strategies.sqlite'));
  t.after(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  database.exec(LEGACY_SCHEMA);
  seedLegacyExecutingStrategy(database, 'unknown-version-strategy');
  database.exec(`
    CREATE TABLE strategy_schema_metadata (
      singleton INTEGER PRIMARY KEY,
      version INTEGER NOT NULL
    );
    INSERT INTO strategy_schema_metadata (singleton, version) VALUES (1, 99);
  `);
  const before = legacyFingerprint(database);
  const journalModeBefore = database.pragma(
    'journal_mode',
    { simple: true }
  );
  assert.equal(journalModeBefore, 'delete');

  assert.throws(
    () => new SqliteStrategyRepository(database),
    /^Error: SQLite strategy schema migration failed$/
  );

  assert.equal(legacyFingerprint(database), before);
  assert.equal(
    database.pragma('journal_mode', { simple: true }),
    journalModeBefore
  );
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
});

test('rejects migration inside an external transaction without taking ownership of it', (t) => {
  const database = legacyDatabase(t);
  seedLegacyExecutingStrategy(database, 'external-transaction-strategy');
  const before = legacyFingerprint(database);
  database.exec('BEGIN');
  try {
    assert.throws(
      () => new SqliteStrategyRepository(database),
      /^Error: SQLite strategy schema migration failed$/
    );
    assert.equal(database.inTransaction, true);
    assert.equal(legacyFingerprint(database), before);
    assert.equal(
      database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'strategy_schema_metadata'
      `).get(),
      undefined
    );
  } finally {
    database.exec('ROLLBACK');
  }
});

test('constructs a v2 repository twice without changing migrated data', (t) => {
  const database = legacyDatabase(t);
  seedLegacyExecutingStrategy(database, 'legacy-strategy');
  seedLegacyPlannedOrder(database, 'legacy-strategy', 'planned-order');
  seedLegacyObservedOrder(database, 'legacy-strategy', 'observed-order');
  const first = new SqliteStrategyRepository(database);
  const firstOrders = first.listOrders('legacy-strategy');
  const firstEvents = first.listOrderEvents('observed-order');

  const second = new SqliteStrategyRepository(database);

  assert.deepEqual(second.listOrders('legacy-strategy'), firstOrders);
  assert.deepEqual(second.listOrderEvents('observed-order'), firstEvents);
  assert.deepEqual(database.prepare(`
    SELECT singleton, version FROM strategy_schema_metadata
  `).all(), [{ singleton: 1, version: 2 }]);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const failurePoint of ['early malformed copy', 'late index install'] as const) {
  test(`rolls back the whole v1 migration after ${failurePoint}`, (t) => {
    const database = legacyDatabase(t);
    seedLegacyExecutingStrategy(database, 'legacy-strategy');
    seedLegacyPlannedOrder(database, 'legacy-strategy', 'planned-order');
    seedLegacyObservedOrder(database, 'legacy-strategy', 'observed-order');
    if (failurePoint === 'early malformed copy') {
      makeMalformedLegacyStrategies(database);
    } else {
      database.exec(`
        DROP INDEX strategies_recoverable_idx;
        CREATE TABLE strategies_recoverable_idx (blocker TEXT NOT NULL);
      `);
    }
    const before = legacyFingerprint(database);

    assert.throws(
      () => new SqliteStrategyRepository(database),
      /SQLite strategy schema migration failed/
    );

    assert.equal(legacyFingerprint(database), before);
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(
      database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'strategy_schema_metadata'
      `).get(),
      undefined
    );
    assert.equal(
      database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'strategies_v2'
      `).get(),
      undefined
    );
    assert.equal(
      (database.prepare('PRAGMA table_info(strategy_orders)').all() as Array<{
        name: string;
      }>).some(({ name }) => (
        name === 'submission_disposition'
        || name === 'submission_failure_code'
      )),
      false
    );
    assert.deepEqual(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name LIKE 'strategy_orders_submission_evidence_%'
      ORDER BY name
    `).all(), []);
    assert.equal(
      database.prepare('SELECT COUNT(*) FROM strategies').pluck().get(),
      1
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) FROM strategy_orders').pluck().get(),
      2
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) FROM order_events').pluck().get(),
      1
    );
  });
}
```

- [x] **Step 2: 运行测试并确认按预期变红**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test --test-name-pattern='fresh file database|migrates v1|definite no-submit|semantic snapshot|submission evidence constraints|unknown schema version|external transaction' dist/tests/storage/sqlite-repository.test.js
```

Expected: FAIL；首先出现 `submissionDisposition`、`markDefinitelyNotSubmitted` 或 `HEDGE_RESIDUAL_NOT_TRADABLE` 尚未定义的 TypeScript 错误，而不是原生模块 ABI 错误。公共接口接通后继续运行同一命令，必须看到 fresh v2 的 CHECK 与 migrated v1 的触发器矩阵都因非法 INSERT/UPDATE 变红，且未知版本和外部事务用例仍失败；不能只以新库约束失败作为迁移红灯。

- [x] **Step 3: 扩展仓储类型和类型化错误**

在 `src/storage/strategy-repository.ts` 按“接口锁定”代码加入三个类型和两个字段，并加入以下错误与方法签名：

```ts
export class OrderSnapshotValidationError extends Error {
  readonly name = 'OrderSnapshotValidationError';

  constructor(detail: string) {
    super(detail);
  }
}

export class OrderSnapshotWriteConflictError extends Error {
  readonly name = 'OrderSnapshotWriteConflictError';

  constructor() {
    super('strategy order changed during snapshot attachment');
  }
}
```

把 `HEDGE_RESIDUAL_NOT_TRADABLE` 加入 `StrategyFailureCode`。`attachOrderSnapshot` 返回 `SnapshotAttachmentResult`，`markDefinitelyNotSubmitted` 只接受 `OrderSubmissionFailureCode`。

- [x] **Step 4: 实现版本化、可回滚的 SQLite v1 到 v2 迁移**

先从 `SQLITE_STRATEGY_SCHEMA` 删除 `PRAGMA foreign_keys = ON` 和 `PRAGMA journal_mode = WAL`；该常量只保留可放进事务的 v2 DDL。生产文件连接此时已经由 Task 1 在 `main.ts` 中取得独占所有权；仓储不得再次 claim。

构造器顺序固定为：拒绝外部事务；启用并验证 connection-local foreign keys；只读识别 `empty/v1/v2`，未知 metadata 版本立即抛固定错误；只有识别成功后才在事务外设置并验证 WAL；最后才执行空库创建、v1 迁移或 v2 只读验证。不能在未知数据库上先执行持久化 PRAGMA：

```ts
if (this.database.inTransaction) {
  throw new Error('SQLite strategy schema migration failed');
}
let schemaGeneration: 'empty' | 'v1' | 'v2';
try {
  this.database.pragma('foreign_keys = ON');
  if (!sqliteIntegerEquals(
    this.database.pragma('foreign_keys', { simple: true }),
    1
  )) {
    throw new Error('foreign keys unavailable');
  }
  schemaGeneration = classifyStrategySchema(this.database);
} catch {
  throw new Error('SQLite strategy schema migration failed');
}

try {
  const journalMode = this.database.pragma(
    'journal_mode = WAL',
    { simple: true }
  );
  const expectedJournalMode = this.database.name === ':memory:'
    ? 'memory'
    : 'wal';
  if (
    typeof journalMode !== 'string'
    || journalMode.toLowerCase() !== expectedJournalMode
  ) {
    throw new Error('journal mode unavailable');
  }
} catch {
  throw new Error('SQLite strategy schema migration failed');
}
```

`classifyStrategySchema` 只能执行 `sqlite_master` 和 metadata `SELECT`。无任何用户表才返回 `empty`；没有 metadata 且 `strategies`、`strategy_orders`、`order_events` 三张业务表都存在才返回待迁移的 `v1`；metadata 恰有 `{ singleton: 1, version: 2 }` 且三张业务表都存在才返回待完整只读验证的 `v2`。缺少任一业务表、metadata 表的行数/singleton/版本不符，或 metadata 与业务表集合矛盾都抛错，且在此之前不得执行 `journal_mode`、DDL、DML 或其他持久化写入。v1 可以包含 `late index install` fixture 的额外冲突对象，但不能在事务外预检列或索引后提前返回；其细部结构验证由下面固定顺序的事务内 DDL/DML 自然完成。v2 的必需对象在 WAL 设置后只读验证，失败时不执行 schema 写入。

`journal_mode` 只能在成功分类后、事务外设置；禁止把它放回 `SQLITE_STRATEGY_SCHEMA`、新库 schema transaction 或 v1 migration transaction。临时/测试 `:memory:` 连接唯一允许返回 `memory`，其他连接必须返回 `wal`。v1 重建需要的 `foreign_keys = OFF` 也必须在迁移事务开始前执行；`schemaGeneration` 只决定随后进入哪个已验证分支，不能在 WAL 设置后重新猜测版本。

在 `src/storage/schema.ts` 定义 schema 版本表，新建库的 `strategies.failure_code` 白名单包含新失败码，`strategy_orders` 加入以下列与约束：

```sql
submission_disposition TEXT NOT NULL DEFAULT 'SUBMISSION_UNCERTAIN' CHECK (
  submission_disposition IN (
    'SUBMISSION_UNCERTAIN',
    'DEFINITELY_NOT_SUBMITTED',
    'REMOTE_OBSERVED'
  )
),
submission_failure_code TEXT CHECK (
  submission_failure_code IS NULL
  OR submission_failure_code IN (
    'ORDER_SUBMISSION_FAILED',
    'HEDGE_RESIDUAL_NOT_TRADABLE'
  )
),
CHECK (
  (
    submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
    AND submission_failure_code IS NOT NULL
  )
  OR
  (
    submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'
    AND submission_failure_code IS NULL
  )
),
CHECK (
  (
    status = 'planned'
    AND submission_disposition IN (
      'SUBMISSION_UNCERTAIN',
      'DEFINITELY_NOT_SUBMITTED'
    )
  )
  OR
  (
    status <> 'planned'
    AND submission_disposition = 'REMOTE_OBSERVED'
  )
)
```

版本表固定为单行：

```sql
CREATE TABLE IF NOT EXISTS strategy_schema_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 2)
);
INSERT OR IGNORE INTO strategy_schema_metadata (singleton, version)
VALUES (1, 2);
```

构造器先确认不在外部事务中并启用外键。若 `strategies` 已存在但版本表不存在，则把它视为唯一受支持的 v1 candidate：关闭外键，并严格按以下顺序执行一个 `better-sqlite3` 事务，不能把源列或索引预检提前到相应故障点之前：

1. 先 `CREATE TABLE strategies_v2`，再用显式列清单执行 `INSERT INTO strategies_v2 ... SELECT ... preflight_json ... FROM strategies`。`early malformed copy` fixture 必须在临时表已经创建后因缺少源列失败，从而验证该 DDL 被回滚。
2. 删除旧 `strategies` 并把 `strategies_v2` 改名；随后给 `strategy_orders` 增加两列并完成回填。
3. 安装两条提交证据触发器，再重建必需索引。不得提前拒绝名为 `strategies_recoverable_idx` 的错误对象；`late index install` fixture 必须在父表重建、列回填和触发器安装后由实际 `CREATE INDEX` 失败，从而验证全部中间变更被回滚。
4. 执行 `foreign_key_check` 和 schema 对象验证，最后才写 version 2 metadata。

订单证据按以下规则回填：

```sql
UPDATE strategy_orders
SET
  submission_disposition = CASE
    WHEN snapshot_json IS NULL THEN 'SUBMISSION_UNCERTAIN'
    ELSE 'REMOTE_OBSERVED'
  END,
  submission_failure_code = NULL;
```

迁移表的两条等价触发器使用固定名称和固定安全消息；`UPDATE OF` 必须包含旧状态三列，不能只监听新增证据列：

```sql
CREATE TRIGGER strategy_orders_submission_evidence_insert
BEFORE INSERT ON strategy_orders
WHEN NOT (
  (
    (
      NEW.submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
      AND NEW.submission_failure_code IS NOT NULL
    )
    OR
    (
      NEW.submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'
      AND NEW.submission_failure_code IS NULL
    )
  )
  AND
  (
    (
      NEW.status = 'planned'
      AND NEW.snapshot_json IS NULL
      AND NEW.exchange_order_id IS NULL
      AND NEW.submission_disposition IN (
        'SUBMISSION_UNCERTAIN', 'DEFINITELY_NOT_SUBMITTED'
      )
    )
    OR
    (
      NEW.status <> 'planned'
      AND NEW.snapshot_json IS NOT NULL
      AND NEW.exchange_order_id IS NOT NULL
      AND NEW.submission_disposition = 'REMOTE_OBSERVED'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid submission evidence');
END;

CREATE TRIGGER strategy_orders_submission_evidence_update
BEFORE UPDATE OF
  status,
  snapshot_json,
  exchange_order_id,
  submission_disposition,
  submission_failure_code
ON strategy_orders
WHEN NOT (
  (
    (
      NEW.submission_disposition = 'DEFINITELY_NOT_SUBMITTED'
      AND NEW.submission_failure_code IS NOT NULL
    )
    OR
    (
      NEW.submission_disposition <> 'DEFINITELY_NOT_SUBMITTED'
      AND NEW.submission_failure_code IS NULL
    )
  )
  AND
  (
    (
      NEW.status = 'planned'
      AND NEW.snapshot_json IS NULL
      AND NEW.exchange_order_id IS NULL
      AND NEW.submission_disposition IN (
        'SUBMISSION_UNCERTAIN', 'DEFINITELY_NOT_SUBMITTED'
      )
    )
    OR
    (
      NEW.status <> 'planned'
      AND NEW.snapshot_json IS NOT NULL
      AND NEW.exchange_order_id IS NOT NULL
      AND NEW.submission_disposition = 'REMOTE_OBSERVED'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid submission evidence');
END;
```

同一迁移事务内先完成父表重建、订单列回填、提交证据触发器和所有索引，再执行 `PRAGMA foreign_key_check`；任何结果行或 DDL 错误都抛固定错误并回滚。schema version 必须是事务中的最后一次写入，不能在触发器或索引安装前标记为 v2。`finally` 恢复 `PRAGMA foreign_keys = ON`，提交后只做第二次 `foreign_key_check` 和版本/必需 schema object 只读验证。新库也在单个业务 schema 事务中最后写 version。未知版本直接拒绝启动，不能猜测 schema。针对 ALTER TABLE 无法添加跨列 CHECK 的 v1 表，迁移事务创建等价的 `BEFORE INSERT` 和 `BEFORE UPDATE OF status, snapshot_json, exchange_order_id, submission_disposition, submission_failure_code` 触发器，覆盖 failure-code 配对和 planned/remote-snapshot 配对两项约束。v2 只读验证必须接受两种等价来源：fresh v2 的 table-level CHECK，或 migrated v1 的上述精确触发器；不能错误要求 fresh v2 也存在冗余触发器。

迁移入口用固定错误包住列验证、事务执行和提交后验证；所有 catch 都新建 `Error('SQLite strategy schema migration failed')`，`finally` 在该错误离开方法前执行 `database.pragma('foreign_keys = ON')`。

- [x] **Step 5: 实现证据 CAS 与语义快照事务**

`markDefinitelyNotSubmitted` 使用一条 UPDATE，WHERE 必须同时包含 `status = 'planned'`、`snapshot_json IS NULL`、`exchange_order_id IS NULL`、`submission_disposition = 'SUBMISSION_UNCERTAIN'` 和 `submission_failure_code IS NULL`。只有 `changes === 1` 返回 `true`。

语义比较固定排除 `updatedAt`，其他字段全部参与：

```ts
function sameSnapshotSemantics(
  left: Readonly<OrderSnapshot>,
  right: Readonly<OrderSnapshot>
): boolean {
  return left.exchangeId === right.exchangeId
    && left.exchangeOrderId === right.exchangeOrderId
    && left.clientOrderId === right.clientOrderId
    && left.symbol === right.symbol
    && left.kind === right.kind
    && left.type === right.type
    && left.side === right.side
    && decimalEqual(left.requestedBaseQuantity, right.requestedBaseQuantity)
    && decimalEqual(left.filledBaseQuantity, right.filledBaseQuantity)
    && decimalEqual(left.remainingBaseQuantity, right.remainingBaseQuantity)
    && (
      left.averagePrice === null
        ? right.averagePrice === null
        : right.averagePrice !== null
          && decimalEqual(left.averagePrice, right.averagePrice)
    )
    && left.status === right.status;
}
```

`attachSnapshotInsideTransaction` 的固定次序为：读取并验证当前行；校验新快照；若语义相同返回 `unchanged`；插入不可变事件；CAS 更新订单快照，同时把 disposition 设为 `REMOTE_OBSERVED`、failure code 清空；CAS 未命中抛 `OrderSnapshotWriteConflictError`，事务自动回滚事件；成功返回 `attached`。把仓储快照校验的固定安全错误包装为 `OrderSnapshotValidationError`，不携带原始数据库或交易所异常。

同步扩展 `STRATEGY_FAILURE_CODES`、`StrategyOrderDbRow`、订单 disposition enum set、`insertOrder` 和 `orderFromRow`。新 plan 必须显式写 `SUBMISSION_UNCERTAIN/null`；row mapper 必须验证三种 disposition、failure allowlist、快照与 `REMOTE_OBSERVED` 的配对关系，以及无快照行不能为 `REMOTE_OBSERVED`，然后把两个必填字段放入冻结后的 `StrategyOrderRecord`。

- [x] **Step 6: 更新现有类型替身并运行目标测试**

`tests/strategy/order-monitor.test.ts` 的 `RepositoryProxy` 使用以下两个方法：

```ts
import type {
  OrderSubmissionFailureCode,
  SnapshotAttachmentResult
} from '../../src/storage/strategy-repository.js';

attachOrderSnapshot(
  strategyOrderId: string,
  snapshot: OrderSnapshot
): SnapshotAttachmentResult {
  return this.target.attachOrderSnapshot(strategyOrderId, snapshot);
}

markDefinitelyNotSubmitted(
  strategyOrderId: string,
  failureCode: OrderSubmissionFailureCode
): boolean {
  return this.target.markDefinitelyNotSubmitted(
    strategyOrderId,
    failureCode
  );
}
```

所有显式 `StrategyOrderRecord` fixture 增加：

```ts
submissionDisposition: 'REMOTE_OBSERVED',
submissionFailureCode: null,
```

所有测试 override 的固定形状为下列两种之一：

```ts
override attachOrderSnapshot(
  strategyOrderId: string,
  snapshot: OrderSnapshot
): SnapshotAttachmentResult {
  return super.attachOrderSnapshot(strategyOrderId, snapshot);
}
```

```ts
override attachOrderSnapshot(
  _strategyOrderId: string,
  _snapshot: OrderSnapshot
): SnapshotAttachmentResult {
  throw new Error('controlled snapshot write failure');
}
```

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/storage/sqlite-repository.test.js dist/tests/logging/trade-events.test.js
```

Expected: PASS；退出码 `0`。迁移测试同时断言 `PRAGMA foreign_key_check` 为空。

- [x] **Step 7: 提交仓储底座**

```bash
git add src/storage/strategy-repository.ts src/storage/schema.ts src/storage/sqlite-strategy-repository.ts tests/storage/sqlite-repository.test.ts tests/logging/trade-events.test.ts tests/strategy/order-monitor.test.ts tests/strategy/hedge-coordinator.test.ts
git commit -m "feat: persist hedge submission evidence"
```

---

### Task 3: 增加脱敏、非抛错的对账 warning 合同

**Files:**
- Modify: `src/logging/logger.ts:37-61, 122-158, 198-270`
- Modify: `tests/logging/logger.test.ts`
- Modify: `tests/main.test.ts:350-380, 672-685`
- Modify: `tests/http/server.test.ts:50-65, 1988-2002`
- Modify: `tests/strategy/order-monitor.test.ts:333-349, 1852-1860`

**Interfaces:**
- Consumes: 现有 `OperationalLog`、`operationalFields`、`redactText` 和 `nonThrowingOperationalLog`。
- Produces: 必填 `OperationalLog.warn(event, fields?)`，以及对账结论需要的显式 allowlist 字段。

- [x] **Step 1: 写 warning 字段、脱敏和失败隔离的红测试**

在 `tests/logging/logger.test.ts` 增加：

```ts
test('writes allowlisted reconciliation warnings with redacted values', () => {
  const output: string[] = [];
  const logger = createAppLogger(captureDestination(output));
  const operations = createOperationalLog(logger, () => ['secret-value']);

  operations.warn('hedge_reconciliation_pending', {
    strategyId: 'strategy-1',
    strategyState: 'EXECUTING',
    conclusion: 'pending',
    reason: 'ORDER_LOOKUP_FAILED',
    role: 'SPOT_MARKET',
    exchangeId: 'bitget',
    strategyOrderId: 'order-1',
    clientOrderId: 'secret-value-client',
    expected: 'closed',
    actual: 'unknown',
    exposureKnown: true,
    marketSpot: '1',
    marketContract: '0.6',
    preGtcResidual: '0.4',
    currentResidual: '0.4'
  });

  const entry = JSON.parse(output.join('').trim()) as Record<string, unknown>;
  assert.equal(entry.level, 40);
  assert.equal(entry.reason, 'ORDER_LOOKUP_FAILED');
  assert.equal(entry.clientOrderId, '[Redacted]-client');
  assert.equal(entry.exposureKnown, true);
  assert.equal('credentials' in entry, false);
});
```

再加入同步抛错和异步 rejection 的完整隔离测试；若 wrapper 没有消费 promise rejection，`node:test` 会把该用例判失败：

```ts
test('absorbs synchronous and asynchronous warning failures', async () => {
  const synchronous = nonThrowingOperationalLog({
    info(): void {},
    warn(): void { throw new Error('sync warning failure'); },
    error(): void {},
    fatal(): void {}
  });
  assert.doesNotThrow(() => synchronous?.warn('sync_warning'));

  const asynchronous = nonThrowingOperationalLog({
    info(): void {},
    warn(): void {
      return Promise.reject(new Error('async warning failure')) as never;
    },
    error(): void {},
    fatal(): void {}
  });
  asynchronous?.warn('async_warning');
  await new Promise<void>((resolve) => setImmediate(resolve));
});
```

- [x] **Step 2: 运行测试并确认缺少 warn 时失败**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test --test-name-pattern='reconciliation warnings|warning failures' dist/tests/logging/logger.test.js
```

Expected: FAIL；TypeScript 报 `OperationalLog` 没有 `warn`，或测试替身缺少必填方法。

- [x] **Step 3: 实现显式字段白名单和 warn 包装**

在 `OperationalFields` 加入以下字段，全部为只读标量，不允许任意对象、原始响应或异常文本：

```ts
readonly strategyState?: string;
readonly conclusion?: string;
readonly failureCode?: string;
readonly reason?: string;
readonly role?: string;
readonly exchangeId?: string;
readonly strategyOrderId?: string;
readonly clientOrderId?: string;
readonly exchangeOrderId?: string;
readonly expected?: string;
readonly actual?: string;
readonly exposureKnown?: boolean;
readonly marketSpot?: string;
readonly marketContract?: string;
readonly preGtcResidual?: string;
readonly currentResidual?: string;
```

`operationalFields` 对所有字符串逐项调用 `redactText`，布尔值原样复制。`OperationalLog` 加入：

```ts
warn(event: string, fields?: Readonly<OperationalFields>): void;
```

`createOperationalLog` 返回对象加入：

```ts
warn(event, fields): void {
  try {
    const secrets = secretProvider();
    const safeEvent = redactText(event, secrets);
    logger.warn(operationalFields(event, fields, secrets), safeEvent);
  } catch {
    // Logging is never allowed to change service behavior.
  }
},
```

`nonThrowingOperationalLog` 返回对象加入：

```ts
warn(event, fields): void {
  try {
    const result: unknown = logger.warn(event, fields);
    void Promise.resolve(result).catch(() => {});
  } catch {
    // Injected logging is never allowed to change service behavior.
  }
},
```

`tests/main.test.ts`、`tests/http/server.test.ts` 与 `tests/strategy/order-monitor.test.ts` 的所有显式 `OperationalLog` 对象加入同一个空实现：

```ts
warn(): void {}
```

- [x] **Step 4: 运行日志与全仓编译检查**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/logging/logger.test.js dist/tests/logging/trade-events.test.js
```

Expected: PASS；退出码 `0`。warning 输出只有 allowlist 字段，secret 被替换为 `[Redacted]`。

- [x] **Step 5: 提交可观察性合同**

```bash
git add src/logging/logger.ts tests/logging/logger.test.ts tests/main.test.ts tests/http/server.test.ts tests/strategy/order-monitor.test.ts
git commit -m "feat: add reconciliation warning fields"
```

---

### Task 4: 实现本地拓扑预检、查所与幂等快照证据收集器

**Files:**
- Create: `src/strategy/hedge-reconciliation-evidence.ts`
- Create: `tests/strategy/hedge-reconciliation.test.ts`

**Interfaces:**
- Consumes: `ExchangeRegistry.get(exchangeId)`、Task 2 的仓储证据和快照结果、`nonThrowingTradeEventSink`、`orderEvent`。
- Produces: `inspectLocalTopology(strategy, orders): LocalTopologyResult` 与 `HedgeOrderEvidenceCollector.collect(strategy, orders): Promise<EvidenceCollectionResult>`；只供 Task 5 的 `HedgeReconciliation` 使用。

- [x] **Step 1: 建立真实形状的对账 fixture 与证据矩阵红测试**

新测试文件复用 `FakeExchangeGateway`，但在文件内定义 tracking 子类，不把测试 helper 暴露到生产代码：

```ts
class ReconciliationGateway extends FakeExchangeGateway {
  readonly fetchCalls: string[] = [];
  readonly findCalls: string[] = [];
  readonly scriptedFetch = new Map<string, Array<OrderSnapshot | Error>>();
  readonly scriptedFind = new Map<string, Array<OrderSnapshot | null | Error>>();

  override async fetchOrder(
    exchangeOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot> {
    this.fetchCalls.push(exchangeOrderId);
    const value = this.scriptedFetch.get(exchangeOrderId)?.shift();
    if (value instanceof Error) throw value;
    if (value !== undefined) return value;
    return super.fetchOrder(exchangeOrderId, symbol, kind);
  }

  override async findOrderByClientId(
    clientOrderId: string,
    symbol: string,
    kind: MarketKind
  ): Promise<OrderSnapshot | null> {
    this.findCalls.push(clientOrderId);
    const value = this.scriptedFind.get(clientOrderId)?.shift();
    if (value instanceof Error) throw value;
    if (value !== undefined) return value;
    return super.findOrderByClientId(clientOrderId, symbol, kind);
  }
}
```

同文件使用以下确定性 fixture；所需 import 明确为 Node `assert/test`、`better-sqlite3`、`makeClientOrderId`、领域类型、`ExchangeRegistry`、`TradeEvent/TradeEventSink`、`SqliteStrategyRepository`、`StrategyOrderRecord`、`HedgeOrderEvidenceCollector`、`PreflightResult` 和 `FakeExchangeGateway`：

```ts
const SYMBOL = 'BTC/USDT';
const OBSERVED_AT = '2026-09-05T00:01:00.000Z';

function reconciliationPreflight(
  mode: ExecutionMode,
  effectiveBaseQuantity = '1'
): PreflightResult {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: effectiveBaseQuantity,
    effectiveBaseQuantity,
    mode,
    spotMarket: {
      exchangeId: 'bitget',
      symbol: SYMBOL,
      marketId: 'BTCUSDT',
      kind: 'spot',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '0.001',
      contractSize: '1',
      minBaseAmount: '0.001',
      minQuoteNotional: '0',
      priceStep: '0.1'
    },
    contractMarket: {
      exchangeId: 'okx',
      symbol: SYMBOL,
      marketId: 'BTC-USDT-SWAP',
      kind: 'swap',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      amountStep: '1',
      contractSize: '0.001',
      minBaseAmount: '0.001',
      minQuoteNotional: '0',
      priceStep: '0.1'
    },
    accountSettings: {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    },
    spotFreeUsdt: '100000',
    contractFreeUsdt: '50000',
    spotReferencePrice: '60000',
    contractReferencePrice: '60010',
    riskAcknowledgementRequired: true,
    createdAt: '2026-09-05T00:00:00.000Z'
  };
}

function requestForRole(
  strategyId: string,
  role: OrderRole,
  baseQuantity = '1'
): OrderRequest {
  const clientOrderId = makeClientOrderId(strategyId, role);
  switch (role) {
    case 'SPOT_MARKET':
      return {
        symbol: SYMBOL,
        kind: 'spot',
        type: 'market',
        side: 'buy',
        baseQuantity,
        clientOrderId
      };
    case 'CONTRACT_MARKET':
      return {
        symbol: SYMBOL,
        kind: 'swap',
        type: 'market',
        side: 'sell',
        baseQuantity,
        clientOrderId,
        positionSide: 'SHORT',
        marginMode: 'cross'
      };
    case 'SPOT_HEDGE_GTC':
      return {
        symbol: SYMBOL,
        kind: 'spot',
        type: 'limit',
        side: 'buy',
        baseQuantity,
        price: '60000',
        timeInForce: 'GTC',
        clientOrderId
      };
    case 'CONTRACT_HEDGE_GTC':
      return {
        symbol: SYMBOL,
        kind: 'swap',
        type: 'limit',
        side: 'sell',
        baseQuantity,
        price: '60000',
        timeInForce: 'GTC',
        clientOrderId,
        positionSide: 'SHORT',
        marginMode: 'cross'
      };
  }
}

function snapshotForOrder(
  order: Readonly<StrategyOrderRecord>,
  overrides: Partial<OrderSnapshot> = {}
): OrderSnapshot {
  return {
    exchangeId: order.exchangeId,
    exchangeOrderId: `${order.role.toLowerCase()}-remote`,
    clientOrderId: order.clientOrderId,
    symbol: order.request.symbol,
    kind: order.request.kind,
    type: order.request.type,
    side: order.request.side,
    requestedBaseQuantity: order.request.baseQuantity,
    filledBaseQuantity: order.request.baseQuantity,
    remainingBaseQuantity: '0',
    averagePrice: '60000',
    status: 'closed',
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

interface ReconciliationFixture {
  readonly repository: SqliteStrategyRepository;
  readonly registry: ExchangeRegistry;
  readonly collector: HedgeOrderEvidenceCollector;
  readonly spot: ReconciliationGateway;
  readonly contract: ReconciliationGateway;
  readonly strategyId: string;
  readonly tradeEvents: TradeEvent[];
  readonly tradeEventSink: TradeEventSink;
}

function fixture(
  t: TestContext,
  mode: ExecutionMode,
  effectiveBaseQuantity = '1',
  claimForExecution = true
): ReconciliationFixture {
  const database = new Database(':memory:');
  t.after(() => database.close());
  let clockTick = 0;
  const repository = new SqliteStrategyRepository(
    database,
    () => new Date(Date.parse('2026-09-05T00:00:00.000Z') + clockTick++ * 1000)
  );
  const preview = reconciliationPreflight(mode, effectiveBaseQuantity);
  const strategyId = repository.createPending(preview).id;
  if (claimForExecution) {
    assert.equal(repository.claimForExecution(strategyId), true);
  }
  const spot = new ReconciliationGateway('bitget');
  const contract = new ReconciliationGateway('okx');
  spot.markets.set(`spot:${SYMBOL}`, preview.spotMarket);
  contract.markets.set(`swap:${SYMBOL}`, preview.contractMarket);
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  const tradeEvents: TradeEvent[] = [];
  const tradeEventSink: TradeEventSink = {
    record: (event) => tradeEvents.push(structuredClone(event))
  };
  const collector = new HedgeOrderEvidenceCollector(
    registry,
    repository,
    tradeEventSink
  );
  return {
    repository,
    registry,
    collector,
    spot,
    contract,
    strategyId,
    tradeEvents,
    tradeEventSink
  };
}

function planOrder(
  f: ReconciliationFixture,
  role: OrderRole,
  baseQuantity = '1'
): StrategyOrderRecord {
  return f.repository.planOrder(
    f.strategyId,
    role,
    requestForRole(f.strategyId, role, baseQuantity)
  );
}

function gatewayFor(
  f: ReconciliationFixture,
  order: Readonly<StrategyOrderRecord>
): ReconciliationGateway {
  return order.exchangeId === 'bitget' ? f.spot : f.contract;
}

function scriptFind(
  f: ReconciliationFixture,
  order: Readonly<StrategyOrderRecord>,
  result: OrderSnapshot | null | Error
): void {
  gatewayFor(f, order).scriptedFind.set(order.clientOrderId, [result]);
}

function assertNoGatewayCalls(f: ReconciliationFixture): void {
  assert.deepEqual({
    fetch: f.spot.fetchCalls.length + f.contract.fetchCalls.length,
    find: f.spot.findCalls.length + f.contract.findCalls.length,
    create:
      f.spot.createdRequests.length + f.contract.createdRequests.length
  }, { fetch: 0, find: 0, create: 0 });
}
```

加入以下表驱动非法拓扑测试，完整覆盖 GTC-only、顺序模式错误市价角色、并发只有一张市价单、两张 GTC、角色集合合法但 GTC 在对应市价意图之前创建、`WAITING_HEDGE` 空集合和 `WAITING_HEDGE` 无 GTC：

```ts
const INVALID_TOPOLOGIES = [
  ['GTC only', 'CONCURRENT', 'EXECUTING', ['CONTRACT_HEDGE_GTC']],
  ['wrong sequential market', 'CONTRACT_FIRST', 'EXECUTING', ['SPOT_MARKET']],
  ['one concurrent market', 'CONCURRENT', 'EXECUTING', ['SPOT_MARKET']],
  ['two GTC orders', 'CONCURRENT', 'EXECUTING', [
    'SPOT_MARKET',
    'CONTRACT_MARKET',
    'SPOT_HEDGE_GTC',
    'CONTRACT_HEDGE_GTC'
  ]],
  ['GTC planned before its market', 'CONTRACT_FIRST', 'EXECUTING', [
    'SPOT_HEDGE_GTC',
    'CONTRACT_MARKET'
  ]],
  ['empty waiting strategy', 'CONTRACT_FIRST', 'WAITING_HEDGE', []],
  ['waiting strategy without GTC', 'CONCURRENT', 'WAITING_HEDGE', [
    'SPOT_MARKET',
    'CONTRACT_MARKET'
  ]]
] as const satisfies readonly (readonly [
  string,
  ExecutionMode,
  'EXECUTING' | 'WAITING_HEDGE',
  readonly OrderRole[]
])[];

for (const [name, mode, state, roles] of INVALID_TOPOLOGIES) {
  test(`rejects invalid local topology: ${name}`, (t) => {
    const f = fixture(t, mode);
    for (const role of roles) planOrder(f, role);
    if (state === 'WAITING_HEDGE') {
      assert.equal(f.repository.transition(
        f.strategyId,
        ['EXECUTING'],
        'WAITING_HEDGE'
      ), true);
    }

    const result = inspectLocalTopology(
      f.repository.getStrategy(f.strategyId),
      f.repository.listOrders(f.strategyId)
    );

    assert.equal(result.kind, 'pending');
    if (result.kind === 'pending') {
      assert.equal(result.reason, 'INVALID_LOCAL_TOPOLOGY');
      assert.equal(result.exposureKnown, false);
    }
    assertNoGatewayCalls(f);
  });
}

for (const [mode, roles] of [
  ['CONTRACT_FIRST', ['CONTRACT_MARKET']],
  ['CONTRACT_FIRST', ['CONTRACT_MARKET', 'SPOT_HEDGE_GTC']],
  ['SPOT_FIRST', ['SPOT_MARKET']],
  ['SPOT_FIRST', ['SPOT_MARKET', 'CONTRACT_HEDGE_GTC']],
  ['CONCURRENT', ['SPOT_MARKET', 'CONTRACT_MARKET']],
  ['CONCURRENT', [
    'SPOT_MARKET',
    'CONTRACT_MARKET',
    'CONTRACT_HEDGE_GTC'
  ]],
  ['CONCURRENT', [
    'SPOT_MARKET',
    'CONTRACT_MARKET',
    'SPOT_HEDGE_GTC'
  ]]
] as const satisfies readonly (
  readonly [ExecutionMode, readonly OrderRole[]]
)[]) {
  test(`accepts valid local topology: ${mode}/${roles.join('+')}`, (t) => {
    const f = fixture(t, mode);
    const planned = roles.map((role) => planOrder(f, role));

    const result = inspectLocalTopology(
      f.repository.getStrategy(f.strategyId),
      f.repository.listOrders(f.strategyId)
    );

    assert.equal(result.kind, 'valid');
    if (result.kind === 'valid') {
      assert.deepEqual(
        result.orders.map(({ id }) => id),
        planned.map(({ id }) => id)
      );
    }
    assertNoGatewayCalls(f);
  });
}

test('classifies only an empty executing strategy as empty topology', (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  assert.deepEqual(inspectLocalTopology(
    f.repository.getStrategy(f.strategyId),
    []
  ), { kind: 'empty' });
  assertNoGatewayCalls(f);
});

test('rejects a market intent whose quantity differs from the strategy target', (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  planOrder(f, 'CONTRACT_MARKET', '0.5');

  const result = inspectLocalTopology(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.deepEqual(result, {
    kind: 'pending',
    reason: 'INVALID_LOCAL_TOPOLOGY',
    exposureKnown: false
  });
  assertNoGatewayCalls(f);
});

test('reports known local exposure while rejecting an invalid topology', (t) => {
  const f = fixture(t, 'CONCURRENT');
  const spot = planOrder(f, 'SPOT_MARKET');
  assert.equal(f.repository.attachOrderSnapshot(
    spot.id,
    snapshotForOrder(spot, {
      status: 'open',
      filledBaseQuantity: '0.2',
      remainingBaseQuantity: '0.8',
      averagePrice: '60000'
    })
  ), 'attached');

  assert.deepEqual(inspectLocalTopology(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  ), {
    kind: 'pending',
    reason: 'INVALID_LOCAL_TOPOLOGY',
    exposureKnown: true
  });
  assertNoGatewayCalls(f);
});
```

再加入以下查所测试：

```ts
test('persists successful observations before returning a partial lookup failure', async (t) => {
  const f = fixture(t, 'CONCURRENT');
  const spotOrder = planOrder(f, 'SPOT_MARKET');
  const contractOrder = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, spotOrder, snapshotForOrder(spotOrder));
  scriptFind(f, contractOrder, new Error('private detail'));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_LOOKUP_FAILED');
  assert.equal(result.strategyOrderId, contractOrder.id);
  assert.equal(result.exposureKnown, true);
  assert.equal(f.repository.listOrders(f.strategyId)[0]?.status, 'closed');
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
});

test('keeps an uncertain planned order pending when lookup returns null', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, order, null);

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [order]
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'SUBMISSION_UNCERTAIN');
  assert.equal(f.contract.createdRequests.length, 0);
});
```

其余查所、证据和写冲突分支使用以下可执行测试；不得用一个宽泛的“lookup failed”用例代替：

```ts
test('continues after the first lookup failure in repository order', async (t) => {
  const f = fixture(t, 'CONCURRENT');
  const spotOrder = planOrder(f, 'SPOT_MARKET');
  const contractOrder = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, spotOrder, new Error('private first failure'));
  scriptFind(f, contractOrder, snapshotForOrder(contractOrder));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_LOOKUP_FAILED');
  assert.equal(result.strategyOrderId, spotOrder.id);
  assert.equal(f.repository.listOrders(f.strategyId)[1]?.status, 'closed');
  assert.deepEqual(f.spot.findCalls, [spotOrder.clientOrderId]);
  assert.deepEqual(f.contract.findCalls, [contractOrder.clientOrderId]);
});

test('falls back from exchange id lookup to client id lookup', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const planned = planOrder(f, 'CONTRACT_MARKET');
  assert.equal(f.repository.attachOrderSnapshot(
    planned.id,
    snapshotForOrder(planned, {
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6',
      status: 'open'
    })
  ), 'attached');
  const observed = f.repository.listOrders(f.strategyId)[0];
  assert.ok(observed?.exchangeOrderId);
  f.contract.scriptedFetch.set(observed.exchangeOrderId, [
    new Error('private fetch failure')
  ]);
  scriptFind(f, observed, snapshotForOrder(observed, {
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    status: 'closed',
    updatedAt: '2026-09-05T00:02:00.000Z'
  }));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [observed]
  );

  assert.equal(result.kind, 'ready');
  assert.deepEqual(f.contract.fetchCalls, [observed.exchangeOrderId]);
  assert.deepEqual(f.contract.findCalls, [observed.clientOrderId]);
  assert.equal(f.repository.listOrders(f.strategyId)[0]?.status, 'closed');
});

for (const [name, disposition, expectedReason] of [
  ['uncertain', 'SUBMISSION_UNCERTAIN', 'SUBMISSION_UNCERTAIN'],
  ['remote observed', 'REMOTE_OBSERVED', 'ORDER_NOT_FOUND']
] as const) {
  test(`classifies a missing ${name} order exactly`, async (t) => {
    const f = fixture(t, 'CONTRACT_FIRST');
    const planned = planOrder(f, 'CONTRACT_MARKET');
    if (disposition === 'REMOTE_OBSERVED') {
      assert.equal(f.repository.attachOrderSnapshot(
        planned.id,
        snapshotForOrder(planned, {
          filledBaseQuantity: '0.4',
          remainingBaseQuantity: '0.6',
          status: 'open'
        })
      ), 'attached');
    }
    const order = f.repository.listOrders(f.strategyId)[0];
    assert.ok(order);
    if (order.exchangeOrderId !== null) {
      f.contract.scriptedFetch.set(order.exchangeOrderId, [
        new Error('private fetch failure')
      ]);
    }
    scriptFind(f, order, null);

    const result = await f.collector.collect(
      f.repository.getStrategy(f.strategyId),
      [order]
    );

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, expectedReason);
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  });
}

test('accepts definite no-submit only after client lookup confirms null', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  assert.equal(f.repository.markDefinitelyNotSubmitted(
    order.id,
    'ORDER_SUBMISSION_FAILED'
  ), true);
  scriptFind(f, order, null);

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') {
    assert.equal(result.orders[0]?.submissionDisposition,
      'DEFINITELY_NOT_SUBMITTED');
    assert.equal(result.orders[0]?.snapshot, null);
  }
  assert.deepEqual(f.contract.findCalls, [order.clientOrderId]);
});

test('persists a remote contradiction to definite no-submit then blocks', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  assert.equal(f.repository.markDefinitelyNotSubmitted(
    order.id,
    'ORDER_SUBMISSION_FAILED'
  ), true);
  scriptFind(f, order, snapshotForOrder(order));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
  const persisted = f.repository.listOrders(f.strategyId)[0];
  assert.equal(persisted?.submissionDisposition, 'REMOTE_OBSERVED');
  assert.equal(persisted?.status, 'closed');
});

for (const [name, patch] of [
  ['exchange identity', { exchangeId: 'bitget' }],
  ['client identity', { clientOrderId: 'different-client-id' }],
  ['symbol', { symbol: 'ETH/USDT' }],
  ['kind', { kind: 'spot' }],
  ['type', { type: 'limit' }],
  ['side', { side: 'buy' }],
  ['requested quantity', { requestedBaseQuantity: '2' }]
] as const satisfies readonly (
  readonly [string, Partial<OrderSnapshot>]
)[]) {
  test(`blocks remote ${name} mismatch`, async (t) => {
    const f = fixture(t, 'CONTRACT_FIRST');
    const order = planOrder(f, 'CONTRACT_MARKET');
    scriptFind(f, order, snapshotForOrder(order, patch));

    const result = await f.collector.collect(
      f.repository.getStrategy(f.strategyId),
      [order]
    );

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
    assert.equal(f.repository.listOrders(f.strategyId)[0]?.status, 'planned');
  });
}

for (const [name, patch] of [
  ['quantity conservation', {
    filledBaseQuantity: '0.7',
    remainingBaseQuantity: '0.4'
  }],
  ['numeric format', { filledBaseQuantity: 'not-a-decimal' }]
] as const satisfies readonly (
  readonly [string, Partial<OrderSnapshot>]
)[]) {
  test(`blocks invalid snapshot ${name}`, async (t) => {
    const f = fixture(t, 'CONTRACT_FIRST');
    const order = planOrder(f, 'CONTRACT_MARKET');
    scriptFind(f, order, snapshotForOrder(order, patch));

    const result = await f.collector.collect(
      f.repository.getStrategy(f.strategyId),
      [order]
    );

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'ORDER_SNAPSHOT_INVALID');
    assert.equal(f.repository.listOrderEvents(order.id).length, 0);
  });
}

test('maps an attach compare-and-set conflict without retaining its cause', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  scriptFind(f, order, snapshotForOrder(order));
  const originalAttach = f.repository.attachOrderSnapshot.bind(f.repository);
  Reflect.set(f.repository, 'attachOrderSnapshot', () => {
    throw new OrderSnapshotWriteConflictError();
  });
  t.after(() => Reflect.set(
    f.repository,
    'attachOrderSnapshot',
    originalAttach
  ));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [order]
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'SNAPSHOT_WRITE_CONFLICT');
  assert.equal(f.repository.listOrderEvents(order.id).length, 0);
});
```

```ts
for (const [name, localPatch, remotePatch] of [
  ['status regression', {
    status: 'closed',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0'
  }, {
    status: 'open',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0'
  }],
  ['exchange order id change', {
    status: 'open',
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6'
  }, {
    exchangeOrderId: 'different-remote-order',
    status: 'closed',
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0'
  }]
] as const satisfies readonly (readonly [
  string,
  Partial<OrderSnapshot>,
  Partial<OrderSnapshot>
])[]) {
  test(`blocks ${name} against persisted evidence`, async (t) => {
    const f = fixture(t, 'CONTRACT_FIRST');
    const planned = planOrder(f, 'CONTRACT_MARKET');
    assert.equal(f.repository.attachOrderSnapshot(
      planned.id,
      snapshotForOrder(planned, localPatch)
    ), 'attached');
    const before = f.repository.listOrders(f.strategyId)[0];
    assert.ok(before?.exchangeOrderId);
    f.contract.scriptedFetch.set(before.exchangeOrderId, [
      snapshotForOrder(before, {
        ...remotePatch,
        updatedAt: '2026-09-05T00:02:00.000Z'
      })
    ]);

    const result = await f.collector.collect(
      f.repository.getStrategy(f.strategyId),
      [before]
    );

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'ORDER_EVIDENCE_MISMATCH');
    assert.deepEqual(f.repository.listOrders(f.strategyId)[0], before);
    assert.equal(f.repository.listOrderEvents(planned.id).length, 1);
  });
}

test('reports both exchange-id and client-id lookup failure safely', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const planned = planOrder(f, 'CONTRACT_MARKET');
  assert.equal(f.repository.attachOrderSnapshot(
    planned.id,
    snapshotForOrder(planned, {
      status: 'open',
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0.6'
    })
  ), 'attached');
  const order = f.repository.listOrders(f.strategyId)[0];
  assert.ok(order?.exchangeOrderId);
  f.contract.scriptedFetch.set(order.exchangeOrderId, [
    new Error('private fetch detail')
  ]);
  scriptFind(f, order, new Error('private client lookup detail'));

  const result = await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    [order]
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'ORDER_LOOKUP_FAILED');
  assert.doesNotMatch(
    JSON.stringify(result),
    /private fetch detail|private client lookup detail/
  );
}
```

- [x] **Step 2: 运行证据测试并确认新模块缺失**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test --test-name-pattern='topology|lookup|observation|snapshot' dist/tests/strategy/hedge-reconciliation.test.js
```

Expected: FAIL；导入 `hedge-reconciliation-evidence.js` 失败，或预期类型尚未导出。

- [x] **Step 3: 建立闭集结果与可编译失败封闭骨架**

在 `src/strategy/hedge-reconciliation-evidence.ts` 定义：

```ts
export type EvidencePendingReason =
  | 'INVALID_LOCAL_TOPOLOGY'
  | 'ORDER_LOOKUP_FAILED'
  | 'ORDER_NOT_FOUND'
  | 'SUBMISSION_UNCERTAIN'
  | 'ORDER_SNAPSHOT_INVALID'
  | 'ORDER_EVIDENCE_MISMATCH'
  | 'SNAPSHOT_WRITE_CONFLICT';

export interface EvidencePending {
  readonly kind: 'pending';
  readonly reason: EvidencePendingReason;
  readonly exposureKnown: boolean;
  readonly strategyOrderId?: string;
  readonly clientOrderId?: string;
  readonly exchangeId?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export type LocalTopologyResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'valid'; readonly orders: readonly StrategyOrderRecord[] }
  | EvidencePending;

export type EvidenceCollectionResult =
  | {
      readonly kind: 'ready';
      readonly orders: readonly StrategyOrderRecord[];
    }
  | EvidencePending;
```

先只加入下列可编译、始终失败封闭的骨架，不实现查所或写库：

```ts
export function inspectLocalTopology(
  strategy: Readonly<StrategyRecord>,
  orders: readonly StrategyOrderRecord[]
): LocalTopologyResult {
  if (orders.length === 0 && strategy.state === 'EXECUTING') {
    return { kind: 'empty' };
  }
  return {
    kind: 'pending',
    reason: 'INVALID_LOCAL_TOPOLOGY',
    exposureKnown: false
  };
}

export class HedgeOrderEvidenceCollector {
  constructor(
    _registry: ExchangeRegistry,
    _repository: StrategyRepository,
    _tradeEvents: TradeEventSink = NOOP_TRADE_EVENT_SINK
  ) {}

  async collect(
    _strategy: Readonly<StrategyRecord>,
    _orders: readonly StrategyOrderRecord[]
  ): Promise<EvidenceCollectionResult> {
    return {
      kind: 'pending',
      reason: 'ORDER_LOOKUP_FAILED',
      exposureKnown: false
    };
  }
}
```

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test --test-name-pattern='topology|lookup|observation|snapshot|definite|mismatch|conflict' dist/tests/strategy/hedge-reconciliation.test.js
```

Expected: FAIL；模块已经可以导入，但测试在具体行为断言处失败：成功快照未落库、definite-null 未返回 `ready`、身份/快照/CAS 原因不匹配。不能接受编译错误或 fixture 错误作为本轮红灯。

- [x] **Step 4: 实现严格角色集合与仓储顺序拓扑预检**

`inspectLocalTopology` 使用严格角色集合，不使用“缺什么就补什么”的逻辑。合法集合只有：

```ts
const LEGAL_ROLE_SETS: Readonly<Record<ExecutionMode, ReadonlySet<string>>> = {
  CONTRACT_FIRST: new Set([
    'CONTRACT_MARKET',
    'CONTRACT_MARKET|SPOT_HEDGE_GTC'
  ]),
  SPOT_FIRST: new Set([
    'SPOT_MARKET',
    'CONTRACT_HEDGE_GTC|SPOT_MARKET'
  ]),
  CONCURRENT: new Set([
    'CONTRACT_MARKET|SPOT_MARKET',
    'CONTRACT_HEDGE_GTC|CONTRACT_MARKET|SPOT_MARKET',
    'CONTRACT_MARKET|SPOT_HEDGE_GTC|SPOT_MARKET'
  ])
};
```

角色先按字符串排序再用 `|` 连接。除集合匹配外，每张 `*_MARKET` 的 `request.baseQuantity` 必须用精确十进制比较等于 `strategy.effectiveBaseQuantity`；不能接受更小的旧意图并据此错误宣称已完全对冲。GTC 数量不在这里和策略目标量比较，而由 Task 5 与补单前残差比较。还要保留 repository 的订单顺序并断言每张 GTC 的索引大于该模式全部必需市价角色的索引；不能仅比较 `createdAt`，因为同一原子事务中的时间戳可能相同。空集合仅在策略为 `EXECUTING` 时返回 `empty`；`WAITING_HEDGE` 空集合直接返回 `pending / INVALID_LOCAL_TOPOLOGY`。任何非空非法集合或市价请求数量不一致都立即返回 pending，不能访问 registry；其 `exposureKnown` 从已由仓储验证的本地 snapshot 正成交量计算，不能固定为 false。

- [x] **Step 5: 实现固定查所顺序、三方一致和事件唯一所有权**

`HedgeOrderEvidenceCollector` 的构造器固定为：

```ts
constructor(
  private readonly registry: ExchangeRegistry,
  private readonly repository: StrategyRepository,
  tradeEvents: TradeEventSink = NOOP_TRADE_EVENT_SINK
) {
  this.tradeEvents = nonThrowingTradeEventSink(tradeEvents);
}
```

对每张订单按仓储顺序串行执行并收集第一项 pending，但单笔失败后继续处理余下订单；这样每个成功且语义变化的快照都先落库，同时最终 reason 的选择仍是确定的。不得用 fail-fast `return` 跳过后续订单：

```ts
private async lookup(order: Readonly<StrategyOrderRecord>): Promise<OrderSnapshot | null> {
  const gateway = this.registry.get(order.exchangeId);
  if (order.exchangeOrderId === null) {
    return gateway.findOrderByClientId(
      order.clientOrderId,
      order.request.symbol,
      order.request.kind
    );
  }
  try {
    return await gateway.fetchOrder(
      order.exchangeOrderId,
      order.request.symbol,
      order.request.kind
    );
  } catch {
    return gateway.findOrderByClientId(
      order.clientOrderId,
      order.request.symbol,
      order.request.kind
    );
  }
}
```

捕获 lookup 异常时只保存固定诊断，不保存异常对象或消息，并继续下一张订单。`null` 的分支严格按 disposition 区分：`DEFINITELY_NOT_SUBMITTED` 是 ready 证据；`SUBMISSION_UNCERTAIN` 记录同名 reason；`REMOTE_OBSERVED` 记录 `ORDER_NOT_FOUND`。

远端快照先比较 exchange/client ID、symbol、kind、type、side、请求量、exchange order ID 和相对本地快照的合法状态推进；不一致返回 `ORDER_EVIDENCE_MISMATCH`。数量非负、`filled + remaining = requested` 和平均价格式属于快照内部有效性，类型化 validation error 映射为 `ORDER_SNAPSHOT_INVALID`；write conflict 映射为 `SNAPSHOT_WRITE_CONFLICT`。全部订单处理完成后重新调用 `listOrders(strategy.id)`，把结果放进 `{ kind: 'ready', orders }`，供外层再做一次独立版本比较。只有 `attached` 才记录：

```ts
function terminalOrderStatus(
  status: OrderSnapshot['status'] | undefined
): boolean {
  return status === 'closed'
    || status === 'canceled'
    || status === 'rejected';
}

this.tradeEvents.record(orderEvent(
  'order_status_changed',
  order,
  snapshot,
  { mode: strategy.mode, strategyState: strategy.state }
));
if (
  !terminalOrderStatus(order.snapshot?.status)
  && terminalOrderStatus(snapshot.status)
) {
  this.tradeEvents.record(orderEvent(
    'order_terminal',
    order,
    snapshot,
    { mode: strategy.mode, strategyState: strategy.state }
  ));
}
```

若 definite 证据反而查到远端，正常 attach 后强制返回 `ORDER_EVIDENCE_MISMATCH`；不能因 disposition 已被 attach 改成 `REMOTE_OBSERVED` 而吞掉矛盾。

- [x] **Step 6: 加入重复快照和生命周期事件测试并跑绿**

加入五轮 collect，锁定时间戳变化不写库、真实语义变化只写一次，以及终态事件的唯一所有权：

```ts
test('emits lifecycle events only for semantic snapshot changes', async (t) => {
  const f = fixture(t, 'CONTRACT_FIRST');
  const order = planOrder(f, 'CONTRACT_MARKET');
  const firstOpen = snapshotForOrder(order, {
    exchangeOrderId: 'contract-lifecycle',
    status: 'open',
    filledBaseQuantity: '0.2',
    remainingBaseQuantity: '0.8',
    averagePrice: '60010'
  });
  const timestampOnly = {
    ...firstOpen,
    updatedAt: '2026-09-05T00:02:00.000Z'
  };
  const changedOpen = {
    ...firstOpen,
    filledBaseQuantity: '0.4',
    remainingBaseQuantity: '0.6',
    updatedAt: '2026-09-05T00:03:00.000Z'
  };
  const closed = {
    ...firstOpen,
    status: 'closed' as const,
    filledBaseQuantity: '1',
    remainingBaseQuantity: '0',
    updatedAt: '2026-09-05T00:04:00.000Z'
  };
  const closedTimestampOnly = {
    ...closed,
    updatedAt: '2026-09-05T00:05:00.000Z'
  };
  scriptFind(f, order, firstOpen);
  f.contract.scriptedFetch.set('contract-lifecycle', [
    timestampOnly,
    changedOpen,
    closed,
    closedTimestampOnly
  ]);

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  const afterFirst = structuredClone(
    f.repository.listOrders(f.strategyId)[0]
  );
  assert.equal(f.repository.listOrderEvents(order.id).length, 1);
  assert.equal(f.tradeEvents.length, 1);

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  assert.deepEqual(f.repository.listOrders(f.strategyId)[0], afterFirst);
  assert.equal(f.repository.listOrderEvents(order.id).length, 1);
  assert.equal(f.tradeEvents.length, 1);

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  assert.equal(f.repository.listOrderEvents(order.id).length, 2);
  assert.equal(f.tradeEvents.length, 2);

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  assert.equal(f.repository.listOrderEvents(order.id).length, 3);
  assert.equal(
    f.tradeEvents.filter(({ event }) => event === 'order_status_changed').length,
    3
  );
  assert.equal(
    f.tradeEvents.filter(({ event }) => event === 'order_terminal').length,
    1
  );

  assert.equal((await f.collector.collect(
    f.repository.getStrategy(f.strategyId),
    f.repository.listOrders(f.strategyId)
  )).kind, 'ready');
  assert.equal(f.repository.listOrderEvents(order.id).length, 3);
  assert.equal(f.tradeEvents.length, 4);
  assert.equal(f.contract.createdRequests.length, 0);
});
```

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/strategy/hedge-reconciliation.test.js
```

Expected: 当前证据收集测试全部 PASS；退出码 `0`。本任务没有任何 `createOrder` 调用。

- [x] **Step 7: 提交证据收集器**

```bash
git add src/strategy/hedge-reconciliation-evidence.ts tests/strategy/hedge-reconciliation.test.ts
git commit -m "feat: collect complete hedge order evidence"
```

---

### Task 5: 实现精确残差、互斥决策、可交易性和状态 CAS

**Files:**
- Modify: `src/strategy/hedge-reconciliation-evidence.ts`
- Create: `src/strategy/hedge-reconciliation.ts`
- Modify: `tests/strategy/hedge-reconciliation.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `inspectLocalTopology` 和 `HedgeOrderEvidenceCollector`，Task 2 仓储 CAS，Task 3 `OperationalLog.warn/info`，现有 `ExchangeGateway.loadMarket/quantizePrice`。
- Produces: `ReconciliationPendingReason`、`ReconciliationDiagnostic`、`ReconciliationResult`、`ReconciliationRunner`、`HedgeReconciliation.run(strategyId)`。

- [x] **Step 1: 写入口、无 GTC 和高精度决策表的红测试**

在 Task 4 的 fixture 中构造真实 `HedgeReconciliation`，并加入以下辅助函数。后续每个测试都必须通过 fake 的查回结果形成证据，不能直接调用私有决策方法：

```ts
interface DecisionFixture extends ReconciliationFixture {
  readonly reconciliation: HedgeReconciliation;
}

function decisionFixture(
  t: TestContext,
  mode: ExecutionMode,
  operationalLog?: OperationalLog,
  effectiveBaseQuantity = '1',
  claimForExecution = true
): DecisionFixture {
  const f = fixture(t, mode, effectiveBaseQuantity, claimForExecution);
  return {
    ...f,
    reconciliation: new HedgeReconciliation(
      f.registry,
      f.repository,
      f.tradeEventSink,
      operationalLog
    )
  };
}

function marketRoles(mode: ExecutionMode): readonly OrderRole[] {
  if (mode === 'CONTRACT_FIRST') return ['CONTRACT_MARKET'];
  if (mode === 'SPOT_FIRST') return ['SPOT_MARKET'];
  return ['SPOT_MARKET', 'CONTRACT_MARKET'];
}

function fixtureRemaining(filled: string): string {
  switch (filled) {
    case '0': return '1';
    case '0.6': return '0.4';
    case '1': return '0';
    default: throw new Error(`missing explicit fixture remaining for ${filled}`);
  }
}

interface ClosedConcurrentSeed {
  readonly requested: string;
  readonly spotFill: string;
  readonly spotRemaining: string;
  readonly spotAverage: string | null;
  readonly contractFill: string;
  readonly contractRemaining: string;
  readonly contractAverage: string | null;
}

function seedClosedConcurrentMarkets(
  f: DecisionFixture,
  seed: ClosedConcurrentSeed
): readonly [StrategyOrderRecord, StrategyOrderRecord] {
  const spotOrder = planOrder(f, 'SPOT_MARKET', seed.requested);
  const contractOrder = planOrder(f, 'CONTRACT_MARKET', seed.requested);
  scriptFind(f, spotOrder, snapshotForOrder(spotOrder, {
    filledBaseQuantity: seed.spotFill,
    remainingBaseQuantity: seed.spotRemaining,
    averagePrice: seed.spotAverage,
    status: 'closed'
  }));
  scriptFind(f, contractOrder, snapshotForOrder(contractOrder, {
    filledBaseQuantity: seed.contractFill,
    remainingBaseQuantity: seed.contractRemaining,
    averagePrice: seed.contractAverage,
    status: 'closed'
  }));
  return [spotOrder, contractOrder];
}
```

加入以下表和实际执行循环：

```ts
const NO_GTC_CASES = [
  {
    name: 'sequential rejected zero fill',
    mode: 'CONTRACT_FIRST',
    fills: ['0'],
    statuses: ['rejected'],
    expected: ['FAILED', 'ORDER_SUBMISSION_FAILED']
  },
  {
    name: 'sequential closed zero fill',
    mode: 'CONTRACT_FIRST',
    fills: ['0'],
    statuses: ['closed'],
    expected: ['FAILED', 'NO_FILL']
  },
  {
    name: 'concurrent equal fills',
    mode: 'CONCURRENT',
    fills: ['1', '1'],
    statuses: ['closed', 'closed'],
    expected: ['HEDGED', null]
  },
  {
    name: 'concurrent rejected opposite positive fill',
    mode: 'CONCURRENT',
    fills: ['1', '0'],
    statuses: ['closed', 'rejected'],
    expected: ['HEDGE_INCOMPLETE', 'INCONSISTENT_ORDER_STATE']
  },
  {
    name: 'concurrent rejected zero fills',
    mode: 'CONCURRENT',
    fills: ['0', '0'],
    statuses: ['rejected', 'closed'],
    expected: ['FAILED', 'ORDER_SUBMISSION_FAILED']
  },
  {
    name: 'concurrent ordinary zero fills',
    mode: 'CONCURRENT',
    fills: ['0', '0'],
    statuses: ['canceled', 'closed'],
    expected: ['FAILED', 'NO_FILL']
  }
] as const;

for (const testCase of NO_GTC_CASES) {
  test(testCase.name, async (t) => {
    const f = decisionFixture(t, testCase.mode);
    const roles = marketRoles(testCase.mode);
    for (const [index, role] of roles.entries()) {
      const order = planOrder(f, role);
      const filled = testCase.fills[index];
      const status = testCase.statuses[index];
      assert.ok(filled);
      assert.ok(status);
      scriptFind(f, order, snapshotForOrder(order, {
        filledBaseQuantity: filled,
        remainingBaseQuantity: fixtureRemaining(filled),
        averagePrice: filled === '0' ? null : '60000',
        status
      }));
    }

    const [expectedState, expectedFailureCode] = testCase.expected;
    const result = await f.reconciliation.run(f.strategyId);

    assert.deepEqual(result, expectedFailureCode === null
      ? { kind: 'written', state: expectedState }
      : {
          kind: 'written',
          state: expectedState,
          failureCode: expectedFailureCode
        });
    const persisted = f.repository.getStrategy(f.strategyId);
    assert.equal(persisted.state, expectedState);
    assert.equal(persisted.failureCode, expectedFailureCode);
    assert.equal(
      f.spot.createdRequests.length + f.contract.createdRequests.length,
      0
    );
  });
}
```

每行先把订单放进 fake 的查回结果，再调用 `run`，同时断言持久化状态和返回联合一致。紧接着加入显式业务测试：

```ts
test('authorizes exactly 0.4 contract GTC after reconciling spot 1 and contract 0.6', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  seedClosedConcurrentMarkets(f, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'need_gtc',
    role: 'CONTRACT_HEDGE_GTC',
    baseQuantity: '0.4',
    referencePrice: '60000'
  });
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  assert.equal(f.contract.createdRequests.length, 0);
});
```

其余入口和无 GTC 分支使用以下测试：

```ts
for (const status of ['open', 'unknown'] as const) {
  test(`keeps an active ${status} market order pending`, async (t) => {
    const f = decisionFixture(t, 'CONTRACT_FIRST');
    const order = planOrder(f, 'CONTRACT_MARKET');
    scriptFind(f, order, snapshotForOrder(order, {
      status,
      filledBaseQuantity: '0.2',
      remainingBaseQuantity: '0.8',
      averagePrice: '60010'
    }));

    const result = await f.reconciliation.run(f.strategyId);

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'MARKET_ORDER_ACTIVE');
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assert.equal(f.contract.createdRequests.length, 0);
  });
}

test('short-circuits a terminal strategy without touching orders or gateways', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  assert.equal(f.repository.transition(
    f.strategyId,
    ['EXECUTING'],
    'HEDGED'
  ), true);

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'observed_state',
    state: 'HEDGED'
  });
  assertNoGatewayCalls(f);
  assert.deepEqual(f.repository.listOrders(f.strategyId), []);
});

test('rejects a non-terminal state outside the run contract', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT', undefined, '1', false);

  await assert.rejects(
    f.reconciliation.run(f.strategyId),
    /^Error: hedge reconciliation requires an executing or waiting strategy$/
  );
  assertNoGatewayCalls(f);
  assert.equal(
    f.repository.getStrategy(f.strategyId).state,
    'PENDING_CONFIRMATION'
  );
});

for (const [mode, marketRole, hedgeRole, referencePrice] of [
  ['CONTRACT_FIRST', 'CONTRACT_MARKET', 'SPOT_HEDGE_GTC', '60010'],
  ['SPOT_FIRST', 'SPOT_MARKET', 'CONTRACT_HEDGE_GTC', '60000']
] as const) {
  test(`authorizes the opposite GTC after ${mode} first-leg fill`, async (t) => {
    const f = decisionFixture(t, mode);
    const order = planOrder(f, marketRole);
    scriptFind(f, order, snapshotForOrder(order, {
      status: 'closed',
      filledBaseQuantity: '1',
      remainingBaseQuantity: '0',
      averagePrice: referencePrice
    }));

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'need_gtc',
      role: hedgeRole,
      baseQuantity: '1',
      referencePrice
    });
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  });
}

test('writes missing average only after a positive reconciled residual', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  seedClosedConcurrentMarkets(f, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: null,
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'written',
    state: 'HEDGE_INCOMPLETE',
    failureCode: 'MISSING_AVERAGE_PRICE'
  });
  assert.equal(f.contract.createdRequests.length, 0);
});

for (const failureCode of [
  'ORDER_SUBMISSION_FAILED',
  'HEDGE_RESIDUAL_NOT_TRADABLE'
] as const) {
  test(`prioritizes definite market failure ${failureCode}`, async (t) => {
    const f = decisionFixture(t, 'CONTRACT_FIRST');
    const order = planOrder(f, 'CONTRACT_MARKET');
    assert.equal(
      f.repository.markDefinitelyNotSubmitted(order.id, failureCode),
      true
    );
    scriptFind(f, order, null);

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'written',
      state: 'FAILED',
      failureCode
    });
    assert.equal(f.repository.getStrategy(f.strategyId).failureCode,
      failureCode);
    assert.equal(f.contract.createdRequests.length, 0);
  });
}
```

高精度期望只使用以下测试私有的 `BigInt` 定点函数，不复用生产 `Decimal`：

```ts
function canonicalScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = (negative ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  const whole = magnitude.slice(0, -scale);
  const fraction = magnitude.slice(-scale).replace(/0+$/, '');
  const unsigned = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative ? `-${unsigned}` : unsigned;
}

test('keeps a residual that differs only after forty decimal places', async (t) => {
  const scale = 50;
  const one = 10n ** BigInt(scale);
  const spotScaled = one + 1n;
  const contractScaled = one;
  const requested = canonicalScaled(spotScaled, scale);
  const expectedResidual = canonicalScaled(
    spotScaled - contractScaled,
    scale
  );
  const originalPrecision = Decimal.precision;
  Decimal.set({ precision: 5 });
  t.after(() => Decimal.set({ precision: originalPrecision }));
  const f = decisionFixture(
    t,
    'CONCURRENT',
    undefined,
    requested
  );
  const market = f.contract.markets.get(`swap:${SYMBOL}`);
  assert.ok(market);
  f.contract.markets.set(`swap:${SYMBOL}`, {
    ...market,
    amountStep: '1',
    contractSize: expectedResidual,
    minBaseAmount: expectedResidual
  });
  seedClosedConcurrentMarkets(f, {
    requested,
    spotFill: requested,
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: canonicalScaled(contractScaled, scale),
    contractRemaining: expectedResidual,
    contractAverage: '60010'
  });

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'need_gtc',
    role: 'CONTRACT_HEDGE_GTC',
    baseQuantity: expectedResidual,
    referencePrice: '60000'
  });
  assert.equal(Decimal.precision, 5);
});

test('uses full product precision for amount step times contract size', async (t) => {
  const amountStep = 12345678901234567890123456789012345678901n;
  const residual = canonicalScaled(amountStep, 40);
  const f = decisionFixture(t, 'CONCURRENT', undefined, residual);
  const market = f.contract.markets.get(`swap:${SYMBOL}`);
  assert.ok(market);
  f.contract.markets.set(`swap:${SYMBOL}`, {
    ...market,
    amountStep: amountStep.toString(),
    contractSize: canonicalScaled(1n, 40),
    minBaseAmount: canonicalScaled(1n, 40)
  });
  seedClosedConcurrentMarkets(f, {
    requested: residual,
    spotFill: residual,
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0',
    contractRemaining: residual,
    contractAverage: null
  });

  assert.equal(canonicalScaled(amountStep * 1n, 40), residual);
  assert.equal((await f.reconciliation.run(f.strategyId)).kind, 'need_gtc');
});

for (const [name, minimumOffset, expectedKind] of [
  ['exact notional boundary', 0n, 'need_gtc'],
  ['one scaled unit below minimum', 1n, 'written']
] as const) {
  test(`uses full residual-price product precision: ${name}`, async (t) => {
    const residualScale = 39;
    const priceScale = 36;
    const residualInt = 123456789012345678901234567890123456789n;
    const priceInt = 81000000000000000000000000000000000001n;
    const residual = canonicalScaled(residualInt, residualScale);
    const price = canonicalScaled(priceInt, priceScale);
    const notionalScale = residualScale + priceScale;
    const exactNotional = residualInt * priceInt;
    const minimum = canonicalScaled(
      exactNotional + minimumOffset,
      notionalScale
    );
    const f = decisionFixture(t, 'CONCURRENT', undefined, residual);
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      amountStep: '1',
      contractSize: canonicalScaled(1n, residualScale),
      minBaseAmount: canonicalScaled(1n, residualScale),
      priceStep: canonicalScaled(1n, priceScale),
      minQuoteNotional: minimum
    });
    seedClosedConcurrentMarkets(f, {
      requested: residual,
      spotFill: residual,
      spotRemaining: '0',
      spotAverage: price,
      contractFill: '0',
      contractRemaining: residual,
      contractAverage: null
    });

    const result = await f.reconciliation.run(f.strategyId);

    if (expectedKind === 'need_gtc') {
      assert.deepEqual(result, {
        kind: 'need_gtc',
        role: 'CONTRACT_HEDGE_GTC',
        baseQuantity: residual,
        referencePrice: price
      });
    } else {
      assert.deepEqual(result, {
        kind: 'written',
        state: 'HEDGE_INCOMPLETE',
        failureCode: 'HEDGE_RESIDUAL_NOT_TRADABLE'
      });
    }
    assert.equal(f.contract.createdRequests.length, 0);
  });
}
```

再加一个带超时的资源边界测试。它不得在测试中构造展开后的字符串或 `BigInt` expected：

```ts
test(
  'blocks a compact decimal whose canonical form exceeds the resource limit',
  { timeout: 1_000 },
  async (t) => {
    const f = decisionFixture(
      t,
      'CONCURRENT',
      undefined,
      '2e-9000000000000000'
    );
    seedClosedConcurrentMarkets(f, {
      requested: '2e-9000000000000000',
      spotFill: '2e-9000000000000000',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '1e-9000000000000000',
      contractRemaining: '1e-9000000000000000',
      contractAverage: '60010'
    });

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'pending',
      reason: 'EXACT_ARITHMETIC_UNAVAILABLE',
      strategyState: 'EXECUTING',
      exposureKnown: true,
      expected: 'canonical decimal at most 1000000 characters',
      actual: 'canonical decimal exceeds resource limit'
    });
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assert.equal(f.contract.createdRequests.length, 0);
  }
);
```

该用例验证输入虽然可解析且加减 precision 预算很小，规范化输出仍受独立资源上限保护。实现必须在任何 `toFixed()` 前返回上述固定诊断，不能把指数或推算出的巨大宽度写入日志。

- [x] **Step 2: 写已有 GTC、可交易边界和 CAS 竞争的红测试**

已有 GTC 的固定矩阵为：

```ts
const GTC_CASES = [
  ['open partial', 'open', '0.1', '0.3', 'WAITING_HEDGE', null],
  ['closed full', 'closed', '0.4', '0', 'HEDGED', null],
  ['canceled full', 'canceled', '0.4', '0', 'HEDGED', null],
  ['rejected zero', 'rejected', '0', '0.4', 'HEDGE_INCOMPLETE', 'HEDGE_ORDER_REJECTED'],
  ['canceled partial', 'canceled', '0.1', '0.3', 'HEDGE_INCOMPLETE', 'HEDGE_ORDER_CANCELED']
] as const;

for (const [name, status, filled, remaining, state, failureCode]
  of GTC_CASES) {
  test(`reconciles an existing GTC: ${name}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '0.6',
      contractRemaining: '0.4',
      contractAverage: '60010'
    });
    const gtc = planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');
    scriptFind(f, gtc, snapshotForOrder(gtc, {
      filledBaseQuantity: filled,
      remainingBaseQuantity: remaining,
      averagePrice: filled === '0' ? null : '60000',
      status
    }));

    const result = await f.reconciliation.run(f.strategyId);

    assert.deepEqual(result, failureCode === null
      ? { kind: 'written', state }
      : { kind: 'written', state, failureCode });
    const persisted = f.repository.getStrategy(f.strategyId);
    assert.equal(persisted.state, state);
    assert.equal(persisted.failureCode, failureCode);
    assert.equal(
      f.spot.createdRequests.length + f.contract.createdRequests.length,
      0
    );
  });
}

for (const failureCode of [
  'ORDER_SUBMISSION_FAILED',
  'HEDGE_RESIDUAL_NOT_TRADABLE'
] as const) {
  test(`uses persisted definite GTC failure ${failureCode}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '0.6',
      contractRemaining: '0.4',
      contractAverage: '60010'
    });
    const gtc = planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');
    assert.equal(
      f.repository.markDefinitelyNotSubmitted(gtc.id, failureCode),
      true
    );
    scriptFind(f, gtc, null);

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'written',
      state: 'HEDGE_INCOMPLETE',
      failureCode
    });
    assert.equal(
      f.repository.getStrategy(f.strategyId).failureCode,
      failureCode
    );
    assert.equal(f.contract.createdRequests.length, 0);
  });
}
```

其余 GTC 畸形、unknown、双 GTC 和 `WAITING_HEDGE` 重跑使用以下测试：

```ts
interface InvalidGtcCase {
  readonly name: string;
  readonly role: 'SPOT_HEDGE_GTC' | 'CONTRACT_HEDGE_GTC';
  readonly quantity: string;
  readonly contractFill?: string;
  readonly contractRemaining?: string;
  readonly snapshot: Readonly<Pick<
    OrderSnapshot,
    'status' | 'filledBaseQuantity' | 'remainingBaseQuantity'
  >>;
}

const INVALID_GTC_CASES = [
  {
    name: 'wrong role',
    role: 'SPOT_HEDGE_GTC',
    quantity: '0.4',
    snapshot: { status: 'open', filledBaseQuantity: '0', remainingBaseQuantity: '0.4' }
  },
  {
    name: 'request differs from pre-GTC residual',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.5',
    snapshot: { status: 'open', filledBaseQuantity: '0', remainingBaseQuantity: '0.5' }
  },
  {
    name: 'remaining differs from current residual',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.4',
    contractFill: '0.5',
    contractRemaining: '0.5',
    snapshot: { status: 'open', filledBaseQuantity: '0.1', remainingBaseQuantity: '0.3' }
  },
  {
    name: 'fill crosses the original market residual',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.5',
    snapshot: { status: 'closed', filledBaseQuantity: '0.5', remainingBaseQuantity: '0' }
  },
  {
    name: 'open has zero remaining',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.4',
    snapshot: { status: 'open', filledBaseQuantity: '0.4', remainingBaseQuantity: '0' }
  },
  {
    name: 'closed is not fully filled',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.4',
    snapshot: { status: 'closed', filledBaseQuantity: '0.1', remainingBaseQuantity: '0.3' }
  },
  {
    name: 'rejected has a positive fill',
    role: 'CONTRACT_HEDGE_GTC',
    quantity: '0.4',
    snapshot: { status: 'rejected', filledBaseQuantity: '0.1', remainingBaseQuantity: '0.3' }
  }
] as const satisfies readonly InvalidGtcCase[];

for (const testCase of INVALID_GTC_CASES) {
  test(`writes the unique failure for invalid GTC: ${testCase.name}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: testCase.contractFill ?? '0.6',
      contractRemaining: testCase.contractRemaining ?? '0.4',
      contractAverage: '60010'
    });
    const gtc = planOrder(f, testCase.role, testCase.quantity);
    scriptFind(f, gtc, snapshotForOrder(gtc, {
      ...testCase.snapshot,
      averagePrice: testCase.snapshot.filledBaseQuantity === '0'
        ? null
        : '60000'
    }));

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'written',
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'INCONSISTENT_ORDER_STATE'
    });
    assert.equal(f.contract.createdRequests.length, 0);
    assert.equal(f.spot.createdRequests.length, 0);
  });
}

test('keeps an unknown GTC pending', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  seedClosedConcurrentMarkets(f, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });
  const gtc = planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');
  scriptFind(f, gtc, snapshotForOrder(gtc, {
    status: 'unknown',
    filledBaseQuantity: '0',
    remainingBaseQuantity: '0.4',
    averagePrice: null
  }));

  const result = await f.reconciliation.run(f.strategyId);

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'GTC_STATUS_UNKNOWN');
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
});

test('rejects two GTC roles before any lookup', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  planOrder(f, 'SPOT_MARKET');
  planOrder(f, 'CONTRACT_MARKET');
  planOrder(f, 'SPOT_HEDGE_GTC', '0.4');
  planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');

  const result = await f.reconciliation.run(f.strategyId);

  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'INVALID_LOCAL_TOPOLOGY');
  assertNoGatewayCalls(f);
});

test('returns waiting_gtc without a WAITING_HEDGE self-transition', async (t) => {
  const f = decisionFixture(t, 'CONCURRENT');
  seedClosedConcurrentMarkets(f, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });
  const gtc = planOrder(f, 'CONTRACT_HEDGE_GTC', '0.4');
  scriptFind(f, gtc, snapshotForOrder(gtc, {
    status: 'open',
    filledBaseQuantity: '0.1',
    remainingBaseQuantity: '0.3'
  }));
  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'written',
    state: 'WAITING_HEDGE'
  });

  const persistedOrders = f.repository.listOrders(f.strategyId);
  for (const order of persistedOrders) {
    const exchangeOrderId = order.exchangeOrderId;
    const snapshot = order.snapshot;
    assert.ok(exchangeOrderId);
    assert.ok(snapshot);
    gatewayFor(f, order).scriptedFetch.set(exchangeOrderId, [
      { ...snapshot, updatedAt: '2026-09-05T00:03:00.000Z' }
    ]);
  }
  let transitions = 0;
  const originalTransition = f.repository.transition.bind(f.repository);
  Reflect.set(f.repository, 'transition', (...args: Parameters<
    StrategyRepository['transition']
  >) => {
    transitions += 1;
    return originalTransition(...args);
  });

  assert.deepEqual(await f.reconciliation.run(f.strategyId), {
    kind: 'waiting_gtc'
  });
  assert.equal(transitions, 0);
  assert.equal(f.repository.getStrategy(f.strategyId).state, 'WAITING_HEDGE');
});
```

可交易性使用以下边界表，每行都断言 `createOrder` 为 0：

```ts
const TRADABILITY_CASES = [
  ['below step', '0.002', { amountStep: '1', contractSize: '0.003' }],
  ['not a whole contract', '0.0045', { amountStep: '0.5', contractSize: '0.003' }],
  ['below minimum', '0.004', { minBaseAmount: '0.005' }],
  ['above maximum', '1.1', { maxBaseAmount: '1' }],
  ['below notional', '0.01', { minQuoteNotional: '10' }, '900'],
  ['above notional', '2', { maxQuoteNotional: '100' }, '60']
] as const;

for (const [name, residual, overrides, referencePrice = '60000']
  of TRADABILITY_CASES) {
  test(`does not round an untradable residual: ${name}`, async (t) => {
    const f = decisionFixture(
      t,
      'CONCURRENT',
      undefined,
      residual
    );
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      ...overrides
    });
    seedClosedConcurrentMarkets(f, {
      requested: residual,
      spotFill: residual,
      spotRemaining: '0',
      spotAverage: referencePrice,
      contractFill: '0',
      contractRemaining: residual,
      contractAverage: null
    });

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'written',
      state: 'HEDGE_INCOMPLETE',
      failureCode: 'HEDGE_RESIDUAL_NOT_TRADABLE'
    });
    assert.equal(f.contract.createdRequests.length, 0);
  });
}

const TRADABILITY_BOUNDARIES = [
  ['step', '0.003', { amountStep: '1', contractSize: '0.003' }, '60000'],
  ['minimum', '0.005', { minBaseAmount: '0.005' }, '60000'],
  ['maximum', '1', { maxBaseAmount: '1' }, '60000'],
  ['minimum notional', '0.01', { minQuoteNotional: '10' }, '1000'],
  ['maximum notional', '1', { maxQuoteNotional: '100' }, '100']
] as const;

for (const [name, residual, overrides, referencePrice]
  of TRADABILITY_BOUNDARIES) {
  test(`authorizes a residual exactly on the ${name} boundary`, async (t) => {
    const f = decisionFixture(
      t,
      'CONCURRENT',
      undefined,
      residual
    );
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      ...overrides
    });
    seedClosedConcurrentMarkets(f, {
      requested: residual,
      spotFill: residual,
      spotRemaining: '0',
      spotAverage: referencePrice,
      contractFill: '0',
      contractRemaining: residual,
      contractAverage: null
    });

    assert.deepEqual(await f.reconciliation.run(f.strategyId), {
      kind: 'need_gtc',
      role: 'CONTRACT_HEDGE_GTC',
      baseQuantity: residual,
      referencePrice
    });
    assert.equal(f.contract.createdRequests.length, 0);
  });
}
```

市场资料与价格量化不可靠的分支使用以下表驱动测试；精确上下文资源上限由 Step 1 的极端指数用例覆盖：

```ts
for (const [name, mutate] of [
  ['load failure', (f: DecisionFixture) => {
    f.contract.markets.clear();
  }],
  ['inactive market', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, { ...market, active: false });
  }],
  ['market identity mismatch', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      exchangeId: 'bitget'
    });
  }],
  ['invalid rule number', (f: DecisionFixture) => {
    const market = f.contract.markets.get(`swap:${SYMBOL}`);
    assert.ok(market);
    f.contract.markets.set(`swap:${SYMBOL}`, {
      ...market,
      amountStep: 'not-a-decimal'
    });
  }]
] as const) {
  test(`keeps uncertain market rules pending: ${name}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    mutate(f);
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '0.6',
      contractRemaining: '0.4',
      contractAverage: '60010'
    });

    const result = await f.reconciliation.run(f.strategyId);

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'MARKET_RULES_UNAVAILABLE');
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assert.equal(f.contract.createdRequests.length, 0);
  });
}

for (const [name, mutate] of [
  ['quantize failure', (f: DecisionFixture) => {
    Reflect.set(f.contract, 'quantizePrice', async () => {
      throw new Error('private quantize detail');
    });
  }],
  ['non-positive candidate', (f: DecisionFixture) => {
    f.contract.quantizedPrices.set(`swap:${SYMBOL}`, '0');
  }],
  ['off-step candidate', (f: DecisionFixture) => {
    f.contract.quantizedPrices.set(`swap:${SYMBOL}`, '60000.05');
  }]
] as const) {
  test(`keeps uncertain candidate price pending: ${name}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    mutate(f);
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: '60000',
      contractFill: '0.6',
      contractRemaining: '0.4',
      contractAverage: '60010'
    });

    const result = await f.reconciliation.run(f.strategyId);

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'PRICE_QUANTIZATION_FAILED');
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
    assert.equal(f.contract.createdRequests.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private quantize detail/);
  });
}
```

CAS 竞争使用真实仓储并只替换当前实例的 `transition`：

```ts
for (const [behavior, expected, persistedState] of [
  ['false unchanged', 'pending', 'EXECUTING'],
  ['false after target write', 'observed', 'HEDGED'],
  ['throw after target write', 'observed', 'HEDGED'],
  ['throw after other write', 'pending', 'FAILED']
] as const) {
  test(`never fabricates written when transition ${behavior}`, async (t) => {
    const f = decisionFixture(t, 'CONCURRENT');
    seedClosedConcurrentMarkets(f, {
      requested: '1',
      spotFill: '1',
      spotRemaining: '0',
      spotAverage: null,
      contractFill: '1',
      contractRemaining: '0',
      contractAverage: null
    });
    const original = f.repository.transition.bind(f.repository);
    Reflect.set(f.repository, 'transition', (...args: Parameters<
      StrategyRepository['transition']
    >): boolean => {
      if (behavior === 'false unchanged') return false;
      if (behavior === 'throw after other write') {
        assert.equal(original(
          f.strategyId,
          ['EXECUTING'],
          'FAILED',
          'ORDER_SUBMISSION_FAILED'
        ), true);
        throw new Error('private competing write detail');
      }
      assert.equal(original(...args), true);
      if (behavior === 'false after target write') return false;
      throw new Error('private post-commit detail');
    });

    const result = await f.reconciliation.run(f.strategyId);

    if (expected === 'observed') {
      assert.deepEqual(result, {
        kind: 'observed_state',
        state: 'HEDGED'
      });
    } else {
      assert.equal(result.kind, 'pending');
      assert.equal(result.reason, 'STATE_WRITE_CONFLICT');
      assert.notEqual(result.kind, 'written');
    }
    assert.equal(
      f.repository.getStrategy(f.strategyId).state,
      persistedState
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /private competing write detail|private post-commit detail/
    );
    assert.equal(
      f.spot.createdRequests.length + f.contract.createdRequests.length,
      0
    );
  });
}
```

用以下捕获型 `OperationalLog` 锁定 pending 去重和结论事件：

```ts
interface CapturedReconciliationOperation {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: Readonly<OperationalFields> | undefined;
}

function captureReconciliationOperations(
  entries: CapturedReconciliationOperation[]
): OperationalLog {
  return {
    info: (event, fields) => entries.push({ level: 'info', event, fields }),
    warn: (event, fields) => entries.push({ level: 'warn', event, fields }),
    error(): void {},
    fatal(): void {}
  };
}

test('deduplicates one pending revision and logs a changed reason', async (t) => {
  const entries: CapturedReconciliationOperation[] = [];
  const f = decisionFixture(
    t,
    'CONTRACT_FIRST',
    captureReconciliationOperations(entries)
  );
  const order = planOrder(f, 'CONTRACT_MARKET');
  f.contract.scriptedFind.set(order.clientOrderId, [
    null,
    null,
    new Error('private lookup detail')
  ]);

  assert.equal((await f.reconciliation.run(f.strategyId)).kind, 'pending');
  assert.equal((await f.reconciliation.run(f.strategyId)).kind, 'pending');
  assert.equal(
    entries.filter(({ level }) => level === 'warn').length,
    1
  );
  const changed = await f.reconciliation.run(f.strategyId);
  assert.equal(changed.kind, 'pending');
  assert.equal(changed.reason, 'ORDER_LOOKUP_FAILED');
  assert.deepEqual(
    entries.filter(({ level }) => level === 'warn')
      .map(({ fields }) => fields?.reason),
    ['SUBMISSION_UNCERTAIN', 'ORDER_LOOKUP_FAILED']
  );

  scriptFind(f, order, snapshotForOrder(order, {
    status: 'open',
    filledBaseQuantity: '0',
    remainingBaseQuantity: '1',
    averagePrice: null,
    updatedAt: '2026-09-05T00:02:00.000Z'
  }));
  const firstActive = await f.reconciliation.run(f.strategyId);
  assert.equal(firstActive.kind, 'pending');
  assert.equal(firstActive.reason, 'MARKET_ORDER_ACTIVE');
  const persisted = f.repository.listOrders(f.strategyId)[0];
  assert.ok(persisted?.exchangeOrderId);
  f.contract.scriptedFetch.set(persisted.exchangeOrderId, [
    snapshotForOrder(persisted, {
      status: 'open',
      filledBaseQuantity: '0.1',
      remainingBaseQuantity: '0.9',
      averagePrice: '60000',
      updatedAt: '2026-09-05T00:03:00.000Z'
    })
  ]);
  const revisedActive = await f.reconciliation.run(f.strategyId);
  assert.equal(revisedActive.kind, 'pending');
  assert.equal(revisedActive.reason, 'MARKET_ORDER_ACTIVE');
  assert.deepEqual(
    entries.filter(({ level }) => level === 'warn')
      .map(({ fields }) => fields?.reason),
    [
      'SUBMISSION_UNCERTAIN',
      'ORDER_LOOKUP_FAILED',
      'MARKET_ORDER_ACTIVE',
      'MARKET_ORDER_ACTIVE'
    ]
  );
  assert.doesNotMatch(JSON.stringify(entries), /private lookup detail/);
});

test('logs written, observed terminal, and need_gtc conclusions', async (t) => {
  const terminalEntries: CapturedReconciliationOperation[] = [];
  const terminal = decisionFixture(
    t,
    'CONCURRENT',
    captureReconciliationOperations(terminalEntries)
  );
  seedClosedConcurrentMarkets(terminal, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: null,
    contractFill: '1',
    contractRemaining: '0',
    contractAverage: null
  });
  assert.deepEqual(await terminal.reconciliation.run(terminal.strategyId), {
    kind: 'written',
    state: 'HEDGED'
  });
  assert.deepEqual(await terminal.reconciliation.run(terminal.strategyId), {
    kind: 'observed_state',
    state: 'HEDGED'
  });
  assert.equal(
    terminalEntries.filter(
      ({ event }) => event === 'hedge_reconciliation_conclusion'
    ).length,
    2
  );

  const gtcEntries: CapturedReconciliationOperation[] = [];
  const gtc = decisionFixture(
    t,
    'CONCURRENT',
    captureReconciliationOperations(gtcEntries)
  );
  seedClosedConcurrentMarkets(gtc, {
    requested: '1',
    spotFill: '1',
    spotRemaining: '0',
    spotAverage: '60000',
    contractFill: '0.6',
    contractRemaining: '0.4',
    contractAverage: '60010'
  });
  assert.equal((await gtc.reconciliation.run(gtc.strategyId)).kind, 'need_gtc');
  const fields = gtcEntries.find(
    ({ event }) => event === 'hedge_reconciliation_conclusion'
  )?.fields;
  assert.equal(fields?.marketSpot, '1');
  assert.equal(fields?.marketContract, '0.6');
  assert.equal(fields?.preGtcResidual, '0.4');
  assert.equal(fields?.currentResidual, '0.4');
});

for (const [name, operationalLog] of [
  ['sync throw', {
    info(): never { throw new Error('sync log failure'); },
    warn(): never { throw new Error('sync log failure'); },
    error(): void {},
    fatal(): void {}
  }],
  ['async rejection', {
    info: () => Promise.reject(new Error('async log failure')),
    warn: () => Promise.reject(new Error('async log failure')),
    error(): void {},
    fatal(): void {}
  } as unknown as OperationalLog]
] as const) {
  test(`logging cannot change reconciliation: ${name}`, async (t) => {
    const f = decisionFixture(t, 'CONTRACT_FIRST', operationalLog);
    const order = planOrder(f, 'CONTRACT_MARKET');
    scriptFind(f, order, null);

    const result = await f.reconciliation.run(f.strategyId);

    assert.equal(result.kind, 'pending');
    assert.equal(result.reason, 'SUBMISSION_UNCERTAIN');
    assert.equal(f.repository.getStrategy(f.strategyId).state, 'EXECUTING');
  });
}
```

- [x] **Step 3: 运行新模块测试并确认缺少公共合同**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/strategy/hedge-reconciliation.test.js
```

Expected: FAIL；`hedge-reconciliation.js` 或 `HedgeReconciliation` 尚不存在。

- [x] **Step 4: 建立公共判别联合与可编译失败封闭骨架**

公共类型严格采用“接口锁定”代码。`ReconciliationDiagnostic` 定义为：

```ts
export interface ReconciliationDiagnostic {
  readonly strategyState: 'EXECUTING' | 'WAITING_HEDGE';
  readonly exposureKnown: boolean;
  readonly strategyOrderId?: string;
  readonly clientOrderId?: string;
  readonly exchangeId?: string;
  readonly expected?: string;
  readonly actual?: string;
}
```

构造器固定为：

```ts
constructor(
  private readonly registry: ExchangeRegistry,
  private readonly repository: StrategyRepository,
  tradeEvents: TradeEventSink = NOOP_TRADE_EVENT_SINK,
  operationalLog?: OperationalLog
) {
  this.evidence = new HedgeOrderEvidenceCollector(
    registry,
    repository,
    tradeEvents
  );
  this.operationalLog = nonThrowingOperationalLog(operationalLog);
}
```

先让 `run` 只处理入口合同，其余合法入口固定返回 pending：

```ts
function terminalStrategyState(state: StrategyState): boolean {
  return state === 'HEDGED'
    || state === 'HEDGE_INCOMPLETE'
    || state === 'FAILED';
}

async run(strategyId: string): Promise<ReconciliationResult> {
  const entered = this.repository.getStrategy(strategyId);
  if (terminalStrategyState(entered.state)) {
    return { kind: 'observed_state', state: entered.state };
  }
  if (entered.state !== 'EXECUTING' && entered.state !== 'WAITING_HEDGE') {
    throw new Error(
      'hedge reconciliation requires an executing or waiting strategy'
    );
  }
  return {
    kind: 'pending',
    reason: 'INVALID_LOCAL_TOPOLOGY',
    strategyState: entered.state,
    exposureKnown: false
  };
}
```

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test --test-name-pattern='sequential|concurrent|GTC|residual|transition|tradable|boundary' dist/tests/strategy/hedge-reconciliation.test.js
```

Expected: FAIL；模块和 fixture 已成功编译，但市价/GTC 结果、精确 `0.4`、交易边界和 CAS 断言分别收到固定 pending 而失败。不能接受导入、类型或测试数据校验错误作为本轮红灯。

- [x] **Step 5: 实现入口顺序、证据重读与 pending 去重**

`run` 的固定骨架必须保持以下顺序：

```ts
async run(strategyId: string): Promise<ReconciliationResult> {
  const entered = this.repository.getStrategy(strategyId);
  if (terminalStrategyState(entered.state)) {
    return { kind: 'observed_state', state: entered.state };
  }
  if (entered.state !== 'EXECUTING' && entered.state !== 'WAITING_HEDGE') {
    throw new Error('hedge reconciliation requires an executing or waiting strategy');
  }

  const initialOrders = this.repository.listOrders(strategyId);
  const topology = inspectLocalTopology(entered, initialOrders);
  if (topology.kind === 'empty') {
    return entered.state === 'EXECUTING'
      ? { kind: 'awaiting_market_submission' }
      : this.pending(entered, initialOrders, {
          kind: 'pending',
          reason: 'INVALID_LOCAL_TOPOLOGY',
          exposureKnown: false
        });
  }
  if (topology.kind === 'pending') {
    return this.pending(entered, initialOrders, topology);
  }

  const evidence = await this.evidence.collect(entered, topology.orders);
  if (evidence.kind === 'pending') {
    return this.pending(entered, this.repository.listOrders(strategyId), evidence);
  }

  const current = this.repository.getStrategy(strategyId);
  if (current.state !== entered.state) {
    return { kind: 'observed_state', state: current.state };
  }
  const orders = this.repository.listOrders(strategyId);
  if (!sameOrderRevisions(evidence.orders, orders)) {
    return this.pending(entered, orders, {
      kind: 'pending',
      reason: 'ORDER_EVIDENCE_MISMATCH',
      exposureKnown: hasPositiveFill(orders),
      expected: orderRevision(evidence.orders),
      actual: orderRevision(orders)
    });
  }
  return this.decideAndApply(entered, orders);
}
```

`sameOrderRevisions` 逐项比较 `id/status/updatedAt/submissionDisposition/submissionFailureCode/snapshot`，并拒绝数量、顺序或 ID 集合变化。`terminalStrategyState` 只接受 `HEDGED/HEDGE_INCOMPLETE/FAILED`，不能把 `WAITING_HEDGE` 当成终态。

pending warning key 固定为 `strategyId|reason|strategyOrderId-or-empty|sorted-order-id:updatedAt`。相同 key 只记一次 `hedge_reconciliation_pending`；原因或订单修订变化后再记。字段只来自 `OperationalFields` allowlist。

每次 CAS 成功写终态或 `WAITING_HEDGE`、首次读取或 CAS 重读得到终态 `observed_state`，以及每次返回 `need_gtc`，还要用 `OperationalLog.info('hedge_reconciliation_conclusion', fields)` 记录进入状态、结论、失败码或角色，以及当时可得的两侧成交、补单前残差、当前残差和 `exposureKnown`。首次入口已经是终态时不得查所；此时未知的成交与残差字段省略，不能伪造零值。日志失败由 Task 3 包装吸收，不能改变返回结果。

- [x] **Step 6: 实现私有精确小数上下文和两种残差**

在模块内创建私有基础构造器，不能导出：

```ts
const MAX_RECONCILIATION_PRECISION = 1_000_000;
const RECONCILIATION_MIN_EXPONENT = -9_000_000_000_000_000;
const RECONCILIATION_MAX_EXPONENT = 9_000_000_000_000_000;
const MAX_CANONICAL_DECIMAL_CHARACTERS = 1_000_000n;
const ReconciliationDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_DOWN,
  minE: RECONCILIATION_MIN_EXPONENT,
  maxE: RECONCILIATION_MAX_EXPONENT,
  toExpNeg: -7,
  toExpPos: 21
});
```

先解析全部输入，再分别计算操作预算，最终 clone precision 取所有预算的最大值：加减预算为“最高指数减最低有效指数，加操作数数量的十进制进位位数，再加 4”；乘法预算为两个操作数 `sd()` 之和加 4；取模/整除预算还要包含非负的商整数位数 `left.e - right.e + 1`、双方 `sd()` 之和与 4 个安全位。任一预算不是安全整数、超过上限，或运算结果非有限时返回 `EXACT_ARITHMETIC_UNAVAILABLE`。不能只用加减跨度预算执行 `amountStep * contractSize` 或 `residual * price`。用对应预算创建的私有 clone 计算：

```ts
function additivePrecision(values: readonly Decimal[]): number {
  const highest = Math.max(...values.map((value) => value.e));
  const lowest = Math.min(...values.map(
    (value) => value.e - value.sd() + 1
  ));
  return highest - lowest + Math.ceil(Math.log10(values.length + 1)) + 4;
}

function productPrecision(left: Decimal, right: Decimal): number {
  return left.sd() + right.sd() + 4;
}

function moduloPrecision(left: Decimal, right: Decimal): number {
  const quotientIntegerDigits = Math.max(1, left.e - right.e + 1);
  return quotientIntegerDigits + left.sd() + right.sd() + 4;
}
```

precision 预算通过不代表十进制展开安全。任何 `toFixed()` 之前必须先用 exponent 和有效位数计算规范字符串宽度，计算过程使用 `BigInt`，不能先创建目标字符串：

```ts
function canonicalDecimalWidth(value: Decimal): bigint {
  if (value.isZero()) return 1n;
  const signWidth = value.isNegative() ? 1n : 0n;
  const exponent = BigInt(value.e);
  const significantDigits = BigInt(value.sd());
  if (exponent >= 0n) {
    const integerDigits = exponent + 1n;
    const fractionalDigits = significantDigits > integerDigits
      ? significantDigits - integerDigits
      : 0n;
    return signWidth + integerDigits
      + (fractionalDigits === 0n ? 0n : 1n + fractionalDigits);
  }
  return signWidth + 2n + (-exponent - 1n) + significantDigits;
}

function canonicalDecimal(value: Decimal): string | undefined {
  if (canonicalDecimalWidth(value) > MAX_CANONICAL_DECIMAL_CHARACTERS) {
    return undefined;
  }
  return value.toFixed();
}
```

`value.e` 和 `value.sd()` 在转成 `BigInt` 前也必须是安全整数。任何待输出数量、价格或诊断数值超过宽度上限都返回 `EXACT_ARITHMETIC_UNAVAILABLE`，其安全诊断固定为 `expected: 'canonical decimal at most 1000000 characters'` 与 `actual: 'canonical decimal exceeds resource limit'`；不得把指数形式写入要求规范化十进制字符串的结果，也不得把超限值送入测试辅助函数的扩大字符串或 `BigInt` 转换。

```ts
marketDelta = marketSpot.minus(marketContract);
preGtcResidual = marketDelta.abs();
totalSpot = marketSpot.plus(spotGtcFilled);
totalContract = marketContract.plus(contractGtcFilled);
currentResidual = totalSpot.minus(totalContract).abs();
```

所有对外数量必须通过受限的 `canonicalDecimal()` 使用 `toFixed()` 规范化。GTC 请求量只比较 `preGtcResidual`；GTC remaining 只比较 `currentResidual`；GTC 成交后 `totalSpot - totalContract` 的符号不能穿越原始 `marketDelta`。

- [x] **Step 7: 实现无 GTC 与已有 GTC 的互斥决策表**

决策顺序固定如下，前一项命中后立即返回：

1. 任一市价单 `open/unknown` -> `MARKET_ORDER_ACTIVE`。
2. 任一尚未形成“有效快照或 definite-null”的订单 -> 对应证据 pending。
3. 计算精确金额；已有 GTC 为 `unknown` 时固定返回 `GTC_STATUS_UNKNOWN`，即使精确金额超过资源限制，也优先于市价 rejected/definite 和后续 GTC 结构校验。
4. 市价 rejected/definite 分支；并发一侧正成交、另一侧零拒单固定写 `HEDGE_INCOMPLETE / INCONSISTENT_ORDER_STATE`。
5. 有 GTC 时按市场残差和角色方向校验请求、成交、剩余、穿越和状态；GTC rejected 零成交与 definite-null 保留其确定性结论，不降级为未知。
6. 无 GTC 时按顺序/并发表处理双零、等量、缺均价、正残差。

状态写统一经过一个方法：

```ts
private transition(
  entered: Readonly<StrategyRecord>,
  state: 'HEDGED' | 'WAITING_HEDGE'
): ReconciliationResult;
private transition(
  entered: Readonly<StrategyRecord>,
  state: 'FAILED' | 'HEDGE_INCOMPLETE',
  failureCode: StrategyFailureCode
): ReconciliationResult;
```

只有 repository CAS 返回 `true` 才返回 `written`。false 或 throw 后重读：恰好已是目标状态且 failure code 相同才返回 `observed_state`；仍是进入状态或变成其他状态返回 `pending / STATE_WRITE_CONFLICT`。`WAITING_HEDGE + open GTC` 直接返回 `waiting_gtc`，不能调用仓储自转换。

- [x] **Step 8: 实现 need_gtc 前的精确可交易性验证**

目标 gateway 由角色决定；依次 `loadMarket`、验证 exchange/symbol/kind/active 与规则字段、用大侧均价 `quantizePrice`、验证正候选价且精确对齐 `priceStep`。市场身份、active 或规则失败返回 `MARKET_RULES_UNAVAILABLE`；价格调用失败、非正或不对齐返回 `PRICE_QUANTIZATION_FAILED`。

在同一私有 Decimal clone 中验证：

```ts
const baseStep = amountStep.mul(contractSize);
const stepAligned = residual.mod(baseStep).isZero();
const wholeContracts = kind === 'spot'
  || residual.mod(contractSize).isZero();
const priceAligned = candidatePrice.mod(priceStep).isZero();
const withinBaseRange = residual.gte(minBaseAmount)
  && (maxBaseAmount === undefined || residual.lte(maxBaseAmount));
const notional = residual.mul(candidatePrice);
const withinNotionalRange = (
  minQuoteNotional === undefined || notional.gte(minQuoteNotional)
) && (
  maxQuoteNotional === undefined || notional.lte(maxQuoteNotional)
);
```

`stepAligned`、`wholeContracts`、`priceAligned`、`withinBaseRange` 和 `withinNotionalRange` 都为 true 才返回 `need_gtc`。数量、合约张数或名义金额明确为 false 且有正暴露时 CAS 写 `HEDGE_INCOMPLETE / HEDGE_RESIDUAL_NOT_TRADABLE`；价格不对齐按上段归为 `PRICE_QUANTIZATION_FAILED`。解析、资源上限或市场数据不能可靠判定时返回 `EXACT_ARITHMETIC_UNAVAILABLE`，不能归类为不可交易。

- [x] **Step 9: 跑完整对账矩阵并提交**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/strategy/hedge-reconciliation.test.js
```

Expected: PASS；退出码 `0`。测试至少包含规格第 11.1 到 11.5 节每个项目，并确认 `HedgeReconciliation` 的 gateway 从未调用 `createOrder`、余额、账户设置或改账户方法。

```bash
git add src/strategy/hedge-reconciliation-evidence.ts src/strategy/hedge-reconciliation.ts tests/strategy/hedge-reconciliation.test.ts
git commit -m "feat: reconcile hedge orders before state changes"
```

---

### Task 6: 让协调器只消费当次对账授权并持久化提交事实

**Files:**
- Modify: `src/exchanges/exchange-gateway.ts:11-38`
- Modify: `src/exchanges/ccxt-exchange-gateway.ts:550-596, 857-968`
- Modify: `src/strategy/hedge-coordinator.ts:1-240, 356-530, 597-837, 881-1520`
- Modify: `src/main.ts:285-314`
- Modify: `tests/exchanges/exchange-gateway.test.ts`
- Modify: `tests/exchanges/ccxt-gateway.test.ts`
- Modify: `tests/strategy/hedge-coordinator.test.ts`
- Modify: `tests/strategy/order-monitor.test.ts`
- Modify: `tests/http/server.test.ts:1580-1630, 1690-1740`

**Interfaces:**
- Consumes: `ReconciliationRunner.run`、`ReconciliationResult`、`markDefinitelyNotSubmitted`、`NoOrderSubmittedError.reason`、现有 request builders、原子并发订单规划和 operation lock。
- Produces: 新构造器 `HedgeCoordinator(registry, repository, reconciliation, tradeEvents?, operationalLog?)`；协调器不再 attach 查所快照或写四种受控状态。

- [x] **Step 1: 用 scripted runner 写授权与禁止副作用的红测试**

在 `tests/strategy/hedge-coordinator.test.ts` 扩展 import：

```ts
import type {
  OperationalFields,
  OperationalLog
} from '../../src/logging/logger.js';
import type { StrategyState } from '../../src/domain/types.js';
import type {
  OrderSubmissionFailureCode,
  StrategyFailureCode,
  StrategyOrderPlan,
  StrategyOrderRecord,
  StrategyRecord
} from '../../src/storage/strategy-repository.js';
import {
  HedgeReconciliation,
  type ReconciliationResult,
  type ReconciliationRunner
} from '../../src/strategy/hedge-reconciliation.js';
```

用可观察的真实 SQLite repository 替换 fixture 中的 repository，并加入 scripted runner 与日志捕获器：

```ts
interface TransitionCall {
  readonly strategyId: string;
  readonly from: readonly StrategyState[];
  readonly to: StrategyState;
  readonly failureCode?: StrategyFailureCode;
}

class CoordinatorRepository extends SqliteStrategyRepository {
  atomicPlanCalls = 0;
  readonly transitionCalls: TransitionCall[] = [];
  readonly evidenceCalls: Array<{
    orderId: string;
    failureCode: OrderSubmissionFailureCode;
  }> = [];
  evidenceWriteBehavior: 'delegate' | 'false' | 'throw' = 'delegate';

  override planOrdersAtomically(
    strategyId: string,
    plans: readonly Readonly<StrategyOrderPlan>[]
  ): StrategyOrderRecord[] {
    this.atomicPlanCalls += 1;
    return super.planOrdersAtomically(strategyId, plans);
  }

  override markDefinitelyNotSubmitted(
    orderId: string,
    failureCode: OrderSubmissionFailureCode
  ): boolean {
    this.evidenceCalls.push({ orderId, failureCode });
    if (this.evidenceWriteBehavior === 'throw') {
      throw new Error('private sqlite detail that must not escape');
    }
    if (this.evidenceWriteBehavior === 'false') return false;
    return super.markDefinitelyNotSubmitted(orderId, failureCode);
  }

  override transition(
    strategyId: string,
    from: StrategyState[],
    to: StrategyState,
    failureCode?: StrategyFailureCode
  ): boolean {
    this.transitionCalls.push({
      strategyId,
      from: [...from],
      to,
      ...(failureCode === undefined ? {} : { failureCode })
    });
    return super.transition(strategyId, from, to, failureCode);
  }
}

class ScriptedReconciliation implements ReconciliationRunner {
  readonly calls: string[] = [];

  constructor(private readonly results: ReconciliationResult[]) {}

  async run(strategyId: string): Promise<ReconciliationResult> {
    this.calls.push(strategyId);
    const result = this.results.shift();
    assert.ok(result, 'unexpected reconciliation call');
    return result;
  }
}

class CapturingOperationalLog implements OperationalLog {
  readonly warnings: Array<{
    event: string;
    fields: Readonly<OperationalFields> | undefined;
  }> = [];

  info(): void {}

  warn(event: string, fields?: Readonly<OperationalFields>): void {
    this.warnings.push({ event, fields });
  }

  error(): void {}

  fatal(): void {}
}

function scriptedPending(
  reason: 'ORDER_LOOKUP_FAILED' | 'SUBMISSION_UNCERTAIN' =
    'ORDER_LOOKUP_FAILED'
): ReconciliationResult {
  return {
    kind: 'pending',
    reason,
    strategyState: 'EXECUTING',
    exposureKnown: false
  };
}
```

把现有 `SetupResult` 和 `setup` 替换为下面的版本；未显式传 runner 的旧测试走真实对账器：

```ts
interface SetupResult {
  readonly database: Database.Database;
  readonly repository: CoordinatorRepository;
  readonly registry: ExchangeRegistry;
  readonly spot: TrackingGateway;
  readonly contract: TrackingGateway;
  readonly reconciliation: ReconciliationRunner;
  readonly coordinator: HedgeCoordinator;
  readonly strategyId: string;
  readonly tradeEvents: TradeEvent[];
  readonly tradeEventSink: TradeEventSink;
}

function setup(
  t: TestContext,
  mode: ExecutionMode,
  options: {
    spot?: TrackingGateway;
    contract?: TrackingGateway;
    preflight?: Partial<PreflightResult>;
    tradeEvents?: TradeEventSink;
    reconciliation?: ReconciliationRunner;
    operationalLog?: OperationalLog;
  } = {}
): SetupResult {
  const database = new Database(':memory:');
  t.after(() => database.close());
  const repository = new CoordinatorRepository(database);
  const spot = options.spot ?? new TrackingGateway('bitget');
  const contract = options.contract ?? new TrackingGateway('okx');
  const registry = new ExchangeRegistry(new Map([
    ['bitget', spot],
    ['okx', contract]
  ]));
  const preview = preflight(mode, options.preflight);
  spot.markets.set(`spot:${preview.symbol}`, preview.spotMarket);
  contract.markets.set(`swap:${preview.symbol}`, preview.contractMarket);
  contract.accountSettings = { ...preview.accountSettings };
  const strategyId = repository.createPending(preview).id;
  const tradeEvents: TradeEvent[] = [];
  const tradeEventSink = options.tradeEvents ?? {
    record(event: Readonly<TradeEvent>): void {
      tradeEvents.push(structuredClone(event));
    }
  };
  const reconciliation = options.reconciliation ?? new HedgeReconciliation(
    registry,
    repository,
    tradeEventSink,
    options.operationalLog
  );

  return {
    database,
    repository,
    registry,
    spot,
    contract,
    reconciliation,
    coordinator: new HedgeCoordinator(
      registry,
      repository,
      reconciliation,
      tradeEventSink,
      options.operationalLog
    ),
    strategyId,
    tradeEvents,
    tradeEventSink
  };
}

function seedConcurrentMarketEvidence(
  context: SetupResult,
  spotFill = '1',
  contractFill = '0.6'
): readonly [StrategyOrderRecord, StrategyOrderRecord] {
  assert.equal(context.repository.claimForExecution(context.strategyId), true);
  const [spotOrder, contractOrder] = context.repository.planOrdersAtomically(
    context.strategyId,
    [
      {
        role: 'SPOT_MARKET',
        request: requestFor(context.strategyId, 'SPOT_MARKET', '1')
      },
      {
        role: 'CONTRACT_MARKET',
        request: requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
      }
    ]
  );
  assert.ok(spotOrder);
  assert.ok(contractOrder);
  context.repository.attachOrderSnapshot(
    spotOrder.id,
    snapshotFor(context.strategyId, 'SPOT_MARKET', '1', {
      filledBaseQuantity: spotFill,
      remainingBaseQuantity: new Decimal('1').minus(spotFill).toString(),
      averagePrice: spotFill === '0' ? null : '60000'
    })
  );
  context.repository.attachOrderSnapshot(
    contractOrder.id,
    snapshotFor(context.strategyId, 'CONTRACT_MARKET', '1', {
      filledBaseQuantity: contractFill,
      remainingBaseQuantity: new Decimal('1').minus(contractFill).toString(),
      averagePrice: contractFill === '0' ? null : '60010'
    })
  );
  context.repository.atomicPlanCalls = 0;
  return [spotOrder, contractOrder];
}
```

在追加新测试前先迁移现有协调器测试，不能把新用例叠在仍表达旧所有权的断言上，也不能用 `skip`、`todo` 或缩小最终测试命令掩盖冲突。以测试标题为稳定锚点，逐项执行下面的清单：

| 现有测试 | 必须执行的迁移动作 |
| --- | --- |
| `coordinator never claims or submits a persisted one-way strategy` | 改名为“claims but never submits a persisted one-way strategy”。一次确认后固定断言 `EXECUTING/null`、零订单、零提交、`transitionCalls=[]`，以及一次 `hedge_submission_guard_changed`；不得继续期待停在 `PENDING_CONFIRMATION`。 |
| `fresh contract settings reject one-way, unknown, margin drift, and leverage drift before any order` | 保留参数矩阵，但每个子用例改为纯阻断：`EXECUTING/null`、一次 settings 请求、零计划/提交、`transitionCalls=[]`、一次脱敏 `hedge_submission_guard_changed`；不得写 `FAILED/INCONSISTENT_ORDER_STATE`。 |
| `fresh settings fetch uncertainty stays executing and submits only after a later valid check` | 首轮增加一次 `hedge_submission_guard_pending` 断言；第二轮只提供一个有效 settings 结果。零成交 market 经提交后对账写 `FAILED/NO_FILL`；总 settings 请求从 3 改为 2。 |
| `fresh settings drift classifies persisted exposure conservatively`、`repository uncertainty while classifying settings drift remains recoverable` | 删除这两条旧测试。账户守卫不再读取或分类已有暴露；其替代证据分别是 Task 4 的查所部分成功/本地暴露矩阵、Task 5 的唯一终态矩阵，以及本 Task 的 `runs reconciliation before any account guard in WAITING_HEDGE`。 |
| `spot-first rechecks contract settings after the spot fill and before contract create` | settings 队列改为 `[valid, drift]`。一次确认内第一次授权提交 spot market，第二次授权前漂移只留下 `EXECUTING/null` 和唯一 `SPOT_MARKET`，零 contract GTC，settings 请求 2、`transitionCalls=[]`、一次 changed warning；不得终态化。 |
| `second-leg settings fetch uncertainty recovers without stranding a planned intent` | settings 队列首轮改为 `[valid, Error]`，仍断言只有 `SPOT_MARKET`；次轮提供一个 valid 后提交唯一 GTC 并完成。总 settings 请求从 5 改为 3，失败轮不得预建 GTC。 |
| `concurrent mode rechecks settings for each new create and blocks both on drift` | 改名为“guards one concurrent market authorization before atomic planning”，只提供一个 drift 结果；断言 settings 请求 1、`atomicPlanCalls=0`、零订单/提交、`EXECUTING/null`、`transitionCalls=[]` 和一次 changed warning。守卫粒度是一次 market batch 授权，不是每个 `createOrder`。 |
| `lookup-only recovery checks fresh settings once without treating the existing role as a new create` | 改名为“runs lookup-only recovery without an account guard”；保留一次 client-ID lookup 和零提交断言，把 settings 请求从 1 改为 0，并断言没有 guard warning。 |

以下现有测试保留为跨模块纵向回归，只按新 fixture、事件所有者和 Task 7 的 monitor 构造器做机械调整，不能删除：

- `fresh market orders emit a complete persisted lifecycle in every mode`、`a derived GTC order receives its own complete lifecycle`、`recovered intents emit persisted status but no new planning or submission`、`a throwing trade sink cannot change state or duplicate submission`。
- `contract-first hedges only the actual partial fill with a quantized spot GTC`、`spot-first sends a fully persisted SHORT GTC using the confirmed isolated mode`、`sequential open market remains executing until terminal observation then hedges once`、`concurrent open markets progress asynchronously without an early GTC or terminal state`。
- `create side effect plus transient lookup error remains recoverable and never recreates`、`create timeout reconciles by stable client id and never resubmits the role`、`unknown first-leg submission not found by client id stays recoverable without retry`、`unknown hedge submission after exposure stays recoverable without retry`。
- `concurrent mode preplans both intents before racing exact equal fills`、`concurrent planning failure leaves no orphan and later creates each leg once`、`concurrent mode sends one exact contract difference at the larger spot average`、`concurrent mode sends one spot difference at the larger contract average`。
- `sequential restart reconciles an existing first role before creating only its hedge`、`sequential restart reconciles a persisted hedge without re-quantizing its price`、`concurrent restart reconciles two existing market intents without recreating either`、`concurrent restart reconciles a persisted difference without recomputing its price`。
- `a second confirmation and a failed competing claim never submit any role twice`、`an active execution owner blocks restart recovery across coordinator instances`、`pre-existing planned or snapshotted pending roles are never submitted`。

其中 derived GTC、contract-first、spot-first 和两个 concurrent difference 用例继续只调用一次 `confirmAndExecute` 就期待 market -> 当次 `need_gtc` -> GTC -> 最终 `run`；它们与下面新增的并发锁用例共同防止丢弃 market 后第二次 `run` 的返回值。

删除下列仅测试旧协调器内部查所、attach、残差或终态判定的用例；对应规则已经由 Task 4/5 的真实 `HedgeReconciliation` 矩阵拥有，不能把这些断言改成调用协调器私有 helper：

- `typed pre-submit rejection emits only a classified rejection event`、`generic create uncertainty is classified without logging its message` 和 `create snapshot attach failure remains executing for monitor recovery by client id`；由本 Task 的 no-submit/CAS/真实不确定提交测试替代。
- 从 `sequential canceled-positive market hedges the exact reliable fill` 到 `sequential hedge rejection and cancellation use safe allowlisted codes` 的连续六条测试。
- 从 `a typed no-order-submitted first leg fails without lookup or indefinite planned state` 到 `a typed no-order-submitted too-small derived difference becomes incomplete without lookup` 的连续四条测试。
- 从 `direct unknown result keeps its known fill recoverable when lookup finds nothing` 到 `direct unknown result is durable before its required lookup completes` 的连续九条测试；`createOrder` 返回值不再是持久化成交证据。
- `concurrent arithmetic is isolated from ambient Decimal precision and exponent settings`；精度污染由 Task 5 的私有 Decimal 上下文测试拥有。
- 从 `concurrent mode with two reliable zero fills fails without difference order` 到 `sequential attach failure never invokes a terminal transition` 的连续十二条测试。
- 从 `concurrent restart with only one persisted market intent never starts the missing leg` 到 `sequential restart reconciles every mode-inconsistent extra role` 的连续五条测试。

完成清单后先运行一次 `rg -n "^test\\(" tests/strategy/hedge-coordinator.test.ts` 人工核对：所有“保留/改写”标题都有对应活动测试，所有“删除”标题均已消失，且文件中没有 `.skip`、`.todo` 或 `.only`。

先用完整循环覆盖所有不授权提交的结果：

```ts
const ORCHESTRATION_CASES = [
  ['pending', scriptedPending()],
  ['written', { kind: 'written', state: 'HEDGED' }],
  ['observed', { kind: 'observed_state', state: 'HEDGED' }],
  ['waiting', { kind: 'waiting_gtc' }]
] as const satisfies readonly (readonly [string, ReconciliationResult])[];

for (const [name, result] of ORCHESTRATION_CASES) {
  test(`does not submit or transition for ${name}`, async (t) => {
    const reconciliation = new ScriptedReconciliation([result]);
    const context = setup(t, 'CONCURRENT', { reconciliation });

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.deepEqual(reconciliation.calls, [context.strategyId]);
    assert.equal(
      context.spot.createdRequests.length
        + context.contract.createdRequests.length,
      0
    );
    assert.deepEqual(context.repository.transitionCalls, []);
    assert.equal(
      context.repository.getStrategy(context.strategyId).state,
      'EXECUTING'
    );
  });
}
```

再加入本轮授权、旧授权失效和计划边界测试：

```ts
test('atomically plans and submits both concurrent market legs once', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'awaiting_market_submission' },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const context = setup(t, 'CONCURRENT', { reconciliation });
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  ));
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(context.repository.atomicPlanCalls, 1);
  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId).map(({ role }) => role),
    ['SPOT_MARKET', 'CONTRACT_MARKET']
  );
  assert.equal(
    context.repository.listOrders(context.strategyId)
      .every(({ snapshot: persistedSnapshot }) => persistedSnapshot === null),
    true
  );
  assert.deepEqual(context.spot.createdRequests, [
    requestFor(context.strategyId, 'SPOT_MARKET', '1')
  ]);
  assert.deepEqual(context.contract.createdRequests, [
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  ]);
  assert.deepEqual(context.repository.transitionCalls, []);
});

test('holds one operation lock across a bounded market-to-GTC chain', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'awaiting_market_submission' },
    {
      kind: 'need_gtc',
      role: 'SPOT_HEDGE_GTC',
      baseQuantity: '1',
      referencePrice: '60010'
    },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const contract = new DeferredCreateGateway('okx');
  t.after(() => contract.release());
  const context = setup(t, 'CONTRACT_FIRST', {
    contract,
    reconciliation
  });
  contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    { averagePrice: '60010' }
  ));
  context.spot.quantizedPrices.set('spot:BTC/USDT', '60010');
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_HEDGE_GTC',
    '1',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '1',
      averagePrice: null,
      status: 'open'
    }
  ));

  const execution = context.coordinator.confirmAndExecute(context.strategyId);
  await contract.started;
  const competing = context.coordinator.confirmAndExecute(context.strategyId);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  try {
    assert.deepEqual(reconciliation.calls, [context.strategyId]);
    assert.equal(contract.createStarts, 1);
    assert.equal(context.spot.createdRequests.length, 0);
  } finally {
    contract.release();
  }
  await Promise.all([execution, competing]);

  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId,
    context.strategyId
  ]);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId).map(({ role }) => role),
    ['CONTRACT_MARKET', 'SPOT_HEDGE_GTC']
  );
  assert.deepEqual(context.contract.createdRequests, [
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  ]);
  assert.deepEqual(context.spot.createdRequests, [
    requestFor(
      context.strategyId,
      'SPOT_HEDGE_GTC',
      '1',
      'cross',
      '60010'
    )
  ]);
  assert.equal(context.contract.accountSettingsRequests.length, 2);
  assert.deepEqual(context.repository.transitionCalls, []);
});

test('submits only the GTC authorized by the current run result', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    {
      kind: 'need_gtc',
      role: 'CONTRACT_HEDGE_GTC',
      baseQuantity: '0.4',
      referencePrice: '61234.56'
    },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const context = setup(t, 'CONCURRENT', { reconciliation });
  seedConcurrentMarketEvidence(context);
  context.contract.quantizedPrices.set('swap:BTC/USDT', '61234.5');
  context.contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_HEDGE_GTC',
    '0.4',
    {
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.4',
      averagePrice: null,
      status: 'open'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(context.contract.quantizeRequests, [{
    symbol: SYMBOL,
    kind: 'swap',
    price: '61234.56'
  }]);
  assert.deepEqual(context.contract.createdRequests, [
    requestFor(
      context.strategyId,
      'CONTRACT_HEDGE_GTC',
      '0.4',
      'cross',
      '61234.5'
    )
  ]);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.deepEqual(context.repository.transitionCalls, []);
});

test('fails closed when final GTC price quantization is unavailable', async (t) => {
  const reconciliation = new ScriptedReconciliation([{
    kind: 'need_gtc',
    role: 'CONTRACT_HEDGE_GTC',
    baseQuantity: '0.4',
    referencePrice: '60000'
  }]);
  const operations = new CapturingOperationalLog();
  const context = setup(t, 'CONCURRENT', {
    reconciliation,
    operationalLog: operations
  });
  seedConcurrentMarketEvidence(context);
  context.contract.quantizePrice = async () => {
    throw new Error('private price adapter failure');
  };

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(reconciliation.calls, [context.strategyId]);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.equal(
    context.repository.listOrders(context.strategyId)
      .some(({ role }) => role.endsWith('_HEDGE_GTC')),
    false
  );
  assert.equal(
    operations.warnings.filter(
      ({ event }) => event === 'hedge_submission_price_pending'
    ).length,
    1
  );
  assert.equal(
    JSON.stringify(operations.warnings).includes('private price adapter'),
    false
  );
});

test('does not retain a GTC authorization after its account guard fails', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    {
      kind: 'need_gtc',
      role: 'CONTRACT_HEDGE_GTC',
      baseQuantity: '0.4',
      referencePrice: '60000'
    },
    scriptedPending()
  ]);
  const context = setup(t, 'CONCURRENT', { reconciliation });
  seedConcurrentMarketEvidence(context);
  context.contract.accountSettingsResults.push(
    new Error('credential text must not escape')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);
  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.equal(context.contract.accountSettingsRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('runs reconciliation before any account guard in WAITING_HEDGE', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'written', state: 'HEDGED' }
  ]);
  const context = setup(t, 'CONTRACT_FIRST', { reconciliation });
  assert.equal(context.repository.claimForExecution(context.strategyId), true);
  assert.equal(context.repository.transition(
    context.strategyId,
    ['EXECUTING'],
    'WAITING_HEDGE'
  ), true);
  context.repository.transitionCalls.length = 0;
  context.contract.accountSettingsResults.push(
    new Error('account settings unavailable')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(reconciliation.calls, [context.strategyId]);
  assert.equal(context.contract.accountSettingsRequests.length, 0);
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
  assert.deepEqual(context.repository.transitionCalls, []);
});

test('never submits an order record that existed before the authorization', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'awaiting_market_submission' },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const context = setup(t, 'CONTRACT_FIRST', { reconciliation });
  assert.equal(context.repository.claimForExecution(context.strategyId), true);
  const existing = context.repository.planOrder(
    context.strategyId,
    'CONTRACT_MARKET',
    requestFor(context.strategyId, 'CONTRACT_MARKET', '1')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId).map(({ id }) => id),
    [existing.id]
  );
  assert.equal(context.contract.createdRequests.length, 0);
  assert.equal(context.spot.createdRequests.length, 0);
});

test('waits for both submissions and retains the operation lock after one rejects', async (t) => {
  const reconciliation = new ScriptedReconciliation([
    { kind: 'awaiting_market_submission' },
    scriptedPending('SUBMISSION_UNCERTAIN')
  ]);
  const contract = new DeferredCreateGateway('okx');
  t.after(() => contract.release());
  const operations = new CapturingOperationalLog();
  const context = setup(t, 'CONCURRENT', {
    contract,
    reconciliation,
    operationalLog: operations
  });
  contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  ));

  type SubmitNew = (
    strategy: Readonly<StrategyRecord>,
    order: Readonly<StrategyOrderRecord>
  ) => Promise<void>;
  const mutable = context.coordinator as unknown as {
    submitNew: SubmitNew;
  };
  const realSubmit = mutable.submitNew.bind(context.coordinator);
  mutable.submitNew = async (strategy, order) => {
    if (order.role === 'SPOT_MARKET') {
      throw new Error('unexpected internal submission failure');
    }
    await realSubmit(strategy, order);
  };

  const execution = context.coordinator.confirmAndExecute(context.strategyId);
  await contract.started;
  try {
    await context.coordinator.confirmAndExecute(context.strategyId);
    assert.deepEqual(reconciliation.calls, [context.strategyId]);
  } finally {
    contract.release();
    await execution;
  }

  assert.deepEqual(reconciliation.calls, [
    context.strategyId,
    context.strategyId
  ]);
  assert.equal(contract.createStarts, 1);
  assert.equal(context.repository.atomicPlanCalls, 1);
  assert.equal(
    operations.warnings.filter(
      ({ event }) => event === 'hedge_submission_internal_failure'
    ).length,
    1
  );
  assert.equal(
    JSON.stringify(operations.warnings).includes(
      'unexpected internal submission failure'
    ),
    false
  );
});
```

- [x] **Step 2: 写确定/不确定提交与守卫告警红测试**

先在 `tests/exchanges/exchange-gateway.test.ts` 锁定闭集载体：

```ts
test('exposes only the closed no-order-submitted reason set', () => {
  const unclassified = new NoOrderSubmittedError();
  const untradable = new NoOrderSubmittedError('UNTRADABLE_REQUEST');

  assert.deepEqual({
    name: unclassified.name,
    message: unclassified.message,
    code: unclassified.code,
    reason: unclassified.reason
  }, {
    name: 'NoOrderSubmittedError',
    message: 'order was not submitted',
    code: 'NO_ORDER_SUBMITTED',
    reason: 'UNCLASSIFIED'
  });
  assert.equal(untradable.code, 'NO_ORDER_SUBMITTED');
  assert.equal(untradable.reason, 'UNTRADABLE_REQUEST');
  assert.equal('cause' in unclassified, false);
  assert.equal('cause' in untradable, false);
});
```

在 `tests/exchanges/ccxt-gateway.test.ts` 加入原因断言 helper 和六个底层 create 计数用例：

```ts
function isNoOrderSubmittedWithReason(
  expectedReason: 'UNCLASSIFIED' | 'UNTRADABLE_REQUEST'
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert(error instanceof NoOrderSubmittedError);
    assert.equal(error.code, 'NO_ORDER_SUBMITTED');
    assert.equal(error.reason, expectedReason);
    assert.equal(error.message, 'order was not submitted');
    assert.equal('cause' in error, false);
    return true;
  };
}

test('classifies a base minimum rejection as untradable before create', async () => {
  const constrained = okxSpotMarket({
    precision: { amount: 0.001, price: 0.1 },
    limits: {
      amount: { min: 0.01, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: undefined, max: undefined }
    }
  });
  const { gateway, ccxt } = makeGateway('okx', [constrained]);

  await assert.rejects(
    gateway.createOrder(spotRequest({ baseQuantity: '0.005' })),
    isNoOrderSubmittedWithReason('UNTRADABLE_REQUEST')
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('classifies changed whole-contract precision as untradable before create', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  ccxt.amountPrecisionResult = '9';

  await assert.rejects(
    gateway.createOrder(swapRequest()),
    isNoOrderSubmittedWithReason('UNTRADABLE_REQUEST')
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('classifies quote-notional rejection as untradable before create', async () => {
  const constrained = okxSpotMarket({
    limits: {
      amount: { min: 0.000001, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 650, max: undefined }
    }
  });
  const { gateway, ccxt } = makeGateway('okx', [constrained]);
  ccxt.pricePrecisionResult = '60000';

  await assert.rejects(
    gateway.createOrder(spotRequest({ price: '65000' })),
    isNoOrderSubmittedWithReason('UNTRADABLE_REQUEST')
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('keeps market resolution failure unclassified before create', async () => {
  const { gateway, ccxt } = makeGateway('okx');

  await assert.rejects(
    gateway.createOrder(spotRequest({ symbol: 'ETH/USDT' })),
    isNoOrderSubmittedWithReason('UNCLASSIFIED')
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('keeps missing account parameters unclassified before create', async () => {
  const { gateway, ccxt } = makeGateway('okx');
  const request = swapRequest();
  delete request.marginMode;

  await assert.rejects(
    gateway.createOrder(request),
    isNoOrderSubmittedWithReason('UNCLASSIFIED')
  );
  assert.equal(ccxt.createCalls.length, 0);
});

test('keeps price preparation failure unclassified before create', async () => {
  const { gateway, ccxt } = makeGateway('bitget');
  ccxt.ticker = {};

  await assert.rejects(
    gateway.createOrder(spotMarketRequest()),
    isNoOrderSubmittedWithReason('UNCLASSIFIED')
  );
  assert.equal(ccxt.createCalls.length, 0);
});
```

在协调器测试中加入一个只统计 gateway 入口、但在 fake 外部提交记录前拒绝的替身：

```ts
class ReasonedPreSubmissionGateway extends TrackingGateway {
  readonly attempts: OrderRequest[] = [];

  constructor(
    exchangeId: string,
    private readonly rejectedType: OrderRequest['type'],
    private readonly reason: 'UNCLASSIFIED' | 'UNTRADABLE_REQUEST'
  ) {
    super(exchangeId);
  }

  override async createOrder(request: OrderRequest): Promise<OrderSnapshot> {
    this.attempts.push(structuredClone(request));
    if (request.type === this.rejectedType) {
      throw new NoOrderSubmittedError(this.reason);
    }
    return super.createOrder(request);
  }
}

interface NoSubmitCase {
  readonly name: string;
  readonly authorization: 'market' | 'gtc';
  readonly reason: 'UNCLASSIFIED' | 'UNTRADABLE_REQUEST';
  readonly expectedFailureCode: OrderSubmissionFailureCode;
}

const NO_SUBMIT_CASES: readonly NoSubmitCase[] = [
  {
    name: 'unclassified initial market order',
    authorization: 'market',
    reason: 'UNCLASSIFIED',
    expectedFailureCode: 'ORDER_SUBMISSION_FAILED'
  },
  {
    name: 'untradable initial market order',
    authorization: 'market',
    reason: 'UNTRADABLE_REQUEST',
    expectedFailureCode: 'ORDER_SUBMISSION_FAILED'
  },
  {
    name: 'unclassified residual GTC',
    authorization: 'gtc',
    reason: 'UNCLASSIFIED',
    expectedFailureCode: 'ORDER_SUBMISSION_FAILED'
  },
  {
    name: 'untradable residual GTC',
    authorization: 'gtc',
    reason: 'UNTRADABLE_REQUEST',
    expectedFailureCode: 'HEDGE_RESIDUAL_NOT_TRADABLE'
  }
];

for (const testCase of NO_SUBMIT_CASES) {
  test(`persists definite no-submit evidence for ${testCase.name}`, async (t) => {
    const rejectedType = testCase.authorization === 'market'
      ? 'market'
      : 'limit';
    const contract = new ReasonedPreSubmissionGateway(
      'okx',
      rejectedType,
      testCase.reason
    );
    const authorization: ReconciliationResult =
      testCase.authorization === 'market'
        ? { kind: 'awaiting_market_submission' }
        : {
            kind: 'need_gtc',
            role: 'CONTRACT_HEDGE_GTC',
            baseQuantity: '0.4',
            referencePrice: '60000'
          };
    const reconciliation = new ScriptedReconciliation([
      authorization,
      scriptedPending('SUBMISSION_UNCERTAIN')
    ]);
    const context = setup(
      t,
      testCase.authorization === 'market'
        ? 'CONTRACT_FIRST'
        : 'CONCURRENT',
      { contract, reconciliation }
    );
    if (testCase.authorization === 'gtc') {
      seedConcurrentMarketEvidence(context);
    }

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.equal(contract.attempts.length, 1);
    assert.deepEqual(reconciliation.calls, [
      context.strategyId,
      context.strategyId
    ]);
    assert.equal(context.repository.evidenceCalls.length, 1);
    assert.equal(
      context.repository.evidenceCalls[0]?.failureCode,
      testCase.expectedFailureCode
    );
    const targetRole = testCase.authorization === 'market'
      ? 'CONTRACT_MARKET'
      : 'CONTRACT_HEDGE_GTC';
    const persisted = context.repository.listOrders(context.strategyId)
      .find(({ role }) => role === targetRole);
    assert.ok(persisted);
    assert.equal(
      persisted.submissionDisposition,
      'DEFINITELY_NOT_SUBMITTED'
    );
    assert.equal(
      persisted.submissionFailureCode,
      testCase.expectedFailureCode
    );
    assert.deepEqual(context.repository.transitionCalls, []);
  });
}
```

CAS 未命中和异常必须保持证据不确定、再次对账且只写安全 warning：

```ts
for (const behavior of ['false', 'throw'] as const) {
  test(`reconciles again after no-submit evidence ${behavior}`, async (t) => {
    const contract = new ReasonedPreSubmissionGateway(
      'okx',
      'market',
      'UNCLASSIFIED'
    );
    const reconciliation = new ScriptedReconciliation([
      { kind: 'awaiting_market_submission' },
      scriptedPending('SUBMISSION_UNCERTAIN')
    ]);
    const operations = new CapturingOperationalLog();
    const context = setup(t, 'CONTRACT_FIRST', {
      contract,
      reconciliation,
      operationalLog: operations
    });
    context.repository.evidenceWriteBehavior = behavior;

    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.equal(contract.attempts.length, 1);
    assert.deepEqual(reconciliation.calls, [
      context.strategyId,
      context.strategyId
    ]);
    const [order] = context.repository.listOrders(context.strategyId);
    assert.ok(order);
    assert.equal(order.submissionDisposition, 'SUBMISSION_UNCERTAIN');
    assert.equal(order.submissionFailureCode, null);
    assert.deepEqual(context.repository.transitionCalls, []);
    assert.equal(
      operations.warnings.filter(
        ({ event }) => event === 'hedge_submission_evidence_conflict'
      ).length,
      1
    );
    assert.equal(
      JSON.stringify(operations.warnings).includes('private sqlite detail'),
      false
    );
  });
}
```

再加入两条使用真实 `HedgeReconciliation` 的纵向恢复测试。第一条证明不可交易 GTC 只尝试一次，终态来自持久化证据；第二条证明普通异常后查回远端订单，不按同一 client ID 重提：

```ts
test('real reconciliation terminates an untradable residual without retry', async (t) => {
  const contract = new ReasonedPreSubmissionGateway(
    'okx',
    'limit',
    'UNTRADABLE_REQUEST'
  );
  const context = setup(t, 'CONCURRENT', { contract });
  context.spot.createResults.push(snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  ));
  contract.createResults.push(snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1',
    {
      filledBaseQuantity: '0.6',
      remainingBaseQuantity: '0.4',
      averagePrice: '60010'
    }
  ));

  await context.coordinator.confirmAndExecute(context.strategyId);

  const persisted = context.repository.getStrategy(context.strategyId);
  assert.equal(persisted.state, 'HEDGE_INCOMPLETE');
  assert.equal(persisted.failureCode, 'HEDGE_RESIDUAL_NOT_TRADABLE');
  assert.equal(
    contract.attempts.filter(({ type }) => type === 'limit').length,
    1
  );
  assert.equal(
    context.repository.listOrders(context.strategyId)
      .filter(({ role }) => role === 'CONTRACT_HEDGE_GTC').length,
    1
  );
  assert.equal(
    context.repository.listOrders(context.strategyId)
      .find(({ role }) => role === 'CONTRACT_HEDGE_GTC')
      ?.submissionDisposition,
    'DEFINITELY_NOT_SUBMITTED'
  );

  await context.coordinator.confirmAndExecute(context.strategyId);
  assert.equal(
    contract.attempts.filter(({ type }) => type === 'limit').length,
    1
  );
});

test('real reconciliation recovers uncertain market submissions without duplicates', async (t) => {
  const context = setup(t, 'CONCURRENT');
  const spotSnapshot = snapshotFor(
    context.strategyId,
    'SPOT_MARKET',
    '1'
  );
  const contractSnapshot = snapshotFor(
    context.strategyId,
    'CONTRACT_MARKET',
    '1'
  );
  context.spot.createResults.push(spotSnapshot);
  context.contract.createResults.push(contractSnapshot);
  context.spot.createErrors.set(
    spotSnapshot.clientOrderId,
    new Error('ambiguous transport failure')
  );
  context.contract.createErrors.set(
    contractSnapshot.clientOrderId,
    new Error('ambiguous transport failure')
  );

  await context.coordinator.confirmAndExecute(context.strategyId);
  await context.coordinator.confirmAndExecute(context.strategyId);

  assert.equal(
    context.repository.getStrategy(context.strategyId).state,
    'HEDGED'
  );
  assert.equal(context.spot.createdRequests.length, 1);
  assert.equal(context.contract.createdRequests.length, 1);
  assert.deepEqual(
    context.repository.listOrders(context.strategyId)
      .map(({ submissionDisposition }) => submissionDisposition),
    ['REMOTE_OBSERVED', 'REMOTE_OBSERVED']
  );
});
```

最后用相同 `updatedAt` 连续两轮锁定账户守卫的纯阻断和 warning 去重；两个分支都不写状态或计划订单：

```ts
for (const testCase of [
  {
    name: 'settings lookup failure',
    event: 'hedge_submission_guard_pending',
    results: [
      new Error('apiKey=must-not-be-logged'),
      new Error('apiKey=must-not-be-logged')
    ]
  },
  {
    name: 'settings drift',
    event: 'hedge_submission_guard_changed',
    results: [
      { marginMode: 'isolated', positionMode: 'hedged', leverage: '2' },
      { marginMode: 'isolated', positionMode: 'hedged', leverage: '2' }
    ]
  }
] as const) {
  test(`blocks and deduplicates ${testCase.name}`, async (t) => {
    const reconciliation = new ScriptedReconciliation([
      { kind: 'awaiting_market_submission' },
      { kind: 'awaiting_market_submission' }
    ]);
    const operations = new CapturingOperationalLog();
    const context = setup(t, 'CONCURRENT', {
      reconciliation,
      operationalLog: operations
    });
    context.contract.accountSettingsResults.push(...testCase.results);

    await context.coordinator.confirmAndExecute(context.strategyId);
    await context.coordinator.confirmAndExecute(context.strategyId);

    assert.deepEqual(reconciliation.calls, [
      context.strategyId,
      context.strategyId
    ]);
    assert.deepEqual(context.repository.listOrders(context.strategyId), []);
    assert.deepEqual(context.repository.transitionCalls, []);
    assert.equal(context.spot.createdRequests.length, 0);
    assert.equal(context.contract.createdRequests.length, 0);
    assert.equal(
      operations.warnings.filter(
        ({ event }) => event === testCase.event
      ).length,
      1
    );
    assert.equal(
      JSON.stringify(operations.warnings).includes('must-not-be-logged'),
      false
    );
  });
}
```

- [x] **Step 3: 运行协调器测试并确认构造器与行为变红**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test --test-name-pattern='submit|authorization|guard|reconciliation|untradable|unclassified' dist/tests/exchanges/exchange-gateway.test.js dist/tests/exchanges/ccxt-gateway.test.js dist/tests/strategy/hedge-coordinator.test.js
```

Expected: FAIL；首先出现新 `hedge-reconciliation.js` import、`NoOrderSubmittedError.reason` 或新构造器签名缺失的 TypeScript 错误。该红灯只证明公共接口尚未接入，不作为业务行为红灯。

- [x] **Step 4: 接入可编译、失败封闭的 run-first 骨架并确认行为变红**

在 `src/exchanges/exchange-gateway.ts` 先加入已由 Step 2 红测试锁定的闭集载体；不保留底层 cause 或 message：

```ts
export type NoOrderSubmittedReason =
  | 'UNCLASSIFIED'
  | 'UNTRADABLE_REQUEST';

export class NoOrderSubmittedError extends Error {
  readonly code = 'NO_ORDER_SUBMITTED';

  constructor(readonly reason: NoOrderSubmittedReason = 'UNCLASSIFIED') {
    super('order was not submitted');
    this.name = 'NoOrderSubmittedError';
  }
}
```

在 `HedgeCoordinator` 声明日志字段并接入新构造器：

```ts
import {
  nonThrowingOperationalLog,
  type OperationalLog
} from '../logging/logger.js';
import type {
  OrderSubmissionFailureCode,
  StrategyFailureCode,
  StrategyOrderPlan,
  StrategyOrderRecord,
  StrategyRecord,
  StrategyRepository
} from '../storage/strategy-repository.js';
import type {
  ReconciliationResult,
  ReconciliationRunner
} from './hedge-reconciliation.js';
```

```ts
private readonly operationalLog: OperationalLog | undefined;

constructor(
  private readonly registry: ExchangeRegistry,
  private readonly repository: StrategyRepository,
  private readonly reconciliation: ReconciliationRunner,
  tradeEvents: TradeEventSink = NOOP_TRADE_EVENT_SINK,
  operationalLog?: OperationalLog
) {
  this.tradeEvents = nonThrowingTradeEventSink(tradeEvents);
  this.operationalLog = nonThrowingOperationalLog(operationalLog);
}
```

保留现有 `confirmAndExecute` operation lock，把锁内旧执行树暂时替换为只领取、只调用一次对账器的失败封闭骨架：

```ts
private async confirmAndExecuteOwned(strategyId: string): Promise<void> {
  let strategy = this.repository.getStrategy(strategyId);
  if (strategy.state === 'PENDING_CONFIRMATION') {
    if (!this.repository.claimForExecution(strategyId)) return;
    strategy = this.repository.getStrategy(strategyId);
  }
  if (strategy.state !== 'EXECUTING' && strategy.state !== 'WAITING_HEDGE') {
    return;
  }
  await this.reconciliation.run(strategyId);
}
```

在 `src/main.ts` 的 repository、gateway、registry 已完成构造后，且不移动 Task 1 的 `claimSqliteProcessOwnership`，按以下顺序装配：

```ts
import { HedgeReconciliation } from './strategy/hedge-reconciliation.js';

const reconciliation = new HedgeReconciliation(
  registry,
  repository,
  tradeEvents,
  operationalLog
);
const coordinator = new HedgeCoordinator(
  registry,
  repository,
  reconciliation,
  tradeEvents,
  operationalLog
);
```

`tests/strategy/order-monitor.test.ts` 与 `tests/http/server.test.ts` 的每个直接构造点都用其现有 fake registry、内存 repository 和同一个 event sink 构造真实对账器，再传入协调器；没有 operational log 的 fixture 使用四参数形式：

```ts
const reconciliation = new HedgeReconciliation(
  registry,
  repository,
  tradeEventSink
);
const coordinator = new HedgeCoordinator(
  registry,
  repository,
  reconciliation,
  tradeEventSink
);
```

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test --test-name-pattern='reconciliation|authorization|no-submit|account settings|market-to-GTC|derived GTC|fresh contract settings|lookup-only recovery|contract-first hedges|concurrent mode sends one exact|untradable before create|unclassified before create' dist/tests/exchanges/exchange-gateway.test.js dist/tests/exchanges/ccxt-gateway.test.js dist/tests/strategy/hedge-coordinator.test.js
```

Expected: FAIL；编译成功，`awaiting_market_submission` 没有规划订单、`need_gtc` 没有提交、market 后返回的 `need_gtc` 被丢弃，改写后的纯阻断守卫/无守卫恢复断言仍失败，且 CCXT 的明确不可交易用例仍得到 `UNCLASSIFIED`。至少一个新增授权用例和一个上表保留或改写的存量用例必须以行为断言失败；不能接受缺失 import、构造器或 fixture 错误作为这一轮红灯。

- [x] **Step 5: 重写持锁入口为完整 run-first 状态机**

`confirmAndExecute` 保留现有 operation lock。锁内流程固定为：

```ts
private async confirmAndExecuteOwned(strategyId: string): Promise<void> {
  let strategy = this.repository.getStrategy(strategyId);
  if (strategy.state === 'PENDING_CONFIRMATION') {
    if (!this.repository.claimForExecution(strategyId)) return;
    strategy = this.repository.getStrategy(strategyId);
  }
  if (strategy.state !== 'EXECUTING' && strategy.state !== 'WAITING_HEDGE') {
    return;
  }

  let result = await this.reconciliation.run(strategyId);
  if (result.kind === 'awaiting_market_submission') {
    if (!await this.newSubmissionAllowed(strategy, false)) return;
    const orders = this.planInitialMarketOrders(strategy);
    const settled = await Promise.allSettled(
      orders.map((order) => this.submitNew(strategy, order))
    );
    this.warnRejectedSubmissions(strategy, orders, settled);
    result = await this.reconciliation.run(strategyId);
  }
  if (result.kind === 'need_gtc') {
    if (!await this.newSubmissionAllowed(strategy, true)) return;
    const order = await this.planAuthorizedGtc(strategy, result);
    if (order === null) return;
    const settled = await Promise.allSettled([
      this.submitNew(strategy, order)
    ]);
    this.warnRejectedSubmissions(strategy, [order], settled);
    await this.reconciliation.run(strategyId);
  }
}
```

账户守卫只在拿到提交授权后调用，使用进入本轮的策略修订做 warning 去重。当前设置只输出验证后的枚举和正十进制摘要，任何异常文本都丢弃：

```ts
private readonly guardWarningKeys = new Set<string>();

private safeAccountSettingsSummary(settings: Readonly<AccountSettings>): string {
  const marginMode = settings.marginMode === 'isolated'
    || settings.marginMode === 'cross'
    || settings.marginMode === 'unknown'
    ? settings.marginMode
    : 'invalid';
  const positionMode = settings.positionMode === 'hedged'
    || settings.positionMode === 'one-way'
    || settings.positionMode === 'unknown'
    ? settings.positionMode
    : 'invalid';
  let leverage = 'invalid';
  if (typeof settings.leverage === 'string') {
    try {
      const parsed = new Decimal(settings.leverage);
      if (parsed.isFinite() && parsed.gt(0)) leverage = parsed.toString();
    } catch {
      // Invalid runtime data is represented only by the fixed token above.
    }
  }
  return [
    `marginMode=${marginMode}`,
    `positionMode=${positionMode}`,
    `leverage=${leverage}`
  ].join(',');
}

private warnSubmissionGuard(
  strategy: Readonly<StrategyRecord>,
  event: 'hedge_submission_guard_pending' | 'hedge_submission_guard_changed',
  reason: 'ACCOUNT_SETTINGS_UNAVAILABLE' | 'ACCOUNT_SETTINGS_CHANGED',
  exposureKnown: boolean,
  current?: Readonly<AccountSettings>
): void {
  const key = `${strategy.id}:${reason}:${strategy.updatedAt}`;
  if (this.guardWarningKeys.has(key)) return;
  this.guardWarningKeys.add(key);
  this.operationalLog?.warn(event, {
    strategyId: strategy.id,
    strategyState: strategy.state,
    conclusion: 'pending',
    reason,
    expected: this.safeAccountSettingsSummary(
      strategy.preflight.accountSettings
    ),
    ...(current === undefined
      ? {}
      : { actual: this.safeAccountSettingsSummary(current) }),
    exposureKnown
  });
}

private async newSubmissionAllowed(
  strategy: Readonly<StrategyRecord>,
  exposureKnown: boolean
): Promise<boolean> {
  let current: AccountSettings;
  try {
    current = await this.registry.get(strategy.contractExchangeId)
      .fetchAccountSettings(strategy.symbol);
  } catch {
    this.warnSubmissionGuard(
      strategy,
      'hedge_submission_guard_pending',
      'ACCOUNT_SETTINGS_UNAVAILABLE',
      exposureKnown
    );
    return false;
  }
  if (!accountSettingsMatch(strategy.preflight.accountSettings, current)) {
    this.warnSubmissionGuard(
      strategy,
      'hedge_submission_guard_changed',
      'ACCOUNT_SETTINGS_CHANGED',
      exposureKnown,
      current
    );
    return false;
  }
  return true;
}
```

只从空订单集合规划初始腿；已有任何 record 时返回空数组，因此仓储幂等返回的旧 record 永远不会被当成本轮新计划提交：

```ts
private planInitialMarketOrders(
  strategy: Readonly<StrategyRecord>
): StrategyOrderRecord[] {
  if (this.repository.listOrders(strategy.id).length !== 0) return [];
  const marginMode = strategy.preflight.accountSettings.marginMode;
  if (marginMode !== 'isolated' && marginMode !== 'cross') return [];
  const plans: StrategyOrderPlan[] = strategy.mode === 'CONCURRENT'
    ? [
        {
          role: 'SPOT_MARKET',
          request: this.marketRequest(strategy, 'spot', marginMode)
        },
        {
          role: 'CONTRACT_MARKET',
          request: this.marketRequest(strategy, 'contract', marginMode)
        }
      ]
    : strategy.mode === 'CONTRACT_FIRST'
      ? [{
          role: 'CONTRACT_MARKET',
          request: this.marketRequest(strategy, 'contract', marginMode)
        }]
      : [{
          role: 'SPOT_MARKET',
          request: this.marketRequest(strategy, 'spot', marginMode)
        }];
  const records = strategy.mode === 'CONCURRENT'
    ? this.repository.planOrdersAtomically(strategy.id, plans)
    : plans.map(({ role, request }) => (
        this.repository.planOrder(strategy.id, role, request)
      ));
  for (const record of records) {
    this.recordOrderEvent(
      'order_planned',
      this.prepareExisting(strategy, record)
    );
  }
  return records;
}
```

GTC 规划只消费参数中的当次判别联合，不读取缓存；若已有任一 GTC record，或最终价格量化失败，则失败封闭且不返回旧 record：

```ts
private async planAuthorizedGtc(
  strategy: Readonly<StrategyRecord>,
  authorization: Extract<ReconciliationResult, { kind: 'need_gtc' }>
): Promise<StrategyOrderRecord | null> {
  if (
    this.repository.listOrders(strategy.id)
      .some(({ role }) => role.endsWith('_HEDGE_GTC'))
  ) {
    return null;
  }
  const leg = authorization.role === 'SPOT_HEDGE_GTC'
    ? 'spot'
    : 'contract';
  const kind = leg === 'spot' ? 'spot' : 'swap';
  const gateway = this.registry.get(
    leg === 'spot'
      ? strategy.spotExchangeId
      : strategy.contractExchangeId
  );
  const price = await this.quantizedPrice(
    gateway,
    strategy.symbol,
    kind,
    authorization.referencePrice
  );
  if (price === null) {
    this.operationalLog?.warn('hedge_submission_price_pending', {
      strategyId: strategy.id,
      strategyState: strategy.state,
      conclusion: 'pending',
      reason: 'PRICE_QUANTIZATION_FAILED',
      role: authorization.role,
      exchangeId: gateway.exchangeId,
      exposureKnown: true
    });
    return null;
  }
  const marginMode = strategy.preflight.accountSettings.marginMode;
  if (marginMode !== 'isolated' && marginMode !== 'cross') return null;
  const request = this.hedgeRequest(
    strategy,
    leg,
    authorization.baseQuantity,
    price,
    marginMode
  );
  const record = this.repository.planOrder(
    strategy.id,
    authorization.role,
    request
  );
  this.recordOrderEvent(
    'order_planned',
    this.prepareExisting(strategy, record)
  );
  return record;
}

private warnRejectedSubmissions(
  strategy: Readonly<StrategyRecord>,
  orders: readonly StrategyOrderRecord[],
  settled: readonly PromiseSettledResult<void>[]
): void {
  for (const [index, result] of settled.entries()) {
    if (result.status !== 'rejected') continue;
    const order = orders[index];
    if (order === undefined) continue;
    this.operationalLog?.warn('hedge_submission_internal_failure', {
      strategyId: strategy.id,
      strategyState: strategy.state,
      conclusion: 'pending',
      reason: 'SUBMISSION_INTERNAL_FAILURE',
      role: order.role,
      exchangeId: order.exchangeId,
      strategyOrderId: order.id,
      clientOrderId: order.clientOrderId,
      exposureKnown: order.role.endsWith('_HEDGE_GTC')
    });
  }
}
```

这是有界串联而不是循环：最多消费一次 `awaiting_market_submission`，其第二次 `run` 若返回当次 `need_gtc`，再消费一次 GTC 授权并做最终 `run`；最终结果不再触发提交。`pending/written/observed_state/waiting_gtc` 自然返回。每次 `need_gtc` 都只存在当前栈帧，不能保存到字段、缓存或数据库。

- [x] **Step 6: 收缩提交方法并删除直接判定路径**

在 `src/exchanges/ccxt-exchange-gateway.ts` 增加不导出的分类错误，并只在四个“规则已经明确判定不满足”的位置抛它。解析失败、资源上限、market/账户/价格准备失败仍抛原固定错误，不能通过匹配 message 分类：

```ts
class UntradableOrderRequestError extends Error {
  readonly name = 'UntradableOrderRequestError';

  constructor() {
    super('order request is definitely untradable');
  }
}
```

把四类明确分支固定为以下 throw；解析、精确运算资源上限和 formatter 自身抛错仍保留原错误类型：

```ts
if (base.lt(rules.minBaseAmount)) {
  throw new UntradableOrderRequestError();
}
if (
  rules.maxBaseAmount !== undefined
  && base.gt(rules.maxBaseAmount)
) {
  throw new UntradableOrderRequestError();
}

if (!decimal(exchangeAmountToBase(exchangeAmount, size)).eq(base)) {
  throw new UntradableOrderRequestError();
}

if (!decimal(validFormattedAmount).eq(exchangeAmount)) {
  throw new UntradableOrderRequestError();
}

if (
  rules.minQuoteNotional !== undefined
  && decimal(quoteNotional).lt(rules.minQuoteNotional)
) {
  throw new UntradableOrderRequestError();
}
if (
  rules.maxQuoteNotional !== undefined
  && decimal(quoteNotional).gt(rules.maxQuoteNotional)
) {
  throw new UntradableOrderRequestError();
}
```

`createOrder` 的 prepare catch 固定为：

```ts
let prepared: PreparedCcxtOrder;
try {
  prepared = await this.prepareCreateOrder(request);
} catch (error) {
  throw new NoOrderSubmittedError(
    error instanceof UntradableOrderRequestError
      ? 'UNTRADABLE_REQUEST'
      : 'UNCLASSIFIED'
  );
}
```

`NoOrderSubmittedError` 不设置 `cause`，上述 catch 之后也不得读取或保留 `error.message`。

`submitNew` 只接收本轮刚计划的 record：记录 `order_submit_started`；调用 `createOrder`；成功只记录 `order_submit_succeeded`，不 attach 返回快照；普通异常只记录不确定事实。完整方法为：

```ts
private async submitNew(
  strategy: Readonly<StrategyRecord>,
  order: Readonly<StrategyOrderRecord>
): Promise<void> {
  const prepared = this.prepareExisting(strategy, order);
  this.recordOrderEvent('order_submit_started', prepared, null);
  let snapshot: OrderSnapshot;
  try {
    snapshot = await prepared.gateway.createOrder(order.request);
  } catch (error) {
    if (error instanceof NoOrderSubmittedError) {
      const failureCode: OrderSubmissionFailureCode =
        error.reason === 'UNTRADABLE_REQUEST'
          && order.role.endsWith('_HEDGE_GTC')
          ? 'HEDGE_RESIDUAL_NOT_TRADABLE'
          : 'ORDER_SUBMISSION_FAILED';
      this.recordSubmissionFailure(
        'order_rejected_before_submit',
        prepared,
        failureCode,
        error
      );
      try {
        const written = this.repository.markDefinitelyNotSubmitted(
          order.id,
          failureCode
        );
        if (!written) {
          this.warnSubmissionEvidenceConflict(
            strategy,
            order,
            order.role.endsWith('_HEDGE_GTC')
          );
        }
      } catch {
        this.warnSubmissionEvidenceConflict(
          strategy,
          order,
          order.role.endsWith('_HEDGE_GTC')
        );
      }
      return;
    }
    this.recordSubmissionFailure(
      'order_submit_uncertain',
      prepared,
      'ORDER_SUBMISSION_UNKNOWN',
      error
    );
    return;
  }
  this.recordOrderEvent('order_submit_succeeded', prepared, snapshot);
}
```

同时把 `recordSubmissionFailure` 的签名固定为下列类型；方法体保留现有安全的 error name/code 提取，不读取 message、stack 或 cause：

```ts
private recordSubmissionFailure(
  name: 'order_rejected_before_submit' | 'order_submit_uncertain',
  prepared: Readonly<PreparedOrder>,
  failureCode: StrategyFailureCode,
  error: unknown
): void {
  const errorCode = safeStringProperty(error, 'code');
  this.recordOrderEvent(name, prepared, null, {
    failureCode,
    errorType: safeStringProperty(error, 'name') ?? 'UnknownError',
    ...(errorCode === undefined ? {} : { errorCode })
  });
}
```

辅助方法固定为安全字段，不记录底层异常：

```ts
private warnSubmissionEvidenceConflict(
  strategy: Readonly<StrategyRecord>,
  order: Readonly<StrategyOrderRecord>,
  exposureKnown: boolean
): void {
  this.operationalLog?.warn('hedge_submission_evidence_conflict', {
    strategyId: strategy.id,
    strategyState: strategy.state,
    conclusion: 'pending',
    reason: 'SUBMISSION_EVIDENCE_WRITE_CONFLICT',
    role: order.role,
    exchangeId: order.exchangeId,
    strategyOrderId: order.id,
    clientOrderId: order.clientOrderId,
    exposureKnown
  });
}
```

普通异常只记录 `order_submit_uncertain`。所有路径都不 transition，外层统一再次 run。CAS 返回 false 或抛错时不能使用内存中的 reason 终态化；第二次 run 必须重读持久化订单。

并发提交必须使用 `Promise.allSettled`；即使一个内部路径出现预期外 rejection，也要等两张订单都 settle 后再进入第二次 run，不能提前释放 strategy operation lock。每个 rejected result 只记录固定 `hedge_submission_internal_failure` warning，不记录原始 cause。

删除 `finishHedge`、`failStrategy`、`failStrategyBestEffort`、协调器内两腿残差解释、查回已有 planned 订单后重新 create、以及协调器发出的 `order_status_changed/order_terminal`。保留 request 构造、最终价格量化、账户设置精确比较和原子规划。

账户 guard 改成纯阻断：读取失败记录 `hedge_submission_guard_pending`；设置漂移记录 `hedge_submission_guard_changed`，字段只有预检和当前的 margin/position/leverage 安全摘要。相同 `(strategyId, reason, strategy.updatedAt)` 只记录一次。它不能调用 transition，也不能在 `run` 前执行。

- [x] **Step 7: 跑协调器、网关与对账集成**

普通协调器测试 fixture 构造真实 reconciliation：

```ts
const reconciliation = new HedgeReconciliation(
  registry,
  repository,
  tradeEventSink,
  operationalLog
);
const coordinator = new HedgeCoordinator(
  registry,
  repository,
  reconciliation,
  tradeEventSink,
  operationalLog
);
```

Step 1 已固定 orchestration fixture，Step 4 已更新 `src/main.ts`、HTTP 和 monitor 测试的直接构造点。本步骤不再改构造器；Task 7 才删除 monitor 的旧参数。

在 `tests/http/server.test.ts` 现有返回订单的 status 用例中，对每个公开订单加入下列断言，锁定持久化证据仍是内部字段：

```ts
for (const order of body.orders as Array<Record<string, unknown>>) {
  assert.equal(Object.hasOwn(order, 'submissionDisposition'), false);
  assert.equal(Object.hasOwn(order, 'submissionFailureCode'), false);
}
```

先确认存量协调器测试迁移已完成，且没有把失败用例静默禁用：

```bash
! rg -n 'coordinator never claims|fresh settings drift classifies|repository uncertainty while classifying|rechecks settings for each new create|lookup-only recovery checks' tests/strategy/hedge-coordinator.test.ts
! rg -n '\.(skip|todo|only)\(' tests/strategy/hedge-coordinator.test.ts
```

Expected: 两条命令都退出 `0`。被反转的旧标题已删除或改名，测试文件没有禁用或单独运行标记；Step 1 清单中要求保留和改写的用例已经人工按标题核对。

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/exchanges/exchange-gateway.test.js dist/tests/exchanges/ccxt-gateway.test.js dist/tests/strategy/hedge-reconciliation.test.js dist/tests/strategy/hedge-coordinator.test.js dist/tests/http/server.test.js
```

Expected: PASS；退出码 `0`。同一 client order ID 在任何恢复场景下 `createdRequests` 最多为 1。

- [x] **Step 8: 提交协调器收口**

```bash
git add src/exchanges/exchange-gateway.ts src/exchanges/ccxt-exchange-gateway.ts src/strategy/hedge-coordinator.ts src/main.ts tests/exchanges/exchange-gateway.test.ts tests/exchanges/ccxt-gateway.test.ts tests/strategy/hedge-coordinator.test.ts tests/strategy/order-monitor.test.ts tests/http/server.test.ts
git commit -m "refactor: gate hedge submissions through reconciliation"
```

---

### Task 7: 收口监控器、运行时装配与重启验收

**Files:**
- Modify: `src/strategy/order-monitor.ts:1-1258`
- Modify: `src/main.ts:285-330`
- Modify: `tests/strategy/hedge-coordinator.test.ts`
- Modify: `tests/strategy/order-monitor.test.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/acceptance/hedge-opening.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `claimSqliteProcessOwnership` 固定启动顺序、`ExecutionContinuation.confirmAndExecute(strategyId)`、仓储 `listRecoverable()`、Task 6 新协调器构造器。
- Produces: `OrderMonitor(repository, executionContinuation, operationalLog?)`；恢复链路唯一为 monitor -> coordinator -> reconciliation。

- [x] **Step 1: 把监控测试改成转发、去重和恢复红测试**

删除 `tests/strategy/order-monitor.test.ts` 中从 `keeps waiting after a partial GTC fill` 到 `uses exact private Decimal arithmetic despite global configuration pollution` 的旧业务判定测试；这些规则由 Task 5 的真实对账器矩阵拥有。保留现有四个 timer/stop 测试，并把它们的 monitor 构造器改为新参数。

在同文件加入只暴露 `listRecoverable` 的 repository proxy；若 monitor 读取其他仓储方法，测试立即失败：

```ts
function monitorStrategy(
  id: string,
  state: 'EXECUTING' | 'WAITING_HEDGE'
): StrategyRecord {
  const preview = preflight('CONCURRENT');
  return {
    id,
    state,
    mode: preview.mode,
    spotExchangeId: preview.spotExchangeId,
    contractExchangeId: preview.contractExchangeId,
    symbol: preview.symbol,
    requestedBaseQuantity: preview.requestedBaseQuantity,
    effectiveBaseQuantity: preview.effectiveBaseQuantity,
    preflight: preview,
    failureCode: null,
    createdAt: preview.createdAt,
    updatedAt: preview.createdAt
  };
}

function monitorRepository(
  records: readonly StrategyRecord[]
): StrategyRepository {
  const target = {
    listRecoverable(): StrategyRecord[] {
      return [...records];
    }
  } as unknown as StrategyRepository;
  return new Proxy(target, {
    get(object, property, receiver): unknown {
      if (property !== 'listRecoverable') {
        throw new Error(`monitor touched forbidden repository member ${String(property)}`);
      }
      return Reflect.get(object, property, receiver);
    }
  });
}

class CapturingContinuation implements ExecutionContinuation {
  readonly calls: string[] = [];
  errorFor = new Set<string>();

  async confirmAndExecute(strategyId: string): Promise<void> {
    this.calls.push(strategyId);
    if (this.errorFor.has(strategyId)) {
      throw new Error('controlled continuation failure');
    }
  }
}

class DeferredContinuation implements ExecutionContinuation {
  readonly calls: string[] = [];
  #release: (() => void) | undefined;
  #started: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.#started = resolve;
  });
  readonly gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  release(): void {
    this.#release?.();
  }

  async confirmAndExecute(strategyId: string): Promise<void> {
    this.calls.push(strategyId);
    this.#started?.();
    await this.gate;
  }
}
```

加入下列完整测试：

```ts
test('deduplicates concurrent reconciliation for one strategy', async (t) => {
  const continuation = new DeferredContinuation();
  t.after(() => continuation.release());
  const monitor = new OrderMonitor(
    monitorRepository([]),
    continuation
  );

  const first = monitor.reconcileStrategy('strategy-1');
  await continuation.started;
  const second = monitor.reconcileStrategy('strategy-1');
  await Promise.resolve();

  assert.deepEqual(continuation.calls, ['strategy-1']);
  continuation.release();
  await Promise.all([first, second]);
  assert.deepEqual(continuation.calls, ['strategy-1']);
});

test('forwards every recoverable strategy and touches no other dependency', async () => {
  const records = [
    monitorStrategy('executing', 'EXECUTING'),
    monitorStrategy('waiting', 'WAITING_HEDGE')
  ];
  const continuation = new CapturingContinuation();
  const monitor = new OrderMonitor(
    monitorRepository(records),
    continuation
  );

  await monitor.recover();

  assert.deepEqual(continuation.calls, ['executing', 'waiting']);
});

test('isolates one continuation failure and continues recovery', async () => {
  const records = [
    monitorStrategy('fails', 'EXECUTING'),
    monitorStrategy('continues', 'WAITING_HEDGE')
  ];
  const continuation = new CapturingContinuation();
  continuation.errorFor.add('fails');
  const monitor = new OrderMonitor(
    monitorRepository(records),
    continuation
  );

  await monitor.recover();

  assert.deepEqual(continuation.calls, ['fails', 'continues']);
});

test('logging failures cannot change recovery forwarding', async () => {
  const records = [monitorStrategy('fails', 'EXECUTING')];
  const continuation = new CapturingContinuation();
  continuation.errorFor.add('fails');
  const throwingLog: OperationalLog = {
    info(): void { throw new Error('logger info failure'); },
    warn(): void { throw new Error('logger warn failure'); },
    error(): void { throw new Error('logger error failure'); },
    fatal(): void { throw new Error('logger fatal failure'); }
  };
  const monitor = new OrderMonitor(
    monitorRepository(records),
    continuation,
    throwingLog
  );

  await monitor.recover();

  assert.deepEqual(continuation.calls, ['fails']);
});
```

- [x] **Step 2: 写真实重启恢复验收红测试**

在 `tests/acceptance/hedge-opening.test.ts` 增加 import 和本地请求 helper：

```ts
import Database from 'better-sqlite3';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import type { TradeEvent } from '../../src/logging/trade-events.js';
import { claimSqliteProcessOwnership } from '../../src/storage/sqlite-process-owner.js';
import { SqliteStrategyRepository } from '../../src/storage/sqlite-strategy-repository.js';
import { HedgeCoordinator } from '../../src/strategy/hedge-coordinator.js';
import { HedgeReconciliation } from '../../src/strategy/hedge-reconciliation.js';
import { OrderMonitor } from '../../src/strategy/order-monitor.js';
import type { PreflightResult } from '../../src/strategy/preflight-service.js';

function recoveryRequest(
  strategyId: string,
  role: OrderRole,
  baseQuantity: string
): OrderRequest {
  const clientOrderId = makeClientOrderId(strategyId, role);
  if (role === 'SPOT_MARKET') {
    return {
      symbol: SYMBOL,
      kind: 'spot',
      type: 'market',
      side: 'buy',
      baseQuantity,
      clientOrderId
    };
  }
  if (role === 'CONTRACT_MARKET') {
    return {
      symbol: SYMBOL,
      kind: 'swap',
      type: 'market',
      side: 'sell',
      baseQuantity,
      clientOrderId,
      positionSide: 'SHORT',
      marginMode: 'cross'
    };
  }
  if (role === 'CONTRACT_HEDGE_GTC') {
    return {
      symbol: SYMBOL,
      kind: 'swap',
      type: 'limit',
      side: 'sell',
      baseQuantity,
      price: '60000',
      timeInForce: 'GTC',
      clientOrderId,
      positionSide: 'SHORT',
      marginMode: 'cross'
    };
  }
  throw new Error('this recovery fixture only supports a contract GTC');
}

function recoveryPreflight(): PreflightResult {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1',
    effectiveBaseQuantity: '1',
    mode: 'CONCURRENT',
    spotMarket: market('bitget', 'spot'),
    contractMarket: market('okx', 'swap'),
    accountSettings: {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    },
    spotFreeUsdt: '100000',
    contractFreeUsdt: '50000',
    spotReferencePrice: '60000',
    contractReferencePrice: '60010',
    riskAcknowledgementRequired: true,
    createdAt: '2026-09-05T00:00:00.000Z'
  };
}
```

用同一段真实重启流程执行四种结果：

```ts
const RESTART_GTC_CASES = [
  {
    name: 'closed',
    remote: {
      status: 'closed',
      filledBaseQuantity: '0.4',
      remainingBaseQuantity: '0',
      averagePrice: '60000'
    },
    expectedState: 'HEDGED',
    expectedFailureCode: null,
    expectedGtcEvents: 2,
    expectedTerminalEvents: 1
  },
  {
    name: 'rejected',
    remote: {
      status: 'rejected',
      filledBaseQuantity: '0',
      remainingBaseQuantity: '0.4',
      averagePrice: null
    },
    expectedState: 'HEDGE_INCOMPLETE',
    expectedFailureCode: 'HEDGE_ORDER_REJECTED',
    expectedGtcEvents: 2,
    expectedTerminalEvents: 1
  },
  {
    name: 'canceled partial',
    remote: {
      status: 'canceled',
      filledBaseQuantity: '0.1',
      remainingBaseQuantity: '0.3',
      averagePrice: '60000'
    },
    expectedState: 'HEDGE_INCOMPLETE',
    expectedFailureCode: 'HEDGE_ORDER_CANCELED',
    expectedGtcEvents: 2,
    expectedTerminalEvents: 1
  },
  {
    name: 'lookup failure',
    remote: null,
    expectedState: 'WAITING_HEDGE',
    expectedFailureCode: null,
    expectedGtcEvents: 1,
    expectedTerminalEvents: 0
  }
] as const;

for (const testCase of RESTART_GTC_CASES) {
  test(`restart reconciles ${testCase.name} GTC without submission`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'trade-ops-restart-'));
    const databasePath = join(directory, 'recovery.sqlite');
    let initialDatabase: Database.Database | undefined = new Database(
      databasePath,
      { timeout: 0 }
    );
    let restartedDatabase: Database.Database | undefined;
    t.after(async () => {
      if (restartedDatabase?.open === true) restartedDatabase.close();
      if (initialDatabase?.open === true) initialDatabase.close();
      await rm(directory, { recursive: true, force: true });
    });
    claimSqliteProcessOwnership(initialDatabase, databasePath);
    const initialRepository = new SqliteStrategyRepository(initialDatabase);
    const strategyId = initialRepository.createPending(recoveryPreflight()).id;
    assert.equal(initialRepository.claimForExecution(strategyId), true);
    const [spotMarket, contractMarket] =
      initialRepository.planOrdersAtomically(strategyId, [
        {
          role: 'SPOT_MARKET',
          request: recoveryRequest(strategyId, 'SPOT_MARKET', '1')
        },
        {
          role: 'CONTRACT_MARKET',
          request: recoveryRequest(strategyId, 'CONTRACT_MARKET', '1')
        }
      ]);
    assert.ok(spotMarket);
    assert.ok(contractMarket);
    initialRepository.attachOrderSnapshot(spotMarket.id, snapshot(
      strategyId,
      'SPOT_MARKET',
      {
        exchangeOrderId: 'spot-market-restart',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '1',
        remainingBaseQuantity: '0',
        averagePrice: '60000',
        status: 'closed'
      }
    ));
    initialRepository.attachOrderSnapshot(contractMarket.id, snapshot(
      strategyId,
      'CONTRACT_MARKET',
      {
        exchangeOrderId: 'contract-market-restart',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '0.6',
        remainingBaseQuantity: '0.4',
        averagePrice: '60010',
        status: 'closed'
      }
    ));
    const gtc = initialRepository.planOrder(
      strategyId,
      'CONTRACT_HEDGE_GTC',
      recoveryRequest(strategyId, 'CONTRACT_HEDGE_GTC', '0.4')
    );
    initialRepository.attachOrderSnapshot(gtc.id, snapshot(
      strategyId,
      'CONTRACT_HEDGE_GTC',
      {
        exchangeOrderId: 'contract-gtc-restart',
        requestedBaseQuantity: '0.4',
        filledBaseQuantity: '0',
        remainingBaseQuantity: '0.4',
        averagePrice: null,
        status: 'open'
      }
    ));
    assert.equal(initialRepository.transition(
      strategyId,
      ['EXECUTING'],
      'WAITING_HEDGE'
    ), true);
    initialDatabase.close();
    initialDatabase = undefined;

    restartedDatabase = new Database(databasePath, { timeout: 0 });
    claimSqliteProcessOwnership(restartedDatabase, databasePath);
    const restartedRepository = new SqliteStrategyRepository(
      restartedDatabase
    );
    const restartedSpot = new FakeExchangeGateway('bitget');
    const restartedContract = new FakeExchangeGateway('okx');
    restartedSpot.markets.set(`spot:${SYMBOL}`, market('bitget', 'spot'));
    restartedContract.markets.set(
      `swap:${SYMBOL}`,
      market('okx', 'swap')
    );
    restartedSpot.fetchResults.set('spot-market-restart', [snapshot(
      strategyId,
      'SPOT_MARKET',
      {
        exchangeOrderId: 'spot-market-restart',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '1',
        remainingBaseQuantity: '0',
        averagePrice: '60000',
        status: 'closed'
      }
    )]);
    restartedContract.fetchResults.set('contract-market-restart', [snapshot(
      strategyId,
      'CONTRACT_MARKET',
      {
        exchangeOrderId: 'contract-market-restart',
        requestedBaseQuantity: '1',
        filledBaseQuantity: '0.6',
        remainingBaseQuantity: '0.4',
        averagePrice: '60010',
        status: 'closed'
      }
    )]);
    if (testCase.remote !== null) {
      restartedContract.fetchResults.set('contract-gtc-restart', [snapshot(
        strategyId,
        'CONTRACT_HEDGE_GTC',
        {
          exchangeOrderId: 'contract-gtc-restart',
          requestedBaseQuantity: '0.4',
          updatedAt: '2026-09-05T00:02:00.000Z',
          ...testCase.remote
        }
      )]);
    }
    const registry = new ExchangeRegistry(new Map([
      ['bitget', restartedSpot],
      ['okx', restartedContract]
    ]));
    const restartedTradeEvents: TradeEvent[] = [];
    const reconciliation = new HedgeReconciliation(
      registry,
      restartedRepository,
      {
        record(event): void {
          restartedTradeEvents.push(structuredClone(event));
        }
      }
    );
    const coordinator = new HedgeCoordinator(
      registry,
      restartedRepository,
      reconciliation
    );
    const monitor = new OrderMonitor(
      restartedRepository,
      coordinator
    );

    await monitor.recover();

    const persisted = restartedRepository.getStrategy(strategyId);
    assert.equal(persisted.state, testCase.expectedState);
    assert.equal(persisted.failureCode, testCase.expectedFailureCode);
    assert.equal(restartedSpot.createdRequests.length, 0);
    assert.equal(restartedContract.createdRequests.length, 0);
    assert.equal(
      restartedRepository.listOrderEvents(gtc.id).length,
      testCase.expectedGtcEvents
    );
    assert.equal(
      restartedTradeEvents.filter(
        ({ event }) => event === 'order_terminal'
      ).length,
      testCase.expectedTerminalEvents
    );
  });
}
```

- [x] **Step 3: 运行监控与验收测试并确认旧实现失败**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test dist/tests/strategy/order-monitor.test.js dist/tests/acceptance/hedge-opening.test.js
```

Expected: FAIL；首先出现新 constructor 参数不匹配。该轮只锁定公共边界，不把编译失败当成转发行为证据。

- [x] **Step 4: 建立可编译、无业务判定的 monitor 骨架并确认行为变红**

保留 `ExecutionContinuation` 接口、activeReconciliations、activeRecovery、start/stop 和逐策略 catch。构造器改为：

```ts
constructor(
  private readonly repository: StrategyRepository,
  private readonly executionContinuation: ExecutionContinuation,
  operationalLog?: OperationalLog
) {
  this.operationalLog = nonThrowingOperationalLog(operationalLog);
}
```

删除 registry、gateway lookup、Decimal、request/snapshot validation、trade events、operation owner、classify 和 transition helpers。先让单策略入口固定无副作用返回：

```ts
private async reconcileStrategyOwned(_strategyId: string): Promise<void> {}
```

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build && PATH=/usr/local/bin:$PATH node --test --test-name-pattern='deduplicates concurrent|forwards every|isolates one|logging failures' dist/tests/strategy/order-monitor.test.js
```

Expected: FAIL；编译成功，但 continuation 调用数组为空。不能接受构造器、import 或 fixture 错误作为这一轮红灯。

- [x] **Step 5: 让单策略入口只转发给协调器**

把骨架替换为唯一业务动作：

```ts
private async reconcileStrategyOwned(strategyId: string): Promise<void> {
  await this.executionContinuation.confirmAndExecute(strategyId);
}
```

monitor 不自己持锁，因为 coordinator 必须在同一把锁内完成 `run -> 授权 -> submit -> run`。

- [x] **Step 6: 更新 main 装配且保持 HTTP 表面不变**

保留 Task 1 已建立的 `database open -> claimSqliteProcessOwnership -> repository -> gateway` 顺序；不得因注入 reconciliation 把 gateway、monitor 或 server 移到 claim 之前。在 repository 和 registry 都已构造后按唯一顺序构造：

```ts
const reconciliation = new HedgeReconciliation(
  registry,
  repository,
  tradeEvents,
  operationalLog
);
const coordinator = new HedgeCoordinator(
  registry,
  repository,
  reconciliation,
  tradeEvents,
  operationalLog
);
const monitor = new OrderMonitor(
  repository,
  coordinator,
  operationalLog
);
```

HTTP 内部字段边界已由 Task 6 的 response 断言锁定。把 `tests/main.test.ts` 原来的 `composition shares one safe injected trade sink with coordinator and monitor` 替换为：

```ts
test('composition shares one safe trade sink with submission and evidence owners', async (t) => {
  const tradeEvents = { record(): void {} };
  const composition = composeService({
    env: VALID_ENV,
    gatewayFactory: (exchangeId) => new FakeExchangeGateway(exchangeId),
    databaseFactory: () => new Database(':memory:'),
    tradeEvents,
    logger: false
  });
  t.after(async () => {
    await composition.server.close();
    composition.database.close();
  });

  const coordinatorSink = Reflect.get(
    composition.coordinator,
    'tradeEvents'
  );
  const reconciliation = Reflect.get(
    composition.coordinator,
    'reconciliation'
  ) as object;
  const evidence = Reflect.get(reconciliation, 'evidence') as object;
  const evidenceSink = Reflect.get(evidence, 'tradeEvents');

  assert.equal(coordinatorSink, evidenceSink);
  assert.notEqual(coordinatorSink, tradeEvents);
  assert.equal(Reflect.has(composition.monitor, 'tradeEvents'), false);
  assert.equal(Reflect.has(composition.monitor, 'registry'), false);
});
```

Task 1 的两个完整 `composeService` 竞争测试保持原断言，并在 Step 7 的目标命令中重跑；它们继续证明第二实例在 gateway 构造、恢复和监听之前失败。

- [x] **Step 7: 跑目标测试、静态所有权检查与全套回归**

Run:

```bash
PATH=/usr/local/bin:$PATH npm run build
PATH=/usr/local/bin:$PATH node --test dist/tests/storage/sqlite-process-owner.test.js dist/tests/strategy/order-monitor.test.js dist/tests/main.test.js dist/tests/http/server.test.js dist/tests/acceptance/hedge-opening.test.js
```

Expected: 两条命令都退出 `0`，所有目标测试 PASS。

Run:

```bash
test "$(rg -l '\.transition\(' src/strategy --glob '*.ts')" = 'src/strategy/hedge-reconciliation.ts'
test "$(rg -l 'attachOrderSnapshot\(' src/strategy --glob '*.ts')" = 'src/strategy/hedge-reconciliation-evidence.ts'
test "$(rg -l '\.createOrder\(' src/strategy --glob '*.ts')" = 'src/strategy/hedge-coordinator.ts'
test "$(rg -l 'claimSqliteProcessOwnership\(' src/main.ts)" = 'src/main.ts'
! rg -n 'finishHedge|reconcileStrategyOnce|transitionTerminal|transitionIncomplete' src/strategy/hedge-coordinator.ts src/strategy/order-monitor.ts
```

Expected: 五条静态命令都退出 `0`；策略层所有 production transition 只在 reconciliation，查所快照 attach 只在 evidence collector，`createOrder` 只在 coordinator，生产组合仍显式 claim SQLite，旧判定 helper 无匹配。

Run:

```bash
PATH=/usr/local/bin:$PATH npm test
```

Expected: PASS；退出码 `0`。输出不得包含真实网络请求、真实数据库路径或凭证。

- [x] **Step 8: 提交恢复链路收口**

```bash
git add src/strategy/order-monitor.ts src/main.ts tests/strategy/hedge-coordinator.test.ts tests/strategy/order-monitor.test.ts tests/main.test.ts tests/acceptance/hedge-opening.test.ts
git commit -m "refactor: route hedge recovery through reconciliation"
```

---

## 审查后实施修订

以下修订是任务内 TDD 与风险审查形成的最终实施约束；它们覆盖前文代码草图中更窄或不完整的历史表达：

- Task 1：配置数据库路径去除首尾空白后再用于目录和连接；SQLite 竞争错误只接受 `SQLITE_BUSY`、`SQLITE_LOCKED` 或其下划线分隔的扩展码族，拒绝相似前缀。
- Task 2：新建与迁移后的 `strategy_orders` 都校验完整规范 DDL；迁移还精确校验证据触发器、父外键和 SQL 字面量语义，任何伪装或不完整约束均失败关闭。
- Task 4：每次查所后的决定都使用同步重读的本地订单；只有类型化校验或 CAS 失败映射到闭集 pending 原因，确定未提交与远端证据矛盾时携带安全标量诊断。
- Task 5：GTC `unknown` 在市价失败、后续结构校验和精确资源限制之前保持 pending；GTC rejected 零成交和 definite-null 仍保留更强的确定性。结论日志记录实际持久化状态和失败码，精确计算成功前不写金额字段。
- Task 6：协调器在同一把 operation lock 内执行 `run -> 当次授权 -> submit -> run`，只消费本轮授权；明确未提交与不确定提交分别持久化，且不直接写受控状态或附加交易所快照。
- Task 7：监控器只负责调度、去重和失败隔离，所有可恢复策略统一转发给协调器；文件 SQLite 重启矩阵验证已有 GTC 的终态、拒单、部分撤单和查回 pending，且 fake gateway 零新提交。

## 规格覆盖索引

| 已批准规格 | 实现任务 | 验证证据 |
| --- | --- | --- |
| §2、§3.1 SQLite 单进程所有权 | Task 1 | 真实子进程竞争、正常关闭/`SIGKILL` 接管、启动顺序与 README |
| §3 模块入口、返回联合、pending | Tasks 4、5、6 | 入口状态、run-first、诊断和旧授权测试 |
| §4 提交结论、查所、幂等事件 | Tasks 2、4 | v1 迁移、证据 CAS、partial lookup、事件计数 |
| §5 固定 fail-fast 顺序 | Tasks 4、5 | 非法拓扑零 gateway 调用、查询失败不落后续表 |
| §6 合法角色拓扑 | Task 4 | 全部非法集合表驱动测试 |
| §7 两种残差、GTC、可交易性 | Task 5 | `1/0.6/0.4/0.1/0.3`、精度和边界矩阵 |
| §8 顺序/并发无 GTC 表 | Task 5 | rejected、definite、双零、等量、缺均价和残差测试 |
| §9 协调器、监控器、恢复 | Tasks 6、7 | 当次授权、守卫、重启临时库和零 create 测试 |
| §10 失败码与可观察性 | Tasks 2、3、4、5、6 | schema 迁移、warning allowlist、结论日志 |
| §11 测试要求 | Tasks 1 至 7 | 每任务红绿命令和最终 `npm test` |
| §12 完成条件 | Tasks 1、7 | SQLite 排他、状态写入所有权静态检查与完整回归 |

## 最终验证门

实现执行完所有任务后，主代理必须依次使用 `pre-verification-check`、`verification-before-completion`、`consistency-check` 和 `post-verification-check`。验证必须记录精确命令、退出码和关键输出；任何失败先使用 `systematic-debugging` 定位，不得删除或放宽资金安全断言。确认所有任务复选框、提交和批准规格一致后，才能宣告实现完成。
