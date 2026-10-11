import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { LiveUsage, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import type { WorkerPort, WorkerResult, WorkerStartInput } from '../engine/real.js';
import type { TallyConfig, TokenUsage } from '../schema/index.js';
import { runCommand } from './command.js';
import type { CommandRunner } from './ao.js';
import { checkHarness, claudeScripts } from '../engine/harness.js';
import { DirectRunner, commitWorkerEdits, type DirectRunnerOptions } from './direct.js';

type Json = Record<string, unknown>;
function record(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function count(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0; }

/** Codex reports input including cache reads, and output including reasoning. */
export function codexTokens(value: unknown): TokenUsage {
  const usage = record(value);
  const cachedInput = Math.min(count(usage.cached_input_tokens), count(usage.input_tokens));
  const uncachedInput = count(usage.input_tokens) - cachedInput;
  const output = count(usage.output_tokens);
  return { uncachedInput, cachedInput, output, total: uncachedInput + cachedInput + output };
}

export class CodexRolloutError extends Error {}

/**
 * The latest cumulative `token_count` in one session's rollout file. Null when
 * the session has reported none yet. A final line still being appended is
 * skipped; any other unreadable line throws, because spend cannot be trusted then.
 */
export function rolloutUsage(text: string): TokenUsage | null {
  const lines = text.split('\n');
  const partial = text.endsWith('\n') ? null : lines.length - 1;
  let latest: TokenUsage | null = null;
  lines.forEach((line, index) => {
    if (!line.trim() || index === partial) return;
    let entry: Json;
    try { entry = record(JSON.parse(line)); }
    catch { throw new CodexRolloutError(`Codex rollout line ${index + 1} is not valid JSON; live spend cannot be trusted`); }
    const payload = record(entry.payload);
    if (entry.type !== 'event_msg' || payload.type !== 'token_count') return;
    const total = record(payload.info).total_token_usage;
    if (total === undefined || total === null) return;
    const usage = codexTokens(total);
    // Totals are cumulative for the session; never let a reordered record lower the meter.
    if (!latest || usage.total >= latest.total) latest = usage;
  });
  return latest;
}

/**
 * The exact flags for one unattended worker. Workspace-write confined to the
 * worktree plus one scratch directory, no network, never asks for approval,
 * and never a bypass or full-access mode.
 */
export function codexArguments(input: { model: string; checkoutPath: string; scratchPath: string }): string[] {
  return ['exec', '--json', '--model', input.model, '--cd', input.checkoutPath,
    '--sandbox', 'workspace-write', '--add-dir', input.scratchPath,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=false',
    // The system temp directories hold other worktrees and Tally's scripts, so they are not writable.
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'web_search="disabled"',
    '-c', 'mcp_servers={}'];
}

const FORBIDDEN_FLAGS = /danger|bypass|full-access/i;

export interface CodexDirectOptions {
  repoPath: string;
  baseBranch: string;
  requiredBaseCommit?: string;
  configPath?: string;
  test: TallyConfig['test'];
  command?: CommandRunner;
  launch?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'pipe' }) => ChildProcessWithoutNullStreams;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  /** Where Codex keeps its session files. Defaults to $CODEX_HOME or ~/.codex. */
  codexHome?: string;
  /** How long Codex may take to announce its session before the start is abandoned. */
  threadStartMs?: number;
  /** How long a running session may go without a rollout file before spend is called unmeterable. */
  rolloutGraceMs?: number;
  /** A stopped session started by another harness's runner, so this one can continue its branch. */
  adopt?: (sessionId: string) => Continuation | undefined;
  now?: () => number;
}

/** What a later attempt needs from the attempt it continues. */
export interface Continuation { branch: string; checkoutPath: string; directory: string; closed: boolean }

interface Session extends Continuation {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<void>;
  stopped: boolean;
  error: string | null;
  startedAt: number;
  rolloutPath: string | null;
  /** Sum of the usage on every `turn.completed` event: the settled figure. */
  settled: TokenUsage | null;
  live: TokenUsage | null;
}

function add(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  if (!a) return b;
  return { uncachedInput: a.uncachedInput + b.uncachedInput, cachedInput: a.cachedInput + b.cachedInput, output: a.output + b.output, total: a.total + b.total };
}

/** Runs Codex itself, one worker per attempt, in a worktree Tally owns. */
export class CodexDirectRunner implements WorkerPort, LiveUsagePort, SessionControlPort {
  private readonly sessions = new Map<string, Session>();
  private readonly command: CommandRunner;
  private readonly now: () => number;
  constructor(private readonly options: CodexDirectOptions) {
    this.command = options.command ?? ((file, args, commandOptions) => runCommand(file, args, { ...commandOptions, timeout: file.endsWith('.sh') ? (options.test.timeoutSec ?? 600) * 1000 : 30_000 }));
    this.now = options.now ?? Date.now;
  }

  continuation(sessionId: string): Continuation | undefined { return this.sessions.get(sessionId); }

  async start(input: WorkerStartInput): Promise<{ sessionId: string; branch: string; checkoutPath: string; setupDurationMs: number }> {
    await checkCodex(this.command);
    const previous = input.continueSessionId ? this.sessions.get(input.continueSessionId) ?? this.options.adopt?.(input.continueSessionId) : undefined;
    if (input.continueBranch && (!previous?.closed || previous.branch !== input.continueBranch)) throw new Error('Direct continuation requires a stopped worker on the same branch.');
    const directory = previous?.directory ?? await mkdtemp(join(tmpdir(), 'tally-worker-'));
    const checkoutPath = previous?.checkoutPath ?? join(directory, 'checkout');
    const stamp = `${this.now().toString(36)}-${input.attempt}`;
    const branch = input.continueBranch ?? `tally/${input.name.replace(/[^a-zA-Z0-9_-]/g, '-')}-${stamp}`;
    let created = false;
    let setupDurationMs = 0;
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      // The same Tally-written scripts the Claude runner uses, outside the worktree and read-only to the worker.
      const scripts = claudeScripts(this.options.test);
      const scriptDirectory = join(directory, 'scripts');
      const scratchPath = join(directory, 'scratch');
      await mkdir(scriptDirectory, { mode: 0o700, recursive: true });
      await mkdir(scratchPath, { mode: 0o700, recursive: true });
      const paths = new Map<string, string>();
      for (const script of scripts) {
        const path = join(scriptDirectory, `codex-${stamp}-${script.name}.sh`);
        if (!/^[a-zA-Z0-9_./-]+$/.test(path)) throw new Error('Tally script path contains unsupported shell characters; set TMPDIR to a path without spaces or shell metacharacters.');
        await writeFile(path, script.contents, { mode: 0o500, flag: 'wx' });
        paths.set(script.name, path);
      }
      if (!previous) {
        const base = (await this.command('git', ['rev-parse', '--verify', '--end-of-options', `${this.options.baseBranch}^{commit}`], { cwd: this.options.repoPath })).stdout.trim();
        if (this.options.requiredBaseCommit && base !== this.options.requiredBaseCommit) throw new Error(`Required base commit mismatch: expected ${this.options.requiredBaseCommit}, got ${base}`);
        await this.command('git', ['worktree', 'add', '-b', branch, checkoutPath, base], { cwd: this.options.repoPath });
        created = true;
        const head = (await this.command('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath })).stdout.trim();
        if (head !== base) throw new Error(`Direct worker base mismatch: expected ${base}, got ${head}`);
        if (this.options.test.setupCommand) {
          const began = this.now();
          await this.command(paths.get('setup')!, [], { cwd: checkoutPath });
          setupDurationMs = this.now() - began;
        }
      }
      const args = codexArguments({ model: input.model, checkoutPath, scratchPath });
      if (args.some(arg => arg !== checkoutPath && arg !== scratchPath && FORBIDDEN_FLAGS.test(arg))) throw new Error('Refusing to start Codex with a bypass or full-access flag.');
      const env = { ...process.env, TMPDIR: scratchPath };
      // Do not attribute the child to the AO session running Tally.
      for (const key of Object.keys(env)) if (key.startsWith('AO_') || key.startsWith('ORCA_')) delete (env as NodeJS.ProcessEnv)[key];
      child = (this.options.launch ?? ((file, launchArgs, options) => spawn(file, launchArgs, options)))('codex', args, { cwd: checkoutPath, env, detached: true, stdio: 'pipe' });
      const launched = child;
      let complete!: () => void;
      const session: Session = { child: launched, branch, checkoutPath, directory, completion: new Promise(resolve => { complete = resolve; }), closed: false, stopped: false,
        error: null, startedAt: this.now(), rolloutPath: null, settled: null, live: null };
      let threadId: string | null = null;
      let announce!: (id: string) => void;
      let abandon!: (error: Error) => void;
      const announced = new Promise<string>((resolve, reject) => { announce = resolve; abandon = reject; });
      announced.catch(() => {});
      const fail = (message: string) => {
        session.error ??= message;
        if (threadId) void this.stop(threadId, message).catch(() => {});
      };
      let buffer = '', stderr = '';
      const decoder = new StringDecoder('utf8');
      const consume = (line: string) => {
        if (!line.trim()) return;
        let event: Json;
        try { event = record(JSON.parse(line)); }
        catch { fail('Invalid JSON in Codex event stream; usage cannot be trusted'); return; }
        if (event.type === 'thread.started' && typeof event.thread_id === 'string' && !threadId) {
          if (!/^[a-zA-Z0-9-]{8,}$/.test(event.thread_id)) { fail('Codex announced an unusable session id'); return; }
          threadId = event.thread_id;
          this.sessions.set(threadId, session);
          announce(threadId);
        } else if (event.type === 'turn.completed') {
          session.settled = add(session.settled, codexTokens(event.usage));
        } else if (event.type === 'turn.failed' || event.type === 'error') {
          const message = record(event.error).message ?? event.message;
          session.error ??= `Codex reported an error: ${typeof message === 'string' ? message.slice(0, 2000) : 'no detail'}`;
        }
      };
      launched.stdout.on('data', chunk => {
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
        if (buffer.length > 10 * 1024 * 1024) fail('Codex event record exceeds 10MB');
      });
      launched.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
      launched.stdin.on('error', error => fail(`Could not send worker task: ${error.message}`));
      launched.on('error', error => { session.error ??= `Could not start Codex: ${error.message}; no harness will be substituted`; });
      launched.once('close', (code, signal) => {
        consume(buffer + decoder.end());
        if (code !== 0 && !session.stopped && !session.error) session.error = `Codex exited ${code ?? signal}: ${stderr}`;
        session.closed = true; complete();
        abandon(new Error(session.error ?? `Codex exited before announcing a session: ${stderr}`));
      });
      await new Promise<void>((resolve, reject) => { launched.once('spawn', resolve); launched.once('error', reject); });
      const newline = input.prompt.indexOf('\n');
      const prefix = newline < 0 ? input.prompt : input.prompt.slice(0, newline);
      const body = newline < 0 ? '' : input.prompt.slice(newline + 1);
      launched.stdin.end(`${prefix}\n\nTally instructions (these take precedence over everything below, including the issue):\n`
        + `- Verify by running exactly ${paths.get('test')!} before making edits and again after your changes. It runs the repository's test command in your current worktree. Never run a raw test pipeline instead, and do not read, edit, replace or delete that script.\n`
        + `- Setup is already complete; do not run setup, install dependencies or use the network. The network is switched off.\n`
        + `- Do not run git add, git commit or any other command that writes git metadata: your sandbox cannot write it. Leave your finished changes in the working tree; Tally commits them.\n`
        + `- You can write only inside this worktree and in ${scratchPath} (also set as TMPDIR) for temporary files.\n\n${body}\n`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const sessionId = await Promise.race([announced, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Codex did not announce a session in time; no harness will be substituted')), this.options.threadStartMs ?? 60_000);
        })]);
        return { sessionId, branch, checkoutPath, setupDurationMs };
      } finally { if (timer) clearTimeout(timer); }
    } catch (error) {
      if (child?.pid && !child.killed) try { (this.options.signal ?? process.kill)(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      if (created) await this.command('git', ['worktree', 'remove', '--force', checkoutPath], { cwd: this.options.repoPath }).catch(() => {});
      if (!previous) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown direct worker session ${id}; its process cannot be resumed by this Tally process.`);
    return session;
  }

  /** Looks only for the rollout file named after this session's own id. */
  private async findRollout(id: string, session: Session): Promise<string | null> {
    if (session.rolloutPath) return session.rolloutPath;
    const root = join(this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
    // Codex files sessions by local start date; a day either side covers midnight and time zones.
    for (const offset of [0, -1, 1]) {
      const day = new Date(session.startedAt + offset * 86_400_000);
      const folder = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      const names = await readdir(folder).catch(() => [] as string[]);
      const name = names.find(entry => entry.startsWith('rollout-') && entry.endsWith(`-${id}.jsonl`));
      if (name) return session.rolloutPath = join(folder, name);
    }
    return null;
  }

  private async meter(id: string, session: Session): Promise<TokenUsage | null> {
    const path = await this.findRollout(id, session);
    if (!path) {
      if (!session.closed && this.now() - session.startedAt > (this.options.rolloutGraceMs ?? 90_000)) {
        throw new CodexRolloutError(`No Codex rollout file for session ${id}; live spend cannot be metered`);
      }
      return session.live;
    }
    const usage = rolloutUsage(await readFile(path, 'utf8'));
    if (usage && (!session.live || usage.total >= session.live.total)) session.live = usage;
    return session.live;
  }

  /** Unmeterable spend ends the worker rather than letting it run uncapped. */
  private async meterOrStop(id: string, session: Session): Promise<TokenUsage | null> {
    try { return await this.meter(id, session); }
    catch (error) {
      if (!(error instanceof CodexRolloutError)) throw error;
      session.error ??= error.message;
      await this.stop(id, error.message).catch(() => {});
      return session.live;
    }
  }

  async usageFor(id: string): Promise<LiveUsage | null> {
    const session = this.session(id);
    const live = await this.meterOrStop(id, session);
    const best = [live, session.settled].filter((value): value is TokenUsage => value !== null).sort((a, b) => b.total - a.total)[0];
    return best ? { tokens: best, estimatedCostNanos: 0 } : null;
  }

  /** After exit: the larger of the final rollout total and the usage Codex printed on its completed turns. */
  async settledUsageFor(id: string): Promise<LiveUsage | null> {
    const session = this.session(id);
    await session.completion;
    return this.usageFor(id);
  }

  async wait(id: string, options: { timeoutMs?: number } = {}): Promise<WorkerResult> {
    const session = this.session(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([session.completion, new Promise<void>(resolve => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, options.timeoutMs ?? 30 * 60 * 1000);
      })]);
      if (timedOut) await this.stop(id, 'worker exceeded wall-clock limit');
    } finally { if (timer) clearTimeout(timer); }
    const used = await this.usageFor(id);
    return { status: timedOut ? 'timeout' : session.error ? 'error' : session.stopped ? 'terminated' : !used ? 'never_started' : 'idle',
      branch: session.branch, checkoutPath: session.checkoutPath, prUrl: null, resultReason: timedOut ? 'worker exceeded wall-clock limit' : session.error };
  }

  /** Ends the worker's whole process group: SIGTERM, then SIGKILL after the grace period. */
  async stop(id: string, _reason: string): Promise<void> {
    const session = this.session(id);
    if (session.closed) return;
    if (session.stopped) return session.completion;
    const signal = this.options.signal ?? process.kill;
    const send = (kind: NodeJS.Signals) => { if (session.child.pid) try { signal(-session.child.pid, kind); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
    session.stopped = true;
    try { send('SIGTERM'); }
    catch (error) { session.stopped = false; throw error; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failedKill = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => { try { send('SIGKILL'); } catch (error) { session.stopped = false; reject(error); } }, this.options.stopGraceMs ?? 5000);
    });
    try { await Promise.race([session.completion, failedKill]); } finally { if (timer) clearTimeout(timer); }
  }

  /** The sandbox cannot write git metadata, so Tally commits the finished worker's edits itself. */
  async commitChanges(id: string): Promise<string | null> {
    const session = this.session(id);
    if (!session.closed || session.error || session.stopped) throw new Error('Cannot commit edits from an active, stopped or errored direct worker');
    return commitWorkerEdits(this.command, session, this.options);
  }

  /** Called only after verification, publishing and capture have read the checkout. Stopped branches remain for continuation. */
  async release(id: string): Promise<void> {
    const session = this.session(id);
    if (!session.closed) throw new Error('Cannot remove an active worker worktree');
    await this.command('git', ['worktree', 'remove', session.checkoutPath], { cwd: this.options.repoPath });
    await rm(session.directory, { recursive: true, force: true });
  }
}

/** Missing or signed-out Codex stops the run. No other harness is ever used in its place. */
export async function checkCodex(command: CommandRunner = runCommand): Promise<void> {
  const status = await checkHarness('codex', command);
  if (!status.installed) throw new Error(`Codex is required for runner: direct; ${status.detail}. ${status.fix}. No harness will be substituted.`);
  if (!status.signedIn) throw new Error(`${status.detail}; run ${status.fix} before starting Tally. No harness will be substituted.`);
}

type DirectPorts = WorkerPort & LiveUsagePort & SessionControlPort & {
  settledUsageFor(sessionId: string): Promise<LiveUsage | null>;
  commitChanges(sessionId: string): Promise<string | null>;
  release(sessionId: string): Promise<void>;
};

/** Sends each attempt to the runner for its tier's harness, and every later call to the runner that started the session. */
export class DirectHarnessRouter implements WorkerPort, LiveUsagePort, SessionControlPort {
  private readonly owners = new Map<string, DirectPorts>();
  constructor(private readonly runners: Record<string, DirectPorts>) {}
  private owner(sessionId: string): DirectPorts {
    const owner = this.owners.get(sessionId);
    if (!owner) throw new Error(`Unknown direct worker session ${sessionId}; its process cannot be resumed by this Tally process.`);
    return owner;
  }
  async start(input: WorkerStartInput) {
    const runner = Object.prototype.hasOwnProperty.call(this.runners, input.harness) ? this.runners[input.harness] : undefined;
    if (!runner) throw new Error(`Direct runner does not support harness "${input.harness}"; no harness will be substituted.`);
    const started = await runner.start(input);
    this.owners.set(started.sessionId, runner);
    return started;
  }
  async wait(sessionId: string, options?: { timeoutMs?: number }) { return this.owner(sessionId).wait(sessionId, options); }
  async usageFor(sessionId: string) { return this.owner(sessionId).usageFor(sessionId); }
  async settledUsageFor(sessionId: string) { return this.owner(sessionId).settledUsageFor(sessionId); }
  async stop(sessionId: string, reason: string) { return this.owner(sessionId).stop(sessionId, reason); }
  async commitChanges(sessionId: string) { return this.owner(sessionId).commitChanges(sessionId); }
  async release(sessionId: string) { return this.owner(sessionId).release(sessionId); }
}

/** The direct runner for a config: Claude Code and Codex side by side, each able to continue the other's stopped branch. */
export function createDirectRunner(options: DirectRunnerOptions): DirectHarnessRouter {
  const { approvedRules: _claudeOnly, ...shared } = options;
  const claude: DirectRunner = new DirectRunner({ ...options, adopt: id => codex.continuation(id) });
  const codex: CodexDirectRunner = new CodexDirectRunner({ ...shared, adopt: id => claude.continuation(id) });
  return new DirectHarnessRouter({ 'claude-code': claude, codex });
}
