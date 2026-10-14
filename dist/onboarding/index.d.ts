import type { OnboardingContext, IntegrationOnboarding } from './types.js';
/** Integration modules return proposals; only init owns the config file write. */
export declare function configureIntegrations(context: OnboardingContext, products?: Partial<Record<'cfoai' | 'neatlogs' | 'entire', IntegrationOnboarding>>): Promise<void>;
