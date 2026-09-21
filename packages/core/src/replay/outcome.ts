/**
 * The result contract.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * The brief names the most common design mistake in this problem, and it is
 * worth restating because the whole shape of this file follows from avoiding
 * it: **"no such member" is an answer, not a crash.**
 *
 * An AI agent calling a capability needs to distinguish four things, and if the
 * result type does not force that distinction, the caller will collapse them:
 *
 *   success           the flow completed and here are the typed outputs
 *   business_outcome  the application gave a legitimate, declared answer that
 *                     is not the happy path — not found, not authorised,
 *                     validation rejected, system in end-of-day. The caller
 *                     branches on `outcome.code`; it should not retry blindly
 *                     and must not treat this as an incident.
 *   escalated         the run paused, a human took the live session, and here
 *                     is what they did. The work may or may not be complete.
 *   failed            something is wrong with the automation or the
 *                     environment. This is an incident. It carries which step,
 *                     what was expected, what was observed, and where the
 *                     evidence is.
 *
 * Recoveries are deliberately *not* a status. A session that timed out and was
 * re-established still succeeded; surfacing that as its own outcome would train
 * callers to handle a non-event. It is recorded on the result as a list, so the
 * fleet-health view can see that a capability is quietly recovering twice per
 * run before it starts failing.
 */
import type { RiskClass } from '../artifact/schema.js';

export type FailureClass =
  | 'TARGET_NOT_FOUND'        // the control the artifact describes is not on screen
  | 'TARGET_AMBIGUOUS'        // several candidates, none clearly right — refused to guess
  | 'CHECKPOINT_FAILED'       // the action ran but the screen did not become what was expected
  | 'PRECONDITION_FAILED'     // inputs invalid, or the starting state was wrong
  | 'POLICY_DENIED'           // the run tried to do something it is not permitted to do
  | 'SIGNAL_FATAL'            // a condition fired that the artifact classifies as fatal
  | 'RECOVERY_EXHAUSTED'      // a recoverable condition kept recurring
  | 'TIMEOUT'                 // a budget ran out
  | 'SURFACE_ERROR'           // the browser/session itself failed
  | 'SESSION_UNRECOVERABLE'   // could not re-establish an authenticated session
  | 'INTERNAL';

export interface StepTrace {
  stepId: string;
  intent: string;
  kind: string;
  risk: RiskClass;
  status: 'ok' | 'skipped' | 'recovered' | 'failed';
  durationMs: number;
  /** Resolution quality — the early-warning signal for drift. */
  targeting?: { score: number; corroboration: number; margin: number; matched: string[]; missed: string[]; candidates: number };
  checkpoint?: { held: boolean; description: string; observed?: string };
  note?: string;
}

export interface RecoveryTrace {
  signalId: string;
  signalTitle: string;
  strategy: string;
  attempts: number;
  succeeded: boolean;
  atStepId: string;
}

export interface EscalationTrace {
  interventionId: string;
  reason: string;
  atStepId?: string;
  /** What the operator declared they did. */
  resolution?: string;
  note?: string;
  humanActions: number;
}

export interface ReplayCommon {
  runId: string;
  capability: { id: string; version: string; contentHash?: string };
  tenant: { id: string; institution?: string };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepTrace[];
  recoveries: RecoveryTrace[];
  /**
   * Every time a human was brought into this run.
   *
   * Recorded on success as well as failure: a caller reconciling a posting
   * needs to know a person touched the session, even if the automation went on
   * to finish the job itself.
   */
  escalations: EscalationTrace[];
  evidenceDir: string;
  /**
   * 0-100: the mean target-resolution score across this run.
   *
   * A run where every control resolved on strong semantic evidence scores 100.
   * One that only just cleared its thresholds scores in the 60s — working, but
   * visibly closer to the edge than it was when the capability was recorded.
   */
  runQuality: number;
  /**
   * 0-100: how well this run's *corroborating* evidence still agrees.
   *
   * Separate from `runQuality` on purpose. A capability can identify every
   * control perfectly while its recorded id patterns stop matching — which is
   * what a vendor version rollout looks like from the inside, days before it
   * breaks anything. This is the number to alert on across a fleet.
   */
  driftSignal: number;
  /** Model calls made during this run. Structurally zero; counted rather than asserted. */
  llmCalls: number;
}

export type ReplayResult =
  | (ReplayCommon & { status: 'success'; outputs: Record<string, unknown> })
  | (ReplayCommon & {
      status: 'business_outcome';
      outcome: { code: string; retryable: boolean; message: string; data: Record<string, unknown> };
      outputs: Record<string, unknown>;
    })
  | (ReplayCommon & {
      status: 'escalated';
      intervention: { id: string; reason: string; resolution?: string; note?: string; humanActions: number };
      outputs: Record<string, unknown>;
    })
  | (ReplayCommon & {
      status: 'failed';
      error: {
        class: FailureClass;
        stepId?: string;
        stepIntent?: string;
        message: string;
        expected?: string;
        observed?: string;
        /** Relative paths inside the evidence bundle. */
        evidence: { screenshot?: string; snapshot?: string; page?: string };
      };
      outputs: Record<string, unknown>;
    });

/** Compact, human-first rendering for CLI output and console cards. */
export function formatResult(r: ReplayResult): string {
  const head = `${r.capability.id}@${r.capability.version} · ${r.tenant.id} · ${r.durationMs}ms · ${r.steps.length} steps · ${r.llmCalls} model calls` +
    (r.driftSignal < 80 ? ` · drift ${r.driftSignal}` : '');
  switch (r.status) {
    case 'success':
      return `SUCCESS  ${head}\n  outputs: ${JSON.stringify(r.outputs)}` +
        (r.escalations.length ? `\n  note: a human was involved in this run (${r.escalations.length} escalation(s)); the automation completed it.` : '');
    case 'business_outcome':
      return `OUTCOME  ${head}\n  ${r.outcome.code}${r.outcome.retryable ? ' (retryable)' : ''}: ${r.outcome.message}` +
        `${Object.keys(r.outcome.data).length ? `\n  data: ${JSON.stringify(r.outcome.data)}` : ''}`;
    case 'escalated':
      return `ESCALATED ${head}\n  intervention ${r.intervention.id} (${r.intervention.reason})` +
        `\n  resolution: ${r.intervention.resolution ?? 'pending'} — ${r.intervention.note ?? ''}` +
        `\n  human actions recorded: ${r.intervention.humanActions}` +
        `\n  A person completed this work, not the automation. Verify before acting on it.` +
        (Object.keys(r.outputs).length ? `\n  outputs: ${JSON.stringify(r.outputs)}` : '');
    case 'failed':
      return `FAILED   ${head}\n  ${r.error.class} at step "${r.error.stepId ?? '-'}" (${r.error.stepIntent ?? '-'})` +
        `\n  ${r.error.message}` +
        (r.error.expected ? `\n  expected: ${r.error.expected}` : '') +
        (r.error.observed ? `\n  observed: ${r.error.observed}` : '') +
        `\n  evidence: ${r.evidenceDir}`;
  }
}
