import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  attemptId,
  ceilingNanos,
  costNanos,
  formatUsd,
  nanosToUsd,
  usdToNanos,
  validateConfig,
  validateLedger,
  validateLedgerRow,
  validateRunState,
  type LedgerRow,
  type RunState,
  type TallyConfig,
} from './index.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const ledger = JSON.parse(fixture('finished-run/ledger.json')) as LedgerRow[];
const run = JSON.parse(fixture('finished-run/run.json')) as RunState;
const config = parseYaml(fixture('finished-run/tally.yaml')) as TallyConfig;

it('accepts generated Entire summaries only as an explicit boolean setting', () => {
  expect(validateConfig({ ...config, entire: { generatedSummaries: false } }).ok).toBe(true);
  expect(validateConfig({ ...config, entire: { generatedSummaries: true } }).ok).toBe(true);
  expect(validateConfig({ ...config, entire: { generatedSummaries: 'true' } }).ok).toBe(false);
});

// A row written against the TypeScript type. `npm run typecheck` fails if the
// type drifts from this shape; the test below fails if the JSON Schema does.
const typedRow: LedgerRow = {
  schemaVersion: 1,
  attemptId: 'run-1:T1:1',
  runId: 'run-1',
  taskId: 'T1',
  taskTitle: 'Fix off-by-one in pager',
  attempt: 1,
  size: 'small',
  tier: 'cheap',
  model: 'some-model',
  harness: 'some-harness',
  sessionId: null,
  branch: null,
  tokens: { uncachedInput: 1000, cachedInput: 0, output: 100, total: 1100 },
  estimatedCostNanos: 1_500_000,
  costSource: 'list-price',
  ceilingNanos: 300_000_000,
  result: 'passed',
  resultReason: null,
  escalatedFrom: null,
  handoff: 'none',
  prUrl: null,
  traceId: null,
  traceUrl: null,
  checkpointId: null,
  checkpointUrl: null,
  decision: 'Small task with existing tests, so the cheap tier is expected to finish it.',
  startedAt: '2026-10-11T08:00:00Z',
  endedAt: '2026-10-11T08:04:00Z',
};

describe('money helpers', () => {
  it('shows fractional-cent costs without misleading cent rounding', () => {
    expect(formatUsd(15_307_560)).toBe('$0.0153');
    expect(formatUsd(15_000_000)).toBe('$0.0150');
    expect(formatUsd(1)).toBe('$0.000000001');
    expect(formatUsd(300_000_000)).toBe('$0.30');
  });
  it('converts between USD and integer nanos', () => {
    expect(usdToNanos(1)).toBe(1_000_000_000);
    expect(usdToNanos(0.3)).toBe(300_000_000);
    expect(nanosToUsd(2_345_760)).toBeCloseTo(0.00234576, 10);
  });

  it('prices tokens at list price', () => {
    const price = { inputUsdPerMTok: 0.2, cachedInputUsdPerMTok: 0.02, outputUsdPerMTok: 1.2 };
    // Figures observed from the AO usage endpoint for a real Codex session.
    expect(costNanos({ uncachedInput: 10_592, cachedInput: 11_008, output: 6, total: 21_606 }, price)).toBe(2_345_760);
  });

  it('derives a ceiling from task size and tier fraction', () => {
    const cheap = config.tiers[0]!;
    expect(ceilingNanos(config, 'medium', cheap)).toBe(usdToNanos(config.ceilings.bySizeUsd.medium * cheap.ceilingFraction));
  });

  it('builds a stable attempt id', () => {
    expect(attemptId('run-1', 'T5', 2)).toBe('run-1:T5:2');
  });
});

describe('ledger row schema', () => {
  it('accepts optional native Entire session evidence without changing the AO session', () => {
    expect(validateLedgerRow({ ...typedRow, sessionId: 'ao-worker', entireSessionId: 'codex-native' }).ok).toBe(true);
    expect(validateLedgerRow({ ...typedRow, entireSessionId: null }).ok).toBe(true);
    expect(validateLedgerRow({ ...typedRow, entireSessionId: 7 }).ok).toBe(false);
  });
  it('accepts a row that satisfies the TypeScript type', () => {
    expect(validateLedgerRow(typedRow)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a missing decision sentence', () => {
    const { decision: _drop, ...rest } = typedRow;
    const res = validateLedgerRow(rest);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('decision');
  });

  it('rejects unknown fields, results and sizes', () => {
    expect(validateLedgerRow({ ...typedRow, extra: 1 }).ok).toBe(false);
    expect(validateLedgerRow({ ...typedRow, result: 'maybe' }).ok).toBe(false);
    expect(validateLedgerRow({ ...typedRow, size: 'huge' }).ok).toBe(false);
  });

  it('rejects fractional or negative money and tokens', () => {
    expect(validateLedgerRow({ ...typedRow, estimatedCostNanos: 1.5 }).ok).toBe(false);
    expect(validateLedgerRow({ ...typedRow, ceilingNanos: -1 }).ok).toBe(false);
    expect(validateLedgerRow({ ...typedRow, tokens: { ...typedRow.tokens, output: -3 } }).ok).toBe(false);
  });
});

describe('finished-run fixture', () => {
  it('validates graph caps, relative paths and edge endpoints', () => {
    const impact = run.tasks[0]!.impact!;
    const withImpact = (value: unknown) => ({ ...run, tasks: [{ ...run.tasks[0], impact: value }] });
    expect(validateRunState(withImpact(impact)).ok).toBe(true);
    expect(validateRunState(withImpact({ ...impact, totals: { ...impact.totals, nodes: 0 } })).ok).toBe(false);
    expect(validateRunState(withImpact({ ...impact, nodes: Array.from({ length: 41 }, (_, i) => ({ id: `src/${i}.ts`, kind: 'target' })) })).ok).toBe(false);
    expect(validateRunState(withImpact({ ...impact, nodes: [{ id: '/absolute.ts', kind: 'target' }] })).ok).toBe(false);
    expect(validateRunState(withImpact({ ...impact, nodes: [{ id: '../escape.ts', kind: 'target' }] })).ok).toBe(false);
    expect(validateRunState(withImpact({ ...impact, edges: [{ from: 'missing.ts', to: 'src/refund.ts', kind: 'calls' }] })).ok).toBe(false);
    expect(validateRunState({ ...run, tasks: [{ ...run.tasks[0], changedFiles: ['/absolute.ts'] }] }).ok).toBe(false);
  });
  it('validates against all three schemas', () => {
    expect(validateConfig(config)).toEqual({ ok: true, errors: [] });
    expect(validateLedger(ledger)).toEqual({ ok: true, errors: [] });
    expect(validateRunState(run)).toEqual({ ok: true, errors: [] });
  });

  it('has exactly one escalated task, whose second attempt points at the first', () => {
    const escalated = run.tasks.filter((t) => t.escalated);
    expect(escalated).toHaveLength(1);
    const rows = ledger.filter((r) => r.taskId === escalated[0]!.taskId);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
    expect(rows[0]!.result).not.toBe('passed');
    expect(rows[1]!.result).toBe('passed');
    expect(rows[1]!.escalatedFrom).toBe(rows[0]!.attemptId);
    expect(ledger.filter((r) => r.escalatedFrom !== null)).toHaveLength(1);
  });

  it('prices every row from the config tiers, never from hard-coded numbers', () => {
    for (const row of ledger) {
      const tier = config.tiers.find((t) => t.name === row.tier);
      expect(tier, `tier ${row.tier}`).toBeDefined();
      expect(row.model).toBe(tier!.model);
      expect(row.harness).toBe(tier!.harness);
      expect(row.tokens.total).toBe(row.tokens.uncachedInput + row.tokens.cachedInput + row.tokens.output);
      expect(row.estimatedCostNanos).toBe(costNanos(row.tokens, tier!.price));
      expect(row.ceilingNanos).toBe(ceilingNanos(config, row.size, tier!));
      expect(row.attemptId).toBe(attemptId(row.runId, row.taskId, row.attempt));
    }
  });

  it('keeps run state consistent with the ledger', () => {
    const total = ledger.reduce((sum, r) => sum + r.estimatedCostNanos, 0);
    expect(run.budget.spentNanos).toBe(total);
    expect(run.budget.limitNanos).toBe(usdToNanos(config.budget.usd));
    expect(run.budget.spentNanos).toBeLessThanOrEqual(run.budget.limitNanos);
    expect(run.status).toBe('finished');
    for (const task of run.tasks) {
      const rows = ledger.filter((r) => r.taskId === task.taskId);
      expect(task.attempts).toBe(rows.length);
      expect(task.spentNanos).toBe(rows.reduce((sum, r) => sum + r.estimatedCostNanos, 0));
      expect(rows.every((r) => r.runId === run.runId)).toBe(true);
    }
    expect(new Set(ledger.map((r) => r.taskId))).toEqual(new Set(run.tasks.map((t) => t.taskId)));
  });

  it('only stops attempts that actually crossed their ceiling', () => {
    for (const row of ledger) {
      if (row.result === 'stopped') expect(row.estimatedCostNanos).toBeGreaterThanOrEqual(row.ceilingNanos);
      if (row.result === 'passed') expect(row.estimatedCostNanos).toBeLessThanOrEqual(row.ceilingNanos);
    }
  });
});

describe('config schema', () => {
  it('accepts only HTTPS cfo.ai dashboard links in config and persisted runs', () => {
    for (const key of ['pageUrl', 'tableUrl']) {
      for (const url of ['https://app.cfo.ai/s/table', 'https://app.cfo.ai/page?scenario=Main#budget']) {
        expect(validateConfig({ ...config, budget: { ...config.budget, cfoai: { [key]: url } } }).ok).toBe(true);
        expect(validateRunState({ ...run, budget: { ...run.budget, cfoai: { [key]: url } } }).ok).toBe(true);
      }
      for (const url of ['http://app.cfo.ai/s/table', 'javascript:alert(1)', '/relative', 'https://', 'https:///missing-host']) {
        expect(validateConfig({ ...config, budget: { ...config.budget, cfoai: { [key]: url } } }).ok).toBe(false);
        expect(validateRunState({ ...run, budget: { ...run.budget, cfoai: { [key]: url } } }).ok).toBe(false);
      }
    }
  });
  it('requires repo, test command and at least one tier', () => {
    expect(validateConfig({ ...config, repo: undefined }).ok).toBe(false);
    expect(validateConfig({ ...config, test: {} }).ok).toBe(false);
    expect(validateConfig({ ...config, tiers: [] }).ok).toBe(false);
  });

  it('accepts any harness and model strings for a tier', () => {
    const tiers = [{ ...config.tiers[0]!, harness: 'codex', model: 'gpt-5.6-luna' }, ...config.tiers.slice(1)];
    expect(validateConfig({ ...config, tiers }).ok).toBe(true);
  });

  it('requires a provider on every tier and carries it through', () => {
    expect(config.tiers.every((t) => typeof t.provider === 'string' && t.provider.length > 0)).toBe(true);
    const { provider: _drop, ...withoutProvider } = config.tiers[0]!;
    expect(validateConfig({ ...config, tiers: [withoutProvider] }).ok).toBe(false);
    const gateway = { ...config.tiers[0]!, provider: 'litellm', model: 'nova-lite' };
    expect(validateConfig({ ...config, tiers: [gateway] }).ok).toBe(true);
  });

  it('rejects a ceiling fraction above 1 and an unknown budget source', () => {
    const tiers = [{ ...config.tiers[0]!, ceilingFraction: 1.5 }];
    expect(validateConfig({ ...config, tiers }).ok).toBe(false);
    expect(validateConfig({ ...config, budget: { source: 'guess', usd: 5 } }).ok).toBe(false);
  });
});
