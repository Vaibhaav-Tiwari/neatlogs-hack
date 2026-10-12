import { describe, expect, it } from 'vitest';
import type { TallyConfig } from '../schema/index.js';
import { CommandVerifier, EntireGraphVerifier, parseEntireVerifyVerdict } from './verifier.js';

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

describe('parseEntireVerifyVerdict', () => {
  it('fails only on newly failing tests and includes the delta lists', () => {
    expect(
      parseEntireVerifyVerdict(
        JSON.stringify({
          newly_failing: ['tests/refund.test.ts::rejects negative refunds'],
          newly_passing: ['tests/parser.test.ts::handles escaped strings'],
          pre_existing: ['tests/flaky.test.ts::already bad'],
        }),
        1,
      ),
    ).toEqual({
      passed: false,
      reason:
        'newly failing tests: tests/refund.test.ts::rejects negative refunds; newly passing tests: tests/parser.test.ts::handles escaped strings; pre-existing failing tests: tests/flaky.test.ts::already bad',
    });
  });

  it('passes with a reason when only newly passing or pre-existing failures are reported', () => {
    expect(parseEntireVerifyVerdict('NEWLY PASSING: test A\nPRE-EXISTING: test B\nNEWLY FAILING: 0\n', 1)).toEqual({
      passed: true,
      reason: 'newly passing tests: test A; pre-existing failing tests: test B',
    });
  });
});

describe('EntireGraphVerifier', () => {
  it('records a baseline on the repo and verifies the worker checkout against it', async () => {
    const calls: Array<{ args: string[]; cwd: string | undefined }> = [];
    const verifier = new EntireGraphVerifier(
      new CommandVerifier(async () => {
        throw new Error('fallback should not run');
      }),
      async (args, options) => {
        calls.push({ args, cwd: options.cwd });
        if (args.includes('--record-baseline')) return { stdout: 'baseline recorded', stderr: '', code: 0 };
        return { stdout: JSON.stringify({ newly_passing: ['tests/new.test.ts::works'], newly_failing: [] }), stderr: '', code: 0 };
      },
    );

    await expect(verifier.verify({ checkoutPath: '/tmp/task-1', branch: 'tally/task-1', repoPath: '/repo', config })).resolves.toEqual({
      passed: true,
      reason: 'newly passing tests: tests/new.test.ts::works',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args.slice(0, 6)).toEqual(['graph', 'verify', '--repo', '/repo', '--test', 'npm test']);
    expect(calls[0]?.args).toContain('--record-baseline');
    expect(calls[1]?.args.slice(0, 6)).toEqual(['graph', 'verify', '--repo', '/tmp/task-1', '--test', 'npm test']);
    expect(calls[1]?.args).toContain('--pre-edit-baseline');
  });

  it('reports a failed baseline recording command separately from a passing candidate', async () => {
    const verifier = new EntireGraphVerifier(
      new CommandVerifier(async () => { throw new Error('fallback should not run'); }),
      async args => args.includes('--record-baseline')
        ? { stdout: 'baseline test failed once', stderr: '', code: 1 }
        : { stdout: JSON.stringify({ newly_failing: [], newly_passing: [], pre_existing: [] }), stderr: '', code: 0 },
    );

    const result = await verifier.verify({ checkoutPath: '/tmp/task-1', repoPath: '/repo', config });
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('Entire baseline recording command exited with code 1');
  });

  it('fails when Entire reports a candidate-only regression against a recorded baseline', async () => {
    const verifier = new EntireGraphVerifier(
      new CommandVerifier(async () => { throw new Error('fallback should not run'); }),
      async args => args.includes('--record-baseline')
        ? { stdout: 'baseline recorded', stderr: '', code: 0 }
        : { stdout: JSON.stringify({ newly_failing: ['tests/refund.test.ts'], pre_existing: [] }), stderr: '', code: 1 },
    );

    await expect(verifier.verify({ checkoutPath: '/tmp/task-1', repoPath: '/repo', config })).resolves.toEqual({
      passed: false,
      reason: 'newly failing tests: tests/refund.test.ts',
    });
  });

  it('falls back to the command verifier when Entire is not installed', async () => {
    const fallback = new CommandVerifier(async () => ({ stdout: '', stderr: '' }));
    const verifier = new EntireGraphVerifier(fallback, async () => ({ stdout: '', stderr: 'entire: command not found', code: 127 }));

    await expect(verifier.verify({ checkoutPath: '/tmp/task-1', repoPath: '/repo', config })).resolves.toEqual({
      passed: true,
      reason: null,
    });
  });
});
