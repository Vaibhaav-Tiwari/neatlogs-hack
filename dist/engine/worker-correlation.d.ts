/** Hooks use only the first 60 prompt characters. Keep all correlation before the title. */
export declare function workerCorrelationPrefix(runId: string, taskId: string, attempt: number): string;
