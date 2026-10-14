import { type MarketReview } from './market-report.js';
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
    jobEvidence?: Array<{
        id: string | number;
        title: string;
        url: string;
        date: string;
        terms: string[];
        excerpt: string;
    }>;
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
    jobSearch?: {
        returnedCount: number;
        discardedCount: number;
        duplicates: number;
    };
    secondary?: MarketSearchResult;
}
export declare class CrustDataError extends Error {
    constructor(message: string);
}
export declare function buildCodingAgentsMarketQuery(options?: Pick<MarketSearchOptions, 'keyword' | 'limit' | 'minHeadcount'>): Record<string, unknown>;
export declare function runCrustDataMarketSearch(options?: MarketSearchOptions): Promise<MarketSearchResult>;
