import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
export function installRecordPath(configPath) {
    return resolve(dirname(configPath), '.tally', 'install.json');
}
export function contentHash(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function configHash(value) {
    const canonical = (item) => Array.isArray(item) ? item.map(canonical)
        : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])) : item;
    return contentHash(JSON.stringify(canonical(value)) ?? 'undefined');
}
//# sourceMappingURL=install-record.js.map