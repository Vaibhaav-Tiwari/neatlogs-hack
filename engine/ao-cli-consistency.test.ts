import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AoCliAdapter } from '../adapters/ao.js';
import { runInit } from './init.js';
import { runDoctor } from './doctor.js';
import * as commands from '../adapters/command.js';

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
}

describe('ordinary-terminal AO CLI consistency', () => {
  // Only AO needs real subprocess resolution; unrelated prerequisites are fakes.
  it.each(['init', 'doctor', 'adapter'])('%s uses the fallback binary when ao is absent from PATH', async (consumer) => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-outside-ao-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const aoBin = join(dir, 'ao-cli');
    script(aoBin, `case "$1" in\nagent) printf '{"installed":[{"id":"claude-code"}]}' ;;\nproject) printf '{"project":{"config":{"worker":{"agentConfig":{"permissions":"auto"}}}}}' ;;\nstatus) printf '{"state":"running"}' ;;\n*) printf 'ok' ;;\nesac`);
    script(join(bin, 'git'), `case "$1" in\nrev-parse) printf '%s' "$PWD" ;;\nbranch) printf 'main' ;;\n*) printf 'ok' ;;\nesac`);
    script(join(bin, 'gh'), "printf 'ok'");
    script(join(bin, 'claude'), `printf '{"loggedIn":true}'`);
    script(join(bin, 'codex'), `printf 'Logged in using ChatGPT'`);
    writeFileSync(join(dir, 'Makefile'), 'test:\n\ttrue\n');
    vi.stubEnv('PATH', bin);
    vi.stubEnv('TALLY_AO_BIN', aoBin);
    const runCommand = commands.runCommand;
    vi.spyOn(commands, 'runCommand').mockImplementation(async (file, args, options) => {
      if (file === 'ao') return runCommand(file, args, options);
      const stdout = file === 'git' && args[0] === 'rev-parse' ? dir
        : file === 'git' && args[0] === 'branch' ? 'main'
        : file === 'claude' ? '{"loggedIn":true}'
        : file === 'codex' ? 'Logged in using ChatGPT' : 'ok';
      return { stdout, stderr: '' };
    });
    vi.stubGlobal('fetch', async (_url: string, options?: RequestInit) => {
      expect(options?.method).not.toBe('PUT');
      return { ok: true, json: async () => ({ project: { config: {} } }) };
    });
    try {
      if (consumer === 'init') {
        const proposal: string[] = [];
        const result = await runInit({ cwd: dir, dryRun: true, print: line => proposal.push(line) });
        expect(result.applied).toBe(false);
        expect(result.tiers.every((tier) => tier.includes('claude-code'))).toBe(true);
        expect(existsSync(join(dir, '.tally'))).toBe(false);
        expect(proposal.some(line => line.startsWith('Runner: ao'))).toBe(true);
      }
      if (consumer === 'doctor') {
        const lines = await runDoctor({ env: {}, cfoaiCheck: async () => ({ status: 'missing', detail: 'test disabled' }) });
        expect(lines.find((line) => line.product === 'AO daemon')?.status).toBe('off');
        expect(lines.find((line) => line.product === 'Neatlogs key')?.status).toBe('off');
        expect(lines.find((line) => line.product === 'Entire CLI')?.status).toBe('off');
      }
      if (consumer === 'adapter') {
        await new AoCliAdapter({ aoBin, cwd: dir }).stop('fake-test-session', 'test only');
      }
      if (consumer === 'doctor') {
        vi.stubEnv('TALLY_AO_BIN', '');
        const configPath = join(dir, 'doctor.yaml');
        writeFileSync(configPath, JSON.stringify({ version: 1,
          repo: { path: '.', baseBranch: 'main', aoProject: 'fake-test-project', aoBin: 'ao-cli' },
          test: { command: 'make test' }, backlog: { source: 'github-issues', issueLabel: 'tally' },
          tiers: [{ name: 'cheap', harness: 'codex', provider: 'test', model: 'fake', price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 1 }, ceilingFraction: 1 }],
          ceilings: { bySizeUsd: { small: 1, medium: 2, large: 3 } }, budget: { source: 'config', usd: 10 },
          integrations: { neatlogs: false, entire: false, cfoai: false, slack: false },
        }));
        const configuredLines = await runDoctor({ configPath, env: {}, cfoaiCheck: async () => ({ status: 'missing', detail: 'test disabled' }) });
        expect(configuredLines.find((line) => line.product === 'AO daemon')?.status).toBe('connected');
        expect(configuredLines.find((line) => line.product === 'AO worker auto mode')?.status).toBe('connected');
      }
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
  });
});
