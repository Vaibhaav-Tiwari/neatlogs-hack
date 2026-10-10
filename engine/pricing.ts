import type { Tier, TierPrice } from '../schema/types.js';

/** Official short-context text rates checked on 2026-10-11, not an invoice estimate. */
export const CODEX_LIST_PRICES: Record<string, TierPrice> = {
  'gpt-5.6-luna': { inputUsdPerMTok: 0.2, cachedInputUsdPerMTok: 0.02, outputUsdPerMTok: 1.2 },
  'gpt-5.6-terra': { inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.2, outputUsdPerMTok: 12 },
  'gpt-5.6-sol': { inputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.4, outputUsdPerMTok: 20 },
};

export function tierPriceNote(tier: Pick<Tier, 'model' | 'provider' | 'price' | 'priceNote'>): string {
  const published = tier.provider === 'openai' ? CODEX_LIST_PRICES[tier.model] : undefined;
  const rates = `Configured USD per million input/cached/output: ${tier.price.inputUsdPerMTok}/${tier.price.cachedInputUsdPerMTok}/${tier.price.outputUsdPerMTok}.`;
  if (!published) return `Unverified configured price. ${rates}${tier.priceNote ? ` Config note: ${tier.priceNote}` : ' No public source verified by Tally.'}`;
  const matches = Object.entries(published).every(([key, value]) => tier.price[key as keyof TierPrice] === value);
  return `${matches ? 'Verified base list price' : 'Unverified configured price: differs from published rates'}. ${rates} Source: https://developers.openai.com/api/docs/models/${tier.model} (checked 2026-10-11; published ${published.inputUsdPerMTok}/${published.cachedInputUsdPerMTok}/${published.outputUsdPerMTok}). Short-context text rates only; per-request >272K input and cache-write uplifts cannot be resolved from aggregate AO usage. Not an invoice.${tier.priceNote ? ` Config note: ${tier.priceNote}` : ''}`;
}
