import { CfoaiOnboarding } from './cfoai.js';
import type { OnboardingContext, IntegrationOnboarding } from './types.js';

/** Integration modules return proposals; only init owns the config file write. */
export async function configureIntegrations(
  context: OnboardingContext,
  products: Partial<Record<'cfoai' | 'neatlogs' | 'entire', IntegrationOnboarding>> = { cfoai: new CfoaiOnboarding() },
): Promise<void> {
  for (const name of ['cfoai', 'neatlogs', 'entire'] as const) {
    const product = products[name];
    if (!context.config.integrations[name] || !product) continue;
    const result = await product.configure(context);
    context.config.integrations[name] = result.enabled;
    if (result.budget) context.config.budget = result.budget;
    if (result.state.detail) context.ui.print(result.state.detail);
  }
}
