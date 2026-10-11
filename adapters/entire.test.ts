import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from './entire.js';
import { EntireSizingAdapter } from './entire.js';
import { sizeFromSignals } from '../agent/sizer.js';
import { RepositorySizingAdapter } from './repository-sizing.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

const task = { taskId: 'T1', title: 'Fix refund validator', body: 'Edit src/refund/validator.ts and tests/refund.test.ts. Calling `refund.validate(-5)` should fail.' };

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
        return { stdout: JSON.stringify({
          callers: { total: 2, entries: [{ endpoint: { file_path: 'src/refund/index.ts', qualified_name: 'refund.create' }, depth: 1 }] },
          co_changes: { total: 3, entries: [{ endpoint: { file_path: 'src/refund/store.ts' } }, { endpoint: { file_path: 'tests/refund.test.ts' } }] },
        }) };
      }
      return { stdout: JSON.stringify({ callers: { total: 1 }, co_changes: { total: 0 } }) };
    });
    const adapter = new EntireSizingAdapter({ repoPath: '/repo', runner, topSymbols: 2 });
    const signals = await adapter.signalsFor(task);
    expect(signals).toMatchObject({ filesTouched: 2, dependents: 6, testsPresent: true, source: 'entire-graph' });
    expect(signals?.impact?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'src/refund/validator.ts', kind: 'target' }),
      expect.objectContaining({ id: 'src/refund/index.ts', kind: 'caller' }),
      expect.objectContaining({ id: 'src/refund/store.ts', kind: 'coChange' }),
      expect.objectContaining({ id: 'tests/refund.test.ts', kind: 'test' }),
    ]));
    expect(signals?.impact?.edges).toEqual(expect.arrayContaining([
      { from: 'src/refund/index.ts', to: 'src/refund/validator.ts', kind: 'calls' },
      { from: 'src/refund/validator.ts', to: 'src/refund/store.ts', kind: 'changesWith' },
      { from: 'tests/refund.test.ts', to: 'src/refund/validator.ts', kind: 'tests' },
    ]));
    expect(adapter.status()).toEqual({ status: 'ok', detail: null });
    expect(runner.calls.filter(call => call.command === 'entire').map((call) => call.args.slice(0, 3).join(' '))).toEqual([
      'graph index --repo',
      'graph search --repo',
      'graph impact --repo',
      'graph impact --repo',
    ]);
  });

  it('falls back to the shared repository sizing adapter when entire is missing', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tally-entire-fallback-'));
    mkdirSync(join(repoPath, 'src/refund'), { recursive: true });
    mkdirSync(join(repoPath, 'tests'));
    writeFileSync(join(repoPath, 'src/refund/validator.ts'), 'refund.validate(-5)');
    writeFileSync(join(repoPath, 'tests/refund.test.ts'), 'refund.validate(-5)');
    const runner = new FakeRunner((command, args) => {
      if (command === 'entire') return new Error('entire missing');
      if (command === 'git' && args.includes('ls-files')) return { stdout: 'src/refund/validator.ts\0tests/refund.test.ts\0' };
      return new Error('no matches');
    });
    const adapter = new EntireSizingAdapter({ repoPath, runner });
    const signals = await adapter.signalsFor(task);
    const shared = await new RepositorySizingAdapter({ repoPath, listFiles: async () => ['src/refund/validator.ts', 'tests/refund.test.ts'] }).signalsFor(task);
    expect(signals).toEqual(shared);
    expect(signals).toMatchObject({ filesTouched: 2, dependents: 0, testsPresent: true, source: 'code-search' });
    expect(signals?.impact?.nodes.map((node) => node.id)).toEqual(['src/refund/validator.ts', 'tests/refund.test.ts']);
    expect(signals?.impact?.nodes.every((node) => node.kind === 'target')).toBe(true);
    expect(adapter.status()).toMatchObject({ status: 'missing' });
    expect(adapter.status().detail).toContain('entire enable');
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

  it('counts the full primary target spread, caps evidence and rejects outside-repo paths', async () => {
    const runner = new FakeRunner((_command, args) => {
      if (args.includes('index')) return { stdout: '' };
      if (args.includes('search')) return { stdout: JSON.stringify({ results: Array.from({ length: 9 }, (_, i) => ({ file_path: `src/f${i}.ts`, qualified_name: `f${i}`, score: 90 - i })) }) };
      return { stdout: JSON.stringify({ callers: { total: 1, entries: [{ endpoint: { file_path: '/outside/private.ts' }, depth: 1 }] }, co_changes: { total: 60,
        entries: Array.from({ length: 60 }, (_, i) => ({ endpoint: { file_path: `/repo/src/c${i}.ts` }, weight: i })) } }) };
    });
    const namedTask = { ...task, body: `Edit ${Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`).join(', ')}.` };
    const signals = await new EntireSizingAdapter({ repoPath: '/repo', runner }).signalsFor(namedTask);
    expect(signals?.filesTouched).toBe(9);
    expect(sizeFromSignals(task, signals).size).toBe('large');
    expect(signals?.impact?.nodes).toHaveLength(40);
    expect(signals?.impact?.totals.nodes).toBe(69);
    expect(signals?.impact?.totals.edges).toBe(180);
    expect(signals?.impact?.edges).toHaveLength(80);
    expect(signals?.impact?.truncated).toBe(true);
    expect(signals?.impact?.nodes.some((node) => node.id === 'src/c59.ts')).toBe(true);
    expect(signals?.impact?.nodes.some((node) => node.id.startsWith('/') || node.id.includes('..'))).toBe(false);
    expect(runner.calls.filter((call) => call.args.includes('impact'))).toHaveLength(3);
  });

  it('sizes makeSection on its issue target, not generated data or related renderers', async () => {
    const runner = new FakeRunner((_command, args) => {
      if (args.includes('index')) return { stdout: '' };
      if (args.includes('search')) return { stdout: JSON.stringify({ results: [
        { file_path: 'js/main.js', qualified_name: 'makeSection', score: 75 },
        { file_path: '.tally/runs/latest/run.json', qualified_name: 'filesTouched', score: 20 },
        { file_path: '.entire/settings.json', qualified_name: 'enabled', score: 20 },
        { file_path: 'node_modules/pkg/index.js', qualified_name: 'render', score: 20 },
        { file_path: 'dist/main.js', qualified_name: 'makeSection', score: 20 },
        { file_path: 'js/sections/10-gputpu.js', qualified_name: 'render', score: 17 },
      ] }) };
      return { stdout: '{}' };
    });
    const specific = { taskId: 'T1', title: 'Fix makeSection in js/main.js', body: 'Edit js/main.js so makeSection should return the expected section. Do not change other renderers.' };
    const signals = await new EntireSizingAdapter({ repoPath: '/repo', runner }).signalsFor(specific);
    expect(signals).toMatchObject({ filesTouched: 1, contextFiles: ['js/sections/10-gputpu.js'] });
    expect(signals?.impact?.nodes.map(node => node.id)).toEqual(['js/main.js']);
    expect(sizeFromSignals(specific, signals).size).toBe('small');
    expect(sizeFromSignals(specific, signals).summary).toContain('related context (not targets)');
    expect(runner.calls.filter(call => call.args.includes('impact'))).toHaveLength(1);
  });
});
