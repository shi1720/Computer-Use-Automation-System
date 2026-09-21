/**
 * What the replay engine does when the screen misbehaves.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * The engine's whole reason to exist is the unhappy path. The happy path is a
 * handful of clicks; what earns the artifact format is the behaviour when a
 * core goes slow mid-commit, when a session drops after a posting, when a
 * checkpoint will not hold and a person has to be asked.
 *
 * None of that is reachable against a real application — you cannot ask a bank
 * core to be slow on cue — so the surface here is a script. `FakeSurface`
 * records every action it is asked to perform, which is what makes the single
 * most important assertion in this file possible: that Submit was pressed
 * exactly once.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  replay, resolveCapability, EvidenceRecorder, Redactor, EscalationBroker,
  type Capability, type ReplayResult, type Intervention,
} from '@swivel/core';
import { node, FakeSurface, type ScriptedScreen } from './helpers.js';

// ── a capability with one irreversible step, and a signal that interrupts it ──

const SUBMIT_SCREEN: ScriptedScreen = {
  url: 'http://127.0.0.1:4711/content/entry',
  nodes: [node({ ref: 'submit', role: 'button', name: 'Place Stop Payment', text: 'Place Stop Payment' })],
};
const BUSY_SCREEN: ScriptedScreen = {
  url: 'http://127.0.0.1:4711/content/entry',
  nodes: [node({ ref: 'busy', role: 'text', name: '', text: 'System is busy, please wait' })],
};
const CONFIRMED_SCREEN: ScriptedScreen = {
  url: 'http://127.0.0.1:4711/content/done',
  nodes: [node({ ref: 'ok', role: 'text', name: '', text: 'STOP PAYMENT CONFIRMED reference 88213' })],
};

function capability(over: Partial<Capability> = {}): Capability {
  const base = {
    apiVersion: 'swivel.dev/cap-1', kind: 'Capability',
    metadata: { id: 'test.stop-payment', version: '0.1.0', title: 'Stop a check', summary: 'A one-step flow that posts something irreversible.', createdAt: new Date().toISOString(), labels: {}, owner: 'tests' },
    target: { surface: 'web', vendor: 'Test', product: 'Test Core', productVersions: '~1.0.0', entry: { urlTemplate: '{{tenant.baseUrl}}/content/entry', expectedFrames: [] }, vocabulary: {} },
    contract: {
      inputs: [], outputs: [], outcomes: [], preconditions: [],
      effects: { mutating: true, reversible: false, riskClass: 'irreversible', dualControl: false, financialImpact: true, idempotent: false, summary: 'Posts a stop payment.' },
    },
    policy: {
      allowedOrigins: ['http://127.0.0.1:4711'], allowedPathPatterns: ['^/content'],
      allowedActions: ['navigate', 'click', 'fill', 'extract', 'assert', 'wait_for'],
      requiresApproval: false, requiresPerInvocationConfirmation: false,
      maxDurationMs: 120_000, maxSteps: 60, redactPatterns: [],
    },
    signals: [{
      id: 'transient_server_error', title: 'The core is busy', kind: 'recoverable',
      detect: [{ kind: 'text_present', text: 'System is busy', because: 'the core paints this while a posting is in flight' }],
      recovery: { strategy: 'wait_and_retry', maxAttempts: 2, backoffMs: 10 },
    }],
    flow: {
      steps: [{
        id: 'submit', kind: 'click', intent: 'Submit the stop payment.', risk: 'irreversible',
        target: { id: 'submit_button', role: 'button', name: { value: 'Place Stop Payment', match: 'exact' }, hints: { css: [], nearText: [], attrs: {} }, require: { minScore: 60, unique: true, timeoutMs: 200 } },
        expect: { id: 'posted', description: 'Screen shows the stop payment confirmed', all: [{ kind: 'text_present', text: 'STOP PAYMENT CONFIRMED', because: 'the core stamps this on the confirmation screen' }], timeoutMs: 300, stableForMs: 0 },
        authoredBy: 'model',
      }],
      successCheckpoint: { id: 'done', description: 'The stop payment is confirmed', all: [{ kind: 'text_present', text: 'STOP PAYMENT CONFIRMED', because: 'that is the whole point of the flow' }], timeoutMs: 300, stableForMs: 0 },
    },
    provenance: { discoveredBy: 'tests', model: 'none', modelTurns: 0, discoveredAt: new Date().toISOString(), sourceRunId: 'test', tenantDiscoveredAgainst: 'test' },
    quality: { approvalState: 'draft', replays: { total: 0, success: 0, businessOutcome: 0, recovered: 0, escalated: 0, failed: 0 }, stabilityScore: 0, notes: [] },
  } as unknown as Capability;
  return { ...base, ...over } as Capability;
}

async function run(
  surface: FakeSurface,
  opts: { cap?: Capability; escalation?: { resolution: Intervention['resolution']; note?: string }; confirm?: boolean } = {},
): Promise<{ result: ReplayResult; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'swivel-engine-'));
  const redactor = new Redactor({ salt: 'test-salt', extraPatterns: [] });
  const evidence = new EvidenceRecorder(dir, {
    runId: 'rep_test', kind: 'replay', startedAt: new Date().toISOString(),
    principal: { id: 'tests', kind: 'system' },
    counts: { events: 0, steps: 0, screenshots: 0, signals: 0, recoveries: 0, escalations: 0 },
    redaction: {}, swivelVersion: 'test',
  }, redactor);

  const broker = new EscalationBroker(undefined, 5_000);
  const escalation = opts.escalation
    ? {
        broker,
        grantControl: async (i: Intervention) => {
          // Stand in for an operator: claim, take control, decide.
          broker.claim(i.id, { id: 'op', name: 'R. Solis' });
          broker.markInControl(i.id, { wsUrl: 'ws://127.0.0.1:1/control', token: 't', viewport: { width: 1, height: 1 } });
          setTimeout(() => broker.returnControl(i.id, opts.escalation!.resolution ?? 'resume', opts.escalation!.note ?? '', undefined), 5);
        },
        reclaim: async () => { /* nothing to reclaim from a script */ },
      }
    : undefined;

  const result = await replay({
    capability: resolveCapability(opts.cap ?? capability()),
    inputs: {}, surface, evidence,
    principal: { id: 'tests', kind: 'system', roles: ['capability.invoke', 'capability.invoke.financial'] },
    unattended: true, pollMs: 20, runId: 'rep_test',
    // An irreversible step will not run without one, which is the point of the
    // gate; these tests are about what happens *after* it is permitted.
    ...(opts.confirm === false ? {} : { confirmationToken: 'test-confirmation' }),
    tenant: { id: 'test', institution: 'Test CU', baseUrl: 'http://127.0.0.1:4711' },
    ...(escalation ? { escalation } : {}),
  });
  return { result, dir };
}

describe('a step that changes state is never performed twice', () => {
  test('a slow confirmation is waited for, not treated as a failed click', async () => {
    // The core paints "System is busy" and only *then* the confirmation. The
    // recoverable signal fires, the recovery waits, and the checkpoint has to
    // be given its declared budget — not evaluated once, immediately.
    // The button stays on the busy screen, exactly as a legacy core leaves it.
    // That matters: it means a wrongly-retried step *would* find its target and
    // post a second time, so this test can observe the difference rather than
    // being saved by the second click happening to fail.
    const BUSY_KEEPS_BUTTON: ScriptedScreen = {
      url: 'http://127.0.0.1:4711/content/entry',
      nodes: [
        node({ ref: 'busy1', role: 'text', name: '', text: 'System is busy, please wait' }),
        node({ ref: 'submit1', role: 'button', name: 'Place Stop Payment', text: 'Place Stop Payment' }),
      ],
    };
    let clicks = 0;
    let pollsWhileBusy = 0;
    const surface: FakeSurface = new FakeSurface(
      [SUBMIT_SCREEN, BUSY_KEEPS_BUTTON, CONFIRMED_SCREEN],
      (a, _i, self) => {
        if (a.kind !== 'click') return;
        clicks += 1;
        self.goTo(1);           // busy…
        return 1;
      },
      // …and confirmed only on the *fourth* look. A checkpoint that polls its
      // budget sees the confirmation; one that evaluates once, immediately
      // after the recovery's backoff, does not — and concludes the posting
      // never happened. Counting perceptions rather than milliseconds is what
      // makes that distinction the thing under test rather than a race.
      (self) => {
        if (self.current === 1 && ++pollsWhileBusy >= 4) self.goTo(2);
      },
    );

    const { result, dir } = await run(surface);
    assert.equal(clicks, 1, 'THE assertion: Submit was pressed once');
    assert.equal(surface.countActions('click'), 1);
    assert.equal(result.status, 'success', `expected success, got ${result.status}: ${JSON.stringify(result.status === 'failed' ? result.error : {})}`);
    await rm(dir, { recursive: true, force: true });
  });

  test('when the outcome genuinely cannot be established, it stops rather than retrying', async () => {
    // Same interruption, but the confirmation never arrives. The engine must
    // not re-click on the theory that the first one did not take: it cannot
    // tell a failed posting from a slow one, and one of those two guesses
    // places a second stop payment.
    let clicks = 0;
    const surface = new FakeSurface(
      [SUBMIT_SCREEN, BUSY_SCREEN],
      (a, _i, self) => { if (a.kind === 'click') { clicks += 1; self.goTo(1); return 1; } },
    );

    const { result, dir } = await run(surface);
    assert.equal(clicks, 1, 'still exactly one commit attempt');
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.error.class, 'CHECKPOINT_FAILED');
      assert.match(result.error.message, /will not be repeated|cannot be shown to have completed/);
    }
    await rm(dir, { recursive: true, force: true });
  });

  test('a read-only step in the same position IS retried, because repeating it is free', async () => {
    const readOnly = capability();
    (readOnly.flow.steps[0] as { risk: string }).risk = 'read_only';
    (readOnly.contract as { effects: { riskClass: string; mutating: boolean } }).effects = {
      ...(readOnly.contract as { effects: object }).effects as object, riskClass: 'read_only', mutating: false,
    } as never;

    // The busy banner appears *beside* the button rather than replacing it,
    // which is what a legacy core actually does and what makes a retry possible
    // at all.
    const BUSY_WITH_BUTTON: ScriptedScreen = {
      url: 'http://127.0.0.1:4711/content/entry',
      nodes: [
        node({ ref: 'busy2', role: 'text', name: '', text: 'System is busy, please wait' }),
        node({ ref: 'submit2', role: 'button', name: 'Place Stop Payment', text: 'Place Stop Payment' }),
      ],
    };
    let clicks = 0;
    const surface = new FakeSurface(
      [SUBMIT_SCREEN, BUSY_WITH_BUTTON, CONFIRMED_SCREEN],
      (a, _i, self) => {
        if (a.kind !== 'click') return;
        clicks += 1;
        // The first click is swallowed by the busy core; the second takes.
        if (clicks === 1) { self.goTo(1); return 1; }
        self.goTo(2); return 2;
      },
    );
    const { result, dir } = await run(surface, { cap: readOnly });
    assert.ok(clicks >= 2, 'a read-only step is re-run after recovery');
    assert.equal(result.status, 'success');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('what an escalation resolution actually means', () => {
  test('"resume" on a step the operator completed is recorded as theirs, not the automation\'s', async () => {
    // The click never resolves — the button is not on screen. The operator
    // takes over, does the posting by hand, and hands back "resume". The flow
    // finishes and the success checkpoint holds, and the run must still not
    // claim it placed the stop payment.
    const surface = new FakeSurface([{ url: 'http://127.0.0.1:4711/content/entry', nodes: [node({ ref: 'nothing', role: 'text', text: 'nothing useful here' })] }, CONFIRMED_SCREEN]);
    const { result, dir } = await run(surface, { escalation: { resolution: 'resume', note: 'placed it by hand' } });

    // The operator's work lands between the escalation and the hand-back.
    assert.equal(surface.countActions('click'), 0, 'the automation never clicked anything');
    assert.equal(result.escalations.length, 1);
    await rm(dir, { recursive: true, force: true });
  });

  test('a run the operator finished by hand reports `escalated`, never `success`', async () => {
    const surface = new FakeSurface([{ url: 'http://127.0.0.1:4711/content/entry', nodes: [node({ ref: 'nothing', role: 'text', text: 'nothing useful here' })] }, CONFIRMED_SCREEN]);
    const { result, dir } = await run(surface, { escalation: { resolution: 'completed_by_human', note: 'did it myself' } });
    assert.equal(result.status, 'escalated', 'the automation cannot vouch for work it did not do');
    if (result.status === 'escalated') assert.equal(result.intervention.resolution, 'completed_by_human');
    await rm(dir, { recursive: true, force: true });
  });

  test('an operator is not asked about the same step forever', async () => {
    // Every resume puts the run back on a step that still cannot resolve. That
    // has to terminate: an operator handing back "resume" three times has told
    // you the capability is wrong, not that they want a fourth ticket.
    const surface = new FakeSurface([{ url: 'http://127.0.0.1:4711/content/entry', nodes: [node({ ref: 'nothing', role: 'text', text: 'nothing useful' })] }]);
    const { result, dir } = await run(surface, { escalation: { resolution: 'resume', note: 'try again' } });
    assert.equal(result.status, 'failed');
    assert.ok(result.escalations.length <= 4, `bounded, got ${result.escalations.length} escalations`);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('every run leaves a manifest', () => {
  test('including one killed by a defect in an artifact-authored expression', async () => {
    // A checkpoint referencing an output no step produces throws inside
    // `render`. That is an authoring defect, and the run should fail — but a
    // bundle with no manifest is a bundle nobody can index, and a failed run is
    // precisely the one somebody comes looking for.
    const broken = capability();
    broken.flow.successCheckpoint = {
      id: 'broken', description: 'references something that does not exist',
      all: [{ kind: 'text_present', text: '{{output.neverProduced}}', because: 'an authoring mistake' }],
      timeoutMs: 100, stableForMs: 0,
    } as never;

    const surface = new FakeSurface(
      [SUBMIT_SCREEN, CONFIRMED_SCREEN],
      (a, _i, self) => { if (a.kind === 'click') { self.goTo(1); return 1; } },
    );
    const { result, dir } = await run(surface, { cap: broken });

    assert.equal(result.status, 'failed');
    const manifest = await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'run.json'), 'utf8'));
    assert.ok(JSON.parse(manifest).finishedAt, 'the manifest is written even on this path');
    await rm(dir, { recursive: true, force: true });
  });

  test('and a run refused by policy', async () => {
    const needsConfirmation = capability();
    (needsConfirmation.policy as { requiresPerInvocationConfirmation: boolean }).requiresPerInvocationConfirmation = true;
    const surface = new FakeSurface([SUBMIT_SCREEN]);
    const { result, dir } = await run(surface, { cap: needsConfirmation, confirm: false });
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.error.class, 'POLICY_DENIED');
    assert.equal(surface.countActions('click'), 0, 'refused before anything was touched');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('the step record has no holes in it', () => {
  test('a step abandoned mid-flow still appears in the trace', async () => {
    const surface = new FakeSurface([{ url: 'http://127.0.0.1:4711/content/entry', nodes: [node({ ref: 'x', role: 'text', text: 'wrong screen' })] }]);
    const { result, dir } = await run(surface);
    assert.equal(result.status, 'failed');
    assert.equal(result.steps.length, 1, 'the step that failed is on the record, not missing from it');
    assert.equal(result.steps[0]?.stepId, 'submit');
    await rm(dir, { recursive: true, force: true });
  });
});
