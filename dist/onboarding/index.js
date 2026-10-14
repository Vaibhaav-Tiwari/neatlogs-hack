import { CfoaiOnboarding } from './cfoai.js';
import { EntireOnboarding } from './entire.js';
import { NeatlogsOnboarding } from './neatlogs.js';
/** Integration modules return proposals; only init owns the config file write. */
export async function configureIntegrations(context, products = { cfoai: new CfoaiOnboarding(), neatlogs: new NeatlogsOnboarding(), entire: new EntireOnboarding() }) {
    for (const name of ['neatlogs', 'entire', 'cfoai']) {
        const product = products[name];
        if (!context.config.integrations[name] || !product)
            continue;
        const result = await product.configure(context);
        context.config.integrations[name] = result.enabled;
        if (result.budget)
            context.config.budget = result.budget;
        if (result.state.detail)
            context.ui.print(result.state.detail);
    }
}
//# sourceMappingURL=index.js.map