# Bitget Classic v2 Spot Zero Minimum Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow only fully evidenced Bitget Classic v2 `BTC/USDT`-style spot markets whose raw and unified amount minima are both exact decimal zero to load with `minBaseAmount = amountStep`, while preserving the positive USDT quote-notional floor and every existing pre-submit safety check.

**Architecture:** Keep the exception private to `CcxtExchangeGateway.resolveMarket()`: parse the existing positive `amountStep` and positive `limits.cost.min` first, safely narrow `info`, then select `amountStep` only when all eight approved compatibility predicates hold. Every non-match falls through to the existing positive minimum parser and therefore remains fail-closed; no domain, preflight, profile, persistence, or public type changes are allowed.

**Tech Stack:** Node.js >=20, TypeScript ESM, CCXT 4.5.68-compatible market fixtures, Decimal.js 10.6, Node.js built-in test runner. No new dependency.

## Global Constraints

- Approved design: `docs/superpowers/specs/2026-08-09-bitget-classic-spot-zero-minimum-design.md`.
- Direct money risk: execute strict RED -> GREEN; each RED must fail because the zero-minimum compatibility is absent, not because the fixture has the wrong market identity or malformed unrelated metadata.
- Compatibility requires all eight predicates together: gateway `exchangeId === 'bitget'`; requested `kind === 'spot'`; selected active spot has `quote === 'USDT'`; `info` is a non-null, non-array object; raw `info.minTradeAmount` is an exact finite decimal zero; unified `limits.amount.min` is an exact finite decimal zero; parsed `amountStep` is finite and positive; parsed `limits.cost.min` is finite and positive.
- `amountStep` becomes only the application-side minimum expressible positive base quantity. Never call it a Bitget official minimum amount.
- Parse and validate `limits.cost.min` safely before compatibility selection, but continue to use the existing `decimalString(..., 'minimum quote notional')` result as `minQuoteNotional`.
- A finite positive unified `limits.amount.min` always uses the existing path and does not require raw-zero or cost-minimum compatibility evidence.
- Any missing, malformed, non-finite, wrong-sign, wrong-type, wrong-exchange, swap, non-USDT, or non-Classic evidence remains fail-closed. Do not swallow invalid metadata into compatibility.
- Do not modify `MarketRules`, `src/domain/quantity-normalizer.ts`, `src/strategy/preflight-service.ts`, exchange profiles, database code, configuration, dependencies, or operator documentation.
- Allowed implementation files are only `src/exchanges/ccxt-exchange-gateway.ts` and `tests/exchanges/ccxt-gateway.test.ts`; this plan and its approved spec are read-only during execution except that `post-verification-check` may mark this plan's completed checkboxes.
- Use only `CcxtDouble`/`makeGateway` fake adapters and in-memory fixtures. Do not read `.env`, start `npm start`, instantiate a production gateway, call any real exchange endpoint (including public market data), or open a real business SQLite database.
- Preserve the unrelated HTTP logging changes already present in the working tree. Never reset, overwrite, stage, or otherwise alter unrelated files.
- The user did not request a commit or push. Do not commit or push at any task boundary.

---

## File Map

- Modify `tests/exchanges/ccxt-gateway.test.ts`: add one focused Classic v2 spot fixture, table-driven compatibility/fail-closed coverage, and only the missing create-order regression assertions.
- Modify `src/exchanges/ccxt-exchange-gateway.ts`: add private exact-zero/narrow compatibility helpers and a narrow effective-minimum branch inside `resolveMarket()`.
- Verify `docs/superpowers/specs/2026-08-09-bitget-classic-spot-zero-minimum-design.md`: source of truth; do not edit.
- Track execution in `docs/superpowers/plans/2026-08-09-bitget-classic-spot-zero-minimum.md`: no other documentation changes.

---

### Task 1: RED — Compatibility, Isolation, and Fail-Closed Matrix

**Files:**
- Modify: `tests/exchanges/ccxt-gateway.test.ts`
- Verify only: `src/exchanges/ccxt-exchange-gateway.ts`

**Interfaces:**
- Produce test-only `classicBitgetSpotMarket(rawMinimum?, unifiedMinimum?, amountStep?, costMinimum?): CcxtMarket`.
- Consume existing `market()`, `bitgetSwapMarket()`, `okxSpotMarket()`, `makeGateway()`, and `CcxtExchangeGateway.loadMarket()`.
- Do not export a production interface in this task.

- [x] **Step 1: Add the exact Classic v2 fixture constructor**

Place this next to the existing market fixture helpers. Unknown values are cast only at the fake CCXT boundary so malformed runtime metadata can be tested without widening production types:

```ts
function classicBitgetSpotMarket(
  rawMinimum: unknown = '0',
  unifiedMinimum: unknown = 0,
  amountStep: unknown = 0.000001,
  costMinimum: unknown = 1
): CcxtMarket {
  return market({
    info: { minTradeAmount: rawMinimum },
    precision: {
      amount: amountStep as CcxtMarket['precision']['amount'],
      price: 0.1
    },
    limits: {
      amount: {
        min: unifiedMinimum as CcxtMarket['limits']['amount']['min'],
        max: 1000
      },
      price: { min: 0.1, max: 10000000 },
      cost: {
        min: costMinimum as CcxtMarket['limits']['cost']['min'],
        max: 100000000
      }
    }
  });
}
```

- [x] **Step 2: Add the positive compatibility and exact-zero representation tests**

Add these tests near the existing market-loading tests:

```ts
test('loads an evidenced Bitget Classic spot zero minimum as one amount step', async () => {
  const { gateway } = makeGateway('bitget', [classicBitgetSpotMarket()]);

  const rules = await gateway.loadMarket('BTC/USDT', 'spot');

  assert.equal(rules.amountStep, '0.000001');
  assert.equal(rules.minBaseAmount, '0.000001');
  assert.equal(rules.minQuoteNotional, '1');
  assert.equal(rules.maxBaseAmount, '1000');
  assert.equal(rules.maxQuoteNotional, '100000000');
});

for (const [name, rawMinimum, unifiedMinimum] of [
  ['number zero', 0, 0],
  ['negative zero', -0, -0],
  ['decimal string zero', '0.0', '0.000'],
  ['exponent string zero', ' 0e10 ', ' -0e-3 ']
] as const) {
  test(`accepts Classic exact decimal zero representation: ${name}`, async () => {
    const { gateway } = makeGateway('bitget', [
      classicBitgetSpotMarket(rawMinimum, unifiedMinimum)
    ]);
    const rules = await gateway.loadMarket('BTC/USDT', 'spot');
    assert.equal(rules.minBaseAmount, '0.000001');
    assert.equal(rules.minQuoteNotional, '1');
  });
}
```

- [x] **Step 3: Run the focused positive tests and verify RED**

Run:

```bash
npm run build
node --test --test-name-pattern='evidenced Bitget Classic|Classic exact decimal zero' dist/tests/exchanges/ccxt-gateway.test.js
```

Expected: build exits `0`; tests FAIL with `invalid minimum amount limit: must be finite and positive`. If they fail for market selection, precision, quote-notional, typing, or fixture construction, fix the tests and rerun until the only RED cause is the missing approved compatibility.

- [x] **Step 4: Add positive-unified preservation and exchange/kind isolation tests**

```ts
test('keeps a positive unified Bitget spot minimum without raw compatibility evidence', async () => {
  const configured = classicBitgetSpotMarket('not-a-decimal', '0.01');
  const { gateway } = makeGateway('bitget', [configured]);

  const rules = await gateway.loadMarket('BTC/USDT', 'spot');

  assert.equal(rules.minBaseAmount, '0.01');
  assert.equal(rules.minQuoteNotional, '1');
});

test('does not apply Bitget compatibility to OKX spot', async () => {
  const forged = okxSpotMarket({
    info: { minTradeAmount: '0' },
    limits: {
      amount: { min: 0, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 1, max: 100000000 }
    }
  });
  const { gateway } = makeGateway('okx', [forged]);

  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'spot'),
    /minimum amount limit/
  );
});

test('does not apply Classic spot compatibility to Bitget swap', async () => {
  const configured = bitgetSwapMarket({
    info: { minTradeAmount: '0' },
    limits: {
      amount: { min: 0, max: undefined },
      price: { min: undefined, max: undefined },
      cost: { min: 5, max: undefined }
    }
  });
  const { gateway } = makeGateway('bitget', [configured]);

  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'swap'),
    /minimum amount limit/
  );
});
```

The existing `parseUnifiedSymbol()` and spot identity tests already enforce USDT; do not add a fake non-USDT compatibility branch or change symbol parsing.

- [x] **Step 5: Add compact fail-closed matrices for `info` and raw minimum**

```ts
for (const [name, info] of [
  ['undefined', undefined],
  ['null', null],
  ['array', []],
  ['string', 'classic'],
  ['number', 0]
] as const) {
  test(`rejects Classic zero minimum when info is ${name}`, async () => {
    const configured = classicBitgetSpotMarket();
    configured.info = info;
    const { gateway } = makeGateway('bitget', [configured]);
    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'spot'),
      /minimum amount limit/
    );
  });
}

for (const [name, rawMinimum] of [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['whitespace', '   '],
  ['boolean', false],
  ['object', {}],
  ['array', []],
  ['negative', -1],
  ['positive', 1],
  ['NaN number', Number.NaN],
  ['infinite number', Number.POSITIVE_INFINITY],
  ['NaN string', 'NaN'],
  ['infinite string', 'Infinity'],
  ['malformed string', 'zero']
] as const) {
  test(`rejects Classic unified zero with raw minimum ${name}`, async () => {
    const { gateway } = makeGateway('bitget', [
      classicBitgetSpotMarket(rawMinimum)
    ]);
    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'spot'),
      /minimum amount limit/
    );
  });
}
```

- [x] **Step 6: Add compact invalid unified, step, and cost matrices**

Use `unknown` arrays so TypeScript accepts deliberate malformed fake values:

```ts
const invalidDecimalMetadata: ReadonlyArray<[string, unknown]> = [
  ['missing', undefined],
  ['empty', ''],
  ['negative', -1],
  ['NaN number', Number.NaN],
  ['infinite number', Number.POSITIVE_INFINITY],
  ['NaN string', 'NaN'],
  ['infinite string', 'Infinity'],
  ['malformed string', 'invalid']
];

for (const [name, unifiedMinimum] of invalidDecimalMetadata) {
  test(`rejects invalid unified Classic amount minimum: ${name}`, async () => {
    const { gateway } = makeGateway('bitget', [
      classicBitgetSpotMarket('0', unifiedMinimum)
    ]);
    await assert.rejects(gateway.loadMarket('BTC/USDT', 'spot'));
  });
}

for (const [name, amountStep] of [
  ...invalidDecimalMetadata,
  ['zero', 0] as const
]) {
  test(`rejects Classic compatibility with invalid amount step: ${name}`, async () => {
    const { gateway } = makeGateway('bitget', [
      classicBitgetSpotMarket('0', 0, amountStep)
    ]);
    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'spot'),
      /amount precision/
    );
  });
}

for (const [name, costMinimum] of [
  ...invalidDecimalMetadata,
  ['zero', 0] as const
]) {
  test(`rejects Classic compatibility with invalid quote minimum: ${name}`, async () => {
    const { gateway } = makeGateway('bitget', [
      classicBitgetSpotMarket('0', 0, 0.000001, costMinimum)
    ]);
    await assert.rejects(
      gateway.loadMarket('BTC/USDT', 'spot'),
      /minimum quote notional/
    );
  });
}
```

Do not duplicate every raw invalid value for unified/step/cost: the raw matrix proves strict type narrowing; the common numeric matrix proves the parser categories. Zero gets an explicit row where its business meaning differs.

- [x] **Step 7: Add range regression and run the complete Task 1 matrix**

```ts
test('rejects a compatible Classic minimum when maximum amount is below its step', async () => {
  const configured = classicBitgetSpotMarket();
  configured.limits.amount.max = '0.0000001';
  const { gateway } = makeGateway('bitget', [configured]);

  await assert.rejects(
    gateway.loadMarket('BTC/USDT', 'spot'),
    /invalid base amount range/
  );
});
```

Run:

```bash
npm run build
node --test --test-name-pattern='Classic|Bitget.*(compatibility|unified)' dist/tests/exchanges/ccxt-gateway.test.js
```

Expected before Task 2: positive compatibility tests FAIL only at `minimum amount limit`; positive-unified and all isolation/fail-closed tests PASS. Record both outcomes. Do not weaken a fail-closed assertion to make the suite uniformly RED.

---

### Task 2: Minimal Compatibility Implementation and GREEN

**Files:**
- Modify: `src/exchanges/ccxt-exchange-gateway.ts`
- Test: `tests/exchanges/ccxt-gateway.test.ts`

**Interfaces:**
- Produce private `exactFiniteDecimalZero(value: unknown): boolean`.
- Produce private `classicBitgetSpotMinimumAmount(exchangeId, kind, selected, amountStep, minQuoteNotional): string | undefined`.
- Consume existing `decimal()`, `decimalString()`, `CcxtMarket`, `SupportedExchangeId`, and `MarketKind`.
- `undefined` means “not compatible; use the unchanged positive unified parser,” never “accept missing metadata.”

- [x] **Step 1: Add the exact finite decimal zero helper**

Place this immediately after `decimalString()` so zero and positive parsing contracts remain adjacent:

```ts
function exactFiniteDecimalZero(value: unknown): boolean {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || String(value).trim() === ''
  ) {
    return false;
  }
  try {
    const parsed = decimal(String(value));
    return parsed.isFinite() && parsed.eq(0);
  } catch {
    return false;
  }
}
```

Do not use `Number(value)`, truthiness, `Object.is`, or string-literal matching.

- [x] **Step 2: Add the narrow Classic compatibility selector**

```ts
function classicBitgetSpotMinimumAmount(
  exchangeId: SupportedExchangeId,
  kind: MarketKind,
  selected: Readonly<CcxtMarket>,
  amountStep: string,
  minQuoteNotional: string | undefined
): string | undefined {
  if (
    exchangeId !== 'bitget'
    || kind !== 'spot'
    || selected.quote !== 'USDT'
    || minQuoteNotional === undefined
    || !exactFiniteDecimalZero(selected.limits.amount.min)
    || typeof selected.info !== 'object'
    || selected.info === null
    || Array.isArray(selected.info)
  ) {
    return undefined;
  }
  const info = selected.info as Record<string, unknown>;
  return exactFiniteDecimalZero(info.minTradeAmount)
    ? amountStep
    : undefined;
}
```

`amountStep` is already a finite positive decimal string and `minQuoteNotional` is already a finite positive decimal string at this call site. Keep the helper private and purpose-specific; do not introduce a general exchange metadata framework.

- [x] **Step 3: Reorder only quote-minimum parsing and select the effective minimum**

In `resolveMarket()`, keep amount and price precision parsing first. Replace the current minimum/cost ordering with this exact structure:

```ts
const amountStep = decimalString(
  selected.precision.amount,
  'amount precision'
);
const priceStep = decimalString(
  selected.precision.price,
  'price precision'
);
const minQuoteNotional = selected.limits.cost.min === undefined
  ? undefined
  : decimalString(
    selected.limits.cost.min,
    'minimum quote notional'
  );
const compatibleMinimumAmount = classicBitgetSpotMinimumAmount(
  this.exchangeId,
  kind,
  selected,
  amountStep,
  minQuoteNotional
);
const minimumAmount = compatibleMinimumAmount ?? decimalString(
  selected.limits.amount.min,
  'minimum amount limit'
);
```

Retain the existing `contractSize`, `minBaseAmount`, amount range, `maxQuoteNotional`, quote range, and returned `MarketRules` code. Remove only the later duplicate declaration of `minQuoteNotional`; do not parse `cost.min` twice and do not change its output semantics.

- [x] **Step 4: Run the focused GREEN matrix**

Run:

```bash
npm run build
node --test --test-name-pattern='Classic|Bitget.*(compatibility|unified)' dist/tests/exchanges/ccxt-gateway.test.js
```

Expected: exit `0`; all positive, positive-unified, isolation, invalid-info, invalid-raw, invalid-unified, invalid-step, invalid-cost, and `max < step` cases PASS.

- [x] **Step 5: Run the whole gateway suite before downstream additions**

Run:

```bash
node --test dist/tests/exchanges/ccxt-gateway.test.js
```

Expected: exit `0`; all existing gateway tests PASS, including precision mode, maximum amount, quote-notional range, OKX, Bitget swap, and order normalization tests. If an unrelated HTTP test is affected, stop: this task may not modify HTTP files.

---

### Task 3: Create-Order Secondary Validation and Notional Regression

**Files:**
- Modify only if coverage is missing: `tests/exchanges/ccxt-gateway.test.ts`
- Verify only: `src/exchanges/ccxt-exchange-gateway.ts`

**Interfaces:**
- Consume existing `spotRequest()`, `isNoOrderSubmitted()`, `CcxtDouble.createCalls`, and Task 1 `classicBitgetSpotMarket()`.
- Preserve `prepareCreateOrder()` and `BitgetProfile` production code unchanged.
- Every rejected request must produce `NoOrderSubmittedError` and `ccxt.createCalls.length === 0`.

- [x] **Step 1: Inventory existing assertions and add only compatibility-specific missing cases**

The suite already proves generic minimum-base rejection, precision-output mismatch, Bitget quote-notional rejection, and existing parameter construction. Do not duplicate those generic tests. Add this compatibility-specific table to prove the newly loadable market still reaches all existing guards:

```ts
test('keeps pre-submit amount and notional guards for compatible Classic spot', async (t) => {
  await t.test('below one amount step', async () => {
    const { gateway, ccxt } = makeGateway('bitget', [
      classicBitgetSpotMarket()
    ]);
    await assert.rejects(
      gateway.createOrder(spotRequest({ baseQuantity: '0.0000001' })),
      isNoOrderSubmitted
    );
    assert.equal(ccxt.createCalls.length, 0);
  });

  await t.test('not exactly representable at the amount step', async () => {
    const { gateway, ccxt } = makeGateway('bitget', [
      classicBitgetSpotMarket()
    ]);
    ccxt.amountPrecisionResult = '0.000001';
    await assert.rejects(
      gateway.createOrder(spotRequest({ baseQuantity: '0.0000015' })),
      isNoOrderSubmitted
    );
    assert.equal(ccxt.createCalls.length, 0);
  });

  await t.test('at one step but below minimum quote notional', async () => {
    const { gateway, ccxt } = makeGateway('bitget', [
      classicBitgetSpotMarket()
    ]);
    await assert.rejects(
      gateway.createOrder(spotRequest({
        baseQuantity: '0.000001',
        price: '100'
      })),
      isNoOrderSubmitted
    );
    assert.equal(ccxt.createCalls.length, 0);
  });
});
```

- [x] **Step 2: Decide whether a second RED cycle is real**

Run:

```bash
npm run build
node --test --test-name-pattern='pre-submit amount and notional guards for compatible Classic spot' dist/tests/exchanges/ccxt-gateway.test.js
```

Expected after Task 2: PASS, because this task verifies preserved behavior rather than adding production behavior. If any subtest FAILS, confirm the failure is a genuine approved invariant gap; retain it as RED, apply the smallest correction in `ccxt-exchange-gateway.ts`, and rerun. Do not alter `prepareCreateOrder()` merely to manufacture a RED cycle, and do not weaken the test.

- [x] **Step 3: Add the legal submission-parameter regression**

```ts
test('submits an eligible compatible Classic spot order with unchanged parameters', async () => {
  const { gateway, ccxt } = makeGateway('bitget', [
    classicBitgetSpotMarket()
  ]);
  ccxt.createResult = ccxtOrder({
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount: '0.00002',
    filled: '0',
    remaining: '0.00002'
  });

  await gateway.createOrder(spotRequest({
    baseQuantity: '0.00002',
    price: '60000'
  }));

  assert.deepEqual(ccxt.createCalls, [{
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount: '0.00002',
    price: '60000',
    params: {
      clientOrderId: 'clientorderid0000000000000000001',
      timeInForce: 'GTC'
    }
  }]);
});
```

The hand calculation is independent evidence: `0.00002 BTC * 60000 USDT/BTC = 1.2 USDT`, which is above the retained `1 USDT` minimum; `0.00002 / 0.000001 = 20` exact steps.

- [x] **Step 4: Run Task 3 and the complete gateway suite**

Run:

```bash
npm run build
node --test --test-name-pattern='compatible Classic spot' dist/tests/exchanges/ccxt-gateway.test.js
node --test dist/tests/exchanges/ccxt-gateway.test.js
```

Expected: every command exits `0`; rejection cases make zero create calls and the eligible request makes exactly one call with unchanged symbol/type/side/amount/price/params.

---

### Task 4: Risk Review and Completion Verification Gates

**Files:**
- Verify: `src/exchanges/ccxt-exchange-gateway.ts`
- Verify: `tests/exchanges/ccxt-gateway.test.ts`
- Verify: `docs/superpowers/specs/2026-08-09-bitget-classic-spot-zero-minimum-design.md`
- Track checkboxes: `docs/superpowers/plans/2026-08-09-bitget-classic-spot-zero-minimum.md`

**Interfaces:**
- No new code interface.
- Produce exact command outputs, exit statuses, test counts, lint diagnostics, scope diff, and an explicit consistency checklist.
- Perform review and verification locally; do not delegate further, commit, push, start the service, or access an exchange/database/environment secret.

- [x] **Step 1: Perform a defect-first money-safety review**

Inspect the final diff and answer every item with file/symbol evidence:

```text
[ ] Compatibility is gated by exact bitget + spot + selected USDT spot identity.
[ ] info is narrowed from unknown; null and arrays are rejected.
[ ] Raw and unified minima both require number|string, nonblank, finite Decimal eq(0).
[ ] amountStep is parsed positive before compatibility and is not rebuilt from quantityPrecision.
[ ] cost.min is parsed positive before compatibility and the same parsed value becomes minQuoteNotional.
[ ] Positive unified minimum bypasses compatibility evidence and preserves existing behavior.
[ ] Any compatibility non-match falls through to the existing positive minimum parser.
[ ] maxBaseAmount < minBaseAmount and invalid quote ranges still reject.
[ ] OKX spot, Bitget swap, non-USDT selection, and missing Classic raw evidence remain isolated.
[ ] prepareCreateOrder still blocks below-step, precision-changed, and below-notional orders before createOrder.
[ ] Eligible createOrder symbol/type/side/amount/price/params are unchanged.
[ ] No MarketRules/domain/preflight/profile/database/config/dependency/doc behavior changed.
```

Any defect requires a retained failing regression test first, then the smallest correction, then rerun Tasks 2–3 GREEN commands. If fixing it requires leaving the approved two-file implementation boundary, stop and request a spec/plan amendment.

- [x] **Step 2: Run `pre-verification-check`**

Invoke the skill. Without reading `.env`, confirm `node`, `npm`, local `typescript`, and the compiled Node test runner path are available. Confirm the commands below use only fake gateways and do not start `npm start`, instantiate production credentials, access an exchange, or open SQLite. A missing tool is a blocker to report, not a reason to skip.

- [ ] **Step 3: Run `verification-before-completion` with fresh evidence**

Invoke the skill, then run exactly:

```bash
npm run build
node --test dist/tests/exchanges/ccxt-gateway.test.js
npm test
```

Expected: all commands exit `0`, with zero failed/cancelled tests. Then run `ReadLints` on:

```text
src/exchanges/ccxt-exchange-gateway.ts
tests/exchanges/ccxt-gateway.test.ts
```

Expected: no newly introduced diagnostics. Do not claim the focused or full suite passes from an earlier Task 2/3 run.

- [x] **Step 4: Run `consistency-check`**

Invoke the skill, re-read the approved spec, this plan, both changed implementation files, and the final diff. Output the mandatory checklist and include these feature-specific rows:

```text
[ ] Eight compatibility predicates agree across spec, plan, helper, and tests.
[ ] “Application-side minimum expressible positive quantity” is not presented as an official Bitget minimum.
[ ] exactFiniteDecimalZero and classicBitgetSpotMinimumAmount signatures match every plan occurrence and implementation call.
[ ] cost.min validation order and minQuoteNotional output agree.
[ ] Test fixture values match Classic evidence: raw zero, unified zero, positive step, positive USDT cost minimum.
[ ] Fail-closed matrices cover type, finite/sign, exchange, kind, raw/unified mismatch, step, cost, and max<step boundaries.
[ ] Create-order tests prove no-submit on three blocked paths and unchanged parameters on the eligible path.
[ ] Final diff contains only the approved gateway source/test plus this plan's checkbox updates; unrelated HTTP changes are untouched.
[ ] No dependency, configuration, domain, preflight, profile, database, README, or operator-guide change exists for this feature.
```

Any contradiction requires correction under RED -> GREEN and fresh verification-before-completion again.

- [x] **Step 5: Run `post-verification-check` and report**

Invoke the skill. Re-read this plan in full, count every checkbox, and mark `[x]` only where direct evidence exists. Report:

```text
- changed files and symbols;
- RED command and exact expected failure observed;
- GREEN focused gateway and full npm test commands, exit statuses, and material test counts;
- ReadLints result;
- twelve-item money-safety review result;
- spec coverage, placeholder scan, and type/signature consistency result;
- final scope diff, including confirmation that unrelated HTTP working-tree changes were not overwritten;
- every unchecked item, unexecuted command, uncertainty, or required user decision.
```

Do not commit or push. If any checkbox remains unverified, do not claim implementation completion.

---

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 cover all eight compatibility conditions, exact Decimal zero forms, positive-unified preservation, safe `info` narrowing, cost-minimum-before-compatibility parsing, maximum range behavior, and OKX/swap isolation. Task 3 covers the unchanged create-order quantity, precision, quote-notional, no-submit, and submission-parameter contracts. Task 4 covers direct-money-risk review and all required verification gates.
- **Scope coverage:** The implementation map contains only the gateway source/test files. Domain, preflight, profiles, SQLite, config, dependencies, README/operator guide, approved spec, and unrelated HTTP changes are explicitly excluded.
- **Placeholder scan:** Every code-changing step contains concrete code, every command has an expected outcome, and every referenced interface is defined. Conditional Task 3 production correction is allowed only when a retained approved-invariant test demonstrates a real gap.
- **Type consistency:** `exactFiniteDecimalZero(value: unknown): boolean` and `classicBitgetSpotMinimumAmount(exchangeId: SupportedExchangeId, kind: MarketKind, selected: Readonly<CcxtMarket>, amountStep: string, minQuoteNotional: string | undefined): string | undefined` are defined once and consumed consistently. Deliberately malformed fake metadata is cast at fixture boundaries without widening `CcxtMarket` production types.
- **Risk calibration:** The minimal complete design adds no dependency, public type, provenance field, generalized compatibility framework, or downstream behavioral change. Ambiguity always returns to the existing fail-closed parser.
