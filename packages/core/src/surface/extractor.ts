/**
 * The in-page perception routine.
 *
 * Runs inside each frame of the target document and returns an accessibility-
 * shaped description of what a human can currently see. It is written as one
 * self-contained function because it is serialised into the page; it may not
 * reference anything from module scope.
 *
 * Why compute this rather than use the browser's own accessibility snapshot:
 * the AX snapshot omits the two things this domain needs most — element
 * geometry (required for "the box to the right of the caption", which is the
 * only way to target a control in an app that never used <label for>) and
 * tabular position (required for "the row where Member # is 0100482"). The
 * roles and name-computation below deliberately follow the ARIA spec so that
 * what this produces is directly comparable to what a UIA/AX tree produces on a
 * desktop surface.
 */

/** Shape returned per node. Mirrors UiNode minus the fields the host fills in. */
export interface RawNode {
  idx: number;
  role: string;
  name: string;
  value?: string;
  text?: string;
  enabled: boolean;
  visible: boolean;
  checked?: boolean;
  labelled?: boolean;
  parentIdx?: number;
  bounds?: { x: number; y: number; w: number; h: number };
  table?: { tableIdx: number; rowIndex: number; colIndex: number; columnHeader?: string; rowValues: Record<string, string> };
  raw: { tag?: string; domId?: string; inputType?: string; className?: string; attrs?: Record<string, string> };
}

export interface RawFrameSnapshot {
  url: string;
  title: string;
  text: string;
  nodes: RawNode[];
}

/**
 * Serialised into the page by the web surface. Keep it dependency-free.
 * `refAttr` is the attribute used to hand an element back to Playwright for a
 * trusted, auto-waiting interaction.
 */
export const EXTRACTOR_SOURCE = function extractSwivelSnapshot(refAttr: string): RawFrameSnapshot {
  const MAX_NODES = 1500;
  const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION']);
  const TABULAR = new Set(['TABLE', 'TR', 'TH', 'TD']);
  const HEADING = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  function visibleOf(el: Element): boolean {
    const he = el as HTMLElement;
    if (!he.getClientRects || he.getClientRects().length === 0) {
      // Tables/rows can have zero rects in odd layouts; fall back to offsetParent.
      if (!(he.offsetParent || he === document.body)) return false;
    }
    const cs = window.getComputedStyle(he);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return true;
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName;
    switch (tag) {
      case 'A': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'BUTTON': return 'button';
      case 'SELECT': return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
      case 'OPTION': return 'option';
      case 'TEXTAREA': return 'textbox';
      case 'TABLE': return 'table';
      case 'TR': return 'row';
      case 'TH': return (el.getAttribute('scope') === 'row') ? 'rowheader' : 'columnheader';
      case 'TD': return 'cell';
      case 'IMG': return 'image';
      case 'FORM': return 'form';
      case 'UL': case 'OL': return 'list';
      case 'LI': return 'listitem';
      case 'INPUT': {
        const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'search') return 'searchbox';
        if (t === 'hidden') return 'generic';
        return 'textbox';
      }
      default:
        if (HEADING.has(tag)) return 'heading';
        return 'text';
    }
  }

  function explicitLabel(el: Element): string | null {
    const aria = el.getAttribute('aria-label');
    if (norm(aria)) return norm(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => norm((document.getElementById(id) as HTMLElement | null)?.innerText)).join(' ');
      if (norm(t)) return norm(t);
    }
    const id = el.getAttribute('id');
    if (id) {
      try {
        const lab = document.querySelector(`label[for="${(window as any).CSS?.escape ? (window as any).CSS.escape(id) : id}"]`);
        if (lab && norm((lab as HTMLElement).innerText)) return norm((lab as HTMLElement).innerText);
      } catch { /* malformed id; ignore */ }
    }
    const anc = el.closest('label');
    if (anc && norm((anc as HTMLElement).innerText)) return norm((anc as HTMLElement).innerText);
    return null;
  }

  function accessibleName(el: Element, role: string): { name: string; labelled: boolean } {
    const lab = explicitLabel(el);
    if (lab) return { name: lab, labelled: true };
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const inp = el as HTMLInputElement;
      const t = (inp.type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return { name: norm(inp.value) || t, labelled: true };
      // Legacy apps commonly have none of these. An empty name is a true
      // observation, not a failure — it is what forces anchor-based targeting.
      return { name: norm(inp.getAttribute('title') || inp.getAttribute('placeholder') || ''), labelled: false };
    }
    if (tag === 'IMG') return { name: norm(el.getAttribute('alt')), labelled: true };
    if (role === 'combobox' || role === 'listbox') {
      return { name: norm(el.getAttribute('title') || ''), labelled: false };
    }
    const own = norm((el as HTMLElement).innerText || el.textContent);
    // Containers should not inherit the name of everything inside them.
    if (role === 'table' || role === 'row' || role === 'form' || role === 'generic') return { name: '', labelled: false };
    return { name: own.length <= 200 ? own : own.slice(0, 200), labelled: false };
  }

  function isTextLeaf(el: Element): boolean {
    if (el.children.length > 0) return false;
    const t = norm((el as HTMLElement).innerText || el.textContent);
    return t.length > 0 && t.length <= 160;
  }

  // ── collect candidate elements ────────────────────────────────────────────
  const all = Array.from(document.querySelectorAll('*'));
  const picked: Element[] = [];
  for (const el of all) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD' || tag === 'META' || tag === 'LINK') continue;
    if (INTERACTIVE.has(tag) || TABULAR.has(tag) || HEADING.has(tag) || el.hasAttribute('role') || tag === 'FORM' || tag === 'IMG') {
      picked.push(el);
    } else if (isTextLeaf(el)) {
      picked.push(el);
    }
    if (picked.length >= MAX_NODES) break;
  }

  const indexOf = new Map<Element, number>();
  picked.forEach((el, i) => indexOf.set(el, i));

  /**
   * Table context.
   *
   * Attached only for tables that contain a <th>. Legacy apps use tables for
   * layout constantly — Meridian nests them four deep — and treating a layout
   * table as a data grid produces meaningless "column headers" that would then
   * be recorded into artifacts. A <th> is the strongest available signal that
   * the author meant this one as data. Desktop and terminal surfaces supply grid
   * semantics directly and do not need this heuristic.
   */
  const headerCache = new Map<Element, string[]>();
  function ownRows(table: Element): Element[] {
    return Array.from(table.querySelectorAll('tr')).filter((r) => r.closest('table') === table);
  }

  /** A <th> belonging to THIS table, not to a grid nested inside a layout table. */
  function isDataGrid(table: Element): boolean {
    return Array.from(table.querySelectorAll('th')).some((th) => th.closest('table') === table);
  }

  function headersFor(table: Element): string[] {
    const cached = headerCache.get(table);
    if (cached) return cached;
    const headRow = ownRows(table)[0];
    const cells = headRow ? Array.from(headRow.children) : [];
    const hs = cells.map((c) => norm((c as HTMLElement).innerText));
    headerCache.set(table, hs);
    return hs;
  }

  function tableContextFor(el: Element): RawNode['table'] | undefined {
    const cell = el.closest('td, th');
    if (!cell) return undefined;
    const table = cell.closest('table');
    if (!table || !isDataGrid(table)) return undefined;
    const row = cell.closest('tr');
    if (!row) return undefined;
    const tableIdx = indexOf.get(table);
    if (tableIdx === undefined) return undefined;
    const rowIndex = ownRows(table).indexOf(row);
    const cells = Array.from(row.children);
    const colIndex = cells.indexOf(cell);
    const headers = headersFor(table);
    const rowValues: Record<string, string> = {};
    cells.forEach((c, i) => {
      const h = headers[i];
      if (h) rowValues[h] = norm((c as HTMLElement).innerText);
    });
    const ctx: RawNode['table'] = { tableIdx, rowIndex, colIndex, rowValues };
    const header = headers[colIndex];
    if (header) ctx.columnHeader = header;
    return ctx;
  }

  const KEEP_ATTRS = ['name', 'type', 'href', 'value', 'title', 'target', 'class'];

  const nodes: RawNode[] = picked.map((el, idx) => {
    const role = roleOf(el);
    const { name, labelled } = accessibleName(el, role);
    const he = el as HTMLElement;
    const r = he.getBoundingClientRect?.();
    el.setAttribute(refAttr, String(idx));

    const attrs: Record<string, string> = {};
    for (const a of KEEP_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null && v.length <= 200) attrs[a] = v;
    }
    // The enclosing form's method is the single best available signal for
    // whether activating a control changes state. A GET form is a query; a
    // POST form is a transaction. It beats keyword-matching on button labels,
    // which is what most automation resorts to.
    const form = el.closest('form');
    if (form) attrs['_formMethod'] = (form.getAttribute('method') || 'get').toLowerCase();

    let parentIdx: number | undefined;
    let p: Element | null = el.parentElement;
    while (p) { const i = indexOf.get(p); if (i !== undefined) { parentIdx = i; break; } p = p.parentElement; }

    const node: RawNode = {
      idx,
      role,
      name,
      enabled: !(el as HTMLInputElement).disabled,
      visible: visibleOf(el),
      labelled,
      raw: {
        tag: el.tagName.toLowerCase(),
        domId: el.getAttribute('id') ?? undefined,
        inputType: el.tagName === 'INPUT' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : undefined,
        className: el.getAttribute('class') ?? undefined,
        attrs,
      },
    };
    if (parentIdx !== undefined) node.parentIdx = parentIdx;
    if (r && (r.width || r.height)) node.bounds = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };

    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const v = (el as HTMLInputElement).value;
      // Never read the value of a password field into a snapshot. The redactor
      // downstream would catch it, but the right place to not have a secret is
      // to never have read it.
      node.value = (el as HTMLInputElement).type === 'password' ? '' : (v ?? '').slice(0, 300);
      if ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio') {
        node.checked = (el as HTMLInputElement).checked;
      }
    }
    const own = norm(he.innerText || el.textContent);
    if (own && own.length <= 300) node.text = own;

    const tc = tableContextFor(el);
    if (tc) node.table = tc;
    return node;
  });

  return {
    url: location.href,
    title: document.title,
    text: norm((document.body as HTMLElement | null)?.innerText).slice(0, 20_000),
    nodes,
  };
};

/**
 * The extractor as transport-ready source.
 *
 * Two wrinkles, both worth knowing about:
 *
 *  1. TypeScript build tooling (esbuild, and therefore tsx) wraps named function
 *     declarations in a `__name` helper to preserve `Function.prototype.name`.
 *     That helper lives in the module scope, not the page's, so shipping the
 *     stringified function into a browser context throws
 *     `ReferenceError: __name is not defined`. The shim below is declared inside
 *     the evaluated wrapper, which keeps it lexically available to the body
 *     while leaving the target application's global scope untouched — adding
 *     globals to a bank's application in order to read it is not a trade worth
 *     making.
 *
 *  2. Playwright evaluates a *string* page-function as an expression and does
 *     not pass arguments to it. So the host compiles this source in-page with
 *     `new Function` from inside a real closure instead. The known limitation:
 *     an application serving a Content-Security-Policy without `unsafe-eval`
 *     would block that, and would need the extractor injected via an init
 *     script instead. No such policy exists on the surfaces this targets, and
 *     the seam to add it is one function.
 */
export const EXTRACTOR_PRELUDE = 'const __name = (fn) => fn;';
export const extractorSource = (): string => EXTRACTOR_SOURCE.toString();
