import { loadEnv } from '../engine/env.js';
import type { IntegrationState } from '../schema/types.js';
import type { TraceAttributes, TracePort, TraceSpan, TraceValue } from '../agent/ports.js';

export interface NeatlogsSdk {
  init(options: { apiKey: string; workflowName: string; tags?: string[] }): Promise<unknown> | unknown;
  trace<T>(options: { name: string; kind: 'CHAIN'; sessionId?: string; input?: unknown; attributes?: Record<string, TraceValue> }, fn: () => Promise<T>): Promise<T>;
  injectTraceContext?(carrier: Record<string, string>): void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export interface NeatlogsTraceOptions {
  workflowName?: string;
  tags?: string[];
  env?: Record<string, string>;
  sdk?: NeatlogsSdk | null;
  loadSdk?: () => Promise<NeatlogsSdk>;
}

type MutableSpan = TraceSpan & { attributes: TraceAttributes };

const DEFAULT_WORKFLOW = 'tally-cfo-agent';

function traceIdFromCarrier(carrier: Record<string, string>): string | null {
  const traceparent = carrier.traceparent;
  const match = typeof traceparent === 'string' ? /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(traceparent) : null;
  return match?.[1] ?? null;
}

function serialisable(attributes: TraceAttributes): Record<string, TraceValue> {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => ['string', 'number', 'boolean', 'object'].includes(typeof value)));
}

async function importNeatlogs(): Promise<NeatlogsSdk> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<NeatlogsSdk>;
  return dynamicImport('neatlogs');
}

export class NeatlogsTraceAdapter implements TracePort {
  private readonly apiKey: string | null;
  private readonly workflowName: string;
  private readonly tags: string[];
  private readonly sdkOverride: NeatlogsSdk | null | undefined;
  private readonly loadSdk: () => Promise<NeatlogsSdk>;
  private sdk: NeatlogsSdk | null = null;
  private initStarted: Promise<void> | null = null;
  private offReason: string | null = null;
  private lastTraceIdValue: string | null = null;

  constructor(options: NeatlogsTraceOptions = {}) {
    const env = options.env ?? loadEnv();
    this.apiKey = env.NEATLOGS_API_KEY || null;
    this.workflowName = options.workflowName ?? DEFAULT_WORKFLOW;
    this.tags = options.tags ?? ['tally', 'cfo-agent'];
    this.sdkOverride = options.sdk;
    this.loadSdk = options.loadSdk ?? importNeatlogs;
    if (!this.apiKey) this.offReason = 'NEATLOGS_API_KEY is missing';
  }

  status(): IntegrationState {
    return this.offReason ? { status: 'missing', detail: this.offReason } : { status: 'ok', detail: this.lastTraceIdValue };
  }

  lastTraceId(): string | null {
    return this.lastTraceIdValue;
  }

  async span<T>(name: string, attributes: TraceAttributes, fn: (span: TraceSpan) => Promise<T>): Promise<T> {
    const sdk = await this.ready();
    if (!sdk) return fn({ set: () => {} });

    const span: MutableSpan = {
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
      const carrier: Record<string, string> = {};
      sdk.injectTraceContext?.(carrier);
      this.lastTraceIdValue = traceIdFromCarrier(carrier);
      return fn(span);
    });
  }

  async flush(): Promise<void> {
    const sdk = await this.ready();
    await sdk?.flush?.();
  }

  async shutdown(): Promise<void> {
    const sdk = await this.ready();
    await sdk?.flush?.();
    await sdk?.shutdown?.();
  }

  private async ready(): Promise<NeatlogsSdk | null> {
    if (this.sdk || this.offReason) return this.sdk;
    this.initStarted ??= this.initialise();
    await this.initStarted;
    return this.sdk;
  }

  private async initialise(): Promise<void> {
    if (!this.apiKey) return;
    try {
      const sdk = this.sdkOverride === undefined ? await this.loadSdk() : this.sdkOverride;
      if (!sdk) {
        this.offReason = 'neatlogs SDK is not installed';
        return;
      }
      await sdk.init({ apiKey: this.apiKey, workflowName: this.workflowName, tags: this.tags });
      this.sdk = sdk;
      this.offReason = null;
    } catch {
      this.offReason = 'neatlogs SDK is not available';
      this.sdk = null;
    }
  }
}
