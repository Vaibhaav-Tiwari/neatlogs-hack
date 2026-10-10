import { describe, expect, it } from 'vitest';
import { usdToNanos } from '../schema/money.js';
import { routeBaseline } from './baseline.js';
import { decideEscalation } from './escalation.js';
import { routeTask } from './router.js';
import type { SizeEstimate } from './sizer.js';
import { FakeBudget, FakeHistory, RecordingTrace, sampleConfig, task } from './testing/fakes.js';

const config = sampleConfig();

const estimate = (size: SizeEstimate['size'], confidence: number): SizeEstimate => ({
  size,
  confidence,
  signals: null,
  specificity: 0,
  refinedBy: 'rules',
  summary: 'no sizing signals',
  recall: null,
});

describe('routeBaseline', () => {
  it('sends every task to the top tier with no ceiling, whatever the routing rule would say', async () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      for (const confidence of [0, 0.5, 1]) {
        const input = { task: task(), estimate: estimate(size, confidence), config, ports: { budget: new FakeBudget(usdToNanos(40)) } };
        const decision = await routeBaseline(input);
        expect(decision).toMatchObject({ action: 'start', ceilingNanos: null });
        if (decision.action === 'start') expect(decision.tier).toBe(config.tiers[2]);
      }
    }
    // The same confident small task would have gone cheap under the rule.
    const input = { task: task(), estimate: estimate('small', 1), config, ports: { budget: new FakeBudget(usdToNanos(40)) } };
    const routed = await routeTask(input);
    expect(routed.action === 'start' && routed.tier.name).toBe('bronze');
  });

  it('ignores the price history', async () => {
    const history = new FakeHistory().set('small', 'gold', { attempts: 1000, passRate: 0, avgCostNanos: usdToNanos(99) });
    const decision = await routeBaseline({
      task: task(),
      estimate: estimate('small', 1),
      config,
      ports: { history, budget: new FakeBudget(usdToNanos(40)) },
    });
    expect(decision.action).toBe('start');
  });

  it('starts even when the top ceiling would not fit, because baseline has no ceilings', async () => {
    const decision = await routeBaseline({
      task: task(),
      estimate: estimate('large', 0.5),
      config,
      ports: { budget: new FakeBudget(usdToNanos(1)) },
    });
    expect(decision.action).toBe('start');
  });

  it('starts nothing once the budget is gone', async () => {
    const decision = await routeBaseline({
      task: task(),
      estimate: estimate('small', 1),
      config,
      ports: { budget: new FakeBudget(0) },
    });
    expect(decision).toMatchObject({ action: 'skip', statusReason: 'not started: no budget' });
  });

  it('says in one sentence that it is the baseline', async () => {
    const decision = await routeBaseline({
      task: task(),
      estimate: estimate('medium', 0.2),
      config,
      ports: { budget: new FakeBudget(usdToNanos(40)) },
    });
    expect(decision.reason).toBe('Baseline mode sends every task straight to gold with no ceiling, so this medium task is not routed.');
  });

  it('leaves nothing to escalate to when a baseline attempt fails', async () => {
    const decision = await decideEscalation({
      previous: { attemptId: 'r:T1:1', taskId: 'T1', attempt: 1, size: 'small', tier: 'gold', result: 'failed', sessionId: 's' },
      config,
      ports: { budget: new FakeBudget(usdToNanos(40)) },
    });
    expect(decision.action).toBe('give-up');
  });

  it('traces the baseline routing decision when a trace port is provided', async () => {
    const trace = new RecordingTrace();
    const decision = await routeBaseline({
      task: task(),
      estimate: estimate('medium', 0.2),
      config,
      ports: { budget: new FakeBudget(usdToNanos(40)), trace },
    });
    expect(decision.action).toBe('start');
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]).toMatchObject({
      name: 'tally.baseline.route',
      attributes: { taskId: 'T1', size: 'medium', confidence: 0.2, action: 'start', tier: 'gold', ceilingNanos: null },
      error: null,
    });
  });
});
