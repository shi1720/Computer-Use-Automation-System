/**
 * Bridging a locally-hosted run to the operator console.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * A run launched from a terminal owns its own browser session. When it gets
 * stuck it must not die and it must not hold the terminal hostage waiting for
 * someone to notice — it needs a person, and the person is looking at the
 * console.
 *
 * So the run keeps its session, starts its own live-control websocket beside it,
 * and mirrors the ticket into the console. The operator opens it there and
 * drives *this* browser over that websocket. The run polls for their decision
 * and picks up where it stopped.
 *
 * This is the shape a real deployment has and the reason the seam is worth
 * having: runners live wherever the network reaches the core — a branch, a
 * jump host, a container beside the mainframe gateway — while there is one
 * console and one operator queue.
 */
import { EscalationBroker, type EscalationSink, type Intervention } from '@swivel/core';
import { c } from './ui.js';

export interface BridgeOptions {
  consoleUrl: string;
  /** How often to ask the console whether a human has decided. */
  pollMs?: number;
  onNotice?: (message: string) => void;
}

export class ConsoleEscalationBridge implements EscalationSink {
  readonly broker: EscalationBroker;
  private readonly seen = new Set<string>();

  constructor(private readonly opts: BridgeOptions) {
    this.broker = new EscalationBroker(this);
  }

  static async isReachable(url: string): Promise<boolean> {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/me`, { signal: AbortSignal.timeout(1500) });
      return res.ok || res.status === 401;
    } catch { return false; }
  }

  private async send(i: Intervention): Promise<void> {
    try {
      await fetch(`${this.opts.consoleUrl.replace(/\/$/, '')}/api/interventions/ingest`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(i),
      });
    } catch (e) {
      this.opts.onNotice?.(`Could not reach the console to publish this intervention: ${(e as Error).message}`);
    }
  }

  async publish(i: Intervention): Promise<void> {
    await this.send(i);
    this.opts.onNotice?.(
      `\n  ${c.bgYellow(' NEEDS A HUMAN ')}  ${i.context.diagnosis.message}\n` +
      `  ${c.grey('The browser session is paused and still alive. Take it over at:')}\n` +
      `  ${c.cyan(`${this.opts.consoleUrl}/#/operators/${i.id}`)}\n`);
    if (!this.seen.has(i.id)) { this.seen.add(i.id); void this.watch(i.id); }
  }

  /** The control channel only exists after the run grants it, so keep mirroring. */
  async update(i: Intervention): Promise<void> { await this.send(i); }

  /**
   * Poll until a human decides, then apply their decision to the local broker —
   * which is what un-blocks the waiting run.
   */
  private async watch(id: string): Promise<void> {
    const url = `${this.opts.consoleUrl.replace(/\/$/, '')}/api/interventions/${id}/resolution`;
    const every = this.opts.pollMs ?? 1200;
    for (;;) {
      await new Promise((r) => setTimeout(r, every));
      const local = this.broker.get(id);
      if (!local || ['returned', 'resolved', 'expired'].includes(local.status)) return;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) continue;
        const body = await res.json() as { status: string; resolution?: 'resume' | 'completed_by_human' | 'abort'; note?: string; assignee?: { id: string; name: string }; humanActions?: Intervention['humanActions'] };
        if (body.assignee && !local.assignee) {
          local.assignee = body.assignee;
          this.opts.onNotice?.(`  ${c.yellow('→')} ${body.assignee.name} claimed the session.`);
        }
        // Mirror back what the operator actually did, so it lands on this run's
        // evidence chain rather than only in the console's memory.
        for (const a of body.humanActions ?? []) {
          if (!local.humanActions.some((x) => x.at === a.at && x.detail === a.detail)) local.humanActions.push(a);
        }
        if (body.status === 'returned' && body.resolution) {
          this.broker.returnControl(id, body.resolution, body.note ?? '', undefined);
          this.opts.onNotice?.(`  ${c.green('→')} Control handed back: ${body.resolution}${body.note ? ` — ${body.note}` : ''}`);
          return;
        }
      } catch { /* the console may be restarting; keep waiting */ }
    }
  }
}
