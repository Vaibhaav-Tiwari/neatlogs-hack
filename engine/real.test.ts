import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SizingSignalsPort, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import { validateLedger, validateRunState, type TokenUsage } from '../schema/index.js';
import type { BacklogIntakePort } from '../adapters/github.js';
import type { VerifierPort, VerifyResult } from '../adapters/verifier.js';
import { runRealTally, type WorkerPort, type WorkerStartInput } from './real.js';

const fixedNow = () => new Date('2026-10-11T03:00:00.000Z');

function fixture() {
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
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
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
  });
});
