import { dirname, resolve } from 'node:path';
import { FilePriceHistory } from '../adapters/history-file.js';
import { NeatlogsPriceHistory } from '../adapters/neatlogs-history.js';
/** Construct the same local or Neatlogs-backed history port for plans and runs. */
export function createPriceHistory(config, configPath) {
    const fallback = new FilePriceHistory({ path: resolve(dirname(configPath), '.tally', 'history.json') });
    if (!config.integrations.neatlogs)
        return fallback;
    return new NeatlogsPriceHistory({ fallback });
}
//# sourceMappingURL=price-history.js.map