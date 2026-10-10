import { basename } from 'node:path';
import { costNanos } from '../schema/money.js';
import type { TallyConfig, TaskSize, Tier, TokenUsage } from '../schema/types.js';
import { PriceHistory } from '../agent/history.js';
import type { HandoffSummary, LiveUsage, LiveUsagePort, SessionControlPort, SizingSignals, SizingSignalsPort } from '../agent/ports.js';
import type { VerifierPort, VerifyInput, VerifyResult } from '../adapters/verifier.js';
import { type BacklogTask, loadFileBacklog, type ScriptedAttempt } from './backlog.js';
import type { RealRunPorts, WorkerPort, WorkerResult, WorkerStartInput } from './real.js';

interface DrySession {
  sessionId: string;
  task: BacklogTask;
  attempt: number;
  tier: Tier;
  ceilingNanos: number | null;
  script: ScriptedAttempt;
  branch: string;
  checkoutPath: string;
  stopped: boolean;
  resolve?: (result: WorkerResult) => void;
}

class DryRunState implements WorkerPort, LiveUsagePort, SessionControlPort, VerifierPort {
  private readonly sessions = new Map<string, DrySession>();

  async start(input: WorkerStartInput): Promise<{ sessionId: string; branch: string | null; checkoutPath: string | null }> {
    const scripts: ScriptedAttempt[] =
      input.task.scriptedAttempts ?? input.task.outcomes.map((result) => ({ result, resultReason: null, tokens: zeroTokens(), handoff: null, decision: null }));
    const script = scripts.find((candidate) => candidate.tier === input.tier.name) ?? scripts[input.attempt - 1] ?? scripts[scripts.length - 1];
    if (!script) throw new Error(`dry-run task ${input.task.taskId} has no scripted attempt ${input.attempt}`);
    const sessionId = `dry-${input.task.taskId}-${input.attempt}`;
    const branch = `dry/${input.task.taskId}/${input.attempt}`;
    const checkoutPath = `dry-run:${sessionId}`;
    this.sessions.set(sessionId, {
      sessionId,
      task: input.task,
      attempt: input.attempt,
      tier: input.tier,
      ceilingNanos: input.ceilingNanos,
      script,
      branch,
      checkoutPath,
      stopped: false,
    });
    return { sessionId, branch, checkoutPath };
  }

  async wait(sessionId: string): Promise<WorkerResult> {
    const session = this.session(sessionId);
    if (session.script.result !== 'stopped' || session.ceilingNanos === null) return resultFor(session, 'idle');
    if (session.stopped) return resultFor(session, 'terminated');
    return new Promise((resolve) => {
      session.resolve = resolve;
    });
  }

  async usageFor(sessionId: string): Promise<LiveUsage | null> {
    const session = this.session(sessionId);
    const tokens = meteredTokens(session.script.tokens, session.tier, session.ceilingNanos, session.script.result);
    return { tokens, estimatedCostNanos: costNanos(tokens, session.tier.price) };
  }

  async stop(sessionId: string, _reason: string): Promise<void> {
    const session = this.session(sessionId);
    session.stopped = true;
    setTimeout(() => session.resolve?.(resultFor(session, 'terminated')), 0);
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const session = [...this.sessions.values()].find((candidate) => candidate.checkoutPath === input.checkoutPath || candidate.branch === input.branch);
    if (!session) return { passed: false, reason: 'dry-run session was not found' };
    if (session.script.result === 'passed') return { passed: true, reason: null };
    return { passed: false, reason: session.script.resultReason ?? `scripted ${session.script.result}` };
  }

  async summaryFor(sessionId: string): Promise<HandoffSummary | null> {
    const session = this.session(sessionId);
    const next = session.task.scriptedAttempts?.[session.attempt];
    const type = next?.handoff ?? 'entire-handoff';
    if (type === 'restart') return null;
    return {
      type,
      summary: `Dry-run handoff from ${session.task.taskId} attempt ${session.attempt}: ${session.script.resultReason ?? session.script.result}.`,
    };
  }

  async changedFilesFor(sessionId: string): Promise<string[] | null> {
    const files = this.session(sessionId).script.changedFiles;
    return files ? [...files] : null;
  }

  private session(sessionId: string): DrySession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown dry-run session ${sessionId}`);
    return session;
  }
}

function resultFor(session: DrySession, status: WorkerResult['status']): WorkerResult {
  return { status, branch: session.branch, checkoutPath: session.checkoutPath, prUrl: null };
}

function signalsForSize(size: TaskSize): SizingSignals {
  if (size === 'small') return { filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' };
  if (size === 'medium') return { filesTouched: 4, dependents: 4, testsPresent: true, source: 'code-search' };
  return { filesTouched: 9, dependents: 12, testsPresent: false, source: 'code-search' };
}

class ScriptedSizingSignals implements SizingSignalsPort {
  private readonly tasksById: Map<string, BacklogTask>;

  constructor(config: TallyConfig, configPath: string) {
    this.tasksById = new Map(loadFileBacklog(config, configPath).map((task) => [task.taskId, task]));
  }

  async signalsFor(task: { taskId: string; title: string; body: string }): Promise<SizingSignals | null> {
    const sample = this.tasksById.get(task.taskId);
    const size = sample?.size;
    if (!size) return null;
    const signals = signalsForSize(size);
    if (sample?.impact) return { ...sample.impact.totals, source: 'scripted', impact: { ...sample.impact, source: 'scripted' } };
    return { ...signals, source: 'scripted', impact: {
      source: 'scripted', query: `${task.title}\n${task.body}`.trim(), nodes: [], edges: [],
      totals: { filesTouched: signals.filesTouched, dependents: signals.dependents, testsPresent: signals.testsPresent, nodes: 0, edges: 0 }, truncated: false,
    } };
  }

  status() {
    return { status: 'ok' as const, detail: 'not used: sample tasks carry scripted sizing' };
  }
}

function usesSampleBacklog(config: TallyConfig): boolean {
  return config.backlog.source === 'file' && config.backlog.file !== undefined && basename(config.backlog.file) === 'sample-backlog.yaml';
}

function meteredTokens(tokens: TokenUsage, tier: Tier, ceilingNanos: number | null, result: string): TokenUsage {
  if (result !== 'stopped' || ceilingNanos === null || costNanos(tokens, tier.price) >= ceilingNanos) return tokens;
  const outputPriceNanos = tier.price.outputUsdPerMTok * 1000;
  if (outputPriceNanos <= 0) return tokens;
  const neededOutput = Math.ceil((ceilingNanos - costNanos(tokens, tier.price)) / outputPriceNanos);
  return {
    ...tokens,
    output: tokens.output + neededOutput,
    total: tokens.total + neededOutput,
  };
}

function zeroTokens(): TokenUsage {
  return { uncachedInput: 0, cachedInput: 0, output: 0, total: 0 };
}

export function createDryRunPorts(options: { config?: TallyConfig; configPath?: string } = {}): Partial<RealRunPorts> {
  const dryRun = new DryRunState();
  const scriptedSignals =
    options.config && options.configPath && (!options.config.integrations.entire || usesSampleBacklog(options.config))
      ? new ScriptedSizingSignals(options.config, options.configPath)
      : undefined;
  return {
    ...(scriptedSignals ? { signals: scriptedSignals } : {}),
    worker: dryRun,
    verifier: dryRun,
    usage: dryRun,
    sessions: dryRun,
    history: new PriceHistory(),
    handoff: dryRun,
  };
}
