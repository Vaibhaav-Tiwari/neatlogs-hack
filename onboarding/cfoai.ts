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
  if (r.isError === true) throw new Error('cfo.ai refused the operation');
  if (r.structuredContent) return object(r.structuredContent);
  const blocks = Array.isArray(r.content) ? r.content : [];
  for (const block of blocks) {
    const b = object(block);
    if (b.type === 'text' && typeof b.text === 'string') {
      try { return object(JSON.parse(b.text)); } catch { /* Try the next content block. */ }
    }
  }
  throw new Error('cfo.ai returned an unreadable response');
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
    catch { return { status: 'missing', detail: 'cfo.ai is unavailable; run tally login cfoai.' }; }
  }

  async connect(context: OnboardingContext): Promise<IntegrationState> {
    const current = await this.check();
    if (current.status === 'ok') return current;
    context.ui.print('cfo.ai needs a Tally connection. No account? Sign up at https://app.cfo.ai; you can skip for now.');
    if (!await context.ui.confirm('Open the browser to connect Tally to cfo.ai?')) {
      return { status: 'off', detail: 'cfo.ai skipped; the tally.yaml budget remains available.' };
    }
    try {
      await (this.options.login ?? loginCfoai)();
      return await this.check();
    } catch {
      return { status: 'missing', detail: 'cfo.ai login did not complete; run tally login cfoai to retry.' };
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
          if (!validator(args)) throw new Error(`Incompatible ${name} schema`);
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
        context.ui.print(`Create on page Tally in ${workspace.name}, scenario ${scenario}, monthly USD columns starting ${month}:`);
        if (missing.includes(table)) context.ui.print(`${table}: ${budgetRow} = $${context.config.budget.usd}; ${spendRow} = $0; ${remainingRow} = ${budgetRow} - ${spendRow} (formula).`);
        if (missing.includes(detailTable)) context.ui.print(`${detailTable}: ${detailRows.join(', ')} = $0 each.`);
        context.ui.print('Existing tables and spend are not reset. New tables get their own variables.');
        if (!await context.ui.confirm('Create these missing cfo.ai tables?')) return off('cfo.ai skipped: table creation declined.');
        const end = `${now.getUTCFullYear() + 1}-12-31`;
        for (const name of missing) {
          const rows = name === table ? budgetRows : detailRows;
          const create: ObjectValue = {
            name, page: 'Tally', columns: [{ time: 'MONTH' }],
            rows: rows.map(variable => ({ variable, new: true })),
            variables: rows.map(target => ({ target, currency: 'USD', format: 'CURRENCY' })),
            window: { start: `${month}-01`, end, granularity: 'MONTH' },
          };
          // Inputs apply only to the new table's current month; never reset an existing table.
          create.values = { columns: [month], rows: rows.filter(row => row !== remainingRow).map(row => [row, row === budgetRow ? context.config.budget.usd : 0]) };
          if (name === table) create.rows = [
            { variable: budgetRow, new: true }, { variable: spendRow, new: true },
            { variable: remainingRow, new: true, formula: `\`${budgetRow}\` - \`${spendRow}\`` },
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
    } catch {
      context.ui.print('cfo.ai setup could not be verified; using the local budget. You can rerun onboarding to retry; existing model data was not reset.');
      return off('cfo.ai setup incomplete; local budget selected.');
    } finally { await client.close().catch(() => undefined); }
  }
}
