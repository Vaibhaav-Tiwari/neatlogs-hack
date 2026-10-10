import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TallyConfig } from '../schema/index.js';
import { ConfigBacklogIntake, GithubIssueIntake } from './github.js';

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
        stdout: JSON.stringify([{ number: 12, title: 'Fix bug', body: 'Expected behavior', url: 'https://github.com/acme/payments/issues/12' }]),
        stderr: '',
      };
    });

    await expect(intake.tasks(baseConfig, 'tally.yaml')).resolves.toMatchObject([
      { taskId: '#12', title: 'Fix bug', issueNumber: 12, size: 'medium' },
    ]);
    expect(calls[0]).toContain('acme/payments');
    expect(calls[0]).toContain('tally');
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
