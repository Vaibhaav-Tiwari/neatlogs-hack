import { resolveAoBinary, runCommand } from './command.js';
import { aoProjectCommand } from './ao-project.js';
import { AO_HARNESS_PERMISSIONS } from '../engine/harness.js';
import { commitWorkerEdits } from './direct.js';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { LiveUsage, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import type { TokenUsage } from '../schema/index.js';
import type { WorkerPort, WorkerResult, WorkerStartInput } from '../engine/real.js';

const spawnLocks = new Map<string, Promise<void>>();

async function withProjectSpawnLock<T>(project: string, action: () => Promise<T>): Promise<T> {
  const previous = spawnLocks.get(project) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  spawnLocks.set(project, current);
  await previous;
  try { return await action(); }
  finally { release(); if (spawnLocks.get(project) === current) spawnLocks.delete(project); }
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

export interface AoAdapterOptions {
  aoBin?: string;
  requiredBaseCommit?: string;
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
  now?: () => number;
  startupTimeoutMs?: number;
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

function terminalDetail(session: AoSessionJson['session']): string | null {
  const details = [session?.reason, session?.message, session?.detail,
    session?.activity?.reason, session?.activity?.message, session?.activity?.detail]
    .map(textValue)
    .filter((detail): detail is string => detail !== null);
  return [...new Set(details)].join('; ').slice(0, 2000) || null;
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
  private readonly stoppedSessions = new Set<string>();
  private readonly command: CommandRunner;
  private readonly fetchImpl: typeof fetch;
  private readonly usageBaseUrl: string;
  private readonly pollMs: number;
  private readonly idleStablePolls: number;
  private readonly needsInputGracePolls: number;
  private readonly usageSettlePolls: number;
  private readonly usageSettleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly exitedAgents = new Set<string>();

  constructor(private readonly options: AoAdapterOptions = {}) {
    this.command = options.command ?? ((file, args, commandOptions) => {
      if (file === 'ao' && args[0] === 'project' && ['get', 'set-config'].includes(args[1]!)) {
        resolveAoBinary({ aoBin: options.aoBin });
        return aoProjectCommand(args);
      }
      return runCommand(file, args, { ...commandOptions, aoBin: options.aoBin });
    });
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
    if (input.continueBranch) return this.continueAttempt(input);
    const args = ['spawn'];
    const project = input.aoProject ?? this.options.project;
    if (project) args.push('--project', project);
    if (input.sessionMode) args.push('--mode', input.sessionMode);
    args.push('--harness', input.harness, '--model', input.model, '--name', input.name);
    // Attach the prompt to the initial spawn even for experiments. Sending it
    // after spawn races the worker's startup and can leave the first attempt
    // with no work; the base preflight below still gates accepting the worker.
    args.push('--prompt', input.prompt);
    const { stdout } = await this.spawnWithPermissions(input, args);
    const sessionId = parseSpawn(stdout);
    if (!this.options.requiredBaseCommit) return { sessionId, branch: null, checkoutPath: null };
    try {
      const session = (await this.session(sessionId)).session;
      let checkoutPath = session?.worktreePath ?? session?.checkoutPath ?? session?.path ?? null;
      const branch = session?.branch ?? null;
      if (!checkoutPath && branch) {
        const list = await this.command('git', ['worktree', 'list', '--porcelain'], { cwd: this.options.cwd });
        for (const block of list.stdout.split(/\n\n/)) {
          if (block.split('\n').includes(`branch refs/heads/${branch}`)) checkoutPath = block.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? null;
        }
      }
      if (!checkoutPath) throw new Error('experiment could not locate worker checkout before sending task');
      const head = (await this.command('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath })).stdout.trim();
      if (head !== this.options.requiredBaseCommit) throw new Error(`experiment worker base mismatch: expected ${this.options.requiredBaseCommit}, got ${head}`);
      return { sessionId, branch, checkoutPath };
    } catch (error) {
      await this.stop(sessionId, 'experiment base preflight failed');
      throw error;
    }
  }

  private async spawnWithPermissions(input: WorkerStartInput, args: string[]): Promise<CommandResult> {
    const project = input.aoProject ?? this.options.project;
    if (!project) throw new Error('AO worker permission selection requires an explicit project; no worker was started.');
    const mode = AO_HARNESS_PERMISSIONS[input.harness as keyof typeof AO_HARNESS_PERMISSIONS];
    if (!mode) throw new Error(`Unsupported AO harness ${input.harness}; no worker was started.`);
    return withProjectSpawnLock(project, async () => {
      const read = await this.command('ao', ['project', 'get', project, '--json'], { cwd: this.options.cwd });
      const payload = JSON.parse(read.stdout) as { project?: { config?: Record<string, unknown> } };
      if (!payload.project || typeof payload.project !== 'object' || Array.isArray(payload.project)
        || payload.project.config !== undefined && (!payload.project.config || typeof payload.project.config !== 'object' || Array.isArray(payload.project.config))) throw new Error('Invalid AO project config; refusing to change permissions or spawn.');
      const config = payload.project.config ?? {};
      const worker = config.worker as Record<string, unknown> | undefined;
      const agent = worker?.agentConfig as Record<string, unknown> | undefined;
      if (worker !== undefined && (!worker || typeof worker !== 'object' || Array.isArray(worker)) || agent !== undefined && (!agent || typeof agent !== 'object' || Array.isArray(agent))) throw new Error('Invalid AO worker config; refusing to change permissions or spawn.');
      const next = { ...config, worker: { ...worker, agentConfig: { ...agent, permissions: mode } } };
      await this.command('ao', ['project', 'set-config', project, '--config-json', JSON.stringify(next), '--json'], { cwd: this.options.cwd });
      const verified = JSON.parse((await this.command('ao', ['project', 'get', project, '--json'], { cwd: this.options.cwd })).stdout);
      if (verified.project?.config?.worker?.agentConfig?.permissions !== mode) throw new Error(`AO worker permission mode was not applied: expected ${mode}; no worker was started.`);
      return this.command('ao', args, { cwd: this.options.cwd });
    });
  }

  private async checkoutFor(branch: string): Promise<string | null> {
    const { stdout } = await this.command('git', ['worktree', 'list', '--porcelain'], { cwd: this.options.cwd });
    const block = stdout.split(/\n\n/).find((item) => item.split('\n').includes(`branch refs/heads/${branch}`));
    return block?.split('\n').find((line) => line.startsWith('worktree '))?.slice(9) ?? null;
  }

  private async continueAttempt(input: WorkerStartInput): Promise<{ sessionId: string; branch: string; checkoutPath: string }> {
    const branch = input.continueBranch!;
    if (!input.continueSessionId) throw new Error('continuation requires the stopped worker session id');
    const previous = (await this.session(input.continueSessionId)).session;
    if (!previous?.isTerminated || previous.branch !== branch) throw new Error('continuation requires a terminated worker on the same branch');
    const oldCheckout = await this.checkoutFor(branch);
    const scratch = await mkdtemp(join(tmpdir(), 'tally-handoff-'));
    let patch = '';
    let untracked: string[] = [];
    let sessionId: string | null = null;
    try {
      if (oldCheckout) {
        patch = (await this.command('git', ['diff', '--binary', 'HEAD'], { cwd: oldCheckout })).stdout;
        untracked = (await this.command('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: oldCheckout })).stdout.split('\0').filter(Boolean);
        // The old agent is dead. Retain its dirty recovery copy while freeing the branch.
        await this.command('git', ['switch', '--detach'], { cwd: oldCheckout });
      }
      const args = ['spawn'];
      const project = input.aoProject ?? this.options.project;
      if (project) args.push('--project', project);
      if (input.sessionMode) args.push('--mode', input.sessionMode);
      args.push('--branch', branch, '--harness', input.harness, '--model', input.model, '--name', input.name);
      if (!patch && !untracked.length) args.push('--prompt', input.prompt);
      sessionId = parseSpawn((await this.spawnWithPermissions(input, args)).stdout);
      const current = (await this.session(sessionId)).session;
      if (current?.branch !== branch) throw new Error(`continuation branch mismatch: expected ${branch}, got ${current?.branch}`);
      const checkoutPath = current.worktreePath ?? current.checkoutPath ?? await this.checkoutFor(branch);
      if (!checkoutPath) throw new Error('could not locate continuation worker checkout');
      if (patch) {
        const patchPath = join(scratch, 'changes.patch');
        await writeFile(patchPath, patch);
        await this.command('git', ['apply', '--binary', patchPath], { cwd: checkoutPath });
      }
      for (const file of untracked) {
        const source = resolve(oldCheckout!, file);
        const target = resolve(checkoutPath, file);
        if (!source.startsWith(resolve(oldCheckout!) + sep) || !target.startsWith(resolve(checkoutPath) + sep)) throw new Error('unsafe handoff file path');
        await mkdir(dirname(target), { recursive: true });
        const parent = await realpath(dirname(target));
        const root = await realpath(checkoutPath);
        if (parent !== root && !parent.startsWith(root + sep)) throw new Error('handoff file escapes worker checkout');
        await cp(source, target, { dereference: false, force: false, errorOnExist: true });
      }
      if (patch || untracked.length) await this.command('ao', ['send', '--session', sessionId, '--message', input.prompt], { cwd: this.options.cwd });
      return { sessionId, branch, checkoutPath };
    } catch (error) {
      if (sessionId) await this.stop(sessionId, 'continuation preparation failed');
      throw error;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async wait(sessionId: string, options: { timeoutMs?: number } = {}): Promise<WorkerResult> {
    let idlePolls = 0;
    let needsInputPolls = 0;
    let needsInputState: AoSessionJson['session'] | undefined;
    let needsInputFingerprint: string | null = null;
    const timeoutMs = options.timeoutMs;
    const now = this.options.now ?? Date.now;
    const began = now();
    const deadline = timeoutMs === undefined ? null : began + timeoutMs;
    const startupDeadline = began + (this.options.startupTimeoutMs ?? 60_000);
    let usedTokens = false;
    for (;;) {
      const session = await this.session(sessionId);
      const state = session.session;
      const status = state?.status ?? state?.activity?.state ?? 'unknown';
      const usage = await this.usageFor(sessionId).catch(() => null);
      usedTokens ||= (usage?.tokens.total ?? 0) > 0;
      if (!usedTokens && (state?.isTerminated || status === 'terminated' || (status === 'idle' && now() >= startupDeadline))) {
        await this.stop(sessionId, 'worker never started');
        const detail = terminalDetail(state);
        return this.resultFrom(state, 'never_started', detail ? `worker never started: ${detail}` : 'worker never started');
      }
      if (deadline !== null && now() >= deadline) {
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
        const fingerprint = progressFingerprint(state, usage);
        needsInputPolls = fingerprint === needsInputFingerprint ? needsInputPolls + 1 : 1;
        needsInputFingerprint = fingerprint;
        needsInputState = state ?? needsInputState;
        if (needsInputPolls >= this.needsInputGracePolls) {
          const reason = needsInputReason(needsInputState);
          try {
            await this.exitAgent(sessionId);
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
        idlePolls = usedTokens ? idlePolls + 1 : 0;
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
    if (this.stoppedSessions.has(sessionId)) return;
    await this.command('ao', ['session', 'kill', sessionId], { cwd: this.options.cwd });
    this.stoppedSessions.add(sessionId);
  }

  private async exitAgent(sessionId: string): Promise<void> {
    if (this.exitedAgents.has(sessionId)) return;
    await this.command('ao', ['session', 'exit-agent', sessionId], { cwd: this.options.cwd });
    this.exitedAgents.add(sessionId);
  }

  async commitChanges(sessionId: string): Promise<string | null> {
    // Stop the agent without deleting its clean worktree before verification.
    await this.exitAgent(sessionId);
    const session = (await this.session(sessionId)).session;
    const branch = session?.branch;
    if (!branch) throw new Error('could not locate worker branch before committing');
    let checkoutPath = session?.checkoutPath ?? session?.worktreePath ?? session?.path;
    if (!checkoutPath) {
      const list = await this.command('git', ['worktree', 'list', '--porcelain'], { cwd: this.options.cwd });
      for (const block of list.stdout.split(/\n\n/)) {
        if (block.split('\n').includes(`branch refs/heads/${branch}`)) checkoutPath = block.split('\n').find(line => line.startsWith('worktree '))?.slice('worktree '.length);
      }
    }
    if (!checkoutPath) throw new Error('could not locate worker checkout before committing');
    return commitWorkerEdits((file, args, options) => this.command(file, args,
      { ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }),
      { checkoutPath, branch }, { repoPath: this.options.cwd ?? checkoutPath });
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
