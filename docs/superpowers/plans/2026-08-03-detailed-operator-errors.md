# Detailed Operator Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the most detailed safely sanitized error available for every operator UI request instead of collapsing failures into fixed generic messages.

**Architecture:** Add a bounded allowlisted public-error serializer, inject current credential values into the Fastify boundary for redaction, and return one consistent JSON error envelope. Replace the browser's per-action fixed catches with one request helper and one multiline plain-text renderer while preserving all existing state invalidation rules.

**Tech Stack:** Node.js >=20, TypeScript ESM, Fastify 5, Pino 10, browser JavaScript, Node.js built-in test runner.

## Global Constraints

- Detailed server messages are intentionally visible because the service is local and single-user.
- Every current non-empty Bitget/OKX API key, secret, and password/passphrase substring must become `[Redacted]` before an error reaches the browser.
- Never return stack traces, arbitrary error properties, nested causes, headers, environment objects, signatures, or original CCXT requests/responses.
- Public error strings are capped at 2,000 UTF-16 code units per field; truncation uses the visible suffix `…[truncated]` and never restores redacted text.
- Browser rendering uses `textContent` only and never assigns server content to `innerHTML`.
- Preflight remains 422; validation remains 400; forbidden remains 403; not found remains 404; unexpected failures remain 500.
- A successful confirmation remains asynchronous HTTP 202; later execution failures stay in persisted strategy state/stdout rather than being presented as synchronous confirmation errors.
- Do not access the real workspace `.env`, real exchanges, or real funds in tests.
- Follow strict RED -> GREEN -> refactor for every behavior change.
- Before completion run `pre-verification-check` -> `verification-before-completion` -> `consistency-check` -> `post-verification-check`.

---

## File Map

- Create `src/http/public-error.ts`: bounded, allowlisted, credential-redacted browser error detail.
- Create `tests/http/public-error.test.ts`: serializer safety and hostile-object tests.
- Modify `src/http/server.ts`: consistent JSON error envelopes and injected secret provider.
- Modify `src/main.ts`: pass current resolved credential values to the HTTP boundary.
- Modify `tests/http/server.test.ts` and `tests/main.test.ts`: response contract and composition coverage.
- Modify `public/app.js`: shared JSON request failure parser and multiline renderer for every operator action.
- Modify `public/styles.css`: preserve multiline plain text and wrap long diagnostics.
- Modify `README.md`: document detailed local UI errors and the remaining redaction boundary.

---

### Task 1: Bounded Public Error Detail

**Files:**
- Create: `src/http/public-error.ts`
- Create: `tests/http/public-error.test.ts`

**Interfaces:**
- Consumes: `safeError(error, secrets)` from `src/logging/logger.ts`.
- Produces: `PUBLIC_ERROR_TEXT_LIMIT`, `PublicErrorDetail`, and `publicErrorDetail(error, secrets)`.

- [x] **Step 1: Write failing serializer tests**

Create `tests/http/public-error.test.ts` with tests equivalent to:

```ts
test('returns only bounded redacted type code and message', () => {
  const error = Object.assign(
    new Error(`credential-value failed ${'x'.repeat(2_100)}`),
    {
      name: 'AuthenticationError',
      code: 401,
      apiKey: 'credential-value',
      request: { apiKey: 'credential-value' },
      response: { body: 'credential-value' },
      cause: new Error('credential-value nested')
    }
  );

  const detail = publicErrorDetail(error, ['credential-value']);

  assert.equal(detail.type, 'AuthenticationError');
  assert.equal(detail.code, 401);
  assert.match(detail.message, /\[Redacted\]/);
  assert.match(detail.message, /…\[truncated\]$/);
  assert.ok(detail.message.length <= PUBLIC_ERROR_TEXT_LIMIT);
  assert.deepEqual(Object.keys(detail).sort(), ['code', 'message', 'type']);
  assert.doesNotMatch(JSON.stringify(detail), /credential-value|apiKey|request|response|cause|stack/);
});
```

Add cases for a string code, primitive thrown value, getters that throw, non-finite numeric code, empty secret strings, and oversized `name`/`code` fields.

- [x] **Step 2: Run RED**

Run:

```bash
npm run build
```

Expected: FAIL because `src/http/public-error.ts` does not exist.

- [x] **Step 3: Implement the minimal allowlisted serializer**

Create `src/http/public-error.ts`:

```ts
import { safeError } from '../logging/logger.js';

export const PUBLIC_ERROR_TEXT_LIMIT = 2_000;
const TRUNCATION_SUFFIX = '…[truncated]';

export interface PublicErrorDetail {
  readonly type: string;
  readonly message: string;
  readonly code?: string | number;
}

function bounded(value: string): string {
  if (value.length <= PUBLIC_ERROR_TEXT_LIMIT) return value;
  return `${value.slice(
    0,
    PUBLIC_ERROR_TEXT_LIMIT - TRUNCATION_SUFFIX.length
  )}${TRUNCATION_SUFFIX}`;
}

function numericCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const value: unknown = Reflect.get(error, 'code');
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function publicErrorDetail(
  error: unknown,
  secrets: readonly string[]
): PublicErrorDetail {
  const safe = safeError(error, secrets);
  const code = safe.code === undefined
    ? numericCode(error)
    : bounded(safe.code);
  return {
    type: bounded(safe.type),
    message: bounded(safe.message),
    ...(code === undefined ? {} : { code })
  };
}
```

- [x] **Step 4: Verify GREEN**

Run:

```bash
npm run build
node --test dist/tests/http/public-error.test.js
git diff --check -- src/http/public-error.ts tests/http/public-error.test.ts
```

Expected: build succeeds, serializer tests pass, and hostile fields never appear.

- [x] **Step 5: Commit the serializer**

```bash
git add src/http/public-error.ts tests/http/public-error.test.ts
git commit -m "feat(http): serialize detailed public errors"
```

---

### Task 2: Consistent Detailed HTTP Error Envelopes

**Files:**
- Modify: `src/http/server.ts`
- Modify: `src/main.ts`
- Modify: `tests/http/server.test.ts`
- Modify: `tests/main.test.ts`

**Interfaces:**
- Adds `BuildServerDependencies.secretProvider?: () => readonly string[]`.
- Uses `publicErrorDetail(error, secrets)` from Task 1.
- Produces JSON failures with `code`, `message`, `requestId`, and optional `error`.

- [x] **Step 1: Write failing HTTP contract tests**

Extend the HTTP fixture options with `secretProvider` and pass it to `buildServer`. Replace the fixed preflight assertion with:

```ts
const failure = Object.assign(
  new Error('bitget credential-value authentication failed'),
  { name: 'AuthenticationError', code: 401, rawResponse: 'LEAK-ME-NOT' }
);
const { server } = setup(t, {
  runPreflight: async () => { throw failure; },
  secretProvider: () => ['credential-value']
});
const response = await server.inject({
  method: 'POST',
  url: '/api/hedges/preflight',
  headers: LOCAL_HEADERS,
  payload: {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: 'BTC/USDT',
    requestedBaseQuantity: '1',
    mode: 'SPOT_FIRST'
  }
});
assert.equal(response.statusCode, 422);
assert.deepEqual(response.json(), {
  code: 'PREFLIGHT_REJECTED',
  message: 'Preflight checks did not pass',
  requestId: response.json().requestId,
  error: {
    type: 'AuthenticationError',
    code: 401,
    message: 'bitget [Redacted] authentication failed'
  }
});
assert.equal(typeof response.json().requestId, 'string');
assert.doesNotMatch(response.body, /credential-value|LEAK-ME-NOT|rawResponse|stack/);
```

Add assertions that validation, forbidden, not-found, and unexpected failures include request IDs, retain their existing statuses/codes, and include sanitized detail when a caught error exists. Add a test where `secretProvider` throws and assert the stable envelope remains but the optional `error` field is absent.

In `tests/main.test.ts`, assert a composed server receives a provider that redacts all six values from the explicitly supplied environment.

- [x] **Step 2: Run RED**

Run:

```bash
npm run build
node --test dist/tests/http/server.test.js dist/tests/main.test.js
```

Expected: new response assertions fail because request IDs/details and the provider are absent.

- [x] **Step 3: Add one safe envelope helper to Fastify**

In `src/http/server.ts`, add the optional dependency and helpers with these contracts:

```ts
interface PublicHttpError {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly error?: PublicErrorDetail;
}

function publicHttpError(
  requestId: string,
  code: string,
  message: string,
  error: unknown | undefined,
  secretProvider: (() => readonly string[]) | undefined
): PublicHttpError {
  let detail: PublicErrorDetail | undefined;
  if (error !== undefined && secretProvider !== undefined) {
    try {
      detail = publicErrorDetail(error, secretProvider());
    } catch {
      detail = undefined;
    }
  }
  return {
    code,
    message,
    requestId,
    ...(detail === undefined ? {} : { error: detail })
  };
}
```

Use this helper for the 403 hook, every branch of `setErrorHandler`, and the 422 preflight catch. Catch the preflight error as `catch (error)` rather than discarding it. Never pass an error object directly to `reply.send`.

- [x] **Step 4: Inject current resolved credentials from composition**

In `src/main.ts`, pass:

```ts
secretProvider: () => configuredSecretValues(env)
```

to `buildServer`. Keep the provider dynamic over the resolved `env` object and do not capture a one-time array.

- [x] **Step 5: Verify GREEN**

Run:

```bash
npm run build
node --test dist/tests/http/public-error.test.js dist/tests/http/server.test.js dist/tests/main.test.js
git diff --check -- src/http/server.ts src/main.ts tests/http/server.test.ts tests/main.test.ts
```

Expected: all focused tests pass; every tested credential/raw field remains absent.

- [x] **Step 6: Commit the HTTP contract**

```bash
git add src/http/server.ts src/main.ts tests/http/server.test.ts tests/main.test.ts
git commit -m "feat(http): return detailed sanitized errors"
```

---

### Task 3: Unified Browser Error Rendering

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/http/server.test.ts`

**Interfaces:**
- Produces browser-local `OperatorRequestError`, `requestJson`, `serverFailureMessage`, and `operatorFailureMessage` helpers.
- Consumes the Task 2 JSON envelope but remains compatible with legacy `{ code, message }` failures.

- [x] **Step 1: Write failing browser behavior tests**

Add table-driven browser tests for preflight, strategy load, refresh, confirmation, and exchange-list loading. For each action, return:

```ts
browserResponse(422, {
  code: 'PREFLIGHT_REJECTED',
  message: 'Preflight checks did not pass',
  requestId: 'req-3',
  error: {
    type: 'AuthenticationError',
    code: '40101',
    message: '<b>bitget authentication failed</b>'
  }
})
```

Assert `operator-message.textContent` equals the action-specific multiline text and contains the literal `<b>` characters. Assert the actionable-state reset/re-enable behavior is unchanged for each action.

Add focused cases for:

- a legacy `{ code, message }` body;
- a non-JSON error response using a fake response whose `json()` rejects;
- a rejected `fetch` with `new Error('connection refused')`;
- malformed or over-2,000-character server detail;
- a malformed 2xx success response, which must say `响应校验失败` and clear actionable state.

- [x] **Step 2: Run RED**

Run:

```bash
npm run build
node --test dist/tests/http/server.test.js
```

Expected: browser assertions receive the current fixed Chinese messages.

- [x] **Step 3: Implement the shared browser request boundary**

In `public/app.js`, add:

```js
const operatorErrorTextLimit = 2000;
const operatorTruncationSuffix = '…[truncated]';

class OperatorRequestError extends Error {
  constructor(operatorMessage) {
    super(operatorMessage);
    this.operatorMessage = operatorMessage;
  }
}

function boundedOperatorText(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length <= operatorErrorTextLimit
    ? value
    : `${value.slice(
        0,
        operatorErrorTextLimit - operatorTruncationSuffix.length
      )}${operatorTruncationSuffix}`;
}

function serverFailureMessage(operation, response, body) {
  const lines = [`${operation}失败`];
  const code = isRecord(body) ? boundedOperatorText(body.code) : null;
  lines.push(`HTTP ${response.status}${code === null ? '' : ` · ${code}`}`);
  const detail = isRecord(body?.error) ? body.error : null;
  const detailType = boundedOperatorText(detail?.type);
  const detailMessage = boundedOperatorText(detail?.message);
  const detailCode = typeof detail?.code === 'number' && Number.isFinite(detail.code)
    ? String(detail.code)
    : boundedOperatorText(detail?.code);
  if (detailType !== null && detailMessage !== null) {
    lines.push(`${detailType}${detailCode === null ? '' : ` [${detailCode}]`}: ${detailMessage}`);
  } else {
    const message = isRecord(body) ? boundedOperatorText(body.message) : null;
    lines.push(message ?? '响应不是有效的结构化 JSON 错误');
  }
  const requestId = isRecord(body) ? boundedOperatorText(body.requestId) : null;
  if (requestId !== null) lines.push(`请求 ID：${requestId}`);
  return lines.join('\n');
}

async function requestJson(operation, url, options, expectedStatus) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const message = boundedOperatorText(error?.message)
      ?? boundedOperatorText(String(error))
      ?? '未知网络错误';
    throw new OperatorRequestError(`${operation}失败\n网络错误：${message}`);
  }
  const body = await responseJson(response);
  if (response.status !== expectedStatus) {
    throw new OperatorRequestError(serverFailureMessage(operation, response, body));
  }
  if (body === null) {
    throw new OperatorRequestError(`${operation}失败\nHTTP ${response.status}\n响应不是有效 JSON`);
  }
  return body;
}

function operatorFailureMessage(operation, error) {
  if (error instanceof OperatorRequestError) return error.operatorMessage;
  const message = boundedOperatorText(error?.message)
    ?? boundedOperatorText(String(error))
    ?? '未知响应错误';
  return `${operation}失败\n响应校验失败：${message}`;
}
```

Use `requestJson` in exchange loading, preflight, strategy loading, status refresh, and confirmation. Change each `catch` to retain `error` and pass `operatorFailureMessage(operation, error)` to the existing state-reset/message path. Do not change the existing revision guards, button restoration, or actionable-state rules.

- [x] **Step 4: Preserve multiline plain text in CSS**

Add to `.message` in `public/styles.css`:

```css
white-space: pre-wrap;
overflow-wrap: anywhere;
```

- [x] **Step 5: Verify GREEN**

Run:

```bash
npm run build
node --test dist/tests/http/server.test.js
git diff --check -- public/app.js public/styles.css tests/http/server.test.ts
```

Expected: all browser scenarios show specific multiline details and existing state-safety tests remain green.

- [x] **Step 6: Commit the browser behavior**

```bash
git add public/app.js public/styles.css tests/http/server.test.ts
git commit -m "feat(ui): show detailed request failures"
```

---

### Task 4: Documentation and Completion Gates

**Files:**
- Modify: `README.md`
- Verify: every file above
- Update: `docs/superpowers/plans/2026-08-03-detailed-operator-errors.md`

**Interfaces:**
- Documents the browser-visible fields and the deliberate redaction boundary.

- [x] **Step 1: Document detailed local errors**

Add a short README subsection explaining that the local operator UI displays HTTP status, stable code, sanitized original type/code/message, and request ID; credentials, stack traces, and raw CCXT traffic remain excluded. State that asynchronous execution failures are diagnosed from persisted status plus stdout.

- [x] **Step 2: Run focused security/UI verification**

Run:

```bash
npm run build
node --test dist/tests/http/public-error.test.js dist/tests/http/server.test.js dist/tests/main.test.js dist/tests/logging/logger.test.js
```

Expected: all pass with no seeded credential or hostile property in HTTP/browser output.

- [x] **Step 3: Run full Node 20 verification**

Run:

```bash
node --version
npm test
git diff --check
git status --short --branch
```

Expected: Node `v20.x`, 0 failures, clean diff check, and only intended documentation/plan state remains.

- [x] **Step 4: Run completion gates and reconcile the plan**

Apply `pre-verification-check`, `verification-before-completion`, `consistency-check`, and `post-verification-check` in order. Re-read the design and this plan, verify every checkbox, and ensure server/browser/README terminology agrees exactly.

- [x] **Step 5: Commit documentation and completed plan**

```bash
git add README.md docs/superpowers/plans/2026-08-03-detailed-operator-errors.md
git commit -m "docs: explain detailed operator errors"
```

Do not commit `dist`, `.env`, credentials, logs, temporary probe files, or unrelated user changes.
