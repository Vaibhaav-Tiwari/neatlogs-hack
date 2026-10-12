import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { runInit, type InitCommandRunner } from './init.js';
import { runDoctor } from './doctor.js';
import { runUninstall } from './uninstall.js';
import { claudeAllowList } from './harness.js';
import { validateConfig } from '../schema/index.js';

function fixture(ao = false, installed = ['claude', 'codex'], signedIn = installed, aoState: 'running' | 'stopped' = 'running') {
  const cwd = mkdtempSync(join(tmpdir(), 'tally-init-runners-'));
  writeFileSync(join(cwd, 'Makefile'), 'test:\n\ttrue\nsetup:\n\ttrue\n');
  const calls: string[] = [];
  const command: InitCommandRunner = async (file, args) => {
    calls.push(`${file} ${args.join(' ')}`);
    if (file === 'ao') {
      if (!ao) throw new Error('AO missing');
      if (args[0] === 'status') return { stdout: JSON.stringify({ state: aoState }), stderr: '' };
      return { stdout: args[0] === 'project' ? '{"project":{"config":{}}}' : 'ok', stderr: '' };
    }
    if (file === 'git') return { stdout: args[0] === 'rev-parse' ? cwd : args[0] === 'branch' ? 'main' : '', stderr: '' };
    if (file === 'gh') return { stdout: 'ok', stderr: '' };
    if (!installed.includes(file)) throw new Error('missing CLI');
    if (args[0] === '--version') return { stdout: 'v1', stderr: '' };
    return { stdout: file === 'claude' ? JSON.stringify({ loggedIn: signedIn.includes(file) }) : signedIn.includes(file) ? 'Logged in using ChatGPT' : 'Not logged in', stderr: '' };
  };
  const print = vi.fn();
  return { cwd, command, calls, print };
}

describe('runner and coding CLI setup', () => {
  it('initializes and uninstalls without AO, using explicit signed-in Claude tiers and consent', async () => {
    const f = fixture(false, ['claude']);
    const result = await runInit({ ...f, yes: true, allowClaude: true, doctor: async () => [] });
    const config = parse(readFileSync(result.configPath, 'utf8'));
    expect(config.runner).toBe('direct');
    expect(config.concurrency).toBe(1);
    expect(config.repo.aoProject).toBeUndefined();
    expect(config.tiers.map((t: { model: string }) => t.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(config.tiers.every((t: { harness: string; priceNote: string }) => t.harness === 'claude-code' && t.priceNote.includes('checked 2026-10-11'))).toBe(true);
    expect(config.claudeCode.allow).toEqual(claudeAllowList(config.test));
    expect(f.calls.filter(call => call.startsWith('ao '))).toEqual(['ao --version']);
    expect(f.print.mock.calls.join(' ').toLowerCase()).toContain('parallel workers need');
    await runUninstall({ configPath: result.configPath, command: f.command, readLine: async () => 'y' });
    expect(f.calls.filter(call => call.startsWith('ao '))).toEqual(['ao --version']);
    expect(existsSync(result.configPath)).toBe(false);
  });
  it.each(['ao', 'direct'] as const)('offers the runner choice when AO is found: %s', async runner => {
    const f = fixture(true, ['codex']);
    const readLine = vi.fn(async (question, fallback) => question.startsWith('Runner:') ? runner : question === 'Apply these changes? y/N' ? 'y' : fallback ?? '');
    const result = await runInit({ ...f, readLine, doctor: async () => [] });
    expect(parse(readFileSync(result.configPath, 'utf8')).runner).toBe(runner);
    expect(readLine.mock.calls.some(([q]) => q.startsWith('Runner:'))).toBe(true);
    expect(f.calls.some(call => call.startsWith('ao project'))).toBe(runner === 'ao');
  });
  it('defaults to direct when AO is installed but its daemon is stopped', async () => {
    const f = fixture(true, ['codex'], ['codex'], 'stopped');
    const result = await runInit({ ...f, yes: true, harnessChoice: 'codex', testCommand: 'true', setupCommand: '',
      integrations: { neatlogs: false, entire: false, cfoai: false }, doctor: async () => [] });
    expect(parse(readFileSync(result.configPath, 'utf8')).runner).toBe('direct');
    expect(f.print.mock.calls.join(' ')).toContain('AO daemon is stopped. AO is unavailable. Direct is the default. Run ao start to use AO.');
    expect(f.calls.some(call => call.startsWith('ao project'))).toBe(false);
  });
  it('refuses AO selection when the installed daemon is stopped', async () => {
    const f = fixture(true, ['codex'], ['codex'], 'stopped');
    await expect(runInit({ ...f, yes: true, runner: 'ao', harnessChoice: 'codex', testCommand: 'true', setupCommand: '',
      integrations: { neatlogs: false, entire: false, cfoai: false }, doctor: async () => [] })).rejects.toThrow('AO daemon is stopped. run ao start and retry, or select direct. Nothing was changed.');
    expect(existsSync(join(f.cwd, 'tally.yaml'))).toBe(false);
  });
  it.each(['claude-code', 'codex', 'mixed'] as const)('persists the requested harnesses with both CLIs installed: %s', async choice => {
    const f = fixture();
    const result = await runInit({ ...f, yes: true, harnessChoice: choice, allowClaude: true, doctor: async () => [] });
    const config = parse(readFileSync(result.configPath, 'utf8'));
    expect(config.tiers.map((t: { harness: string }) => t.harness)).toEqual(choice === 'mixed' ? ['codex', 'claude-code', 'claude-code'] : [choice, choice, choice]);
  });
  it('does not substitute Codex for a signed-out configured Claude selection', async () => {
    const f = fixture(false, ['claude', 'codex'], ['codex']);
    await expect(runInit({ ...f, yes: true, harnessChoice: 'claude-code', allowClaude: true })).rejects.toThrow('will not substitute');
    expect(existsSync(join(f.cwd, 'tally.yaml'))).toBe(false);
  });
  it('does not let --yes silently consent to Claude permissions', async () => {
    const f = fixture(false, ['claude']);
    await expect(runInit({ ...f, yes: true })).rejects.toThrow('allow-list was not approved');
    expect(existsSync(join(f.cwd, 'tally.yaml'))).toBe(false);
  });
  it('resumes direct initialization after doctor failure without touching AO', async () => {
    const f = fixture(false, ['codex']);
    await expect(runInit({ ...f, yes: true, doctor: async () => { throw new Error('temporary failure'); } })).rejects.toThrow('configured direct mode');
    expect(existsSync(join(f.cwd, '.tally/init-pending.json'))).toBe(true);
    const result = await runInit({ ...f, yes: true, doctor: async () => [] });
    expect(result.applied).toBe(true);
    expect(existsSync(join(f.cwd, '.tally/init-pending.json'))).toBe(false);
    expect(f.calls.filter(call => call.startsWith('ao '))).toEqual(['ao --version']);
  });
  it('refuses an explicitly requested AO runner when AO is missing', async () => {
    const f = fixture(false, ['codex']);
    await expect(runInit({ ...f, yes: true, runner: 'ao' })).rejects.toThrow('AO is unavailable');
    expect(existsSync(join(f.cwd, 'tally.yaml'))).toBe(false);
  });
  it('asks consent once per repository and asks again for changed commands', async () => {
    const f = fixture(false, ['claude']);
    const prompts: string[] = [];
    const readLine = async (q: string, fallback?: string) => { prompts.push(q); return q.startsWith('Approve this Claude') || q === 'Apply these changes? y/N' ? 'y' : fallback ?? ''; };
    await runInit({ ...f, readLine, doctor: async () => [] });
    await runInit({ ...f, readLine, doctor: async () => [] });
    expect(prompts.filter(q => q.startsWith('Approve this Claude'))).toHaveLength(1);
    await runInit({ ...f, readLine, testCommand: 'make check', doctor: async () => [] });
    expect(prompts.filter(q => q.startsWith('Approve this Claude'))).toHaveLength(2);
  });
  it('direct doctor skips AO and fails a signed-out configured harness without probing the other one', async () => {
    const f = fixture(false, ['claude']);
    const result = await runInit({ ...f, yes: true, allowClaude: true, doctor: async () => [] });
    f.calls.length = 0;
    const lines = await runDoctor({ configPath: result.configPath, runner: async (file, args, options) => file === 'claude' && args[0] === 'auth' ? { stdout: '{"loggedIn":false}', stderr: '' } : f.command(file, args, options), env: {} });
    expect(lines.find(l => l.product === 'AO daemon')).toMatchObject({ status: 'off' });
    expect(lines.find(l => l.product === 'Claude Code')).toMatchObject({ status: 'broken', fix: 'claude auth login' });
    expect(f.calls.some(call => /^(ao|codex) /.test(call))).toBe(false);
  });
  it('doctor fails a missing configured Codex instead of using installed Claude', async () => {
    const f = fixture(false, ['codex']);
    const result = await runInit({ ...f, yes: true, doctor: async () => [] });
    const checks: string[] = [];
    const lines = await runDoctor({ configPath: result.configPath, runner: async (file, args, options) => {
      checks.push(file);
      if (file === 'codex') throw new Error('not installed');
      return f.command(file, args, options);
    }, env: {} });
    expect(lines.find(l => l.product === 'Codex')).toMatchObject({ status: 'missing', detail: expect.stringContaining('not installed') });
    expect(checks).not.toContain('claude');
  });
  it('validates runner and configured harness without inventing defaults for legacy config', async () => {
    const f = fixture();
    const result = await runInit({ ...f, yes: true, harnessChoice: 'codex', doctor: async () => [] });
    const config = parse(readFileSync(result.configPath, 'utf8'));
    delete config.runner;
    expect(validateConfig(config).ok).toBe(true);
    expect(config.runner).toBeUndefined();
    expect(validateConfig({ ...config, runner: 'invalid' }).ok).toBe(false);
    expect(validateConfig({ ...config, tiers: [{ ...config.tiers[0], harness: 'unknown' }] }).ok).toBe(false);
  });
});
