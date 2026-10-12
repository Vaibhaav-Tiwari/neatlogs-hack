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
import { formatUsd, nanosToUsd } from '../schema/money.js';
import type { TallyConfig, TaskSize, Tier } from '../schema/types.js';
import { DEFAULT_PRIOR_WEIGHT, estimateFor, priorFor } from './history.js';
import type { BudgetPort, PriceHistoryPort, TaskInput, TraceAttributes, TracePort } from './ports.js';
import { planFromHistory, type HistoryPlan } from './history-plan.js';
import type { SizeEstimate } from './sizer.js';
import { traceDecision } from './trace.js';

export interface RoutingOptions {
  /**
   * Kept for compatibility with older callers; routing now derives the
   * confidence needed for each cheaper tier from the expected-cost rule.
   */
  cheapConfidence?: number;
  /** How many observed attempts the prior is worth. */
  priorWeight: number;
  /** Observations needed before routing trusts a history cell over the prior. */
  minHistoryAttempts: number;
  /**
   * When the budget rules out the preferred tier, a cheaper one is tried
   * only if it is expected to pass at least this often.
   */
  minPassRateOnTightBudget: number;
}

export const DEFAULT_ROUTING: RoutingOptions = {
  priorWeight: DEFAULT_PRIOR_WEIGHT,
  minHistoryAttempts: 2,
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
  history?: HistoryPlan[];
}

export interface SkipDecision {
  action: 'skip';
  taskId: string;
  size: TaskSize;
  confidence: number;
  /** Goes into TaskState.statusReason. */
  statusReason: 'not started: no budget';
  reason: string;
  history?: HistoryPlan[];
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
  return formatUsd(nanos);
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
  avgCostNanos: number;
  attempts: number;
  source: 'history' | 'prior' | 'thin-history';
  expected: number;
  expectedOnPrior: number;
  neededConfidence: number;
  worthIt: boolean;
  worthItOnPrior: boolean;
  confident: boolean;
  fits: boolean;
  plan: HistoryPlan;
}

function neededConfidenceForRule(ceiling: number, passRate: number, topCost: number): number {
  if (ceiling <= 0) return 0;
  if (passRate <= 0 || topCost <= 0) return 1;
  return Math.min(1, ceiling / (passRate * topCost));
}

async function routeTaskCore(input: RouteInput): Promise<RouteDecision> {
  const { task, estimate, config } = input;
  const options = { ...DEFAULT_ROUTING, ...input.options };
  const { size, confidence } = estimate;
  const top = config.tiers[config.tiers.length - 1];
  if (!top) throw new Error('tally.yaml has no tiers');

  const remaining = Math.max(0, await input.ports.budget.remainingNanos());
  const topPlan = await planFromHistory(config, input.ports.history, size, top.name, options.minHistoryAttempts);
  const topPriorCost = (await estimateFor(config, undefined, size, top.name, options.priorWeight)).avgCostNanos;
  const topCost = topPlan.avgCostNanos;
  const topCeiling = topPlan.ceilingNanos;
  const subject = `${size} task with ${estimate.summary}`;
  const history: HistoryPlan[] = [topPlan];
  const common = { taskId: task.taskId, size, confidence, history };

  const cheaper: Candidate[] = [];
  for (const tier of config.tiers.slice(0, -1)) {
    const plan = await planFromHistory(config, input.ports.history, size, tier.name, options.minHistoryAttempts);
    history.push(plan);
    const prior = priorFor(config, size, tier.name);
    const ceiling = plan.ceilingNanos;
    const expected = Math.round(ceiling + (1 - plan.passRate) * topCost);
    const expectedOnPrior = Math.round(plan.configuredCeilingNanos + (1 - prior.passRate) * topPriorCost);
    const neededConfidence = neededConfidenceForRule(ceiling, plan.passRate, topCost);
    cheaper.push({
      tier,
      ceiling,
      passRate: plan.passRate,
      avgCostNanos: plan.avgCostNanos,
      attempts: plan.attempts,
      source: plan.usedPrior ? (plan.attempts ? 'thin-history' : 'prior') : 'history',
      plan,
      expected,
      expectedOnPrior,
      neededConfidence,
      worthIt: expected < topCost,
      worthItOnPrior: expectedOnPrior < topPriorCost,
      confident: confidence >= neededConfidence,
      fits: ceiling <= remaining,
    });
  }

  const historyNote = (candidate: Candidate): string | null => {
    if (candidate.source === 'thin-history') {
      return `History has only ${candidate.attempts} ${candidate.tier.name} attempt${candidate.attempts === 1 ? '' : 's'} for ${size}, so it uses the prior`;
    }
    if (candidate.source === 'prior') return `No usable history exists for ${candidate.tier.name} on ${size}, so it uses the prior`;
    if (candidate.worthIt !== candidate.worthItOnPrior) {
      return `History changed the choice for ${candidate.tier.name}: ${candidate.attempts} attempts show a ${percent(candidate.passRate)} pass rate and ${usd(candidate.avgCostNanos)} average cost`;
    }
    return `History for ${candidate.tier.name} uses ${candidate.plan.source}: ${candidate.attempts} observations, ${percent(candidate.passRate)} pass rate and ${usd(candidate.avgCostNanos)} average cost`;
  };

  // Why the tiers below the chosen one were passed over, most telling first.
  const passedOver = (below: Candidate[]): string | null => {
    const unsure = below.find((c) => c.worthIt && !c.confident);
    if (unsure) {
      const note = historyNote(unsure);
      const reason = `${subject} is too uncertain for ${unsure.tier.name} (confidence ${confidence.toFixed(2)} of ${unsure.neededConfidence.toFixed(2)} needed)`;
      return note ? `${note}; ${reason}` : capitalise(reason);
    }
    const failing = below.find((c) => !c.worthIt);
    if (failing) {
      const note = historyNote(failing);
      const reason = `${failing.tier.name} is expected to fail ${percent(1 - failing.passRate)} of ${size} tasks, too often for an attempt capped at ${usd(failing.ceiling)} to beat ${usd(topCost)} on ${top.name}`;
      return note ? `${note}; ${reason}` : capitalise(reason);
    }
    return null;
  };

  const chosenIndex = cheaper.findIndex((c) => c.worthIt && c.confident && c.fits);
  const chosen = cheaper[chosenIndex];
  if (chosen) {
    const why = passedOver(cheaper.slice(0, chosenIndex));
    const odds = `expected to cost ${usd(chosen.expected)} against ${usd(topCost)} for going straight to ${top.name}`;
    const note = historyNote(chosen);
    const reason = why
      ? `${why}, so it starts on ${chosen.tier.name} capped at ${usd(chosen.ceiling)}, ${odds}.`
      : note
        ? `${note}; ${subject} starts on ${chosen.tier.name} capped at ${usd(chosen.ceiling)}, ${odds}.`
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
      const notes = decision.history?.map((plan) => {
        const stats = plan.observedPassRate === null
          ? `${plan.tier} ${plan.source}: 0 observations, prior ${percent(plan.passRate)} pass rate and ${usd(plan.avgCostNanos)} average cost`
          : `${plan.tier} ${plan.source}: ${plan.attempts} observations, ${percent(plan.observedPassRate)} pass rate, ${usd(plan.observedAvgCostNanos!)} average cost`;
        const cap = plan.capSource === 'successful-p90'
          ? `cap ${usd(plan.ceilingNanos)} from P90 ${usd(plan.p90CostNanos!)} x 1.5 over ${plan.successfulSamples} successful samples, max ${usd(plan.configuredCeilingNanos)}`
          : `config cap ${usd(plan.ceilingNanos)} (${plan.successfulSamples} successful samples; 5 needed)`;
        return `${stats}, ${plan.usedPrior ? 'uses the prior' : 'observed statistics'}, ${cap}, model ${plan.model} only (unknown-model observations excluded)`;
      });
      if (notes?.length) decision.reason = `${decision.reason.replace(/\.$/, '')}; ${notes.join('; ')}.`;
      span.set({
        action: decision.action,
        tier: decision.action === 'start' ? decision.tier.name : null,
        ceilingNanos: decision.action === 'start' ? decision.ceilingNanos : null,
        reason: decision.reason,
        history: JSON.stringify(decision.history ?? []),
      });
      return decision;
    },
  );
}
