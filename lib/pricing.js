'use strict';

const fs = require('node:fs');

// Prices are USD per million tokens, for standard, first-party text requests.
// Keep each generation separate: a retired model must not inherit a successor's price.
const PRICING_METADATA = Object.freeze({
  asOf: '2026-11-05',
  currency: 'USD',
  unit: 'per_million_tokens',
  sources: Object.freeze({
    anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
    openai4oMini: 'https://developers.openai.com/api/docs/models/gpt-4o-mini',
    openai41Mini: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
    openaiCaching: 'https://developers.openai.com/api/docs/guides/prompt-caching',
    google: 'https://aistudio.google.com/docs/pricing#gemini-3-flash-preview'
  }),
  legacyUnverified: Object.freeze(['google/gemini-3-pro-preview', 'xai/grok-4-1-fast']),
  notes: Object.freeze([
    'Legacy unverified rows retain repository defaults; they are not prices verified on the asOf date.',
    'An aggregate Claude cacheWrite count is estimated at the 5-minute rate; separate 5-minute/1-hour counts take precedence.',
    'Gemini Flash rates cover text/image/video tokens, excluding audio, cache storage duration and tools.',
    'Catalog estimates exclude batch/priority/regional premiums, negotiated discounts and non-token fees.',
    'OpenAI cacheWrite=0 applies only to the two cataloged legacy models, not to all OpenAI models.'
  ])
});

function rates(input, output, cacheRead, cacheWrite, cacheWrite1h = cacheWrite) {
  return Object.freeze({ input, output, cacheRead, cacheWrite, cacheWrite5m: cacheWrite, cacheWrite1h });
}

const DEFAULT_MODEL_PRICING = Object.freeze({
  'anthropic/claude-opus-4': rates(15, 75, 1.5, 18.75, 30),
  'anthropic/claude-opus-4-1': rates(15, 75, 1.5, 18.75, 30),
  'anthropic/claude-opus-4-5': rates(5, 25, 0.5, 6.25, 10),
  'anthropic/claude-opus-4-6': rates(5, 25, 0.5, 6.25, 10),
  'anthropic/claude-opus-4-7': rates(5, 25, 0.5, 6.25, 10),
  'anthropic/claude-opus-4-8': rates(5, 25, 0.5, 6.25, 10),
  'anthropic/claude-opus-5': rates(5, 25, 0.5, 6.25, 10),
  'anthropic/claude-opus-5-5': rates(4, 20, 0.2, 5, 8),
  'anthropic/claude-sonnet-4': rates(3, 15, 0.3, 3.75, 6),
  'anthropic/claude-sonnet-4-5': rates(3, 15, 0.3, 3.75, 6),
  'anthropic/claude-sonnet-4-6': rates(3, 15, 0.3, 3.75, 6),
  'anthropic/claude-sonnet-5': rates(2, 10, 0.2, 2.5, 4),
  'anthropic/claude-sonnet-5-5': rates(2, 10, 0.1, 2.5, 4),
  'anthropic/claude-3-5-haiku-latest': rates(0.8, 4, 0.08, 1, 1.6),
  'anthropic/claude-haiku-4-5': rates(1, 5, 0.1, 1.25, 2),
  'anthropic/claude-haiku-5-5': Object.freeze({
    ...rates(0.1, 0.5, 0.01, 0.125, 0.2),
    aboveInputTokens: 100000,
    longContext: rates(0.5, 2.5, 0.05, 0.625, 1)
  }),
  'anthropic/claude-fable-5': rates(10, 50, 1, 12.5, 20),
  'anthropic/claude-fable-5-1': rates(10, 50, 0.25, 12.5, 20),
  'anthropic/claude-mythos-5': rates(10, 50, 1, 12.5, 20),
  'anthropic/claude-mythos-5-1': rates(10, 50, 0.25, 12.5, 20),
  'openai/gpt-4o-mini': rates(0.15, 0.6, 0.075, 0),
  'openai/gpt-4.1-mini': rates(0.4, 1.6, 0.1, 0),
  // Preserve these legacy rows until their historical prices can be verified.
  'google/gemini-3-pro-preview': rates(1.25, 10, 0.31, 4.5),
  'google/gemini-3-flash-preview': rates(0.5, 3, 0.05, 0),
  'xai/grok-4-1-fast': rates(0.2, 0.5, 0.05, 0.2)
});

function toNum(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeProvider(provider) {
  return String(provider || 'unknown').trim().toLowerCase() || 'unknown';
}

function rawModel(provider, model) {
  let value = String(model || 'unknown').trim().toLowerCase() || 'unknown';
  const prefix = normalizeProvider(provider) + '/';
  if (value.startsWith(prefix)) value = value.slice(prefix.length);
  return value;
}

const modelAliases = new Map();
for (const key of Object.keys(DEFAULT_MODEL_PRICING)) {
  const model = key.slice(key.indexOf('/') + 1);
  modelAliases.set(model, model);
  if (model.startsWith('claude-') || model.startsWith('grok-')) {
    modelAliases.set(model.replace(/(\d)-(\d)/g, '$1.$2'), model);
  }
  if (model.startsWith('gpt-')) modelAliases.set(model.replace(/(\d)\.(\d)/g, '$1-$2'), model);
}
modelAliases.set('claude-3-5-haiku', 'claude-3-5-haiku-latest');
modelAliases.set('claude-3.5-haiku', 'claude-3-5-haiku-latest');

const SNAPSHOT_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

function normalizeModel(provider, model) {
  const value = rawModel(provider, model);
  // A model may include an upstream provider prefix, even with a custom provider.
  const leaf = value.slice(value.lastIndexOf('/') + 1);
  for (const candidate of [leaf, leaf.replace(SNAPSHOT_SUFFIX, ''), leaf.replace(/-latest$/, '')]) {
    if (modelAliases.has(candidate)) return modelAliases.get(candidate);
  }
  // Preserve unknown names instead of guessing a neighboring model's price.
  return value;
}

function inferProviderFromModel(model) {
  const name = String(model || '').toLowerCase().split('/').pop();
  if (name.startsWith('claude-')) return 'anthropic';
  if (/^(?:gpt-|o[1-9](?:-|$))/.test(name)) return 'openai';
  if (name.startsWith('gemini-')) return 'google';
  if (name.startsWith('grok-')) return 'xai';
  return null;
}

function normalizeOverrideModel(provider, model) {
  const raw = rawModel(provider, model);
  const suffix = raw.match(SNAPSHOT_SUFFIX);
  return suffix ? normalizeModel(provider, raw.slice(0, -suffix[0].length)) + suffix[0] : normalizeModel(provider, raw);
}

const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'];

function sanitizeRates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const present = RATE_FIELDS.filter(field => Object.hasOwn(value, field));
  if (!present.length) return null;
  // A malformed override must not silently turn a paid model into a free model.
  for (const field of present) {
    const n = value[field];
    if ((typeof n !== 'number' && typeof n !== 'string') || String(n).trim() === '' || !Number.isFinite(Number(n)) || Number(n) < 0) return null;
  }
  const write = toNum(value.cacheWrite ?? value.cacheWrite5m);
  return Object.freeze({
    input: toNum(value.input),
    output: toNum(value.output),
    cacheRead: toNum(value.cacheRead),
    cacheWrite: write,
    cacheWrite5m: toNum(value.cacheWrite5m ?? write),
    cacheWrite1h: toNum(value.cacheWrite1h ?? write)
  });
}

function readOverrides(pricingFile) {
  const overrides = Object.create(null);
  if (!pricingFile) return overrides;
  try {
    const parsed = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
    const values = parsed && parsed.rates_usd_per_million;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return overrides;
    for (const [key, value] of Object.entries(values)) {
      const slash = key.indexOf('/');
      if (slash <= 0 || slash === key.length - 1) continue;
      const valid = sanitizeRates(value);
      if (!valid) continue;
      const provider = normalizeProvider(key.slice(0, slash));
      const model = rawModel(provider, key.slice(slash + 1));
      // Retain an exact snapshot override; it must not change the whole family.
      const canonical = normalizeOverrideModel(provider, model);
      overrides[`${provider}/${canonical}`] = valid;
    }
  } catch {
    // A missing, unreadable or invalid file falls back to the bundled catalog.
  }
  return overrides;
}

function loadModelPricing(pricingFile) {
  return Object.assign(Object.create(null), DEFAULT_MODEL_PRICING, readOverrides(pricingFile));
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function usageTokens(usage = {}, provider) {
  usage = usage && typeof usage === 'object' ? usage : {};
  const creation = usage.cache_creation || {};
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const cacheRead = toNum(firstDefined(usage.cacheRead, usage.cache_read_input_tokens, details.cached_tokens));
  const totalWrite = toNum(firstDefined(usage.cacheWrite, usage.cache_creation_input_tokens, details.cache_write_tokens));
  const shortWrite = firstDefined(usage.cacheWrite5m, creation.ephemeral_5m_input_tokens);
  const longWrite = firstDefined(usage.cacheWrite1h, creation.ephemeral_1h_input_tokens);
  // Normalized OpenClaw fields exclude cached tokens from input. Raw OpenAI
  // prompt/input_tokens include them; remove them once, before adding cache costs.
  let input = toNum(firstDefined(usage.input, usage.input_tokens, usage.prompt_tokens));
  const hasSplits = shortWrite !== undefined || longWrite !== undefined;
  const write1h = toNum(longWrite);
  const write5m = hasSplits ? toNum(shortWrite) + Math.max(0, totalWrite - toNum(shortWrite) - write1h) : totalWrite;
  if (usage.input === undefined && provider === 'openai') input = Math.max(0, input - cacheRead - write5m - write1h);
  return {
    input,
    output: toNum(firstDefined(usage.output, usage.output_tokens, usage.completion_tokens)),
    cacheRead,
    cacheWrite: write5m + write1h,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h
  };
}

function createPricing(pricingFile) {
  const overrides = readOverrides(pricingFile);
  const MODEL_PRICING = Object.freeze(Object.assign(Object.create(null), DEFAULT_MODEL_PRICING, overrides));

  function resolveRates(provider, model) {
    const p = normalizeProvider(provider);
    const raw = rawModel(p, model);
    const normalized = normalizeModel(p, model);
    const snapshot = normalizeOverrideModel(p, raw);
    const exactKeys = [...new Set([`${p}/${raw}`, `${p}/${snapshot}`, `${p}/${normalized}`])];
    // Custom-provider rates always win over inferred upstream prices.
    for (const key of exactKeys) {
      if (Object.hasOwn(overrides, key)) return { rates: overrides[key], key, source: 'override' };
    }
    const inferred = inferProviderFromModel(normalized);
    const upstreamKeys = inferred ? [...new Set([`${inferred}/${raw}`, `${inferred}/${snapshot}`, `${inferred}/${normalized}`])] : [];
    for (const key of upstreamKeys) {
      if (Object.hasOwn(overrides, key)) return { rates: overrides[key], key, source: 'override' };
    }
    for (const key of [...exactKeys, ...upstreamKeys]) {
      if (Object.hasOwn(DEFAULT_MODEL_PRICING, key)) return { rates: DEFAULT_MODEL_PRICING[key], key, source: 'catalog' };
    }
    return null;
  }

  function lookupRates(provider, model, inputTokens = 0) {
    const found = resolveRates(provider, model);
    if (!found) return null;
    const row = found.rates;
    return row.longContext && toNum(inputTokens) > row.aboveInputTokens ? row.longContext : row;
  }

  function getCostInfo(msg) {
    const provider = normalizeProvider(msg && msg.provider);
    const model = normalizeModel(provider, msg && msg.model);
    const base = { provider, model, breakdown: null };
    if (model === 'delivery-mirror' || model.endsWith('/delivery-mirror')) return { ...base, cost: 0, priced: true, source: 'ignored' };
    const usage = msg && msg.usage && typeof msg.usage === 'object' ? msg.usage : {};
    const explicit = toNum(usage.cost && usage.cost.total);
    if (explicit > 0) return { ...base, cost: explicit, priced: true, source: 'reported' };
    const found = resolveRates(provider, msg && msg.model);
    if (!found) return { ...base, cost: 0, priced: false, source: 'unpriced' };
    const tokens = usageTokens(usage, inferProviderFromModel(model) || provider);
    const context = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
    const row = found.rates.longContext && context > found.rates.aboveInputTokens ? found.rates.longContext : found.rates;
    const breakdown = {
      inputCost: tokens.input / 1e6 * row.input,
      outputCost: tokens.output / 1e6 * row.output,
      cacheReadCost: tokens.cacheRead / 1e6 * row.cacheRead,
      cacheWriteCost: tokens.cacheWrite5m / 1e6 * row.cacheWrite5m + tokens.cacheWrite1h / 1e6 * row.cacheWrite1h
    };
    const cost = breakdown.inputCost + breakdown.outputCost + breakdown.cacheReadCost + breakdown.cacheWriteCost;
    if (!Number.isFinite(cost)) return { ...base, cost: 0, priced: false, source: 'unpriced' };
    return { ...base, cost, priced: true, source: found.source, pricingKey: found.key, breakdown };
  }

  function estimateMsgCost(msg) {
    return getCostInfo(msg).cost;
  }

  return { MODEL_PRICING, lookupRates, estimateMsgCost, getCostInfo };
}

const defaultPricing = createPricing();
module.exports = {
  DEFAULT_MODEL_PRICING,
  PRICING_METADATA,
  toNum,
  normalizeProvider,
  normalizeModel,
  inferProviderFromModel,
  usageTokens,
  loadModelPricing,
  createPricing,
  ...defaultPricing
};
