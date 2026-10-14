import { type MarketCompany, type MarketSearchOptions, type MarketSearchResult } from './crustdata.js';
export declare function buildJobQuery(limit?: number, now?: Date): Record<string, unknown>;
export declare function qualifyJobs(rows: unknown[]): {
    companies: MarketCompany[];
    discardedCount: number;
    duplicates: number;
};
export declare function runJobMarket(options: MarketSearchOptions): Promise<MarketSearchResult>;
