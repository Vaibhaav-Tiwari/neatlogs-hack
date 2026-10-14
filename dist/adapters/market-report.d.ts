import type { MarketCompany, MarketSearchResult } from './crustdata.js';
export interface MarketReview {
    id: string | number;
    label: MarketCompany['label'];
    reason: string;
    sourceUrl: string;
    sourceDate: string | null;
    excerpt?: string;
    reviewedAt?: string;
}
export declare function estimateMarketCredits(payload: Record<string, unknown>, endpoint: Record<string, unknown>): number;
export declare function applyMarketReviews(companies: MarketCompany[], path?: string): void;
export declare function writeMarketReport(result: MarketSearchResult): void;
