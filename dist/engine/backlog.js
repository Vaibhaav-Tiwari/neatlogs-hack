import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateChangedFiles, validateTaskImpact } from '../schema/index.js';
export class BacklogError extends Error {
    path;
    problems;
    constructor(path, problems) {
        super(`${path}: ${problems.join('; ')}`);
        this.path = path;
        this.problems = problems;
        this.name = 'BacklogError';
    }
}
const SIZES = new Set(['small', 'medium', 'large']);
const OUTCOMES = new Set(['passed', 'failed', 'stopped', 'error']);
const HANDOFFS = new Set(['restart', 'entire-handoff']);
function zeroTokens() {
    return { uncachedInput: 0, cachedInput: 0, output: 0, total: 0 };
}
function stringAt(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
function numberAt(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isInteger(value))
            return value;
    }
    return null;
}
function parseOutcomes(value, problems, prefix) {
    if (value === undefined)
        return ['passed'];
    if (!Array.isArray(value) || value.length === 0) {
        problems.push(`${prefix}.outcomes must be a non-empty array`);
        return ['error'];
    }
    return value.map((item, index) => {
        if (typeof item === 'string' && OUTCOMES.has(item))
            return item;
        problems.push(`${prefix}.outcomes[${index}] must be passed, failed, stopped or error`);
        return 'error';
    });
}
function parseTokens(value, problems, prefix) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(`${prefix}.tokens must be an object`);
        return zeroTokens();
    }
    const record = value;
    const uncachedInput = tokenAt(record.uncachedInput);
    const cachedInput = tokenAt(record.cachedInput);
    const output = tokenAt(record.output);
    const total = tokenAt(record.total) || uncachedInput + cachedInput + output;
    return { uncachedInput, cachedInput, output, total };
}
function tokenAt(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
function parseScriptedAttempts(task, outcomes, problems, prefix) {
    const scriptedOutcome = task.scriptedOutcome;
    const attempts = typeof scriptedOutcome === 'object' && scriptedOutcome !== null && !Array.isArray(scriptedOutcome)
        ? scriptedOutcome.attempts
        : undefined;
    if (attempts === undefined) {
        return outcomes.map((result) => ({ result, resultReason: null, tokens: zeroTokens(), handoff: null, decision: null }));
    }
    if (!Array.isArray(attempts) || attempts.length === 0) {
        problems.push(`${prefix}.scriptedOutcome.attempts must be a non-empty array`);
        return outcomes.map((result) => ({ result, resultReason: null, tokens: zeroTokens(), handoff: null, decision: null }));
    }
    return attempts.map((item, index) => {
        const attemptPrefix = `${prefix}.scriptedOutcome.attempts[${index}]`;
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            problems.push(`${attemptPrefix} must be an object`);
            return { result: 'error', resultReason: null, tokens: zeroTokens(), handoff: null, decision: null };
        }
        const attempt = item;
        const result = attempt.result;
        if (typeof result !== 'string' || !OUTCOMES.has(result)) {
            problems.push(`${attemptPrefix}.result must be passed, failed, stopped or error`);
        }
        const handoff = attempt.handoff;
        if (handoff !== undefined && (typeof handoff !== 'string' || !HANDOFFS.has(handoff))) {
            problems.push(`${attemptPrefix}.handoff must be restart or entire-handoff`);
        }
        const tier = attempt.tier;
        if (tier !== undefined && (typeof tier !== 'string' || tier.length === 0)) {
            problems.push(`${attemptPrefix}.tier must be a non-empty string`);
        }
        if (attempt.changedFiles !== undefined) {
            const validation = validateChangedFiles(attempt.changedFiles);
            if (!validation.ok)
                problems.push(...validation.errors.map((error) => `${attemptPrefix}.changedFiles ${error}`));
        }
        return {
            ...(attempt.changedFiles !== undefined ? { changedFiles: attempt.changedFiles } : {}),
            ...(typeof tier === 'string' && tier.length > 0 ? { tier } : {}),
            result: typeof result === 'string' && OUTCOMES.has(result) ? result : 'error',
            resultReason: typeof attempt.resultReason === 'string' && attempt.resultReason.length > 0 ? attempt.resultReason : null,
            tokens: parseTokens(attempt.tokens, problems, attemptPrefix),
            handoff: typeof handoff === 'string' && HANDOFFS.has(handoff) ? handoff : null,
            decision: typeof attempt.decision === 'string' && attempt.decision.length > 0 ? attempt.decision : null,
        };
    });
}
function normaliseTask(value, index, problems) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(`/tasks/${index} must be an object`);
        return null;
    }
    const task = value;
    const taskId = stringAt(task, ['taskId', 'id']);
    const title = stringAt(task, ['title']);
    const size = task.size;
    const prefix = `/tasks/${taskId ?? index}`;
    if (taskId === undefined)
        problems.push(`${prefix}.taskId is required`);
    if (title === undefined)
        problems.push(`${prefix}.title is required`);
    if (typeof size !== 'string' || !SIZES.has(size)) {
        problems.push(`${prefix}.size must be small, medium or large`);
    }
    if (taskId === undefined || title === undefined || typeof size !== 'string' || !SIZES.has(size))
        return null;
    const outcomes = parseOutcomes(task.outcomes, problems, prefix);
    const override = task.firstAttemptCeilingUsd;
    if (override !== undefined && (typeof override !== 'number' || !Number.isFinite(override) || override <= 0)) {
        problems.push(`${prefix}.firstAttemptCeilingUsd must be a positive finite number`);
    }
    if (task.impact !== undefined) {
        const result = validateTaskImpact(task.impact);
        if (!result.ok)
            problems.push(...result.errors.map((error) => `${prefix}.impact ${error}`));
    }
    return {
        taskId,
        title,
        body: stringAt(task, ['body', 'description']) ?? '',
        issueNumber: numberAt(task, ['issueNumber', 'number']),
        issueUrl: stringAt(task, ['issueUrl', 'url']) ?? null,
        size: size,
        outcomes,
        ...(typeof override === 'number' ? { firstAttemptCeilingUsd: override } : {}),
        scriptedAttempts: parseScriptedAttempts(task, outcomes, problems, prefix),
        ...(task.impact !== undefined ? { impact: task.impact } : {}),
    };
}
/** Reads the file fallback backlog. GitHub issue intake will plug in beside this adapter. */
export function loadFileBacklog(config, configPath) {
    if (config.backlog.source !== 'file') {
        throw new BacklogError(configPath, ['github issue intake is not implemented yet; use backlog.source=file for dry runs']);
    }
    if (config.backlog.file === undefined) {
        throw new BacklogError(configPath, ['backlog.file is required when backlog.source=file']);
    }
    const path = resolve(dirname(configPath), config.backlog.file);
    if (!existsSync(path))
        throw new BacklogError(path, ['file not found']);
    let parsed;
    try {
        parsed = parseYaml(readFileSync(path, 'utf8'));
    }
    catch (e) {
        throw new BacklogError(path, [`not valid YAML or JSON: ${e.message}`]);
    }
    const rawTasks = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null ? parsed.tasks : undefined;
    if (!Array.isArray(rawTasks))
        throw new BacklogError(path, ['expected an array or an object with a tasks array']);
    const problems = [];
    const tasks = rawTasks.map((item, i) => normaliseTask(item, i, problems)).filter((task) => task !== null);
    if (problems.length > 0)
        throw new BacklogError(path, problems);
    return tasks;
}
//# sourceMappingURL=backlog.js.map