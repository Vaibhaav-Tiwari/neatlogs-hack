import { neatlogsTraceUrl } from '../adapters/evidence-links.js';
function httpsUrl(value) {
    if (!value)
        return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.toString() : null;
    }
    catch {
        return null;
    }
}
export function prEvidenceLinks(row, config) {
    const links = [];
    if (config.integrations.entire) {
        const checkpointUrl = httpsUrl(row.checkpointUrl);
        if (checkpointUrl)
            links.push({
                label: 'Entire session and checkpoint',
                url: checkpointUrl,
                ...(row.checkpointId ? { note: `checkpoint ${row.checkpointId}` } : {}),
            });
    }
    if (config.integrations.neatlogs) {
        const decisionTraceUrl = httpsUrl(row.traceUrl) ?? neatlogsTraceUrl(row.traceId);
        const workerTraceUrl = httpsUrl(row.workerTraceUrl) ?? neatlogsTraceUrl(row.workerTraceId);
        if (decisionTraceUrl)
            links.push({ label: 'Neatlogs routing trace', url: decisionTraceUrl });
        if (workerTraceUrl)
            links.push({ label: 'Neatlogs worker trace', url: workerTraceUrl });
    }
    if (config.integrations.cfoai || config.budget.source === 'cfoai') {
        const budgetUrl = httpsUrl(config.budget.cfoai?.tableUrl);
        const spendUrl = httpsUrl(config.budget.cfoai?.spendDetailTableUrl);
        if (budgetUrl)
            links.push({ label: 'cfo.ai budget table', url: budgetUrl });
        if (spendUrl)
            links.push({ label: 'cfo.ai spend table', url: spendUrl });
    }
    return links;
}
//# sourceMappingURL=pr-evidence.js.map