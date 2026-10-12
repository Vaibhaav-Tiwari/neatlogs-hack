import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AoCliAdapter as RealAoCliAdapter, type AoAdapterOptions, type CommandRunner, usageFromAoPayload } from './ao.js';
import { GitWorktreeResolver } from '../engine/real.js';

class AoCliAdapter extends RealAoCliAdapter {
  constructor(options: AoAdapterOptions = {}) {
    let config: unknown = {};
    const original = options.command;
    super({ project: 'fake-project', ...options,
      ...(original ? { command: async (file: string, args: string[], opts?: { cwd?: string }) => {
        if (file === 'ao' && args[0] === 'project') {
          if (args[1] === 'set-config') config = JSON.parse(args[args.indexOf('--config-json') + 1]!);
          return { stdout: JSON.stringify({ project: { config } }), stderr: '' };
        }
        return original(file, args, opts);
      } } : {}), fetch: options.fetch ?? (async () => ({ ok: true, json: async () => ({ totals: { inputTokens: 1, outputTokens: 1 } }) }) as Response) });
  }
}

describe('AO per-harness permission selection', () => {
  const input = (harness: string, aoProject = 'mixed') => ({ task: {} as never, tier: {} as never, attempt: 1,
    ceilingNanos: 1, harness, model: 'fake-model', name: harness, prompt: 'implement', aoProject });

  it('locks set+readback+spawn across adapter instances and preserves other project fields', async () => {
    let config = { worker: { agent: 'codex', agentConfig: { permissions: 'auto', effort: 'high', model: 'existing' } },
      orchestrator: { agentConfig: { permissions: 'accept-edits' } }, env: { KEEP: 'yes' }, postCreate: ['existing hook'] };
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let firstSet!: () => void;
    const entered = new Promise<void>(resolve => { firstSet = resolve; });
    let sets = 0;
    const command: CommandRunner = async (_file, args) => {
      calls.push(args.slice(0, 3).join(' '));
      if (args[0] === 'project') {
        if (args[1] === 'set-config') {
          config = JSON.parse(args[args.indexOf('--config-json') + 1]!);
          if (++sets === 1) { firstSet(); await gate; }
        }
        return { stdout: JSON.stringify({ project: { config } }), stderr: '' };
      }
      const harness = args[args.indexOf('--harness') + 1];
      expect(config.worker.agentConfig.permissions).toBe(harness === 'claude-code' ? 'default' : 'auto');
      expect(config.worker.agentConfig.effort).toBe('high');
      expect(config.orchestrator.agentConfig.permissions).toBe('accept-edits');
      expect(config.env).toEqual({ KEEP: 'yes' });
      expect(config.postCreate).toEqual(['existing hook']);
      expect(args).not.toContain('--permission');
      expect(args.join(' ')).not.toContain('bypass-permissions');
      return { stdout: `spawned session ${harness}`, stderr: '' };
    };
    const first = new RealAoCliAdapter({ command }).start(input('claude-code'));
    await entered;
    const second = new RealAoCliAdapter({ command }).start(input('codex'));
    await Promise.resolve();
    expect(sets).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(['project get mixed', 'project set-config mixed', 'project get mixed', 'spawn --project mixed',
      'project get mixed', 'project set-config mixed', 'project get mixed', 'spawn --project mixed']);
  });

  it('does not spawn on a failed or unapplied mode update, and releases the lock for retry', async () => {
    let config: unknown = { worker: { agentConfig: { permissions: 'auto' } } };
    let fail = true, applied = false, spawns = 0;
    const command: CommandRunner = async (_file, args) => {
      if (args[0] === 'spawn') { spawns++; return { stdout: 'spawned session ok', stderr: '' }; }
      if (args[1] === 'set-config') {
        if (fail) throw new Error('mode update failed');
        if (applied) config = JSON.parse(args[args.indexOf('--config-json') + 1]!);
      }
      return { stdout: JSON.stringify({ project: { config } }), stderr: '' };
    };
    const adapter = new RealAoCliAdapter({ command });
    await expect(adapter.start(input('claude-code'))).rejects.toThrow('mode update failed');
    fail = false;
    await expect(adapter.start(input('claude-code'))).rejects.toThrow('expected default');
    expect(spawns).toBe(0);
    applied = true;
    await expect(adapter.start(input('claude-code'))).resolves.toMatchObject({ sessionId: 'ok' });
    expect(spawns).toBe(1);
  });

  it('requires an explicit project and known harness before making changes', async () => {
    const adapter = new RealAoCliAdapter({ command: async () => { throw new Error('must not call AO'); } });
    await expect(adapter.start({ ...input('claude-code'), aoProject: undefined })).rejects.toThrow('explicit project');
    await expect(adapter.start(input('other'))).rejects.toThrow('Unsupported AO harness');
  });

  it('applies Claude default for a same-branch continuation before spawning', async () => {
    let config: unknown = {};
    const calls: string[] = [];
    const adapter = new RealAoCliAdapter({ command: async (file, args) => {
      calls.push(`${file} ${args.slice(0, 3).join(' ')}`);
      if (file === 'git') return { stdout: '', stderr: '' };
      if (args[0] === 'project') {
        if (args[1] === 'set-config') config = JSON.parse(args[args.indexOf('--config-json') + 1]!);
        return { stdout: JSON.stringify({ project: { config } }), stderr: '' };
      }
      if (args[0] === 'spawn') {
        expect(config).toEqual({ worker: { agentConfig: { permissions: 'default' } } });
        return { stdout: 'spawned session next', stderr: '' };
      }
      return { stdout: JSON.stringify({ session: { branch: 'task', isTerminated: args[2] === 'old', worktreePath: '/next' } }), stderr: '' };
    } });
    await adapter.start({ ...input('claude-code'), attempt: 2, continueBranch: 'task', continueSessionId: 'old' });
    expect(calls.indexOf('ao project set-config mixed')).toBeLessThan(calls.indexOf('ao spawn --project mixed'));
  });
});

describe('AO host-side task commits', () => {
  it('quiesces without deleting the checkout and runs normal commit hooks without interactive prompts', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const command: CommandRunner = async (file, args, options) => {
      calls.push({ args, env: options?.env });
      if (file === 'ao' && args[1] === 'exit-agent') return { stdout: '', stderr: '' };
      if (file === 'ao' && args[1] === 'get') return { stdout: JSON.stringify({ session: { branch: 'task', worktreePath: '/tmp/worker' } }), stderr: '' };
      if (args[0] === 'branch') return { stdout: 'task\n', stderr: '' };
      if (args[0] === 'diff') return { stdout: 'calc.ts\0', stderr: '' };
      if (args[0] === 'ls-files') return { stdout: args.includes('--others') ? 'new.ts\0tally.yaml\0' : '', stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: 'a'.repeat(40), stderr: '' };
      if (args[0] === '--literal-pathspecs') return { stdout: '', stderr: '' };
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    };
    const worker = new RealAoCliAdapter({ command, cwd: '/tmp/repo' });
    await expect(worker.commitChanges('worker')).resolves.toBe('a'.repeat(40));
    expect(calls[0]?.args).toEqual(['session', 'exit-agent', 'worker']);
    const commit = calls.find(call => call.args.includes('commit'))!;
    expect(commit.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(commit.args).toEqual(['--literal-pathspecs', 'commit', '--only', '-m', 'tally: commit completed task edits', '--', 'calc.ts', 'new.ts']);
    expect(calls.some(call => call.args.includes('kill') || call.args.includes('--no-verify'))).toBe(false);
  });
});

describe('AO branch continuation', () => {
  it('launches a clean continuation with its task prompt instead of sending into startup idle', async () => {
    const calls: string[][] = [];
    const adapter = new AoCliAdapter({ command: async (file, args) => {
      calls.push(args);
      if (file === 'git') return { stdout: '', stderr: '' };
      if (args[0] === 'spawn') return { stdout: 'spawned session next', stderr: '' };
      return { stdout: JSON.stringify({ session: { branch: 'task', isTerminated: args[2] === 'old', worktreePath: '/next' } }), stderr: '' };
    } });
    await adapter.start({ task: {} as never, tier: {} as never, attempt: 2, ceilingNanos: 1, harness: 'codex', model: 'middle', name: 'continued', prompt: 'edit and test', continueBranch: 'task', continueSessionId: 'old' });
    expect(calls.find((args) => args[0] === 'spawn')).toContain('--prompt');
    expect(calls.some((args) => args[0] === 'send')).toBe(false);
  });
  it('saves stopped edits with a normal git commit that runs repository hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tally-wip-test-'));
    const worktree = join(root, 'worker');
    const exec = promisify(execFile);
    const git = (args: string[], cwd = root) => exec('git', args, { cwd });
    try {
      await git(['init', '-b', 'main']);
      await writeFile(join(root, 'tracked'), 'original');
      await git(['add', 'tracked']);
      await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']);
      await git(['worktree', 'add', '-b', 'task', worktree]);
      await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntest "$GIT_TERMINAL_PROMPT" = "0" || exit 1\nprintf hook-ran > hook-proof\n', { mode: 0o755 });
      await writeFile(join(worktree, 'tracked'), 'partial implementation');
      await writeFile(join(worktree, 'new-test'), 'partial regression');
      const resolver = new GitWorktreeResolver();
      const sha = await resolver.commitWorkInProgress(root, 'task');
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
      expect(await readFile(join(worktree, 'hook-proof'), 'utf8')).toBe('hook-ran');
      expect((await git(['show', `${sha}:new-test`])).stdout).toBe('partial regression');
      expect((await git(['rev-list', '--count', 'main..task'])).stdout.trim()).toBe('1');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('does not complete startup idle until tokens arrive and subsequent idle is stable', async () => {
    let polls = 0;
    const adapter = new AoCliAdapter({ pollMs: 0, sleep: async () => {}, idleStablePolls: 2,
      command: async () => ({ stdout: JSON.stringify({ session: { status: 'idle' } }), stderr: '' }),
      fetch: async () => ({ ok: true, json: async () => ({ totals: ++polls < 4 ? { inputTokens: 0 } : { inputTokens: 10 } }) }) as Response });
    await expect(adapter.wait('startup')).resolves.toMatchObject({ status: 'idle' });
    expect(polls).toBe(5);
  });
  it('reports a bounded zero-token startup as never started and kills it', async () => {
    let clock = 0;
    const calls: string[][] = [];
    const adapter = new AoCliAdapter({ startupTimeoutMs: 10, now: () => clock, sleep: async () => { clock += 5; },
      command: async (_file, args) => { calls.push(args); return { stdout: JSON.stringify({ session: { status: 'idle' } }), stderr: '' }; },
      fetch: async () => ({ ok: true, json: async () => ({ totals: { inputTokens: 0 } }) }) as Response });
    await expect(adapter.wait('startup')).resolves.toMatchObject({ status: 'never_started', resultReason: 'worker never started' });
    expect(calls.at(-1)).toEqual(['session', 'kill', 'startup']);
  });
  it('preserves the provider reason when an AO session ends before worker activity', async () => {
    const calls: string[][] = [];
    const adapter = new AoCliAdapter({ pollMs: 0, sleep: async () => {},
      command: async (_file, args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ session: { status: 'terminated', reason: 'terminated', message: 'model gpt-5.6-sol not available for this account' } }), stderr: '' };
      },
      fetch: async () => ({ ok: true, json: async () => ({ totals: { inputTokens: 0 } }) }) as Response });
    await expect(adapter.wait('rejected-model')).resolves.toMatchObject({
      status: 'never_started',
      resultReason: 'worker never started: terminated; model gpt-5.6-sol not available for this account',
    });
    expect(calls.at(-1)).toEqual(['session', 'kill', 'rejected-model']);
  });
  it('replays tracked and untracked edits on the same branch before sending the task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tally-continuation-test-'));
    const old = join(root, 'old');
    const next = join(root, 'next');
    const branch = 'tally/task';
    const exec = promisify(execFile);
    const git = (args: string[], cwd = root) => exec('git', args, { cwd });
    let delivered = false;
    try {
      await git(['init', '-b', 'main']);
      await writeFile(join(root, 'tracked.txt'), 'original\n');
      await git(['add', 'tracked.txt']);
      await git(['-c', 'user.name=Tally test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']);
      await git(['worktree', 'add', '-b', branch, old]);
      await writeFile(join(old, 'tracked.txt'), 'partial implementation\n');
      await writeFile(join(old, 'new-test.txt'), 'partial test\n');
      const command: CommandRunner = async (file, args, options) => {
        if (file === 'git') return exec(file, args, { cwd: options?.cwd, encoding: 'utf8' });
        if (args[0] === 'spawn') {
          expect(args).toContain(branch);
          expect(args).not.toContain('--prompt');
          await git(['worktree', 'add', next, branch]);
          return { stdout: 'spawned session next-worker', stderr: '' };
        }
        if (args[0] === 'send') {
          expect(await readFile(join(next, 'tracked.txt'), 'utf8')).toBe('partial implementation\n');
          expect(await readFile(join(next, 'new-test.txt'), 'utf8')).toBe('partial test\n');
          delivered = true;
          return { stdout: '', stderr: '' };
        }
        return { stdout: JSON.stringify({ session: { branch, isTerminated: args[2] === 'old-worker', worktreePath: args[2] === 'old-worker' ? old : next } }), stderr: '' };
      };
      const adapter = new AoCliAdapter({ cwd: root, command });
      await expect(adapter.start({ task: { taskId: 'T1', title: 'Fix tracked', body: '', issueNumber: null, issueUrl: null, size: 'small', outcomes: ['passed'] }, attempt: 2, tier: {} as never, ceilingNanos: 1,
        harness: 'codex', model: 'middle', sessionMode: 'tui', name: 'continued', prompt: 'continue', continueBranch: branch, continueSessionId: 'old-worker' })).resolves.toEqual({ sessionId: 'next-worker', branch, checkoutPath: next });
      expect(delivered).toBe(true);
      expect((await git(['branch', '--show-current'], old)).stdout.trim()).toBe('');
      expect(await readFile(join(old, 'tracked.txt'), 'utf8')).toBe('partial implementation\n');
      expect((await git(['rev-list', '--count', 'main..' + branch])).stdout.trim()).toBe('0');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 10_000);

  it('refuses to detach a branch belonging to a live worker', async () => {
    const calls: string[][] = [];
    const adapter = new AoCliAdapter({ command: async (_file, args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ session: { branch: 'task', isTerminated: false } }), stderr: '' };
    } });
    await expect(adapter.start({ task: {} as never, tier: {} as never, attempt: 2, ceilingNanos: 1, harness: 'codex', model: 'middle', name: 'continued', prompt: 'continue',
      continueBranch: 'task', continueSessionId: 'old-worker' })).rejects.toThrow('terminated worker');
    expect(calls).toEqual([['session', 'get', 'old-worker', '--json']]);
  });
});

describe('AO pinned-base startup', () => {
  it.each([true, false])('starts the first worker with its prompt and accepts it only after the pinned base check; match=%s', async (matches) => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const base = 'a'.repeat(40);
    const command: CommandRunner = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      if (args[0] === 'spawn') return { stdout: 'spawned session worker-base', stderr: '' };
      if (args[0] === 'session' && args[1] === 'get') return { stdout: JSON.stringify({ session: { id: 'worker-base', branch: 'ao/worker-base/root' } }), stderr: '' };
      if (file === 'git' && args[0] === 'worktree') return { stdout: 'worktree /worker\nHEAD abc\nbranch refs/heads/ao/worker-base/root\n\n', stderr: '' };
      if (file === 'git' && args[0] === 'rev-parse') return { stdout: matches ? base : 'b'.repeat(40), stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const adapter = new AoCliAdapter({ command, cwd: '/repo', requiredBaseCommit: base });
    const input = { task: { taskId: 'T1', title: 'Task', body: '', issueNumber: null, issueUrl: null, size: 'small' as const, outcomes: ['passed' as const] }, attempt: 1,
      tier: { name: 'cheap', harness: 'codex' as const, model: 'model', provider: 'openai', price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 1 }, ceilingFraction: 1 },
      ceilingNanos: null, harness: 'codex', model: 'model', name: 'test', prompt: 'implement task' };
    if (matches) await expect(adapter.start(input)).resolves.toMatchObject({ checkoutPath: '/worker' });
    else await expect(adapter.start(input)).rejects.toThrow('experiment worker base mismatch');

    const spawnIndex = calls.findIndex((call) => call.args[0] === 'spawn');
    const sessionIndex = calls.findIndex((call) => call.args[0] === 'session' && call.args[1] === 'get');
    const baseCheckIndex = calls.findIndex((call) => call.file === 'git' && call.args[0] === 'rev-parse');
    expect(calls[spawnIndex]?.args).toContain('--prompt');
    expect(calls[spawnIndex]?.args).toContain(input.prompt);
    expect(spawnIndex).toBeLessThan(sessionIndex);
    expect(sessionIndex).toBeLessThan(baseCheckIndex);
    expect(calls.some((call) => call.args[0] === 'send')).toBe(false);
    expect(calls.some((call) => call.args[0] === 'session' && call.args[1] === 'kill')).toBe(!matches);
    if (!matches) {
      const killIndex = calls.findIndex((call) => call.args[0] === 'session' && call.args[1] === 'kill');
      expect(baseCheckIndex).toBeLessThan(killIndex);
    }
    expect(calls.find((call) => call.file === 'git' && call.args[0] === 'rev-parse')?.cwd).toBe('/worker');
  });

  it('keeps ordinary spawns prompt-attached without experiment preflight', async () => {
    const calls: string[][] = [];
    const adapter = new AoCliAdapter({ command: async (_file, args) => {
      calls.push(args);
      return { stdout: args[0] === 'spawn' ? 'spawned session ordinary' : '', stderr: '' };
    } });

    await expect(adapter.start({ task: {} as never, tier: {} as never, attempt: 1, ceilingNanos: 1,
      harness: 'codex', model: 'fake-model', name: 'ordinary', prompt: 'ordinary task', aoProject: 'fake-project' })).resolves.toEqual({
      sessionId: 'ordinary', branch: null, checkoutPath: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls.at(-1)).toContain('--prompt');
    expect(calls.at(-1)).toContain('ordinary task');
    expect(calls.some((args) => args[0] === 'send')).toBe(false);
  });
  it('does not kill twice when adapter and engine both close the session', async () => {
    let kills = 0;
    const adapter = new AoCliAdapter({ command: async () => { kills += 1; return { stdout: '', stderr: '' }; } });
    await adapter.stop('worker', 'input stalled');
    await adapter.stop('worker', 'attempt finished');
    expect(kills).toBe(1);
  });
  it('maps AO usage totals into the shared live usage shape', () => {
    expect(
      usageFromAoPayload({
        totals: {
          inputTokens: 100,
          cachedInputTokens: 30,
          uncachedInputTokens: 70,
          outputTokens: 11,
          estimatedCost: { totalNanos: 1234 },
        },
      }),
    ).toEqual({
      tokens: { uncachedInput: 70, cachedInput: 30, output: 11, total: 111 },
      estimatedCostNanos: 1234,
    });
  });

  it('returns null until AO reports tokens', () => {
    expect(usageFromAoPayload({ totals: { inputTokens: 0, outputTokens: 0 } })).toBeNull();
  });

  it('waits for final AO usage to settle before returning it', async () => {
    let polls = 0;
    const adapter = new AoCliAdapter({
      sleep: async () => {},
      usageSettleMs: 0,
      usageSettlePolls: 4,
      fetch: async () =>
        ({
          ok: true,
          async json() {
            polls += 1;
            return {
              totals:
                polls === 1
                  ? { inputTokens: 100, cachedInputTokens: 20, uncachedInputTokens: 80, outputTokens: 5, estimatedCost: { totalNanos: 10 } }
                  : { inputTokens: 120, cachedInputTokens: 20, uncachedInputTokens: 100, outputTokens: 6, estimatedCost: { totalNanos: 12 } },
            };
          },
        }) as Response,
    });

    await expect(adapter.settledUsageFor('worker-usage')).resolves.toEqual({
      tokens: { uncachedInput: 100, cachedInput: 20, output: 6, total: 126 },
      estimatedCostNanos: 12,
    });
    expect(polls).toBe(3);
  });

  it('exits a worker asking for input but preserves its AO worktree for independent verification', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const command: CommandRunner = async (file, args) => {
      calls.push({ file, args });
      if (args.slice(0, 2).join(' ') === 'session get') {
        return {
          stdout: JSON.stringify({
            session: {
              id: 'worker-1',
              status: 'needs_input',
              branch: 'ao/worker-1/root',
              worktreePath: '/worktree',
              activity: { state: 'waiting_input' },
            },
          }),
          stderr: '',
        };
      }
      if (args.slice(0, 2).join(' ') === 'session exit-agent') return { stdout: '', stderr: '' };
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    };
    const adapter = new AoCliAdapter({ command, sleep: async () => {}, needsInputGracePolls: 1 });

    await expect(adapter.wait('worker-1')).resolves.toEqual({
      status: 'needs_input',
      branch: 'ao/worker-1/root',
      checkoutPath: '/worktree',
      prUrl: null,
      resultReason: 'worker asked for input: AO session entered needs_input/waiting_input',
    });
    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toEqual(['ao session get worker-1 --json', 'ao session exit-agent worker-1']);
  });

  it('waits through a transient needs-input state before returning stable idle', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    let gets = 0;
    const command: CommandRunner = async (file, args) => {
      calls.push({ file, args });
      if (args.slice(0, 2).join(' ') === 'session get') {
        gets += 1;
        const sessions = [
          { id: 'worker-2', status: 'idle', branch: 'ao/worker-2/root', worktreePath: '/worktree' },
          {
            id: 'worker-2',
            status: 'needs_input',
            branch: 'ao/worker-2/root',
            worktreePath: '/worktree',
            activity: { state: 'waiting_input', message: 'make setup is being auto-reviewed' },
          },
          { id: 'worker-2', status: 'idle', branch: 'ao/worker-2/root', worktreePath: '/worktree' },
          { id: 'worker-2', status: 'idle', branch: 'ao/worker-2/root', worktreePath: '/worktree' },
        ];
        return {
          stdout: JSON.stringify({ session: sessions[Math.min(gets - 1, sessions.length - 1)] }),
          stderr: '',
        };
      }
      if (args.slice(0, 2).join(' ') === 'session kill') return { stdout: '', stderr: '' };
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    };
    const adapter = new AoCliAdapter({ command, sleep: async () => {}, pollMs: 0, idleStablePolls: 2, needsInputGracePolls: 3 });

    await expect(adapter.wait('worker-2')).resolves.toMatchObject({
      status: 'idle',
      branch: 'ao/worker-2/root',
      checkoutPath: '/worktree',
    });
    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toEqual([
      'ao session get worker-2 --json',
      'ao session get worker-2 --json',
      'ao session get worker-2 --json',
      'ao session get worker-2 --json',
    ]);
  });

  it('does not kill a Claude worker for a recovered refusal in its completion message', async () => {
    let polls = 0;
    const command: CommandRunner = async (_file, args) => {
      if (args.slice(0, 2).join(' ') !== 'session get') throw new Error(`unexpected kill: ${args.join(' ')}`);
      polls += 1;
      return { stdout: JSON.stringify({ session: { id: 'claude-recovered', status: polls === 1 ? 'needs_input' : 'idle',
        activity: { state: polls === 1 ? 'waiting_input' : 'idle', message: 'Earlier command permission denied; completed the edit and tests with the approved script.' },
        branch: 'ao/claude-recovered/root' } }), stderr: '' };
    };
    const adapter = new AoCliAdapter({ command, sleep: async () => {}, pollMs: 0, needsInputGracePolls: 3, idleStablePolls: 2,
      fetch: async () => ({ ok: true, json: async () => ({ totals: { inputTokens: 100, outputTokens: 20 } }) }) as Response });
    await expect(adapter.wait('claude-recovered')).resolves.toMatchObject({ status: 'idle', branch: 'ao/claude-recovered/root' });
    expect(polls).toBe(3);
  });

  it('does not count a needs-input poll as stalled while activity or usage changes', async () => {
    let gets = 0;
    let usagePolls = 0;
    const command: CommandRunner = async (file, args) => {
      if (args.slice(0, 2).join(' ') === 'session get') {
        gets += 1;
        const needsInput = {
          id: 'worker-3',
          status: 'needs_input',
          branch: 'ao/worker-3/root',
          worktreePath: '/worktree',
          updatedAt: `2026-10-10T17:23:${String(Math.min(gets, 12)).padStart(2, '0')}Z`,
          activity: { state: 'waiting_input', message: 'make setup is being auto-reviewed', lastActivityAt: `2026-10-10T17:23:${String(Math.min(gets, 12)).padStart(2, '0')}Z` },
        };
        const idle = { id: 'worker-3', status: 'idle', branch: 'ao/worker-3/root', worktreePath: '/worktree' };
        return { stdout: JSON.stringify({ session: gets < 4 ? needsInput : idle }), stderr: '' };
      }
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    };
    const adapter = new AoCliAdapter({
      command,
      sleep: async () => {},
      pollMs: 0,
      idleStablePolls: 1,
      needsInputGracePolls: 2,
      fetch: async () =>
        ({
          ok: true,
          async json() {
            usagePolls += 1;
            return { totals: { inputTokens: usagePolls, uncachedInputTokens: usagePolls, cachedInputTokens: 0, outputTokens: 0 } };
          },
        }) as Response,
    });

    await expect(adapter.wait('worker-3')).resolves.toMatchObject({ status: 'idle', branch: 'ao/worker-3/root' });
    expect(gets).toBe(4);
  });

  it('stops a worker that exceeds the configured wall-clock limit', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => {
      now += 1_000;
      return now;
    };
    try {
      const command: CommandRunner = async (file, args) => {
        calls.push({ file, args });
        if (args.slice(0, 2).join(' ') === 'session get') {
          return {
            stdout: JSON.stringify({
              session: {
                id: 'worker-timeout',
                status: 'working',
                branch: 'ao/worker-timeout/root',
                worktreePath: '/worktree',
                activity: { state: 'working' },
              },
            }),
            stderr: '',
          };
        }
        if (args.slice(0, 2).join(' ') === 'session kill') return { stdout: '', stderr: '' };
        throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
      };
      const adapter = new AoCliAdapter({ command, sleep: async () => {}, pollMs: 0 });

      await expect(adapter.wait('worker-timeout', { timeoutMs: 1_500 })).resolves.toEqual({
        status: 'timeout',
        branch: 'ao/worker-timeout/root',
        checkoutPath: '/worktree',
        prUrl: null,
        resultReason: 'worker exceeded wall-clock limit of 2s',
      });
    } finally {
      Date.now = originalNow;
    }
    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toEqual([
      'ao session get worker-timeout --json',
      'ao session get worker-timeout --json',
      'ao session kill worker-timeout',
    ]);
  });

  it('passes the configured AO session mode when spawning a worker', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const command: CommandRunner = async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'spawned session worker-2 "tally-test" (idle)', stderr: '' };
    };
    const adapter = new AoCliAdapter({ command });

    await expect(
      adapter.start({
        task: { taskId: 'T1', title: 'Task', body: '', issueNumber: null, issueUrl: null, size: 'small', outcomes: ['passed'] },
        attempt: 1,
        tier: {
          name: 'cheap',
          harness: 'codex',
          sessionMode: 'tui',
          model: 'gpt-5.6-luna',
          provider: 'openai',
          price: { inputUsdPerMTok: 0.2, cachedInputUsdPerMTok: 0.02, outputUsdPerMTok: 1.2 },
          ceilingFraction: 1,
        },
        ceilingNanos: 100,
        harness: 'codex',
        sessionMode: 'tui',
        model: 'gpt-5.6-luna',
        name: 'tally-test',
        prompt: 'do work',
        aoProject: 'fly-doom-jev',
      }),
    ).resolves.toEqual({ sessionId: 'worker-2', branch: null, checkoutPath: null });
    expect(calls[0]).toEqual({
      file: 'ao',
      args: ['spawn', '--project', 'fly-doom-jev', '--mode', 'tui', '--harness', 'codex', '--model', 'gpt-5.6-luna', '--name', 'tally-test', '--prompt', 'do work'],
    });
  });
});
