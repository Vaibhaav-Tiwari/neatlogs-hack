import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as initModule from '../engine/init.js';
import * as runModule from '../engine/run.js';
import * as doctorModule from '../engine/doctor.js';
import * as planModule from '../engine/plan.js';
import * as dashboardModule from './dashboard-server.js';
import * as lifecycle from './dashboard-lifecycle.js';
import type { RunState } from '../schema/types.js';
import { CommandError } from '../adapters/command.js';
import { COMMANDS, main, parseCli } from './main.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, out, err };
}

it('prints a plain error when a paid parallel run cannot read its monthly budget', async () => {
  const { io, err } = capture();
  const mocked = vi.spyOn(runModule, 'runTally').mockRejectedValueOnce(new runModule.RunError([
    'parallel AO run cannot reserve the monthly budget: cfo.ai read failed: access denied; no workers were started. Restore cfo.ai access or run sequentially with --parallel 1.',
  ]));
  try {
    expect(await main(['run', '--parallel', '3'], io)).toBe(2);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('no workers were started');
    expect(err[0]).not.toContain('\n    at ');
  } finally { mocked.mockRestore(); }
});

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'tally-cli-cwd-'));
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

describe('parseCli', () => {
  it('parses scripted init flags and rejects invalid product opt-ins', () => {
    expect(parseCli(['init', '--runner', 'direct', '--harness', 'mixed', '--model-access-fallback-tier', 'middle', '--allow-claude'])).toMatchObject({ kind: 'command', options: { runner: 'direct', harnessChoice: 'mixed', modelAccessFallbackTier: 'middle', allowClaude: true } });
    expect(parseCli(['init', '--runner', 'other'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['init', '--harness', 'other'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['init', '--yes', '--test-command', 'node --check app.js', '--setup-command', '', '--budget', '5', '--issue-label', 'tally', '--neatlogs', 'yes', '--entire', 'no', '--cfoai', 'yes', '--verbose'])).toMatchObject({ kind: 'command', options: {
      testCommand: 'node --check app.js', setupCommand: '', budgetUsd: 5, issueLabel: 'tally', verbose: true,
      integrations: { neatlogs: true, entire: false, cfoai: true },
    } });
    expect(parseCli(['init', '--neatlogs', 'maybe'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['init', '--test-command', ''])).toMatchObject({ kind: 'error' });
    expect(parseCli(['init', '--model-access-fallback-tier', ''])).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--model-access-fallback-tier', 'middle'])).toMatchObject({ kind: 'error' });
  });
  it('explains an empty GitHub intake with the repo, label and labeling command without a stack', async () => {
    const state = JSON.parse(readFileSync(new URL('../schema/fixtures/finished-run/run.json', import.meta.url), 'utf8')) as RunState;
    state.tasks = [];
    state.repo = 'acme/static-site';
    state.backlog = { source: 'github-issues', issueLabel: 'ready-for-tally' };
    const spy = vi.spyOn(runModule, 'runTally').mockResolvedValueOnce({ runState: state, ledger: [], outputDir: '/tmp/example', runStatePath: '/tmp/example/run.json', ledgerPath: '/tmp/example/ledger.json', latestRunDir: '/tmp/example/latest' });
    try {
      const { io, out, err } = capture();
      expect(await main(['run'], io)).toBe(0);
      expect(out.join('\n')).toContain('No runnable open issues with label "ready-for-tally" in acme/static-site');
      expect(out.join('\n')).toContain('Issues already linked to open PRs are excluded.');
      expect(out.join('\n')).toContain("gh issue edit <issue-number> --repo 'acme/static-site' --add-label 'ready-for-tally'");
      expect(err).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  it('prints missing AO requirements without an unhandled stack trace', async () => {
    const message = 'Agent Orchestrator (AO) is required; looked in PATH and app bundles; set TALLY_AO_BIN to its executable path.';
    const spy = vi.spyOn(initModule, 'runInit').mockRejectedValueOnce(new CommandError(message, 'ENOENT'));
    try {
      const { io, err } = capture();
      expect(await main(['init', '--yes'], io)).toBe(2);
      expect(err).toEqual([`tally init: ${message}`]);
    } finally { spy.mockRestore(); }
  });
  it('prints an actionable init error for a static repo under --yes without writing configuration', async () => {
    await withTempCwd(async () => {
      writeFileSync('index.html', '<h1>Static site</h1>');
      const { io, out, err } = capture();
      expect(await main(['init', '--yes'], io)).toBe(2);
      expect(out.join('\n')).toContain('No test command found');
      expect(err.join('\n')).toContain('Tally cannot verify work without a test command');
      expect(existsSync('tally.yaml')).toBe(false);
      expect(existsSync('.tally')).toBe(false);
    });
  });
  it('parses each command', () => {
    for (const command of COMMANDS.filter((command) => command !== 'login' && command !== 'traces')) {
      expect(parseCli([command])).toMatchObject({ kind: 'command', command });
    }
  });

  it('parses run options', () => {
    expect(parseCli(['run', '--dry-run', '--budget', '40', '--only', 'T3', '--baseline', '--config', 'x/tally.yaml', '--dashboard', '--port', '0'])).toEqual({
      kind: 'command',
      command: 'run',
      options: {
        config: 'x/tally.yaml',
        dryRun: true,
        baseline: true,
        budgetUsd: 40,
        only: 'T3',
        dashboard: true,
        port: 0,
        plan: false,
        live: false,
        loginTarget: undefined,
        output: undefined,
        limit: undefined,
        keyword: undefined,
      },
    });
  });

  it('requires a run-scoped trace drain and rejects unsafe run ids', () => {
    expect(parseCli(['traces', 'drain', '--run', 'run-1', '--output', '/runs/run-1'])).toMatchObject({ kind: 'command', command: 'traces', options: { runId: 'run-1', output: '/runs/run-1' } });
    expect(parseCli(['traces'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['traces', 'drain'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['traces', 'drain', '--run', '../latest'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['traces', 'drain', '--run', 'run-1', '--dry-run'])).toMatchObject({ kind: 'error' });
  });

  it('defaults the config path and leaves budget unset', () => {
    expect(parseCli(['run'])).toEqual({
      kind: 'command',
      command: 'run',
      options: {
        config: 'tally.yaml',
        dryRun: false,
        baseline: false,
        budgetUsd: undefined,
        only: undefined,
        dashboard: false,
        port: undefined,
        plan: false,
        live: false,
        loginTarget: undefined,
        output: undefined,
        limit: undefined,
        keyword: undefined,
      },
    });
  });

  it('parses the cfo.ai login command', () => {
    expect(parseCli(['login', 'cfoai'])).toEqual({
      kind: 'command',
      command: 'login',
      options: {
        config: 'tally.yaml',
        dryRun: false,
        baseline: false,
        budgetUsd: undefined,
        only: undefined,
        dashboard: false,
        port: undefined,
        plan: false,
        live: false,
        loginTarget: 'cfoai',
        output: undefined,
        limit: undefined,
        keyword: undefined,
      },
    });
    expect(parseCli(['login'])).toMatchObject({ kind: 'error' });
  });

  it('parses --plan', () => {
    expect(parseCli(['run', '--plan'])).toMatchObject({ kind: 'command', command: 'run', options: { plan: true } });
  });

  it('parses experiment repeat counts and rejects invalid counts', () => {
    expect(parseCli(['experiment', '--repeats', '2', '--budget', '10', '--dry-run'])).toMatchObject({ kind: 'command', command: 'experiment', options: { repeats: 2, budgetUsd: 10, dryRun: true } });
    expect(parseCli(['experiment', '--repeats', '0'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['experiment', '--repeats', '1.5'])).toMatchObject({ kind: 'error' });
  });

  it('parses demo --live', () => {
    expect(parseCli(['demo', '--live'])).toMatchObject({ kind: 'command', command: 'demo', options: { live: true } });
  });

  it('parses init final approval and preview flags', () => {
    expect(parseCli(['init', '--yes'])).toMatchObject({ kind: 'command', command: 'init', options: { yes: true } });
    expect(parseCli(['init', '--dry-run'])).toMatchObject({ kind: 'command', command: 'init', options: { dryRun: true } });
  });

  it('parses market options', () => {
    expect(parseCli(['market', '--output', 'out/market', '--limit', '3', '--keyword', 'GitHub Copilot'])).toMatchObject({
      kind: 'command',
      command: 'market',
      options: { output: 'out/market', limit: 3, keyword: 'GitHub Copilot' },
    });
    expect(parseCli(['market', '--replay', 'saved/query.json', '--review', 'labels.json', '--max-credits', '2.5'])).toMatchObject({
      kind: 'command', command: 'market', options: { replay: 'saved/query.json', review: 'labels.json', maxCredits: 2.5 },
    });
    for (const cap of ['0', '-1', 'NaN', 'Infinity']) expect(parseCli(['market', '--max-credits', cap])).toMatchObject({ kind: 'error' });
    expect(parseCli(['market', '--jobs', '--secondary', 'saved/query.json'])).toMatchObject({ kind: 'command', options: { jobs: true, secondary: 'saved/query.json' } });
  });

  it('rejects a budget that is not a positive number', () => {
    expect(parseCli(['run', '--budget', 'lots'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--budget', '-5'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['dashboard', '--port', 'lots'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['market', '--limit', '0'])).toMatchObject({ kind: 'error' });
  });

  it('accepts an opt-in parallel count and rejects invalid counts', () => {
    expect(parseCli(['run', '--parallel', '3'])).toMatchObject({ kind: 'command', options: { parallel: 3 } });
    for (const value of ['0', '-1', '1.5', 'Infinity', 'NaN']) expect(parseCli(['run', '--parallel', value])).toMatchObject({ kind: 'error' });
    expect(parseCli(['run'])).toMatchObject({ kind: 'command' });
  });

  it('rejects unknown commands and unknown flags', () => {
    expect(parseCli(['deploy'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--nope'])).toMatchObject({ kind: 'error' });
  });

  it('treats no arguments, --help and -h as help', () => {
    expect(parseCli([])).toEqual({ kind: 'help' });
    expect(parseCli(['--help'])).toEqual({ kind: 'help' });
    expect(parseCli(['run', '-h'])).toEqual({ kind: 'help' });
  });

  it('reports the version', () => {
    expect(parseCli(['--version'])).toEqual({ kind: 'version' });
  });
});

describe('main', () => {
  it('prints plan reasons as wrapped bullets and shows live budget availability', async () => {
    const budget = vi.spyOn(planModule, 'readPlanBudget').mockResolvedValue({
      source: 'cfoai', limitNanos: 5_000_000_000, monthlyLimitNanos: 1_000_000_000,
      monthlySpentNanos: 343_700_000, monthlyRemainingNanos: 656_300_000, limitSource: 'cli',
    });
    const plan = vi.spyOn(planModule, 'planTally').mockResolvedValue([{
      taskId: '#6', title: 'Add a ledger filter', size: 'small', confidence: 0.65,
      tier: 'cheap', model: 'gpt-5.6-luna', harness: 'codex', ceilingNanos: 300_000_000,
      decision: 'History has one cheap attempt so it uses the prior; related files were found by a local repository search; observed cost is below the configured ceiling (0 successful samples; 5 needed).',
      historySources: ['neatlogs'], skipped: false,
    }]);
    try {
      const { io, out } = capture();
      expect(await main(['run', '--plan', '--budget', '5', '--config', new URL('../demo/tally.live.yaml', import.meta.url).pathname], io)).toBe(0);
      expect(out.join('\n')).toContain('Monthly remaining: $0.6563 of $1.00 (cfo.ai)');
      expect(out.join('\n')).toContain('History source: remote Neatlogs');
      expect(out.join('\n')).toContain('  Decision:\n    - History has one cheap attempt so it uses the prior');
      expect(out.join('\n')).toContain('    - related files were found by a local repository search');
      expect(out.join('\n')).toContain('observed cost is below the configured ceiling (0 successful samples, 5 needed).');
      expect(out.join('\n')).not.toContain(';');
    } finally { budget.mockRestore(); plan.mockRestore(); }
  });

  it.each(['run', 'demo'])('starts and opens the dashboard before %s, reports progress, and waits after the summary', async command => {
    await withTempCwd(async () => {
      const c = capture();
      const dashboard = { url: 'http://127.0.0.1:1234/', dataUrl: '/runs/latest/', server: {} as never, close: vi.fn(async () => {}) };
      const start = vi.spyOn(dashboardModule, 'startDashboardServer').mockResolvedValue(dashboard);
      const open = vi.spyOn(lifecycle, 'openDashboardBrowser').mockResolvedValue();
      const wait = vi.spyOn(lifecycle, 'waitForDashboard').mockImplementation(async () => {
        expect(c.out.join('\n')).toContain('Run summary');
        expect(c.out.join('\n')).toContain('run folder');
        expect(c.out.join('\n')).toContain('serving until Ctrl+C');
      });
      const realDemo = runModule.runDemo;
      const target = command === 'demo' ? 'runDemo' : 'runTally';
      const run = vi.spyOn(runModule, target).mockImplementation(async (options: { onEvent?: runModule.RunOptions['onEvent'] }) => {
        expect(start).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledWith(dashboard.url);
        expect(c.out[0]).toBe(`dashboard ${dashboard.url}`);
        const result = await realDemo({ onEvent: options.onEvent });
        result.runState.tasks[0]!.prUrl = 'https://github.com/example/repo/pull/1';
        return result;
      });
      try {
        expect(await main([command, '--open', '--port', '0'], c.io)).toBe(0);
        expect(wait).toHaveBeenCalledWith(dashboard);
        expect(c.out.join('\n')).toContain('worker');
        expect(c.out.join('\n')).toContain('spend');
        expect(c.out.join('\n')).toContain('Budget availability');
        expect(c.out.join('\n')).toContain('Monthly remaining:');
        expect(c.out.join('\n')).toContain('Run cap:');
        expect(c.out.join('\n')).toContain('Available now:');
        expect(c.out.join('\n')).toContain('PR https://github.com/example/repo/pull/1');
      } finally { run.mockRestore(); start.mockRestore(); open.mockRestore(); wait.mockRestore(); }
    });
  });
  it('does not fail doctor for an explicitly disabled product', async () => {
    const spy = vi.spyOn(doctorModule, 'runDoctor').mockResolvedValueOnce([{ product: 'Neatlogs key', status: 'off', detail: 'Disabled in tally.yaml. This integration is not required.', fix: null }]);
    try {
      const c = capture();
      expect(await main(['doctor'], c.io)).toBe(0);
      expect(c.out).toEqual(['Neatlogs key: off', '  Disabled in tally.yaml. This integration is not required.']);
    } finally { spy.mockRestore(); }
  });
  it('never starts an experiment for an unsupported --plan request', async () => {
    const c = capture();
    expect(await main(['experiment', '--plan'], c.io)).toBe(2);
    expect(c.err.join('\n')).toContain('Use tally run --plan');
  });
  it('prints usage listing every command and exits 0 for help', async () => {
    const c = capture();
    expect(await main(['--help'], c.io)).toBe(0);
    for (const command of COMMANDS) expect(c.out.join('\n')).toContain(command);
  });

  it('exits 2 with a message on a bad command', async () => {
    const c = capture();
    expect(await main(['deploy'], c.io)).toBe(2);
    expect(c.err.join('\n')).toContain('deploy');
  });

  it('reports config errors before a real run can start', async () => {
    const c = capture();
    expect(await main(['run', '--config', '/nonexistent/tally.yaml'], c.io)).toBe(2);
    expect(c.err.join('\n')).toContain('file not found');
  });

  it('runs demo and reports the generated files', async () => {
    await withTempCwd(async () => {
      const c = capture();
      expect(await main(['demo'], c.io)).toBe(0);
      expect(c.out.join('\n')).toContain('ledger.json');
      expect(c.out.join('\n')).toContain('attempts');
      expect(c.out.join('\n')).toContain('Integrations\n  Integration  Status');
    });
  });

  it('runs a dry-run from a file backlog', async () => {
    await withTempCwd(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tally-cli-'));
      const configPath = join(dir, 'tally.yaml');
      writeFileSync(
        configPath,
        `version: 1
repo: { path: ".", baseBranch: "main" }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: claude-code
    provider: litellm
    model: nova-micro
    price: { inputUsdPerMTok: 0.035, cachedInputUsdPerMTok: 0.00875, outputUsdPerMTok: 0.14 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 2, large: 3 }
budget: { source: config, usd: 10 }
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
`,
      );
      writeFileSync(join(dir, 'backlog.yaml'), 'tasks:\n  - id: T1\n    title: Tiny fix\n    size: small\n');
      const c = capture();

      expect(await main(['run', '--dry-run', '--config', configPath], c.io)).toBe(0);
      expect(c.out.join('\n')).toContain('1 tasks, 1 attempts');
    });
  });
  it('explains that an empty plan will start no tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-cli-empty-plan-'));
    const configPath = join(dir, 'tally.yaml');
    writeFileSync(configPath, `version: 1
repo: { path: ".", baseBranch: "main" }
test: { command: "npm test" }
backlog: { source: "file", file: "backlog.yaml" }
tiers:
  - name: cheap
    harness: codex
    provider: test
    model: test-model
    price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0, outputUsdPerMTok: 1 }
    ceilingFraction: 1
ceilings:
  bySizeUsd: { small: 1, medium: 2, large: 3 }
budget: { source: config, usd: 10 }
integrations: { neatlogs: false, entire: false, cfoai: false, slack: false }
`);
    writeFileSync(join(dir, 'backlog.yaml'), 'tasks: []\n');
    const { io, out, err } = capture();
    expect(await main(['run', '--plan', '--dry-run', '--config', configPath], io)).toBe(0);
    expect(out.join('\n')).toContain('No tasks found in the configured file backlog "backlog.yaml"; nothing would start.');
    expect(err).toEqual([]);
  });
});
