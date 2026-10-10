import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ledger, RunState } from '../schema/index.js';
import { createDryRunPorts } from './dry-run.js';
import { runRealTally, type RealRunOptions } from './real.js';
import { DEFAULT_LATEST_RUN_DIR } from './output.js';
import { loadConfig } from './config.js';
import { validateRealRunConfig, type PreflightRunner } from './preflight.js';

export interface RunOptions {
  configPath: string;
  dryRun: boolean;
  baseline: boolean;
  budgetUsd?: number;
  only?: string;
  outputDir?: string;
  latestRunDir?: string;
  now?: () => Date;
  preflightRunner?: PreflightRunner;
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
  const config = loadConfig(options.configPath);
  if (!options.dryRun) await validateRealRunConfig(config, options.configPath, options.preflightRunner);
  const ports = options.dryRun ? { ...createDryRunPorts({ config, configPath: options.configPath }), ...(options as RealRunOptions).ports } : (options as RealRunOptions).ports;
  return runRealTally({ ...(options as RealRunOptions), ...(ports ? { ports } : {}) });
}

function demoConfigPath(live = false): string {
  const file = live ? 'tally.live.yaml' : 'tally.yaml';
  const candidates = [
    resolve('demo', file),
    fileURLToPath(new URL(`../demo/${file}`, import.meta.url)),
    fileURLToPath(new URL(`../../demo/${file}`, import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export async function runDemo(options: Pick<RunOptions, 'outputDir' | 'latestRunDir' | 'now'> & { live?: boolean } = {}): Promise<RunResult> {
  return runTally({
    configPath: demoConfigPath(options.live),
    dryRun: true,
    baseline: false,
    outputDir: options.outputDir,
    latestRunDir: options.latestRunDir ?? DEFAULT_LATEST_RUN_DIR,
    now: options.now,
  });
}
