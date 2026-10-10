import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodingAgentsMarketQuery, CrustDataError, runCrustDataMarketSearch } from './crustdata.js';

function response(body: unknown, ok = true, headers: Record<string, string> = {}): Response {
  return { ok, status: ok ? 200 : 400, headers: new Headers(headers), json: async () => body } as Response;
}

describe('buildCodingAgentsMarketQuery', () => {
  it('builds a rerunnable company search payload for coding-agent terminology', () => {
    expect(buildCodingAgentsMarketQuery({ keyword: 'GitHub Copilot', limit: 3, minHeadcount: 25 })).toMatchObject({
      filters: {
        op: 'and',
        conditions: [
          { field: 'basic_info.description', type: 'contains', value: 'GitHub Copilot' },
          { field: 'headcount.total', type: '=>', value: 25 },
        ],
      },
      limit: 3,
    });
  });
});

describe('runCrustDataMarketSearch', () => {
  it('writes the exact query and summarized company list', async () => {
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const outputDir = mkdtempSync(join(tmpdir(), 'tally-market-'));
    const result = await runCrustDataMarketSearch({
      outputDir,
      limit: 2,
      env: { CRUSTDATA_API_KEY: 'secret' },
      fetch: async (input, init) => {
        calls.push({
          url: `${input}`,
          body: JSON.parse(`${init?.body}`),
          authorization: (init?.headers as Record<string, string>).authorization ?? null,
        });
        return response(
          {
            total_count: 12,
            next_cursor: 'cursor',
            companies: [
              {
                crustdata_company_id: 123,
                basic_info: {
                  name: 'DevTools Co',
                  primary_domain: 'devtools.example',
                  description: 'Engineering teams use GitHub Copilot and coding agents here.',
                },
                headcount: { total: 144 },
                taxonomy: { professional_network_industry: 'Software Development' },
              },
            ],
          },
          true,
          { 'x-credit-cost': '0.53' },
        );
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.crustdata.com/company/search');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    expect(result).toMatchObject({ totalCount: 12, nextCursor: true, creditCost: '0.53' });
    expect(JSON.parse(readFileSync(result.queryPath, 'utf8'))).toMatchObject({ payload: { limit: 2 } });
    expect(JSON.parse(readFileSync(result.companiesPath, 'utf8')).companies).toEqual([
      {
        id: 123,
        name: 'DevTools Co',
        domain: 'devtools.example',
        description: 'Engineering teams use GitHub Copilot and coding agents here.',
        headcount: 144,
        industry: 'Software Development',
        evidenceTerms: ['coding agent', 'GitHub Copilot'],
      },
    ]);
  });

  it('requires a CrustData key without printing one', async () => {
    await expect(runCrustDataMarketSearch({ env: {}, fetch: async () => response({}) })).rejects.toThrow(CrustDataError);
  });

  it('reports non-secret API validation errors', async () => {
    await expect(
      runCrustDataMarketSearch({
        env: { CRUSTDATA_API_KEY: 'secret' },
        fetch: async () => response({ error: { message: 'Unsupported columns in conditions' } }, false),
      }),
    ).rejects.toThrow(/Unsupported columns/);
  });
});
