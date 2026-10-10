// What the Ledger says when a run has nothing in it yet, or never will.
// Pure markup builders so they can be tested without a browser.

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const isSlug = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value);

/** `github-issues` or `file`. Older run files do not record it, so fall back to the GitHub integration state. */
export function backlogSource(run) {
  if (run.backlog?.source) return run.backlog.source;
  return run.integrations?.github?.status === 'off' ? 'file' : 'github-issues';
}

function commands(lines) {
  return `<pre class="empty-commands"><code>${lines.map(esc).join('\n')}</code></pre>`;
}

function noIssues(run) {
  const label = typeof run.backlog?.issueLabel === 'string' && run.backlog.issueLabel.length > 0 ? run.backlog.issueLabel : null;
  const repo = isSlug(run.repo) ? ` --repo ${run.repo}` : '';
  const arg = label ? shellQuote(label) : '<label>';
  const named = label
    ? `labelled <b class="fig">${esc(label)}</b>`
    : 'with the label set as <span class="fig">backlog.issueLabel</span> in tally.yaml';
  const where = isSlug(run.repo) ? ` on ${esc(run.repo)}` : '';
  if (run.status === 'running') {
    return `<div class="empty-state"><h3>No tasks listed yet</h3>
      <p>The run has started and is looking for open issues ${named}${where}.</p></div>`;
  }
  const spent = run.budget?.spentNanos ? '' : ' and spent nothing';
  return `<div class="empty-state"><h3>No issues matched the label</h3>
    <p>GitHub intake found no open issues ${named}${where}, so this run had no tasks${spent}.
      Labels must match exactly, and closed issues are not read.</p>
    <p>See what the label matches, create it if it does not exist, then put it on an issue:</p>
    ${commands([
      `gh issue list${repo} --label ${arg} --state open`,
      `gh label create ${arg}${repo}`,
      `gh issue edit <issue-number>${repo} --add-label ${arg}`,
    ])}
    <p>Then run <span class="fig">tally run --plan</span> to check the task count before starting workers.</p></div>`;
}

function noFileTasks(run) {
  const file = typeof run.backlog?.file === 'string' && run.backlog.file ? `<span class="fig">${esc(run.backlog.file)}</span>` : 'The backlog file named in tally.yaml';
  return `<div class="empty-state"><h3>No tasks in the backlog</h3>
    <p>${file} listed no tasks, so this run had nothing to work on. Add tasks to it, or set
      <span class="fig">backlog.source: github-issues</span> and an issue label in tally.yaml.</p></div>`;
}

/** Markup to show in place of, or above, the task groups. Empty string when the run needs no explanation. */
export function ledgerEmptyState(run, ledger) {
  if (run.tasks.length === 0) return backlogSource(run) === 'file' ? noFileTasks(run) : noIssues(run);
  if (ledger.length > 0 || run.tasks.some(task => task.status !== 'pending')) return '';
  const tasks = `${run.tasks.length} ${run.tasks.length === 1 ? 'task' : 'tasks'}`;
  if (run.status === 'running') {
    return `<div class="empty-state"><h3>No worker has started yet</h3>
      <p>This run has listed ${tasks} and is sizing and routing them. Each attempt is entered below its task
        as soon as a worker starts, and the page updates by itself.</p></div>`;
  }
  return `<div class="empty-state"><h3>No worker was started</h3>
    <p>This run ${run.status === 'interrupted' ? 'was interrupted' : 'ended'} with ${tasks} listed and no attempt made, so nothing was spent.
      Start it again with <span class="fig">tally run</span>.</p></div>`;
}
