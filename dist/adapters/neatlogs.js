import { loadEnv } from '../engine/env.js';
const DEFAULT_WORKFLOW = 'tally-cfo-agent';
function traceIdFromCarrier(carrier) {
    const traceparent = carrier.traceparent;
    const match = typeof traceparent === 'string' ? /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(traceparent) : null;
    return match?.[1] ?? null;
}
function serialisable(attributes) {
    return Object.fromEntries(Object.entries(attributes).filter(([, value]) => ['string', 'number', 'boolean', 'object'].includes(typeof value)));
}
async function importNeatlogs() {
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    return dynamicImport('neatlogs');
}
export class NeatlogsTraceAdapter {
    apiKey;
    workflowName;
    tags;
    sdkOverride;
    loadSdk;
    sdk = null;
    initStarted = null;
    offReason = null;
    lastTraceIdValue = null;
    decisionIds = new Map();
    constructor(options = {}) {
        const env = options.env ?? loadEnv();
        this.apiKey = env.NEATLOGS_API_KEY || null;
        this.workflowName = options.workflowName ?? DEFAULT_WORKFLOW;
        this.tags = options.tags ?? ['tally', 'cfo-agent'];
        this.sdkOverride = options.sdk;
        this.loadSdk = options.loadSdk ?? importNeatlogs;
        if (!this.apiKey)
            this.offReason = 'NEATLOGS_API_KEY is missing';
    }
    status() {
        return this.offReason ? { status: 'missing', detail: this.offReason } : { status: 'ok', detail: this.lastTraceIdValue };
    }
    lastTraceId(runId, taskId, attempt) {
        if (runId && taskId && attempt)
            return this.decisionIds.get(JSON.stringify([runId, taskId, attempt])) ?? null;
        return this.lastTraceIdValue;
    }
    async span(name, attributes, fn) {
        const sdk = await this.ready();
        if (!sdk)
            return fn({ set: () => { } });
        const span = {
            attributes: { ...attributes },
            set: (next) => Object.assign(span.attributes, next),
        };
        const sessionId = typeof attributes.sessionId === 'string' ? attributes.sessionId : undefined;
        const safeAttributes = serialisable(attributes);
        // Public trace summaries expose names but not custom input/attributes.
        const decision = ['tally.route', 'tally.baseline.route', 'tally.escalate'].includes(name);
        const correlatedName = decision && sessionId && typeof attributes.taskId === 'string'
            && typeof attributes.attempt === 'number' && Number.isInteger(attributes.attempt) && attributes.attempt > 0
            ? `${name}: Tally run ${sessionId}, task ${attributes.taskId}, attempt ${attributes.attempt}`
            : name;
        return sdk.trace({ name: correlatedName, kind: 'CHAIN', ...(sessionId ? { sessionId } : {}), input: safeAttributes, attributes: safeAttributes }, async () => {
            const carrier = {};
            sdk.injectTraceContext?.(carrier);
            this.lastTraceIdValue = traceIdFromCarrier(carrier);
            if (decision && sessionId)
                this.decisionIds.set(JSON.stringify([sessionId, attributes.taskId, attributes.attempt]), this.lastTraceIdValue);
            return fn(span);
        });
    }
    async flush() {
        const sdk = await this.ready();
        await sdk?.flush?.();
    }
    async shutdown() {
        const sdk = await this.ready();
        await sdk?.flush?.();
        await sdk?.shutdown?.();
    }
    async ready() {
        if (this.sdk || this.offReason)
            return this.sdk;
        this.initStarted ??= this.initialise();
        await this.initStarted;
        return this.sdk;
    }
    async initialise() {
        if (!this.apiKey)
            return;
        try {
            const sdk = this.sdkOverride === undefined ? await this.loadSdk() : this.sdkOverride;
            if (!sdk) {
                this.offReason = 'neatlogs SDK is not installed';
                return;
            }
            await sdk.init({ apiKey: this.apiKey, workflowName: this.workflowName, tags: this.tags });
            this.sdk = sdk;
            this.offReason = null;
        }
        catch {
            this.offReason = 'neatlogs SDK is not available';
            this.sdk = null;
        }
    }
}
//# sourceMappingURL=neatlogs.js.map