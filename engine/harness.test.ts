import { describe, expect, it, vi } from 'vitest';
import { checkHarness, claudeAllowList, claudeScripts, requireClaudeScriptConsent } from './harness.js';

describe('harness sign-in checks', () => {
  it('requires a real Claude loggedIn flag, not installation or credential-shaped text', async () => {
    for (const stdout of ['{"loggedIn":true}', '{"loggedIn":false}', '{}', 'ok', '{"email":"private"}']) {
      const command = vi.fn(async () => ({ stdout, stderr: '' }));
      const status = await checkHarness('claude-code', command, '/target');
      expect(status.signedIn).toBe(stdout === '{"loggedIn":true}');
      expect(status.detail).not.toContain('private');
      expect(command.mock.calls).toHaveLength(2);
    }
  });
  it('accepts Codex login status on stderr and rejects signed-out/unknown output', async () => {
    for (const stderr of ['Logged in using ChatGPT', 'Logged in using an API key', 'Not logged in', 'ok']) {
      const command = vi.fn(async () => ({ stdout: '', stderr }));
      expect((await checkHarness('codex', command)).signedIn).toBe(stderr.startsWith('Logged in'));
    }
  });
  it.each(['claude-code', 'codex'] as const)('handles missing and failed status for %s without secrets or fallback', async harness => {
    const command = vi.fn(async () => { throw new Error('secret-bearing failure'); });
    expect(await checkHarness(harness, command)).toMatchObject({ installed: false, signedIn: false });
    expect(command).toHaveBeenCalledOnce();
    let calls = 0;
    const status = await checkHarness(harness, async () => { if (++calls === 2) throw new Error('secret'); return { stdout: 'v1', stderr: '' }; });
    expect(status).toMatchObject({ installed: true, signedIn: false });
    expect(status.detail).not.toContain('secret');
  });
  it('limits the proposed edit rules and shell commands instead of allowing all Bash', () => {
    const allow = claudeAllowList({ command: 'npm test', setupCommand: 'npm ci' });
    expect(allow).toContain('Edit(./**)');
    expect(allow).toContain('Write(./**)');
    expect(allow).toContain(claudeScripts({ command: 'npm test', setupCommand: 'npm ci' })[0]!.rule);
    expect(allow.join(' ')).not.toContain('Bash(npm');
    expect(allow).not.toContain('Bash');
    expect(allow.join(' ')).not.toContain('bypass');
    expect(() => claudeAllowList({ command: 'npm test\nrm -rf /' })).toThrow('single-line');
  });
  it('binds portable script consent to exact contents and refuses legacy, edited or broad rules', () => {
    const test = { command: "find js -name '*.js' -print0 | xargs -0 -n1 node --check", setupCommand: 'make setup' };
    const allow = claudeAllowList(test);
    expect(() => requireClaudeScriptConsent(allow, test)).not.toThrow();
    expect(claudeScripts(test)[0]!.contents).toBe(`#!/bin/sh\nset -e\n${test.command}\n`);
    expect(allow.join(' ')).not.toContain('/tmp/');
    expect(() => requireClaudeScriptConsent(['Bash(make test)'], test)).toThrow('re-run tally init');
    expect(() => requireClaudeScriptConsent(allow, { ...test, command: 'make test' })).toThrow('re-run tally init');
    expect(() => requireClaudeScriptConsent([...allow, 'Bash(*)'], test)).toThrow('re-run tally init');
  });
});
