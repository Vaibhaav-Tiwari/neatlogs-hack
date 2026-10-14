import type { BudgetSource, LedgerRow, TaskImpact, Tier } from '../schema/types.js';
import type { TokenUsage, TierPrice } from '../schema/types.js';
export interface CfoaiTaskContextInput {
    row: LedgerRow;
    repo: string;
    runId: string;
    scenario?: string;
    contextPageName?: string;
    contextPageUrl?: string;
    runLimitNanos: number;
    runLimitSource: 'cli' | BudgetSource;
    runSpentNanos: number;
    budgetSource: BudgetSource;
    spendTableWriteStatus: 'ok' | 'failed';
    monthlyLimitNanos: number;
    monthlySpentBeforeRunNanos: number;
    tiers: Tier[];
    impact?: TaskImpact;
    sizingConfidence?: number;
    issueUrl?: string | null;
    budgetTableUrl?: string;
    spendTableUrl?: string;
}
export interface CfoaiTaskContextDocument {
    content: string;
    filename: string;
    tags: string[];
    metadata: Record<string, string>;
    idempotencyKey: string;
}
export declare function repriceTokenUsage(tokens: TokenUsage, price: TierPrice): number;
/** Build the minimum useful, reproducible run record Ari needs for spend what-ifs. */
export declare function buildCfoaiTaskContext(input: CfoaiTaskContextInput): CfoaiTaskContextDocument;
