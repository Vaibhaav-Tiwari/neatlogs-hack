import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BacklogError } from '../engine/backlog.js';
import { ConfigError, loadConfig } from '../engine/config.js';
import { runDoctor } from '../engine/doctor.js';
import { runInit } from '../engine/init.js';
import { runUninstall } from '../engine/uninstall.js';
import { planTally, readPlanBudget } from '../engine/plan.js';
import { RunError, runDemo, runTally } from '../engine/run.js';
import { loginCfoai } from '../adapters/cfoai.js';
import { CrustDataError, runCrustDataMarketSearch } from '../adapters/crustdata.js';
import { nanosToUsd } from '../schema/index.js';
import { startDashboardServer } from './dashboard-server.js';
import { publishSite } from './publish.js';

export const COMMANDS = ['run', 'demo', 'dashboard', 'init', 'uninstall', 'doctor', 'login', 'market', 'publish'] as const;
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
  /** Use live read-only integrations for `tally demo`. */
  live: boolean;
  yes?: boolean;
  /** Integration to authenticate for `tally login`. */
  loginTarget: 'cfoai' | undefined;
  /** Directory for `tally market` output. */
  output: string | undefined;
  /** CrustData result limit for `tally market`. */
  limit: number | undefined;
  /** Keyword for `tally market`. */
  keyword: string | undefined;
  out?: string;
  runs?: string[];
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
  uninstall List and remove the recorded Tally installation
  doctor   Check that each integration is connected
  login    Connect an integration, e.g. tally login cfoai
  market   Search CrustData for companies adopting coding agents
  publish  Write a static dashboard bundle (does not deploy)

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
  --live            For demo: use live read-only integrations with fake workers
  --yes             For init: approve the final change summary without prompting
  --output <dir>    Output directory for tally market (default: .tally/market/latest)
  --limit <number>  Result limit for tally market (default: 10)
  --keyword <text>  CrustData keyword for tally market (default: AI coding)
  --out <dir>       New directory for tally publish (required)
  --runs <ids>      Comma-separated run folder ids (default: all real runs)
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
        live: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        output: { type: 'string' },
        limit: { type: 'string' },
        keyword: { type: 'string' },
        out: { type: 'string' },
        runs: { type: 'string' },
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
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      return { kind: 'error', message: `--limit must be an integer from 1 to 100, got "${values.limit}"` };
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
      live: values.live,
      ...(values.yes ? { yes: true } : {}),
      loginTarget: name === 'login' ? 'cfoai' : undefined,
      output: values.output,
      limit,
      keyword: values.keyword,
      ...(values.out !== undefined ? { out: values.out } : {}),
      ...(values.runs !== undefined ? { runs: values.runs.split(',') } : {}),
    },
  };
}

type Handler = (options: CliOptions, io: CliIO) => Promise<number>;

async function runCommand(options: CliOptions, io: CliIO): Promise<number> {
  try {
    if (options.plan) {
      const budget = await readPlanBudget(loadConfig(options.config), { budgetUsd: options.budgetUsd });
      io.stdout(`budget: $${nanosToUsd(budget.limitNanos).toFixed(2)} from ${budget.source === 'cfoai' ? 'cfo.ai' : 'tally.yaml'}`);
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
    printIntegrations(result, io);
    if (options.dashboard) await dashboardCommand(options, io);
    return 0;
  } catch (e) {
    return reportError('tally run', e, io);
  }
}

async function initCommand(options: CliOptions, io: CliIO): Promise<number> {
  try {
    const result = await runInit({ configPath: options.config, yes: options.yes, dryRun: options.dryRun, print: io.stdout });
    if (!result.applied) {
      io.stdout(options.dryRun ? 'Dry run: no changes made.' : 'Init cancelled: no changes made.');
      return 0;
    }
    io.stdout(`wrote ${result.configPath}`);
    io.stdout(`repo project ${result.projectId}`);
    io.stdout(`test ${result.testCommand}`);
    if (result.setupCommand) io.stdout(`setup ${result.setupCommand}`);
    io.stdout(`tiers ${result.tiers.join(', ')}`);
    for (const line of result.doctor) {
      io.stdout(`${line.product}: ${line.status} - ${line.detail}${line.fix ? `; fix: ${line.fix}` : ''}`);
    }
    return result.doctor.some((line) => line.status !== 'connected') ? 1 : 0;
  } catch (e) {
    return reportError('tally init', e, io);
  }
}

async function uninstallCommand(options: CliOptions, io: CliIO): Promise<number> {
  try {
    const result = await runUninstall({ configPath: options.config, print: io.stdout });
    io.stdout(result.removed ? 'Tally installation removed; run data and credentials retained.' : 'Uninstall cancelled.');
    return 0;
  } catch (error) {
    return reportError('tally uninstall', error, io);
  }
}

async function demoCommand(_options: CliOptions, io: CliIO): Promise<number> {
  try {
    const result = await runDemo({ live: _options.live });
    io.stdout(`wrote ${result.runStatePath}`);
    io.stdout(`wrote ${result.ledgerPath}`);
    io.stdout(`updated ${result.latestRunDir}`);
    io.stdout(`finished ${result.runState.runId}: ${result.runState.tasks.length} tasks, ${result.ledger.length} attempts`);
    printIntegrations(result, io);
    if (_options.dashboard) await dashboardCommand(_options, io);
    return 0;
  } catch (e) {
    return reportError('tally demo', e, io);
  }
}

function printIntegrations(result: Awaited<ReturnType<typeof runTally>>, io: CliIO): void {
  const summary = Object.entries(result.runState.integrations)
    .map(([name, state]) => `${name}=${state.status}${state.detail ? ` (${state.detail})` : ''}`)
    .join('; ');
  io.stdout(`integrations: ${summary}`);
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

async function doctorCommand(options: CliOptions, io: CliIO): Promise<number> {
  const lines = await runDoctor({ configPath: options.config });
  for (const line of lines) {
    io.stdout(`${line.product}: ${line.status} - ${line.detail}${line.fix ? `; fix: ${line.fix}` : ''}`);
  }
  return lines.some((line) => line.status !== 'connected') ? 1 : 0;
}

async function marketCommand(options: CliOptions, io: CliIO): Promise<number> {
  try {
    const result = await runCrustDataMarketSearch({
      outputDir: options.output,
      limit: options.limit,
      keyword: options.keyword,
    });
    io.stdout(`wrote ${result.queryPath}`);
    io.stdout(`wrote ${result.companiesPath}`);
    io.stdout(`market: ${result.companies.length} companies from ${result.totalCount ?? 'unknown'} matches`);
    io.stdout(`credits: ${result.creditCost ?? 'not reported'}`);
    return 0;
  } catch (e) {
    return reportError('tally market', e, io);
  }
}

function reportError(prefix: string, error: unknown, io: CliIO): number {
  if (error instanceof ConfigError || error instanceof BacklogError || error instanceof RunError || error instanceof CrustDataError) {
    io.stderr(`${prefix}: ${error.message}`);
    return 2;
  }
  throw error;
}

const handlers: Record<Command, Handler> = {
  publish: async (options, io) => {
    try {
      if (!options.out) throw new Error('publish requires --out <dir>');
      const result = publishSite({ out: options.out, runs: options.runs });
      for (const file of result.files) io.stdout(`${file.path}: ${file.bytes} bytes`);
      io.stdout(`bundle: ${result.files.length} files, ${result.totalBytes} bytes`);
      return 0;
    } catch (error) {
      io.stderr(`tally publish: ${(error as Error).message}`);
      return 2;
    }
  },
  run: runCommand,
  demo: demoCommand,
  dashboard: dashboardCommand,
  init: initCommand,
  uninstall: uninstallCommand,
  doctor: doctorCommand,
  login: loginCommand,
  market: marketCommand,
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
