import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckpointPort, CheckpointRecallPort, HandoffPort, SizingSignalsPort, LiveUsagePort, SessionControlPort, TracePort, TraceAttributes, TraceSpan } from '../agent/ports.js';
import { usdToNanos, validateLedger, validateRunState, type TokenUsage } from '../schema/index.js';
import type { BacklogIntakePort } from '../adapters/github.js';
import type { VerifierPort, VerifyResult } from '../adapters/verifier.js';
import { runRealTally, type CfoaiBudgetPort, type WorkerPort, type WorkerResult, type WorkerStartInput, type WorktreePort } from './real.js';

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

const scriptedEntireSignals: SizingSignalsPort & { status: () => { status: 'ok'; detail: string } } = {
  async signalsFor() {
    return { filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' };
  },
  status() {
    return { status: 'ok', detail: 'not used: sample tasks carry scripted sizing' };
  },
};

const tokens: TokenUsage = { uncachedInput: 1000, cachedInput: 2000, output: 300, total: 3300 };

class FakeWorker implements WorkerPort, LiveUsagePort, SessionControlPort {
  starts: WorkerStartInput[] = [];
  stopped: string[] = [];
  published: Array<{ branch: string; taskId: string }> = [];
  commitChecks: Array<{ checkoutPath: string; branch: string }> = [];
  publishPaths: string[] = [];
  commitsAheadCount = 1;
  files = ['calc.ts'];
  async changedFiles() { return this.files; }

  async start(input: WorkerStartInput): ReturnType<WorkerPort['start']> {
    this.starts.push(input);
    return { sessionId: `session-${this.starts.length}`, branch: `tally/t1-${this.starts.length}`, checkoutPath: `/tmp/tally-${this.starts.length}` };
  }

  async wait(sessionId: string): Promise<WorkerResult> {
    const index = Number(sessionId.split('-')[1]);
    return { status: 'idle' as const, branch: `tally/t1-${index}`, checkoutPath: `/tmp/tally-${index}`, prUrl: `https://github.com/acme/payments-service/pull/${index}` };
  }

  async usageFor(): Promise<{ tokens: TokenUsage; estimatedCostNanos: number } | null> {
    return { tokens, estimatedCostNanos: 123 };
  }

  async settledUsageFor() {
    return this.usageFor();
  }

  async stop(sessionId: string) {
    this.stopped.push(sessionId);
  }

  async commitsAhead(input: { checkoutPath: string; branch: string }) {
    this.commitChecks.push(input);
    return this.commitsAheadCount;
  }

  async publishPr(input: { checkoutPath: string; branch: string; task: { taskId: string } }) {
    this.publishPaths.push(input.checkoutPath);
    this.published.push({ branch: input.branch, taskId: input.task.taskId });
    return `https://github.com/acme/payments-service/pull/${this.published.length}`;
  }
}

class BranchOnlyWorker extends FakeWorker {
  async start(input: WorkerStartInput): ReturnType<WorkerPort['start']> {
    this.starts.push(input);
    return { sessionId: `session-${this.starts.length}`, branch: null, checkoutPath: null };
  }

  async wait(sessionId: string): Promise<WorkerResult> {
    const index = Number(sessionId.split('-')[1]);
    return { status: 'idle' as const, branch: `tally/t1-${index}`, checkoutPath: null, prUrl: null };
  }
}

class NeedsInputWorker extends FakeWorker {
  async wait(sessionId: string): Promise<WorkerResult> {
    const index = Number(sessionId.split('-')[1]);
    return {
      status: 'needs_input',
      branch: `tally/t1-${index}`,
      checkoutPath: `/tmp/tally-${index}`,
      prUrl: null,
      resultReason: 'worker asked for input: AO session entered needs_input/waiting_input',
    };
  }
}

class UsageSettlesWorker extends FakeWorker {
  usageCalls = 0;

  async usageFor() {
    return null;
  }

  async settledUsageFor() {
    this.usageCalls += 1;
    return { tokens, estimatedCostNanos: 123 };
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

class FakeWorktrees implements WorktreePort {
  calls: Array<{ repoPath: string; branch: string }> = [];
  constructor(private readonly path: string | null) {}

  async checkoutPathFor(repoPath: string, branch: string): Promise<string | null> {
    this.calls.push({ repoPath, branch });
    return this.path;
  }
}

class FakeCfoaiBudget implements CfoaiBudgetPort {
  writes: number[] = [];
  detailWrites: Array<{ attempts: Array<{ tier: string; costNanos: number }>; cumulativeRunSpendNanos: number }> = [];
  constructor(
    private readonly budgetNanos = usdToNanos(40),
    private readonly failRead = false,
    private readonly currentSpend = 0,
  ) {}

  async remainingNanos() {
    return this.budgetNanos;
  }

  async budgetLimitNanos() {
    if (this.failRead) throw new Error('not logged in');
    return this.budgetNanos;
  }

  async currentSpendNanos() {
    if (this.failRead) throw new Error('not logged in');
    return this.currentSpend;
  }

  async writeCumulativeActualSpend(runSpendNanos: number) {
    if (this.failRead) throw new Error('not logged in');
    this.writes.push(runSpendNanos);
  }

  async writeSpendDetail(input: { attempts: Array<{ tier: string; costNanos: number }>; cumulativeRunSpendNanos: number }) {
    if (this.failRead) throw new Error('not logged in');
    this.detailWrites.push(input);
    return { skippedTiers: [] };
  }

  status() {
    return this.failRead
      ? { status: 'missing' as const, detail: 'not logged in. Run `tally login cfoai` to connect cfo.ai.' }
      : { status: 'ok' as const, detail: 'https://app.cfo.ai/s/table' };
  }
}

class FakeTrace implements TracePort {
  spans: Array<{ name: string; attributes: TraceAttributes }> = [];
  private next = 1;
  private last: string | null = null;

  async span<T>(name: string, attributes: TraceAttributes, fn: (span: TraceSpan) => Promise<T>): Promise<T> {
    const record = { name, attributes: { ...attributes } };
    this.spans.push(record);
    this.last = String(this.next).padStart(32, '0');
    this.next += 1;
    return fn({ set: (next) => Object.assign(record.attributes, next) });
  }

  lastTraceId(): string | null {
    return this.last;
  }

  status() {
    return { status: 'ok' as const, detail: 'https://app.neatlogs.com/traces/test-trace' };
  }
}

class FakeEntireEvidence implements HandoffPort, CheckpointPort {
  summaryCalls: Array<{ sessionId: string; branch?: string | null; checkpointId?: string | null }> = [];

  async checkpointFor(input: { sessionId: string; branch?: string | null }) {
    return { checkpointId: `checkpoint-${input.sessionId}`, checkpointUrl: null, entireSessionId: `native-${input.sessionId}` };
  }

  async summaryFor(sessionId: string, context: { branch?: string | null; checkpointId?: string | null } = {}) {
    this.summaryCalls.push({ sessionId, branch: context.branch, checkpointId: context.checkpointId });
    return {
      type: 'entire-handoff' as const,
      summary: 'Attempt one changed calc.ts but left the addition test red.',
      branch: context.branch ?? null,
      checkpointId: context.checkpointId ?? `checkpoint-${sessionId}`,
      checkpointUrl: null,
      summaryCostNanos: 111,
      summaryCostSource: 'ao-estimate' as const,
      summaryTokens: { uncachedInput: 11, cachedInput: 22, output: 3, total: 36 },
    };
  }
}

class FakeRecall implements CheckpointRecallPort {
  async recallFor() {
    return {
      checkpointId: '01M4FAIL',
      checkpointUrl: null,
      summary: 'A cheap attempt failed on this area before.',
      files: ['calc.ts'],
      failed: true,
    };
  }
}

describe('runRealTally', () => {
  it('uses a first-attempt override to stop via the watcher and escalates with the normal ceiling', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    const wait = worker.wait.bind(worker);
    worker.wait = (sessionId) => sessionId === 'session-1' ? new Promise(() => {}) : wait(sessionId);
    const overridingIntake: BacklogIntakePort = { tasks: async (...args) => (await intake.tasks(...args)).map((task) => ({ ...task, firstAttemptCeilingUsd: 0.001 })) };
    const result = await runRealTally({ configPath, dryRun: true, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake: overridingIntake, signals, worker, usage: worker, sessions: worker, publisher: worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]), handoff: { summaryFor: async () => ({ type: 'entire-handoff', summary: 'Partial implementation: continue calc.ts.' }) } } });
    expect(result.ledger.map((row) => row.result)).toEqual(['stopped', 'passed']);
    expect(worker.stopped).toContain('session-1');
    expect(worker.starts.map((start) => start.tier.name)).toEqual(['cheap', 'middle']);
    expect(worker.starts.map((start) => start.ceilingNanos)).toEqual([usdToNanos(0.001), usdToNanos(0.5)]);
    expect(worker.starts[1]?.prompt).toContain('Partial implementation: continue calc.ts.');
  });
  it.each([false, true])('records scope warnings and only blocks when configured: %s', async (block) => {
    const { dir, configPath } = fixture();
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('aoProject: "payments"', `aoProject: "payments", blockOutOfScopeChanges: ${block}`));
    const worker = new FakeWorker();
    worker.files = ['calc.ts', 'vercel.json'];
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'run'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]), usage: worker, sessions: worker, publisher: worker } });
    expect(result.ledger[0]?.scopeWarnings).toEqual(['vercel.json']);
    expect(result.ledger[0]?.result).toBe(block ? 'error' : 'passed');
    expect(worker.published).toHaveLength(block ? 0 : 1);
    expect(worker.starts).toHaveLength(1);
    expect(worker.starts[0]?.prompt).toContain('If a check outside your task fails, report it; do not fix it.');
  });
  it('sizes, routes, spawns, verifies, escalates once and writes valid output', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    const trace = new FakeTrace();
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
      ports: { intake, signals, worker, verifier, usage: worker, sessions: worker, publisher: worker, trace },
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
    expect(result.ledger.map((row) => row.traceId)).toEqual(['00000000000000000000000000000002', '00000000000000000000000000000005']);
    expect(result.ledger.map((row) => row.traceUrl)).toEqual([null, null]);
    expect(trace.spans.filter((span) => span.name === 'tally.route' || span.name === 'tally.escalate').map((span) => span.attributes)).toMatchObject([
      { sessionId: result.runState.runId, taskId: 'T1', attempt: 1 },
      { sessionId: result.runState.runId, taskId: 'T1', attempt: 2 },
    ]);
    expect(trace.spans.filter((span) => span.name.startsWith('tally.history.record ')).map((span) => span.attributes)).toMatchObject([
      { sessionId: result.runState.runId, taskId: 'T1', attempt: 1, 'tally.history.size': 'small', 'tally.history.tier': 'cheap', 'tally.history.result': 'failed' },
      { sessionId: result.runState.runId, taskId: 'T1', attempt: 2, 'tally.history.size': 'small', 'tally.history.tier': 'middle', 'tally.history.result': 'passed' },
    ]);
    expect(trace.spans.filter((span) => span.name.startsWith('tally.history.record ')).map((span) => span.name)).toEqual([
      'tally.history.record size=small tier=cheap result=failed cost_nanos=2700000',
      'tally.history.record size=small tier=middle result=passed cost_nanos=5400000',
    ]);
    expect(result.runState.tasks[0]).toMatchObject({ status: 'passed', attempts: 2, escalated: true });
    expect(validateRunState(JSON.parse(readFileSync(result.runStatePath, 'utf8'))).ok).toBe(true);
    expect(validateLedger(JSON.parse(readFileSync(result.ledgerPath, 'utf8'))).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'latest', 'run.json'), 'utf8'))).toMatchObject({ runId: result.runState.runId });
  });

  it('records Entire checkpoint ids and a separate handoff summary cost row before escalation', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: true, cfoai: false, slack: false');
    const worker = new FakeWorker();
    const entireEvidence = new FakeEntireEvidence();
    const verifier = new SequenceVerifier([
      { passed: false, reason: 'tests failed: one assertion failed' },
      { passed: true, reason: null },
    ]);

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'entire-evidence'),
      latestRunDir: join(dir, 'latest'),
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker,
        verifier,
        usage: worker,
        sessions: worker,
        publisher: worker,
        handoff: entireEvidence,
        checkpoints: entireEvidence,
      },
    });

    expect(result.ledger.map((row) => row.taskId)).toEqual(['T1', 'T1:handoff', 'T1']);
    expect(result.ledger[0]).toMatchObject({ checkpointId: 'checkpoint-session-1', checkpointUrl: null, sessionId: 'session-1', entireSessionId: 'native-session-1' });
    expect(result.ledger[1]).toMatchObject({
      attemptId: `${result.runState.runId}:T1:2:handoff`,
      tier: 'entire-handoff',
      model: 'entire checkpoint explain',
      estimatedCostNanos: 111,
      tokens: { uncachedInput: 11, cachedInput: 22, output: 3, total: 36 },
      escalatedFrom: result.ledger[0]!.attemptId,
      checkpointId: 'checkpoint-session-1',
      resultReason: 'Entire checkpoint summary generated for escalation',
    });
    expect(result.ledger[2]).toMatchObject({
      attempt: 2,
      handoff: 'entire-handoff',
      escalatedFrom: result.ledger[0]!.attemptId,
      checkpointId: 'checkpoint-session-2',
      result: 'passed',
    });
    expect(worker.starts[1]!.prompt).toContain('Continue from failed branch tally/t1-1.');
    expect(worker.starts[1]!.prompt).toContain('Attempt one changed calc.ts but left the addition test red.');
    expect(entireEvidence.summaryCalls).toEqual([{ sessionId: 'session-1', branch: 'tally/t1-1', checkpointId: 'checkpoint-session-1' }]);
    expect(result.runState.budget.spentNanos).toBe(result.ledger.reduce((sum, row) => sum + row.estimatedCostNanos, 0));
    expect(validateLedger(result.ledger).ok).toBe(true);
  });

  it('lowers routing confidence when Entire recalls a prior failure on the same files', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: true, cfoai: false, slack: false');
    const worker = new FakeWorker();

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'recall'),
      latestRunDir: join(dir, 'latest'),
      now: fixedNow,
      ports: {
        intake,
        signals,
        recall: new FakeRecall(),
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
      },
    });

    expect(result.ledger[0]!.decision).toContain('a prior checkpoint failed on calc.ts before');
  });

  it('prompts workers to stay in their AO worktree and leave setup and publishing to Tally/AO by default', async () => {
    const { dir, configPath } = fixture();
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('test: { command: "npm test" }', 'test: { setupCommand: "npm ci", command: "npm test" }'));
    const worker = new FakeWorker();

    await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'prompt'),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
      },
    });

    const prompt = worker.starts[0]!.prompt;
    expect(prompt).toContain('Work only in the current working directory');
    expect(prompt).toContain('Never read or write any other checkout or path outside this worktree');
    expect(prompt).toContain('The environment has already been set up before you started');
    expect(prompt).toContain('Do not run setup (npm ci), install dependencies, or use the network');
    expect(prompt).toContain('do not push and do not open a pull request; Tally will publish the verified branch');
    expect(prompt).not.toContain('/tmp/');
  });

  it('fails a real task that leaves the worker branch with no commits ahead of base', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    worker.commitsAheadCount = 0;
    const verifier = new SequenceVerifier([{ passed: true, reason: null }]);

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'no-changes'),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier,
        usage: worker,
        sessions: worker,
        publisher: worker,
      },
    });

    expect(verifier.calls).toBe(0);
    expect(worker.published).toHaveLength(0);
    expect(result.ledger.every((row) => row.result === 'failed' && row.resultReason === 'no changes made' && row.prUrl === null)).toBe(true);
  });

  it('publishes the verified worker branch from Tally and records the PR URL', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'publish'),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
      },
    });

    expect(worker.published).toEqual([{ branch: 'tally/t1-1', taskId: 'T1' }]);
    expect(result.ledger[0]).toMatchObject({ result: 'passed', prUrl: 'https://github.com/acme/payments-service/pull/1' });
  });

  it('resolves the worker checkout from git worktrees when AO reports only the branch', async () => {
    const { dir, configPath } = fixture();
    const worker = new BranchOnlyWorker();
    const worktrees = new FakeWorktrees('/tmp/resolved-worker-checkout');
    const checkpointCalls: unknown[] = [];

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'resolved-checkout'),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
        worktrees,
        checkpoints: { checkpointFor: async (context) => {
          checkpointCalls.push(context);
          return { checkpointId: 'trailer-checkpoint', checkpointUrl: null, entireSessionId: 'native-codex' };
        } },
      },
    });

    expect(worktrees.calls).toEqual([{ repoPath: dir, branch: 'tally/t1-1' }]);
    expect(worker.commitChecks).toMatchObject([{ checkoutPath: '/tmp/resolved-worker-checkout', branch: 'tally/t1-1' }]);
    expect(worker.publishPaths).toEqual(['/tmp/resolved-worker-checkout']);
    expect(checkpointCalls).toEqual([{ sessionId: 'session-1', branch: 'tally/t1-1', checkoutPath: '/tmp/resolved-worker-checkout' }]);
    expect(result.ledger[0]).toMatchObject({ result: 'passed', prUrl: 'https://github.com/acme/payments-service/pull/1', checkpointId: 'trailer-checkpoint', entireSessionId: 'native-codex' });
  });

  it('records a missing worker checkout as an error without verification or escalation', async () => {
    const { dir, configPath } = fixture();
    const worker = new BranchOnlyWorker();
    const worktrees = new FakeWorktrees(null);
    const verifier = new SequenceVerifier([{ passed: true, reason: null }]);

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'missing-checkout'),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier,
        usage: worker,
        sessions: worker,
        publisher: worker,
        worktrees,
      },
    });

    expect(verifier.calls).toBe(0);
    expect(worker.starts).toHaveLength(1);
    expect(worker.published).toHaveLength(0);
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({ result: 'error', resultReason: 'could not locate worker checkout' });
    expect(result.runState.tasks[0]).toMatchObject({
      status: 'failed',
      statusReason: 'could not locate worker checkout',
      attempts: 1,
      escalated: false,
      prUrl: null,
    });
  });

  it('records settled final usage instead of an early empty usage snapshot', async () => {
    const { dir, configPath } = fixture();
    const worker = new UsageSettlesWorker();

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'settled-usage'),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
      },
    });

    expect(worker.usageCalls).toBe(1);
    expect(result.ledger[0]!.tokens.total).toBe(tokens.total);
    expect(result.ledger[0]!.estimatedCostNanos).toBeGreaterThan(0);
  });

  it('records a worker needs-input state as an error without running verification or escalating', async () => {
    const { dir, configPath } = fixture();
    const worker = new NeedsInputWorker();
    const verifier = new SequenceVerifier([{ passed: true, reason: null }]);

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'needs-input'),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier,
        usage: worker,
        sessions: worker,
        publisher: worker,
      },
    });

    expect(verifier.calls).toBe(0);
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({
      result: 'error',
      resultReason: 'worker asked for input: AO session entered needs_input/waiting_input',
    });
    expect(result.runState.tasks[0]).toMatchObject({
      status: 'failed',
      statusReason: 'worker asked for input: AO session entered needs_input/waiting_input',
      attempts: 1,
      escalated: false,
    });
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
      latestRunDir: join(dir, 'latest-resume'),
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker: firstWorker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: firstWorker,
        sessions: firstWorker,
        publisher: firstWorker,
      },
    });
    const secondWorker = new FakeWorker();
    const second = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir,
      latestRunDir: join(dir, 'latest-resume'),
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker: secondWorker,
        verifier: new SequenceVerifier([{ passed: false, reason: 'should not run' }]),
        usage: secondWorker,
        sessions: secondWorker,
        publisher: secondWorker,
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
            traceId: null,
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
      latestRunDir: join(dir, 'latest-interrupted'),
      now: fixedNow,
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
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
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
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
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals: missingEntireSignals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
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
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
        cfoai,
      },
    });

    expect(result.runState.budget).toMatchObject({ source: 'cfoai', limitNanos: usdToNanos(40) });
    expect(cfoai.writes).toEqual([result.ledger[0]!.estimatedCostNanos]);
    expect(cfoai.detailWrites).toEqual([
      {
        cumulativeRunSpendNanos: result.ledger[0]!.estimatedCostNanos,
        attempts: [{ tier: result.ledger[0]!.tier, costNanos: result.ledger[0]!.estimatedCostNanos }],
      },
    ]);
    const csv = readFileSync(join(result.outputDir, 'cfoai-spend-fallback.csv'), 'utf8');
    expect(csv).toContain('run_id,attempt_id,task_id');
    expect(csv).toContain(result.ledger[0]!.attemptId);
    expect(result.runState.integrations.cfoai).toEqual({ status: 'ok', detail: 'https://app.cfo.ai/s/table' });
  });

  it('respects the current month remaining budget from cfo.ai before starting work', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: false, cfoai: true, slack: false');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('budget: { source: config, usd: 40 }', 'budget: { source: cfoai, usd: 40 }'));
    const worker = new FakeWorker();
    const cfoai = new FakeCfoaiBudget(usdToNanos(40), false, usdToNanos(39.9));

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, 'cfoai-remaining'),
      latestRunDir: join(dir, 'latest'),
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

    expect(result.runState.budget).toMatchObject({ source: 'cfoai', limitNanos: usdToNanos(40), spentNanos: 0 });
    expect(result.runState.tasks[0]).toMatchObject({ status: 'skipped', statusReason: 'not started: no budget' });
    expect(result.ledger).toHaveLength(0);
    expect(cfoai.writes).toEqual([]);
    expect(cfoai.detailWrites).toEqual([]);
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
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
        cfoai,
      },
    });

    expect(result.runState.budget).toMatchObject({ source: 'config', limitNanos: usdToNanos(10) });
    expect(cfoai.writes).toEqual([]);
    expect(cfoai.detailWrites).toEqual([]);
    expect(result.runState.integrations.cfoai).toMatchObject({ status: 'missing' });
    expect(readFileSync(join(result.outputDir, 'cfoai-spend-fallback.csv'), 'utf8')).toContain(result.ledger[0]!.attemptId);
  });

  it('reads cfo.ai budget in dry-run, reports it as live and never writes simulated spend', async () => {
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
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
        cfoai,
      },
    });

    expect(cfoai.writes).toEqual([]);
    expect(existsSync(join(result.outputDir, 'cfoai-spend-fallback.csv'))).toBe(false);
    expect(result.runState.budget).toMatchObject({ source: 'cfoai', limitNanos: usdToNanos(40) });
    expect(result.runState.integrations.cfoai).toEqual({ status: 'ok', detail: 'budget read; spend not written in a dry run' });
  });

  it('reports scripted dry-run Entire sizing as neutral instead of missing', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: true, cfoai: false, slack: false');
    const worker = new FakeWorker();

    const result = await runRealTally({
      configPath,
      dryRun: true,
      baseline: false,
      outputDir: join(dir, 'entire-scripted'),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals: scriptedEntireSignals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
      },
    });

    expect(result.runState.integrations.entire).toEqual({ status: 'ok', detail: 'not used: sample tasks carry scripted sizing' });
  });

  it('reports neatlogs status from the trace port in a dry run', async () => {
    const { dir, configPath } = fixture('neatlogs: true, entire: false, cfoai: false, slack: false');
    const worker = new FakeWorker();

    const result = await runRealTally({
      configPath,
      dryRun: true,
      baseline: false,
      outputDir: join(dir, 'neatlogs-dry'),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
        trace: new FakeTrace(),
      },
    });

    expect(result.runState.integrations.neatlogs).toEqual({ status: 'ok', detail: 'https://app.neatlogs.com/traces/test-trace' });
  });

  it.each([
    [
      'neatlogs',
      'neatlogs: false, entire: true, cfoai: true, slack: false',
      {
        neatlogs: { status: 'off', detail: null },
        entire: { status: 'ok', detail: 'not used: sample tasks carry scripted sizing' },
        cfoai: { status: 'ok', detail: 'https://app.cfo.ai/s/table' },
      },
    ],
    [
      'entire',
      'neatlogs: true, entire: false, cfoai: true, slack: false',
      {
        neatlogs: { status: 'ok', detail: 'https://app.neatlogs.com/traces/test-trace' },
        entire: { status: 'off', detail: null },
        cfoai: { status: 'ok', detail: 'https://app.cfo.ai/s/table' },
      },
    ],
    [
      'cfoai',
      'neatlogs: true, entire: true, cfoai: false, slack: false',
      {
        neatlogs: { status: 'ok', detail: 'https://app.neatlogs.com/traces/test-trace' },
        entire: { status: 'ok', detail: 'not used: sample tasks carry scripted sizing' },
        cfoai: { status: 'off', detail: null },
      },
    ],
  ] as const)('completes the real loop with %s off and reports exactly that integration state', async (_off, integrations, expected) => {
    const { dir, configPath } = fixture(integrations);
    const worker = new FakeWorker();
    const cfoai = new FakeCfoaiBudget(usdToNanos(40));

    const result = await runRealTally({
      configPath,
      dryRun: false,
      baseline: false,
      outputDir: join(dir, `optional-${_off}`),
      now: fixedNow,
      latestRunDir: join(dir, 'latest'),
      ports: {
        intake,
        signals: scriptedEntireSignals,
        worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        usage: worker,
        sessions: worker,
        publisher: worker,
        trace: new FakeTrace(),
        cfoai,
      },
    });

    expect(result.runState.status).toBe('finished');
    expect(result.runState.tasks[0]).toMatchObject({ status: 'passed' });
    expect(result.ledger).toHaveLength(1);
    expect(result.runState.integrations.neatlogs).toEqual(expected.neatlogs);
    expect(result.runState.integrations.entire).toEqual(expected.entire);
    expect(result.runState.integrations.cfoai).toEqual(expected.cfoai);
  });
});
