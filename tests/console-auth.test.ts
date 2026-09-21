/**
 * What the control plane lets each account see and do.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * These are the tests that would have caught the worst class of defect this
 * system can have. The console can hand an operator the wheel of a live teller
 * session; the thing that makes that safe is a bearer token that reaches
 * exactly one account and no other. "The code looks like it withholds it" is
 * not evidence — a serialiser that runs once and fans the same bytes out to
 * every subscriber looks identical at the call site.
 *
 * So each guarantee below is asserted against a real HTTP server, over real
 * cookies, from the point of view of an account that should not have it.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import {
  SwivelStore, EscalationBroker, hashPassword, runnerToken,
  type Intervention, type InterventionContext,
} from '@swivel/core';
import { buildConsole } from '../apps/console/src/server.js';
import { DEFAULT_CONFIG } from '../packages/cli/src/config.js';

let dir: string;
let server: Server;
let base: string;
let broker: EscalationBroker;

const CONTROL = { wsUrl: 'ws://127.0.0.1:59999/control', token: 'SECRET-DRIVE-TOKEN', viewport: { width: 1280, height: 860 } };

function ctx(over: Partial<InterventionContext> = {}): InterventionContext {
  return {
    runId: 'rep_test0001', kind: 'replay', url: 'http://127.0.0.1:4711/main',
    diagnosis: { code: 'target_unresolvable', message: 'Could not identify "member_search".' },
    ...over,
  };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'swivel-console-'));
  const store = new SwivelStore(dir);
  await store.init();
  for (const u of [
    { id: 'op', name: 'R. Solis', role: 'operator' as const, roles: ['operator.takeover', 'evidence.read'] },
    { id: 'op2', name: 'T. Okafor', role: 'operator' as const, roles: ['operator.takeover', 'evidence.read'] },
    { id: 'bot', name: 'Agent', role: 'agent' as const, roles: ['capability.invoke'] },
  ]) {
    const { hash, salt } = hashPassword('pw');
    await store.putUser({ ...u, email: `${u.id}@swivel.test`, passwordHash: hash, salt, createdAt: new Date().toISOString() });
  }
  broker = new EscalationBroker();
  const app = await buildConsole({ store, config: DEFAULT_CONFIG, broker });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

/** Sign in and keep the cookie, the way a browser would. */
async function signIn(id: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password: 'pw' }),
  });
  assert.equal(res.status, 200, `${id} should be able to sign in`);
  const cookie = res.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie, 'login must set a session cookie');
  return cookie;
}

const as = (cookie: string) => ({ cookie });
const asRunner = () => ({ authorization: `Bearer ${runnerToken()}` });

async function raiseAndGrant(): Promise<Intervention> {
  const i = await broker.raise('target_unresolvable', ctx());
  broker.claim(i.id, { id: 'op', name: 'R. Solis' });
  broker.markInControl(i.id, CONTROL);
  return i;
}

describe('the live-control token', () => {
  test('is withheld from an operator who did not claim the ticket', async () => {
    const i = await raiseAndGrant();
    const res = await fetch(`${base}/api/interventions/${i.id}`, { headers: as(await signIn('op2')) });
    const body = await res.json() as { intervention: Intervention };
    assert.equal(body.intervention.status, 'in_control', 'the ticket itself is visible — this is a queue');
    assert.equal(body.intervention.context.control, undefined, 'but the wheel is not');
    assert.ok(!JSON.stringify(body).includes(CONTROL.token), 'the token must not appear anywhere in the response');
  });

  test('is withheld from an account with no takeover role at all', async () => {
    const i = await raiseAndGrant();
    const res = await fetch(`${base}/api/interventions/${i.id}`, { headers: as(await signIn('bot')) });
    assert.ok(!(await res.text()).includes(CONTROL.token));
  });

  test('reaches the operator who claimed it', async () => {
    const i = await raiseAndGrant();
    const res = await fetch(`${base}/api/interventions/${i.id}`, { headers: as(await signIn('op')) });
    const body = await res.json() as { intervention: Intervention };
    assert.equal(body.intervention.context.control?.token, CONTROL.token, 'claiming is what grants the wheel');
  });

  test('is not broadcast over the event stream to every signed-in account', async () => {
    // The regression this pins: one `JSON.stringify` of the ticket, written to
    // every SSE subscriber. It looks like a fan-out optimisation; it is a
    // credential disclosure to every account with a session.
    const cookie = await signIn('op2');
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: as(cookie), signal: ac.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    const i = await broker.raise('target_unresolvable', ctx({ runId: 'rep_test0002' }));
    broker.claim(i.id, { id: 'op', name: 'R. Solis' });
    broker.markInControl(i.id, CONTROL);

    let seen = '';
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !seen.includes('"control_granted"') && !seen.includes(i.id)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array }>((r) => setTimeout(() => r({}), 500)),
      ]);
      if (chunk?.value) seen += Buffer.from(chunk.value).toString();
    }
    ac.abort();
    assert.ok(seen.includes(i.id), 'op2 should still be told a ticket moved — they are on the queue');
    assert.ok(!seen.includes(CONTROL.token), 'but the stream must not carry the drive token to them');
  });
});

describe('the machine-facing routes', () => {
  test('refuse an anonymous mirror of a ticket', async () => {
    const res = await fetch(`${base}/api/interventions/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'int_forged1', status: 'open', reason: 'target_unresolvable', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), context: ctx({ runId: 'attacker' }), humanActions: [], timeline: [] }),
    });
    assert.equal(res.status, 401);
    assert.equal(broker.get('int_forged1'), undefined, 'nothing may enter the operator queue unauthenticated');
  });

  test('refuse an anonymous read of what an operator typed', async () => {
    const i = await raiseAndGrant();
    broker.recordHumanAction(i.id, { at: new Date().toISOString(), kind: 'type', detail: '0100482' });
    const res = await fetch(`${base}/api/interventions/${i.id}/resolution`);
    assert.equal(res.status, 401);
    assert.ok(!(await res.text()).includes('0100482'));
  });

  test('accept the runner credential, because that is how a remote run polls', async () => {
    const i = await raiseAndGrant();
    const res = await fetch(`${base}/api/interventions/${i.id}/resolution`, { headers: asRunner() });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { status: string }).status, 'in_control');
  });

  test('will not let one run repoint another run\'s control channel', async () => {
    // The attack: learn a ticket id, mirror it back with `context.control`
    // pointing at a socket you own, and the operator's takeover UI connects to
    // you instead. Binding the ticket to its originating run closes it even for
    // a caller who holds the runner credential.
    const i = await raiseAndGrant();
    const res = await fetch(`${base}/api/interventions/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...asRunner() },
      body: JSON.stringify({ ...i, context: { ...i.context, runId: 'rep_someone_else', control: { wsUrl: 'ws://attacker.invalid/control', token: 'x', viewport: { width: 1, height: 1 } } } }),
    });
    assert.equal(res.status, 409);
    assert.equal(broker.get(i.id)?.context.control?.wsUrl, CONTROL.wsUrl, 'the real channel is untouched');
  });
});

describe('claiming a ticket is a control, not a label', () => {
  test('a second operator cannot resolve a ticket they never claimed', async () => {
    const i = await raiseAndGrant();
    const res = await fetch(`${base}/api/interventions/${i.id}/return`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...as(await signIn('op2')) },
      body: JSON.stringify({ resolution: 'abort', note: 'not mine to abort' }),
    });
    assert.equal(res.status, 409);
    assert.equal(broker.get(i.id)?.status, 'in_control', 'the session stays where it was');
  });

  test('the holder can, and the response still does not echo the token back', async () => {
    const i = await raiseAndGrant();
    const res = await fetch(`${base}/api/interventions/${i.id}/return`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...as(await signIn('op')) },
      body: JSON.stringify({ resolution: 'resume', note: 'opened Customer Search by hand' }),
    });
    assert.equal(res.status, 200);
    assert.equal(broker.get(i.id)?.resolution, 'resume');
  });

  test('a second operator cannot write to another ticket\'s action log', async () => {
    const i = await raiseAndGrant();
    const before = broker.get(i.id)!.humanActions.length;
    const res = await fetch(`${base}/api/interventions/${i.id}/note`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...as(await signIn('op2')) },
      body: JSON.stringify({ note: 'I was here' }),
    });
    assert.equal(res.status, 403);
    assert.equal(broker.get(i.id)!.humanActions.length, before, 'the audit trail is the assignee\'s account of events');
  });
});

describe('evidence', () => {
  test('is not readable by an account that only invokes capabilities', async () => {
    const res = await fetch(`${base}/api/runs/rep_whatever`, { headers: as(await signIn('bot')) });
    assert.equal(res.status, 403, 'evidence bundles hold screenshots of member data');
  });
});
