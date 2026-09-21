/**
 * How Swivel identifies a control.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * The single most consequential decision in this system.
 *
 * The obvious thing to record is a selector: `#ctl00_Main_txtMemberNo`, or
 * `table tr:nth-child(3) td:nth-child(6) a`. Both are wrong for this domain, and
 * they are wrong for opposite reasons:
 *
 *   - Generated ids (ASP.NET `ctl00_Main_grdResults_ctl03_lnkView`) encode the
 *     control's *position in a grid at record time*. Add a row and every id below
 *     it shifts. They also differ between versions of the same vendor product:
 *     Meridian 9.2 emits `ctl00_Main_*`, Meridian 10.1 emits `ctl00_cphMain_*`.
 *   - Structural selectors encode layout, and layout is what tenants customise.
 *
 * What is actually stable across tenants, versions and re-brands is the thing a
 * human operator uses: *what the control is* (a textbox), *what it is called*
 * (the words "Member #" sitting to its left), and *what it is near* (the row for
 * member 0100482). That vocabulary — role, accessible name, spatial and tabular
 * relationships — is also exactly what an OS accessibility API (UIA on Windows,
 * AX on macOS, AT-SPI on Linux) exposes for a desktop application. Recording in
 * that vocabulary is what lets the same artifact shape describe a web screen and
 * a thick client.
 *
 * So a TargetDescriptor is not a selector. It is a **bundle of independent
 * evidence** about a control, plus a policy for how much agreement is required
 * before the replay engine is willing to act on a candidate. Selectors are still
 * recorded — but as low-weight corroboration, never as the identity.
 *
 * Each piece of evidence is a "probe". At replay time every probe is evaluated
 * independently, candidates are scored by weighted agreement, and the engine
 * reports which probes matched. That report is the drift signal: a control that
 * still resolves but now only matches its low-weight probes is a capability
 * about to break, and Swivel surfaces that before it does.
 */
import { z } from 'zod';

/**
 * Roles are deliberately the ARIA set, because ARIA roles, Windows UIA control
 * types and macOS AX roles are near-isomorphic. A `button` is a button on all
 * three surfaces; a CSS selector is a button on exactly one.
 */
export const RoleSchema = z.enum([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'cell', 'columnheader', 'rowheader', 'row', 'table', 'grid',
  'heading', 'paragraph', 'text', 'image', 'list', 'listitem',
  'dialog', 'alert', 'status', 'menuitem', 'tab', 'tabpanel', 'region', 'form', 'document', 'generic',
]);
export type Role = z.infer<typeof RoleSchema>;

/** How strictly a recorded string must match what is on screen at replay time. */
export const TextMatchSchema = z.enum(['exact', 'normalized', 'contains', 'startsWith', 'regex']);
export type TextMatch = z.infer<typeof TextMatchSchema>;

export const TextProbeSchema = z.object({
  /**
   * May contain template expressions — `{{vocab.memberNumber}}` resolves through
   * the tenant's vocabulary map, which is how one artifact addresses a control
   * labelled "Member #" at one institution and "Customer ID" at another.
   */
  value: z.string(),
  match: TextMatchSchema.default('normalized'),
}).strict();

/**
 * A relationship to a nearby landmark.
 *
 * This is how you target a control in an application whose author never
 * associated a <label> with anything: you describe it the way the operator
 * training manual does — "the box to the right of the words Member #".
 */
export const AnchorSchema = z.object({
  relation: z.enum([
    'labelled-by',   // a real <label for> / aria-label association exists
    'right-of',      // caption text sits to the left, same visual row
    'left-of',
    'below',
    'above',
    'in-row-with',   // same table row as a cell containing this text
    'after-text',    // first matching control in document order after this text
    'within-region', // inside a fieldset/box whose heading is this text
  ]),
  text: TextProbeSchema,
  /** Max distance in CSS px for spatial relations; ignored for the rest. */
  maxDistancePx: z.number().int().positive().default(320),
}).strict();

/**
 * Table-cell addressing — the workhorse of back-office automation.
 *
 * "The View link in the row whose Member # column equals 0100482" survives a
 * tenant inserting a Segment column in the middle of the grid, re-ordering the
 * result set, or renaming the grid's control id. Column index does not.
 */
export const CellProbeSchema = z.object({
  /** Header text of the column the target sits in. */
  columnHeader: TextProbeSchema.optional(),
  /** Row selection by matching another column's value in the same row. */
  rowWhere: z.object({
    columnHeader: TextProbeSchema,
    equals: z.string(),           // templatable
    match: TextMatchSchema.default('normalized'),
  }).strict().optional(),
  /** Row selection by ordinal, 1-based. Last resort; scored accordingly. */
  rowIndex: z.number().int().positive().optional(),
}).strict();

/**
 * Corroborating hints.
 *
 * None of these can identify a control on their own — they only add weight to a
 * candidate that the semantic probes already like. `idPattern` deserves a note:
 * generated ids are unstable in their *digits* but stable in their *shape*, so
 * `ctl00_Main_grdResults_ctl\d+_lnkView` is meaningfully more durable than the
 * literal id, and Swivel canonicalises recorded ids into patterns automatically.
 */
export const HintsSchema = z.object({
  domId: z.string().optional(),
  idPattern: z.string().optional(),
  css: z.array(z.string()).default([]),
  nearText: z.array(z.string()).default([]),
  attrs: z.record(z.string(), z.string()).default({}),
  /** Position among otherwise identical candidates, 1-based. */
  ordinal: z.number().int().positive().optional(),
  /** Tag name, useful to separate <input type=submit> from <a>. */
  tag: z.string().optional(),
  inputType: z.string().optional(),
}).strict();

/**
 * Visual evidence, for surfaces where there is no tree at all.
 *
 * Unused by the web surface but part of the schema from day one, because a
 * screenshot-and-coordinates surface is the fallback for Citrix-published thick
 * clients and terminal emulators — and retrofitting a coordinate model into an
 * artifact format later is how you end up with two formats.
 */
export const VisualSchema = z.object({
  /** Fractional bounding box [x, y, w, h] of the containing viewport. */
  bboxRatio: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /** Text expected to be readable at/near the target (OCR). */
  ocrText: z.string().optional(),
}).strict();

/** Which frame of a frameset/iframe tree the control lives in. */
export const FrameRefSchema = z.object({
  /**
   * Ordered path of frame *names* from the top document. Names are part of the
   * application's contract (`<frame name="contentFrame">`) and survive far
   * better than frame indices or URLs, which carry session ids.
   */
  path: z.array(z.string()).default([]),
  /** Fallback: match the frame by URL pattern if the name is absent. */
  urlPattern: z.string().optional(),
}).strict();

/**
 * Authoring types.
 *
 * Deliberately hand-written rather than `z.infer`ed. Zod's output types mark
 * every field with a `.default()` as required, which is right for a parsed
 * document and wrong for one being written: it would force every author — the
 * discovery synthesiser, a product profile, a test — to spell out
 * `hints: { css: [], nearText: [], attrs: {} }` on targets that have no hints.
 * The schemas remain the single source of truth for validation; these describe
 * the same documents as something a person can comfortably write.
 */
export interface TextProbe { value: string; match?: TextMatch }

export interface Anchor {
  relation: 'labelled-by' | 'right-of' | 'left-of' | 'below' | 'above' | 'in-row-with' | 'after-text' | 'within-region';
  text: TextProbe;
  maxDistancePx?: number;
}

export interface CellProbe {
  columnHeader?: TextProbe;
  rowWhere?: { columnHeader: TextProbe; equals: string; match?: TextMatch };
  rowIndex?: number;
}

export interface TargetHints {
  domId?: string;
  idPattern?: string;
  css?: string[];
  nearText?: string[];
  attrs?: Record<string, string>;
  ordinal?: number;
  tag?: string;
  inputType?: string;
}

export interface FrameRef { path: string[]; urlPattern?: string }
export interface VisualProbe { bboxRatio?: [number, number, number, number]; ocrText?: string }

export interface TargetDescriptor {
  id: string;
  role: Role;
  name?: TextProbe;
  frame?: FrameRef;
  within?: TargetDescriptor;
  anchors?: Anchor[];
  cell?: CellProbe;
  hints?: TargetHints;
  visual?: VisualProbe;
  require?: { minScore?: number; unique?: boolean; timeoutMs?: number };
  /** Free-text note from the discovery agent: why this control, in its words. */
  note?: string;
}

export const TargetDescriptorSchema: z.ZodType<TargetDescriptor> = z.lazy(() =>
  z.object({
    /** Stable local handle, referenced by steps and by tenant overlays. */
    id: z.string().regex(/^[a-z0-9_]+$/, 'target ids are lower_snake_case'),
    role: RoleSchema,
    name: TextProbeSchema.optional(),
    frame: FrameRefSchema.optional(),
    /** Scope resolution to inside another described control (e.g. a grid). */
    within: TargetDescriptorSchema.optional(),
    anchors: z.array(AnchorSchema).default([]).optional(),
    cell: CellProbeSchema.optional(),
    hints: HintsSchema.optional(),
    visual: VisualSchema.optional(),
    require: z.object({
      /** 0-100. Below this, the engine refuses to act rather than guess. */
      minScore: z.number().min(0).max(100).default(55),
      /** Require the winner to beat the runner-up by a clear margin. */
      unique: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(10_000),
    }).strict().default({ minScore: 55, unique: true, timeoutMs: 10_000 }).optional(),
    note: z.string().optional(),
  }).strict(),
);

/**
 * Evidence weights.
 *
 * Read this table as a claim about what survives change in enterprise software.
 * Semantic identity (what it is called, what row it is in) is worth 3-8x a
 * selector, because selectors are the part vendors and tenants rewrite. Ordinal
 * position is worth almost nothing on its own — it exists only to break ties
 * between candidates that are otherwise genuinely indistinguishable.
 */
export const PROBE_WEIGHTS = {
  name_exact: 40,
  name_fuzzy: 28,
  anchor: 25,          // per anchor, capped below
  cell_row_match: 45,
  cell_column: 20,
  cell_row_index: 8,
  id_pattern: 18,
  dom_id: 12,
  css: 10,
  near_text: 10,
  attrs: 8,
  tag: 6,
  ordinal: 5,
} as const;

/**
 * Two things that deliberately have no weight.
 *
 * `within` is a *constraint*, not evidence. The resolver filters the candidate
 * pool to the container's descendants before scoring, so every candidate that
 * survives satisfies it identically. Giving it points added the same number to
 * every candidate's earned and available totals, which quietly lifted a control
 * identified by nothing at all toward the threshold.
 *
 * `visual` is reserved for surfaces that perceive pixels rather than a tree — a
 * Citrix-published thick client, a terminal emulator. The web surface never
 * emits it, and a probe scored against a guessed reference viewport is worse
 * than no probe at all, so it is not scored until a surface exists that can
 * supply a real one.
 */

/** Anchors are strong but correlated; cap their combined contribution. */
export const ANCHOR_WEIGHT_CAP = 50;
