import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { contentHash, installRecordPath } from './install-record.js';
import { runInit, type InitCommandRunner } from './init.js';
import { reinitPath } from './reinit.js';
import { claudeAllowList } from './harness.js';
import type { OnboardingContext } from '../onboarding/types.js';

function fixture(owned = true) {
  const cwd = mkdtempSync(join(tmpdir(), 'tally-reinit-'));
  const path = join(cwd, 'tally.yaml');
  const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
  config.repo.path = '.';
  config.repo.aoProject = 'preserved-project';
  config.test.command = 'sh custom-check.sh';
  config.claudeCode = { allow: claudeAllowList(config.test) };
  config.budget.usd = 17;
  writeFileSync(path, stringify(config));
  const record = { version: 1, configPath: path, configHash: contentHash(readFileSync(path, 'utf8')), projectId: 'preserved-project', projectCreated: false,
    projectConfigHash: 'unchanged', postCreateExisted: true, postCreateAfterHash: 'unchanged', addedSetupCommand: 'sh custom-setup.sh' };
  if (owned) { mkdirSync(join(cwd, '.tally')); writeFileSync(installRecordPath(path), JSON.stringify(record, null, 2)); }
  const commands: string[] = [];
  const command: InitCommandRunner = async (file, args) => {
    commands.push(`${file} ${args.join(' ')}`);
    if (file === 'claude') return { stdout: '{"loggedIn":true}', stderr: '' };
    if (file === 'ao' && args[0] === 'status') return { stdout: '{"state":"running"}', stderr: '' };
    if (file === 'ao' && args[0] === 'project' && args[1] === 'get') return { stdout: JSON.stringify({ project: { path: cwd, config: {} } }), stderr: '' };
    if (file === 'ao' && args[0] === 'project') throw new Error('Re-init must not mutate or replace AO configuration');
    return { stdout: file === 'git' && args[0] === 'rev-parse' ? cwd : 'ok', stderr: '' };
  };
  return { cwd, path, config, record, commands, command };
}

describe('consented integration re-init', () => {
  it.each(['decline', 'dry-run'] as const)('shows a diff but writes nothing on %s', async (mode) => {
    const f = fixture();
    const before = readFileSync(f.path, 'utf8');
    const recordBefore = readFileSync(installRecordPath(f.path), 'utf8');
    const output: string[] = [];
    const result = await runInit({ cwd: f.cwd, command: f.command, env: { NEATLOGS_API_KEY: 'fake-key' }, dryRun: mode === 'dry-run', print: (line) => output.push(line), onboarding: async () => {},
      readLine: async (question, fallback) => {
        if (question.startsWith('Enable neatlogs')) return 'y';
        if (question === 'Apply these changes? y/N') { expect(fallback).toBe('N'); return ''; }
        return fallback ?? '';
      } });
    expect(result.applied).toBe(false);
    expect(output.join('\n')).toContain('- integrations:');
    expect(output.join('\n')).toContain('+ integrations:');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(readFileSync(installRecordPath(f.path), 'utf8')).toBe(recordBefore);
    expect(existsSync(reinitPath(f.path))).toBe(false);
  });

  it.each([true, false])('connects a skipped product, preserving all other settings and ownership: owned=%s', async (owned) => {
    const f = fixture(owned);
    const result = await runInit({ cwd: f.cwd, command: f.command, env: { NEATLOGS_API_KEY: 'fake-key' }, print: () => {}, doctor: async () => [],
      onboarding: async ({ config }) => { config.integrations.neatlogs = true; },
      readLine: async (question, fallback) => question.startsWith('Enable neatlogs') || question === 'Apply these changes? y/N' ? 'y' : fallback ?? '' });
    expect(result.applied).toBe(true);
    expect(loadConfig(f.path)).toEqual({ ...f.config, integrations: { ...f.config.integrations, neatlogs: true } });
    if (owned) expect(JSON.parse(readFileSync(installRecordPath(f.path), 'utf8'))).toEqual({ ...f.record, configHash: contentHash(readFileSync(f.path, 'utf8')) });
    else expect(existsSync(installRecordPath(f.path))).toBe(false);
    expect(f.commands.some((line) => /^ao project (?:add|set-config)/.test(line))).toBe(false);
    expect(existsSync(reinitPath(f.path))).toBe(false);
  });

  it('exits cleanly with unchanged files when no changes are proposed', async () => {
    const f = fixture();
    const before = readFileSync(f.path, 'utf8');
    const output: string[] = [];
    expect((await runInit({ cwd: f.cwd, command: f.command, yes: true, print: (line) => output.push(line) })).applied).toBe(false);
    expect(output.join('\n')).toContain('No changes proposed');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.commands).toEqual(['git rev-parse --show-toplevel', 'ao project get preserved-project --json']);
  });

  it('proposes and restores an AO project missing from an existing installation', async () => {
    const f = fixture();
    const command: InitCommandRunner = async (file, args, options) => {
      if (file === 'ao' && args.join(' ') === 'project get preserved-project --json') {
        throw new Error('AO project preserved-project not found');
      }
      if (file === 'ao' && args[0] === 'project' && ['add', 'set-config'].includes(args[1]!)) {
        f.commands.push(`${file} ${args.join(' ')}`);
        return { stdout: 'ok', stderr: '' };
      }
      return f.command(file, args, options);
    };
    const output: string[] = [];
    const result = await runInit({ cwd: f.cwd, command, yes: true, print: line => output.push(line), doctor: async () => [] });
    expect(result.applied).toBe(true);
    expect(output.join('\n')).toContain('Re-register AO project preserved-project');
    expect(f.commands).toContain(`ao project add --path ${f.cwd} --id preserved-project`);
    expect(f.commands.some(line => /^ao project set-config preserved-project --config-json /.test(line))).toBe(true);
  });

  it('refreshes enabled integrations on interactive re-init even when YAML settings are unchanged', async () => {
    const f = fixture();
    const existing = loadConfig(f.path);
    existing.integrations.neatlogs = true;
    writeFileSync(f.path, stringify(existing));
    let receivedConfig: OnboardingContext['config'] | undefined;
    const onboarding = vi.fn(async ({ config }: OnboardingContext) => { receivedConfig = config; });
    const output: string[] = [];
    const result = await runInit({ cwd: f.cwd, command: f.command, env: { NEATLOGS_API_KEY: 'fake-key' }, onboarding,
      print: (line) => output.push(line), readLine: async (_question, fallback) => fallback ?? '' });
    expect(result.applied).toBe(false);
    expect(onboarding).toHaveBeenCalledOnce();
    expect(receivedConfig?.integrations.neatlogs).toBe(true);
    expect(output.join('\n')).toContain('No changes proposed');
  });

  it('checks prerequisites before writing any re-init changes', async () => {
    const f = fixture();
    const before = readFileSync(f.path, 'utf8');
    await expect(runInit({ cwd: f.cwd, command: f.command, env: {}, print: () => {},
      onboarding: async () => {},
      readLine: async (question, fallback) => question.startsWith('Enable neatlogs') ? 'y' : fallback ?? '' })).rejects.toThrow('NEATLOGS_API_KEY');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(existsSync(reinitPath(f.path))).toBe(false);
  });

  it('lets the explicit model-access fallback flag update an existing config', async () => {
    const f = fixture();
    const result = await runInit({ cwd: f.cwd, command: f.command, modelAccessFallbackTier: 'middle', yes: true,
      env: { NEATLOGS_API_KEY: 'fake-key' }, print: () => {}, doctor: async () => [],
      readLine: async (_question, fallback) => fallback ?? '' });
    expect(result.applied).toBe(true);
    expect(loadConfig(f.path).modelAccessFallbackTier).toBe('middle');
  });

  it('recovers after doctor fails but refuses intervening user edits', async () => {
    const f = fixture();
    await expect(runInit({ cwd: f.cwd, command: f.command, env: { NEATLOGS_API_KEY: 'fake-key' }, print: () => {}, doctor: async () => { throw new Error('doctor stopped'); },
      onboarding: async () => {},
      readLine: async (question, fallback) => question.startsWith('Enable neatlogs') || question === 'Apply these changes? y/N' ? 'y' : fallback ?? '' })).rejects.toThrow('rerun tally init');
    const proposed = readFileSync(f.path, 'utf8');
    writeFileSync(f.path, `${proposed}\n# user edit\n`);
    await expect(runInit({ cwd: f.cwd, command: f.command, env: { NEATLOGS_API_KEY: 'fake-key' }, yes: true, print: () => {}, doctor: async () => [] })).rejects.toThrow('preserve your edits');
    expect(readFileSync(f.path, 'utf8')).toContain('# user edit');
    writeFileSync(f.path, proposed);
    expect((await runInit({ cwd: f.cwd, command: f.command, env: { NEATLOGS_API_KEY: 'fake-key' }, yes: true, print: () => {}, doctor: async () => [] })).applied).toBe(true);
    expect(existsSync(reinitPath(f.path))).toBe(false);
  });
});
