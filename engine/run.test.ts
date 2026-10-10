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
integrations: { neatlogs: false, entire: true, cfoai: false, slack: false }
`,
  );
  writeFileSync(
    backlogPath,
    `tasks:
  - id: T1
    title: Reject negative amounts
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
  it('writes valid run state and ledger files with an escalated attempt', async () => {
    const { dir, configPath } = writeFixture();
    const outputDir = join(dir, 'out');
    const result = await runTally({ configPath, dryRun: true, baseline: false, outputDir, now: fixedNow });

    expect(result.runState.runId).toBe('run-20261011-030000Z');
    expect(result.runState.tasks).toHaveLength(3);
    expect(result.ledger.map((row) => `${row.taskId}:${row.attempt}:${row.result}:${row.tier}`)).toEqual([
      'T1:1:passed:cheap',
      'T2:1:stopped:middle',
      'T2:2:passed:top',
      'T3:1:passed:top',
    ]);
    expect(result.runState.tasks[1]).toMatchObject({ status: 'passed', attempts: 2, escalated: true, tier: 'top' });
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
    const result = await runDemo({ outputDir: dir, now: fixedNow });

    expect(result.runState.dryRun).toBe(true);
    expect(result.ledger.some((row) => row.escalatedFrom !== null)).toBe(true);
    expect(validateRunState(result.runState).ok).toBe(true);
    expect(validateLedger(result.ledger).ok).toBe(true);
  });
});
