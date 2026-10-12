import { describe, expect, it } from 'vitest';
import { modelAccessConfigurationError } from './model-access.js';

describe('model access diagnostics', () => {
  const tier = { name: 'top', harness: 'codex', model: 'gpt-5.6-sol' } as const;

  it.each([
    'model not available for this account',
    'The model "gpt-5.6-sol" is not available on your plan',
    'You do not have access to model gpt-5.6-sol',
    'model_not_found',
  ])('turns a model rejection into a tier-specific configuration error: %s', (detail) => {
    const result = modelAccessConfigurationError(new Error(detail), tier);
    expect(result).toContain('Model configuration error for tier "top" (codex, model "gpt-5.6-sol")');
    expect(result).toContain('update this tier\'s model in tally.yaml');
  });

  it('does not mislabel unrelated worker errors and redacts credentials from provider detail', () => {
    expect(modelAccessConfigurationError(new Error('invalid API response'), tier)).toBeNull();
    expect(modelAccessConfigurationError(new Error('model not available; api_key=secret-value-123'), tier)).not.toContain('secret-value-123');
    expect(modelAccessConfigurationError(new Error('model not available; Authorization: Bearer secret-value-456'), tier)).not.toContain('secret-value-456');
  });
});
