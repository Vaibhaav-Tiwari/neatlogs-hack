/**
 * Escalation: what happens after an attempt fails or is stopped at its
 * ceiling. The task moves one tier up, once, if the budget allows, and the
 * stronger tier is given the earlier attempt's handoff summary when there is
 * one.
 */
import { ceilingNanos } from '../schema/money.js';
import type { AttemptResult, CostSource, Handoff, TallyConfig, TaskSize, Tier, TokenUsage } from '../schema/types.js';
import type { BudgetPort, HandoffPort, TaskInput, TraceAttributes, TracePort } from './ports.js';
import { usd } from './router.js';
import { traceDecision } from './trace.js';

/** The attempt that just ended, as written on its ledger row. */
export interface FinishedAttempt {
  attemptId: string;
  taskId: string;
  /** 1 for the first attempt, 2 for the escalation. */
  attempt: number;
  size: TaskSize;
  /** Tier name from tally.yaml. */
  tier: string;
  result: AttemptResult;
  /** Null for simulated attempts. */
  sessionId: string | null;
  branch?: string | null;
  checkpointId?: string | null;
  resultReason?: string | null;
}

export interface EscalateDecision {
  action: 'escalate';
  taskId: string;
  size: TaskSize;
  attempt: 2;
  tier: Tier;
  ceilingNanos: number;
  /** attemptId of the attempt being taken over. */
  escalatedFrom: string;
  /** Goes on the escalated ledger row. */
  handoff: Exclude<Handoff, 'none'>;
  /** Text to give the stronger tier; null when it restarts from the issue. */
  handoffSummary: string | null;
  handoffSummaryCostNanos: number;
  handoffSummaryCostSource: CostSource;
  handoffSummaryTokens: TokenUsage;
  checkpointId: string | null;
  checkpointUrl: string | null;
  /** One plain-English sentence for the dashboard and the ledger row. */
  reason: string;
}

export interface GiveUpDecision {
  action: 'give-up';
  taskId: string;
  /** Goes into TaskState.statusReason. Null when the attempt passed and nothing is wrong. */
  statusReason: string | null;
  reason: string;
}

export type EscalationDecision = EscalateDecision | GiveUpDecision;

export interface EscalationInput {
  previous: FinishedAttempt;
  task?: TaskInput;
  config: TallyConfig;
  ports: { budget: BudgetPort; handoff?: HandoffPort; trace?: TracePort };
  traceAttributes?: TraceAttributes;
}

const HANDOFF_NAMES: Record<Exclude<Handoff, 'none' | 'restart'>, string> = {
  'entire-handoff': 'the Entire handoff summary',
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function decideEscalationCore(input: EscalationInput): Promise<EscalationDecision> {
  const { previous, config } = input;
  const index = config.tiers.findIndex((tier) => tier.name === previous.tier);
  if (index < 0) throw new Error(`Tier "${previous.tier}" is not in tally.yaml`);
  const from = capitalise(previous.tier);
  const giveUp = (statusReason: string | null, reason: string): GiveUpDecision => ({
    action: 'give-up',
    taskId: previous.taskId,
    statusReason,
    reason,
  });

  if (previous.result === 'passed') {
    return giveUp(null, `${from} attempt passed, so there is nothing to escalate.`);
  }
  if (previous.result === 'error') {
    return giveUp(
      'failed: attempt errored',
      `${from} attempt broke for a reason outside the model, so a stronger tier would not help and it is not escalated.`,
    );
  }
  const outcome = previous.result === 'stopped' ? 'was stopped at its ceiling' : 'failed its tests';
  if (previous.attempt >= 2) {
    return giveUp(
      'failed: already escalated once',
      `${from} attempt ${outcome} and the task has already been escalated once, so it is marked failed.`,
    );
  }
  const next = config.tiers[index + 1];
  if (!next) {
    return giveUp(
      'failed: no stronger tier',
      `${from} attempt ${outcome} and there is no stronger tier to hand it to, so it is marked failed.`,
    );
  }
  const ceiling = ceilingNanos(config, previous.size, next);
  const remaining = Math.max(0, await input.ports.budget.remainingNanos());
  if (ceiling > remaining) {
    return giveUp(
      `failed: no budget to escalate (next ceiling ${usd(ceiling)}, budget left ${usd(remaining)})`,
      `${from} attempt ${outcome}, but the ${usd(ceiling)} ceiling on ${next.name} does not fit the ${usd(remaining)} of budget left, so it is not escalated.`,
    );
  }

  let handoff: EscalateDecision['handoff'] = 'restart';
  let handoffSummary: string | null = null;
  let handoffSummaryCostNanos = 0;
  let handoffSummaryCostSource: CostSource = 'ao-estimate';
  let handoffSummaryTokens: TokenUsage = { uncachedInput: 0, cachedInput: 0, output: 0, total: 0 };
  let checkpointId: string | null = previous.checkpointId ?? null;
  let checkpointUrl: string | null = null;
  if (previous.sessionId && input.ports.handoff) {
    try {
      const found = await input.ports.handoff.summaryFor(previous.sessionId, {
        branch: previous.branch,
        checkpointId: previous.checkpointId,
        result: previous.result,
        resultReason: previous.resultReason,
        task: input.task,
      });
      if (found && found.summary.trim() !== '') {
        handoff = found.type;
        handoffSummary = found.branch ? `Continue from failed branch ${found.branch}.\n\n${found.summary}` : found.summary;
        handoffSummaryCostNanos = Math.max(0, Math.round(found.summaryCostNanos ?? 0));
        handoffSummaryCostSource = found.summaryCostSource ?? 'ao-estimate';
        handoffSummaryTokens = found.summaryTokens ?? handoffSummaryTokens;
        checkpointId = found.checkpointId ?? checkpointId;
        checkpointUrl = found.checkpointUrl ?? null;
      }
    } catch {
      // No summary: the stronger tier starts from the issue.
    }
  }
  const how =
    handoff === 'restart'
      ? 'restarting from the issue because no handoff summary was available,'
      : `continuing from ${HANDOFF_NAMES[handoff]}`;
  return {
    action: 'escalate',
    taskId: previous.taskId,
    size: previous.size,
    attempt: 2,
    tier: next,
    ceilingNanos: ceiling,
    escalatedFrom: previous.attemptId,
    handoff,
    handoffSummary,
    handoffSummaryCostNanos,
    handoffSummaryCostSource,
    handoffSummaryTokens,
    checkpointId,
    checkpointUrl,
    reason: `${from} attempt ${outcome}, so it escalates one tier to ${next.name} capped at ${usd(ceiling)}, ${how} with ${usd(remaining)} of budget left.`,
  };
}

export async function decideEscalation(input: EscalationInput): Promise<EscalationDecision> {
  return traceDecision(
    input.ports.trace,
    'tally.escalate',
    {
      taskId: input.previous.taskId,
      size: input.previous.size,
      attempt: input.previous.attempt,
      fromTier: input.previous.tier,
      result: input.previous.result,
      ...input.traceAttributes,
    },
    async (span) => {
      const decision = await decideEscalationCore(input);
      span.set({
        action: decision.action,
        tier: decision.action === 'escalate' ? decision.tier.name : null,
        handoff: decision.action === 'escalate' ? decision.handoff : null,
        checkpointId: decision.action === 'escalate' ? decision.checkpointId : null,
        reason: decision.reason,
      });
      return decision;
    },
  );
}
