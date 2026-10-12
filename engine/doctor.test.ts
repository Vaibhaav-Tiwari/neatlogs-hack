import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig } from './config.js';
import { doctorHasFailures, runDoctor, type DoctorRunner } from './doctor.js';
import { CommandError } from '../adapters/command.js';
import { claudeAllowList } from './harness.js';
import { aoClaudeSetupCommand } from './ao-claude-settings.js';

describe('runDoctor', () => {
  it('shows configured model access as unverified without failing the doctor command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-models-'));
    const configPath = join(dir, 'tally.yaml');
    const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
    config.runner = 'direct';
    config.integrations = { entire: false, neatlogs: false, cfoai: false, slack: false };
    config.budget.source = 'config';
    writeFileSync(configPath, stringify(config));
    const lines = await runDoctor({ configPath, env: {}, runner: async file => ({
      stdout: file === 'claude' ? '{"loggedIn":true}' : file === 'codex' ? 'Logged in using ChatGPT' : 'ok', stderr: '',
    }) });
    const access = lines.find(line => line.product === 'Configured model access');
    expect(access).toMatchObject({ status: 'unverified', detail: expect.stringContaining('does not send a model request before a run'), fix: expect.stringContaining('configured accounts') });
    expect(access && doctorHasFailures([access])).toBe(false);
    expect(doctorHasFailures([{ product: 'Codex', status: 'broken', detail: 'signed out', fix: 'codex login' }])).toBe(true);
  });
  it('reports hosted checkpoint recall as optional when Graph and capture are connected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-recall-'));
    const configPath = join(dir, 'tally.yaml');
    const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
    config.runner = 'direct';
    config.integrations = { entire: true, neatlogs: false, cfoai: false, slack: false };
    config.budget.source = 'config';
    writeFileSync(configPath, stringify(config));
    const lines = await runDoctor({ configPath, env: {}, runner: async (file, args) => {
      if (file === 'entire' && args.includes('search')) throw new CommandError('search failed', 1, '', 'no matching repositories found (is the repo mirrored to Entire?)');
      return { stdout: '{"enabled":true,"loggedIn":true}', stderr: '' };
    } });
    expect(lines.find(line => line.product === 'Entire graph plugin')).toMatchObject({ status: 'connected' });
    expect(lines.find(line => line.product === 'Entire repository')).toMatchObject({ status: 'connected' });
    expect(lines.find(line => line.product === 'Entire checkpoint recall')).toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining('Hosted recall is optional. Local capture and normal task runs remain available.'),
      fix: expect.stringContaining('Optional:'),
    });
    expect(lines.find(line => line.product === 'Entire Web mirror')).toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining('Local checkpoint capture and Git-remote checkpoint sync are separate.'),
      fix: expect.stringContaining('entire repo mirror add'),
    });
    expect(doctorHasFailures(lines.filter(line => line.product === 'Entire checkpoint recall'))).toBe(false);
  });
  it('reports a ready Entire Web mirror separately from local capture and checkpoint recall', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-entire-mirror-'));
    const configPath = join(dir, 'tally.yaml');
    const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
    config.runner = 'direct';
    config.repo.slug = 'acme/widgets';
    config.integrations = { entire: true, neatlogs: false, cfoai: false, slack: false };
    config.budget.source = 'config';
    writeFileSync(configPath, stringify(config));
    const lines = await runDoctor({ configPath, env: {}, runner: async (_file, args) => ({
      stdout: args[0] === 'repo' && args[1] === 'mirror'
        ? JSON.stringify([{ repo: '/gh/acme/widgets', placements: [{ cluster: 'aws-ap-south-1.entire.io', status: 'ready' }] }])
        : '{"enabled":true,"loggedIn":true}',
      stderr: '',
    }) });
    expect(lines.find(line => line.product === 'Entire Web mirror')).toMatchObject({
      status: 'connected',
      detail: 'GitHub repository mirror is ready on aws-ap-south-1.entire.io.',
      fix: null,
    });
    expect(doctorHasFailures(lines.filter(line => line.product === 'Entire Web mirror'))).toBe(false);
  });
  it('reports mixed AO per-harness permission selection without substituting a harness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-mixed-'));
    const configPath = join(dir, 'tally.yaml');
    const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
    config.repo.aoProject = 'mixed';
    config.tiers[1]!.harness = 'codex';
    config.claudeCode = { allow: claudeAllowList(config.test) };
    config.integrations = { neatlogs: false, entire: false, cfoai: false, slack: false };
    writeFileSync(configPath, stringify(config));
    const lines = await runDoctor({ configPath, env: {}, runner: async (file, args) => ({
      stdout: file === 'ao' && args[0] === 'status' ? '{"state":"running"}' : file === 'claude' ? '{"loggedIn":true}' : file === 'codex' ? 'Logged in using ChatGPT'
        : JSON.stringify({ project: { config: { worker: { agentConfig: { permissions: 'default' } } } } }), stderr: '' }) });
    expect(lines.find(line => line.product === 'AO worker auto mode')).toMatchObject({
      status: 'connected', detail: expect.stringContaining('immediately before each spawn under a project lock'),
      fix: null,
    });
  });
  it('reports disabled products as off, without checking credentials or optional CLIs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-off-'));
    const configPath = join(dir, 'tally.yaml');
    const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
    config.repo.aoProject = 'scratch';
    config.integrations = { neatlogs: false, entire: false, cfoai: false, slack: false };
    config.budget.source = 'config';
    config.claudeCode = { allow: claudeAllowList(config.test) };
    writeFileSync(configPath, stringify(config));
    const runner = vi.fn(async (file: string, args: string[]) => ({ stdout: file === 'ao' && args[0] === 'status' ? '{"state":"running"}' : file === 'claude' ? '{"loggedIn":true}' : JSON.stringify({ project: { config: { worker: { agentConfig: { permissions: 'default' } }, postCreate: [aoClaudeSetupCommand(configPath)] } } }), stderr: '' }));
    const check = vi.fn(async () => ({ status: 'missing' as const, detail: 'no token' }));
    const lines = await runDoctor({ runner, configPath, env: {}, cfoaiCheck: check });
    expect(lines.filter(line => ['Neatlogs key', 'Entire CLI', 'Entire graph plugin', 'cfo.ai'].includes(line.product)).every(line => line.status === 'off' && line.fix === null)).toBe(true);
    expect(check).not.toHaveBeenCalled();
    expect(runner.mock.calls.some(call => call[0] === 'entire')).toBe(false);
    expect(lines.some(line => line.status === 'missing' || line.status === 'broken')).toBe(false);
  });
  it('reports a missing AO executable honestly instead of daemon-only connectivity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-ao-missing-'));
    const configPath = join(dir, 'tally.yaml');
    const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
    config.runner = 'ao';
    delete config.repo.aoProject;
    config.integrations = { neatlogs: false, entire: false, cfoai: false, slack: false };
    writeFileSync(configPath, stringify(config));
    const detail = 'Agent Orchestrator (AO) is required; looked in PATH and app bundles; set TALLY_AO_BIN to its executable path.';
    const lines = await runDoctor({ runner: async (file) => {
      if (file === 'ao') throw new CommandError(detail, 'ENOENT');
      return { stdout: 'ok', stderr: '' };
    }, configPath, env: {}, cfoaiCheck: async () => ({ status: 'missing', detail: 'test' }) });
    expect(lines.find((line) => line.product === 'AO daemon')).toMatchObject({ status: 'missing', detail, fix: expect.stringContaining('TALLY_AO_BIN') });
  });
  it('keeps optional integrations off before init without probing local credentials', async () => {
    const runner = vi.fn(async (_file: string, _args: string[] = []) => ({ stdout: 'ok', stderr: '' }));
    const cfoaiCheck = vi.fn(async () => ({ status: 'ok' as const, detail: 'connected' }));
    const lines = await runDoctor({ runner, env: { NEATLOGS_API_KEY: 'present' }, cfoaiCheck });
    expect(lines.filter(line => ['AO daemon', 'Entire CLI', 'Entire graph plugin', 'Neatlogs key', 'cfo.ai'].includes(line.product))
      .every(line => line.status === 'off' && line.fix === null)).toBe(true);
    expect(doctorHasFailures(lines)).toBe(false);
    expect(runner.mock.calls.some(([file]) => file === 'ao' || file === 'entire')).toBe(false);
    expect(cfoaiCheck).not.toHaveBeenCalled();
  });
  it('reports a stopped configured AO daemon as broken with the start command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-ao-stopped-'));
    const configPath = join(dir, 'tally.yaml');
    const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
    config.runner = 'ao';
    delete config.repo.aoProject;
    config.integrations = { neatlogs: false, entire: false, cfoai: false, slack: false };
    writeFileSync(configPath, stringify(config));
    const lines = await runDoctor({ configPath, runner: async (file, args) => ({
      stdout: file === 'ao' && args[0] === 'status' ? '{"state":"stopped"}' : 'ok', stderr: '' }), env: {} });
    expect(lines.find(line => line.product === 'AO daemon')).toMatchObject({ status: 'broken', detail: 'AO daemon is stopped', fix: 'ao start' });
  });
  it('reports product status and exact fix commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-products-'));
    const configPath = join(dir, 'tally.yaml');
    const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
    config.runner = 'direct';
    config.integrations = { neatlogs: true, entire: false, cfoai: true, slack: false };
    config.budget.source = 'config';
    writeFileSync(configPath, stringify(config));
    const runner: DoctorRunner = async (file, args) => {
      const command = `${file} ${args.join(' ')}`;
      if (command === 'gh auth status') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (file === 'claude') return { stdout: args[0] === 'auth' ? '{"loggedIn":true}' : 'Claude 1', stderr: '' };
      throw new Error(command);
    };
    const lines = await runDoctor({
      runner,
      configPath,
      env: { NEATLOGS_API_KEY: 'set' },
      cfoaiCheck: async () => ({ status: 'ok', detail: 'Tally cached token works against https://api.cfo.ai/mcp' }),
    });
    expect(lines.find((line) => line.product === 'AO daemon')).toMatchObject({ status: 'off' });
    expect(lines.find((line) => line.product === 'GitHub CLI')).toMatchObject({ status: 'missing', fix: 'gh auth login' });
    expect(lines.find((line) => line.product === 'Entire graph plugin')).toMatchObject({ status: 'off' });
    expect(lines.find((line) => line.product === 'Neatlogs key')).toMatchObject({ status: 'connected' });
    expect(lines.find((line) => line.product === 'cfo.ai')).toMatchObject({ status: 'connected' });
  });

  it('reports cfo.ai from Tally token state with the Tally login fix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-cfoai-'));
    const configPath = join(dir, 'tally.yaml');
    const config = loadConfig(new URL('../demo/tally.yaml', import.meta.url).pathname);
    config.runner = 'direct';
    config.integrations = { neatlogs: false, entire: false, cfoai: true, slack: false };
    config.budget.source = 'config';
    writeFileSync(configPath, stringify(config));
    const runner: DoctorRunner = async () => ({ stdout: 'ok', stderr: '' });
    const lines = await runDoctor({
      runner,
      configPath,
      env: { NEATLOGS_API_KEY: 'set' },
      cfoaiCheck: async () => ({ status: 'missing', detail: 'Tally has no cached cfo.ai token. Run `tally login cfoai` to connect cfo.ai.' }),
    });

    expect(lines.find((line) => line.product === 'cfo.ai')).toMatchObject({
      status: 'missing',
      detail: 'Tally has no cached cfo.ai token. Run `tally login cfoai` to connect cfo.ai.',
      fix: 'tally login cfoai',
    });
  });

  it('reports Claude default launch mode and missing prelaunch local settings separately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-'));
    mkdirSync(join(dir, 'repo'));
    const configPath = join(dir, 'tally.yaml');
    writeFileSync(
      configPath,
      `version: 1
repo: { path: "repo", baseBranch: "main", aoProject: "fly-doom-jev" }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: claude-code
    provider: test
    model: test-model
    price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 1 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 2, large: 3 }
budget: { source: config, usd: 10 }
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
`,
    );
    writeFileSync(join(dir, 'backlog.yaml'), 'tasks: []\n');
    const runner: DoctorRunner = async (file, args) => {
      const command = `${file} ${args.join(' ')}`;
      if (command === 'ao status --json') return { stdout: '{"state":"running"}', stderr: '' };
      if (command === 'ao project get fly-doom-jev --json') {
        return {
          stdout: JSON.stringify({
            project: {
              config: {
                worker: { agent: 'claude-code', agentConfig: { permissions: 'default' } },
              },
            },
          }),
          stderr: '',
        };
      }
      return { stdout: 'ok', stderr: '' };
    };

    const lines = await runDoctor({
      runner,
      configPath,
      env: { NEATLOGS_API_KEY: 'set' },
      cfoaiCheck: async () => ({ status: 'ok', detail: 'connected' }),
    });

    expect(lines.find((line) => line.product === 'AO worker auto mode')).toMatchObject({
      status: 'connected',
      detail: expect.stringContaining('worker permission mode is default'),
      fix: null,
    });
    expect(lines.find(line => line.product === 'AO setup post-create')).toMatchObject({ status: 'broken', fix: expect.stringContaining('tally-worker-settings.js') });
  });

  it('reports target AO setup post-create from tally.yaml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-doctor-'));
    mkdirSync(join(dir, 'repo'));
    const configPath = join(dir, 'tally.yaml');
    writeFileSync(
      configPath,
      `version: 1
repo: { path: "repo", baseBranch: "main", aoProject: "fly-doom-jev" }
test: { setupCommand: "make setup", command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: codex
    sessionMode: tui
    provider: test
    model: test-model
    price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 1 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 2, large: 3 }
budget: { source: config, usd: 10 }
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
`,
    );
    writeFileSync(join(dir, 'backlog.yaml'), 'tasks: []\n');
    const runner: DoctorRunner = async (file, args) => {
      const command = `${file} ${args.join(' ')}`;
      if (command === 'ao status --json') return { stdout: '{"state":"running"}', stderr: '' };
      if (command === 'ao project get fly-doom-jev --json') {
        return {
          stdout: JSON.stringify({
            project: {
              config: {
                worker: { agent: 'codex', agentConfig: { permissions: 'auto' } },
                postCreate: [],
              },
            },
          }),
          stderr: '',
        };
      }
      return { stdout: 'ok', stderr: '' };
    };

    const lines = await runDoctor({
      runner,
      configPath,
      env: { NEATLOGS_API_KEY: 'set' },
      cfoaiCheck: async () => ({ status: 'ok', detail: 'connected' }),
    });

    expect(lines.find((line) => line.product === 'AO setup post-create')).toMatchObject({
      status: 'broken',
      detail: 'test.setupCommand is "make setup", but AO project postCreate does not run it before the worker starts',
      fix: expect.stringContaining('"postCreate":["make setup"]'),
    });
  });
});
