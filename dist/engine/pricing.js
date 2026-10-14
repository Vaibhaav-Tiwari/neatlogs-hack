/** Official short-context text rates checked on 2026-10-11, not an invoice estimate. */
export const CODEX_LIST_PRICES = {
    'gpt-5.6-luna': { inputUsdPerMTok: 0.2, cachedInputUsdPerMTok: 0.02, outputUsdPerMTok: 1.2 },
    'gpt-5.6-terra': { inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.2, outputUsdPerMTok: 12 },
    'gpt-5.6-sol': { inputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.4, outputUsdPerMTok: 20 },
};
/** Anthropic standard first-party input/cache-read/output rates, checked 2026-10-11. */
export const CLAUDE_LIST_PRICES = {
    'claude-haiku-4-5-20251001': { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 5 },
    'claude-sonnet-5-5': { inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 10 },
    'claude-opus-5-5': { inputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.2, outputUsdPerMTok: 20 },
};
export function tierPriceNote(tier) {
    const published = tier.provider === 'openai' ? CODEX_LIST_PRICES[tier.model] : tier.provider === 'anthropic' ? CLAUDE_LIST_PRICES[tier.model] : undefined;
    const rates = `Configured USD per million input/cached/output: ${tier.price.inputUsdPerMTok}/${tier.price.cachedInputUsdPerMTok}/${tier.price.outputUsdPerMTok}.`;
    if (!published)
        return `Unverified configured price. ${rates}${tier.priceNote ? ` Config note: ${tier.priceNote}` : ' No public source verified by Tally.'}`;
    const matches = Object.entries(published).every(([key, value]) => tier.price[key] === value);
    if (tier.provider === 'anthropic')
        return `${matches ? 'Verified base list price' : 'Unverified configured price: differs from published rates'}. ${rates} Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-11; published ${published.inputUsdPerMTok}/${published.cachedInputUsdPerMTok}/${published.outputUsdPerMTok}). Standard first-party text and cache-read rates; cache writes, fast mode, geography uplifts and subscription billing are not captured by these normalized list rates. Not an invoice.${tier.priceNote ? ` Config note: ${tier.priceNote}` : ''}`;
    return `${matches ? 'Verified base list price' : 'Unverified configured price: differs from published rates'}. ${rates} Source: https://developers.openai.com/api/docs/models/${tier.model} (checked 2026-10-11; published ${published.inputUsdPerMTok}/${published.cachedInputUsdPerMTok}/${published.outputUsdPerMTok}). Short-context text rates only; per-request >272K input and cache-write uplifts cannot be resolved from aggregate AO usage. Not an invoice.${tier.priceNote ? ` Config note: ${tier.priceNote}` : ''}`;
}
//# sourceMappingURL=pricing.js.map