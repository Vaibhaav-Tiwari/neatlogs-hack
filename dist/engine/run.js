import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDryRunPorts } from './dry-run.js';
import { runRealTally } from './real.js';
import { DEFAULT_LATEST_RUN_DIR } from './output.js';
import { loadConfig } from './config.js';
import { validateRealRunConfig } from './preflight.js';
export class RunError extends Error {
    problems;
    constructor(problems) {
        super(problems.join('; '));
        this.problems = problems;
        this.name = 'RunError';
    }
}
export async function runTally(options) {
    const config = loadConfig(options.configPath);
    if (!options.dryRun)
        await validateRealRunConfig(config, options.configPath, options.preflightRunner);
    const ports = options.dryRun ? { ...createDryRunPorts({ config, configPath: options.configPath }), ...options.ports } : options.ports;
    return runRealTally({ ...options, ...(ports ? { ports } : {}) });
}
function demoConfigPath(live = false) {
    const file = live ? 'tally.live.yaml' : 'tally.yaml';
    const candidates = [
        resolve('demo', file),
        fileURLToPath(new URL(`../demo/${file}`, import.meta.url)),
        fileURLToPath(new URL(`../../demo/${file}`, import.meta.url)),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
export async function runDemo(options = {}) {
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
//# sourceMappingURL=run.js.map