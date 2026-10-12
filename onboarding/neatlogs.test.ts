import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NeatlogsOnboarding, NEATLOGS_KEYS_URL, installGlobalNeatlogsHooks } from './neatlogs.js';
import { readHiddenSecret, saveSecrets } from './secrets.js';
import { PassThrough } from 'node:stream';
import { sampleConfig } from '../agent/testing/fakes.js';
import type { OnboardingContext } from './types.js';

function setup(env: Record<string, string> = { NEATLOGS_API_KEY: 'fake-key' }) {
  const context: OnboardingContext = { config: sampleConfig(), ui: { print: vi.fn(), confirm: vi.fn(async () => false), select: vi.fn(async () => 0) } };
  const save = vi.fn((values: Record<string, string>) => { Object.assign(env, values); });
  const options = { env: () => env, save, probe: vi.fn(async () => true), readSecret: vi.fn(async (): Promise<string | null> => 'fake-new-key'),
    openBrowser: vi.fn(async () => undefined), projects: vi.fn(async () => [{ id: 'project-discovered', name: 'Project' }]),
    verifyProject: vi.fn(async () => true), installHooks: vi.fn(async () => undefined) };
  return { context, options, module: new NeatlogsOnboarding(options) };
}

describe('neatlogs onboarding', () => {
  it('verifies the key and installs worker hooks after the Neatlogs integration is selected', async () => {
    const { module, options, context } = setup();
    const result = await module.configure(context);
    expect(result.enabled).toBe(true);
    expect(options.probe).toHaveBeenCalledWith('fake-key');
    expect(options.save).not.toHaveBeenCalled();
    expect(options.installHooks).toHaveBeenCalledWith({ NEATLOGS_API_KEY: 'fake-key' }, { harnesses: ['claude-code', 'codex'] });
    expect(context.ui.confirm).not.toHaveBeenCalled();
    expect(vi.mocked(context.ui.print).mock.calls.join(' ')).toContain('Past-run history is not configured');
  });
  it('passively checks presence without exporting traces or opening a browser', async () => {
    const { module, options } = setup();
    expect((await module.check()).status).toBe('ok');
    expect(options.probe).not.toHaveBeenCalled();
    expect(options.openBrowser).not.toHaveBeenCalled();
  });
  it('automatically verifies an existing key and installs the selected workers hooks', async () => {
    const { module, options, context } = setup();
    expect((await module.configure(context)).enabled).toBe(true);
    expect(options.probe).toHaveBeenCalledWith('fake-key');
    expect(options.save).not.toHaveBeenCalled();
    expect(options.installHooks).toHaveBeenCalledOnce();
  });
  it('keeps the Neatlogs output concise and discloses global worker-hook scope', async () => {
    const { module, context } = setup();
    expect((await module.configure(context)).enabled).toBe(true);
    const messages = vi.mocked(context.ui.print).mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain('Neatlogs connection');
    expect(messages).not.toContain('Tally already includes the Neatlogs SDK');
    expect(messages).toContain('Installing Neatlogs worker hooks');
    expect(messages).toContain('global agent settings');
    expect(messages).not.toContain('Past-run history (optional)');
    expect(context.ui.confirm).not.toHaveBeenCalled();
    expect(messages).not.toContain(';');
    expect(vi.mocked(context.ui.confirm).mock.calls.join('\n')).not.toContain(';');
  });
  it('opens the key page and stays off when the user leaves the new key blank', async () => {
    const { module, options, context } = setup({});
    options.readSecret.mockResolvedValueOnce(null);
    expect((await module.configure(context)).enabled).toBe(false);
    expect(options.openBrowser).toHaveBeenCalledWith(NEATLOGS_KEYS_URL);
    expect(options.readSecret).toHaveBeenCalledOnce();
    expect(context.ui.print).toHaveBeenCalledWith(expect.stringContaining('https://app.neatlogs.com'));
  });
  it('opens the API keys page, prompts secretly, verifies before saving outside config', async () => {
    const { module, options, context } = setup({});
    expect((await module.configure(context)).enabled).toBe(true);
    expect(options.openBrowser).toHaveBeenCalledWith(NEATLOGS_KEYS_URL);
    expect(options.save).toHaveBeenCalledWith({ NEATLOGS_API_KEY: 'fake-new-key' });
    expect(options.probe.mock.invocationCallOrder[0]).toBeLessThan(options.save.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(context.config)).not.toContain('fake-new-key');
    expect(JSON.stringify(vi.mocked(context.ui.print).mock.calls)).not.toContain('fake-new-key');
  });
  it('leaves a blank secret unsaved and off', async () => {
    const { context, options } = setup({});
    const module = new NeatlogsOnboarding({ ...options, readSecret: async () => null });
    expect((await module.configure(context)).enabled).toBe(false);
    expect(options.save).not.toHaveBeenCalled();
  });
  it('never saves an unverified key and keeps raw failures out of output', async () => {
    const { context, options } = setup({});
    const module = new NeatlogsOnboarding({ ...options, probe: async () => { throw new Error('secret=fake-new-key'); } });
    expect((await module.configure(context)).enabled).toBe(false);
    expect(options.save).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(context.ui.print).mock.calls)).not.toContain('fake-new-key');
  });
  it('replaces an invalid existing key through hidden input without hand editing the secrets file', async () => {
    const { context, options } = setup();
    options.probe.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await new NeatlogsOnboarding(options).configure(context)).enabled).toBe(true);
    expect(options.save).toHaveBeenCalledWith({ NEATLOGS_API_KEY: 'fake-new-key' });
    expect(options.probe).toHaveBeenCalledTimes(2);
  });
  it('discovers the project from a read token and verifies it before saving', async () => {
    const { module, context, options } = setup({ NEATLOGS_API_KEY: 'fake-key', NEATLOGS_TOKEN: 'read-token' });
    expect((await module.configure(context)).enabled).toBe(true);
    expect(options.projects).toHaveBeenCalledWith('read-token');
    expect(options.verifyProject).toHaveBeenCalledWith('read-token', 'project-discovered');
    expect(options.save).toHaveBeenCalledWith({ NEATLOGS_TOKEN: 'read-token', NEATLOGS_PROJECT_ID: 'project-discovered' });
  });
  it('preserves tracing and local history when configured read access fails', async () => {
    const { context, options } = setup({ NEATLOGS_API_KEY: 'fake-key', NEATLOGS_TOKEN: 'read-token', NEATLOGS_PROJECT_ID: 'project-id' });
    const module = new NeatlogsOnboarding({ ...options, verifyProject: async () => false });
    expect((await module.configure(context)).enabled).toBe(true);
    expect(options.save).not.toHaveBeenCalled();
    expect(context.ui.print).toHaveBeenCalledWith(expect.stringContaining('local history'));
  });
  it('allows skipping project selection without saving a project ID', async () => {
    const { context, options } = setup({ NEATLOGS_API_KEY: 'fake-key', NEATLOGS_TOKEN: 'read-token' });
    context.ui.select = async () => null;
    const module = new NeatlogsOnboarding({ ...options, projects: async () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    expect((await module.configure(context)).enabled).toBe(true);
    expect(options.save).not.toHaveBeenCalled();
  });
  it('falls back to local history when the configured read token has no accessible projects', async () => {
    const { context, options } = setup({ NEATLOGS_API_KEY: 'fake-key', NEATLOGS_TOKEN: 'read-token' });
    const module = new NeatlogsOnboarding({ ...options, projects: async () => [] });
    expect((await module.configure(context)).enabled).toBe(true);
    const messages = vi.mocked(context.ui.print).mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain('No Neatlogs projects were available to the history token. Tally will use local history.');
    expect(context.ui.select).not.toHaveBeenCalled();
  });
  it('installs only selected global hooks and explains agent trust afterwards', async () => {
    const { module, context, options } = setup();
    context.config.tiers = context.config.tiers.map(tier => ({ ...tier, harness: 'codex' }));
    expect((await module.configure(context)).enabled).toBe(true);
    expect(options.installHooks).toHaveBeenCalledWith({ NEATLOGS_API_KEY: 'fake-key' }, { harnesses: ['codex'] });
    expect(context.ui.confirm).not.toHaveBeenCalled();
    expect(context.ui.print).toHaveBeenCalledWith(expect.stringContaining('Review and trust them in your coding agent'));
  });
  it('does not disable decision tracing if global hook installation fails', async () => {
    const { context, options } = setup();
    const module = new NeatlogsOnboarding({ ...options, installHooks: async () => { throw new Error('fake-key'); } });
    expect((await module.configure(context)).enabled).toBe(true);
    expect(JSON.stringify(vi.mocked(context.ui.print).mock.calls)).not.toContain('fake-key');
  });
  it('backs up global settings before installing, uses only environment secrets and preserves backups on rerun', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-global-hooks-'));
    for (const directory of ['.claude', '.codex']) mkdirSync(join(home, directory));
    const settings = join(home, '.claude/settings.json');
    const hooks = join(home, '.codex/hooks.json');
    writeFileSync(settings, '{"hooks":{"Existing":[]}}');
    writeFileSync(hooks, '{"hooks":{"Entire":[]}}');
    const run = vi.fn(async (_file: string, args: string[], env: Record<string, string>) => {
      expect(readFileSync(`${hooks}.pre-tally-neatlogs`, 'utf8')).toContain('Entire');
      expect(statSync(`${settings}.pre-tally-neatlogs`).mode & 0o777).toBe(0o600);
      expect(args.join(' ')).not.toContain('fake-key');
      expect(env.NEATLOGS_API_KEY).toBe('fake-key');
    });
    await installGlobalNeatlogsHooks({ NEATLOGS_API_KEY: 'fake-key' }, { home, run });
    expect(run.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['npm', ['install', '--global', '@neatlogs/claude-code', '@neatlogs/codex']],
      ['neatlogs-claude-code', ['setup', '--global']], ['neatlogs-codex', ['setup', '--global']],
    ]);
    writeFileSync(settings, 'modified');
    await installGlobalNeatlogsHooks({ NEATLOGS_API_KEY: 'fake-key' }, { home, run });
    expect(readFileSync(`${settings}.pre-tally-neatlogs`, 'utf8')).toContain('Existing');
  });
});

describe('secret file storage', () => {
  it('preserves unrelated dotenv lines, replaces duplicate keys and enforces 0600 on rerun', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tally-secrets-')), '.env');
    writeFileSync(path, '# preserved\nOTHER_TOKEN=other\nNEATLOGS_API_KEY=old\nexport NEATLOGS_API_KEY=duplicate\n', { mode: 0o644 });
    saveSecrets({ NEATLOGS_API_KEY: 'fake-key' }, path);
    saveSecrets({ NEATLOGS_TOKEN: 'fake-token', NEATLOGS_PROJECT_ID: 'project-id' }, path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('# preserved\nOTHER_TOKEN=other');
    expect(content.match(/NEATLOGS_API_KEY=/g)).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('rejects multiline injection, unrelated keys and symlinks without touching the destination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-secrets-safe-'));
    const path = join(dir, '.env');
    const target = join(dir, 'target');
    writeFileSync(target, 'preserved');
    symlinkSync(target, path);
    expect(() => saveSecrets({ NEATLOGS_API_KEY: 'fake-key' }, path)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('preserved');
    expect(() => saveSecrets({ NEATLOGS_API_KEY: 'key\nINJECTED=yes' }, join(dir, 'new'))).toThrow();
    expect(() => saveSecrets({ OTHER_KEY: 'fake' }, join(dir, 'new'))).toThrow();
  });
  it('refuses a symlinked secrets directory and preserves padded token values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-secrets-parent-'));
    const target = join(dir, 'target');
    mkdirSync(target);
    symlinkSync(target, join(dir, 'linked'));
    expect(() => saveSecrets({ NEATLOGS_API_KEY: 'fake' }, join(dir, 'linked', '.env'))).toThrow();
    const path = join(dir, '.env');
    saveSecrets({ NEATLOGS_TOKEN: 'fake-token==' }, path);
    expect(readFileSync(path, 'utf8')).toContain('fake-token==');
  });
});

describe('hidden secret input', () => {
  it.each(['\r', '\u0003'])('never echoes a secret and restores raw mode for terminator %s', async terminator => {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    let printed = '';
    output.on('data', chunk => { printed += chunk.toString(); });
    const answer = readHiddenSecret('API key', { input: input as unknown as typeof process.stdin, output: output as unknown as typeof process.stdout });
    input.write(`do-not-echo${terminator}`);
    expect(await answer).toBe(terminator === '\r' ? 'do-not-echo' : null);
    expect(printed).not.toContain('do-not-echo');
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.listenerCount('data')).toBe(0);
  });
  it('skips secret input when the terminal cannot hide it', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    expect(await readHiddenSecret('API key', { input: input as unknown as typeof process.stdin })).toBeNull();
  });
});
