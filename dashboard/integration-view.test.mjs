import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integrationView } from './integration-view.js';

test('the dashboard keeps connected Entire status when optional hosted recall is unavailable', () => {
  const [entire] = integrationView({ integrations: {
    entire: { status: 'ok', detail: 'Graph sizing: ok; checkpoint recall unavailable: repository not mirrored to Entire.' },
  } });
  assert.equal(entire.statusLabel, 'connected');
  assert.match(entire.detail, /checkpoint recall unavailable/);
});

test('the dashboard summarizes successful Entire graph and checkpoint checks', () => {
  const [entire] = integrationView({ integrations: {
    entire: { status: 'ok', detail: 'Graph sizing: ok (Graph search available; no matching target symbols, sizing from repository evidence.); checkpoint search available' },
  } });
  assert.equal(entire.statusLabel, 'connected');
  assert.equal(entire.detail, 'Graph sizing and checkpoint search are available.');
});

test('the dashboard shows CFO status, Ari context, and a safe table link together', () => {
  const [cfoai] = integrationView({ budget: { cfoai: {
    pageUrl: 'https://app.cfo.ai/s/scenario', tableUrl: 'https://app.cfo.ai/s/budget-table',
  } }, integrations: {
    cfoai: { status: 'ok', detail: 'https://app.cfo.ai/s/budget https://app.cfo.ai/s/detail Ari task context was shared with organization memory.' },
  } });
  assert.equal(cfoai.statusLabel, 'connected');
  assert.match(cfoai.detail, /Ari task context was shared/);
  assert.equal(cfoai.link.label, 'cfo.ai budget table');
  assert.equal(cfoai.link.url, 'https://app.cfo.ai/s/budget-table');
});

test('the dashboard lists Neatlogs and omits disabled Slack', () => {
  const cards = integrationView({ integrations: {
    neatlogs: { status: 'ok', detail: '857389b3abfd1cb8b7e18932ebc5d3ef; No usable Neatlogs price-history observations matched small/middle model gpt-5.6-terra (unknown-model observations excluded); using local history.' },
    slack: { status: 'off', detail: null },
  } }, [{ traceId: '857389b3abfd1cb8b7e18932ebc5d3ef', workerTraceId: 'trace-2' }]);
  assert.deepEqual(cards.map(card => card.name), ['neatlogs']);
  assert.equal(cards[0].statusLabel, 'connected');
  assert.equal(cards[0].detail, 'Routing trace recorded. No matching remote price history for small/middle model gpt-5.6-terra. Tally used local history. Trace links are in the attempt ledger.');
  assert.doesNotMatch(cards[0].detail, /;/);
});

test('the dashboard presents an indexing delay as a connected Neatlogs warning', () => {
  const [neatlogs] = integrationView({ integrations: {
    neatlogs: { status: 'ok', detail: 'No usable Neatlogs price-history observations matched small/middle model terra; using local history.; Neatlogs worker span read-back failed (HTTP 409).' },
  } }, [{ traceId: 'a'.repeat(32) }]);
  assert.equal(neatlogs.statusLabel, 'connected');
  assert.match(neatlogs.detail, /still being indexed/);
  assert.match(neatlogs.detail, /Trace links are in the attempt ledger/);
  assert.doesNotMatch(neatlogs.detail, /setup needed|not connected|HTTP 409/);
});

test('the dashboard repairs the status label for a saved run with a trace and a delayed span projection', () => {
  const [neatlogs] = integrationView({ integrations: {
    neatlogs: { status: 'missing', detail: `${'a'.repeat(32)}; No usable Neatlogs price-history observations matched small/middle model terra; using local history.; Neatlogs worker span read-back failed (HTTP 409).` },
  } }, [{ traceId: 'a'.repeat(32) }]);
  assert.equal(neatlogs.statusLabel, 'connected');
  assert.match(neatlogs.detail, /Routing trace recorded/);
  assert.match(neatlogs.detail, /still being indexed/);
});

test('the dashboard keeps cfo.ai connected when only the optional Ari context report is refused', () => {
  const [cfoai] = integrationView({ integrations: {
    cfoai: { status: 'ok', detail: 'Ari context report failed for 4 attempts: cfo.ai refused the Ari context write: organization memory access denied. Budget and spend tables remain connected; the local ledger is the source of truth.' },
  } });
  assert.equal(cfoai.statusLabel, 'connected');
  assert.match(cfoai.detail, /Ari context report failed for 4 attempts/);
  assert.match(cfoai.detail, /spend tables remain connected/);
});

test('the dashboard summarizes repeated Ari report failures in a saved legacy run', () => {
  const failure = 'Ari task-context write failed: cfo.ai refused the Ari context write. Local ledger and spend tables remain the source of truth for this attempt.';
  const [cfoai] = integrationView({ integrations: {
    cfoai: { status: 'error', detail: `${failure} ${failure} ${failure} ${failure}` },
  } });
  assert.equal(cfoai.statusLabel, 'connected');
  assert.match(cfoai.detail, /failed for 4 attempts/);
  assert.doesNotMatch(cfoai.detail, /Ari task-context write failed/);
});
