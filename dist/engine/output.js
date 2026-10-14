import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
export const DEFAULT_LATEST_RUN_DIR = '.tally/runs/latest';
function writeJson(path, value) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}
export function writeRunFiles(outputDir, runState, ledger, latestRunDir = DEFAULT_LATEST_RUN_DIR) {
    const resolvedOutput = resolve(outputDir);
    const resolvedLatest = resolve(latestRunDir);
    mkdirSync(resolvedOutput, { recursive: true });
    mkdirSync(resolvedLatest, { recursive: true });
    const runStatePath = resolve(resolvedOutput, 'run.json');
    const ledgerPath = resolve(resolvedOutput, 'ledger.json');
    writeJson(runStatePath, runState);
    writeJson(ledgerPath, ledger);
    writeJson(resolve(resolvedLatest, 'run.json'), runState);
    writeJson(resolve(resolvedLatest, 'ledger.json'), ledger);
    return { outputDir: resolvedOutput, runStatePath, ledgerPath, latestRunDir: resolvedLatest };
}
//# sourceMappingURL=output.js.map