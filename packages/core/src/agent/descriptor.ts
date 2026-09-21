/**
 * Synthesising a durable TargetDescriptor from a perceived control.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * This is the file where "the model discovers" becomes "the artifact is
 * reusable", and the design decision in it is the one I would defend hardest:
 *
 *   **The model chooses which control. Swivel decides how to describe it.**
 *
 * The tempting alternative is to ask the model for a locator — "give me a
 * selector for the member number box". Three things go wrong. The model's
 * locator quality varies run to run, so the artifact's durability becomes
 * non-deterministic. It cannot see geometry, so it reaches for the DOM id,
 * which is the least stable evidence available. And it has no idea which value
 * on screen came from a caller-supplied parameter, so it hardcodes `0100482`
 * into a capability that was supposed to work for every member.
 *
 * All three are solved by deriving the descriptor mechanically from the
 * perception snapshot, using rules that never change between runs:
 *
 *   - Prefer the accessible name. If the app gave the control a real name, use it.
 *   - If it has none — the normal case in these apps — find the caption a human
 *     reads instead, and record it as a spatial anchor.
 *   - If it lives in a data grid, record the row by *value*, not by index, and
 *     bind that value to the parameter it came from.
 *   - Always record the id as a *pattern*, never as a literal, and weight it low.
 *   - Rewrite any recorded string that matches the tenant's vocabulary into a
 *     `{{vocab.*}}` reference, so the same artifact reads "Member #" at one
 *     institution and "Customer ID" at the next.
 *
 * The output is deterministic: the same snapshot and the same chosen node
 * produce byte-identical descriptors every time.
 */
import type { TargetDescriptor } from '../artifact/target.js';
import type { Snapshot, UiNode } from '../surface/types.js';
import { canonicaliseId } from '../targeting/resolve.js';
import { captionFor } from './digest.js';

export interface SynthesisContext {
  /** Example inputs supplied by the operator who started discovery. */
  parameters: Record<string, string>;
  /** Tenant vocabulary, e.g. { memberNumber: 'Member #', member: 'Member' }. */
  vocabulary: Record<string, string>;
  /** Base URL of the instance discovery ran against. */
  baseUrl: string;
  /**
   * Name of the institution discovery ran against, e.g. "Pine Ridge Federal
   * Credit Union".
   *
   * Recorded so it can be *removed*. A model writing a summary names the
   * institution it was looking at, and a capability is supposed to describe the
   * vendor product rather than any one customer of it — "one artifact, N
   * overlays" is not true of an artifact whose own summary says Pine Ridge.
   */
  institution?: string;
  /** Ids already allocated in this capability, to keep them unique. */
  usedIds: Set<string>;
}

export interface SynthesisHints {
  /**
   * The value that identifies the grid row the caller meant, in the caller's
   * own terms — "SPECIAL SAVINGS", or a member number.
   *
   * This is the one piece of row semantics the system genuinely cannot infer.
   * Faced with a row whose Account column reads `0100482-01` and whose Type
   * column reads `SPECIAL SAVINGS`, both are valid row keys, but only one
   * matches what the capability is *for*. The model knows which; it supplies
   * the value, and the system still decides how to encode it — including
   * turning it into `{{input.shareType}}` if the operator declared it as a
   * parameter.
   */
  rowMatch?: string;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'control';

function uniqueId(base: string, used: Set<string>): string {
  let id = base, i = 2;
  while (used.has(id)) id = `${base}_${i++}`;
  used.add(id);
  return id;
}

/**
 * Replace literal strings with template references.
 *
 * Longest match first, so a parameter whose value is a substring of another
 * does not shadow it. Vocabulary is matched case-insensitively and only on a
 * whole-string basis: a caption is "Member #" or it is not, and partial
 * vocabulary substitution inside a sentence produces unreadable artifacts.
 */
export function templatise(
  value: string,
  ctx: SynthesisContext,
  opts: { vocabWholeString?: boolean; vocabWords?: boolean } = {},
): string {
  let out = value;

  const params = Object.entries(ctx.parameters)
    .filter(([, v]) => v && String(v).length >= 2)
    .sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [name, v] of params) {
    if (out.includes(String(v))) out = out.split(String(v)).join(`{{input.${name}}}`);
  }

  // The institution's own name, which belongs to the tenant and not the
  // artifact. Done before vocabulary so a name containing a vocabulary word
  // ("Harbor Point Savings Bank") is replaced whole.
  if (ctx.institution && ctx.institution.length >= 4 && out.includes(ctx.institution)) {
    out = out.split(ctx.institution).join('{{tenant.institution}}');
  }

  if (opts.vocabWholeString !== false) {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    for (const [key, term] of Object.entries(ctx.vocabulary)) {
      if (term && norm(out) === norm(term)) return `{{vocab.${key}}}`;
    }
  }

  /**
   * Word-level vocabulary substitution, for phrases rather than labels.
   *
   * A screen titled "MEMBER INQUIRY" at one institution is "CUSTOMER INQUIRY"
   * at the next. Recording the literal pins the capability to one tenant's
   * wording; recording `{{vocab.member}} INQUIRY` makes it travel. Applied only
   * where asked (checkpoint and assertion text), only to terms of four
   * characters or more, and only on whole-word boundaries — substituting inside
   * words would produce unreadable artifacts for no benefit.
   */
  if (opts.vocabWords) {
    const terms = Object.entries(ctx.vocabulary)
      .filter(([, term]) => term && term.length >= 4)
      .sort((a, b) => b[1].length - a[1].length);
    for (const [key, term] of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), `{{vocab.${key}}}`);
    }
  }
  return out;
}

/**
 * Strip one invocation's parameter values out of an output's name.
 *
 * The model names outputs after what it is looking at, so a run parameterised
 * on `shareType = "SPECIAL SAVINGS"` produces `specialSavingsBalance`. That is
 * a perfectly good description of this run and a bad name for the capability:
 * invoke the same artifact with `REGULAR SHARE` and the caller gets a field
 * called `specialSavingsBalance` holding a regular share's balance. It is the
 * same defect as a target pinned to one record, in the part of the artifact a
 * calling agent actually reads.
 *
 * So the parameter's words come out of the name, and what remains is what the
 * field is: `balance`. If nothing would remain, the model's name is kept —
 * a confusing name beats an empty one.
 */
export function generaliseOutputName(name: string, ctx: SynthesisContext): string {
  // camelCase / snake_case / PascalCase → lowercase words.
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  let kept = words;
  for (const raw of Object.values(ctx.parameters)) {
    const value = String(raw ?? '').trim();
    if (value.length < 3) continue;
    const needle = value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
    if (needle.length === 0) continue;
    // Only strip when the whole parameter appears as a contiguous run of
    // words. A partial overlap ("share" from "SHARE DRAFT") is a coincidence
    // of vocabulary, not the parameter leaking in.
    const lower = kept.map((w) => w.toLowerCase());
    for (let i = 0; i + needle.length <= lower.length; i++) {
      if (needle.every((w, j) => lower[i + j] === w)) {
        kept = [...kept.slice(0, i), ...kept.slice(i + needle.length)];
        break;
      }
    }
  }
  if (kept.length === 0 || kept.length === words.length) return name;
  const [head, ...rest] = kept;
  return [
    (head as string).toLowerCase(),
    ...rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()),
  ].join('');
}

/** Rewrite a concrete URL into a portable, parameterised template. */
export function templatiseUrl(url: string, ctx: SynthesisContext): string {
  let out = url;
  const base = ctx.baseUrl.replace(/\/$/, '');
  if (out.startsWith(base)) out = `{{tenant.baseUrl}}${out.slice(base.length)}`;
  return templatise(out, ctx, { vocabWholeString: false });
}

/**
 * Pick the column that best identifies a grid row.
 *
 * There is exactly one good answer and everything else is a compromise: a value
 * the caller supplied. That is what makes the step parameterised — the
 * descriptor records `row where Member # = {{input.memberNumber}}`, and the
 * next invocation finds the next member's row.
 *
 * Everything else is a *literal from this one run*. An account number, a
 * balance, a name: correct once and wrong forever. A capability that ships with
 * `rowWhere.equals: "0100482-01"` fails closed on the next invocation — the
 * resolver refuses rather than clicking the wrong row, which is the right
 * failure — but it is still a capability pinned to one record, which is the
 * thing this module exists to prevent.
 *
 * So a row key is only accepted when it is parameterised or when it is
 * classifier-like (a product type, a status — values drawn from a small fixed
 * vocabulary that mean the same thing for every member). A run-specific
 * identifier is refused, and the caller falls back to a descriptor without a
 * row key: weaker, honestly weaker, and not silently wrong.
 */
function chooseRowKey(node: UiNode, ctx: SynthesisContext, hints?: SynthesisHints): { columnHeader: string; value: string } | null {
  if (!node.table) return null;
  const entries = Object.entries(node.table.rowValues).filter(([h, v]) => h && v && v.length <= 60);
  if (!entries.length) return null;

  /** A value this run was handed, which `templatise` will turn back into a placeholder. */
  const isParameter = (value: string): boolean =>
    Object.values(ctx.parameters).some((pv) => pv && value.trim() === String(pv).trim());

  // 1. What the model said identifies this row — but only if it is a value the
  //    caller supplied or a classifier, held to the same bar as anything else.
  if (hints?.rowMatch) {
    const want = hints.rowMatch.replace(/\s+/g, ' ').trim().toLowerCase();
    const hit = entries.find(([, v]) => v.replace(/\s+/g, ' ').trim().toLowerCase() === want);
    if (hit && (isParameter(hit[1]) || !looksLikeData(hit[1]))) return { columnHeader: hit[0], value: hit[1] };
  }

  // 2. A caller-supplied value anywhere in the row. The best case.
  for (const [header, value] of entries) {
    if (isParameter(value)) return { columnHeader: header, value };
  }

  // 3. A classifier: "SPECIAL SAVINGS", "ACTIVE", "CHECKING". These are the
  //    application's own vocabulary rather than this member's data, so a
  //    descriptor built on one is portable. `looksLikeData` is what tells the
  //    two apart, and it is the same test used for anchors and checkpoints.
  const classifier = entries.find(([, v]) => {
    const t = v.trim();
    return t.length >= 3 && !looksLikeData(t) && /[A-Za-z]/.test(t);
  });
  if (classifier) return { columnHeader: classifier[0], value: classifier[1] };

  // 4. Nothing here identifies the row without identifying the member.
  return null;
}

/**
 * Does this look like a name the application generated rather than wrote?
 *
 * Grid action links ("View", "Select") are real names but non-unique, and
 * button captions are stable. Values that look like data — a balance, an
 * account number — are not names at all and must never become identity.
 */
/**
 * Does this string look like a value rather than a label?
 *
 * Anchors and checkpoints must be built from the application's own vocabulary —
 * captions, headings, screen codes — never from what happens to be on screen
 * for this member today.
 */
export function looksLikeData(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/^[\d.,()$%\s+-]+$/.test(t)) return true;               // amounts, rates, counts
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{2}\/\d{2}\/\d{2,4}$/.test(t)) return true;  // dates
  if (/^[\d-]{5,}$/.test(t)) return true;                      // account and member numbers
  if (/^\*{2,}/.test(t)) return true;                          // masked identifiers
  // Reference numbers the application mints per transaction: SP-3028287,
  // FM-0091284, REV-88410, T-5500121, APR-0028841. These are the single most
  // tempting thing to record as a target's identity and the single most
  // certain to be different on every future run.
  if (/^[A-Za-z]{1,4}[-_ ]?\d{4,}$/.test(t)) return true;
  if (/^[A-Za-z]{2,5}-\d{2,4}-\d{3,}$/.test(t)) return true;
  return false;
}

function nameIsUsable(name: string): boolean {
  if (!name || name.length > 60) return false;
  // The accessible name of a value node IS the value. Recording it as the
  // control's identity pins the capability to one run's data — a confirmation
  // number that will never appear again.
  return !looksLikeData(name);
}

export function synthesiseTarget(node: UiNode, snap: Snapshot, ctx: SynthesisContext, rowHints?: SynthesisHints): TargetDescriptor {
  const evidence: string[] = [];

  // ── id ────────────────────────────────────────────────────────────────────
  const domId = node.raw?.domId;
  // A grid cell's own text is data ("18,402.66"), which makes a terrible
  // identifier. Name it after the column it sits in.
  const baseId = slug(
    (node.table?.columnHeader ? `${node.table.columnHeader}_cell` : '') ||
    (nameIsUsable(node.name) ? node.name : '') ||
    captionFor(node, snap)?.text ||
    (domId ? domId.split('_').pop() ?? domId : '') ||
    `${node.role}`,
  );
  const id = uniqueId(baseId, ctx.usedIds);

  const t: TargetDescriptor = { id, role: node.role };

  // ── frame ─────────────────────────────────────────────────────────────────
  if (node.framePath.length) t.frame = { path: [...node.framePath] };

  // ── accessible name ───────────────────────────────────────────────────────
  if (nameIsUsable(node.name)) {
    // Word-level vocabulary substitution here is what makes most cross-tenant
    // differences need no overlay at all: a nav link reading "Member Search"
    // is recorded as "{{vocab.member}} Search", which resolves to
    // "Customer Search" at an institution that uses that word. It renders back
    // to the identical string at the tenant it was recorded on, so nothing is
    // lost locally and a whole class of overlays never has to be written.
    t.name = { value: templatise(node.name, ctx, { vocabWords: true }), match: node.name.length <= 30 ? 'exact' : 'contains' };
    evidence.push('name');
  }

  // ── relational anchor, when the app gave the control no name ──────────────
  //
  // Skipped for anything inside a data grid: the cell's column and row are its
  // identity, and the text beside a grid cell is the *neighbouring cell's
  // value* — recording "the cell to the right of 18,402.66" bakes one member's
  // balance into a capability meant to serve all of them.
  if (!t.name && !node.table) {
    const cap = captionFor(node, snap);
    if (cap && !looksLikeData(cap.text)) {
      t.anchors = [{
        relation: cap.relation,
        text: { value: templatise(cap.text, ctx), match: 'normalized' },
        maxDistancePx: cap.relation === 'right-of' ? 320 : 80,
      }];
      evidence.push('anchor');
    }
  }

  // ── tabular position ──────────────────────────────────────────────────────
  if (node.table) {
    const key = chooseRowKey(node, ctx, rowHints);
    t.cell = {};
    if (node.table.columnHeader) {
      t.cell.columnHeader = { value: templatise(node.table.columnHeader, ctx), match: 'normalized' };
      evidence.push('column');
    }
    if (key) {
      t.cell.rowWhere = {
        columnHeader: { value: templatise(key.columnHeader, ctx), match: 'normalized' },
        equals: templatise(key.value, ctx, { vocabWholeString: false }),
        match: 'normalized',
      };
      evidence.push('row');
    }
  }

  // ── corroborating hints (low weight, recorded for diagnosis) ──────────────
  const hints: NonNullable<TargetDescriptor['hints']> = { css: [], nearText: [], attrs: {} };
  if (domId) {
    // The literal id is deliberately NOT recorded: it is the single most
    // volatile thing on the screen, and recording it invites a future
    // maintainer to "fix" a broken target by pinning it.
    hints.idPattern = canonicaliseId(domId);
    evidence.push('idPattern');
  }
  if (node.raw?.tag) hints.tag = node.raw.tag;
  if (node.raw?.inputType) hints.inputType = node.raw.inputType;

  // Ordinal is a last resort and only earns a place when nothing semantic
  // identified the control at all.
  if (!t.name && !t.anchors?.length && !t.cell) {
    const peers = snap.nodes.filter((n) => n.role === node.role && n.name === node.name && n.visible &&
      n.framePath.join('/') === node.framePath.join('/'));
    if (peers.length > 1) { hints.ordinal = peers.indexOf(node) + 1; evidence.push('ordinal'); }
  }
  t.hints = hints;

  // ── how much agreement to demand at replay time ───────────────────────────
  // A target backed by strong semantic evidence can afford a high bar. One
  // scraped together from an id pattern and a tag cannot, and lowering the bar
  // for it is honest: the alternative is a capability that refuses to run at
  // all. Its weakness is recorded in `note`, surfaces in validation as
  // SELECTOR_ONLY_TARGET, and drags down the capability's stability score.
  const strong = evidence.includes('name') || evidence.includes('anchor') || evidence.includes('row');
  t.require = { minScore: strong ? 60 : 40, unique: true, timeoutMs: 10_000 };

  t.note = `identified by ${evidence.join(' + ') || 'role only'}${node.name ? '' : ' (control has no accessible name — the application never associated a label)'}`;
  return t;
}
