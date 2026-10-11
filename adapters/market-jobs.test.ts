import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildJobQuery, qualifyJobs } from './market-jobs.js';
import { runCrustDataMarketSearch } from './crustdata.js';
const job = (description = 'Use Claude Code and GitHub Copilot to build software.', domain = 'acme.example') => ({
  crustdata_job_id: 1, job_details: { title: 'Software Engineer', category: 'Engineering', url: 'https://example.org/jobs/1' },
  company: { basic_info: { name: 'Acme', primary_domain: domain, crustdata_company_id: 5 } },
  content: { description }, metadata: { date_added: '2026-10-01' },
});
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'x-credits-used': '0.06' } });
describe('job-qualified prospects', () => {
  it('keeps explicit evidence, drops ambiguous mentions and groups companies', () => {
    const q = qualifyJobs([job(), { ...job(), crustdata_job_id: 2 }, job('Move the cursor over the form'), job('Codex is a legal manuscript'),
      job('Use AI coding tools such as Cursor'), { ...job(), job_details: { title: 'Engineer', category: 'Engineering', url: 'javascript:alert(1)' } }]);
    expect(q).toMatchObject({ discardedCount: 3, duplicates: 2 });
    expect(q.companies).toHaveLength(1);
    expect(q.companies[0]?.label).toBe('hiring intent');
    expect(q.companies[0]?.jobEvidence).toHaveLength(3);
  });
  it('has a bounded engineering/exact-phrase query without premium company filters', () => {
    const q = buildJobQuery(25, new Date('2026-10-11'));
    expect(JSON.stringify(q)).toContain('content.description');
    expect(JSON.stringify(q)).not.toContain('headcount');
    expect(q.limit).toBe(25);
  });
  it('checks price, searches once and replays without credentials/network', async () => {
    let calls = 0;
    const result = await runCrustDataMarketSearch({ jobs: true, limit: 2, outputDir: mkdtempSync(join(tmpdir(), 'tally-jobs-')),
      env: { CRUSTDATA_API_KEY: 'secret' }, fetch: async input => { calls++; return response(String(input).includes('/account/') ?
        { endpoints: [{ path: '/job/search', status: 'enabled', base_credits: 0.03 }] } : { job_listings: [job(), { ...job(), crustdata_job_id: 2 }], total_count: 40 }); } });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ estimatedMaxCredits: 0.06, totalCount: 40, jobSearch: { returnedCount: 2, duplicates: 1 } });
    expect(readFileSync(result.reportPath, 'utf8')).toContain('Software Engineer');
    const replay = await runCrustDataMarketSearch({ replay: result.queryPath, outputDir: mkdtempSync(join(tmpdir(), 'tally-job-replay-')), env: {}, fetch: async () => { throw new Error('network forbidden'); } });
    expect(replay.companies).toEqual(result.companies);
    expect(replay.jobSearch).toEqual(result.jobSearch);
  });
  it('embeds a cached secondary table without refreshing it', async () => {
    const fetch: typeof globalThis.fetch = async input => response(String(input).includes('/account/') ?
      { endpoints: [{ path: '/company/search', status: 'enabled', base_credits: 0.03, premium_filters: [], premium_fields: [] }] } :
      { companies: [{ crustdata_company_id: 5, basic_info: { name: 'Firmographic only' } }], total_count: 9 });
    const secondary = await runCrustDataMarketSearch({ outputDir: mkdtempSync(join(tmpdir(), 'tally-secondary-')), env: { CRUSTDATA_API_KEY: 'secret' }, fetch });
    let calls = 0;
    const result = await runCrustDataMarketSearch({ jobs: true, secondary: secondary.queryPath,
      outputDir: mkdtempSync(join(tmpdir(), 'tally-combined-')), env: { CRUSTDATA_API_KEY: 'secret' }, fetch: async input => {
        calls++; expect(String(input)).not.toContain('/company/search');
        return response(String(input).includes('/account/') ? { endpoints: [{ path: '/job/search', status: 'enabled', base_credits: 0.03 }] } : { job_listings: [], total_count: 0 });
      } });
    expect(calls).toBe(2);
    expect(readFileSync(result.reportPath, 'utf8')).toContain('No usable coding-tool hiring evidence');
    expect(result.secondary?.companies[0]?.name).toBe('Firmographic only');
    const replay = await runCrustDataMarketSearch({ replay: result.queryPath, outputDir: mkdtempSync(join(tmpdir(), 'tally-combined-replay-')), fetch: async () => { throw new Error('network forbidden'); } });
    expect(replay.secondary?.queryHash).toBe(secondary.queryHash);
  });
  it('refuses the job estimate above cap before paid search', async () => {
    let calls = 0;
    await expect(runCrustDataMarketSearch({ jobs: true, maxCredits: 0.1, env: { CRUSTDATA_API_KEY: 'secret' }, fetch: async () => {
      calls++; return response({ endpoints: [{ path: '/job/search', status: 'enabled', base_credits: 0.03 }] });
    } })).rejects.toThrow(/exceeds cap/);
    expect(calls).toBe(1);
  });
});
