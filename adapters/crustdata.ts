import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../engine/env.js';

const ENDPOINT = 'https://api.crustdata.com/company/search';
const API_VERSION = '2025-11-01';

export interface MarketSearchOptions {
  outputDir?: string;
  limit?: number;
  keyword?: string;
  minHeadcount?: number;
  env?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface MarketCompany {
  id: number | string | null;
  name: string | null;
  domain: string | null;
  description: string | null;
  headcount: number | null;
  industry: string | null;
  evidenceTerms: string[];
}

export interface MarketSearchResult {
  outputDir: string;
  queryPath: string;
  companiesPath: string;
  totalCount: number | null;
  nextCursor: boolean;
  companies: MarketCompany[];
  creditCost: string | null;
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
  const keyword = options.keyword ?? 'AI coding';
  return {
    filters: {
      op: 'and',
      conditions: [
        { field: 'basic_info.description', type: 'contains', value: keyword },
        { field: 'headcount.total', type: '=>', value: options.minHeadcount ?? 10 },
      ],
    },
    fields: [
      'basic_info.name',
      'basic_info.primary_domain',
      'basic_info.description',
      'headcount.total',
      'hiring.openings_count',
      'hiring.by_function_6m_pct.engineering',
      'taxonomy.professional_network_industry',
    ],
    limit: options.limit ?? 10,
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
  };
}

export async function runCrustDataMarketSearch(options: MarketSearchOptions = {}): Promise<MarketSearchResult> {
  const env = options.env ?? loadEnv();
  const apiKey = env.CRUSTDATA_API_KEY;
  if (!apiKey) throw new CrustDataError('CRUSTDATA_API_KEY is missing from ~/.tally/.env');

  const payload = buildCodingAgentsMarketQuery(options);
  const response = await (options.fetch ?? fetch)(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-api-version': API_VERSION,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(async () => ({ text: await response.text() }));
  if (!response.ok) {
    const error = recordValue(body).error;
    const message = stringValue(recordValue(error).message) ?? `HTTP ${response.status}`;
    throw new CrustDataError(`CrustData company search failed: ${message}`);
  }

  const bodyRecord = recordValue(body);
  const companies = Array.isArray(bodyRecord.companies) ? bodyRecord.companies.map(summarizeCompany) : [];
  const outputDir = resolve(options.outputDir ?? '.tally/market/latest');
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
        payload,
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
        companies,
      },
      null,
      2,
    )}\n`,
  );

  return {
    outputDir,
    queryPath,
    companiesPath,
    totalCount: numberValue(bodyRecord.total_count),
    nextCursor: Boolean(bodyRecord.next_cursor),
    companies,
    creditCost,
  };
}
