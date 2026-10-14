import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CommandError } from '../adapters/command.js';
import { configHash, contentHash } from './install-record.js';
import { withWorkerPermissionMode } from './preflight.js';
import { AO_HARNESS_PERMISSIONS } from './harness.js';
export function pendingInitPath(configPath) {
    return resolve(dirname(configPath), '.tally', 'init-pending.json');
}
export function readPendingInit(configPath) {
    const path = pendingInitPath(configPath);
    if (!existsSync(path))
        return null;
    let value;
    try {
        value = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        throw new CommandError(`Invalid init recovery record at ${path}; preserve it and inspect it before retrying.`);
    }
    if (!value || typeof value !== 'object' || value.version !== 1 || value.configPath !== configPath || value.record?.configPath !== configPath ||
        typeof value.configText !== 'string' || contentHash(value.configText) !== value.record.configHash ||
        typeof value.beforeProjectConfigHash !== 'string' || typeof value.repoRoot !== 'string' ||
        value.record.version !== 1 || (value.record.runner !== undefined && !['ao', 'direct'].includes(value.record.runner)) || typeof value.record.projectId !== 'string' || typeof value.record.projectCreated !== 'boolean' || typeof value.record.projectConfigHash !== 'string') {
        throw new CommandError(`Invalid init recovery record at ${path}; preserve it and inspect it before retrying.`);
    }
    if (value.record.workerPermissionMode !== undefined && !['auto', 'default'].includes(value.record.workerPermissionMode))
        throw new CommandError('Invalid init recovery worker permission mode.');
    if (value.record.aoHarnessPermissions && (typeof value.record.aoHarnessPermissions !== 'object' || Array.isArray(value.record.aoHarnessPermissions)
        || !Object.keys(value.record.aoHarnessPermissions).length || Object.entries(value.record.aoHarnessPermissions).some(([harness, mode]) => AO_HARNESS_PERMISSIONS[harness] !== mode)))
        throw new CommandError('Invalid init recovery harness permission modes.');
    return value;
}
export async function applyInitTransaction(transaction, command, recordPath) {
    const { configPath, configText, record, repoRoot } = transaction;
    const pendingPath = pendingInitPath(configPath);
    // Never overwrite files changed by the user while recovering an interrupted init.
    if (existsSync(configPath) && contentHash(readFileSync(configPath, 'utf8')) !== record.configHash) {
        throw new CommandError(`Init recovery refused: ${configPath} differs from the pending configuration; preserve your edits before retrying.`);
    }
    if (existsSync(recordPath) && configHash(JSON.parse(readFileSync(recordPath, 'utf8'))) !== configHash(record)) {
        throw new CommandError(`Init recovery refused: ${recordPath} differs from the pending ownership record.`);
    }
    let stage = 'creating recovery record';
    const completed = transaction.completed ?? [];
    const save = () => writeFileSync(pendingPath, JSON.stringify({ ...transaction, completed }, null, 2), { mode: 0o600 });
    try {
        mkdirSync(dirname(pendingPath), { recursive: true });
        if (!existsSync(pendingPath))
            writeFileSync(pendingPath, JSON.stringify(transaction, null, 2), { mode: 0o600, flag: 'wx' });
        if ((record.runner ?? 'ao') === 'ao') {
            stage = 'reading AO project';
            let current;
            try {
                const payload = JSON.parse((await command('ao', ['project', 'get', record.projectId, '--json'], { cwd: repoRoot })).stdout);
                const path = payload.project?.path;
                if (typeof path === 'string' && resolve(path) !== resolve(repoRoot))
                    throw new CommandError(`AO project ${record.projectId} belongs to another repository (${path}); choose another project id.`);
                current = payload.project?.config ?? {};
            }
            catch (error) {
                if (!(error instanceof Error) || !/missing project|not found|HTTP 404/i.test(error.message))
                    throw error;
                if (!record.projectCreated)
                    throw new CommandError(`Existing AO project ${record.projectId} disappeared; refusing to recreate a project Tally did not own.`);
                stage = 'registering AO project';
                await command('ao', ['project', 'add', '--path', repoRoot, '--id', record.projectId], { cwd: repoRoot });
                completed.push(`registered AO project ${record.projectId}`);
                save();
                current = JSON.parse((await command('ao', ['project', 'get', record.projectId, '--json'], { cwd: repoRoot })).stdout).project?.config ?? {};
            }
            const hash = configHash(current);
            if (!record.projectCreated && hash !== transaction.beforeProjectConfigHash && hash !== record.projectConfigHash) {
                throw new CommandError('AO project settings changed since init was proposed; refusing to overwrite them.');
            }
            const next = record.workerAfterHash ? withWorkerPermissionMode(current, record.workerPermissionMode ?? 'auto') : { ...current };
            if (record.addedSetupCommand) {
                const commands = Array.isArray(next.postCreate) ? next.postCreate : [];
                next.postCreate = commands.includes(record.addedSetupCommand) ? commands : [...commands, record.addedSetupCommand];
            }
            if (record.projectCreated && !transaction.newProjectInitialized) {
                // New AO projects can contain daemon defaults unknown before registration.
                record.projectConfigHash = configHash(next);
                record.postCreateExisted = Array.isArray(current?.postCreate);
                record.postCreateAfterHash = configHash(next.postCreate ?? []);
                if (record.workerAfterHash) {
                    record.workerExisted = Object.hasOwn(current ?? {}, 'worker');
                    record.workerBefore = current?.worker ?? null;
                    record.workerAfterHash = configHash(next.worker);
                }
                if (record.addedSetupCommand && Array.isArray(current?.postCreate) && current.postCreate.includes(record.addedSetupCommand))
                    record.addedSetupCommand = null;
                transaction.newProjectInitialized = true;
                save();
            }
            if (configHash(next) !== record.projectConfigHash) {
                throw new CommandError('AO project configuration differs from the pending init; no settings were overwritten.');
            }
            stage = 'updating AO project configuration';
            await command('ao', ['project', 'set-config', record.projectId, '--config-json', JSON.stringify(next), '--json'], { cwd: repoRoot });
            completed.push(`configured AO project ${record.projectId}`);
            save();
        }
        stage = 'writing ownership record';
        if (existsSync(recordPath)) {
            if (configHash(JSON.parse(readFileSync(recordPath, 'utf8'))) !== configHash(record))
                throw new CommandError('Ownership record changed during init; refusing to overwrite it.');
        }
        else
            writeFileSync(recordPath, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
        completed.push(`wrote ${recordPath}`);
        save();
        stage = 'writing tally.yaml';
        if (existsSync(configPath)) {
            if (contentHash(readFileSync(configPath, 'utf8')) !== record.configHash)
                throw new CommandError('tally.yaml changed during init; refusing to overwrite it.');
        }
        else
            writeFileSync(configPath, configText, { flag: 'wx' });
        completed.push(`wrote ${configPath}`);
        save();
    }
    catch (error) {
        throw new CommandError(`Init stopped while ${stage}: ${error instanceof Error ? error.message : 'unknown error'}; completed: ${completed.join(', ') || 'no AO or config changes confirmed'}; ${configPath} ${existsSync(configPath) ? 'exists' : 'was not written'}, ${recordPath} ${existsSync(recordPath) ? 'exists' : 'was not written'}; if the failed AO call did not return, its outcome must be checked on resume; recovery record ${existsSync(pendingPath) ? pendingPath : 'was not written'}; rerun tally init --config ${JSON.stringify(configPath)} to resume safely after fixing the error.`);
    }
}
export function finishInitTransaction(configPath) {
    unlinkSync(pendingInitPath(configPath));
}
//# sourceMappingURL=init-transaction.js.map