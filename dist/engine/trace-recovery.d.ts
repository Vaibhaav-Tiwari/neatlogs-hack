import { type WorkerTraceDrainPort } from '../adapters/neatlogs-worker-spool.js';
import { type WorkerTraceReaderPort } from '../adapters/neatlogs-worker-traces.js';
import { type RunState } from '../schema/index.js';
export declare function recoverRunTraces(options: {
    runId: string;
    outputDir?: string;
    drain?: WorkerTraceDrainPort;
    reader?: WorkerTraceReaderPort;
    now?: () => Date;
}): Promise<{
    before: RunState['integrations']['neatlogs'];
    after: RunState['integrations']['neatlogs'];
    traceIds: string[];
}>;
