import type { TraceAttributes, TracePort, TraceSpan } from './ports.js';

export const noopTrace: TracePort = {
  async span<T>(_name: string, _attributes: TraceAttributes, fn: (span: TraceSpan) => Promise<T>): Promise<T> {
    return fn({ set: () => {} });
  },
};

export function traceDecision<T>(
  trace: TracePort | undefined,
  name: string,
  attributes: TraceAttributes,
  fn: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  return (trace ?? noopTrace).span(name, attributes, fn);
}
