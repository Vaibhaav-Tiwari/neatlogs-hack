import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BacklogError } from '../engine/backlog.js';
import { ConfigError, loadConfig } from '../engine/config.js';
import { runDoctor } from '../engine/doctor.js';
import { InitError, runInit } from '../engine/init.js';
import { CommandError } from '../adapters/command.js';
import { runUninstall } from '../engine/uninstall.js';
import { runExperiment } from '../engine/experiment.js';
import { planTally, readPlanBudget } from '../engine/plan.js';
import { RunError, runDemo, runTally } from '../engine/run.js';
import { recoverRunTraces } from '../engine/trace-recovery.js';
import { loginCfoai } from '../adapters/cfoai.js';
import { CrustDataError, runCrustDataMarketSearch } from '../adapters/crustdata.js';
import { formatUsd } from '../schema/index.js';
import { startDashboardServer } from './dashboard-server.js';
import { publishSite } from './publish.js';

export const COMMANDS = ['run', 'demo', 'dashboard', 'init', 'uninstall', 'doctor', 'login', 'market', 'publish', 'experiment', 'traces'] as const;
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
  repeats?: number;
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
  runId?: string;
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
  experiment Run baseline and Tally repeats with a shared safety budget
  run      Run the backlog against the budget in tally.yaml
  demo     Run the full loop with simulated workers on a sample backlog
  dashboard Start the local dashboard server
  init     Set up tally.yaml for the current repository
  uninstall List and remove the recorded Tally installation
  doctor   Check that each integration is connected
  login    Connect an integration, e.g. tally login cfoai
  market   Search CrustData for companies adopting coding agents
  publish  Write a static dashboard bundle (does not deploy)
  traces drain --run <id> Drain and read-back verify a finished run's worker traces

Options:
  --repeats <N>     Repeats per experiment mode (default: 2)
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
  --run <id>        Run id for traces drain; --output overrides its run directory
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
        repeats: { type: 'string' },
        out: { type: 'string' },
        runs: { type: 'string' },
        run: { type: 'string' },
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
  } else if (name === 'traces') {
    if (extra.length !== 1 || extra[0] !== 'drain' || !values.run) return { kind: 'error', message: 'traces expects drain --run <id>' };
    if (!/^[a-zA-Z0-9_-]+$/.test(values.run)) return { kind: 'error', message: 'Invalid run id' };
    if (values['dry-run'] || values.plan) return { kind: 'error', message: 'traces drain verifies real delivery; --dry-run and --plan are not supported' };
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
  let repeats: number | undefined;
  if (values.repeats !== undefined) {
    repeats = Number(values.repeats);
    if (!Number.isInteger(repeats) || repeats < 1) return { kind: 'error', message: '--repeats must be a positive integer' };
  }
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
      ...(repeats === undefined ? {} : { repeats }),
      loginTarget: name === 'login' ? 'cfoai' : undefined,
      output: values.output,
      limit,
      keyword: values.keyword,
      ...(values.out !== undefined ? { out: values.out } : {}),
      ...(values.runs !== undefined ? { runs: values.runs.split(',') } : {}),
      ...(values.run !== undefined ? { runId: values.run } : {}),
    },
  };
}

type Handler = (options: CliOptions, io: CliIO) => Promise<number>;

async function runCommand(options: CliOptions, io: CliIO): Promise<number> {
  try {
    if (options.plan) {
      const config = loadConfig(options.config);
      const budget = await readPlanBudget(config, { budgetUsd: options.budgetUsd });
      io.stdout(`budget: ${formatUsd(budget.limitNanos)} from ${budget.source === 'cfoai' ? 'cfo.ai' : 'tally.yaml'}`);
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
          : `${task.tier} ${task.harness}/${task.model} ceiling ${task.ceilingNanos === null ? 'none' : formatUsd(task.ceilingNanos)}`;
        io.stdout(`${task.taskId}: ${task.size} -> ${route}`);
        io.stdout(`  ${task.decision}`);
      }
      if (plan.length === 0) {
        if (config.backlog.source === 'github-issues') {
          const label = config.backlog.issueLabel ?? 'tally';
          io.stdout(`No matching open issues with label ${JSON.stringify(label)} in ${config.repo.slug ?? config.repo.path}; nothing would start.`);
        } else {
          io.stdout('No tasks matched the configured backlog; nothing would start.');
        }
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
    if (result.runState.tasks.length === 0 && result.runState.backlog?.source === 'github-issues') {
      const label = result.runState.backlog.issueLabel ?? 'tally';
      const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
      io.stdout(`No matching open issues with label ${JSON.stringify(label)} in ${result.runState.repo}; nothing started. Label an issue with: gh issue edit <issue-number> --repo ${quote(result.runState.repo)} --add-label ${quote(label)}`);
    }
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
    io.stderr(`tally init: ${e instanceof Error ? e.message : 'initialization failed; no changes confirmed'}`);
    return 2;
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
  if (error instanceof CommandError || error instanceof InitError || error instanceof ConfigError || error instanceof BacklogError || error instanceof RunError || error instanceof CrustDataError) {
    io.stderr(`${prefix}: ${error.message}`);
    return 2;
  }
  throw error;
}

const handlers: Record<Command, Handler> = {
  traces: async (options, io) => {
    try {
      const result = await recoverRunTraces({ runId: options.runId!, outputDir: options.output });
      io.stdout(`neatlogs: ${result.before.status} -> ${result.after.status}`);
      io.stdout(result.after.detail ?? '');
      return 0;
    } catch (error) {
      io.stderr(`tally traces drain: ${error instanceof Error ? error.message : 'Trace recovery failed'}`);
      return 2;
    }
  },
  experiment: async (options, io) => {
    try {
      if (options.plan || options.baseline || options.live) throw new RunError(['experiment runs both modes; --plan/--baseline/--live are not supported here. Use tally run --plan to preview a mode.']);
      const result = await runExperiment({ configPath: options.config, dryRun: options.dryRun, repeats: options.repeats, budgetUsd: options.budgetUsd, only: options.only });
      io.stdout(`wrote ${result.summaryPath}`);
      io.stdout(`experiment ${result.summary.status}: ${result.summary.reason ?? result.summary.experimentId}`);
      if (options.dashboard) await dashboardCommand(options, io);
      return result.summary.status === 'finished' ? 0 : 1;
    } catch (error) { return reportError('tally experiment', error, io); }
  },
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
