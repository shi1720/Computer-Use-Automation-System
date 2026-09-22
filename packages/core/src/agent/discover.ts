/**
 * Discovery: the one place a model is in the loop.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Observe → decide → act, against a live application, until the goal is met or
 * a stopping condition fires. What makes this different from a generic browser
 * agent is what happens on the way out: every action the model takes is
 * converted, deterministically, into a step of a typed capability artifact —
 * with a durable target descriptor, a parameterised value, a checkpoint, and a
 * risk classification that the model does not get a vote on.
 *
 * The division of labour is the point:
 *
 *   the model decides   which control, in which order, and why
 *   Swivel decides      how that control is described, what counts as proof the
 *                       step worked, how risky it was, and which values are
 *                       parameters
 *
 * So two discovery runs that take the same path produce byte-identical
 * artifacts, and a weaker model produces a *shorter* artifact rather than a
 * more fragile one.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Assertion, Capability, FieldDef, Signal, Step } from '../artifact/schema.js';
import { API_VERSION } from '../artifact/schema.js';
import { withContentHash } from '../artifact/hash.js';
import { validateCapability, type Finding } from '../artifact/validate.js';
import { emptyContext, type TemplateContext } from '../artifact/template.js';
import type { Snapshot, UiNode } from '../surface/types.js';
import type { WebSurface } from '../surface/web.js';
import { buildDigest, readableValues, screenMessages } from './digest.js';
import { generaliseOutputName, looksLikeData, synthesiseTarget, templatise, templatiseUrl, type SynthesisContext } from './descriptor.js';
import { DISCOVERY_TOOLS, discoverySystemPrompt } from './prompt.js';
import { addUsage, emptyUsage, estimateCostUsd, type LlmMessage, type LlmProvider, type LlmUsage } from './llm.js';
import { classifyRisk, PolicyEngine, type ExecutionContext } from '../policy/policy.js';
import { getProductProfile } from '../signals/profiles.js';
import { evaluateAny } from '../replay/assertions.js';
import { scrubProse, sentenceLeaksRunData } from './prose.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';

export const SWIVEL_VERSION = '1.0.0';

export interface DiscoveryParameter extends FieldDef { value: string }

export interface DiscoveryRequest {
  goal: string;
  capabilityId: string;
  title: string;
  productProfileId: string;
  tenant: { id: string; institution: string; baseUrl: string; productVersion?: string; vocabulary?: Record<string, string> };
  /** Where the flow starts, after the session provider has signed in. */
  entryUrl: string;
  parameters: DiscoveryParameter[];
  policy: { allowedOrigins: string[]; allowedPathPatterns: string[]; allowedActions: Step['kind'][] };
  maxTurns?: number;
  maxDurationMs?: number;
  /** Permits the model to complete state-changing actions. Absent = read-only. */
  confirmationToken?: string;
  owner?: string;
}

export interface DiscoveryResult {
  status: 'success' | 'escalated' | 'failed';
  capability?: Capability;
  findings: Finding[];
  message: string;
  turns: number;
  usage: LlmUsage;
  costUsd: number;
  interventionId?: string;
}

interface RecordedStep { step: Step; snapshotBefore: Snapshot }

export interface DiscoveryDeps {
  surface: WebSurface;
  llm: LlmProvider;
  evidence: EvidenceRecorder;
  /**
   * Called when the run wants a human — wired by the CLI or console.
   *
   * Discovery escalates by *asking* rather than by handing over the session.
   * It is read-only by construction (`policy.allowedActions` excludes every
   * mutating kind, and `PolicyEngine.step` enforces it), so there is nothing
   * mid-flight for an operator to take the wheel of: the useful answer is
   * "carry on" or "stop", and a person who wants to drive can run the surface
   * themselves. Replay is the path where control actually transfers, and it
   * takes a broker and a lease manager for exactly that reason.
   */
  onEscalate?: (reason: string, diagnosis: { code: string; message: string }) => Promise<'resume' | 'abort'>;
}

export async function discover(req: DiscoveryRequest, deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const { surface, llm, evidence } = deps;
  const profile = getProductProfile(req.productProfileId);
  if (!profile) throw new Error(`Unknown product profile "${req.productProfileId}". Register it in signals/profiles.ts.`);

  const vocabulary = { ...profile.vocabulary, ...(req.tenant.vocabulary ?? {}) };
  const parameters = Object.fromEntries(req.parameters.map((p) => [p.name, p.value]));
  const synth: SynthesisContext = {
    parameters, vocabulary, baseUrl: req.tenant.baseUrl, usedIds: new Set(),
    ...(req.tenant.institution ? { institution: req.tenant.institution } : {}),
  };

  const ctx: TemplateContext = {
    ...emptyContext(),
    input: parameters,
    vocab: vocabulary,
    tenant: { baseUrl: req.tenant.baseUrl, tenantId: req.tenant.id, institution: req.tenant.institution },
  };

  // A provisional capability so the policy engine has something to enforce
  // against from turn one. Discovery is the moment the allowlist matters most:
  // it is the only time a model chooses where to go.
  const execCtx: ExecutionContext = {
    principal: { id: req.owner ?? 'discovery', kind: 'human', roles: ['capability.author'] },
    ...(req.confirmationToken ? { confirmationToken: req.confirmationToken } : {}),
    unattended: false,
    startedAt: Date.now(),
    stepsTaken: 0,
  };
  const provisional = skeletonCapability(req, profile.outcomes, profile.signals, vocabulary);
  const policy = new PolicyEngine(provisional, execCtx);

  const maxTurns = req.maxTurns ?? 22;
  const deadline = Date.now() + (req.maxDurationMs ?? 8 * 60_000);

  const messages: LlmMessage[] = [];
  const recorded: RecordedStep[] = [];
  const outputs: FieldDef[] = [];
  let usage = emptyUsage();
  let turns = 0;
  let finished: { summary: string; success_text: string; assertions?: Assertion[]; caveats?: string; awaitsSecondApproval?: boolean } | null = null;
  let escalatedReason: string | null = null;

  const system = discoverySystemPrompt({
    goal: req.goal,
    institution: req.tenant.institution,
    product: profile.product,
    vocabulary,
    parameters: req.parameters.map((p) => ({ name: p.name, value: p.value, description: p.description })),
    allowRisky: Boolean(req.confirmationToken),
  });

  await evidence.log('run.started', `Discovery run for "${req.goal}"`, {
    capabilityId: req.capabilityId, tenant: req.tenant.id, provider: llm.name, model: llm.model,
  });

  // ── the entry navigation is itself a policed, recorded step ───────────────
  const entryUrl = req.entryUrl;
  const entryDecision = policy.url(entryUrl, 'entry');
  if (!entryDecision.allow) {
    await evidence.log('policy.decision', `Entry URL refused: ${entryDecision.reason}`, { code: entryDecision.code });
    return { status: 'failed', findings: [], message: entryDecision.reason, turns: 0, usage, costUsd: 0 };
  }
  await surface.act({ kind: 'navigate', url: entryUrl });

  let snap = await surface.snapshot({ settleMs: 200 });
  await evidence.snapshot('000_entry', snap);

  while (turns < maxTurns && Date.now() < deadline && !finished && !escalatedReason) {
    turns += 1;
    const { text: digest, index } = buildDigest(snap);

    messages.push({
      role: 'user',
      content: [{ type: 'text', text: turns === 1 ? `Here is the starting screen.\n\n${digest}` : digest }],
    });

    // A single failed model call — a timeout, a transient provider error — must
    // not throw away a run that has already driven ten screens. One retry, then
    // the run ends cleanly with whatever it has.
    let res;
    try {
      res = await llm.complete({ system, messages, tools: DISCOVERY_TOOLS as never, effort: 'high' });
    } catch (e) {
      await evidence.log('note', `Model call failed on turn ${turns}: ${(e as Error).message}. Retrying once.`);
      try {
        res = await llm.complete({ system, messages, tools: DISCOVERY_TOOLS as never, effort: 'high' });
      } catch (e2) {
        await evidence.log('step.failed', `Model unavailable after a retry: ${(e2 as Error).message}`);
        escalatedReason = `The model became unavailable mid-discovery: ${(e2 as Error).message}`;
        break;
      }
    }
    usage = addUsage(usage, res.usage);

    /**
     * What the model said it was doing, for the transcript.
     *
     * Not every model narrates. A reasoning model keeps its chain of thought in
     * reasoning items the API does not return as text, so `res.text` is often
     * empty and the transcript would read "(no narration)" for the whole run —
     * which makes the one artefact meant to show *why* the model did what it
     * did useless precisely when the model thought hardest.
     *
     * The tool call's own `intent` is the honest fallback. It is the model's
     * sentence about this action, written for a human reviewer, and it is the
     * same text that ends up on the step.
     */
    const narration = res.text?.trim()
      || res.toolCalls.map((t) => String(t.input?.intent ?? '')).filter(Boolean).join(' ')
      || '(no narration)';

    await evidence.log('model.turn', narration, {
      turn: turns,
      toolCalls: res.toolCalls.map((t) => t.name),
      usage: res.usage,
    });

    if (!res.toolCalls.length) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: res.text || '(no action)' }] });
      messages.push({ role: 'user', content: [{ type: 'text', text: 'You did not call a tool. Call exactly one tool now, or call `escalate` if you are stuck.' }] });
      continue;
    }

    const call = res.toolCalls[0] as { id: string; name: string; input: Record<string, unknown> };
    messages.push({
      role: 'assistant',
      content: [
        ...(res.text ? [{ type: 'text' as const, text: res.text }] : []),
        { type: 'tool_use', id: call.id, name: call.name, input: call.input },
      ],
    });

    const reply = (content: string, isError = false) =>
      messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content, isError }] });

    // ── terminal tools ──────────────────────────────────────────────────────
    if (call.name === 'finish') {
      // The success condition is the one assertion every future run depends on,
      // so it is verified here rather than trusted. Models routinely nominate
      // text that is not on the screen; a capability whose success checkpoint
      // asserts a fiction fails every replay for a reason nobody can see.
      const proposed = typeof call.input.success_text === 'string' ? call.input.success_text.trim() : '';
      const screen = Object.values(snap.frameTexts).join('\n').replace(/\s+/g, ' ').toLowerCase();
      const values = readableValues(snap, 250).map((n) => (n.text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
      const normalised = proposed.replace(/\s+/g, ' ').toLowerCase();
      const present = proposed.length > 0 && screen.includes(normalised)
        && !values.some((v) => v.includes(normalised) || normalised.includes(v))
        && !looksLikeData(proposed);
      if (!present) {
        await evidence.log('note',
          proposed
            ? `Model proposed success text "${proposed}", which is not on the final screen. Deriving the success condition from the screen instead.`
            : 'Model finished without proposing success text. Deriving the success condition from the screen.');
      }
      // The model narrates what it just saw, which means its summary and
      // caveats routinely contain this member's name and this run's balances.
      // That prose is published to every calling agent and shared across every
      // institution using this capability, so it is scrubbed here rather than
      // trusted.
      const forbidden = [
        ...Object.values(parameters).filter((v) => String(v).length >= 3).map(String),
        ...readableValues(snap, 250).map((n) => (n.text ?? '').trim()).filter((t) => t.length >= 3),
      ];
      // The summary and caveats go through `templatise` first, so the
      // institution's name becomes `{{tenant.institution}}` rather than being
      // dropped — a sentence that explains what the capability does is worth
      // keeping, and only the tenant-specific part of it is the problem.
      const portable = (prose: string | undefined): string | undefined =>
        prose === undefined ? undefined : templatise(prose, synth, { vocabWholeString: false });
      const scrub = (prose: string | undefined, label: string): string | undefined =>
        scrubProse(portable(prose), forbidden, () => {
          void evidence.log('note', `Removed a sentence from the capability's ${label}: it described this run's data rather than what the capability does.`);
        });

      finished = {
        // Falling back to the operator's goal is right — it is the best
        // one-line description of what this capability does — but the goal is
        // written about one member ("look up member 0100482…"). Templatising it
        // turns it into a description of the capability rather than of the run.
        summary: scrub(String(call.input.summary ?? ''), 'summary')
          ?? templatise(req.goal, synth, { vocabWords: true }),
        success_text: present ? proposed : deriveSuccessText(snap, synth),
        assertions: successAssertions(snap, present ? proposed : undefined, synth),
        ...(typeof call.input.caveats === 'string'
          ? (() => { const c = scrub(call.input.caveats as string, 'caveats'); return c ? { caveats: c } : {}; })()
          : {}),
        ...(call.input.awaits_second_approval === true ? { awaitsSecondApproval: true } : {}),
      };
      reply('Recorded. Assembling the capability artifact.');
      break;
    }
    if (call.name === 'escalate') {
      escalatedReason = String(call.input.reason ?? 'model requested human assistance');
      reply('Escalation raised.');
      break;
    }

    // ── resolve the chosen control ──────────────────────────────────────────
    let node: UiNode | undefined;
    if (call.name !== 'navigate') {
      const ref = String(call.input.ref ?? '');
      node = index.get(ref);
      if (!node) {
        await evidence.log('model.action_blocked', `Model referenced unknown control "${ref}"`, { turn: turns });
        reply(`There is no control with handle "${ref}" on this screen. Re-read the digest and pick one of the listed handles.`, true);
        continue;
      }
    }

    const intent = String(call.input.intent ?? call.name);
    const targetName = node?.name || node?.text || '';
    const allText = Object.values(snap.frameTexts).join('\n');
    const risk = classifyRisk(call.name, targetName, allText, {
      role: node?.role,
      ...(node?.raw?.attrs?._formMethod ? { formMethod: node.raw.attrs._formMethod } : {}),
      ...(node?.raw?.inputType ? { inputType: node.raw.inputType } : {}),
      // A WebForms grid action link is `javascript:__doPostBack(...)` — it has
      // the role of a link and the effect of a submit. The href is how the two
      // are told apart.
      ...(node?.raw?.attrs?.href !== undefined ? { href: node.raw.attrs.href } : {}),
      ...(call.name === 'press' && call.input.key ? { key: String(call.input.key) } : {}),
      ...(call.name === 'navigate' && call.input.url ? { url: String(call.input.url) } : {}),
    });

    const urlArg = call.name === 'navigate' ? String(call.input.url ?? '') : undefined;
    const gate = policy.discoveryAction(call.name, urlArg, risk, `turn${turns}`);
    if (!gate.allow) {
      await evidence.log('model.action_blocked', gate.reason, { code: gate.code, action: call.name, risk, turn: turns });
      reply(`BLOCKED BY POLICY (${gate.code}): ${gate.reason}\nChoose a different approach, or call \`escalate\`.`, true);
      continue;
    }

    // ── act ─────────────────────────────────────────────────────────────────
    await evidence.log('step.started', intent, { turn: turns, action: call.name, risk });
    const before = snap;
    try {
      switch (call.name) {
        case 'click': await surface.act({ kind: 'click', ref: (node as UiNode).ref }); break;
        case 'fill': await surface.act({ kind: 'fill', ref: (node as UiNode).ref, value: String(call.input.value ?? '') }); break;
        case 'select': await surface.act({ kind: 'select', ref: (node as UiNode).ref, value: String(call.input.value ?? '') }); break;
        case 'navigate': await surface.act({ kind: 'navigate', url: urlArg as string }); break;
        case 'extract': break; // read-only; handled below
        default:
          reply(`Unknown tool "${call.name}".`, true);
          continue;
      }
    } catch (e) {
      await evidence.log('step.failed', `Action failed: ${(e as Error).message}`, { turn: turns });
      reply(`That action failed: ${(e as Error).message}. Try a different control.`, true);
      continue;
    }

    execCtx.stepsTaken += 1;
    if (call.name !== 'extract') {
      await new Promise((r) => setTimeout(r, 350));
      snap = await surface.snapshot({ settleMs: 200 });
      await evidence.snapshot(`${String(turns).padStart(3, '0')}_${call.name}`, snap);
    }

    // ── record the step as a durable artifact fragment ──────────────────────
    const step = buildStep(call, node, before, snap, synth, intent, risk, outputs);
    if (step) {
      recorded.push({ step, snapshotBefore: before });
      await evidence.log('step.acted', `Recorded step "${step.id}": ${step.intent}`, {
        target: step.target?.id, targetNote: step.target?.note, risk: step.risk,
        checkpoint: step.expect?.description,
      });
    }

    // ── tell the model what the screen is saying ────────────────────────────
    const fired = detectProfileSignal(profile.signals, snap, ctx);
    const msgs = screenMessages(snap);
    let feedback = call.name === 'extract'
      ? `Recorded output "${String(call.input.output_name)}" = ${JSON.stringify(readValue(node as UiNode, String(call.input.transform ?? 'none')))}.`
      : 'Action completed.';
    if (fired) {
      feedback += `\n\nThe system raised a known condition: ${fired.signal.title} (${fired.signal.kind}). Detected: ${fired.outcome.observed}`;
      await evidence.log('signal.fired', `${fired.signal.id} during discovery`, { kind: fired.signal.kind, turn: turns });
    }
    if (msgs.length) feedback += `\n\nScreen messages now showing:\n${msgs.map((m) => `  ! ${m}`).join('\n')}`;
    if (step?.expect) feedback += `\n\nCheckpoint recorded for this step: ${step.expect.description}`;
    if (call.name !== 'extract') feedback += `\n\n(The next screen digest follows.)`;
    reply(feedback);
  }

  // ── outcome ─────────────────────────────────────────────────────────────
  const costUsd = estimateCostUsd(llm.model, usage);

  if (escalatedReason) {
    await evidence.log('escalation.raised', escalatedReason, { runId: evidence.dir });
    const decision = await deps.onEscalate?.(escalatedReason, { code: 'discovery_stuck', message: escalatedReason });
    return {
      status: 'escalated',
      findings: [],
      message: `Discovery escalated to a human operator: ${escalatedReason}${decision ? ` (operator chose to ${decision})` : ''}`,
      turns, usage, costUsd,
    };
  }

  if (!finished) {
    const why = turns >= maxTurns ? `turn budget of ${maxTurns} exhausted` : 'time budget exhausted';
    await evidence.log('run.finished', `Discovery did not reach the goal: ${why}`);
    return { status: 'failed', findings: [], message: `Discovery did not reach the goal (${why}). ${recorded.length} steps were recorded before stopping.`, turns, usage, costUsd };
  }

  /**
   * The conversation that produced this artifact, written once, in order.
   *
   * Tied to the capability by digest rather than embedded in it: an artifact
   * outlives the model that wrote it, and carrying a model's output around
   * forever makes the document harder to review and no more trustworthy.
   */
  const { sha256: transcriptSha256 } = await evidence.transcript(
    messages.map((m) => ({
      role: m.role,
      content: m.content.map((c) =>
        c.type === 'text' ? { type: 'text', text: c.text }
        : c.type === 'tool_use' ? { type: 'tool_use', name: c.name, input: c.input }
        : { type: 'tool_result', content: c.content, ...(c.isError ? { isError: true } : {}) }),
    })),
  );

  const capability = assembleCapability({
    req, profile, vocabulary, outputs,
    steps: recorded.map((r) => r.step),
    finish: finished,
    llm: { provider: llm.name, model: llm.model },
    synth,
    transcriptSha256,
    // The frames that existed on the entry screen. Replay checks them before
    // step 1, so a build with a different frameset fails saying *that* rather
    // than failing four steps later on a control it cannot find.
    entryFrames: (recorded[0]?.snapshotBefore ?? (await surface.snapshot({ settleMs: 80 })))
      .frames.map((f) => f.join('/')).filter(Boolean),
  });

  const findings = validateCapability(capability);
  await evidence.log('artifact.emitted', `Capability ${capability.metadata.id}@${capability.metadata.version} assembled`, {
    steps: capability.flow.steps.length,
    outputs: capability.contract.outputs.map((o) => o.name),
    contentHash: capability.contentHash,
    findings: findings.map((f) => `${f.severity}:${f.code}`),
  });

  return {
    status: 'success',
    capability,
    findings,
    message: `Discovered a ${capability.flow.steps.length}-step capability in ${turns} model turns.`,
    turns, usage, costUsd,
  };
}

// ── step construction ────────────────────────────────────────────────────────

function readValue(node: UiNode, transform: string): string {
  const raw = (node.value ?? node.text ?? node.name ?? '').trim();
  switch (transform) {
    case 'money_to_number': return raw.replace(/[(),$\s]/g, '').replace(/^-?/, raw.startsWith('(') ? '-' : '');
    case 'digits_only': return raw.replace(/\D/g, '');
    case 'upper': return raw.toUpperCase();
    case 'lower': return raw.toLowerCase();
    default: return raw;
  }
}

/**
 * Synthesise a checkpoint proving the step did something.
 *
 * Preference order matters. The model's own `expect_text` is used only if it is
 * actually on the resulting screen — models routinely predict text that never
 * appears, and a checkpoint that asserts a fiction fails every replay. The
 * fallbacks are screen identity, not content: legacy cores stamp a screen code
 * on every page, and that is both stable across runs and meaningless to leak.
 */
function synthesiseCheckpoint(
  before: Snapshot, after: Snapshot, modelText: string | undefined, synth: SynthesisContext, stepId: string,
): Step['expect'] | undefined {
  const afterText = Object.values(after.frameTexts).join('\n');
  const beforeText = Object.values(before.frameTexts).join('\n');
  const flat = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

  const containsParameter = (s: string) =>
    Object.values(synth.parameters).some((v) => v && String(v).length > 2 && s.includes(String(v)));

  /**
   * A checkpoint must not assert data.
   *
   * Models reach for the most salient thing on the screen, which is usually the
   * member's name or a balance. Both are correct once and wrong forever: the
   * next invocation is for a different member. So any candidate that matches a
   * value the screen is *displaying as data* is rejected in favour of screen
   * identity — which also keeps member data out of the artifact entirely.
   */
  const screenValues = readableValues(after, 250).map((n) => flat(n.text ?? '')).filter(Boolean);
  /** Overlapping a displayed value in either direction is enough to disqualify. */
  const touchesDisplayedData = (s: string) => {
    const f = flat(s);
    if (f.length < 3) return true;
    return screenValues.some((v) => v.includes(f) || f.includes(v));
  };

  /**
   * A checkpoint has to discriminate.
   *
   * Text that was already on the screen before the step proves nothing: the
   * step could have done nothing at all and the assertion would still hold.
   * This is the difference between "the click worked" and "the page never
   * changed", which is the whole reason checkpoints exist.
   */
  const discriminates = (s: string) => !flat(beforeText).includes(flat(s));

  if (modelText && modelText.length <= 120 && flat(afterText).includes(flat(modelText))
      && !containsParameter(modelText) && !touchesDisplayedData(modelText)
      && !looksLikeData(modelText) && discriminates(modelText)) {
    return {
      id: `${stepId}_ok`,
      description: `Screen shows "${modelText}"`,
      all: [{ kind: 'text_present', text: templatise(modelText, synth, { vocabWords: true }), because: 'the model nominated this as proof the step worked, and it was verified present during discovery' }],
      timeoutMs: 15_000,
      stableForMs: 0,
    };
  }

  // Screen identifier — the most stable thing a legacy core puts on a page.
  const codes = [...afterText.matchAll(/SCREEN\s+([A-Z]{2,4}-\d{3,4})/g)].map((m) => m[1] as string);
  const beforeCodes = new Set([...beforeText.matchAll(/SCREEN\s+([A-Z]{2,4}-\d{3,4})/g)].map((m) => m[1] as string));
  const newCode = codes.find((c) => !beforeCodes.has(c)) ?? codes[0];
  if (newCode) {
    return {
      id: `${stepId}_ok`,
      description: `Reached screen ${newCode}`,
      all: [{ kind: 'text_present', regex: `SCREEN\\s+${newCode}`, because: 'the core stamps a screen identifier on every page; it is stable across runs and carries no member data' }],
      timeoutMs: 15_000,
      stableForMs: 0,
    };
  }

  /**
   * Last resort: the page title changed.
   *
   * It goes through exactly the same guards as the model's own proposal, and
   * for the same reason. A title is not inherently safe — plenty of cores stamp
   * record context into it ("Account Inquiry - 0100482"), and baking that into
   * a checkpoint pins the capability to one member and fails every subsequent
   * replay for a reason nobody can see from the artifact. MERIDIAN's titles
   * happen to be `institution - screen`, which is fine; relying on that being
   * true of the next vendor is not a position worth holding.
   */
  const titleTail = after.title && after.title !== before.title
    ? (after.title.split(' - ').pop() ?? after.title).trim()
    : '';
  if (titleTail && !containsParameter(titleTail) && !touchesDisplayedData(titleTail)
      && !looksLikeData(titleTail) && discriminates(titleTail)) {
    return {
      id: `${stepId}_ok`,
      description: `Page title becomes "${titleTail}"`,
      all: [{ kind: 'text_present', text: templatise(titleTail, synth, { vocabWords: true }), because: 'the screen changed to a different page after this action' }],
      timeoutMs: 15_000,
      stableForMs: 0,
    };
  }

  // Nothing on this screen can be asserted without asserting data. Returning
  // nothing is the honest answer: the validator will flag a mutating step with
  // no checkpoint as an error, which is a problem a reviewer can see and act
  // on, unlike a checkpoint that quietly encodes one member's name.
  return undefined;
}

function buildStep(
  call: { name: string; input: Record<string, unknown> },
  node: UiNode | undefined,
  before: Snapshot,
  after: Snapshot,
  synth: SynthesisContext,
  rawIntent: string,
  risk: ReturnType<typeof classifyRisk>,
  outputs: FieldDef[],
): Step | null {
  // Step ids are read by humans in change tickets, so they are derived from the
  // control's *meaning* (its name, or the caption a person reads beside it) —
  // the same derivation the target descriptor uses — never from a generated
  // control id like ctl00_Main_txtMemberNo.
  const rowMatch = typeof call.input.row_match === 'string' ? call.input.row_match : undefined;
  const target = node ? synthesiseTarget(node, before, synth, rowMatch ? { rowMatch } : undefined) : undefined;
  // Extract steps are named for what they produce; everything else for what it
  // operates on. Both read better in a change ticket than a control id does.
  // The model names outputs after what it is looking at, which bakes this run's
  // parameters into the artifact's public interface — and into the step id,
  // which a tenant overlay then has to patch by name. See
  // `generaliseOutputName`.
  const outputName = call.name === 'extract'
    ? generaliseOutputName(String(call.input.output_name ?? 'value'), synth)
    : undefined;
  const stepId = uniqueStepId(
    outputName ? `extract_${outputName}` : `${call.name}_${target?.id ?? 'screen'}`,
    synth.usedIds,
  );

  const intent = safeIntent(rawIntent, call, target, before, synth);

  if (call.name === 'navigate') {
    return {
      id: stepId, intent, kind: 'navigate',
      url: templatiseUrl(String(call.input.url ?? ''), synth),
      // The classifier's answer, not a hardcoded 'low'. Legacy cores commit on
      // GET routinely — `…/fee-reversal?confirm=1` is a real shape — and
      // discarding the classification here was how such a step got recorded as
      // harmless, which then propagated to the capability's own risk class.
      risk,
      expect: synthesiseCheckpoint(before, after, undefined, synth, stepId),
      authoredBy: 'model',
      note: 'Direct navigation. Prefer clicking through the application where possible; recorded URLs are more sensitive to routing changes than recorded controls.',
    };
  }

  if (!node || !target) return null;

  if (call.name === 'extract') {
    const name = outputName as string;
    const transform = String(call.input.transform ?? 'none') as never;
    if (!outputs.some((o) => o.name === name)) {
      outputs.push({
        name,
        // A balance is money; a member name is PII. Classifying here means the
        // redactor knows what to do with it in every future run's evidence.
        type: transform === 'money_to_number' ? 'money' : 'string',
        description: String(call.input.description ?? name),
        sensitivity: transform === 'money_to_number' ? 'sensitive' : 'internal',
        required: false,
      });
    }
    return {
      id: stepId, intent, kind: 'extract', target, risk: 'read_only',
      extract: { into: name, source: node.value !== undefined && node.value !== '' ? 'value' : 'text', transform },
      authoredBy: 'model',
    };
  }

  if (call.name === 'fill' || call.name === 'select') {
    return {
      id: stepId, intent, kind: call.name, target,
      value: templatise(String(call.input.value ?? ''), synth, { vocabWholeString: false }),
      risk,
      authoredBy: 'model',
    };
  }

  // click
  return {
    id: stepId, intent, kind: 'click', target, risk,
    expect: synthesiseCheckpoint(before, after, call.input.expect_text ? String(call.input.expect_text) : undefined, synth, stepId),
    authoredBy: 'model',
  };
}

function uniqueStepId(rawBase: string, used: Set<string>): string {
  // Step ids are part of the artifact's public surface — overlays reference
  // them by name — so they are normalised to one shape rather than whatever
  // casing the output field happened to use.
  const base = rawBase.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'step';
  let id = base, i = 2;
  while (used.has(`step:${id}`)) id = `${base}_${i++}`;
  used.add(`step:${id}`);
  return id;
}

/**
 * Fall back to screen identity when the model cannot nominate stable success
 * text. A screen code is the most durable thing on a legacy page and leaks no
 * member data; the page title is the next best thing.
 */
/**
 * Assertions for the capability's success condition.
 *
 * Two independent facts where possible: the screen identifier the core stamps
 * on every page, and the distinctive phrase the model nominated (already
 * verified present and non-data). Asserting both is more robust and more
 * reviewable than either alone — an approver reads "reached screen SVC-0629
 * and the screen says ACCOUNT OPENED SUCCESSFULLY" and knows exactly what was
 * checked.
 */
/**
 * A step's intent, fit to ship.
 *
 * The intent is prose in a shared artifact: it is what a reviewer reads in a
 * change ticket, what the console shows, and what an operator sees on an
 * escalation ticket at every institution that adopts this capability. The
 * model writes it as a description of what it just did — "Enter the member
 * number 0100482", "View the full record for Dolores Whitfield" — which is
 * accurate about this run and wrong for the artifact twice over: it carries a
 * member's data, and it describes one invocation rather than the step.
 *
 * Templatising fixes most of it: parameters and vocabulary become placeholders,
 * so "enter 0100482" becomes "enter {{input.memberNumber}}", which is both
 * safer and more useful to anyone reading the capability.
 *
 * What templatising cannot fix is a value the model read off the screen — a
 * member's name is nobody's parameter. So the result is held to the same test
 * as the summary, and an intent that still describes this run is replaced with
 * one derived from the step itself. A blander sentence is a small price.
 */
function safeIntent(
  raw: string,
  call: { name: string; input: Record<string, unknown> },
  target: Step['target'] | undefined,
  screen: Snapshot,
  synth: SynthesisContext,
): string {
  const templated = templatise(raw, synth, { vocabWords: true });
  const forbidden = readableValues(screen, 250).map((n) => (n.text ?? '').trim()).filter((t) => t.length >= 3);
  if (!sentenceLeaksRunData(templated, forbidden)) return templated;

  // The descriptor already says, precisely and portably, what this step acts
  // on — that is its whole job. Reusing it is how the fallback stays useful
  // prose rather than "Activate View."
  const named = target?.name?.value ? `the "${target.name.value}" ${target.role ?? 'control'}` : null;
  const where = target?.cell?.rowWhere
    ? ` in the row where ${target.cell.rowWhere.columnHeader.value} is ${target.cell.rowWhere.equals}`
    : '';
  const column = target?.cell?.columnHeader?.value;
  const what = named ? `${named}${where}` : `${target?.id ?? 'the screen'}${where}`;

  switch (call.name) {
    case 'extract':
      return column
        ? `Capture the ${column} value${where}.`
        : `Capture "${String(call.input.output_name ?? 'value')}" from ${what}.`;
    case 'fill':
    case 'select':
      return `Enter ${templatise(String(call.input.value ?? ''), synth, { vocabWholeString: false })} into ${what}.`;
    case 'navigate':
      return 'Navigate to the recorded screen.';
    default:
      return `Activate ${what}.`;
  }
}

function successAssertions(snap: Snapshot, proposed: string | undefined, synth: SynthesisContext): Assertion[] {
  const out: Assertion[] = [];
  const text = Object.values(snap.frameTexts).join('\n');
  const code = text.match(/SCREEN\s+([A-Z]{2,4}-\d{3,4})/);
  if (code) {
    out.push({
      kind: 'text_present', regex: `SCREEN\\s+${code[1]}`,
      because: 'the core stamps a screen identifier on every page; it is stable across runs and carries no member data',
    });
  }
  if (proposed) {
    out.push({
      kind: 'text_present', text: templatise(proposed, synth, { vocabWords: true }),
      because: 'the discovery run verified this phrase was present on the final screen and that it is not run-varying data',
    });
  }
  if (!out.length) {
    const derived = deriveSuccessText(snap, synth);
    out.push({
      kind: 'text_present', text: templatise(derived, synth, { vocabWords: true }),
      because: 'fallback: screen identity derived from the final page',
    });
  }
  return out;
}

/**
 * Something on the final screen that identifies it, and is not a member's data.
 *
 * The screen code is by far the best answer and is what this almost always
 * returns. The title is a fallback, and it goes through the data guards first:
 * a core that stamps record context into `<title>` ("Account Inquiry -
 * 0100482") would otherwise pin the capability's success condition — the one
 * assertion every future replay depends on — to the member this run happened
 * to use.
 *
 * When neither is usable the product name is used. That is a weak assertion and
 * it is meant to be: it says "still inside the application", which is honest
 * about how little the final screen offered, and the validator's
 * WEAK_SUCCESS_CHECKPOINT rule is what surfaces it to a reviewer.
 */
function deriveSuccessText(snap: Snapshot, synth: SynthesisContext): string {
  const text = Object.values(snap.frameTexts).join('\n');
  const code = text.match(/SCREEN\s+([A-Z]{2,4}-\d{3,4})/);
  if (code) return `SCREEN ${code[1]}`;

  const titleTail = snap.title ? (snap.title.split(' - ').pop() ?? snap.title).trim() : '';
  if (titleTail) {
    const values = readableValues(snap, 250).map((n) => (n.text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
    const flat = titleTail.replace(/\s+/g, ' ').toLowerCase();
    const carriesData =
      looksLikeData(titleTail) ||
      values.some((v) => v.includes(flat) || flat.includes(v)) ||
      Object.values(synth.parameters).some((v) => v && String(v).length > 2 && titleTail.includes(String(v)));
    if (!carriesData) return titleTail;
  }
  return snap.title?.split(' - ')[0]?.trim() || 'MERIDIAN';
}

function detectProfileSignal(signals: Signal[], snap: Snapshot, ctx: TemplateContext) {
  for (const signal of signals) {
    const outcome = evaluateAny(signal.detect, snap, ctx);
    if (outcome) return { signal, outcome };
  }
  return null;
}

// ── capability assembly ──────────────────────────────────────────────────────

function skeletonCapability(
  req: DiscoveryRequest,
  outcomes: Array<{ code: string; kind: 'business' | 'failure'; description: string; retryable: boolean }>,
  signals: Signal[],
  vocabulary: Record<string, string>,
): Capability {
  return {
    apiVersion: API_VERSION,
    kind: 'Capability',
    metadata: {
      id: req.capabilityId, version: '0.1.0', title: req.title,
      summary: req.goal, createdAt: new Date().toISOString(), labels: {},
      ...(req.owner ? { owner: req.owner } : {}),
    },
    target: {
      surface: 'web', vendor: '', product: req.productProfileId, productVersions: '*',
      entry: { urlTemplate: templatiseUrlLiteral(req.entryUrl, req.tenant.baseUrl), expectedFrames: [] },
      vocabulary,
    },
    contract: {
      inputs: req.parameters.map(({ value, ...f }) => { void value; return f; }),
      outputs: [], outcomes,
      effects: { mutating: false, reversible: true, riskClass: 'read_only', dualControl: false, financialImpact: false, idempotent: true },
      preconditions: [],
    },
    policy: {
      allowedOrigins: req.policy.allowedOrigins,
      allowedPathPatterns: req.policy.allowedPathPatterns,
      allowedActions: req.policy.allowedActions,
      requiresApproval: true, requiresPerInvocationConfirmation: false,
      maxDurationMs: req.maxDurationMs ?? 120_000, maxSteps: 60, redactPatterns: [],
    },
    signals,
    flow: { steps: [{ id: 'placeholder', intent: 'placeholder', kind: 'wait_for' }], successCheckpoint: { id: 'done', description: 'placeholder', all: [{ kind: 'text_present', text: '' }], timeoutMs: 15_000, stableForMs: 0 } },
    provenance: {
      discoveredAt: new Date().toISOString(),
      discoveredBy: { kind: 'llm_discovery' },
      goal: req.goal, swivelVersion: SWIVEL_VERSION, history: [],
    },
    quality: {
      approvalState: 'draft',
      replays: { total: 0, success: 0, businessOutcome: 0, recovered: 0, escalated: 0, failed: 0 },
      stabilityScore: 0, notes: [],
    },
  };
}

const templatiseUrlLiteral = (url: string, baseUrl: string): string =>
  url.startsWith(baseUrl.replace(/\/$/, '')) ? `{{tenant.baseUrl}}${url.slice(baseUrl.replace(/\/$/, '').length)}` : url;

function assembleCapability(a: {
  req: DiscoveryRequest;
  profile: NonNullable<ReturnType<typeof getProductProfile>>;
  vocabulary: Record<string, string>;
  outputs: FieldDef[];
  steps: Step[];
  finish: { summary: string; success_text: string; assertions?: Assertion[]; caveats?: string; awaitsSecondApproval?: boolean };
  entryFrames: string[];
  /** Digest of the evidence bundle's transcript.json, so the two are tied together. */
  transcriptSha256: string;
  llm: { provider: string; model: string };
  synth: SynthesisContext;
}): Capability {
  const { req, profile, vocabulary, outputs, steps, finish, llm, synth } = a;

  /**
   * What this capability actually does, derived from what its steps do.
   *
   * `mutating` used to require `kind === 'click'`, which meant a mutating
   * `select`, a mutating `press` (Enter submits these forms) or a postback link
   * produced `mutating: false`. Everything downstream is derived from this one
   * predicate — `riskClass`, `idempotent`, `financialImpact`,
   * `requiresPerInvocationConfirmation` — so a single wrong answer let a
   * state-changing capability be admitted unattended with no confirmation
   * token and no financial role. The validator's RISK_MISLABELLED rule could
   * not catch it either, because both sides of the comparison came from the
   * same mistake.
   *
   * The risk class is the step risk, and nothing else needs to know how the
   * step was performed.
   */
  const mutating = steps.some((s) => (s.risk ?? 'read_only') !== 'read_only');
  const irreversible = steps.some((s) => s.risk === 'irreversible');
  const high = steps.some((s) => s.risk === 'high');
  const riskClass: Capability['contract']['effects']['riskClass'] =
    irreversible ? 'irreversible' : high ? 'high' : mutating ? 'medium' : 'read_only';

  /**
   * Does this capability move money or incur a charge?
   *
   * Tying this to `irreversible` alone was too narrow by exactly the case that
   * matters most. A funds transfer classifies as `high` — it POSTs and its
   * control says "Transfer" — and is not `irreversible`, because a transfer
   * between a member's own shares genuinely can be reversed. So
   * `financialImpact` was false, the per-invocation confirmation gate never
   * engaged, and the `capability.invoke.financial` role was never required. A
   * capability that moves money ran unattended with neither.
   *
   * Money moving and money being irrecoverable are different questions, and
   * only the second one was being asked.
   */
  const MONEY_WORDS = /transfer|payment|disburse|withdraw|deposit|wire|fee|charge|post(ing)?\b|refund|reversal|stop pay/i;
  const financialImpact = irreversible || (mutating && steps.some((s) =>
    (s.risk ?? 'read_only') !== 'read_only' &&
    (MONEY_WORDS.test(s.intent) || MONEY_WORDS.test(s.target?.name?.value ?? '') || MONEY_WORDS.test(req.goal))));

  const base = skeletonCapability(req, profile.outcomes, profile.signals, vocabulary);

  const cap: Capability = {
    ...base,
    metadata: { ...base.metadata, summary: finish.summary },
    target: { ...base.target, vendor: profile.vendor, product: profile.product, productVersions: req.tenant.productVersion ? `~${req.tenant.productVersion}` : '*',
      entry: { ...base.target.entry, expectedFrames: a.entryFrames } },
    contract: {
      ...base.contract,
      outputs,
      effects: {
        mutating,
        reversible: !irreversible,
        riskClass,
        // Asked of the model as a structured claim, not grepped out of its
        // prose. The previous rule tested the caveats for "pending approval" —
        // and a run whose caveat read "the stop payment was accepted, *not*
        // pending approval" set the flag, because a regex over free text cannot
        // tell an assertion from its denial. A control-relevant field deserves
        // a question with a yes or no answer.
        dualControl: finish.awaitsSecondApproval ?? false,
        financialImpact,
        idempotent: !mutating,
        summary: finish.caveats ?? (mutating
          ? 'This capability changes state in the institution\'s system of record.'
          : 'This capability only reads. It makes no change to any record.'),
      },
    },
    policy: {
      ...base.policy,
      // Anything that moves money asks the caller to say so explicitly, not
      // only the subset that cannot be undone afterwards.
      requiresPerInvocationConfirmation: irreversible || financialImpact,
    },
    flow: {
      steps,
      successCheckpoint: {
        id: 'capability_complete',
        description: finish.success_text,
        all: finish.assertions?.length
          ? finish.assertions
          : [{ kind: 'text_present', text: templatise(finish.success_text, synth), because: 'the discovery run verified this text was present on the final screen' }],
        timeoutMs: 20_000,
        stableForMs: 0,
      },
    },
    provenance: {
      ...base.provenance,
      discoveredBy: { kind: 'llm_discovery', provider: llm.provider, model: llm.model },
      recordedOnTenant: req.tenant.id,
      transcriptSha256: a.transcriptSha256,
      history: [{ at: new Date().toISOString(), actor: req.owner ?? 'discovery', action: 'discovered', note: `via ${llm.provider}/${llm.model}` }],
    },
    quality: { ...base.quality, notes: finish.caveats ? [finish.caveats] : [] },
  };

  return withContentHash(cap);
}

export const __testing = { synthesiseCheckpoint, buildStep, readValue, uniqueStepId };
export { randomUUID as _uuid, join as _join };
