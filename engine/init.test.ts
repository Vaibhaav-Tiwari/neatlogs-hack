import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { runInit, type InitCommandRunner } from './init.js';

describe('runInit', () => {
  it('detects repo defaults, registers AO with setup post-create, writes tally.yaml and runs doctor', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-repo-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'Makefile'), 'setup:\n\tuv sync\n\ntest:\n\tpytest\n');
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    let projectAdded = false;
    const command: InitCommandRunner = async (file, args, options) => {
      calls.push({ file, args, cwd: options?.cwd });
      const joined = `${file} ${args.join(' ')}`;
      if (joined === 'git rev-parse --show-toplevel') return { stdout: repo, stderr: '' };
      if (joined === 'git branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (joined === 'git remote get-url origin') return { stdout: 'git@github.com:acme/widgets.git\n', stderr: '' };
      if (joined === 'ao agent ls --refresh --json') return { stdout: JSON.stringify({ agents: [{ id: 'codex' }] }), stderr: '' };
      if (file === 'ao' && args[0] === 'project' && args[1] === 'get') {
        if (!projectAdded) throw new Error('missing project');
        return { stdout: JSON.stringify({ project: { config: {} } }), stderr: '' };
      }
      if (file === 'ao' && args[0] === 'project' && args[1] === 'add') {
        projectAdded = true;
        return { stdout: 'added', stderr: '' };
      }
      if (file === 'ao' && args[0] === 'project' && args[1] === 'set-config') return { stdout: JSON.stringify({ ok: true }), stderr: '' };
      throw new Error(`unexpected command: ${joined}`);
    };
    let prompt = 0;
    const answers = ['12.5', 'bug', 'y', 'y', 'n'];

    const result = await runInit({
      cwd: repo,
      command,
      readLine: async () => answers[prompt++]!,
      doctor: async () => [{ product: 'AO daemon', status: 'connected', detail: 'ok', fix: null }],
    });

    const config = parseYaml(readFileSync(result.configPath, 'utf8')) as Record<string, any>;
    expect(config.repo).toMatchObject({ path: '.', slug: 'acme/widgets', baseBranch: 'main', aoProject: result.projectId });
    expect(config.test).toMatchObject({ setupCommand: 'make setup', command: 'make test', timeoutSec: 900 });
    expect(config.backlog).toMatchObject({ source: 'github-issues', issueLabel: 'bug' });
    expect(config.budget).toMatchObject({ source: 'config', usd: 12.5 });
    expect(config.integrations).toMatchObject({ neatlogs: true, entire: true, cfoai: false, slack: false });
    expect(config.tiers.map((tier: { harness: string; sessionMode: string }) => `${tier.harness}:${tier.sessionMode}`)).toEqual(['codex:tui', 'codex:tui', 'codex:tui']);
    expect(calls.some((call) => call.file === 'ao' && call.args.join(' ') === `project add --path ${repo} --id ${result.projectId}`)).toBe(true);
    const setConfig = calls.find((call) => call.file === 'ao' && call.args[0] === 'project' && call.args[1] === 'set-config');
    expect(setConfig?.args).toContain(JSON.stringify({ postCreate: ['make setup'] }));
    expect(result.doctor[0]).toMatchObject({ product: 'AO daemon', status: 'connected' });
  });
});
