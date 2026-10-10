import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BacklogError } from '../engine/backlog.js';
import { ConfigError } from '../engine/config.js';
import { runDoctor } from '../engine/doctor.js';
import { planTally } from '../engine/plan.js';
import { RunError, runDemo, runTally } from '../engine/run.js';
import { loginCfoai } from '../adapters/cfoai.js';
import { nanosToUsd } from '../schema/index.js';
import { startDashboardServer } from './dashboard-server.js';

export const COMMANDS = ['run', 'demo', 'dashboard', 'init', 'doctor', 'login'] as const;
export type Command = (typeof COMMANDS)[number];

export const VERSION = '0.1.0';

export interface CliOptions {
  /** Path to tally.yaml. */
  config: string;
  /** Simulated workers with scripted outcomes; spends nothing. */
  dryRun: boolean;
  /** Send every task to the strongest tier, for the before/after comparison. */
  baseline: boolean;
  /** Overrides the budget in tally.yaml. */
  budgetUsd: number | undefined;
  /** Run a single task by id or issue number. */
  only: string | undefined;
  /** Start the local dashboard server after the command finishes. */
  dashboard: boolean;
  /** Port for the dashboard server. */
  port: number | undefined;
  /** Print route decisions without spawning workers. */
  plan: boolean;
  /** Integration to authenticate for `tally login`. */
  loginTarget: 'cfoai' | undefined;
}

export type ParsedCli =
  | { kind: 'command'; command: Command; options: CliOptions }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const USAGE = `tally: a CFO for a fleet of coding agents

Usage: tally <command> [options]

Commands:
  run      Run the backlog against the budget in tally.yaml
  demo     Run the full loop with simulated workers on a sample backlog
  dashboard Start the local dashboard server
  init     Set up tally.yaml for the current repository
  doctor   Check that each integration is connected
  login    Connect an integration, e.g. tally login cfoai

Options:
  --config <path>   Path to tally.yaml (default: tally.yaml)
  --dry-run         Simulate workers; spends nothing
  --budget <usd>    Override the budget for this run
  --only <task>     Run a single task
  --baseline        Send every task to the strongest tier
  --dashboard       Start the dashboard server after run/demo
  --open            Alias for --dashboard
  --port <number>   Dashboard port (default: 5177; use 0 for any free port)
  --plan            Size and route tasks, but do not spawn workers
  -h, --help        Show this help
  -v, --version     Show the version`;

export function parseCli(argv: string[]): ParsedCli {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', default: 'tally.yaml' },
        'dry-run': { type: 'boolean', default: false },
        baseline: { type: 'boolean', default: false },
        budget: { type: 'string' },
        only: { type: 'string' },
        dashboard: { type: 'boolean', default: false },
        open: { type: 'boolean', default: false },
        port: { type: 'string' },
        plan: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };
  const [name, ...extra] = positionals;
  if (name === undefined) return { kind: 'help' };
  if (!(COMMANDS as readonly string[]).includes(name)) {
    return { kind: 'error', message: `unknown command "${name}"; expected one of ${COMMANDS.join(', ')}` };
  }
  if (name === 'login') {
    if (extra[0] !== 'cfoai') return { kind: 'error', message: 'login expects an integration: cfoai' };
    if (extra.length > 1) return { kind: 'error', message: `unexpected argument "${extra[1]}"` };
  } else if (extra.length > 0) {
    return { kind: 'error', message: `unexpected argument "${extra[0]}"` };
  }

  let budgetUsd: number | undefined;
  if (values.budget !== undefined) {
    budgetUsd = Number(values.budget);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      return { kind: 'error', message: `--budget must be a positive number of USD, got "${values.budget}"` };
    }
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return { kind: 'error', message: `--port must be an integer from 0 to 65535, got "${values.port}"` };
    }
  }
  return {
    kind: 'command',
    command: name as Command,
    options: {
      config: values.config,
      dryRun: values['dry-run'],
      baseline: values.baseline,
      budgetUsd,
      only: values.only,
      dashboard: values.dashboard || values.open,
      port,
      plan: values.plan,
      loginTarget: name === 'login' ? 'cfoai' : undefined,
    },
  };
}

type Handler = (options: CliOptions, io: CliIO) => Promise<number>;

const stub =
  (command: Command): Handler =>
  async (_options, io) => {
    io.stdout(`tally ${command}: not implemented yet`);
    return 0;
  };

async function runCommand(options: CliOptions, io: CliIO): Promise<number> {
  try {
    if (options.plan) {
      const plan = await planTally({
        configPath: options.config,
        dryRun: options.dryRun,
        baseline: options.baseline,
        budgetUsd: options.budgetUsd,
        only: options.only,
      });
      for (const task of plan) {
        const route = task.skipped
          ? 'skip'
          : `${task.tier} ${task.harness}/${task.model} ceiling ${task.ceilingNanos === null ? 'none' : `$${nanosToUsd(task.ceilingNanos).toFixed(2)}`}`;
        io.stdout(`${task.taskId}: ${task.size} -> ${route}`);
        io.stdout(`  ${task.decision}`);
      }
      return 0;
    }
    const result = await runTally({
      configPath: options.config,
      dryRun: options.dryRun,
      baseline: options.baseline,
      budgetUsd: options.budgetUsd,
      only: options.only,
    });
    io.stdout(`wrote ${result.runStatePath}`);
    io.stdout(`wrote ${result.ledgerPath}`);
    io.stdout(`updated ${result.latestRunDir}`);
    io.stdout(`finished ${result.runState.runId}: ${result.runState.tasks.length} tasks, ${result.ledger.length} attempts`);
    if (options.dashboard) await dashboardCommand(options, io);
    return 0;
  } catch (e) {
    return reportError('tally run', e, io);
  }
}

async function demoCommand(_options: CliOptions, io: CliIO): Promise<number> {
  try {
    const result = await runDemo();
    io.stdout(`wrote ${result.runStatePath}`);
    io.stdout(`wrote ${result.ledgerPath}`);
    io.stdout(`updated ${result.latestRunDir}`);
    io.stdout(`finished ${result.runState.runId}: ${result.runState.tasks.length} tasks, ${result.ledger.length} attempts`);
    if (_options.dashboard) await dashboardCommand(_options, io);
    return 0;
  } catch (e) {
    return reportError('tally demo', e, io);
  }
}

async function loginCommand(options: CliOptions, io: CliIO): Promise<number> {
  if (options.loginTarget !== 'cfoai') return reportError('tally login', new RunError(['login expects an integration: cfoai']), io);
  try {
    const result = await loginCfoai();
    io.stdout(`cfo.ai connected; tokens cached at ${result.tokenPath}`);
    return 0;
  } catch (e) {
    io.stderr(`tally login cfoai: ${(e as Error).message}`);
    return 2;
  }
}

async function dashboardCommand(options: CliOptions, io: CliIO): Promise<number> {
  const dashboard = await startDashboardServer({ port: options.port });
  io.stdout(`dashboard ${dashboard.url}`);
  io.stdout(`data ${dashboard.dataUrl}`);
  await new Promise<void>(() => {});
  return 0;
}

async function doctorCommand(_options: CliOptions, io: CliIO): Promise<number> {
  const lines = await runDoctor();
  for (const line of lines) {
    io.stdout(`${line.product}: ${line.status} - ${line.detail}${line.fix ? `; fix: ${line.fix}` : ''}`);
  }
  return lines.some((line) => line.status !== 'connected') ? 1 : 0;
}

function reportError(prefix: string, error: unknown, io: CliIO): number {
  if (error instanceof ConfigError || error instanceof BacklogError || error instanceof RunError) {
    io.stderr(`${prefix}: ${error.message}`);
    return 2;
  }
  throw error;
}

const handlers: Record<Command, Handler> = {
  run: runCommand,
  demo: demoCommand,
  dashboard: dashboardCommand,
  init: stub('init'),
  doctor: doctorCommand,
  login: loginCommand,
};

const consoleIO: CliIO = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

/** Returns the process exit code. */
export async function main(argv: string[], io: CliIO = consoleIO): Promise<number> {
  const parsed = parseCli(argv);
  switch (parsed.kind) {
    case 'help':
      io.stdout(USAGE);
      return 0;
    case 'version':
      io.stdout(VERSION);
      return 0;
    case 'error':
      io.stderr(`tally: ${parsed.message}`);
      io.stderr('Run `tally --help` for usage.');
      return 2;
    case 'command':
      return handlers[parsed.command](parsed.options, io);
  }
}

const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
