import { createHash } from 'node:crypto';
function compactId(id, limit) {
    const encoded = encodeURIComponent(id).replace(/%23/g, '#');
    return encoded.length <= limit ? encoded : `~${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
}
/** Hooks use only the first 60 prompt characters. Keep all correlation before the title. */
export function workerCorrelationPrefix(runId, taskId, attempt) {
    const format = (run, task) => `Tally ${run} ${task} a${attempt}:`;
    const prefix = format(compactId(runId, 24), compactId(taskId, 12));
    return prefix.length <= 55 ? prefix : format(compactId(runId, 0), compactId(taskId, 0));
}
//# sourceMappingURL=worker-correlation.js.map