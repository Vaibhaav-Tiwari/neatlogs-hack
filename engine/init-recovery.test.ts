import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit, type InitCommandRunner } from './init.js';
import { pendingInitPath } from './init-transaction.js';
import { installRecordPath } from './install-record.js';
import { configureIntegrations } from '../onboarding/index.js';
import { CfoaiOnboarding } from '../onboarding/cfoai.js';
import { EntireOnboarding } from '../onboarding/entire.js';
import { NeatlogsOnboarding } from '../onboarding/neatlogs.js';
import { parse as parseYaml } from 'yaml';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'tally-init-recover-'));
  writeFileSync(join(cwd, 'Makefile'), 'test:\n\ttrue\nsetup:\n\ttrue\n');
  let project: Record<string, unknown> | null = null;
  let fail = false;
  const mutations: string[] = [];
  const command: InitCommandRunner = async (file, args) => {
    if (file === 'git') return { stdout: args[0] === 'rev-parse' ? cwd : args[0] === 'branch' ? 'main' : '', stderr: '' };
    if (file === 'gh' || args[0] === 'status') return { stdout: 'ok', stderr: '' };
    if (args[0] === 'agent') return { stdout: '{"installed":[{"id":"codex"}]}', stderr: '' };
    if (args[1] === 'get') { if (!project) throw new Error('missing project'); return { stdout: JSON.stringify({ project: { config: project, path: cwd } }), stderr: '' }; }
    if (args[1] === 'add') { mutations.push('add'); project = { worker: { agentConfig: { effort: 'high' } }, postCreate: ['echo existing'] }; }
    if (args[1] === 'set-config') { mutations.push('set-config'); if (fail) throw new Error('daemon refused update'); project = JSON.parse(args[args.indexOf('--config-json') + 1]!); }
    return { stdout: '{}', stderr: '' };
  };
  return { cwd, command, mutations, setFail: (value: boolean) => { fail = value; }, project: () => project };
}

describe('transactional init prerequisites and recovery', () => {
  it('rejects a null recovery record with a plain recovery error before mutation', async () => {
    const f = fixture();
    mkdirSync(join(f.cwd, '.tally'));
    writeFileSync(pendingInitPath(join(f.cwd, 'tally.yaml')), 'null');
    await expect(runInit({ cwd: f.cwd, command: f.command, yes: true, print: () => {} })).rejects.toThrow('Invalid init recovery record');
    expect(f.mutations).toEqual([]);
  });

  it('checks AO/gh before creating files or registering projects', async () => {
    const f = fixture();
    const command: InitCommandRunner = async (file, args, options) => {
      if (file === 'gh') throw new Error('gh auth required');
      return f.command(file, args, options);
    };
    await expect(runInit({ cwd: f.cwd, command, yes: true, print: () => {} })).rejects.toThrow('gh auth required');
    expect(f.mutations).toEqual([]);
    expect(existsSync(join(f.cwd, '.tally'))).toBe(false);
  });

  it('completes init with Entire off when target repository capture setup is declined', async () => {
    const f = fixture();
    const captureMutations: string[] = [];
    const entire = new EntireOnboarding({ command: async (file, args, options) => {
      expect(options.cwd).toBe(f.cwd);
      if (file === 'git') return { stdout: args[0] === 'rev-parse' ? f.cwd : '' };
      if (args[0] === 'auth') return { stdout: '{"logged_in":true}' };
      if (args[0] === 'plugin') return { stdout: '  graph v0.4.0' };
      if (args[0] === 'status') return { stdout: '{"enabled":false}' };
      if (args[0] === 'enable') captureMutations.push('enable');
      return { stdout: 'ok' };
    } });
    const result = await runInit({ cwd: f.cwd, command: f.command, print: () => {}, doctor: async () => [],
      onboarding: context => configureIntegrations(context, { entire }),
      readLine: async (question, fallback) => question.startsWith('Enable Entire') || question === 'Apply these changes? y/N' ? 'y' : fallback ?? '' });
    expect(result.applied).toBe(true);
    expect(parseYaml(readFileSync(result.configPath, 'utf8')).integrations.entire).toBe(false);
    expect(captureMutations).toEqual([]);
  });

  it('allows neatlogs connection to be skipped and completes init with tracing off', async () => {
    const f = fixture();
    const probe = vi.fn(async () => true);
    const neatlogs = new NeatlogsOnboarding({ env: () => ({}), probe });
    const result = await runInit({ cwd: f.cwd, command: f.command, print: () => {}, env: {}, doctor: async () => [],
      onboarding: context => configureIntegrations(context, { neatlogs }),
      readLine: async (question, fallback) => question.startsWith('Enable neatlogs') || question === 'Apply these changes? y/N' ? 'y' : fallback ?? '' });
    expect(result.applied).toBe(true);
    expect(parseYaml(readFileSync(result.configPath, 'utf8')).integrations.neatlogs).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('offers cfo.ai login during init and safely uses the local budget when it is skipped', async () => {
    const f = fixture();
    const login = vi.fn(async () => undefined);
    const cfoai = new CfoaiOnboarding({ check: async () => ({ status: 'missing', detail: 'not connected' }), login });
    const result = await runInit({ cwd: f.cwd, command: f.command, print: () => {}, doctor: async () => [],
      onboarding: context => configureIntegrations(context, { cfoai }),
      readLine: async (question, fallback) => question.startsWith('Enable cfo.ai') || question === 'Apply these changes? y/N' ? 'y' : fallback ?? '' });
    expect(result.applied).toBe(true);
    const config = parseYaml(readFileSync(result.configPath, 'utf8'));
    expect(config.integrations.cfoai).toBe(false);
    expect(config.budget.source).toBe('config');
    expect(login).not.toHaveBeenCalled();
  });

  it('recovers an AO failure without duplicate registration or lost daemon defaults', async () => {
    const f = fixture();
    const path = join(f.cwd, 'tally.yaml');
    f.setFail(true);
    await expect(runInit({ cwd: f.cwd, command: f.command, yes: true, print: () => {}, doctor: async () => [] })).rejects.toThrow('was not written');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(pendingInitPath(path))).toBe(true);
    f.setFail(false);
    const result = await runInit({ cwd: f.cwd, command: f.command, yes: true, print: () => {}, doctor: async () => [] });
    expect(result.applied).toBe(true);
    expect(f.mutations.filter((value) => value === 'add')).toHaveLength(1);
    expect(f.project()).toEqual({ worker: { agentConfig: { effort: 'high' } }, postCreate: ['echo existing', 'make setup'] });
    expect(existsSync(pendingInitPath(path))).toBe(false);
    expect(JSON.parse(readFileSync(installRecordPath(path), 'utf8')).projectCreated).toBe(true);
  });

  it('resumes a doctor failure after files were written, but never overwrites user edits', async () => {
    const f = fixture();
    const path = join(f.cwd, 'tally.yaml');
    const doctor = vi.fn(async () => { throw new Error('doctor unavailable'); });
    await expect(runInit({ cwd: f.cwd, command: f.command, yes: true, print: () => {}, doctor })).rejects.toThrow('Init configured AO and wrote');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, `${original}\n# user edit\n`);
    await expect(runInit({ cwd: f.cwd, command: f.command, yes: true, print: () => {}, doctor: async () => [] })).rejects.toThrow('preserve your edits');
    expect(readFileSync(path, 'utf8')).toContain('# user edit');
    writeFileSync(path, original);
    expect((await runInit({ cwd: f.cwd, command: f.command, yes: true, print: () => {}, doctor: async () => [] })).applied).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)('reports and recovers a file write failure after AO was configured', async () => {
    const f = fixture();
    const path = join(f.cwd, 'tally.yaml');
    let block = true;
    const command: InitCommandRunner = async (file, args, options) => {
      const result = await f.command(file, args, options);
      if (block && args[1] === 'set-config') chmodSync(join(f.cwd, '.tally'), 0o500);
      return result;
    };
    try {
      await expect(runInit({ cwd: f.cwd, command, yes: true, print: () => {}, doctor: async () => [] })).rejects.toThrow('writing ownership record');
      expect(existsSync(path)).toBe(false);
      expect(existsSync(installRecordPath(path))).toBe(false);
      expect(existsSync(pendingInitPath(path))).toBe(true);
    } finally { chmodSync(join(f.cwd, '.tally'), 0o700); }
    block = false;
    expect((await runInit({ cwd: f.cwd, command, yes: true, print: () => {}, doctor: async () => [] })).applied).toBe(true);
    expect(f.mutations.filter((value) => value === 'add')).toHaveLength(1);
  });
});
