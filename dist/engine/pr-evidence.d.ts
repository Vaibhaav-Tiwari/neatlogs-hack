import type { LedgerRow, TallyConfig } from '../schema/index.js';
export interface PrEvidenceLink {
    label: string;
    url: string;
    note?: string;
}
export declare function prEvidenceLinks(row: LedgerRow, config: TallyConfig): PrEvidenceLink[];
