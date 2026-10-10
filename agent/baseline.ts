/**
 * Baseline mode: the "before" side of the comparison. Every task goes to the
 * strongest tier with no ceiling. Sizing still runs so ledger rows carry a
 * size, but it has no say in the decision.
 */
import { estimateFor } from './history.js';
import { usd, type RouteDecision, type RouteInput } from './router.js';
import { traceDecision } from './trace.js';

export async function routeBaseline(input: RouteInput): Promise<RouteDecision> {
  return traceDecision(
    input.ports.trace,
    'tally.baseline.route',
    { ...input.traceAttributes, taskId: input.task.taskId, size: input.estimate.size, confidence: input.estimate.confidence },
    async (span) => {
      const { task, estimate, config } = input;
      const top = config.tiers[config.tiers.length - 1];
      if (!top) throw new Error('tally.yaml has no tiers');
      const common = { taskId: task.taskId, size: estimate.size, confidence: estimate.confidence };

      const remaining = await input.ports.budget.remainingNanos();
      if (remaining <= 0) {
        const decision = {
          ...common,
          action: 'skip' as const,
          statusReason: 'not started: no budget' as const,
          reason: `Not started because the budget is spent, with ${usd(Math.max(0, remaining))} left.`,
        };
        span.set({ action: decision.action, tier: null, ceilingNanos: null, reason: decision.reason });
        return decision;
      }
      const topCost = (await estimateFor(config, input.ports.history, estimate.size, top.name)).avgCostNanos;
      const decision = {
        ...common,
        action: 'start' as const,
        tier: top,
        ceilingNanos: null,
        expectedCostNanos: topCost,
        topCostNanos: topCost,
        reason: `Baseline mode sends every task straight to ${top.name} with no ceiling, so this ${estimate.size} task is not routed.`,
      };
      span.set({ action: decision.action, tier: top.name, ceilingNanos: null, reason: decision.reason });
      return decision;
    },
  );
}
