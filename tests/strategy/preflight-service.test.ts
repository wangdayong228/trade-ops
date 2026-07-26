/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AccountSettings,
  ExecutionMode,
  MarketKind,
  MarketRules
} from '../../src/domain/types.js';
import { ExchangeRegistry } from '../../src/exchanges/exchange-registry.js';
import {
  PreflightService,
  type PreflightInput
} from '../../src/strategy/preflight-service.js';
import { FakeExchangeGateway } from '../support/fake-exchange-gateway.js';

const SYMBOL = 'BTC/USDT';

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
} = {}): {
  service: PreflightService;
  spot: FakeExchangeGateway;
  contract: FakeExchangeGateway;
} {
  const spot = new FakeExchangeGateway('bitget');
  const contract = new FakeExchangeGateway('okx');
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
    positionMode: 'one-way',
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

test('returns normalized quantity and a confirmed preview snapshot', async () => {
  const { service, contract } = setup();

  const result = await service.run(input());

  assert.equal(result.effectiveBaseQuantity, '1');
  assert.deepEqual(result.accountSettings, {
    marginMode: 'isolated',
    positionMode: 'one-way',
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

test('rejects same-exchange and unsupported exchange selections', async () => {
  const { service } = setup();

  await assert.rejects(
    service.run(input({ contractExchangeId: 'bitget' })),
    /different exchanges/
  );
  await assert.rejects(
    service.run(input({ spotExchangeId: 'coinbase' })),
    /unsupported exchange/
  );
});

test('rejects different base assets or non-USDT quote markets', async () => {
  const differentBase = setup({
    contractMarket: { base: 'ETH' }
  });
  await assert.rejects(
    differentBase.service.run(input()),
    /same base.*USDT/
  );

  const nonUsdt = setup({
    spotMarket: { quote: 'BTC' } as unknown as Partial<MarketRules>
  });
  await assert.rejects(
    nonUsdt.service.run(input()),
    /same base.*USDT/
  );
});

test('rejects inactive or unexpected market kinds', async () => {
  for (const configured of [
    setup({ spotMarket: { active: false } }),
    setup({ contractMarket: { active: false } }),
    setup({ spotMarket: { kind: 'swap' } }),
    setup({ contractMarket: { kind: 'spot' } })
  ]) {
    await assert.rejects(
      configured.service.run(input()),
      /active spot.*active linear USDT.*swap/
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
    /execution mode/
  );
});

test('fails closed when margin or position mode is unknown', async () => {
  for (const accountSettings of [
    {
      marginMode: 'unknown',
      positionMode: 'one-way',
      leverage: '2'
    },
    {
      marginMode: 'isolated',
      positionMode: 'unknown',
      leverage: '2'
    }
  ] satisfies AccountSettings[]) {
    await assert.rejects(
      setup({ accountSettings }).service.run(input()),
      /confirmed account settings/
    );
  }
});

test('fails closed when leverage is missing, non-finite, zero, or negative', async () => {
  for (const leverage of [null, 'NaN', 'Infinity', '0', '-1']) {
    await assert.rejects(
      setup({
        accountSettings: {
          marginMode: 'isolated',
          positionMode: 'one-way',
          leverage
        }
      }).service.run(input()),
      /leverage/
    );
  }
});

test('checks spot balance just below, exactly at, and just above required quote', async () => {
  await assert.rejects(
    setup({ spotFreeUsdt: '99.999999999999999999' }).service.run(input()),
    /spot USDT balance/
  );
  await setup({ spotFreeUsdt: '100' }).service.run(input());
  await setup({ spotFreeUsdt: '100.000000000000000001' }).service.run(input());
});

test('checks contract balance just below, exactly at, and just above leveraged requirement', async () => {
  await assert.rejects(
    setup({ contractFreeUsdt: '59.999999999999999999' }).service.run(input()),
    /contract USDT balance/
  );
  await setup({ contractFreeUsdt: '60' }).service.run(input());
  await setup({
    contractFreeUsdt: '60.000000000000000001'
  }).service.run(input());
});

test('fails closed for malformed spot and contract balances', async () => {
  for (const balance of ['NaN', 'Infinity', '-1', '0']) {
    await assert.rejects(
      setup({ spotFreeUsdt: balance }).service.run(input()),
      /spot.*balance/
    );
    await assert.rejects(
      setup({ contractFreeUsdt: balance }).service.run(input()),
      /contract.*balance/
    );
  }
});

test('fails closed when either required reference price is missing or malformed', async () => {
  const missingSpot = setup();
  missingSpot.spot.lastPrices.clear();
  await assert.rejects(
    missingSpot.service.run(input()),
    /missing last price/
  );

  const missingContract = setup();
  missingContract.contract.lastPrices.clear();
  await assert.rejects(
    missingContract.service.run(input()),
    /missing last price/
  );

  for (const price of ['NaN', 'Infinity', '0', '-1']) {
    await assert.rejects(
      setup({ spotPrice: price }).service.run(input()),
      /spot reference price/
    );
    await assert.rejects(
      setup({ contractPrice: price }).service.run(input()),
      /contract reference price/
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
      new RegExp(`${leg} quote notional.*minimum`)
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
      new RegExp(`${leg} quote notional.*maximum`)
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
      /spot minimum quote notional/
    );
    await assert.rejects(
      setup({
        contractMarket: { maxQuoteNotional: limit }
      }).service.run(input()),
      /contract maximum quote notional/
    );
  }

  await assert.rejects(
    setup({
      spotMarket: {
        minQuoteNotional: '101',
        maxQuoteNotional: '100'
      }
    }).service.run(input()),
    /spot quote notional limits/
  );
});
