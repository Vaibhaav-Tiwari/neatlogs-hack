export function neatlogsTraceUrl(traceId) {
    if (!traceId || !/^[0-9a-f]{32}$/i.test(traceId))
        return null;
    return `https://app.neatlogs.com/traces/${traceId}`;
}
export function entireSessionUrl(repoSlug, sessionId) {
    if (!repoSlug || !sessionId)
        return null;
    const parts = repoSlug.split('/');
    if (parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..'))
        return null;
    return `https://entire.io/gh/${parts.map(encodeURIComponent).join('/')}/session/${encodeURIComponent(sessionId)}`;
}
//# sourceMappingURL=evidence-links.js.map