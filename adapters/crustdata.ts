import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { estimateMarketCredits, writeMarketReport, applyMarketReviews, type MarketReview } from './market-report.js';
import { loadEnv } from '../engine/env.js';
import { runJobMarket } from './market-jobs.js';

const ENDPOINT = 'https://api.crustdata.com/company/search';
const API_VERSION = '2025-11-01';

export interface MarketSearchOptions {
  outputDir?: string;
  limit?: number;
  keyword?: string;
  minHeadcount?: number;
  env?: Record<string, string>;
  fetch?: typeof fetch;
  maxCredits?: number;
  replay?: string;
  review?: string;
  plan?: boolean;
  onEstimate?: (credits: number) => void;
  jobs?: boolean;
  secondary?: string;
}

export interface MarketCompany {
  id: number | string | null;
  name: string | null;
  domain: string | null;
  description: string | null;
  headcount: number | null;
  industry: string | null;
  evidenceTerms: string[];
  sourceUrl: string | null;
  sourceDate: string | null;
  label: 'candidate' | 'vendor' | 'hiring intent' | 'verified use' | 'rejected';
  review: MarketReview | null;
  jobEvidence?: Array<{ id: string | number; title: string; url: string; date: string; terms: string[]; excerpt: string }>;
}

export interface MarketSearchResult {
  outputDir: string;
  queryPath: string;
  companiesPath: string;
  totalCount: number | null;
  nextCursor: boolean;
  companies: MarketCompany[];
  creditCost: string | null;
  estimatedMaxCredits: number;
  retrievedAt: string;
  queryHash: string;
  replayed: boolean;
  csvPath: string;
  reportPath: string;
  jobSearch?: { returnedCount: number; discardedCount: number; duplicates: number };
  secondary?: MarketSearchResult;
}

export class CrustDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrustDataError';
  }
}

const DEFAULT_TERMS = ['AI coding', 'coding agent', 'coding assistant', 'GitHub Copilot', 'Cursor', 'Codex', 'agentic coding'];

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function buildCodingAgentsMarketQuery(options: Pick<MarketSearchOptions, 'keyword' | 'limit' | 'minHeadcount'> = {}): Record<string, unknown> {
  const limit = options.limit ?? 10;
  const min = options.minHeadcount ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CrustDataError('Market limit must be 1 to 100');
  if (!Number.isInteger(min) || min < 1 || min > 500) throw new CrustDataError('Minimum headcount must be 1 to 500');
  if (options.keyword !== undefined && !options.keyword.trim()) throw new CrustDataError('Market keyword cannot be empty');
  return {
    filters: {
      op: 'and',
      conditions: [
        { field: 'headcount.total', type: '=>', value: min },
        { field: 'headcount.total', type: '=<', value: 500 },
        { field: 'taxonomy.professional_network_industry', type: '=', value: 'Software Development' },
        ...(options.keyword ? [{ field: 'basic_info.description', type: '[.]', value: options.keyword }] : []),
      ],
    },
    fields: [
      'crustdata_company_id',
      'basic_info.name',
      'basic_info.primary_domain',
      'basic_info.description',
      'headcount.total',
      'basic_info.professional_network_url',
      'taxonomy.professional_network_industry',
      'metadata.updated_at',
    ],
    limit,
  };
}

function evidenceTerms(company: Record<string, unknown>): string[] {
  const basic = recordValue(company.basic_info);
  const haystack = `${stringValue(basic.name) ?? ''}\n${stringValue(basic.description) ?? ''}`.toLowerCase();
  return DEFAULT_TERMS.filter((term) => haystack.includes(term.toLowerCase()));
}

function summarizeCompany(company: unknown): MarketCompany {
  const record = recordValue(company);
  const basic = recordValue(record.basic_info);
  const headcount = recordValue(record.headcount);
  const taxonomy = recordValue(record.taxonomy);
  return {
    id: stringValue(record.crustdata_company_id) ?? numberValue(record.crustdata_company_id),
    name: stringValue(basic.name),
    domain: stringValue(basic.primary_domain),
    description: stringValue(basic.description),
    headcount: numberValue(headcount.total),
    industry: stringValue(taxonomy.professional_network_industry),
    evidenceTerms: evidenceTerms(record),
    sourceUrl: stringValue(basic.professional_network_url),
    sourceDate: stringValue(recordValue(record.metadata).updated_at),
    label: 'candidate',
    review: null,
  };
}

export async function runCrustDataMarketSearch(options: MarketSearchOptions = {}): Promise<MarketSearchResult> {
  if (options.replay) return replayMarket(options);
  if (options.jobs) {
    const secondary = options.secondary ? replayMarket({ replay: options.secondary }, false) : undefined;
    const result = await runJobMarket(options);
    if (secondary && !options.plan) {
      result.secondary = secondary;
      const saved = JSON.parse(readFileSync(result.companiesPath, 'utf8'));
      writeFileSync(result.companiesPath, `${JSON.stringify({ ...saved, secondary }, null, 2)}\n`);
      writeMarketReport(result);
    }
    return result;
  }
  if (options.secondary) throw new CrustDataError('--secondary is for --jobs or cached job replay');
  if (options.review) throw new CrustDataError('Apply reviews to a cached snapshot with --replay');
  const payload = buildCodingAgentsMarketQuery(options);
  const maxCredits = options.maxCredits ?? 10;
  if (!Number.isFinite(maxCredits) || maxCredits <= 0) throw new CrustDataError('Maximum credits must be positive');
  const env = options.env ?? loadEnv();
  const apiKey = env.CRUSTDATA_API_KEY;
  if (!apiKey) throw new CrustDataError('CRUSTDATA_API_KEY is missing from ~/.tally/.env');

  const request = options.fetch ?? fetch;
  const pricing = await request('https://api.crustdata.com/account/endpoints?path=/company/search', {
    headers: { authorization: `Bearer ${apiKey}`, 'x-api-version': API_VERSION },
  });
  if (!pricing.ok) throw new CrustDataError(`Cannot check account pricing: HTTP ${pricing.status}`);
  const endpoints = recordValue(await pricing.json()).endpoints;
  const endpoint = Array.isArray(endpoints) ? endpoints.find(e => recordValue(e).path === '/company/search') : undefined;
  const estimatedMaxCredits = estimateMarketCredits(payload, recordValue(endpoint));
  options.onEstimate?.(estimatedMaxCredits);
  if (estimatedMaxCredits > maxCredits) throw new CrustDataError(`Estimated maximum ${estimatedMaxCredits} credits exceeds cap ${maxCredits}; lower --limit`);
  const retrievedAt = new Date().toISOString();
  const queryHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const outputDir = resolve(options.outputDir ?? '.tally/market/latest');
  const paths = { outputDir, queryPath: resolve(outputDir, 'query.json'), companiesPath: resolve(outputDir, 'companies.json'),
    csvPath: resolve(outputDir, 'companies.csv'), reportPath: resolve(outputDir, 'report.md') };
  if (options.plan) return { ...paths, retrievedAt, queryHash, estimatedMaxCredits, replayed: false, companies: [], totalCount: null, nextCursor: false, creditCost: '0' };
  const response = await request(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-api-version': API_VERSION,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new CrustDataError(`CrustData company search failed: HTTP ${response.status}; credits: ${response.headers.get('x-credits-used') ?? response.headers.get('x-credit-cost') ?? 'unknown'}`);
  }

  const bodyRecord = recordValue(body);
  if (!Array.isArray(bodyRecord.companies)) throw new CrustDataError('Company Search returned no companies array');
  const companies = bodyRecord.companies.map(summarizeCompany);
  mkdirSync(outputDir, { recursive: true });
  const queryPath = resolve(outputDir, 'query.json');
  const companiesPath = resolve(outputDir, 'companies.json');
  const creditCost = response.headers.get('x-credits-used') ?? response.headers.get('x-credit-cost');

  writeFileSync(
    queryPath,
    `${JSON.stringify(
      {
        endpoint: ENDPOINT,
        method: 'POST',
        apiVersion: API_VERSION,
        queryHash,
        payload,
        maxCredits,
        estimatedMaxCredits,
        pricing: { baseCredits: recordValue(endpoint).base_credits, premiumFilters: recordValue(endpoint).premium_filters, premiumFields: recordValue(endpoint).premium_fields },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    companiesPath,
    `${JSON.stringify(
      {
        totalCount: numberValue(bodyRecord.total_count),
        nextCursor: Boolean(bodyRecord.next_cursor),
        creditCost,
        apiVersion: API_VERSION,
        retrievedAt,
        queryHash,
        returnedCount: companies.length,
        estimatedMaxCredits,
        companies,
      },
      null,
      2,
    )}\n`,
  );

  const result: MarketSearchResult = {
    outputDir,
    queryPath,
    companiesPath,
    totalCount: numberValue(bodyRecord.total_count),
    nextCursor: Boolean(bodyRecord.next_cursor),
    companies,
    creditCost,
    csvPath: paths.csvPath,
    reportPath: paths.reportPath,
    estimatedMaxCredits,
    retrievedAt,
    queryHash,
    replayed: false,
  };
  writeMarketReport(result);
  return result;
}

function replayMarket(options: MarketSearchOptions, write = true): MarketSearchResult {
  if (options.limit !== undefined || options.keyword !== undefined || options.plan) throw new CrustDataError('Replay uses the saved query; omit limit, keyword and plan');
  let query: Record<string, unknown>, saved: Record<string, unknown>;
  try {
    query = recordValue(JSON.parse(readFileSync(options.replay!, 'utf8')));
    saved = recordValue(JSON.parse(readFileSync(resolve(dirname(options.replay!), 'companies.json'), 'utf8')));
  } catch { throw new CrustDataError('Cannot read saved query and companies.json'); }
  const queryHash = createHash('sha256').update(JSON.stringify(query.payload) ?? '').digest('hex');
  if (![ENDPOINT, 'https://api.crustdata.com/job/search'].includes(String(query.endpoint)) || query.method !== 'POST' || query.apiVersion !== API_VERSION || query.queryHash !== queryHash || saved.queryHash !== queryHash || saved.apiVersion !== API_VERSION ||
    !Array.isArray(saved.companies) || typeof saved.retrievedAt !== 'string' || !Number.isFinite(Date.parse(saved.retrievedAt)) ||
    typeof saved.estimatedMaxCredits !== 'number' || !Number.isFinite(saved.estimatedMaxCredits) || saved.estimatedMaxCredits < 0 || saved.returnedCount !== saved.companies.length) {
    throw new CrustDataError('Saved query and snapshot are invalid or do not match');
  }
  const outputDir = resolve(options.outputDir ?? '.tally/market/latest');
  const result: MarketSearchResult = { outputDir, queryPath: resolve(outputDir, 'query.json'), companiesPath: resolve(outputDir, 'companies.json'),
    csvPath: resolve(outputDir, 'companies.csv'), reportPath: resolve(outputDir, 'report.md'),
    companies: saved.companies as MarketCompany[], totalCount: numberValue(saved.totalCount), nextCursor: Boolean(saved.nextCursor),
    creditCost: stringValue(saved.creditCost), estimatedMaxCredits: saved.estimatedMaxCredits,
    retrievedAt: saved.retrievedAt, queryHash, replayed: true,
    ...(saved.jobSearch ? { jobSearch: saved.jobSearch as MarketSearchResult['jobSearch'] } : {}),
    ...(saved.secondary ? { secondary: saved.secondary as MarketSearchResult } : {}) };
  if (options.secondary) result.secondary = replayMarket({ replay: options.secondary }, false);
  applyMarketReviews(result.companies, options.review);
  if (result.secondary) applyMarketReviews(result.secondary.companies);
  if (!write) return result;
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(result.queryPath, `${JSON.stringify(query, null, 2)}\n`);
  writeFileSync(result.companiesPath, `${JSON.stringify({ ...saved, companies: result.companies, secondary: result.secondary, replayed: true }, null, 2)}\n`);
  writeMarketReport(result);
  return result;
}
