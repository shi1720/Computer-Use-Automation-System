/**
 * Deterministic target resolution.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Given a `TargetDescriptor` and a `Snapshot`, decide which control the artifact
 * meant — or refuse.
 *
 * The refusal is the important half. A resolver that always returns its best
 * guess will, on the day a tenant adds a column to a grid, confidently click the
 * wrong row of a fee-reversal screen. So resolution produces a *score* and a
 * *margin*, and the engine acts only when both clear the thresholds the artifact
 * declared. Below that it fails loudly, with the list of which evidence matched
 * and which did not, which is exactly the information a human needs to fix it.
 *
 * The algorithm:
 *   1. Gate on role and visibility. Role is never scored — a button is not a
 *      partial match for a textbox, and treating it as one is how automation
 *      types a member number into a page heading.
 *   2. Scope: restrict to the declared frame, and to the descendants of the
 *      declared container.
 *   3. Score each survivor by weighted evidence agreement, where the weights
 *      encode a claim about what survives change in enterprise software
 *      (see PROBE_WEIGHTS).
 *   4. Normalise to 0-100 against the evidence that was *available to check*, so
 *      a sparse descriptor is not punished for the probes it never recorded.
 *   5. Require the winner to clear `minScore` and, if uniqueness is demanded, to
 *      beat the runner-up by a clear margin.
 *
 * Everything here is pure: snapshot in, decision out. No I/O, no waiting, no
 * browser. That is what makes it testable, and it is also what makes the desktop
 * surface a drop-in — this file never learns what a DOM is.
 */
import { ANCHOR_WEIGHT_CAP, PROBE_WEIGHTS, type TargetDescriptor } from '../artifact/target.js';
import type { Snapshot, UiNode } from '../surface/types.js';
import { render, type TemplateContext } from '../artifact/template.js';
import { z } from 'zod';

export interface ProbeResult {
  probe: string;
  weight: number;
  matched: boolean;
  detail?: string;
}

export interface Candidate {
  node: UiNode;
  score: number;
  probes: ProbeResult[];
}

export type Resolution =
  | {
      ok: true;
      node: UiNode;
      score: number;
      /** Points between the winner and the runner-up. High margin = unambiguous. */
      margin: number;
      matched: string[];
      missed: string[];
      candidatesConsidered: number;
    }
  | {
      ok: false;
      reason: 'no_candidates' | 'below_min_score' | 'ambiguous';
      /** Best few candidates, for the failure report. */
      best: Array<{ score: number; name: string; role: string; domId?: string; matched: string[]; missed: string[] }>;
      candidatesConsidered: number;
      message: string;
    };

/** Winner must beat the runner-up by this many points when `unique` is set. */
export const UNIQUENESS_MARGIN = 12;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const fold = (s: string): string => norm(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9$#%.,:/'\- ]/g, '');

type TextProbe = z.infer<typeof import('../artifact/target.js').TextProbeSchema>;

export function textMatches(probe: { value: string; match?: string }, actual: string, ctx?: TemplateContext): boolean {
  let expected = probe.value;
  if (ctx) { try { expected = render(expected, ctx); } catch { /* unresolved template cannot match */ return false; } }
  const mode = probe.match ?? 'normalized';
  switch (mode) {
    case 'exact': return norm(actual) === norm(expected);
    case 'normalized': return fold(actual) === fold(expected);
    case 'contains': return fold(actual).includes(fold(expected));
    case 'startsWith': return fold(actual).startsWith(fold(expected));
    case 'regex': { try { return new RegExp(expected, 'i').test(actual); } catch { return false; } }
    default: return fold(actual) === fold(expected);
  }
}

/**
 * Canonicalise a generated control id into a pattern.
 *
 * `ctl00_Main_grdResults_ctl03_lnkView` -> `ctl00_Main_grdResults_ctl\d+_lnkView`
 *
 * The digits in a WebForms id encode the control's ordinal in its container at
 * render time. They change when a row is added. The rest of the id is the
 * developer's naming and is genuinely stable, so recording the shape rather than
 * the literal buys real durability at zero cost.
 */
export function canonicaliseId(domId: string): string {
  return domId.replace(/\d+/g, '\\d+');
}

const sameFrame = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Do these two boxes share a visual row?
 *
 * Tested by actual vertical overlap rather than centre proximity. Legacy forms
 * pack rows 16-18px apart, and a centre-distance tolerance wide enough to catch
 * a tall control also catches the row above it — which is how automation ends
 * up reading the SSN field as though it were labelled "Member #".
 */
function onSameRow(a: NonNullable<UiNode['bounds']>, b: NonNullable<UiNode['bounds']>): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap >= Math.min(a.h, b.h) * 0.5;
}
function inSameColumn(a: NonNullable<UiNode['bounds']>, b: NonNullable<UiNode['bounds']>): boolean {
  const aMid = a.x + a.w / 2;
  const bMid = b.x + b.w / 2;
  return Math.abs(aMid - bMid) <= Math.max(a.w, b.w) / 2 + 24;
}

function ancestorsOf(node: UiNode, byRef: Map<string, UiNode>): UiNode[] {
  const out: UiNode[] = [];
  let cur = node.parentRef ? byRef.get(node.parentRef) : undefined;
  let guard = 0;
  while (cur && guard++ < 64) { out.push(cur); cur = cur.parentRef ? byRef.get(cur.parentRef) : undefined; }
  return out;
}

function isDescendantOf(node: UiNode, containerRef: string, byRef: Map<string, UiNode>): boolean {
  let cur = node.parentRef ? byRef.get(node.parentRef) : undefined;
  let guard = 0;
  while (cur && guard++ < 64) { if (cur.ref === containerRef) return true; cur = cur.parentRef ? byRef.get(cur.parentRef) : undefined; }
  return false;
}

export interface ResolveOptions {
  ctx?: TemplateContext;
  /** Consider invisible nodes too — used by `target_absent` assertions. */
  includeInvisible?: boolean;
}

export function resolveTarget(target: TargetDescriptor, snap: Snapshot, opts: ResolveOptions = {}): Resolution {
  const byRef = new Map(snap.nodes.map((n) => [n.ref, n]));
  // Defaults live here, in the engine, not in the document: an artifact that
  // omits a threshold gets the current one rather than whichever one happened
  // to be current on the day it was recorded.
  const req = {
    minScore: target.require?.minScore ?? 55,
    unique: target.require?.unique ?? true,
    timeoutMs: target.require?.timeoutMs ?? 10_000,
  };

  // ── 1-2. gate and scope ──────────────────────────────────────────────────
  let pool = snap.nodes.filter((n) => n.role === target.role && (opts.includeInvisible || n.visible));

  if (target.frame) {
    const want = target.frame.path;
    pool = pool.filter((n) => sameFrame(n.framePath, want));
  }

  let containerRef: string | undefined;
  if (target.within) {
    const inner = resolveTarget(target.within, snap, opts);
    if (!inner.ok) {
      return {
        ok: false, reason: 'no_candidates', candidatesConsidered: 0, best: [],
        message: `Container "${target.within.id}" for target "${target.id}" could not be resolved: ${inner.message}`,
      };
    }
    containerRef = inner.node.ref;
    pool = pool.filter((n) => isDescendantOf(n, containerRef as string, byRef));
  }

  if (pool.length === 0) {
    return {
      ok: false, reason: 'no_candidates', candidatesConsidered: 0, best: [],
      message: `No ${target.role} elements${target.frame ? ` in frame "${target.frame.path.join('/') || '(top)'}"` : ''} are present on this screen.`,
    };
  }

  // Document order per frame, used by the `after-text` relation.
  const orderIndex = new Map(snap.nodes.map((n, i) => [n.ref, i]));

  // ── 3. score ─────────────────────────────────────────────────────────────
  const candidates: Candidate[] = pool.map((node) => {
    const probes: ProbeResult[] = [];
    const add = (probe: string, weight: number, matched: boolean, detail?: string) =>
      probes.push(detail === undefined ? { probe, weight, matched } : { probe, weight, matched, detail });

    // accessible name
    if (target.name) {
      const isExact = (target.name.match ?? 'normalized') === 'exact';
      const w = isExact ? PROBE_WEIGHTS.name_exact : PROBE_WEIGHTS.name_fuzzy;
      add('name', w, textMatches(target.name, node.name, opts.ctx), `"${node.name}"`);
    }

    // relational anchors
    if (target.anchors?.length) {
      let anchorScore = 0;
      const per = Math.min(PROBE_WEIGHTS.anchor, ANCHOR_WEIGHT_CAP / target.anchors.length);
      for (const a of target.anchors) {
        const hit = anchorHolds(a, node, snap, opts.ctx, orderIndex, byRef);
        if (hit) anchorScore += per;
        add(`anchor:${a.relation}("${a.text.value}")`, per, hit);
      }
      void anchorScore;
    }

    // table semantics
    if (target.cell) {
      if (target.cell.columnHeader) {
        add('cell.columnHeader', PROBE_WEIGHTS.cell_column,
          Boolean(node.table?.columnHeader && textMatches(target.cell.columnHeader, node.table.columnHeader, opts.ctx)),
          node.table?.columnHeader);
      }
      if (target.cell.rowWhere) {
        const rw = target.cell.rowWhere;
        let hit = false;
        let seen = '';
        if (node.table) {
          for (const [header, value] of Object.entries(node.table.rowValues)) {
            if (!textMatches(rw.columnHeader, header, opts.ctx)) continue;
            seen = value;
            hit = textMatches({ value: rw.equals, match: rw.match }, value, opts.ctx);
            break;
          }
        }
        add(`cell.rowWhere(${rw.columnHeader.value}=${rw.equals})`, PROBE_WEIGHTS.cell_row_match, hit, seen);
      }
      if (target.cell.rowIndex !== undefined) {
        add('cell.rowIndex', PROBE_WEIGHTS.cell_row_index, node.table?.rowIndex === target.cell.rowIndex);
      }
    }

    if (containerRef) add('within', PROBE_WEIGHTS.within_container, true);

    // corroborating hints
    const h = target.hints;
    if (h) {
      if (h.domId !== undefined) add('hints.domId', PROBE_WEIGHTS.dom_id, node.raw?.domId === h.domId, node.raw?.domId);
      if (h.idPattern !== undefined) {
        let ok = false;
        try { ok = Boolean(node.raw?.domId && new RegExp(`^${h.idPattern}$`).test(node.raw.domId)); } catch { ok = false; }
        add('hints.idPattern', PROBE_WEIGHTS.id_pattern, ok, node.raw?.domId);
      }
      if (h.tag !== undefined) add('hints.tag', PROBE_WEIGHTS.tag, node.raw?.tag === h.tag);
      if (h.inputType !== undefined) add('hints.inputType', PROBE_WEIGHTS.tag, node.raw?.inputType === h.inputType);
      if (h.attrs && Object.keys(h.attrs).length) {
        const all = Object.entries(h.attrs).every(([k, v]) => node.raw?.attrs?.[k] === v);
        add('hints.attrs', PROBE_WEIGHTS.attrs, all);
      }
      if (h.nearText?.length) {
        const frameText = snap.frameTexts[node.framePath.join('/') || '(top)'] ?? '';
        const near = h.nearText.every((t) => fold(frameText).includes(fold(t)));
        add('hints.nearText', PROBE_WEIGHTS.near_text, near);
      }
      if (h.ordinal !== undefined) {
        const peers = pool.filter((p) => p.name === node.name && p.role === node.role);
        add('hints.ordinal', PROBE_WEIGHTS.ordinal, peers.indexOf(node) + 1 === h.ordinal);
      }
    }

    // visual evidence (unused by the web surface; scored so the model is shared)
    if (target.visual?.bboxRatio && node.bounds) {
      const [rx, ry] = target.visual.bboxRatio;
      const vw = 1280, vh = 860; // frame-local reference; surfaces normalise
      const dx = Math.abs(node.bounds.x / vw - rx), dy = Math.abs(node.bounds.y / vh - ry);
      add('visual.bbox', PROBE_WEIGHTS.visual_bbox, dx < 0.08 && dy < 0.08);
    }

    const available = probes.reduce((a, p) => a + p.weight, 0);
    const earned = probes.reduce((a, p) => a + (p.matched ? p.weight : 0), 0);
    // A descriptor with no probes at all (role only) scores 0: role is a gate,
    // not evidence, and "the only button on the page" is not an identification.
    const score = available === 0 ? 0 : Math.round((earned / available) * 100);
    return { node, score, probes };
  });

  candidates.sort((a, b) => b.score - a.score || (a.node.bounds?.y ?? 0) - (b.node.bounds?.y ?? 0));
  const top = candidates[0] as Candidate;
  const runnerUp = candidates[1];
  const margin = top.score - (runnerUp?.score ?? 0);

  const describe = (c: Candidate) => ({
    score: c.score,
    name: c.node.name,
    role: c.node.role,
    ...(c.node.raw?.domId ? { domId: c.node.raw.domId } : {}),
    matched: c.probes.filter((p) => p.matched).map((p) => p.probe),
    missed: c.probes.filter((p) => !p.matched).map((p) => p.probe),
  });

  if (top.score < req.minScore) {
    return {
      ok: false, reason: 'below_min_score', candidatesConsidered: candidates.length,
      best: candidates.slice(0, 3).map(describe),
      message: `Best candidate for "${target.id}" scored ${top.score}, below the required ${req.minScore}. ` +
        `Matched: [${describe(top).matched.join(', ') || 'nothing'}]. Missed: [${describe(top).missed.join(', ')}].`,
    };
  }
  if (req.unique && runnerUp && margin < UNIQUENESS_MARGIN) {
    return {
      ok: false, reason: 'ambiguous', candidatesConsidered: candidates.length,
      best: candidates.slice(0, 3).map(describe),
      message: `Target "${target.id}" is ambiguous: ${candidates.filter((c) => c.score >= top.score - UNIQUENESS_MARGIN).length} ` +
        `candidates within ${UNIQUENESS_MARGIN} points of the best (${top.score} vs ${runnerUp.score}). Refusing to guess.`,
    };
  }

  return {
    ok: true,
    node: top.node,
    score: top.score,
    margin: runnerUp ? margin : 100,
    matched: describe(top).matched,
    missed: describe(top).missed,
    candidatesConsidered: candidates.length,
  };
}

/** Evaluate one relational anchor against one candidate. */
function anchorHolds(
  a: { relation: string; text: { value: string; match?: string }; maxDistancePx?: number },
  node: UiNode,
  snap: Snapshot,
  ctx: TemplateContext | undefined,
  orderIndex: Map<string, number>,
  byRef: Map<string, UiNode>,
): boolean {
  const maxD = a.maxDistancePx ?? 320;
  const sameFrameNodes = snap.nodes.filter((n) => sameFrame(n.framePath, node.framePath));
  const textCarriers = sameFrameNodes.filter((n) => n.ref !== node.ref && textMatches(a.text, n.text ?? n.name ?? '', ctx));

  /**
   * Spatial anchors mean the NEAREST label in that direction, not any label.
   *
   * "The box to the right of Member #" is only a useful description because a
   * person reads the caption immediately beside the box. On a row laid out as
   *   [Member #][___]   [Last Name][___]
   * every caption is technically to the left of the second box, so an
   * any-match rule makes both boxes equally valid for both anchors — and the
   * resolver then correctly, and uselessly, refuses the whole step as
   * ambiguous. Nearest-match is what makes the anchor mean something.
   *
   * The tolerance absorbs nested wrappers: a caption is typically a <b> inside
   * a <font> inside a <td>, three nodes reporting the same words at edges a few
   * pixels apart.
   */
  const NEST_TOLERANCE_PX = 12;
  const nearestMatches = (
    inDirection: (n: UiNode) => boolean,
    edgeOf: (n: UiNode) => number,
    /** true when a is nearer to the control than b */
    nearer: (a: number, b: number) => boolean,
  ): boolean => {
    if (!node.bounds) return false;
    const carriers = sameFrameNodes.filter((n) => n.ref !== node.ref && n.bounds && (n.text ?? n.name ?? '').trim() && inDirection(n));
    if (!carriers.length) return false;
    let bestEdge = edgeOf(carriers[0] as UiNode);
    for (const n of carriers) if (nearer(edgeOf(n), bestEdge)) bestEdge = edgeOf(n);
    return carriers.some((n) =>
      Math.abs(edgeOf(n) - bestEdge) <= NEST_TOLERANCE_PX &&
      textMatches(a.text, n.text ?? n.name ?? '', ctx));
  };

  switch (a.relation) {
    case 'labelled-by':
      return Boolean(node.labelled) && textMatches(a.text, node.name, ctx);

    case 'right-of':
      return nearestMatches(
        (n) => Boolean(n.bounds && node.bounds && onSameRow(n.bounds, node.bounds) &&
          n.bounds.x + n.bounds.w <= node.bounds.x + 4 &&
          node.bounds.x - (n.bounds.x + n.bounds.w) <= maxD),
        (n) => (n.bounds as NonNullable<UiNode['bounds']>).x + (n.bounds as NonNullable<UiNode['bounds']>).w,
        (x, best) => x > best,
      );

    case 'left-of':
      return nearestMatches(
        (n) => Boolean(n.bounds && node.bounds && onSameRow(n.bounds, node.bounds) &&
          node.bounds.x + node.bounds.w <= n.bounds.x + 4 &&
          n.bounds.x - (node.bounds.x + node.bounds.w) <= maxD),
        (n) => (n.bounds as NonNullable<UiNode['bounds']>).x,
        (x, best) => x < best,
      );

    case 'below':
      return nearestMatches(
        (n) => Boolean(n.bounds && node.bounds && inSameColumn(n.bounds, node.bounds) &&
          node.bounds.y >= n.bounds.y + n.bounds.h - 4 &&
          node.bounds.y - (n.bounds.y + n.bounds.h) <= maxD),
        (n) => (n.bounds as NonNullable<UiNode['bounds']>).y + (n.bounds as NonNullable<UiNode['bounds']>).h,
        (y, best) => y > best,
      );

    case 'above':
      return nearestMatches(
        (n) => Boolean(n.bounds && node.bounds && inSameColumn(n.bounds, node.bounds) &&
          n.bounds.y >= node.bounds.y + node.bounds.h - 4 &&
          n.bounds.y - (node.bounds.y + node.bounds.h) <= maxD),
        (n) => (n.bounds as NonNullable<UiNode['bounds']>).y,
        (y, best) => y < best,
      );

    case 'in-row-with':
      if (node.table) return Object.values(node.table.rowValues).some((v) => textMatches(a.text, v, ctx));
      return textCarriers.some((t) => t.bounds && node.bounds && onSameRow(t.bounds, node.bounds));

    case 'after-text': {
      const myIdx = orderIndex.get(node.ref) ?? -1;
      return textCarriers.some((t) => {
        const ti = orderIndex.get(t.ref) ?? Number.MAX_SAFE_INTEGER;
        return ti < myIdx;
      });
    }

    case 'within-region':
      return ancestorsOf(node, byRef).some((anc) => textMatches(a.text, anc.text ?? '', ctx));

    default:
      return false;
  }
}

/** Compact one-line description for logs and failure output. */
export function describeTarget(t: TargetDescriptor): string {
  const bits: string[] = [t.role];
  if (t.name) bits.push(`name~"${t.name.value}"`);
  if (t.cell?.rowWhere) bits.push(`row[${t.cell.rowWhere.columnHeader.value}=${t.cell.rowWhere.equals}]`);
  if (t.cell?.columnHeader) bits.push(`col[${t.cell.columnHeader.value}]`);
  for (const a of t.anchors ?? []) bits.push(`${a.relation}("${a.text.value}")`);
  if (t.frame?.path.length) bits.push(`frame=${t.frame.path.join('/')}`);
  return `${t.id} { ${bits.join(' ')} }`;
}
