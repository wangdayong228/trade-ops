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

No unresolved concern was identified in the original implementation pass;
the independent review below superseded that conclusion.

## Independent Review Follow-up

All independent-review findings were reproduced and fixed with regression
tests:

1. Every request now rejects a missing, malformed, userinfo-bearing, or
   non-loopback `Host` before API or static route work. Only `localhost`,
   `127.0.0.1`, and `[::1]`, with an optional valid port, are accepted.
   Forwarded host headers cannot replace `Host`.
2. State-changing `POST` requests accept a missing `Origin` for local CLI use,
   but an included origin must be HTTP(S), loopback, and exactly match the
   request host and effective port. `Origin: null`, cross-origin values, and
   `Sec-Fetch-Site: cross-site` are rejected with a fixed 403 body.
3. Confirmation queues both `PENDING_CONFIRMATION` and recoverable
   `EXECUTING` strategies through the same per-strategy deduplication set.
   Terminal strategies remain idempotent 202 responses without coordinator
   work. A real coordinator/repository/fake-gateway recovery test proves that
   an observed existing intent is reconciled without duplicate creation.
4. Fastify validation explicitly disables AJV type coercion while retaining
   `removeAdditional: false`. Runtime numbers, booleans, arrays, and objects
   are rejected for string fields, and non-boolean acknowledgement values are
   rejected before application services run.
5. The browser script validates the complete actionable/rendered response
   shape before rendering, and renders before retaining a strategy ID or
   enabling confirmation. Parse, shape, or render failures clear the preview,
   acknowledgement, strategy ID, and action controls. Node VM/DOM tests cover
   malformed 201 responses, stale delayed responses after input edits, and
   confirmation double clicks. External values continue to use DOM
   `textContent`; no `innerHTML` was introduced.

Review RED evidence included hostile hosts/origins returning success instead
of 403, `EXECUTING` confirmation performing zero recovery attempts, a numeric
string field being coerced and reaching a 500 path, and malformed 201 browser
responses leaving a partial preview (`"1"` instead of `"—"`).

Review GREEN:

```text
npm run build && node --test dist/tests/http/server.test.js
tests 28
pass 28
fail 0

npm test
tests 277
pass 277
fail 0

node --check public/app.js
exit 0

git diff --check
exit 0
```

No network request or live exchange order was used in this follow-up.

### Task 9 Composition-Root Handoff

Task 9 must bind the Fastify listener only to a validated loopback address
(for example `127.0.0.1` or `::1`), never `0.0.0.0` or another externally
reachable interface. The risk checkbox is only an explicit acknowledgement
gate; it is not authentication, user identity, or proof that a human performed
the confirmation.
