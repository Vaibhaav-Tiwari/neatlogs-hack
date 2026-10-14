import type { IntegrationState, TallyConfig } from '../schema/types.js';
export interface OnboardingUi {
    print(message: string): void;
    /** Default-no confirmation; an unattended init must not imply consent. */
    confirm(question: string): Promise<boolean>;
    /** Returns a zero-based index, or null when the user skips. */
    select(question: string, choices: string[]): Promise<number | null>;
}
export interface OnboardingContext {
    config: TallyConfig;
    ui: OnboardingUi;
    /** Actual target root, independent of the CLI process's working directory. */
    repoRoot?: string;
}
export interface OnboardingResult {
    enabled: boolean;
    state: IntegrationState;
    /** Proposed configuration only; the init owner performs the final write. */
    budget?: TallyConfig['budget'];
}
export interface IntegrationOnboarding {
    check(): Promise<IntegrationState>;
    connect(context: OnboardingContext): Promise<IntegrationState>;
    configure(context: OnboardingContext): Promise<OnboardingResult>;
}
