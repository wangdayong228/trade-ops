# Task 8 Report: Fastify API and Explicit Operator UI

## Outcome

Implemented the operator-confirmed hedge-opening HTTP surface and static UI.
All tests use Fastify injection, in-memory SQLite, and fake gateways. No
network request or live exchange order was used.

## Delivered

- `buildServer(dependencies)` with:
  - `GET /api/exchanges`
  - `POST /api/hedges/preflight`
  - `POST /api/hedges/:id/confirm`
  - `GET /api/hedges/:id`
  - static serving for `public/`
- Exact five-field preflight schema with bounded strings, fixed mode enum,
  and `additionalProperties: false`.
- Exact confirmation body `{ "riskAcknowledged": true }`; missing, false, or
  additional fields fail before coordinator execution.
- Typed strategy-not-found errors and fixed, non-leaking HTTP error bodies.
- Per-strategy in-process confirmation deduplication, `setImmediate`
  execution, caught background rejections, and close-time task draining.
- Public-only preflight, strategy, order, and latest-snapshot status
  serialization.
- Private high-precision Decimal aggregation of actual spot buys, actual swap
  shorts, and absolute unmatched base quantity without replaying events.
- Logger redaction for authorization, cookie, direct secret fields, and common
  nested credential paths.
- CSP, anti-framing/content-sniffing headers, API `no-store`, and static
  `no-cache`.
- Framework-free operator page with explicit mode selection, separate
  preflight/confirm actions, exact risk acknowledgement copy, complete preview
  and status rendering, multiple order ID lists, and no credential inputs.
- Input-revision guards so stale preflight, confirmation, or status responses
  cannot restore an invalidated preview.
- DOM-only external-value rendering through `textContent`/element APIs; no
  `innerHTML`.

## TDD Evidence

Initial RED:

```text
npm run build
TS2307: Cannot find module '../../src/http/server.js'
TS2305: no exported member 'StrategyNotFoundError'
```

Focused GREEN:

```text
npm run build && node --test dist/tests/http/server.test.js
tests 16
pass 16
fail 0
```

Full GREEN:

```text
npm test
tests 265
pass 265
fail 0
```

Additional checks:

```text
node --check public/app.js
exit 0
```

The actual verification runtime was Node.js `v20.19.4`; the approved project
plan names Node.js 24 LTS as the target runtime.

## High-Risk Coverage

- Secret/extra/malformed/oversized preflight payloads never reach preflight.
- Invalid risk acknowledgements never reach the coordinator.
- Two concurrent HTTP confirmations compose the real coordinator, in-memory
  repository, and fake gateways and create each fake exchange order once.
- Terminal confirmation is idempotent and does not start new execution.
- Background rejection is caught without an unhandled rejection or raw error
  response, and server close waits for queued work.
- A hand-calculated 40-decimal status case proves exact latest-snapshot totals
  and an unmatched quantity of
  `0.0000000000000000000000000000000000000002`.
- Planned orders report zero fills.
- Tampered repository reads return fixed safe HTTP 500 responses.

## Self-Review

The affected-path review traced browser input through schema validation,
preflight, persistence, confirmation ownership, coordinator side effects,
latest order snapshots, status serialization, and DOM rendering.

Two issues were found and corrected during review:

1. Stale asynchronous browser responses could restore a preview after input
   invalidation. Revision tokens now suppress stale preflight, confirmation,
   and status results.
2. The public quantity field inherited the storage layer's 10,000-character
   allowance. The HTTP and UI boundary is now capped at 256 characters while
   persisted high-precision status values retain their existing safety limits.

No unresolved Task 8 implementation concern remains.
