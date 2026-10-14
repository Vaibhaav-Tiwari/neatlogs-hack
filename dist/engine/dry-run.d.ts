import type { TallyConfig } from '../schema/types.js';
import type { RealRunPorts } from './real.js';
export declare function createDryRunPorts(options?: {
    config?: TallyConfig;
    configPath?: string;
}): Partial<RealRunPorts>;
