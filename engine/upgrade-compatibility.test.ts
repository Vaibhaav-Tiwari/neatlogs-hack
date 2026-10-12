import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createDryRunPorts } from './dry-run.js';
import { runRealTally } from './real.js';

it('runs a published 0.1.0 init config unchanged and sequentially despite legacy concurrency: 3', async () => {
  const configPath = fileURLToPath(new URL('../schema/fixtures/init-010/tally.yaml', import.meta.url));
  const config = loadConfig(configPath);
  expect(config.parallelWorkers).toBeUndefined();
  expect(config.modelAccessFallbackTier).toBeUndefined();
  expect(config.concurrency).toBe(3);
  const dir = mkdtempSync(join(tmpdir(), 'tally-upgrade-'));
  const dry = createDryRunPorts();
  const events: string[] = [];
  const worker = dry.worker!;
  try {
    const result = await runRealTally({ configPath, dryRun: true, baseline: false, outputDir: join(dir, 'out'), latestRunDir: join(dir, 'latest'),
      ports: { ...dry,
        intake: { tasks: async () => ['T1', 'T2'].map(taskId => ({ taskId, title: 'Fix a small tested file', body: 'Expected one value', issueNumber: null, issueUrl: null, size: 'small' as const, outcomes: ['passed' as const] })) },
        signals: { signalsFor: async () => ({ filesTouched: 1, dependents: 0, testsPresent: true, source: 'code-search' as const }) },
        worker: {
          start: async input => { events.push(`start:${input.task.taskId}`); return worker.start(input); },
          wait: async id => { const result = await worker.wait(id); events.push(`end:${id}`); return result; },
        },
      } });
    expect(result.runState.tasks.every(task => task.status === 'passed')).toBe(true);
    expect(events.map(event => event.split(':')[0])).toEqual(['start', 'end', 'start', 'end']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
