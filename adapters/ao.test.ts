import { describe, expect, it } from 'vitest';
import { usageFromAoPayload } from './ao.js';

describe('usageFromAoPayload', () => {
  it('maps AO usage totals into the shared live usage shape', () => {
    expect(
      usageFromAoPayload({
        totals: {
          inputTokens: 100,
          cachedInputTokens: 30,
          uncachedInputTokens: 70,
          outputTokens: 11,
          estimatedCost: { totalNanos: 1234 },
        },
      }),
    ).toEqual({
      tokens: { uncachedInput: 70, cachedInput: 30, output: 11, total: 111 },
      estimatedCostNanos: 1234,
    });
  });

  it('returns null until AO reports tokens', () => {
    expect(usageFromAoPayload({ totals: { inputTokens: 0, outputTokens: 0 } })).toBeNull();
  });
});
