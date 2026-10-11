import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeUsageMeter, DirectRunner, claudeArguments, checkDirectHarness } from './direct.js';
import type { WorkerStartInput } from '../engine/real.js';
import { checkCeiling, CeilingWatcher } from '../agent/watcher.js';

const input: WorkerStartInput = {
  task: { taskId: 'T1', title: 'Fix add', body: '', issueNumber: null, issueUrl: null, size: 'small', outcomes: [] },
  attempt: 1, tier: { name: 'cheap', harness: 'claude-code', model: 'haiku', provider: 'anthropic', ceilingFraction: 1,
    price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 5 } },
  harness: 'claude-code', model: 'haiku', name: 'tally-test', prompt: 'edit, test, commit', ceilingNanos: 1000,
};

function processFake() {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  const launch = vi.fn((_file: string, _args: string[], _options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'pipe' }) => { queueMicrotask(() => child.emit('spawn')); return child as unknown as ChildProcessWithoutNullStreams; });
  return { child, emit, launch };
}

describe('Claude live usage', () => {
  it('meters partial turns, deduplicates content blocks, settles cumulative usage without double counting', () => {
    const meter = new ClaudeUsageMeter();
    meter.consume({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 80 } } } });
    meter.consume({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 30 } } });
    expect(meter.usage()?.tokens).toEqual({ uncachedInput: 100, cachedInput: 200, cacheWrite5m: 80, cacheWrite1h: 0, output: 30, total: 410 });
    const message = { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 80, output_tokens: 30 } } };
    meter.consume(message); meter.consume(message);
    expect(meter.usage()?.tokens.total).toBe(410);
    meter.consume({ type: 'result', usage: { input_tokens: 150, cache_read_input_tokens: 220, cache_creation_input_tokens: 80, output_tokens: 50 } });
    expect(meter.usage()?.tokens.total).toBe(500);
    expect(checkCeiling(meter.usage(), { tier: input.tier, sessionId: 's', ceilingNanos: null }).costNanos).toBe(522000);
  });
  it('counts one-hour cache writes separately and rejects malformed usage', () => {
    const meter = new ClaudeUsageMeter();
    meter.consume({ type: 'assistant', message: { id: 'a', usage: { input_tokens: -1, output_tokens: 'bad', cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 15 } } } });
    expect(meter.usage()?.tokens.total).toBe(20);
    expect(checkCeiling(meter.usage(), { tier: input.tier, sessionId: 's', ceilingNanos: null }).costNanos).toBe(36250);
  });
});

describe('direct Claude worker', () => {
  it('rejects a wrong base and a setup failure before launching any agent', async () => {
    const launch = vi.fn();
    const calls: string[] = [];
    const command = async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'sh') throw new Error('setup failed');
      return { stdout: file === 'claude' ? '{"loggedIn":true}' : 'actual-base', stderr: '' };
    };
    const runner = new DirectRunner({ repoPath: '/tmp/repo', baseBranch: 'main', requiredBaseCommit: 'wrong-base', test: { command: 'true' }, command, launch });
    await expect(runner.start(input)).rejects.toThrow('base commit mismatch');
    expect(launch).not.toHaveBeenCalled();
    const failingSetup = new DirectRunner({ repoPath: '/tmp/repo', baseBranch: 'main', test: { command: 'true', setupCommand: 'make setup' }, command, launch });
    await expect(failingSetup.start(input)).rejects.toThrow('setup failed');
    expect(launch).not.toHaveBeenCalled();
    expect(calls.some(c => c.startsWith('git worktree remove'))).toBe(true);
  });
  it('handles split JSON and an unterminated final line, and fails on malformed output', async () => {
    const fake = processFake();
    const runner = new DirectRunner({ repoPath: '/tmp/repo', baseBranch: 'main', test: { command: 'true' }, command: async (file) => ({ stdout: file === 'claude' ? '{"loggedIn":true}' : 'base', stderr: '' }), launch: fake.launch, signal: () => fake.child.emit('close', null, 'SIGTERM') });
    const started = await runner.start(input);
    fake.child.stdout.write('{"type":"assistant","message":{"id":"m","usage":');
    fake.child.stdout.write('{"input_tokens":10,"output_tokens":2}}}\n');
    fake.child.stdout.write('{"type":"result","usage":{"input_tokens":20,"output_tokens":3}}');
    fake.child.emit('close', 0, null);
    expect((await runner.wait(started.sessionId)).status).toBe('idle');
    expect((await runner.settledUsageFor(started.sessionId))?.tokens.total).toBe(23);
    await runner.release(started.sessionId);
    const broken = processFake();
    fake.launch.mockImplementation(broken.launch);
    const second = await runner.start(input);
    broken.child.stdout.write('not JSON\n');
    // Signal fake belongs to the first process, so explicitly finish this child.
    broken.child.emit('close', 1, null);
    expect((await runner.wait(second.sessionId)).status).toBe('error');
    await runner.release(second.sessionId);
  });
  it('bounds a healthy-but-hung process by the wall clock and escalates TERM to KILL', async () => {
    const fake = processFake();
    const signals: string[] = [];
    const runner = new DirectRunner({ repoPath: '/tmp/repo', baseBranch: 'main', test: { command: 'true' }, command: async (file) => ({ stdout: file === 'claude' ? '{"loggedIn":true}' : 'base', stderr: '' }), launch: fake.launch, stopGraceMs: 1,
      signal: (_pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') fake.child.emit('close', null, signal); } });
    const started = await runner.start(input);
    expect((await runner.wait(started.sessionId, { timeoutMs: 1 })).status).toBe('timeout');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    await runner.release(started.sessionId);
  });
  it('uses scoped explicit permissions, exact model, no publishing or bypass, and enables partial JSON', () => {
    const args = claudeArguments(input, '/tmp/work', 'session', { command: 'make test', setupCommand: 'make setup' });
    expect(args).toContain('haiku');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('Edit(//tmp/work/**)');
    expect(args.join(' ')).not.toMatch(/dangerously|bypass|fallback-model/);
    expect(args).toContain('Bash(git push *)'); // denied, never allowed
    expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')).join(' ')).not.toContain('git push');
    expect(args).toContain('dontAsk');
  });
  it('fails clearly on missing or signed-out Claude without substituting a harness', async () => {
    await expect(checkDirectHarness('claude-code', async () => { throw new Error('ENOENT'); })).rejects.toThrow('Claude Code is required');
    await expect(checkDirectHarness('claude-code', async () => ({ stdout: '{"loggedIn":false}', stderr: '' }))).rejects.toThrow('claude auth login');
    const command = vi.fn();
    await expect(checkDirectHarness('codex', command)).rejects.toThrow('codex');
    expect(command).not.toHaveBeenCalled();
  });
  it('sets up before starting, streams live usage, stops the process group at ceiling and reuses the branch', async () => {
    const fake = processFake();
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const command = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
      calls.push({ file, args, cwd: options?.cwd });
      return { stdout: args.includes('auth') ? '{"loggedIn":true}' : args.includes('rev-parse') ? 'base\n' : '', stderr: '' };
    });
    const signal = vi.fn(() => fake.child.emit('close', null, 'SIGTERM'));
    const worker = new DirectRunner({ repoPath: '/tmp/repo', baseBranch: 'main', test: { command: 'make test', setupCommand: 'make setup' }, command, launch: fake.launch, signal });
    const started = await worker.start(input);
    expect(calls.findIndex(c => c.file === 'sh')).toBeGreaterThan(calls.findIndex(c => c.args[0] === 'worktree'));
    expect(fake.launch.mock.calls[0]?.[2]?.cwd).toBe(started.checkoutPath);
    fake.emit({ type: 'assistant', message: { id: 'm', usage: { input_tokens: 100, output_tokens: 10 } } });
    expect((await worker.usageFor(started.sessionId))?.tokens.total).toBe(110);
    expect((await new CeilingWatcher({ usage: worker, sessions: worker }).poll({ ...input, sessionId: started.sessionId })).action).toBe('stop');
    expect(signal).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect((await worker.wait(started.sessionId)).checkoutPath).toBe(started.checkoutPath);
    expect((await worker.settledUsageFor(started.sessionId))?.tokens.total).toBe(110);
    const next = processFake();
    fake.launch.mockImplementation(next.launch);
    const continued = await worker.start({ ...input, attempt: 2, continueBranch: started.branch, continueSessionId: started.sessionId });
    expect(continued.branch).toBe(started.branch);
    expect(continued.checkoutPath).toBe(started.checkoutPath);
    expect(calls.filter(c => c.args[0] === 'worktree' && c.args[1] === 'add')).toHaveLength(1);
    next.child.emit('close', 0, null);
    expect((await worker.wait(continued.sessionId)).status).toBe('never_started');
    await worker.release(continued.sessionId);
  });
  it('does not call a nonzero process exit successful and keeps permission denials visible', async () => {
    const fake = processFake();
    const worker = new DirectRunner({ repoPath: '/tmp/repo', baseBranch: 'main', test: { command: 'true' }, command: async (_file, args) => ({ stdout: args.includes('auth') ? '{"loggedIn":true}' : 'base', stderr: '' }), launch: fake.launch, signal: vi.fn() });
    const started = await worker.start(input);
    fake.emit({ type: 'result', is_error: true, result: 'permission denied', permission_denials: [{ tool_name: 'Bash' }], usage: { input_tokens: 1 } });
    fake.child.emit('close', 1, null);
    expect(await worker.wait(started.sessionId)).toMatchObject({ status: 'needs_input', resultReason: expect.stringContaining('permission denied') });
    await worker.release(started.sessionId);
  });
});
