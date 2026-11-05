'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_MODEL_PRICING, PRICING_METADATA, createPricing, loadModelPricing,
  normalizeProvider, normalizeModel, usageTokens, toNum
} = require('../lib/pricing');

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `Expected ${expected}, got ${actual}`);
}

function withOverrides(t, values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-pricing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pricing.json');
  fs.writeFileSync(file, JSON.stringify({ rates_usd_per_million: values }));
  return { file, ...createPricing(file) };
}

test('verified Opus generations and legacy prices stay distinct', () => {
  const { lookupRates } = createPricing();
  for (const version of ['4-5', '4-6', '4-7', '4-8', '5']) {
    const row = lookupRates('anthropic', 'claude-opus-' + version);
    assert.deepEqual([row.input, row.output, row.cacheRead, row.cacheWrite, row.cacheWrite1h], [5, 25, 0.5, 6.25, 10]);
  }
  for (const version of ['4', '4-1']) {
    const row = lookupRates('anthropic', 'claude-opus-' + version);
    assert.deepEqual([row.input, row.output, row.cacheRead], [15, 75, 1.5]);
  }
  const newest = lookupRates('anthropic', 'claude-opus-5.5');
  assert.deepEqual([newest.input, newest.output, newest.cacheRead], [4, 20, 0.2]);
});

test('current Sonnet and Haiku rows use their own rates', () => {
  const { lookupRates } = createPricing();
  for (const [model, expected] of [
    ['claude-sonnet-4-5', [3, 15, 0.3]], ['claude-sonnet-4-6', [3, 15, 0.3]],
    ['claude-sonnet-5', [2, 10, 0.2]], ['claude-sonnet-5-5', [2, 10, 0.1]],
    ['claude-haiku-4-5', [1, 5, 0.1]], ['claude-3-5-haiku-20241022', [0.8, 4, 0.08]]
  ]) {
    const row = lookupRates('anthropic', model);
    assert.deepEqual([row.input, row.output, row.cacheRead], expected, model);
  }
});

test('custom providers normalize version punctuation, prefixes, case and snapshots', () => {
  const { lookupRates, estimateMsgCost } = createPricing();
  for (const model of [
    'claude-opus-4.6', 'Claude-Opus-4-6', 'anthropic/claude-opus-4.6',
    'anthropic/claude-opus-4-6-20260205', 'claude-opus-4.6-2026-02-05',
    'custom-10-32-86-60-4141/anthropic/claude-opus-4.6-latest'
  ]) {
    assert.equal(normalizeModel('custom-10-32-86-60-4141', model), 'claude-opus-4-6', model);
    assert.equal(lookupRates('custom-10-32-86-60-4141', model).input, 5, model);
    near(estimateMsgCost({ provider: 'custom-10-32-86-60-4141', model, usage: { input: 1000, cost: { total: 0 } } }), 0.005);
  }
  assert.equal(lookupRates('proxy', 'openai/gpt-4.1-mini-2025-04-14').cacheRead, 0.1);
  assert.equal(lookupRates('proxy', 'google/gemini-3-flash-preview').input, 0.5);
});

test('unknown versions never inherit neighboring or newer model prices', () => {
  const { lookupRates } = createPricing();
  for (const model of ['claude-opus-4-50', 'claude-opus-4-6-experimental', 'claude-opus-6', 'claude-haiku-3', 'gpt-6']) {
    assert.equal(lookupRates('custom', model), null, model);
  }
  assert.equal(normalizeModel('anthropic', 'claude-opus-4-1-20250805'), 'claude-opus-4-1');
  assert.equal(lookupRates('anthropic', 'claude-opus-4-1-20250805').input, 15);
});

test('exact custom overrides win over inferred upstream overrides and defaults', t => {
  const pricing = withOverrides(t, {
    'anthropic/claude-opus-4.6': { input: 8, output: 40 },
    'CUSTOM/claude-opus-4.6': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
  });
  assert.equal(pricing.lookupRates('custom', 'anthropic/claude-opus-4.6').input, 2);
  const info = pricing.getCostInfo({ provider: 'custom', model: 'claude-opus-4.6', usage: { input: 1e6 } });
  assert.equal(info.cost, 2);
  assert.equal(info.source, 'override');
  assert.equal(pricing.lookupRates('other-custom', 'claude-opus-4.6').input, 8);
  assert.equal(pricing.lookupRates('anthropic', 'claude-sonnet-4-6').input, 3, 'unrelated defaults remain available');
  assert.equal(loadModelPricing(pricing.file)['anthropic/claude-sonnet-4-6'].input, 3);
});

test('an override for one snapshot does not override the whole model family', t => {
  const pricing = withOverrides(t, {
    'custom/claude-opus-4.6-20260205': { input: 1, output: 2 },
    'anthropic/claude-opus-4-6-20260206': { input: 3, output: 4 }
  });
  assert.equal(pricing.lookupRates('custom', 'claude-opus-4-6-20260205').input, 1);
  assert.equal(pricing.lookupRates('custom', 'anthropic/claude-opus-4.6-20260206').input, 3);
  assert.equal(pricing.lookupRates('custom', 'claude-opus-4.6').input, 5);
  assert.equal(pricing.lookupRates('custom', 'claude-opus-4.6-20260207').input, 5);
});

test('unknown custom models can receive explicit zero or paid override rates', t => {
  const pricing = withOverrides(t, {
    'ollama/local-model': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    'my-host/my-model': { input: '1.5', output: 3 }
  });
  const free = pricing.getCostInfo({ provider: 'ollama', model: 'local-model', usage: { input: 10000 } });
  assert.deepEqual([free.cost, free.priced, free.source], [0, true, 'override']);
  assert.equal(pricing.estimateMsgCost({ provider: 'my-host', model: 'my-model', usage: { input: 1e6 } }), 1.5);
});

test('reported positive cost is authoritative, while reported zero falls back to estimation', () => {
  const { getCostInfo, estimateMsgCost } = createPricing();
  const msg = { provider: 'custom', model: 'claude-opus-4.6', usage: { input: 1e6, cost: { total: 0.123 } } };
  assert.equal(estimateMsgCost(msg), 0.123);
  assert.equal(getCostInfo(msg).source, 'reported');
  assert.equal(getCostInfo(msg).breakdown, null, 'reported cost cannot be allocated by catalog rates');
  msg.usage.cost.total = 0;
  assert.equal(estimateMsgCost(msg), 5);
  assert.equal(getCostInfo({ model: 'unlisted', usage: { cost: { total: 1 } } }).priced, true);
});

test('unpriced zero differs from a priced zero, with numeric estimate compatibility', () => {
  const { getCostInfo, estimateMsgCost } = createPricing();
  const missing = getCostInfo({ provider: 'local', model: 'unlisted', usage: { input: 1e6 } });
  assert.deepEqual([missing.cost, missing.priced, missing.source], [0, false, 'unpriced']);
  const empty = getCostInfo({ provider: 'anthropic', model: 'claude-opus-4.6', usage: {} });
  assert.deepEqual([empty.cost, empty.priced, empty.source], [0, true, 'catalog']);
  assert.equal(estimateMsgCost(undefined), 0);
});

test('delivery mirrors do not become billable or unpriced calls', () => {
  const { getCostInfo } = createPricing();
  for (const model of ['delivery-mirror', 'openclaw/delivery-mirror']) {
    const info = getCostInfo({ model, usage: { input: 1e6, cost: { total: 2 } } });
    assert.deepEqual([info.cost, info.priced, info.source], [0, true, 'ignored']);
  }
});

test('OpenClaw input, output, cache reads and cache writes are counted independently', () => {
  const { estimateMsgCost } = createPricing();
  near(estimateMsgCost({ provider: 'custom', model: 'claude-opus-4.6', usage: { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 } }), 36.75);
});

test('cache lifetime split replaces aggregate writes without double counting', () => {
  const { estimateMsgCost } = createPricing();
  const model = 'claude-opus-4-6';
  const provider = 'anthropic';
  near(estimateMsgCost({ provider, model, usage: { cacheWrite: 1e6, cacheWrite5m: 400000, cacheWrite1h: 600000 } }), 8.5);
  near(estimateMsgCost({ provider, model, usage: { cacheWrite: 1e6, cacheWrite1h: 600000 } }), 8.5);
  near(estimateMsgCost({ provider, model, usage: { cacheWrite1h: 1e6 } }), 10);
  near(estimateMsgCost({ provider, model, usage: { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 400000, ephemeral_1h_input_tokens: 600000 } } }), 8.5);
});

test('raw Anthropic input excludes cache counts and raw legacy OpenAI input includes them', () => {
  const { estimateMsgCost } = createPricing();
  near(estimateMsgCost({ provider: 'proxy', model: 'claude-opus-4.6', usage: { input_tokens: 1e6, cache_read_input_tokens: 1e6 } }), 5.5);
  near(estimateMsgCost({ provider: 'proxy', model: 'gpt-4o-mini', usage: { input_tokens: 2e6, input_tokens_details: { cached_tokens: 1e6 } } }), 0.225);
  near(estimateMsgCost({ provider: 'openai', model: 'gpt-4.1-mini', usage: { prompt_tokens: 2e6, prompt_tokens_details: { cached_tokens: 1e6 } } }), 0.5);
  near(estimateMsgCost({ provider: 'openai', model: 'gpt-4o-mini', usage: { input: 1e6, cacheRead: 1e6 } }), 0.225);
});

test('legacy OpenAI models have verified cache read prices and no extra write charge', () => {
  const { lookupRates, estimateMsgCost } = createPricing();
  for (const [model, input, output, cached] of [['gpt-4o-mini', 0.15, 0.6, 0.075], ['gpt-4.1-mini', 0.4, 1.6, 0.1]]) {
    const row = lookupRates('openai', model);
    assert.deepEqual([row.input, row.output, row.cacheRead, row.cacheWrite], [input, output, cached, 0]);
    assert.equal(estimateMsgCost({ provider: 'openai', model, usage: { cacheWrite: 1e6 } }), 0);
  }
  assert.equal(lookupRates('openai', 'gpt-6'), null, 'new models do not inherit a blanket no-write-charge rule');
});

test('Haiku 5.5 applies the higher full-request rate only above 100k context tokens', () => {
  const { lookupRates, estimateMsgCost } = createPricing();
  assert.equal(lookupRates('anthropic', 'claude-haiku-5.5', 100000).input, 0.1);
  assert.equal(lookupRates('anthropic', 'claude-haiku-5.5', 100001).input, 0.5);
  near(estimateMsgCost({ model: 'claude-haiku-5.5', usage: { input: 100000, output: 1000 } }), 0.0105);
  near(estimateMsgCost({ model: 'claude-haiku-5.5', usage: { input: 100001, output: 1000 } }), 0.0525005);
  near(estimateMsgCost({ model: 'claude-haiku-5.5', usage: { input: 1, cacheRead: 100000 } }), 0.0050005);
});

test('cost components retain cache lifetimes and context tiers for aggregation', () => {
  const { getCostInfo } = createPricing();
  const info = getCostInfo({ model: 'claude-opus-4.6', usage: { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite1h: 1e6 } });
  assert.deepEqual(info.breakdown, { inputCost: 5, outputCost: 25, cacheReadCost: 0.5, cacheWriteCost: 10 });
  assert.equal(info.cost, 40.5);
  const haiku = getCostInfo({ model: 'claude-haiku-5.5', usage: { input: 100001, output: 1000 } });
  near(haiku.breakdown.inputCost, 0.0500005);
  near(haiku.breakdown.outputCost, 0.0025);
  assert.equal(getCostInfo({ model: 'unknown' }).breakdown, null);
});

test('usage token helper exposes normalized totals without counting split writes twice', () => {
  assert.deepEqual(usageTokens({ input: 10, output: 20, cacheRead: 30, cacheWrite: 100, cacheWrite1h: 40 }), {
    input: 10, output: 20, cacheRead: 30, cacheWrite: 100, cacheWrite5m: 60, cacheWrite1h: 40
  });
  assert.equal(usageTokens({ input_tokens: 100, input_tokens_details: { cached_tokens: 30 } }, 'openai').input, 70);
  assert.equal(usageTokens(null).cacheWrite, 0);
});

test('negative, nonfinite and invalid usage numbers cannot generate invalid cost', () => {
  const { estimateMsgCost } = createPricing();
  for (const value of [-1, '-1', NaN, Infinity, -Infinity, 'NaN', 'Infinity', {}, [], null, undefined, Symbol('invalid')]) {
    assert.equal(toNum(value), 0);
    assert.equal(estimateMsgCost({ model: 'claude-opus-4.6', usage: { input: value, output: value, cacheRead: value, cacheWrite: value } }), 0);
  }
  assert.equal(toNum('123.5'), 123.5);
  assert.equal(normalizeProvider(' CUSTOM '), 'custom');
});

test('invalid overrides or malformed files preserve catalog pricing', t => {
  const pricing = withOverrides(t, {
    'anthropic/claude-opus-4.6': { input: -10, output: 0 },
    'bad/thing': { input: 'Infinity' },
    'bad/empty': {},
    'missing-slash': { input: 1 },
    'openai/gpt-4o-mini': { input: null, output: 0 }
  });
  assert.equal(pricing.lookupRates('anthropic', 'claude-opus-4.6').input, 5);
  assert.equal(pricing.lookupRates('openai', 'gpt-4o-mini').input, 0.15);
  assert.equal(pricing.lookupRates('bad', 'thing'), null);
  fs.writeFileSync(pricing.file, '{invalid json');
  assert.equal(createPricing(pricing.file).lookupRates('anthropic', 'claude-opus-4.6').input, 5);
  assert.equal(createPricing(path.join(path.dirname(pricing.file), 'missing.json')).lookupRates('anthropic', 'claude-opus-4.6').input, 5);
});

test('catalog metadata identifies sources, date and unchanged legacy rows', () => {
  assert.equal(PRICING_METADATA.asOf, '2026-11-05');
  assert.match(PRICING_METADATA.sources.anthropic, /^https:\/\/platform\.claude\.com\//);
  assert.ok(PRICING_METADATA.legacyUnverified.includes('google/gemini-3-pro-preview'));
  assert.equal(DEFAULT_MODEL_PRICING['google/gemini-3-pro-preview'].input, 1.25);
  assert.deepEqual([DEFAULT_MODEL_PRICING['google/gemini-3-flash-preview'].input, DEFAULT_MODEL_PRICING['google/gemini-3-flash-preview'].output, DEFAULT_MODEL_PRICING['google/gemini-3-flash-preview'].cacheRead], [0.5, 3, 0.05]);
});
