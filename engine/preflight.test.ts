import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { validateRealRunConfig, workerAutoModeFixCommand } from './preflight.js';
import { runTally } from './run.js';
import { CommandError } from '../adapters/command.js';
import { claudeAllowList } from './harness.js';

function writeConfig(extraRepo = '') {
  const dir = mkdtempSync(join(tmpdir(), 'tally-preflight-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(dir, 'backlog.yaml'), 'tasks:\n  - id: T1\n    title: Tiny fix\n    size: small\n');
  const configPath = join(dir, 'tally.yaml');
  writeFileSync(
    configPath,
    `version: 1
repo: { path: "repo", baseBranch: "main"${extraRepo} }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: claude-code
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
  return { configPath };
}

describe('real run preflight', () => {
  it('checks the configured direct harness without requiring an AO project or session mode', async () => {
    const { configPath } = writeConfig();
    const config = loadConfig(configPath);
    config.runner = 'direct';
    config.claudeCode = { allow: claudeAllowList(config.test) };
    delete config.tiers[0]!.sessionMode;
    const calls: string[] = [];
    await validateRealRunConfig(config, configPath, async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return { stdout: '{"loggedIn":true}', stderr: '' };
    });
    expect(calls).toEqual(['claude --version', 'claude auth status']);
    config.tiers[0]!.harness = 'codex';
    await expect(validateRealRunConfig(config, configPath, async () => ({ stdout: '{}', stderr: '' }))).rejects.toThrow('no harness will be substituted');
  });
  it('requires direct Claude consent before checking auth or spawning', async () => {
    const { configPath } = writeConfig();
    const config = loadConfig(configPath);
    config.runner = 'direct';
    const calls: string[] = [];
    await expect(validateRealRunConfig(config, configPath, async file => {
      calls.push(file);
      return { stdout: '{"loggedIn":true}', stderr: '' };
    })).rejects.toThrow('run tally init');
    expect(calls).toEqual([]);
    config.claudeCode = { allow: ['Edit(./**)', 'Write(./**)', 'Bash(npm test)'] };
    await expect(validateRealRunConfig(config, configPath, async file => {
      calls.push(file);
      return { stdout: '{"loggedIn":true}', stderr: '' };
    })).rejects.toThrow('re-run tally init');
    expect(calls).toEqual([]);
  });
  it('reports missing AO executable as a prerequisite error before any run output or worker', async () => {
    const { configPath } = writeConfig(', aoProject: "test-project"');
    await expect(runTally({ configPath, dryRun: false, baseline: false, preflightRunner: async () => {
      throw new CommandError('Agent Orchestrator (AO) is required; set TALLY_AO_BIN to its executable path.', 'ENOENT');
    } })).rejects.toThrow('set TALLY_AO_BIN');
  });
  it('requires repo.aoProject before a real run can spawn a worker', async () => {
    const { configPath } = writeConfig();
    await expect(
      runTally({ configPath, dryRun: false, baseline: false, preflightRunner: async () => ({ stdout: '{}', stderr: '' }) }),
    ).rejects.toThrow('repo.aoProject is required');
  });

  it('checks that repo.aoProject exists in AO', async () => {
    const { configPath } = writeConfig(', aoProject: "missing-project"');
    await expect(
      validateRealRunConfig(loadConfig(configPath), configPath, async () => {
        throw new Error('not found');
      }),
    ).rejects.toThrow('ao project add');
  });

  it('requires the target AO project worker to run in auto mode before spawning', async () => {
    const { configPath } = writeConfig(', aoProject: "fly-doom-jev"');
    const projectConfig = {
      canonicalRepoURL: 'https://github.com/Vaibhaav-Tiwari/fly-doom-jev',
      defaultBranch: 'main',
      agentConfig: { permissions: 'auto' },
      worker: { agent: 'claude-code', agentConfig: {} },
      orchestrator: { agentConfig: {} },
    };

    await expect(
      validateRealRunConfig(loadConfig(configPath), configPath, async () => ({
        stdout: JSON.stringify({ project: { config: projectConfig } }),
        stderr: '',
      })),
    ).rejects.toThrow(
      `worker permission mode is unset; unattended Tally workers can stall before setup, edits, tests, or commits; fix: ${workerAutoModeFixCommand('fly-doom-jev', projectConfig)}`,
    );
  });

  it('accepts worker-scoped auto mode for a real run', async () => {
    const { configPath } = writeConfig(', aoProject: "fly-doom-jev"');
    await expect(
      validateRealRunConfig(loadConfig(configPath), configPath, async () => ({
        stdout: JSON.stringify({
          project: {
            config: {
              agentConfig: { permissions: 'default' },
              worker: { agent: 'claude-code', agentConfig: { permissions: 'auto' } },
            },
          },
        }),
        stderr: '',
      })),
    ).resolves.toBeUndefined();
  });

  it('requires test setup to run in AO post-create before the worker starts', async () => {
    const { configPath } = writeConfig(', aoProject: "fly-doom-jev"');
    const config = loadConfig(configPath);
    config.test.setupCommand = 'make setup';
    const projectConfig = {
      canonicalRepoURL: 'https://github.com/Vaibhaav-Tiwari/fly-doom-jev',
      defaultBranch: 'main',
      worker: { agent: 'codex', agentConfig: { permissions: 'auto' } },
    };

    await expect(
      validateRealRunConfig(config, configPath, async () => ({
        stdout: JSON.stringify({ project: { config: projectConfig } }),
        stderr: '',
      })),
    ).rejects.toThrow('test.setupCommand is "make setup", but AO project postCreate does not run it before the worker starts');
  });

  it('accepts test setup when AO post-create runs it before the worker starts', async () => {
    const { configPath } = writeConfig(', aoProject: "fly-doom-jev"');
    const config = loadConfig(configPath);
    config.test.setupCommand = 'make setup';

    await expect(
      validateRealRunConfig(config, configPath, async () => ({
        stdout: JSON.stringify({
          project: {
            config: {
              worker: { agent: 'codex', agentConfig: { permissions: 'auto' } },
              postCreate: ['make setup'],
            },
          },
        }),
        stderr: '',
      })),
    ).resolves.toBeUndefined();
  });

  it('requires an explicit TUI session mode for real worker tiers', async () => {
    const { configPath } = writeConfig(', aoProject: "fly-doom-jev"');
    const config = loadConfig(configPath);
    delete config.tiers[0]!.sessionMode;

    await expect(
      validateRealRunConfig(config, configPath, async () => ({
        stdout: JSON.stringify({ project: { config: { worker: { agentConfig: { permissions: 'auto' } } } } }),
        stderr: '',
      })),
    ).rejects.toThrow('tiers[0].sessionMode is required for real runs');
  });

  it('rejects chat-mode worker tiers for real runs', async () => {
    const { configPath } = writeConfig(', aoProject: "fly-doom-jev"');
    const config = loadConfig(configPath);
    config.tiers[0]!.sessionMode = 'chat';

    await expect(
      validateRealRunConfig(config, configPath, async () => ({
        stdout: JSON.stringify({ project: { config: { worker: { agentConfig: { permissions: 'auto' } } } } }),
        stderr: '',
      })),
    ).rejects.toThrow('tiers[0].sessionMode is "chat"');
  });
});
