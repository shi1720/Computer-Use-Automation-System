/**
 * Synthetic screens.
 *
 * The resolver, the assertion evaluator and the outcome taxonomy are pure
 * functions of a `Snapshot`, so they can be tested exhaustively without a
 * browser, a server or a model. That is not a testing convenience — it is the
 * reason the perception/action seam exists, and being able to write these tests
 * is the evidence that the seam is real.
 */
import type { Snapshot, UiNode } from '@swivel/core';

let seq = 0;
export function node(partial: Partial<UiNode> & Pick<UiNode, 'role'>): UiNode {
  const ref = partial.ref ?? `n${++seq}`;
  return {
    ref, name: '', enabled: true, visible: true, framePath: [], childRefs: [],
    ...partial,
  } as UiNode;
}

export function snapshot(nodes: UiNode[], opts: Partial<Snapshot> = {}): Snapshot {
  const frameTexts: Record<string, string> = {};
  for (const n of nodes) {
    const key = n.framePath.join('/') || '(top)';
    frameTexts[key] = `${frameTexts[key] ?? ''} ${n.text ?? n.name ?? ''}`.trim();
  }
  return {
    id: 'snap', at: new Date().toISOString(), url: 'http://127.0.0.1:4711/content/x',
    title: 'Test', nodes, frameTexts: { ...frameTexts, ...(opts.frameTexts ?? {}) },
    frames: [[]], captureMs: 1,
    ...opts,
  };
}

/**
 * A results grid, parameterised by which columns it has.
 *
 * `extraColumnFirst` reproduces the exact hazard the multi-tenant story turns
 * on: one institution's build of the same vendor product inserts a column in
 * the middle of the grid, which shifts every column index after it.
 */
export function resultsGrid(rows: Array<Record<string, string>>, opts: { extraColumnFirst?: boolean; frame?: string[] } = {}): UiNode[] {
  const frame = opts.frame ?? ['contentFrame'];
  const headers = Object.keys(rows[0] ?? {});
  const nodes: UiNode[] = [];
  rows.forEach((row, r) => {
    const rowValues = opts.extraColumnFirst ? { Segment: 'RETAIL', ...row } : row;
    headers.concat('Action').forEach((h, cIdx) => {
      if (h === 'Action') {
        nodes.push(node({
          ref: `link-${r}`, role: 'link', name: 'View', text: 'View', framePath: frame,
          table: { tableRef: 'grid', rowIndex: r + 1, colIndex: cIdx, columnHeader: 'Action', rowValues: { ...rowValues, Action: 'View' } },
          raw: { tag: 'a', domId: `ctl00_Main_grdResults_ctl0${r + 2}_lnkView` },
          bounds: { x: 600, y: 100 + r * 20, w: 40, h: 14 },
        }));
      } else {
        nodes.push(node({
          ref: `cell-${r}-${h}`, role: 'cell', text: row[h] as string, framePath: frame,
          table: { tableRef: 'grid', rowIndex: r + 1, colIndex: cIdx, columnHeader: h, rowValues: { ...rowValues, Action: 'View' } },
          raw: { tag: 'td' },
          bounds: { x: 100 + cIdx * 90, y: 100 + r * 20, w: 80, h: 14 },
        }));
      }
    });
  });
  return nodes;
}

/** An unlabelled input with a caption to its left — the legacy default. */
export function captionedInput(caption: string, opts: { y?: number; domId?: string; frame?: string[]; value?: string } = {}): UiNode[] {
  const y = opts.y ?? 40;
  const frame = opts.frame ?? ['contentFrame'];
  return [
    node({ ref: `cap-${caption}`, role: 'text', text: caption, framePath: frame, raw: { tag: 'b' }, bounds: { x: 40, y, w: 70, h: 14 } }),
    node({
      ref: `in-${caption}`, role: 'textbox', name: '', labelled: false, framePath: frame,
      value: opts.value ?? '', raw: { tag: 'input', inputType: 'text', ...(opts.domId ? { domId: opts.domId } : {}) },
      bounds: { x: 130, y: y - 1, w: 110, h: 16 },
    }),
  ];
}
