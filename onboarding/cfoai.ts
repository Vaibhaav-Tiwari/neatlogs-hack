import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  CfoaiBudgetAdapter, cfoaiMonthColumn, checkCfoaiConnection, createCfoaiClient, loginCfoai,
  type CfoaiMcpClient,
} from '../adapters/cfoai.js';
import type { IntegrationState } from '../schema/types.js';
import type { IntegrationOnboarding, OnboardingContext, OnboardingResult } from './types.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value)
  ? value as ObjectValue : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const https = (value: unknown): string | undefined => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
};

function payload(result: unknown): ObjectValue {
  const r = object(result);
  let parsed = r.structuredContent ? object(r.structuredContent) : undefined;
  let plainText: string | undefined;
  const blocks = Array.isArray(r.content) ? r.content : [];
  if (!parsed) {
    for (const block of blocks) {
      const b = object(block);
      if (b.type === 'text' && typeof b.text === 'string') {
        try { parsed = object(JSON.parse(b.text)); break; } catch { plainText ??= b.text; }
      }
    }
  }
  if (r.isError === true) {
    const error = object(parsed?.error);
    const detail = text(error.message) ?? text(parsed?.message) ?? text(parsed?.error) ?? text(plainText);
    throw new Error(detail ? `cfo.ai refused the operation: ${detail}` : 'cfo.ai refused the operation');
  }
  if (parsed) return parsed;
  throw new Error('cfo.ai returned an unreadable response');
}

function safeFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = raw
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|client[_-]?secret|signature|code|password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^@\s/]+:[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (safe || 'the server returned an unspecified error').slice(0, 240);
}

async function choose(context: OnboardingContext, question: string, values: ObjectValue[], name: (v: ObjectValue) => string): Promise<ObjectValue | null> {
  if (values.length === 1) return values[0]!;
  if (!values.length) return null;
  const index = await context.ui.select(question, values.map(name));
  return index === null ? null : values[index] ?? null;
}

export interface CfoaiOnboardingOptions {
  client?: () => CfoaiMcpClient;
  check?: () => Promise<IntegrationState>;
  login?: () => Promise<unknown>;
  now?: () => Date;
}

/** No init-file writes, no other harness's credentials, and no model edits without consent. */
export class CfoaiOnboarding implements IntegrationOnboarding {
  private readonly options: CfoaiOnboardingOptions;
  constructor(options: CfoaiOnboardingOptions = {}) { this.options = options; }

  async check(): Promise<IntegrationState> {
    try { return await (this.options.check ?? checkCfoaiConnection)(); }
    catch { return { status: 'missing', detail: 'cfo.ai is unavailable. Run tally login cfoai.' }; }
  }

  async connect(context: OnboardingContext): Promise<IntegrationState> {
    const current = await this.check();
    if (current.status === 'ok') return current;
    context.ui.print('cfo.ai connection');
    context.ui.print('  Sign in to let Tally read the budget and record spend.');
    context.ui.print('  No account? Sign up at https://app.cfo.ai. You can skip this integration.');
    if (!await context.ui.confirm('Open the browser to connect Tally to cfo.ai?')) {
      return { status: 'off', detail: 'cfo.ai skipped. The tally.yaml budget remains available.' };
    }
    try {
      await (this.options.login ?? loginCfoai)();
      return await this.check();
    } catch {
      return { status: 'missing', detail: 'cfo.ai login did not complete. Run tally login cfoai to retry.' };
    }
  }

  async configure(context: OnboardingContext): Promise<OnboardingResult> {
    const off = (detail: string): OnboardingResult => ({
      enabled: false, state: { status: 'off', detail },
      budget: { source: 'config', usd: context.config.budget.usd },
    });
    const connection = await this.connect(context);
    if (connection.status !== 'ok') {
      context.ui.print(connection.detail ?? 'cfo.ai skipped.');
      return { ...off(connection.detail ?? 'cfo.ai unavailable'), state: connection };
    }
    const client = (this.options.client ?? createCfoaiClient)();
    try {
      await client.connect();
      const listed = await client.listTools();
      const tools = new Map(listed.tools.map(tool => [tool.name, tool]));
      const call = async (name: string, args: ObjectValue): Promise<ObjectValue> => {
        const tool = tools.get(name);
        if (!tool) throw new Error(`Missing ${name}`);
        // Refuse an unvalidated write if a server does not publish its edit schema.
        if (name.startsWith('edit_') && !tool.inputSchema) throw new Error('Missing edit schema');
        if (tool.inputSchema) {
          const validator = new Ajv2020({ strict: false, allErrors: true }).compile(tool.inputSchema);
          if (!validator(args)) {
            const issues = validator.errors?.slice(0, 3).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
            throw new Error(`Incompatible ${name} schema${issues ? `: ${issues}` : ''}`);
          }
        }
        return payload(await client.callTool(name, args));
      };
      const orgs = await call('list_orgs', {});
      const workspace = await choose(context, 'Choose a cfo.ai workspace (or skip)',
        Array.isArray(orgs.orgs) ? orgs.orgs.map(object) : [], v => `${v.name} (${v.org_id})`);
      if (!workspace) return off('cfo.ai skipped: no workspace selected. Sign up at https://app.cfo.ai.');
      const orgId = text(workspace.org_id) ?? (typeof workspace.org_id === 'number' ? String(workspace.org_id) : undefined);
      if (!orgId) throw new Error('Workspace has no ID');
      const scenarioResult = await call('inspect_scenarios', { org_id: orgId, list: {} });
      const scenarioObject = await choose(context, 'Choose a cfo.ai scenario (or skip)',
        Array.isArray(scenarioResult.scenarios) ? scenarioResult.scenarios.map(object) : [], v => String(v.display_name));
      if (!scenarioObject) return off('cfo.ai skipped: no scenario selected.');
      const scenario = text(scenarioObject.display_name);
      if (!scenario) throw new Error('Scenario has no name');
      const existing = context.config.budget.cfoai;
      const table = existing?.table ?? 'Tally agent budget';
      const detailTable = existing?.spendDetailTable ?? 'Tally spend detail';
      const budgetRow = existing?.budgetRow ?? 'Agent budget';
      const spendRow = existing?.spendRow ?? 'Agent spend';
      const remainingRow = existing?.remainingRow ?? 'Budget remaining';
      const tierSpendRows = Object.fromEntries(context.config.tiers.map(tier => [
        tier.name, existing?.tierSpendRows?.[tier.name] ?? `Tier spend - ${tier.name}`,
      ]));
      const runSpendRow = existing?.runSpendRow ?? 'Run spend - current';
      const cumulativeRunSpendRow = existing?.cumulativeRunSpendRow ?? 'Run spend - cumulative';
      const scope = { org_id: orgId, scenario };
      const inspect = async (): Promise<ObjectValue[]> => {
        const result = await call('inspect_table_blocks', { ...scope, list: { target: [table, detailTable] } });
        if (!Array.isArray(result.blocks)) throw new Error('Missing table discovery');
        return result.blocks.map(object);
      };
      let blocks = await inspect();
      const find = (name: string) => {
        const matches = blocks.filter(b => b.display_name === name);
        if (matches.length > 1) throw new Error('Ambiguous table');
        return matches[0];
      };
      const now = (this.options.now ?? (() => new Date()))();
      const month = cfoaiMonthColumn(now);
      const budgetRows = [budgetRow, spendRow, remainingRow];
      const detailRows = [...Object.values(tierSpendRows), runSpendRow, cumulativeRunSpendRow];
      const missing = [!find(table) ? table : null, !find(detailTable) ? detailTable : null].filter((x): x is string => x !== null);
      if (missing.length) {
        context.ui.print('cfo.ai table setup');
        context.ui.print(`  Workspace: ${workspace.name}`);
        context.ui.print(`  Scenario: ${scenario}`);
        context.ui.print(`  Page: Tally`);
        context.ui.print(`  Monthly values start: ${month}`);
        if (missing.includes(table)) {
          context.ui.print(`  Create ${table}:`);
          context.ui.print(`    ${budgetRow}: $${context.config.budget.usd}`);
          context.ui.print(`    ${spendRow}: $0`);
          context.ui.print(`    ${remainingRow}: formula (${budgetRow} - ${spendRow})`);
        }
        if (missing.includes(detailTable)) {
          context.ui.print(`  Create ${detailTable}:`);
          for (const row of detailRows) context.ui.print(`    ${row}: $0`);
        }
        context.ui.print('Only missing tables will be created. Existing tables and spend will not be changed.');
        if (!await context.ui.confirm('Create the listed tables in cfo.ai?')) return off('cfo.ai skipped. Table creation was declined.');
        const end = `${now.getUTCFullYear() + 1}-12-31`;
        for (const name of missing) {
          const rows = name === table ? budgetRows : detailRows;
          const currencyFormat = () => ({ numberFormat: 'CURRENCY', decimalPlaces: 2 });
          const create: ObjectValue = {
            name, page: 'Tally', columns: [{ time: 'MONTH' }],
            rows: rows.map(variable => ({ variable, new: true, format: currencyFormat() })),
            window: { start: `${month}-01`, end, granularity: 'MONTH' },
          };
          // Inputs apply only to the new table's current month; never reset an existing table.
          create.values = { columns: [month], rows: rows.filter(row => row !== remainingRow).map(row => [row, row === budgetRow ? context.config.budget.usd : 0]) };
          if (name === table) create.rows = [
            { variable: budgetRow, new: true, format: currencyFormat() },
            { variable: spendRow, new: true, format: currencyFormat() },
            { variable: remainingRow, new: true, formula: `\`${budgetRow}\` - \`${spendRow}\``, format: currencyFormat() },
          ];
          const receipt = await call('edit_table_blocks', { ...scope, create });
          if (receipt.status !== 'applied') throw new Error('Creation not applied');
        }
        blocks = await inspect();
      }
      const budgetBlock = find(table);
      const detailBlock = find(detailTable);
      for (const [block, rows] of [[budgetBlock, budgetRows], [detailBlock, detailRows]] as const) {
        if (!block) throw new Error('Created table not found');
        const layout = object(block.layout);
        const names = new Set(Array.isArray(layout.rows) ? layout.rows.map(row => object(row).display_name) : []);
        if (rows.some(row => !names.has(row))) throw new Error('Existing table lacks required rows');
        const columns = Array.isArray(layout.columns) ? layout.columns.map(object) : [];
        if (!columns.some(c => c.time === 'MONTH' || (c.grain === 'MONTH' && String(c.dimension).startsWith('Date')))) throw new Error('Table needs monthly Date columns');
      }
      const pageUrl = https(object(budgetBlock!.page).url);
      const tableUrl = https(budgetBlock!.url);
      const spendDetailTableUrl = https(detailBlock!.url);
      if (!pageUrl || !tableUrl || !spendDetailTableUrl) throw new Error('Missing discovered HTTPS table/page URL');
      const cfoai = { orgId, scenario, table, budgetRow, spendRow, remainingRow,
        spendDetailTable: detailTable, tierSpendRows, runSpendRow, cumulativeRunSpendRow,
        pageUrl, tableUrl, spendDetailTableUrl };
      // Verify the adapter can read the chosen budget before proposing budget.source=cfoai.
      const budgetClient = (this.options.client ?? createCfoaiClient)();
      const adapter = new CfoaiBudgetAdapter({ client: budgetClient, config: cfoai, now: () => now });
      try { await adapter.remainingNanos(); } finally { await budgetClient.close(); }
      return { enabled: true, state: { status: 'ok', detail: `cfo.ai configured for ${workspace.name}, ${scenario}.` },
        budget: { source: 'cfoai', usd: context.config.budget.usd, cfoai } };
    } catch (error) {
      const reason = safeFailureReason(error);
      context.ui.print(`cfo.ai setup could not be verified: ${reason}.`);
      context.ui.print('Tally will use the local budget. Existing model data was not changed. Rerun tally init to retry.');
      return off(`cfo.ai setup incomplete: ${reason}. Tally selected the local budget.`);
    } finally { await client.close().catch(() => undefined); }
  }
}
