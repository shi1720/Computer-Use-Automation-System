/**
 * Terminal presentation.
 *
 * A CLI that reports on automation acting against a bank's core system is read
 * under pressure — usually while something is broken. Legibility is a feature,
 * so this is a small, dependency-free formatting layer rather than a log dump.
 */
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColour ? `\u001b[${code}m${s}\u001b[0m` : s);

export const c = {
  dim: wrap('2'), bold: wrap('1'), italic: wrap('3'),
  red: wrap('31'), green: wrap('32'), yellow: wrap('33'),
  blue: wrap('34'), magenta: wrap('35'), cyan: wrap('36'), grey: wrap('90'),
  bgGreen: wrap('42;30'), bgRed: wrap('41;37'), bgYellow: wrap('43;30'), bgBlue: wrap('44;37'), bgGrey: wrap('100;37'),
};

export const SYMBOL = { ok: '✓', fail: '✗', warn: '!', info: '·', arrow: '→', bullet: '•' };

const WIDTH = Math.min(process.stdout.columns ?? 92, 96);

export function rule(label?: string): string {
  if (!label) return c.grey('─'.repeat(WIDTH));
  const text = ` ${label} `;
  const left = 2;
  return c.grey(`${'─'.repeat(left)}${text}${'─'.repeat(Math.max(0, WIDTH - left - text.length))}`);
}

export function banner(title: string, subtitle?: string): string {
  return [
    '',
    `  ${c.bold(c.cyan('◧ SWIVEL'))}  ${c.grey('·')}  ${c.bold(title)}`,
    subtitle ? `  ${c.grey(subtitle)}` : '',
    rule(),
  ].filter(Boolean).join('\n');
}

export function kv(pairs: Array<[string, string | number | undefined]>, indent = 2): string {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${' '.repeat(indent)}${c.grey(k.padEnd(width))}  ${v}`)
    .join('\n');
}

export function statusChip(status: string): string {
  switch (status) {
    case 'success': return c.bgGreen(' SUCCESS ');
    case 'business_outcome': return c.bgBlue(' OUTCOME ');
    case 'escalated': return c.bgYellow(' ESCALATED ');
    case 'failed': return c.bgRed(' FAILED ');
    case 'approved': return c.green('approved');
    case 'candidate': return c.yellow('candidate');
    case 'draft': return c.grey('draft');
    case 'deprecated': return c.grey('deprecated');
    default: return status;
  }
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  const line = (cells: string[], pad: (s: string) => string = (s) => s) =>
    `  ${cells.map((cell, i) => pad(cell) + ' '.repeat(Math.max(0, (widths[i] as number) - stripAnsi(cell).length))).join('   ')}`;
  return [line(headers, c.grey), c.grey(`  ${widths.map((w) => '─'.repeat(w)).join('───')}`), ...rows.map((r) => line(r))].join('\n');
}

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

/** Live event line, used while a run is in flight. */
export function event(kind: string, message: string): string {
  const colour =
    kind.startsWith('step.failed') || kind.includes('blocked') ? c.red
    : kind.startsWith('signal') || kind.startsWith('escalation') ? c.yellow
    : kind.startsWith('recovery') ? c.magenta
    : kind.startsWith('model') ? c.cyan
    : kind.startsWith('policy') ? c.blue
    : c.grey;
  return `  ${colour(kind.padEnd(22))} ${message.length > 150 ? `${message.slice(0, 150)}…` : message}`;
}

export function money(usd: number): string {
  return usd === 0 ? c.green('$0.0000') : `$${usd.toFixed(4)}`;
}

export function fail(message: string): never {
  process.stderr.write(`\n  ${c.bgRed(' ERROR ')} ${message}\n\n`);
  process.exit(1);
}
