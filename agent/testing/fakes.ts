/**
 * In-memory implementations of the agent's ports, for unit tests and dry runs.
 */
import type { TallyConfig, TaskSize, TokenUsage } from '../../schema/types.js';
import type {
  BudgetPort,
  HandoffPort,
  HandoffSummary,
  LiveUsage,
  LiveUsagePort,
  LlmPort,
  LlmRequest,
  LlmResponse,
  PriceHistoryPort,
  PriceStats,
  SessionControlPort,
  SizingSignals,
  SizingSignalsPort,
  TaskInput,
  TraceAttributes,
  TracePort,
} from '../ports.js';

/** Three made-up tiers. The names are deliberately not cheap/middle/top. */
export function sampleConfig(overrides: Partial<TallyConfig> = {}): TallyConfig {
  return {
    version: 1,
    repo: { path: '.', baseBranch: 'main' },
    test: { command: 'make test' },
    backlog: { source: 'file', file: 'backlog.yaml' },
    tiers: [
      {
        name: 'bronze',
        harness: 'claude-code',
        model: 'model-small',
        provider: 'fake',
        price: { inputUsdPerMTok: 1, cachedInputUsdPerMTok: 0.1, outputUsdPerMTok: 5 },
        ceilingFraction: 0.2,
      },
      {
        name: 'silver',
        harness: 'claude-code',
        model: 'model-mid',
        provider: 'fake',
        price: { inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.2, outputUsdPerMTok: 10 },
        ceilingFraction: 0.5,
      },
      {
        name: 'gold',
        harness: 'codex',
        model: 'model-big',
        provider: 'fake',
        price: { inputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.4, outputUsdPerMTok: 20 },
        ceilingFraction: 1,
      },
    ],
    ceilings: { bySizeUsd: { small: 1.5, medium: 4, large: 10 } },
    budget: { source: 'config', usd: 40 },
    integrations: { neatlogs: false, entire: false, cfoai: false, slack: false },
    ...overrides,
  };
}

export function task(overrides: Partial<TaskInput> = {}): TaskInput {
  return { taskId: 'T1', title: 'Fix the thing', body: '', ...overrides };
}

export function tokens(uncachedInput: number, cachedInput: number, output: number): TokenUsage {
  return { uncachedInput, cachedInput, output, total: uncachedInput + cachedInput + output };
}

export class FakeSignals implements SizingSignalsPort {
  calls = 0;
  constructor(private readonly result: SizingSignals | null | Error) {}
  async signalsFor(_task: TaskInput): Promise<SizingSignals | null> {
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

export class FakeHistory implements PriceHistoryPort {
  private readonly stats = new Map<string, PriceStats>();
  failWith: Error | null = null;
  set(size: TaskSize, tier: string, stats: PriceStats): this {
    this.stats.set(`${size}:${tier}`, stats);
    return this;
  }
  async lookup(size: TaskSize, tier: string): Promise<PriceStats | null> {
    if (this.failWith) throw this.failWith;
    return this.stats.get(`${size}:${tier}`) ?? null;
  }
}

export class FakeBudget implements BudgetPort {
  constructor(public remaining: number) {}
  async remainingNanos(): Promise<number> {
    return this.remaining;
  }
}

export class FakeUsage implements LiveUsagePort {
  /** Readings are returned in order; the last one repeats. */
  constructor(private readonly readings: Array<LiveUsage | null | Error>) {}
  polls = 0;
  async usageFor(_sessionId: string): Promise<LiveUsage | null> {
    const reading = this.readings[Math.min(this.polls, this.readings.length - 1)] ?? null;
    this.polls += 1;
    if (reading instanceof Error) throw reading;
    return reading;
  }
}

export class FakeSessions implements SessionControlPort {
  stopped: Array<{ sessionId: string; reason: string }> = [];
  failWith: Error | null = null;
  async stop(sessionId: string, reason: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.stopped.push({ sessionId, reason });
  }
}

export class FakeHandoff implements HandoffPort {
  calls: string[] = [];
  constructor(private readonly result: HandoffSummary | null | Error) {}
  async summaryFor(sessionId: string): Promise<HandoffSummary | null> {
    this.calls.push(sessionId);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

export class FakeLlm implements LlmPort {
  requests: LlmRequest[] = [];
  constructor(private readonly reply: string | Error) {}
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.reply instanceof Error) throw this.reply;
    return { text: this.reply };
  }
}

export class RecordingTrace implements TracePort {
  spans: Array<{ name: string; attributes: TraceAttributes; error: string | null }> = [];
  async span<T>(
    name: string,
    attributes: TraceAttributes,
    fn: (span: { set(a: TraceAttributes): void }) => Promise<T>,
  ): Promise<T> {
    const record = { name, attributes: { ...attributes }, error: null as string | null };
    this.spans.push(record);
    try {
      return await fn({ set: (a) => Object.assign(record.attributes, a) });
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}
