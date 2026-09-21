/**
 * Product signal profiles.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * The runtime conditions a core banking system produces — session timeout, "in
 * end-of-day processing", "record in use by another operator", an OFAC
 * interstitial — are properties of the *product*, not of any one capability and
 * not of any one institution. Symitar times out the same way for every credit
 * union running it.
 *
 * So they are authored once per product and attached to every capability
 * recorded against it. Ten capabilities on Meridian share one definition of
 * "your session expired"; when the vendor changes that screen in 10.2, one
 * profile changes and every capability inherits the fix.
 *
 * This is the factoring that makes the error handling economic. Asking each
 * discovery run to rediscover session-timeout handling would be expensive,
 * unreliable, and would produce ten subtly different definitions of the same
 * condition.
 *
 * In a real deployment a profile is a reviewed, versioned record in the control
 * plane — the same review path as a capability. It is a TypeScript module here
 * because there is one product and a reviewer should be able to read it.
 */
import type { Signal } from '../artifact/schema.js';

export interface ProductProfile {
  id: string;
  vendor: string;
  product: string;
  /** Default vocabulary; tenants override individual terms. */
  vocabulary: Record<string, string>;
  signals: Signal[];
  /** Canonical outcome declarations the signals refer to. */
  outcomes: Array<{ code: string; kind: 'business' | 'failure'; description: string; retryable: boolean }>;
}

const MERIDIAN_CORE: ProductProfile = {
  id: 'meridian-core',
  vendor: 'Meridian Financial Systems',
  product: 'MERIDIAN Core Banking',
  vocabulary: {
    member: 'Member',
    memberNumber: 'Member #',
    share: 'Share',
    shareList: 'Share Accounts',
  },
  outcomes: [
    { code: 'RECORD_NOT_FOUND', kind: 'business', description: 'No record matched the search criteria supplied by the caller.', retryable: false },
    { code: 'NOT_AUTHORIZED', kind: 'business', description: 'The signed-in operator lacks authority for this transaction. A supervisor override is required.', retryable: false },
    { code: 'VALIDATION_FAILED', kind: 'business', description: "The application rejected the supplied values. The message field carries the core's own wording.", retryable: false },
    { code: 'SYSTEM_UNAVAILABLE_EOD', kind: 'business', description: 'The core is in end-of-day processing. Maintenance functions are unavailable until it completes.', retryable: true },
    { code: 'RECORD_LOCKED', kind: 'business', description: 'The record is held by another operator and was still held after retrying.', retryable: true },
  ],
  signals: [
    // ── recoverable ────────────────────────────────────────────────────────
    {
      id: 'session_expired',
      title: 'Operator session timed out',
      kind: 'recoverable',
      detect: [
        { kind: 'text_present', regex: 'MSG\\s*0900|SESSION HAS TIMED OUT|session has expired', because: 'the core drops you to a re-authentication screen inside the content frame' },
      ],
      recovery: {
        strategy: 'reauthenticate',
        maxAttempts: 2,
        backoffMs: 500,
        steps: [],
      },
      exceptStepIds: [],
      capture: [],
    },
    {
      id: 'transient_server_error',
      title: 'Application server returned 503',
      kind: 'recoverable',
      detect: [
        { kind: 'text_present', regex: 'HTTP 503|Service Temporarily Unavailable|did not respond within the configured timeout' },
      ],
      recovery: { strategy: 'wait_and_retry', maxAttempts: 3, backoffMs: 1_500, steps: [] },
      exceptStepIds: [],
      capture: [],
    },
    {
      id: 'compliance_interstitial',
      title: 'BSA/OFAC review notice',
      kind: 'recoverable',
      detect: [
        { kind: 'text_present', regex: 'BSA/OFAC NOTICE|RESTRICTED RECORD|COMPLIANCE REVIEW', because: 'flagged members trigger an acknowledgement screen before the record opens' },
      ],
      recovery: {
        strategy: 'run_steps',
        maxAttempts: 1,
        backoffMs: 0,
        steps: [{
          id: 'ack_compliance_notice',
          intent: 'Acknowledge the BSA/OFAC review notice so the record opens',
          kind: 'click',
          // Acknowledging a notice is logged by the core against the operator,
          // so it is not a free action even though it changes nothing.
          risk: 'low',
          target: {
            id: 'acknowledge_notice',
            role: 'button',
            name: { value: 'Acknowledge and Continue', match: 'normalized' },
          },
          authoredBy: 'human',
        }],
      },
      exceptStepIds: [],
      capture: [],
    },
    {
      id: 'record_locked',
      title: 'Record in use by another operator',
      kind: 'recoverable',
      detect: [{ kind: 'text_present', regex: 'MSG\\s*0310|IS IN USE BY OPERATOR|RECORD IN USE' }],
      recovery: { strategy: 'wait_and_retry', maxAttempts: 3, backoffMs: 2_000, steps: [] },
      exhaustedOutcomeCode: 'RECORD_LOCKED',
      exceptStepIds: [],
      capture: [{ name: 'lockedBy', regex: 'IN USE BY OPERATOR (\\w+)' }],
    },

    // ── business outcomes ──────────────────────────────────────────────────
    {
      id: 'no_record_found',
      title: 'Search returned no records',
      kind: 'business',
      outcomeCode: 'RECORD_NOT_FOUND',
      detect: [{ kind: 'text_present', regex: 'MSG\\s*0042|NO (?:MEMBER|CUSTOMER) RECORD FOUND' }],
      exceptStepIds: [],
      capture: [],
    },
    {
      id: 'permission_denied',
      title: 'Operator not authorised for this function',
      kind: 'business',
      outcomeCode: 'NOT_AUTHORIZED',
      detect: [{ kind: 'text_present', regex: 'MSG\\s*0451|OPERATOR NOT AUTHORIZED|INSUFFICIENT AUTHORITY' }],
      exceptStepIds: [],
      capture: [{ name: 'authorizationDetail', regex: 'MSG\\s*0451[\\s\\S]{0,20}?([A-Z][\\s\\S]{0,160}?\\.)' }],
    },
    {
      id: 'eod_lockout',
      title: 'Core is in end-of-day processing',
      kind: 'business',
      outcomeCode: 'SYSTEM_UNAVAILABLE_EOD',
      detect: [{ kind: 'text_present', regex: 'MSG\\s*0600|END-OF-DAY PROCESSING' }],
      exceptStepIds: [],
      capture: [],
    },
    {
      id: 'validation_error',
      title: 'The core rejected the submitted values',
      kind: 'business',
      outcomeCode: 'VALIDATION_FAILED',
      detect: [
        { kind: 'text_present', regex: 'MSG\\s*00(07|21|31|74)|MSG\\s*02(12|33|44)|MSG\\s*0455|DATA ERROR|REQUIRED FIELD IS MISSING|MINIMUM OPENING DEPOSIT' },
      ],
      exceptStepIds: [],
      capture: [{ name: 'validationMessage', regex: '(MSG\\s*\\d{4}[\\s\\S]{0,160}?\\.)' }],
    },
  ],
};

const REGISTRY: Record<string, ProductProfile> = { 'meridian-core': MERIDIAN_CORE };

export function getProductProfile(id: string): ProductProfile | undefined { return REGISTRY[id]; }
export function listProductProfiles(): ProductProfile[] { return Object.values(REGISTRY); }
export { MERIDIAN_CORE };
