import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandError, resolveAoBinary, resolveEntireBinary, runCommand } from './command.js';

function executable(path: string) {
  writeFileSync(path, '#!/bin/sh\nprintf "ok"\n');
  chmodSync(path, 0o700);
  return path;
}

describe('shared AO executable resolution', () => {
  it('prefers PATH, then environment, then config override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-ao-bin-'));
    const path = executable(join(dir, 'ao'));
    const env = executable(join(dir, 'environment'));
    const config = executable(join(dir, 'configured'));
    expect(resolveAoBinary({ platform: 'linux', env: { PATH: dir, TALLY_AO_BIN: env }, aoBin: config })).toBe(path);
    expect(resolveAoBinary({ platform: 'linux', env: { PATH: '', TALLY_AO_BIN: env }, aoBin: config })).toBe(env);
    expect(resolveAoBinary({ platform: 'linux', cwd: dir, env: { PATH: '' }, aoBin: 'configured' })).toBe(config);
  });

  it('finds the macOS app bundle with no AO executable on PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-ao-app-'));
    const folder = join(dir, 'Agent Orchestrator.app', 'Contents', 'Resources', 'daemon');
    mkdirSync(folder, { recursive: true });
    const path = executable(join(folder, 'ao'));
    const options = { platform: 'darwin', env: { PATH: '' }, bundleRoots: [dir] };
    expect(resolveAoBinary(options)).toBe(path);
    expect((await runCommand('ao', ['status'], options)).stdout).toBe('ok');
  });

  it('rejects directories and non-executable files with a plain fix and searched locations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-ao-missing-'));
    writeFileSync(join(dir, 'ao'), 'not executable', { mode: 0o600 });
    expect(() => resolveAoBinary({ platform: 'linux', env: { PATH: dir }, aoBin: dir })).toThrow('Agent Orchestrator (AO) is required; looked in PATH');
    expect(() => resolveAoBinary({ platform: 'linux', env: { PATH: '' } })).toThrow('set TALLY_AO_BIN');
  });

  it('wraps missing or failing child commands without echoing sensitive arguments', async () => {
    await expect(runCommand('/does/not/exist', ['sensitive-argument'])).rejects.toBeInstanceOf(CommandError);
    await expect(runCommand('/bin/sh', ['-c', 'exit 7', 'sensitive-argument'])).rejects.toThrow('command failed (7)');
  });

  it('preserves nonzero command output for adapter verdict parsing', async () => {
    const error = await runCommand('/bin/sh', ['-c', 'printf verdict; printf detail >&2; exit 3']).catch((failure) => failure);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: 3, stdout: 'verdict', stderr: 'detail' });
    expect(error.message).not.toContain('printf');
  });

  it('shows sanitized Git stderr so commit and publish failures can be diagnosed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-git-error-'));
    const path = executable(join(dir, 'git'));
    writeFileSync(path, "#!/bin/sh\nprintf 'remote: permission denied; token=ghp_supersecret1234567890\\n' >&2\nexit 1\n");
    chmodSync(path, 0o700);
    const error = await runCommand('git', ['push'], { env: { PATH: dir } }).catch((failure) => failure);
    expect(error).toBeInstanceOf(CommandError);
    expect(error.message).toContain('git push command failed');
    expect(error.message).toContain('permission denied');
    expect(error.message).not.toContain('ghp_supersecret1234567890');
    expect(error.stderr).toContain('ghp_supersecret1234567890');
  });
});

describe('Entire user-local executable resolution', () => {
  it('finds the official Linux install location when it is missing from PATH', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-entire-bin-'));
    const local = join(home, '.local', 'bin');
    mkdirSync(local, { recursive: true });
    const path = executable(join(local, 'entire'));
    expect(resolveEntireBinary({ platform: 'linux', home })).toBe(path);
    expect((await runCommand('entire', ['version'], { platform: 'linux', home })).stdout).toBe('ok');
    expect(resolveEntireBinary({ platform: 'linux', home: `${home}-missing` })).toBe('entire');
  });
});
