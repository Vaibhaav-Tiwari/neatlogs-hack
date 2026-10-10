import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { validateRealRunConfig, workerAutoModeFixCommand } from './preflight.js';
import { runTally } from './run.js';

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
      `worker permission mode is unset; unattended Tally workers can stall before running setup, tests, git push, or gh pr create; fix: ${workerAutoModeFixCommand('fly-doom-jev', projectConfig)}`,
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
});
