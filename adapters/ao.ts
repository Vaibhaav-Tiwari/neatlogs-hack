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
  sleep?: (ms: number) => Promise<void>;
}

interface AoSessionJson {
  session?: {
    id?: string;
    status?: string;
    isTerminated?: boolean;
    branch?: string | null;
    worktreePath?: string | null;
    checkoutPath?: string | null;
    path?: string | null;
    prs?: { url?: string | null }[];
    activity?: { state?: string };
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
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AoAdapterOptions = {}) {
    this.command = options.command ?? defaultCommand;
    this.fetchImpl = options.fetch ?? fetch;
    this.usageBaseUrl = options.usageBaseUrl ?? 'http://127.0.0.1:3001/api/v1';
    this.pollMs = options.pollMs ?? 5000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async start(input: WorkerStartInput): Promise<{ sessionId: string; branch: string | null; checkoutPath: string | null }> {
    const args = ['spawn'];
    const project = input.aoProject ?? this.options.project;
    if (project) args.push('--project', project);
    args.push('--harness', input.harness, '--model', input.model, '--name', input.name, '--prompt', input.prompt);
    const { stdout } = await this.command('ao', args, { cwd: this.options.cwd });
    return { sessionId: parseSpawn(stdout), branch: null, checkoutPath: null };
  }

  async wait(sessionId: string): Promise<WorkerResult> {
    for (;;) {
      const session = await this.session(sessionId);
      const state = session.session;
      const status = state?.status ?? state?.activity?.state ?? 'unknown';
      if (state?.isTerminated || status === 'terminated') {
        return this.resultFrom(state, 'terminated');
      }
      if (status === 'idle' || state?.activity?.state === 'idle') {
        return this.resultFrom(state, 'idle');
      }
      await this.sleep(this.pollMs);
    }
  }

  async usageFor(sessionId: string): Promise<LiveUsage | null> {
    const response = await this.fetchImpl(`${this.usageBaseUrl}/usage/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) return null;
    return usageFromAoPayload(await response.json());
  }

  async stop(sessionId: string, _reason: string): Promise<void> {
    await this.command('ao', ['session', 'kill', sessionId], { cwd: this.options.cwd });
  }

  private async session(sessionId: string): Promise<AoSessionJson> {
    const { stdout } = await this.command('ao', ['session', 'get', sessionId, '--json'], { cwd: this.options.cwd });
    return JSON.parse(stdout) as AoSessionJson;
  }

  private resultFrom(session: AoSessionJson['session'], status: WorkerResult['status']): WorkerResult {
    const prUrl = session?.prs?.find((pr) => typeof pr.url === 'string')?.url ?? null;
    return {
      status,
      branch: session?.branch ?? null,
      checkoutPath: session?.checkoutPath ?? session?.worktreePath ?? session?.path ?? null,
      prUrl,
    };
  }
}
