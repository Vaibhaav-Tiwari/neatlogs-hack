const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (value) => `$${(value / 1e9).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const absent = '<span class="blank">none yet</span>';

export function validExperiment(summary) {
  return summary?.schemaVersion === 1 && typeof summary.experimentId === 'string' && typeof summary.repo === 'string'
    && typeof summary.real === 'boolean' && Array.isArray(summary.taskIds) && summary.taskIds.every((id) => typeof id === 'string')
    && ['running', 'finished', 'stopped'].includes(summary.status)
    && ['baseline', 'tally'].every((mode) => Array.isArray(summary.modes?.[mode]?.runs) && summary.modes[mode].runs.every((run) => typeof run?.runId === 'string' && typeof run.path === 'string' && Number.isInteger(run.repeat) && typeof run.status === 'string'));
}

export function experimentMatches(summary, current) {
  return validExperiment(summary) && summary.repo === current.repo && [...summary.taskIds].sort().join('|') === current.taskIds
    && (summary.real ? current.kind === 'real' : ['simulated', 'sample'].includes(current.kind));
}

export function statRange(stat, format) {
  if (!stat || ![stat.min, stat.median, stat.max].every((n) => Number.isFinite(n))) return absent;
  return stat.min === stat.max ? format(stat.median) : `${format(stat.min)}-${format(stat.max)}<span class="spread-mid">median ${format(stat.median)}</span>`;
}

function runHref(path, pageUrl, summaryPath) {
  try {
    const page = new URL(pageUrl), data = new URL(path, page);
    if (!['http:', 'https:'].includes(data.protocol) || data.origin !== page.origin) return null;
    page.searchParams.set('data', path);
    for (const key of ['run', 'demo', 'replay']) page.searchParams.delete(key);
    page.searchParams.set('experiment', summaryPath);
    return page.href;
  } catch { return null; }
}

export function experimentMarkup(summary, { path, choices = [], pageUrl }) {
  const options = choices.map((item) => `<option value="${esc(item.path)}" ${item.path === path ? 'selected' : ''}>${esc(item.summary.experimentId)} - ${esc(item.summary.status)}</option>`).join('');
  const picker = choices.length > 1 ? `<label class="experiment-picker">Experiment <select id="experiment-select">${options}</select></label>` : '';
  const rows = ['baseline', 'tally'].map((mode) => {
    const group = summary.modes[mode], finished = group.runs.filter((run) => run.status === 'finished');
    const details = group.runs.map((run) => {
      const href = runHref(run.path, pageUrl, path);
      const label = `${run.runId} - repeat ${run.repeat} - ${run.status}`;
      return `<span class="experiment-run">${href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label)}</span>`;
    }).join('');
    return `<tr><td>${mode === 'baseline' ? 'Baseline' : 'Tally'}<span class="l-note">${finished.length}/${esc(summary.repeatsPlanned)} repeats finished</span>${details}</td>
      <td class="num fig" data-label="Cost per passed task">${statRange(group.costPerPassedTaskNanos, usd)}</td><td class="num fig" data-label="Pass rate">${statRange(group.passRate, pct)}</td><td class="num fig" data-label="Total cost">${statRange(group.totalCostNanos, usd)}</td></tr>`;
  }).join('');
  const comparison = summary.comparison ?? {};
  const bothFinished = ['baseline', 'tally'].every((mode) => summary.modes[mode].runs.some((run) => run.status === 'finished'));
  const costChange = (value, label) => Number.isFinite(value) ? value === 0 ? `${label}: unchanged from baseline.` : `${label}: ${Math.abs(value).toFixed(1)}% ${value < 0 ? 'less' : 'more'} than baseline.` : '';
  const verdict = bothFinished ? [costChange(comparison.totalCostChangePct, 'Total cost'), costChange(comparison.costPerPassedTaskChangePct, 'Cost per passed task'), Number.isFinite(comparison.passRateChangePoints) ? `Pass rate: ${comparison.passRateChangePoints > 0 ? '+' : ''}${comparison.passRateChangePoints.toFixed(1)} percentage points.` : ''].filter(Boolean).join(' ') : 'No comparable baseline yet: waiting for a finished run in both modes.';
  return `${picker}<p class="comparison-scope"><b>${esc(summary.experimentId)}</b> · ${summary.real ? 'real experiment' : 'simulated experiment'} · ${esc(summary.status)}. Repository <span class="fig">${esc(summary.repo)}</span>; tasks <span class="fig">${esc(summary.taskIds.join(', '))}</span>. Summary: <span class="fig">${esc(path)}</span>.</p>
    <p class="experiment-budget">Experiment spend ${Number.isFinite(summary.budget?.spentNanos) ? usd(summary.budget.spentNanos) : 'unknown'} of ${Number.isFinite(summary.budget?.capNanos) ? usd(summary.budget.capNanos) : 'unknown'} cap.</p>
    <div class="scroll"><table class="comparison experiment-comparison"><thead><tr><th>Mode and repeats</th><th class="num">Cost per passed task</th><th class="num">Pass rate</th><th class="num">Total cost</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="experiment-verdict">${esc(verdict)}</p><p class="comparison-scope">${esc(comparison.note ?? 'Statistics cover finished repeats only.')} A passed task is not proof of a merged pull request.</p>`;
}
