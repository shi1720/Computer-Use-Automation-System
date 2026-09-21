/**
 * The deterministic replay engine — the production execution path.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * No model is consulted here. Given the same artifact, the same inputs and the
 * same application state, this performs the same actions in the same order and
 * returns the same result. That is not a performance optimisation; it is the
 * regulatory precondition. SR 11-7 requires an institution to perform its own
 * outcomes testing on a vendor model, and you cannot outcomes-test something
 * that does not produce the same output twice.
 *
 * Determinism here rests on five things, each of which is a decision rather
 * than an accident:
 *
 *  1. **Targets resolve by scored evidence, and refuse below threshold.** The
 *     engine never picks "the closest match"; it either clears the bar the
 *     artifact set or it stops and says which evidence went missing.
 *  2. **Every state change is proven.** A step with a checkpoint does not
 *     advance until the checkpoint holds. Without this, "the click worked" and
 *     "the page never loaded" are indistinguishable.
 *  3. **Waiting is a condition, never a duration.** The engine re-perceives on
 *     an interval until the condition holds or the budget expires. There are no
 *     sleeps tuned to one machine's speed.
 *  4. **Exceptional states are named in advance.** After every step, the
 *     artifact's signals are evaluated in order and the first match decides
 *     what happens — return a business outcome, recover, escalate, or fail.
 *     Nothing is discovered at runtime.
 *  5. **Inputs are validated before the browser opens.** A malformed member
 *     number is rejected in microseconds, not after four screens.
 */
import { randomUUID } from 'node:crypto';
import type { Capability, Checkpoint, Signal, Step } from '../artifact/schema.js';
import type { ResolvedCapability } from '../artifact/merge.js';
import { emptyContext, render, TemplateError, type TemplateContext } from '../artifact/template.js';
import { resolveTarget, describeTarget, type Resolution } from '../targeting/resolve.js';
import type { Snapshot, Surface } from '../surface/types.js';
import { evaluateAll, evaluateAny } from './assertions.js';
import type { EscalationTrace, FailureClass, RecoveryTrace, ReplayResult, StepTrace } from './outcome.js';
import { PolicyEngine, type ExecutionContext } from '../policy/policy.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { EscalationBroker, InterventionReason, Intervention } from '../escalation/broker.js';
import type { SessionProvider } from '../session/provider.js';
import { validateInputs, coerceOutput } from './contract.js';

export interface ReplayOptions {
  capability: ResolvedCapability;
  inputs: Record<string, unknown>;
  surface: Surface;
  evidence: EvidenceRecorder;
  principal: ExecutionContext['principal'];
  unattended: boolean;
  confirmationToken?: string;
  session?: SessionProvider;
  /** Escalation wiring. Absent = the run fails instead of pausing for a human. */
  escalation?: {
    broker: EscalationBroker;
    /** Publishes the live-control channel once an operator claims the ticket. */
    grantControl: (i: Intervention) => Promise<void>;
    /** Called after the operator hands back, to reclaim the session. */
    reclaim: () => Promise<void>;
  };
  /** Polling interval for condition waits. */
  pollMs?: number;
  runId?: string;
  /** Institution this invocation is acting for. */
  tenant?: { id: string; institution?: string; baseUrl?: string };
}

const now = () => Date.now();

export async function replay(o: ReplayOptions): Promise<ReplayResult> {
  const cap = o.capability;
  const runId = o.runId ?? `run_${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const t0 = now();
  const pollMs = o.pollMs ?? 400;

  const steps: StepTrace[] = [];
  const recoveries: RecoveryTrace[] = [];
  const escalations: EscalationTrace[] = [];
  const outputs: Record<string, unknown> = {};
  /** Set when an operator declares they finished the work by hand. */
  let completedByHuman: EscalationTrace | null = null;
  const targetingScores: number[] = [];

  const tenant = {
    id: o.tenant?.id ?? cap.resolvedFor?.tenantId ?? 'default',
    ...(o.tenant?.institution ?? cap.resolvedFor?.institution
      ? { institution: o.tenant?.institution ?? cap.resolvedFor?.institution as string }
      : {}),
  };

  const finish = (partial: Omit<ReplayResult, keyof ReturnType<typeof common>> & { status: ReplayResult['status'] }): ReplayResult => {
    return { ...common(), ...partial } as ReplayResult;
  };
  const common = () => ({
    runId,
    capability: { id: cap.metadata.id, version: cap.metadata.version, ...(cap.contentHash ? { contentHash: cap.contentHash } : {}) },
    tenant,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: now() - t0,
    steps,
    recoveries,
    escalations,
    evidenceDir: o.evidence.dir,
    runQuality: targetingScores.length
      ? Math.round(targetingScores.reduce((a, b) => a + b, 0) / targetingScores.length)
      : 100,
    llmCalls: 0,
  });

  await o.evidence.log('run.started', `Replaying ${cap.metadata.id}@${cap.metadata.version} for tenant ${tenant.id}`, {
    contentHash: cap.contentHash, unattended: o.unattended, principal: o.principal.id,
    overlay: cap.resolvedFor?.overlayId, patches: cap.resolvedFor?.patchCount,
  });

  // ── 1. contract validation, before anything opens ────────────────────────
  const validation = validateInputs(cap.contract.inputs, o.inputs);
  if (!validation.ok) {
    await o.evidence.log('step.failed', `Input validation failed: ${validation.message}`, { class: 'PRECONDITION_FAILED' });
    await o.evidence.finish({ status: 'failed', class: 'PRECONDITION_FAILED', message: validation.message });
    return finish({
      status: 'failed', outputs,
      error: { class: 'PRECONDITION_FAILED', message: validation.message, evidence: {} },
    } as never);
  }

  const ctx: TemplateContext = {
    input: validation.values,
    output: outputs,
    vocab: cap.target.vocabulary,
    tenant: {
      // The instance this run is acting against, resolved from the overlay when
      // one applies and from the caller's tenant otherwise.
      baseUrl: (o.tenant?.baseUrl ?? cap.policy.allowedOrigins[0] ?? '').replace(/\/$/, ''),
      tenantId: tenant.id,
      institution: tenant.institution ?? '',
    },
    run: { runId, startedAt },
  };
  const execCtx: ExecutionContext = {
    principal: o.principal,
    ...(o.confirmationToken ? { confirmationToken: o.confirmationToken } : {}),
    unattended: o.unattended,
    startedAt: t0,
    stepsTaken: 0,
  };
  const policy = new PolicyEngine(cap, execCtx);

  // ── 2. admission ─────────────────────────────────────────────────────────
  const admit = policy.admit();
  await o.evidence.log('policy.decision', admit.allow ? 'Invocation admitted' : admit.reason, {
    code: admit.allow ? 'ADMITTED' : admit.code,
  });
  if (!admit.allow) {
    // A refusal is evidence too — "the automation declined to act, and why" is
    // exactly what an examiner or an incident review comes looking for.
    await o.evidence.finish({ status: 'failed', class: 'POLICY_DENIED', code: admit.code, message: admit.reason });
    return finish({
      status: 'failed', outputs,
      error: { class: 'POLICY_DENIED', message: admit.reason, evidence: {} },
    } as never);
  }

  // ── failure/escalation helpers ───────────────────────────────────────────
  const captureEvidence = async (label: string): Promise<{ screenshot?: string; snapshot?: string; page?: string }> => {
    const out: { screenshot?: string; snapshot?: string; page?: string } = {};
    try { out.screenshot = await o.evidence.screenshot(label, await o.surface.screenshot()); } catch { /* surface gone */ }
    try { out.snapshot = await o.evidence.snapshot(label, await o.surface.snapshot(), true); } catch { /* surface gone */ }
    const anyHtml = (o.surface as unknown as { html?: () => Promise<string> }).html;
    if (anyHtml) { try { out.page = await o.evidence.pageCapture(label, await anyHtml.call(o.surface)); } catch { /* noop */ } }
    return out;
  };

  const fail = async (
    cls: FailureClass, message: string, step?: Step, expected?: string, observed?: string,
  ): Promise<ReplayResult> => {
    const ev = await captureEvidence(`fail_${step?.id ?? 'run'}`);
    await o.evidence.log('step.failed', message, { class: cls, stepId: step?.id, expected, observed, evidence: ev });
    // The manifest has to be written on the failure path too. A bundle without
    // one is the bundle nobody can index — and a failed run is precisely the
    // one somebody will come looking for.
    await o.evidence.finish({ status: 'failed', class: cls, message, stepId: step?.id, expected, observed });
    return finish({
      status: 'failed', outputs,
      error: {
        class: cls, message,
        ...(step ? { stepId: step.id, stepIntent: step.intent } : {}),
        ...(expected ? { expected } : {}), ...(observed ? { observed } : {}),
        evidence: ev,
      },
    } as never);
  };

  const escalate = async (
    reason: InterventionReason, diagnosis: { code: string; message: string; expected?: string; observed?: string }, step?: Step,
  ): Promise<{ action: 'resume' | 'complete' | 'abort'; intervention: Intervention } | null> => {
    if (!o.escalation) return null;
    const ev = await captureEvidence(`escalate_${step?.id ?? 'run'}`);
    const i = await o.escalation.broker.raise(reason, {
      runId, kind: 'replay',
      capability: { id: cap.metadata.id, version: cap.metadata.version, title: cap.metadata.title },
      tenant: { id: tenant.id, institution: tenant.institution ?? tenant.id },
      ...(step ? { stepId: step.id, stepIntent: step.intent } : {}),
      diagnosis,
      url: await o.surface.currentUrl().catch(() => ''),
      ...(ev.screenshot ? { screenshotRef: ev.screenshot } : {}),
      ...(ev.snapshot ? { snapshotRef: ev.snapshot } : {}),
      inputs: validation.values,
    });
    await o.evidence.log('escalation.raised', `${reason}: ${diagnosis.message}`, { interventionId: i.id, stepId: step?.id });

    await o.escalation.grantControl(i);
    const resolved = await o.escalation.broker.waitForResolution(i.id);
    await o.escalation.reclaim();

    await o.evidence.log('escalation.control_returned', `Operator resolution: ${resolved.resolution ?? 'none'} — ${resolved.resolutionNote ?? ''}`, {
      interventionId: i.id,
      humanActions: resolved.humanActions.map((h) => `${h.kind}:${h.detail}`).slice(0, 50),
      sessionDelta: resolved.sessionDelta,
    });
    for (const h of resolved.humanActions) {
      await o.evidence.log('escalation.human_action', `${h.kind}: ${h.detail}`, h.at_xy ? { at: h.at_xy } : undefined);
    }

    const action = resolved.resolution === 'completed_by_human' ? 'complete'
      : resolved.resolution === 'resume' ? 'resume' : 'abort';

    const trace: EscalationTrace = {
      interventionId: i.id, reason,
      ...(step ? { atStepId: step.id } : {}),
      ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
      ...(resolved.resolutionNote ? { note: resolved.resolutionNote } : {}),
      humanActions: resolved.humanActions.length,
    };
    escalations.push(trace);
    if (action === 'complete') completedByHuman = trace;

    o.escalation.broker.resolve(i.id, `run ${runId} continued with action "${action}"`);
    return { action, intervention: resolved };
  };

  // ── 3. establish a session ───────────────────────────────────────────────
  if (o.session) {
    const r = await o.session.establish(o.surface, ctx.tenant);
    await o.evidence.log(r.ok ? 'note' : 'step.failed', r.message);
    if (!r.ok) return fail('SESSION_UNRECOVERABLE', `Could not establish an authenticated session: ${r.message}`);
  }

  // ── 4. entry + preconditions ─────────────────────────────────────────────
  let entryUrl: string;
  try { entryUrl = render(cap.target.entry.urlTemplate, ctx); }
  catch (e) { return fail('PRECONDITION_FAILED', `Entry URL template could not be resolved: ${(e as TemplateError).message}`); }

  const entryGate = policy.url(entryUrl, 'entry');
  if (!entryGate.allow) return fail('POLICY_DENIED', entryGate.reason);
  await o.surface.act({ kind: 'navigate', url: entryUrl });

  let snap = await o.surface.snapshot({ settleMs: 150 });
  if (cap.contract.preconditions.length) {
    const pre = evaluateAll(cap.contract.preconditions, snap, ctx);
    if (!pre.held) {
      return fail('PRECONDITION_FAILED',
        `The starting state is not what this capability requires: ${pre.firstFailure?.because ?? pre.firstFailure?.expected}`,
        undefined, pre.firstFailure?.expected, pre.firstFailure?.observed);
    }
  }

  // ── 5. step loop ─────────────────────────────────────────────────────────
  const recoveryAttempts = new Map<string, number>();
  /**
   * Has anything been committed yet?
   *
   * This is what decides whether a flow may be restarted after a session
   * timeout. Replaying read-only steps costs a few seconds; replaying a step
   * that posted a transaction posts it twice.
   */
  let committedSomething = false;

  for (let i = 0; i < cap.flow.steps.length; i++) {
    const step = cap.flow.steps[i] as Step;
    const stepStart = now();
    const trace: StepTrace = {
      stepId: step.id, intent: step.intent, kind: step.kind,
      risk: step.risk ?? 'read_only', status: 'ok', durationMs: 0,
    };

    await o.evidence.log('step.started', step.intent, { stepId: step.id, kind: step.kind, risk: step.risk, authoredBy: step.authoredBy });

    // policy gate
    let resolvedUrl: string | undefined;
    if (step.kind === 'navigate' && step.url) {
      try { resolvedUrl = render(step.url, ctx); }
      catch (e) { return fail('PRECONDITION_FAILED', `Step "${step.id}" URL could not be resolved: ${(e as Error).message}`, step); }
    }
    const gate = policy.step(step, resolvedUrl);
    if (!gate.allow) {
      const esc = await escalate('policy_block', { code: gate.code, message: gate.reason }, step);
      if (esc?.action === 'complete') break;
      if (esc?.action === 'resume') { snap = await o.surface.snapshot({ settleMs: 150 }); continue; }
      return fail('POLICY_DENIED', gate.reason, step);
    }
    execCtx.stepsTaken += 1;
    if ((step.risk ?? 'read_only') !== 'read_only') committedSomething = true;

    // ── resolve + act ──────────────────────────────────────────────────────
    let actionError: { cls: FailureClass; message: string; expected?: string; observed?: string } | null = null;

    if (step.kind === 'navigate') {
      await o.surface.act({ kind: 'navigate', url: resolvedUrl as string });
    } else if (step.kind === 'wait_for') {
      // handled entirely by the checkpoint below
    } else if (step.target) {
      const budget = step.timeoutMs ?? step.target.require?.timeoutMs ?? 10_000;
      const { resolution, snapshot } = await waitForTarget(o.surface, step, ctx, budget, pollMs);
      snap = snapshot;

      if (!resolution.ok) {
        if (step.kind === 'dismiss_if_present' || step.optional) {
          trace.status = 'skipped';
          trace.note = `not present: ${resolution.message}`;
          trace.durationMs = now() - stepStart;
          steps.push(trace);
          await o.evidence.log('step.skipped', `Optional step "${step.id}" skipped — ${resolution.reason}`, { stepId: step.id });
          continue;
        }
        actionError = {
          cls: resolution.reason === 'ambiguous' ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
          message: resolution.message,
          expected: describeTarget(step.target),
          observed: resolution.best.length
            ? `best candidate scored ${resolution.best[0]?.score} (matched: ${resolution.best[0]?.matched.join(', ') || 'nothing'}; missed: ${resolution.best[0]?.missed.join(', ')})`
            : 'no candidates of the required role were present',
        };
      } else {
        targetingScores.push(Math.min(100, resolution.score));
        trace.targeting = {
          score: resolution.score, margin: resolution.margin,
          matched: resolution.matched, missed: resolution.missed,
          candidates: resolution.candidatesConsidered,
        };
        await o.evidence.log('step.resolved', `Resolved ${describeTarget(step.target)} → score ${resolution.score}, margin ${resolution.margin}`, {
          stepId: step.id, matched: resolution.matched, missed: resolution.missed, candidates: resolution.candidatesConsidered,
        });
        // A target that still resolves but has lost its strong evidence is the
        // earliest warning of drift available. Recorded, not fatal.
        if (resolution.missed.some((m) => m.startsWith('name') || m.startsWith('anchor') || m.startsWith('cell.rowWhere'))) {
          await o.evidence.log('note', `Degraded targeting on "${step.id}": semantic evidence missing (${resolution.missed.join(', ')}). The capability still ran, but this is how drift starts.`, { stepId: step.id });
        }

        try {
          switch (step.kind) {
            case 'click':
            case 'dismiss_if_present':
              await o.surface.act({ kind: 'click', ref: resolution.node.ref });
              break;
            case 'fill':
              await o.surface.act({ kind: 'fill', ref: resolution.node.ref, value: render(step.value ?? '', ctx) });
              break;
            case 'select':
              await o.surface.act({ kind: 'select', ref: resolution.node.ref, value: render(step.value ?? '', ctx) });
              break;
            case 'press':
              await o.surface.act({ kind: 'press', ref: resolution.node.ref, key: step.key ?? 'Enter' });
              break;
            case 'extract': {
              const e = step.extract as NonNullable<Step['extract']>;
              const raw = pickSource(resolution.node, e.source, e.attribute);
              const value = coerceOutput(applyRegex(raw, e.regex), e.transform, cap.contract.outputs.find((x) => x.name === e.into)?.type);
              outputs[e.into] = value;
              ctx.output[e.into] = value;
              await o.evidence.log('extract', `Extracted "${e.into}"`, { stepId: step.id, into: e.into, transform: e.transform, value });
              break;
            }
            case 'assert':
              break;
            case 'escalate': {
              const esc = await escalate('risky_action', { code: 'ARTIFACT_ESCALATION', message: step.intent }, step);
              if (esc?.action === 'abort') return fail('SIGNAL_FATAL', `Run aborted by operator at step "${step.id}".`, step);
              break;
            }
          }
        } catch (e) {
          actionError = { cls: 'SURFACE_ERROR', message: `Acting on "${step.id}" failed: ${(e as Error).message}` };
        }
      }
    }

    // ── perceive the result ────────────────────────────────────────────────
    if (step.kind !== 'extract') {
      await sleep(180);
      snap = await o.surface.snapshot({ settleMs: 120 });
    }

    // ── signals: the first match decides what happens next ─────────────────
    const fired = firstSignal(cap.signals, step, snap, ctx);
    if (fired) {
      const disposition = step.onSignal?.[fired.signal.id];
      const kind = disposition === 'ignore' ? null
        : disposition === 'fail' ? 'fatal'
        : disposition === 'escalate' ? 'escalate'
        : disposition === 'recover' ? 'recoverable'
        : fired.signal.kind;

      if (kind) {
        await o.evidence.log('signal.fired', `${fired.signal.title} (${fired.signal.id}) after step "${step.id}"`, {
          kind, observed: fired.outcome.observed, stepId: step.id,
        });

        const captured = capture(fired.signal, snap);

        if (kind === 'business') {
          const decl = cap.contract.outcomes.find((x) => x.code === fired.signal.outcomeCode);
          trace.status = 'ok';
          trace.durationMs = now() - stepStart;
          trace.note = `business outcome ${fired.signal.outcomeCode}`;
          steps.push(trace);
          await o.evidence.finish({ status: 'business_outcome', code: fired.signal.outcomeCode });
          return finish({
            status: 'business_outcome', outputs,
            outcome: {
              code: fired.signal.outcomeCode as string,
              retryable: decl?.retryable ?? false,
              message: decl?.description ?? fired.signal.title,
              data: captured,
            },
          } as never);
        }

        if (kind === 'recoverable') {
          const key = `${step.id}:${fired.signal.id}`;
          const attempt = (recoveryAttempts.get(key) ?? 0) + 1;
          recoveryAttempts.set(key, attempt);
          const plan = fired.signal.recovery;
          const max = plan?.maxAttempts ?? 1;

          if (attempt > max) {
            if (fired.signal.exhaustedOutcomeCode) {
              const decl = cap.contract.outcomes.find((x) => x.code === fired.signal.exhaustedOutcomeCode);
              steps.push({ ...trace, status: 'failed', durationMs: now() - stepStart, note: 'recovery exhausted → business outcome' });
              await o.evidence.finish({ status: 'business_outcome', code: fired.signal.exhaustedOutcomeCode });
              return finish({
                status: 'business_outcome', outputs,
                outcome: {
                  code: fired.signal.exhaustedOutcomeCode,
                  retryable: decl?.retryable ?? true,
                  message: `${decl?.description ?? fired.signal.title} (still present after ${max} attempts)`,
                  data: captured,
                },
              } as never);
            }
            const esc = await escalate('unrecoverable_signal', {
              code: fired.signal.id,
              message: `"${fired.signal.title}" kept recurring; ${max} recovery attempts were exhausted.`,
              observed: fired.outcome.observed,
            }, step);
            if (esc?.action === 'complete') break;
            if (esc?.action === 'resume') { i -= 1; snap = await o.surface.snapshot({ settleMs: 150 }); continue; }
            return fail('RECOVERY_EXHAUSTED', `Recovery for "${fired.signal.id}" exhausted after ${max} attempts.`, step, fired.signal.title, fired.outcome.observed);
          }

          await o.evidence.log('recovery.attempted', `Applying "${plan?.strategy}" for ${fired.signal.id} (attempt ${attempt}/${max})`, { stepId: step.id });
          const ok = await applyRecovery(fired.signal, o, ctx, pollMs);
          recoveries.push({
            signalId: fired.signal.id, signalTitle: fired.signal.title,
            strategy: plan?.strategy ?? 'none', attempts: attempt, succeeded: ok, atStepId: step.id,
          });
          await o.evidence.log(ok ? 'recovery.succeeded' : 'recovery.failed', `Recovery for ${fired.signal.id} ${ok ? 'succeeded' : 'did not clear the condition'}`, { stepId: step.id });

          trace.status = 'recovered';
          trace.durationMs = now() - stepStart;
          steps.push(trace);

          /**
           * Re-authentication is different from every other recovery.
           *
           * Dismissing an interstitial or waiting out a 503 leaves you exactly
           * where you were, so re-running the step is right. Signing in again
           * does not: the core drops you on the home screen with none of the
           * navigation state the flow had built up, so re-running the step in
           * isolation fails on a screen that no longer exists.
           *
           * The flow has to restart — and restarting is only safe while
           * nothing has been committed. Once a step has posted a transaction,
           * replaying the flow would post it twice, so the run escalates
           * instead and a person verifies what actually landed before anyone
           * retries. That is the same call a supervisor makes when a teller's
           * session drops mid-transaction.
           */
          if (plan?.strategy === 'reauthenticate' && ok) {
            if (committedSomething) {
              await o.evidence.log('note',
                'Session expired after a state-changing step. Refusing to restart the flow — a replay would risk posting the transaction twice.');
              const esc = await escalate('unrecoverable_signal', {
                code: 'SESSION_EXPIRED_AFTER_COMMIT',
                message: 'The operator session expired after this capability had already changed state. Restarting would risk a duplicate posting, so a human must confirm what actually posted before this is retried.',
                observed: fired.outcome.observed,
              }, step);
              if (esc?.action === 'complete') break;
              if (esc?.action === 'abort' || !esc) {
                return fail('SESSION_UNRECOVERABLE',
                  'Session expired after a state-changing step; refusing to replay a mutating flow.', step);
              }
            } else {
              await o.evidence.log('note', 'Session re-established. Restarting the flow from the beginning — nothing had been committed, so replaying it is safe.');
              await o.surface.act({ kind: 'navigate', url: entryUrl });
              for (const k of Object.keys(outputs)) { delete outputs[k]; delete ctx.output[k]; }
              snap = await o.surface.snapshot({ settleMs: 150 });
              i = -1;
              continue;
            }
          }

          snap = await o.surface.snapshot({ settleMs: 150 });

          /**
           * Re-run the step only if its purpose is still unmet.
           *
           * Some conditions fire *because* the step worked: clicking through to
           * a member record can raise a BSA/OFAC notice, and once that notice is
           * acknowledged the record is open — the step achieved what it was for.
           * Blindly re-running it then looks for a control that is no longer on
           * screen and fails a run that had actually succeeded.
           *
           * The step's own checkpoint already states what "done" means, so ask
           * it. No checkpoint means nothing to verify, and re-running is the
           * safe default (the validator refuses to save a mutating step without
           * one, so this only ever re-runs read-only work).
           */
          if (step.expect) {
            const after = evaluateAll(step.expect.all, snap, ctx);
            if (after.held) {
              await o.evidence.log('step.checkpoint', `Held after recovery: ${step.expect.description}`, { stepId: step.id });
              continue;   // the step's purpose is met; move on
            }
          }
          i -= 1;
          continue;
        }

        if (kind === 'escalate') {
          const esc = await escalate('unrecoverable_signal', {
            code: fired.signal.id, message: fired.signal.title, observed: fired.outcome.observed,
          }, step);
          if (esc?.action === 'complete') break;
          if (esc?.action === 'resume') { snap = await o.surface.snapshot({ settleMs: 150 }); continue; }
          return fail('SIGNAL_FATAL', `Escalation declined or unavailable for signal "${fired.signal.id}".`, step, fired.signal.title, fired.outcome.observed);
        }

        if (kind === 'fatal') {
          return fail('SIGNAL_FATAL', `Fatal condition "${fired.signal.title}" after step "${step.id}".`, step, fired.signal.title, fired.outcome.observed);
        }
      }
    }

    // ── action error, after signals had their say ──────────────────────────
    if (actionError) {
      const reason: InterventionReason = actionError.cls === 'TARGET_AMBIGUOUS' || actionError.cls === 'TARGET_NOT_FOUND'
        ? 'target_unresolvable' : 'checkpoint_failed';
      const esc = await escalate(reason, {
        code: actionError.cls, message: actionError.message,
        ...(actionError.expected ? { expected: actionError.expected } : {}),
        ...(actionError.observed ? { observed: actionError.observed } : {}),
      }, step);
      if (esc?.action === 'complete') break;
      if (esc?.action === 'resume') { snap = await o.surface.snapshot({ settleMs: 150 }); continue; }
      return fail(actionError.cls, actionError.message, step, actionError.expected, actionError.observed);
    }

    // ── checkpoint ─────────────────────────────────────────────────────────
    if (step.expect) {
      const cp = await waitForCheckpoint(o.surface, step.expect, ctx, pollMs);
      snap = cp.snapshot;
      trace.checkpoint = {
        held: cp.outcome.held,
        description: step.expect.description,
        ...(cp.outcome.firstFailure ? { observed: cp.outcome.firstFailure.observed } : {}),
      };
      await o.evidence.log('step.checkpoint', `${cp.outcome.held ? 'Held' : 'FAILED'}: ${step.expect.description}`, {
        stepId: step.id,
        ...(cp.outcome.firstFailure ? { expected: cp.outcome.firstFailure.expected, observed: cp.outcome.firstFailure.observed } : {}),
      });

      if (!cp.outcome.held) {
        const esc = await escalate('checkpoint_failed', {
          code: 'CHECKPOINT_FAILED',
          message: `Step "${step.id}" ran, but the screen did not become what the capability expects: ${step.expect.description}`,
          ...(cp.outcome.firstFailure ? { expected: cp.outcome.firstFailure.expected, observed: cp.outcome.firstFailure.observed } : {}),
        }, step);
        if (esc?.action === 'complete') break;
        if (esc?.action === 'resume') { snap = await o.surface.snapshot({ settleMs: 150 }); continue; }
        trace.status = 'failed';
        trace.durationMs = now() - stepStart;
        steps.push(trace);
        return fail('CHECKPOINT_FAILED',
          `Step "${step.id}" completed but its checkpoint did not hold: ${step.expect.description}`,
          step, cp.outcome.firstFailure?.expected, cp.outcome.firstFailure?.observed);
      }
    }

    trace.durationMs = now() - stepStart;
    steps.push(trace);
  }

  // ── 6. the definition of done ────────────────────────────────────────────
  const done = await waitForCheckpoint(o.surface, cap.flow.successCheckpoint, ctx, pollMs);
  await o.evidence.log('step.checkpoint', `Success checkpoint ${done.outcome.held ? 'held' : 'FAILED'}: ${cap.flow.successCheckpoint.description}`, {
    ...(done.outcome.firstFailure ? { expected: done.outcome.firstFailure.expected, observed: done.outcome.firstFailure.observed } : {}),
  });

  if (!done.outcome.held) {
    const esc = await escalate('checkpoint_failed', {
      code: 'SUCCESS_CHECKPOINT_FAILED',
      message: `All steps ran, but the capability's success condition does not hold: ${cap.flow.successCheckpoint.description}`,
      ...(done.outcome.firstFailure ? { expected: done.outcome.firstFailure.expected, observed: done.outcome.firstFailure.observed } : {}),
    });
    if (esc?.action !== 'complete') {
      return fail('CHECKPOINT_FAILED',
        `Every step ran, but the success condition does not hold — the flow did not actually achieve its goal: ${cap.flow.successCheckpoint.description}`,
        undefined, done.outcome.firstFailure?.expected, done.outcome.firstFailure?.observed);
    }
  }

  // Outputs the contract declares but no step produced come back as null
  // rather than absent, so a caller's schema validation is stable.
  for (const f of cap.contract.outputs) if (!(f.name in outputs)) outputs[f.name] = null;

  /**
   * If a person finished the job, say so.
   *
   * Returning plain `success` here would be the single most misleading thing
   * this system could do: the caller would record an automated posting that a
   * human actually made, and reconciliation would have no idea. The automation
   * cannot vouch for work it did not do.
   */
  if (completedByHuman) {
    const e: EscalationTrace = completedByHuman;
    await o.evidence.finish({ status: 'escalated', resolution: e.resolution, outputs });
    return finish({
      status: 'escalated', outputs,
      intervention: {
        id: e.interventionId, reason: e.reason,
        ...(e.resolution ? { resolution: e.resolution } : {}),
        ...(e.note ? { note: e.note } : {}),
        humanActions: e.humanActions,
      },
    } as never);
  }

  await o.evidence.finish({ status: 'success', outputs });
  return finish({ status: 'success', outputs } as never);
}

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a condition, never for a duration.
 *
 * Re-perceives on an interval until the target resolves or the budget expires.
 * Legacy servers are slow and erratic; a fixed sleep that works on a developer
 * laptop is exactly the kind of flake that makes people distrust automation.
 */
async function waitForTarget(
  surface: Surface, step: Step, ctx: TemplateContext, budgetMs: number, pollMs: number,
): Promise<{ resolution: Resolution; snapshot: Snapshot }> {
  const deadline = now() + budgetMs;
  let snapshot = await surface.snapshot({ settleMs: 80 });
  let resolution = resolveTarget(step.target as NonNullable<Step['target']>, snapshot, { ctx });
  while (!resolution.ok && now() < deadline) {
    await sleep(pollMs);
    snapshot = await surface.snapshot({ settleMs: 80 });
    resolution = resolveTarget(step.target as NonNullable<Step['target']>, snapshot, { ctx });
  }
  return { resolution, snapshot };
}

async function waitForCheckpoint(
  surface: Surface, cp: Checkpoint, ctx: TemplateContext, pollMs: number,
): Promise<{ outcome: ReturnType<typeof evaluateAll>; snapshot: Snapshot }> {
  const deadline = now() + cp.timeoutMs;
  let snapshot = await surface.snapshot({ settleMs: 80 });
  let outcome = evaluateAll(cp.all, snapshot, ctx);
  while (!outcome.held && now() < deadline) {
    await sleep(pollMs);
    snapshot = await surface.snapshot({ settleMs: 80 });
    outcome = evaluateAll(cp.all, snapshot, ctx);
  }
  // Defeat the flash of a transitional screen: require the condition to still
  // hold after a beat, for checkpoints that asked for it.
  if (outcome.held && cp.stableForMs > 0) {
    await sleep(cp.stableForMs);
    snapshot = await surface.snapshot({ settleMs: 40 });
    outcome = evaluateAll(cp.all, snapshot, ctx);
  }
  return { outcome, snapshot };
}

function firstSignal(signals: Signal[], step: Step, snap: Snapshot, ctx: TemplateContext) {
  for (const signal of signals) {
    if (signal.exceptStepIds?.includes(step.id)) continue;
    if (step.onSignal?.[signal.id] === 'ignore') continue;
    const outcome = evaluateAny(signal.detect, snap, ctx);
    if (outcome) return { signal, outcome };
  }
  return null;
}

function capture(signal: Signal, snap: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = Object.values(snap.frameTexts).join('\n');
  for (const c of signal.capture ?? []) {
    try {
      const m = text.match(new RegExp(c.regex, 'i'));
      if (m) out[c.name] = (m[1] ?? m[0]).replace(/\s+/g, ' ').trim();
    } catch { /* a bad capture regex must not take down the run */ }
  }
  return out;
}

async function applyRecovery(signal: Signal, o: ReplayOptions, ctx: TemplateContext, pollMs: number): Promise<boolean> {
  const plan = signal.recovery;
  if (!plan) return false;

  switch (plan.strategy) {
    case 'wait_and_retry':
      await sleep(plan.backoffMs);
      return true;

    case 'retry_step':
      return true;

    case 'reauthenticate': {
      if (!o.session) return false;
      const r = await o.session.reauthenticate(o.surface, ctx.tenant as Record<string, string>);
      return r.ok;
    }

    case 'run_steps': {
      for (const s of plan.steps ?? []) {
        if (!s.target) continue;
        const { resolution } = await waitForTarget(o.surface, s, ctx, s.timeoutMs ?? 6_000, pollMs);
        if (!resolution.ok) return false;
        if (s.kind === 'click') await o.surface.act({ kind: 'click', ref: resolution.node.ref });
        else if (s.kind === 'fill') await o.surface.act({ kind: 'fill', ref: resolution.node.ref, value: render(s.value ?? '', ctx) });
        await sleep(250);
      }
      return true;
    }

    case 'restart_flow':
      return false;

    default:
      return false;
  }
}

function pickSource(node: { value?: string; text?: string; name: string; raw?: { attrs?: Record<string, string> } }, source: string, attribute?: string): string {
  switch (source) {
    case 'value': return node.value ?? node.text ?? '';
    case 'text': case 'cell': return node.text ?? node.value ?? node.name ?? '';
    case 'href': return node.raw?.attrs?.href ?? '';
    case 'attribute': return attribute ? (node.raw?.attrs?.[attribute] ?? '') : '';
    default: return node.text ?? '';
  }
}

function applyRegex(raw: string, re?: string): string {
  if (!re) return raw;
  try { const m = raw.match(new RegExp(re)); return m ? (m[1] ?? m[0]) : raw; } catch { return raw; }
}
