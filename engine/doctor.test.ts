import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor, type DoctorRunner } from './doctor.js';

describe('runDoctor', () => {
  it('reports product status and exact fix commands', async () => {
    const runner: DoctorRunner = async (file, args) => {
      const command = `${file} ${args.join(' ')}`;
      if (command === 'ao status') return { stdout: 'ok', stderr: '' };
      if (command === 'gh auth status') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (command === 'entire --version') return { stdout: 'entire 1', stderr: '' };
      if (command === 'entire graph --help') throw new Error('no graph');
      throw new Error(command);
    };
    const lines = await runDoctor({
      runner,
      env: { NEATLOGS_API_KEY: 'set' },
      cfoaiCheck: async () => ({ status: 'ok', detail: 'Tally cached token works against https://api.cfo.ai/mcp' }),
    });
    expect(lines.find((line) => line.product === 'AO daemon')).toMatchObject({ status: 'connected' });
    expect(lines.find((line) => line.product === 'GitHub CLI')).toMatchObject({ status: 'missing', fix: 'gh auth login' });
    expect(lines.find((line) => line.product === 'Entire graph plugin')).toMatchObject({ status: 'broken', fix: 'entire enable' });
    expect(lines.find((line) => line.product === 'neatlogs key')).toMatchObject({ status: 'connected' });
    expect(lines.find((line) => line.product === 'cfo.ai')).toMatchObject({ status: 'connected' });
  });

  it('reports cfo.ai from Tally token state with the Tally login fix', async () => {
    const runner: DoctorRunner = async () => ({ stdout: 'ok', stderr: '' });
    const lines = await runDoctor({
      runner,
      env: { NEATLOGS_API_KEY: 'set' },
      cfoaiCheck: async () => ({ status: 'missing', detail: 'Tally has no cached cfo.ai token. Run `tally login cfoai` to connect cfo.ai.' }),
    });

    expect(lines.find((line) => line.product === 'cfo.ai')).toMatchObject({
      status: 'missing',
      detail: 'Tally has no cached cfo.ai token. Run `tally login cfoai` to connect cfo.ai.',
      fix: 'tally login cfoai',
    });
  });

  it('reports target AO worker auto mode from tally.yaml', async () => {
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
      if (command === 'ao status') return { stdout: 'ok', stderr: '' };
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
      status: 'broken',
      detail: expect.stringContaining('worker permission mode is default'),
      fix: expect.stringContaining('ao project set-config fly-doom-jev --config-json'),
    });
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
