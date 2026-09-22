/**
 * Intervention requests and the handoff protocol.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * "Escalate to a human" is easy to write and usually means "throw an error and
 * put it in a queue". That is not useful, because by the time a person looks at
 * the queue the session is gone and they are starting from scratch on a task
 * they did not see fail.
 *
 * The protocol here keeps the session alive:
 *
 *   raised      the run has paused mid-flow. The browser session, its cookies,
 *               whatever the application has built up server-side — all still
 *               there, frozen at the step that failed.
 *   claimed     an operator has taken the ticket. Still no control transfer.
 *   in_control  the lease has moved to the operator. They are driving the same
 *               session, through the console, and every input they make is
 *               recorded.
 *   returned    the operator has handed the wheel back and declared what they
 *               did: resume the flow, mark it complete by hand, or abort.
 *   resolved    the run has acted on that declaration.
 *
 * The ticket carries enough context to act without archaeology: the goal, the
 * capability and step, why it stopped, the last screenshot, and the perception
 * snapshot. That is the difference between a five-minute rescue and a
 * twenty-minute investigation.
 *
 * What the human does is not thrown away. Their inputs are recorded as
 * `humanActions`, and a before/after diff of the session is attached — which is
 * what makes "promote this rescue into the capability" possible later, instead
 * of the same escalation firing every week.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export type InterventionStatus = 'open' | 'claimed' | 'in_control' | 'returned' | 'resolved' | 'expired';

export type InterventionReason =
  | 'target_unresolvable'      // replay could not identify a control with confidence
  | 'checkpoint_failed'        // the screen did not become what the artifact expected
  | 'unrecoverable_signal'     // a signal fired that has no recovery plan
  | 'policy_block'             // the flow needs an action policy will not permit unattended
  | 'risky_action'             // an irreversible step needs a person to decide
  | 'discovery_stuck'          // the model ran out of ideas during discovery
  | 'budget_exhausted';        // step or time budget hit with the goal unmet

export type InterventionResolution = 'resume' | 'completed_by_human' | 'abort';

export interface HumanAction {
  at: string;
  kind: 'click' | 'type' | 'key' | 'navigate' | 'note';
  detail: string;
  /** Viewport coordinates for pointer actions, so the replay of the replay makes sense. */
  at_xy?: { x: number; y: number };
}

export interface InterventionContext {
  runId: string;
  kind: 'discovery' | 'replay';
  goal?: string;
  capability?: { id: string; version: string; title: string };
  tenant?: { id: string; institution: string };
  stepId?: string;
  stepIntent?: string;
  /** Machine-readable detail of what went wrong, for triage and for metrics. */
  diagnosis: { code: string; message: string; expected?: string; observed?: string };
  url: string;
  screenshotRef?: string;
  snapshotRef?: string;
  /** Redacted. Operators see what the capability was asked to do. */
  inputs?: Record<string, unknown>;
  /** Where the live session can be driven from, once control is granted. */
  control?: { wsUrl: string; token: string; viewport: { width: number; height: number } };
}

export interface Intervention {
  id: string;
  status: InterventionStatus;
  reason: InterventionReason;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  context: InterventionContext;
  assignee?: { id: string; name: string };
  humanActions: HumanAction[];
  resolution?: InterventionResolution;
  resolutionNote?: string;
  /** Semantic before/after of the session across the handoff. */
  sessionDelta?: { urlBefore: string; urlAfter: string; changes: string[] };
  timeline: Array<{ at: string; event: string; by?: string; detail?: string }>;
}

export interface EscalationSink {
  publish(i: Intervention): Promise<void>;
  update(i: Intervention): Promise<void>;
}

/**
 * In-process broker. The console embeds one; a distributed deployment would
 * swap the sink for a queue without changing the protocol above.
 */
/** Union two accounts of what an operator did, keeping chronological order. */
function mergeHumanActions(a: HumanAction[], b: HumanAction[]): HumanAction[] {
  const key = (h: HumanAction) => `${h.at}|${h.kind}|${h.detail}`;
  const seen = new Set(a.map(key));
  const merged = [...a];
  for (const h of b) if (!seen.has(key(h))) { seen.add(key(h)); merged.push(h); }
  return merged.sort((x, y) => x.at.localeCompare(y.at));
}

export class EscalationBroker extends EventEmitter {
  private readonly items = new Map<string, Intervention>();

  constructor(private readonly sink?: EscalationSink, private readonly ttlMs = 30 * 60_000) { super(); }

  list(filter?: { status?: InterventionStatus }): Intervention[] {
    const all = [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter?.status ? all.filter((i) => i.status === filter.status) : all;
  }
  get(id: string): Intervention | undefined { return this.items.get(id); }

  /**
   * Accept a ticket raised by another process.
   *
   * A run launched from the CLI owns its own browser session, so its ticket —
   * and the live-control channel attached to it — is created there and mirrored
   * here for an operator to act on. The console is the operator's window onto a
   * session it does not host, which is the shape any real deployment has: the
   * runners are wherever the network reaches the core, the console is one place.
   */
  ingest(i: Intervention): Intervention {
    const existing = this.items.get(i.id);
    // Never let an upstream mirror walk a ticket backwards over a decision an
    // operator has already made here.
    if (existing && ['returned', 'resolved', 'expired'].includes(existing.status)) return existing;

    // A ticket belongs to the run that raised it, for its whole life. Without
    // this, anyone able to POST a mirror update for a known ticket id could
    // replace its context wholesale — including `context.control`, which is the
    // websocket the operator's takeover UI connects to. Repointing that at a
    // socket of your choosing would hand you an operator driving a live teller
    // session on your behalf, which is about the worst outcome this system has.
    // The run id is carried in the ticket and never changes, so it is the
    // natural key to bind to.
    if (existing && existing.context.runId !== i.context.runId) {
      throw new Error(
        `Intervention ${i.id} belongs to run ${existing.context.runId}; ` +
        `run ${i.context.runId} may not update it.`,
      );
    }

    const merged: Intervention = existing
      ? {
          ...i,
          status: existing.status,
          ...(existing.assignee ? { assignee: existing.assignee } : {}),
          ...(existing.resolution ? { resolution: existing.resolution } : {}),
          ...(existing.resolutionNote !== undefined ? { resolutionNote: existing.resolutionNote } : {}),
          timeline: existing.timeline,
          // Human actions are unioned, never replaced in either direction.
          //
          // Which side records them depends on where the session lives: a run
          // hosted in another process records the operator's clicks locally and
          // mirrors them up, while a run the console hosts records them here.
          // Letting either side's copy win erases the other's account of what a
          // person did to a live teller session, and that record is the whole
          // point of recording it.
          humanActions: mergeHumanActions(existing.humanActions, i.humanActions),
        }
      : i;
    this.items.set(i.id, merged);
    this.emit(existing ? 'updated' : 'raised', merged);
    return merged;
  }

  async raise(reason: InterventionReason, context: InterventionContext): Promise<Intervention> {
    const now = new Date();
    const i: Intervention = {
      id: `int_${randomUUID().slice(0, 8)}`,
      status: 'open',
      reason,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      context,
      humanActions: [],
      timeline: [{ at: now.toISOString(), event: 'raised', detail: `${reason}: ${context.diagnosis.message}` }],
    };
    this.items.set(i.id, i);
    await this.sink?.publish(i);
    this.emit('raised', i);
    return i;
  }

  private touch(i: Intervention, event: string, by?: string, detail?: string): void {
    i.updatedAt = new Date().toISOString();
    i.timeline.push({ at: i.updatedAt, event, ...(by ? { by } : {}), ...(detail ? { detail } : {}) });
    void this.sink?.update(i);
    this.emit('updated', i);
  }

  claim(id: string, operator: { id: string; name: string }): Intervention {
    const i = this.require(id);
    if (i.status !== 'open') throw new Error(`Intervention ${id} is ${i.status}; only open tickets can be claimed.`);
    i.status = 'claimed';
    i.assignee = operator;
    this.touch(i, 'claimed', operator.id);
    return i;
  }

  /** Called once the lease has actually moved. Never call it speculatively. */
  markInControl(id: string, control: NonNullable<InterventionContext['control']>): Intervention {
    const i = this.require(id);
    if (i.status !== 'claimed' || !i.assignee) throw new Error('A named operator must claim the ticket before control is granted.');
    i.status = 'in_control';
    i.context.control = control;
    this.touch(i, 'control_granted', i.assignee?.id);
    return i;
  }

  recordHumanAction(id: string, action: HumanAction): void {
    const i = this.items.get(id);
    if (!i) return;
    // Coalesce consecutive keystrokes into one typed string; a per-character
    // audit trail is noise, and the operator typed a value, not 12 events.
    const last = i.humanActions[i.humanActions.length - 1];
    if (action.kind === 'type' && last?.kind === 'type' && Date.parse(action.at) - Date.parse(last.at) < 2_000) {
      last.detail += action.detail;
      last.at = action.at;
    } else {
      i.humanActions.push(action);
    }
    i.updatedAt = action.at;
    void this.sink?.update(i);
  }

  /**
   * Hand the wheel back.
   *
   * `by` is the operator making the call. It is optional only because the run
   * that raised the ticket also applies its own resolution locally, where there
   * is no operator identity to check; every console-facing path passes it, and
   * when it is passed it must match the assignee. Claiming a ticket has to mean
   * something, and it only does if nobody else can resolve it.
   */
  returnControl(
    id: string,
    resolution: InterventionResolution,
    note: string,
    delta?: Intervention['sessionDelta'],
    by?: { id: string; name: string },
  ): Intervention {
    const i = this.require(id);
    if (by && i.assignee && i.assignee.id !== by.id) {
      throw new Error(`Intervention ${id} is held by ${i.assignee.name}; only they can return it.`);
    }
    if (by && !i.assignee) {
      throw new Error(`Intervention ${id} has not been claimed; claim it before returning control.`);
    }
    i.status = 'returned';
    i.resolution = resolution;
    i.resolutionNote = note;
    if (delta) i.sessionDelta = delta;
    this.touch(i, 'control_returned', i.assignee?.id, `${resolution}: ${note}`);
    this.emit(`resolved:${id}`, i);
    this.emit('resolved', i);
    return i;
  }

  resolve(id: string, detail: string): Intervention {
    const i = this.require(id);
    i.status = 'resolved';
    this.touch(i, 'resolved', undefined, detail);
    return i;
  }

  expire(id: string): void {
    const i = this.items.get(id);
    if (!i || ['resolved', 'returned'].includes(i.status)) return;
    i.status = 'expired';
    this.touch(i, 'expired', undefined, 'no operator took the session within the ticket TTL');
    this.emit(`resolved:${id}`, i);
  }

  /**
   * Block the run until a human resolves the ticket — or until the TTL runs out.
   *
   * This is where the automation actually pauses. It is an await, not a poll
   * loop, and the surface is untouched for the whole time, which is what makes
   * "the human takes over the same session" true rather than aspirational.
   */
  waitForResolution(id: string, timeoutMs?: number): Promise<Intervention> {
    const i = this.require(id);
    if (['returned', 'resolved', 'expired'].includes(i.status)) return Promise.resolve(i);
    const budget = timeoutMs ?? Math.max(1_000, Date.parse(i.expiresAt) - Date.now());
    return new Promise((resolve) => {
      let settled = false;
      const done = (x: Intervention) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off(`resolved:${id}`, done);
        resolve(x);
      };
      const timer = setTimeout(() => {
        // `expire` emits `resolved:id`, which re-enters `done` — the guard above
        // is what keeps that from double-settling. Removing the listener here as
        // well matters because a long-lived console accumulates one leaked
        // listener per timed-out ticket otherwise.
        this.expire(id);
        done(this.require(id));
      }, budget);
      this.on(`resolved:${id}`, done);
    });
  }

  /** Keep a local ticket claimable until a real operator takes responsibility. */
  waitForClaim(id: string): Promise<Intervention> {
    const i = this.require(id);
    if (i.status !== 'open') return Promise.resolve(i);
    return new Promise((resolve) => {
      const done = (updated: Intervention) => {
        if (updated.id !== id || updated.status === 'open') return;
        clearTimeout(timer); this.off('updated', done); resolve(updated);
      };
      const timer = setTimeout(() => this.expire(id), Math.max(1, Date.parse(i.expiresAt) - Date.now()));
      this.on('updated', done);
    });
  }

  private require(id: string): Intervention {
    const i = this.items.get(id);
    if (!i) throw new Error(`No such intervention: ${id}`);
    return i;
  }
}
