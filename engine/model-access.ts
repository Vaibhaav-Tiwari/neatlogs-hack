import type { Tier } from '../schema/types.js';

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_ -]?key)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function isModelAccessRejection(message: string): boolean {
  return [
    /\bmodel(?:[_\s-])*(?:not[_\s-]*found|not[_\s-]*available|unavailable|access[_\s-]*denied|unknown)\b/i,
    /\b(?:unknown|unsupported)\s+model\b/i,
    /\bmodel\b.{0,120}\b(?:does not exist|not available|is not available|unavailable|is unavailable|is not supported|is unsupported)\b/i,
    /\b(?:not available|unavailable|not found|not authorized|not allowed|no access|don't have access|do not have access).{0,120}\bmodel\b/i,
    /\b(?:account|subscription|plan).{0,100}\b(?:cannot|can't|not authorized|not allowed|no access).{0,100}\bmodel\b/i,
  ].some((pattern) => pattern.test(message));
}

/** Turn a worker's explicit model-access rejection into an actionable config error. */
export function modelAccessConfigurationError(error: unknown, tier: Pick<Tier, 'name' | 'harness' | 'model'>): string | null {
  const raw = error instanceof Error ? error.message : String(error);
  if (!isModelAccessRejection(raw)) return null;
  const detail = errorMessage(raw);
  return `Model configuration error for tier "${tier.name}" (${tier.harness}, model "${tier.model}"): the active harness account rejected the configured model. Check model access for that account/provider, then update this tier's model in tally.yaml. Tally will not silently substitute another model. Provider detail: ${detail}`;
}
