# Precise Error Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make startup, HTTP, logs, status responses, browser UI, and operator documentation expose the same precise safe error semantics produced by Plans 1-3.

**Architecture:** Convert unknown failures once at their owning boundary, map trusted `TradeOpsError` details to fixed HTTP statuses, log only allowlisted projections, and render the new response/status contract directly. Delete the old generic public-error serializer and all browser compatibility parsing.

**Tech Stack:** TypeScript ESM, Fastify 5, Pino 10, browser JavaScript, Node.js built-in test runner.

## Global Constraints

- Requires completed Plans 1-3.
- Approved design: `docs/superpowers/specs/2026-08-09-ordered-workflows-and-precise-errors-design.md`.
- HTTP/UI/SQLite/trade events never contain stack, cause, arbitrary third-party fields, raw CCXT payloads, credentials, headers, or complete environment objects.
- Internal stdout operational logs may include a sanitized type/stack, but their structured `errorDetail` must equal the trusted safe projection.
- Host/Origin rejection remains before body observation.
- Browser writes server-controlled text only through `textContent`.
- Do not preserve the old `{ code, message, error }` response or legacy browser fallback.
- Never read real `.env`, start a production gateway, contact exchanges, or open a business database.

---

## File Map

- Modify `src/config/exchange-credentials.ts` and `src/main.ts`: ordered precise startup errors.
- Modify `src/http/server.ts`: new envelope and status mapping.
- Delete `src/http/public-error.ts` and its old tests after equivalent safety coverage moves to the error/HTTP tests.
- Modify `src/logging/logger.ts` and `src/logging/trade-events.ts`: structured allowlisted projections.
- Modify `public/app.js` and `public/styles.css`: new HTTP/status error rendering.
- Modify main, HTTP, logging, browser, and acceptance tests.
- Modify `README.md`, `docs/usage/operator-guide.md`, and `docs/manual/feature_list.md` where current behavior is described.

### Task 1: Ordered Precise Startup

**Files:**
- Modify: `src/config/exchange-credentials.ts`
- Modify: `src/main.ts`
- Modify: `tests/config/environment-loader.test.ts`
- Modify: `tests/main.test.ts`

**Interfaces:**
- `loadRuntimeConfig(env, clock?)` throws only `TradeOpsError` for expected configuration failures.
- `composeService` passes `config.databasePath` to `SqliteStrategyRepository`.
- `run` converts construction, monitor start, listen, and shutdown failures at their exact component boundary.

- [ ] **Step 1: Add RED startup-order tests**

Instrument credential loading, database factory, gateway factory, monitor start, and listen. Require this order:

```text
TRADING_EXCHANGES
Bitget key/secret/password presence
OKX key/secret/password presence
TRADING_DATABASE_PATH
HOST
PORT
database open/schema check
gateway construction
component construction
monitor start
listen
```

Inject failure at every step and assert no later operation occurred. Credential actual values must be only `missing` or `present-but-invalid`; tests include secret substrings and assert they never appear in the error, logs, or JSON.

- [ ] **Step 2: Run RED**

Run main/config tests. Expected: generic `invalid FIELD configuration` and current composition order fail assertions.

- [ ] **Step 3: Implement precise startup boundaries**

Use `CONFIG_FIELD_MISSING`/`CONFIG_FIELD_INVALID` per field, `DATABASE_OPEN_FAILED`, `SERVICE_COMPONENT_FAILED`, and `SERVICE_LISTEN_FAILED` with configuration/database/exchange subjects. Preserve original causes only in memory. Ensure schema mismatch occurs before monitor recovery and listen.

- [ ] **Step 4: Verify and commit**

Run build, config, and main tests. Commit: `refactor(startup): fail fast with precise errors`.

### Task 2: New HTTP Error Envelope

**Files:**
- Modify: `src/http/server.ts`
- Delete: `src/http/public-error.ts`
- Delete/replace: `tests/http/public-error.test.ts`
- Modify: `tests/http/server.test.ts`

**Interfaces:**

```ts
interface ErrorResponse {
  readonly requestId: string;
  readonly error: ErrorDetail;
}

function statusFor(error: Readonly<ErrorDetail>): 400 | 403 | 404 | 409 | 422 | 500;
```

Mapping is exact: request body/field `400`; forbidden `403`; not found `404`; strategy-state and confirmation-invalidated failures `409`; initial business preflight failures `422`; storage/unexpected server failures `500`.

- [ ] **Step 1: Add RED response matrix**

For every error family assert exact status and exact envelope keys. Assert no top-level `code`/`message`, no nested old `{ type, code, message }`, and no stack/cause/arbitrary fields. Include hostile unknown errors and a throwing secret provider/logger.

Retain tests proving forbidden requests never observe attack payloads and failure logging does not alter the response.

- [ ] **Step 2: Run RED, implement one responder, verify GREEN**

Trusted `TradeOpsError` uses its detail. Unknown route errors become an `INVARIANT_VIOLATION` or boundary-specific storage/service error with `safeUnknownActual`; never use the unknown message. `rememberHttpError` stores the same detail for completion logging.

Delete `public-error.ts` only after its redaction/bounding/hostile-object guarantees are covered by `trade-ops-error.test.ts` and server tests.

- [ ] **Step 3: Verify and commit**

Run build and all HTTP tests. Commit: `feat(http): return precise error details`.

### Task 3: Structured Safe Logs and Trade Events

**Files:**
- Modify: `src/logging/logger.ts`
- Modify: `src/logging/trade-events.ts`
- Modify: `tests/logging/logger.test.ts`
- Modify: `tests/logging/trade-events.test.ts`
- Modify: `tests/http/server.test.ts`

**Interfaces:**
- Operational log fields may include `errorDetail: ErrorDetail` after validation/redaction.
- Order lifecycle failure events include `errorCode`, `errorPhase`, `errorSubject`, `expected`, and `actual`; they do not include `message` when the same information is already structured.

- [ ] **Step 1: Add RED allowlist tests**

Pass an `ErrorDetail` plus enumerable secrets, nested causes, headers, raw request/response, and getters. Assert JSON includes only the validated detail and existing allowlisted lifecycle fields. Assert configured secret substrings are replaced in every string as defense in depth.

- [ ] **Step 2: Run RED, update projections, verify GREEN**

Validate with `parseErrorDetail` before logging. Invalid details degrade to safe type/category fields and never throw. Preserve non-throwing logging wrappers and one HTTP completion event.

- [ ] **Step 3: Commit**

Commit: `refactor(logging): project precise safe errors`.

### Task 4: Browser and Status Diagnostics

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/http/server.test.ts`

**Interfaces:**
- Browser accepts only `{ requestId, error: ErrorDetail }` for failed HTTP responses.
- Status parser accepts `strategy.failure` and `orders[].issue` as exact structured values.
- UI renders message plus labeled phase, object, expected, actual, and request ID.

- [ ] **Step 1: Add RED browser contract tests**

Test preflight, confirmation, load, refresh, and exchange-list failures. Reject extra/missing error fields, invalid phases/subjects/values/timestamps, and old legacy envelopes. Accept only a bounded non-empty `message`; server/error-contract tests, not the UI, prove that it matches the structured fields. Test status rendering before and after simulated restart with `PREFLIGHT_INVALIDATED`, `FAILED`, `HEDGE_INCOMPLETE`, and an unresolved order issue.

Use hostile HTML/script strings in every safe string field and assert they remain literal text through `textContent`.

- [ ] **Step 2: Run RED**

Run HTTP/browser tests. Expected: current legacy parser and `failureCode` validation fail.

- [ ] **Step 3: Implement exact browser validation and rendering**

Mirror the server's closed phase/code/subject/value schema in framework-free validation, but do not recompute or reinterpret the Chinese business message. Reject malformed successful/status payloads without retaining actionable preview state.

Remove legacy JSON handling. Preserve current request locking, preview invalidation, risk acknowledgment, status topology checks, decimal exactness, and button state rules.

- [ ] **Step 4: Verify and commit**

Run build and HTTP tests. Commit: `feat(ui): show precise strategy and order errors`.

### Task 5: Operator Documentation and Full Acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/usage/operator-guide.md`
- Modify: `docs/manual/feature_list.md`
- Modify: `tests/acceptance/hedge-opening.test.ts`

- [ ] **Step 1: Update current contracts**

Document strict preflight order, synchronous confirmation revalidation, `PREFLIGHT_INVALIDATED`, per-order issues, new HTTP envelope, schema-version refusal, no old-database migration, and recovery error priority. Remove all references to `failureCode`, old generic messages, and idempotent terminal confirmation.

- [ ] **Step 2: Run full fake acceptance**

Run complete open/restart/status scenarios with fake gateways and temporary SQLite. Assert Chinese error messages and structured diagnostics survive restart without credentials or raw provider errors.

- [ ] **Step 3: Run required verification skills**

Use `pre-verification-check`, then run the available approved commands established by that skill. At minimum:

```bash
npm run build
npm test
git diff --check
rg -n "failureCode|failure_code|PublicErrorDetail|NoOrderSubmittedError|legacy JSON|legacy.*error" src public tests README.md docs/usage docs/manual
git status --short
```

Expected: build/tests/diff pass; legacy search has no behavior references; only user-owned unrelated changes remain outside the implementation diff.

Then use `verification-before-completion`, `consistency-check`, and `post-verification-check`. Cross-check the design, all four plans, source, tests, README, operator guide, and schema version.

- [ ] **Step 4: Commit documentation**

Commit: `docs: explain ordered checks and precise errors`.

## Plan 4 Completion Gate

No completion claim is allowed until the full fake-only suite passes and all four verification skills finish. Do not run `npm start`, read `.env`, instantiate production gateways, or access any exchange endpoint during verification.
