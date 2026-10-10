import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Ledger, RunState } from '../schema/index.js';
import { createDryRunPorts } from './dry-run.js';
import { runRealTally, type RealRunOptions } from './real.js';
import { DEFAULT_LATEST_RUN_DIR } from './output.js';

export interface RunOptions {
  configPath: string;
  dryRun: boolean;
  baseline: boolean;
  budgetUsd?: number;
  only?: string;
  outputDir?: string;
  latestRunDir?: string;
  now?: () => Date;
}

export interface RunResult {
  runState: RunState;
  ledger: Ledger;
  outputDir: string;
  runStatePath: string;
  ledgerPath: string;
  latestRunDir: string;
}

export class RunError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'RunError';
  }
}

export async function runTally(options: RunOptions | RealRunOptions): Promise<RunResult> {
  const ports = options.dryRun ? { ...createDryRunPorts(), ...(options as RealRunOptions).ports } : (options as RealRunOptions).ports;
  return runRealTally({ ...(options as RealRunOptions), ...(ports ? { ports } : {}) });
}

function demoConfigPath(): string {
  const fromCwd = resolve('demo/tally.yaml');
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(new URL('../demo/tally.yaml', import.meta.url).pathname);
}

export async function runDemo(options: Pick<RunOptions, 'outputDir' | 'latestRunDir' | 'now'> = {}): Promise<RunResult> {
  return runTally({
    configPath: demoConfigPath(),
    dryRun: true,
    baseline: false,
    outputDir: options.outputDir,
    latestRunDir: options.latestRunDir ?? DEFAULT_LATEST_RUN_DIR,
    now: options.now,
  });
}
