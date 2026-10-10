/**
 * The routing rule: which tier a task starts on.
 *
 * A task goes to a cheaper tier only when
 *
 *     cheap ceiling + P(cheap fails) x top cost  <  top cost
 *
 * and the sizer is confident enough in what the task is. Otherwise it goes
 * to a stronger tier. Nothing starts unless its ceiling fits the budget left.
 */
import { ceilingNanos, nanosToUsd } from '../schema/money.js';
import type { TallyConfig, TaskSize, Tier } from '../schema/types.js';
import { DEFAULT_PRIOR_WEIGHT, estimateFor, tierRank } from './history.js';
import type { BudgetPort, PriceHistoryPort, TaskInput, TraceAttributes, TracePort } from './ports.js';
import type { SizeEstimate } from './sizer.js';
import { traceDecision } from './trace.js';

export interface RoutingOptions {
  /**
   * Confidence the cheapest tier needs. Tiers in between need proportionally
   * less, and the strongest tier needs none.
   */
  cheapConfidence: number;
  /** How many observed attempts the prior is worth. */
  priorWeight: number;
  /**
   * When the budget rules out the preferred tier, a cheaper one is tried
   * only if it is expected to pass at least this often.
   */
  minPassRateOnTightBudget: number;
}

export const DEFAULT_ROUTING: RoutingOptions = {
  cheapConfidence: 0.65,
  priorWeight: DEFAULT_PRIOR_WEIGHT,
  minPassRateOnTightBudget: 0.5,
};

export interface StartDecision {
  action: 'start';
  taskId: string;
  size: TaskSize;
  confidence: number;
  /** The tier to run, straight from tally.yaml. */
  tier: Tier;
  /** Spend ceiling for the attempt. Null means no ceiling (baseline mode only). */
  ceilingNanos: number | null;
  /** Ceiling plus the chance of failing times the top cost; for the top tier, its estimated cost. */
  expectedCostNanos: number;
  /** Estimated cost of sending this task straight to the strongest tier. */
  topCostNanos: number;
  /** One plain-English sentence, shown on the dashboard and stored on the ledger row. */
  reason: string;
}

export interface SkipDecision {
  action: 'skip';
  taskId: string;
  size: TaskSize;
  confidence: number;
  /** Goes into TaskState.statusReason. */
  statusReason: 'not started: no budget';
  reason: string;
}

export type RouteDecision = StartDecision | SkipDecision;

export interface RouteInput {
  task: TaskInput;
  estimate: SizeEstimate;
  config: TallyConfig;
  ports: { history?: PriceHistoryPort; budget: BudgetPort; trace?: TracePort };
  options?: Partial<RoutingOptions>;
  traceAttributes?: TraceAttributes;
}

export function usd(nanos: number): string {
  return `$${nanosToUsd(nanos).toFixed(2)}`;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface Candidate {
  tier: Tier;
  ceiling: number;
  passRate: number;
  expected: number;
  neededConfidence: number;
  worthIt: boolean;
  confident: boolean;
  fits: boolean;
}

async function routeTaskCore(input: RouteInput): Promise<RouteDecision> {
  const { task, estimate, config } = input;
  const options = { ...DEFAULT_ROUTING, ...input.options };
  const { size, confidence } = estimate;
  const top = config.tiers[config.tiers.length - 1];
  if (!top) throw new Error('tally.yaml has no tiers');

  const remaining = Math.max(0, await input.ports.budget.remainingNanos());
  const topCost = (await estimateFor(config, input.ports.history, size, top.name, options.priorWeight)).avgCostNanos;
  const topCeiling = ceilingNanos(config, size, top);
  const subject = `${size} task with ${estimate.summary}`;
  const common = { taskId: task.taskId, size, confidence };

  const cheaper: Candidate[] = [];
  for (const tier of config.tiers.slice(0, -1)) {
    const { passRate } = await estimateFor(config, input.ports.history, size, tier.name, options.priorWeight);
    const ceiling = ceilingNanos(config, size, tier);
    const expected = Math.round(ceiling + (1 - passRate) * topCost);
    const neededConfidence = options.cheapConfidence * (1 - tierRank(config, tier.name));
    cheaper.push({
      tier,
      ceiling,
      passRate,
      expected,
      neededConfidence,
      worthIt: expected < topCost,
      confident: confidence >= neededConfidence,
      fits: ceiling <= remaining,
    });
  }

  // Why the tiers below the chosen one were passed over, most telling first.
  const passedOver = (below: Candidate[]): string | null => {
    const unsure = below.find((c) => c.worthIt && !c.confident);
    if (unsure) {
      return `${capitalise(subject)} is too uncertain for ${unsure.tier.name} (confidence ${confidence.toFixed(2)} of ${unsure.neededConfidence.toFixed(2)} needed)`;
    }
    const failing = below.find((c) => !c.worthIt);
    if (failing) {
      return `${capitalise(failing.tier.name)} is expected to fail ${percent(1 - failing.passRate)} of ${size} tasks, too often for an attempt capped at ${usd(failing.ceiling)} to beat ${usd(topCost)} on ${top.name}`;
    }
    return null;
  };

  const chosenIndex = cheaper.findIndex((c) => c.worthIt && c.confident && c.fits);
  const chosen = cheaper[chosenIndex];
  if (chosen) {
    const why = passedOver(cheaper.slice(0, chosenIndex));
    const odds = `expected to cost ${usd(chosen.expected)} against ${usd(topCost)} for going straight to ${top.name}`;
    const reason = why
      ? `${why}, so it starts on ${chosen.tier.name} capped at ${usd(chosen.ceiling)}, ${odds}.`
      : `${capitalise(subject)}, so a ${chosen.tier.name} attempt capped at ${usd(chosen.ceiling)} is ${odds}.`;
    return {
      ...common,
      action: 'start',
      tier: chosen.tier,
      ceilingNanos: chosen.ceiling,
      expectedCostNanos: chosen.expected,
      topCostNanos: topCost,
      reason,
    };
  }

  if (topCeiling <= remaining) {
    const why = passedOver(cheaper);
    const ending = `${top.name} with a ${usd(topCeiling)} ceiling`;
    return {
      ...common,
      action: 'start',
      tier: top,
      ceilingNanos: topCeiling,
      expectedCostNanos: topCost,
      topCostNanos: topCost,
      reason: why
        ? `${why}, so it goes straight to ${ending}.`
        : `${capitalise(subject)} goes to ${ending}, the only tier configured.`,
    };
  }

  // The preferred tier does not fit. Take the strongest one that does, if it has a fair chance.
  const fallback = [...cheaper]
    .reverse()
    .find((c) => c.fits && c.passRate >= options.minPassRateOnTightBudget);
  if (fallback) {
    return {
      ...common,
      action: 'start',
      tier: fallback.tier,
      ceilingNanos: fallback.ceiling,
      expectedCostNanos: fallback.expected,
      topCostNanos: topCost,
      reason: `Only ${usd(remaining)} of budget is left, which does not cover the ${usd(topCeiling)} ceiling on ${top.name}, so this ${size} task gets a ${fallback.tier.name} attempt capped at ${usd(fallback.ceiling)}.`,
    };
  }

  const smallest = Math.min(topCeiling, ...cheaper.map((c) => c.ceiling));
  return {
    ...common,
    action: 'skip',
    statusReason: 'not started: no budget',
    reason:
      smallest > remaining
        ? `Not started because only ${usd(remaining)} of budget is left and the smallest ceiling for this ${size} task is ${usd(smallest)}.`
        : `Not started because only ${usd(remaining)} of budget is left, and no tier that fits it is likely to finish this ${size} task.`,
  };
}

export async function routeTask(input: RouteInput): Promise<RouteDecision> {
  return traceDecision(
    input.ports.trace,
    'tally.route',
    { ...input.traceAttributes, taskId: input.task.taskId, size: input.estimate.size, confidence: input.estimate.confidence },
    async (span) => {
      const decision = await routeTaskCore(input);
      span.set({
        action: decision.action,
        tier: decision.action === 'start' ? decision.tier.name : null,
        ceilingNanos: decision.action === 'start' ? decision.ceilingNanos : null,
        reason: decision.reason,
      });
      return decision;
    },
  );
}
