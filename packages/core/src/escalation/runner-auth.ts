/**
 * The credential a runner presents to the console.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Two of the console's routes are machine-facing rather than person-facing: a
 * run hosted in another process mirrors its ticket in (`/ingest`) and then polls
 * for the operator's decision (`/resolution`). Neither has a browser session, so
 * neither can present the console's signed cookie.
 *
 * That does not make them public. `/ingest` writes into the operator queue, and
 * the ticket it writes carries `context.control` — the websocket that drives a
 * live teller session. `/resolution` reads back everything the operator typed
 * while they were driving it. Both need a credential.
 *
 * So runners authenticate with a bearer token shared between the runner hosts
 * and the console. In a real deployment you set `SWIVEL_RUNNER_TOKEN` on both
 * sides from your secret store. When it is unset — the single-host demo — it is
 * derived from the session secret, so the two processes agree without any
 * setup, and changing `SWIVEL_SESSION_SECRET` (which a real deployment must do
 * anyway) changes this too.
 *
 * The token is never written to an artifact, an evidence bundle or a log: the
 * redactor's `bearer` rule catches it if it ever reaches one.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEV_SESSION_SECRET = 'swivel-dev-secret-change-me';

/** The token this process should present, or expect. */
export function runnerToken(): string {
  const explicit = process.env.SWIVEL_RUNNER_TOKEN;
  if (explicit) return explicit;
  const base = process.env.SWIVEL_SESSION_SECRET ?? DEV_SESSION_SECRET;
  return createHmac('sha256', base).update('swivel:runner-credential:v1').digest('base64url');
}

/** True if `presented` is the runner credential. Constant-time. */
export function isRunnerToken(presented: string | undefined): boolean {
  if (!presented) return false;
  const expect = Buffer.from(runnerToken());
  const got = Buffer.from(presented);
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length; compare lengths first and only then compare contents.
  if (got.length !== expect.length) return false;
  return timingSafeEqual(got, expect);
}

/** Pull a bearer token out of an `Authorization` header. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}
