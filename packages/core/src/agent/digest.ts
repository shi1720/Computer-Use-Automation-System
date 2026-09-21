/**
 * Turning a screen into something a model can reason about.
 *
 * A snapshot of a legacy screen is ~1,500 nodes. Sending that costs a fortune
 * and buries the model in `<font>` tags. The digest below is the filtered,
 * annotated view: every control the operator could actually use, each with the
 * *handle* a human would use to describe it — the caption to its left, or the
 * grid row it sits in.
 *
 * Two deliberate choices:
 *
 *  - **Refs, not selectors.** The model picks a control by its `[n12]` handle.
 *    It never writes a locator. Swivel derives the durable descriptor from the
 *    perception data (see `descriptor.ts`), which keeps artifact quality
 *    independent of how good the model is at CSS.
 *
 *  - **Messages are surfaced, loudly.** Legacy cores put the thing you need to
 *    know — "MSG 0042 NO MEMBER RECORD FOUND" — in an unremarkable box
 *    somewhere. Those are pulled out and listed separately, because they are
 *    the single most important signal on the screen and a model scanning a wall
 *    of table cells will miss them.
 */
import type { Snapshot, UiNode } from '../surface/types.js';

const INTERACTIVE = new Set(['textbox', 'searchbox', 'button', 'link', 'checkbox', 'radio', 'combobox', 'listbox']);
/** Tags that mark a field caption rather than a field value. */
const CAPTION_TAGS = new Set(['b', 'strong', 'label', 'th', 'dt']);

export interface DigestOptions {
  maxControls?: number;
  maxTextLines?: number;
}

/** Boxes share a visual row when they actually overlap vertically. */
function overlapsRow(a: NonNullable<UiNode['bounds']>, b: NonNullable<UiNode['bounds']>): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap >= Math.min(a.h, b.h) * 0.5;
}

/** Nearest text to the left of a control on the same visual row. */
export function captionFor(node: UiNode, snap: Snapshot): { text: string; relation: 'right-of' | 'below' } | null {
  const n = captionNodeFor(node, snap);
  return n ? { text: n.node.text as string, relation: n.relation } : null;
}

/** As `captionFor`, but returns the node, so callers can tell captions from values. */
export function captionNodeFor(node: UiNode, snap: Snapshot): { node: UiNode; relation: 'right-of' | 'below' } | null {
  if (!node.bounds) return null;
  const nb = node.bounds;
  // Only leaf text nodes are considered captions. A <td> wrapping a caption
  // reports the same text at a different ref, and treating the wrapper as the
  // caption breaks the caption/value disambiguation downstream.
  const sameFrame = snap.nodes.filter(
    (n) => n.ref !== node.ref && n.bounds && n.childRefs.length === 0 &&
      (n.text ?? '').length > 0 && (n.text ?? '').length <= 60 &&
      n.framePath.join('/') === node.framePath.join('/') && !INTERACTIVE.has(n.role),
  );

  let best: { node: UiNode; relation: 'right-of' | 'below'; d: number } | null = null;
  for (const t of sameFrame) {
    const tb = t.bounds as NonNullable<UiNode['bounds']>;
    if (overlapsRow(tb, nb) && tb.x + tb.w <= nb.x + 4) {
      const d = nb.x - (tb.x + tb.w);
      if (d <= 320 && (!best || d < best.d)) best = { node: t, relation: 'right-of', d };
    }
  }
  if (best) return { node: best.node, relation: best.relation };

  // Some forms caption above the field instead of beside it.
  for (const t of sameFrame) {
    const tb = t.bounds as NonNullable<UiNode['bounds']>;
    const aligned = Math.abs(tb.x - nb.x) <= 24;
    if (aligned && nb.y >= tb.y + tb.h - 4) {
      const d = nb.y - (tb.y + tb.h);
      if (d <= 60 && (!best || d < best.d)) best = { node: t, relation: 'below', d };
    }
  }
  return best ? { node: best.node, relation: best.relation } : null;
}

/** Screen messages: errors, warnings and confirmations a core puts in a box. */
export function screenMessages(snap: Snapshot): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of snap.nodes) {
    const cls = n.raw?.className ?? '';
    const isMessageBox = /\b(err|warn|okbox|alert|message|msg)\b/i.test(cls) || n.role === 'alert' || n.role === 'status';
    const t = (n.text ?? '').trim();
    if (!isMessageBox || !t || t.length > 400 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  // Legacy cores also emit bare "MSG nnnn" lines with no styling at all.
  for (const [, text] of Object.entries(snap.frameTexts)) {
    for (const m of text.matchAll(/\b(?:MSG|ERR|SEC|SYS|CPF)[\s-]?\d{3,5}\b[^.\n]{0,200}/g)) {
      const s = m[0].trim();
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
  }
  return out.slice(0, 8);
}

export interface DigestEntry { ref: string; line: string; node: UiNode }

/**
 * Readable values on the screen.
 *
 * The controls list answers "what can I operate?". This answers "what can I
 * read?", and back-office automation is at least as much about the second.
 * A balance is not a control; it is a cell in a grid or a span sitting beside a
 * caption, and if the model cannot address it, it cannot declare it as an
 * output — which is the whole point of the capability.
 *
 * Two shapes cover essentially everything these applications do:
 *
 *   grid cells       — addressable by column header plus the row's other values
 *   captioned values — a value with a caption to its left, the way every
 *                      form-style detail screen in enterprise software is laid out
 */
export function readableValues(snap: Snapshot, max = 70): UiNode[] {
  const out: UiNode[] = [];
  const seen = new Set<string>();

  // Data-grid cells. Take the cell itself, not its <font> descendants.
  for (const n of snap.nodes) {
    if (out.length >= max) break;
    if (!n.table || n.role !== 'cell') continue;
    const text = (n.text ?? '').trim();
    if (!text || text.length > 80) continue;
    const key = `${n.table.tableRef}:${n.table.rowIndex}:${n.table.colIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }

  // Captioned values on detail screens.
  //
  // A caption is itself a text node with a caption to its left, so a naive pass
  // reports "Name" as a value labelled "0100482". Resolve it by computing every
  // candidate's caption first: anything that serves as someone else's caption
  // is a label, not data.
  const candidates: Array<{ node: UiNode; caption: UiNode }> = [];
  const captionRefs = new Set<string>();
  for (const n of snap.nodes) {
    if (n.table || INTERACTIVE.has(n.role)) continue;
    // Field captions in these applications are emphasised and their values are
    // not — that convention long predates CSS and is remarkably consistent.
    // Without it, a four-column layout is genuinely ambiguous: in
    // [Member #][0100482][Name][Whitfield, Dolores] the text "Name" has a value
    // to its left and a value to its right.
    if (CAPTION_TAGS.has(n.raw?.tag ?? '')) continue;
    const text = (n.text ?? '').trim();
    if (!text || text.length > 90 || !n.bounds || n.childRefs.length) continue;
    const cap = captionNodeFor(n, snap);
    if (!cap || cap.relation !== 'right-of') continue;
    if ((cap.node.text ?? '').trim() === text) continue;
    candidates.push({ node: n, caption: cap.node });
    captionRefs.add(cap.node.ref);
  }
  for (const { node, caption } of candidates) {
    if (out.length >= max) break;
    if (captionRefs.has(node.ref)) continue;
    const key = `cap:${caption.ref}:${node.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

export function buildDigest(snap: Snapshot, opts: DigestOptions = {}): { text: string; index: Map<string, UiNode> } {
  const maxControls = opts.maxControls ?? 120;
  const index = new Map<string, UiNode>();
  const lines: string[] = [];

  lines.push(`URL: ${snap.url}`);
  lines.push(`TITLE: ${snap.title}`);

  const msgs = screenMessages(snap);
  if (msgs.length) {
    lines.push('', 'SCREEN MESSAGES (these usually explain what the system wants):');
    for (const m of msgs) lines.push(`  ! ${m}`);
  }

  let counter = 0;
  const byFrame = new Map<string, UiNode[]>();
  for (const n of snap.nodes) {
    const key = n.framePath.join('/') || '(top)';
    if (!byFrame.has(key)) byFrame.set(key, []);
    (byFrame.get(key) as UiNode[]).push(n);
  }

  for (const [frame, nodes] of byFrame) {
    const controls = nodes.filter((n) => INTERACTIVE.has(n.role) && n.visible);
    const headings = nodes.filter((n) => n.role === 'heading' && n.visible);
    if (!controls.length && !headings.length) continue;

    lines.push('', `FRAME ${frame}`);
    for (const h of headings.slice(0, 6)) lines.push(`  heading: ${h.text ?? h.name}`);

    for (const n of controls) {
      if (counter >= maxControls) break;
      const ref = `n${++counter}`;
      index.set(ref, n);

      const bits: string[] = [`[${ref}] ${n.role.padEnd(9)}`];
      bits.push(n.name ? `"${n.name}"` : '""');
      if (n.value) bits.push(`value="${n.value.slice(0, 40)}"`);
      if (n.checked !== undefined) bits.push(n.checked ? '[checked]' : '[unchecked]');
      if (!n.enabled) bits.push('[disabled]');

      if (!n.name) {
        const cap = captionFor(n, snap);
        if (cap) bits.push(`<- caption ${cap.relation === 'right-of' ? 'to its left' : 'above it'}: "${cap.text}"`);
      }
      if (n.table) {
        const row = Object.entries(n.table.rowValues)
          .filter(([, v]) => v && v.length <= 40)
          .map(([k, v]) => `${k}=${v}`).join(' | ');
        bits.push(`(grid column "${n.table.columnHeader ?? '?'}", row: ${row})`);
      }
      if (n.role === 'combobox') {
        const options = snap.nodes.filter((o) => o.role === 'option' && o.parentRef === n.ref).map((o) => o.name || o.text).filter(Boolean);
        if (options.length) bits.push(`options: [${options.slice(0, 12).join(', ')}]`);
      }
      lines.push(`  ${bits.join(' ')}`);
    }
  }

  // ── readable values ───────────────────────────────────────────────────────
  const values = readableValues(snap);
  if (values.length) {
    lines.push('', 'READABLE VALUES (use these handles with `extract` to return data to the caller):');
    for (const n of values) {
      if (counter >= maxControls + 80) break;
      const ref = `v${++counter}`;
      index.set(ref, n);
      if (n.table) {
        const row = Object.entries(n.table.rowValues)
          .filter(([, v]) => v && v.length <= 40)
          .map(([k, v]) => `${k}=${v}`).join(' | ');
        lines.push(`  [${ref}] "${n.text}"   (grid column "${n.table.columnHeader ?? '?'}", row: ${row})`);
      } else {
        const cap = captionFor(n, snap);
        lines.push(`  [${ref}] "${n.text}"   (labelled "${cap?.text ?? ''}")`);
      }
    }
  }

  // A trimmed body-text tail, for context the control list cannot convey
  // (balances, statuses, confirmation numbers).
  const maxText = opts.maxTextLines ?? 40;
  for (const [frame, text] of Object.entries(snap.frameTexts)) {
    if (!text.trim()) continue;
    const trimmed = text.replace(/\s+/g, ' ').slice(0, 2_400);
    lines.push('', `VISIBLE TEXT [${frame}]:`, `  ${trimmed}`);
  }
  void maxText;

  return { text: lines.join('\n'), index };
}
