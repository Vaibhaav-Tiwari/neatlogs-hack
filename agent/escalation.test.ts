import { describe, expect, it } from 'vitest';
import { usdToNanos } from '../schema/money.js';
import { decideEscalation, type EscalationDecision, type FinishedAttempt } from './escalation.js';
import { FakeBudget, FakeHandoff, RecordingTrace, sampleConfig } from './testing/fakes.js';

const config = sampleConfig();

const previous = (overrides: Partial<FinishedAttempt> = {}): FinishedAttempt => ({
  attemptId: 'run-1:T1:1',
  taskId: 'T1',
  attempt: 1,
  size: 'medium',
  tier: 'bronze',
  result: 'stopped',
  sessionId: 'sess-1',
  ...overrides,
});

const entire = () => new FakeHandoff({ type: 'entire-handoff', summary: 'Parser done; retry test still red.' });
const NO_HANDOFF = Symbol('NO_HANDOFF');

async function decide(
  attempt: FinishedAttempt,
  budgetUsd = 40,
  handoff: FakeHandoff | typeof NO_HANDOFF = entire(),
  cfg = config,
): Promise<EscalationDecision> {
  return decideEscalation({
    previous: attempt,
    config: cfg,
    ports: { budget: new FakeBudget(usdToNanos(budgetUsd)), ...(handoff !== NO_HANDOFF ? { handoff } : {}) },
  });
}

function escalated(decision: EscalationDecision) {
  if (decision.action !== 'escalate') throw new Error(`expected an escalation, got: ${decision.reason}`);
  return decision;
}

function expectOneSentence(reason: string): void {
  expect(reason).toMatch(/^[A-Z].*\.$/);
  expect(reason).not.toMatch(/[.!?]\s/);
}

describe('decideEscalation', () => {
  it('moves a stopped attempt one tier up, carrying the handoff summary', async () => {
    const decision = escalated(await decide(previous()));
    expect(decision.tier.name).toBe('silver');
    expect(decision.attempt).toBe(2);
    expect(decision.ceilingNanos).toBe(usdToNanos(2));
    expect(decision.escalatedFrom).toBe('run-1:T1:1');
    expect(decision.handoff).toBe('entire-handoff');
    expect(decision.handoffSummary).toBe('Parser done; retry test still red.');
    expect(decision.reason).toBe(
      'Bronze attempt was stopped at its ceiling, so it escalates one tier to silver capped at $2.00, continuing from the Entire handoff summary with $40.00 of budget left.',
    );
  });

  it('moves a failed attempt one tier up', async () => {
    const decision = escalated(await decide(previous({ result: 'failed', tier: 'silver' })));
    expect(decision.tier.name).toBe('gold');
    expect(decision.reason).toMatch(/^Silver attempt failed its tests/);
  });

  it('moves exactly one tier, never straight to the top', async () => {
    expect(escalated(await decide(previous({ size: 'small' }))).tier.name).toBe('silver');
  });

  it('escalates at most once per task', async () => {
    const decision = await decide(previous({ attempt: 2, attemptId: 'run-1:T1:2', tier: 'silver', result: 'failed' }));
    expect(decision).toMatchObject({ action: 'give-up', statusReason: 'failed: already escalated once' });
  });

  it('gives up when there is no stronger tier', async () => {
    const decision = await decide(previous({ tier: 'gold', result: 'failed' }));
    expect(decision).toMatchObject({ action: 'give-up', statusReason: 'failed: no stronger tier' });
  });

  it('gives up when the next ceiling does not fit the budget left', async () => {
    const decision = await decide(previous(), 1.99);
    expect(decision).toMatchObject({ action: 'give-up' });
    if (decision.action !== 'give-up') throw new Error('expected give-up decision');
    expect(decision.statusReason).toBe('failed: no budget to escalate (next ceiling $2.00, budget left $1.99)');
    expect(decision.reason).toContain('$1.99');
    expect(escalated(await decide(previous(), 2)).tier.name).toBe('silver');
  });

  it('does not ask for a handoff summary it will not use', async () => {
    const handoff = entire();
    await decide(previous(), 0.5, handoff);
    expect(handoff.calls).toEqual([]);
  });

  it('does not escalate an attempt that passed or errored', async () => {
    expect((await decide(previous({ result: 'passed' }))).action).toBe('give-up');
    expect(await decide(previous({ result: 'error' }))).toMatchObject({
      action: 'give-up',
      statusReason: 'failed: attempt errored',
    });
  });

  describe('handoff type', () => {
    const restartCases: Array<[string, FakeHandoff | typeof NO_HANDOFF]> = [
      ['no summary exists', new FakeHandoff(null)],
      ['the summary is blank', new FakeHandoff({ type: 'entire-handoff', summary: '  ' })],
      ['the handoff port fails', new FakeHandoff(new Error('entire not enabled'))],
      ['there is no handoff port', NO_HANDOFF],
    ];

    it.each(restartCases)('is restart when %s', async (_label, handoff) => {
      const decision = escalated(await decide(previous(), 40, handoff));
      expect(decision.handoff).toBe('restart');
      expect(decision.handoffSummary).toBeNull();
      expect(decision.reason).toMatch(/restarting from the issue/);
    });

    it('is restart when the failed attempt had no session', async () => {
      const handoff = entire();
      const decision = escalated(await decide(previous({ sessionId: null }), 40, handoff));
      expect(decision.handoff).toBe('restart');
      expect(handoff.calls).toEqual([]);
    });
  });

  it('gives a one-sentence reason for every outcome', async () => {
    for (const result of ['passed', 'failed', 'stopped', 'error'] as const) {
      for (const tier of ['bronze', 'silver', 'gold']) {
        for (const attempt of [1, 2]) {
          for (const budgetUsd of [0, 40]) {
            expectOneSentence((await decide(previous({ result, tier, attempt }), budgetUsd)).reason);
          }
        }
      }
    }
  });

  it('rejects a tier that is not in the config', async () => {
    await expect(decide(previous({ tier: 'platinum' }))).rejects.toThrow(/platinum/);
  });

  it('traces the escalation decision when a trace port is provided', async () => {
    const trace = new RecordingTrace();
    const decision = await decideEscalation({
      previous: previous(),
      config,
      ports: { budget: new FakeBudget(usdToNanos(40)), handoff: entire(), trace },
    });
    expect(decision.action).toBe('escalate');
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]).toMatchObject({
      name: 'tally.escalate',
      attributes: { taskId: 'T1', size: 'medium', attempt: 1, fromTier: 'bronze', result: 'stopped', action: 'escalate', tier: 'silver' },
      error: null,
    });
  });
});
