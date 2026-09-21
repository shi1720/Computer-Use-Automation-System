/**
 * Semantic validation — the rules zod cannot express.
 *
 * Schema validation says the document is well-formed. This says the document is
 * *safe to approve*. It is the automated half of the review a bank's change
 * board would otherwise do by eye, and it runs on discovery output before the
 * artifact is ever written to disk.
 *
 * Findings are graded. `error` blocks persistence; `warning` is recorded on the
 * artifact and shown to the approver; `info` is advisory.
 */
import type { Capability, Step, TenantOverlay } from './schema.js';
import type { TargetDescriptor } from './target.js';
import { referencesOf } from './template.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  /** Dotted path into the document, for pinpointing in the console. */
  at: string;
}

const MUTATING_KINDS = new Set(['click', 'press']);

function collectTemplates(cap: Capability): Array<{ at: string; tmpl: string }> {
  const out: Array<{ at: string; tmpl: string }> = [];
  const target = (t: TargetDescriptor | undefined, at: string) => {
    if (!t) return;
    if (t.name?.value) out.push({ at: `${at}.name`, tmpl: t.name.value });
    if (t.cell?.rowWhere?.equals) out.push({ at: `${at}.cell.rowWhere`, tmpl: t.cell.rowWhere.equals });
    for (const [i, a] of (t.anchors ?? []).entries()) out.push({ at: `${at}.anchors[${i}]`, tmpl: a.text.value });
    target(t.within, `${at}.within`);
  };
  out.push({ at: 'target.entry.urlTemplate', tmpl: cap.target.entry.urlTemplate });
  for (const [i, s] of cap.flow.steps.entries()) {
    if (s.url) out.push({ at: `flow.steps[${i}].url`, tmpl: s.url });
    if (s.value) out.push({ at: `flow.steps[${i}].value`, tmpl: s.value });
    target(s.target, `flow.steps[${i}].target`);
    for (const [j, a] of (s.expect?.all ?? []).entries()) {
      if (a.text) out.push({ at: `flow.steps[${i}].expect.all[${j}]`, tmpl: a.text });
      target(a.target, `flow.steps[${i}].expect.all[${j}].target`);
    }
  }
  for (const [j, a] of cap.flow.successCheckpoint.all.entries()) {
    if (a.text) out.push({ at: `flow.successCheckpoint.all[${j}]`, tmpl: a.text });
    target(a.target, `flow.successCheckpoint.all[${j}].target`);
  }
  return out;
}

export function validateCapability(cap: Capability): Finding[] {
  const f: Finding[] = [];
  const add = (severity: Severity, code: string, at: string, message: string) => f.push({ severity, code, at, message });

  const inputNames = new Set(cap.contract.inputs.map((i) => i.name));
  const outputNames = new Set(cap.contract.outputs.map((o) => o.name));
  const stepIds = new Set<string>();
  const signalIds = new Set(cap.signals.map((s) => s.id));

  // ── structural integrity ──────────────────────────────────────────────────
  for (const [i, s] of cap.flow.steps.entries()) {
    if (stepIds.has(s.id)) add('error', 'DUPLICATE_STEP_ID', `flow.steps[${i}]`, `Duplicate step id "${s.id}".`);
    stepIds.add(s.id);

    if (s.kind === 'navigate' && !s.url) add('error', 'NAVIGATE_WITHOUT_URL', `flow.steps[${i}]`, `Step "${s.id}" navigates but declares no url.`);
    if (['click', 'fill', 'select', 'extract', 'dismiss_if_present'].includes(s.kind) && !s.target) {
      add('error', 'STEP_WITHOUT_TARGET', `flow.steps[${i}]`, `Step "${s.id}" (${s.kind}) has no target descriptor.`);
    }
    if (s.kind === 'fill' && s.value === undefined) add('error', 'FILL_WITHOUT_VALUE', `flow.steps[${i}]`, `Step "${s.id}" fills a control but has no value.`);
    if (s.kind === 'extract' && !s.extract) add('error', 'EXTRACT_WITHOUT_BINDING', `flow.steps[${i}]`, `Step "${s.id}" extracts but declares no output binding.`);
    if (s.extract && !outputNames.has(s.extract.into)) {
      add('error', 'EXTRACT_UNDECLARED_OUTPUT', `flow.steps[${i}].extract`, `Step "${s.id}" extracts into "${s.extract.into}", which is not declared in contract.outputs.`);
    }
    for (const sig of Object.keys(s.onSignal ?? {})) {
      if (!signalIds.has(sig)) add('error', 'UNKNOWN_SIGNAL_REF', `flow.steps[${i}].onSignal`, `Step "${s.id}" references unknown signal "${sig}".`);
    }

    // ── the checkpoint rule ─────────────────────────────────────────────────
    // A step that changes state and does not verify the result is the single
    // most common way automation reports success while having done nothing.
    const mutates = (s.risk ?? 'read_only') !== 'read_only';
    if (mutates && !s.expect && !s.optional) {
      add('error', 'MUTATING_STEP_WITHOUT_CHECKPOINT', `flow.steps[${i}]`,
        `Step "${s.id}" is risk=${s.risk} but has no expect{} checkpoint. A state-changing step must prove it worked.`);
    }
    if (!mutates && MUTATING_KINDS.has(s.kind) && !s.expect && !s.optional) {
      add('warning', 'NAVIGATION_STEP_WITHOUT_CHECKPOINT', `flow.steps[${i}]`,
        `Step "${s.id}" clicks without a checkpoint. Replay cannot distinguish "the click worked" from "the page never changed".`);
    }
  }

  // ── contract coherence ────────────────────────────────────────────────────
  const boundOutputs = new Set(cap.flow.steps.flatMap((s) => (s.extract ? [s.extract.into] : [])));
  for (const capture of cap.signals.flatMap((s) => s.capture ?? [])) boundOutputs.add(capture.name);
  for (const o of cap.contract.outputs) {
    if (!boundOutputs.has(o.name)) {
      add('warning', 'UNBOUND_OUTPUT', 'contract.outputs',
        `Output "${o.name}" is declared but no step extracts it; callers will always receive null.`);
    }
  }
  for (const s of cap.signals) {
    if (s.kind === 'business' && !s.outcomeCode) {
      add('error', 'BUSINESS_SIGNAL_WITHOUT_CODE', `signals.${s.id}`, `Business signal "${s.id}" must declare an outcomeCode the caller can branch on.`);
    }
    if (s.kind === 'business' && s.outcomeCode && !cap.contract.outcomes.some((o) => o.code === s.outcomeCode)) {
      add('error', 'UNDECLARED_OUTCOME', `signals.${s.id}`, `Signal "${s.id}" returns outcome "${s.outcomeCode}", which is not declared in contract.outcomes.`);
    }
    if (s.kind === 'recoverable' && !s.recovery) {
      add('error', 'RECOVERABLE_WITHOUT_PLAN', `signals.${s.id}`, `Signal "${s.id}" is recoverable but declares no recovery plan.`);
    }
  }

  // ── template hygiene ──────────────────────────────────────────────────────
  for (const { at, tmpl } of collectTemplates(cap)) {
    for (const ref of referencesOf(tmpl)) {
      if (ref.ns === 'input' && !inputNames.has(ref.path.split('.')[0] as string)) {
        add('error', 'UNKNOWN_INPUT_REF', at, `References {{input.${ref.path}}}, which is not a declared input.`);
      }
      if (ref.ns === 'output' && !outputNames.has(ref.path.split('.')[0] as string)) {
        add('error', 'UNKNOWN_OUTPUT_REF', at, `References {{output.${ref.path}}}, which is not a declared output.`);
      }
      if (ref.ns === 'vocab' && !(ref.path in cap.target.vocabulary)) {
        add('warning', 'UNKNOWN_VOCAB_REF', at, `References {{vocab.${ref.path}}} with no default in target.vocabulary; tenants without an override will fail.`);
      }
      if (!['input', 'output', 'vocab', 'tenant', 'run'].includes(ref.ns)) {
        add('error', 'UNKNOWN_NAMESPACE', at, `Unknown template namespace "${ref.ns}".`);
      }
    }
  }

  // ── policy coherence ──────────────────────────────────────────────────────
  if (cap.policy.allowedOrigins.length === 0) {
    add('error', 'EMPTY_ALLOWLIST', 'policy.allowedOrigins', 'A capability with an empty origin allowlist can navigate anywhere. Refusing.');
  }
  const usedKinds = new Set(cap.flow.steps.map((s) => s.kind));
  for (const k of usedKinds) {
    if (cap.policy.allowedActions.length && !cap.policy.allowedActions.includes(k as never)) {
      add('error', 'ACTION_NOT_ALLOWED', 'policy.allowedActions', `Flow uses action "${k}" which the capability's own policy does not permit.`);
    }
  }
  if (cap.contract.effects.mutating && cap.contract.effects.riskClass === 'read_only') {
    add('error', 'RISK_MISLABELLED', 'contract.effects', 'Capability is declared mutating but classified read_only.');
  }
  if (!cap.contract.effects.reversible && cap.contract.effects.mutating && !cap.policy.requiresPerInvocationConfirmation) {
    add('warning', 'IRREVERSIBLE_WITHOUT_CONFIRMATION', 'policy',
      'Capability performs an irreversible change but does not require per-invocation confirmation.');
  }
  if (cap.contract.effects.financialImpact && cap.quality.approvalState === 'approved' && !cap.quality.approvedBy) {
    add('error', 'APPROVED_WITHOUT_APPROVER', 'quality', 'A financially impactful capability is marked approved with no named approver.');
  }

  // ── secrets must never be inputs that get persisted ───────────────────────
  for (const i of cap.contract.inputs) {
    if (i.sensitivity === 'secret' && i.example) {
      add('error', 'SECRET_WITH_EXAMPLE', 'contract.inputs', `Input "${i.name}" is classified secret but carries an example value.`);
    }
  }

  // ── targeting robustness ──────────────────────────────────────────────────
  for (const [i, s] of cap.flow.steps.entries()) {
    const t = s.target;
    if (!t) continue;
    const hasSemantic = Boolean(t.name || (t.anchors?.length ?? 0) > 0 || t.cell);
    if (!hasSemantic) {
      add('warning', 'SELECTOR_ONLY_TARGET', `flow.steps[${i}].target`,
        `Target "${t.id}" is identified only by selector-level hints. It will not survive a version change or a re-brand.`);
    }
    if (t.hints?.ordinal && !hasSemantic) {
      add('warning', 'ORDINAL_ONLY_TARGET', `flow.steps[${i}].target`,
        `Target "${t.id}" relies on ordinal position. Any change to the result set breaks it.`);
    }
  }

  return f;
}

export function validateOverlay(overlay: TenantOverlay, cap: Capability): Finding[] {
  const f: Finding[] = [];
  const stepIds = new Set(cap.flow.steps.map((s) => s.id));
  const targetIds = new Set<string>();
  const walk = (t: TargetDescriptor | undefined) => { if (!t) return; targetIds.add(t.id); walk(t.within); };
  for (const s of cap.flow.steps) walk(s.target);

  if (overlay.metadata.capabilityId !== cap.metadata.id) {
    f.push({ severity: 'error', code: 'OVERLAY_CAPABILITY_MISMATCH', at: 'metadata.capabilityId', message: `Overlay targets "${overlay.metadata.capabilityId}" but was applied to "${cap.metadata.id}".` });
  }
  for (const [i, p] of overlay.stepPatches.entries()) {
    if (!stepIds.has(p.stepId)) {
      f.push({ severity: 'error', code: 'OVERLAY_UNKNOWN_STEP', at: `stepPatches[${i}]`, message: `Patch references step "${p.stepId}" which does not exist in the base capability.` });
    }
  }
  for (const id of Object.keys(overlay.targetOverrides)) {
    if (!targetIds.has(id)) {
      f.push({ severity: 'error', code: 'OVERLAY_UNKNOWN_TARGET', at: `targetOverrides.${id}`, message: `Override references target "${id}" which does not exist in the base capability.` });
    }
  }
  // The "this should have been a second capability" heuristic.
  const patched = new Set(overlay.stepPatches.map((p) => p.stepId));
  const divergence = (patched.size + Object.keys(overlay.targetOverrides).length) / Math.max(cap.flow.steps.length, 1);
  if (divergence > 0.4) {
    f.push({ severity: 'warning', code: 'OVERLAY_TOO_DIVERGENT', at: 'stepPatches',
      message: `This overlay modifies ${Math.round(divergence * 100)}% of the base flow. Past ~40% the tenants are not really running the same flow; consider a separate base capability instead.` });
  }
  return f;
}

export const hasErrors = (f: Finding[]): boolean => f.some((x) => x.severity === 'error');
export const formatFindings = (f: Finding[]): string =>
  f.map((x) => `  ${x.severity === 'error' ? '✗' : x.severity === 'warning' ? '!' : 'i'} [${x.code}] ${x.at}\n      ${x.message}`).join('\n');
