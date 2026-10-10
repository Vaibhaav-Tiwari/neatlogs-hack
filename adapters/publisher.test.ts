import { describe, expect, it } from 'vitest';
import { GitHubPublisher, type PublishCommand } from './publisher.js';
import type { TallyConfig } from '../schema/index.js';

const config: TallyConfig = {
  version: 1,
  repo: { path: '.', slug: 'acme/payments', baseBranch: 'main' },
  test: { command: 'npm test' },
  backlog: { source: 'file', file: 'backlog.yaml' },
  tiers: [
    {
      name: 'cheap',
      harness: 'codex',
      model: 'gpt-5.6-luna',
      provider: 'openai',
      price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 1 },
      ceilingFraction: 1,
    },
  ],
  ceilings: { bySizeUsd: { small: 1, medium: 2, large: 3 } },
  budget: { source: 'config', usd: 5 },
  integrations: { neatlogs: false, entire: false, cfoai: false, slack: false },
};

describe('GitHubPublisher', () => {
  it('counts commits ahead of the base branch and publishes a PR from Tally', async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const command: PublishCommand = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      if (file === 'git' && args[0] === 'rev-list') return { stdout: '2\n', stderr: '' };
      if (file === 'git' && args[0] === 'push') return { stdout: '', stderr: '' };
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') return { stdout: 'https://github.com/acme/payments/pull/42\n', stderr: '' };
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    };
    const publisher = new GitHubPublisher(command);

    await expect(publisher.commitsAhead({ checkoutPath: '/worktree', branch: 'ao/task/root', config })).resolves.toBe(2);
    await expect(
      publisher.publishPr({
        checkoutPath: '/worktree',
        branch: 'ao/task/root',
        config,
        task: { taskId: 'T1', title: 'Fix math', body: 'Body', issueNumber: 7, issueUrl: null, size: 'small', outcomes: ['passed'] },
        runId: 'run-1',
        attempt: 1,
      }),
    ).resolves.toBe('https://github.com/acme/payments/pull/42');

    expect(calls.map((call) => `${call.file} ${call.args.join(' ')}`)).toEqual([
      'git rev-list --count origin/main..HEAD',
      'git push -u origin HEAD:ao/task/root',
      'gh pr create --repo acme/payments --head ao/task/root --base main --title T1: Fix math --body Tally run run-1, task T1, attempt 1.\n\nBody\n\n\nRefs #7',
    ]);
  });
});
