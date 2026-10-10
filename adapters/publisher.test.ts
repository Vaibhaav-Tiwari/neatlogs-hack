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
  it('reads NUL-separated changed paths and includes scope warnings in the PR', async () => {
    let body = '';
    const publisher = new GitHubPublisher(async (file, args) => {
      if (file === 'git' && args[0] === 'diff') return { stdout: 'src/file.ts\0vercel.json\0', stderr: '' };
      if (file === 'gh') body = args[args.indexOf('--body') + 1]!;
      return { stdout: 'https://github.com/acme/payments/pull/1', stderr: '' };
    });
    const input = { checkoutPath: '/tmp/worktree', branch: 'task', config };
    expect(await publisher.changedFiles(input)).toEqual(['src/file.ts', 'vercel.json']);
    await publisher.publishPr({ ...input, task: { taskId: 'T1', title: 'Fix replay', body: '', issueNumber: null, issueUrl: null, size: 'small', outcomes: ['passed'] }, runId: 'run', attempt: 1, scopeWarnings: ['vercel.json'] });
    expect(body).toContain('Scope warning: out-of-scope changes: vercel.json');
  });
  it.each([false, true])('pushes only task checkpoint refs to origin and optional Entire remote (%s)', async (entireRemote) => {
    const calls: string[][] = [];
    const ref = 'refs/entire/checkpoints/VN/01M4PROOF';
    const publisher = new GitHubPublisher(async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'log') return { stdout: 'task\nEntire-Checkpoint: 01M4PROOF\n', stderr: '' };
      if (args[0] === 'for-each-ref') return { stdout: `${ref}\nrefs/entire/checkpoints/XX/OTHER\n`, stderr: '' };
      if (args[0] === 'remote') return { stdout: `origin\n${entireRemote ? 'entire\n' : ''}`, stderr: '' };
      if (args[0] === 'push') return { stdout: '', stderr: '' };
      return { stdout: 'https://github.com/acme/payments/pull/42', stderr: '' };
    });
    await publisher.publishPr({ checkoutPath: '/worker', branch: 'worker', config: { ...config, integrations: { ...config.integrations, entire: true } },
      task: { taskId: 'T1', title: 'Fix', body: '', issueNumber: null, issueUrl: null, size: 'small', outcomes: ['passed'] }, runId: 'r', attempt: 1 });
    expect(calls.filter((call) => call[1] === 'push')).toEqual([
      ['git', 'push', '-u', 'origin', 'HEAD:worker'],
      ['git', 'push', 'origin', `${ref}:${ref}`],
      ...(entireRemote ? [['git', 'push', 'entire', `${ref}:${ref}`]] : []),
    ]);
  });

  it('surfaces missing checkpoint refs instead of opening a PR without its evidence', async () => {
    let opened = false;
    const publisher = new GitHubPublisher(async (file, args) => {
      if (file === 'gh') opened = true;
      return { stdout: args[0] === 'log' ? 'Entire-Checkpoint: 01M4MISSING\n' : '', stderr: '' };
    });
    await expect(publisher.publishPr({ checkoutPath: '/worker', branch: 'worker', config: { ...config, integrations: { ...config.integrations, entire: true } },
      task: { taskId: 'T1', title: 'Fix', body: '', issueNumber: null, issueUrl: null, size: 'small', outcomes: ['passed'] }, runId: 'r', attempt: 1 })).rejects.toThrow('checkpoint ref missing');
    expect(opened).toBe(false);
  });

  it('does not upload unrelated refs when the task has no checkpoint trailer', async () => {
    const calls: string[] = [];
    const publisher = new GitHubPublisher(async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return { stdout: args[0] === 'log' ? 'ordinary commit\n' : 'https://github.com/acme/payments/pull/42', stderr: '' };
    });
    await publisher.publishPr({ checkoutPath: '/worker', branch: 'worker', config: { ...config, integrations: { ...config.integrations, entire: true } },
      task: { taskId: 'T1', title: 'Fix', body: '', issueNumber: null, issueUrl: null, size: 'small', outcomes: ['passed'] }, runId: 'r', attempt: 1 });
    expect(calls.filter((call) => call.startsWith('git push'))).toEqual(['git push -u origin HEAD:worker']);
    expect(calls.some((call) => call.includes('for-each-ref'))).toBe(false);
  });
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
