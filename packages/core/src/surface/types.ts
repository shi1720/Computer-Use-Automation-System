/**
 * The perception/action seam.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Everything above this interface — target resolution, the replay engine, policy
 * enforcement, signal detection, evidence capture, escalation — is written
 * against `Snapshot` and `SurfaceAction` and has no idea what a browser is.
 * Everything below it is surface-specific and knows nothing about capabilities.
 *
 * That is the answer to "how does this extend to a legacy thick client?". A
 * desktop surface implements `snapshot()` by walking the Windows UI Automation
 * tree and `act()` by dispatching UIA patterns or synthetic input. A terminal
 * surface implements `snapshot()` by reading the 24x80 character buffer of a
 * 5250 emulator and synthesising nodes for its fields, and `act()` by sending
 * keystrokes. Neither requires a change to the artifact format or the replay
 * engine, because `UiNode` is expressed in the vocabulary all three surfaces
 * already share: role, name, value, bounds, containment, table position.
 *
 * The deliberate consequence: this interface is narrow, and stays narrow. Any
 * capability that leaks a browser concept (a CSS selector, a DOM event, a
 * `waitForLoadState`) upward is a defect, because it is a concept the desktop
 * surface cannot honour.
 */
import type { Role } from '../artifact/target.js';

/**
 * One perceivable control or piece of content.
 *
 * Fields are grouped by how durable they are, which mirrors the probe weights in
 * `artifact/target.ts`: semantic identity first, structure second, raw
 * implementation detail last and clearly marked.
 */
export interface UiNode {
  /** Opaque handle, valid only within the snapshot that produced it. */
  ref: string;

  // ── semantic identity (portable across every surface) ─────────────────────
  role: Role;
  /** Accessible name, computed per the ARIA spec on web, from UIA Name on desktop. */
  name: string;
  /** Current value of an editable/selectable control. */
  value?: string;
  /** The node's own visible text, when it is a content node rather than a control. */
  text?: string;
  enabled: boolean;
  visible: boolean;
  checked?: boolean;
  /** Present for controls whose name comes from an explicit label association. */
  labelled?: boolean;

  // ── structure ─────────────────────────────────────────────────────────────
  /** Frame/window path from the root document. Empty array = top level. */
  framePath: string[];
  parentRef?: string;
  childRefs: string[];
  /** Frame-local coordinates, CSS pixels. Used for spatial anchors and for the operator view. */
  bounds?: { x: number; y: number; w: number; h: number };

  /**
   * Tabular position, propagated down to every descendant of a cell.
   *
   * This is what makes "the View link in the row whose Member # is 0100482"
   * expressible. Grids are the primary interaction surface of back-office
   * software, so this is a first-class field rather than something the resolver
   * reconstructs.
   */
  table?: {
    tableRef: string;
    rowIndex: number;
    colIndex: number;
    columnHeader?: string;
    /** columnHeader -> cell text, for every column in this node's row. */
    rowValues: Record<string, string>;
  };

  /**
   * Implementation detail. Corroboration only, never identity.
   * A desktop surface populates `automationId`/`className`; a web surface
   * populates `domId`/`tag`. Both are weighted low for the same reason.
   */
  raw?: {
    tag?: string;
    domId?: string;
    inputType?: string;
    className?: string;
    automationId?: string;
    attrs?: Record<string, string>;
  };
}

export interface Snapshot {
  id: string;
  at: string;
  /** Location of the active document. For desktop: the window title/appId. */
  url: string;
  title: string;
  nodes: UiNode[];
  /** Joined visible text per frame, keyed by frame path. Backs text assertions. */
  frameTexts: Record<string, string>;
  /** Frame paths present, in document order. */
  frames: string[][];
  /** Wall-clock cost of taking the snapshot; surfaces vary enormously. */
  captureMs: number;
}

export type SurfaceAction =
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; value: string }
  | { kind: 'select'; ref: string; value: string }
  | { kind: 'press'; ref?: string; key: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'scroll_into_view'; ref: string };

export interface SnapshotOptions {
  /** Skip nodes that carry no identifying information, to keep snapshots small. */
  includeInvisible?: boolean;
  /** Wait for the surface to settle before capturing. */
  settleMs?: number;
}

/**
 * A live, stateful view of one application session.
 *
 * `Surface` instances are long-lived and single-writer: exactly one actor — the
 * automation or a human operator — may act on one at a time. That constraint is
 * enforced above, by the control lease in `escalation/lease.ts`, but it is a
 * property of the surface, which is why it is documented here.
 */
export interface Surface {
  readonly id: string;
  readonly kind: 'web' | 'desktop' | 'terminal';

  snapshot(opts?: SnapshotOptions): Promise<Snapshot>;
  act(action: SurfaceAction): Promise<void>;
  currentUrl(): Promise<string>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;

  /**
   * Hand the live session to a human without tearing it down.
   *
   * Returning a descriptor rather than a UI is intentional: what "take control"
   * means differs per surface (a CDP screencast for a browser, an RDP/VNC
   * channel for a desktop, a shared terminal buffer), but the *seam* — pause,
   * expose, observe, resume on the same session — is identical. A surface that
   * cannot support this returns null and the escalation degrades to
   * "operator does it themselves and marks it done", which is still better than
   * failing the run.
   */
  exposeForHumanControl?(): Promise<HumanControlChannel | null>;
}

export interface HumanControlChannel {
  /** How the operator console should render this session. */
  transport: 'cdp-screencast' | 'vnc' | 'terminal-stream' | 'none';
  /** Opaque connection descriptor consumed by the console. */
  endpoint: string;
  /** Viewport the operator is looking at, so click coordinates can be mapped. */
  viewport: { width: number; height: number };
  /** Stop streaming and reclaim exclusive control for the automation. */
  release(): Promise<void>;
}
