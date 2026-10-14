import type { Tier } from '../schema/types.js';
/** Turn a worker's explicit model-access rejection into an actionable config error. */
export declare function modelAccessConfigurationError(error: unknown, tier: Pick<Tier, 'name' | 'harness' | 'model'>): string | null;
