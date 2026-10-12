import { budgetPageUrl } from './budget-link.js';

const INTEGRATIONS = [
  ['neatlogs', 'neatlogs', 'traces'],
  ['entire', 'Entire', 'checkpoints and handoff'],
  ['cfoai', 'cfo.ai', 'live budget'],
  ['github', 'GitHub', 'issues and pull requests'],
  ['slack', 'Slack', 'alerts'],
];
const INTEGRATION_WORD = { ok: 'on', off: 'off', missing: 'not connected', error: 'broken' };
const INTEGRATION_OFF_NOTE = {
  neatlogs: 'Off for this run; traces were not sent.',
  entire: 'Off for this run; checkpoints and handoff use local fallback.',
  cfoai: 'Off for this run; budget comes from tally.yaml.',
  github: 'Off for this run; backlog came from a file.',
  slack: 'Off for this run; alerts were not sent.',
};

function cfoaiDetail(detail) {
  if (typeof detail !== 'string') return null;
  return detail.replace(/https:\/\/app\.cfo\.ai\/\S+/g, '').trim() || null;
}

function entireDetail(detail) {
  if (typeof detail !== 'string') return null;
  if (/Graph sizing: ok/i.test(detail) && /checkpoint search available/i.test(detail)) {
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
  if (traceRecorded) parts.push('Routing trace recorded.');
  if (noMatch) parts.push(`No matching Neatlogs price history for ${noMatch[1]}. Tally used local history.`);
  else if (readFailed) parts.push('Neatlogs price history could not be read. Tally used local history.');
  else {
    const remainder = detail.replace(/\b[\da-f]{32}\b/gi, '').replace(/;\s*/g, '. ').trim();
    if (remainder) parts.push(remainder);
  }
  if (ledger.some(row => row.traceUrl || row.traceId || row.workerTraceUrl || row.workerTraceId)) {
    parts.push('Trace links appear in the attempt ledger.');
  }
  return parts.join(' ') || null;
}

export function integrationView(run, ledger = []) {
  return INTEGRATIONS.filter(([key]) => run.integrations?.[key] && (key !== 'slack' || run.integrations[key].status !== 'off'))
    .map(([key, name, job]) => {
      const { status, detail } = run.integrations[key];
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
