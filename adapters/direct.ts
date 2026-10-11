import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { LiveUsage, LiveUsagePort, SessionControlPort } from '../agent/ports.js';
import type { WorkerPort, WorkerResult, WorkerStartInput } from '../engine/real.js';
import type { TallyConfig, TokenUsage } from '../schema/index.js';
import { runCommand } from './command.js';
import type { CommandRunner } from './ao.js';
import { checkHarness, claudeScripts, requireClaudeScriptConsent } from '../engine/harness.js';

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
  if (harness !== 'claude-code' && harness !== 'codex') throw new Error(`Direct runner does not support harness "${harness}"; no harness will be substituted.`);
  const status = await checkHarness(harness, command);
  if (!status.installed) throw new Error(`${harness === 'codex' ? 'Codex' : 'Claude Code'} is required for runner: direct; ${status.detail}. ${status.fix}. No harness will be substituted.`);
  if (!status.signedIn) throw new Error(`${status.detail}; run ${status.fix} before starting Tally. No harness will be substituted.`);
}

export function requireClaudeConsent(approvedRules: string[] | undefined, test?: TallyConfig['test']): asserts approvedRules is string[] {
  if (!approvedRules?.length) throw new Error('Claude Code worker consent is missing (claudeCode.allow); run tally init to review and approve its allow-list before starting a worker.');
  if (test) requireClaudeScriptConsent(approvedRules, test);
}

export function claudeArguments(input: WorkerStartInput, sessionId: string, approvedRules: string[]): string[] {
  requireClaudeConsent(approvedRules);
  return ['-p', '--model', input.model, '--session-id', sessionId, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'dontAsk', '--allowedTools', ...approvedRules,
    '--disallowedTools', 'Bash(git push *)', 'Bash(gh *)', 'WebFetch', 'WebSearch', 'Agent',
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
}

/** Commits a finished direct worker's edits on its branch, leaving out ignored and Tally-owned files. Shared by every direct harness. */
export async function commitWorkerEdits(command: CommandRunner, session: { checkoutPath: string; branch: string }, repo: { repoPath: string; configPath?: string }): Promise<string | null> {
    const options = { cwd: session.checkoutPath };
    const headBranch = (await command('git', ['branch', '--show-current'], options)).stdout.trim();
    if (headBranch !== session.branch) throw new Error(`Direct worker branch changed: expected ${session.branch}, got ${headBranch}`);
    const changed = (await command('git', ['diff', '--name-only', '-z', 'HEAD', '--'], options)).stdout;
    const added = (await command('git', ['ls-files', '--others', '--exclude-standard', '-z'], options)).stdout;
    const ignored = new Set((await command('git', ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'], options)).stdout.split('\0').filter(Boolean));
    const configFile = repo.configPath ? relative(resolve(repo.repoPath), resolve(repo.configPath)).replace(/\\/g, '/') : 'tally.yaml';
    const files = [...new Set((changed + added).split('\0').filter(Boolean))].filter(path =>
      !ignored.has(path) && path !== 'tally.yaml' && path !== configFile && path !== '.tally' && !path.startsWith('.tally/') && path !== '.claude/settings.local.json');
    if (!files.length) return null;
    await command('git', ['--literal-pathspecs', 'add', '-A', '--', ...files], options);
    // Commit only these paths, even if the worker pre-staged ignored or Tally-owned files.
    await command('git', ['--literal-pathspecs', 'commit', '--only', '-m', 'tally: commit completed task edits', '--', ...files], options);
    return (await command('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
}

export interface DirectRunnerOptions {
  repoPath: string;
  baseBranch: string;
  requiredBaseCommit?: string;
  test: TallyConfig['test'];
  approvedRules?: string[];
  configPath?: string;
  command?: CommandRunner;
  launch?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'pipe' }) => ChildProcessWithoutNullStreams;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  stopGraceMs?: number;
  /** A stopped session started by another harness's runner, so this one can continue its branch. */
  adopt?: (sessionId: string) => Pick<Session, 'branch' | 'checkoutPath' | 'directory' | 'closed'> | undefined;
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
  permissionWarnings: string[];
}

export class DirectRunner implements WorkerPort, LiveUsagePort, SessionControlPort {
  private readonly sessions = new Map<string, Session>();
  private readonly command: CommandRunner;
  constructor(private readonly options: DirectRunnerOptions) {
    this.command = options.command ?? ((file, args, commandOptions) => runCommand(file, args, { ...commandOptions, timeout: file.endsWith('.sh') ? (options.test.timeoutSec ?? 600) * 1000 : 30_000 }));
  }

  async start(input: WorkerStartInput): Promise<{ sessionId: string; branch: string; checkoutPath: string; setupDurationMs: number }> {
    requireClaudeConsent(this.options.approvedRules, this.options.test);
    await checkDirectHarness(input.harness, this.command);
    const previous = input.continueSessionId ? this.sessions.get(input.continueSessionId) ?? this.options.adopt?.(input.continueSessionId) : undefined;
    if (input.continueBranch && (!previous?.closed || previous.branch !== input.continueBranch)) throw new Error('Direct continuation requires a stopped worker on the same branch.');
    const sessionId = randomUUID();
    const branch = input.continueBranch ?? `tally/${input.name.replace(/[^a-zA-Z0-9_-]/g, '-')}-${sessionId.slice(0, 8)}`;
    const directory = previous?.directory ?? await mkdtemp(join(tmpdir(), 'tally-worker-'));
    const checkoutPath = previous?.checkoutPath ?? join(directory, 'checkout');
    let created = false;
    let setupDurationMs = 0;
    try {
      const scripts = claudeScripts(this.options.test);
      const scriptDirectory = join(directory, 'scripts');
      await mkdir(scriptDirectory, { mode: 0o700, recursive: true });
      const paths = new Map<string, string>();
      for (const script of scripts) {
        const path = join(scriptDirectory, `${sessionId}-${script.name}.sh`);
        if (!/^[a-zA-Z0-9_./-]+$/.test(path)) throw new Error('Claude script path contains unsupported shell characters; set TMPDIR to a path without spaces or shell metacharacters.');
        // Exact executable permission only; script edits are explicitly denied below.
        await writeFile(path, script.contents, { mode: 0o500, flag: 'wx' });
        paths.set(script.rule, path);
      }
      const runtimeRules = this.options.approvedRules.map(rule => paths.has(rule) ? `Bash(${paths.get(rule)})` : rule);
      if (!previous) {
        const base = (await this.command('git', ['rev-parse', '--verify', '--end-of-options', `${this.options.baseBranch}^{commit}`], { cwd: this.options.repoPath })).stdout.trim();
        if (this.options.requiredBaseCommit && base !== this.options.requiredBaseCommit) throw new Error(`Required base commit mismatch: expected ${this.options.requiredBaseCommit}, got ${base}`);
        await this.command('git', ['worktree', 'add', '-b', branch, checkoutPath, base], { cwd: this.options.repoPath });
        created = true;
        const head = (await this.command('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath })).stdout.trim();
        if (head !== base) throw new Error(`Direct worker base mismatch: expected ${base}, got ${head}`);
        if (this.options.test.setupCommand) {
          const began = Date.now();
          await this.command(paths.get(scripts.find(script => script.name === 'setup')!.rule)!, [], { cwd: checkoutPath });
          setupDurationMs = Date.now() - began;
        }
      }
      const env = { ...process.env };
      // Do not attribute the child to the AO session running Tally or trigger nested-Claude detection.
      for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('AO_') || key.startsWith('ORCA_')) delete env[key];
      const args = claudeArguments(input, sessionId, runtimeRules);
      // Claude uses // for filesystem-root paths; Edit governs both Edit and Write.
      args.splice(args.indexOf('--tools'), 0, `Edit(/${scriptDirectory}/**)`);
      const child = (this.options.launch ?? ((file, args, options) => spawn(file, args, options)))('claude', args, { cwd: checkoutPath, env, detached: true, stdio: 'pipe' });
      const meter = new ClaudeUsageMeter();
      let complete!: () => void;
      const session: Session = { child, branch, checkoutPath, directory, meter, completion: new Promise(resolve => { complete = resolve; }), closed: false, stopped: false, error: null, denied: false, permissionWarnings: [] };
      this.sessions.set(sessionId, session);
      let buffer = '', stderr = '';
      const decoder = new StringDecoder('utf8');
      const consume = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = record(JSON.parse(line));
          meter.consume(event);
          if (event.type === 'result') {
            if (Array.isArray(event.permission_denials)) session.permissionWarnings = event.permission_denials.map((denial: unknown) => {
              const item = record(denial);
              const command = record(item.tool_input).command;
              return `permission denied for ${String(item.tool_name ?? 'tool')}${typeof command === 'string' ? `: ${command}` : ''}`.slice(0, 2000);
            });
            if (event.is_error) session.error = typeof event.result === 'string' ? event.result.slice(0, 2000) : 'Claude reported an error';
            // Successful results may include earlier denials the worker recovered from.
            if (event.is_error && session.permissionWarnings.length) { session.denied = true; session.error = `permission failure: ${session.permissionWarnings.join('; ')}`; }
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
        if (code !== 0 && !session.stopped && !session.error) session.error = `Claude Code exited ${code ?? signal}: ${stderr}${session.permissionWarnings.length ? `; permission failure: ${session.permissionWarnings.join('; ')}` : ''}`;
        session.closed = true; complete();
      });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const testPath = paths.get(scripts[0]!.rule)!;
      const newline = input.prompt.indexOf('\n');
      const prefix = newline < 0 ? input.prompt : input.prompt.slice(0, newline);
      const body = newline < 0 ? '' : input.prompt.slice(newline + 1);
      child.stdin.end(`${prefix}\n\nTally verification instruction (takes precedence over the issue): run exactly ${testPath} first, before making edits, and again after your changes. Never run a raw test pipeline from the issue or wrap this script in a shell. This executable is outside the worktree and approved only for execution. Do not read, edit, replace or delete it. It runs the consented test command in your current worktree. Setup is already complete; do not run setup.\n\n${body}\n`);
      return { sessionId, branch, checkoutPath, setupDurationMs };
    } catch (error) {
      if (created) await this.command('git', ['worktree', 'remove', '--force', checkoutPath], { cwd: this.options.repoPath }).catch(() => {});
      if (!previous) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  continuation(id: string): Pick<Session, 'branch' | 'checkoutPath' | 'directory' | 'closed'> | undefined { return this.sessions.get(id); }
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
      resultReason: timedOut ? 'worker exceeded wall-clock limit' : session.error,
      ...(session.permissionWarnings.length ? { permissionWarnings: session.permissionWarnings } : {}) };
  }
  async usageFor(id: string): Promise<LiveUsage | null> { return this.session(id).meter.usage(); }
  async settledUsageFor(id: string): Promise<LiveUsage | null> {
    const session = this.session(id); await session.completion; return session.meter.usage();
  }
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
