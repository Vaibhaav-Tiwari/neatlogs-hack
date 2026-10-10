import { existsSync, readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { TaskImpact } from './types.js';

export interface ValidationResult {
  ok: boolean;
  /** One human-readable line per problem, e.g. "/tiers/0 must have required property 'model'". */
  errors: string[];
}

// Schemas are plain JSON files so the dashboard can read the same ones. They
// sit next to this file in the source tree and two levels up from dist/schema.
const here = new URL('./', import.meta.url);
const schemaDir = existsSync(new URL('ledger-row.schema.json', here)) ? here : new URL('../../schema/', here);
const load = (name: string): object => JSON.parse(readFileSync(new URL(name, schemaDir), 'utf8')) as object;

const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
const ajv = new Ajv({ allErrors: true });
(addFormats as unknown as (a: Ajv) => void)(ajv);

const ledgerRow = ajv.compile(load('ledger-row.schema.json'));
const runState = ajv.compile(load('run-state.schema.json'));
const taskImpact = ajv.compile({ $ref: 'https://tally.dev/schema/run-state.schema.json#/definitions/impact' });
const changedFiles = ajv.compile({ $ref: 'https://tally.dev/schema/run-state.schema.json#/definitions/changedFiles' });
const config = ajv.compile(load('tally-config.schema.json'));

function run(validate: ValidateFunction, value: unknown, prefix = ''): ValidationResult {
  if (validate(value)) return { ok: true, errors: [] };
  const errors = (validate.errors ?? []).map((e) => `${prefix}${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
  return { ok: false, errors };
}

export function validateLedgerRow(value: unknown): ValidationResult {
  return run(ledgerRow, value);
}

export function validateLedger(value: unknown): ValidationResult {
  if (!Array.isArray(value)) return { ok: false, errors: ['/ must be an array of ledger rows'] };
  const errors = value.flatMap((row, i) => run(ledgerRow, row, `/${i}`).errors);
  return { ok: errors.length === 0, errors };
}

export function validateRunState(value: unknown): ValidationResult {
  const result = run(runState, value);
  if (!result.ok) return result;
  const tasks = (value as { tasks: Array<{ impact?: { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> } }> }).tasks;
  const errors: string[] = [];
  for (const [index, task] of tasks.entries()) {
    if (!task.impact) continue;
    errors.push(...validateTaskImpact(task.impact).errors.map((error) => `/tasks/${index}/impact${error}`));
  }
  return { ok: errors.length === 0, errors };
}

export function validateTaskImpact(value: unknown): ValidationResult {
  const result = run(taskImpact, value);
  if (!result.ok) return result;
  const impact = value as TaskImpact;
  const ids = new Set(impact.nodes.map((node) => node.id));
  const errors: string[] = [];
  if (ids.size !== impact.nodes.length) errors.push('/nodes must have unique ids');
  if (impact.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) errors.push('/edges must reference included nodes');
  if (impact.totals.nodes < impact.nodes.length || impact.totals.edges < impact.edges.length) errors.push('/totals must include at least the displayed nodes and edges');
  return { ok: errors.length === 0, errors };
}

export function validateConfig(value: unknown): ValidationResult {
  return run(config, value);
}

export function validateChangedFiles(value: unknown): ValidationResult {
  return run(changedFiles, value);
}
