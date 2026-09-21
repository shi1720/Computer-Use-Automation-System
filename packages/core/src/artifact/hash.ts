/**
 * Content hashing and version discipline.
 *
 * `contentHash` covers only the *normative* subset of a capability: the parts
 * that determine what it will do. Quality statistics, replay counts and
 * provenance history all change constantly and must not churn the hash —
 * otherwise nobody can tell "this automation changed" from "this automation
 * ran again", which is precisely the distinction a bank's change-management
 * process exists to make.
 */
import { createHash } from 'node:crypto';
import type { Capability } from './schema.js';

/** Stable stringify: sorted keys, so key order never affects the hash. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, walk((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** The behaviour-determining subset of a capability. */
export function normativeSubset(cap: Capability): Record<string, unknown> {
  return {
    apiVersion: cap.apiVersion,
    id: cap.metadata.id,
    version: cap.metadata.version,
    target: cap.target,
    contract: cap.contract,
    policy: cap.policy,
    signals: cap.signals,
    flow: cap.flow,
  };
}

export function computeContentHash(cap: Capability): string {
  return sha256(canonicalJson(normativeSubset(cap)));
}

export function withContentHash(cap: Capability): Capability {
  return { ...cap, contentHash: computeContentHash(cap) };
}

/**
 * Did the behaviour of this capability change between two revisions?
 * Used by the console to show reviewers a meaningful diff and to invalidate
 * approvals: an approved capability whose hash changes drops back to `draft`.
 */
export function behaviourChanged(a: Capability, b: Capability): boolean {
  return computeContentHash(a) !== computeContentHash(b);
}
