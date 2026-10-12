import { describe, expect, it, vi } from 'vitest';
import { CfoaiOnboarding } from './cfoai.js';
import type { OnboardingContext } from './types.js';
import type { CfoaiMcpClient } from '../adapters/cfoai.js';
import { sampleConfig } from '../agent/testing/fakes.js';
import { validateConfig } from '../schema/validate.js';

type Obj = Record<string, any>;
const tools = ['list_orgs', 'inspect_scenarios', 'inspect_table_blocks', 'edit_table_blocks', 'inspect_pages', 'edit_pages', 'edit_memory'];
const budgetRows = ['Agent budget', 'Agent spend', 'Budget remaining'];
const detailRows = ['Tier spend - cheap', 'Tier spend - middle', 'Tier spend - top', 'Run spend - current', 'Run spend - cumulative'];
function block(name: string, rows: string[]): Obj {
  return { display_name: name, url: `https://app.cfo.ai/s/${encodeURIComponent(name)}`,
    page: { display_name: 'Tally', url: 'https://app.cfo.ai/s/page-discovered' },
    layout: { rows: rows.map(display_name => ({ display_name })), columns: [{ dimension: 'Date#ea9', grain: 'MONTH' }] } };
}

const toolSchemas: Record<string, Obj> = {
  list_orgs: { type: 'object' },
  inspect_scenarios: { type: 'object' },
  inspect_table_blocks: { type: 'object' },
  edit_table_blocks: { type: 'object' },
  inspect_pages: { type: 'object', required: ['org_id', 'scenario', 'read'], properties: {
    org_id: { type: 'string' }, scenario: { type: 'string' },
    read: { type: 'object', required: ['target', 'include_text'], properties: { target: { type: 'array' }, include_text: { type: 'boolean' } } },
  } },
  edit_pages: { type: 'object', required: ['org_id', 'scenario'], properties: {
    org_id: { type: 'string' }, scenario: { type: 'string' },
    add_text: { type: 'object', required: ['page', 'scenario', 'markdown'], properties: { page: { type: 'string' }, scenario: { type: 'string' }, markdown: { type: 'string' } } },
    update_text: { type: 'object', required: ['target', 'page', 'scenario', 'markdown'], properties: { target: { type: 'string' }, page: { type: 'string' }, scenario: { type: 'string' }, markdown: { type: 'string' } } },
  } },
  edit_memory: { type: 'object', required: ['org_id', 'idempotency_key', 'retain_document'], properties: {
    org_id: { type: 'string' }, idempotency_key: { type: 'string' },
    retain_document: { type: 'object', required: ['content', 'filename', 'scope', 'tags', 'metadata'], properties: {
      content: { type: 'string' }, filename: { type: 'string' }, scope: { const: 'organization' },
      tags: { type: 'array' }, metadata: { type: 'object' },
    } },
  } },
};

class FakeClient implements CfoaiMcpClient {
  calls: { name: string; args: Obj }[] = [];
  blocks: Obj[] = [block('Tally agent budget', budgetRows), block('Tally spend detail', detailRows)];
  pages: Obj[] = [{ display_name: 'Tally', blocks: [] }];
  orgs = [{ org_id: '42', name: 'Workspace one' }];
  scenarios = [{ display_name: 'Main Scenario' }];
  failure?: string;
  refusal?: string;
  receipt = 'applied';
  textOnly = false;
  close = vi.fn(async () => undefined);
  connect = vi.fn(async () => undefined);
  async listTools() {
    return { tools: tools.map(name => ({ name, inputSchema: toolSchemas[name] })) };
  }
  async callTool(name: string, args: Obj) {
    this.calls.push({ name, args });
    if (this.failure === name) throw new Error('fake unavailable');
    let data: Obj;
    if (name === 'list_orgs') data = { orgs: this.orgs };
    else if (name === 'inspect_scenarios') data = { scenarios: this.scenarios };
    else if (name === 'inspect_table_blocks' && args.list) data = { blocks: this.blocks };
    else if (name === 'inspect_table_blocks' && args.read) data = {
      values: { [args.read.rows[0]]: { [args.read.columns[0]]: args.read.rows[0] === 'Agent budget' ? 40 : 7 } },
    };
    else if (name === 'inspect_pages') data = { pages: this.pages };
    else if (name === 'edit_pages') {
      const page = this.pages.find(item => item.display_name === (args.add_text?.page ?? args.update_text?.page));
      if (!page) throw new Error('page missing');
      if (args.add_text) page.blocks.push({ ref: 'tally-guide', markdown: args.add_text.markdown });
      if (args.update_text) {
        const target = page.blocks.find((item: Obj) => item.ref === args.update_text.target);
        if (!target) throw new Error('target missing');
        target.markdown = args.update_text.markdown;
      }
      data = { status: 'applied' };
    } else if (name === 'edit_memory') data = { status: 'applied' };
    else if (name === 'edit_table_blocks') {
      if (this.refusal) return { isError: true, structuredContent: { error: { message: this.refusal }, state_changed: 'no' } };
      const create = args.create;
      if (this.receipt === 'applied') this.blocks.push(block(create.name, create.rows.map((r: Obj) => r.variable)));
      data = { status: this.receipt };
    } else throw new Error(`Unexpected tool ${name}`);
    return this.textOnly ? { content: [{ type: 'text', text: JSON.stringify(data) }] } : { structuredContent: data };
  }
}

function context(confirms: boolean[] = [], selections: (number | null)[] = []): OnboardingContext {
  const config = sampleConfig();
  config.tiers = config.tiers.map((tier, index) => ({ ...tier, name: ['cheap', 'middle', 'top'][index]! }));
  return { config, ui: { print: vi.fn(), confirm: vi.fn(async () => confirms.shift() ?? false),
    select: vi.fn(async () => selections.shift() ?? null) } };
}
function setup(client = new FakeClient(), connected = true) {
  let isConnected = connected;
  const check = vi.fn(async () => ({ status: isConnected ? 'ok' as const : 'missing' as const, detail: 'fake connection' }));
  const login = vi.fn(async () => { isConnected = true; });
  const module = new CfoaiOnboarding({ client: () => client, check, login, now: () => new Date('2026-10-11T00:00:00Z') });
  return { client, module, check, login };
}

describe('cfo.ai onboarding', () => {
  it('checks without browser login or workspace writes', async () => {
    const { module, login, client } = setup();
    expect((await module.check()).status).toBe('ok');
    expect(login).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
  });

  it('discovers a complete config and actual page address for a connected account without writes', async () => {
    const { module, client, login } = setup();
    const ctx = context([false]);
    const result = await module.configure(ctx);
    expect(result.enabled).toBe(true);
    expect(result.budget?.cfoai).toMatchObject({ orgId: '42', scenario: 'Main Scenario',
      pageUrl: 'https://app.cfo.ai/s/page-discovered', table: 'Tally agent budget',
      tierSpendRows: { cheap: 'Tier spend - cheap', middle: 'Tier spend - middle', top: 'Tier spend - top' } });
    expect(client.calls.filter(c => c.name.startsWith('edit'))).toEqual([]);
    expect(login).not.toHaveBeenCalled();
    expect(ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(vi.mocked(ctx.ui.confirm).mock.calls[0]?.[0]).toContain('scenario note');
    expect(ctx.config.budget.source).toBe('config');
    const complete = { ...ctx.config, budget: result.budget, integrations: { ...ctx.config.integrations, cfoai: true } };
    expect(validateConfig(complete)).toMatchObject({ ok: true });
    expect(client.close).toHaveBeenCalled();
  });

  it('opens the existing login only after consent, then configures without asking for IDs', async () => {
    const { module, login } = setup(new FakeClient(), false);
    expect((await module.configure(context([true]))).enabled).toBe(true);
    expect(login).toHaveBeenCalledOnce();
  });

  it('skips login for no account or declined authorization with a local budget', async () => {
    const { module, login, client } = setup(new FakeClient(), false);
    const ctx = context([false]);
    const result = await module.configure(ctx);
    expect(result).toMatchObject({ enabled: false, state: { status: 'off' }, budget: { source: 'config', usd: 40 } });
    expect(login).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
    expect(ctx.ui.print).toHaveBeenCalledWith(expect.stringContaining('https://app.cfo.ai'));
  });

  it('does not fail init when login fails, and never prints the server error', async () => {
    const login = vi.fn(async () => { throw new Error('secret-sensitive server response'); });
    const module = new CfoaiOnboarding({ check: async () => ({ status: 'missing', detail: 'not connected' }), login });
    const ctx = context([true]);
    const result = await module.configure(ctx);
    expect(result.enabled).toBe(false);
    expect(result.budget?.source).toBe('config');
    expect(JSON.stringify(vi.mocked(ctx.ui.print).mock.calls)).not.toContain('secret-sensitive');
  });

  it('lets the user select a workspace and scenario, scoping every later call', async () => {
    const { module, client } = setup();
    client.orgs.push({ org_id: '99', name: 'Workspace two' });
    client.scenarios.push({ display_name: 'Draft' });
    const result = await module.configure(context([], [1, 1]));
    expect(result.budget?.cfoai).toMatchObject({ orgId: '99', scenario: 'Draft' });
    for (const call of client.calls.filter(c => c.name !== 'list_orgs')) expect(call.args.org_id).toBe('99');
  });

  it.each(['workspace', 'scenario'])('permits skipping %s selection', async which => {
    const { module, client } = setup();
    if (which === 'workspace') client.orgs.push({ org_id: '99', name: 'Other' });
    else client.scenarios.push({ display_name: 'Other' });
    expect((await module.configure(context([], [null]))).enabled).toBe(false);
    expect(client.calls.some(c => c.name.startsWith('edit'))).toBe(false);
  });

  it('creates missing tables only after showing the exact proposal and receiving consent', async () => {
    const { module, client } = setup();
    client.blocks = [];
    const ctx = context([true]);
    const result = await module.configure(ctx);
    expect(result.enabled).toBe(true);
    const edits = client.calls.filter(c => c.name === 'edit_table_blocks');
    expect(edits).toHaveLength(2);
    expect(edits[0]!.args.create).toMatchObject({ name: 'Tally agent budget', page: 'Tally', columns: [{ time: 'MONTH' }],
      rows: [{ variable: 'Agent budget', new: true, format: { numberFormat: 'CURRENCY', decimalPlaces: 2 } },
        { variable: 'Agent spend', new: true, format: { numberFormat: 'CURRENCY', decimalPlaces: 2 } },
        { variable: 'Budget remaining', new: true, formula: '`Agent budget` - `Agent spend`', format: { numberFormat: 'CURRENCY', decimalPlaces: 2 } }],
      values: { columns: ['2026-10'], rows: [['Agent budget', 40], ['Agent spend', 0]] } });
    expect(edits[0]!.args.create).not.toHaveProperty('variables');
    expect(JSON.stringify(edits[0]!.args.create.values)).not.toContain('Budget remaining');
    const proposal = vi.mocked(ctx.ui.print).mock.calls.map(([line]) => line).join('\n');
    expect(proposal).toContain('cfo.ai table setup');
    expect(proposal).toContain('Agent budget: $40');
    expect(proposal).toContain('Budget remaining: formula (Agent budget - Agent spend)');
    expect(proposal).toContain('Only missing tables will be created. Existing tables and spend will not be changed.');
    expect(proposal).not.toContain(';');
    // Repeating onboarding reads the tables and preserves spend; no second login or creation.
    client.calls = [];
    expect((await module.configure(context())).enabled).toBe(true);
    expect(client.calls.some(c => c.name.startsWith('edit'))).toBe(false);
  });

  it('enables detailed Ari context only after a separate shared-memory consent', async () => {
    const { module, client } = setup();
    const ctx = context([true]);
    const result = await module.configure(ctx);
    expect(result.enabled).toBe(true);
    expect(result.budget?.cfoai?.publishRunContext).toBe(true);
    const messages = vi.mocked(ctx.ui.print).mock.calls.map(([line]) => line).join('\n');
    expect(messages).toContain('Ari task context (optional)');
    expect(messages).toContain('shared with members of the selected cfo.ai workspace');
    expect(vi.mocked(ctx.ui.confirm).mock.calls[0]?.[0]).toContain('scenario note and share per-attempt reports');
    expect(client.calls.filter(c => c.name === 'edit_pages')).toHaveLength(1);
    expect(client.calls.find(c => c.name === 'edit_memory')).toBeUndefined();
    expect(client.pages[0]?.blocks[0]?.markdown).toContain('same recorded token mix');
  });

  it('updates only its marked scenario guide and skips an identical update on repeat init', async () => {
    const { module, client } = setup();
    client.pages[0]!.blocks.push({ ref: 'tally-guide', markdown: '# Tally Ari context guide (managed by tally-agents)\nold' });
    const first = context([true]);
    expect((await module.configure(first)).budget?.cfoai?.publishRunContext).toBe(true);
    expect(client.calls.filter(c => c.name === 'edit_pages')).toHaveLength(1);
    expect(client.calls.find(c => c.name === 'edit_pages')?.args.update_text.target).toBe('tally-guide');
    client.calls = [];
    expect((await module.configure(context([true]))).budget?.cfoai?.publishRunContext).toBe(true);
    expect(client.calls.filter(c => c.name === 'edit_pages')).toHaveLength(0);
  });

  it('keeps cfo.ai tables usable if scenario-guide setup cannot be verified', async () => {
    const { module, client } = setup();
    client.failure = 'inspect_pages';
    const ctx = context([true]);
    const result = await module.configure(ctx);
    expect(result.enabled).toBe(true);
    expect(result.budget?.cfoai?.publishRunContext).toBeUndefined();
    expect(vi.mocked(ctx.ui.print).mock.calls.map(call => call.join(' ')).join(' ')).toContain('Budget and spend tables remain available');
  });

  it('keeps CFO tables connected while leaving Ari organization memory off by default', async () => {
    const { module } = setup();
    const ctx = context([false]);
    const result = await module.configure(ctx);
    expect(result.enabled).toBe(true);
    expect(result.budget?.cfoai?.publishRunContext).toBeUndefined();
  });

  it('keeps table budgeting available when the server lacks the organization memory tool', async () => {
    const { module, client } = setup();
    client.listTools = async () => ({ tools: tools.filter(name => name !== 'edit_memory').map(name => ({ name, inputSchema: toolSchemas[name] })) });
    const ctx = context();
    const result = await module.configure(ctx);
    expect(result.enabled).toBe(true);
    expect(result.budget?.cfoai?.publishRunContext).toBeUndefined();
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.print).mock.calls.map(call => call.join(' ')).join(' ')).toContain('Ari task context is unavailable');
  });

  it('does not create any table when creation is declined', async () => {
    const { module, client } = setup();
    client.blocks = [];
    expect((await module.configure(context([false]))).enabled).toBe(false);
    expect(client.calls.some(c => c.name.startsWith('edit'))).toBe(false);
  });

  it('creates only the missing table, preserving the existing budget', async () => {
    const { module, client } = setup();
    client.blocks.pop();
    expect((await module.configure(context([true]))).enabled).toBe(true);
    expect(client.calls.filter(c => c.name === 'edit_table_blocks').map(c => c.args.create.name)).toEqual(['Tally spend detail']);
  });

  it('uses actual configured tier names when creating the spend-detail rows', async () => {
    const { module, client } = setup();
    client.blocks = [];
    const ctx = context([true]);
    ctx.config.tiers[0]!.name = 'economy';
    expect((await module.configure(ctx)).budget?.cfoai?.tierSpendRows?.economy).toBe('Tier spend - economy');
  });

  it.each(['list_orgs', 'inspect_scenarios', 'inspect_table_blocks', 'edit_table_blocks'])('falls back safely when %s fails', async name => {
    const { module, client } = setup();
    client.failure = name;
    if (name.startsWith('edit')) client.blocks = [];
    expect((await module.configure(context([true]))).budget?.source).toBe('config');
    expect(client.close).toHaveBeenCalled();
  });

  it('refuses an unapplied receipt and an incompatible live write schema', async () => {
    const { module, client } = setup();
    client.blocks = [];
    client.receipt = 'refused';
    expect((await module.configure(context([true]))).enabled).toBe(false);
    client.calls = [];
    client.listTools = async () => ({ tools: tools.map(name => ({ name, inputSchema: { type: 'object', maxProperties: 0 } })) });
    expect((await module.configure(context([true]))).enabled).toBe(false);
    expect(client.calls.some(c => c.name.startsWith('edit'))).toBe(false);
  });

  it('shows a sanitized cfo.ai create failure and keeps local budgeting', async () => {
    const { module, client } = setup();
    client.blocks = [];
    client.refusal = 'shared property target "Agent budget" was unavailable; Authorization: Bearer cfoai-secret-value';
    const ctx = context([true]);
    const result = await module.configure(ctx);

    expect(result).toMatchObject({ enabled: false, state: { status: 'off' }, budget: { source: 'config' } });
    expect(vi.mocked(ctx.ui.print).mock.calls.join(' ')).toContain('shared property target "Agent budget" was unavailable');
    expect(JSON.stringify(vi.mocked(ctx.ui.print).mock.calls)).not.toContain('cfoai-secret-value');
    expect(JSON.stringify(result)).not.toContain('cfoai-secret-value');
  });

  it.each(['missing rows', 'bad monthly axis', 'untrusted URL', 'duplicate table'])('does not propose a broken configuration for %s', async problem => {
    const { module, client } = setup();
    if (problem === 'missing rows') client.blocks[0]!.layout.rows.pop();
    if (problem === 'bad monthly axis') client.blocks[0]!.layout.columns = [{ time: 'YEAR' }];
    if (problem === 'untrusted URL') client.blocks[0]!.page.url = 'http://app.cfo.ai/page';
    if (problem === 'duplicate table') client.blocks.push(client.blocks[0]!);
    expect((await module.configure(context())).enabled).toBe(false);
    expect(client.calls.some(c => c.name.startsWith('edit'))).toBe(false);
  });

  it('supports JSON text tool results as well as structuredContent', async () => {
    const { module, client } = setup();
    client.textOnly = true;
    expect((await module.configure(context())).enabled).toBe(true);
  });
});
