import { describe, expect, it } from 'vitest';
import { AoCliAdapter, type CommandRunner, usageFromAoPayload } from './ao.js';

describe('usageFromAoPayload', () => {
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

  it('kills a worker that asks for input and returns a clear result reason', async () => {
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
      if (args.slice(0, 2).join(' ') === 'session kill') return { stdout: '', stderr: '' };
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
    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toEqual(['ao session get worker-1 --json', 'ao session kill worker-1']);
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
