import { describe, expect, it } from 'vitest';
import { CODEX_LIST_PRICES, tierPriceNote } from './pricing.js';

describe('price provenance', () => {
  it.each(Object.keys(CODEX_LIST_PRICES))('cites verified base rates for %s', (model) => {
    const note = tierPriceNote({ provider: 'openai', model, price: CODEX_LIST_PRICES[model]! });
    expect(note).toContain('Verified base list price');
    expect(note).toContain(`https://developers.openai.com/api/docs/models/${model}`);
    expect(note).toContain('checked 2026-10-11');
    expect(note).toContain('Not an invoice');
  });

  it('does not verify legacy rates just because the model has published pricing', () => {
    const note = tierPriceNote({ provider: 'openai', model: 'gpt-5.6-terra', price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 5 } });
    expect(note).toContain('Unverified configured price: differs');
    expect(note).toContain('published 2/0.2/12');
  });

  it('labels unknown models and providers unverified even with an operator note', () => {
    for (const tier of [
      { provider: 'openai', model: 'unknown' },
      { provider: 'gateway', model: 'gpt-5.6-luna' },
    ]) {
      expect(tierPriceNote({ ...tier, price: CODEX_LIST_PRICES['gpt-5.6-luna']!, priceNote: 'operator source' })).toContain('Unverified configured price');
    }
  });
});
