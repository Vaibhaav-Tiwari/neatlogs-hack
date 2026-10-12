import type { AttemptResult } from '../schema/types.js';

export type FailureKind = 'ceiling' | 'tool-failure' | 'tests-failed' | 'permission-refused' | 'model-unavailable' | 'unknown';

export interface FailureAssessment {
  kind: FailureKind;
  source: 'neatlogs' | 'ledger';
  traceId: string | null;
  evidence: string[];
  spans: string[];
  retryable: boolean;
  detail: string;
}

export interface FailureSpan {
  id: string;
  name: string;
  type: string;
  status: string;
  error?: string;
  startedAt?: string;
}

export interface FailureTraceContext {
  runId: string;
  taskId: string;
  attempt: number;
  traceId?: string | null;
}

export interface FailureTracePort {
  failureFor(context: FailureTraceContext): Promise<{ traceId: string; spans: FailureSpan[] } | null>;
}

export interface FailureAttempt {
  attemptId: string;
  taskId: string;
  attempt: number;
  result: AttemptResult;
  resultReason?: string | null;
  workerTraceId?: string | null;
}

function kindFor(text: string): FailureKind {
  if (/permission (?:denied|refused)|not (?:allowed|authorized)|requires? approval|EACCES/i.test(text)) return 'permission-refused';
  if (/model (?:unavailable|not found|not supported)|model.*(?:access denied|rejected)|invalid model|Model configuration error/i.test(text)) return 'model-unavailable';
  if (/ceiling crossed|budget (?:exceeded|exhausted)|hit (?:the )?(?:spend )?ceiling/i.test(text)) return 'ceiling';
  if (/tests? failed|AssertionError|assertion failed|pytest.*failed|test suite.*failed/i.test(text)) return 'tests-failed';
  if (/command not found|ENOENT|ENOTFOUND|ECONNREFUSED|network (?:unavailable|failure)|missing (?:dependency|dependencies)|tool.*failed|command.*(?:failed|exit(?:ed)? (?:code )?[1-9])/i.test(text)) return 'tool-failure';
  return 'unknown';
}

function assessment(kind: FailureKind, source: FailureAssessment['source'], traceId: string | null,
  spans: string[], detail: string): FailureAssessment {
  return {
    kind, source, traceId, spans,
    // Persist a bounded, fixed vocabulary, never raw command output or credentials.
    evidence: [detail], detail,
    retryable: kind === 'ceiling' || kind === 'tests-failed' || kind === 'unknown',
  };
}

export async function diagnoseAttempt(previous: FailureAttempt, port?: FailureTracePort): Promise<FailureAssessment> {
  const runId = previous.attemptId.split(':')[0]!;
  let trace: Awaited<ReturnType<FailureTracePort['failureFor']>> = null;
  try {
    trace = await port?.failureFor({ runId, taskId: previous.taskId, attempt: previous.attempt, traceId: previous.workerTraceId }) ?? null;
  } catch { /* Read failure must not change the ledger-based fallback. */ }
  if (trace) {
    const ordered = [...trace.spans].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
    const latest = new Map<string, FailureSpan>();
    for (const span of ordered) if (span.type === 'TOOL' || span.type === 'LLM') latest.set(`${span.type}:${span.name}`, span);
    for (const span of [...latest.values()].reverse()) {
      if (span.status !== 'ERROR') continue;
      const kind = kindFor(`${span.name} ${span.error ?? ''}`);
      if (kind !== 'unknown') return assessment(kind, 'neatlogs', trace.traceId, [span.id], `Neatlogs contains an unrecovered ${kind} signal in span ${span.id}.`);
    }
  }
  let kind = kindFor(previous.resultReason ?? '');
  if (kind === 'unknown' && previous.result === 'failed') kind = 'tests-failed';
  const readable = trace ? `${trace.spans.length} readable spans have no explicit unrecovered failure signal` : 'worker trace could not be read';
  const fallback = assessment(kind, 'ledger', trace?.traceId ?? previous.workerTraceId ?? null, [],
    `Ledger fallback: ${readable}; attempt result ${previous.result} classifies as ${kind}.`);
  // Preserve the existing failed/stopped escalation policy when the trace adds no evidence.
  if (kind === 'unknown') fallback.retryable = previous.result === 'failed' || previous.result === 'stopped';
  return fallback;
}
