/**
 * Scenario controller.
 *
 * Real legacy cores fail in specific, recurring ways. Rather than hope one of
 * those happens while a reviewer is watching, MERIDIAN exposes an explicit
 * control surface so every exceptional state can be summoned on demand and
 * reproduced exactly. Default state is fully deterministic: nothing fails
 * unless you ask it to.
 *
 * Endpoints (simulator-only, never part of the automated surface):
 *   GET  /__sim/state
 *   POST /__sim/scenario   { ...partial scenario }
 *   POST /__sim/reset
 */

export interface Scenario {
  /** Expire the operator session on the next content request. */
  forceSessionExpiry: boolean;
  /**
   * Expire the session once, after this many content requests (null = never).
   *
   * One-shot on purpose: a core that times out again immediately after every
   * re-authentication is not a timeout, it is an outage, and it tests nothing
   * interesting about recovery.
   */
  sessionExpiresAfterRequests: number | null;
  /** "System is in end-of-day processing" lockout. */
  eodLockout: boolean;
  /** Fail the next N content requests with a transient 503. */
  transientFailuresRemaining: number;
  /** Add this much artificial latency to every content request. */
  latencyMs: number;
  /** Deny every privileged action regardless of the signed-in role. */
  forcePermissionDenied: boolean;
  /** Show the compliance interstitial before every member detail screen. */
  alwaysShowComplianceInterstitial: boolean;
  /** Simulate the record-locked ("in use by another user") condition globally. */
  forceRecordLocked: boolean;
}

export const DEFAULT_SCENARIO: Scenario = {
  forceSessionExpiry: false,
  sessionExpiresAfterRequests: null,
  eodLockout: false,
  transientFailuresRemaining: 0,
  latencyMs: 0,
  forcePermissionDenied: false,
  alwaysShowComplianceInterstitial: false,
  forceRecordLocked: false,
};

export class SimState {
  scenario: Scenario = { ...DEFAULT_SCENARIO };
  contentRequestCount = 0;

  reset(): void {
    this.scenario = { ...DEFAULT_SCENARIO };
    this.contentRequestCount = 0;
  }

  apply(patch: Partial<Scenario>): Scenario {
    this.scenario = { ...this.scenario, ...patch };
    return this.scenario;
  }

  /** Consume one transient failure if any are queued. */
  takeTransientFailure(): boolean {
    if (this.scenario.transientFailuresRemaining > 0) {
      this.scenario.transientFailuresRemaining -= 1;
      return true;
    }
    return false;
  }

  /** Should this content request be treated as an expired session? */
  takeSessionExpiry(): boolean {
    if (this.scenario.forceSessionExpiry) {
      this.scenario.forceSessionExpiry = false;
      return true;
    }
    const n = this.scenario.sessionExpiresAfterRequests;
    if (n !== null && this.contentRequestCount > n) {
      this.scenario.sessionExpiresAfterRequests = null;
      return true;
    }
    return false;
  }
}
