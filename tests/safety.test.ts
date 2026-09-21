/**
 * Guardrails, control transfer and evidence integrity.
 *
 * These are the tests that matter most if the system is wrong: a policy hole
 * lets automation act where it was never approved, a lease bug lets a human and
 * a robot type into the same funds-transfer form, and a broken evidence chain
 * means nobody can prove what happened.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PolicyEngine, classifyRisk, ControlLeaseManager, LeasedSurface, LeaseViolation,
  EscalationBroker, EvidenceRecorder, verifyChain, Redactor, stabilityScore, scrubProse, computeContentHash,
  type Capability, type ExecutionContext, type Surface,
} from '@swivel/core';

// A minimal capability, enough for the policy engine to have opinions about.
const cap = (over: Partial<Capability> = {}): Capability => ({
  apiVersion: 'swivel.dev/cap-1', kind: 'Capability',
  metadata: { id: 'c', version: '1.0.0', title: 'T', summary: 'S', createdAt: '', labels: {} },
  target: { surface: 'web', vendor: '', product: '', productVersions: '*', entry: { urlTemplate: '', expectedFrames: [] }, vocabulary: {} },
  contract: {
    inputs: [], outputs: [], outcomes: [],
    effects: { mutating: false, reversible: true, riskClass: 'read_only', dualControl: false, financialImpact: false, idempotent: true },
    preconditions: [],
  },
  policy: {
    allowedOrigins: ['http://127.0.0.1:4711'], allowedPathPatterns: ['^/content'],
    allowedActions: ['click', 'fill'], requiresApproval: true, requiresPerInvocationConfirmation: false,
    maxDurationMs: 60000, maxSteps: 10, redactPatterns: [],
  },
  signals: [], flow: { steps: [{ id: 's', intent: 'i', kind: 'click' }], successCheckpoint: { id: 'd', description: '', all: [{ kind: 'text_present', text: 'x' }], timeoutMs: 1000, stableForMs: 0 } },
  provenance: { discoveredAt: '', discoveredBy: { kind: 'llm_discovery' }, goal: '', swivelVersion: '1.0.0', history: [] },
  quality: { approvalState: 'approved', approvedBy: 'r', replays: { total: 1, success: 1, businessOutcome: 0, recovered: 0, escalated: 0, failed: 0 }, stabilityScore: 80, notes: [] },
  ...over,
});

const ctx = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
  principal: { id: 'agent', kind: 'agent', roles: ['capability.invoke'] },
  unattended: true, startedAt: Date.now(), stepsTaken: 0, ...over,
});

describe('allowlist enforcement', () => {
  test('permits a URL inside the allowlist', () => {
    const p = new PolicyEngine(cap(), ctx());
    assert.equal(p.url('http://127.0.0.1:4711/content/member/1', 'x').allow, true);
  });

  test('refuses another origin, however plausible', () => {
    const p = new PolicyEngine(cap(), ctx());
    const d = p.url('http://127.0.0.1:4712/content/member/1', 'x');
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.code, 'ORIGIN_NOT_ALLOWED');
  });

  test('refuses a path outside the permitted routes of a permitted origin', () => {
    const p = new PolicyEngine(cap(), ctx());
    const d = p.url('http://127.0.0.1:4711/__sim/scenario', 'x');
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.code, 'PATH_NOT_ALLOWED');
  });

  test('refuses a non-http protocol', () => {
    const p = new PolicyEngine(cap(), ctx());
    assert.equal(p.url('file:///etc/passwd', 'x').allow, false);
  });

  test('records both permits and refusals — what was not done is also evidence', () => {
    const p = new PolicyEngine(cap(), ctx());
    p.url('http://127.0.0.1:4711/content/a', 'x');
    p.url('http://evil.example/', 'y');
    assert.equal(p.events.length, 2);
    assert.deepEqual(p.events.map((e) => e.decision), ['allow', 'deny']);
  });
});

describe('approval and confirmation gating', () => {
  test('a draft capability cannot be invoked unattended', () => {
    const c = cap();
    c.quality.approvalState = 'draft';
    const d = new PolicyEngine(c, ctx()).admit();
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.code, 'APPROVAL_REQUIRED');
  });

  test('a draft capability can still be run attended, by a person watching', () => {
    const c = cap();
    c.quality.approvalState = 'draft';
    assert.equal(new PolicyEngine(c, ctx({ unattended: false })).admit().allow, true);
  });

  test('an approval is of a document, not of a name', () => {
    // A reviewer signs off on specific steps, targets and policy. Editing any
    // of them afterwards and keeping the approval would make the review a
    // formality — the thing running unattended would be a document nobody read.
    // Binding approval to the content hash is what stops that, and it has to
    // hold in both directions: the unchanged capability still runs.
    const approved = cap();
    approved.quality.approvalState = 'approved';
    approved.quality.approvedBy = 'reviewer';
    approved.quality.approvedContentHash = computeContentHash(approved);
    assert.equal(new PolicyEngine(approved, ctx()).admit().allow, true);

    const edited = JSON.parse(JSON.stringify(approved)) as Capability;
    edited.policy.allowedOrigins = [...edited.policy.allowedOrigins, 'http://somewhere-else.invalid'];
    const d = new PolicyEngine(edited, ctx()).admit();
    assert.equal(d.allow, false, 'widening the origin allowlist after sign-off must void it');
    if (!d.allow) assert.equal(d.code, 'APPROVAL_STALE');
  });

  test('replay statistics do not void an approval', () => {
    // The content hash deliberately covers the behaviour-determining subset
    // only. If every completed run invalidated the approval, the gate would
    // fire constantly and be routed around within a week.
    const approved = cap();
    approved.quality.approvalState = 'approved';
    approved.quality.approvedContentHash = computeContentHash(approved);
    approved.quality.replays = { total: 9, success: 9, businessOutcome: 0, recovered: 0, escalated: 0, failed: 0 };
    approved.quality.stabilityScore = 93;
    assert.equal(new PolicyEngine(approved, ctx()).admit().allow, true);
  });

  test('an irreversible capability refuses to start without a confirmation token', () => {
    const c = cap();
    c.policy.requiresPerInvocationConfirmation = true;
    const d = new PolicyEngine(c, ctx()).admit();
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.code, 'CONFIRMATION_REQUIRED');
  });

  test('an irreversible step refuses even if the capability was admitted', () => {
    const p = new PolicyEngine(cap(), ctx());
    const d = p.step({ id: 's', intent: 'Place the stop payment', kind: 'click', risk: 'irreversible' });
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.code, 'IRREVERSIBLE_WITHOUT_CONFIRMATION');
  });

  test('a fee-bearing capability requires a principal role an agent cannot self-assign', () => {
    const c = cap();
    c.contract.effects.financialImpact = true;
    const d = new PolicyEngine(c, ctx()).admit();
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.code, 'INSUFFICIENT_PRINCIPAL_ROLE');
  });

  test('budgets are enforced, so a malfunctioning flow cannot loop on a core', () => {
    const p = new PolicyEngine(cap(), ctx({ stepsTaken: 10 }));
    const d = p.step({ id: 's', intent: 'i', kind: 'click' });
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.code, 'STEP_BUDGET_EXCEEDED');
  });

  test('discovery cannot be talked into a high-risk action', () => {
    const p = new PolicyEngine(cap(), ctx({ unattended: false }));
    const d = p.discoveryAction('click', undefined, 'irreversible', 'turn3');
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.code, 'RISKY_ACTION_BLOCKED_IN_DISCOVERY');
  });
});

describe('risk classification', () => {
  test('typing is free — state changes when something is submitted', () => {
    assert.equal(classifyRisk('fill', 'Member #', ''), 'read_only');
  });

  test('a control in a GET form is running a query', () => {
    assert.equal(classifyRisk('click', 'Search', 'member search', { role: 'button', formMethod: 'get' }), 'read_only');
  });

  test('a control in a POST form is running a transaction', () => {
    assert.equal(classifyRisk('click', 'Continue', 'some screen', { role: 'button', formMethod: 'post' }), 'medium');
  });

  test('a submit that places a stop payment is irreversible', () => {
    assert.equal(classifyRisk('click', 'Place Stop Payment', '', { role: 'button', formMethod: 'post', inputType: 'submit' }), 'irreversible');
  });

  test('a menu link named after a risky action is still just navigation', () => {
    // Opening the Stop Payment screen does not place a stop payment. Demanding
    // a confirmation token to open a form teaches people to supply them
    // reflexively, which is how the control stops meaning anything.
    assert.equal(classifyRisk('click', 'Stop Payment', '', { role: 'link', href: '/content/stop-payment' }), 'read_only');
    // And with no href signal at all: absence of information is not evidence
    // of a postback, and navigation is what a link overwhelmingly is.
    assert.equal(classifyRisk('click', 'Stop Payment', '', { role: 'link' }), 'read_only');
  });

  test('a scripted navigation button is not a transaction either', () => {
    assert.equal(classifyRisk('click', 'Stop Payment', '', { role: 'button', inputType: 'button' }), 'read_only');
  });

  test("the application's own warning outranks the label", () => {
    const page = 'IRREVERSIBLE — FEE BEARING. A $32.00 fee will be assessed immediately.';
    assert.equal(classifyRisk('click', 'Submit', page, { role: 'button', formMethod: 'post' }), 'irreversible');
  });

  test('following a link is navigation', () => {
    assert.equal(classifyRisk('click', 'Member Search', '', { role: 'link' }), 'read_only');
  });
});

describe('the control lease keeps exactly one actor on the wheel', () => {
  test('a second actor cannot simply acquire control', () => {
    const l = new ControlLeaseManager();
    l.acquire('automation', 'swivel', 'replay');
    assert.throws(() => l.acquire('operator', 'r.solis', 'takeover'), LeaseViolation);
  });

  test('transfer is the only way control changes hands, and it is recorded', () => {
    const l = new ControlLeaseManager();
    l.acquire('automation', 'swivel', 'replay');
    l.transfer('operator', 'r.solis', 'intervention int_1');
    assert.equal(l.holder, 'operator');
    assert.deepEqual(l.history.map((t) => t.to), ['automation', 'operator']);
  });

  test('a lapsed lease releases itself rather than stranding the session', () => {
    const l = new ControlLeaseManager();
    l.acquire('operator', 'r.solis', 'takeover', 1);
    assert.equal(l.holder, 'operator');
    const until = Date.now() + 8;
    while (Date.now() < until) { /* spin briefly past the TTL */ }
    assert.equal(l.holder, 'none');
  });

  test('a surface refuses to act for anyone but the lease holder', async () => {
    const acted: string[] = [];
    const inner = {
      id: 'x', kind: 'web' as const,
      snapshot: async () => ({ id: 's', at: '', url: '', title: '', nodes: [], frameTexts: {}, frames: [], captureMs: 0 }),
      act: async (a: { kind: string }) => { acted.push(a.kind); },
      currentUrl: async () => '', screenshot: async () => Buffer.alloc(0), close: async () => {},
    } satisfies Surface;

    const leases = new ControlLeaseManager();
    const lease = leases.acquire('automation', 'swivel', 'replay');
    const surface = new LeasedSurface(inner, leases, () => lease.id);

    await surface.act({ kind: 'click', ref: 'r' });
    assert.deepEqual(acted, ['click']);

    // A human takes over mid-run. The automation must go quiet immediately.
    leases.transfer('operator', 'r.solis', 'intervention');
    await assert.rejects(() => surface.act({ kind: 'click', ref: 'r' }), LeaseViolation);
    assert.deepEqual(acted, ['click'], 'no second action reached the browser');

    // Observation stays open to everyone — watching is safe, acting is not.
    await surface.snapshot();
  });
});

describe('escalation protocol', () => {
  const context = {
    runId: 'r1', kind: 'replay' as const,
    diagnosis: { code: 'TARGET_NOT_FOUND', message: 'could not find the View link' },
    url: 'http://127.0.0.1:4711/content/member-results',
  };

  test('a ticket moves open → claimed → in control → returned', async () => {
    const b = new EscalationBroker();
    const i = await b.raise('target_unresolvable', context);
    assert.equal(i.status, 'open');
    b.claim(i.id, { id: 'operator', name: 'R. Solis' });
    assert.equal(b.get(i.id)?.status, 'claimed');
    b.markInControl(i.id, { wsUrl: 'ws://x', token: 't', viewport: { width: 1, height: 1 } });
    assert.equal(b.get(i.id)?.status, 'in_control');
    b.returnControl(i.id, 'resume', 'cleared the interstitial by hand');
    assert.equal(b.get(i.id)?.status, 'returned');
  });

  test('the run waits on the ticket and resumes on the human decision', async () => {
    const b = new EscalationBroker();
    const i = await b.raise('checkpoint_failed', context);
    const waiting = b.waitForResolution(i.id, 2000);
    b.claim(i.id, { id: 'operator', name: 'R. Solis' });
    b.returnControl(i.id, 'completed_by_human', 'posted it manually');
    const resolved = await waiting;
    assert.equal(resolved.resolution, 'completed_by_human');
  });

  test('a ticket nobody takes expires instead of hanging the run forever', async () => {
    const b = new EscalationBroker(undefined, 30);
    const i = await b.raise('discovery_stuck', context);
    const resolved = await b.waitForResolution(i.id, 30);
    assert.equal(resolved.status, 'expired');
  });

  test('keystrokes are coalesced into the value the operator actually typed', async () => {
    const b = new EscalationBroker();
    const i = await b.raise('target_unresolvable', context);
    for (const ch of '0100482') b.recordHumanAction(i.id, { at: new Date().toISOString(), kind: 'type', detail: ch });
    const actions = b.get(i.id)?.humanActions ?? [];
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.detail, '0100482');
  });
});

describe('evidence integrity', () => {
  test('a chain of events verifies, and any edit to it is detected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swivel-ev-'));
    const rec = new EvidenceRecorder(dir, {
      runId: 'r', kind: 'replay', startedAt: new Date().toISOString(),
      principal: { id: 'test', kind: 'system' }, counts: { events: 0, steps: 0, screenshots: 0, signals: 0, recoveries: 0, escalations: 0 },
      redaction: {}, swivelVersion: '1.0.0',
    }, new Redactor({ salt: 's' }));

    await rec.log('run.started', 'begin');
    await rec.log('step.acted', 'clicked the View link');
    await rec.log('run.finished', 'done');
    // `finish()` writes the manifest, which pins the chain's final digest.
    // Verification is not just "these events link up" but "these events are all
    // of them", and the second half of that lives in run.json.
    await rec.finish({ status: 'success' });
    assert.equal((await verifyChain(dir)).ok, true);

    // Someone edits the record to hide what happened.
    const path = join(dir, 'events.jsonl');
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[1] as string) as { message: string };
    tampered.message = 'clicked Cancel';
    lines[1] = JSON.stringify(tampered);
    await writeFile(path, `${lines.join('\n')}\n`);

    const v = await verifyChain(dir);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 2);
    assert.match(v.message, /modified since it was written/);
  });

  test('removing an event breaks the chain too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swivel-ev-'));
    const rec = new EvidenceRecorder(dir, {
      runId: 'r', kind: 'replay', startedAt: new Date().toISOString(),
      principal: { id: 'test', kind: 'system' }, counts: { events: 0, steps: 0, screenshots: 0, signals: 0, recoveries: 0, escalations: 0 },
      redaction: {}, swivelVersion: '1.0.0',
    }, new Redactor({ salt: 's' }));
    await rec.log('run.started', 'a');
    await rec.log('step.acted', 'b');
    await rec.log('run.finished', 'c');
    await rec.finish({ status: 'success' });

    const path = join(dir, 'events.jsonl');
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    await writeFile(path, `${[lines[0], lines[2]].join('\n')}\n`);
    assert.equal((await verifyChain(dir)).ok, false);
  });

  test('truncating the log is caught, which walking it forward cannot do', async () => {
    // The easiest tampering, and the most useful: delete everything after the
    // event you would rather nobody read. What remains is a valid chain — each
    // event still names its predecessor — so a forward walk reports it intact.
    // The manifest's recorded tip is what makes that a lie you cannot tell.
    const dir = await mkdtemp(join(tmpdir(), 'swivel-ev-'));
    const rec = new EvidenceRecorder(dir, {
      runId: 'r', kind: 'replay', startedAt: new Date().toISOString(),
      principal: { id: 'test', kind: 'system' }, counts: { events: 0, steps: 0, screenshots: 0, signals: 0, recoveries: 0, escalations: 0 },
      redaction: {}, swivelVersion: '1.0.0',
    }, new Redactor({ salt: 's' }));
    await rec.log('run.started', 'a');
    await rec.log('step.acted', 'placed a stop payment');
    await rec.log('step.failed', 'the part somebody would rather hide');
    await rec.log('run.finished', 'c');
    await rec.finish({ status: 'failed' });
    assert.equal((await verifyChain(dir)).ok, true);

    const path = join(dir, 'events.jsonl');
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    await writeFile(path, `${lines.slice(0, 2).join('\n')}\n`);

    const v = await verifyChain(dir);
    assert.equal(v.ok, false, 'a truncated chain is not an intact chain');
    assert.match(v.message, /incomplete|removed from the end/);
  });

  test('sensitive values never reach the log in the first place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swivel-ev-'));
    const rec = new EvidenceRecorder(dir, {
      runId: 'r', kind: 'replay', startedAt: new Date().toISOString(),
      principal: { id: 'test', kind: 'system' }, counts: { events: 0, steps: 0, screenshots: 0, signals: 0, recoveries: 0, escalations: 0 },
      redaction: {}, swivelVersion: '1.0.0',
    }, new Redactor({ salt: 's' }));
    await rec.log('note', 'member SSN 123-45-6789 was displayed', { email: 'a.b@example.invalid' });
    const written = await readFile(join(dir, 'events.jsonl'), 'utf8');
    assert.ok(!written.includes('123-45-6789'));
    assert.ok(!written.includes('a.b@example.invalid'));
  });
});

describe('confidence scoring', () => {
  const R = (o: Partial<Capability['quality']['replays']> = {}) =>
    ({ total: 0, success: 0, businessOutcome: 0, recovered: 0, escalated: 0, failed: 0, ...o });

  test('a single green run does not buy full confidence', () => {
    assert.ok(stabilityScore(R({ total: 1, success: 1 }), 100) < 80);
  });

  test('a consistent history does', () => {
    assert.ok(stabilityScore(R({ total: 10, success: 10 }), 100) > 90);
  });

  test('business outcomes count as the automation working', () => {
    const clean = stabilityScore(R({ total: 10, success: 10 }), 100);
    const mixed = stabilityScore(R({ total: 10, success: 6, businessOutcome: 4 }), 100);
    assert.equal(clean, mixed);
  });

  test('failures cost more than they are worth', () => {
    assert.ok(stabilityScore(R({ total: 10, success: 8, failed: 2 }), 100) < stabilityScore(R({ total: 10, success: 10 }), 100) - 15);
  });

  test('weak targeting drags the score down even with a clean history', () => {
    // The point of measuring this: a capability resolving its controls at 58
    // is fragile before it has ever failed.
    assert.ok(stabilityScore(R({ total: 10, success: 10 }), 58) < stabilityScore(R({ total: 10, success: 10 }), 100));
  });
});

describe('capability prose never carries one run\'s data', () => {
  // The summary is published in the artifact, served to every calling agent
  // through the tool catalogue, and shared across every institution that
  // adopts the capability. A model narrating what it just saw will put a
  // member's name and balance in it unless something stops it.
  //
  // This exercises the scrubber the discovery loop actually calls. An earlier
  // version of this file defined its own copy and tested that, which meant
  // these tests would have passed with the real one deleted — and the real one
  // had defects the copy did not.
  const forbidden = ['0100482', 'WHITFIELD, DOLORES', '18,402.66', 'SPECIAL SAVINGS'];

  test('drops a sentence naming the member the run happened to use', () => {
    assert.equal(
      scrubProse('Looks up a member and reads their savings balance. For member 0100482 the balance was 18,402.66.', forbidden),
      'Looks up a member and reads their savings balance.',
    );
  });

  test('matches regardless of case, because the screen shouts and the prose does not', () => {
    // The core renders `WHITFIELD, DOLORES`. A case-sensitive substring test
    // finds nothing in "Whitfield, Dolores" and the name ships in the artifact.
    assert.equal(scrubProse('Reads a balance. Verified against Whitfield, Dolores.', forbidden), 'Reads a balance.');
  });

  test('catches a name the model reordered into natural word order', () => {
    // `WHITFIELD, DOLORES` on screen becomes "Dolores Whitfield" in prose
    // without being asked. No substring of the forbidden value appears at all.
    assert.equal(
      scrubProse('Reads a share balance. During discovery this returned Dolores Whitfield\'s account.', forbidden),
      'Reads a share balance.',
    );
  });

  test('drops any sentence containing a currency amount, declared or not', () => {
    // Independent of the forbidden list: a paraphrased balance appears verbatim
    // in no node on the screen, and is still this run's data.
    assert.equal(scrubProse('Reads a balance. It returned about 1,015.44 today.', []), 'Reads a balance.');
  });

  test('a caveat list with no full stops does not take the whole summary out', () => {
    // Prose with no sentence terminator used to be one enormous "sentence", so
    // a single leak anywhere in it removed everything. That fails safe, and
    // silently, and the surviving content was worth keeping.
    const out = scrubProse('Requires an active session\nMember 0100482 was used in discovery\nThe share must exist', forbidden);
    assert.ok(out?.includes('Requires an active session'));
    assert.ok(out?.includes('The share must exist'));
    assert.ok(!out?.includes('0100482'));
  });

  test('keeps prose that describes the capability rather than the run', () => {
    const prose = 'Looks up a member by member number and reads the balance of a named share product.';
    assert.equal(scrubProse(prose, forbidden), prose);
  });

  test('returns undefined rather than an empty string when nothing survives', () => {
    // So the caller falls back to something written, rather than shipping a
    // capability whose summary is "".
    assert.equal(scrubProse('Member 0100482 had 18,402.66.', forbidden), undefined);
  });
});

describe('what a capability says it does', () => {
  // Everything the safety model gates on is derived from these two predicates.
  // A wrong answer here is not a mislabelling; it is an unattended invocation
  // with no confirmation token.

  test('a link that posts is not read-only just because it is a link', () => {
    // In WebForms a grid action link is `javascript:__doPostBack(...)`: the
    // role of a link, the effect of a submit. Recording it as read_only also
    // means replay never marks the flow as having committed, which is what
    // lets a session-expiry recovery replay a flow that already posted.
    assert.equal(classifyRisk('click', 'Place Stop Payment', '', { role: 'link', href: 'javascript:__doPostBack(\'ctl00$Main$grd\',\'\')' }), 'irreversible');
    // A real menu link still opens a screen and still costs nothing.
    assert.equal(classifyRisk('click', 'Stop Payment', '', { role: 'link', href: '/content/stop-payment' }), 'read_only');
  });

  test('a GET that commits is not read-only just because it is a GET', () => {
    assert.equal(classifyRisk('navigate', undefined, '', { url: 'http://core/content/fee-reversal?confirm=1' }), 'medium');
    assert.equal(classifyRisk('navigate', undefined, '', { url: 'http://core/content/member-inquiry?id=1' }), 'read_only');
  });

  test('Enter inside a form is a submit', () => {
    assert.equal(classifyRisk('press', 'Post Transfer', '', { key: 'Enter', formMethod: 'post' }), 'high');
    assert.equal(classifyRisk('press', 'Member #', '', { key: 'Tab', formMethod: 'post' }), 'read_only');
  });
});
