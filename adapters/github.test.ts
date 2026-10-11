import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TallyConfig } from '../schema/index.js';
import { ConfigBacklogIntake, GithubIssueIntake } from './github.js';
import { CommandError } from './command.js';

const baseConfig: TallyConfig = {
  version: 1,
  repo: { path: '.', slug: 'acme/payments', baseBranch: 'main' },
  test: { command: 'npm test' },
  backlog: { source: 'github-issues', issueLabel: 'tally' },
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

describe('GithubIssueIntake', () => {
  it('reads labeled GitHub issues through gh', async () => {
    const calls: string[][] = [];
    const intake = new GithubIssueIntake(async (_file, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify(args[0] === 'pr' ? [] : [{ number: 12, title: 'Fix bug', body: 'Expected behavior', url: 'https://github.com/acme/payments/issues/12' }]),
        stderr: '',
      };
    });

    await expect(intake.tasks(baseConfig, 'tally.yaml')).resolves.toMatchObject([
      { taskId: '#12', title: 'Fix bug', issueNumber: 12, size: 'medium' },
    ]);
    expect(calls[0]).toContain('acme/payments');
    expect(calls[0]).toContain('tally');
    expect(calls[1]).toContain('closingIssuesReferences');
  });

  it('excludes issues that already have an open closing PR, but not cross-repository number matches', async () => {
    const issues = [4, 6, 9].map(number => ({ number, title: `Task ${number}`, url: `https://github.com/acme/payments/issues/${number}` }));
    const intake = new GithubIssueIntake(async (_file, args) => ({
      stdout: JSON.stringify(args[0] === 'issue' ? issues : [
        { number: 7, closingIssuesReferences: [{ url: issues[1]!.url }] },
        { number: 8, closingIssuesReferences: [{ url: issues[0]!.url }] },
        { number: 10, closingIssuesReferences: [{ url: 'https://github.com/other/repo/issues/9' }] },
      ]), stderr: '',
    }));
    await expect(intake.tasks(baseConfig, 'tally.yaml')).resolves.toMatchObject([{ taskId: '#9' }]);
  });

  it('does not query PRs when no issues match the label', async () => {
    const calls: string[][] = [];
    const intake = new GithubIssueIntake(async (_file, args) => {
      calls.push(args);
      return { stdout: '[]', stderr: '' };
    });
    await expect(intake.tasks(baseConfig, 'tally.yaml')).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reports the actual GitHub failure and exact read-only command without credentials or a stack', async () => {
    const intake = new GithubIssueIntake(async () => {
      throw new CommandError('gh command failed (1)', 1, '', 'GraphQL: API rate limit exceeded\nAuthorization: Bearer github_pat_secret123\n');
    });
    await expect(intake.tasks(baseConfig, 'tally.yaml')).rejects.toThrow('API rate limit exceeded');
    await expect(intake.tasks(baseConfig, 'tally.yaml')).rejects.toThrow("gh issue list --repo 'acme/payments' --label tally");
    await expect(intake.tasks(baseConfig, 'tally.yaml')).rejects.not.toThrow('github_pat_secret123');
  });

  it('fails closed if open-PR discovery fails instead of redoing existing work', async () => {
    const intake = new GithubIssueIntake(async (_file, args) => {
      if (args[0] === 'pr') throw new CommandError('gh command failed (1)', 1, '', 'Could not resolve host: api.github.com');
      return { stdout: JSON.stringify([{ number: 4, title: 'README', url: 'https://github.com/acme/payments/issues/4' }]), stderr: '' };
    });
    await expect(intake.tasks(baseConfig, 'tally.yaml')).rejects.toThrow('Could not resolve host: api.github.com');
    await expect(intake.tasks(baseConfig, 'tally.yaml')).rejects.toThrow("gh pr list --repo 'acme/payments'");
  });

  it('returns no tasks when every labeled issue has an open closing PR', async () => {
    const url = 'https://github.com/acme/payments/issues/4';
    const intake = new GithubIssueIntake(async (_file, args) => ({
      stdout: JSON.stringify(args[0] === 'issue' ? [{ number: 4, title: 'README', url }] : [{ closingIssuesReferences: [{ url }] }]), stderr: '',
    }));
    await expect(intake.tasks(baseConfig, 'tally.yaml')).resolves.toEqual([]);
  });

  it('refuses a truncated PR list instead of assuming an issue has no PR', async () => {
    const intake = new GithubIssueIntake(async (_file, args) => ({
      stdout: JSON.stringify(args[0] === 'issue' ? [{ number: 4, title: 'README', url: 'https://github.com/acme/payments/issues/4' }] : Array.from({ length: 1000 }, () => ({ closingIssuesReferences: [] }))), stderr: '',
    }));
    await expect(intake.tasks(baseConfig, 'tally.yaml')).rejects.toThrow('1000 open-PR safety limit');
  });
});

describe('ConfigBacklogIntake', () => {
  it('uses the YAML fallback when configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-intake-'));
    writeFileSync(join(dir, 'backlog.yaml'), 'tasks:\n  - id: T1\n    title: Local task\n    size: small\n');
    const intake = new ConfigBacklogIntake();
    const config: TallyConfig = { ...baseConfig, backlog: { source: 'file', file: 'backlog.yaml' } };

    await expect(intake.tasks(config, join(dir, 'tally.yaml'))).resolves.toMatchObject([{ taskId: 'T1', size: 'small' }]);
  });
});
