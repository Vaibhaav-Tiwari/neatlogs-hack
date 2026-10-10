import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionEvidence } from './session-evidence.js';
test('ordinary browsers get selectable session ids, Copy and no AO link', () => {
  const html = sessionEvidence('session-1', { project: 'my project' });
  assert.ok(!html.includes('ao://'));
  assert.ok(html.includes('data-copy-session="session-1"'));
  assert.ok(html.includes('open in Agent Orchestrator'));
});
test('only explicitly identified AO host gets an encoded canonical link', () => {
  assert.ok(sessionEvidence('session/1', { project: 'my project', insideAO: true }).includes('ao://sessions/my%20project/session%2F1'));
  assert.ok(!sessionEvidence('session-1', { insideAO: true }).includes('ao://'));
  assert.ok(!sessionEvidence('<unsafe>', {}).includes('<unsafe>'));
  assert.equal(sessionEvidence(null), '');
});
