import type { IntegrationState } from '../schema/types.js';
import type { IntegrationOnboarding, OnboardingContext, OnboardingResult } from './types.js';
export declare const NEATLOGS_KEYS_URL = "https://app.neatlogs.com/settings/api-keys";
type Env = Record<string, string>;
export declare function installGlobalNeatlogsHooks(env: Env, options?: {
    home?: string;
    harnesses?: Array<'claude-code' | 'codex'>;
    run?: (file: string, args: string[], env: Env) => Promise<void>;
}): Promise<void>;
export interface NeatlogsOnboardingOptions {
    env?: () => Env;
    probe?: (key: string) => Promise<boolean>;
    openBrowser?: (url: string) => Promise<void>;
    readSecret?: (question: string) => Promise<string | null>;
    save?: (values: Env) => void;
    projects?: (token: string) => Promise<{
        id: string;
        name: string;
    }[]>;
    verifyProject?: (token: string, projectId: string) => Promise<boolean>;
    installHooks?: (env: Env, options?: {
        harnesses: Array<'claude-code' | 'codex'>;
    }) => Promise<void>;
}
export declare class NeatlogsOnboarding implements IntegrationOnboarding {
    private readonly options;
    private key;
    constructor(options?: NeatlogsOnboardingOptions);
    private env;
    check(): Promise<IntegrationState>;
    connect(context: OnboardingContext): Promise<IntegrationState>;
    configure(context: OnboardingContext): Promise<OnboardingResult>;
    private connectHistory;
    private verifyProject;
}
export {};
