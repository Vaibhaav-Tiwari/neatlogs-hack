import { dirname, resolve } from 'node:path';
import { FilePriceHistory } from '../adapters/history-file.js';
import { NeatlogsPriceHistory } from '../adapters/neatlogs-history.js';
import type { PriceHistoryPort, PriceHistoryWriterPort } from '../agent/ports.js';
import type { TallyConfig } from '../schema/types.js';

/** Construct the same local or Neatlogs-backed history port for plans and runs. */
export function createPriceHistory(config: TallyConfig, configPath: string): PriceHistoryPort & PriceHistoryWriterPort {
  const fallback = new FilePriceHistory({ path: resolve(dirname(configPath), '.tally', 'history.json') });
  if (!config.integrations.neatlogs) return fallback;
  return new NeatlogsPriceHistory({ fallback });
}
