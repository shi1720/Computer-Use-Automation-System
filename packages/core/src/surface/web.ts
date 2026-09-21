/**
 * The web implementation of `Surface`, over Playwright/Chromium.
 *
 * Chosen over a screenshot-plus-coordinates surface for the *reference*
 * implementation because it is the only one that lets a reviewer reproduce the
 * whole system on a laptop in under a minute. The perception it produces,
 * though, is deliberately not DOM-shaped: `extractor.ts` reduces the page to
 * roles, names, geometry and table position — the same vocabulary a UIA tree
 * exposes — so nothing above this file depends on there being a DOM at all.
 *
 * Two things live here rather than in the policy layer, on purpose:
 *
 *  - **Origin enforcement at the network boundary.** The policy engine already
 *    refuses to *issue* an action outside the allowlist. This aborts the request
 *    even if something else in the page tries to make it. Policy that is only
 *    enforced at the point of decision is policy that a redirect can defeat.
 *  - **Control transfer.** Handing a live browser to a human is a CDP concern,
 *    and CDP is a browser concept. The seam above is `HumanControlChannel`.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Frame, type CDPSession } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import type { HumanControlChannel, Snapshot, SnapshotOptions, Surface, SurfaceAction, UiNode } from './types.js';
import { EXTRACTOR_PRELUDE, extractorSource, type RawFrameSnapshot } from './extractor.js';
import type { Role } from '../artifact/target.js';

const REF_ATTR = 'data-swivel-ref';
const EXTRACTOR_SRC = extractorSource();

export interface WebSurfaceOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Origins this session may talk to. Everything else is aborted at the wire. */
  allowedOrigins?: string[];
  /**
   * Path patterns permitted within those origins.
   *
   * Enforced here as well as in the policy engine. Policy checked only at the
   * point of decision is policy a server-side redirect can walk around — and it
   * does not constrain a human operator clicking links during a takeover.
   */
  allowedPathPatterns?: string[];
  /** Called whenever a request is blocked, so it lands in the evidence log. */
  onBlocked?: (url: string, reason: string) => void;
  /** Extra latency tolerance for slow legacy servers. */
  defaultTimeoutMs?: number;
  /**
   * Explicit Chromium binary. Set `SWIVEL_CHROMIUM_PATH` when running in an
   * image that already ships a browser, so `npx playwright install` is not a
   * prerequisite for reviewing this project.
   */
  executablePath?: string;
}

const KNOWN_ROLES = new Set<string>([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'cell', 'columnheader', 'rowheader', 'row', 'table', 'grid',
  'heading', 'paragraph', 'text', 'image', 'list', 'listitem',
  'dialog', 'alert', 'status', 'menuitem', 'tab', 'tabpanel', 'region', 'form', 'document', 'generic',
]);
const asRole = (r: string): Role => (KNOWN_ROLES.has(r) ? r : 'generic') as Role;

const frameKey = (path: string[]): string => (path.length ? path.join('/') : '(top)');

export class WebSurface implements Surface {
  readonly id = `web-${randomUUID().slice(0, 8)}`;
  readonly kind = 'web' as const;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly opts: WebSurfaceOptions,
  ) {}

  static async launch(opts: WebSurfaceOptions = {}): Promise<WebSurface> {
    const headless = opts.headless ?? true;
    const viewport = opts.viewport ?? { width: 1280, height: 860 };
    const executablePath = opts.executablePath ?? process.env.SWIVEL_CHROMIUM_PATH;
    const browser = await chromium.launch({
      headless,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: false });
    context.setDefaultTimeout(opts.defaultTimeoutMs ?? 15_000);
    const page = await context.newPage();

    const allow = opts.allowedOrigins?.map((o) => o.replace(/\/$/, ''));
    const paths = (opts.allowedPathPatterns ?? [])
      .map((p) => { try { return new RegExp(p); } catch { return null; } })
      .filter((r): r is RegExp => r !== null);

    if (allow?.length) {
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) { await route.continue(); return; }
        let parsed: URL;
        try { parsed = new URL(url); } catch { await route.abort('blockedbyclient'); return; }
        if (!allow.includes(parsed.origin)) {
          opts.onBlocked?.(url, `origin ${parsed.origin} is not in the capability allowlist`);
          await route.abort('blockedbyclient');
          return;
        }
        // Documents only: an allowlist of *routes* is about where the session
        // may go, not about which stylesheet a permitted page pulls in.
        if (paths.length && route.request().resourceType() === 'document' && !paths.some((re) => re.test(parsed.pathname))) {
          opts.onBlocked?.(url, `path ${parsed.pathname} does not match any allowed route pattern`);
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
    }
    return new WebSurface(browser, context, page, opts);
  }

  /** Ordered frame-name path from the top document. */
  private framePath(frame: Frame): string[] {
    const path: string[] = [];
    let f: Frame | null = frame;
    while (f && f.parentFrame()) {
      path.unshift(f.name() || `#${f.url().split('/').pop() ?? 'frame'}`);
      f = f.parentFrame();
    }
    return path;
  }

  private frameByPath(path: string[]): Frame | undefined {
    if (!path.length) return this.page.mainFrame();
    return this.page.frames().find((f) => frameKey(this.framePath(f)) === frameKey(path));
  }

  async snapshot(o: SnapshotOptions = {}): Promise<Snapshot> {
    const started = Date.now();
    if (o.settleMs) await this.page.waitForTimeout(o.settleMs);
    try { await this.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }); } catch { /* legacy apps stall; carry on with what we have */ }

    const nodes: UiNode[] = [];
    const frameTexts: Record<string, string> = {};
    const frames: string[][] = [];

    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      let raw: RawFrameSnapshot;
      try {
        raw = await frame.evaluate(
          (a: { src: string; prelude: string; ref: string }) =>
            (new Function('refAttr', `${a.prelude} return (${a.src})(refAttr);`) as (r: string) => RawFrameSnapshot)(a.ref),
          { src: EXTRACTOR_SRC, prelude: EXTRACTOR_PRELUDE, ref: REF_ATTR },
        );
      } catch {
        continue; // frame navigated mid-capture; the next snapshot will see it
      }
      const path = this.framePath(frame);
      const key = frameKey(path);
      frames.push(path);
      frameTexts[key] = raw.text;

      const refOf = (i: number) => `${key}::${i}`;
      for (const n of raw.nodes) {
        if (!n.visible && !o.includeInvisible) continue;
        const node: UiNode = {
          ref: refOf(n.idx),
          role: asRole(n.role),
          name: n.name,
          enabled: n.enabled,
          visible: n.visible,
          framePath: path,
          childRefs: [],
          raw: n.raw,
        };
        if (n.value !== undefined) node.value = n.value;
        if (n.text !== undefined) node.text = n.text;
        if (n.checked !== undefined) node.checked = n.checked;
        if (n.labelled !== undefined) node.labelled = n.labelled;
        if (n.bounds) node.bounds = n.bounds;
        if (n.parentIdx !== undefined) node.parentRef = refOf(n.parentIdx);
        if (n.table) {
          node.table = {
            tableRef: refOf(n.table.tableIdx),
            rowIndex: n.table.rowIndex,
            colIndex: n.table.colIndex,
            rowValues: n.table.rowValues,
          };
          if (n.table.columnHeader) node.table.columnHeader = n.table.columnHeader;
        }
        nodes.push(node);
      }
    }

    // Back-fill child links so `within` scoping can be resolved by containment.
    const byRef = new Map(nodes.map((n) => [n.ref, n]));
    for (const n of nodes) {
      if (!n.parentRef) continue;
      byRef.get(n.parentRef)?.childRefs.push(n.ref);
    }

    return {
      id: randomUUID(),
      at: new Date().toISOString(),
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      nodes,
      frameTexts,
      frames,
      captureMs: Date.now() - started,
    };
  }

  private locatorFor(ref: string) {
    const [key, idxStr] = ref.split('::');
    const path = key === '(top)' ? [] : (key ?? '').split('/');
    const frame = this.frameByPath(path);
    if (!frame) throw new Error(`Frame "${key}" is no longer present`);
    return frame.locator(`[${REF_ATTR}="${idxStr}"]`).first();
  }

  async act(action: SurfaceAction): Promise<void> {
    switch (action.kind) {
      case 'navigate':
        await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
        return;
      case 'click': {
        const l = this.locatorFor(action.ref);
        await l.scrollIntoViewIfNeeded().catch(() => {});
        await l.click({ timeout: this.opts.defaultTimeoutMs ?? 15_000 });
        return;
      }
      case 'fill': {
        const l = this.locatorFor(action.ref);
        await l.scrollIntoViewIfNeeded().catch(() => {});
        // fill() clears first; legacy forms frequently pre-populate.
        await l.fill(action.value, { timeout: this.opts.defaultTimeoutMs ?? 15_000 });
        return;
      }
      case 'select': {
        const l = this.locatorFor(action.ref);
        await l.selectOption(action.value, { timeout: this.opts.defaultTimeoutMs ?? 15_000 });
        return;
      }
      case 'press': {
        if (action.ref) await this.locatorFor(action.ref).press(action.key);
        else await this.page.keyboard.press(action.key);
        return;
      }
      case 'scroll_into_view':
        await this.locatorFor(action.ref).scrollIntoViewIfNeeded();
        return;
    }
  }

  async currentUrl(): Promise<string> { return this.page.url(); }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: 'png', fullPage: false });
  }

  /** Raw access, used only by the control-transfer channel and evidence capture. */
  get rawPage(): Page { return this.page; }

  async html(): Promise<string> {
    const parts: string[] = [];
    for (const f of this.page.frames()) {
      if (f.isDetached()) continue;
      const key = frameKey(this.framePath(f));
      try { parts.push(`<!-- frame: ${key} -->\n${await f.content()}`); } catch { /* detached */ }
    }
    return parts.join('\n\n');
  }

  // ── control transfer ───────────────────────────────────────────────────────
  private cdp: CDPSession | null = null;

  /**
   * Expose the *same* page to a human operator over a CDP screencast.
   *
   * Not a new session, not a copy of the cookies, not a replay of the steps so
   * far: the identical browser context, mid-flow, with whatever server-side
   * session state the application has built up. That is the only version of this
   * that is useful — a handoff that starts a fresh session hands the operator
   * the problem of getting back to where the automation was.
   */
  async exposeForHumanControl(): Promise<HumanControlChannel | null> {
    const vp = this.page.viewportSize() ?? { width: 1280, height: 860 };
    this.cdp = await this.context.newCDPSession(this.page);
    return {
      transport: 'cdp-screencast',
      endpoint: this.id,
      viewport: vp,
      release: async () => {
        try { await this.cdp?.send('Page.stopScreencast'); } catch { /* already gone */ }
        try { await this.cdp?.detach(); } catch { /* already detached */ }
        this.cdp = null;
      },
    };
  }

  /** Used by the console's live-view websocket. */
  get cdpSession(): CDPSession | null { return this.cdp; }

  async close(): Promise<void> {
    try { await this.cdp?.detach(); } catch { /* noop */ }
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
