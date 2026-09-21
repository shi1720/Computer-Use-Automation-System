/**
 * The single-writer invariant.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Exactly one actor drives a live teller session at a time. Everything about
 * the escalation model rests on that: an operator taking over is only safe
 * because the automation genuinely stops, and the audit answer to "who touched
 * this account?" is only meaningful if the lease history is a faithful record
 * of when control moved.
 *
 * Both halves are tested here — the enforcement, and the record.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ControlLeaseManager, LeasedSurface, LeaseViolation } from '@swivel/core';
import { node, FakeSurface } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const screen = () => [{ nodes: [node({ role: 'button', name: 'Submit' })] }];

describe('holding the wheel', () => {
  test('a second acquire is refused rather than queued', () => {
    const leases = new ControlLeaseManager();
    leases.acquire('automation', 'swivel', 'replay');
    assert.throws(() => leases.acquire('operator', 'op', 'takeover'), LeaseViolation);
  });

  test('releasing somebody else\'s lease is refused', () => {
    const leases = new ControlLeaseManager();
    leases.acquire('automation', 'swivel', 'replay');
    assert.throws(() => leases.release('not-the-lease-id'), LeaseViolation);
  });

  test('transferring requires presenting the lease being given up', () => {
    // Otherwise anyone holding a reference to the manager can take the wheel
    // off whoever is driving — which is exactly what `acquire()`'s own error
    // message points people at `transfer()` to avoid.
    const leases = new ControlLeaseManager();
    const mine = leases.acquire('automation', 'swivel', 'replay');
    assert.throws(() => leases.transfer('operator', 'op', 'takeover', 60_000, 'some-other-id'), LeaseViolation);
    const moved = leases.transfer('operator', 'op', 'takeover', 60_000, mine.id);
    assert.equal(moved.holder, 'operator');
    assert.equal(leases.holder, 'operator');
  });
});

describe('an expired lease is gone', () => {
  test('expiry is recorded, not silent', async () => {
    const leases = new ControlLeaseManager();
    leases.acquire('operator', 'op', 'takeover', 5);
    await sleep(30);
    assert.equal(leases.holder, 'none');
    assert.ok(
      leases.history.some((h) => h.to === 'none' && /expired/.test(h.reason)),
      'the audit trail must show the hold ending, not just stop mentioning it',
    );
  });

  test('a stale heartbeat cannot resurrect it', async () => {
    // The race this closes: once a lease lapses, the automation's next action
    // reaps it and fails the run — the documented behaviour. If a late console
    // heartbeat landed first instead, the expired lease came back with no
    // release event, the history showed an unbroken operator hold across a gap
    // where there had been none, and the automation was blocked indefinitely.
    // Which of the two happened was luck.
    const leases = new ControlLeaseManager();
    const l = leases.acquire('operator', 'op', 'takeover', 5);
    await sleep(30);
    assert.throws(() => leases.renew(l.id, 60_000), LeaseViolation);
    assert.equal(leases.holder, 'none', 'still gone');
  });

  test('renewing a live lease works, because that is what a heartbeat is for', () => {
    const leases = new ControlLeaseManager();
    const l = leases.acquire('operator', 'op', 'takeover', 60_000);
    leases.renew(l.id, 120_000);
    assert.equal(leases.holder, 'operator');
  });
});

describe('a leased surface acts only for the lease holder', () => {
  test('the automation cannot act while an operator is driving', async () => {
    const leases = new ControlLeaseManager();
    const mine = leases.acquire('automation', 'swivel', 'replay');
    const inner = new FakeSurface(screen());
    const leased = new LeasedSurface(inner, leases, () => (leases.holder === 'automation' ? leases.lease?.id ?? null : null));

    await leased.act({ kind: 'click', ref: 'n1' });
    assert.equal(inner.actions.length, 1);

    leases.transfer('operator', 'op', 'takeover', 60_000, mine.id);
    await assert.rejects(() => leased.act({ kind: 'click', ref: 'n1' }), LeaseViolation);
    assert.equal(inner.actions.length, 1, 'nothing reached the page');
  });

  test('perception stays open to everybody, because watching is not driving', async () => {
    const leases = new ControlLeaseManager();
    const mine = leases.acquire('automation', 'swivel', 'replay');
    const inner = new FakeSurface(screen());
    const leased = new LeasedSurface(inner, leases, () => (leases.holder === 'automation' ? leases.lease?.id ?? null : null));
    leases.transfer('operator', 'op', 'takeover', 60_000, mine.id);

    // The evidence recorder must keep capturing while a human drives; that is
    // the whole point of recording what they do.
    const snap = await leased.snapshot();
    assert.ok(snap.nodes.length > 0);
    assert.ok(await leased.screenshot());
  });

  test('a token that names a lease nobody holds does not act', async () => {
    // The check has to compare against the *current* lease, not against
    // whatever the current lease happens to be. Written the second way it can
    // never fail, and the invariant is decoration.
    const leases = new ControlLeaseManager();
    const inner = new FakeSurface(screen());
    const leased = new LeasedSurface(inner, leases, () => 'a-lease-id-from-nowhere');
    await assert.rejects(() => leased.act({ kind: 'click', ref: 'n1' }), LeaseViolation);

    leases.acquire('operator', 'op', 'takeover');
    await assert.rejects(() => leased.act({ kind: 'click', ref: 'n1' }), LeaseViolation);
    assert.equal(inner.actions.length, 0);
  });
});
