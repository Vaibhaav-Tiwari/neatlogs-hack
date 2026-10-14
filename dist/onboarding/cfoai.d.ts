import { type CfoaiMcpClient } from '../adapters/cfoai.js';
import type { IntegrationState } from '../schema/types.js';
import type { IntegrationOnboarding, OnboardingContext, OnboardingResult } from './types.js';
export interface CfoaiOnboardingOptions {
    client?: () => CfoaiMcpClient;
    check?: () => Promise<IntegrationState>;
    login?: () => Promise<unknown>;
    now?: () => Date;
}
/** Keeps model tables intact and writes only Tally-owned, scoped context. */
export declare class CfoaiOnboarding implements IntegrationOnboarding {
    private readonly options;
    constructor(options?: CfoaiOnboardingOptions);
    check(): Promise<IntegrationState>;
    connect(context: OnboardingContext): Promise<IntegrationState>;
    configure(context: OnboardingContext): Promise<OnboardingResult>;
}
