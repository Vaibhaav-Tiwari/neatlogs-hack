import { describe, expect, it } from 'vitest';
import { sampleConfig } from '../agent/testing/fakes.js';
import type { LedgerRow } from '../schema/index.js';
import { neatlogsTraceUrl } from '../adapters/evidence-links.js';
import { prEvidenceLinks } from './pr-evidence.js';

const row = {
  checkpointId: '01M4PROOF',
  checkpointUrl: 'https://entire.io/gh/acme/payments/session/session-1',
  entireSessionId: 'session-1',
  traceId: '0123456789abcdef0123456789abcdef',
  traceUrl: null,
  workerTraceId: 'fedcba9876543210fedcba9876543210',
  workerTraceUrl: null,
} as LedgerRow;

describe('PR evidence links', () => {
  it('builds app links only for enabled integrations and configured CFO evidence', () => {
    const config = sampleConfig();
    config.repo.slug = 'acme/payments';
    config.integrations = { neatlogs: true, entire: true, cfoai: true, slack: false };
    config.budget.cfoai = {
      tableUrl: 'https://app.cfo.ai/s/budget',
      spendDetailTableUrl: 'https://app.cfo.ai/s/spend',
    };
    expect(prEvidenceLinks(row, config)).toEqual([
      { label: 'Entire session and checkpoint', url: 'https://entire.io/gh/acme/payments/session/session-1', note: 'checkpoint 01M4PROOF' },
      { label: 'Neatlogs routing trace', url: 'https://app.neatlogs.com/traces/0123456789abcdef0123456789abcdef' },
      { label: 'Neatlogs worker trace', url: 'https://app.neatlogs.com/traces/fedcba9876543210fedcba9876543210' },
      { label: 'cfo.ai budget table', url: 'https://app.cfo.ai/s/budget' },
      { label: 'cfo.ai spend table', url: 'https://app.cfo.ai/s/spend' },
    ]);
  });

  it('does not create links when integration data is disabled, malformed, or absent', () => {
    const config = sampleConfig();
    config.repo.slug = 'bad-slug';
    config.integrations.entire = true;
    expect(prEvidenceLinks({ ...row, checkpointUrl: null, entireSessionId: null }, config)).toEqual([]);
    expect(neatlogsTraceUrl('not-a-trace')).toBeNull();
  });
});
