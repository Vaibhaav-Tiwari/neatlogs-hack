import { existsSync, readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

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
  return run(runState, value);
}

export function validateConfig(value: unknown): ValidationResult {
  return run(config, value);
}
