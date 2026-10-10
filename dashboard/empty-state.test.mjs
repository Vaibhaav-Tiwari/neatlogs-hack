import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backlogSource, ledgerEmptyState } from './empty-state.js';

const run = (over = {}) => ({
  status: 'finished',
  repo: 'acme/payments-service',
  budget: { spentNanos: 0 },
  tasks: [],
  integrations: { github: { status: 'ok', detail: null } },
  ...over,
});
const pending = { taskId: 'T1', status: 'pending' };

test('a label that matched no issues is named, with the gh commands to fix it', () => {
  const html = ledgerEmptyState(run({ backlog: { source: 'github-issues', issueLabel: 'tally-work' } }), []);
  assert.ok(html.includes('No issues matched the label'));
  assert.ok(html.includes('>tally-work</b>'));
  assert.ok(html.includes("gh issue list --repo acme/payments-service --label &#39;tally-work&#39; --state open"));
  assert.ok(html.includes("gh issue edit &lt;issue-number&gt; --repo acme/payments-service --add-label &#39;tally-work&#39;"));
  assert.ok(html.includes('spent nothing'));
});

test('run files without a recorded label point at tally.yaml and use a placeholder', () => {
  const html = ledgerEmptyState(run(), []);
  assert.ok(html.includes('backlog.issueLabel'));
  assert.ok(html.includes('--add-label &lt;label&gt;'));
});

test('labels and repositories from the run file cannot inject markup or a second command', () => {
  const html = ledgerEmptyState(run({ repo: 'x; rm -rf ~', backlog: { source: 'github-issues', issueLabel: `a'<b>` } }), []);
  assert.ok(!html.includes('<b>`'));
  assert.ok(!html.includes('--repo'));
  assert.ok(html.includes('&#39;a&#39;\\&#39;&#39;&lt;b&gt;&#39;'));
});

test('a file backlog with no tasks says so instead of blaming a label', () => {
  assert.equal(backlogSource(run({ integrations: { github: { status: 'off' } } })), 'file');
  const html = ledgerEmptyState(run({ backlog: { source: 'file', file: 'backlog.yaml' } }), []);
  assert.ok(html.includes('No tasks in the backlog') && html.includes('backlog.yaml'));
});

test('a first run with tasks listed and no worker started explains the wait', () => {
  assert.ok(ledgerEmptyState(run({ status: 'running', tasks: [pending, pending] }), []).includes('listed 2 tasks'));
  assert.ok(ledgerEmptyState(run({ status: 'running' }), []).includes('No tasks listed yet'));
  assert.ok(ledgerEmptyState(run({ status: 'interrupted', tasks: [pending] }), []).includes('was interrupted'));
});

test('runs with work recorded need no explanation', () => {
  assert.equal(ledgerEmptyState(run({ tasks: [pending] }), [{ taskId: 'T1' }]), '');
  assert.equal(ledgerEmptyState(run({ tasks: [{ taskId: 'T1', status: 'skipped' }] }), []), '');
});
