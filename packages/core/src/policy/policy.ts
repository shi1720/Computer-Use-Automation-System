/**
 * The guardrail layer.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Three questions, asked in order, before anything touches the application:
 *
 *   1. **Is this action in scope?** Origin and path allowlists, action-type
 *      allowlist. Enforced twice: here, before the action is issued, and again
 *      at the network boundary inside the surface, so a server-side redirect
 *      cannot walk the session somewhere the capability was never approved for.
 *
 *   2. **Is this action safe to take unattended?** Read-only and reversible
 *      actions are cheap to approve. Irreversible ones — a stop payment that
 *      assesses a $32 fee, a posted reversal — are gated on an explicit
 *      per-invocation confirmation token supplied by the caller. The gate is not
 *      "the model thought about it"; it is a value the caller had to put in the
 *      request, which means a human or an upstream control decided.
 *
 *   3. **Is this capability allowed to run at all right now?** Draft capabilities
 *      never run unattended. Budgets (steps, wall-clock) are enforced so a
 *      malfunctioning flow cannot sit in a loop against a production core.
 *
 * Deny is the default for anything unrecognised. Every decision — allow and deny
 * alike — is recorded, because "the automation did not do X" is as much a part
 * of the audit record as what it did.
 */
import type { Capability, RiskClass, Step } from '../artifact/schema.js';
import { computeContentHash } from '../artifact/hash.js';

export type Decision = { allow: true } | { allow: false; code: string; reason: string };

export interface ExecutionContext {
  /** Who/what triggered this invocation. */
  principal: { id: string; kind: 'agent' | 'human' | 'system'; roles: string[] };
  /** Present iff the caller supplied one. Required for irreversible capabilities. */
  confirmationToken?: string;
  /** Unattended = no human watching. Tightens the approval requirement. */
  unattended: boolean;
  startedAt: number;
  stepsTaken: number;
  /**
   * Milliseconds this run spent paused with a human holding the wheel.
   *
   * The wall-clock budget exists to stop an automation grinding against a core
   * that has stopped answering. An operator reading a screen and deciding what
   * to do is not that — and a budget that counts their thinking time makes the
   * escalation path unusable, because every real rescue takes longer than any
   * sane automation timeout. The clock stops while a person has control and
   * starts again when they hand it back.
   */
  pausedMs?: number;
}

export interface PolicyEvent {
  at: string;
  decision: 'allow' | 'deny';
  code: string;
  detail: string;
  subject: string;
}

/**
 * Risk ordering. `dismiss_if_present` is read-only by construction; `navigate`
 * is read-only in a well-behaved app but is scored `low` because legacy systems
 * routinely perform state changes on GET.
 */
const RISK_ORDER: RiskClass[] = ['read_only', 'low', 'medium', 'high', 'irreversible'];
export const riskAtLeast = (a: RiskClass, b: RiskClass): boolean => RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b);

/** A capability plus, when one was applied, what it was resolved from. */
type Governed = Capability & {
  resolvedFor?: { overlayId: string; patchCount: number; overlayApproved: boolean; tenantId: string };
};

export class PolicyEngine {
  readonly events: PolicyEvent[] = [];

  constructor(private readonly cap: Governed, private readonly ctx: ExecutionContext) {}

  private record(decision: 'allow' | 'deny', code: string, subject: string, detail: string): void {
    this.events.push({ at: new Date().toISOString(), decision, code, subject, detail });
  }

  private deny(code: string, subject: string, reason: string): Decision {
    this.record('deny', code, subject, reason);
    return { allow: false, code, reason };
  }

  /** Gate the whole invocation before step 1. */
  admit(): Decision {
    const p = this.cap.policy;
    const q = this.cap.quality;

    if (q.approvalState === 'deprecated') {
      return this.deny('CAPABILITY_DEPRECATED', this.cap.metadata.id,
        `Capability ${this.cap.metadata.id}@${this.cap.metadata.version} is deprecated.`);
    }
    // Approval is of a document, not of a name. If the behaviour-determining
    // content has changed since a reviewer signed off, the approval is void.
    if (q.approvalState === 'approved' && q.approvedContentHash) {
      const current = computeContentHash(this.cap);
      if (current !== q.approvedContentHash) {
        return this.deny('APPROVAL_STALE', this.cap.metadata.id,
          `${this.cap.metadata.id}@${this.cap.metadata.version} was approved as ${q.approvedContentHash.slice(0, 12)} but its content is now ${current.slice(0, 12)}. ` +
          `The steps, targets or policy have changed since ${q.approvedBy ?? 'a reviewer'} signed off. It must be reviewed again.`);
      }
    }
    if (this.ctx.unattended && p.requiresApproval && q.approvalState !== 'approved') {
      return this.deny('APPROVAL_REQUIRED', this.cap.metadata.id,
        `Capability is in state "${q.approvalState}". Unattended invocation requires "approved". ` +
        `Run it attended (a human watching) or have an authorised reviewer approve it in the console.`);
    }
    // A tenant overlay that inserts or replaces steps changes what the
    // approved flow does. The base reviewer never saw those steps.
    const r = this.cap.resolvedFor;
    if (this.ctx.unattended && r && r.patchCount > 0 && !r.overlayApproved) {
      return this.deny('OVERLAY_APPROVAL_REQUIRED', r.overlayId,
        `Overlay "${r.overlayId}" modifies the approved flow (${r.patchCount} patch(es)) but carries no reviewer sign-off of its own. ` +
        `The base capability's approval does not extend to steps its reviewer never saw.`);
    }
    if (p.requiresPerInvocationConfirmation && !this.ctx.confirmationToken) {
      return this.deny('CONFIRMATION_REQUIRED', this.cap.metadata.id,
        `Capability "${this.cap.metadata.title}" is ${this.cap.contract.effects.reversible ? '' : 'irreversible and '}` +
        `requires an explicit confirmationToken from the caller. Refusing to act without one.`);
    }
    if (this.cap.contract.effects.financialImpact && this.ctx.unattended && !this.ctx.principal.roles.includes('capability.invoke.financial')) {
      return this.deny('INSUFFICIENT_PRINCIPAL_ROLE', this.ctx.principal.id,
        `Principal "${this.ctx.principal.id}" lacks role "capability.invoke.financial" required by a fee-bearing capability.`);
    }
    this.record('allow', 'ADMITTED', this.cap.metadata.id, `principal=${this.ctx.principal.id} unattended=${this.ctx.unattended}`);
    return { allow: true };
  }

  /** Gate each step as it is about to run. */
  step(step: Step, resolvedUrl?: string): Decision {
    const p = this.cap.policy;

    if (this.ctx.stepsTaken >= p.maxSteps) {
      return this.deny('STEP_BUDGET_EXCEEDED', step.id, `Step budget of ${p.maxSteps} exhausted.`);
    }
    const elapsed = Date.now() - this.ctx.startedAt - (this.ctx.pausedMs ?? 0);
    if (elapsed > p.maxDurationMs) {
      return this.deny('TIME_BUDGET_EXCEEDED', step.id, `Wall-clock budget of ${p.maxDurationMs}ms exceeded (${elapsed}ms).`);
    }
    if (p.allowedActions.length && !p.allowedActions.includes(step.kind as never)) {
      return this.deny('ACTION_NOT_ALLOWED', step.id, `Action "${step.kind}" is not in the capability's allowed action set.`);
    }
    if (riskAtLeast(step.risk ?? 'read_only', 'irreversible') && !this.ctx.confirmationToken) {
      return this.deny('IRREVERSIBLE_WITHOUT_CONFIRMATION', step.id,
        `Step "${step.id}" (${step.intent}) is irreversible and no confirmationToken was supplied.`);
    }
    if (resolvedUrl) {
      const d = this.url(resolvedUrl, step.id);
      if (!d.allow) return d;
    }
    this.record('allow', 'STEP_ALLOWED', step.id, `${step.kind} risk=${step.risk ?? 'read_only'}`);
    return { allow: true };
  }

  /** Origin + path allowlist. Also used for the initial entry URL. */
  url(url: string, subject: string): Decision {
    const p = this.cap.policy;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return this.deny('MALFORMED_URL', subject, `"${url}" is not a valid absolute URL.`); }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return this.deny('PROTOCOL_NOT_ALLOWED', subject, `Protocol "${parsed.protocol}" is not permitted.`);
    }
    if (!p.allowedOrigins.includes(parsed.origin)) {
      return this.deny('ORIGIN_NOT_ALLOWED', subject,
        `Origin "${parsed.origin}" is not in the capability allowlist [${p.allowedOrigins.join(', ')}].`);
    }
    if (p.allowedPathPatterns.length) {
      const ok = p.allowedPathPatterns.some((re) => { try { return new RegExp(re).test(parsed.pathname); } catch { return false; } });
      if (!ok) {
        return this.deny('PATH_NOT_ALLOWED', subject,
          `Path "${parsed.pathname}" does not match any allowed pattern [${p.allowedPathPatterns.join(', ')}].`);
      }
    }
    // Permits are recorded as well as refusals. Where the automation *did not*
    // go is part of the answer to "what did this thing do to our core?", and an
    // audit log that only records denials cannot support that claim.
    this.record('allow', 'URL_ALLOWED', subject, parsed.origin + parsed.pathname);
    return { allow: true };
  }

  /**
   * Gate an LLM-proposed action during discovery.
   *
   * Discovery is the one time a model chooses what to do, so it is the one time
   * the allowlist is load-bearing against the model rather than against the
   * application. The model never sees a way to widen it: the policy is supplied
   * by the operator who started the run, not inferred from the goal.
   */
  discoveryAction(kind: string, url: string | undefined, risk: RiskClass, subject: string): Decision {
    const p = this.cap.policy;
    if (p.allowedActions.length && !p.allowedActions.includes(kind as never)) {
      return this.deny('ACTION_NOT_ALLOWED', subject, `Model proposed "${kind}", which is not permitted for this run.`);
    }
    if (riskAtLeast(risk, 'high') && !this.ctx.confirmationToken) {
      return this.deny('RISKY_ACTION_BLOCKED_IN_DISCOVERY', subject,
        `Model proposed a ${risk} action. Discovery runs may not take high-risk actions without an explicit confirmation token; ` +
        `escalate to a human instead.`);
    }
    if (url) return this.url(url, subject);
    return { allow: true };
  }
}

/**
 * Classify an action's risk.
 *
 * Used during discovery, where the model proposes an action and something other
 * than the model has to decide how dangerous it was. The model's own opinion is
 * recorded but never trusted: it is an input to review, not a gate.
 *
 * The classification is structural first and lexical second, which is the right
 * way round:
 *
 *   - Typing into a box changes nothing. State changes when something is
 *     submitted, so `fill` and `select` are read-only and the risk lands on the
 *     control that posts.
 *   - Following a link is navigation.
 *   - A control inside a GET form is running a query. A control inside a POST
 *     form is running a transaction. That distinction is in the markup and
 *     needs no guessing.
 *
 * Only then do the words matter — and they matter most for separating
 * "changes a record" from "cannot be undone", which is the line the policy
 * engine actually enforces.
 */
export interface RiskSignals {
  /** Role of the control being activated. */
  role?: string;
  /** Accessible name of the control. */
  name?: string;
  /** method attribute of the enclosing form, if any. */
  formMethod?: string;
  /** input type, which distinguishes a submit from a scripted navigation. */
  inputType?: string;
  /** For `press`: the key. Enter inside a form submits it. */
  key?: string;
  /** Visible text of the screen, for warnings the application itself prints. */
  pageText?: string;
  /** href of a link, which is how a navigation link is told from a postback. */
  href?: string;
  /** For `navigate`: the destination, since legacy cores commit on GET. */
  url?: string;
}

const IRREVERSIBLE_WORDS = [
  'stop payment', 'place stop', 'reverse fee', 'reverse', 'disburse', 'wire',
  'close account', 'charge off', 'delete', 'purge', 'void',
];
const MUTATING_WORDS = [
  'submit', 'open account', 'place ', 'save', 'update', 'apply', 'approve',
  'authorize', 'authorise', 'confirm', 'accept', 'post ', 'transfer', 'release',
];

export function classifyRisk(kind: string, targetName: string | undefined, pageText: string, signals: RiskSignals = {}): RiskClass {
  // Reading and staging are free. Nothing has been committed.
  if (kind === 'wait_for' || kind === 'extract' || kind === 'assert') return 'read_only';
  if (kind === 'fill' || kind === 'select') return 'read_only';

  /**
   * A GET is not a promise either.
   *
   * These cores commit on navigation all the time — `…/fee-reversal?confirm=1`
   * is not a hypothetical shape — so a URL is read as a sentence like any other
   * control name. Nothing in the query string that reads like a commit means
   * read-only, which is the common case and stays free.
   */
  if (kind === 'navigate') {
    const url = (signals.url ?? '').toLowerCase();
    if (!url) return 'read_only';
    if (IRREVERSIBLE_WORDS.some((w) => url.includes(w.replace(/\s+/g, '')) || url.includes(w))) return 'irreversible';
    if (/\b(confirm|commit|post|apply|submit|execute|approve|delete|remove|void)\b/.test(url)) return 'medium';
    return 'read_only';
  }

  /**
   * Enter inside a form submits it.
   *
   * These applications are keyboard-driven and operators submit with Enter
   * constantly. Treating `press` as read-only would route a POST around the
   * irreversible-action gate *and* around the validator's rule that a
   * state-changing step must carry a checkpoint — the two controls that exist
   * precisely to catch this.
   */
  if (kind === 'press') {
    const key = (signals.key ?? '').toLowerCase();
    const submitsOnKey = key === 'enter' || key === 'numpadenter';
    if (!submitsOnKey) return 'read_only';
    // fall through and classify it as activating this form's submit control
  }

  const name = (targetName ?? signals.name ?? '').toLowerCase();
  const page = (pageText ?? signals.pageText ?? '').toLowerCase();
  const method = (signals.formMethod ?? '').toLowerCase();
  const role = signals.role ?? '';

  /**
   * Navigation is navigation, whatever the destination is called.
   *
   * A menu link reading "Stop Payment" opens a screen; it does not place a stop
   * payment, and classifying it as irreversible would demand a confirmation
   * token to open a form — which trains people to supply tokens reflexively,
   * and a reflexive confirmation is no confirmation.
   *
   * But "link" is a role, not a promise. In WebForms a grid action link is
   * `javascript:__doPostBack(...)`: it looks like a link, and it posts. So the
   * exemption is for links that navigate — ones with a real href that is not a
   * script — and a link that posts is classified like any other submit.
   * Getting this wrong is quiet and expensive: a link-driven mutation recorded
   * `read_only` also never sets the engine's "something has been committed"
   * flag, which is what stops a session-expiry recovery from replaying a flow
   * that has already posted.
   */
  let linkPostsBack = false;
  if (role === 'link') {
    // An absent href is not evidence of a postback — it is the caller not
    // having told us. The web surface only assigns the `link` role to an
    // element that has one, so absence here means the signal was not supplied,
    // and the safe reading of "no information" is the common case: navigation.
    const href = signals.href?.trim().toLowerCase();
    linkPostsBack = method === 'post'
      || (href !== undefined && (href.startsWith('javascript:') || href === '' || href === '#'));
    if (!linkPostsBack) return 'read_only';
  }

  const submits = kind === 'press' || linkPostsBack
    || signals.inputType === 'submit' || signals.inputType === 'image' || method === 'post';
  if (!submits) return 'read_only';

  const irreversibleByWord = IRREVERSIBLE_WORDS.some((w) => name.includes(w));
  const mutatingByWord = MUTATING_WORDS.some((w) => name.includes(w));
  // The application warning its own operator is the strongest signal available.
  const pageWarnsIrreversible = /irreversible|cannot be reversed|cannot be undone|fee will be assessed/.test(page);

  if (irreversibleByWord || pageWarnsIrreversible) return 'irreversible';
  // A GET submit is a query — a search button, a filter. A postback link is
  // not: it has no form method to report because the form is submitted by
  // script, and it is the shape most grid actions in this vendor's product
  // take.
  if (method !== 'post' && !linkPostsBack) return 'read_only';
  if (mutatingByWord) return 'high';
  return 'medium';
}
