import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { LiveUsage, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import type { WorkerPort, WorkerResult, WorkerStartInput } from '../engine/real.js';
import type { TallyConfig, TokenUsage } from '../schema/index.js';
import { runCommand } from './command.js';
import type { CommandRunner } from './ao.js';

type Json = Record<string, unknown>;
function record(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function count(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0; }
function tokens(value: unknown): TokenUsage {
  const u = record(value);
  const cacheWrite1h = count(record(u.cache_creation).ephemeral_1h_input_tokens);
  const cacheWrite5m = Math.max(count(record(u.cache_creation).ephemeral_5m_input_tokens), count(u.cache_creation_input_tokens) - cacheWrite1h);
  const uncachedInput = count(u.input_tokens), cachedInput = count(u.cache_read_input_tokens), output = count(u.output_tokens);
  return { uncachedInput, cachedInput, cacheWrite5m, cacheWrite1h, output, total: uncachedInput + cachedInput + cacheWrite5m + cacheWrite1h + output };
}

/** API message ids deduplicate the full content-block and partial-event views. */
export class ClaudeUsageMeter {
  private readonly messages = new Map<string, Json>();
  private current: string | null = null;
  private final: TokenUsage | null = null;
  consume(value: unknown): void {
    const line = record(value);
    if (line.type === 'result' && line.usage) { this.final = tokens(line.usage); return; }
    const event = record(line.event), message = record(line.message);
    if (line.type === 'stream_event' && event.type === 'message_start') {
      const start = record(event.message);
      if (typeof start.id === 'string') { this.current = start.id; this.merge(start.id, record(start.usage)); }
    } else if (line.type === 'stream_event' && event.type === 'message_delta' && this.current) {
      this.merge(this.current, record(event.usage));
    } else if (line.type === 'assistant' && typeof message.id === 'string') {
      this.merge(message.id, record(message.usage));
    }
  }
  private merge(id: string, usage: Json): void {
    const previous = this.messages.get(id) ?? {};
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === 'number') previous[key] = Math.max(count(previous[key]), count(value));
      else if (key === 'cache_creation') previous[key] = { ...record(previous[key]), ...record(value) };
    }
    this.messages.set(id, previous);
  }
  usage(): LiveUsage | null {
    const total = { uncachedInput: 0, cachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, total: 0 };
    for (const usage of this.messages.values()) {
      const t = tokens(usage);
      for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += t[key] ?? 0;
    }
    // Final result usage is cumulative for this fresh native session, not another turn.
    if (this.final) for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] = Math.max(total[key], this.final[key] ?? 0);
    total.total = total.uncachedInput + total.cachedInput + total.cacheWrite5m + total.cacheWrite1h + total.output;
    return total.total ? { tokens: total, estimatedCostNanos: 0 } : null;
  }
}

export async function checkDirectHarness(harness: string, command: CommandRunner = runCommand): Promise<void> {
  if (harness !== 'claude-code') throw new Error(`Direct runner does not support harness "${harness}" yet; no harness will be substituted.`);
  let loggedIn = false;
  try { loggedIn = record(JSON.parse((await command('claude', ['auth', 'status'])).stdout)).loggedIn === true; }
  catch (error) {
    throw new Error(`Claude Code is required for runner: direct with harness: claude-code; install claude and run claude auth login. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!loggedIn) throw new Error('Claude Code is signed out; run claude auth login before starting Tally. No harness will be substituted.');
}

export function claudeArguments(input: WorkerStartInput, checkoutPath: string, sessionId: string, test: TallyConfig['test']): string[] {
  const allow = [`Read(/${checkoutPath}/**)`, `Edit(/${checkoutPath}/**)`, 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git add *)', 'Bash(git commit *)', `Bash(${test.command})`];
  if (test.setupCommand) allow.push(`Bash(${test.setupCommand})`);
  return ['-p', '--model', input.model, '--session-id', sessionId, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'dontAsk', '--allowedTools', ...allow,
    '--disallowedTools', 'Bash(git push *)', 'Bash(gh *)', 'WebFetch', 'WebSearch', 'Agent',
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
}

export interface DirectRunnerOptions {
  repoPath: string;
  baseBranch: string;
  requiredBaseCommit?: string;
  test: TallyConfig['test'];
  command?: CommandRunner;
  launch?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'pipe' }) => ChildProcessWithoutNullStreams;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  branch: string;
  checkoutPath: string;
  directory: string;
  meter: ClaudeUsageMeter;
  completion: Promise<void>;
  closed: boolean;
  stopped: boolean;
  error: string | null;
  denied: boolean;
}

export class DirectRunner implements WorkerPort, LiveUsagePort, SessionControlPort {
  private readonly sessions = new Map<string, Session>();
  private readonly command: CommandRunner;
  constructor(private readonly options: DirectRunnerOptions) {
    this.command = options.command ?? ((file, args, commandOptions) => runCommand(file, args, { ...commandOptions, timeout: file === 'sh' ? (options.test.timeoutSec ?? 600) * 1000 : 30_000 }));
  }

  async start(input: WorkerStartInput): Promise<{ sessionId: string; branch: string; checkoutPath: string; setupDurationMs: number }> {
    await checkDirectHarness(input.harness, this.command);
    const previous = input.continueSessionId ? this.sessions.get(input.continueSessionId) : undefined;
    if (input.continueBranch && (!previous?.closed || previous.branch !== input.continueBranch)) throw new Error('Direct continuation requires a stopped worker on the same branch.');
    const sessionId = randomUUID();
    const branch = input.continueBranch ?? `tally/${input.name.replace(/[^a-zA-Z0-9_-]/g, '-')}-${sessionId.slice(0, 8)}`;
    const directory = previous?.directory ?? await mkdtemp(join(tmpdir(), 'tally-worker-'));
    const checkoutPath = previous?.checkoutPath ?? join(directory, 'checkout');
    let created = false;
    let setupDurationMs = 0;
    try {
      if (!previous) {
        const base = (await this.command('git', ['rev-parse', '--verify', '--end-of-options', `${this.options.baseBranch}^{commit}`], { cwd: this.options.repoPath })).stdout.trim();
        if (this.options.requiredBaseCommit && base !== this.options.requiredBaseCommit) throw new Error(`Required base commit mismatch: expected ${this.options.requiredBaseCommit}, got ${base}`);
        await this.command('git', ['worktree', 'add', '-b', branch, checkoutPath, base], { cwd: this.options.repoPath });
        created = true;
        const head = (await this.command('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath })).stdout.trim();
        if (head !== base) throw new Error(`Direct worker base mismatch: expected ${base}, got ${head}`);
        if (this.options.test.setupCommand) {
          const began = Date.now();
          await this.command('sh', ['-c', this.options.test.setupCommand], { cwd: checkoutPath });
          setupDurationMs = Date.now() - began;
        }
      }
      const env = { ...process.env };
      // Do not attribute the child to the AO session running Tally or trigger nested-Claude detection.
      for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('AO_') || key.startsWith('ORCA_')) delete env[key];
      const child = (this.options.launch ?? ((file, args, options) => spawn(file, args, options)))('claude', claudeArguments(input, checkoutPath, sessionId, this.options.test), { cwd: checkoutPath, env, detached: true, stdio: 'pipe' });
      const meter = new ClaudeUsageMeter();
      let complete!: () => void;
      const session: Session = { child, branch, checkoutPath, directory, meter, completion: new Promise(resolve => { complete = resolve; }), closed: false, stopped: false, error: null, denied: false };
      this.sessions.set(sessionId, session);
      let buffer = '', stderr = '';
      const decoder = new StringDecoder('utf8');
      const consume = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = record(JSON.parse(line));
          meter.consume(event);
          if (event.type === 'result') {
            if (event.is_error) session.error = typeof event.result === 'string' ? event.result.slice(0, 2000) : 'Claude reported an error';
            if (Array.isArray(event.permission_denials) && event.permission_denials.length) { session.denied = true; session.error = `worker asked for input: permission denied for ${event.permission_denials.map((d: unknown) => record(d).tool_name ?? 'tool').join(', ')}`; }
          }
        } catch { session.error = 'Invalid JSON in Claude stream; live usage cannot be trusted'; void this.stop(sessionId, session.error).catch(() => {}); }
      };
      child.stdout.on('data', chunk => {
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
        if (buffer.length > 10 * 1024 * 1024) { session.error = 'Claude stream record exceeds 10MB'; void this.stop(sessionId, session.error).catch(() => {}); }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
      child.stdin.on('error', error => { session.error = `Could not send worker task: ${error.message}`; void this.stop(sessionId, session.error).catch(() => {}); });
      child.on('error', error => { session.error = `Could not start Claude Code: ${error.message}; no harness will be substituted`; });
      child.once('close', (code, signal) => {
        consume(buffer + decoder.end());
        if (code !== 0 && !session.stopped && !session.error) session.error = `Claude Code exited ${code ?? signal}: ${stderr}`;
        session.closed = true; complete();
      });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.stdin.end(input.prompt);
      return { sessionId, branch, checkoutPath, setupDurationMs };
    } catch (error) {
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
    return { status: timedOut ? 'timeout' : session.denied ? 'needs_input' : session.error ? 'error' : session.stopped ? 'terminated' : !session.meter.usage() ? 'never_started' : 'idle', branch: session.branch, checkoutPath: session.checkoutPath, prUrl: null,
      resultReason: timedOut ? 'worker exceeded wall-clock limit' : session.error };
  }
  async usageFor(id: string): Promise<LiveUsage | null> { return this.session(id).meter.usage(); }
  async settledUsageFor(id: string): Promise<LiveUsage | null> {
    const session = this.session(id); await session.completion; return session.meter.usage();
  }
  async stop(id: string, _reason: string): Promise<void> {
    const session = this.session(id);
    if (session.stopped) return session.completion;
    session.stopped = true;
    const signal = this.options.signal ?? process.kill;
    const send = (kind: NodeJS.Signals) => { if (session.child.pid) try { signal(-session.child.pid, kind); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
    send('SIGTERM');
    const timer = setTimeout(() => send('SIGKILL'), this.options.stopGraceMs ?? 5000);
    try { await session.completion; } finally { clearTimeout(timer); }
  }
  /** Called only after verification, publishing and capture have read the checkout. Stopped branches remain for continuation. */
  async release(id: string): Promise<void> {
    const session = this.session(id);
    if (!session.closed) throw new Error('Cannot remove an active worker worktree');
    await this.command('git', ['worktree', 'remove', session.checkoutPath], { cwd: this.options.repoPath });
    await rm(session.directory, { recursive: true, force: true });
  }
}
