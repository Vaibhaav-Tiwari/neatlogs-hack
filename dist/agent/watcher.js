/**
 * Ceiling watcher: decides when a running attempt has spent its ceiling and
 * must be stopped.
 */
import { costNanos } from '../schema/money.js';
import { usd } from './router.js';
import { traceDecision } from './trace.js';
/** Cost is tokens x list price. The orchestrator's estimate is used only when the tier has no price. */
export function checkCeiling(usage, attempt) {
    if (!usage)
        return { costNanos: 0, costSource: 'list-price', tokens: null, crossed: false };
    const listCost = costNanos(usage.tokens, attempt.tier.price);
    const priced = listCost > 0 || usage.estimatedCostNanos <= 0;
    const cost = priced ? listCost : usage.estimatedCostNanos;
    return {
        costNanos: cost,
        costSource: priced ? 'list-price' : 'ao-estimate',
        tokens: usage.tokens,
        crossed: attempt.ceilingNanos !== null && cost >= attempt.ceilingNanos,
    };
}
export class CeilingWatcher {
    ports;
    constructor(ports) {
        this.ports = ports;
    }
    /** Reads usage once and stops the session if it has crossed its ceiling. */
    async poll(attempt) {
        return traceDecision(this.ports.trace, 'tally.ceiling.poll', { sessionId: attempt.sessionId, tier: attempt.tier.name, ceilingNanos: attempt.ceilingNanos }, async (span) => {
            let usage;
            try {
                usage = await this.ports.usage.usageFor(attempt.sessionId);
            }
            catch {
                const verdict = { ...checkCeiling(null, attempt), action: 'continue', reason: null, stopped: false, usageReadable: false };
                span.set({ action: verdict.action, costNanos: verdict.costNanos, crossed: verdict.crossed, usageReadable: false });
                return verdict;
            }
            const check = checkCeiling(usage, attempt);
            if (!check.crossed || attempt.ceilingNanos === null) {
                const verdict = { ...check, action: 'continue', reason: null, stopped: false, usageReadable: true };
                span.set({ action: verdict.action, costNanos: verdict.costNanos, crossed: verdict.crossed, usageReadable: true });
                return verdict;
            }
            const reason = `ceiling crossed: ${usd(check.costNanos)} spent against a ${usd(attempt.ceilingNanos)} ceiling`;
            let stopped = true;
            try {
                await this.ports.sessions.stop(attempt.sessionId, reason);
            }
            catch {
                stopped = false;
            }
            const verdict = { ...check, action: 'stop', reason, stopped, usageReadable: true };
            span.set({ action: verdict.action, costNanos: verdict.costNanos, crossed: verdict.crossed, stopped, reason });
            return verdict;
        });
    }
    /** Polls until the session has been stopped at its ceiling or the signal is aborted. */
    async watch(attempt, options = {}) {
        const sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', done);
                resolve();
            };
            const timer = setTimeout(done, ms);
            options.signal?.addEventListener('abort', done, { once: true });
            if (options.signal?.aborted)
                done();
        }));
        for (;;) {
            const verdict = await this.poll(attempt);
            if (verdict.action === 'stop' && verdict.stopped)
                return verdict;
            if (options.signal?.aborted)
                return verdict;
            await sleep(options.intervalMs ?? 5000);
            if (options.signal?.aborted)
                return verdict;
        }
    }
}
//# sourceMappingURL=watcher.js.map