function usdFromNanos(value) {
  return Number.isFinite(value) ? `$${(value / 1_000_000_000).toFixed(2)}` : null;
}

function expectedComparison(decision) {
  const match = /expected to cost \$([\d.]+) against \$([\d.]+) for going straight to ([\w-]+)/i.exec(decision ?? '');
  if (!match) return null;
  return `expected $${Number(match[1]).toFixed(2)} vs $${Number(match[2]).toFixed(2)} at ${match[3]}`;
}

function historySummary(decision, tier) {
  if (!tier) return null;
  const escapedTier = tier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`History for ${escapedTier} uses (neatlogs|local): (\\d+) observations, ([\\d.]+)% pass rate and \\$([\\d.]+) average cost`, 'i').exec(decision ?? '');
  if (!match) return null;
  const source = match[1].toLowerCase() === 'neatlogs' ? 'Neatlogs' : 'Local history';
  return `${source} · ${match[2]} similar attempts · ${match[3]}% passed · $${Number(match[4]).toFixed(2)} avg`;
}

export function decisionSummary(task, attempts = []) {
  if (!attempts.length) {
    return {
      headline: task.status === 'skipped' ? 'Skipped · budget did not cover the minimum attempt ceiling.' : 'No attempt has started yet.',
      history: null,
    };
  }

  const first = attempts[0];
  const last = attempts.at(-1);
  const size = task.size ?? first.size;
  const files = task.impact?.totals?.filesTouched;
  const tiers = [...new Set(attempts.map(attempt => attempt.tier).filter(Boolean))];
  const cap = usdFromNanos(first.ceilingNanos);
  const pieces = [
    size ? `${size[0].toUpperCase()}${size.slice(1)} scope` : null,
    Number.isFinite(files) ? `${files} target ${files === 1 ? 'file' : 'files'}` : null,
    tiers.length ? `${tiers.join(' → ')} tier${tiers.length > 1 ? 's' : ''}` : null,
    cap ? `${cap} cap` : null,
    expectedComparison(first.decision),
  ].filter(Boolean);
  return {
    headline: pieces.join(' · '),
    history: historySummary(first.decision, first.tier),
    finalHistory: last !== first ? historySummary(last.decision, last.tier) : null,
  };
}
