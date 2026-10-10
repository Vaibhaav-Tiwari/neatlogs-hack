import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyableIdEvidence } from './session-evidence.js';
import { reasonText } from './reason-text.js';

test('evidence keeps complete selectable ids, hover values and copy payloads', () => {
  const id = '0123456789abcdef0123456789abcdef01234567';
  const html = copyableIdEvidence('checkpoint', id);
  assert.ok(html.includes(`title="${id}"`));
  assert.ok(html.includes(`data-copy-id="${id}"`));
  assert.ok(html.includes(`>${id}</code>`));
  assert.ok(!copyableIdEvidence('trace', '<unsafe>').includes('<unsafe>'));
  assert.equal(copyableIdEvidence('trace', null), '');
});

test('commit hashes shorten to seven characters with full hover text and escaped reasons', () => {
  const hash = 'bc7529d374e7135b6b07fede0b7965db6a5be9b1';
  const html = reasonText(`Stopped; committed as ${hash}. <script>`);
  assert.ok(html.includes(`title="${hash}">bc7529d</abbr>`));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(reasonText('short id abcdef0'), 'short id abcdef0');
});
