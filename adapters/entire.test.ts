import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from './entire.js';
import { EntireSizingAdapter } from './entire.js';

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly handler: (command: string, args: string[]) => CommandResult | Error) {}
  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const result = this.handler(command, args);
    if (result instanceof Error) throw result;
    return result;
  }
}

const task = { taskId: 'T1', title: 'Fix refund validator', body: 'Calling `refund.validate(-5)` should fail.' };

describe('EntireSizingAdapter', () => {
  it('uses entire-graph search and impact to count files, callers and co-change files', async () => {
    const runner = new FakeRunner((_command, args) => {
      const text = args.join(' ');
      if (text.includes('graph index')) return { stdout: '' };
      if (text.includes('graph search')) {
        return {
          stdout: JSON.stringify({
            results: [
              { file_path: 'src/refund/validator.ts', symbol: 'refund.validate' },
              { file_path: 'tests/refund.test.ts', qualified_name: 'refund.test' },
            ],
          }),
        };
      }
      if (text.includes('refund.validate')) {
        return { stdout: JSON.stringify({ callers: { total: 2 }, co_changes: { total: 3 }, files: [{ file_path: 'src/refund/index.ts' }] }) };
      }
      return { stdout: JSON.stringify({ callers: { total: 1 }, co_changes: { total: 0 } }) };
    });
    const signals = await new EntireSizingAdapter({ repoPath: '/repo', runner, topSymbols: 2 }).signalsFor(task);
    expect(signals).toEqual({ filesTouched: 3, dependents: 6, testsPresent: true, source: 'entire-graph' });
    expect(runner.calls.map((call) => call.args.slice(0, 3).join(' '))).toEqual([
      'graph index --repo',
      'graph search --repo',
      'graph impact --repo',
      'graph impact --repo',
    ]);
  });

  it('falls back to rg code search when entire is missing', async () => {
    const runner = new FakeRunner((command, args) => {
      if (command === 'entire') return new Error('entire missing');
      if (command === 'rg' && args.includes('validator')) return { stdout: '/repo/src/refund/validator.ts\n/repo/tests/refund.test.ts\n' };
      return new Error('no matches');
    });
    const signals = await new EntireSizingAdapter({ repoPath: '/repo', runner }).signalsFor(task);
    expect(signals).toEqual({ filesTouched: 2, dependents: 0, testsPresent: true, source: 'code-search' });
  });

  it('returns null when neither graph nor code search can find anything', async () => {
    const runner = new FakeRunner(() => new Error('no tool or no matches'));
    await expect(new EntireSizingAdapter({ repoPath: '/repo', runner }).signalsFor(task)).resolves.toBeNull();
  });

  it('returns null for an empty issue', async () => {
    const runner = new FakeRunner(() => {
      throw new Error('should not run');
    });
    await expect(new EntireSizingAdapter({ repoPath: '/repo', runner }).signalsFor({ taskId: 'T1', title: '', body: '' })).resolves.toBeNull();
    expect(runner.calls).toEqual([]);
  });
});
