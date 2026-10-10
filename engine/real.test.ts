import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SizingSignalsPort, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import { usdToNanos, validateLedger, validateRunState, type TokenUsage } from '../schema/index.js';
import type { BacklogIntakePort } from '../adapters/github.js';
import type { VerifierPort, VerifyResult } from '../adapters/verifier.js';
import { runRealTally, type CfoaiBudgetPort, type WorkerPort, type WorkerStartInput } from './real.js';

const fixedNow = () => new Date('2026-10-11T03:00:00.000Z');

function fixture(integrations = 'neatlogs: false, entire: false, cfoai: false, slack: false') {
  const dir = mkdtempSync(join(tmpdir(), 'tally-real-'));
  const configPath = join(dir, 'tally.yaml');
  writeFileSync(
    configPath,
    `version: 1
repo: { path: ".", slug: "acme/payments-service", baseBranch: "main", aoProject: "payments" }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: claude-code
    provider: subscription
    model: claude-haiku-4-5-20251001
    price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 5 }
    ceilingFraction: 0.2
  - name: middle
    harness: claude-code
    provider: subscription
    model: claude-sonnet-5-5
    price: { inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.2, outputUsdPerMTok: 10 }
    ceilingFraction: 0.5
  - name: top
    harness: claude-code
    provider: subscription
    model: claude-opus-5-5
    price: { inputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.4, outputUsdPerMTok: 20 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 4, large: 10 }
budget: { source: config, usd: 40 }
integrations: { ${integrations} }
`,
  );
  return { dir, configPath };
}

const intake: BacklogIntakePort = {
  async tasks() {
    return [{ taskId: 'T1', title: 'Fix `calc.ts` should add values', body: 'Expected calc.ts to return a + b.', issueNumber: 7, issueUrl: null, size: 'small', outcomes: ['passed'] }];
  },
};

const signals: SizingSignalsPort = {
  async signalsFor() {
    return { filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' };
  },
};

const missingEntireSignals: SizingSignalsPort & { status: () => { status: 'missing'; detail: string } } = {
  async signalsFor() {
    return { filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' };
  },
  status() {
    return { status: 'missing', detail: 'Entire graph is unavailable. Falling back to code search. Fix: run `entire enable` in this repository.' };
  },
};

const tokens: TokenUsage = { uncachedInput: 1000, cachedInput: 2000, output: 300, total: 3300 };

class FakeWorker implements WorkerPort, LiveUsagePort, SessionControlPort {
  starts: WorkerStartInput[] = [];
  stopped: string[] = [];

  async start(input: WorkerStartInput) {
    this.starts.push(input);
    return { sessionId: `session-${this.starts.length}`, branch: `tally/t1-${this.starts.length}`, checkoutPath: `/tmp/tally-${this.starts.length}` };
  }

  async wait(sessionId: string) {
    const index = Number(sessionId.split('-')[1]);
    return { status: 'idle' as const, branch: `tally/t1-${index}`, checkoutPath: `/tmp/tally-${index}`, prUrl: `https://github.com/acme/payments-service/pull/${index}` };
  }

  async usageFor() {
    return { tokens, estimatedCostNanos: 123 };
  }

  async stop(sessionId: string) {
    this.stopped.push(sessionId);
  }
}

class SequenceVerifier implements VerifierPort {
  calls = 0;
  constructor(private readonly results: VerifyResult[]) {}

  async verify() {
    const result = this.results[Math.min(this.calls, this.results.length - 1)]!;
    this.calls += 1;
    return result;
  }
}

class FakeCfoaiBudget implements CfoaiBudgetPort {
  writes: number[] = [];
  constructor(
    private readonly budgetNanos = usdToNanos(40),
    private readonly failRead = false,
  ) {}

  async remainingNanos() {
    return this.budgetNanos;
  }

  async budgetLimitNanos() {
    if (this.failRead) throw new Error('not logged in');
    return this.budgetNanos;
  }

  async writeCumulativeActualSpend(runSpendNanos: number) {
    if (this.failRead) throw new Error('not logged in');
    this.writes.push(runSpendNanos);
  }

  status() {
    return this.failRead
      ? { status: 'missing' as const, detail: 'not logged in. Run `tally login cfoai` to connect cfo.ai.' }
      : { status: 'ok' as const, detail: 'https://app.cfo.ai/s/table' };
  }
}

describe('runRealTally', () => {
  it('sizes, routes, spawns, verifies, escalates once and writes valid output', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    const verifier = new SequenceVerifier([
      { passed: false, reason: 'tests failed: one assertion failed' },
      { passed: true, reason: null },
    ]);

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'out'),
      latestRunDir: join(dir, 'latest'),
      now: fixedNow,
      ports: { intake, signals, worker, verifier, usage: worker, sessions: worker },
    });

    expect(worker.starts.map((start) => `${start.harness}:${start.model}`)).toEqual([
      'claude-code:claude-haiku-4-5-20251001',
      'claude-code:claude-sonnet-5-5',
    ]);
    expect(result.ledger).toHaveLength(2);
    expect(result.ledger[1]).toMatchObject({
      attempt: 2,
      escalatedFrom: result.ledger[0]!.attemptId,
      handoff: 'restart',
      result: 'passed',
    });
    expect(result.runState.tasks[0]).toMatchObject({ status: 'passed', attempts: 2, escalated: true });
    expect(validateRunState(JSON.parse(readFileSync(result.runStatePath, 'utf8'))).ok).toBe(true);
    expect(validateLedger(JSON.parse(readFileSync(result.ledgerPath, 'utf8'))).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'latest', 'run.json'), 'utf8'))).toMatchObject({ runId: result.runState.runId });
  });

  it('resumes from an existing successful ledger row without spawning again', async () => {
    const { dir, configPath } = fixture();
    const outputDir = join(dir, 'resume');
    const firstWorker = new FakeWorker();
    const first = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir,
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker: firstWorker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: firstWorker,
        sessions: firstWorker,
      },
    });
    const secondWorker = new FakeWorker();
    const second = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir,
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker: secondWorker,
        verifier: new SequenceVerifier([{ passed: false, reason: 'should not run' }]),
        usage: secondWorker,
        sessions: secondWorker,
      },
    });

    expect(first.ledger).toHaveLength(1);
    expect(second.ledger).toHaveLength(1);
    expect(secondWorker.starts).toHaveLength(0);
  });

  it('resumes an interrupted task from its ledger row without redoing attempt one or double counting cost', async () => {
    const { dir, configPath } = fixture();
    const outputDir = join(dir, 'interrupted');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, 'ledger.json'),
      JSON.stringify(
        [
          {
            schemaVersion: 1,
            attemptId: 'run-20261011-030000Z:T1:1',
            runId: 'run-20261011-030000Z',
            taskId: 'T1',
            taskTitle: 'Fix `calc.ts` should add values',
            attempt: 1,
            size: 'small',
            tier: 'cheap',
            model: 'claude-haiku-4-5-20251001',
            harness: 'claude-code',
            sessionId: 'session-old',
            branch: 'tally/t1-old',
            tokens,
            estimatedCostNanos: 500_000_000,
            costSource: 'list-price',
            ceilingNanos: 200_000_000,
            result: 'failed',
            resultReason: 'tests failed before interruption',
            escalatedFrom: null,
            handoff: 'none',
            prUrl: null,
            traceUrl: null,
            checkpointId: null,
            checkpointUrl: null,
            decision: 'Existing first attempt from the interrupted run.',
            startedAt: '2026-10-11T03:00:00.000Z',
            endedAt: '2026-10-11T03:00:00.000Z',
          },
        ],
        null,
        2,
      ),
    );
    const worker = new FakeWorker();
    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir,
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
      },
    });

    expect(worker.starts).toHaveLength(1);
    expect(worker.starts[0]).toMatchObject({ attempt: 2, model: 'claude-sonnet-5-5' });
    expect(result.ledger.map((row) => `${row.taskId}:${row.attempt}:${row.result}`)).toEqual(['T1:1:failed', 'T1:2:passed']);
    expect(result.ledger[1]?.escalatedFrom).toBe('run-20261011-030000Z:T1:1');
    expect(result.runState.tasks[0]).toMatchObject({ status: 'passed', attempts: 2, spentNanos: 505_400_000 });
    expect(result.runState.budget.spentNanos).toBe(505_400_000);
  });

  it('keeps budget-bounded tasks out of the worker fleet', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      budgetUsd: 0.01,
      outputDir: join(dir, 'tiny'),
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
      },
    });

    expect(worker.starts).toHaveLength(0);
    expect(result.ledger).toHaveLength(0);
    expect(result.runState.tasks[0]).toMatchObject({ status: 'skipped', statusReason: 'not started: no budget' });
    expect(result.runState.budget.spentNanos).toBe(0);
  });

  it('reports Entire as missing when enabled sizing falls back to code search', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: true, cfoai: false, slack: false');
    const worker = new FakeWorker();
    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'entire-missing'),
      now: fixedNow,
      ports: {
        intake,
        signals: missingEntireSignals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
      },
    });

    expect(result.runState.integrations.entire).toMatchObject({ status: 'missing' });
    expect(result.runState.integrations.entire.detail).toContain('entire enable');
  });

  it('reads the run budget from cfo.ai, writes cumulative real spend and keeps a CSV fallback', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: false, cfoai: true, slack: false');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replace(
        'budget: { source: config, usd: 40 }',
        'budget: { source: cfoai, usd: 10, cfoai: { orgId: "103210", scenario: "Main Scenario", table: "Tally agent budget", budgetRow: "Agent budget", spendRow: "Agent spend", tableUrl: "https://app.cfo.ai/s/table" } }',
      ),
    );
    const worker = new FakeWorker();
    const cfoai = new FakeCfoaiBudget(usdToNanos(40));

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'cfoai'),
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        cfoai,
      },
    });

    expect(result.runState.budget).toMatchObject({ source: 'cfoai', limitNanos: usdToNanos(40) });
    expect(cfoai.writes).toEqual([result.ledger[0]!.estimatedCostNanos]);
    const csv = readFileSync(join(result.outputDir, 'cfoai-spend-fallback.csv'), 'utf8');
    expect(csv).toContain('run_id,attempt_id,task_id');
    expect(csv).toContain(result.ledger[0]!.attemptId);
    expect(result.runState.integrations.cfoai).toEqual({ status: 'ok', detail: 'https://app.cfo.ai/s/table' });
  });

  it('falls back to tally.yaml budget and CSV-only accounting when cfo.ai is enabled but unavailable', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: false, cfoai: true, slack: false');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('budget: { source: config, usd: 40 }', 'budget: { source: cfoai, usd: 10 }'));
    const worker = new FakeWorker();
    const cfoai = new FakeCfoaiBudget(usdToNanos(40), true);

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'cfoai-missing'),
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        cfoai,
      },
    });

    expect(result.runState.budget).toMatchObject({ source: 'config', limitNanos: usdToNanos(10) });
    expect(cfoai.writes).toEqual([]);
    expect(result.runState.integrations.cfoai).toMatchObject({ status: 'missing' });
    expect(readFileSync(join(result.outputDir, 'cfoai-spend-fallback.csv'), 'utf8')).toContain(result.ledger[0]!.attemptId);
  });

  it('never writes simulated dry-run spend to cfo.ai', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: false, cfoai: true, slack: false');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('budget: { source: config, usd: 40 }', 'budget: { source: cfoai, usd: 10 }'));
    const worker = new FakeWorker();
    const cfoai = new FakeCfoaiBudget(usdToNanos(40));

    const result = await runRealTally({
      configPath,
      dryRun: true,
      baseline: false,
      outputDir: join(dir, 'cfoai-dry'),
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        cfoai,
      },
    });

    expect(cfoai.writes).toEqual([]);
    expect(existsSync(join(result.outputDir, 'cfoai-spend-fallback.csv'))).toBe(false);
    expect(result.runState.budget).toMatchObject({ source: 'config', limitNanos: usdToNanos(10) });
  });
});
