/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AccountSettings,
  ExecutionMode,
  MarketKind,
  MarketRules
} from '../../src/domain/types.js';
import {
  TradeOpsError,
  type ErrorCode,
  type ErrorPhase
} from '../../src/errors/trade-ops-error.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import {
  PreflightService,
  type PreflightInput
} from '../../src/strategy/preflight-service.js';
import {
  FakeExchangeGateway,
  type FakeLoadedMarketSnapshot,
  type FakeMarketLoadOptions
} from '../support/fake-exchange-gateway.js';

const SYMBOL = 'BTC/USDT';

function isTradeOpsFailure(
  code: ErrorCode,
  options: {
    phase?: ErrorPhase;
    subjectType?: string;
    field?: string;
    expected?: unknown;
    actual?: unknown;
  } = {}
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert(error instanceof TradeOpsError);
    assert.equal(error.detail.code, code);
    assert.equal(error.detail.phase, options.phase ?? 'preflight');
    if (options.subjectType !== undefined) {
      assert.equal(error.detail.subject.type, options.subjectType);
    }
    if (options.field !== undefined) {
      assert.equal('field' in error.detail.subject
        ? error.detail.subject.field
        : undefined, options.field);
    }
    if ('expected' in options) {
      assert.deepEqual(error.detail.expected, options.expected);
    }
    if ('actual' in options) {
      assert.deepEqual(error.detail.actual, options.actual);
    }
    assert.match(error.detail.message, /期望 .*实际为/);
    return true;
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

class DeferredReadGateway extends FakeExchangeGateway {
  readonly readStarted = deferred();
  readonly continueRead = deferred();

  override async fetchFreeBalance(
    asset: 'USDT',
    kind: MarketKind
  ): Promise<string> {
    this.readStarted.resolve();
    await this.continueRead.promise;
    return super.fetchFreeBalance(asset, kind);
  }
}

class ReadTrackingGateway extends FakeExchangeGateway {
  readonly readRequests: string[] = [];

  override async fetchFreeBalance(
    asset: 'USDT',
    kind: MarketKind
  ): Promise<string> {
    this.readRequests.push(`balance:${asset}:${kind}`);
    return super.fetchFreeBalance(asset, kind);
  }

  override async fetchAccountSettings(
    symbol: string
  ): Promise<AccountSettings> {
    this.readRequests.push(`settings:${symbol}`);
    return super.fetchAccountSettings(symbol);
  }

  override async fetchLastPrice(
    symbol: string,
    kind: MarketKind
  ): Promise<string> {
    this.readRequests.push(`price:${symbol}:${kind}`);
    return super.fetchLastPrice(symbol, kind);
  }
}

class OrderedReadGateway extends FakeExchangeGateway {
  accountSettingsError: unknown;

  constructor(
    exchangeId: string,
    private readonly trace: string[]
  ) {
    super(exchangeId);
  }

  override async loadMarket(
    symbol: string,
    kind: MarketKind,
    options: FakeMarketLoadOptions = {}
  ): Promise<MarketRules> {
    this.trace.push(`${kind}:market:${String(options.reload === true)}`);
    return super.loadMarket(symbol, kind, options);
  }

  override async loadMarketSnapshot(
    symbol: string,
    kind: MarketKind,
    options: FakeMarketLoadOptions = {}
  ): Promise<FakeLoadedMarketSnapshot> {
    this.trace.push(`${kind}:market:${String(options.reload === true)}`);
    const snapshot = await super.loadMarketSnapshot(symbol, kind, options);
    return {
      identity: snapshot.identity,
      quantityRules: () => {
        this.trace.push(`${kind}:quantity-rules`);
        return snapshot.quantityRules();
      },
      notionalRules: () => {
        this.trace.push(`${kind}:notional-rules`);
        return snapshot.notionalRules();
      },
      fetchAccountSettings: () => snapshot.fetchAccountSettings(),
      fetchLastPrice: () => snapshot.fetchLastPrice()
    };
  }

  override async fetchFreeBalance(
    asset: 'USDT',
    kind: MarketKind
  ): Promise<string> {
    this.trace.push(`${kind}:balance`);
    return super.fetchFreeBalance(asset, kind);
  }

  override async fetchAccountSettings(
    symbol: string
  ): Promise<AccountSettings> {
    this.trace.push('swap:account-settings');
    if (this.accountSettingsError !== undefined) {
      throw this.accountSettingsError;
    }
    return super.fetchAccountSettings(symbol);
  }

  override async fetchLastPrice(
    symbol: string,
    kind: MarketKind
  ): Promise<string> {
    this.trace.push(`${kind}:price`);
    return super.fetchLastPrice(symbol, kind);
  }
}

function market(
  exchangeId: string,
  kind: MarketKind,
  overrides: Partial<MarketRules> = {}
): MarketRules {
  return {
    exchangeId,
    symbol: SYMBOL,
    marketId: kind === 'spot' ? 'BTCUSDT' : 'BTC-USDT-SWAP',
    kind,
    base: 'BTC',
    quote: 'USDT',
    active: true,
    amountStep: '1',
    contractSize: '1',
    minBaseAmount: '1',
    priceStep: '0.1',
    ...overrides
  };
}

function input(
  overrides: Partial<PreflightInput> = {}
): PreflightInput {
  return {
    spotExchangeId: 'bitget',
    contractExchangeId: 'okx',
    symbol: SYMBOL,
    requestedBaseQuantity: '1.001',
    mode: 'CONTRACT_FIRST',
    ...overrides
  };
}

function setup(options: {
  spotMarket?: Partial<MarketRules>;
  contractMarket?: Partial<MarketRules>;
  spotPrice?: string;
  contractPrice?: string;
  spotFreeUsdt?: string;
  contractFreeUsdt?: string;
  accountSettings?: AccountSettings;
  spotGateway?: FakeExchangeGateway;
  contractGateway?: FakeExchangeGateway;
} = {}): {
  service: PreflightService;
  spot: FakeExchangeGateway;
  contract: FakeExchangeGateway;
} {
  const spot = options.spotGateway ?? new FakeExchangeGateway('bitget');
  const contract = options.contractGateway ?? new FakeExchangeGateway('okx');
  spot.markets.set(
    `spot:${SYMBOL}`,
    market('bitget', 'spot', options.spotMarket)
  );
  contract.markets.set(
    `swap:${SYMBOL}`,
    market('okx', 'swap', options.contractMarket)
  );
  spot.lastPrices.set(`spot:${SYMBOL}`, options.spotPrice ?? '100');
  contract.lastPrices.set(`swap:${SYMBOL}`, options.contractPrice ?? '120');
  spot.freeUsdt = options.spotFreeUsdt ?? '100';
  contract.freeUsdt = options.contractFreeUsdt ?? '60';
  contract.accountSettings = options.accountSettings ?? {
    marginMode: 'isolated',
    positionMode: 'hedged',
    leverage: '2'
  };
  return {
    service: new PreflightService(new ExchangeRegistry(new Map([
      ['bitget', spot],
      ['okx', contract]
    ]))),
    spot,
    contract
  };
}

function orderedSetup(options: Parameters<typeof setup>[0] = {}): {
  service: PreflightService;
  spot: OrderedReadGateway;
  contract: OrderedReadGateway;
  trace: string[];
} {
  const trace: string[] = [];
  const spot = new OrderedReadGateway('bitget', trace);
  const contract = new OrderedReadGateway('okx', trace);
  return {
    ...setup({ ...options, spotGateway: spot, contractGateway: contract }),
    spot,
    contract,
    trace
  };
}

test('returns normalized quantity and a confirmed preview snapshot', async () => {
  const { service, contract } = setup();

  const result = await service.run(input());

  assert.equal(result.effectiveBaseQuantity, '1');
  assert.deepEqual(result.accountSettings, {
    marginMode: 'isolated',
    positionMode: 'hedged',
    leverage: '2'
  });
  assert.equal(result.spotFreeUsdt, '100');
  assert.equal(result.contractFreeUsdt, '60');
  assert.equal(result.spotReferencePrice, '100');
  assert.equal(result.contractReferencePrice, '120');
  assert.equal(result.riskAcknowledgementRequired, true);
  assert.equal(new Date(result.createdAt).toISOString(), result.createdAt);

  contract.accountSettings.marginMode = 'cross';
  assert.equal(result.accountSettings.marginMode, 'isolated');
});

test('requests each free balance from the correct market kind', async () => {
  const { service, spot, contract } = setup();

  await service.run(input());

  assert.deepEqual(spot.balanceRequests, [{ asset: 'USDT', kind: 'spot' }]);
  assert.deepEqual(contract.balanceRequests, [{ asset: 'USDT', kind: 'swap' }]);
});

test('keeps one input and market snapshot across async reads and after return', async () => {
  const contractGateway = new DeferredReadGateway('okx');
  const configured = setup({ contractGateway });
  const mutableInput = input();
  const sourceSpotMarket = configured.spot.markets.get(`spot:${SYMBOL}`);
  const sourceContractMarket = configured.contract.markets.get(`swap:${SYMBOL}`);
  assert.ok(sourceSpotMarket);
  assert.ok(sourceContractMarket);
  const expectedInput = { ...mutableInput };
  const expectedSpotMarket = { ...sourceSpotMarket };
  const expectedContractMarket = { ...sourceContractMarket };

  const resultPromise = configured.service.run(mutableInput);
  await contractGateway.readStarted.promise;

  Object.assign(mutableInput, {
    spotExchangeId: 'okx',
    contractExchangeId: 'okx',
    symbol: 'ETH/USDT',
    requestedBaseQuantity: '999',
    mode: 'SPOT_FIRST' as const
  });
  Object.assign(sourceSpotMarket, {
    exchangeId: 'okx',
    symbol: 'ETH/USDT',
    base: 'ETH',
    active: false
  });
  Object.assign(sourceContractMarket, {
    exchangeId: 'bitget',
    symbol: 'ETH/USDT',
    base: 'ETH',
    active: false
  });
  contractGateway.continueRead.resolve();

  const result = await resultPromise;
  assert.deepEqual({
    spotExchangeId: result.spotExchangeId,
    contractExchangeId: result.contractExchangeId,
    symbol: result.symbol,
    requestedBaseQuantity: result.requestedBaseQuantity,
    mode: result.mode
  }, expectedInput);
  assert.deepEqual(result.spotMarket, expectedSpotMarket);
  assert.deepEqual(result.contractMarket, expectedContractMarket);
  assert.equal(result.effectiveBaseQuantity, '1');

  Object.assign(mutableInput, { symbol: 'SOL/USDT' });
  Object.assign(sourceSpotMarket, { symbol: 'SOL/USDT' });
  Object.assign(sourceContractMarket, { symbol: 'SOL/USDT' });
  assert.equal(result.symbol, SYMBOL);
  assert.equal(result.spotMarket.symbol, SYMBOL);
  assert.equal(result.contractMarket.symbol, SYMBOL);
});

const COMPLETE_PREFLIGHT_TRACE = [
  'spot:market:true',
  'swap:market:true',
  'swap:account-settings',
  'spot:quantity-rules',
  'swap:quantity-rules',
  'spot:price',
  'spot:notional-rules',
  'swap:price',
  'swap:notional-rules',
  'spot:balance',
  'swap:balance'
] as const;

test('performs the thirteen preflight checks through the prescribed read order', async () => {
  const configured = orderedSetup();

  await configured.service.run(input());

  assert.deepEqual(configured.trace, COMPLETE_PREFLIGHT_TRACE);
  assert.deepEqual(configured.spot.marketLoadRequests, [{
    symbol: SYMBOL,
    kind: 'spot',
    reload: true
  }]);
  assert.deepEqual(configured.contract.marketLoadRequests, [{
    symbol: SYMBOL,
    kind: 'swap',
    reload: true
  }]);
  assert.deepEqual(configured.spot.createdRequests, []);
  assert.deepEqual(configured.contract.createdRequests, []);
});

for (const invalidRequest of [
  { name: 'symbol case', overrides: { symbol: 'btc/usdt' } },
  { name: 'quantity exponent', overrides: { requestedBaseQuantity: '1e2' } },
  { name: 'quantity leading zero', overrides: { requestedBaseQuantity: '01' } },
  {
    name: 'quantity length',
    overrides: { requestedBaseQuantity: '1'.repeat(257) }
  },
  {
    name: 'execution mode',
    overrides: { mode: 'UNEXPECTED' as ExecutionMode }
  }
]) {
  test(`rejects invalid ${invalidRequest.name} before every gateway read`, async () => {
    const configured = orderedSetup();

    await assert.rejects(
      configured.service.run(input(invalidRequest.overrides)),
      isTradeOpsFailure('REQUEST_FIELD_INVALID', {
        subjectType: 'request'
      })
    );

    assert.deepEqual(configured.trace, []);
    assert.deepEqual(configured.spot.createdRequests, []);
    assert.deepEqual(configured.contract.createdRequests, []);
  });
}

test('checks both exchange configurations before loading the spot market', async () => {
  const trace: string[] = [];
  const spot = new OrderedReadGateway('bitget', trace);
  spot.markets.set(`spot:${SYMBOL}`, market('bitget', 'spot'));
  const service = new PreflightService(new ExchangeRegistry(new Map([
    ['bitget', spot]
  ])));

  await assert.rejects(
    service.run(input()),
    isTradeOpsFailure('EXCHANGE_NOT_CONFIGURED', {
      subjectType: 'exchange'
    })
  );
  assert.deepEqual(trace, []);
  assert.deepEqual(spot.createdRequests, []);
});

interface OrderedFailureCase {
  readonly name: string;
  readonly configure: (configured: ReturnType<typeof orderedSetup>) => void;
  readonly expectedTrace: readonly string[];
  readonly failure: (error: unknown) => boolean;
}

const orderedFailureCases: readonly OrderedFailureCase[] = [
  {
    name: 'spot market unavailable',
    configure: ({ spot }) => spot.markets.clear(),
    expectedTrace: ['spot:market:true'],
    failure: isTradeOpsFailure('MARKET_UNAVAILABLE', {
      subjectType: 'market'
    })
  },
  {
    name: 'contract market inactive',
    configure: ({ contract }) => {
      const configured = contract.markets.get(`swap:${SYMBOL}`);
      assert(configured);
      configured.active = false;
    },
    expectedTrace: ['spot:market:true', 'swap:market:true'],
    failure: isTradeOpsFailure('MARKET_INACTIVE', {
      subjectType: 'market',
      field: 'active',
      expected: true,
      actual: false
    })
  },
  {
    name: 'one-way position mode',
    configure: ({ contract }) => {
      contract.accountSettings = {
        marginMode: 'isolated',
        positionMode: 'one-way',
        leverage: '2'
      };
    },
    expectedTrace: [
      'spot:market:true',
      'swap:market:true',
      'swap:account-settings'
    ],
    failure: isTradeOpsFailure('ACCOUNT_POSITION_MODE_MISMATCH', {
      subjectType: 'account',
      field: 'positionMode',
      expected: 'hedged',
      actual: 'one-way'
    })
  },
  {
    name: 'unknown margin mode before leverage',
    configure: ({ contract }) => {
      contract.accountSettings = {
        marginMode: 'unknown',
        positionMode: 'hedged',
        leverage: 'not-a-decimal'
      };
    },
    expectedTrace: [
      'spot:market:true',
      'swap:market:true',
      'swap:account-settings'
    ],
    failure: isTradeOpsFailure('ACCOUNT_MARGIN_MODE_MISMATCH', {
      subjectType: 'account',
      field: 'marginMode',
      expected: ['isolated', 'cross'],
      actual: 'unknown'
    })
  },
  {
    name: 'invalid leverage before quantity rules',
    configure: ({ contract }) => {
      contract.accountSettings = {
        marginMode: 'isolated',
        positionMode: 'hedged',
        leverage: '0'
      };
    },
    expectedTrace: [
      'spot:market:true',
      'swap:market:true',
      'swap:account-settings'
    ],
    failure: isTradeOpsFailure('ACCOUNT_LEVERAGE_MISMATCH', {
      subjectType: 'account',
      field: 'leverage',
      actual: '0'
    })
  },
  {
    name: 'invalid spot quantity rule before contract quantity rules',
    configure: ({ spot }) => {
      const configured = spot.markets.get(`spot:${SYMBOL}`);
      assert(configured);
      configured.amountStep = '0';
    },
    expectedTrace: [
      'spot:market:true',
      'swap:market:true',
      'swap:account-settings',
      'spot:quantity-rules'
    ],
    failure: isTradeOpsFailure('MARKET_RULE_INVALID', {
      subjectType: 'market',
      field: 'amountStep'
    })
  },
  {
    name: 'invalid spot price before spot notional rules',
    configure: ({ spot }) => {
      spot.lastPrices.set(`spot:${SYMBOL}`, 'NaN');
    },
    expectedTrace: [
      ...COMPLETE_PREFLIGHT_TRACE.slice(0, 5),
      'spot:price'
    ],
    failure: isTradeOpsFailure('PRICE_INVALID', {
      subjectType: 'market',
      field: 'price'
    })
  },
  {
    name: 'invalid spot notional rule before contract price',
    configure: ({ spot }) => {
      const configured = spot.markets.get(`spot:${SYMBOL}`);
      assert(configured);
      configured.minQuoteNotional = 'NaN';
    },
    expectedTrace: COMPLETE_PREFLIGHT_TRACE.slice(0, 7),
    failure: isTradeOpsFailure('MARKET_RULE_INVALID', {
      subjectType: 'market',
      field: 'minQuoteNotional'
    })
  },
  {
    name: 'invalid contract price before contract notional rules',
    configure: ({ contract }) => {
      contract.lastPrices.set(`swap:${SYMBOL}`, 'Infinity');
    },
    expectedTrace: COMPLETE_PREFLIGHT_TRACE.slice(0, 8),
    failure: isTradeOpsFailure('PRICE_INVALID', {
      subjectType: 'market',
      field: 'price'
    })
  },
  {
    name: 'invalid contract notional rule before balances',
    configure: ({ contract }) => {
      const configured = contract.markets.get(`swap:${SYMBOL}`);
      assert(configured);
      configured.maxQuoteNotional = '-1';
    },
    expectedTrace: COMPLETE_PREFLIGHT_TRACE.slice(0, 9),
    failure: isTradeOpsFailure('MARKET_RULE_INVALID', {
      subjectType: 'market',
      field: 'maxQuoteNotional'
    })
  },
  {
    name: 'zero spot balance as insufficiency before contract balance',
    configure: ({ spot }) => {
      spot.freeUsdt = '0';
    },
    expectedTrace: COMPLETE_PREFLIGHT_TRACE.slice(0, 10),
    failure: isTradeOpsFailure('BALANCE_INSUFFICIENT', {
      subjectType: 'account',
      field: 'balance',
      actual: '0'
    })
  },
  {
    name: 'zero contract balance as insufficiency',
    configure: ({ contract }) => {
      contract.freeUsdt = '0';
    },
    expectedTrace: COMPLETE_PREFLIGHT_TRACE,
    failure: isTradeOpsFailure('BALANCE_INSUFFICIENT', {
      subjectType: 'account',
      field: 'balance',
      actual: '0'
    })
  }
];

for (const failureCase of orderedFailureCases) {
  test(`stops after ${failureCase.name}`, async () => {
    const configured = orderedSetup();
    failureCase.configure(configured);

    await assert.rejects(
      configured.service.run(input()),
      failureCase.failure
    );

    assert.deepEqual(configured.trace, failureCase.expectedTrace);
    assert.deepEqual(configured.spot.createdRequests, []);
    assert.deepEqual(configured.contract.createdRequests, []);
  });
}

test('converts unknown account failures safely and applies the requested phase', async () => {
  const configured = orderedSetup();
  const secret = 'raw-third-party-account-failure';
  configured.contract.accountSettingsError = new Error(secret);
  const phasedService = configured.service as unknown as {
    run(
      value: PreflightInput,
      phase?: 'preflight' | 'confirmation'
    ): ReturnType<PreflightService['run']>;
  };

  await assert.rejects(
    phasedService.run(input(), 'confirmation'),
    (error: unknown) => {
      assert(isTradeOpsFailure('ACCOUNT_SETTINGS_UNAVAILABLE', {
        phase: 'confirmation',
        subjectType: 'account',
        field: 'settings'
      })(error));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      return true;
    }
  );
  assert.deepEqual(configured.trace, [
    'spot:market:true',
    'swap:market:true',
    'swap:account-settings'
  ]);
  assert.deepEqual(configured.spot.createdRequests, []);
  assert.deepEqual(configured.contract.createdRequests, []);
});

test('rejects same-exchange and unsupported exchange selections', async () => {
  const { service } = setup();

  await assert.rejects(
    service.run(input({ contractExchangeId: 'bitget' })),
    isTradeOpsFailure('REQUEST_FIELD_INVALID', {
      subjectType: 'request',
      field: 'contractExchangeId'
    })
  );
  await assert.rejects(
    service.run(input({ spotExchangeId: 'coinbase' })),
    isTradeOpsFailure('EXCHANGE_NOT_CONFIGURED', {
      subjectType: 'exchange'
    })
  );
});

for (const identityCase of [
  {
    name: 'spot exchangeId',
    options: { spotMarket: { exchangeId: 'okx' } }
  },
  {
    name: 'spot symbol',
    options: { spotMarket: { symbol: 'ETH/USDT' } }
  },
  {
    name: 'contract exchangeId',
    options: { contractMarket: { exchangeId: 'bitget' } }
  },
  {
    name: 'contract symbol',
    options: { contractMarket: { symbol: 'ETH/USDT' } }
  }
] satisfies Array<{
  name: string;
  options: {
    spotMarket?: Partial<MarketRules>;
    contractMarket?: Partial<MarketRules>;
  };
}>) {
  test(`rejects ${identityCase.name} mismatch before account reads`, async () => {
    const spotGateway = new ReadTrackingGateway('bitget');
    const contractGateway = new ReadTrackingGateway('okx');
    const configured = setup({
      ...identityCase.options,
      spotGateway,
      contractGateway
    });

    await assert.rejects(
      configured.service.run(input()),
      isTradeOpsFailure('MARKET_IDENTITY_MISMATCH', {
        subjectType: 'market'
      })
    );

    assert.deepEqual(spotGateway.readRequests, []);
    assert.deepEqual(contractGateway.readRequests, []);
  });
}

test('rejects different base assets or non-USDT quote markets', async () => {
  const differentBase = setup({
    contractMarket: { base: 'ETH' }
  });
  await assert.rejects(
    differentBase.service.run(input()),
    isTradeOpsFailure('MARKET_IDENTITY_MISMATCH', {
      subjectType: 'market',
      field: 'base'
    })
  );

  const nonUsdt = setup({
    spotMarket: { quote: 'BTC' } as unknown as Partial<MarketRules>
  });
  await assert.rejects(
    nonUsdt.service.run(input()),
    isTradeOpsFailure('MARKET_IDENTITY_MISMATCH', {
      subjectType: 'market',
      field: 'quote'
    })
  );
});

test('rejects inactive or unexpected market kinds', async () => {
  for (const { configured, code, field } of [
    {
      configured: setup({ spotMarket: { active: false } }),
      code: 'MARKET_INACTIVE',
      field: 'active'
    },
    {
      configured: setup({ contractMarket: { active: false } }),
      code: 'MARKET_INACTIVE',
      field: 'active'
    },
    {
      configured: setup({ spotMarket: { kind: 'swap' } }),
      code: 'MARKET_IDENTITY_MISMATCH',
      field: 'kind'
    },
    {
      configured: setup({ contractMarket: { kind: 'spot' } }),
      code: 'MARKET_IDENTITY_MISMATCH',
      field: 'kind'
    }
  ] satisfies Array<{
    configured: ReturnType<typeof setup>;
    code: ErrorCode;
    field: string;
  }>) {
    await assert.rejects(
      configured.service.run(input()),
      isTradeOpsFailure(code, { subjectType: 'market', field })
    );
  }
});

test('accepts only the three execution modes', async () => {
  for (const mode of [
    'CONCURRENT',
    'CONTRACT_FIRST',
    'SPOT_FIRST'
  ] satisfies ExecutionMode[]) {
    await setup().service.run(input({ mode }));
  }

  await assert.rejects(
    setup().service.run(input({
      mode: 'UNEXPECTED' as ExecutionMode
    })),
    isTradeOpsFailure('REQUEST_FIELD_INVALID', {
      subjectType: 'request',
      field: 'mode'
    })
  );
});

test('fails closed when margin or position mode is unknown', async () => {
  for (const { accountSettings, code, field } of [
    {
      accountSettings: {
        marginMode: 'unknown',
        positionMode: 'hedged',
        leverage: '2'
      },
      code: 'ACCOUNT_MARGIN_MODE_MISMATCH',
      field: 'marginMode'
    },
    {
      accountSettings: {
        marginMode: 'isolated',
        positionMode: 'unknown',
        leverage: '2'
      },
      code: 'ACCOUNT_POSITION_MODE_MISMATCH',
      field: 'positionMode'
    }
  ] satisfies Array<{
    accountSettings: AccountSettings;
    code: ErrorCode;
    field: string;
  }>) {
    await assert.rejects(
      setup({ accountSettings }).service.run(input()),
      isTradeOpsFailure(code, { subjectType: 'account', field })
    );
  }
});

test('rejects flat OKX-style hedged settings when margin mode and leverage are not observable', async () => {
  await assert.rejects(
    setup({
      accountSettings: {
        marginMode: 'unknown',
        positionMode: 'hedged',
        leverage: null
      }
    }).service.run(input()),
    isTradeOpsFailure('ACCOUNT_MARGIN_MODE_MISMATCH', {
      subjectType: 'account',
      field: 'marginMode'
    })
  );
});

test('rejects one-way contract accounts before returning a persistable preview', async () => {
  const { service } = setup({
    accountSettings: {
      marginMode: 'isolated',
      positionMode: 'one-way',
      leverage: '2'
    }
  });

  await assert.rejects(
    service.run(input()),
    isTradeOpsFailure('ACCOUNT_POSITION_MODE_MISMATCH', {
      subjectType: 'account',
      field: 'positionMode'
    })
  );
});

test('fails closed when leverage is missing, non-finite, zero, or negative', async () => {
  for (const leverage of [null, 'NaN', 'Infinity', '0', '-1']) {
    await assert.rejects(
      setup({
        accountSettings: {
          marginMode: 'isolated',
          positionMode: 'hedged',
          leverage
        }
      }).service.run(input()),
      isTradeOpsFailure('ACCOUNT_LEVERAGE_MISMATCH', {
        subjectType: 'account',
        field: 'leverage'
      })
    );
  }
});

test('checks spot balance just below, exactly at, and just above required quote', async () => {
  await assert.rejects(
    setup({ spotFreeUsdt: '99.999999999999999999' }).service.run(input()),
    isTradeOpsFailure('BALANCE_INSUFFICIENT', {
      subjectType: 'account',
      field: 'balance'
    })
  );
  await setup({ spotFreeUsdt: '100' }).service.run(input());
  await setup({ spotFreeUsdt: '100.000000000000000001' }).service.run(input());
});

test('checks contract balance just below, exactly at, and just above leveraged requirement', async () => {
  await assert.rejects(
    setup({ contractFreeUsdt: '59.999999999999999999' }).service.run(input()),
    isTradeOpsFailure('BALANCE_INSUFFICIENT', {
      subjectType: 'account',
      field: 'balance'
    })
  );
  await setup({ contractFreeUsdt: '60' }).service.run(input());
  await setup({
    contractFreeUsdt: '60.000000000000000001'
  }).service.run(input());
});

test('fails closed for malformed spot and contract balances', async () => {
  for (const balance of ['NaN', 'Infinity', '-1']) {
    await assert.rejects(
      setup({ spotFreeUsdt: balance }).service.run(input()),
      isTradeOpsFailure('BALANCE_UNAVAILABLE', {
        subjectType: 'account',
        field: 'balance'
      })
    );
    await assert.rejects(
      setup({ contractFreeUsdt: balance }).service.run(input()),
      isTradeOpsFailure('BALANCE_UNAVAILABLE', {
        subjectType: 'account',
        field: 'balance'
      })
    );
  }
});

test('fails closed when either required reference price is missing or malformed', async () => {
  const missingSpot = setup();
  missingSpot.spot.lastPrices.clear();
  await assert.rejects(
    missingSpot.service.run(input()),
    isTradeOpsFailure('PRICE_UNAVAILABLE', {
      subjectType: 'market',
      field: 'price'
    })
  );

  const missingContract = setup();
  missingContract.contract.lastPrices.clear();
  await assert.rejects(
    missingContract.service.run(input()),
    isTradeOpsFailure('PRICE_UNAVAILABLE', {
      subjectType: 'market',
      field: 'price'
    })
  );

  for (const price of ['NaN', 'Infinity', '0', '-1']) {
    await assert.rejects(
      setup({ spotPrice: price }).service.run(input()),
      isTradeOpsFailure('PRICE_INVALID', {
        subjectType: 'market',
        field: 'price'
      })
    );
    await assert.rejects(
      setup({ contractPrice: price }).service.run(input()),
      isTradeOpsFailure('PRICE_INVALID', {
        subjectType: 'market',
        field: 'price'
      })
    );
  }
});

for (const leg of ['spot', 'contract'] as const) {
  test(`${leg} quote notional respects minimum just below, at, and above`, async () => {
    const marketOption = leg === 'spot'
      ? 'spotMarket' as const
      : 'contractMarket' as const;
    const priceOption = leg === 'spot'
      ? 'spotPrice' as const
      : 'contractPrice' as const;

    await assert.rejects(
      setup({
        [marketOption]: { minQuoteNotional: '100' },
        [priceOption]: '99.999999999999999999',
        spotFreeUsdt: '1000',
        contractFreeUsdt: '1000'
      }).service.run(input()),
      isTradeOpsFailure('NOTIONAL_OUT_OF_RANGE', {
        subjectType: 'market',
        field: 'notional'
      })
    );
    await setup({
      [marketOption]: { minQuoteNotional: '100' },
      [priceOption]: '100',
      spotFreeUsdt: '1000',
      contractFreeUsdt: '1000'
    }).service.run(input());
    await setup({
      [marketOption]: { minQuoteNotional: '100' },
      [priceOption]: '100.000000000000000001',
      spotFreeUsdt: '1000',
      contractFreeUsdt: '1000'
    }).service.run(input());
  });

  test(`${leg} quote notional respects maximum just below, at, and above`, async () => {
    const marketOption = leg === 'spot'
      ? 'spotMarket' as const
      : 'contractMarket' as const;
    const priceOption = leg === 'spot'
      ? 'spotPrice' as const
      : 'contractPrice' as const;

    await setup({
      [marketOption]: { maxQuoteNotional: '100' },
      [priceOption]: '99.999999999999999999',
      spotFreeUsdt: '1000',
      contractFreeUsdt: '1000'
    }).service.run(input());
    await setup({
      [marketOption]: { maxQuoteNotional: '100' },
      [priceOption]: '100',
      spotFreeUsdt: '1000',
      contractFreeUsdt: '1000'
    }).service.run(input());
    await assert.rejects(
      setup({
        [marketOption]: { maxQuoteNotional: '100' },
        [priceOption]: '100.000000000000000001',
        spotFreeUsdt: '1000',
        contractFreeUsdt: '1000'
      }).service.run(input()),
      isTradeOpsFailure('NOTIONAL_OUT_OF_RANGE', {
        subjectType: 'market',
        field: 'notional'
      })
    );
  });
}

test('uses each leg reference price for exact quote-notional checks', async () => {
  await setup({
    spotMarket: {
      amountStep: '0.1',
      minBaseAmount: '0.1',
      minQuoteNotional: '0.02',
      maxQuoteNotional: '0.02'
    },
    contractMarket: {
      amountStep: '0.1',
      minBaseAmount: '0.1',
      minQuoteNotional: '0.03',
      maxQuoteNotional: '0.03'
    },
    spotPrice: '0.2',
    contractPrice: '0.3',
    spotFreeUsdt: '0.02',
    contractFreeUsdt: '0.015',
    accountSettings: {
      marginMode: 'cross',
      positionMode: 'hedged',
      leverage: '2'
    }
  }).service.run(input({ requestedBaseQuantity: '0.1' }));
});

test('rejects invalid quote-notional market limits', async () => {
  for (const limit of ['NaN', 'Infinity', '0', '-1']) {
    await assert.rejects(
      setup({
        spotMarket: { minQuoteNotional: limit }
      }).service.run(input()),
      isTradeOpsFailure('MARKET_RULE_INVALID', {
        subjectType: 'market',
        field: 'minQuoteNotional'
      })
    );
    await assert.rejects(
      setup({
        contractMarket: { maxQuoteNotional: limit }
      }).service.run(input()),
      isTradeOpsFailure('MARKET_RULE_INVALID', {
        subjectType: 'market',
        field: 'maxQuoteNotional'
      })
    );
  }

  await assert.rejects(
    setup({
      spotMarket: {
        minQuoteNotional: '101',
        maxQuoteNotional: '100'
      }
    }).service.run(input()),
    isTradeOpsFailure('MARKET_RULE_INVALID', {
      subjectType: 'market',
      field: 'quoteNotionalRange'
    })
  );
});
