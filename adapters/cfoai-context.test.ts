import { describe, expect, it } from 'vitest';
import { buildCfoaiTaskContext, repriceTokenUsage } from './cfoai-context.js';
import type { LedgerRow, Tier } from '../schema/types.js';

const tiers: Tier[] = [
  { name: 'cheap', harness: 'codex', sessionMode: 'tui', provider: 'openai', model: 'gpt-cheap', price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 5 }, ceilingFraction: 0.2 },
  { name: 'top', harness: 'codex', sessionMode: 'tui', provider: 'openai', model: 'gpt-top', price: { inputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.4, outputUsdPerMTok: 20 }, ceilingFraction: 1 },
];

const row: LedgerRow = {
  schemaVersion: 1, attemptId: 'run-1:T-1:2', runId: 'run-1', taskId: 'T-1', taskTitle: 'Repair budget display', attempt: 2,
  size: 'medium', tier: 'top', model: 'gpt-top', harness: 'codex', sessionId: 'session-1', branch: 'tally/t-1', baseCommit: 'abc',
  tallyCommit: 'def456',
  tokens: { uncachedInput: 100_000, cachedInput: 50_000, output: 10_000, cacheWrite5m: 2_000, cacheWrite1h: 1_000, total: 163_000 }, estimatedCostNanos: 650_000_000,
  costSource: 'list-price', price: tiers[1]!.price, priceNote: 'Configured base list price.', ceilingNanos: 2_000_000_000,
  result: 'passed', resultReason: 'verified. Authorization: Bearer should-not-leak', failureAssessment: undefined,
  escalatedFrom: 'run-1:T-1:1', handoff: 'restart', handoffText: null, prUrl: 'https://github.com/acme/app/pull/2',
  traceId: 'a'.repeat(32), traceUrl: 'https://app.neatlogs.com/trace/decision', workerTraceId: null, workerTraceUrl: null,
  checkpointId: 'checkpoint-2', checkpointUrl: 'https://entire.io/session/checkpoint-2', decision: 'Escalated after verification failed.',
  startedAt: '2026-10-12T09:00:00.000Z', endedAt: '2026-10-12T09:05:00.000Z',
};

describe('buildCfoaiTaskContext', () => {
  it('builds a useful, bounded Ari report from the attempt ledger and current rates', () => {
    const report = buildCfoaiTaskContext({ row, repo: 'acme/app', runId: 'run-1', scenario: 'Tally E2E', contextPageName: 'Tally',
      contextPageUrl: 'https://app.cfo.ai/s/tally', runLimitNanos: 5_000_000_000,
      runLimitSource: 'cli', runSpentNanos: 1_000_000_000, budgetSource: 'cfoai', spendTableWriteStatus: 'ok',
      monthlyLimitNanos: 10_000_000_000, monthlySpentBeforeRunNanos: 2_000_000_000,
      tiers, sizingConfidence: 0.78, issueUrl: 'https://github.com/acme/app/issues/1', budgetTableUrl: 'https://app.cfo.ai/s/budget', spendTableUrl: 'https://app.cfo.ai/s/detail' });
    expect(report.content).toContain('uncached input 100000, cached input 50000, cache creation 5m 2000, cache creation 1h 1000, output 10000, total 163000');
    expect(report.content).toContain('cheap: codex / gpt-cheap');
    expect(report.content).toContain('sizing confidence 78%');
    expect(report.content).toContain('Verification: passed');
    expect(report.content).toContain('Tally task commit: `def456`');
    expect(report.content).toContain('Monthly spend including this run so far: $3.000000000');
    expect(report.content).toContain('https://github.com/acme/app/pull/2');
    expect(report.content).toContain('https://entire.io/session/checkpoint-2');
    expect(report.content).toContain('https://app.neatlogs.com/trace/decision');
    expect(report.content).toContain('https://app.cfo.ai/s/detail');
    expect(report.content).toContain('cfo.ai scenario: Tally E2E');
    expect(report.content).toContain('https://app.cfo.ai/s/tally');
    expect(report.content).not.toContain('should-not-leak');
    expect(report.content).not.toContain('source code snippet');
    expect(Buffer.byteLength(report.content, 'utf8')).toBeLessThanOrEqual(30_000);
    expect(report).toMatchObject({ filename: expect.stringMatching(/^tally-run-1-attempt-[0-9a-f]{16}\.md$/),
      tags: ['tally', 'tally-scenario-tally-e2e', 'tally-run-run-1', 'tally-task-t-1', expect.stringMatching(/^tally-attempt-/)],
      idempotencyKey: expect.stringMatching(/^tally-attempt-[0-9a-f]{64}$/) });
  });

  it('uses stable idempotency identity for retry-safe external writes', () => {
    const input = { row, repo: 'acme/app', runId: 'run-1', runLimitNanos: 5_000_000_000,
      runLimitSource: 'cli' as const, runSpentNanos: 1_000_000_000, budgetSource: 'cfoai' as const, spendTableWriteStatus: 'ok' as const,
      monthlyLimitNanos: 10_000_000_000, monthlySpentBeforeRunNanos: 2_000_000_000, tiers };
    expect(buildCfoaiTaskContext(input).idempotencyKey).toBe(buildCfoaiTaskContext(input).idempotencyKey);
  });

  it('reprices cache reads and cache creation arithmetically for a candidate tier', () => {
    expect(repriceTokenUsage(row.tokens, tiers[0]!.price)).toBe(159_500_000);
    expect(repriceTokenUsage(row.tokens, tiers[1]!.price)).toBe(638_000_000);
  });
});
