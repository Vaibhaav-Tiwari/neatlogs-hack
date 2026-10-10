import { describe, expect, it } from 'vitest';
import { EntireCheckpointRecallAdapter, type CommandRunner } from './entire-recall.js';

describe('EntireCheckpointRecallAdapter', () => {
  it('returns a failed prior checkpoint that touched the same explicit file', async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return {
        stdout: JSON.stringify([
          {
            id: '01M4FAIL',
            files_touched: ['src/calc.ts'],
            title: 'cheap attempt failed on calc',
            match: 'A cheap attempt failed on this area before.',
          },
        ]),
      };
    };
    const adapter = new EntireCheckpointRecallAdapter({ repoPath: '/repo', command: runner });

    await expect(adapter.recallFor({ taskId: 'T1', title: 'Fix `src/calc.ts` add values', body: '' })).resolves.toEqual({
      checkpointId: '01M4FAIL',
      checkpointUrl: null,
      summary: 'A cheap attempt failed on this area before.',
      files: ['src/calc.ts'],
      failed: true,
    });
    expect(calls[0]).toContain('entire checkpoint search src/calc.ts --json --compact --limit 5');
  });

  it('ignores matches that touched other files or were not failures', async () => {
    const adapter = new EntireCheckpointRecallAdapter({
      repoPath: '/repo',
      command: async () => ({
        stdout: JSON.stringify([
          { id: 'other', files_touched: ['src/other.ts'], match: 'failed elsewhere' },
          { id: 'pass', files_touched: ['src/calc.ts'], match: 'passed after cleanup' },
        ]),
      }),
    });

    await expect(adapter.recallFor({ taskId: 'T1', title: 'Fix src/calc.ts add values', body: '' })).resolves.toBeNull();
  });
});
