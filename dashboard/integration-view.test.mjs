import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integrationView } from './integration-view.js';

test('the dashboard keeps connected Entire status when optional hosted recall is unavailable', () => {
  const [entire] = integrationView({ integrations: {
    entire: { status: 'ok', detail: 'Graph sizing: ok; checkpoint recall unavailable: repository not mirrored to Entire.' },
  } });
  assert.equal(entire.statusLabel, 'on');
  assert.match(entire.detail, /checkpoint recall unavailable/);
});

test('the dashboard summarizes successful Entire graph and checkpoint checks', () => {
  const [entire] = integrationView({ integrations: {
    entire: { status: 'ok', detail: 'Graph sizing: ok (Graph search available; no matching target symbols, sizing from repository evidence.); checkpoint search available' },
  } });
  assert.equal(entire.statusLabel, 'on');
  assert.equal(entire.detail, 'Graph sizing and checkpoint search are available.');
});

test('the dashboard shows CFO status, Ari context, and a safe table link together', () => {
  const [cfoai] = integrationView({ budget: { cfoai: {
    pageUrl: 'https://app.cfo.ai/s/scenario', tableUrl: 'https://app.cfo.ai/s/budget-table',
  } }, integrations: {
    cfoai: { status: 'ok', detail: 'https://app.cfo.ai/s/budget https://app.cfo.ai/s/detail Ari task context was shared with organization memory.' },
  } });
  assert.equal(cfoai.statusLabel, 'on');
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
  assert.equal(cards[0].statusLabel, 'on');
  assert.equal(cards[0].detail, 'Routing trace recorded. No matching Neatlogs price history for small/middle model gpt-5.6-terra (unknown-model observations excluded). Tally used local history. Trace links appear in the attempt ledger.');
  assert.doesNotMatch(cards[0].detail, /;/);
});
