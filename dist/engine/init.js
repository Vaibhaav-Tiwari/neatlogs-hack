import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { contentHash, configHash, installRecordPath } from './install-record.js';
import { applyInitTransaction, finishInitTransaction, pendingInitPath, readPendingInit } from './init-transaction.js';
import { validateConfig } from '../schema/index.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runDoctor } from './doctor.js';
import { tierPriceNote } from './pricing.js';
import { CommandError, resolveAoBinary, runCommand } from '../adapters/command.js';
import { checkCfoaiConnection } from '../adapters/cfoai.js';
import { loadEnv } from './env.js';
import { aoWorkerMode, withWorkerPermissionMode } from './preflight.js';
import { aoClaudeSetupCommand } from './ao-claude-settings.js';
import { aoProjectCommand } from '../adapters/ao-project.js';
import { configureIntegrations } from '../onboarding/index.js';
import { loadConfig } from './config.js';
import { readPlanBudget } from './plan.js';
import { formatUsd } from '../schema/money.js';
import { applyReinit, finishReinit, prepareReinit, readReinit, reinitPath } from './reinit.js';
import { AO_HARNESS_PERMISSIONS, checkHarness, claudeAllowList, claudeScripts } from './harness.js';
import { readAoDaemonStatus } from './ao-status.js';
import { createTerminalStyle, formatInitPrompt } from '../ui/terminal.js';
export class InitError extends Error {
}
const CODEx_TIERS = [
    ['cheap', 'gpt-5.6-luna', 0.2, 0.02, 1.2, 0.2],
    ['middle', 'gpt-5.6-terra', 2, 0.2, 12, 0.5],
    ['top', 'gpt-5.6-sol', 4, 0.4, 20, 1],
];
const CLAUDE_TIERS = [
    ['cheap', 'claude-haiku-4-5-20251001', 1, 0.1, 5, 0.2],
    ['middle', 'claude-sonnet-5-5', 2, 0.1, 10, 0.5],
    ['top', 'claude-opus-5-5', 4, 0.2, 20, 1],
];
export async function defaultCommand(file, args, options) {
    if (file === 'ao')
        resolveAoBinary(options);
    // The CLI config mirror drops fields such as effort; use the full daemon object.
    if (file === 'ao' && args[0] === 'project' && (args[1] === 'get' || args[1] === 'set-config')) {
        return aoProjectCommand(args);
    }
    return runCommand(file, args, options);
}
async function projectOrNull(command, projectId, cwd) {
    try {
        return (await command('ao', ['project', 'get', projectId, '--json'], { cwd })).stdout;
    }
    catch (error) {
        if (error instanceof Error && /missing project|not found|HTTP 404/i.test(error.message))
            return null;
        throw error;
    }
}
export async function defaultReadLine(question, defaultValue = '') {
    if (!process.stdin.isTTY)
        throw new InitError('Interactive init needs a terminal; use --yes with explicit init flags for scripted input.');
    const { createInterface } = await import('node:readline/promises');
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    readline.once('close', () => controller.abort());
    try {
        const answer = await readline.question(formatInitPrompt(question, defaultValue, createTerminalStyle()), { signal: controller.signal });
        return answer.trim() || defaultValue;
    }
    catch {
        throw new InitError('Init input closed; rerun in a terminal or use --yes with explicit init flags.');
    }
    finally {
        readline.close();
    }
}
async function commandOrNull(command, file, args, cwd) {
    try {
        return (await command(file, args, { cwd })).stdout.trim();
    }
    catch (error) {
        if (file === 'ao' && error instanceof CommandError)
            throw error;
        return null;
    }
}
function hasMakeTarget(cwd, target) {
    const path = resolve(cwd, 'Makefile');
    if (!existsSync(path))
        return false;
    return new RegExp(`^${target}[ \\t]*:`, 'm').test(readFileSync(path, 'utf8'));
}
function packageJsonScript(cwd, script) {
    const path = resolve(cwd, 'package.json');
    if (!existsSync(path))
        return false;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const value = parsed.scripts?.[script];
        return typeof value === 'string' && value.trim().length > 0;
    }
    catch {
        return false;
    }
}
function detectTestCommand(cwd) {
    if (hasMakeTarget(cwd, 'test'))
        return 'make test';
    if (packageJsonScript(cwd, 'test'))
        return 'npm test';
    for (const [file, section] of [
        ['pyproject.toml', 'tool.pytest.ini_options'], ['pytest.ini', 'pytest'],
        ['tox.ini', 'pytest'], ['setup.cfg', 'tool:pytest'],
    ]) {
        const path = resolve(cwd, file);
        if (!existsSync(path))
            continue;
        const text = readFileSync(path, 'utf8');
        if (text.split('\n').some((line) => line.trim().split('#')[0].trim() === `[${section}]`))
            return 'pytest';
    }
    if (existsSync(resolve(cwd, 'Cargo.toml')))
        return 'cargo test';
    if (existsSync(resolve(cwd, 'go.mod')))
        return 'go test ./...';
    return null;
}
function detectSetupCommand(cwd) {
    if (hasMakeTarget(cwd, 'setup'))
        return 'make setup';
    if (packageJsonScript(cwd, 'setup'))
        return 'npm run setup';
    if (existsSync(resolve(cwd, 'package.json'))) {
        if (existsSync(resolve(cwd, 'package-lock.json')))
            return 'npm ci';
        if (existsSync(resolve(cwd, 'pnpm-lock.yaml')))
            return 'pnpm install --frozen-lockfile';
        if (existsSync(resolve(cwd, 'yarn.lock')))
            return 'yarn install --frozen-lockfile';
    }
    if (existsSync(resolve(cwd, 'pyproject.toml')) && existsSync(resolve(cwd, 'uv.lock')))
        return 'uv sync';
    return null;
}
function slugFromRemote(remote) {
    if (!remote)
        return undefined;
    const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
    return match?.[1];
}
function parseYes(value) {
    return /^y(?:es)?$/i.test(value.trim());
}
function parseBudget(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        throw new InitError('Budget must be a positive number of USD; nothing was changed.');
    return parsed;
}
function printSummary(config, print) {
    print(`  Runner             ${config.runner ?? 'ao'}${config.runner === 'direct' ? ' · one task at a time' : ' · Agent Orchestrator'}`);
    print(`  Repository         ${config.repo.slug ?? config.repo.path} · base ${config.repo.baseBranch}`);
    print(`  Verification       ${config.test.command}`);
    print(`  Setup              ${config.test.setupCommand ?? 'none'}`);
    print(`  Issue label        ${config.backlog.issueLabel ?? 'none'}`);
    print(`  Budget             ${config.budget.source === 'cfoai' ? `cfo.ai live · $${config.budget.usd} fallback` : `$${config.budget.usd} · tally.yaml`}`);
    for (const tier of config.tiers)
        print(`  Tier ${tier.name.padEnd(11)} ${tier.harness}/${tier.model} · ${tier.sessionMode}`);
    print('Integrations:');
    for (const [name, label] of [['neatlogs', 'Neatlogs'], ['entire', 'Entire'], ['cfoai', 'cfo.ai']]) {
        print(`  ${label.padEnd(18)} ${config.integrations[name] ? 'on' : 'off'}`);
    }
    if (config.budget.cfoai?.publishRunContext)
        print('  cfo.ai Ari context   on · per-attempt organization-memory reports');
    print(`  Model fallback     ${config.modelAccessFallbackTier ?? 'disabled'}`);
    print(`  Workers            ${config.runner === 'direct' ? 1 : config.parallelWorkers ?? 1} · ${config.runner ?? 'ao'}`);
}
function tiersFor(choice) {
    // Mixed uses Codex for cheap work, then Sonnet and Opus for stronger attempts.
    return [0, 1, 2].map(index => {
        const harness = choice === 'mixed' ? index === 0 ? 'codex' : 'claude-code' : choice;
        const [name, model, input, cached, output, ceilingFraction] = (harness === 'codex' ? CODEx_TIERS : CLAUDE_TIERS)[index];
        const provider = harness === 'codex' ? 'openai' : 'anthropic';
        return {
            name,
            harness,
            sessionMode: 'tui',
            provider,
            model,
            price: { inputUsdPerMTok: input, cachedInputUsdPerMTok: cached, outputUsdPerMTok: output },
            priceNote: tierPriceNote({ model, provider, price: { inputUsdPerMTok: input, cachedInputUsdPerMTok: cached, outputUsdPerMTok: output } }),
            ceilingFraction,
        };
    });
}
async function chooseSetup(options, command, cwd, readLine, print) {
    let aoFound = false;
    try {
        await command('ao', ['--version'], { cwd });
        aoFound = true;
    }
    catch { /* Optional CLI: direct mode needs no AO. */ }
    let runner = options.runner;
    let aoStatus = { state: 'unknown', detail: 'AO daemon status could not be checked' };
    if (!aoFound) {
        if (runner === 'ao')
            throw new InitError('AO runner was requested, but AO is unavailable. Install AO or select direct.');
        runner = 'direct';
        print('AO was not found. Using direct, one task at a time. Parallel workers need Agent Orchestrator.');
    }
    else {
        try {
            aoStatus = await readAoDaemonStatus(command, cwd);
        }
        catch (error) {
            aoStatus = { state: 'unknown', detail: error instanceof Error ? error.message : 'AO status could not be checked' };
        }
        if (aoStatus.state !== 'running')
            print(`${aoStatus.detail}. AO is unavailable. Direct is the default. ${aoStatus.state === 'stopped' ? 'Run ao start to use AO.' : 'Check ao status --json before choosing AO.'}`);
        if (!runner) {
            if (aoStatus.state === 'running') {
                const value = options.yes || options.dryRun ? 'ao' : (await readLine('Runner: Agent Orchestrator (AO) or direct?', 'ao')).trim().toLowerCase();
                if (!['ao', 'direct'].includes(value))
                    throw new InitError('Runner must be AO or direct; nothing was changed.');
                runner = value;
            }
            else {
                runner = 'direct';
            }
        }
        if (runner === 'ao' && aoStatus.state !== 'running') {
            const guidance = aoStatus.state === 'stopped' ? 'run ao start and retry' : 'check ao status --json, then retry';
            throw new InitError(`${aoStatus.detail}. ${guidance}, or select direct. Nothing was changed.`);
        }
    }
    let concurrency = 1;
    if (runner === 'ao' && !options.yes && !options.dryRun && parseYes(await readLine('Run tasks in parallel through AO? y/N', 'N'))) {
        concurrency = Number(await readLine('Maximum concurrent AO workers?', '3'));
        if (!Number.isInteger(concurrency) || concurrency < 1)
            throw new InitError('Worker count must be a positive integer; nothing was changed.');
    }
    const statuses = [];
    for (const harness of ['claude-code', 'codex']) {
        const status = await checkHarness(harness, command, cwd);
        statuses.push(status);
        print(`${harness}: ${status.detail}`);
        if (!status.signedIn)
            print(`  Next: ${status.fix}`);
    }
    const ready = new Set(statuses.filter(s => s.installed && s.signedIn).map(s => s.harness));
    if (!ready.size)
        throw new InitError('No installed and signed-in Codex or Claude Code agent detected; run claude auth login or codex login, then retry.');
    const fallback = ready.has('codex') ? 'codex' : 'claude-code';
    let choice = options.harnessChoice;
    if (!choice) {
        const choices = [
            ...(ready.has('codex') ? [{ choice: 'codex', label: 'Codex' }] : []),
            ...(ready.has('claude-code') ? [{ choice: 'claude-code', label: 'Claude Code' }] : []),
            ...(ready.has('codex') && ready.has('claude-code') ? [{ choice: 'mixed', label: 'Both (Codex + Claude Code)' }] : []),
        ];
        if (choices.length === 1 || options.yes || options.dryRun)
            choice = choices.find(item => item.choice === fallback)?.choice ?? choices[0].choice;
        else {
            print('Coding agent');
            choices.forEach((item, index) => print(`  ${index + 1}. ${item.label}${item.choice === fallback ? ' (default)' : ''}`));
            const answer = (await readLine('Choose a coding agent (number)', String(choices.findIndex(item => item.choice === fallback) + 1))).trim().toLowerCase();
            const index = Number(answer) - 1;
            const selected = /^\d+$/.test(answer) ? choices[index] : choices.find(item => item.choice === answer || item.label.toLowerCase() === answer);
            if (!selected)
                throw new InitError('Choose one of the listed coding agents; nothing was changed.');
            choice = selected.choice;
        }
    }
    if (!['claude-code', 'codex', 'mixed'].includes(choice))
        throw new InitError('Choose claude-code, codex or mixed; nothing was changed.');
    const required = choice === 'mixed' ? ['claude-code', 'codex'] : [choice];
    if (required.some(h => !ready.has(h)))
        throw new InitError(`Selected ${choice} requires installed and signed-in ${required.join(' and ')}; Tally will not substitute another harness.`);
    if (choice === 'mixed')
        print('Mixed tiers: cheap Codex Luna, middle Claude Sonnet 5.5, top Claude Opus 5.5.');
    return { runner, concurrency, tiers: tiersFor(choice) };
}
async function consentClaude(config, options, readLine, print) {
    if (!config.tiers.some(tier => tier.harness === 'claude-code'))
        return;
    const allow = claudeAllowList(config.test);
    print('Claude Code worker allow-list (relative to its worker folder):');
    for (const rule of allow)
        print(`- ${rule}`);
    print('Script tokens are portable content-bound consent. Tally replaces them with exact paths outside the worker worktree at startup.');
    print('Workers cannot edit these scripts. No broad Bash permission is granted.');
    for (const script of claudeScripts(config.test))
        print(`${script.name} script contents:\n${script.contents}`);
    print('Test and setup commands execute repository code and may install dependencies. Tally installs these consented script rules locally before Claude starts. Never bypass-permissions.');
    if (config.claudeCode && configHash(config.claudeCode.allow) === configHash(allow))
        return;
    if (options.dryRun) {
        print('Preview only: Claude permission consent has not been granted.');
        return;
    }
    const approved = options.allowClaude ?? (!options.yes && parseYes(await readLine('Approve this Claude Code allow-list once for this repository? y/N', 'N')));
    if (!approved)
        throw new InitError('Claude Code allow-list was not approved; no Tally config or AO settings were changed. Choose Codex or rerun and approve the list.');
    config.claudeCode = { allow };
}
function withPostCreate(config, setupCommand) {
    const base = typeof config === 'object' && config !== null && !Array.isArray(config) ? { ...config } : {};
    if (!setupCommand)
        return base;
    const current = Array.isArray(base.postCreate) ? base.postCreate.filter((item) => typeof item === 'string') : [];
    base.postCreate = current.includes(setupCommand) ? current : [...current, setupCommand];
    return base;
}
async function initPrerequisites(config, command, cwd, options) {
    if ((config.runner ?? 'ao') === 'ao') {
        let status;
        try {
            status = await readAoDaemonStatus(command, cwd);
        }
        catch (error) {
            throw new InitError(`AO daemon status could not be checked (${error instanceof Error ? error.message : 'unknown error'}); check ao status --json and retry, or select direct. Nothing was changed.`);
        }
        if (status.state !== 'running') {
            const guidance = status.state === 'stopped' ? 'run ao start and retry' : 'check ao status --json and retry';
            throw new InitError(`${status.detail}; ${guidance}, or select direct. Nothing was changed.`);
        }
    }
    await command('git', ['--version'], { cwd });
    await command('gh', ['auth', 'status'], { cwd });
    for (const harness of new Set(config.tiers.map(tier => tier.harness))) {
        const status = await checkHarness(harness, command, cwd);
        if (!status.installed || !status.signedIn)
            throw new InitError(`${status.detail}; fix: ${status.fix}. No harness substitution or changes were made.`);
    }
    const env = options.env ?? { ...loadEnv(), ...process.env };
    if (config.integrations.neatlogs && !env.NEATLOGS_API_KEY)
        throw new InitError('neatlogs was requested but NEATLOGS_API_KEY is missing; add it to ~/.tally/.env before rerunning init; nothing was changed.');
    if (config.integrations.cfoai) {
        const status = await (options.cfoaiCheck ?? checkCfoaiConnection)();
        if (status.status !== 'ok')
            throw new InitError('cfo.ai was requested but is not connected; run tally login cfoai, then rerun init; nothing was changed.');
    }
    if (config.integrations.entire) {
        await command('entire', ['--version'], { cwd });
        await command('entire', ['graph', '--help'], { cwd });
        const status = JSON.parse((await command('entire', ['status', '--json'], { cwd })).stdout);
        if (status.enabled !== true)
            throw new InitError(`Entire was requested but is not enabled in ${cwd}; run cd ${JSON.stringify(cwd)} && entire enable, review its repository/hook changes and trust the harness hooks, then rerun init; nothing was changed.`);
    }
}
async function finishInit(options, transaction, command, recordPath) {
    await applyInitTransaction(transaction, command, recordPath);
    try {
        const doctor = await (options.doctor ?? ((path) => runDoctor({ configPath: path })))(transaction.configPath);
        finishInitTransaction(transaction.configPath);
        return doctor;
    }
    catch (error) {
        throw new InitError(`Init ${transaction.record.runner === 'direct' ? 'configured direct mode' : 'configured AO'} and wrote ${transaction.configPath} and ${recordPath}, but doctor failed: ${error instanceof Error ? error.message : 'unknown error'}; rerun tally init --config ${JSON.stringify(transaction.configPath)} to resume from ${pendingInitPath(transaction.configPath)}; files will not be overwritten.`);
    }
}
async function reconfigureInit(options, configPath, print, readLine) {
    const pending = readReinit(configPath);
    const before = pending ? parseYaml(pending.beforeConfig) : loadConfig(configPath);
    const config = pending ? parseYaml(pending.afterConfig) : structuredClone(before);
    const targetRepo = resolve(dirname(configPath), config.repo.path);
    if (!validateConfig(before).ok || !validateConfig(config).ok)
        throw new InitError('Re-init recovery configuration is invalid; no changes made.');
    if (!pending) {
        for (const name of ['neatlogs', 'entire', 'cfoai']) {
            const label = name === 'cfoai' ? 'cfo.ai' : name === 'entire' ? 'Entire' : name;
            config.integrations[name] = options.integrations?.[name] ?? parseYes(await readLine(`Enable ${label} integration? y/N`, before.integrations[name] ? 'y' : 'N'));
        }
        if (options.modelAccessFallbackTier !== undefined)
            config.modelAccessFallbackTier = options.modelAccessFallbackTier;
    }
    if (!pending) {
        if (options.testCommand !== undefined)
            config.test.command = options.testCommand;
        if (options.setupCommand !== undefined) {
            delete config.test.setupCommand;
            if (options.setupCommand.trim())
                config.test.setupCommand = options.setupCommand;
        }
        if (options.budgetUsd !== undefined)
            config.budget.usd = parseBudget(String(options.budgetUsd));
        if (options.issueLabel !== undefined)
            config.backlog.issueLabel = options.issueLabel;
        if (options.runner || options.harnessChoice) {
            const setup = await chooseSetup({ ...options, runner: options.runner ?? before.runner ?? 'ao' }, options.command ?? defaultCommand, resolve(dirname(configPath), config.repo.path), readLine, print);
            if (setup.runner !== (before.runner ?? 'ao'))
                throw new InitError('Changing an existing installation runner requires uninstall and a fresh init; AO ownership will not be silently changed.');
            config.runner = setup.runner;
            if (!options.yes && !options.dryRun)
                config.parallelWorkers = setup.concurrency;
            if (options.harnessChoice)
                config.tiers = setup.tiers;
        }
        if ((config.runner ?? 'ao') === 'ao')
            aoWorkerMode(config);
        await consentClaude(config, options, readLine, print);
        // Re-running init is also the repair/upgrade path for repositories that
        // already have tally.yaml. Refresh selected integrations before comparing
        // the proposed config so new integration settings (for example Entire's
        // automatic commit linking or cfo.ai Ari context) are persisted too.
        // Dry runs and --yes do not imply consent to external integration changes.
        if (!options.dryRun && !options.yes) {
            await (options.onboarding ?? configureIntegrations)({ config, repoRoot: targetRepo, ui: {
                    print,
                    confirm: async (question) => parseYes(await readLine(`${question} y/N`, 'N')),
                    select: async (question, choices) => {
                        choices.forEach((choice, index) => print(`${index + 1}. ${choice}`));
                        const value = (await readLine(`${question} (number, or Enter to skip)`, '')).trim();
                        const index = Number(value) - 1;
                        return /^\d+$/.test(value) && index >= 0 && index < choices.length ? index : null;
                    },
                } });
        }
    }
    const validation = validateConfig(config);
    if (!validation.ok)
        throw new InitError(`Proposed configuration is invalid: ${validation.errors.join('; ')}; nothing was changed.`);
    const result = { configPath, projectId: config.repo.aoProject ?? '', testCommand: config.test.command, setupCommand: config.test.setupCommand ?? null, baseBranch: config.repo.baseBranch, tiers: config.tiers.map((tier) => `${tier.name}:${tier.harness}/${tier.model}`) };
    if (!pending && configHash(config) === configHash(before)) {
        print('No changes proposed. Existing configuration and installation ownership are unchanged.');
        return { ...result, applied: false, doctor: [] };
    }
    const command = options.command ?? ((file, args, commandOptions) => defaultCommand(file, args, { ...commandOptions, aoBin: config.repo.aoBin ? resolve(dirname(configPath), config.repo.aoBin) : undefined }));
    await initPrerequisites(config, command, targetRepo, options);
    const plan = pending ?? prepareReinit(configPath, stringifyYaml(config));
    print(`Tally re-init proposed diff for ${configPath}:`);
    printSummary(config, print);
    for (const key of Object.keys(config)) {
        if (configHash(before[key]) !== configHash(config[key])) {
            print(options.verbose || key === 'integrations' ? `- ${key}: ${JSON.stringify(before[key])}` : `- ${key}: existing setting`);
            print(options.verbose || key === 'integrations' ? `+ ${key}: ${JSON.stringify(config[key])}` : `+ ${key}: proposed setting shown above`);
        }
    }
    print(`Preserve all other settings. ${plan.beforeRecord === null ? 'No installation ownership record will be created' : 'Installation ownership and consented harness modes will be updated'}. AO project, setup hooks and worker permissions will not change.`);
    if (pending)
        print(`Resume interrupted re-init from ${reinitPath(configPath)}.`);
    if (options.dryRun || (!options.yes && !parseYes(await readLine('Apply these changes? y/N', 'N'))))
        return { ...result, applied: false, doctor: [] };
    applyReinit(plan);
    try {
        const doctor = await (options.doctor ?? ((path) => runDoctor({ configPath: path })))(configPath);
        finishReinit(configPath);
        return { ...result, applied: true, doctor };
    }
    catch (error) {
        throw new InitError(`Re-init updated ${configPath} and preserved installation ownership, but doctor failed: ${error instanceof Error ? error.message : 'unknown error'}; AO settings were unchanged; rerun tally init --config ${JSON.stringify(configPath)} to resume safely.`);
    }
}
export async function runInit(options = {}) {
    const command = options.command ?? defaultCommand;
    const print = options.print ?? console.log;
    const readLine = options.readLine ?? (options.yes || options.dryRun ? async (_question, defaultValue = '') => defaultValue : defaultReadLine);
    const cwd = options.cwd ?? process.cwd();
    const repoRoot = (await commandOrNull(command, 'git', ['rev-parse', '--show-toplevel'], cwd)) ?? cwd;
    const configPath = resolve(repoRoot, options.configPath ?? 'tally.yaml');
    const recordPath = installRecordPath(configPath);
    const pending = readPendingInit(configPath);
    if (pending) {
        const saved = parseYaml(pending.configText);
        const validation = validateConfig(saved);
        if (!validation.ok || resolve(pending.repoRoot) !== resolve(repoRoot) || (pending.record.runner ?? 'ao') !== (saved.runner ?? 'ao'))
            throw new InitError('Init recovery configuration is invalid or belongs to a different repository; no changes made.');
        const resumeCommand = options.command ?? ((file, args, commandOptions) => defaultCommand(file, args, { ...commandOptions, aoBin: saved.repo.aoBin ? resolve(dirname(configPath), saved.repo.aoBin) : undefined }));
        try {
            await initPrerequisites(saved, resumeCommand, repoRoot, options);
        }
        catch (error) {
            throw new InitError(`Incomplete init remains at ${pendingInitPath(configPath)}; ${configPath} ${existsSync(configPath) ? 'exists' : 'was not written'}, ${recordPath} ${existsSync(recordPath) ? 'exists' : 'was not written'}; no additional changes made: ${error instanceof Error ? error.message : 'prerequisites failed'}; fix the prerequisite and rerun tally init --config ${JSON.stringify(configPath)}.`);
        }
        print(`Resume incomplete init from ${pendingInitPath(configPath)}. Preserve matching files and existing AO settings.`);
        printSummary(saved, print);
        if (options.verbose)
            print(pending.configText);
        print(saved.runner === 'direct' ? 'Direct installation. No AO settings are owned or changed.' : `AO project: ${pending.record.projectId}\nSetup entry: ${pending.record.addedSetupCommand ?? 'none'}\nWorker allow-list: ${pending.record.workerPermissionMode === 'default' ? 'Claude local settings installed before launch' : 'not installed'}\nGlobal harness settings are unchanged.`);
        const result = { configPath, projectId: pending.record.projectId, testCommand: saved.test.command, setupCommand: saved.test.setupCommand ?? null, baseBranch: saved.repo.baseBranch, tiers: saved.tiers.map((tier) => `${tier.name}:${tier.harness}/${tier.model}`) };
        if (options.dryRun || (!options.yes && !parseYes(await readLine('Resume these changes? y/N', 'N'))))
            return { ...result, applied: false, doctor: [] };
        return { ...result, applied: true, doctor: await finishInit(options, pending, resumeCommand, recordPath) };
    }
    if (existsSync(configPath) || readReinit(configPath))
        return reconfigureInit(options, configPath, print, readLine);
    if (existsSync(recordPath))
        throw new InitError(`An install record exists without ${configPath}; preserve it and use tally uninstall --config ${JSON.stringify(configPath)} to remove the owned partial installation before retrying.`);
    const baseBranch = (await commandOrNull(command, 'git', ['branch', '--show-current'], repoRoot)) || 'main';
    const remote = await commandOrNull(command, 'git', ['remote', 'get-url', 'origin'], repoRoot);
    let testCommand = options.testCommand?.trim() || detectTestCommand(repoRoot);
    if (!testCommand) {
        const explanation = 'No test command found. Tally cannot verify work without a test command. Provide a shell command that checks the work. No configuration or AO settings have been changed.';
        print(explanation);
        if (options.yes || options.dryRun)
            throw new InitError(explanation);
        testCommand = (await readLine('Test command (shell command)', '')).trim();
        if (!testCommand)
            throw new InitError(explanation);
    }
    let setupCommand = options.setupCommand === undefined ? detectSetupCommand(repoRoot) : options.setupCommand.trim() || null;
    if (!setupCommand && options.setupCommand === undefined) {
        print('No setup command found. Leave it blank if no environment setup is needed. Tally will not invent an install command.');
        if (!options.yes && !options.dryRun)
            setupCommand = (await readLine('Setup command (optional shell command)', '')).trim() || null;
    }
    const issueLabel = options.issueLabel ?? await readLine('GitHub issue label for Tally tasks', 'tally');
    print('Optional integrations');
    print('  Integration  What it adds');
    print('  Neatlogs     Routing traces and machine-wide worker hooks');
    print('  Entire       Code graph sizing and session checkpoints');
    print('  cfo.ai       Budget, spend and Ari context reports');
    const neatlogs = options.integrations?.neatlogs ?? parseYes(await readLine('Enable Neatlogs traces and machine-wide worker hooks? y/N', 'N'));
    const entire = options.integrations?.entire ?? parseYes(await readLine('Enable Entire graph and checkpoints? y/N', 'N'));
    const cfoai = options.integrations?.cfoai ?? parseYes(await readLine('Use cfo.ai for budget, spend and Ari context? y/N', 'N'));
    const { runner, concurrency, tiers } = await chooseSetup(options, command, repoRoot, readLine, print);
    const fallbackTier = options.modelAccessFallbackTier ?? 'cheap';
    if (!tiers.some(tier => tier.name === fallbackTier)) {
        throw new InitError(`Model-access fallback tier must be one of ${tiers.map(tier => tier.name).join(', ')}; nothing was changed.`);
    }
    if (runner === 'ao')
        aoWorkerMode({ tiers });
    const projectId = runner === 'ao' ? basename(repoRoot) : '';
    const config = {
        version: 1,
        runner,
        repo: {
            path: '.',
            ...(slugFromRemote(remote) ? { slug: slugFromRemote(remote) } : {}),
            baseBranch,
            ...(runner === 'ao' ? { aoProject: projectId } : {}),
        },
        test: {
            ...(setupCommand ? { setupCommand } : {}),
            command: testCommand,
            timeoutSec: 900,
        },
        backlog: {
            source: 'github-issues',
            issueLabel,
        },
        tiers,
        modelAccessFallbackTier: fallbackTier,
        ceilings: {
            bySizeUsd: { small: 1.5, medium: 4, large: 10 },
        },
        budget: {
            source: cfoai ? 'cfoai' : 'config',
            usd: options.budgetUsd ?? 40,
        },
        concurrency,
        parallelWorkers: concurrency,
        integrations: { neatlogs, entire, cfoai, slack: false },
    };
    await consentClaude(config, options, readLine, print);
    if (!options.dryRun)
        await (options.onboarding ?? configureIntegrations)({ config, repoRoot, ui: {
                print,
                confirm: async (question) => !options.yes && parseYes(await readLine(`${question} y/N`, 'N')),
                select: async (question, choices) => {
                    if (options.yes)
                        return null;
                    choices.forEach((choice, index) => print(`${index + 1}. ${choice}`));
                    const value = (await readLine(`${question} (number, or Enter to skip)`, '')).trim();
                    const index = Number(value) - 1;
                    return /^\d+$/.test(value) && index >= 0 && index < choices.length ? index : null;
                },
            } });
    const liveBudget = config.budget.source === 'cfoai' && !options.dryRun
        ? await (options.readBudget ?? readPlanBudget)(config, {}) : null;
    let budgetQuestion;
    if (config.budget.source === 'cfoai') {
        if (liveBudget?.source === 'cfoai')
            print(`cfo.ai monthly budget: ${formatUsd(liveBudget.monthlyLimitNanos)}.`);
        else
            print('cfo.ai monthly budget is unavailable or has not been checked.');
        budgetQuestion = liveBudget?.source === 'cfoai'
            ? 'Local fallback budget if cfo.ai is unreachable (USD)'
            : 'Local fallback budget in USD';
    }
    else
        budgetQuestion = 'Monthly budget in USD (also the default run cap)';
    config.budget.usd = parseBudget(options.budgetUsd === undefined ? await readLine(budgetQuestion, String(config.budget.usd)) : String(options.budgetUsd));
    const validation = validateConfig(config);
    if (!validation.ok)
        throw new InitError(`Proposed configuration is invalid: ${validation.errors.join('; ')}; nothing was changed.`);
    await initPrerequisites(config, command, repoRoot, options);
    const existingProject = runner === 'ao' ? await projectOrNull(command, projectId, cwd) : null;
    const existingProjectPath = existingProject ? JSON.parse(existingProject).project?.path : undefined;
    if (existingProjectPath && resolve(existingProjectPath) !== resolve(repoRoot))
        throw new InitError(`AO project ${projectId} belongs to ${existingProjectPath}, not ${repoRoot}; choose a distinct project id before init; nothing was changed.`);
    const currentProjectConfig = existingProject ? parseYaml(existingProject)?.project?.config ?? {} : {};
    const workerMode = runner === 'ao' ? aoWorkerMode(config) : null;
    const hasClaude = config.tiers.some(tier => tier.harness === 'claude-code');
    const ownedSetupCommand = runner === 'ao' && hasClaude ? aoClaudeSetupCommand(configPath) : setupCommand;
    const nextProjectConfig = runner === 'ao' ? withWorkerPermissionMode(withPostCreate(currentProjectConfig, ownedSetupCommand), workerMode) : {};
    print('Tally init proposed changes:');
    printSummary(config, print);
    print(`Create ${configPath}: repository configuration${options.verbose ? `\n${stringifyYaml(config)}` : ' (use --verbose for full YAML)'}.`);
    print(`Create ${recordPath}: installation ownership record for uninstall.`);
    if (runner === 'ao') {
        print(`${existingProject ? 'Update' : 'Register'} AO project ${projectId} at ${repoRoot}. Preserve all existing config fields.`);
        print(`AO post-create entries: ${JSON.stringify(nextProjectConfig.postCreate ?? [])}`);
        print(`AO worker permission mode: ${workerMode} for this project only. No bypass-permissions or global settings changes. Uninstall restores the owned setting.`);
        print('Before each AO spawn Tally selects the consented tier harness mode under one in-process project lock: Codex auto, Claude Code default with local dontAsk.');
        if (hasClaude)
            print('Worker allow-list: consented Claude rules are installed before launch in .claude/settings.local.json. Script files stay outside the worktree. Local settings and instructions are excluded from Git.');
        else
            print('Worker allow-list: not installed. The current AO worker launch API cannot enforce scoped rules.');
        print(hasClaude ? 'Consented worker rules (installed locally before launch):' : 'Requested worker rules (not yet enforced):');
        print('- Edit files in the worker\'s own worktree.');
        print(`- Run the configured test command: ${testCommand}`);
        print('- Run git add and git commit.');
        print('- Tally publishes changes. Workers must not git push or create PRs. Approved setup may install dependencies.');
    }
    else
        print('Direct setup: no AO registration, post-create hooks, or AO worker permission changes.');
    print('Integration connection changes require separate approval. The config proposal contains no credentials.');
    const result = { configPath, projectId, testCommand, setupCommand, baseBranch, tiers: tiers.map((tier) => `${tier.name}:${tier.harness}/${tier.model}`), doctor: [] };
    if (options.dryRun || (!options.yes && !parseYes(await readLine('Apply these changes? y/N', 'N')))) {
        return { ...result, applied: false };
    }
    const configText = stringifyYaml(config);
    const before = currentProjectConfig;
    const postCreateBefore = Array.isArray(before.postCreate) ? before.postCreate : [];
    const record = { version: 1, runner, configPath, configHash: contentHash(configText), projectId,
        projectCreated: runner === 'ao' && !existingProject, projectConfigHash: configHash(nextProjectConfig),
        postCreateExisted: Array.isArray(before.postCreate), postCreateAfterHash: configHash(nextProjectConfig.postCreate ?? []),
        addedSetupCommand: runner === 'ao' && ownedSetupCommand && !postCreateBefore.includes(ownedSetupCommand) ? ownedSetupCommand : null,
        ...(runner === 'direct' ? {} : {
            aoHarnessPermissions: Object.fromEntries(config.tiers.map(tier => [tier.harness, AO_HARNESS_PERMISSIONS[tier.harness]])),
            workerPermissionMode: workerMode,
            workerExisted: Object.hasOwn(before, 'worker'), workerBefore: before.worker ?? null,
            workerAfterHash: configHash(nextProjectConfig.worker),
        }),
    };
    const doctor = await finishInit(options, { version: 1, repoRoot, configPath, configText, beforeProjectConfigHash: configHash(currentProjectConfig), record }, command, recordPath);
    return { ...result, applied: true, doctor };
}
//# sourceMappingURL=init.js.map