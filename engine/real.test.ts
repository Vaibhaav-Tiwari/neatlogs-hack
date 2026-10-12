import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { createDryRunPorts } from './dry-run.js';
import { RunError } from './run.js';
import { CODEX_LIST_PRICES } from './pricing.js';
import { PriceHistory } from '../agent/history.js';
import type { CheckpointPort, CheckpointRecallPort, HandoffPort, SizingSignalsPort, LiveUsagePort, SessionControlPort, TracePort, TraceAttributes, TraceSpan } from '../agent/ports.js';
import { usdToNanos, validateLedger, validateRunState, type TaskImpact, type TokenUsage } from '../schema/index.js';
import type { BacklogIntakePort } from '../adapters/github.js';
import type { VerifierPort, VerifyResult } from '../adapters/verifier.js';
import { runRealTally as runRealTallyImpl, type RealRunOptions, type CfoaiBudgetPort, type WorkerPort, type WorkerResult, type WorkerStartInput, type WorktreePort } from './real.js';

// Loop tests never consult hosted Entire history; adapter behavior has dedicated fakes.
function runRealTally(options: RealRunOptions) {
  return runRealTallyImpl({ ...options, ports: { recall: { recallFor: async () => null }, ...options.ports } });
}

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
  async commitChanges() { return null; }

  async start(input: WorkerStartInput): ReturnType<WorkerPort['start']> {
    this.starts.push(input);
    return { sessionId: `session-${this.starts.length}`, branch: `tally/t1-${this.starts.length}`, checkoutPath: `/tmp/tally-${this.starts.length}` };
  }

  async wait(sessionId: string): Promise<WorkerResult> {
    const index = Number(sessionId.split('-')[1]);
    return { status: 'idle' as const, branch: `tally/t1-${index}`, checkoutPath: `/tmp/tally-${index}`, prUrl: `https://github.com/acme/payments-service/pull/${index}` };
  }

  async usageFor(_id?: string): Promise<{ tokens: TokenUsage; estimatedCostNanos: number } | null> {
    return { tokens, estimatedCostNanos: 123 };
  }

  async settledUsageFor(id?: string) {
    return this.usageFor(id);
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
  it.each(['live-demo', 'legacy-init'])('keeps %s legacy concurrency sequential when cfo.ai is unreachable', async kind => {
    const { dir, configPath } = fixture();
    const config = kind === 'live-demo' ? loadConfig(join(process.cwd(), 'demo/tally.live.yaml')) : loadConfig(configPath);
    config.concurrency = 3;
    config.integrations.cfoai = true;
    config.budget.source = 'cfoai';
    config.backlog = { source: 'file', file: join(process.cwd(), 'demo/sample-backlog.yaml') };
    writeFileSync(configPath, stringifyYaml(config));
    const dry = createDryRunPorts({ config, configPath });
    const active = new Set<string>();
    let peak = 0;
    const cfoai = new FakeCfoaiBudget(usdToNanos(40), true);
    const result = await runRealTally({ configPath, dryRun: true, baseline: false,
      outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { ...dry, trace: new FakeTrace(), checkpoints: { checkpointFor: async () => null }, cfoai,
        sessions: { stop: async (id, reason) => { active.delete(id); await dry.sessions!.stop(id, reason); } },
        worker: {
          start: async input => { const started = await dry.worker!.start(input); active.add(started.sessionId); peak = Math.max(peak, active.size); return started; },
          wait: async id => { try { await new Promise(resolve => setTimeout(resolve, 5)); return await dry.worker!.wait(id); } finally { active.delete(id); } },
        },
      } });
    expect(peak).toBe(1);
    expect(result.runState.tasks).toHaveLength(7);
    expect(result.runState.status).toBe('finished');
    expect(result.runState.budget.source).toBe('config');
    expect(result.runState.integrations.cfoai.status).toBe('missing');
    expect(result.runState.integrations.cfoai.detail).toContain('using the fallback budget in tally.yaml');
    expect(cfoai.writes).toEqual([]);
  });

  it('allows explicitly parallel dry workers to fall back when cfo.ai is unreachable', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: false, cfoai: true, slack: false');
    const config = loadConfig(configPath);
    config.parallelWorkers = 3;
    writeFileSync(configPath, stringifyYaml(config));
    const worker = new FakeWorker();
    const cfoai = new FakeCfoaiBudget(usdToNanos(40), true);
    cfoai.status = () => ({ status: 'ok', detail: 'transport connected but budget inaccessible' });
    const result = await runRealTally({ configPath, dryRun: true, baseline: false,
      outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, cfoai,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });
    expect(worker.starts).toHaveLength(1);
    expect(result.runState.status).toBe('finished');
    expect(result.runState.budget.source).toBe('config');
    expect(result.runState.integrations.cfoai.status).toBe('missing');
    expect(cfoai.writes).toEqual([]);
  });

  it('keeps absent concurrency byte-for-byte identical to explicit 1', async () => {
    const { dir, configPath } = fixture();
    const config = loadConfig(configPath);
    const run = async (name: string, concurrency?: number) => {
      writeFileSync(configPath, stringifyYaml({ ...config, ...(concurrency === undefined ? {} : { concurrency }) }));
      const worker = new FakeWorker();
      return runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, name), latestRunDir: join(dir, 'latest'), now: fixedNow,
        ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, history: new PriceHistory(), verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });
    };
    const absent = await run('absent');
    const explicit = await run('explicit', 1);
    expect(readFileSync(absent.runStatePath, 'utf8')).toBe(readFileSync(explicit.runStatePath, 'utf8'));
    expect(readFileSync(absent.ledgerPath, 'utf8')).toBe(readFileSync(explicit.ledgerPath, 'utf8'));
  });

  it('isolates a worker error and still verifies, publishes and closes healthy workers', async () => {
    const { dir, configPath } = fixture();
    const task = (await intake.tasks(loadConfig(configPath), configPath))[0]!;
    class ErrorWorker extends FakeWorker {
      override async wait(id: string) { if (this.starts[Number(id.split('-')[1]) - 1]?.task.taskId === 'T1') throw new Error('AO connection failed for T1'); return super.wait(id); }
    }
    const worker = new ErrorWorker();
    const result = await runRealTally({ configPath, parallel: 2, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake: { tasks: async () => [task, { ...task, taskId: 'T2' }] }, signals, worker, usage: worker, sessions: worker, publisher: worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });
    expect(result.ledger.find(row => row.taskId === 'T1')?.result).toBe('error');
    expect(result.ledger.find(row => row.taskId === 'T2')?.result).toBe('passed');
    expect(worker.published.map(item => item.taskId)).toEqual(['T2']);
    expect(worker.stopped.sort()).toEqual(['session-1', 'session-2']);
  });

  it('interrupts every live worker and never verifies or publishes interrupted work', async () => {
    const { dir, configPath } = fixture();
    const task = (await intake.tasks(loadConfig(configPath), configPath))[0]!;
    class WaitingWorker extends FakeWorker {
      pending = new Map<string, (result: WorkerResult) => void>();
      override async wait(id: string): Promise<WorkerResult> { return new Promise(resolve => this.pending.set(id, resolve)); }
      override async stop(id: string) { await super.stop(id); this.pending.get(id)?.(await super.wait(id)); }
    }
    const worker = new WaitingWorker();
    let interrupted = false;
    const result = await runRealTally({ configPath, parallel: 2, dryRun: true, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      stopRequested: () => interrupted ? 'interrupted by user' : null,
      onEvent: event => { if (event.type === 'worker' && worker.starts.length === 2) interrupted = true; },
      ports: { intake: { tasks: async () => [task, { ...task, taskId: 'T2' }, { ...task, taskId: 'T3' }] }, signals, worker, usage: worker, sessions: worker, publisher: worker,
        verifier: { verify: async () => { throw new Error('must not verify interrupted work'); } } } });
    expect(worker.starts).toHaveLength(2);
    expect(new Set(worker.stopped)).toEqual(new Set(['session-1', 'session-2']));
    expect(worker.published).toHaveLength(0);
    expect(result.runState.status).toBe('interrupted');
    expect(result.runState.tasks[2]?.status).toBe('skipped');
  }, 5000);

  it('keeps a ceiling-stopped task escalation on its branch while another task passes', async () => {
    const { dir, configPath } = fixture();
    const task = (await intake.tasks(loadConfig(configPath), configPath))[0]!;
    class StoppedWorker extends FakeWorker {
      pending?: (result: WorkerResult) => void;
      override async wait(id: string): Promise<WorkerResult> {
        if (id === 'session-1') return new Promise(resolve => { this.pending = resolve; });
        return super.wait(id);
      }
      override async stop(id: string) { await super.stop(id); if (id === 'session-1') this.pending?.(await super.wait(id)); }
      override async usageFor(id?: string) {
        return id === 'session-1' ? { tokens: { uncachedInput: 0, cachedInput: 0, output: 41_000, total: 41_000 }, estimatedCostNanos: 1 } : super.usageFor();
      }
      override async settledUsageFor(id?: string) { return this.usageFor(id); }
    }
    const worker = new StoppedWorker();
    const result = await runRealTally({ configPath, parallel: 2, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake: { tasks: async () => [task, { ...task, taskId: 'T2' }] }, signals, worker, usage: worker, sessions: worker, publisher: worker,
        worktrees: { checkoutPathFor: async () => '/tmp/fake', commitWorkInProgress: async () => 'wip-sha' },
        verifier: new SequenceVerifier([{ passed: true, reason: null }, { passed: true, reason: null }]) } });
    const first = result.ledger.find(row => row.taskId === 'T1' && row.attempt === 1)!;
    expect(first.result).toBe('stopped');
    expect(first.resultReason).toContain('wip-sha');
    expect(worker.starts.find(start => start.task.taskId === 'T1' && start.attempt === 2)?.continueBranch).toBe(first.branch);
    expect(result.runState.tasks.every(task => task.status === 'passed')).toBe(true);
  }, 5000);

  for (const width of [2, 3]) {
    it(`overlaps ${width} AO workers, persists valid interleaved JSON and serializes accounting`, async () => {
      const { dir, configPath } = fixture('neatlogs: false, entire: false, cfoai: true, slack: false');
      if (width === 3) writeFileSync(configPath, stringifyYaml({ ...loadConfig(configPath), parallelWorkers: width }));
      const backlog = (await intake.tasks(loadConfig(configPath), configPath))[0]!;
      const tasks = Array.from({ length: width * 2 }, (_, i) => ({ ...backlog, taskId: `T${i + 1}` }));
      class OverlapWorker extends FakeWorker {
        active = 0;
        peak = 0;
        pending: Array<() => void> = [];
        override async start(input: WorkerStartInput) {
          this.peak = Math.max(this.peak, ++this.active);
          return super.start(input);
        }
        override async wait(id: string) {
          await new Promise<void>(resolve => {
            this.pending.push(resolve);
            if (this.pending.length === width) for (const done of this.pending.splice(0)) done();
          });
          return super.wait(id);
        }
        override async stop(id: string) { this.active--; await super.stop(id); }
      }
      const worker = new OverlapWorker();
      let writing = 0;
      let maxWriting = 0;
      const actuals: number[] = [];
      const cfoai: CfoaiBudgetPort = {
        budgetLimitNanos: async () => usdToNanos(40), currentSpendNanos: async () => 0, remainingNanos: async () => usdToNanos(40),
        status: () => ({ status: 'ok', detail: 'fake' }),
        async writeCumulativeActualSpend(cost) {
          maxWriting = Math.max(maxWriting, ++writing);
          await Promise.resolve(); actuals.push(cost); writing--;
        },
      };
      let snapshots = 0;
      const result = await runRealTally({ configPath, ...(width === 2 ? { parallel: width } : {}), dryRun: false, baseline: false,
        outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
        onEvent: () => {
          for (const root of ['out', 'latest']) {
            expect(validateRunState(JSON.parse(readFileSync(join(dir, root, 'run.json'), 'utf8'))).ok).toBe(true);
            expect(validateLedger(JSON.parse(readFileSync(join(dir, root, 'ledger.json'), 'utf8'))).ok).toBe(true);
          }
          snapshots++;
        },
        ports: { intake: { tasks: async () => tasks }, signals, worker, usage: worker, sessions: worker, publisher: worker,
          verifier: new SequenceVerifier(tasks.map(() => ({ passed: true, reason: null }))), cfoai },
      });
      expect(worker.peak).toBe(width);
      expect(worker.active).toBe(0);
      expect(result.ledger).toHaveLength(tasks.length);
      expect(new Set(result.ledger.map(row => row.sessionId)).size).toBe(tasks.length);
      expect(new Set(result.ledger.map(row => row.branch)).size).toBe(tasks.length);
      expect(result.runState.tasks.every(task => task.status === 'passed')).toBe(true);
      expect(maxWriting).toBe(1);
      expect(actuals.at(-1)).toBe(result.runState.budget.spentNanos);
      expect(snapshots).toBeGreaterThan(tasks.length * 3);
    }, 5000);
  }

  it('holds funds for escalation and admits a waiting task only after unused funds are released', async () => {
    const { dir, configPath } = fixture();
    const task = (await intake.tasks(loadConfig(configPath), configPath))[0]!;
    const worker = new FakeWorker();
    const events: string[] = [];
    const result = await runRealTally({ configPath, parallel: 2, budgetUsd: 0.9, dryRun: false, baseline: false,
      outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      onEvent: event => { if (event.type === 'worker' || event.type === 'result') events.push(`${event.type}:${event.type === 'result' ? event.row.taskId : event.taskId}`); },
      ports: { intake: { tasks: async () => [task, { ...task, taskId: 'T2' }] }, signals, worker, usage: worker, sessions: worker, publisher: worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }, { passed: true, reason: null }]) },
    });
    expect(events).toEqual(['worker:T1', 'result:T1', 'worker:T2', 'result:T2']);
    expect(result.runState.tasks.every(task => task.status === 'passed')).toBe(true);
  }, 5000);

  it('cannot reserve an escalation beyond the CLI cap or the live monthly remainder', async () => {
    for (const monthly of [false, true]) {
      const { dir, configPath } = fixture(`neatlogs: false, entire: false, cfoai: ${monthly}, slack: false`);
      const worker = new FakeWorker();
      const result = await runRealTally({ configPath, parallel: 3, budgetUsd: monthly ? 2 : 0.6, dryRun: false, baseline: false,
        outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
        ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker,
          ...(monthly ? { cfoai: { budgetLimitNanos: async () => usdToNanos(40), currentSpendNanos: async () => usdToNanos(39.4),
            remainingNanos: async () => usdToNanos(0.6), writeCumulativeActualSpend: async () => {}, status: () => ({ status: 'ok' as const, detail: 'fake' }) } } : {}) },
      });
      expect(worker.starts).toHaveLength(0);
      expect(result.runState.tasks[0]?.status).toBe('skipped');
      expect(result.runState.tasks[0]?.statusReason).toContain('reservation');
    }
  });

  it('fails closed before spawning parallel workers if the live monthly budget cannot be read', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: false, cfoai: true, slack: false');
    const worker = new FakeWorker();
    await expect(runRealTally({ configPath, parallel: 3, dryRun: false, baseline: false,
      outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'),
      ports: { worker, usage: worker, sessions: worker, cfoai: {
        budgetLimitNanos: async () => { throw new Error('budget unavailable'); }, remainingNanos: async () => 0,
        writeCumulativeActualSpend: async () => {}, status: () => ({ status: 'missing', detail: 'unavailable' }),
      } } })).rejects.toThrow(RunError);
    expect(worker.starts).toHaveLength(0);
  });

  it('stops the pool when delayed usage reveals the shared cap is exhausted', async () => {
    const { dir, configPath } = fixture();
    const task = (await intake.tasks(loadConfig(configPath), configPath))[0]!;
    let releaseUsage!: () => void;
    const bothStarted = new Promise<void>(resolve => { releaseUsage = resolve; });
    class DelayedUsageWorker extends FakeWorker {
      pending = new Map<string, (result: WorkerResult) => void>();
      override async start(input: WorkerStartInput) { const result = await super.start(input); if (this.starts.length === 2) releaseUsage(); return result; }
      override async wait(id: string): Promise<WorkerResult> { return new Promise(resolve => this.pending.set(id, resolve)); }
      override async usageFor() { await bothStarted; return { tokens: { uncachedInput: 0, cachedInput: 0, output: 160_000, total: 160_000 }, estimatedCostNanos: 0 }; }
      override async stop(id: string) { await super.stop(id); this.pending.get(id)?.(await super.wait(id)); }
    }
    const worker = new DelayedUsageWorker();
    const result = await runRealTally({ configPath, parallel: 2, budgetUsd: 1.5, dryRun: true, baseline: false,
      outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake: { tasks: async () => [task, { ...task, taskId: 'T2' }, { ...task, taskId: 'T3' }] }, signals, worker, usage: worker, sessions: worker, publisher: worker } });
    expect(worker.starts).toHaveLength(2);
    expect(new Set(worker.stopped)).toEqual(new Set(['session-1', 'session-2']));
    expect(result.runState.status).toBe('interrupted');
    expect(result.runState.tasks[2]?.status).toBe('skipped');
    expect(result.ledger.every(row => row.resultReason?.includes('shared run cap'))).toBe(true);
    // A delayed meter can report an overshoot; retain the actual cost, never clamp it.
    expect(result.runState.budget.spentNanos).toBe(usdToNanos(1.6));
  }, 5000);

  it('keeps configured direct workers sequential and rejects a parallel CLI override', async () => {
    const { dir, configPath } = fixture();
    const config = loadConfig(configPath);
    writeFileSync(configPath, stringifyYaml({ ...config, runner: 'direct', concurrency: 3 }));
    const worker = new FakeWorker();
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });
    expect(result.ledger[0]?.result).toBe('passed');
    await expect(runRealTally({ configPath, parallel: 2, dryRun: false, baseline: false })).rejects.toThrow('direct remains sequential');
  });

  it('uses real repository sizing with Entire off and fake worker/verifier ports', async () => {
    const { dir, configPath } = fixture();
    writeFileSync(join(dir, 'index.html'), '<main>Static site</main>');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', 'index.html'], { cwd: dir });
    const worker = new FakeWorker();
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake: { tasks: async () => [{ taskId: 'README', title: 'Add README.md', body: 'Create README.md to document how the repository is used. Keep it under 80 lines. Do not change any existing file.', size: 'medium', outcomes: ['passed'], issueNumber: null, issueUrl: null }] },
        worker, usage: worker, sessions: worker, publisher: worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });
    expect(worker.starts[0]?.tier.name).toBe('cheap');
    expect(result.ledger[0]?.size).toBe('small');
    expect(result.ledger[0]?.decision).toContain('from the issue text and a search of the repository');
    expect(result.runState.tasks[0]?.impact?.nodes.map(node => node.id)).toEqual(['README.md']);
  });
  it.each(['file', 'github-issues'] as const)('records %s backlog provenance even with zero tasks', async (source) => {
    const { dir, configPath } = fixture();
    const config = loadConfig(configPath);
    config.backlog = source === 'file' ? { source, file: 'external/backlog.yaml' } : { source, issueLabel: 'ready-for-tally' };
    writeFileSync(configPath, stringifyYaml(config));
    const worker = new FakeWorker();
    const result = await runRealTally({ configPath, dryRun: true, baseline: false, outputDir: join(dir, 'empty'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake: { tasks: async () => [] }, worker, usage: worker, sessions: worker } });
    expect(result.runState.backlog).toEqual(config.backlog);
    expect(JSON.parse(readFileSync(result.runStatePath, 'utf8')).backlog).toEqual(config.backlog);
    expect(result.runState.tasks).toEqual([]);
    expect(worker.starts).toEqual([]);
    expect(validateRunState(result.runState).ok).toBe(true);
  });
  it('persists verified configured price provenance through the real loop with fake ports', async () => {
    const { dir, configPath } = fixture();
    const config = loadConfig(configPath);
    Object.assign(config.tiers[0]!, { provider: 'openai', harness: 'codex', model: 'gpt-5.6-luna', price: CODEX_LIST_PRICES['gpt-5.6-luna']! });
    writeFileSync(configPath, stringifyYaml(config));
    const worker = new FakeWorker();
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]), publisher: worker, usage: worker, sessions: worker } });
    const rows = JSON.parse(readFileSync(result.ledgerPath, 'utf8'));
    expect(rows[0].price).toEqual(CODEX_LIST_PRICES['gpt-5.6-luna']);
    expect(rows[0].priceNote).toContain('Verified base list price');
    expect(rows[0].priceNote).toContain('https://developers.openai.com/api/docs/models/gpt-5.6-luna');
    expect(validateLedger(rows).ok).toBe(true);
  });
  it('persists actual branch files after worker close removes its checkout', async () => {
    const { dir, configPath } = fixture();
    const checkout = join(dir, 'worker');
    mkdirSync(checkout);
    const worker = new FakeWorker();
    const wait = worker.wait.bind(worker);
    worker.wait = async id => ({ ...await wait(id), checkoutPath: checkout });
    worker.stop = async id => { worker.stopped.push(id); rmSync(checkout, { recursive: true, force: true }); };
    let settledDiff = false;
    worker.changedFiles = async (input?: { checkoutPath?: string; branch?: string; baseCommit?: string | null }) => {
      if (worker.stopped.length) {
        expect(existsSync(checkout)).toBe(false);
        expect(input).toMatchObject({ checkoutPath: dir, branch: 'tally/t1-1', baseCommit: 'pinned-base' });
        settledDiff = true;
      }
      return ['calc.ts', 'tests/outside-predicted-slice.test.ts'];
    };
    const result = await runRealTally({ configPath, requiredBaseCommit: 'pinned-base', dryRun: false, baseline: false,
      outputDir: join(dir, 'actual'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker,
        worktrees: { checkoutPathFor: async () => checkout, commitFor: async () => 'pinned-base' },
        verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });
    expect(settledDiff).toBe(true);
    expect(result.runState.tasks[0]?.changedFiles).toEqual(['calc.ts', 'tests/outside-predicted-slice.test.ts']);
    const saved = JSON.parse(readFileSync(join(result.outputDir, 'run.json'), 'utf8'));
    expect(saved.tasks[0].changedFiles).toEqual(result.runState.tasks[0]?.changedFiles);
    expect(validateRunState(saved).ok).toBe(true);
  }, 10_000);
  it('records the native session of a stopped worker without a checkpoint and passes it to trace drain', async () => {
    const { dir, configPath } = fixture('neatlogs: true, entire: true, cfoai: false, slack: false');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('harness: claude-code', 'harness: codex'));
    const worker = new FakeWorker();
    const wait = worker.wait.bind(worker);
    let finish: ((result: WorkerResult) => void) | undefined;
    worker.wait = (id) => id === 'session-1' ? new Promise(resolve => { finish = resolve; }) : wait(id);
    worker.stop = async id => {
      worker.stopped.push(id);
      if (id === 'session-1') finish?.({ status: 'terminated', branch: 'tally/t1-1', checkoutPath: '/tmp/tally-1', prUrl: null });
    };
    const contexts: Array<{ entireSessionId?: string | null }> = [];
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'native'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake: { tasks: async (...args) => (await intake.tasks(...args)).map(t => ({ ...t, firstAttemptCeilingUsd: 0.001 })) },
        worktrees: { checkoutPathFor: async () => null, commitWorkInProgress: async () => null },
        signals, worker, usage: worker, sessions: worker, publisher: worker, trace: new FakeTrace(),
        history: { lookup: async () => null, record: async () => {} },
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        checkpoints: { checkpointFor: async () => null, sessionIdFor: async c => `native-${c.sessionId}` },
        workerTraceDrain: { drainWorker: async c => { contexts.push(c); } },
        workerTraceReader: { verifyFor: async c => { expect(c.nativeSessionId).toBe(`native-session-${c.attempt}`); return 'b'.repeat(32); } } } });
    expect(result.ledger[0]).toMatchObject({ result: 'stopped', checkpointId: null, entireSessionId: 'native-session-1', sessionId: 'session-1' });
    expect(result.ledger[0]?.workerTraceId).toBe('b'.repeat(32));
    expect(result.ledger[0]?.traceId).not.toBe(result.ledger[0]?.workerTraceId);
    expect(contexts[0]?.entireSessionId).toBe('native-session-1');
  });
  it.each([false, true])('records zero-token startup as error and retries only once (always zero: %s)', async (alwaysZero) => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    const usage = worker.usageFor.bind(worker);
    worker.usageFor = async () => alwaysZero || worker.starts.length === 1 ? null : usage();
    const verifier = new SequenceVerifier([{ passed: true, reason: null }]);
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, verifier } });
    expect(worker.starts).toHaveLength(2);
    expect(result.ledger[0]).toMatchObject({ result: 'error', resultReason: 'worker never started', estimatedCostNanos: 0 });
    expect(result.ledger[1]?.attemptId).toContain('startup-retry');
    expect(result.ledger[1]?.result).toBe(alwaysZero ? 'error' : 'passed');
    expect(verifier.calls).toBe(alwaysZero ? 0 : 1);
    expect(new Set(result.ledger.map((row) => row.attemptId)).size).toBe(2);
  });
  it('records an AO model rejection as a tier configuration error without retrying or verifying task work', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    worker.usageFor = async () => null;
    worker.settledUsageFor = async () => null;
    worker.wait = async () => ({ status: 'never_started', branch: null, checkoutPath: null, prUrl: null,
      resultReason: `worker never started: model ${worker.starts[0]?.model} not available for this account` });
    const verifier = new SequenceVerifier([{ passed: true, reason: null }]);
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'model-rejected'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, verifier } });
    const first = result.ledger[0]!;
    expect(worker.starts).toHaveLength(1);
    expect(verifier.calls).toBe(0);
    expect(first).toMatchObject({ result: 'error', estimatedCostNanos: 0 });
    expect(first.resultReason).toContain(`tier "${worker.starts[0]?.tier.name}"`);
    expect(first.resultReason).toContain(`model "${worker.starts[0]?.model}"`);
    expect(first.resultReason).toContain('update this tier\'s model in tally.yaml');
  });
  it('surfaces a model rejection thrown before a worker session starts as a configuration error', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    worker.start = async (input) => {
      worker.starts.push(input);
      throw new Error(`model ${input.model} not available for this account`);
    };
    const verifier = new SequenceVerifier([{ passed: true, reason: null }]);
    await expect(runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'model-start-rejected'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, verifier } }))
      .rejects.toThrow(/Model configuration error for tier .*active harness account rejected the configured model/);
    expect(worker.starts).toHaveLength(1);
    expect(verifier.calls).toBe(0);
  });
  it.each(['start', 'wait'] as const)('retries once on the configured model-access fallback when rejection happens during worker %s', async failurePoint => {
    const { dir, configPath } = fixture();
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(
      'budget: { source: config, usd: 40 }',
      'modelAccessFallbackTier: middle\nbudget: { source: config, usd: 40 }',
    ));
    const worker = new FakeWorker();
    const originalWait = worker.wait.bind(worker);
    worker.start = async input => {
      worker.starts.push(input);
      if (failurePoint === 'start' && worker.starts.length === 1) throw new Error(`model ${input.model} not available for this account`);
      return { sessionId: `session-${worker.starts.length}`, branch: `tally/t1-${worker.starts.length}`, checkoutPath: `/tmp/tally-${worker.starts.length}` };
    };
    if (failurePoint === 'wait') {
      worker.wait = async id => id === 'session-1'
        ? { status: 'never_started', branch: null, checkoutPath: null, prUrl: null, resultReason: 'model gpt-5.6-luna not available for this account' }
        : originalWait(id);
      worker.usageFor = async (id?: string) => id === 'session-1' ? null : { tokens, estimatedCostNanos: 123 };
      worker.settledUsageFor = async (id?: string) => id === 'session-1' ? null : { tokens, estimatedCostNanos: 123 };
    }

    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'fallback'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });

    expect(worker.starts.map(start => start.tier.name)).toEqual(['cheap', 'middle']);
    expect(result.ledger).toHaveLength(2);
    expect(result.ledger[0]).toMatchObject({ result: 'error', estimatedCostNanos: 0, tier: 'cheap' });
    expect(result.ledger[0]?.resultReason).toContain('active harness account rejected the configured model');
    expect(result.ledger[1]).toMatchObject({ attempt: 2, result: 'passed', tier: 'middle', escalatedFrom: result.ledger[0]?.attemptId });
    expect(result.runState.tasks[0]?.status).toBe('passed');
    expect(result.runState.tasks[0]?.escalated).toBe(true);
    expect(validateLedger(result.ledger).ok).toBe(true);
  });

  it('preserves unique ledger ids when model access is rejected during the startup retry', async () => {
    const { dir, configPath } = fixture();
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(
      'budget: { source: config, usd: 40 }',
      'modelAccessFallbackTier: middle\nbudget: { source: config, usd: 40 }',
    ));
    const worker = new FakeWorker();
    worker.start = async input => {
      worker.starts.push(input);
      if (worker.starts.length === 2) throw new Error(`model ${input.model} not available for this account`);
      return { sessionId: `session-${worker.starts.length}`, branch: `tally/t1-${worker.starts.length}`, checkoutPath: `/tmp/tally-${worker.starts.length}` };
    };
    const originalWait = worker.wait.bind(worker);
    worker.wait = async id => id === 'session-1'
      ? { status: 'never_started', branch: null, checkoutPath: null, prUrl: null, resultReason: 'worker never started' }
      : originalWait(id);
    worker.usageFor = async (id?: string) => id === 'session-1' ? null : { tokens, estimatedCostNanos: 123 };
    worker.settledUsageFor = async (id?: string) => id === 'session-1' ? null : { tokens, estimatedCostNanos: 123 };

    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'startup-fallback'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });

    expect(result.ledger.map(row => row.attemptId)).toEqual(['run-20261011-030000Z:T1:1', 'run-20261011-030000Z:T1:1:startup-retry', 'run-20261011-030000Z:T1:2']);
    expect(result.ledger.map(row => row.tier)).toEqual(['cheap', 'cheap', 'middle']);
    expect(new Set(result.ledger.map(row => row.attemptId)).size).toBe(result.ledger.length);
    expect(result.ledger[1]?.resultReason).toContain('active harness account rejected the configured model');
    expect(result.ledger[2]?.result).toBe('passed');
    expect(validateLedger(result.ledger).ok).toBe(true);
  });

  it('does not use a configured model-access fallback for a network failure', async () => {
    const { dir, configPath } = fixture();
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(
      'budget: { source: config, usd: 40 }',
      'modelAccessFallbackTier: middle\nbudget: { source: config, usd: 40 }',
    ));
    const worker = new FakeWorker();
    worker.wait = async () => ({ status: 'error', branch: null, checkoutPath: null, prUrl: null, resultReason: 'network timeout while starting model' });

    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'no-fallback'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });

    expect(worker.starts).toHaveLength(1);
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({ result: 'error', resultReason: 'network timeout while starting model' });
  });
  it.each([
    { dryRun: true, source: 'cfoai', enabled: false },
    { dryRun: false, source: 'cfoai', enabled: false },
    { dryRun: true, source: 'config', enabled: true },
    { dryRun: false, source: 'config', enabled: true },
    { dryRun: true, source: 'config', enabled: false },
  ])('persists configured cfo.ai links only when applicable: %j', async ({ dryRun, source, enabled }) => {
    const { dir, configPath } = fixture(`neatlogs: false, entire: false, cfoai: ${enabled}, slack: false`);
    const links = { pageUrl: 'https://app.cfo.ai/page/tally', tableUrl: 'https://app.cfo.ai/s/table' };
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('budget: { source: config, usd: 40 }',
      `budget: { source: ${source}, usd: 40, cfoai: ${JSON.stringify(links)} }`));
    const worker = new FakeWorker();
    const result = await runRealTally({ configPath, dryRun, baseline: false, outputDir: join(dir, 'links'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker,
        cfoai: new FakeCfoaiBudget(), verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });
    const saved = JSON.parse(readFileSync(join(result.outputDir, 'run.json'), 'utf8'));
    expect(saved.budget.cfoai).toEqual(source === 'cfoai' || enabled ? links : undefined);
    expect(result.runState.budget.cfoai).toEqual(saved.budget.cfoai);
  });
  it.each([
    { dryRun: false, enabled: true, delivered: false }, { dryRun: false, enabled: true, delivered: true }, { dryRun: true, enabled: true, delivered: false }, { dryRun: false, enabled: false, delivered: false },
  ])('drains Codex traces after closing real workers only: %j', async ({ dryRun, enabled, delivered }) => {
    const { dir, configPath } = fixture(`neatlogs: ${enabled}, entire: false, cfoai: false, slack: false`);
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('harness: claude-code', 'harness: codex'));
    const worker = new FakeWorker();
    const contexts: unknown[] = [];
    const events: string[] = [];
    const result = await runRealTally({ configPath, dryRun, baseline: false, outputDir: join(dir, 'drain'), latestRunDir: join(dir, 'latest'), now: fixedNow, onEvent: event => events.push(event.type),
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, trace: new FakeTrace(),
        history: { lookup: async () => null, record: async () => {} },
        worktrees: { checkoutPathFor: async () => '/worker' },
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        workerTraceDrain: { drainWorker: async (context) => { expect(worker.stopped).toContain('session-1'); contexts.push(context); },
          status: () => ({ status: 'missing', detail: 'No queued worker trace found; delivery is not verified' }) },
        workerTraceReader: { verifyFor: async context => {
          expect(context).toMatchObject({ runId: 'run-20261011-030000Z', taskId: 'T1', attempt: 1, nativeSessionId: null });
          return delivered ? 'a'.repeat(32) : null;
        } },
      } });
    expect(contexts.length).toBe(!dryRun && enabled ? 1 : 0);
    expect(events[0]).toBe('budget');
    expect(events.indexOf('route')).toBeLessThan(events.indexOf('worker'));
    expect(events.indexOf('worker')).toBeLessThan(events.indexOf('spend'));
    expect(events.at(-1)).toBe('result');
    if (!dryRun && enabled) {
      expect(result.ledger[0]?.workerTraceId).toBe(delivered ? 'a'.repeat(32) : null);
      expect(result.runState.integrations.neatlogs.status).toBe(delivered ? 'ok' : 'missing');
    }
    expect(result.runState.status).toBe('finished');
  });
  it.each([
    ['ao', 'claude-code'], ['ao', 'codex'], ['direct', 'claude-code'], ['direct', 'codex'],
  ] as const)('reads worker traces after closure for %s/%s and reports delivery honestly', async (runner, harness) => {
    for (const delivered of [true, false]) {
      const { dir, configPath } = fixture('neatlogs: true, entire: false, cfoai: false, slack: false');
      const config = loadConfig(configPath);
      config.runner = runner;
      config.tiers.forEach(tier => { tier.harness = harness; });
      writeFileSync(configPath, stringifyYaml(config));
      const worker = new FakeWorker();
      let reads = 0, drains = 0;
      const result = await runRealTally({ configPath, dryRun: false, baseline: false,
        outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
        ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker,
          history: { lookup: async () => null, record: async () => {} },
          worktrees: { checkoutPathFor: async () => '/worker', commitFor: async () => 'test-base' },
          trace: new FakeTrace(), verifier: new SequenceVerifier([{ passed: true, reason: null }]),
          workerTraceDrain: { drainWorker: async () => { expect(worker.stopped).toContain('session-1'); drains++; } },
          workerTraceReader: { verifyFor: async context => {
            expect(worker.stopped).toContain('session-1');
            expect(context).toEqual({ runId: 'run-20261011-030000Z', taskId: 'T1', attempt: 1,
              nativeSessionId: runner === 'direct' ? 'session-1' : null });
            reads++;
            return delivered ? 'c'.repeat(32) : null;
          }, status: () => delivered
            ? { status: 'ok' as const, detail: null }
            : { status: 'missing' as const, detail: 'Neatlogs worker span read-back was unauthorized (HTTP 401).' } },
        },
      });
      expect(reads).toBe(1);
      expect(drains).toBe(harness === 'codex' ? 1 : 0);
      expect(result.ledger[0]?.workerTraceId).toBe(delivered ? 'c'.repeat(32) : null);
      expect(result.runState.integrations.neatlogs.status).toBe(delivered ? 'ok' : 'missing');
      if (!delivered) {
        expect(result.ledger[0]?.workerTraceDetail).toContain('HTTP 401');
        expect(result.runState.integrations.neatlogs.detail).toContain('HTTP 401');
      }
      const saved = JSON.parse(readFileSync(join(result.outputDir, 'ledger.json'), 'utf8'));
      expect(saved[0].workerTraceId).toBe(result.ledger[0]?.workerTraceId);
    }
  });

  it('continues the watcher-stopped branch on escalation and publishes only the verified attempt', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    const originalWait = worker.wait.bind(worker);
    const originalStart = worker.start.bind(worker);
    worker.start = async (input) => {
      if (input.attempt === 2) {
        const rows = JSON.parse(readFileSync(join(dir, 'out', 'ledger.json'), 'utf8'));
        const state = JSON.parse(readFileSync(join(dir, 'out', 'run.json'), 'utf8'));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ result: 'stopped', estimatedCostNanos: 2_700_000 });
        expect(state.budget.spentNanos).toBe(2_700_000);
        expect(state.tasks[0].attempts).toBe(1);
      }
      return originalStart(input);
    };
    let finish: ((result: WorkerResult) => void) | undefined;
    worker.wait = (id) => id === 'session-1' ? new Promise((resolve) => { finish = resolve; }) : originalWait(id).then((result) => ({ ...result, branch: 'tally/t1-1' }));
    worker.stop = async (id) => { worker.stopped.push(id); if (id === 'session-1') finish?.({ status: 'terminated', branch: 'tally/t1-1', checkoutPath: '/tmp/tally-1', prUrl: null }); };
    const tasks: BacklogIntakePort = { tasks: async (...args) => (await intake.tasks(...args)).map((task) => ({ ...task, firstAttemptCeilingUsd: 0.001 })) };
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake: tasks, signals, worker, usage: worker, sessions: worker, publisher: worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        worktrees: { checkoutPathFor: async () => null, commitWorkInProgress: async () => null },
        handoff: { summaryFor: async () => ({ type: 'entire-handoff', summary: 'Continue partial calc.ts.', branch: 'tally/t1-1' }) } } });
    expect(result.ledger.map((row) => row.result)).toEqual(['stopped', 'passed']);
    expect(worker.starts[1]).toMatchObject({ continueBranch: 'tally/t1-1', continueSessionId: 'session-1' });
    expect(worker.starts[1]?.prompt).toContain('Continue partial calc.ts.');
    expect(worker.starts[1]?.prompt).toContain('do not amend, squash, reset, or rebase');
    expect(result.ledger[1]?.handoffText).toBe('Continue from failed branch tally/t1-1.\n\nContinue partial calc.ts.');
    expect(worker.published).toEqual([{ branch: 'tally/t1-1', taskId: 'T1' }]);
  }, 10_000);
  it('flushes live cost and running task state to disk before the worker ends', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    const wait = worker.wait.bind(worker);
    worker.wait = async (id) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const state = JSON.parse(readFileSync(join(dir, 'out', 'run.json'), 'utf8'));
      expect(state.budget.spentNanos).toBe(2_700_000);
      expect(state.tasks[0]).toMatchObject({ status: 'running', tier: 'cheap', attempts: 1, spentNanos: 2_700_000 });
      expect(JSON.parse(readFileSync(join(dir, 'out', 'ledger.json'), 'utf8'))).toEqual([]);
      return wait(id);
    };
    const result = await runRealTally({ configPath, dryRun: true, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]) } });
    expect(result.runState.budget.spentNanos).toBe(2_700_000);
    expect(result.ledger).toHaveLength(1);
    expect(result.runState.tasks[0]?.status).toBe('passed');
  }, 5000);
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
  it('records CLI limit provenance separately from live cfo.ai accounting', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: false, cfoai: true, slack: false');
    const worker = new FakeWorker();
    const cfoai = new FakeCfoaiBudget(usdToNanos(40), false, usdToNanos(10));
    let reads = 0;
    cfoai.budgetLimitNanos = async () => { reads += 1; return usdToNanos(40); };
    const result = await runRealTally({ configPath, budgetUsd: 1, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]), usage: worker, sessions: worker, publisher: worker, cfoai } });
    expect(result.runState.budget).toMatchObject({ source: 'cfoai', limitSource: 'cli', systemOfRecord: 'cfoai', limitNanos: usdToNanos(1), monthly: { source: 'cfoai', limitNanos: usdToNanos(40), spentBeforeRunNanos: usdToNanos(10) } });
    expect(reads).toBe(1);
    expect(worker.starts).toHaveLength(1);
    expect(cfoai.writes).toEqual([result.runState.budget.spentNanos]);
  });
  it('persists frozen impact before spawning and diffs against the recorded attempt base', async () => {
    const { dir, configPath } = fixture();
    const outputDir = join(dir, 'impact');
    const impact: TaskImpact = { source: 'entire-graph', query: 'calc', nodes: [{ id: 'calc.ts', kind: 'target', weight: 10 }], edges: [],
      totals: { filesTouched: 1, dependents: 0, testsPresent: true, nodes: 1, edges: 0 }, truncated: false };
    let commitReads = 0;
    let diffBase: string | null | undefined;
    class ImpactWorker extends FakeWorker {
      async start(input: WorkerStartInput) {
        const snapshot = JSON.parse(readFileSync(join(outputDir, 'run.json'), 'utf8'));
        expect(snapshot.tasks[0].impact).toEqual(impact);
        impact.nodes[0]!.id = 'mutated.ts';
        return super.start(input);
      }
      async changedFiles(input?: { baseCommit?: string | null }) {
        diffBase = input?.baseCommit;
        return ['calc.ts', 'tests/calc.test.ts'];
      }
    }
    const worker = new ImpactWorker();
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir, latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals: { async signalsFor() { return { ...impact.totals, source: 'entire-graph', impact }; } },
        worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]), usage: worker, sessions: worker, publisher: worker,
        worktrees: { async checkoutPathFor() { return '/worker'; }, async commitFor() { return ++commitReads === 1 ? 'run-base' : 'attempt-base'; } } } });
    expect(result.runState.baseCommit).toBe('run-base');
    expect(result.ledger[0]!.baseCommit).toBe('attempt-base');
    expect(diffBase).toBe('attempt-base');
    expect(result.runState.tasks[0]!.impact!.nodes[0]!.id).toBe('calc.ts');
    expect(result.runState.tasks[0]!.changedFiles).toEqual(['calc.ts', 'tests/calc.test.ts']);
    expect(validateRunState(result.runState).ok).toBe(true);
    const resumed = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir, latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals: { async signalsFor() { throw new Error('must not resize completed task'); } },
        worker, verifier: new SequenceVerifier([{ passed: true, reason: null }]), usage: worker, sessions: worker, publisher: worker } });
    expect(resumed.runState.tasks[0]!.impact).toEqual(result.runState.tasks[0]!.impact);
    expect(resumed.runState.tasks[0]!.changedFiles).toEqual(result.runState.tasks[0]!.changedFiles);
    expect(resumed.runState.baseCommit).toBe('run-base');
  });

  it('uses the experiment base pin for run, attempts and actual-file diffs', async () => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    const diffs: Array<string | null | undefined> = [];
    let baseReads = 0;
    worker.changedFiles = async (input?: { baseCommit?: string | null }) => { diffs.push(input?.baseCommit); return ['calc.ts']; };
    const result = await runRealTally({ configPath, requiredBaseCommit: 'experiment-pin', dryRun: false, baseline: false,
      outputDir: join(dir, 'pinned'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker,
        verifier: new SequenceVerifier([{ passed: false, reason: 'test failed' }, { passed: true, reason: null }]),
        handoff: { summaryFor: async () => ({ type: 'entire-handoff', summary: 'Continue calc.', branch: 'failed-branch' }) },
        worktrees: { checkoutPathFor: async () => dir, commitFor: async () => { baseReads += 1; return baseReads === 1 ? 'experiment-pin' : 'later-base'; } } } });
    expect(result.runState.baseCommit).toBe('experiment-pin');
    expect(result.ledger.map((row) => row.baseCommit)).toEqual(['experiment-pin', 'experiment-pin']);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.every((base) => base === 'experiment-pin')).toBe(true);
    expect(result.runState.tasks[0]!.changedFiles).toEqual(['calc.ts']);
    expect(baseReads).toBe(1);
  });

  it.each(['different-base', null])('rejects the experiment pin before spawning when the base resolves to %s', async (resolved) => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    await expect(runRealTally({ configPath, requiredBaseCommit: 'experiment-pin', dryRun: false, baseline: false,
      outputDir: join(dir, 'mismatch'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker,
        verifier: new SequenceVerifier([]), worktrees: { checkoutPathFor: async () => dir, commitFor: async () => resolved } } })).rejects.toThrow(/Required base commit experiment-pin does not match resolved main base/);
    expect(worker.starts).toEqual([]);
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
  it.each(['passed', 'verification-error', 'publish-error', 'needs-input'] as const)('closes the worker on %s and records usage after closure', async (scenario) => {
    const { dir, configPath } = fixture();
    const worker = new FakeWorker();
    const settled = { uncachedInput: 1200, cachedInput: 2000, output: 400, total: 3600 };
    worker.settledUsageFor = async () => ({ tokens: worker.stopped.length ? settled : tokens, estimatedCostNanos: 123 });
    if (scenario === 'publish-error') worker.publishPr = async () => { throw new Error('push refused'); };
    if (scenario === 'needs-input') worker.wait = async () => ({ status: 'needs_input', checkoutPath: '/tmp/worker', branch: 'task', prUrl: null, resultReason: 'worker asked for input' });
    const verifier: VerifierPort = { verify: async () => {
      if (scenario === 'verification-error') throw new Error('verifier unavailable');
      return { passed: true, reason: null };
    } };
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, verifier, publisher: worker, usage: worker, sessions: worker } });
    expect(worker.stopped).toEqual(worker.starts.map((_, i) => `session-${i + 1}`));
    expect(result.ledger.every((row) => row.tokens.total === settled.total)).toBe(true);
  });
  it.each([
    ['permission denied', 'permission-refused', false],
    ['command not found', 'tool-failure', false],
    ['model unavailable', 'model-unavailable', false],
    ['tests failed', 'tests-failed', true],
    ['budget exhausted', 'ceiling', true],
  ] as const)('persists trace diagnosis for %s and only escalates model-solvable failures', async (error, kind, escalates) => {
    const { dir, configPath } = fixture('neatlogs: true, entire: false, cfoai: false, slack: false');
    const worker = new FakeWorker();
    const trace = new FakeTrace();
    let diagnoses = 0;
    const traceId = 'a'.repeat(32);
    const result = await runRealTally({
      configPath, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: {
        intake, signals, worker, usage: worker, sessions: worker, publisher: worker, trace,
        verifier: new SequenceVerifier([{ passed: false, reason: 'tests failed' }, { passed: true, reason: null }]),
        history: {
          lookup: async (_size, tier) => tier === 'middle'
            ? { attempts: 5, passRate: 1, avgCostNanos: 20_000_000, source: 'neatlogs', successfulCostsNanos: [20_000_000, 20_000_000, 20_000_000, 20_000_000, 20_000_000] } : null,
          record: async () => {},
        },
        workerTraceReader: {
          verifyFor: async () => traceId,
          failureFor: async context => {
            diagnoses++;
            expect(context).toMatchObject({ runId: 'run-20261011-030000Z', taskId: 'T1', attempt: 1, traceId });
            return { traceId, spans: [{ id: 'failed-span', name: 'Bash', type: 'TOOL', status: 'ERROR', error }] };
          },
        },
      },
    });
    expect(diagnoses).toBe(1);
    expect(result.ledger[0]?.failureAssessment).toMatchObject({ kind, source: 'neatlogs', traceId, spans: ['failed-span'], retryable: escalates });
    expect(worker.starts).toHaveLength(escalates ? 2 : 1);
    expect(validateLedger(JSON.parse(readFileSync(result.ledgerPath, 'utf8'))).ok).toBe(true);
    const decision = trace.spans.find(span => span.name === 'tally.escalate');
    expect(JSON.parse(String(decision?.attributes.failureAssessment))).toMatchObject({ kind });
    if (escalates) {
      expect(result.ledger[1]?.ceilingNanos).toBe(30_000_000);
      expect(result.ledger[1]?.decision).toContain('neatlogs history: 5 observations');
    } else expect(result.runState.tasks[0]?.statusReason).toMatch(/needs intervention|model unavailable/);
  });

  it('uses an honest persisted ledger fallback when worker trace diagnosis cannot be read', async () => {
    const { dir, configPath } = fixture('neatlogs: true, entire: false, cfoai: false, slack: false');
    const worker = new FakeWorker();
    const result = await runRealTally({
      configPath, dryRun: false, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker, trace: new FakeTrace(), history: new PriceHistory(),
        verifier: new SequenceVerifier([{ passed: false, reason: 'tests failed' }, { passed: true, reason: null }]),
        failureTrace: { failureFor: async () => { throw new Error('read unavailable'); } } },
    });
    expect(result.ledger[0]?.failureAssessment).toMatchObject({ source: 'ledger', kind: 'tests-failed' });
    expect(result.ledger[1]?.decision).toContain('worker trace could not be read');
    expect(worker.starts).toHaveLength(2);
  });

  it('does not consult worker traces for simulated dry-run failures', async () => {
    const { dir, configPath } = fixture('neatlogs: true, entire: false, cfoai: false, slack: false');
    const config = loadConfig(configPath);
    const dry = createDryRunPorts();
    let reads = 0;
    const result = await runRealTally({
      configPath, dryRun: true, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { ...dry, signals, intake: { tasks: async () => [{ ...(await intake.tasks(config, configPath))[0]!, outcomes: ['failed', 'passed'] }] },
        trace: new FakeTrace(), failureTrace: { failureFor: async () => { reads++; return null; } } },
    });
    expect(reads).toBe(0);
    expect(result.ledger[0]?.failureAssessment?.source).toBe('ledger');
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
    expect(result.ledger.map((row) => row.price)).toEqual([
      { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 5 },
      { inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.2, outputUsdPerMTok: 10 },
    ]);
    expect(result.ledger.every((row) => row.priceNote?.includes('Unverified configured price'))).toBe(true);
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
    expect(prompt).toMatch(/^Tally run-\d{8}-\d{6}Z T1 a1:/);
    expect(prompt).toContain('Work only in the current working directory');
    expect(prompt).toContain('Never read or write any other checkout or path outside this worktree');
    expect(prompt).toContain('The environment has already been set up before you started');
    expect(prompt).toContain('Do not run setup (npm ci), install dependencies, or use the network');
    expect(prompt).toContain('do not push and do not open a pull request; Tally will publish the verified branch');
    expect(prompt).not.toContain('/tmp/');
  });

  it.each(['codex', 'claude-code'] as const)('gives direct %s script verification and host-commit instructions through escalation', async harness => {
    const { dir, configPath } = fixture();
    const config = loadConfig(configPath);
    config.runner = 'direct';
    config.tiers.forEach(tier => { tier.harness = harness; });
    writeFileSync(configPath, stringifyYaml(config));
    const worker = new FakeWorker();
    await runRealTally({ configPath, dryRun: false, baseline: false,
      outputDir: join(dir, 'prompt'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, usage: worker, sessions: worker, publisher: worker,
        verifier: new SequenceVerifier([{ passed: false, reason: 'test failed' }, { passed: true, reason: null }]),
        handoff: { summaryFor: async () => ({ type: 'entire-handoff', summary: 'Continue partial calc.ts.' }) },
      },
    });
    expect(worker.starts).toHaveLength(2);
    for (const { prompt } of worker.starts) {
      expect(prompt).toContain('Run the exact Tally verification script path supplied below');
      expect(prompt).toContain('never a raw pipeline');
      expect(prompt).not.toContain('Run this verification command');
      expect(prompt).not.toContain('Add a new commit');
      expect(prompt).toContain('Tally');
      if (harness === 'codex') {
        expect(prompt).toContain('Leave your finished changes uncommitted');
        expect(prompt).toContain('Do not run git add, git commit');
      } else expect(prompt).toContain('You do not need to commit; Tally commits your work');
    }
    expect(worker.starts[1]!.prompt).toContain('Leave your changes for Tally to commit');
  });

  it('fails a real task that leaves the worker branch with no commits ahead of base', async () => {
    const { dir, configPath } = fixture();
    writeFileSync(configPath, stringifyYaml({ ...loadConfig(configPath), runner: 'direct' }));
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
    expect(worker.starts).toHaveLength(2);
    expect(result.ledger.every((row) => row.result === 'failed' && row.resultReason === 'no changes made' && row.prUrl === null)).toBe(true);
  });

  it.each(['idle', 'error'] as const)('does not escalate permission failures with no commit or an errored worker (%s)', async status => {
    const { dir, configPath } = fixture();
    writeFileSync(configPath, stringifyYaml({ ...loadConfig(configPath), runner: 'direct' }));
    const worker = new FakeWorker();
    worker.commitsAheadCount = 0;
    worker.wait = async () => ({ status, branch: 'task', checkoutPath: '/tmp/worker', prUrl: null,
      resultReason: status === 'error' ? 'permission failure: permission denied for Bash: raw test pipeline' : null,
      permissionWarnings: ['permission denied for Bash: raw test pipeline'] });
    const verifier = new SequenceVerifier([{ passed: true, reason: null }]);
    try {
      const result = await runRealTally({ configPath, dryRun: false, baseline: false,
        outputDir: join(dir, 'permission-error'), latestRunDir: join(dir, 'latest'), now: fixedNow,
        ports: { intake, signals, worker, verifier, usage: worker, sessions: worker, publisher: worker } });
      expect(verifier.calls).toBe(0);
      expect(worker.published).toHaveLength(0);
      expect(worker.starts).toHaveLength(1);
      expect(result.ledger).toHaveLength(1);
      expect(result.ledger[0]).toMatchObject({ result: 'error', resultReason: expect.stringContaining('permission failure'),
        permissionWarnings: ['permission denied for Bash: raw test pipeline'] });
      expect(validateLedger(result.ledger).ok).toBe(true);
      const disk = JSON.parse(readFileSync(join(dir, 'permission-error', 'ledger.json'), 'utf8'));
      expect(disk[0].permissionWarnings).toEqual(result.ledger[0]?.permissionWarnings);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([false, true])('verifies an experiment without publishing, even with worker publishing=%s', async workerPublishesPr => {
    const { dir, configPath } = fixture();
    const config = loadConfig(configPath);
    config.repo.workerPublishesPr = workerPublishesPr;
    writeFileSync(configPath, stringifyYaml(config));
    const worker = new FakeWorker();
    const verifier = new SequenceVerifier([{ passed: true, reason: null }]);
    const result = await runRealTally({ configPath, dryRun: false, baseline: false, publish: false,
      outputDir: join(dir, 'experiment'), latestRunDir: join(dir, 'latest'), now: fixedNow,
      ports: { intake, signals, worker, verifier, usage: worker, sessions: worker, publisher: worker } });
    expect(verifier.calls).toBe(1);
    expect(worker.commitChecks).toHaveLength(1);
    expect(worker.published).toEqual([]);
    expect(worker.starts[0]?.prompt).toContain('do not push or open a PR');
    expect(result.ledger[0]).toMatchObject({ result: 'passed', prUrl: null, resultReason: 'verified locally; publishing disabled for experiment' });
    expect(worker.stopped).toEqual(['session-1']);
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

    expect(worker.usageCalls).toBe(2);
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

  it('persists unavailable recall separately from successful Graph sizing and states it in decisions', async () => {
    const { dir, configPath } = fixture('neatlogs: false, entire: true, cfoai: false, slack: false');
    const worker = new FakeWorker();
    const result = await runRealTally({
      configPath, dryRun: true, baseline: false, outputDir: join(dir, 'recall-unavailable'),
      now: fixedNow, latestRunDir: join(dir, 'latest'),
      ports: { intake, signals: scriptedEntireSignals, worker, usage: worker, sessions: worker, publisher: worker,
        verifier: new SequenceVerifier([{ passed: true, reason: null }]),
        recall: { recallFor: async () => null, status: () => ({ status: 'missing', detail: 'checkpoint recall unavailable: repository not mirrored to Entire' }) },
      },
    });
    expect(result.runState.integrations.entire).toMatchObject({ status: 'missing', detail: expect.stringContaining('Graph sizing: ok') });
    expect(result.runState.integrations.entire.detail).toContain('not mirrored');
    expect(result.ledger[0]?.decision).toContain('checkpoint recall unavailable');
    const onDisk = JSON.parse(readFileSync(join(dir, 'recall-unavailable', 'run.json'), 'utf8'));
    expect(onDisk.integrations.entire.detail).toContain('not mirrored');
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
    expect(result.runState.integrations.cfoai).toMatchObject({ status: 'error' });
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

    expect(result.runState.integrations.entire).toMatchObject({ status: 'ok', detail: expect.stringContaining('not used: sample tasks carry scripted sizing') });
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
        history: { lookup: async () => null, record: async () => {} },
      },
    });

    expect(result.runState.integrations.neatlogs).toEqual({ status: 'ok', detail: 'https://app.neatlogs.com/traces/test-trace' });
  });

  it('includes price-history fallback failures in the saved Neatlogs integration status', async () => {
    const { dir, configPath } = fixture('neatlogs: true, entire: false, cfoai: false, slack: false');
    const worker = new FakeWorker();

    const result = await runRealTally({
      configPath,
      dryRun: true,
      baseline: false,
      outputDir: join(dir, 'neatlogs-history-error'),
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
        history: {
          lookup: async () => null,
          record: async () => {},
          status: () => ({ status: 'error' as const, detail: 'Neatlogs price-history read failed; using local history. HTTP 400' }),
        },
      },
    });

    expect(result.runState.integrations.neatlogs).toEqual({
      status: 'error',
      detail: 'https://app.neatlogs.com/traces/test-trace; Neatlogs price-history read failed; using local history. HTTP 400',
    });
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
        workerTraceReader: { verifyFor: async () => 'd'.repeat(32) },
        history: { lookup: async () => null, record: async () => {} },
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
