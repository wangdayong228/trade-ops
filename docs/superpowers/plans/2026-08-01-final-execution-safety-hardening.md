# Final Execution Safety Hardening Implementation Plan

> Implement one finding at a time with strict RED -> GREEN -> focused regression. Do not stage or commit changes.

**Goal:** Make execution and recovery conservative under partial fills, missing average prices, repository uncertainty, contract-setting drift, and pre-submission gateway failures.

**Architecture:** Extend the existing coordinator/monitor/gateway paths with topology-aware reconciliation, tri-state read handling, repeated fresh-settings guards, and one typed pre-submission error. Keep the current persisted state model and deterministic order-role idempotency.

**Tech stack:** TypeScript, Decimal.js, CCXT, SQLite, Node.js built-in test runner, framework-free browser JavaScript.

## Global Constraints

- Preserve the current `package.json` test command and explicit test globs.
- Do not add settings-mutation calls or live exchange/network tests.
- Do not stage or commit.
- Keep actual exchange `createOrder` exceptions lookup-only and recoverable.
- Keep flat OKX hedged accounts fail-closed.
- Run each RED test before its production change and record the expected failure.

## Finding 1: Positive/Zero Concurrent Terminal Topology

**Files:**

- Modify: `tests/strategy/hedge-coordinator.test.ts`
- Modify: `tests/strategy/order-monitor.test.ts`
- Modify: `src/strategy/hedge-coordinator.ts`
- Modify: `src/strategy/order-monitor.ts`
- Modify: `README.md`
- Modify: `docs/manual/feature_list.md` if it describes concurrent reconciliation

- [x] Add direct coordinator tests for reliable terminal positive/zero and zero/positive market fills. Assert one exact full-difference GTC on the zero side at the larger side's average.
- [x] Add `closed`/`canceled` combinations and preserve the both-zero `FAILED` assertion.
- [x] Run the focused coordinator tests and verify RED because current reconciliation returns `HEDGE_INCOMPLETE`.
- [x] Update coordinator reconciliation so only both-zero fails and all unequal fills derive one difference GTC.
- [x] Run the focused coordinator tests and verify GREEN.
- [x] Add restart monitor tests proving the terminal positive/zero topology stays eligible for continuation and creates exactly one GTC.
- [x] Run monitor tests and verify RED.
- [x] Update the monitor classification/continuation gate and verify GREEN.
- [x] Update operator-facing concurrent behavior documentation.
- [x] Run coordinator and monitor suites before starting finding 2.

## Finding 2: Topology-Dependent Concurrent Average Prices

**Files:**

- Modify: `tests/strategy/hedge-coordinator.test.ts`
- Modify: `tests/strategy/order-monitor.test.ts`
- Modify: `tests/http/server.test.ts` or the existing browser-script test file
- Modify: `src/strategy/hedge-coordinator.ts`
- Modify: `src/strategy/order-monitor.ts` if its trust predicate requires averages
- Modify: `public/app.js`

- [x] Add coordinator tests: equal positive with both averages null => `HEDGED`; unequal with smaller average null => exact GTC; unequal with larger average null => `HEDGE_INCOMPLETE` and no GTC.
- [x] Run focused tests and verify RED.
- [x] Move average validation after fill comparison and require only the larger side's average for unequal fills. Verify GREEN.
- [x] Add restart/monitor equivalents, including canceled-positive snapshots, and verify current failures.
- [x] Align monitor continuation behavior and verify GREEN.
- [x] Add browser trust tests for equal-null averages and unequal topologies with a zero/null smaller side; retain rejection when the larger average is missing.
- [x] Replace the browser's per-market average requirement with topology-aware validation and verify GREEN.
- [x] Run coordinator, monitor, and HTTP/browser suites before starting finding 3.

## Finding 3: Repository Read Uncertainty After External Create

**Files:**

- Modify: `tests/strategy/hedge-coordinator.test.ts`
- Modify: `src/strategy/hedge-coordinator.ts`
- Modify: repository test doubles under `tests/support/` if needed

- [x] Add a valid direct create-result test where `listOrders` fails after the external side effect. Assert `EXECUTING`, persisted deterministic intent, recovery attachment, and exactly one market create.
- [x] Add the equivalent transient `getStrategy` failure case and a later successful recovery.
- [x] Retain/add malformed direct snapshot coverage proving invalid exchange data still terminalizes even if a repository read would fail.
- [x] Run focused tests and verify RED.
- [x] Validate candidate snapshots before repository reads and introduce an internal available/missing/unavailable execution-state result.
- [x] Preserve pending on unavailable reads; retain safe failure for definitive missing/corrupt topology.
- [x] Run focused and full coordinator/monitor tests before starting finding 4.

## Finding 4: Fresh Contract Account Settings Guard

**Files:**

- Modify: `tests/strategy/hedge-coordinator.test.ts`
- Modify: `tests/strategy/order-monitor.test.ts`
- Modify: `tests/exchanges/ccxt-gateway.test.ts`
- Modify: `tests/strategy/preflight-service.test.ts`
- Modify: `tests/support/fake-exchange-gateway.ts`
- Modify: `src/strategy/hedge-coordinator.ts`
- Modify: `src/exchanges/profiles/okx-profile.ts` only if needed to preserve explicit fail-closed behavior
- Modify: `README.md`

- [x] Add entry-guard tests for one-way, unknown, margin-mode drift, leverage drift, and fetch uncertainty before any new order.
- [x] Assert zero safely excluded exposure => `FAILED`; positive or planned/unknown/open uncertainty => `HEDGE_INCOMPLETE`; repository uncertainty remains `EXECUTING`.
- [x] Run focused tests and verify RED.
- [x] Implement decimal-equivalent confirmed-versus-fresh comparison and conservative exposure classification at execution entry.
- [x] Verify entry-guard tests GREEN.
- [x] Add a `SPOT_FIRST` test that changes settings after the spot market fill but before the contract GTC; assert no contract create and `HEDGE_INCOMPLETE`.
- [x] Add concurrent/per-role tests proving each genuinely new create is guarded while existing roles stay lookup-only.
- [x] Run focused tests and verify RED.
- [x] Add the immediate pre-create guard and verify GREEN.
- [x] Add Bitget/OKX profile/preflight coverage, especially flat OKX returning unknown mode/null leverage and being rejected without mutation.
- [x] Reject zero-contract OKX short placeholders and prove they remain fail-closed.
- [x] Move each new-role fresh guard before intent persistence and prove a transient second-leg settings failure later creates exactly one GTC without a stranded planned role.
- [x] Update README with the fresh guard and flat-OKX limitation.
- [x] Run exchange, preflight, coordinator, and monitor suites before starting finding 5.

## Finding 5: Typed No-Order-Submitted Boundary

**Files:**

- Modify: `src/exchanges/exchange-gateway.ts`
- Modify: `src/exchanges/ccxt-exchange-gateway.ts`
- Modify: `src/strategy/hedge-coordinator.ts`
- Modify: `tests/support/fake-exchange-gateway.ts`
- Modify: `tests/exchanges/ccxt-gateway.test.ts`
- Modify: `tests/strategy/hedge-coordinator.test.ts`

- [x] Add gateway tests proving market lookup, ticker, conversion, precision, minimum, and pre-call parameter failures throw `NoOrderSubmittedError` and never call the underlying exchange `createOrder`.
- [x] Add tests proving an underlying `createOrder` exception remains a generic uncertain error.
- [x] Run gateway tests and verify RED.
- [x] Export the safe typed error and separate gateway preparation from the actual exchange-call boundary. Verify GREEN.
- [x] Add coordinator coverage where a derived difference is below destination minimum and the typed failure terminalizes instead of remaining planned forever.
- [x] Retain/add uncertain network-create coverage proving lookup-only pending and no duplicate create.
- [x] Run focused tests and verify RED.
- [x] Teach the coordinator to handle the typed error using exposure certainty and verify GREEN.
- [x] Prioritize a concurrent typed failure over an uncertain companion and terminalize possible exposure without retrying either persisted role.
- [x] Return malformed direct `unknown` snapshot failures before lookup recovery can mask them.

## Final Verification

- [x] Run formatting/type build checks used by the repository.
- [x] Run all focused exchange, preflight, coordinator, monitor, HTTP/browser, storage, and acceptance tests.
- [x] Run `npm test` under Node.js 20.
- [x] Run `npm test` under Node.js 24 when available.
- [x] Inspect `git diff --check`, `git status --short`, and the complete diff for unintended changes.
- [x] Run the repository's required pre-verification, verification, consistency, and post-verification checks before reporting completion.
