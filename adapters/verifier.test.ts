import { describe, expect, it } from 'vitest';
import type { TallyConfig } from '../schema/index.js';
import { CommandVerifier } from './verifier.js';

const config: TallyConfig = {
  version: 1,
  repo: { path: '.', baseBranch: 'main' },
  test: { command: 'npm test' },
  backlog: { source: 'file', file: 'backlog.yaml' },
  tiers: [
    {
      name: 'cheap',
      harness: 'claude-code',
      provider: 'subscription',
      model: 'claude-haiku-4-5-20251001',
      price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 5 },
      ceilingFraction: 1,
    },
  ],
  ceilings: { bySizeUsd: { small: 1, medium: 2, large: 3 } },
  budget: { source: 'config', usd: 10 },
  integrations: { neatlogs: false, entire: false, cfoai: false, slack: false },
};

describe('CommandVerifier', () => {
  it('resolves a worker branch to its worktree before running tests', async () => {
    const commands: { command: string; cwd: string }[] = [];
    const verifier = new CommandVerifier(
      async (command, options) => {
        commands.push({ command, cwd: options.cwd });
        return { stdout: '', stderr: '' };
      },
      async (_repoPath, branch) => (branch === 'tally/task-1' ? '/tmp/task-1' : null),
    );

    await expect(verifier.verify({ checkoutPath: null, branch: 'tally/task-1', repoPath: '/repo', config })).resolves.toEqual({
      passed: true,
      reason: null,
    });
    expect(commands).toEqual([{ command: 'npm test', cwd: '/tmp/task-1' }]);
  });
});
