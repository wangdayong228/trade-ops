# Final Execution Safety Hardening Design

Date: 2026-08-01

Status: Approved

## 1. Goal

Close the final execution-safety gaps in concurrent reconciliation, restart recovery, account-setting drift detection, and exchange submission certainty without adding new persisted strategy states or changing the supported workflow.

The implementation must preserve deterministic order-role idempotency, never create a second external order after an uncertain first submission, and never invent contract account settings.

## 2. Scope

This change covers five implementation findings:

1. A reliable terminal concurrent market topology with one positive fill and one zero fill creates a full-difference GTC order on the zero side. Only a both-zero topology fails without a hedge order.
2. Concurrent average-price requirements depend on the topology: equal positive fills need no average price; unequal fills require only the larger side's average price.
3. Transient repository reads after an external create preserve `EXECUTING` and the persisted intent for recovery. Definitive missing or corrupt data still fails safely.
4. The coordinator re-reads contract account settings before execution/recovery and immediately before every new external create. It never changes those settings.
5. The gateway distinguishes failures that occurred before the external `createOrder` call from failures whose side effect is uncertain.

OKX flat hedged accounts remain fail-closed. With no unambiguous existing short position, the gateway reports unknown margin mode and leverage instead of choosing a default.

## 3. Concurrent Reconciliation Rules

A concurrent topology is complete only when both market roles exist and both snapshots are reliable terminal snapshots (`closed`, or `canceled` with a reliable cumulative fill).

Let `S` be the spot market base fill and `C` be the contract market base fill:

- `S = 0` and `C = 0`: transition to `FAILED`; do not create a GTC order.
- `S = C > 0`: transition to `HEDGED`; neither market average price is required.
- `S > C`: create one contract GTC short for `S - C` at the spot market average price. The contract market average may be absent, including when `C = 0`.
- `C > S`: create one spot GTC buy for `C - S` at the contract market average price. The spot market average may be absent, including when `S = 0`.
- If the required larger-side average is unavailable, transition to `HEDGE_INCOMPLETE`; do not guess a price.

The coordinator, monitor continuation gate, and browser topology validator must implement the same rules for `closed` and `canceled` terminal snapshots.

## 4. Repository Read Certainty

Repository observations used after a possible or confirmed external side effect are classified as:

- available and valid;
- definitively missing or corrupt;
- temporarily unavailable.

The coordinator validates a newly returned exchange snapshot before performing repository reads. This prevents a transient repository failure from hiding a malformed exchange response.

After a valid external result:

- temporary `listOrders` or `getStrategy` failure returns a pending submission outcome and preserves `EXECUTING`;
- a later recovery lookup attaches the same deterministic order role and continues without another market create;
- definitive missing role/intent or corrupt persisted topology follows the existing safe terminal failure path.

Repository uncertainty must never be converted into a false claim that no exposure exists.

## 5. Fresh Contract Account Settings Guard

The confirmed preflight settings are an immutable execution contract. Before execution or lookup-only recovery, and immediately before every new external `createOrder`, the coordinator fetches current contract account settings and compares:

- position mode is `hedged`;
- margin mode exactly matches the confirmed `isolated` or `cross` value;
- leverage is positive and decimal-equivalent to the confirmed leverage.

The repeated pre-create guard is required even within a single sequential execution, so a `SPOT_FIRST` flow cannot create the contract GTC after settings drift between the spot market fill and the second order.

For a genuinely new role, the fresh guard completes before the deterministic intent is persisted. A temporary settings-read failure therefore leaves no definitely-unsubmitted `planned` role that restart recovery would be forced to query forever. In concurrent mode, both per-role guards complete before either intent is persisted or either create begins.

Existing roles are recovered by lookup only. The guard must not reinterpret lookup-only recovery as permission to create a replacement order.

Fresh settings fetch failures and repository read uncertainty are recoverable: preserve `EXECUTING` and return pending. A confirmed drift or invalid setting terminalizes according to exposure certainty:

- `FAILED` only when no relevant order exists, or every relevant order is a reliable terminal zero-fill and exposure is therefore excluded;
- `HEDGE_INCOMPLETE` when any positive fill exists, or any `planned`, `unknown`, `open`, or otherwise uncertain intent means an external side effect cannot be excluded.

No code path calls exchange APIs that change margin mode, position mode, or leverage.

### 5.1 OKX Flat Account Limitation

OKX uses per-order `tdMode` and requires a margin-mode input for leverage queries. A flat account has no unique current margin mode that can safely be inferred. Therefore, when no unambiguous existing short position with a finite positive contract quantity supplies current margin mode and leverage, the OKX profile returns `marginMode: unknown` and `leverage: null`; empty position lists and zero-contract placeholder rows are both flat. Preflight and fresh execution guards reject the account. The service does not default to cross or isolated.

## 6. Submission Boundary

The normalized gateway exports a typed `NoOrderSubmittedError` with a fixed safe message. The CCXT gateway wraps every failure before calling the underlying exchange `createOrder` method in this type, including market lookup, ticker/reference-price acquisition, amount conversion, precision rounding, minimum checks, and parameter construction.

Exceptions thrown by the underlying exchange `createOrder` call, and failures while normalizing its response, remain generic uncertain-submission failures because the external side effect may have occurred.

Coordinator behavior:

- `NoOrderSubmittedError`: no lookup loop is needed; terminalize using the current exposure-certainty rules.
- any uncertain create error: keep the deterministic intent in `EXECUTING`, perform lookup-only recovery, and never retry-create that role.

For concurrent creates, a typed definite failure takes priority over a pending uncertain companion. The uncertain companion means exposure cannot be excluded, so the strategy enters `HEDGE_INCOMPLETE` instead of leaving the definitely unsubmitted role in an impossible lookup loop. A malformed direct `unknown` snapshot also returns its validation failure immediately; lookup recovery cannot mask invalid exchange evidence.

The derived GTC difference being below the destination market minimum is an explicit no-order-submitted case.

## 7. State and Data Flow

No new database schema, strategy state, or public API field is introduced.

```text
confirm / restart continuation
    -> safely load strategy and order intents
    -> acquire existing operation owner
    -> fresh contract settings guard
    -> reconcile existing roles by lookup only
    -> before each genuinely new role: fresh settings guard again
    -> persist deterministic intent
    -> gateway preparation
         -> typed no-order-submitted failure, or
         -> exchange createOrder boundary
    -> validate snapshot
    -> attach snapshot, or preserve pending on repository uncertainty
    -> reconcile terminal topology
```

## 8. UI Trust Boundary

The browser validates status payload topology independently of display formatting:

- equal positive concurrent market fills may be trusted as `HEDGED` with null averages;
- an unequal concurrent topology requires the larger side's positive average and an exact difference hedge on the smaller side;
- the smaller side may have zero fill and null average;
- sequential derived hedges still require the first market leg's positive average;
- contradictory roles, sides, quantities, or states remain untrusted.

## 9. Verification

Each finding is implemented strictly test-first and completed before starting the next:

1. direct coordinator and restart/monitor tests for positive/zero, both-zero, and canceled variants;
2. coordinator, monitor, and UI tests for topology-dependent average requirements;
3. valid external result plus transient `listOrders`/`getStrategy` failure, recovery, and no duplicate create;
4. Bitget/OKX/fake-gateway fresh-setting, drift, uncertainty, sequential inter-leg drift, and flat-OKX tests;
5. gateway boundary and coordinator tests for too-small derived differences versus uncertain exchange-create errors.

After focused tests, run the existing full build/test command without changing its explicit cross-version test-discovery glob. Run the suite on Node.js 20 and Node.js 24 when both runtimes are available.
