import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { defaultCommand, runInit, type InitCommandRunner } from './init.js';
import { installRecordPath } from './install-record.js';

describe('runInit', () => {
  it.each(['decline', 'dry-run', 'yes'] as const)('shows the full summary before mutation: %s', async (mode) => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-consent-'));
    writeFileSync(join(repo, 'Makefile'), 'setup:\n\ttrue\ntest:\n\ttrue\n');
    const printed: string[] = [];
    const mutations: string[] = [];
    let confirmations = 0;
    const command: InitCommandRunner = async (file, args) => {
      if (file === 'git') return { stdout: args[0] === 'rev-parse' ? repo : args[0] === 'branch' ? 'main' : '', stderr: '' };
      if (args[0] === 'agent') return { stdout: '[]', stderr: '' };
      if (args[1] === 'get') return { stdout: JSON.stringify({ project: { config: { postCreate: ['echo preserved'], worker: { agentConfig: { permissions: 'default' } } } } }), stderr: '' };
      expect(printed.join('\n')).toContain('Requested worker rules (not yet enforced)');
      expect(printed.join('\n')).toContain('git add and git commit');
      expect(printed.join('\n')).toContain('["echo preserved","make setup"]');
      mutations.push(args[1]!);
      return { stdout: '{}', stderr: '' };
    };
    const doctor = vi.fn(async () => []);
    const result = await runInit({ cwd: repo, command, print: (line) => printed.push(line), doctor, yes: mode === 'yes', dryRun: mode === 'dry-run',
      readLine: async (question, fallback) => {
        if (question === 'Apply these changes? y/N') { confirmations += 1; expect(fallback).toBe('N'); return ''; }
        return fallback ?? '';
      } });
    expect(result.applied).toBe(mode === 'yes');
    expect(confirmations).toBe(mode === 'decline' ? 1 : 0);
    expect(existsSync(join(repo, 'tally.yaml'))).toBe(mode === 'yes');
    expect(existsSync(installRecordPath(join(repo, 'tally.yaml')))).toBe(mode === 'yes');
    expect(mutations).toEqual(mode === 'yes' ? ['set-config'] : []);
    expect(doctor).toHaveBeenCalledTimes(mode === 'yes' ? 1 : 0);
  });
  it('preserves fields absent from the AO CLI config mirror through the daemon API', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const config = { worker: { agentConfig: { effort: 'high', permissions: 'default' } }, env: { KEEP: 'value' } };
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      requests.push({ url, body: options.body as string | undefined });
      return { ok: true, json: async () => ({ project: { config } }) };
    });
    try {
      const read = await defaultCommand('ao', ['project', 'get', 'test', '--json']);
      const next = { ...JSON.parse(read.stdout).project.config, postCreate: ['make setup'] };
      await defaultCommand('ao', ['project', 'set-config', 'test', '--config-json', JSON.stringify(next), '--json']);
      expect(JSON.parse(requests[1]!.body!).config.worker.agentConfig.effort).toBe('high');
    } finally { vi.unstubAllGlobals(); }
  });
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
    const answers = ['12.5', 'bug', 'y', 'y', 'n', 'y'];

    const result = await runInit({
      cwd: repo,
      command,
      print: () => {},
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
    expect(JSON.parse(readFileSync(installRecordPath(result.configPath), 'utf8'))).toMatchObject({ projectCreated: true, addedSetupCommand: 'make setup', version: 1 });
    await expect(runInit({ cwd: repo, command, readLine: async () => { throw new Error('must not prompt'); } })).rejects.toThrow('will not overwrite');
  });
});
