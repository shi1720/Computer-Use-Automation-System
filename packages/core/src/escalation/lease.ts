/**
 * The control lease.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * A live application session has exactly one steering wheel. If the automation
 * and a human operator can both act on it at the same time, you get the worst
 * failure mode in this whole system: two actors interleaving keystrokes into a
 * funds-transfer form, and an audit trail that cannot say who did what.
 *
 * So control is modelled as a *lease* — a single-writer token with a holder, an
 * expiry and a reason — and the surface is wrapped so that acting without the
 * current token is impossible rather than merely discouraged. "Who is in
 * control" is not a status field somebody remembers to update; it is the thing
 * that decides whether an action executes.
 *
 * Leases expire. An operator who claims a session and then goes to lunch does
 * not strand it forever: the lease lapses, the event is recorded, and the run
 * fails with a clear reason instead of hanging.
 */
import { randomUUID } from 'node:crypto';
import type { Snapshot, SnapshotOptions, Surface, SurfaceAction } from '../surface/types.js';

export type Holder = 'automation' | 'operator';

export interface Lease {
  id: string;
  holder: Holder;
  holderId: string;
  acquiredAt: string;
  expiresAt: string;
  reason: string;
}

export class LeaseViolation extends Error {
  constructor(message: string) { super(message); this.name = 'LeaseViolation'; }
}

export interface LeaseTransfer {
  at: string;
  from: Holder | 'none';
  to: Holder | 'none';
  holderId: string;
  reason: string;
}

/**
 * Owns the single-writer invariant for one session.
 *
 * Deliberately *not* re-entrant and deliberately not a queue: there is no
 * legitimate case where two actors should be waiting their turn on a live
 * teller session, and a queue would hide a design error until it mattered.
 */
export class ControlLeaseManager {
  private current: Lease | null = null;
  readonly history: LeaseTransfer[] = [];

  constructor(private readonly onChange?: (lease: Lease | null, transfer: LeaseTransfer) => void) {}

  get lease(): Lease | null {
    if (this.current && Date.parse(this.current.expiresAt) < Date.now()) {
      this.forceRelease('lease expired');
    }
    return this.current;
  }

  get holder(): Holder | 'none' { return this.lease?.holder ?? 'none'; }

  /** Take control. Fails if somebody else holds it — transfer explicitly instead. */
  acquire(holder: Holder, holderId: string, reason: string, ttlMs = 15 * 60_000): Lease {
    const existing = this.lease;
    if (existing) {
      throw new LeaseViolation(
        `Cannot acquire control for ${holder}/${holderId}: ${existing.holder}/${existing.holderId} holds the lease (since ${existing.acquiredAt}). ` +
        `Use transfer() so the handover is recorded.`);
    }
    return this.install(holder, holderId, reason, ttlMs, 'none');
  }

  /**
   * Hand the wheel over. This is the only way control changes hands while a run
   * is live, and it always produces a history entry.
   *
   * `fromLeaseId` is the lease being given up. It is optional only so that the
   * first grant of an unheld session reads naturally; whenever a lease *is*
   * held, presenting it is how the caller shows it has the authority to hand it
   * over. Without that check, anyone holding a reference to this manager could
   * take the wheel off whoever is driving, which is precisely the thing
   * `acquire()`'s own error message tells people to use `transfer()` to avoid.
   */
  transfer(to: Holder, holderId: string, reason: string, ttlMs = 15 * 60_000, fromLeaseId?: string): Lease {
    const existing = this.lease;
    if (existing && fromLeaseId !== undefined && existing.id !== fromLeaseId) {
      throw new LeaseViolation(
        `Cannot transfer control: ${fromLeaseId} is not the current lease (${existing.id}, held by ${existing.holder}/${existing.holderId}).`);
    }
    const from = existing?.holder ?? 'none';
    return this.install(to, holderId, reason, ttlMs, from);
  }

  release(leaseId: string, reason = 'released'): void {
    if (!this.current) return;
    if (this.current.id !== leaseId) {
      throw new LeaseViolation(`Lease ${leaseId} is not the current lease (${this.current.id}); refusing to release somebody else's control.`);
    }
    this.forceRelease(reason);
  }

  private forceRelease(reason: string): void {
    const from = this.current?.holder ?? 'none';
    const holderId = this.current?.holderId ?? '-';
    this.current = null;
    const t: LeaseTransfer = { at: new Date().toISOString(), from, to: 'none', holderId, reason };
    this.history.push(t);
    this.onChange?.(null, t);
  }

  private install(holder: Holder, holderId: string, reason: string, ttlMs: number, from: Holder | 'none'): Lease {
    const lease: Lease = {
      id: randomUUID(),
      holder, holderId, reason,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    this.current = lease;
    const t: LeaseTransfer = { at: lease.acquiredAt, from, to: holder, holderId, reason };
    this.history.push(t);
    this.onChange?.(lease, t);
    return lease;
  }

  /**
   * Extend an active lease — the operator console heartbeats through this.
   *
   * Note `this.lease`, not `this.current`. The getter is what reaps an expired
   * lease and records the release; reading the field directly walked straight
   * past it and resurrected a lease that had already lapsed, with no release
   * event, so the history showed an unbroken operator hold across a period
   * where there had been none.
   *
   * Worse than the audit gap was the race. Once a lease lapses, the
   * automation's next `act()` reaps it and fails the run with "no control lease
   * is held", which is the documented behaviour. If a stale console heartbeat
   * landed first instead, the expired lease came back and the automation was
   * blocked indefinitely. Which of the two happened was luck. An expired lease
   * is gone; re-acquiring is the honest path, and it is recorded.
   */
  renew(leaseId: string, ttlMs = 15 * 60_000): void {
    const l = this.lease;
    if (!l) throw new LeaseViolation(`Cannot renew: lease ${leaseId} has expired and been released.`);
    if (l.id !== leaseId) throw new LeaseViolation(`Cannot renew: ${leaseId} is not the current lease.`);
    l.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  }
}

/**
 * A `Surface` that refuses to act for anyone but the current lease holder.
 *
 * Perception stays open to everybody — an operator watching a session, or the
 * evidence recorder capturing it, must not need the wheel. Only mutation is
 * gated. That asymmetry is the whole point: observation is safe, action is not.
 */
export class LeasedSurface implements Surface {
  readonly kind: Surface['kind'];
  readonly id: string;

  constructor(
    private readonly inner: Surface,
    private readonly leases: ControlLeaseManager,
    /** The token this wrapper acts with. Held by the automation. */
    private token: () => string | null,
  ) {
    this.kind = inner.kind;
    this.id = inner.id;
  }

  private assert(): void {
    const l = this.leases.lease;
    const mine = this.token();
    if (!l) throw new LeaseViolation('No control lease is held for this session; the automation cannot act.');
    if (!mine || l.id !== mine) {
      throw new LeaseViolation(
        `Control is held by ${l.holder}/${l.holderId} since ${l.acquiredAt} (${l.reason}). The automation may observe but not act.`);
    }
  }

  snapshot(opts?: SnapshotOptions): Promise<Snapshot> { return this.inner.snapshot(opts); }
  currentUrl(): Promise<string> { return this.inner.currentUrl(); }
  screenshot(): Promise<Buffer> { return this.inner.screenshot(); }
  close(): Promise<void> { return this.inner.close(); }
  exposeForHumanControl() { return this.inner.exposeForHumanControl?.() ?? Promise.resolve(null); }

  async act(action: SurfaceAction): Promise<void> {
    this.assert();
    return this.inner.act(action);
  }

  /** Escape hatch for the live-control server, which acts *as* the operator. */
  get unleashed(): Surface { return this.inner; }
}
