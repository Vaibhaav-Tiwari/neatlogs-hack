import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { planTally, readPlanBudget } from './plan.js';
import { CfoaiBudgetAdapter } from '../adapters/cfoai.js';
import { NeatlogsPriceHistory } from '../adapters/neatlogs-history.js';
import { routeTask } from '../agent/router.js';
import { sizeTask } from '../agent/sizer.js';
import { loadConfig } from './config.js';
import { createPriceHistory } from './price-history.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-plan-'));
  const configPath = join(dir, 'tally.yaml');
  writeFileSync(
    configPath,
    `version: 1
repo: { path: ".", slug: "acme/demo", baseBranch: "main" }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: claude-code
    provider: test
    model: cheap-model
    price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 1 }
    ceilingFraction: 0.2
  - name: top
    harness: codex
    provider: test
    model: top-model
    price: { inputUsdPerMTok: 5, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 5 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 4, large: 10 }
budget: { source: config, usd: 10 }
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
`,
  );
  writeFileSync(
    join(dir, 'backlog.yaml'),
    `tasks:
  - id: T1
    title: Fix \`calc.ts\` should add values
    body: Expected calc.ts to return a + b.
    size: small
`,
  );
  return configPath;
}

describe('planTally', () => {
  it('reads monthly cfo.ai budget even with a CLI cap and closes the client', async () => {
    const config = loadConfig(fixture());
    config.integrations.cfoai = true;
    const read = vi.spyOn(CfoaiBudgetAdapter.prototype, 'budgetLimitNanos').mockResolvedValue(40_000_000_000);
    const close = vi.spyOn(CfoaiBudgetAdapter.prototype, 'close').mockResolvedValue();
    try {
      expect(await readPlanBudget(config, { budgetUsd: 1 })).toEqual({ source: 'cfoai', limitSource: 'cli', limitNanos: 1_000_000_000, monthlyLimitNanos: 40_000_000_000 });
      expect(close).toHaveBeenCalledOnce();
    } finally { read.mockRestore(); close.mockRestore(); }
  });
  it.each([false, true])('closes the read-only budget client even after an error: %s', async failure => {
    const config = loadConfig(fixture());
    config.budget.source = 'cfoai';
    const read = vi.spyOn(CfoaiBudgetAdapter.prototype, 'budgetLimitNanos').mockImplementation(async () => { if (failure) throw new Error('read failed'); return 5_000_000_000; });
    const close = vi.spyOn(CfoaiBudgetAdapter.prototype, 'close').mockResolvedValue();
    try {
      expect((await readPlanBudget(config, {})).source).toBe(failure ? 'config' : 'cfoai');
      expect(close).toHaveBeenCalledOnce();
    } finally { read.mockRestore(); close.mockRestore(); }
  });
  it('shows the deliberate first attempt override and rejects invalid values', async () => {
    const configPath = fixture();
    const path = join(dirname(configPath), 'backlog.yaml');
    const body = readFileSync(path, 'utf8');
    writeFileSync(path, `${body}    firstAttemptCeilingUsd: 0.01\n`);
    const options = { configPath, dryRun: true, baseline: false };
    const plan = await planTally(options);
    expect(plan[0]?.ceilingNanos).toBe(10_000_000);
    expect(plan[0]?.decision).toContain('Deliberate first-attempt ceiling override');
    writeFileSync(path, `${body}    firstAttemptCeilingUsd: -1\n`);
    await expect(planTally(options)).rejects.toThrow('positive finite number');
  });
  it('sizes and routes without worker ports', async () => {
    const plan = await planTally({
      configPath: fixture(),
      dryRun: true,
      baseline: false,
      signals: { async signalsFor() { return { filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' }; } },
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ taskId: 'T1', size: 'small', tier: 'cheap', model: 'cheap-model', skipped: false });
    expect(plan[0]?.historySources).toEqual(['none']);
    expect(plan[0]?.decision).toContain('expected to cost');
  });

  it('uses persisted history like routing and leaves the history file unchanged', async () => {
    const configPath = fixture();
    const historyPath = join(dirname(configPath), '.tally', 'history.json');
    mkdirSync(dirname(historyPath), { recursive: true });
    const snapshot = JSON.stringify({
      version: 1,
      cells: { 'small:cheap': { attempts: 5, passes: 0, totalCostNanos: 1_000_000_000 } },
    }, null, 2);
    writeFileSync(historyPath, `${snapshot}\n`);
    const historyBefore = readFileSync(historyPath, 'utf8');
    const signals = { async signalsFor() { return { filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' as const }; } };
    const plan = await planTally({ configPath, dryRun: true, baseline: false, signals });
    const config = loadConfig(configPath);
    const history = createPriceHistory(config, configPath);
    const task = { taskId: 'T1', title: 'Fix `calc.ts` should add values', body: 'Expected calc.ts to return a + b.' };
    const estimate = await sizeTask(task, { signals });
    const route = await routeTask({
      task,
      estimate,
      config,
      ports: { history, budget: { remainingNanos: async () => 10_000_000_000 } },
    });

    expect(plan[0]).toMatchObject({ tier: 'top', historySources: ['local'] });
    expect(plan[0]?.decision).toContain('History changed the choice for cheap: 5 attempts');
    expect(route.action === 'start' ? route.tier.name : null).toBe(plan[0]?.tier);
    expect(readFileSync(historyPath, 'utf8')).toBe(historyBefore);
  });

  it('labels Neatlogs observations as the plan source', async () => {
    const configPath = fixture();
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('neatlogs: false', 'neatlogs: true'));
    const lookup = vi.spyOn(NeatlogsPriceHistory.prototype, 'lookup').mockResolvedValue({ attempts: 2, passRate: 1, avgCostNanos: 100 });
    const source = vi.spyOn(NeatlogsPriceHistory.prototype, 'sourceOfLastLookup').mockReturnValue('neatlogs');
    try {
      const plan = await planTally({
        configPath,
        dryRun: true,
        baseline: false,
        signals: { async signalsFor() { return { filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' }; } },
      });

      expect(plan[0]?.historySources).toEqual(['neatlogs']);
      expect(lookup).toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      source.mockRestore();
    }
  });
});
