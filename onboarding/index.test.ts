import { expect, it, vi } from 'vitest';
import { configureIntegrations } from './index.js';
import { sampleConfig } from '../agent/testing/fakes.js';

it('configures selected products in the order shown during init', async () => {
  const config = sampleConfig();
  config.integrations = { neatlogs: true, entire: true, cfoai: true, slack: false };
  const order: string[] = [];
  const product = (name: string) => ({
    check: async () => ({ status: 'ok' as const, detail: '' }),
    connect: async () => ({ status: 'ok' as const, detail: '' }),
    configure: async () => { order.push(name); return { enabled: true, state: { status: 'ok' as const, detail: '' } }; },
  });
  await configureIntegrations({ config, ui: { print: () => {}, confirm: async () => false, select: async () => null } }, {
    neatlogs: product('Neatlogs'), entire: product('Entire'), cfoai: product('cfo.ai'),
  });
  expect(order).toEqual(['Neatlogs', 'Entire', 'cfo.ai']);
});

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
