# Detailed Operator Error Design

## Goal

Make every operator-facing HTTP failure as diagnostically useful as possible for this single-user local service, while preserving the existing credential and raw-payload safety boundary.

## Current Problem

The preflight route catches every failure and replaces it with the fixed response `PREFLIGHT_REJECTED / Preflight checks did not pass`. The browser then discards even that response and renders a second fixed Chinese sentence. Strategy loading, status refresh, and confirmation use the same browser-side pattern, so distinguishable failures collapse into one generic message.

## Scope

The change applies uniformly to:

- preflight creation;
- loading an existing strategy;
- refreshing strategy status;
- confirmation requests;
- request validation, authorization, not-found, and internal HTTP failures that reach the shared Fastify error handler;
- browser network failures, non-JSON responses, and structurally invalid success/error responses.

Asynchronous execution after a successful confirmation remains outside the synchronous HTTP response. Later execution failures continue to be represented by persisted strategy state and failure codes, with operational detail in stdout.

## Server Error Contract

Every JSON HTTP failure may contain:

```json
{
  "code": "PREFLIGHT_REJECTED",
  "message": "Preflight checks did not pass",
  "requestId": "req-3",
  "error": {
    "type": "AuthenticationError",
    "code": "401",
    "message": "bitget authentication failed: invalid API key"
  }
}
```

`code` and `message` remain stable route-level fields. `requestId` is the Fastify request ID. `error` is an optional detailed summary of the caught value.

The detailed summary reads only explicitly allowlisted properties:

- error type/name;
- error code when it is a string or finite number;
- error message.

It does not spread or serialize the original error. It never returns stack traces, arbitrary enumerable properties, headers, environment objects, credentials, original CCXT requests/responses, or complete cause objects. All string values are capped to a documented maximum length and have every current non-empty configured credential substring replaced with `[Redacted]`.

The server obtains credential values through an injected provider so tests can prove redaction without reading the process environment. The production composition supplies a provider that reads the current resolved runtime environment.

Known typed HTTP errors retain their current statuses and stable codes. Preflight failures remain HTTP 422. Unexpected route failures remain HTTP 500 but include the sanitized detailed summary and request ID. Validation, forbidden, and not-found responses include request IDs and their existing stable public messages; when there is no meaningful caught internal error, they need no synthetic detail object.

## Browser Error Handling

The browser uses one request-error parser and one renderer for all operations. It validates only the allowlisted server error shape and treats all text as plain text.

The operator message renders multiple lines when data is available:

```text
预检失败
HTTP 422 · PREFLIGHT_REJECTED
AuthenticationError [401]: bitget authentication failed: invalid API key
请求 ID：req-3
```

Rules:

- a valid structured server error displays HTTP status, stable code, detailed type/code/message, and request ID;
- an older `{ code, message }` response remains usable and displays its message;
- a non-JSON error response displays the HTTP status and an explicit response-format failure;
- a rejected `fetch` displays the browser-provided network error message;
- a malformed success response remains a response-validation failure and cannot leave actionable strategy state behind;
- all rendering uses `textContent`; server strings never become HTML;
- a successful operation replaces the previous error with the existing success message;
- input changes continue to invalidate the old preflight result and clear its actionable state.

The existing single message region remains sufficient; no modal, toast system, history, copy button, or new dependency is introduced.

## Security and Privacy Constraints

- The service is local and single-user, so sanitized original error messages are intentionally visible.
- Six configured exchange credential values are always redacted wherever they appear as substrings.
- No API key, secret, password/passphrase, signature, authorization/cookie header, complete environment, stack trace, original CCXT request, or original CCXT response may reach the browser.
- Unknown object properties and nested causes are not serialized.
- Error text is length-bounded to prevent an exchange or dependency from creating an unbounded HTTP response or DOM message.
- The detailed error path remains side-effect-free and must not alter persistence, execution, recovery, or order counts.

## Testing

Server tests prove:

- preflight exposes a useful error type/code/message and request ID;
- configured credential substrings are replaced while unrelated diagnostic text survives;
- arbitrary fields, stacks, raw request/response data, and nested causes are absent;
- validation, forbidden, not-found, and unexpected failures keep their status and stable code;
- secret-provider or error-introspection failures fall back safely instead of changing the route result.

Browser tests prove:

- preflight, load, refresh, and confirmation render structured details;
- legacy error responses remain readable;
- network and non-JSON failures are distinct;
- malicious markup is displayed as text only;
- oversized or malformed error shapes are rejected or bounded;
- failed or malformed responses clear actionable state exactly as before.

Full Node 20 verification must pass with no test regressions and no real exchange or real workspace `.env` access.
