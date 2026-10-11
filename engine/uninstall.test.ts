import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentHash, configHash, installRecordPath, type InstallRecord } from './install-record.js';
import { runUninstall } from './uninstall.js';

function fixture(projectCreated = false) {
  const dir = mkdtempSync(join(tmpdir(), 'tally-uninstall-'));
  const configPath = join(dir, 'tally.yaml');
  const projectConfig = { postCreate: ['user setup', 'make setup'], worker: { agent: 'codex' }, env: { KEEP: 'value' } };
  const text = 'version: 1\n';
  writeFileSync(configPath, text);
  const recordPath = installRecordPath(configPath);
  mkdirSync(dirname(recordPath));
  const record: InstallRecord = { version: 1, configPath, configHash: contentHash(text), projectId: 'test', projectCreated,
    projectConfigHash: configHash(projectConfig), postCreateExisted: true, postCreateAfterHash: configHash(projectConfig.postCreate), addedSetupCommand: 'make setup' };
  writeFileSync(recordPath, JSON.stringify(record));
  writeFileSync(join(dir, '.tally', 'ledger.json'), 'keep');
  const calls: string[][] = [];
  const command = async (_file: string, args: string[]) => {
    calls.push(args);
    return { stdout: JSON.stringify(args[0] === 'session' ? { sessions: [] } : { project: { config: projectConfig } }), stderr: '' };
  };
  return { dir, configPath, recordPath, projectConfig, calls, command };
}

describe('uninstall', () => {
  it.each([false, true])('restores only the owned worker policy, preserving an existing worker: %s', async existed => {
    const f = fixture();
    const before = existed ? { agent: 'codex', agentConfig: { effort: 'high' } } : null;
    const worker = { agent: 'codex', agentConfig: { effort: 'high', permissions: 'auto' } };
    Object.assign(f.projectConfig, { worker });
    const record = JSON.parse(readFileSync(f.recordPath, 'utf8'));
    Object.assign(record, { workerExisted: existed, workerBefore: before, workerAfterHash: configHash(worker) });
    writeFileSync(f.recordPath, JSON.stringify(record));
    await runUninstall({ configPath: f.configPath, command: f.command, readLine: async () => 'y' });
    const args = f.calls.find(args => args[1] === 'set-config')!;
    const restored = JSON.parse(args[args.indexOf('--config-json') + 1]!);
    if (existed) expect(restored.worker).toEqual(before);
    else expect(restored).not.toHaveProperty('worker');
    expect(restored.env).toEqual(f.projectConfig.env);
  });
  it('refuses to restore a worker policy the user edited', async () => {
    const f = fixture();
    const record = JSON.parse(readFileSync(f.recordPath, 'utf8'));
    Object.assign(record, { workerExisted: false, workerBefore: null, workerAfterHash: configHash({ agentConfig: { permissions: 'auto' } }) });
    writeFileSync(f.recordPath, JSON.stringify(record));
    await expect(runUninstall({ configPath: f.configPath, command: f.command, readLine: async () => 'y' })).rejects.toThrow('AO worker settings changed');
    expect(f.calls.some(args => args[1] === 'set-config')).toBe(false);
  });
  it('lists changes, restores only the added hook, preserves settings and run data', async () => {
    const f = fixture();
    const listed: string[] = [];
    const result = await runUninstall({ configPath: f.configPath, command: f.command, readLine: async () => 'y', print: (line) => listed.push(line) });
    expect(result.removed).toBe(true);
    expect(listed).toHaveLength(3);
    const args = f.calls.find((args) => args[1] === 'set-config')!;
    expect(JSON.parse(args[args.indexOf('--config-json') + 1]!)).toEqual({ ...f.projectConfig, postCreate: ['user setup'] });
    expect(existsSync(f.configPath)).toBe(false);
    expect(existsSync(f.recordPath)).toBe(false);
    expect(readFileSync(join(f.dir, '.tally', 'ledger.json'), 'utf8')).toBe('keep');
  });
  it('requires confirmation and refuses changed files before doing anything', async () => {
    const f = fixture();
    await expect(runUninstall({ configPath: f.configPath, command: f.command, readLine: async () => '' })).resolves.toMatchObject({ removed: false });
    expect(f.calls.every((args) => args[1] === 'get')).toBe(true);
    writeFileSync(f.configPath, 'user edits');
    await expect(runUninstall({ configPath: f.configPath, command: f.command, readLine: async () => 'y' })).rejects.toThrow('changed after init');
    expect(existsSync(f.recordPath)).toBe(true);
  });
  it('unregisters only a project created by init, and refuses active workers', async () => {
    const f = fixture(true);
    await runUninstall({ configPath: f.configPath, command: f.command, readLine: async () => 'y' });
    expect(f.calls).toContainEqual(['project', 'rm', 'test', '--yes', '--json']);
    const active = fixture(true);
    await expect(runUninstall({ configPath: active.configPath, readLine: async () => 'y', command: async (file, args) => args[0] === 'session'
      ? { stdout: JSON.stringify({ sessions: [{ id: 'busy' }] }), stderr: '' } : active.command(file, args) })).rejects.toThrow('active sessions');
    expect(existsSync(active.configPath)).toBe(true);
  });
  it('refuses to undo hooks that the user changed after init', async () => {
    const f = fixture();
    f.projectConfig.postCreate.push('new user hook');
    await expect(runUninstall({ configPath: f.configPath, command: f.command, readLine: async () => 'y' })).rejects.toThrow('hooks changed');
    expect(existsSync(f.configPath)).toBe(true);
  });
});
