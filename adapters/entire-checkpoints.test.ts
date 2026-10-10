import { describe, expect, it } from 'vitest';
import { EntireCheckpointAdapter, type CommandRunner } from './entire-checkpoints.js';

describe('EntireCheckpointAdapter', () => {
  it('finds a zero-turn stopped native session without a checkpoint in the shared repository', async () => {
    const adapter = new EntireCheckpointAdapter({ repoPath: '/repo', command: async (file, args, options) => {
      expect(file).toBe('entire');
      expect(args).toEqual(['session', 'list', '--json']);
      expect(options?.cwd).toBe('/repo');
      return { stdout: JSON.stringify([
        { session_id: 'older', worktree_id: 'worker-22', branch: 'same-branch' },
        { session_id: 'native-stopped', worktree_id: 'worker-23', branch: 'same-branch', turns: 0, status: 'active' },
      ]), stderr: '' };
    } });
    expect(await adapter.sessionIdFor({ sessionId: 'worker-23', branch: 'same-branch', checkoutPath: '/deleted/worktree' })).toBe('native-stopped');
    expect(await adapter.sessionIdFor({ sessionId: 'worker-24', branch: 'same-branch' })).toBeNull();
  });

  it('rejects ambiguous native sessions and tolerates missing Entire session metadata', async () => {
    const adapter = new EntireCheckpointAdapter({ repoPath: '/repo', command: async () => ({ stdout: JSON.stringify([
      { session_id: 'a', worktree_path: '/worker' }, { session_id: 'b', worktree_path: '/worker' },
    ]), stderr: '' }) });
    expect(await adapter.sessionIdFor({ sessionId: 'ao-worker', checkoutPath: '/worker' })).toBeNull();
    const missing = new EntireCheckpointAdapter({ repoPath: '/repo', command: async () => { throw new Error('missing'); } });
    expect(await missing.sessionIdFor({ sessionId: 'ao-worker' })).toBeNull();
  });
  it('generates a handoff summary only with explicit opt-in (fake provider)', async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      const command = `${file} ${args.join(' ')}`;
      if (command === 'entire session info session-1 --json') {
        return { stdout: JSON.stringify({ session_id: 'session-1', branch: 'tally/t1-1', checkpoints: 0 }), stderr: '' };
      }
      if (command === 'entire checkpoint list --pending --json') {
        return {
          stdout: JSON.stringify([
            {
              id: 'abc123',
              condensation_id: '01M4CHECKPOINT',
              session_id: 'session-1',
              date: '2026-10-10T23:11:09+05:30',
            },
          ]),
          stderr: '',
        };
      }
      if (command === 'entire checkpoint explain 01M4CHECKPOINT --json --no-pager') {
        return {
          stdout: JSON.stringify({
            checkpoint_id: '01M4CHECKPOINT',
            branch: 'tally/t1-1',
            sessions: [
              {
                session_id: 'session-1',
                token_usage: { input_tokens: 10, cache_read_tokens: 20, output_tokens: 5 },
              },
            ],
          }),
          stderr: '',
        };
      }
      if (command === 'entire checkpoint explain 01M4CHECKPOINT --generate --summary-timeout-seconds 45 --no-pager') {
        return { stdout: 'Intent: fix calc.\nOutcome: tests still fail.', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    };
    const adapter = new EntireCheckpointAdapter({ repoPath: '/repo', command: runner, generatedSummaries: true });

    await expect(adapter.checkpointFor({ sessionId: 'session-1', branch: 'tally/t1-1', checkoutPath: '/repo/worktree' })).resolves.toEqual({
      checkpointId: '01M4CHECKPOINT',
      checkpointUrl: null,
      entireSessionId: 'session-1',
    });
    await expect(adapter.summaryFor('session-1', { branch: 'tally/t1-1', checkoutPath: '/repo/worktree' })).resolves.toEqual({
      type: 'entire-handoff',
      summary: 'Intent: fix calc.\nOutcome: tests still fail.',
      branch: 'tally/t1-1',
      checkpointId: '01M4CHECKPOINT',
      checkpointUrl: null,
      summaryCostNanos: 0,
      summaryCostSource: 'ao-estimate',
    });
    expect(calls.some((call) => call.args.includes('--pending'))).toBe(true);
  });

  it('falls back to the Entire checkpoint trailer in the worker checkout', async () => {
    const runner: CommandRunner = async (file, args) => {
      const command = `${file} ${args.join(' ')}`;
      if (command === 'entire session info missing-session --json') throw new Error('no session');
      if (command === 'entire checkpoint list --pending --json') return { stdout: '[]', stderr: '' };
      if (command === 'entire checkpoint list --json --session missing-session') return { stdout: '[]', stderr: '' };
      if (command === 'git log -1 --format=%B --end-of-options HEAD --') return { stdout: 'fix: thing\n\nEntire-Checkpoint: 01M4TRAILER\n', stderr: '' };
      if (command === 'entire checkpoint explain 01M4TRAILER --json --no-pager') {
        return { stdout: JSON.stringify({ checkpoint_id: '01M4TRAILER', url: 'https://entire.example/checkpoints/01M4TRAILER' }), stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    };
    const adapter = new EntireCheckpointAdapter({ repoPath: '/repo', command: runner });

    await expect(adapter.checkpointFor({ sessionId: 'missing-session', checkoutPath: '/repo/worktree' })).resolves.toEqual({
      checkpointId: '01M4TRAILER',
      checkpointUrl: 'https://entire.example/checkpoints/01M4TRAILER',
      entireSessionId: null,
    });
  });

  it('uses the worker branch trailer before an unrelated AO session and retains the native session', async () => {
    const calls: string[] = [];
    const adapter = new EntireCheckpointAdapter({ repoPath: '/root', command: async (file, args, options) => {
      const command = `${file} ${args.join(' ')}`;
      calls.push(command);
      expect(options?.cwd).toBe('/root');
      if (file === 'git') return { stdout: 'fix: task\n\nEntire-Checkpoint: 01M4PROOF\n', stderr: '' };
      return { stdout: JSON.stringify({ checkpoint_id: '01M4PROOF', branch: 'ao/worker/root', sessions: [{ session_id: 'native-codex-id' }] }), stderr: '' };
    } });
    await expect(adapter.checkpointFor({ sessionId: 'ao-worker-id', branch: 'ao/worker/root' })).resolves.toEqual({
      checkpointId: '01M4PROOF', checkpointUrl: null, entireSessionId: 'native-codex-id',
    });
    expect(calls).toEqual(['git log -1 --format=%B --end-of-options ao/worker/root --', 'entire checkpoint explain 01M4PROOF --json --no-pager']);
  });

  it('defaults to metadata-only handoff, including task, verdict and changed commit files', async () => {
    const calls: string[][] = [];
    const adapter = new EntireCheckpointAdapter({ repoPath: '/repo', command: async (_file, args) => {
      calls.push(args);
      if (_file === 'git') return { stdout: 'calc.ts\0calc.test.ts\0', stderr: '' };
      return { stdout: JSON.stringify({ checkpoint_id: '01M4PROOF', branch: 'worker', files_touched: ['calc.ts'], sessions: [{ session_id: 'native' }] }), stderr: '' };
    } });
    const handoff = await adapter.summaryFor('ao-worker', { checkpointId: '01M4PROOF', task: { taskId: 'T1', title: 'Fix calc', body: 'Keep zero inputs valid.' }, result: 'failed', resultReason: 'zero input test failed' });
    expect(handoff?.summary).toContain('Metadata-only handoff');
    expect(handoff?.summary).toContain('Checkpoint files: calc.ts');
    expect(handoff?.summary).toContain('Changed files: calc.ts, calc.test.ts');
    expect(handoff?.summary).toContain('native session: native');
    expect(handoff?.summary).toContain('Attempt verdict: failed - zero input test failed');
    expect(handoff?.summary).toContain('Task T1: Fix calc\nKeep zero inputs valid.');
    expect(handoff?.summary).toContain('rerun the failed tests');
    expect(handoff?.summary).not.toContain('Not generated yet');
    expect(handoff?.branch).toBe('worker');
    expect(calls.some((args) => args.includes('--generate') || args.includes('--short'))).toBe(false);
    expect(handoff?.summaryCostNanos).toBe(0);
  });

  it('uses supplied changed files and remains usable when checkpoint metadata and git are unavailable', async () => {
    const calls: string[] = [];
    const adapter = new EntireCheckpointAdapter({ repoPath: '/repo', command: async (file) => { calls.push(file); throw new Error('unavailable'); } });
    const handoff = await adapter.summaryFor('worker', { checkpointId: 'known', branch: 'failed-branch', changedFiles: ['a.ts'], result: 'stopped' });
    expect(handoff?.summary).toContain('Checkpoint: known');
    expect(handoff?.summary).toContain('Branch: failed-branch');
    expect(handoff?.summary).toContain('Changed files: a.ts');
    expect(handoff?.summary).toContain('Attempt verdict: stopped');
    expect(calls).toEqual(['entire']);
  });

  it('falls back to metadata if explicitly enabled fake generation fails', async () => {
    const adapter = new EntireCheckpointAdapter({ repoPath: '/repo', generatedSummaries: true, command: async (_file, args) => {
      if (args.includes('--generate')) throw new Error('fake generation unavailable');
      return { stdout: '{}', stderr: '' };
    } });
    expect((await adapter.summaryFor('worker', { checkpointId: 'known', changedFiles: [] }))?.summary).toContain('Metadata-only handoff');
  });
});
