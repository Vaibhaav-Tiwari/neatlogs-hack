import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetPageUrl } from './budget-link.js';
test('only dedicated non-placeholder HTTPS page fields become links', () => {
  assert.equal(budgetPageUrl({ cfoai: { pageUrl: 'https://app.cfo.ai/scenario', tableUrl: 'https://app.cfo.ai/budget/view' } }), 'https://app.cfo.ai/budget/view');
  assert.equal(budgetPageUrl({ cfoai: { tableUrl: 'https://app.cfo.ai/budget/view' } }), 'https://app.cfo.ai/budget/view');
  for (const pageUrl of ['https://app.cfo.ai/s/example-budget-table', '<page-url>', 'javascript:alert(1)', 'http://app.cfo.ai/table', 'https://user:secret@app.cfo.ai/table']) assert.equal(budgetPageUrl({ cfoai: { pageUrl } }), null);
  assert.equal(budgetPageUrl({ detail: 'https://app.cfo.ai/chat' }), null);
  assert.equal(budgetPageUrl({}), null);
});
