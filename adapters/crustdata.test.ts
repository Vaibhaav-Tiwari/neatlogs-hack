import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodingAgentsMarketQuery, CrustDataError, runCrustDataMarketSearch } from './crustdata.js';
import { estimateMarketCredits } from './market-report.js';

const pricing = { path: '/company/search', status: 'enabled', base_credits: 0.03,
  premium_filters: [{ field: 'headcount', credits: 0.2 }, { field: 'taxonomy', credits: 0.1 }],
  premium_fields: [{ field: 'headcount', credits: 0.2 }, { field: 'taxonomy', credits: 0.1 }] };
const prices = () => response({ endpoints: [pricing] });

function response(body: unknown, ok = true, headers: Record<string, string> = {}): Response {
  return { ok, status: ok ? 200 : 400, headers: new Headers(headers), json: async () => body } as Response;
}

describe('buildCodingAgentsMarketQuery', () => {
  it('builds a rerunnable company search payload for coding-agent terminology', () => {
    expect(buildCodingAgentsMarketQuery({ keyword: 'GitHub Copilot', limit: 3, minHeadcount: 25 })).toMatchObject({
      filters: {
        op: 'and',
        conditions: [
          { field: 'headcount.total', type: '=>', value: 25 },
          { field: 'headcount.total', type: '=<', value: 500 },
          { field: 'taxonomy.professional_network_industry', type: '=', value: 'Software Development' },
          { field: 'basic_info.description', type: '[.]', value: 'GitHub Copilot' },
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
        if (String(input).includes('/account/')) return prices();
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
      expect.objectContaining({
        id: 123,
        name: 'DevTools Co',
        domain: 'devtools.example',
        description: 'Engineering teams use GitHub Copilot and coding agents here.',
        headcount: 144,
        industry: 'Software Development',
        evidenceTerms: ['coding agent', 'GitHub Copilot'],
        label: 'candidate', review: null,
      }),
    ]);
    expect(result.estimatedMaxCredits).toBe(1.26);
    expect(JSON.parse(readFileSync(result.companiesPath, 'utf8'))).toMatchObject({ returnedCount: 1, apiVersion: '2025-11-01', retrievedAt: result.retrievedAt, queryHash: result.queryHash });
    expect(readFileSync(result.reportPath, 'utf8')).toContain('not adoption or market size');
    expect(readFileSync(result.csvPath, 'utf8')).toContain('candidate');
    const noNetwork = async (): Promise<Response> => { throw new Error('replay made a network call'); };
    const replayed = await runCrustDataMarketSearch({ replay: result.queryPath, outputDir: mkdtempSync(join(tmpdir(), 'tally-replay-')), env: {}, fetch: noNetwork });
    expect(replayed).toMatchObject({ replayed: true, retrievedAt: result.retrievedAt, creditCost: '0.53', companies: result.companies });
    const reviews = join(outputDir, 'reviews.json');
    writeFileSync(reviews, JSON.stringify([{ id: 123, label: 'vendor', reason: 'Tool supplier, not established buyer', sourceUrl: 'https://example.org/profile', sourceDate: null }]));
    const reviewed = await runCrustDataMarketSearch({ replay: result.queryPath, review: reviews, outputDir: mkdtempSync(join(tmpdir(), 'tally-reviewed-')), fetch: noNetwork });
    expect(reviewed.companies[0]?.label).toBe('vendor');
    writeFileSync(reviews, JSON.stringify([{ id: 123, label: 'verified use', reason: 'guess', sourceUrl: 'https://example.org', sourceDate: null }]));
    await expect(runCrustDataMarketSearch({ replay: result.queryPath, review: reviews, fetch: noNetwork })).rejects.toThrow(/excerpt/);
    await expect(runCrustDataMarketSearch({ replay: result.queryPath, limit: 2, fetch: noNetwork })).rejects.toThrow(/omit/);
    const query = JSON.parse(readFileSync(result.queryPath, 'utf8'));
    writeFileSync(result.queryPath, JSON.stringify({ ...query, payload: { ...query.payload, limit: 99 } }));
    await expect(runCrustDataMarketSearch({ replay: result.queryPath, fetch: noNetwork })).rejects.toThrow(/do not match/);
  });

  it('requires a CrustData key without printing one', async () => {
    await expect(runCrustDataMarketSearch({ env: {}, fetch: async () => response({}) })).rejects.toThrow(CrustDataError);
  });

  it('reports status without echoing an untrusted API error containing a key', async () => {
    await expect(
      runCrustDataMarketSearch({
        env: { CRUSTDATA_API_KEY: 'secret' },
        fetch: async input => String(input).includes('/account/') ? prices() : response({ error: { message: 'secret' } }, false),
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it('refuses over-cap estimates before any paid call', async () => {
    const calls: string[] = [];
    await expect(runCrustDataMarketSearch({ limit: 10, maxCredits: 6, env: { CRUSTDATA_API_KEY: 'secret' }, fetch: async input => { calls.push(String(input)); return prices(); } })).rejects.toThrow(/exceeds cap/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/account/endpoints');
  });
  it('plans with free pricing only, and validates limits without network', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return prices(); };
    expect(await runCrustDataMarketSearch({ plan: true, env: { CRUSTDATA_API_KEY: 'secret' }, fetch })).toMatchObject({ estimatedMaxCredits: 6.3, companies: [] });
    expect(calls).toBe(1);
    await expect(runCrustDataMarketSearch({ limit: 101, fetch })).rejects.toThrow(/limit/);
    expect(calls).toBe(1);
  });
  it('requires complete enabled account prices', () => {
    expect(() => estimateMarketCredits(buildCodingAgentsMarketQuery(), {})).toThrow(/pricing/);
    expect(() => estimateMarketCredits(buildCodingAgentsMarketQuery(), { ...pricing, premium_fields: undefined })).toThrow(/Incomplete/);
    expect(() => estimateMarketCredits(buildCodingAgentsMarketQuery(), { ...pricing, status: 'disabled' })).toThrow(/unavailable/);
  });
  it('requests the real metadata timestamp field', () => {
    expect(buildCodingAgentsMarketQuery().fields).toContain('metadata.updated_at');
  });
  it('preserves unknown totals and protects CSV/Markdown against hostile cells', async () => {
    const result = await runCrustDataMarketSearch({ outputDir: mkdtempSync(join(tmpdir(), 'tally-safe-')), limit: 1,
      env: { CRUSTDATA_API_KEY: 'secret' }, fetch: async input => String(input).includes('/account/') ? prices() : response({ total_count: null,
        companies: [{ crustdata_company_id: 'x', basic_info: { name: '=SUM(1,2)|<script>', description: '"quoted"' }, metadata: { updated_at: '2026-10-11' } }] }, true,
        { 'x-credit-cost': '99', 'x-credits-used': '0.63' }) });
    expect(result).toMatchObject({ totalCount: null, creditCost: '0.63' });
    expect(readFileSync(result.csvPath, 'utf8')).toContain('"\'=SUM(1,2)|<script>"');
    expect(readFileSync(result.reportPath, 'utf8')).toContain('\\|\\<script\\>');
  });
  it('does not claim an empty successful response is a real sample', async () => {
    await expect(runCrustDataMarketSearch({ env: { CRUSTDATA_API_KEY: 'secret' }, fetch: async input => String(input).includes('/account/') ? prices() : response({}) })).rejects.toThrow(/companies array/);
  });
});
