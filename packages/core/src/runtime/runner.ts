/**
 * Run assembly.
 *
 * One place that knows how to stand up everything a run needs — surface,
 * evidence bundle, redactor, control lease, policy, escalation wiring — and
 * tear it all down afterwards. The CLI and the console both go through here, so
 * a run launched from a terminal and a run launched from the web console are
 * the same run, with the same guarantees and the same evidence layout.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Capability, TenantOverlay } from '../artifact/schema.js';
import { resolveCapability, tenantContext, type ResolvedCapability } from '../artifact/merge.js';
import { WebSurface } from '../surface/web.js';
import { LeasedSurface, ControlLeaseManager } from '../escalation/lease.js';
import { EscalationBroker, type Intervention } from '../escalation/broker.js';
import { startLiveControl, type LiveControlHandle } from '../escalation/live-control.js';
import { EvidenceRecorder, type RunManifest } from '../evidence/recorder.js';
import { Redactor, defaultSalt } from '../redact/redact.js';
import { SessionProvider, EnvSecretResolver, MERIDIAN_SIGN_ON, type SignOnSpec } from '../session/provider.js';
import { replay, type ReplayOptions } from '../replay/engine.js';
import type { ReplayResult } from '../replay/outcome.js';
import { discover, type DiscoveryRequest, type DiscoveryResult, SWIVEL_VERSION } from '../agent/discover.js';
import type { LlmProvider } from '../agent/llm.js';
import { SwivelStore, type StoredRun } from '../store/store.js';

export interface TenantRef {
  id: string;
  institution: string;
  baseUrl: string;
  productVersion?: string;
  vocabulary?: Record<string, string>;
}

export interface RunnerOptions {
  store: SwivelStore;
  headless?: boolean;
  /** Mirror evidence events to a callback (the CLI prints them; the console streams them). */
  onEvent?: (e: { kind: string; message: string; at: string }) => void;
  /** Where evidence bundles land. */
  evidenceRoot?: string;
  /** Enables the escalation path. Without it, a stuck run fails instead of pausing. */
  escalation?: {
    broker: EscalationBroker;
    /** Called once the live-control channel exists, so an operator UI can be told about it. */
    onControlReady?: (i: Intervention) => void | Promise<void>;
  };
  signOn?: SignOnSpec | null;
  chromiumPath?: string;
}

export interface RunHandle {
  runId: string;
  evidenceDir: string;
  surface: WebSurface;
  leases: ControlLeaseManager;
  close(): Promise<void>;
}

const DEFAULT_EVIDENCE_ROOT = process.env.SWIVEL_EVIDENCE_DIR ?? 'evidence/runs';

export class Runner {
  constructor(private readonly opts: RunnerOptions) {}

  private makeRecorder(runId: string, manifest: Omit<RunManifest, 'counts' | 'redaction' | 'swivelVersion'>, redactor: Redactor): EvidenceRecorder {
    const dir = join(this.opts.evidenceRoot ?? DEFAULT_EVIDENCE_ROOT, runId);
    return new EvidenceRecorder(
      dir,
      { ...manifest, counts: { events: 0, steps: 0, screenshots: 0, signals: 0, recoveries: 0, escalations: 0 }, redaction: {}, swivelVersion: SWIVEL_VERSION },
      redactor,
      (e) => this.opts.onEvent?.({ kind: e.kind, message: e.message, at: e.at }),
    );
  }

  private async launchSurface(allowedOrigins: string[], evidence: EvidenceRecorder, allowedPathPatterns: string[] = []): Promise<WebSurface> {
    return WebSurface.launch({
      headless: this.opts.headless ?? true,
      allowedOrigins,
      allowedPathPatterns,
      ...(this.opts.chromiumPath ? { executablePath: this.opts.chromiumPath } : {}),
      onBlocked: (url, reason) => { void evidence.log('network.blocked', `Blocked request to ${url}: ${reason}`); },
    });
  }

  /**
   * Escalation wiring.
   *
   * Starting the live-control server lazily matters: it opens a websocket that
   * can drive a live banking session, so it exists only for as long as an
   * actual escalation is open, and its token dies with the run.
   */
  private escalationFor(
    surface: WebSurface, leases: ControlLeaseManager, evidence: EvidenceRecorder,
  ): ReplayOptions['escalation'] | undefined {
    const esc = this.opts.escalation;
    if (!esc) return undefined;
    let live: LiveControlHandle | null = null;

    return {
      broker: esc.broker,
      grantControl: async (i: Intervention) => {
        live = await startLiveControl(surface, leases, {
          onHumanAction: (a) => {
            esc.broker.recordHumanAction(i.id, a);
            void evidence.log('escalation.human_action', `${a.kind}: ${a.detail}`);
          },
        });
        // Control moves here and only here. Until this transfer the operator can
        // watch but cannot act — the live-control server drops their input.
        leases.transfer('operator', i.assignee?.id ?? 'operator', `intervention ${i.id}: ${i.reason}`);
        esc.broker.markInControl(i.id, { wsUrl: live.wsUrl, token: live.token, viewport: live.viewport });
        await evidence.log('escalation.control_granted', `Live session handed to operator (${live.wsUrl})`, { interventionId: i.id });
        await esc.onControlReady?.(esc.broker.get(i.id) as Intervention);
      },
      reclaim: async () => {
        await live?.stop();
        live = null;
        leases.transfer('automation', 'swivel', 'control returned by operator');
        await evidence.log('escalation.resumed', 'Automation reacquired the control lease');
      },
    };
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async runDiscovery(req: DiscoveryRequest, llm: LlmProvider): Promise<DiscoveryResult & { runId: string; evidenceDir: string }> {
    // Discovery holds a lease for the same reason replay does — one writer per
    // session — even though nothing transfers control away from it today: the
    // loop is read-only by construction and has no live-control path. The lease
    // is the invariant, not the feature, and wiring it now is what makes adding
    // escalation to discovery a change in one place rather than an audit.
    const runId = `disc_${randomUUID().slice(0, 8)}`;
    const redactor = new Redactor({ salt: defaultSalt(), revealTail: 4 });
    const evidence = this.makeRecorder(runId, {
      runId, kind: 'discovery', startedAt: new Date().toISOString(),
      principal: { id: req.owner ?? 'operator', kind: 'human' },
      goal: req.goal,
      tenant: { id: req.tenant.id, institution: req.tenant.institution, baseUrl: req.tenant.baseUrl },
      inputs: Object.fromEntries(req.parameters.map((p) => [p.name, redactor.field(p.value, p.sensitivity, `input.${p.name}`)])),
    }, redactor);

    await this.opts.store.putRun({
      runId, kind: 'discovery', status: 'running', tenantId: req.tenant.id,
      startedAt: new Date().toISOString(), evidenceDir: evidence.dir, summary: req.goal,
    });

    const surface = await this.launchSurface(req.policy.allowedOrigins, evidence, req.policy.allowedPathPatterns);
    const leases = new ControlLeaseManager();
    const lease = leases.acquire('automation', 'swivel', `discovery ${runId}`);
    // The same single-writer rule as replay, expressed the same way: the
    // automation acts only while *it* holds the lease. Comparing the current
    // lease id against "whatever the current lease id is" can never fail, which
    // made this check a no-op and would have let the automation keep acting
    // through an operator's takeover the moment discovery gained one.
    const leased = new LeasedSurface(surface, leases, () => (leases.holder === 'automation' ? leases.lease?.id ?? null : null));
    void lease;

    try {
      const signOn = this.opts.signOn === null ? null : (this.opts.signOn ?? MERIDIAN_SIGN_ON);
      if (signOn) {
        const provider = new SessionProvider(signOn, new EnvSecretResolver(), (m) => { void evidence.log('note', m); });
        const r = await provider.establish(leased, tenantContext(undefined, req.tenant.baseUrl));
        await evidence.log(r.ok ? 'note' : 'step.failed', r.message);
        if (!r.ok) {
          await evidence.finish({ status: 'failed', reason: r.message });
          return { status: 'failed', findings: [], message: r.message, turns: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 0, runId, evidenceDir: evidence.dir };
        }
      }

      const result = await discover(req, {
        surface: leased as unknown as WebSurface,
        llm, evidence,
        ...(this.opts.escalation ? { broker: this.opts.escalation.broker, leases } : {}),
      });

      if (result.capability) await this.opts.store.putCapability(result.capability);
      const manifest = await evidence.finish({
        status: result.status, message: result.message, turns: result.turns,
        usage: result.usage, costUsd: Number(result.costUsd.toFixed(4)),
        capability: result.capability ? `${result.capability.metadata.id}@${result.capability.metadata.version}` : null,
      });

      await this.opts.store.putRun({
        runId, kind: 'discovery', status: result.status, startedAt: manifest.startedAt,
        finishedAt: manifest.finishedAt ?? new Date().toISOString(),
        evidenceDir: evidence.dir, summary: result.message,
        costUsd: Number(result.costUsd.toFixed(4)),
        ...(result.capability ? { capabilityId: result.capability.metadata.id, capabilityVersion: result.capability.metadata.version } : {}),
        tenantId: req.tenant.id,
      });

      return { ...result, runId, evidenceDir: evidence.dir };
    } finally {
      await surface.close();
    }
  }

  // ── replay ────────────────────────────────────────────────────────────────

  async runReplay(args: {
    capability: Capability;
    overlay?: TenantOverlay | null;
    tenant: TenantRef;
    inputs: Record<string, unknown>;
    principal: { id: string; kind: 'agent' | 'human' | 'system'; roles: string[] };
    unattended: boolean;
    confirmationToken?: string;
    /** Callback fired before the run starts, so the console can register it. */
    onStart?: (h: { runId: string; evidenceDir: string }) => void;
  }): Promise<ReplayResult> {
    const runId = `rep_${randomUUID().slice(0, 8)}`;
    const resolved: ResolvedCapability = resolveCapability(args.capability, args.overlay ?? undefined);
    const redactor = new Redactor({
      salt: defaultSalt(),
      extraPatterns: resolved.policy.redactPatterns,
      revealTail: 4,
    });

    const evidence = this.makeRecorder(runId, {
      runId, kind: 'replay', startedAt: new Date().toISOString(),
      principal: { id: args.principal.id, kind: args.principal.kind },
      capability: { id: resolved.metadata.id, version: resolved.metadata.version, ...(resolved.contentHash ? { contentHash: resolved.contentHash } : {}) },
      tenant: { id: args.tenant.id, institution: args.tenant.institution, baseUrl: args.tenant.baseUrl },
      inputs: redactor.record(args.inputs, resolved.contract.inputs, 'input'),
    }, redactor);

    // Recorded before the browser opens, not after the run ends. An escalation
    // hands an operator a screenshot from a run that is still in flight, and a
    // console that cannot resolve the evidence bundle until the run finishes
    // shows them a broken image at exactly the moment they need it.
    await this.opts.store.putRun({
      runId, kind: 'replay', status: 'running',
      capabilityId: resolved.metadata.id, capabilityVersion: resolved.metadata.version,
      tenantId: args.tenant.id, startedAt: new Date().toISOString(),
      evidenceDir: evidence.dir, summary: 'in flight',
    });
    args.onStart?.({ runId, evidenceDir: evidence.dir });

    const origins = [...new Set([...resolved.policy.allowedOrigins, new URL(args.tenant.baseUrl).origin])];
    const surface = await this.launchSurface(origins, evidence, resolved.policy.allowedPathPatterns);
    const leases = new ControlLeaseManager();
    const lease = leases.acquire('automation', 'swivel', `replay ${runId}`);
    const leased = new LeasedSurface(surface, leases, () => (leases.holder === 'automation' ? leases.lease?.id ?? null : null));
    void lease;

    // The capability's entry template resolves against the tenant's base URL,
    // which is the overlay's when one applies and the CLI's argument otherwise.
    const entryBase = args.overlay?.tenant.baseUrl ?? args.tenant.baseUrl;
    const patched: ResolvedCapability = {
      ...resolved,
      policy: { ...resolved.policy, allowedOrigins: origins },
      target: { ...resolved.target, vocabulary: { ...resolved.target.vocabulary, ...(args.tenant.vocabulary ?? {}) } },
    };

    try {
      const signOn = this.opts.signOn === null ? null : (this.opts.signOn ?? MERIDIAN_SIGN_ON);
      const session = signOn
        ? new SessionProvider(signOn, new EnvSecretResolver(), (m) => { void evidence.log('note', m); })
        : undefined;

      // Built once: starting the live-control server twice would leave an
      // orphaned websocket able to drive the session.
      const escalation = this.escalationFor(surface, leases, evidence);

      const result = await replay({
        capability: { ...patched, target: { ...patched.target, entry: { ...patched.target.entry, urlTemplate: patched.target.entry.urlTemplate } } },
        inputs: args.inputs,
        surface: leased,
        evidence,
        principal: args.principal,
        unattended: args.unattended,
        ...(args.confirmationToken ? { confirmationToken: args.confirmationToken } : {}),
        ...(session ? { session } : {}),
        ...(escalation ? { escalation } : {}),
        tenant: { id: args.tenant.id, institution: args.tenant.institution, baseUrl: entryBase },
        runId,
      });

      // Replay statistics feed the capability's confidence score, which is what
      // gates unattended execution. A capability earns trust by replaying, not
      // by being declared trustworthy.
      await this.recordReplayStats(resolved, result);

      const stored: StoredRun = {
        runId, kind: 'replay', status: result.status,
        capabilityId: resolved.metadata.id, capabilityVersion: resolved.metadata.version,
        tenantId: args.tenant.id,
        startedAt: result.startedAt, finishedAt: result.finishedAt, durationMs: result.durationMs,
        evidenceDir: evidence.dir, runQuality: result.runQuality,
        summary: summarise(result),
        ...(result.status === 'business_outcome' ? { outcomeCode: result.outcome.code } : {}),
      };
      await this.opts.store.putRun(stored);
      void entryBase;
      return result;
    } finally {
      await surface.close();
    }
  }

  private async recordReplayStats(cap: Capability, r: ReplayResult): Promise<void> {
    try {
      await this.opts.store.updateQuality(cap.metadata.id, cap.metadata.version, cap.contentHash, (q) => {
        const replays = { ...q.replays, total: q.replays.total + 1 };
        if (r.status === 'success') replays.success += 1;
        else if (r.status === 'business_outcome') replays.businessOutcome += 1;
        else if (r.status === 'escalated') replays.escalated += 1;
        else replays.failed += 1;
        if (r.recoveries.length) replays.recovered += 1;
        return {
          ...q,
          replays,
          stabilityScore: stabilityScore(replays, r.runQuality),
          lastReplayAt: r.finishedAt,
          // An approved capability that starts failing loses its approval
          // automatically. Trust is continuously earned, not granted once.
          approvalState: q.approvalState === 'approved' && r.status === 'failed' && replays.failed >= 3
            ? 'candidate' : q.approvalState,
        };
      });
    } catch { /* a stats write must never fail a run */ }
  }
}

/**
 * Confidence in a capability.
 *
 * Blends outcome history with the last run's mean resolution score, because a
 * capability whose controls resolve at 58 is fragile even if it has never
 * failed, and saying so before the first incident is the point of measuring it.
 * Business outcomes count as successes: "no such member" is the automation
 * working correctly.
 */
export function stabilityScore(
  replays: Capability['quality']['replays'], lastRunQuality: number,
): number {
  const attempts = Math.max(replays.total, 1);
  const clean = replays.success + replays.businessOutcome;
  const outcomeRate = clean / attempts;
  const penalty = (replays.failed * 2 + replays.escalated) / attempts;
  const confidence = Math.min(1, attempts / 5);       // few runs = little evidence
  const base = Math.max(0, outcomeRate - penalty * 0.5);
  return Math.round(Math.min(100, (base * 70 + (lastRunQuality / 100) * 30) * (0.6 + 0.4 * confidence)));
}

function summarise(r: ReplayResult): string {
  switch (r.status) {
    case 'success': return `success — ${Object.keys(r.outputs).length} outputs in ${r.durationMs}ms`;
    case 'business_outcome': return `${r.outcome.code} — ${r.outcome.message}`;
    case 'escalated': return `escalated — ${r.intervention.reason} (${r.intervention.resolution ?? 'pending'})`;
    case 'failed': return `${r.error.class} at ${r.error.stepId ?? 'run'} — ${r.error.message}`;
  }
}
