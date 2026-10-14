import { existsSync, readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
// Schemas are plain JSON files so the dashboard can read the same ones. They
// sit next to this file in the source tree and two levels up from dist/schema.
const here = new URL('./', import.meta.url);
const schemaDir = existsSync(new URL('ledger-row.schema.json', here)) ? here : new URL('../../schema/', here);
const load = (name) => JSON.parse(readFileSync(new URL(name, schemaDir), 'utf8'));
const addFormats = addFormatsModule.default ?? addFormatsModule;
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const ledgerRow = ajv.compile(load('ledger-row.schema.json'));
const runState = ajv.compile(load('run-state.schema.json'));
const taskImpact = ajv.compile({ $ref: 'https://tally.dev/schema/run-state.schema.json#/definitions/impact' });
const changedFiles = ajv.compile({ $ref: 'https://tally.dev/schema/run-state.schema.json#/definitions/changedFiles' });
const config = ajv.compile(load('tally-config.schema.json'));
function run(validate, value, prefix = '') {
    if (validate(value))
        return { ok: true, errors: [] };
    const errors = (validate.errors ?? []).map((e) => `${prefix}${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
    return { ok: false, errors };
}
export function validateLedgerRow(value) {
    return run(ledgerRow, value);
}
export function validateLedger(value) {
    if (!Array.isArray(value))
        return { ok: false, errors: ['/ must be an array of ledger rows'] };
    const errors = value.flatMap((row, i) => run(ledgerRow, row, `/${i}`).errors);
    return { ok: errors.length === 0, errors };
}
export function validateRunState(value) {
    const result = run(runState, value);
    if (!result.ok)
        return result;
    const tasks = value.tasks;
    const errors = [];
    for (const [index, task] of tasks.entries()) {
        if (!task.impact)
            continue;
        errors.push(...validateTaskImpact(task.impact).errors.map((error) => `/tasks/${index}/impact${error}`));
    }
    return { ok: errors.length === 0, errors };
}
export function validateTaskImpact(value) {
    const result = run(taskImpact, value);
    if (!result.ok)
        return result;
    const impact = value;
    const ids = new Set(impact.nodes.map((node) => node.id));
    const errors = [];
    if (ids.size !== impact.nodes.length)
        errors.push('/nodes must have unique ids');
    if (impact.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to)))
        errors.push('/edges must reference included nodes');
    if (impact.totals.nodes < impact.nodes.length || impact.totals.edges < impact.edges.length)
        errors.push('/totals must include at least the displayed nodes and edges');
    return { ok: errors.length === 0, errors };
}
export function validateConfig(value) {
    const result = run(config, value);
    if (!result.ok || typeof value !== 'object' || value === null)
        return result;
    const candidate = value;
    if (candidate.modelAccessFallbackTier === undefined)
        return result;
    if (typeof candidate.modelAccessFallbackTier !== 'string' || !candidate.tiers?.some(tier => tier.name === candidate.modelAccessFallbackTier)) {
        return { ok: false, errors: ['/modelAccessFallbackTier must name a configured tier'] };
    }
    return result;
}
export function validateChangedFiles(value) {
    return run(changedFiles, value);
}
//# sourceMappingURL=validate.js.map