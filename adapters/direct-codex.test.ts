import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCeiling } from '../agent/watcher.js';
import type { WorkerStartInput } from '../engine/real.js';
import { CodexDirectRunner, DirectHarnessRouter, checkCodex, codexArguments, codexTokens, createDirectRunner, rolloutUsage } from './direct-codex.js';

const input: WorkerStartInput = {
  task: { taskId: 'T1', title: 'Fix add', body: '', issueNumber: null, issueUrl: null, size: 'small', outcomes: [] },
  attempt: 1, tier: { name: 'cheap', harness: 'codex', model: 'gpt-5.6-luna', provider: 'openai', ceilingFraction: 1,
    price: { inputUsdPerMTok: 0.2, cachedInputUsdPerMTok: 0.02, outputUsdPerMTok: 1.2 } },
  harness: 'codex', model: 'gpt-5.6-luna', name: 'tally run/T1', prompt: 'TALLY T1 Fix add\nedit and test', ceilingNanos: 1000,
};
const THREAD = '01a127e1-7b30-7a70-b40f-263c82cc4ec2';
const count = (input_tokens: number, cached_input_tokens: number, output_tokens: number) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens: 5, total_tokens: input_tokens + output_tokens } } } });

const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });

function harness(options: { signedIn?: boolean; installed?: boolean; setup?: string } = {}) {
  const codexHome = mkdtempSync(join(tmpdir(), 'tally-codex-home-'));
  made.push(codexHome);
  const child = Object.assign(new EventEmitter(), { pid: 4321, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  const launches: Array<{ file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; detached: boolean }> = [];
  const launch = vi.fn((file: string, args: string[], launchOptions: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'pipe' }) => {
    launches.push({ file, args, ...launchOptions });
    made.push(dirname(launchOptions.cwd));
    queueMicrotask(() => { child.emit('spawn'); emit({ type: 'thread.started', thread_id: THREAD }); });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const calls: string[] = [];
  const command = vi.fn(async (file: string, args: string[]) => {
    calls.push(`${file} ${args.join(' ')}`.trim());
    if (file === 'codex' && args[0] === '--version') { if (options.installed === false) throw new Error('ENOENT'); return { stdout: 'codex-cli 0.160.1', stderr: '' }; }
    if (file === 'codex') return { stdout: options.signedIn === false ? 'Not logged in' : 'Logged in using ChatGPT', stderr: '' };
    if (file === 'git' && args[0] === 'rev-parse') return { stdout: 'base123\n', stderr: '' };
    return { stdout: '', stderr: '' };
  });
  const signals: Array<[number, string]> = [];
  const signal = (pid: number, kind: NodeJS.Signals) => { signals.push([pid, kind]); if (kind === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM')); };
  let clock = new Date(2026, 9, 11, 12, 0, 0).getTime();
  const runner = new CodexDirectRunner({ repoPath: '/tmp/repo', baseBranch: 'main', test: { command: 'make test', ...(options.setup ? { setupCommand: options.setup } : {}) },
    command, launch, signal, codexHome, now: () => clock });
  const rollout = join(codexHome, 'sessions', '2026', '10', '11', `rollout-2026-10-11T12-00-00-${THREAD}.jsonl`);
  const writeRollout = (text: string) => { mkdirSync(dirname(rollout), { recursive: true }); writeFileSync(rollout, text); };
  return { runner, child, emit, launch, launches, command, calls, signals, writeRollout, advance: (ms: number) => { clock += ms; } };
}

describe('Codex usage', () => {
  it('splits cached from uncached input and keeps reasoning inside output', () => {
    expect(codexTokens({ input_tokens: 96506, cached_input_tokens: 85248, output_tokens: 767, reasoning_output_tokens: 300 }))
      .toEqual({ uncachedInput: 11258, cachedInput: 85248, output: 767, total: 97273 });
    expect(codexTokens({ input_tokens: -1, cached_input_tokens: 'bad', output_tokens: 7 }).total).toBe(7);
    expect(codexTokens({ input_tokens: 10, cached_input_tokens: 50, output_tokens: 0 })).toEqual({ uncachedInput: 0, cachedInput: 10, output: 0, total: 10 });
  });
  it('reads the latest cumulative token_count and prices it at the tier list price', () => {
    const text = [JSON.stringify({ type: 'session_meta', payload: { id: THREAD } }), count(13331, 6912, 152), JSON.stringify({ type: 'response_item', payload: { type: 'message' } }), count(40449, 33024, 301)].join('\n') + '\n';
    const tokens = rolloutUsage(text)!;
    expect(tokens).toEqual({ uncachedInput: 7425, cachedInput: 33024, output: 301, total: 40750 });
    // 7425 x 0.20 + 33024 x 0.02 + 301 x 1.20 USD per million tokens.
    expect(checkCeiling({ tokens, estimatedCostNanos: 0 }, { tier: input.tier, sessionId: 's', ceilingNanos: null }).costNanos).toBe(2506680);
  });
  it('reports nothing before the first count, ignores a line still being written, and never goes backwards', () => {
    expect(rolloutUsage('')).toBeNull();
    expect(rolloutUsage(JSON.stringify({ type: 'session_meta', payload: {} }) + '\n')).toBeNull();
    expect(rolloutUsage(`${count(100, 0, 10)}\n{"type":"event_msg","payl`)?.total).toBe(110);
    expect(rolloutUsage(`${count(500, 0, 10)}\n${count(100, 0, 10)}\n`)?.total).toBe(510);
    expect(rolloutUsage(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n')).toBeNull();
  });
  it('refuses a rollout with an unreadable complete line instead of treating spend as zero', () => {
    expect(() => rolloutUsage(`${count(100, 0, 10)}\nnot json\n${count(200, 0, 10)}\n`)).toThrow('live spend cannot be trusted');
  });
});

describe('Codex arguments', () => {
  it('runs unattended in a workspace-write sandbox with no network and no bypass of any kind', () => {
    const args = codexArguments({ model: 'gpt-5.6-luna', checkoutPath: '/w/checkout', scratchPath: '/w/scratch' });
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gpt-5.6-luna']);
    expect(args.slice(args.indexOf('--cd'), args.indexOf('--cd') + 2)).toEqual(['--cd', '/w/checkout']);
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'workspace-write']);
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual(['--add-dir', '/w/scratch']);
    for (const setting of ['approval_policy="never"', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true', 'web_search="disabled"', 'mcp_servers={}']) {
      expect(args[args.indexOf(setting) - 1]).toBe('-c');
    }
    expect(args.join(' ')).not.toMatch(/danger|bypass|full-access|approve-for-me|ignore-rules|skip-git-repo-check/);
  });
});

describe('direct Codex worker', () => {
  it('stops before any worktree or process when Codex is missing or signed out, naming the fix', async () => {
    const missing = harness({ installed: false });
    await expect(missing.runner.start(input)).rejects.toThrow('Codex is required for runner: direct');
    const signedOut = harness({ signedIn: false });
    await expect(signedOut.runner.start(input)).rejects.toThrow('codex login');
    await expect(checkCodex(signedOut.command)).rejects.toThrow('No harness will be substituted');
    for (const h of [missing, signedOut]) {
      expect(h.launch).not.toHaveBeenCalled();
      expect(h.calls.some(call => call.startsWith('git'))).toBe(false);
    }
  });

  it('sets up first, launches in the worktree, and sends the task with Tally instructions on stdin', async () => {
    const h = harness({ setup: 'make deps' });
    let prompt = '';
    h.child.stdin.on('data', chunk => { prompt += String(chunk); });
    const started = await h.runner.start(input);
    expect(started.sessionId).toBe(THREAD);
    expect(started.branch).toMatch(/^tally\/tally-run-T1-[a-z0-9]+-1$/);
    const launched = h.launches[0]!;
    expect(launched.file).toBe('codex');
    expect(launched.cwd).toBe(started.checkoutPath);
    expect(launched.detached).toBe(true);
    expect(launched.args).toEqual(codexArguments({ model: 'gpt-5.6-luna', checkoutPath: started.checkoutPath, scratchPath: join(dirname(started.checkoutPath), 'scratch') }));
    expect(launched.env.TMPDIR).toBe(join(dirname(started.checkoutPath), 'scratch'));
    expect(Object.keys(launched.env).some(key => key.startsWith('AO_') || key.startsWith('ORCA_'))).toBe(false);
    // Worktree, then setup, both before the agent.
    const worktree = h.calls.findIndex(call => call.startsWith('git worktree add -b'));
    const setup = h.calls.findIndex(call => call.endsWith('-setup.sh'));
    expect(worktree).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(worktree);
    const scripts = join(dirname(started.checkoutPath), 'scripts');
    const test = readdirSync(scripts).find(name => name.endsWith('-test.sh'))!;
    expect(readFileSync(join(scripts, test), 'utf8')).toBe('#!/bin/sh\nset -e\nmake test\n');
    expect(statSync(join(scripts, test)).mode & 0o777).toBe(0o500);
    expect(prompt.startsWith('TALLY T1 Fix add\n\nTally instructions')).toBe(true);
    expect(prompt).toContain(`running exactly ${join(scripts, test)}`);
    expect(prompt).toContain('Do not run git add, git commit');
    expect(prompt.trimEnd().endsWith('edit and test')).toBe(true);
  });

  it('meters live spend from its own rollout file only, then settles on exit', async () => {
    const h = harness();
    const { sessionId } = await h.runner.start(input);
    expect(await h.runner.usageFor(sessionId)).toBeNull();
    h.writeRollout(`${count(13331, 6912, 152)}\n`);
    expect((await h.runner.usageFor(sessionId))?.tokens.total).toBe(13483);
    h.writeRollout(`${count(13331, 6912, 152)}\n${count(40449, 33024, 301)}\n`);
    expect((await h.runner.usageFor(sessionId))?.tokens).toEqual({ uncachedInput: 7425, cachedInput: 33024, output: 301, total: 40750 });
    const settled = h.runner.settledUsageFor(sessionId);
    h.emit({ type: 'turn.completed', usage: { input_tokens: 96506, cached_input_tokens: 85248, output_tokens: 767 } });
    h.child.emit('close', 0, null);
    expect((await settled)?.tokens.total).toBe(97273);
    expect(await h.runner.wait(sessionId)).toMatchObject({ status: 'idle', prUrl: null, resultReason: null });
  });

  it('ends the whole process group at the ceiling and continues on the same branch and worktree', async () => {
    const h = harness();
    const first = await h.runner.start(input);
    h.writeRollout(`${count(900000, 0, 1000)}\n`);
    const verdict = checkCeiling(await h.runner.usageFor(first.sessionId), { tier: input.tier, sessionId: first.sessionId, ceilingNanos: input.ceilingNanos });
    expect(verdict.crossed).toBe(true);
    await h.runner.stop(first.sessionId, 'ceiling crossed');
    expect(h.signals).toEqual([[-4321, 'SIGTERM']]);
    expect(await h.runner.wait(first.sessionId)).toMatchObject({ status: 'terminated', branch: first.branch });
    await expect(h.runner.start({ ...input, attempt: 2, continueBranch: 'tally/other', continueSessionId: first.sessionId })).rejects.toThrow('same branch');
    // A second attempt in the same runner reuses the branch and checkout and adds no worktree.
    const before = h.calls.filter(call => call.startsWith('git worktree add')).length;
    const next = h.runner.start({ ...input, attempt: 2, continueBranch: first.branch, continueSessionId: first.sessionId });
    await expect(next).resolves.toMatchObject({ branch: first.branch, checkoutPath: first.checkoutPath });
    expect(h.calls.filter(call => call.startsWith('git worktree add')).length).toBe(before);
    expect(h.launches[1]!.cwd).toBe(first.checkoutPath);
  });

  it('stops the worker when its spend cannot be metered, instead of letting it run uncapped', async () => {
    const h = harness();
    const { sessionId } = await h.runner.start(input);
    h.advance(91_000);
    expect(await h.runner.usageFor(sessionId)).toBeNull();
    expect(h.signals).toEqual([[-4321, 'SIGTERM']]);
    expect(await h.runner.wait(sessionId)).toMatchObject({ status: 'error', resultReason: expect.stringContaining('live spend cannot be metered') });

    const bad = harness();
    const started = await bad.runner.start(input);
    bad.writeRollout(`not json\n${count(10, 0, 1)}\n`);
    await bad.runner.usageFor(started.sessionId);
    expect(bad.signals).toEqual([[-4321, 'SIGTERM']]);
    expect((await bad.runner.wait(started.sessionId)).resultReason).toContain('live spend cannot be trusted');
  });

  it('reports a Codex failure, a bad exit and a session that never starts', async () => {
    const failed = harness();
    const a = await failed.runner.start(input);
    failed.emit({ type: 'turn.failed', error: { message: 'model not available' } });
    failed.child.emit('close', 1, null);
    expect(await failed.runner.wait(a.sessionId)).toMatchObject({ status: 'error', resultReason: 'Codex reported an error: model not available' });

    const silent = harness();
    const b = await silent.runner.start(input);
    silent.child.emit('close', 0, null);
    expect((await silent.runner.wait(b.sessionId)).status).toBe('never_started');

    const dead = harness();
    dead.launch.mockImplementationOnce((_file, _args, launchOptions) => {
      made.push(dirname(launchOptions.cwd));
      queueMicrotask(() => { dead.child.emit('spawn'); dead.child.stderr.write('not authorised'); setImmediate(() => dead.child.emit('close', 1, null)); });
      return dead.child as unknown as ChildProcessWithoutNullStreams;
    });
    await expect(dead.runner.start(input)).rejects.toThrow('Codex exited 1: not authorised');
    expect(dead.calls.some(call => call.startsWith('git worktree remove --force'))).toBe(true);
  });

  it('releases the worktree only once the worker has exited', async () => {
    const h = harness();
    const started = await h.runner.start(input);
    await expect(h.runner.release(started.sessionId)).rejects.toThrow('active worker');
    h.child.emit('close', 0, null);
    await h.runner.release(started.sessionId);
    expect(h.calls.at(-1)).toBe(`git worktree remove ${started.checkoutPath}`);
    expect(existsSync(dirname(started.checkoutPath))).toBe(false);
  });
});

describe('dispatch by harness', () => {
  const fakeRunner = (id: string) => ({
    start: vi.fn(async () => ({ sessionId: id, branch: `b-${id}`, checkoutPath: `/c/${id}`, setupDurationMs: 0 })),
    wait: vi.fn(async () => ({ status: 'idle' as const, branch: `b-${id}`, checkoutPath: `/c/${id}`, prUrl: null })),
    usageFor: vi.fn(async () => null), settledUsageFor: vi.fn(async () => null), stop: vi.fn(async () => {}), release: vi.fn(async () => {}),
  });
  it('sends each attempt to its own harness and never substitutes one for another', async () => {
    const claude = fakeRunner('c1'), codex = fakeRunner('x1');
    const router = new DirectHarnessRouter({ 'claude-code': claude, codex });
    expect((await router.start(input)).sessionId).toBe('x1');
    expect((await router.start({ ...input, harness: 'claude-code' })).sessionId).toBe('c1');
    await router.stop('x1', 'ceiling'); await router.usageFor('c1'); await router.release('x1'); await router.wait('c1');
    expect(codex.stop).toHaveBeenCalledWith('x1', 'ceiling');
    expect(claude.stop).not.toHaveBeenCalled();
    expect(claude.usageFor).toHaveBeenCalledWith('c1');
    expect(codex.release).toHaveBeenCalledWith('x1');
    await expect(router.start({ ...input, harness: 'toString' })).rejects.toThrow('no harness will be substituted');
    await expect(router.usageFor('nope')).rejects.toThrow('Unknown direct worker session');
  });
  it('builds both runners for a config without needing Claude consent for Codex tiers', async () => {
    const command = vi.fn(async () => { throw new Error('ENOENT'); });
    const router = createDirectRunner({ repoPath: '/tmp/repo', baseBranch: 'main', test: { command: 'make test' }, command });
    await expect(router.start(input)).rejects.toThrow('Codex is required for runner: direct');
    await expect(router.start({ ...input, harness: 'claude-code' })).rejects.toThrow('run tally init');
  });
});
