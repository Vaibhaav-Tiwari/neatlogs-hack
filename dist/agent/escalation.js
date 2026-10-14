import { planFromHistory } from './history-plan.js';
import { usd } from './router.js';
import { traceDecision } from './trace.js';
import { diagnoseAttempt } from './failure.js';
const HANDOFF_NAMES = {
    'entire-handoff': 'the Entire handoff summary',
};
function capitalise(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
function isModelAccessRejection(previous) {
    if (previous.result !== 'error' || !previous.resultReason)
        return false;
    return previous.resultReason.startsWith(`Model configuration error for tier "${previous.tier}"`)
        && previous.resultReason.includes('the active harness account rejected the configured model');
}
async function decideEscalationCore(input) {
    const { previous, config } = input;
    const index = config.tiers.findIndex((tier) => tier.name === previous.tier);
    if (index < 0)
        throw new Error(`Tier "${previous.tier}" is not in tally.yaml`);
    const from = capitalise(previous.tier);
    const modelAccessRejected = isModelAccessRejection(previous);
    const giveUp = (statusReason, reason) => ({
        action: 'give-up',
        taskId: previous.taskId,
        statusReason,
        reason,
    });
    if (previous.result === 'passed') {
        return giveUp(null, `${from} attempt passed, so there is nothing to escalate.`);
    }
    if (previous.result === 'error' && !modelAccessRejected) {
        return giveUp('failed: attempt errored', `${from} attempt broke for a reason outside the model, so a stronger tier would not help and it is not escalated.`);
    }
    const outcome = modelAccessRejected
        ? 'was rejected for model access'
        : previous.result === 'stopped' ? 'was stopped at its ceiling' : 'failed its tests';
    if (previous.attempt >= 2) {
        return giveUp(modelAccessRejected ? 'failed: fallback model was also rejected for model access' : 'failed: already escalated once', `${from} attempt ${outcome} and the task has already used its one retry, so it is marked failed.`);
    }
    const next = modelAccessRejected && config.modelAccessFallbackTier
        ? config.tiers.find(tier => tier.name === config.modelAccessFallbackTier)
        : config.tiers[index + 1];
    if (!next) {
        if (modelAccessRejected && config.modelAccessFallbackTier) {
            return giveUp('failed: configured model-access fallback tier was not found', `The configured model-access fallback tier "${config.modelAccessFallbackTier}" is not available, so Tally did not retry.`);
        }
        if (modelAccessRejected) {
            return giveUp('failed: model access rejected and no fallback tier is configured', `${from} was rejected for model access; set modelAccessFallbackTier in tally.yaml to opt into one budget-checked retry.`);
        }
        return giveUp('failed: no stronger tier', `${from} attempt ${outcome} and there is no stronger tier to hand it to, so it is marked failed.`);
    }
    if (modelAccessRejected && next.harness === config.tiers[index]?.harness && next.model === config.tiers[index]?.model) {
        return giveUp('failed: model-access fallback is the rejected tier', `The configured fallback tier "${next.name}" uses the rejected model; choose a different tier in tally.yaml.`);
    }
    const history = await planFromHistory(config, input.ports.history, previous.size, next.name);
    const ceiling = history.ceilingNanos;
    const remaining = Math.max(0, await input.ports.budget.remainingNanos());
    if (ceiling > remaining) {
        return giveUp(modelAccessRejected
            ? `failed: no budget for model-access fallback (fallback ceiling ${usd(ceiling)}, budget left ${usd(remaining)})`
            : `failed: no budget to escalate (next ceiling ${usd(ceiling)}, budget left ${usd(remaining)})`, modelAccessRejected
            ? `${from} was rejected for model access, but the ${usd(ceiling)} fallback ceiling on ${next.name} does not fit the ${usd(remaining)} of budget left, so Tally did not retry.`
            : `${from} attempt ${outcome}, but the ${usd(ceiling)} ceiling on ${next.name} does not fit the ${usd(remaining)} of budget left, so it is not escalated.`);
    }
    let handoff = 'restart';
    let handoffSummary = null;
    let handoffBranch = null;
    let handoffSummaryCostNanos = 0;
    let handoffSummaryCostSource = 'ao-estimate';
    let handoffSummaryTokens = { uncachedInput: 0, cachedInput: 0, output: 0, total: 0 };
    let checkpointId = previous.checkpointId ?? null;
    let checkpointUrl = null;
    if (previous.sessionId && input.ports.handoff && !modelAccessRejected) {
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
                handoffBranch = found.branch ?? null;
                handoffSummaryCostNanos = Math.max(0, Math.round(found.summaryCostNanos ?? 0));
                handoffSummaryCostSource = found.summaryCostSource ?? 'ao-estimate';
                handoffSummaryTokens = found.summaryTokens ?? handoffSummaryTokens;
                checkpointId = found.checkpointId ?? checkpointId;
                checkpointUrl = found.checkpointUrl ?? null;
            }
        }
        catch {
            // No summary: the stronger tier starts from the issue.
        }
    }
    const how = handoff === 'restart'
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
        handoffBranch,
        handoffSummaryCostNanos,
        handoffSummaryCostSource,
        handoffSummaryTokens,
        checkpointId,
        checkpointUrl,
        history,
        reason: modelAccessRejected
            ? `${from} was rejected for model access, so Tally will try configured fallback tier ${next.name} once, capped at ${usd(ceiling)}, with ${usd(remaining)} of budget left.`
            : `${from} attempt ${outcome}, so it escalates one tier to ${next.name} capped at ${usd(ceiling)}, ${how} with ${usd(remaining)} of budget left.`,
    };
}
export async function decideEscalation(input) {
    return traceDecision(input.ports.trace, 'tally.escalate', {
        taskId: input.previous.taskId,
        size: input.previous.size,
        attempt: input.previous.attempt,
        fromTier: input.previous.tier,
        result: input.previous.result,
        ...input.traceAttributes,
    }, async (span) => {
        const failure = input.previous.result === 'passed' ? undefined
            : input.failureAssessment ?? (input.ports.failureTrace ? await diagnoseAttempt(input.previous, input.ports.failureTrace) : undefined);
        if (failure && !failure.retryable && failure.kind === 'model-unavailable' && !isModelAccessRejection(input.previous)) {
            const decision = {
                action: 'give-up', taskId: input.previous.taskId,
                statusReason: 'failed: model unavailable needs explicit model-access fallback',
                reason: `The worker trace reports model-unavailable; Tally stops rather than silently substituting a model; ${failure.detail.replace(/\.$/, '')}.`,
            };
            span.set({ action: decision.action, reason: decision.reason, failureAssessment: JSON.stringify(failure) });
            return decision;
        }
        if (failure && !failure.retryable && (failure.kind === 'permission-refused' || failure.kind === 'tool-failure')) {
            const decision = {
                action: 'give-up', taskId: input.previous.taskId,
                statusReason: `failed: ${failure.kind} needs intervention`,
                reason: `The attempt hit ${failure.kind}; a stronger model would hit the same wall, so Tally stops without escalating; ${failure.detail.replace(/\.$/, '')}.`,
            };
            span.set({ action: decision.action, reason: decision.reason, failureAssessment: JSON.stringify(failure) });
            return decision;
        }
        const decision = await decideEscalationCore(input);
        if (decision.action === 'escalate' && input.ports.history && decision.history) {
            const h = decision.history;
            const cap = h.capSource === 'successful-p90'
                ? `P90 ${usd(h.p90CostNanos)} x 1.5 over ${h.successfulSamples} successful samples, max ${usd(h.configuredCeilingNanos)}`
                : `configured cap (${h.successfulSamples} successful samples; 5 needed)`;
            const stats = h.observedPassRate === null
                ? `0 observations, prior ${Math.round(h.passRate * 100)}% pass rate and ${usd(h.avgCostNanos)} average cost`
                : `${h.attempts} observations, ${Math.round(h.observedPassRate * 100)}% pass rate, ${usd(h.observedAvgCostNanos)} average cost`;
            decision.reason = `${decision.reason.replace(/\.$/, '')}; ${h.source} history: ${stats}, ${h.usedPrior ? 'uses the prior' : 'observed statistics'}, ${cap}, model ${h.model} only (unknown-model observations excluded).`;
        }
        if (failure)
            decision.reason = `${decision.reason.replace(/\.$/, '')}; ${failure.detail.replace(/\.$/, '')}.`;
        span.set({
            action: decision.action,
            tier: decision.action === 'escalate' ? decision.tier.name : null,
            handoff: decision.action === 'escalate' ? decision.handoff : null,
            checkpointId: decision.action === 'escalate' ? decision.checkpointId : null,
            reason: decision.reason,
            history: JSON.stringify(decision.action === 'escalate' ? decision.history ?? null : null),
            failureAssessment: JSON.stringify(failure ?? null),
        });
        return decision;
    });
}
//# sourceMappingURL=escalation.js.map