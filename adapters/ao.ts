import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LiveUsage, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import type { TokenUsage } from '../schema/index.js';
import type { WorkerPort, WorkerResult, WorkerStartInput } from '../engine/real.js';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[], options?: { cwd?: string }) => Promise<CommandResult>;

export interface AoAdapterOptions {
  project?: string;
  cwd?: string;
  command?: CommandRunner;
  fetch?: typeof fetch;
  usageBaseUrl?: string;
  pollMs?: number;
  idleStablePolls?: number;
  needsInputGracePolls?: number;
  usageSettlePolls?: number;
  usageSettleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface AoSessionJson {
  session?: {
    id?: string;
    status?: string;
    updatedAt?: string;
    isTerminated?: boolean;
    branch?: string | null;
    worktreePath?: string | null;
    checkoutPath?: string | null;
    path?: string | null;
    prs?: { url?: string | null }[];
    activity?: { state?: string; reason?: string | null; message?: string | null; detail?: string | null; lastActivityAt?: string | null };
    reason?: string | null;
    message?: string | null;
    detail?: string | null;
  };
}

function defaultCommand(file: string, args: string[], options?: { cwd?: string }): Promise<CommandResult> {
  return execFileAsync(file, args, { cwd: options?.cwd });
}

function parseSpawn(stdout: string): string {
  const match = /spawned session\s+(\S+)/.exec(stdout);
  if (!match) throw new Error(`could not parse AO session id from: ${stdout.trim()}`);
  return match[1]!;
}

function tokenNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function tokensFromTotals(totals: Record<string, unknown>): TokenUsage {
  const cachedInput = tokenNumber(totals.cachedInputTokens ?? totals.cacheReadTokens);
  const input = tokenNumber(totals.inputTokens);
  const output = tokenNumber(totals.outputTokens);
  const uncachedInput = tokenNumber(totals.uncachedInputTokens ?? input - cachedInput);
  return { uncachedInput, cachedInput, output, total: uncachedInput + cachedInput + output };
}

function isNeedsInput(value: string | undefined): boolean {
  return value === 'needs_input' || value === 'waiting_input';
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function needsInputReason(session: AoSessionJson['session']): string {
  const status = textValue(session?.status) ?? 'unknown';
  const activity = textValue(session?.activity?.state);
  const detail =
    textValue(session?.reason) ??
    textValue(session?.message) ??
    textValue(session?.detail) ??
    textValue(session?.activity?.reason) ??
    textValue(session?.activity?.message) ??
    textValue(session?.activity?.detail);
  const state = activity && activity !== status ? `${status}/${activity}` : status;
  return detail ? `worker asked for input: ${detail}` : `worker asked for input: AO session entered ${state}`;
}

function progressFingerprint(session: AoSessionJson['session'], usage: LiveUsage | null): string {
  return JSON.stringify({
    updatedAt: session?.updatedAt ?? null,
    lastActivityAt: session?.activity?.lastActivityAt ?? null,
    tokens: usage?.tokens.total ?? null,
  });
}

export function usageFromAoPayload(payload: unknown): LiveUsage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const totals = (payload as { totals?: unknown }).totals;
  if (typeof totals !== 'object' || totals === null) return null;
  const tokens = tokensFromTotals(totals as Record<string, unknown>);
  if (tokens.total === 0) return null;
  const estimated = (totals as { estimatedCost?: unknown }).estimatedCost;
  const estimatedCostNanos =
    typeof estimated === 'object' && estimated !== null ? tokenNumber((estimated as { totalNanos?: unknown }).totalNanos) : 0;
  return { tokens, estimatedCostNanos };
}

export class AoCliAdapter implements WorkerPort, LiveUsagePort, SessionControlPort {
  private readonly command: CommandRunner;
  private readonly fetchImpl: typeof fetch;
  private readonly usageBaseUrl: string;
  private readonly pollMs: number;
  private readonly idleStablePolls: number;
  private readonly needsInputGracePolls: number;
  private readonly usageSettlePolls: number;
  private readonly usageSettleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AoAdapterOptions = {}) {
    this.command = options.command ?? defaultCommand;
    this.fetchImpl = options.fetch ?? fetch;
    this.usageBaseUrl = options.usageBaseUrl ?? 'http://127.0.0.1:3001/api/v1';
    this.pollMs = options.pollMs ?? 5000;
    this.idleStablePolls = options.idleStablePolls ?? 3;
    this.needsInputGracePolls = options.needsInputGracePolls ?? Math.max(2, Math.ceil(30_000 / Math.max(1, this.pollMs)));
    this.usageSettlePolls = options.usageSettlePolls ?? 5;
    this.usageSettleMs = options.usageSettleMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async start(input: WorkerStartInput): Promise<{ sessionId: string; branch: string | null; checkoutPath: string | null }> {
    const args = ['spawn'];
    const project = input.aoProject ?? this.options.project;
    if (project) args.push('--project', project);
    if (input.sessionMode) args.push('--mode', input.sessionMode);
    args.push('--harness', input.harness, '--model', input.model, '--name', input.name, '--prompt', input.prompt);
    const { stdout } = await this.command('ao', args, { cwd: this.options.cwd });
    return { sessionId: parseSpawn(stdout), branch: null, checkoutPath: null };
  }

  async wait(sessionId: string, options: { timeoutMs?: number } = {}): Promise<WorkerResult> {
    let idlePolls = 0;
    let needsInputPolls = 0;
    let needsInputState: AoSessionJson['session'] | undefined;
    let needsInputFingerprint: string | null = null;
    const timeoutMs = options.timeoutMs;
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
    for (;;) {
      const session = await this.session(sessionId);
      const state = session.session;
      const status = state?.status ?? state?.activity?.state ?? 'unknown';
      if (deadline !== null && Date.now() >= deadline) {
        const reason = `worker exceeded wall-clock limit of ${Math.round(timeoutMs! / 1000)}s`;
        try {
          await this.stop(sessionId, reason);
        } catch {
          // The ledger still records the timeout state; a later cleanup can see the session id.
        }
        return this.resultFrom(state, 'timeout', reason);
      }
      if (state?.isTerminated || status === 'terminated') {
        return this.resultFrom(state, 'terminated');
      }
      if (isNeedsInput(state?.status) || isNeedsInput(state?.activity?.state)) {
        idlePolls = 0;
        const usage = await this.usageFor(sessionId).catch(() => null);
        const fingerprint = progressFingerprint(state, usage);
        needsInputPolls = fingerprint === needsInputFingerprint ? needsInputPolls + 1 : 1;
        needsInputFingerprint = fingerprint;
        needsInputState = state ?? needsInputState;
        if (needsInputPolls >= this.needsInputGracePolls) {
          const reason = needsInputReason(needsInputState);
          try {
            await this.stop(sessionId, reason);
          } catch {
            // The ledger still records the needs-input state; a later cleanup can see the session id.
          }
          return this.resultFrom(needsInputState, 'needs_input', reason);
        }
        await this.sleep(this.pollMs);
        continue;
      }
      if (status === 'idle' || state?.activity?.state === 'idle') {
        needsInputPolls = 0;
        needsInputState = undefined;
        needsInputFingerprint = null;
        idlePolls += 1;
        if (idlePolls >= this.idleStablePolls) return this.resultFrom(state, 'idle');
        await this.sleep(this.pollMs);
        continue;
      }
      idlePolls = 0;
      needsInputPolls = 0;
      needsInputState = undefined;
      needsInputFingerprint = null;
      await this.sleep(this.pollMs);
    }
  }

  async usageFor(sessionId: string): Promise<LiveUsage | null> {
    const response = await this.fetchImpl(`${this.usageBaseUrl}/usage/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) return null;
    return usageFromAoPayload(await response.json());
  }

  async settledUsageFor(sessionId: string): Promise<LiveUsage | null> {
    let latest: LiveUsage | null = null;
    let stablePolls = 0;
    for (let i = 0; i < this.usageSettlePolls; i += 1) {
      const usage = await this.usageFor(sessionId);
      if (usage && latest && JSON.stringify(usage) === JSON.stringify(latest)) {
        stablePolls += 1;
        if (stablePolls >= 1) return usage;
      } else {
        stablePolls = 0;
      }
      if (usage) latest = usage;
      if (i < this.usageSettlePolls - 1) await this.sleep(this.usageSettleMs);
    }
    return latest;
  }

  async stop(sessionId: string, _reason: string): Promise<void> {
    await this.command('ao', ['session', 'kill', sessionId], { cwd: this.options.cwd });
  }

  private async session(sessionId: string): Promise<AoSessionJson> {
    const { stdout } = await this.command('ao', ['session', 'get', sessionId, '--json'], { cwd: this.options.cwd });
    return JSON.parse(stdout) as AoSessionJson;
  }

  private resultFrom(session: AoSessionJson['session'], status: WorkerResult['status'], resultReason: string | null = null): WorkerResult {
    const prUrl = session?.prs?.find((pr) => typeof pr.url === 'string')?.url ?? null;
    return {
      status,
      branch: session?.branch ?? null,
      checkoutPath: session?.checkoutPath ?? session?.worktreePath ?? session?.path ?? null,
      prUrl,
      resultReason,
    };
  }
}
