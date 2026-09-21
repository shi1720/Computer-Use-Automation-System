/**
 * Redaction.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * This system reads screens full of regulated data and writes evidence bundles
 * that will outlive it. Two rules follow, and they are enforced here rather than
 * left to the discipline of whoever writes the next logging call:
 *
 *  1. **Nothing sensitive is written, ever.** Not to artifacts, not to run logs,
 *     not to evidence, not to the console's database. Redaction happens at the
 *     boundary where a value enters the record, not when it leaves.
 *
 *  2. **Redacted values stay correlatable.** Replacing a member number with
 *     `[REDACTED]` destroys the ability to answer "did these two runs touch the
 *     same record?", which is the first question asked in any incident review.
 *     So a redacted value becomes a keyed hash — `«pii:7f3a9c21»` — stable for a
 *     given deployment salt, meaningless without it, and comparable.
 *
 * Classification comes from the capability contract first (`sensitivity` on each
 * field, declared at design time and reviewed) and from pattern matching second.
 * The patterns are a backstop for text scraped off a screen, where nobody
 * declared anything — not the primary control. A system that relies on regexes
 * to find PII will eventually miss some.
 */
import { createHmac } from 'node:crypto';
import type { FieldDef, Sensitivity } from '../artifact/schema.js';

export interface RedactionOptions {
  /** Per-deployment salt. Rotating it breaks correlation with older evidence, deliberately. */
  salt: string;
  /** Extra regexes from capability policy. */
  extraPatterns?: string[];
  /** Show the last N characters of PII values, the way a bank statement does. */
  revealTail?: number;
}

export interface RedactionEvent {
  at: string;
  kind: 'field' | 'pattern';
  rule: string;
  /** Where it happened, e.g. `step:search_member.value`. */
  at_path: string;
}

/**
 * Built-in patterns.
 *
 * Ordered most- to least-specific: a card number must be matched before the
 * generic long-digit-run rule gets to it, or the evidence will say "account
 * number" about a PAN.
 */
const BUILT_IN: Array<{ name: string; re: RegExp; kind: Sensitivity }> = [
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, kind: 'pii' },
  { name: 'card_pan', re: /\b(?:\d[ -]*?){13,19}\b/g, kind: 'sensitive' },
  { name: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,24}\b/g, kind: 'pii' },
  { name: 'us_phone', re: /\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/g, kind: 'pii' },
  { name: 'routing_number', re: /\b[0-9]{9}\b/g, kind: 'sensitive' },
  { name: 'bearer_token', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/g, kind: 'secret' },
  { name: 'password_kv', re: /\b(?:password|passwd|pwd|secret|token)\s*[:=]\s*\S+/gi, kind: 'secret' },
];

/** Luhn check, so a 16-digit reference number is not mistaken for a card. */
function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

export class Redactor {
  private readonly extra: Array<{ name: string; re: RegExp }>;
  readonly events: RedactionEvent[] = [];

  constructor(private readonly opts: RedactionOptions) {
    this.extra = (opts.extraPatterns ?? []).map((p, i) => ({ name: `policy[${i}]`, re: new RegExp(p, 'g') }));
  }

  /** Stable, salted, non-reversible token. */
  token(value: string, kind: Sensitivity): string {
    const h = createHmac('sha256', this.opts.salt).update(value).digest('hex').slice(0, 8);
    const tail = this.opts.revealTail && kind !== 'secret' && value.length > this.opts.revealTail
      ? `…${value.slice(-this.opts.revealTail)}` : '';
    return `«${kind}:${h}${tail}»`;
  }

  /** Redact one value whose classification is known from the contract. */
  field(value: unknown, sensitivity: Sensitivity | undefined, path: string): unknown {
    const s = sensitivity ?? 'internal';
    if (value === null || value === undefined) return value;
    if (s === 'public' || s === 'internal') return value;
    if (s === 'secret') {
      this.events.push({ at: new Date().toISOString(), kind: 'field', rule: 'secret', at_path: path });
      return '«secret:withheld»';
    }
    this.events.push({ at: new Date().toISOString(), kind: 'field', rule: s, at_path: path });
    return this.token(String(value), s);
  }

  /** Redact free text scraped off a screen. Pattern-based backstop. */
  text(input: string, path = 'text'): string {
    let out = input;
    for (const p of BUILT_IN) {
      out = out.replace(p.re, (m) => {
        if (p.name === 'card_pan' && !luhnValid(m)) return m;
        if (p.name === 'routing_number' && /\b(19|20)\d{7}\b/.test(m)) return m; // date-like
        this.events.push({ at: new Date().toISOString(), kind: 'pattern', rule: p.name, at_path: path });
        return this.token(m, p.kind);
      });
    }
    for (const p of this.extra) {
      out = out.replace(p.re, (m) => {
        this.events.push({ at: new Date().toISOString(), kind: 'pattern', rule: p.name, at_path: path });
        return this.token(m, 'pii');
      });
    }
    return out;
  }

  /** Redact a whole record against a set of declared fields. */
  record(values: Record<string, unknown>, fields: FieldDef[], path: string): Record<string, unknown> {
    const byName = new Map(fields.map((f) => [f.name, f]));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const f = byName.get(k);
      out[k] = typeof v === 'string' && !f
        ? this.text(v, `${path}.${k}`)                 // undeclared: patterns only
        : this.field(v, f?.sensitivity, `${path}.${k}`);
    }
    return out;
  }

  /** Deep-redact an arbitrary JSON structure with pattern rules only. */
  deep<T>(value: T, path = '$'): T {
    if (typeof value === 'string') return this.text(value, path) as unknown as T;
    if (Array.isArray(value)) return value.map((v, i) => this.deep(v, `${path}[${i}]`)) as unknown as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.deep(v, `${path}.${k}`)]),
      ) as unknown as T;
    }
    return value;
  }

  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.events) out[e.rule] = (out[e.rule] ?? 0) + 1;
    return out;
  }
}

/** Default deployment salt. Real deployments inject one from a secret manager. */
export function defaultSalt(): string {
  return process.env.SWIVEL_REDACTION_SALT ?? 'swivel-local-development-salt';
}
