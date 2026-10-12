export function neatlogsTraceUrl(traceId: string | null | undefined): string | null {
  if (!traceId || !/^[0-9a-f]{32}$/i.test(traceId)) return null;
  return `https://app.neatlogs.com/traces/${traceId}`;
}

export function entireSessionUrl(repoSlug: string | undefined, sessionId: string | null | undefined): string | null {
  if (!repoSlug || !sessionId) return null;
  const parts = repoSlug.split('/');
  if (parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..')) return null;
  return `https://entire.io/gh/${parts.map(encodeURIComponent).join('/')}/session/${encodeURIComponent(sessionId)}`;
}
