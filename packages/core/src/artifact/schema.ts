/**
 * CAP-1 — the Capability Artifact schema.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * A capability artifact is not a recording. A recording is a transcript of what
 * happened once; a capability is a contract about what will happen every time.
 * The distinction drives every decision below.
 *
 * Four properties the format has to have, because of who consumes it:
 *
 *  1. **An AI agent calls it.** So the artifact carries a typed input schema, a
 *     typed output schema, and an enumerated set of outcomes — the same shape as
 *     a tool definition, because that is literally what it is compiled into.
 *     "Member not found" is a declared outcome the caller can branch on, not an
 *     exception.
 *
 *  2. **A human reviews it.** A bank's change-management process has to approve
 *     this thing before it runs unattended against a production core. So every
 *     step carries an `intent` in plain language, every risky step is labelled,
 *     and the whole document is diffable YAML/JSON. An approver should be able to
 *     read it top to bottom and know what it will do to the institution.
 *
 *  3. **A deterministic engine executes it.** So there is no room for "figure it
 *     out": targets, waits, checkpoints and error handling are all declared.
 *     Anything the engine would otherwise have to infer at runtime is a bug in
 *     the schema.
 *
 *  4. **Hundreds of tenants share it.** So the artifact describes the *vendor
 *     product*, never the institution. Everything institution-specific — the
 *     base URL, the word for "member", a control that moved — lives in a
 *     separate, small, reviewable TenantOverlay. One artifact, N overlays.
 *
 * The raw model transcript is deliberately NOT in here. It is evidence, stored
 * alongside the run and referenced by hash. Artifacts outlive the model that
 * wrote them.
 */
import { z } from 'zod';
import { TargetDescriptorSchema, type TargetDescriptor } from './target.js';

export const API_VERSION = 'swivel.dev/cap-1' as const;

// ── Type system for the capability's public contract ─────────────────────────
// A deliberately small JSON-Schema subset: everything here maps 1:1 onto an
// MCP / OpenAI function-calling parameter schema, so `swivel serve` can publish
// capabilities as callable tools without a translation layer that could drift.

/**
 * Data sensitivity, declared in the contract rather than guessed at by a regex.
 *
 * This is the primary redaction control. A regex that hunts for SSN-shaped
 * strings in logs is a backstop, not a policy — the field that holds a member's
 * tax ID is known at design time, and the artifact says so.
 */
export const SensitivitySchema = z.enum([
  'public',    // safe to log in full
  'internal',  // log in full, but never leaves the tenant boundary
  'pii',       // redact in logs and evidence; hash for correlation
  'sensitive', // financial values; redact by default, opt in per policy
  'secret',    // credentials/tokens; never logged, never persisted, ever
]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export interface FieldDef {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'money' | 'date' | 'enum' | 'object' | 'array';
  description: string;
  required?: boolean;
  pattern?: string;
  enumValues?: string[];
  example?: string;
  sensitivity?: Sensitivity;
  items?: FieldDef;
  properties?: FieldDef[];
}

export const FieldDefSchema: z.ZodType<FieldDef> = z.lazy(() =>
  z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    type: z.enum(['string', 'number', 'integer', 'boolean', 'money', 'date', 'enum', 'object', 'array']),
    description: z.string().min(1, 'every field needs a description — the calling agent reads it'),
    required: z.boolean().default(false).optional(),
    /** Validated before a single browser action is taken. Cheap rejection. */
    pattern: z.string().optional(),
    enumValues: z.array(z.string()).optional(),
    example: z.string().optional(),
    sensitivity: SensitivitySchema.default('internal').optional(),
    items: FieldDefSchema.optional(),
    properties: z.array(FieldDefSchema).optional(),
  }).strict(),
);

// ── Assertions, checkpoints and signals ──────────────────────────────────────

/**
 * The atom of "did what I expected actually happen".
 *
 * Used for three different jobs, which is intentional — checkpoints, signal
 * detectors and preconditions are the same question asked at different moments.
 */
export const AssertionSchema = z.object({
  kind: z.enum([
    'target_visible',   // the described control is present and visible
    'target_absent',
    'text_present',     // text appears anywhere in the resolved scope
    'text_absent',
    'url_matches',      // regex against the active document URL
    'value_equals',     // a control's value/text equals an expected string
    'value_matches',
  ]),
  target: TargetDescriptorSchema.optional(),
  /** Templatable. Compared after whitespace normalisation unless `regex`. */
  text: z.string().optional(),
  regex: z.string().optional(),
  /** Restrict the search to one frame; omitted means "any frame". */
  frameName: z.string().optional(),
  /** Human-readable reason this assertion exists. Shows up in failure output. */
  because: z.string().optional(),
}).strict();
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * A checkpoint: proof that a step achieved its purpose.
 *
 * Without these, a replay that clicks a button on a page that never loaded looks
 * exactly like a replay that worked. Every mutating step must have one; the
 * validator enforces it.
 */
export const CheckpointSchema = z.object({
  id: z.string(),
  description: z.string(),
  /** All must hold. Conjunction only — disjunction belongs in a signal. */
  all: z.array(AssertionSchema).min(1),
  timeoutMs: z.number().int().positive().default(15_000),
  /** How long the condition must hold, to defeat flash-of-unstyled-content. */
  stableForMs: z.number().int().nonnegative().default(0),
}).strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;

/**
 * A signal detector: a named runtime condition the engine watches for after
 * every single step.
 *
 * This is the load-bearing piece of the error story. The brief's central
 * observation is that in stable enterprise UIs the interesting failures are not
 * layout drift but *legitimate runtime states* — and the only way to respond to
 * them deliberately rather than blindly is to have named them in advance and
 * said what each one means.
 *
 * `kind` is the classification that flows straight through to the caller's
 * result contract:
 *   business   — a real answer the caller asked for. Not an error.
 *   recoverable— the engine knows a remedy; it applies it and continues.
 *   escalate   — a human has to look at this; pause and hand over the session.
 *   fatal      — stop now with a debuggable failure.
 */
export const RecoveryPlanSchema = z.object({
  strategy: z.enum(['retry_step', 'wait_and_retry', 'run_steps', 'reauthenticate', 'restart_flow']),
  maxAttempts: z.number().int().positive().default(3),
  backoffMs: z.number().int().nonnegative().default(1_000),
  /** For `run_steps` / `reauthenticate`: the remediation sequence. */
  steps: z.array(z.lazy(() => StepSchema)).default([]).optional(),
  /** After recovery, resume at this step id instead of retrying the current. */
  resumeAtStepId: z.string().optional(),
}).strict();

export const SignalSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string(),
  kind: z.enum(['business', 'recoverable', 'escalate', 'fatal']),
  /** Any one of these matching fires the signal. */
  detect: z.array(AssertionSchema).min(1),
  /** For `business`: the outcome code returned to the caller. */
  outcomeCode: z.string().optional(),
  /** For `recoverable`: what to do about it. */
  recovery: RecoveryPlanSchema.optional(),
  /** Steps during which this signal is suppressed (e.g. a form you expect to fail validation once). */
  exceptStepIds: z.array(z.string()).default([]).optional(),
  /**
   * If a recovery plan runs out of attempts, report this business outcome
   * instead of a hard failure. "The record is locked by another teller and
   * still locked after three tries" is an answer, not a crash.
   */
  exhaustedOutcomeCode: z.string().optional(),
  /** Extract data out of the signal screen — e.g. the reference number. */
  capture: z.array(z.object({ name: z.string(), regex: z.string() }).strict()).default([]).optional(),
}).strict();
export type Signal = z.infer<typeof SignalSchema>;

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * Risk class drives policy, not documentation.
 *
 * `read_only` capabilities can be approved for unattended execution cheaply.
 * `irreversible` ones cannot run without an explicit per-invocation
 * confirmation token, no matter who is calling. The engine enforces this; it is
 * not a label.
 */
export const RiskClassSchema = z.enum(['read_only', 'low', 'medium', 'high', 'irreversible']);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const TransformSchema = z.enum(['trim', 'upper', 'lower', 'money_to_number', 'digits_only', 'iso_date', 'none']);

export const ExtractionSchema = z.object({
  /** Output field this populates. Must exist in contract.outputs. */
  into: z.string(),
  source: z.enum(['text', 'value', 'href', 'attribute', 'url', 'cell']),
  attribute: z.string().optional(),
  /** Pull a capture group out of the raw string before transforming. */
  regex: z.string().optional(),
  transform: TransformSchema.default('none'),
}).strict();

export interface Step {
  id: string;
  intent: string;
  kind: 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'wait_for' | 'extract' | 'assert' | 'dismiss_if_present' | 'escalate';
  target?: TargetDescriptor;
  url?: string;
  value?: string;
  key?: string;
  extract?: z.infer<typeof ExtractionSchema>;
  expect?: Checkpoint;
  risk?: RiskClass;
  optional?: boolean;
  timeoutMs?: number;
  /** Per-step overrides of the global signal disposition. */
  onSignal?: Record<string, 'recover' | 'fail' | 'escalate' | 'ignore'>;
  /** Free-text reason recorded by whoever authored or edited this step. */
  note?: string;
  /** Provenance of the step itself: discovered by the model, or added by a human. */
  authoredBy?: 'model' | 'human' | 'overlay';
}

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    /**
     * Required, and required to be meaningful. The reviewer reading this
     * artifact in a change ticket sees `intent`, not the selector. If a step
     * cannot be explained in one sentence it is probably two steps.
     */
    intent: z.string().min(3),
    kind: z.enum(['navigate', 'click', 'fill', 'select', 'press', 'wait_for', 'extract', 'assert', 'dismiss_if_present', 'escalate']),
    target: TargetDescriptorSchema.optional(),
    /** For `navigate`. Templatable; must satisfy the policy allowlist. */
    url: z.string().optional(),
    /** For `fill`/`select`. Templatable: `{{input.memberNumber}}`. */
    value: z.string().optional(),
    key: z.string().optional(),
    extract: ExtractionSchema.optional(),
    expect: CheckpointSchema.optional(),
    risk: RiskClassSchema.default('read_only').optional(),
    /** `dismiss_if_present` steps are optional by nature; others rarely are. */
    optional: z.boolean().default(false).optional(),
    timeoutMs: z.number().int().positive().optional(),
    onSignal: z.record(z.string(), z.enum(['recover', 'fail', 'escalate', 'ignore'])).optional(),
    note: z.string().optional(),
    authoredBy: z.enum(['model', 'human', 'overlay']).default('model').optional(),
  }).strict(),
);

// ── The capability document ──────────────────────────────────────────────────

export const OutcomeSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: z.enum(['business', 'failure']),
  description: z.string(),
  /** Whether the calling agent can sensibly retry this outcome. */
  retryable: z.boolean().default(false),
}).strict();

export const EffectsSchema = z.object({
  /** Does invoking this change state in the institution's system of record? */
  mutating: z.boolean(),
  /** Can the change be undone through the same application by an operator? */
  reversible: z.boolean(),
  riskClass: RiskClassSchema,
  /** The application itself requires a second approver for this action. */
  dualControl: z.boolean().default(false),
  /** Does it move money or assess a fee? Drives approval requirements. */
  financialImpact: z.boolean().default(false),
  /** Safe to invoke twice with the same inputs without double-acting? */
  idempotent: z.boolean().default(false),
  /** Prose the approver reads before signing off. */
  summary: z.string().optional(),
}).strict();

export const PolicySchema = z.object({
  /** Exact origins the capability may touch. Enforced per navigation and per request. */
  allowedOrigins: z.array(z.string()).default([]),
  /** Regexes for permitted paths within those origins. Empty = all paths. */
  allowedPathPatterns: z.array(z.string()).default([]),
  allowedActions: z.array(z.enum(['navigate', 'click', 'fill', 'select', 'press', 'wait_for', 'extract', 'assert', 'dismiss_if_present', 'escalate'])).default([]),
  /** Unattended execution is refused unless quality.approvalState is `approved`. */
  requiresApproval: z.boolean().default(true),
  /** Caller must pass an explicit confirmation token per invocation. */
  requiresPerInvocationConfirmation: z.boolean().default(false),
  maxDurationMs: z.number().int().positive().default(120_000),
  maxSteps: z.number().int().positive().default(60),
  /** Extra redaction patterns beyond the field-level `sensitivity` declarations. */
  redactPatterns: z.array(z.string()).default([]),
}).strict();

export const ProvenanceSchema = z.object({
  discoveredAt: z.string(),
  discoveredBy: z.object({
    kind: z.enum(['llm_discovery', 'human_authored', 'human_assisted', 'overlay_derived']),
    provider: z.string().optional(),
    model: z.string().optional(),
  }).strict(),
  goal: z.string(),
  /** Run that produced this artifact. The transcript lives in evidence, not here. */
  sourceRunId: z.string().optional(),
  /** SHA-256 of the model transcript, so the artifact can be tied to it without embedding it. */
  transcriptSha256: z.string().optional(),
  /** Which tenant the discovery happened against. The artifact itself is tenant-neutral. */
  recordedOnTenant: z.string().optional(),
  swivelVersion: z.string(),
  /** Every human edit or promotion, appended. Never rewritten. */
  history: z.array(z.object({
    at: z.string(), actor: z.string(), action: z.string(), note: z.string().optional(),
  }).strict()).default([]),
}).strict();

export const QualitySchema = z.object({
  /**
   * draft      — just discovered; replayable by hand, never unattended.
   * candidate  — replayed successfully at least once by someone other than the author.
   * approved   — signed off for unattended invocation by an AI agent.
   * deprecated — superseded; still replayable for audit reproduction.
   */
  approvalState: z.enum(['draft', 'candidate', 'approved', 'deprecated']).default('draft'),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  /**
   * The content hash that was approved.
   *
   * Approval is approval *of a specific document*. Without pinning the hash,
   * editing an approved artifact's steps by hand — which is a documented
   * authoring path — leaves it approved, and the reviewer's sign-off silently
   * transfers to a flow they never read. The policy engine refuses to run
   * unattended when this does not match the current hash.
   */
  approvedContentHash: z.string().optional(),
  replays: z.object({
    total: z.number().int().nonnegative().default(0),
    success: z.number().int().nonnegative().default(0),
    businessOutcome: z.number().int().nonnegative().default(0),
    recovered: z.number().int().nonnegative().default(0),
    escalated: z.number().int().nonnegative().default(0),
    failed: z.number().int().nonnegative().default(0),
  }).strict().default({ total: 0, success: 0, businessOutcome: 0, recovered: 0, escalated: 0, failed: 0 }),
  /**
   * 0-100. Blends replay outcomes with targeting margin: a capability whose
   * targets resolve at a score of 58 is fragile even if it has never failed,
   * and this number says so before an incident does.
   */
  stabilityScore: z.number().min(0).max(100).default(0),
  lastReplayAt: z.string().optional(),
  notes: z.array(z.string()).default([]),
}).strict();

export const CapabilitySchema = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('Capability'),

  metadata: z.object({
    /** Stable identity across versions. Referenced by overlays and by callers. */
    id: z.string().regex(/^[a-z][a-z0-9.\-]*$/),
    /** Semver. Breaking = input/output contract changed. Minor = steps changed. */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: z.string(),
    /** One paragraph, written for the AI agent that will decide whether to call this. */
    summary: z.string(),
    owner: z.string().optional(),
    createdAt: z.string(),
    labels: z.record(z.string(), z.string()).default({}),
  }).strict(),

  /**
   * What this capability automates — the *product*, not the institution.
   *
   * This split is the whole multi-tenant story. `pineridge` never appears in a
   * capability; `meridian-core` does. The base URL is a template resolved from
   * the tenant overlay at invocation time.
   */
  target: z.object({
    surface: z.enum(['web', 'desktop', 'terminal']),
    vendor: z.string(),
    product: z.string(),
    /** Semver range of product versions this artifact is known to work against. */
    productVersions: z.string().default('*'),
    entry: z.object({
      /** e.g. "{{tenant.baseUrl}}/content/member-search" */
      urlTemplate: z.string(),
      /** Names of frames the flow expects to exist. Checked before step 1. */
      expectedFrames: z.array(z.string()).default([]),
    }).strict(),
    /**
     * Default vocabulary. Overridden per tenant. Referenced from target name
     * probes as `{{vocab.memberNumber}}` — this is how one artifact addresses
     * "Member #" and "Customer ID" without branching.
     */
    vocabulary: z.record(z.string(), z.string()).default({}),
  }).strict(),

  contract: z.object({
    inputs: z.array(FieldDefSchema).default([]),
    outputs: z.array(FieldDefSchema).default([]),
    outcomes: z.array(OutcomeSchema).default([]),
    effects: EffectsSchema,
    /** Conditions that must hold before the flow starts (e.g. signed in). */
    preconditions: z.array(AssertionSchema).default([]),
  }).strict(),

  policy: PolicySchema,

  /** Evaluated after every step. Ordered: first match wins. */
  signals: z.array(SignalSchema).default([]),

  flow: z.object({
    steps: z.array(StepSchema).min(1),
    /** The definition of done. Asserted before any outputs are returned. */
    successCheckpoint: CheckpointSchema,
  }).strict(),

  provenance: ProvenanceSchema,
  quality: QualitySchema,

  /** SHA-256 over the normative subset. Changes iff behaviour could change. */
  contentHash: z.string().optional(),
}).strict();

export type Capability = z.infer<typeof CapabilitySchema>;

// ── Tenant overlay ───────────────────────────────────────────────────────────

/**
 * A TenantOverlay specialises a capability for one institution.
 *
 * It is deliberately a *patch*, not a fork. The reason is operational: when the
 * vendor ships Meridian 10.2 and the base capability is re-recorded, every
 * tenant inherits the fix. A fork inherits nothing, which is exactly how
 * organisations end up maintaining 400 copies of the same automation.
 *
 * Overlays are kept small on purpose. An overlay that has to patch half the
 * steps is telling you the two tenants are not really running the same flow,
 * and the right answer is a second base capability — the validator warns when
 * an overlay crosses that line.
 */
export const TenantOverlaySchema = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('TenantOverlay'),
  metadata: z.object({
    id: z.string(),
    tenantId: z.string(),
    institution: z.string(),
    createdAt: z.string(),
    /** Which capability, and which versions of it, this overlay applies to. */
    capabilityId: z.string(),
    capabilityVersions: z.string().default('*'),
    notes: z.array(z.string()).default([]),
  }).strict(),

  /** Where this institution's instance lives. Feeds `{{tenant.baseUrl}}`. */
  tenant: z.object({
    baseUrl: z.string().url(),
    productVersion: z.string().optional(),
  }).strict(),

  /** Per-institution wording. Merged over the capability's defaults. */
  vocabulary: z.record(z.string(), z.string()).default({}),

  /**
   * Deep-merged over the base target with the same id. Use for the genuinely
   * local differences: a renamed control, a different id prefix.
   */
  targetOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),

  /** Institution-specific runtime conditions — e.g. a local interstitial. */
  extraSignals: z.array(SignalSchema).default([]),

  /**
   * Ordered structural edits. `skip` is the most common (a screen this tenant
   * does not have); `insert-before` handles extra interstitials.
   */
  stepPatches: z.array(z.object({
    op: z.enum(['insert-before', 'insert-after', 'replace', 'skip']),
    stepId: z.string(),
    step: StepSchema.optional(),
    reason: z.string(),
  }).strict()).default([]),

  policyOverrides: PolicySchema.partial().optional(),
  /**
   * An overlay that only supplies a base URL and vocabulary changes no
   * behaviour and rides the base capability's approval. One that patches steps
   * does change behaviour, and needs its own reviewer — otherwise the cheapest
   * document in the system could insert a click into an approved flow.
   */
  approval: z.object({
    approvedBy: z.string(),
    approvedAt: z.string(),
    note: z.string().optional(),
  }).strict().optional(),
  quality: QualitySchema.default({} as never).optional(),
}).strict();

export type TenantOverlay = z.infer<typeof TenantOverlaySchema>;
