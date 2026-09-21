/**
 * Applying a TenantOverlay to a base Capability.
 *
 * The result is called a *resolved capability*: still a valid CAP-1 document,
 * still hashable, but pinned to one institution. Replay always operates on a
 * resolved capability, never on a base — which means there is exactly one code
 * path, whether or not an overlay exists.
 *
 * Merge is deliberately shallow-per-field rather than a generic deep merge.
 * Generic deep merges are unpredictable on arrays, and an unpredictable merge in
 * the path between "approved artifact" and "action against a bank's core" is not
 * a trade I am willing to make.
 */
import type { Capability, Step, TenantOverlay } from './schema.js';
import type { TargetDescriptor } from './target.js';
import { computeContentHash } from './hash.js';

export interface ResolvedCapability extends Capability {
  /** Present iff an overlay was applied. */
  resolvedFor?: {
    tenantId: string;
    institution: string;
    overlayId: string;
    baseContentHash: string;
    patchCount: number;
  };
}

function applyTargetOverride(t: TargetDescriptor | undefined, overrides: Record<string, Record<string, unknown>>): TargetDescriptor | undefined {
  if (!t) return t;
  const o = overrides[t.id];
  const within = applyTargetOverride(t.within, overrides);
  const base: TargetDescriptor = within ? { ...t, within } : { ...t };
  if (!o) return base;
  // Field-level replacement. An override that supplies `name` replaces the whole
  // name probe; it does not merge into it. Partial probes are ambiguous.
  return { ...base, ...(o as Partial<TargetDescriptor>) };
}

function patchSteps(steps: Step[], patches: TenantOverlay['stepPatches']): Step[] {
  let out = [...steps];
  for (const p of patches) {
    const i = out.findIndex((s) => s.id === p.stepId);
    if (i < 0) continue; // validateOverlay has already flagged this as an error
    switch (p.op) {
      case 'skip':
        out = out.filter((_, idx) => idx !== i);
        break;
      case 'replace':
        if (p.step) out[i] = { ...p.step, authoredBy: 'overlay' };
        break;
      case 'insert-before':
        if (p.step) out.splice(i, 0, { ...p.step, authoredBy: 'overlay' });
        break;
      case 'insert-after':
        if (p.step) out.splice(i + 1, 0, { ...p.step, authoredBy: 'overlay' });
        break;
    }
  }
  return out;
}

export function resolveCapability(cap: Capability, overlay?: TenantOverlay): ResolvedCapability {
  if (!overlay) return { ...cap };

  const vocabulary = { ...cap.target.vocabulary, ...overlay.vocabulary };
  const steps = patchSteps(cap.flow.steps, overlay.stepPatches).map((s) => ({
    ...s,
    target: applyTargetOverride(s.target, overlay.targetOverrides),
    expect: s.expect
      ? { ...s.expect, all: s.expect.all.map((a) => ({ ...a, target: applyTargetOverride(a.target, overlay.targetOverrides) })) }
      : s.expect,
  }));

  const resolved: ResolvedCapability = {
    ...cap,
    target: {
      ...cap.target,
      vocabulary,
      entry: { ...cap.target.entry },
    },
    // Tenant signals are appended, not merged: a local interstitial is additive
    // and must not be able to silently disable a base safety signal.
    signals: [...cap.signals, ...overlay.extraSignals],
    policy: {
      ...cap.policy,
      ...(overlay.policyOverrides ?? {}),
      // Origin allowlist is the union of the product default and the tenant's
      // own instance. A tenant cannot widen the *action* allowlist this way.
      allowedOrigins: [...new Set([...cap.policy.allowedOrigins, new URL(overlay.tenant.baseUrl).origin])],
      allowedActions: cap.policy.allowedActions,
    },
    flow: {
      ...cap.flow,
      steps,
      successCheckpoint: {
        ...cap.flow.successCheckpoint,
        all: cap.flow.successCheckpoint.all.map((a) => ({ ...a, target: applyTargetOverride(a.target, overlay.targetOverrides) })),
      },
    },
    resolvedFor: {
      tenantId: overlay.metadata.tenantId,
      institution: overlay.metadata.institution,
      overlayId: overlay.metadata.id,
      baseContentHash: computeContentHash(cap),
      patchCount: overlay.stepPatches.length + Object.keys(overlay.targetOverrides).length,
    },
  };
  return resolved;
}

/** The `tenant.*` template namespace for a run. */
export function tenantContext(overlay: TenantOverlay | undefined, fallbackBaseUrl: string): Record<string, string> {
  if (!overlay) return { baseUrl: fallbackBaseUrl, tenantId: 'default', productVersion: '' };
  return {
    baseUrl: overlay.tenant.baseUrl.replace(/\/$/, ''),
    tenantId: overlay.metadata.tenantId,
    institution: overlay.metadata.institution,
    productVersion: overlay.tenant.productVersion ?? '',
  };
}
