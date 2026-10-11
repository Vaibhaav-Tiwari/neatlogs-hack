import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { DirectRunner, type DirectRunnerOptions } from '../adapters/direct.js';
import { runCommand } from '../adapters/command.js';
import { GitHubPublisher } from '../adapters/publisher.js';
import { PriceHistory } from '../agent/history.js';
import type { TallyConfig } from '../schema/index.js';
import { runRealTally } from './real.js';
import { claudeAllowList } from './harness.js';

describe('direct runner through the real loop', () => {
  it.each([true, false])('independently verifies recovered denials after same-branch escalation (tests pass: %s)', async testsPass => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-direct-loop-'));
    const git = (args: string[], cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(['init', '-b', 'main']);
    writeFileSync(join(dir, 'calc.js'), 'export const add = (a, b) => a - b;\n');
    git(['add', '.']);
    git(['-c', 'user.name=Tally Test', '-c', 'user.email=tally-test@example.invalid', 'commit', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    const config: TallyConfig = {
      runner: 'direct', version: 1, repo: { path: dir, slug: 'acme/calc', baseBranch: 'main' },
      claudeCode: { allow: claudeAllowList({ command: 'node --check calc.js' }) },
      test: { command: 'node --check calc.js' }, backlog: { source: 'file', file: 'backlog.yaml' },
      tiers: ['cheap', 'middle', 'top'].map((name, i) => ({ name, harness: 'claude-code', model: name, provider: 'anthropic', ceilingFraction: [0.2, 0.5, 1][i]!, price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 5 } })),
      ceilings: { bySizeUsd: { small: 1, medium: 2, large: 3 } }, budget: { source: 'config', usd: 2 },
      integrations: { neatlogs: false, entire: false, cfoai: false, slack: false },
    };
    const configPath = join(dir, 'tally.yaml'); writeFileSync(configPath, stringify(config));
    const children: Array<EventEmitter & { pid: number }> = [];
    const paths: string[] = [], branches: string[] = [];
    const command: DirectRunnerOptions['command'] = (file, args, options) => file === 'claude' ? Promise.resolve({ stdout: '{"loggedIn":true}', stderr: '' }) : runCommand(file, file === 'git' && args[0] === 'commit' ? ['-c', 'user.name=Tally Test', '-c', 'user.email=tally-test@example.invalid', ...args] : args, options);
    const runner = new DirectRunner({ repoPath: dir, baseBranch: 'main', requiredBaseCommit: base, test: config.test, approvedRules: config.claudeCode!.allow, command,
      launch: (_file, args, options) => {
        const child = Object.assign(new EventEmitter(), { pid: 10000 + children.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        children.push(child); paths.push(options.cwd); branches.push(git(['branch', '--show-current'], options.cwd));
        child.stdin.once('finish', () => {
          const scriptRule = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')).find(rule => rule.endsWith('-test.sh)'))!;
          const scriptPath = scriptRule.slice(5, -1);
          expect(scriptPath.startsWith(options.cwd + '/')).toBe(false);
          expect(readFileSync(scriptPath, 'utf8')).toBe('#!/bin/sh\nset -e\nnode --check calc.js\n');
          const prompt = child.stdin.read().toString();
          expect(prompt).toContain(`run exactly ${scriptPath} first, before making edits`);
          expect(prompt.indexOf(scriptPath)).toBeLessThan(prompt.indexOf('calc.js should return'));
          if (children.length === 1) {
            writeFileSync(join(options.cwd, 'calc.js'), 'export const add = (a, b) => a + b;\n');
            child.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { input_tokens: 1000, output_tokens: 10 } } }) + '\n');
          } else {
            expect(git(['log', '-1', '--format=%s'], options.cwd)).toBe('wip: preserve Tally ceiling-stopped task edits');
            writeFileSync(join(options.cwd, 'calc.js'), readFileSync(join(options.cwd, 'calc.js'), 'utf8') + '// continued from the first attempt\n');
            git(['add', 'calc.js'], options.cwd);
            git(['-c', 'user.name=Tally Test', '-c', 'user.email=tally-test@example.invalid', 'commit', '-m', 'fix add'], options.cwd);
            child.stdout.write(JSON.stringify({ type: 'result', is_error: false, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'raw test pipeline' } }], usage: { input_tokens: 200, output_tokens: 10 } }) + '\n');
            queueMicrotask(() => child.emit('close', 0, null));
          }
        });
        queueMicrotask(() => child.emit('spawn'));
        return child as unknown as ChildProcessWithoutNullStreams;
      }, signal: pid => children.find(child => child.pid === -pid)?.emit('close', null, 'SIGTERM'),
    });
    const publisher = new GitHubPublisher();
    let publishedBranch: string | undefined;
    try {
      const result = await runRealTally({ configPath, outputDir: join(dir, 'runs', 'test'), latestRunDir: join(dir, 'runs', 'latest'), dryRun: false, baseline: false, requiredBaseCommit: base,
        ports: { worker: runner, usage: runner, sessions: runner, history: new PriceHistory(),
          intake: { tasks: async () => [{ taskId: 'T1', title: 'Fix add in calc.js', body: 'calc.js should return a + b, with existing tests.', issueNumber: null, issueUrl: null, size: 'small', outcomes: [], firstAttemptCeilingUsd: 0.001 }] },
          signals: { signalsFor: async () => ({ filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' }) },
          worktrees: { checkoutPathFor: async () => paths[0]!, commitFor: async () => base,
            commitWorkInProgress: async () => { git(['add', '-A'], paths[0]); git(['-c', 'user.name=Tally Test', '-c', 'user.email=tally-test@example.invalid', 'commit', '-m', 'wip: preserve Tally ceiling-stopped task edits'], paths[0]); return git(['rev-parse', 'HEAD'], paths[0]); } },
          publisher: { commitsAhead: input => publisher.commitsAhead(input), changedFiles: input => publisher.changedFiles(input),
            publishPr: async input => { publishedBranch = input.branch; expect(git(['rev-list', '--count', `${base}..HEAD`], input.checkoutPath)).toBe('2'); return 'https://github.com/acme/calc/pull/1'; } },
          verifier: { verify: async input => { await runCommand('node', ['--check', 'calc.js'], { cwd: input.checkoutPath! }); return { passed: testsPass, reason: testsPass ? 'syntax passed' : 'verification failed' }; } },
        },
      });
      expect(result.ledger.map(row => row.result)).toEqual(['stopped', testsPass ? 'passed' : 'failed']);
      expect(result.ledger[0]?.resultReason).toContain('work in progress committed');
      expect(result.ledger[1]?.prUrl).toBe(testsPass ? 'https://github.com/acme/calc/pull/1' : null);
      expect(result.ledger[1]?.permissionWarnings).toEqual(['permission denied for Bash: raw test pipeline']);
      expect(result.ledger[1]?.resultReason).toContain('warning: permission denied for Bash: raw test pipeline');
      expect(paths[0]).toBe(paths[1]); expect(branches[0]).toBe(branches[1]); expect(publishedBranch).toBe(testsPass ? branches[0] : undefined);
      expect(result.ledger.every(row => row.estimatedCostNanos > 0)).toBe(true);
      expect(existsSync(paths[0]!)).toBe(!testsPass);
    } finally {
      for (const path of new Set(paths)) if (existsSync(path)) {
        git(['worktree', 'remove', '--force', path]);
        rmSync(join(path, '..'), { recursive: true, force: true });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
