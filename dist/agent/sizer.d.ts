/**
 * Sizer: turns the sizing signals and the issue text into a size and a
 * confidence score. The rules are deterministic; an LLM may refine the
 * result but can only make the estimate more cautious about cost, never
 * cheaper on its own word.
 */
import type { TaskSize } from '../schema/types.js';
import type { CheckpointRecall, LlmPort, SizingSignals, SizingSignalsPort, TaskInput, TracePort } from './ports.js';
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
/** How precisely the issue says what to change, from 0 (a wish) to 1 (a pinned-down case). */
export declare function specificity(task: TaskInput): number;
/** The deterministic rules. */
export declare function sizeFromSignals(task: TaskInput, signals: SizingSignals | null): SizeEstimate;
export declare function applyCheckpointRecall(estimate: SizeEstimate, recall: CheckpointRecall | null): SizeEstimate;
/** Reads the signals, applies the rules, and refines with the LLM when one is given. */
export declare function sizeTask(task: TaskInput, ports: {
    signals: SizingSignalsPort;
    llm?: LlmPort;
    trace?: TracePort;
}, options?: SizerOptions): Promise<SizeEstimate>;
