import { readFileSync, writeFileSync } from 'node:fs';
import type { MarketCompany, MarketSearchResult } from './crustdata.js';
import { CrustDataError } from './crustdata.js';

export interface MarketReview {
  id: string | number;
  label: MarketCompany['label'];
  reason: string;
  sourceUrl: string;
  sourceDate: string | null;
  excerpt?: string;
  reviewedAt?: string;
}
const labels = ['candidate', 'vendor', 'hiring intent', 'verified use', 'rejected'];
const rec = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null ? v as Record<string, unknown> : {};

export function estimateMarketCredits(payload: Record<string, unknown>, endpoint: Record<string, unknown>): number {
  const base = endpoint.base_credits;
  if (endpoint.status !== 'enabled' || typeof base !== 'number' || !Number.isFinite(base) || base < 0) {
    throw new CrustDataError('Company Search unavailable or account pricing missing');
  }
  const filterFields: string[] = [];
  function walk(value: unknown): void {
    const r = rec(value);
    if (typeof r.field === 'string') filterFields.push(r.field);
    if (Array.isArray(r.conditions)) r.conditions.forEach(walk);
  }
  walk(payload.filters);
  const fields = Array.isArray(payload.fields) ? payload.fields.map(String) : [];
  let perRow = base;
  for (const [key, selected] of [['premium_filters', filterFields], ['premium_fields', fields]] as const) {
    const premiums = endpoint[key];
    if (!Array.isArray(premiums)) throw new CrustDataError('Incomplete account premium pricing; refusing search');
    for (const value of premiums) {
      const p = rec(value);
      if (typeof p.field !== 'string' || typeof p.credits !== 'number' || !Number.isFinite(p.credits) || p.credits < 0) throw new CrustDataError('Invalid account pricing');
      const field = p.field;
      if (selected.some(f => f === field || f.startsWith(`${field}.`))) perRow += p.credits;
    }
  }
  // Both filter and response sides bill; assume every selected premium is populated.
  return Math.ceil((perRow * Number(payload.limit) - 1e-9) * 10000) / 10000;
}

export function applyMarketReviews(companies: MarketCompany[], path?: string): void {
  for (const c of companies) {
    if (!c || !labels.includes(c.label) || !Array.isArray(c.evidenceTerms) || !c.evidenceTerms.every(t => typeof t === 'string') ||
      !(c.id === null || typeof c.id === 'string' || (typeof c.id === 'number' && Number.isFinite(c.id))) ||
      ![c.name, c.domain, c.description, c.industry, c.sourceUrl, c.sourceDate].every(v => v === null || typeof v === 'string') ||
      !(c.headcount === null || (typeof c.headcount === 'number' && Number.isFinite(c.headcount))) ||
      !(c.review === null || (typeof c.review === 'object' && c.review !== null && c.review.label === c.label && String(c.review.id) === String(c.id)))) {
      throw new CrustDataError('Invalid cached company');
    }
  }
  if (!path) return;
  let reviews: unknown;
  try { reviews = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new CrustDataError('Cannot read market reviews'); }
  if (!Array.isArray(reviews)) throw new CrustDataError('Review file must be an array');
  const seen = new Set<string>();
  for (const value of reviews) {
    const r = rec(value), key = String(r.id);
    const company = companies.find(c => c.id !== null && String(c.id) === key);
    let source: URL;
    try { source = new URL(String(r.sourceUrl)); } catch { throw new CrustDataError('Review source must be an http(s) URL'); }
    if (!company || seen.has(key) || !labels.includes(String(r.label)) || typeof r.reason !== 'string' || !r.reason.trim() ||
      !['http:', 'https:'].includes(source.protocol) || source.username || source.password ||
      !(r.sourceDate === null || (typeof r.sourceDate === 'string' && Number.isFinite(Date.parse(r.sourceDate)))) ||
      (r.excerpt !== undefined && typeof r.excerpt !== 'string')) throw new CrustDataError('Invalid or unmatched market review');
    if (['verified use', 'hiring intent'].includes(String(r.label)) && (typeof r.excerpt !== 'string' || !r.excerpt.trim())) {
      throw new CrustDataError('Use/intent labels require a sourced evidence excerpt');
    }
    seen.add(key);
    company.label = r.label as MarketCompany['label'];
    company.review = { id: company.id!, label: company.label, reason: r.reason, sourceUrl: source.href,
      sourceDate: r.sourceDate as string | null, reviewedAt: new Date().toISOString(), ...(r.excerpt === undefined ? {} : { excerpt: String(r.excerpt) }) };
  }
}
const md = (v: unknown): string => String(v ?? 'unknown').replace(/[\r\n]+/g, ' ').replace(/[|\\`*_[\]<>]/g, '\\$&');
const csv = (v: unknown): string => {
  let s = String(v ?? '');
  if (/^\s*[=+@-]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
export function writeMarketReport(result: MarketSearchResult): void {
  const counts = labels.map(label => `${label}: ${result.companies.filter(c => c.label === label).length}`).join('; ');
  const columns = ['id', 'name', 'domain', 'headcount', 'industry', 'label', 'reason', 'sourceUrl', 'sourceDate', 'retrievedAt'];
  writeFileSync(result.csvPath, `${columns.join(',')}\n${result.companies.map(c => [c.id, c.name, c.domain, c.headcount, c.industry, c.label,
    c.review?.reason ?? 'Firmographic candidate only; tool use unverified', c.review?.sourceUrl ?? c.sourceUrl,
    c.review?.sourceDate ?? c.sourceDate, result.retrievedAt].map(csv).join(',')).join('\n')}\n`);
  writeFileSync(result.reportPath, `# Find and qualify likely pilot companies\n\n` +
    `Retrieved: ${result.retrievedAt}; API: 2025-11-01. Returned ${result.companies.length}; API query matches: ${result.totalCount ?? 'unknown'}.\n` +
    `Credits reported: ${result.creditCost ?? 'unknown'}; conservative maximum estimate: ${result.estimatedMaxCredits}.\n` +
    `Query SHA256: ${result.queryHash}. ${result.replayed ? 'Cached replay: no API calls or new data.' : 'Single bounded batch; no pagination or enrichment.'}\n\n` +
    `Reviewed rows: ${result.companies.filter(c => c.review !== null).length}; ${counts}.\n\n` +
    `Prospects, not adoption or market size. Headcount is not coding-agent seats. Labels are manual review judgements, not independently verified by Tally. API source dates are record-update timestamps, not the publication date or proof of current adoption. Dates remain unknown when absent.\n\n` +
    `| Company | Label | Reason | Source | Source date |\n| --- | --- | --- | --- | --- |\n` +
    result.companies.slice(0, 10).map(c => `| ${md(c.name)} (${md(c.domain)}) | ${md(c.label)} | ${md(c.review?.reason ?? 'Firmographic candidate; tool use unverified')} | ${md(c.review?.sourceUrl ?? c.sourceUrl)} | ${md(c.review?.sourceDate ?? c.sourceDate)} |`).join('\n') +
    `\n\nShowing ${Math.min(10, result.companies.length)} of ${result.companies.length} returned rows. JSON/CSV retain all rows. No deduplication or extrapolation applied.\n`);
}
