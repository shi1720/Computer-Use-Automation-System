/**
 * Establishing an authenticated session.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Sign-on is deliberately *not* part of a capability, for three reasons:
 *
 *  1. **Credentials must never enter an artifact.** Capabilities are reviewed,
 *     diffed, version-controlled and shared across tenants. Anything that
 *     touches a password cannot live there. A sign-on spec references credential
 *     *names*; the values are resolved at runtime from a secret store and are
 *     never returned, logged, or held longer than the keystroke.
 *
 *  2. **One sign-on serves many capabilities.** An institution runs twenty
 *     capabilities against the same core. Re-authenticating per capability is
 *     both slow and a good way to get an operator ID locked out.
 *
 *  3. **Session expiry is a recovery, not a failure.** When the core times out
 *     mid-flow — which it will, because these systems have fifteen-minute
 *     idle timeouts — the replay engine calls straight back into the provider,
 *     re-establishes the session, and resumes the step it was on. That only
 *     works if sign-on is a callable thing rather than steps 1-4 of the flow.
 *
 * The spec is declarative and uses the same TargetDescriptor vocabulary as a
 * capability, so a legacy app with an unlabelled sign-on form is described the
 * same way everything else is.
 */
import { z } from 'zod';
import { CheckpointSchema, type Checkpoint } from '../artifact/schema.js';
import { TargetDescriptorSchema, type TargetDescriptor } from '../artifact/target.js';
import type { Surface } from '../surface/types.js';
import { resolveTarget } from '../targeting/resolve.js';
import { emptyContext, render, type TemplateContext } from '../artifact/template.js';

export const SignOnSpecSchema = z.object({
  id: z.string(),
  /** Where sign-on starts. Templatable against `tenant.baseUrl`. */
  urlTemplate: z.string(),
  fields: z.array(z.object({
    target: TargetDescriptorSchema,
    /**
     * Name of the credential to supply — NOT the credential. Resolved through
     * the SecretResolver at the moment of typing.
     */
    credentialRef: z.string(),
  }).strict()),
  submit: TargetDescriptorSchema,
  /** Proof that sign-on actually worked. */
  success: CheckpointSchema,
  /**
   * Screens some products interpose after sign-on (annual policy
   * acknowledgements, MFA notices). Dismissed if present, skipped if not.
   */
  postSignOn: z.array(z.object({
    target: TargetDescriptorSchema,
    optional: z.boolean().default(true),
    intent: z.string(),
  }).strict()).default([]),
}).strict();

export type SignOnSpec = z.infer<typeof SignOnSpecSchema>;

/**
 * Resolves credential names to values.
 *
 * The interface is intentionally minimal and async so that a real deployment
 * can back it with Vault, AWS Secrets Manager or the institution's own vault
 * without any other part of the system noticing. Values are returned, used and
 * dropped; nothing here caches them.
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

/** Reads credentials from environment variables. */
export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly prefix = 'SWIVEL_CRED_') {}
  async resolve(ref: string): Promise<string> {
    const key = `${this.prefix}${ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const v = process.env[key];
    if (!v) {
      throw new Error(
        `Credential "${ref}" is not available. Set ${key} in the environment (or wire a real secret store into SecretResolver). ` +
        `Swivel never stores credentials in artifacts or configuration.`);
    }
    return v;
  }
}

export interface SignOnResult {
  ok: boolean;
  message: string;
  attempts: number;
}

export class SessionProvider {
  constructor(
    private readonly spec: SignOnSpec,
    private readonly secrets: SecretResolver,
    private readonly log?: (msg: string, data?: Record<string, unknown>) => void,
  ) {}

  get id(): string { return this.spec.id; }

  async establish(surface: Surface, tenant: Record<string, string>): Promise<SignOnResult> {
    const ctx: TemplateContext = { ...emptyContext(), tenant };
    const url = render(this.spec.urlTemplate, ctx);
    this.log?.(`Establishing session at ${url}`);
    await surface.act({ kind: 'navigate', url });

    let snap = await surface.snapshot({ settleMs: 150 });

    for (const f of this.spec.fields) {
      const r = resolveTarget(f.target, snap, { ctx });
      if (!r.ok) return { ok: false, message: `Sign-on field "${f.target.id}" not found: ${r.message}`, attempts: 1 };
      // Resolved here and nowhere else. Not stored on `this`, not logged, not
      // put in the evidence chain — the redactor would catch it, but the
      // right place to not have a secret is to never hold one.
      const value = await this.secrets.resolve(f.credentialRef);
      await surface.act({ kind: 'fill', ref: r.node.ref, value });
    }

    const sub = resolveTarget(this.spec.submit, snap, { ctx });
    if (!sub.ok) return { ok: false, message: `Sign-on submit control not found: ${sub.message}`, attempts: 1 };
    await surface.act({ kind: 'click', ref: sub.node.ref });
    await new Promise((r) => setTimeout(r, 400));

    // Optional interposed screens: present at one tenant, absent at the next.
    for (const p of this.spec.postSignOn) {
      snap = await surface.snapshot({ settleMs: 120 });
      const r = resolveTarget(p.target, snap, { ctx });
      if (r.ok) {
        this.log?.(`Post-sign-on screen handled: ${p.intent}`);
        await surface.act({ kind: 'click', ref: r.node.ref });
        await new Promise((x) => setTimeout(x, 300));
      } else if (!p.optional) {
        return { ok: false, message: `Required post-sign-on step "${p.intent}" could not be completed: ${r.message}`, attempts: 1 };
      }
    }

    snap = await surface.snapshot({ settleMs: 200 });
    const ok = this.spec.success.all.every((a) => assertHolds(a, snap, ctx));
    return ok
      ? { ok: true, message: `Session established (${this.spec.id})`, attempts: 1 }
      : { ok: false, message: `Sign-on did not reach the expected screen: ${this.spec.success.description}`, attempts: 1 };
  }

  /** Same path as establish; separated so callers read as intent, not mechanism. */
  async reauthenticate(surface: Surface, tenant: Record<string, string>): Promise<SignOnResult> {
    this.log?.('Session expired — re-authenticating on the same browser session');
    return this.establish(surface, tenant);
  }
}

/** Small local assertion evaluator, shared in spirit with the replay engine. */
function assertHolds(a: Checkpoint['all'][number], snap: { frameTexts: Record<string, string>; url: string; nodes: unknown[] }, ctx: TemplateContext): boolean {
  const allText = Object.values(snap.frameTexts).join('\n');
  switch (a.kind) {
    case 'text_present':
      if (a.regex) return new RegExp(a.regex, 'i').test(allText);
      return a.text ? allText.toLowerCase().includes(render(a.text, ctx).toLowerCase()) : false;
    case 'text_absent':
      if (a.regex) return !new RegExp(a.regex, 'i').test(allText);
      return a.text ? !allText.toLowerCase().includes(render(a.text, ctx).toLowerCase()) : true;
    case 'url_matches':
      return a.regex ? new RegExp(a.regex).test(snap.url) : snap.url.includes(a.text ?? '');
    default:
      return true;
  }
}

/**
 * The MERIDIAN sign-on spec.
 *
 * Note what it takes to describe a 1990s sign-on form: the operator ID box has
 * no label, no placeholder and no title, so it is addressed the way a human
 * would — "the box to the right of the words Operator ID".
 */
export const MERIDIAN_SIGN_ON: SignOnSpec = {
  id: 'meridian-core-signon',
  urlTemplate: '{{tenant.baseUrl}}/',
  fields: [
    {
      credentialRef: 'meridian_operator_id',
      target: {
        id: 'operator_id', role: 'textbox',
        anchors: [{ relation: 'right-of', text: { value: 'Operator ID', match: 'normalized' }, maxDistancePx: 220 }],
        hints: { idPattern: 'ctl00_\\w+_txtOperatorId' },
      },
    },
    {
      credentialRef: 'meridian_password',
      target: {
        id: 'password', role: 'textbox',
        anchors: [{ relation: 'right-of', text: { value: 'Password', match: 'normalized' }, maxDistancePx: 220 }],
        hints: { inputType: 'password' },
      },
    },
  ],
  submit: { id: 'sign_on', role: 'button', name: { value: 'Sign On', match: 'exact' } },
  postSignOn: [
    {
      intent: 'Acknowledge the annual compliance policy (Meridian 10.1 only)',
      optional: true,
      target: { id: 'acknowledge_policy', role: 'button', name: { value: 'I Acknowledge', match: 'normalized' } },
    },
  ],
  success: {
    id: 'signed_on',
    description: 'The main menu frameset is loaded and the navigation frame is present',
    all: [
      { kind: 'url_matches', regex: '/main$', because: 'Meridian lands on the frameset after a successful sign-on' },
      { kind: 'text_present', text: 'MAIN MENU', because: 'the navigation frame renders only for an authenticated operator' },
    ],
    timeoutMs: 15_000,
    stableForMs: 0,
  },
};
