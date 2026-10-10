import { expect, it, vi } from 'vitest';
import { configureIntegrations } from './index.js';
import { sampleConfig } from '../agent/testing/fakes.js';

it('turns a declined cfo.ai integration off and restores the configured local budget', async () => {
  const config = sampleConfig();
  config.integrations.cfoai = true;
  config.budget.source = 'cfoai';
  const configure = vi.fn(async () => ({ enabled: false, state: { status: 'off' as const, detail: 'Declined' }, budget: { source: 'config' as const, usd: 40 } }));
  const ui = { print: vi.fn(), confirm: async () => false, select: async () => null };
  await configureIntegrations({ config, ui }, { cfoai: { check: async () => ({ status: 'off', detail: 'off' }), connect: async () => ({ status: 'off', detail: 'off' }), configure } });
  expect(config.integrations.cfoai).toBe(false);
  expect(config.budget).toEqual({ source: 'config', usd: 40 });
  config.integrations.cfoai = false;
  await configureIntegrations({ config, ui }, { cfoai: { check: async () => ({ status: 'off', detail: 'off' }), connect: async () => ({ status: 'off', detail: 'off' }), configure } });
  expect(configure).toHaveBeenCalledOnce();
});
