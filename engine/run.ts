import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ledger, RunState } from '../schema/index.js';
import { createDryRunPorts } from './dry-run.js';
import { runRealTally, type RealRunOptions } from './real.js';
import { DEFAULT_LATEST_RUN_DIR } from './output.js';
import { loadConfig } from './config.js';
import { validateRealRunConfig, type PreflightRunner } from './preflight.js';

export type RunProgress =
  | { type: 'budget'; budget: RunState['budget'] }
  | { type: 'route'; taskId: string; size: string; confidence: number; tier: string | null; harness: string | null; model: string | null; ceilingNanos: number | null; decision: string }
  | { type: 'worker'; taskId: string; attempt: number; sessionId: string; tier: string }
  | { type: 'spend'; taskId: string; attempt: number; costNanos: number }
  | { type: 'result'; row: Ledger[number] };

export interface RunOptions {
  configPath: string;
  dryRun: boolean;
  baseline: boolean;
  budgetUsd?: number;
  parallel?: number;
  only?: string;
  outputDir?: string;
  latestRunDir?: string;
  now?: () => Date;
  preflightRunner?: PreflightRunner;
  /** Experiment pin: reject a different resolved repository base before starting workers. */
  requiredBaseCommit?: string;
  runId?: string;
  repeat?: number;
  stopRequested?: () => string | null;
  /** Experiments verify local commits without pushing branches or opening PRs. */
  publish?: boolean;
  onEvent?: (event: RunProgress) => void;
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

export async function runDemo(options: Pick<RunOptions, 'outputDir' | 'latestRunDir' | 'now' | 'onEvent'> & { live?: boolean } = {}): Promise<RunResult> {
  return runTally({
    configPath: demoConfigPath(options.live),
    dryRun: true,
    baseline: false,
    outputDir: options.outputDir,
    latestRunDir: options.latestRunDir ?? DEFAULT_LATEST_RUN_DIR,
    now: options.now,
    onEvent: options.onEvent,
  });
}
