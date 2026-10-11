import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { defaultCommand, runInit, type InitCommandRunner } from './init.js';
import { installRecordPath } from './install-record.js';
import { aoClaudeSetupCommand } from './ao-claude-settings.js';
import { runUninstall } from './uninstall.js';

describe('runInit', () => {
  it('sets parallel AO slots only after opting in, and never offers parallel direct workers', async () => {
    for (const runner of ['ao', 'direct'] as const) {
      const repo = mkdtempSync(join(tmpdir(), 'tally-init-slots-'));
      const questions: string[] = [];
      const result = await runInit({ cwd: repo, command: detectedAgents(repo, ['codex']), runner, harnessChoice: 'codex',
        testCommand: 'true', setupCommand: '', budgetUsd: 1, issueLabel: 'tally',
        integrations: { neatlogs: false, entire: false, cfoai: false }, doctor: async () => [], onboarding: async () => undefined, print: () => {},
        readLine: async (question, fallback) => { questions.push(question); return question.startsWith('Maximum concurrent') ? '3' : question.startsWith('Run tasks') || question.startsWith('Apply these') ? 'y' : fallback ?? ''; } });
      expect(parseYaml(readFileSync(result.configPath, 'utf8')).concurrency).toBe(runner === 'ao' ? 3 : 1);
      expect(parseYaml(readFileSync(result.configPath, 'utf8')).parallelWorkers).toBe(runner === 'ao' ? 3 : 1);
      expect(questions.some(question => question.startsWith('Run tasks'))).toBe(runner === 'ao');
    }
  });
  it('requires Claude consent for mixed AO before integration connection or settings writes', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-mixed-gate-'));
    const onboarding = vi.fn(async () => undefined);
    const command = vi.fn(detectedAgents(repo, ['claude-code', 'codex']));
    await expect(runInit({ cwd: repo, command, runner: 'ao', harnessChoice: 'mixed', yes: true,
      testCommand: 'true', setupCommand: '', print: () => {}, onboarding })).rejects.toThrow('Claude Code allow-list was not approved');
    expect(onboarding).not.toHaveBeenCalled();
    expect(existsSync(join(repo, 'tally.yaml'))).toBe(false);
    expect(command.mock.calls.some(([, args]) => args[0] === 'project')).toBe(false);
  });
  it.each([false, true])('installs Claude AO prelaunch settings and restores ownership (doctor recovery: %s)', async recover => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-ao-claude-'));
    const original = { postCreate: ['echo existing'], worker: { agentConfig: { permissions: 'auto', effort: 'high' } }, env: { KEEP: 'yes' } };
    let project = structuredClone(original);
    const command: InitCommandRunner = async (file, args, options) => {
      if (file === 'ao' && args[0] === 'project' && args[1] === 'get') return { stdout: JSON.stringify({ project: { path: repo, config: project } }), stderr: '' };
      if (file === 'ao' && args[0] === 'project' && args[1] === 'set-config') { project = JSON.parse(args[args.indexOf('--config-json') + 1]!); return { stdout: '{}', stderr: '' }; }
      return detectedAgents(repo)(file, args, options);
    };
    let doctorCalls = 0;
    const options = { cwd: repo, runner: 'ao' as const, harnessChoice: 'claude-code' as const, command,
      doctor: async () => { doctorCalls += 1; if (recover && doctorCalls === 1) throw new Error('doctor interrupted'); return []; }, onboarding: async () => undefined,
      yes: true, allowClaude: true, testCommand: 'true | cat', setupCommand: 'echo setup', print: () => {} };
    if (recover) await expect(runInit(options)).rejects.toThrow('doctor interrupted');
    const result = await runInit(options);
    expect(project.worker.agentConfig).toEqual({ permissions: 'default', effort: 'high' });
    expect(project.postCreate).toEqual(['echo existing', aoClaudeSetupCommand(result.configPath)]);
    const ownership = JSON.parse(readFileSync(installRecordPath(result.configPath), 'utf8'));
    expect(ownership.workerPermissionMode).toBe('default');
    expect(ownership.aoHarnessPermissions).toEqual({ 'claude-code': 'default' });
    expect(ownership.addedSetupCommand).toBe(project.postCreate[1]);
    expect(project.env).toEqual(original.env);
    await runUninstall({ configPath: result.configPath, command, readLine: async () => 'y' });
    expect(project).toEqual(original);
  });
  it('records mixed harness modes and restores the original project after a Codex spawn mode switch', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-ao-mixed-'));
    const original = { worker: { agentConfig: { permissions: 'accept-edits', effort: 'high' } }, postCreate: ['user hook'] };
    let project = structuredClone(original);
    const command: InitCommandRunner = async (file, args, options) => {
      if (file === 'ao' && args[0] === 'project' && args[1] === 'get') return { stdout: JSON.stringify({ project: { config: project } }), stderr: '' };
      if (file === 'ao' && args[0] === 'project' && args[1] === 'set-config') { project = JSON.parse(args[args.indexOf('--config-json') + 1]!); return { stdout: '{}', stderr: '' }; }
      return detectedAgents(repo, ['claude-code', 'codex'])(file, args, options);
    };
    const result = await runInit({ cwd: repo, command, runner: 'ao', harnessChoice: 'mixed', yes: true, allowClaude: true,
      testCommand: 'true', setupCommand: '', doctor: async () => [], onboarding: async () => undefined, print: () => {} });
    const record = JSON.parse(readFileSync(installRecordPath(result.configPath), 'utf8'));
    expect(record.aoHarnessPermissions).toEqual({ codex: 'auto', 'claude-code': 'default' });
    project.worker.agentConfig.permissions = 'auto';
    await runUninstall({ configPath: result.configPath, command, readLine: async () => 'y' });
    expect(project).toEqual(original);
  });
  it('initializes a static repo non-interactively from flags and prints a compact summary', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-flags-'));
    const output: string[] = [];
    const readLine = vi.fn(async () => { throw new Error('unexpected prompt'); });
    const result = await runInit({ cwd: repo, command: detectedAgents(repo), doctor: async () => [], onboarding: async () => undefined,
      yes: true, allowClaude: true, testCommand: 'node --check js/app.js', setupCommand: '', budgetUsd: 5, issueLabel: 'ready',
      integrations: { neatlogs: false, entire: false, cfoai: false }, readLine, print: line => output.push(line) });
    expect(result.applied).toBe(true);
    expect(readLine).not.toHaveBeenCalled();
    const config = parseYaml(readFileSync(result.configPath, 'utf8'));
    expect(config.test).not.toHaveProperty('setupCommand');
    expect(config.budget.usd).toBe(5);
    expect(config.backlog.issueLabel).toBe('ready');
    expect(output.join('\n')).toContain('Test: node --check js/app.js');
    expect(output.join('\n')).not.toContain('priceNote:');
    expect(output.join('\n')).toContain('test script contents:\n#!/bin/sh\nset -e\nnode --check js/app.js\n');
    expect(config.claudeCode.allow.join(' ')).toContain('Bash({{tally.testScript:');
    expect(config.claudeCode.allow.join(' ')).not.toContain(repo);
    expect(config.claudeCode.allow).not.toContain('Bash(node --check js/app.js)');
  });
  it('shows full YAML only in verbose proposals', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-verbose-'));
    const output: string[] = [];
    await runInit({ cwd: repo, command: detectedAgents(repo), dryRun: true, testCommand: 'true', setupCommand: '', verbose: true, print: line => output.push(line) });
    expect(output.join('\n')).toContain('priceNote:');
  });
  function detectedAgents(repo: string, installed = ['claude-code']): InitCommandRunner {
    return async (file, args) => {
      if (file === 'claude' || file === 'codex') {
        if (!installed.includes(file === 'claude' ? 'claude-code' : 'codex')) throw new Error('not installed');
        return { stdout: file === 'claude' ? '{"loggedIn":true}' : 'Logged in using ChatGPT', stderr: '' };
      }
      if (file === 'git') return { stdout: args[0] === 'rev-parse' ? repo : args[0] === 'branch' ? 'main' : '', stderr: '' };
      if (args[0] === 'agent') return { stdout: JSON.stringify({ supported: [{ id: 'codex' }, { id: 'claude-code' }], installed: installed.map((id) => ({ id })) }), stderr: '' };
      if (args[1] === 'get') return { stdout: JSON.stringify({ project: { config: {} } }), stderr: '' };
      return { stdout: '{}', stderr: '' };
    };
  }

  it('re-consents legacy rules without changing other settings, and leaves everything untouched on refusal', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-script-consent-'));
    const options = { cwd: repo, command: detectedAgents(repo), doctor: async () => [], onboarding: async () => undefined,
      runner: 'direct' as const, harnessChoice: 'claude-code' as const, testCommand: 'node --check app.js', setupCommand: '',
      integrations: { neatlogs: false, entire: false, cfoai: false }, print: () => {} };
    const first = await runInit({ ...options, yes: true, allowClaude: true });
    const config = parseYaml(readFileSync(first.configPath, 'utf8'));
    config.claudeCode.allow = ['Edit(./**)', 'Write(./**)', 'Bash(node --check app.js)'];
    writeFileSync(first.configPath, stringifyYaml(config));
    const before = readFileSync(first.configPath, 'utf8');
    const recordPath = installRecordPath(first.configPath);
    const record = readFileSync(recordPath, 'utf8');
    await expect(runInit({ ...options, allowClaude: false })).rejects.toThrow('not approved');
    expect(readFileSync(first.configPath, 'utf8')).toBe(before);
    expect(readFileSync(recordPath, 'utf8')).toBe(record);
    const output: string[] = [];
    await runInit({ ...options, yes: true, allowClaude: true, print: line => output.push(line) });
    const updated = parseYaml(readFileSync(first.configPath, 'utf8'));
    expect(updated.claudeCode.allow.join(' ')).toContain('Bash({{tally.testScript:');
    expect({ ...updated, claudeCode: config.claudeCode }).toEqual(config);
    expect(output.join('\n')).toContain('test script contents:\n#!/bin/sh\nset -e\nnode --check app.js\n');
  });

  it('persists the cfo.ai onboarding proposal instead of a source without a config block', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-cfoai-'));
    writeFileSync(join(repo, 'Makefile'), 'test:\n\ttrue\n');
    const onboarding = vi.fn(async ({ config, ui }) => {
      expect(config.integrations.cfoai).toBe(true);
      expect(await ui.confirm('Connect')).toBe(true);
      config.budget = { source: 'cfoai', usd: 40, cfoai: { orgId: '42', scenario: 'Main Scenario',
        table: 'Tally agent budget', pageUrl: 'https://app.cfo.ai/s/discovered-page' } };
    });
    const questions: string[] = [];
    const result = await runInit({ cwd: repo, command: detectedAgents(repo), print: () => {}, doctor: async () => [], onboarding,
      readBudget: async () => ({ source: 'cfoai', monthlyLimitNanos: 40_000_000_000, limitNanos: 40_000_000_000, limitSource: 'cfoai' }),
      cfoaiCheck: async () => ({ status: 'ok', detail: 'fake connected' }),
      allowClaude: true,
      readLine: async (question, fallback) => { questions.push(question); return question.includes('fallback if') ? '5' : question === 'Enable cfo.ai budget integration? y/N' || question === 'Connect y/N' || question === 'Apply these changes? y/N' ? 'y' : fallback ?? ''; } });
    expect(onboarding).toHaveBeenCalledOnce();
    expect(parseYaml(readFileSync(result.configPath, 'utf8')).budget.cfoai.orgId).toBe('42');
    expect(parseYaml(readFileSync(result.configPath, 'utf8')).budget.usd).toBe(5);
    const budgetQuestion = questions.findIndex(question => question.includes('fallback if'));
    expect(questions[budgetQuestion]).toContain('$40.00 for this month');
    expect(budgetQuestion).toBeGreaterThan(questions.indexOf('Connect y/N'));
  });

  it('never connects or creates integration objects in dry-run init', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-cfoai-preview-'));
    writeFileSync(join(repo, 'Makefile'), 'test:\n\ttrue\n');
    const onboarding = vi.fn(async () => undefined);
    await runInit({ cwd: repo, command: detectedAgents(repo), print: () => {}, dryRun: true, onboarding,
      cfoaiCheck: async () => ({ status: 'ok', detail: 'fake connected' }),
      readLine: async (question, fallback) => question.startsWith('Enable cfo.ai') ? 'y' : fallback ?? '' });
    expect(onboarding).not.toHaveBeenCalled();
  });

  it.each(['interactive', 'yes'] as const)('does not invent a command or mutate an empty static repo: %s', async (mode) => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-static-'));
    writeFileSync(join(repo, 'index.html'), '<h1>Static site</h1>');
    const output: string[] = [];
    const command = vi.fn(detectedAgents(repo));
    const readLine = vi.fn(async () => '');
    await expect(runInit({ cwd: repo, command, readLine, doctor: async () => [], print: (line) => output.push(line), yes: mode === 'yes' })).rejects.toThrow('Tally cannot verify work without a test command');
    expect(output.join('\n')).toContain('No test command found');
    if (mode === 'interactive') expect(readLine).toHaveBeenCalledWith('Test command (shell command)', '');
    else expect(readLine).not.toHaveBeenCalled();
    expect(existsSync(join(repo, 'tally.yaml'))).toBe(false);
    expect(existsSync(installRecordPath(join(repo, 'tally.yaml')))).toBe(false);
    expect(command.mock.calls.some(([, args]) => args[0] === 'project')).toBe(false);
  });

  it('accepts explicit shell commands for a static repo and proposes only installed Claude tiers', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-explicit-'));
    const output: string[] = [];
    const result = await runInit({ cwd: repo, command: detectedAgents(repo), print: (line) => output.push(line), doctor: async () => [], allowClaude: true,
      readLine: async (question, fallback) => question === 'Test command (shell command)' ? 'test -f index.html && sh checks.sh' : question === 'Setup command (shell command; optional)' ? 'sh prepare.sh' : question === 'Apply these changes? y/N' ? 'y' : fallback ?? '' });
    const config = parseYaml(readFileSync(result.configPath, 'utf8'));
    expect(config.test.command).toBe('test -f index.html && sh checks.sh');
    expect(config.test.setupCommand).toBe('sh prepare.sh');
    expect(config.tiers.every((tier: { harness: string }) => tier.harness === 'claude-code')).toBe(true);
    expect(output.join('\n')).toContain('codex is not installed');
    expect(output.join('\n')).toContain('No setup command found');
  });

  it.each([
    ['package.json', '{"scripts":{"test":"node --test"}}', 'npm test'],
    ['Makefile', 'test :\n\ttrue\n', 'make test'],
    ['pyproject.toml', '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n', 'pytest'],
    ['pytest.ini', '[pytest]\n', 'pytest'],
    ['Cargo.toml', '[package]\nname = "example"\n', 'cargo test'],
    ['go.mod', 'module example.com/test\n', 'go test ./...'],
  ])('detects tests from %s evidence', async (file, content, expected) => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-detect-'));
    writeFileSync(join(repo, file), content);
    const result = await runInit({ cwd: repo, command: detectedAgents(repo), dryRun: true, print: () => {} });
    expect(result.testCommand).toBe(expected);
    expect(result.setupCommand).toBeNull();
    expect(result.applied).toBe(false);
  });

  it.each([
    ['pyproject.toml', '[project]\nname = "no-tests"\n'],
    ['package.json', '{"scripts":{"test":"  "}}'],
    ['package-lock.json', '{}'],
  ])('does not guess tests from insufficient evidence in %s', async (file, content) => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-no-evidence-'));
    writeFileSync(join(repo, file), content);
    await expect(runInit({ cwd: repo, command: detectedAgents(repo), doctor: async () => [], yes: true, print: () => {} })).rejects.toThrow('Tally cannot verify work without a test command');
  });

  it('refuses to propose an absent supported agent when none is installed', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-no-agent-'));
    writeFileSync(join(repo, 'Makefile'), 'test:\n\ttrue\n');
    await expect(runInit({ cwd: repo, command: detectedAgents(repo, []), doctor: async () => [], yes: true, print: () => {} })).rejects.toThrow('No installed and signed-in Codex or Claude Code');
    expect(existsSync(join(repo, 'tally.yaml'))).toBe(false);
  });

  it.each(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock'])('does not invent setup from an orphaned %s', async (lock) => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-orphan-lock-'));
    writeFileSync(join(repo, 'Makefile'), 'test:\n\ttrue\n');
    writeFileSync(join(repo, lock), '{}');
    const result = await runInit({ cwd: repo, command: detectedAgents(repo), dryRun: true, print: () => {} });
    expect(result.setupCommand).toBeNull();
  });

  it('allows an explicitly supplied test without inventing optional setup', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-no-setup-'));
    const result = await runInit({ cwd: repo, command: detectedAgents(repo), print: () => {}, doctor: async () => [], allowClaude: true,
      readLine: async (question, fallback) => question === 'Test command (shell command)' ? 'sh checks.sh' : question === 'Apply these changes? y/N' ? 'y' : fallback ?? '' });
    expect(result.setupCommand).toBeNull();
    expect(parseYaml(readFileSync(result.configPath, 'utf8')).test).not.toHaveProperty('setupCommand');
  });
  it.each(['decline', 'dry-run', 'yes'] as const)('shows the full summary before mutation: %s', async (mode) => {
    const repo = mkdtempSync(join(tmpdir(), 'tally-init-consent-'));
    writeFileSync(join(repo, 'Makefile'), 'setup:\n\ttrue\ntest:\n\ttrue\n');
    const printed: string[] = [];
    const mutations: string[] = [];
    let confirmations = 0;
    const command: InitCommandRunner = async (file, args) => {
      if (file === 'claude') throw new Error('not installed');
      if (file === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '' };
      if (file === 'git') return { stdout: args[0] === 'rev-parse' ? repo : args[0] === 'branch' ? 'main' : '', stderr: '' };
      if (args[0] === 'agent') return { stdout: JSON.stringify({ installed: [{ id: 'codex' }] }), stderr: '' };
      if (args[0] === 'status' || args[0] === '--version' || file === 'gh') return { stdout: 'ok', stderr: '' };
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
      if (file === 'claude') throw new Error('not installed');
      if (file === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '' };
      if (joined === 'ao --version') return { stdout: 'ao test', stderr: '' };
      if (joined === 'git rev-parse --show-toplevel') return { stdout: repo, stderr: '' };
      if (joined === 'git branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (joined === 'git remote get-url origin') return { stdout: 'git@github.com:acme/widgets.git\n', stderr: '' };
      if (joined === 'git --version') return { stdout: 'git version test', stderr: '' };
      if (joined === 'ao agent ls --refresh --json') return { stdout: JSON.stringify({ installed: [{ id: 'codex' }] }), stderr: '' };
      if (joined === 'ao status' || file === 'gh') return { stdout: 'ok', stderr: '' };
      if (file === 'entire') return { stdout: args[0] === 'status' ? '{"enabled":true}' : 'ok', stderr: '' };
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
    const answers = ['bug', 'y', 'y', 'n', 'n', '12.5', 'y'];

    const result = await runInit({
      cwd: repo,
      command,
      print: () => {},
      onboarding: async () => undefined,
      env: { NEATLOGS_API_KEY: 'fake-test-key' },
      readLine: async (question, fallback) => question.startsWith('Runner:') || question.startsWith('Coding agents:') ? fallback ?? '' : answers[prompt++]!,
      doctor: async () => [{ product: 'AO daemon', status: 'connected', detail: 'ok', fix: null }],
    });

    const config = parseYaml(readFileSync(result.configPath, 'utf8')) as Record<string, any>;
    expect(config.repo).toMatchObject({ path: '.', slug: 'acme/widgets', baseBranch: 'main', aoProject: result.projectId });
    expect(config.test).toMatchObject({ setupCommand: 'make setup', command: 'make test', timeoutSec: 900 });
    expect(config.backlog).toMatchObject({ source: 'github-issues', issueLabel: 'bug' });
    expect(config.budget).toMatchObject({ source: 'config', usd: 12.5 });
    expect(config.concurrency).toBe(1);
    expect(config.integrations).toMatchObject({ neatlogs: true, entire: true, cfoai: false, slack: false });
    expect(config.tiers.map((tier: { harness: string; sessionMode: string }) => `${tier.harness}:${tier.sessionMode}`)).toEqual(['codex:tui', 'codex:tui', 'codex:tui']);
    expect(config.tiers.map((tier: { price: unknown }) => tier.price)).toEqual([
      { inputUsdPerMTok: 0.2, cachedInputUsdPerMTok: 0.02, outputUsdPerMTok: 1.2 },
      { inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.2, outputUsdPerMTok: 12 },
      { inputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.4, outputUsdPerMTok: 20 },
    ]);
    expect(config.tiers.every((tier: { priceNote: string }) => tier.priceNote.includes('Verified base list price'))).toBe(true);
    expect(calls.some((call) => call.file === 'ao' && call.args.join(' ') === `project add --path ${repo} --id ${result.projectId}`)).toBe(true);
    const setConfig = calls.find((call) => call.file === 'ao' && call.args[0] === 'project' && call.args[1] === 'set-config');
    expect(setConfig?.args).toContain(JSON.stringify({ worker: { agentConfig: { permissions: 'auto' } }, postCreate: ['make setup'] }));
    expect(result.doctor[0]).toMatchObject({ product: 'AO daemon', status: 'connected' });
    expect(JSON.parse(readFileSync(installRecordPath(result.configPath), 'utf8'))).toMatchObject({ projectCreated: true, addedSetupCommand: 'make setup', version: 1 });
    expect((await runInit({ cwd: repo, command, yes: true, print: () => {} })).applied).toBe(false);
  });
});
