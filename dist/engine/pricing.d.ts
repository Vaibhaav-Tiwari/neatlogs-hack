import type { Tier, TierPrice } from '../schema/types.js';
/** Official short-context text rates checked on 2026-10-11, not an invoice estimate. */
export declare const CODEX_LIST_PRICES: Record<string, TierPrice>;
/** Anthropic standard first-party input/cache-read/output rates, checked 2026-10-11. */
export declare const CLAUDE_LIST_PRICES: Record<string, TierPrice>;
export declare function tierPriceNote(tier: Pick<Tier, 'model' | 'provider' | 'price' | 'priceNote'>): string;
