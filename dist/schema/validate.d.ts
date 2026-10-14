export interface ValidationResult {
    ok: boolean;
    /** One human-readable line per problem, e.g. "/tiers/0 must have required property 'model'". */
    errors: string[];
}
export declare function validateLedgerRow(value: unknown): ValidationResult;
export declare function validateLedger(value: unknown): ValidationResult;
export declare function validateRunState(value: unknown): ValidationResult;
export declare function validateTaskImpact(value: unknown): ValidationResult;
export declare function validateConfig(value: unknown): ValidationResult;
export declare function validateChangedFiles(value: unknown): ValidationResult;
