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
  private statusState: IntegrationState = { status: 'ok', detail: null };

  constructor(options: NeatlogsTraceOptions = {}) {
    const env = options.env ?? loadEnv();
    this.apiKey = env.NEATLOGS_API_KEY || null;
    this.workflowName = options.workflowName ?? DEFAULT_WORKFLOW;
    this.tags = options.tags ?? ['tally', 'cfo-agent'];
    this.sdkOverride = options.sdk;
    this.loadSdk = options.loadSdk ?? importNeatlogs;
    if (!this.apiKey) {
      this.offReason = 'NEATLOGS_API_KEY is missing';
      this.statusState = { status: 'missing', detail: this.offReason };
    }
  }

  status(): IntegrationState {
    return this.statusState.status === 'ok' ? { status: 'ok', detail: this.lastTraceIdValue } : this.statusState;
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
    let callbackStarted = false;
    let callbackCompleted = false;
    let callbackFailed = false;
    let callbackResult!: T;
    const callback = async (): Promise<T> => {
      callbackStarted = true;
      const carrier: Record<string, string> = {};
      sdk.injectTraceContext?.(carrier);
      this.lastTraceIdValue = traceIdFromCarrier(carrier);
      try {
        callbackResult = await fn(span);
        callbackCompleted = true;
        return callbackResult;
      } catch (error) {
        callbackFailed = true;
        throw error;
      }
    };
    try {
      const traced = await sdk.trace({ name, kind: 'CHAIN', ...(sessionId ? { sessionId } : {}), input: safeAttributes, attributes: safeAttributes }, callback);
      // Some exporters finish delivery after the callback resolves. Keep the
      // callback's result if delivery reports a late failure.
      return callbackCompleted ? callbackResult : traced;
    } catch (error) {
      // Never run application work twice. Callback failures belong to Tally and
      // must be rethrown; exporter failures before callback entry are optional.
      if (callbackFailed || (callbackStarted && !callbackCompleted)) throw error;
      if (callbackCompleted) return callbackResult;
      this.offReason = 'neatlogs trace export failed; the run continued without this span';
      this.statusState = { status: 'error', detail: this.offReason };
      return fn({ set: () => {} });
    }
  }

  async flush(): Promise<void> {
    const sdk = await this.ready();
    try {
      await sdk?.flush?.();
    } catch {
      this.offReason = 'neatlogs flush failed; queued trace data may be pending';
      this.statusState = { status: 'error', detail: this.offReason };
    }
  }

  async shutdown(): Promise<void> {
    const sdk = await this.ready();
    await this.flush();
    try {
      await sdk?.shutdown?.();
    } catch {
      this.offReason = 'neatlogs shutdown failed; the run data remains local';
      this.statusState = { status: 'error', detail: this.offReason };
    }
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
        this.statusState = { status: 'missing', detail: this.offReason };
        return;
      }
      await sdk.init({ apiKey: this.apiKey, workflowName: this.workflowName, tags: this.tags });
      this.sdk = sdk;
      this.offReason = null;
      this.statusState = { status: 'ok', detail: null };
    } catch {
      this.offReason = 'neatlogs SDK is not available';
      this.statusState = { status: 'missing', detail: this.offReason };
      this.sdk = null;
    }
  }
}
