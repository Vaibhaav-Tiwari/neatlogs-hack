import { describe, expect, it } from 'vitest';
import { GitHubPublisher, replacePrEvidence, type PublishCommand } from './publisher.js';
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
  it('diffs the worker branch against its recorded attempt base, preserving unusual filenames', async () => {
    let diffArgs: string[] = [];
    const publisher = new GitHubPublisher(async (_file, args) => {
      diffArgs = args;
      return { stdout: 'src/space name.ts\0tests/a.ts\0', stderr: '' };
    });
    expect(await publisher.changedFiles({ checkoutPath: '/worker', branch: 'worker', config, baseCommit: 'fixed-sha' })).toEqual(['src/space name.ts', 'tests/a.ts']);
    expect(diffArgs).toEqual(['diff', '--name-only', '-z', '--end-of-options', 'fixed-sha', 'worker', '--']);
  });
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
      if (args.includes('push')) return { stdout: '', stderr: '' };
      return { stdout: 'https://github.com/acme/payments/pull/42', stderr: '' };
    });
    await publisher.publishPr({ checkoutPath: '/worker', branch: 'worker', config: { ...config, integrations: { ...config.integrations, entire: true } },
      task: { taskId: 'T1', title: 'Fix', body: '', issueNumber: null, issueUrl: null, size: 'small', outcomes: ['passed'] }, runId: 'r', attempt: 1 });
    expect(calls.filter((call) => call.includes('push'))).toEqual([
      ['git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '-u', 'origin', 'HEAD:worker'],
      ['git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', `${ref}:${ref}`],
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
    expect(calls.filter((call) => call.includes('push'))).toEqual([
      'git -c credential.helper= -c credential.helper=!gh auth git-credential push -u origin HEAD:worker',
    ]);
    expect(calls.some((call) => call.includes('for-each-ref'))).toBe(false);
  });
  it('counts commits ahead of the base branch and publishes a PR from Tally', async () => {
    const calls: Array<{ file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
    const command: PublishCommand = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd, env: options?.env });
      if (file === 'git' && args[0] === 'rev-list') return { stdout: '2\n', stderr: '' };
      if (file === 'git' && args.includes('push')) return { stdout: '', stderr: '' };
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
      'git -c credential.helper= -c credential.helper=!gh auth git-credential push -u origin HEAD:ao/task/root',
      'gh pr create --repo acme/payments --head ao/task/root --base main --title T1: Fix math --body Tally run run-1, task T1, attempt 1.\n\nBody\n\n\nCloses #7',
    ]);
    expect(calls[1]?.env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('adds verified integration links to an existing PR body without replacing its content', async () => {
    const calls: string[][] = [];
    const timeouts: Array<number | undefined> = [];
    const publisher = new GitHubPublisher(async (_file, args, options) => {
      calls.push(args);
      timeouts.push(options?.timeout);
      return { stdout: args[1] === 'view' ? 'Task details\n\nCloses #7\n' : '', stderr: '' };
    });
    await publisher.updatePrEvidence!({
      config,
      prUrl: 'https://github.com/acme/payments/pull/42',
      links: [
        { label: 'Entire session and checkpoint', url: 'https://entire.io/gh/acme/payments/session/session-1', note: 'checkpoint 01M4PROOF' },
        { label: 'Neatlogs worker trace', url: 'https://app.neatlogs.com/traces/0123456789abcdef0123456789abcdef' },
        { label: 'cfo.ai budget table', url: 'https://app.cfo.ai/s/budget' },
      ],
    });
    expect(calls[0]).toEqual(['pr', 'view', 'https://github.com/acme/payments/pull/42', '--repo', 'acme/payments', '--json', 'body', '-q', '.body']);
    expect(timeouts).toEqual([15_000, 15_000]);
    expect(calls[1]!.slice(0, 5)).toEqual(['pr', 'edit', 'https://github.com/acme/payments/pull/42', '--repo', 'acme/payments']);
    const body = calls[1]![calls[1]!.indexOf('--body') + 1]!;
    expect(body).toContain('Task details\n\nCloses #7');
    expect(body).toContain('[Entire session and checkpoint](https://entire.io/gh/acme/payments/session/session-1) — checkpoint 01M4PROOF');
    expect(body).toContain('[Neatlogs worker trace](https://app.neatlogs.com/traces/0123456789abcdef0123456789abcdef)');
    expect(body).toContain('[cfo.ai budget table](https://app.cfo.ai/s/budget)');
  });

  it('replaces a previous evidence block instead of duplicating it', () => {
    const first = replacePrEvidence('Task details', [{ label: 'First link', url: 'https://example.com/first' }]);
    const second = replacePrEvidence(first, [{ label: 'Updated link', url: 'https://example.com/updated' }]);
    expect(second.match(/tally-run-evidence:start/g)).toHaveLength(1);
    expect(second).toContain('[Updated link](https://example.com/updated)');
    expect(second).not.toContain('[First link]');
  });
});
