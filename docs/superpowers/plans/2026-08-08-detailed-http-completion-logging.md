# Detailed HTTP Completion Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit exactly one status-aware `request completed` log per completed request; every final `4xx/5xx` includes a redacted `httpError` and best-effort `httpRequest` snapshot with method, full query-bearing request URL, and body, while successful requests remain unchanged.

**Architecture:** Disable Fastify automatic completion logging and emit the sole completion line from `onResponse`. Reject invalid Host/Origin in `onRequest` before any body observation/parser, with early-`403` body `null`. For accepted requests, keep request-local error and raw-body state under an independent fixed `1 MiB` capture budget, explicitly set Fastify's global `bodyLimit` to `1 MiB`, release raw bytes as soon as parsed body is available, and never let a larger route-level body limit expand capture. Construct failure snapshots only for final failures; if an invalid body exceeded capture budget, use `[Unavailable]` rather than a prefix so complete redaction precedes the separate UTF-8-safe `8192`-byte final log limit. Route output through one non-throwing logger boundary.

**Tech Stack:** Node.js >=20, TypeScript ESM, Fastify 5.10, Pino 10, Node.js streams, `better-sqlite3` in-memory fixtures, Node.js built-in test runner. No new dependency.

## Global Constraints

- Approved design: `docs/superpowers/specs/2026-08-08-detailed-http-completion-logging-design.md`.
- Do not read `.env`, use real credentials, access any exchange API, start the real service, or open a real business SQLite database.
- Tests use fake gateways/dependencies, injected temporary secrets, real Pino capture, and `:memory:` or temporary SQLite only.
- Do not change HTTP status/body/public errors, handler counts, persistence, queueing, order behavior, or strategy state.
- One completed request produces exactly one `request completed`: `<400` info with no `httpError/httpRequest`; `4xx` warn and `5xx` error with both fields.
- `httpRequest` contains at least `method`, query-bearing original `url`, `body`, `truncated`, and `originalByteLength`; it contains no headers.
- Record no response body, environment object, arbitrary error properties/cause chain, raw exchange payload/config, SQLite row, order, or strategy object.
- Redaction uses only non-empty values from injected `secretProvider`, exact case-sensitive substring replacement, longest values first, then body truncation.
- Two named limits have distinct duties: `1 MiB` (`1_048_576`) is the fixed raw-observation safety budget, while `8192` UTF-8 bytes limits the final redacted log body. `originalByteLength` is measured after redaction and before final-log truncation.
- Explicitly set Fastify's global `bodyLimit` to `1 MiB`. A larger route-level `bodyLimit` does not enlarge raw capture; an over-capture-budget invalid body without parsed output logs `[Unavailable]`, never a raw prefix.
- Failed preflight must create no SQLite record. Logging failures cannot affect response, persistence, or trading behavior.
- Remove `unhandled_http_request_failure`; do not create any replacement side-channel HTTP failure event. Preserve post-response background events.
- Follow strict RED -> GREEN for every production behavior. Do not commit or push.

---

## File Map

- Modify `src/logging/logger.ts`: reusable exact-secret replacement, UTF-8-safe limiting helpers if they are logging-generic, and a generic non-throwing logger-call boundary.
- Modify `tests/logging/logger.test.ts`: focused unit tests for exact replacement, overlaps, byte boundaries, malformed/hostile values, and logger failures.
- Add `src/http/request-body-capture.ts`: dedicated raw-body capture state unit with the fixed `1 MiB` budget, explicit `complete`/`unavailable`/`released` results, idempotent release, and a transparent observation transform.
- Add `tests/http/request-body-capture.test.ts`: focused unit tests for ordered byte capture/counting, exact and exceeded budgets, release semantics, storage isolation, byte-for-byte forwarding, and observation-failure transparency.
- Modify `src/http/server.ts`: request-local integration and lifecycle ownership for the dedicated capture unit, safe snapshot construction, known error context, automatic-log disablement, unique completion hook, and duplicate-event removal.
- Modify `tests/http/server.test.ts`: capture integration with real Pino completion contracts, all HTTP paths, URL/body capture, invalid JSON, redaction, truncation, concurrency, failure isolation, persistence invariants, and event uniqueness.
- Modify `README.md` and `docs/usage/operator-guide.md`: operator contract after behavior is implemented.
- Verify only `src/http/public-error.ts`: public response behavior remains separate and unchanged.
- Do not modify `package.json` or add dependencies.

---

### Task 1: Safe Redaction, Body Representation, and Non-Throwing Logging Primitives

**Files:**
- Modify: `tests/logging/logger.test.ts`
- Modify: `src/logging/logger.ts`

**Interfaces:**
- Produce `nonEmptySecrets(secrets: readonly string[]): readonly string[]`, stable and longest-first.
- Produce or reuse `redactText(value: string, secrets: readonly string[]): string` with global exact replacement.
- Produce `utf8Prefix(value: string, maxBytes: number): string` that never splits a UTF-8 code point or surrogate pair.
- Produce `nonThrowingLogCall(call: () => unknown): void` that absorbs synchronous throws and rejected thenables.
- Preserve existing `safeError`, `createAppLogger`, `createOperationalLog`, and `nonThrowingOperationalLog` contracts.

- [x] **Step 1: Add failing tests for exact replacement and overlap order**

Add named tests proving:

```ts
assert.equal(redactText(
  'token=abc123&short=abc&again=abc123',
  ['abc', '', 'abc123']
), 'token=[Redacted]&short=[Redacted]&again=[Redacted]');
assert.equal(redactText('ABC abc', ['abc']), 'ABC [Redacted]');
```

Also prove duplicate secrets do not change output and ordinary key names such as `passwordHint` remain untouched unless their value contains an injected secret.

- [x] **Step 2: Run RED for reusable secret normalization**

Run:

```bash
npm run build
node --test --test-name-pattern='redact.*(exact|overlap)' dist/tests/logging/logger.test.js
```

Expected: FAIL because overlap-safe reusable normalization/export is absent or current replacement order leaves part of a longer configured value visible.

- [x] **Step 3: Implement minimal exact replacement**

Filter empty strings, de-duplicate, and stable-sort configured secrets by UTF-8 byte length descending before calling existing exact substring replacement. Do not add regex, field-name heuristics, case folding, hashing, or generic Pino redaction as a substitute.

- [x] **Step 4: Add RED tests for UTF-8 byte limits**

Use ASCII and multibyte cases at exactly 8192 and 8193 bytes. Include a string whose boundary falls inside an emoji and assert:

```ts
assert.equal(Buffer.byteLength(result, 'utf8') <= 8192, true);
assert.equal(result.includes('\uFFFD'), false);
assert.equal(result.endsWith('\uD800'), false);
```

Also prove measurement occurs after redaction: a long injected secret replaced by `[Redacted]` can bring the output below the limit, and `originalByteLength` is the byte length of the redacted representation.

- [x] **Step 5: Run RED then implement UTF-8-safe prefixing**

Run:

```bash
npm run build
node --test --test-name-pattern='UTF-8.*(8192|boundary|redaction)' dist/tests/logging/logger.test.js
```

Expected RED: helper missing. Implement with `Buffer.from(value, 'utf8')`, choose a valid prefix no longer than the limit, and decode only a complete UTF-8 boundary. Do not append an unbudgeted truncation marker.

- [x] **Step 6: Add and implement non-throwing call tests**

Test one normal call, one synchronous throw, and one `Promise.reject`. Install a temporary `unhandledRejection` listener for the rejected-thenable case and wait one `setImmediate`.

Run RED, implement the minimal `try` plus consumed `Promise.resolve(result).catch(() => {})`, then run GREEN:

```bash
npm run build
node --test dist/tests/logging/logger.test.js
```

Expected: PASS with no escaped throw or unhandled rejection and all pre-existing logger tests green.

---

### Task 2: Request-Local Raw Body Observation Without Parser Changes

**Files:**
- Add: `tests/http/request-body-capture.test.ts`
- Add: `src/http/request-body-capture.ts`
- Modify: `tests/http/server.test.ts`
- Modify: `src/http/server.ts`

**Interfaces:**
- Export `RAW_REQUEST_BODY_CAPTURE_LIMIT = 1_048_576`, `createRequestBodyCapture()`, and `createRequestBodyCaptureTransform()` from the dedicated production unit.
- The capture unit reports only `complete` (full retained bytes plus byte count), `unavailable` (over-budget/capture failure plus byte count), or `released` (bytes discarded plus byte count); `release()` is idempotent, append cannot restart a released capture, and results do not expose mutable internal storage.
- The capture transform observes accepted chunks while forwarding each original chunk byte-for-byte and in order; observation failure cannot alter the parser stream.
- Keep closure-local request association keyed by `FastifyRequest` (typed decoration or `WeakMap`) in `server.ts`; the capture unit itself has no Fastify, Host/Origin, parsed-body, redaction, or logging responsibility.
- In `onRequest`, record method/URL and complete Host/Origin validation before creating/entering body observation; early rejection records body `null` without reading/caching payload bytes.
- Explicitly configure Fastify's global `bodyLimit` as `1 MiB`; in `preParsing`, connect the accepted request's capture instance through `createRequestBodyCaptureTransform()`. Do not replace JSON parsing or route-level body limits.
- Prefer `request.body` for valid parsed input and immediately call `release()`; use `complete` raw UTF-8 text only when parsing failed within budget. `unavailable` raw data without parsed output becomes `[Unavailable]`, never a prefix; clean remaining request association after completion.

- [x] **Step 1: Add capture characterization tests before implementation**

First add focused unit tests in `tests/http/request-body-capture.test.ts` proving ordered byte capture/counting, exact-budget `complete`, over-budget `unavailable` with all retained bytes discarded while counting continues, idempotent `release` with no restart, result storage isolation, byte-for-byte ordered transform forwarding, and unchanged forwarding when observation throws.

Then add test-only routes and real-Pino capture helpers in `tests/http/server.test.ts`. Write integration tests for:

1. valid object, array, string, number, boolean, and JSON `null` bodies reaching handlers unchanged;
2. no-body GET and POST behavior unchanged;
3. schema validation still returns the same existing `400` response;
4. invalid JSON still returns the same existing `400 INVALID_REQUEST` response;
5. default body-size/content-type behavior is unchanged with global `bodyLimit` explicitly set to `1 MiB`;
6. invalid Host/Origin with malformed and oversized payloads is rejected as `403` before any body observation/parser, with no payload read/cache and logged body `null`;
7. a test route with `bodyLimit: 2 MiB` accepts about `1.1 MiB` valid JSON through parsed-body logging, while about `1.1 MiB` malformed JSON logs `[Unavailable]` because raw capture stays capped at `1 MiB`;
8. raw capture storage is released immediately after parsed body becomes available.

Each test must assert the handler input/response first. Snapshot assertions remain RED until later tasks.

- [x] **Step 2: Run the baseline parser tests**

Run:

```bash
npm run build
node --test --test-name-pattern='body observation preserves' dist/tests/http/server.test.js
```

Expected: PASS before production changes. Record these as invariants.

- [x] **Step 3: Add failing invalid-JSON raw-capture assertion**

Inject raw payload such as `{"symbol":"RAW-INVALID"` with `content-type: application/json`. Assert response remains the existing `400`, then assert request-local capture (through a temporary test-only observation seam or the later completion output) contains exactly the supplied UTF-8 text. Do not inspect response body for the request payload.

Run:

```bash
npm run build
node --test --test-name-pattern='captures raw invalid JSON' dist/tests/http/server.test.js
```

Expected: FAIL because `request.body` is unavailable and no pre-parser capture exists.

- [x] **Step 4: Implement transparent stream observation**

Implement `src/http/request-body-capture.ts` as the dedicated small state unit. `createRequestBodyCapture()` retains ordered copies only through `RAW_REQUEST_BODY_CAPTURE_LIMIT`, continues counting after it becomes `unavailable`, discards all retained bytes on that transition, and implements idempotent `release()` to enter terminal `released` state. `result()` returns an isolated body buffer only for `complete`. `createRequestBodyCaptureTransform()` forwards each original chunk unchanged and in order while containing observation failures.

Keep Host/Origin validation in `onRequest`, before creating or entering raw observation for that request. Configure Fastify's global `bodyLimit` explicitly as `1 MiB`. In `server.ts`, associate one capture instance only with each accepted request and use `preParsing` to return `createRequestBodyCaptureTransform(capture)`. Preserve backpressure and never consume the stream separately. Release raw bytes immediately when parsed body is available and clean the remaining request association after completion.

Capture failures or over-budget malformed payloads must surface as `unavailable` while original data continues to Fastify subject to its applicable global or route-level parser limit. Do not call `JSON.parse`, register a replacement content-type parser, or buffer into business logic. Route-level limits may exceed `1 MiB`, but must not expand capture.

- [x] **Step 5: Run capture GREEN and parser regression checks**

Run:

```bash
npm run build
node --test --test-name-pattern='body observation preserves|captures raw invalid JSON' dist/tests/http/server.test.js
```

Expected: PASS; byte-for-byte handler/parser behavior and all existing HTTP responses remain unchanged; early `403` payloads are not observed, route-level `2 MiB` behavior respects the independent capture budget, and parsed-body paths release raw storage.

---

### Task 3: Unique Completion Log and Failure Snapshot Contract

**Files:**
- Modify: `tests/http/server.test.ts`
- Modify: `src/http/server.ts`

**Interfaces:**
- Produce internal `HttpErrorForLog` with stable `code/message` and optional `SafeError`.
- Produce internal `HttpRequestForLog` with `method`, `url`, `body`, `truncated`, `originalByteLength`.
- Produce `fallbackHttpError(statusCode)` and request-local `rememberHttpError(...)`.
- Emit from one `onResponse` hook using final status and `reply.elapsedTime`.

- [x] **Step 1: Add real-Pino completion helpers and RED contract matrix**

Capture newline-delimited Pino JSON and select lines with `msg === 'request completed'`. Inject concurrent test routes returning `200`, `302`, `418`, and `503`. Assert:

```ts
// Across all requests
assert.equal(completions.length, 4);
assert.equal(new Set(completions.map((line) => line.reqId)).size, 4);
// 200/302
assert.equal(line.level, 30);
assert.equal(line.httpError, undefined);
assert.equal(line.httpRequest, undefined);
// 418/503
assert.deepEqual(line.httpError, {
  code: 'HTTP_ERROR',
  message: `HTTP request failed with status ${status}`
});
assert.equal(line.level, status === 418 ? 40 : 50);
assert.deepEqual(Object.keys(line.httpRequest).sort(), [
  'body', 'method', 'originalByteLength', 'truncated', 'url'
]);
```

Use URLs containing repeated query keys and reserved encoded text; assert logged `url` equals the injected request URL exactly, including query. Assert no header sentinel appears.

- [x] **Step 2: Run RED for automatic completion behavior**

Run:

```bash
npm run build
node --test --test-name-pattern='one status-aware completion' dist/tests/http/server.test.js
```

Expected: FAIL because current automatic lines are always info and lack `httpError/httpRequest`.

- [x] **Step 3: Disable automatic request logging and add the minimal hook**

Use Fastify 5's public `LogController({ disableRequestLogging: true })` (verify the installed type/API before editing). Add a single `onResponse` hook. Build `fields` from `{ res: reply, responseTime: reply.elapsedTime }`; only final failures add `httpError/httpRequest`. Invoke `request.log.info/warn/error` through `nonThrowingLogCall`.

Use `request.url` as the original server request URL/request-target; do not call `requestPathForLog`, parse/re-encode query, or construct an absolute URL from headers.

- [x] **Step 4: Construct body representation and metadata**

For final failures only:

1. choose parsed `request.body` when available, otherwise complete observed raw text within the `1 MiB` capture budget, otherwise `null` for no-body/early-boundary rejection or `[Unavailable]` for over-budget/unavailable capture;
2. convert to a JSON-compatible structure without invoking user getters or serializing arbitrary class instances;
3. redact keys and string values with normalized configured secrets;
4. serialize the redacted representation compactly for byte measurement;
5. keep the structured value if byte length is `<= 8192`; otherwise expose the UTF-8-safe prefix string;
6. set `originalByteLength` to pre-truncation redacted bytes and `truncated` to the comparison result.

Method and URL are redacted but not body-truncated. Non-JSON/hostile parsed values safely fall back to raw text or `[Unavailable]`; never pass an arbitrary object directly to Pino.

- [x] **Step 5: Run GREEN for base completion contract**

Run:

```bash
npm run build
node --test --test-name-pattern='one status-aware completion' dist/tests/http/server.test.js
```

Expected: PASS; unique IDs, correct levels, exact query-bearing URLs, failure snapshots only, no headers, and `logger:false` remains silent.

---

### Task 4: Known Error Semantics and HTTP Event Deduplication

**Files:**
- Modify: `tests/http/server.test.ts`
- Modify: `src/http/server.ts`

**Interfaces:**
- Known mappings: 400 `INVALID_REQUEST`, 403 `FORBIDDEN`, business 404 `STRATEGY_NOT_FOUND`, 422 `PREFLIGHT_REJECTED`, 500 `INTERNAL_ERROR`.
- Framework/plugin failures without context remain `HTTP_ERROR`.
- `httpError.error` remains existing `safeError` whitelist only.

- [x] **Step 1: Write one RED test per known path**

For every test, assert exactly one completion, unchanged status/response JSON, expected level, expected `httpError`, and a matching `httpRequest`.

Cover:

- schema-invalid parsed body at `400`;
- invalid JSON raw body at `400`;
- boundary `403` with invalid/oversized payloads rejected in `onRequest` before observation/parser, malicious Host/Origin and payload sentinels absent from logs, and body `null`;
- business and framework `404` in separate fixtures;
- preflight exception at `422` with allowlisted type/message/string code/stack;
- unhandled `500` with no `unhandled_http_request_failure` event;
- explicit fallback `418` and `503`.

The invalid-JSON assertion must match the raw malformed text. The schema assertion must retain ordinary extra/malformed fields in the request snapshot while omitting Fastify's error `validation` array.

- [x] **Step 2: Run RED for known summaries and duplicate 500 event**

Run:

```bash
npm run build
node --test --test-name-pattern='completion.*(validation|invalid JSON|forbidden|business 404|framework 404|preflight|internal|fallback)' dist/tests/http/server.test.js
```

Expected: FAIL because known request-local summaries are not yet attached and the existing 500 side event remains.

- [x] **Step 3: Remember known errors without logging at failure sites**

Immediately before each existing reply, call a request-local helper with stable code/message and optional caught value. Inside the helper call `safeError(error, normalizedSecrets)` under a safe boundary; never retain/pass the original exception to `onResponse`.

Remove only the current `operationalLog?.error('unhandled_http_request_failure', ...)` block. Preserve unrelated operational logs and `background_confirmation_failed`. Do not add a replacement event.

- [x] **Step 4: Run known-path GREEN**

Run the Step 2 command again.

Expected: PASS with unchanged responses, correct stable summaries, raw invalid JSON, no header/error-property leaks, one completion per request, and no duplicate 500 event.

---

### Task 5: Exact Secret Redaction and UTF-8 Truncation Matrix

**Files:**
- Modify: `tests/http/server.test.ts`
- Modify: `src/http/server.ts` only for minimal fixes exposed by RED tests.

**Interfaces:**
- Apply one secret set to every output string in `httpError` and `httpRequest`, including body object keys/values, method, and URL.
- If `secretProvider` fails, output stable HTTP code/message plus `[Unavailable]` request placeholders; output no raw snapshot/error.

- [x] **Step 1: Add RED tests spanning all logged surfaces**

Inject distinct temporary secrets into:

- error message and stack;
- URL path and query names/values;
- body object key, nested value, array value, and raw invalid JSON;
- repeated and overlapping secret strings.

Assert every occurrence becomes `[Redacted]`. Assert ordinary business values remain intact even under names such as `passwordHint`, proving there is no field-name filtering. Assert serialized logs contain none of the original temporary values.

- [x] **Step 2: Add exact body byte-boundary tests**

Create final-failure payloads whose redacted compact representations are exactly 8192 and 8193 UTF-8 bytes, plus emoji/CJK boundary cases. Assert:

```ts
assert.equal(exact.truncated, false);
assert.equal(exact.originalByteLength, 8192);
assert.equal(over.truncated, true);
assert.equal(over.originalByteLength, 8193);
assert.equal(Buffer.byteLength(over.body, 'utf8') <= 8192, true);
```

For a large structured body, assert `body` is a prefix string only when truncated; for an under-limit structured body, assert object/array shape is retained. Include a long secret whose replacement changes the truncation decision, proving redact-before-count-before-truncate.

- [x] **Step 3: Run RED then make minimal corrections**

Run:

```bash
npm run build
node --test --test-name-pattern='completion.*(secret|overlap|8192|8193|UTF-8|truncat)' dist/tests/http/server.test.js
```

Expected RED: missing surface or boundary behavior. Correct only snapshot construction/redaction/limiting; do not add heuristics or configuration.

- [x] **Step 4: Add secret-provider failure test and run GREEN**

Make `secretProvider` throw while the request/error contains obvious sentinels. Assert unchanged HTTP response; stable `httpError.code/message`; no `httpError.error`; `httpRequest.method/url/body === '[Unavailable]'`; metadata matches the body placeholder; and no sentinel appears.

Run Step 3 command again. Expected: PASS.

---

### Task 6: Request, Logging, Persistence, and Background Failure Isolation

**Files:**
- Modify: `tests/http/server.test.ts`
- Modify: `src/http/server.ts` or `src/logging/logger.ts` only when a retained RED test proves a missing boundary.

**Interfaces:**
- Request capture and error state never cross request IDs.
- Observation failures cannot change HTTP/handler/database/background behavior.

- [x] **Step 1: Add concurrent isolation tests**

Send two controlled failing preflights concurrently with distinct method/URL query/body/error/secret sentinels; release them in reverse order. Correlate each completion using the response `requestId`. Assert each line contains only its own redacted snapshot and error data.

- [x] **Step 2: Add hostile-capture and serialization tests**

Inject stream/capture failure seams and hostile values with throwing getters. Assert stable responses, one completion, safe `[Unavailable]` fallback, and no getter/cause sentinel. Verify raw stream bytes still reach Fastify unchanged when observation fails.

- [x] **Step 3: Add synchronous and rejected-thenable logger tests**

Wrap a real test logger so `info/warn/error` either throws or returns `Promise.reject`. For each mode prove:

1. successful preflight remains `201` and persists exactly one pending strategy;
2. failed preflight remains `422`, runs preflight once, and repository row count/state is unchanged from before the request;
3. confirmation remains `202`, queues exactly one background execution;
4. no `unhandledRejection` occurs.

- [x] **Step 4: Prove failed preflight never persists**

Take a repository snapshot/count before a forced `422`; after response and log flush, assert the same count and no strategy corresponding to the failed payload. Repeat with snapshot construction and logger failures. This is a required money-safety invariant, not only a response assertion.

- [x] **Step 5: Preserve background-event split**

Extend the existing background coordinator rejection test: the `202` completion is a unique info line with no failure snapshot; after queued work fails, exactly one `background_confirmation_failed` remains; no `unhandled_http_request_failure` or newly named HTTP side event appears.

- [x] **Step 6: Run focused isolation GREEN**

Run:

```bash
npm run build
node --test --test-name-pattern='completion.*(concurrent|capture failure|hostile|logger failure|preflight does not persist|background)' dist/tests/http/server.test.js
```

Expected: PASS with request isolation, unchanged state transitions, no persistence on failed preflight, and no unhandled rejection.

---

### Task 7: Operator Documentation and Verification Gates

**Files:**
- Modify: `README.md`
- Modify: `docs/usage/operator-guide.md`
- Verify: all files listed above plus the approved spec and this plan.

**Interfaces:**
- Document the observed implementation only after Tasks 1–6 pass.

- [x] **Step 1: Add RED documentation contract assertions**

Add a focused documentation test requiring both operator documents to mention:

- unique `request completed` and info/warn/error mapping;
- failure-only `httpError` and `httpRequest`;
- method, full query-bearing URL, body, `truncated`, `originalByteLength`, and the final 8192 UTF-8-byte log limit;
- Host/Origin rejection before body observation/parser, with early-`403` body `null` and no payload read/cache;
- explicit global Fastify `bodyLimit: 1 MiB`, independent fixed `1 MiB` raw capture budget, route-level larger limits not expanding capture, and over-budget invalid bodies degrading to `[Unavailable]`;
- exact configured-secret redaction;
- no headers or response body;
- no failed-preflight persistence;
- removal of `unhandled_http_request_failure` and preservation of post-202 background failure events.

Run:

```bash
npm run build
node --test --test-name-pattern='operator docs describe failure request snapshots' dist/tests/http/server.test.js
```

Expected: FAIL while docs are stale.

- [x] **Step 2: Update README and operator guide minimally**

Describe fields and safety boundaries exactly as verified. Do not claim absolute URL reconstruction, header capture, response-body capture, configurable limits, generic field-name redaction, or storage of failed preflights.

Run the Step 1 command again. Expected: PASS.

- [x] **Step 3: Run focused suites**

Run:

```bash
npm run build
node --test dist/tests/logging/logger.test.js dist/tests/http/server.test.js
```

Expected: exit 0; all logger and HTTP tests pass.

- [x] **Step 4: Run `pre-verification-check`**

Invoke the skill. Without reading `.env`, confirm `node`, `npm`, local TypeScript/test dependencies, fake gateways, and temporary/in-memory database fixtures are available. Confirm no command starts the service or accesses an exchange.

- [x] **Step 5: Run `verification-before-completion` with fresh evidence**

Invoke the skill, then run exactly:

```bash
npm run build
node --test dist/tests/logging/logger.test.js dist/tests/http/server.test.js
npm test
```

Expected: all exit 0. Run `ReadLints` on changed source/test files and require no newly introduced diagnostics.

- [x] **Step 6: Run `consistency-check`**

Invoke the skill and cross-check spec, plan, implementation, tests, README, and operator guide against this matrix:

```text
one completed request -> one request completed
<400 info and no failure fields; 4xx warn; 5xx error
all final failures -> httpError + httpRequest
method + original query-bearing URL + valid structured/raw-invalid body
configured non-empty secrets only -> exact replacement, longest first
Host/Origin rejected in onRequest -> no body observation/parser -> body null
Fastify global bodyLimit 1 MiB; independent raw capture budget 1 MiB
route-level larger limit does not enlarge capture; over-budget invalid raw -> [Unavailable]
parsed body available -> release raw immediately
body redacted -> measured -> UTF-8-safe 8192-byte final-log truncation
truncated + originalByteLength semantics match tests
no request headers; no response body; no arbitrary error/exchange payload
failed preflight -> no SQLite mutation
no unhandled_http_request_failure or replacement side event
background_confirmation_failed remains post-202
logger/capture/redaction faults cannot alter behavior
no dependency or public HTTP contract change
```

Any mismatch requires a retained failing test and minimal RED -> GREEN correction before continuing.

- [x] **Step 7: Run `post-verification-check` and report**

Invoke the skill. Re-read this plan, check off only work actually performed, inspect final diff for scope, and report exact command exit statuses, material test counts, lint result, changed files, unexecuted checks, and uncertainties. Do not commit or push.
