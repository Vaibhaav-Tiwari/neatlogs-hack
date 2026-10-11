import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../engine/env.js';
import { CrustDataError, type MarketCompany, type MarketSearchOptions, type MarketSearchResult } from './crustdata.js';
import { estimateMarketCredits, writeMarketReport } from './market-report.js';

const ENDPOINT = 'https://api.crustdata.com/job/search';
const VERSION = '2025-11-01';
const rec = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null ? v as Record<string, unknown> : {};
const str = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
export function buildJobQuery(limit = 25, now = new Date()): Record<string, unknown> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CrustDataError('Job limit must be 1 to 100');
  const since = new Date(now.getTime() - 90 * 86400000).toISOString();
  return { filters: { op: 'and', conditions: [
    { field: 'job_details.category', type: '=', value: 'Engineering' },
    { field: 'metadata.date_added', type: '=>', value: since },
    { op: 'or', conditions: ['Claude Code', 'Cursor', 'GitHub Copilot', 'Codex', 'AI coding agent'].map(value => ({ field: 'content.description', type: '[.]', value })) },
  ] }, fields: ['crustdata_job_id', 'job_details.title', 'job_details.category', 'job_details.url', 'content.description',
    'company.basic_info.crustdata_company_id', 'company.basic_info.name', 'company.basic_info.primary_domain', 'metadata.date_added'],
    sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit };
}

export function qualifyJobs(rows: unknown[]): { companies: MarketCompany[]; discardedCount: number; duplicates: number } {
  const companies: MarketCompany[] = [], keys = new Map<string, MarketCompany>();
  let discardedCount = 0, duplicates = 0;
  for (const value of rows) {
    const r = rec(value), details = rec(r.job_details), basic = rec(rec(r.company).basic_info);
    const description = str(rec(r.content).description).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const terms: string[] = [];
    const patterns: Array<[string, RegExp]> = [
      ['Claude Code', /\bClaude Code\b/i], ['GitHub Copilot', /\bGitHub Copilot\b/i], ['AI coding agent', /\bAI coding agents?\b/i],
      ['Cursor', /\b(?:AI|coding|IDE|assistant|developer tools)\b.{0,60}\bCursor\b|\bCursor\b.{0,60}\b(?:AI|coding|IDE|assistant|developer tools)\b/i],
      ['Codex', /\b(?:OpenAI|AI|coding|assistant)\b.{0,60}\bCodex\b|\bCodex\b.{0,60}\b(?:OpenAI|AI|coding|assistant)\b/i],
    ];
    let offset = -1;
    for (const [term, pattern] of patterns) { const m = pattern.exec(description); if (m) { terms.push(term); if (offset < 0) offset = m.index; } }
    let source: URL | undefined;
    try { source = new URL(str(details.url)); } catch { /* Incomplete evidence is discarded. */ }
    const date = str(rec(r.metadata).date_added), name = str(basic.name), title = str(details.title);
    const id = r.crustdata_job_id;
    if (details.category !== 'Engineering' || !terms.length || !name || !title || !source || !['https:', 'http:'].includes(source.protocol) ||
      source.username || source.password || !date || !Number.isFinite(Date.parse(date)) || !(typeof id === 'string' || typeof id === 'number')) {
      discardedCount++; continue;
    }
    const companyId = basic.crustdata_company_id;
    const domain = str(basic.primary_domain).toLowerCase().replace(/^www\./, '');
    const key = domain || (typeof companyId === 'string' || typeof companyId === 'number' ? `id:${companyId}` : '');
    if (!key) { discardedCount++; continue; }
    const excerpt = description.slice(Math.max(0, offset - 100), offset + 300);
    const evidence = { id, title, url: source.href, date, terms, excerpt };
    const existing = keys.get(key);
    if (existing) { duplicates++; existing.jobEvidence!.push(evidence); existing.evidenceTerms = [...new Set([...existing.evidenceTerms, ...terms])]; continue; }
    const company: MarketCompany = { id: typeof companyId === 'string' || typeof companyId === 'number' ? companyId : domain,
      name, domain: domain || null, description: null, headcount: null, industry: null, evidenceTerms: terms,
      sourceUrl: source.href, sourceDate: date, label: 'hiring intent', review: null, jobEvidence: [evidence] };
    keys.set(key, company); companies.push(company);
  }
  return { companies, discardedCount, duplicates };
}

export async function runJobMarket(options: MarketSearchOptions): Promise<MarketSearchResult> {
  if (options.keyword || options.review || options.minHeadcount !== undefined) throw new CrustDataError('Job mode uses its explicit engineering/tool query; omit keyword, review and headcount');
  const payload = buildJobQuery(options.limit ?? 25), cap = options.maxCredits ?? 10;
  if (!Number.isFinite(cap) || cap <= 0) throw new CrustDataError('Maximum credits must be positive');
  const key = (options.env ?? loadEnv()).CRUSTDATA_API_KEY;
  if (!key) throw new CrustDataError('CRUSTDATA_API_KEY is missing from ~/.tally/.env');
  const request = options.fetch ?? fetch, headers = { authorization: `Bearer ${key}`, 'x-api-version': VERSION, 'content-type': 'application/json' };
  const priceResponse = await request('https://api.crustdata.com/account/endpoints?path=/job/search', { headers });
  if (!priceResponse.ok) throw new CrustDataError(`Cannot check job pricing: HTTP ${priceResponse.status}`);
  const endpoints = rec(await priceResponse.json()).endpoints;
  const endpoint = rec(Array.isArray(endpoints) ? endpoints.find(e => rec(e).path === '/job/search') : undefined);
  // Job Search may omit empty premium arrays. Unknown nonempty premium pricing still bills conservatively.
  const estimatedMaxCredits = estimateMarketCredits(payload, { ...endpoint, premium_filters: endpoint.premium_filters ?? [], premium_fields: endpoint.premium_fields ?? [] });
  options.onEstimate?.(estimatedMaxCredits);
  if (estimatedMaxCredits > cap) throw new CrustDataError(`Estimated maximum ${estimatedMaxCredits} credits exceeds cap ${cap}`);
  const outputDir = resolve(options.outputDir ?? '.tally/market/latest'), queryHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const result: MarketSearchResult = { outputDir, queryPath: resolve(outputDir, 'query.json'), companiesPath: resolve(outputDir, 'companies.json'),
    csvPath: resolve(outputDir, 'companies.csv'), reportPath: resolve(outputDir, 'report.md'), retrievedAt: new Date().toISOString(),
    queryHash, estimatedMaxCredits, replayed: false, companies: [], totalCount: null, nextCursor: false, creditCost: '0' };
  if (options.plan) return result;
  const response = await request(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(payload) });
  result.creditCost = response.headers.get('x-credits-used') ?? response.headers.get('x-credit-cost');
  if (!response.ok) throw new CrustDataError(`Job Search failed: HTTP ${response.status}; credits: ${result.creditCost ?? 'unknown'}`);
  const body = rec(await response.json());
  if (!Array.isArray(body.job_listings)) throw new CrustDataError('Job Search returned no job_listings array');
  const qualified = qualifyJobs(body.job_listings);
  result.companies = qualified.companies;
  result.totalCount = typeof body.total_count === 'number' && Number.isFinite(body.total_count) ? body.total_count : null;
  result.nextCursor = Boolean(body.next_cursor);
  result.jobSearch = { returnedCount: body.job_listings.length, discardedCount: qualified.discardedCount, duplicates: qualified.duplicates };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(result.queryPath, `${JSON.stringify({ endpoint: ENDPOINT, method: 'POST', apiVersion: VERSION, payload, queryHash, maxCredits: cap, estimatedMaxCredits }, null, 2)}\n`);
  writeFileSync(result.companiesPath, `${JSON.stringify({ ...result, apiVersion: VERSION, returnedCount: result.companies.length }, null, 2)}\n`);
  writeMarketReport(result);
  return result;
}
