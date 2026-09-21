/**
 * Enforcing the capability's public contract.
 *
 * Validation runs before the browser opens. A capability invoked with a member
 * number containing letters should be rejected in microseconds with a message
 * the calling agent can act on — not after four screens, a form post and a
 * screenshot of a validation error.
 *
 * The other half is coercion on the way out: a balance read off a green screen
 * is the string "18,402.66", and handing that to an AI agent that then does
 * arithmetic on it is a bug waiting to happen. The contract says `money`, so
 * the caller gets a number.
 */
import type { FieldDef } from '../artifact/schema.js';

export type Validated =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; message: string; errors: Array<{ field: string; problem: string }> };

export function validateInputs(fields: FieldDef[], supplied: Record<string, unknown>): Validated {
  const errors: Array<{ field: string; problem: string }> = [];
  const values: Record<string, unknown> = {};

  for (const f of fields) {
    const raw = supplied[f.name];
    if (raw === undefined || raw === null || raw === '') {
      if (f.required) errors.push({ field: f.name, problem: 'is required but was not supplied' });
      continue;
    }
    const s = String(raw);

    switch (f.type) {
      case 'integer':
        if (!/^-?\d+$/.test(s.trim())) { errors.push({ field: f.name, problem: `must be an integer, got "${s}"` }); continue; }
        values[f.name] = Number(s);
        break;
      case 'number':
      case 'money': {
        const n = Number(s.replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n)) { errors.push({ field: f.name, problem: `must be a number, got "${s}"` }); continue; }
        values[f.name] = n;
        break;
      }
      case 'boolean':
        values[f.name] = ['true', '1', 'yes', 'y'].includes(s.toLowerCase());
        break;
      case 'date':
        if (Number.isNaN(Date.parse(s))) { errors.push({ field: f.name, problem: `must be a date, got "${s}"` }); continue; }
        values[f.name] = s;
        break;
      case 'enum':
        if (f.enumValues?.length && !f.enumValues.includes(s)) {
          errors.push({ field: f.name, problem: `must be one of [${f.enumValues.join(', ')}], got "${s}"` });
          continue;
        }
        values[f.name] = s;
        break;
      default:
        values[f.name] = s;
    }

    if (f.pattern) {
      let re: RegExp | null = null;
      try { re = new RegExp(f.pattern); } catch { /* a malformed pattern must not block a caller */ }
      if (re && !re.test(String(values[f.name] ?? s))) {
        errors.push({ field: f.name, problem: `does not match the required format ${f.pattern}${f.example ? ` (e.g. "${f.example}")` : ''}` });
      }
    }
  }

  // Unknown inputs are rejected rather than ignored. A caller that misspells
  // `memberNumber` deserves an error, not a run against a default.
  const known = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(supplied)) {
    if (!known.has(k)) errors.push({ field: k, problem: `is not an input of this capability (expected: ${[...known].join(', ') || 'none'})` });
  }

  if (errors.length) {
    return { ok: false, errors, message: errors.map((e) => `"${e.field}" ${e.problem}`).join('; ') };
  }
  return { ok: true, values };
}

/** Normalise a value scraped off a screen into the type the contract promises. */
export function coerceOutput(raw: string, transform: string | undefined, declaredType?: FieldDef['type']): unknown {
  let v: string = raw;
  switch (transform) {
    case 'trim': v = raw.trim(); break;
    case 'upper': v = raw.trim().toUpperCase(); break;
    case 'lower': v = raw.trim().toLowerCase(); break;
    case 'digits_only': v = raw.replace(/\D/g, ''); break;
    case 'iso_date': { const d = new Date(raw.trim()); v = Number.isNaN(d.getTime()) ? raw.trim() : (d.toISOString().slice(0, 10) as string); break; }
    case 'money_to_number': {
      const t = raw.trim();
      // Accounting parentheses mean negative. Getting this wrong flips the sign
      // on an overdrawn balance, which is exactly the kind of quiet error that
      // makes an automation untrustworthy.
      const negative = /^\(.*\)$/.test(t) || t.endsWith('-');
      const n = Number(t.replace(/[(),$\s-]/g, ''));
      return Number.isFinite(n) ? (negative ? -n : n) : null;
    }
    default: v = raw.trim();
  }

  if (declaredType === 'money' || declaredType === 'number') {
    const n = Number(String(v).replace(/[(),$\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (declaredType === 'integer') {
    const n = Number.parseInt(String(v).replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
  return v;
}
