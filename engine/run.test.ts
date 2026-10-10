import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateLedger, validateRunState } from '../schema/index.js';
import { runDemo, runTally } from './run.js';

const fixedNow = () => new Date('2026-10-11T03:00:00.000Z');

function writeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-run-'));
  const configPath = join(dir, 'tally.yaml');
  const backlogPath = join(dir, 'backlog.yaml');
  writeFileSync(
    configPath,
    `version: 1
repo: { path: ".", slug: "acme/payments-service", baseBranch: "main" }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: claude-code
    provider: litellm
    model: nova-micro
    price: { inputUsdPerMTok: 0.035, cachedInputUsdPerMTok: 0.00875, outputUsdPerMTok: 0.14 }
    ceilingFraction: 0.2
  - name: middle
    harness: claude-code
    provider: litellm
    model: claude-sonnet-4.6
    price: { inputUsdPerMTok: 3.3, cachedInputUsdPerMTok: 0.33, outputUsdPerMTok: 16.5 }
    ceilingFraction: 0.5
  - name: top
    harness: claude-code
    provider: litellm
    model: claude-opus-4.6
    price: { inputUsdPerMTok: 5.5, cachedInputUsdPerMTok: 0.55, outputUsdPerMTok: 27.5 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 4, large: 10 }
budget: { source: config, usd: 40 }
concurrency: 3
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
`,
  );
  writeFileSync(
    backlogPath,
    `tasks:
  - id: T1
    title: Reject negative amounts
    body: "payments/amounts.ts must throw for negative inputs; cover it in tests/amounts.test.ts."
    size: small
    outcomes: [passed]
  - id: T2
    title: Add idempotency keys
    size: medium
    outcomes: [stopped, passed]
  - id: T3
    title: Move ledger writes into a transaction
    size: large
    outcomes: [passed]
`,
  );
  return { dir, configPath };
}

describe('runTally dry-run', () => {
  it('runs dry-run through the real loop with routing, ceiling stop, escalation and budget skip', async () => {
    const { dir, configPath } = writeFixture();
    const outputDir = join(dir, 'out');
    const result = await runTally({ configPath, dryRun: true, baseline: false, budgetUsd: 4.9, outputDir, now: fixedNow });

    expect(result.runState.runId).toBe('run-20261011-030000Z');
    expect(result.runState.tasks).toHaveLength(3);
    expect(result.ledger.map((row) => `${row.taskId}:${row.attempt}:${row.result}:${row.tier}`)).toEqual([
      'T1:1:passed:cheap',
      'T2:1:stopped:cheap',
      'T2:2:passed:middle',
    ]);
    expect(result.runState.tasks[1]).toMatchObject({ status: 'passed', attempts: 2, escalated: true, tier: 'middle' });
    expect(result.runState.tasks[2]).toMatchObject({ status: 'skipped', statusReason: 'not started: no budget' });
    expect(result.ledger.every((row) => row.costSource === 'simulated')).toBe(true);
    expect(result.ledger[0]?.decision).toContain('expected to cost');
    expect(result.runState.budget.spentNanos).toBe(result.ledger.reduce((sum, row) => sum + row.estimatedCostNanos, 0));
    expect(validateRunState(JSON.parse(readFileSync(result.runStatePath, 'utf8'))).ok).toBe(true);
    expect(validateLedger(JSON.parse(readFileSync(result.ledgerPath, 'utf8'))).ok).toBe(true);
  });

  it('runs a single task by id and can force baseline routing', async () => {
    const { dir, configPath } = writeFixture();
    const result = await runTally({
      configPath,
      dryRun: true,
      baseline: true,
      only: 'T1',
      outputDir: join(dir, 'baseline'),
      now: fixedNow,
    });

    expect(result.runState.mode).toBe('baseline');
    expect(result.runState.tasks).toHaveLength(1);
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({ taskId: 'T1', tier: 'top', model: 'claude-opus-4.6' });
  });

  it('marks tasks skipped when the configured budget cannot reserve their ceiling', async () => {
    const { dir, configPath } = writeFixture();
    const result = await runTally({ configPath, dryRun: true, baseline: false, budgetUsd: 0.01, outputDir: join(dir, 'tiny'), now: fixedNow });

    expect(result.ledger).toHaveLength(0);
    expect(result.runState.tasks.every((task) => task.status === 'skipped')).toBe(true);
    expect(result.runState.tasks.every((task) => task.statusReason === 'not started: no budget')).toBe(true);
  });
});

describe('runDemo', () => {
  it('produces a dry-run ledger without a user config file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-demo-out-'));
    const latest = join(dir, 'latest');
    const result = await runDemo({ outputDir: dir, latestRunDir: latest, now: fixedNow });

    expect(result.runState.dryRun).toBe(true);
    expect(result.runState.tasks).toHaveLength(7);
    expect(result.ledger.length).toBeGreaterThanOrEqual(7);
    expect(result.ledger.some((row) => row.escalatedFrom !== null)).toBe(true);
    expect(validateRunState(result.runState).ok).toBe(true);
    expect(validateLedger(result.ledger).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(latest, 'run.json'), 'utf8'))).toMatchObject({ runId: result.runState.runId });
    expect(JSON.parse(readFileSync(join(latest, 'ledger.json'), 'utf8'))).toHaveLength(result.ledger.length);
  });
});
