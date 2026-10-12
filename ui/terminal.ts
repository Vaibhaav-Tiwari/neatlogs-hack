export type TerminalTone = 'brand' | 'success' | 'warning' | 'error' | 'muted' | 'bold';
export type DisplayStatus = 'connected' | 'ok' | 'off' | 'missing' | 'broken' | 'unavailable' | 'unverified' | 'error';

const SGR: Record<TerminalTone, string> = {
  brand: '1;38;2;226;88;34',
  success: '1;38;2;76;175;80',
  warning: '1;38;2;218;150;35',
  error: '1;38;2;220;65;65',
  muted: '2',
  bold: '1',
};

export interface TerminalStyleOptions {
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
}

export interface TerminalStyle {
  enabled: boolean;
  paint(text: string, tone: TerminalTone): string;
  heading(text: string): string;
  status(status: DisplayStatus): string;
  divider(width?: number): string;
}

const STATUS: Record<DisplayStatus, { icon: string; label: string; tone: TerminalTone }> = {
  connected: { icon: '●', label: 'CONNECTED', tone: 'success' },
  ok: { icon: '●', label: 'CONNECTED', tone: 'success' },
  off: { icon: '○', label: 'OFF', tone: 'muted' },
  missing: { icon: '●', label: 'SETUP NEEDED', tone: 'error' },
  broken: { icon: '●', label: 'CHECK FAILED', tone: 'error' },
  error: { icon: '●', label: 'ERROR', tone: 'error' },
  unavailable: { icon: '○', label: 'OPTIONAL', tone: 'warning' },
  unverified: { icon: '◐', label: 'UNVERIFIED', tone: 'warning' },
};

export function createTerminalStyle(options: TerminalStyleOptions = {}): TerminalStyle {
  const env = options.env ?? process.env;
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0';
  const enabled = env.NO_COLOR === undefined && env.TERM !== 'dumb' && ((options.isTTY ?? Boolean(process.stdout.isTTY)) || forced);
  const paint = (text: string, tone: TerminalTone): string => enabled ? `\u001b[${SGR[tone]}m${text}\u001b[0m` : text;
  return {
    enabled,
    paint,
    heading: text => paint(text, 'brand'),
    divider: width => paint('─'.repeat(Math.max(12, Math.min(width ?? 48, 88))), 'muted'),
    status: value => {
      const item = STATUS[value];
      return `${paint(item.icon, item.tone)} ${paint(item.label, item.tone)}`;
    },
  };
}

export function formatDoctorLine(line: { product: string; status: DisplayStatus; detail: string; fix: string | null }, style: TerminalStyle): string[] {
  const badgeWidths: Record<DisplayStatus, number> = { connected: 11, ok: 11, off: 5, missing: 14, broken: 14, unavailable: 10, unverified: 12, error: 7 };
  const output = [`  ${style.status(line.status)}${' '.repeat(Math.max(1, 17 - badgeWidths[line.status]))}${style.paint(line.product, 'bold')}`];
  if (line.detail && line.detail !== 'ok') output.push(`      ${style.paint(line.detail, line.status === 'missing' || line.status === 'broken' || line.status === 'error' ? 'error' : line.status === 'unverified' || line.status === 'unavailable' ? 'warning' : 'muted')}`);
  if (line.fix) output.push(`      ${style.paint('Next', 'brand')}  ${line.fix}`);
  return output;
}

const INIT_HEADINGS = new Set([
  'Tally init proposed changes:', 'Optional integrations', 'Integrations:', 'Model tiers',
  'Neatlogs connection', 'Past-run history (optional)', 'Worker traces (optional)',
  'Entire account', 'Entire CLI setup', 'Entire repository capture', 'Optional Entire browser mirror',
  'cfo.ai connection', 'cfo.ai table setup', 'Ari task context',
]);

export function formatInitLine(line: string, style: TerminalStyle): string {
  if (INIT_HEADINGS.has(line) || /^(?:Ari task context|Entire CLI setup|Entire repository capture|Optional Entire browser mirror)(?:\b|\s*\()/i.test(line)) return style.heading(line);
  if (line === 'Tally init proposed changes:' || line.startsWith('Tally re-init proposed')) return style.heading(line);
  const integrationState = /^(\s{2,})(Neatlogs|Entire|cfo\.ai)(\s+)(on|off)$/i.exec(line);
  if (integrationState) {
    const [, indent, label, gap, state] = integrationState;
    return `${indent}${style.paint(label!, 'bold')}${gap}${state!.toLowerCase() === 'on' ? style.paint('● ON', 'success') : style.paint('○ OFF', 'muted')}`;
  }
  const ariContext = /^(\s{2,})(cfo\.ai Ari context)(\s+)(on)(\b.*)$/i.exec(line);
  if (ariContext) return `${ariContext[1]}${style.paint(ariContext[2]!, 'bold')}${ariContext[3]}${style.paint('● ON', 'success')}${style.paint(ariContext[5]!, 'muted')}`;
  const field = /^(\s{2,})(Runner|Repository|Verification|Setup|Issue label|Budget|Model fallback|Workers)(\s{2,})(?=\S)/.exec(line);
  if (field) return `${field[1]}${style.paint(field[2]!, 'brand')}${field[3]}${line.slice(field[0].length)}`;
  const tier = /^(\s{2,})(Tier \S+)(\s{2,})(?=\S)/.exec(line);
  if (tier) return `${tier[1]}${style.paint(tier[2]!, 'brand')}${tier[3]}${line.slice(tier[0].length)}`;
  const next = /^(\s*)(Next):\s*(.*)$/.exec(line);
  if (next) return `${next[1]}${style.paint('Next', 'brand')}  ${next[3]}`;
  const ok = /^(\s*)([^:]+):\s*(connected|verified|ready)(\b.*)$/i.exec(line);
  if (ok) return `${ok[1]}${style.paint('●', 'success')} ${style.paint(ok[2]!, 'bold')}  ${style.paint(`${ok[3]}${ok[4]}`, 'success')}`;
  if (/^\s*(?:failed|missing|unavailable|error|not confirmed)\b/i.test(line)) return style.paint(line, 'error');
  if (/optional integration|skip this integration|no changes made/i.test(line)) return style.paint(line, 'muted');
  return line;
}

export function formatInitPrompt(question: string, defaultValue: string, style: TerminalStyle): string {
  const suffix = defaultValue ? ` ${style.paint(`[${defaultValue}]`, 'muted')}` : '';
  return `${style.paint('›', 'brand')} ${style.paint(question, 'bold')}${suffix}: `;
}
