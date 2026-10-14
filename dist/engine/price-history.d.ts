import type { PriceHistoryPort, PriceHistoryWriterPort } from '../agent/ports.js';
import type { TallyConfig } from '../schema/types.js';
/** Construct the same local or Neatlogs-backed history port for plans and runs. */
export declare function createPriceHistory(config: TallyConfig, configPath: string): PriceHistoryPort & PriceHistoryWriterPort;
