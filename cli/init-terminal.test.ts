import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = new URL('../', import.meta.url).pathname;

describe('init process lifecycle', () => {
  it('rejects piped interactive input with a plain actionable error and exits', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tally-init-pipe-'));
    await expect(exec(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'cli/main.ts'), 'init'], { cwd, timeout: 4000 }))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('use --yes with --test-command') });
    expect(existsSync(join(cwd, 'tally.yaml'))).toBe(false);
  }, 5000);

  it.skipIf(!existsSync('/usr/bin/expect')).each(['cancel', 'apply', 'error', 'eof'] as const)('exits after %s in a real PTY with fake external ports', async mode => {
    const cwd = mkdtempSync(join(tmpdir(), 'tally-init-pty-'));
    const driver = join(cwd, 'driver.mjs');
    writeFileSync(driver, `import { runInit } from ${JSON.stringify(new URL('../engine/init.ts', import.meta.url).href)};
      const command = async (file, args) => ({stdout: file === 'git' && args[0] === 'rev-parse' ? process.cwd()
        : args[0] === 'agent' ? JSON.stringify({installed:[{id:'codex'}]})
        : args[1] === 'get' ? JSON.stringify({project:{config:{}}}) : '', stderr:''});
      try { const result = await runInit({command, onboarding: async () => {}, doctor: async () => {
        if (process.env.TALLY_TEST_MODE === 'error') throw new Error('fake doctor failure'); return [];
      }}); console.log('RESULT', result.applied ? 'applied' : 'cancelled'); }
      catch (error) { console.error(error.message); process.exitCode = 2; }
    `);
    const script = `set timeout 5
      spawn $env(TALLY_TEST_NODE) --import $env(TALLY_TEST_TSX) $env(TALLY_TEST_DRIVER)
      expect -exact "Test command (shell command)"
      if {$env(TALLY_TEST_MODE) == "eof"} {
        send -- "\\004"
      } else {
        send -- "node --check app.js\\r"
        expect -exact "Setup command"
        send -- "\\r"
        expect -exact "Monthly budget"
        send -- "5\\r"
        expect -exact "GitHub issue label"
        send -- "tally\\r"
        expect -exact "Enable neatlogs"
        send -- "n\\r"
        expect -exact "Enable Entire"
        send -- "n\\r"
        expect -exact "Enable cfo.ai"
        send -- "n\\r"
        expect -exact "Apply these changes?"
        if {$env(TALLY_TEST_MODE) == "cancel"} {send -- "n\\r"} else {send -- "y\\r"}
      }
      expect {
        eof {puts "CHILD_EXIT [lindex [wait] 3]"}
        timeout {exec kill [exp_pid]; exit 99}
      }
    `;
    const result = await exec('/usr/bin/expect', ['-c', script], { cwd, timeout: 8000, env: { ...process.env,
      TALLY_TEST_NODE: process.execPath, TALLY_TEST_TSX: join(root, 'node_modules/tsx/dist/loader.mjs'), TALLY_TEST_DRIVER: driver, TALLY_TEST_MODE: mode,
    } });
    expect(result.stdout).toContain(`CHILD_EXIT ${mode === 'error' || mode === 'eof' ? 2 : 0}`);
    expect(existsSync(join(cwd, 'tally.yaml'))).toBe(mode === 'apply' || mode === 'error');
    if (mode === 'eof') expect(result.stdout).toContain('Init input closed');
  }, 10000);
});
