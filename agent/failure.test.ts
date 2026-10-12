import { describe, expect, it } from 'vitest';
import { diagnoseAttempt, type FailureKind, type FailureSpan, type FailureTracePort } from './failure.js';
import { decideEscalation } from './escalation.js';
import { FakeBudget, sampleConfig } from './testing/fakes.js';

const previous = {
  attemptId: 'run-1:T1:1', taskId: 'T1', attempt: 1, result: 'failed' as const,
  tier: 'bronze', size: 'small' as const, sessionId: 'ao-1', workerTraceId: 'a'.repeat(32),
};

const span = (error: string, overrides: Partial<FailureSpan> = {}): FailureSpan => ({
  id: 's1', name: 'Bash', type: 'TOOL', status: 'ERROR', error, startedAt: '2026-10-12T01:00:00Z', ...overrides,
});
const port = (...spans: FailureSpan[]): FailureTracePort => ({
  failureFor: async () => ({ traceId: 'a'.repeat(32), spans }),
});

describe('worker trace failure diagnosis', () => {
  it.each<[FailureKind, string, boolean]>([
    ['ceiling', 'budget exhausted', true],
    ['tool-failure', 'command not found', false],
    ['tests-failed', 'AssertionError: failed', true],
    ['permission-refused', 'permission denied', false],
    ['model-unavailable', 'model unavailable', false],
  ])('classifies %s from explicit trace evidence', async (kind, error, retryable) => {
    expect(await diagnoseAttempt(previous, port(span(error)))).toMatchObject({
      kind, retryable, source: 'neatlogs', spans: ['s1'], traceId: 'a'.repeat(32),
    });
  });

  it('does not mistake a recovered refusal for a persistent wall', async () => {
    const diagnosis = await diagnoseAttempt(previous, port(
      span('permission denied'),
      span('', { id: 's2', status: 'OK', startedAt: '2026-10-12T01:00:01Z' }),
    ));
    expect(diagnosis).toMatchObject({ kind: 'tests-failed', source: 'ledger', retryable: true });
    expect(diagnosis.detail).toContain('no explicit unrecovered failure signal');
  });

  it('never classifies a prompt or successful span as a failure', async () => {
    expect(await diagnoseAttempt(previous, port(
      span('permission denied', { type: 'WORKFLOW' }), span('model unavailable', { status: 'OK' }),
    ))).toMatchObject({ source: 'ledger' });
  });

  it.each([undefined, { failureFor: async () => null }, { failureFor: async () => { throw new Error('offline'); } }])(
    'keeps the ledger ceiling fallback when readback is unavailable', async (reader) => {
      expect(await diagnoseAttempt({ ...previous, result: 'stopped', resultReason: 'ceiling crossed: $0.01' }, reader))
        .toMatchObject({ kind: 'ceiling', source: 'ledger', retryable: true });
    },
  );

  it('does not persist command output or secrets as evidence', async () => {
    const diagnosis = await diagnoseAttempt(previous, port(span('permission denied: SECRET-value')));
    expect(JSON.stringify(diagnosis)).not.toContain('SECRET-value');
  });

  it.each(['permission denied', 'command not found'])('stops instead of escalating a shared wall: %s', async error => {
    const decision = await decideEscalation({
      previous, config: sampleConfig(), ports: { budget: new FakeBudget(40e9), failureTrace: port(span(error)) },
    });
    expect(decision.action).toBe('give-up');
    expect(decision.reason).toContain('stops without escalating');
  });

  it.each(['budget exhausted', 'AssertionError: failed'])('escalates a recoverable failure: %s', async error => {
    const decision = await decideEscalation({
      previous, config: sampleConfig(), ports: { budget: new FakeBudget(40e9), failureTrace: port(span(error)) },
    });
    expect(decision.action).toBe('escalate');
    expect(decision.reason).toContain('Neatlogs contains');
  });

  it('does not silently substitute an unavailable model from trace evidence', async () => {
    const decision = await decideEscalation({
      previous, config: sampleConfig(), ports: { budget: new FakeBudget(40e9), failureTrace: port(span('model unavailable')) },
    });
    expect(decision.action).toBe('give-up');
    expect(decision.reason).toContain('rather than silently substituting');
  });
});
