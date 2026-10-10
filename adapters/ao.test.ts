import { describe, expect, it } from 'vitest';
import { AoCliAdapter, type CommandRunner, usageFromAoPayload } from './ao.js';

describe('usageFromAoPayload', () => {
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
    const adapter = new AoCliAdapter({ command, sleep: async () => {} });

    await expect(adapter.wait('worker-1')).resolves.toEqual({
      status: 'needs_input',
      branch: 'ao/worker-1/root',
      checkoutPath: '/worktree',
      prUrl: null,
      resultReason: 'worker asked for input: AO session entered needs_input/waiting_input',
    });
    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toEqual(['ao session get worker-1 --json', 'ao session kill worker-1']);
  });
});
