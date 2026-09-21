/**
 * The artifact schema, its validator, and the tenant-overlay merge.
 *
 * The validator is the automated half of a bank's change review, so these tests
 * are mostly about what it *refuses*.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCapability, validateOverlay, resolveCapability, computeContentHash,
  render, referencesOf, TemplateError, API_VERSION, generaliseOutputName,
  type Capability, type TenantOverlay,
} from '@swivel/core';

function baseCapability(over: Partial<Capability> = {}): Capability {
  const cap: Capability = {
    apiVersion: API_VERSION, kind: 'Capability',
    metadata: { id: 'meridian.test', version: '1.0.0', title: 'Test', summary: 'A test capability', createdAt: '2026-09-21T00:00:00Z', labels: {} },
    target: {
      surface: 'web', vendor: 'Meridian', product: 'MERIDIAN Core', productVersions: '*',
      entry: { urlTemplate: '{{tenant.baseUrl}}/main', expectedFrames: [] },
      vocabulary: { memberNumber: 'Member #' },
    },
    contract: {
      inputs: [{ name: 'memberNumber', type: 'string', description: 'member', required: true }],
      outputs: [{ name: 'balance', type: 'money', description: 'balance' }],
      outcomes: [{ code: 'RECORD_NOT_FOUND', kind: 'business', description: 'no such member', retryable: false }],
      effects: { mutating: false, reversible: true, riskClass: 'read_only', dualControl: false, financialImpact: false, idempotent: true },
      preconditions: [],
    },
    policy: {
      allowedOrigins: ['http://127.0.0.1:4711'], allowedPathPatterns: ['^/content'],
      allowedActions: ['navigate', 'click', 'fill', 'extract'],
      requiresApproval: true, requiresPerInvocationConfirmation: false,
      maxDurationMs: 120000, maxSteps: 60, redactPatterns: [],
    },
    signals: [{
      id: 'no_record', title: 'No record', kind: 'business', outcomeCode: 'RECORD_NOT_FOUND',
      detect: [{ kind: 'text_present', regex: 'MSG 0042' }], exceptStepIds: [], capture: [],
    }],
    flow: {
      steps: [
        { id: 'fill_member', intent: 'Type the member number', kind: 'fill', value: '{{input.memberNumber}}', risk: 'read_only',
          target: { id: 'member_no', role: 'textbox', anchors: [{ relation: 'right-of', text: { value: '{{vocab.memberNumber}}' } }] } },
        { id: 'read_balance', intent: 'Read the balance', kind: 'extract', risk: 'read_only',
          target: { id: 'balance_cell', role: 'cell', cell: { columnHeader: { value: 'Balance' } } },
          extract: { into: 'balance', source: 'text', transform: 'money_to_number' } },
      ],
      successCheckpoint: { id: 'done', description: 'On the inquiry screen', all: [{ kind: 'text_present', regex: 'SCREEN INQ-0420' }], timeoutMs: 15000, stableForMs: 0 },
    },
    provenance: { discoveredAt: '2026-09-21T00:00:00Z', discoveredBy: { kind: 'llm_discovery' }, goal: 'test', swivelVersion: '1.0.0', history: [] },
    quality: { approvalState: 'draft', replays: { total: 0, success: 0, businessOutcome: 0, recovered: 0, escalated: 0, failed: 0 }, stabilityScore: 0, notes: [] },
  };
  return { ...cap, ...over };
}

const errors = (c: Capability) => validateCapability(c).filter((f) => f.severity === 'error').map((f) => f.code);

describe('validation refuses artifacts that are unsafe to approve', () => {
  test('a well-formed capability passes', () => {
    assert.deepEqual(errors(baseCapability()), []);
  });

  test('refuses a state-changing step with no checkpoint', () => {
    const c = baseCapability();
    c.flow.steps.push({ id: 'submit', intent: 'Submit the form', kind: 'click', risk: 'high', target: { id: 'submit_btn', role: 'button', name: { value: 'Submit' } } });
    assert.ok(errors(c).includes('MUTATING_STEP_WITHOUT_CHECKPOINT'));
  });

  test('refuses an extraction that writes to an undeclared output', () => {
    const c = baseCapability();
    (c.flow.steps[1] as { extract: { into: string } }).extract.into = 'notDeclared';
    assert.ok(errors(c).includes('EXTRACT_UNDECLARED_OUTPUT'));
  });

  test('refuses a template reference to an input that does not exist', () => {
    const c = baseCapability();
    (c.flow.steps[0] as { value: string }).value = '{{input.memberNo}}';
    assert.ok(errors(c).includes('UNKNOWN_INPUT_REF'));
  });

  test('refuses an empty origin allowlist', () => {
    const c = baseCapability();
    c.policy.allowedOrigins = [];
    assert.ok(errors(c).includes('EMPTY_ALLOWLIST'));
  });

  test('refuses a flow using an action its own policy forbids', () => {
    const c = baseCapability();
    c.flow.steps.push({ id: 'press_enter', intent: 'Press enter', kind: 'press', key: 'Enter', risk: 'read_only' });
    assert.ok(errors(c).includes('ACTION_NOT_ALLOWED'));
  });

  test('refuses a business signal returning an outcome the contract never declared', () => {
    const c = baseCapability();
    c.signals[0]!.outcomeCode = 'SOMETHING_ELSE';
    assert.ok(errors(c).includes('UNDECLARED_OUTCOME'));
  });

  test('refuses a capability that is mutating but labelled read-only', () => {
    const c = baseCapability();
    c.contract.effects.mutating = true;
    assert.ok(errors(c).includes('RISK_MISLABELLED'));
  });

  test('warns when a target is identified only by selector-level hints', () => {
    const c = baseCapability();
    c.flow.steps[0]!.target = { id: 'weak', role: 'textbox', hints: { idPattern: 'ctl\\d+_txt' } };
    const codes = validateCapability(c).map((f) => f.code);
    assert.ok(codes.includes('SELECTOR_ONLY_TARGET'));
  });
});

describe('content hashing separates behaviour from statistics', () => {
  test('replay statistics do not change the hash', () => {
    const a = baseCapability();
    const b = baseCapability();
    b.quality = { ...b.quality, replays: { ...b.quality.replays, total: 9, success: 9 }, stabilityScore: 91 };
    assert.equal(computeContentHash(a), computeContentHash(b));
  });

  test('changing a step does change the hash', () => {
    const a = baseCapability();
    const b = baseCapability();
    b.flow.steps[0]!.value = '{{input.memberNumber}} ';
    assert.notEqual(computeContentHash(a), computeContentHash(b));
  });

  test('key order does not change the hash', () => {
    // Two documents that differ only in the order their keys were written must
    // hash identically, or a reformatting tool silently revokes every approval.
    const shuffle = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(shuffle);
      if (v && typeof v === 'object') {
        const entries = Object.entries(v as Record<string, unknown>).reverse();
        return Object.fromEntries(entries.map(([k, x]) => [k, shuffle(x)]));
      }
      return v;
    };
    assert.equal(computeContentHash(baseCapability()), computeContentHash(shuffle(baseCapability()) as Capability));
  });
});

describe('tenant overlays specialise rather than fork', () => {
  const overlay: TenantOverlay = {
    apiVersion: API_VERSION, kind: 'TenantOverlay',
    metadata: { id: 'meridian.test--harborpoint', tenantId: 'harborpoint', institution: 'Harbor Point Savings Bank', createdAt: '2026-09-21T00:00:00Z', capabilityId: 'meridian.test', capabilityVersions: '*', notes: [] },
    tenant: { baseUrl: 'http://127.0.0.1:4712', productVersion: '10.1.3' },
    vocabulary: { memberNumber: 'Customer ID' },
    targetOverrides: {},
    extraSignals: [{ id: 'local_ack', title: 'Annual acknowledgement', kind: 'recoverable', detect: [{ kind: 'text_present', text: 'I Acknowledge' }], recovery: { strategy: 'wait_and_retry', maxAttempts: 1, backoffMs: 0, steps: [] }, exceptStepIds: [], capture: [] }],
    stepPatches: [],
  };

  test('tenant vocabulary overrides the product default', () => {
    const r = resolveCapability(baseCapability(), overlay);
    assert.equal(r.target.vocabulary.memberNumber, 'Customer ID');
  });

  test('tenant signals are added, never able to remove a base signal', () => {
    const r = resolveCapability(baseCapability(), overlay);
    assert.equal(r.signals.length, 2);
    assert.ok(r.signals.some((s) => s.id === 'no_record'), 'the base safety signal survives');
  });

  test('the tenant origin joins the allowlist', () => {
    const r = resolveCapability(baseCapability(), overlay);
    assert.ok(r.policy.allowedOrigins.includes('http://127.0.0.1:4712'));
  });

  test('a tenant cannot widen the action allowlist', () => {
    const wide = { ...overlay, policyOverrides: { allowedActions: ['navigate', 'click', 'fill', 'extract', 'press'] as never } };
    const r = resolveCapability(baseCapability(), wide);
    assert.ok(!r.policy.allowedActions.includes('press' as never));
  });

  test('a step patch inserts a tenant-only step and marks its provenance', () => {
    const patched: TenantOverlay = {
      ...overlay,
      stepPatches: [{ op: 'insert-before', stepId: 'fill_member', reason: 'Harbor Point interposes a compliance acknowledgement',
        step: { id: 'ack', intent: 'Acknowledge the annual policy', kind: 'click', risk: 'read_only', optional: true, target: { id: 'ack_btn', role: 'button', name: { value: 'I Acknowledge' } } } }],
    };
    const r = resolveCapability(baseCapability(), patched);
    assert.equal(r.flow.steps[0]!.id, 'ack');
    assert.equal(r.flow.steps[0]!.authoredBy, 'overlay');
    assert.equal(r.flow.steps.length, 3);
  });

  test('records what it was resolved from, so a run is traceable to a base version', () => {
    const r = resolveCapability(baseCapability(), overlay);
    assert.equal(r.resolvedFor?.tenantId, 'harborpoint');
    assert.equal(r.resolvedFor?.baseContentHash, computeContentHash(baseCapability()));
  });

  test('flags an overlay that has diverged far enough to deserve its own capability', () => {
    const heavy: TenantOverlay = {
      ...overlay,
      stepPatches: [
        { op: 'skip', stepId: 'fill_member', reason: 'x' },
        { op: 'skip', stepId: 'read_balance', reason: 'y' },
      ],
    };
    const codes = validateOverlay(heavy, baseCapability()).map((f) => f.code);
    assert.ok(codes.includes('OVERLAY_TOO_DIVERGENT'));
  });

  test('rejects an overlay pointed at a step that does not exist', () => {
    const wrong: TenantOverlay = { ...overlay, stepPatches: [{ op: 'skip', stepId: 'nope', reason: 'x' }] };
    const codes = validateOverlay(wrong, baseCapability()).map((f) => f.code);
    assert.ok(codes.includes('OVERLAY_UNKNOWN_STEP'));
  });
});

describe('templating', () => {
  const ctx = { input: { memberNumber: '0100482' }, output: {}, vocab: { memberNumber: 'Member #' }, tenant: { baseUrl: 'http://x' }, run: {} };

  test('substitutes across namespaces', () => {
    assert.equal(render('{{tenant.baseUrl}}/member/{{input.memberNumber}}', ctx), 'http://x/member/0100482');
  });

  test('throws rather than substituting an empty string for a missing value', () => {
    // Silently rendering "" would search for nothing and return every member.
    assert.throws(() => render('{{output.notYet}}', ctx), TemplateError);
  });

  test('reports its references, which is what the validator checks', () => {
    assert.deepEqual(referencesOf('{{input.a}}/{{vocab.b}}'), [{ ns: 'input', path: 'a' }, { ns: 'vocab', path: 'b' }]);
  });
});

describe('vocabulary substitution generalises across institutions', () => {
  const ctx = { parameters: { memberNumber: '0100482' }, vocabulary: { member: 'Member', memberNumber: 'Member #' }, baseUrl: 'http://x', usedIds: new Set<string>() };

  test('a caption that IS a vocabulary term becomes a reference', async () => {
    const { templatise } = await import('@swivel/core');
    assert.equal(templatise('Member #', ctx), '{{vocab.memberNumber}}');
  });

  test('a phrase containing a vocabulary term is left alone by default', async () => {
    const { templatise } = await import('@swivel/core');
    assert.equal(templatise('MEMBER INQUIRY', ctx), 'MEMBER INQUIRY');
  });

  test('checkpoint text substitutes vocabulary at word level, case-insensitively', async () => {
    const { templatise } = await import('@swivel/core');
    assert.equal(templatise('MEMBER INQUIRY', ctx, { vocabWords: true }), '{{vocab.member}} INQUIRY');
  });

  test('parameter values are substituted before vocabulary, longest first', async () => {
    const { templatise } = await import('@swivel/core');
    assert.equal(templatise('0100482', ctx), '{{input.memberNumber}}');
  });

  test('it does not substitute inside words', async () => {
    const { templatise } = await import('@swivel/core');
    assert.equal(templatise('MEMBERSHIP', ctx, { vocabWords: true }), 'MEMBERSHIP');
  });
});

describe('run-varying data never becomes a target identity', () => {
  test('recognises the values a legacy core paints on every screen', async () => {
    const { looksLikeData } = await import('@swivel/core');
    for (const v of [
      '18,402.66', '(1,204.55)', '0.850%', '25,000.00',   // money and rates
      '2026-09-21', '09/21/2026',                          // dates
      '0100482', '0100482-01',                             // account identifiers
      '***-**-4417',                                       // masked identifiers
      'SP-3028287', 'FM-0091284', 'REV-88410', 'T-5500121', 'OFAC-2026-0917',
    ]) {
      assert.equal(looksLikeData(v), true, `expected "${v}" to be treated as data`);
    }
  });

  test('leaves the application\'s own vocabulary alone', async () => {
    const { looksLikeData } = await import('@swivel/core');
    for (const v of [
      'Member #', 'Share Accounts', 'Search', 'View', 'Sign On',
      'SPECIAL SAVINGS', 'SCREEN INQ-0420', 'Confirmation Number', 'Acknowledge and Continue',
    ]) {
      assert.equal(looksLikeData(v), false, `expected "${v}" to be usable as identity`);
    }
  });
});

describe('an output name describes the field, not the invocation', () => {
  const ctx = (params: Record<string, string>) =>
    ({ parameters: params, vocabulary: {}, baseUrl: 'http://x', usedIds: new Set<string>() }) as never;

  test('strips a parameter value the model folded into the name', () => {
    // Invoke the same artifact with REGULAR SHARE and the caller gets a field
    // called `specialSavingsBalance` holding a regular share's balance. It is
    // the same defect as a target pinned to one record, in the part of the
    // artifact a calling agent reads.
    assert.equal(generaliseOutputName('specialSavingsBalance', ctx({ shareType: 'SPECIAL SAVINGS' })), 'balance');
    assert.equal(generaliseOutputName('specialSavingsAvailable', ctx({ shareType: 'SPECIAL SAVINGS' })), 'available');
  });

  test('leaves a name that describes the field alone', () => {
    assert.equal(generaliseOutputName('confirmationNumber', ctx({ checkNumber: '1042' })), 'confirmationNumber');
    assert.equal(generaliseOutputName('currentBalance', ctx({ shareType: 'SPECIAL SAVINGS' })), 'currentBalance');
  });

  test('a partial word overlap is a coincidence of vocabulary, not a leak', () => {
    // "share" appears in both "SHARE DRAFT" and "shareBalance" without the
    // parameter having leaked anywhere.
    assert.equal(generaliseOutputName('shareBalance', ctx({ shareType: 'SHARE DRAFT' })), 'shareBalance');
  });

  test('keeps the model\'s name rather than returning an empty one', () => {
    assert.equal(generaliseOutputName('specialSavings', ctx({ shareType: 'SPECIAL SAVINGS' })), 'specialSavings');
  });
});
