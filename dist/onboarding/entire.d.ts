import type { IntegrationState } from '../schema/types.js';
import type { IntegrationOnboarding, OnboardingContext, OnboardingResult } from './types.js';
export type EntireOnboardingCommand = (file: string, args: string[], options: {
    cwd: string;
    interactive?: boolean;
}) => Promise<{
    stdout: string;
}>;
export type EntireCliInstaller = () => Promise<string>;
export interface EntireOnboardingOptions {
    cwd?: string;
    command?: EntireOnboardingCommand;
    install?: EntireCliInstaller;
}
export declare class EntireOnboarding implements IntegrationOnboarding {
    private cwd;
    private readonly command;
    private readonly install;
    private binary;
    constructor(options?: EntireOnboardingOptions);
    private run;
    private ensureCli;
    private loggedIn;
    private graphInstalled;
    private status;
    private ensureMirror;
    check(): Promise<IntegrationState>;
    connect(context: OnboardingContext): Promise<IntegrationState>;
    configure(context: OnboardingContext): Promise<OnboardingResult>;
}
