import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { usdToNanos } from '../schema/money.js';
import { CfoaiBudgetAdapter, checkCfoaiConnection, cfoaiMonthColumn, normalizeCfoaiConfig, type CfoaiMcpClient } from './cfoai.js';

class FakeCfoaiClient implements CfoaiMcpClient {
  connected = 0;
  closed = 0;
  tools = ['inspect_table_blocks', 'edit_table_blocks'];
  calls: { name: string; args: Record<string, unknown> }[] = [];
  values = new Map<string, number>([
    ['Agent budget', 40],
    ['Agent spend', 3],
  ]);
  editStatus = 'applied';

  async connect() {
    this.connected += 1;
  }

  async listTools() {
    return { tools: this.tools.map((name) => ({ name })) };
  }

  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (name === 'inspect_table_blocks') {
      const read = args.read as { rows: string[]; columns: string[] };
      const row = read.rows[0]!;
      return { structuredContent: { values: { [row]: { [read.columns[0]!]: this.values.get(row) ?? 0 } } } };
    }
    if (name === 'edit_table_blocks') {
      const update = args.update as { values: { rows: [string, number][] } };
      const [row, value] = update.values.rows[0]!;
      this.values.set(row, value);
      return { structuredContent: { status: this.editStatus } };
    }
    throw new Error(`unexpected tool ${name}`);
  }

  async close() {
    this.closed += 1;
  }
}

const now = () => new Date('2026-10-10T12:00:00.000Z');

describe('CfoaiBudgetAdapter', () => {
  it('normalizes the documented Tally table defaults', () => {
    expect(
      normalizeCfoaiConfig({
        orgId: '103210',
        scenario: 'Main Scenario',
        tableUrl: 'https://app.cfo.ai/s/p_AQKqpgYkMDBiYzMwNzQtZjA3OS00YjYwLWFlYTctM2FjYzYyMjgxMDQ5DWRlZmF1bHRfbGF5ZXI',
      }),
    ).toMatchObject({
      orgId: '103210',
      scenario: 'Main Scenario',
      table: 'Tally agent budget',
      budgetRow: 'Agent budget',
      spendRow: 'Agent spend',
      remainingRow: 'Budget remaining',
      serverUrl: 'https://api.cfo.ai/mcp',
    });
    expect(cfoaiMonthColumn(now())).toBe('2026-10');
  });

  it('reads the current month budget and remaining spend through inspect_table_blocks', async () => {
    const client = new FakeCfoaiClient();
    const adapter = new CfoaiBudgetAdapter({
      client,
      now,
      config: { orgId: '103210', scenario: 'Main Scenario' },
    });

    await expect(adapter.budgetLimitNanos()).resolves.toBe(usdToNanos(40));
    await expect(adapter.remainingNanos()).resolves.toBe(usdToNanos(37));
    expect(client.calls[0]).toEqual({
      name: 'inspect_table_blocks',
      args: {
        org_id: '103210',
        scenario: 'Main Scenario',
        read: { target: 'Tally agent budget', rows: ['Agent budget'], columns: ['2026-10'] },
      },
    });
    expect(adapter.status()).toEqual({ status: 'ok', detail: null });
  });

  it('writes cumulative real spend with edit_table_blocks and verifies the read-back value', async () => {
    const client = new FakeCfoaiClient();
    const adapter = new CfoaiBudgetAdapter({ client, now, config: { orgId: '103210', scenario: 'Main Scenario' } });

    await adapter.writeCumulativeActualSpend(usdToNanos(2.25));
    await adapter.writeCumulativeActualSpend(usdToNanos(4));

    const edits = client.calls.filter((call) => call.name === 'edit_table_blocks');
    expect(edits.map((call) => call.args)).toEqual([
      {
        org_id: '103210',
        scenario: 'Main Scenario',
        update: { target: 'Tally agent budget', values: { columns: ['2026-10'], rows: [['Agent spend', 5.25]] } },
      },
      {
        org_id: '103210',
        scenario: 'Main Scenario',
        update: { target: 'Tally agent budget', values: { columns: ['2026-10'], rows: [['Agent spend', 7]] } },
      },
    ]);
  });

  it('reports missing when the MCP connection or tools are unavailable', async () => {
    const client = new FakeCfoaiClient();
    client.tools = ['inspect_table_blocks'];
    const adapter = new CfoaiBudgetAdapter({ client, now });

    await expect(adapter.budgetLimitNanos()).rejects.toThrow(/edit_table_blocks/);
    expect(adapter.status()).toEqual({
      status: 'missing',
      detail: 'cfo.ai MCP tool edit_table_blocks is missing. Run `tally login cfoai` to connect cfo.ai.',
    });
  });

  it('rejects a write when cfo.ai does not apply the update', async () => {
    const client = new FakeCfoaiClient();
    client.editStatus = 'queued';
    const adapter = new CfoaiBudgetAdapter({ client, now });

    await expect(adapter.writeCumulativeActualSpend(usdToNanos(1))).rejects.toThrow(/did not apply/);
  });
});

describe('checkCfoaiConnection', () => {
  it('uses Tally cached tokens and the cfo.ai MCP server, not another tool MCP list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-cfoai-token-'));
    const tokenPath = join(dir, 'cfoai-oauth.json');
    writeFileSync(tokenPath, JSON.stringify({ tokens: { access_token: 'redacted', token_type: 'Bearer' } }));
    const client = new FakeCfoaiClient();

    await expect(checkCfoaiConnection({ tokenPath, client })).resolves.toEqual({
      status: 'ok',
      detail: 'Tally cached token works against https://api.cfo.ai/mcp',
    });
    expect(client.connected).toBe(1);
  });

  it('is missing when Tally has no cached cfo.ai token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-cfoai-token-'));
    await expect(checkCfoaiConnection({ tokenPath: join(dir, 'missing.json') })).resolves.toEqual({
      status: 'missing',
      detail: 'Tally has no cached cfo.ai token. Run `tally login cfoai` to connect cfo.ai.',
    });
  });
});
