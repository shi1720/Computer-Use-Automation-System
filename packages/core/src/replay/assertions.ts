/**
 * Evaluating an assertion against a screen.
 *
 * Shared by checkpoints, signal detectors, preconditions and sign-on success
 * checks — they are the same question ("is the screen in this state?") asked at
 * different moments, so they get one implementation and one set of semantics.
 *
 * Text comparison normalises whitespace and case. Legacy apps emit
 * `MSG&nbsp;0042&mdash;NO MEMBER` where the same screen a month later emits
 * `MSG 0042 - NO MEMBER`, and an assertion that breaks on that is measuring the
 * wrong thing.
 */
import type { Assertion } from '../artifact/schema.js';
import type { Snapshot } from '../surface/types.js';
import { resolveTarget } from '../targeting/resolve.js';
import { render, type TemplateContext } from '../artifact/template.js';

export interface AssertionOutcome {
  held: boolean;
  /** What the assertion was looking for, rendered. */
  expected: string;
  /** What was actually there — the debuggable half of a failure report. */
  observed: string;
  because?: string;
}

const flatten = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

function textOf(snap: Snapshot, frameName?: string): string {
  if (!frameName) return Object.values(snap.frameTexts).join('\n');
  return snap.frameTexts[frameName] ?? '';
}

/** Around a match, for the "observed" half of a failure message. */
function excerpt(haystack: string, needle: string, radius = 90): string {
  const i = flatten(haystack).indexOf(flatten(needle));
  if (i < 0) return haystack.replace(/\s+/g, ' ').slice(0, 180);
  return `…${haystack.replace(/\s+/g, ' ').slice(Math.max(0, i - radius), i + needle.length + radius)}…`;
}

export function evaluateAssertion(a: Assertion, snap: Snapshot, ctx: TemplateContext): AssertionOutcome {
  const base = { because: a.because };
  const text = textOf(snap, a.frameName);

  switch (a.kind) {
    case 'text_present':
    case 'text_absent': {
      const want = a.regex ?? (a.text ? render(a.text, ctx) : '');
      const hit = a.regex ? new RegExp(a.regex, 'i').test(text) : flatten(text).includes(flatten(want));
      const held = a.kind === 'text_present' ? hit : !hit;
      return {
        ...base, held,
        expected: `${a.kind === 'text_present' ? 'screen contains' : 'screen does not contain'} ${a.regex ? `/${a.regex}/i` : `"${want}"`}`,
        observed: hit ? excerpt(text, a.regex ? (text.match(new RegExp(a.regex, 'i'))?.[0] ?? want) : want) : `not found (screen: "${text.replace(/\s+/g, ' ').slice(0, 180)}…")`,
      };
    }

    case 'url_matches': {
      const ok = a.regex ? new RegExp(a.regex).test(snap.url) : snap.url.includes(a.text ? render(a.text, ctx) : '');
      return { ...base, held: ok, expected: `url matches ${a.regex ? `/${a.regex}/` : `"${a.text}"`}`, observed: snap.url };
    }

    case 'target_visible':
    case 'target_absent': {
      if (!a.target) return { ...base, held: false, expected: 'a target descriptor', observed: 'assertion declared none' };
      const r = resolveTarget(a.target, snap, { ctx });
      const present = r.ok;
      const held = a.kind === 'target_visible' ? present : !present;
      return {
        ...base, held,
        expected: `${a.kind === 'target_visible' ? 'control present' : 'control absent'}: ${a.target.id} (${a.target.role})`,
        observed: present ? `found, score ${(r as { score: number }).score}` : (r as { message: string }).message,
      };
    }

    case 'value_equals':
    case 'value_matches': {
      if (!a.target) return { ...base, held: false, expected: 'a target descriptor', observed: 'assertion declared none' };
      const r = resolveTarget(a.target, snap, { ctx });
      if (!r.ok) return { ...base, held: false, expected: `value of ${a.target.id}`, observed: r.message };
      const actual = r.node.value ?? r.node.text ?? r.node.name ?? '';
      const want = a.regex ?? (a.text ? render(a.text, ctx) : '');
      const held = a.kind === 'value_equals' ? flatten(actual) === flatten(want) : new RegExp(want, 'i').test(actual);
      return { ...base, held, expected: `${a.target.id} ${a.kind === 'value_equals' ? '==' : 'matches'} "${want}"`, observed: `"${actual}"` };
    }

    default:
      return { ...base, held: false, expected: String(a.kind), observed: 'unknown assertion kind' };
  }
}

export interface CheckpointOutcome {
  held: boolean;
  results: Array<AssertionOutcome & { index: number }>;
  /** The first assertion that failed, which is what a human wants to see. */
  firstFailure?: AssertionOutcome & { index: number };
}

export function evaluateAll(assertions: Assertion[], snap: Snapshot, ctx: TemplateContext): CheckpointOutcome {
  const results = assertions.map((a, index) => ({ ...evaluateAssertion(a, snap, ctx), index }));
  const firstFailure = results.find((r) => !r.held);
  return { held: !firstFailure, results, ...(firstFailure ? { firstFailure } : {}) };
}

/** Any-of semantics, used by signal detectors. */
export function evaluateAny(assertions: Assertion[], snap: Snapshot, ctx: TemplateContext): AssertionOutcome | null {
  for (const a of assertions) {
    const r = evaluateAssertion(a, snap, ctx);
    if (r.held) return r;
  }
  return null;
}
