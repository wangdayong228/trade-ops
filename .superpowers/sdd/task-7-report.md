# Task 7 Implementation Report

## Status

Implemented GTC monitoring, restart recovery, and non-overlapping scheduled
polling with a pure observation/persistence boundary.

Changed artifacts:

- `src/strategy/order-monitor.ts`
- `src/strategy/strategy-operation-owner.ts`
- `src/strategy/hedge-coordinator.ts`
- `tests/strategy/order-monitor.test.ts`
- `.superpowers/sdd/task-7-report.md`

The task plan and Task 7 brief checkboxes were not edited, as explicitly
requested.

## Implemented behavior

### Pure monitoring boundary

- `OrderMonitor` never creates, cancels, replaces, reprices, resubmits, or
  closes an order or position.
- A persisted order without an exchange order ID is looked up directly by its
  stable client order ID. The monitor never scans order history and never
  submits a missing leg.
- A persisted `open` or `unknown` order with an exchange order ID is refreshed
  with `fetchOrder`.
- Terminal order snapshots are read from persistence and are not fetched
  again.
- There is no local GTC expiry, timeout-based cancellation, or time-based state
  transition.

### Fetch-before-attach reconciliation

- Every required gateway read for one strategy is allowed to settle before any
  candidate snapshot is attached.
- A gateway, authentication, permission, network, or registry failure causes
  the complete round to return without a snapshot, event, or state transition.
- Every successful candidate is validated before the first attachment:
  exchange and order identity, stable exchange order ID, client ID, symbol,
  kind, type, side, requested quantity, status progression, monotonic fill,
  monotonic remaining quantity, canonical time, positive optional average
  price, and exact `requested = filled + remaining` conservation.
- Decimal lexical validation matches the repository boundary, including
  rejection of Decimal.js-only forms such as hexadecimal input.
- The persisted order set is reloaded and version-compared before attachment.
  A concurrent change ends the round without persistence.
- The repository has no multi-order transaction API. Therefore candidates are
  attached one at a time only after the complete read/validation gate. If an
  attachment still fails, the monitor stops and best-effort transitions the
  strategy to
  `HEDGE_INCOMPLETE/INCONSISTENT_ORDER_STATE`. It never continues to another
  external or persistence write.

### Exact exposure and state classification

- Exposure is calculated only from each persisted order's latest snapshot.
  Immutable event history is never replayed or cumulatively double-counted.
- Spot exposure includes persisted spot buys. Contract exposure includes
  persisted swap sells with `positionSide: SHORT`.
- Arithmetic uses a private Decimal constructor, dynamically sufficient exact
  precision, bounded exponent handling, and no ambient global Decimal
  configuration.
- GTC identity is role-based:
  `SPOT_HEDGE_GTC` and `CONTRACT_HEDGE_GTC`.
- Classification priority is:
  1. any canceled GTC becomes
     `HEDGE_INCOMPLETE/HEDGE_ORDER_CANCELED`;
  2. otherwise any rejected GTC becomes
     `HEDGE_INCOMPLETE/HEDGE_ORDER_REJECTED`;
  3. an unsafe nonterminal market order combined with known positive exposure
     becomes
     `HEDGE_INCOMPLETE/INCONSISTENT_ORDER_STATE`;
  4. an open GTC remains `WAITING_HEDGE`, including an `open` snapshot with
     zero remaining quantity;
  5. an unknown or not-yet-found GTC preserves `EXECUTING`, or remains
     `WAITING_HEDGE` if already waiting;
  6. only confirmed terminal/full required GTCs, confirmed market legs, two
     positive totals, and exact equality become `HEDGED`;
  7. terminal unequal exposure becomes
     `HEDGE_INCOMPLETE/INCONSISTENT_ORDER_STATE`.
- An `EXECUTING` strategy with no persisted orders, an incomplete persisted
  topology, a null direct lookup, or an unknown result is not guessed to be
  `FAILED`. The monitor never transitions any strategy to `FAILED`.
- `PENDING_CONFIRMATION` and every terminal strategy are no-ops.
- Persisted role/request identity is defensively revalidated against the
  strategy, including deterministic client ID, effective market quantity,
  exact spot/swap shape, confirmed swap margin mode, and `SHORT` side.

### Coordinator/monitor ownership

- Task 6's former module-local coordinator owner was moved to
  `strategy-operation-owner.ts`.
- Coordinator execution and monitor reconciliation now acquire the same
  process-wide, strategy-keyed owner.
- This prevents a monitor from marking an unequal concurrent strategy terminal
  while the active coordinator is between confirmed market fills and planning
  the persisted difference GTC.
- The owner has no timer or expiry and is always released in `finally`.
- Every state transition is preceded by a fresh state read. The boolean result
  of every transition is checked. If the strategy changed, the monitor stops
  without another write.
- The boundary is intentionally single-process, matching Task 6. A
  multi-process deployment still requires external serialization or a
  persistent ownership design.

### Recovery and scheduling

- `recover()` loads only repository-declared recoverable strategies and
  isolates each reconciliation so one throw cannot block later strategies.
- Concurrent calls on one monitor instance share the active recovery promise.
- `start(intervalMs)` accepts only positive safe integer intervals within the
  Node timer range (`1..2_147_483_647` milliseconds).
- Start performs one immediate recovery and installs one interval per monitor
  instance.
- Scheduled recovery rejections are caught without logging or retaining their
  raw cause, and later intervals continue running.
- Overlapping polling cycles share the active recovery instead of starting a
  second round.
- The returned stop function clears the interval idempotently. It does not
  abort an already in-flight read.

## TDD evidence

The initial RED was:

```text
TS2307: Cannot find module '../../src/strategy/order-monitor.js'
```

The first implementation made the original focused matrix green:

```text
tests 18
pass 18
fail 0
```

Subsequent safety self-review produced additional RED cases before their
production changes:

- an active concurrent coordinator could be overtaken by the monitor and the
  strategy became `HEDGE_INCOMPLETE` while difference-price quantization was
  blocked;
- canceled status on an extra GTC topology lost priority to
  `INCONSISTENT_ORDER_STATE`;
- rejected status on an extra GTC topology lost priority to
  `INCONSISTENT_ORDER_STATE`;
- Decimal.js accepted `0x0`, causing the first valid candidate to be attached
  before SQLite rejected the second candidate (`2` events observed instead of
  `1`);
- a persisted swap request carrying a margin mode different from the confirmed
  preflight mode was incorrectly classified `HEDGED`.

Each reproduced the unsafe result before its minimal production change and
passed afterward.

Final focused monitor suite:

```text
tests 24
pass 24
fail 0
```

Coordinator regression after sharing the owner:

```text
tests 51
pass 51
fail 0
```

Full development regression:

```text
tests 245
pass 245
fail 0
```

The full command was `npm test`, which includes the strict TypeScript build.

## Independent safety cross-check

- The candidate validator was cross-checked field by field against
  `SqliteStrategyRepository` snapshot validation and status-transition rules.
- A 150-digit exposure case plus a one-unit-at-the-last-decimal GTC was
  hand-constructed and remained exact after global Decimal precision,
  rounding, and exponent limits were deliberately polluted.
- Restart recovery was exercised by constructing a second
  `SqliteStrategyRepository` and a new `OrderMonitor` over the same in-memory
  SQLite database.
- The coordinator/monitor race test blocks the real coordinator at the
  difference-price quantization boundary and proves that the monitor performs
  no terminal transition while execution owns the strategy.
- All gateway behavior used fake gateways. All persistence used in-memory
  SQLite.

## Deliberate limits

- There is no repository API for one transaction spanning snapshot attachments
  for multiple orders. Complete fetch/validation prevents partial updates from
  read or candidate failures, but a repository failure on a later attachment
  can leave an earlier attachment durable. The strategy is then failed closed
  with the safe inconsistency code.
- A planned order that remains absent by direct client-ID lookup is preserved
  without local expiry. Operational intervention or later exchange visibility
  is required; the monitor does not guess absence or create a replacement.
- The shared owner coordinates only one Node.js process. It does not claim
  cross-process or distributed mutual exclusion.
- Verification used no network, real credentials, real database file, or live
  order endpoint.

## Independent review follow-up

### Restart recovery topology

The review found one valid restart-only gap. After both concurrent market
orders were confirmed with unequal positive fills, a crash could occur before
Task 6 persisted the difference GTC. A newly constructed monitor had no active
process owner and classified that recoverable `EXECUTING` topology as
`HEDGE_INCOMPLETE`, preventing a fresh coordinator from completing recovery.

The classification now preserves only this narrow precursor:

- the persisted state is `EXECUTING`;
- the strategy mode is `CONCURRENT`;
- both required market orders are confirmed;
- both sides have positive, unequal filled quantities; and
- no GTC order has been persisted.

The monitor remains observational and performs no exchange write. A restart
integration test constructs a new repository and monitor over the existing
database, verifies the strategy remains `EXECUTING`, then constructs another
new repository and coordinator. The coordinator creates exactly one `0.1`
contract GTC and transitions to `WAITING_HEDGE`; a second fresh coordinator
does not resubmit it.

Related missing-GTC topologies that the coordinator can still continue are
also characterized as `EXECUTING`: either sequential first leg only, one
concurrent market order only, and no concurrent orders yet. The exception does
not apply when a GTC exists. Existing extra, canceled, and rejected GTC safety
tests remain unchanged, and a new malformed persisted-GTC case still fails
closed as `HEDGE_INCOMPLETE / INCONSISTENT_ORDER_STATE`.

### Partial attachment persistence

The requested half-write regression was already handled correctly by the
implementation and was therefore GREEN immediately. With three validated
candidates, a successful first attachment and a failing second attachment:

- the first snapshot and event remain durable;
- the second and third orders remain unchanged;
- no third attachment, terminal success transition, or gateway write occurs;
  and
- the strategy fails closed as
  `HEDGE_INCOMPLETE / INCONSISTENT_ORDER_STATE`.

### Follow-up TDD and verification evidence

The restart test first failed with actual `HEDGE_INCOMPLETE` where
`EXECUTING` was expected. The partial-attachment characterization passed
before any production change. After the narrow classification fix:

```text
focused review cases
pass 2
fail 0

monitor suite
tests 28
pass 28
fail 0

coordinator suite
tests 51
pass 51
fail 0

full development regression
tests 249
pass 249
fail 0
```

The full command remains `npm test`, including the strict TypeScript build.
No network, real credentials, real database file, or live order endpoint was
used.
