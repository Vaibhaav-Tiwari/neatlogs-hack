import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit, type InitCommandRunner } from './init.js';
import { pendingInitPath } from './init-transaction.js';
import { installRecordPath } from './install-record.js';

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

  it('does not accept Entire opt-in until it is enabled in the target repository', async () => {
    const f = fixture();
    const command: InitCommandRunner = async (file, args, options) => file === 'entire'
      ? { stdout: args[0] === 'status' ? '{"enabled":false}' : 'ok', stderr: '' } : f.command(file, args, options);
    await expect(runInit({ cwd: f.cwd, command, print: () => {}, readLine: async (question, fallback) => question.startsWith('Enable Entire') ? 'y' : fallback ?? '' })).rejects.toThrow('entire enable');
    expect(f.mutations).toEqual([]);
    expect(existsSync(join(f.cwd, '.tally'))).toBe(false);
  });

  it.each(['neatlogs', 'cfo.ai'])('checks requested %s before mutation', async (product) => {
    const f = fixture();
    await expect(runInit({ cwd: f.cwd, command: f.command, print: () => {}, env: {}, cfoaiCheck: async () => ({ status: 'missing', detail: 'missing' }),
      readLine: async (question, fallback) => question.startsWith(`Enable ${product}`) ? 'y' : fallback ?? '' })).rejects.toThrow(product === 'neatlogs' ? 'NEATLOGS_API_KEY' : 'tally login cfoai');
    expect(f.mutations).toEqual([]);
    expect(existsSync(join(f.cwd, '.tally'))).toBe(false);
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
