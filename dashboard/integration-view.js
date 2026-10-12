import { budgetPageUrl } from './budget-link.js';

const INTEGRATIONS = [
  ['neatlogs', 'neatlogs', 'traces'],
  ['entire', 'Entire', 'checkpoints and handoff'],
  ['cfoai', 'cfo.ai', 'live budget'],
  ['github', 'GitHub', 'issues and pull requests'],
  ['slack', 'Slack', 'alerts'],
];
const INTEGRATION_WORD = { ok: 'connected', off: 'off', missing: 'not connected', error: 'broken' };
const INTEGRATION_OFF_NOTE = {
  neatlogs: 'Off for this run; traces were not sent.',
  entire: 'Off for this run; checkpoints and handoff use local fallback.',
  cfoai: 'Off for this run; budget comes from tally.yaml.',
  github: 'Off for this run; backlog came from a file.',
  slack: 'Off for this run; alerts were not sent.',
};

function cfoaiDetail(detail) {
  if (typeof detail !== 'string') return null;
  const stripped = detail.replace(/https:\/\/app\.cfo\.ai\/\S+/g, '').trim();
  const contextFailures = [...stripped.matchAll(/Ari task-context write failed:\s*(.*?)\.\s*Local ledger and spend tables remain the source of truth for this attempt\./g)]
    .map(match => match[1].trim());
  if (contextFailures.length) {
    const unique = [...new Set(contextFailures)];
    return `Ari context report failed for ${contextFailures.length} ${contextFailures.length === 1 ? 'attempt' : 'attempts'}: ${unique[0]}. Budget and spend tables remain connected; the local ledger is the source of truth.`;
  }
  return stripped || null;
}

function displayStatus(key, status, detail) {
  if (key === 'neatlogs' && status === 'missing' && typeof detail === 'string'
    && /(?:span|trace) read-back failed \(HTTP 409\)|trace projection is not ready|still indexing this worker trace/i.test(detail)
    && /\b[\da-f]{32}\b/i.test(detail)) return 'ok';
  if (key === 'cfoai' && status === 'error' && typeof detail === 'string') {
    const withoutContextFailures = detail
      .replace(/Ari task-context write failed:\s*.*?\.\s*Local ledger and spend tables remain the source of truth for this attempt\./g, '')
      .replace(/https:\/\/app\.cfo\.ai\/\S+/g, '')
      .replace(/[\s.;]+/g, '');
    if (/Ari task-context write failed:/i.test(detail) && !withoutContextFailures) return 'ok';
  }
  return status;
}

function entireDetail(detail) {
  if (typeof detail !== 'string') return null;
  if (/Graph sizing: ok/i.test(detail) && /checkpoint search available/i.test(detail)
    && !/no (?:matching )?code symbols|without matching code symbols|repository search/i.test(detail)) {
    return 'Graph sizing and checkpoint search are available.';
  }
  return detail;
}

function neatlogsDetail(detail, ledger) {
  if (typeof detail !== 'string') return null;
  const parts = [];
  const traceRecorded = /\b[\da-f]{32}\b/i.test(detail);
  const noMatch = /No usable Neatlogs price-history observations matched (.+?); using local history\.?/i.exec(detail);
  const readFailed = /Neatlogs price-history read failed; using local history\.\s*(.*)/i.exec(detail);
  const projectionPending = /(?:span|trace) read-back failed \(HTTP 409\)|trace projection is not ready|still indexing this worker trace/i.test(detail);
  if (traceRecorded) parts.push('Routing trace recorded.');
  if (noMatch) parts.push(`No matching remote price history for ${noMatch[1].replace(/\s*\(unknown-model observations excluded\)/i, '')}. Tally used local history.`);
  else if (readFailed) parts.push('Remote price history could not be read. Tally used local history.');
  if (projectionPending) parts.push('A worker trace is still being indexed; its trace link may need a moment to populate.');
  const remainder = detail
    .replace(/\b[\da-f]{32}\b/gi, '')
    .replace(/No usable Neatlogs price-history observations matched .+?; using local history\.?/i, '')
    .replace(/Neatlogs price-history read failed; using local history\.\s*/i, '')
    .replace(/Neatlogs worker span read-back failed \(HTTP 409\)\.?/i, '')
    .replace(/(?:span|trace) read-back failed \(HTTP 409\)\.?/i, '')
    .replace(/trace projection is not ready\.?/i, '')
    .replace(/still indexing this worker trace\.?/i, '')
    .replace(/;\s*/g, '. ')
    .replace(/^\s*[.;]+\s*/, '')
    .replace(/\s+[.;]+\s*$/, '')
    .trim();
  if (remainder && !/^[.;\s]+$/.test(remainder)) parts.push(remainder);
  if (ledger.some(row => row.traceUrl || row.traceId || row.workerTraceUrl || row.workerTraceId)) {
    parts.push('Trace links are in the attempt ledger.');
  }
  return parts.join(' ') || null;
}

export function integrationView(run, ledger = []) {
  return INTEGRATIONS.filter(([key]) => run.integrations?.[key] && (key !== 'slack' || run.integrations[key].status !== 'off'))
    .map(([key, name, job]) => {
      const { detail } = run.integrations[key];
      const status = displayStatus(key, run.integrations[key].status, detail);
      const pageUrl = key === 'cfoai' && status !== 'off' ? budgetPageUrl(run.budget) : null;
      const usableDetail = key === 'cfoai' ? cfoaiDetail(detail)
        : key === 'entire' ? entireDetail(detail)
        : key === 'neatlogs' ? neatlogsDetail(detail, ledger) : detail;
      return {
        key,
        name,
        status,
        statusLabel: INTEGRATION_WORD[status] ?? status,
        detail: usableDetail ?? (status === 'off' ? INTEGRATION_OFF_NOTE[key] : job),
        ...(pageUrl ? { link: { url: pageUrl, label: 'cfo.ai budget table' } } : {}),
      };
    });
}
