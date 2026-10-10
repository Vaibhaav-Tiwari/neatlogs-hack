/**
 * Sizer: turns the sizing signals and the issue text into a size and a
 * confidence score. The rules are deterministic; an LLM may refine the
 * result but can only make the estimate more cautious about cost, never
 * cheaper on its own word.
 */
import type { TaskSize } from '../schema/types.js';
import type { CheckpointRecall, LlmPort, SizingSignals, SizingSignalsPort, TaskInput, TracePort } from './ports.js';
import { traceDecision } from './trace.js';

export interface SizeEstimate {
  size: TaskSize;
  /** How sure the sizer is that the task is what it looks like, in [0, 1]. */
  confidence: number;
  /** Null when nothing could be measured. */
  signals: SizingSignals | null;
  /** How specific the issue text is, in [0, 1]. */
  specificity: number;
  refinedBy: 'rules' | 'llm';
  /** The signals in plain words, for the decision sentence. */
  summary: string;
  recall: CheckpointRecall | null;
}

export interface SizerOptions {
  /** Model id for the optional refinement call. Use a cheap one. */
  llmModel?: string;
}

const SIZES: TaskSize[] = ['small', 'medium', 'large'];

/** Upper bounds for small and medium; anything above is large. */
const FILE_LIMITS = [2, 7] as const;
const DEPENDENT_LIMITS = [3, 11] as const;

const BROAD = /\b(refactor\w*|rewrit\w*|rewrote|migrat\w*|redesign\w*|overhaul\w*|re-?architect\w*|everywhere|across the)\b/i;
const CODE_REFERENCE = /`[^`]+`|\b[\w./-]+\.[a-z]{1,5}\b|\b\w+\(\)|\b[\w-]+\/[\w-]+\/[\w./-]+/;
const EXPECTED_BEHAVIOUR = /\b(should|expected|must|instead of|returns?|raises?|throws?|fails?|error)\b/i;
const STEPS_OR_OUTPUT = /^\s*(\d+[.)]|[-*])\s+\S|```|Traceback|\bat .+:\d+/m;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function bucket(value: number, limits: readonly [number, number]): number {
  if (value <= limits[0]) return 0;
  return value <= limits[1] ? 1 : 2;
}

/** How precisely the issue says what to change, from 0 (a wish) to 1 (a pinned-down case). */
export function specificity(task: TaskInput): number {
  const text = `${task.title}\n${task.body}`;
  let score = 0;
  if (CODE_REFERENCE.test(text)) score += 0.35;
  if (EXPECTED_BEHAVIOUR.test(text)) score += 0.25;
  if (task.body.trim().length >= 80) score += 0.2;
  if (STEPS_OR_OUTPUT.test(task.body)) score += 0.2;
  return round2(clamp01(score));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function summarise(signals: SizingSignals | null): string {
  if (!signals) return 'no sizing signals';
  const files = `${plural(signals.filesTouched, 'file')} touched`;
  const dependents = signals.dependents === 0 ? 'no dependents' : plural(signals.dependents, 'dependent');
  return `${files}, ${dependents} and ${signals.testsPresent ? 'tests present' : 'no tests'}`;
}

/** The deterministic rules. */
export function sizeFromSignals(task: TaskInput, signals: SizingSignals | null): SizeEstimate {
  const specific = specificity(task);
  const broad = BROAD.test(`${task.title}\n${task.body}`);
  const base = { signals, specificity: specific, refinedBy: 'rules' as const, summary: summarise(signals), recall: null };

  if (!signals || signals.source === 'none') {
    // Nothing measured: assume the middle and admit it is a guess.
    return { ...base, size: broad ? 'large' : 'medium', confidence: round2(Math.min(0.3, 0.15 + specific * 0.15)) };
  }

  const files = bucket(signals.filesTouched, FILE_LIMITS);
  const dependents = bucket(signals.dependents, DEPENDENT_LIMITS);
  const index = Math.min(2, files + (broad ? 1 : 0));

  let confidence = 0.5;
  confidence += signals.testsPresent ? 0.2 : -0.15;
  confidence += specific * 0.25;
  confidence -= dependents * 0.1;
  if (signals.source === 'code-search') confidence -= 0.1;
  if (broad) confidence -= 0.1;

  return { ...base, size: SIZES[index]!, confidence: round2(clamp01(confidence)) };
}

export function applyCheckpointRecall(estimate: SizeEstimate, recall: CheckpointRecall | null): SizeEstimate {
  if (!recall?.failed) return estimate;
  const confidence = round2(clamp01(estimate.confidence - 0.15));
  const files = recall.files.length > 0 ? ` on ${recall.files.slice(0, 2).join(', ')}` : '';
  return {
    ...estimate,
    confidence,
    recall,
    summary: `${estimate.summary}; a prior checkpoint failed${files} before`,
  };
}

function buildPrompt(task: TaskInput, rules: SizeEstimate): string {
  const signals = rules.signals;
  return [
    'Estimate how big this coding task is for an autonomous coding agent.',
    '',
    `Title: ${task.title}`,
    `Issue: ${task.body.slice(0, 4000) || '(empty)'}`,
    '',
    signals
      ? `Files touched: ${signals.filesTouched}\nDependents: ${signals.dependents}\nTests present: ${signals.testsPresent ? 'yes' : 'no'}`
      : 'No code measurements are available.',
    `Rule-based estimate: ${rules.size}`,
    '',
    'small = one or two target files. medium = several target files. large = many target files or a broad change. Dependents lower confidence, not size.',
    'Reply with JSON only: {"size":"small|medium|large","confidence":<0 to 1, how sure you are>}',
  ].join('\n');
}

function parseReply(text: string): { size: TaskSize; confidence: number } | null {
  const match = /\{[^{}]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { size, confidence } = parsed as Record<string, unknown>;
    if (!SIZES.includes(size as TaskSize)) return null;
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return null;
    return { size: size as TaskSize, confidence };
  } catch {
    return null;
  }
}

async function refine(task: TaskInput, rules: SizeEstimate, llm: LlmPort, model?: string): Promise<SizeEstimate> {
  let reply: { size: TaskSize; confidence: number } | null;
  try {
    const response = await llm.complete({
      ...(model ? { model } : {}),
      system: 'You size software tasks. Answer with JSON only.',
      prompt: buildPrompt(task, rules),
      maxTokens: 60,
    });
    reply = parseReply(response.text);
  } catch {
    reply = null;
  }
  if (!reply) return rules;

  if (reply.size === rules.size) {
    const confidence = clamp01((rules.confidence + reply.confidence) / 2 + 0.1);
    return { ...rules, confidence: round2(Math.max(rules.confidence, confidence)), refinedBy: 'llm' };
  }
  // Disagreement is itself a sign of uncertainty: take the larger size and trust it less.
  const size = SIZES[Math.max(SIZES.indexOf(rules.size), SIZES.indexOf(reply.size))]!;
  const confidence = clamp01(Math.min(rules.confidence, reply.confidence) - 0.15);
  return { ...rules, size, confidence: round2(confidence), refinedBy: 'llm' };
}

/** Reads the signals, applies the rules, and refines with the LLM when one is given. */
export async function sizeTask(
  task: TaskInput,
  ports: { signals: SizingSignalsPort; llm?: LlmPort; trace?: TracePort },
  options: SizerOptions = {},
): Promise<SizeEstimate> {
  return traceDecision(ports.trace, 'tally.size', { taskId: task.taskId }, async (span) => {
    let signals: SizingSignals | null;
    try {
      signals = await ports.signals.signalsFor(task);
    } catch {
      signals = null;
    }
    const rules = sizeFromSignals(task, signals);
    const estimate = ports.llm ? await refine(task, rules, ports.llm, options.llmModel) : rules;
    span.set({
      size: estimate.size,
      confidence: estimate.confidence,
      refinedBy: estimate.refinedBy,
      signalsSource: estimate.signals?.source ?? null,
    });
    return estimate;
  });
}
