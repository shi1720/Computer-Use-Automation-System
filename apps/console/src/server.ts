/**
 * The Swivel control plane.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Three audiences, one service:
 *
 *   Reviewers    read a capability the way a change-control board would — the
 *                intents, the risk class, the validation findings — and approve
 *                it, which is what allows an AI agent to invoke it unattended.
 *   Operators    take over a stuck session. Not a ticket queue: the live
 *                browser, mid-flow, with their keystrokes recorded.
 *   Agents       call approved capabilities by name over HTTP or MCP.
 *
 * The auth model is deliberately boring and deliberately real: scrypt-hashed
 * passwords, signed HttpOnly session cookies, role checks on every mutating
 * route. A console that can approve automation which moves money is not a place
 * to hand-wave authentication.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SwivelStore, Runner, EscalationBroker, verifyChain, validateCapability,
  verifyPassword, resolveCapability, computeContentHash, isRunnerToken, bearerFrom,
  type Capability, type Intervention, type User,
} from '@swivel/core';
import { loadConfig, requireTenant, type SwivelConfig } from '../../../packages/cli/src/config.js';
import { toToolDefinition } from './tools.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

const SESSION_COOKIE = 'swivel_session';
const SECRET = process.env.SWIVEL_SESSION_SECRET ?? 'swivel-dev-secret-change-me';

interface Session { userId: string; issuedAt: number }

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function mintToken(s: Session): string {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = sign(body);
  if (mac.length !== expect.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session;
    // Eight hours. An operator console that can drive a teller session should
    // not hold a session open across a weekend.
    if (Date.now() - s.issuedAt > 8 * 60 * 60_000) return null;
    return s;
  } catch { return null; }
}

export interface ConsoleDeps {
  store: SwivelStore;
  config: SwivelConfig;
  broker: EscalationBroker;
}

export async function buildConsole(deps: ConsoleDeps): Promise<express.Express> {
  const { store, config, broker } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  /**
   * The live-control channel is a websocket that can drive a teller session.
   * It is withheld from every response except to the operator who has actually
   * claimed the ticket — which is what makes "claim" a control rather than a
   * label.
   */
  const visible = (i: Intervention, user: User): Intervention => {
    const mayDrive = user.roles.includes('operator.takeover') && i.assignee?.id === user.id;
    if (mayDrive) return i;
    const { control, ...rest } = i.context;
    void control;
    return { ...i, context: rest };
  };

  // ── server-sent events, for live run and intervention updates ─────────────
  //
  // Each subscriber is remembered with the user it authenticated as, because a
  // ticket is not the same object to every reader: the one who claimed it gets
  // the control channel, everybody else gets the ticket without it. Serialising
  // once and fanning the same bytes out to every socket would hand the live
  // session's bearer token to every signed-in account the instant control was
  // granted — including read-only reviewers and agent principals — which would
  // make `visible()` above decorative.
  const sseClients = new Set<{ res: Response; user: User }>();
  const push = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const { res } of sseClients) res.write(payload);
  };
  const pushIntervention = (i: Intervention) => {
    for (const { res, user } of sseClients) {
      res.write(`event: intervention\ndata: ${JSON.stringify(visible(i, user))}\n\n`);
    }
  };
  broker.on('raised', pushIntervention);
  broker.on('updated', pushIntervention);

  // ── auth ──────────────────────────────────────────────────────────────────
  const currentUser = async (req: Request): Promise<User | null> => {
    const raw = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${SESSION_COOKIE}=`));
    const s = readToken(raw?.slice(SESSION_COOKIE.length + 1));
    return s ? store.findUser(s.userId) : null;
  };

  const requireAuth = (...roles: string[]) => async (req: Request, res: Response, next: NextFunction) => {
    const user = await currentUser(req);
    if (!user) { res.status(401).json({ error: 'Not signed in.' }); return; }
    if (roles.length && !roles.some((r) => user.roles.includes(r))) {
      res.status(403).json({ error: `This action requires one of: ${roles.join(', ')}. You have: ${user.roles.join(', ') || 'none'}.` });
      return;
    }
    (req as Request & { user: User }).user = user;
    next();
  };
  const userOf = (req: Request): User => (req as Request & { user: User }).user;

  /**
   * The machine-to-machine gate.
   *
   * A run hosted in another process has no browser session, so it presents the
   * shared runner credential instead. These are not public routes: one writes
   * into the operator queue and the other reads back everything a human typed
   * into a live teller session.
   */
  const requireRunner = (req: Request, res: Response, next: NextFunction) => {
    if (!isRunnerToken(bearerFrom(req.headers.authorization))) {
      res.status(401).json({ error: 'This route is for Swivel runners. Present the runner credential.' });
      return;
    }
    next();
  };

  app.post('/api/auth/login', async (req, res) => {
    const { id, password } = req.body as { id?: string; password?: string };
    const user = id ? await store.findUser(id) : null;
    if (!user?.passwordHash || !user.salt || !password || !verifyPassword(password, user.passwordHash, user.salt)) {
      // One message for both failure modes — enumerating valid user ids is free
      // reconnaissance.
      res.status(401).json({ error: 'Incorrect user or password.' });
      return;
    }
    const token = mintToken({ userId: user.id, issuedAt: Date.now() });
    // `Secure` is set whenever the console is reached over TLS. It is omitted on
    // a plain-HTTP localhost demo because a browser silently drops a Secure
    // cookie there, which would make the console appear broken rather than
    // secure.
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${8 * 3600}`);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', async (req, res) => {
    const user = await currentUser(req);
    res.json({ user: user ? publicUser(user) : null });
  });

  // ── catalogue ─────────────────────────────────────────────────────────────
  app.get('/api/capabilities', requireAuth(), async (_req, res) => {
    const caps = await store.listCapabilities();
    res.json({
      capabilities: caps.map((c) => ({
        id: c.metadata.id, version: c.metadata.version, title: c.metadata.title, summary: c.metadata.summary,
        approvalState: c.quality.approvalState, stabilityScore: c.quality.stabilityScore,
        replays: c.quality.replays, steps: c.flow.steps.length,
        effects: c.contract.effects, inputs: c.contract.inputs, outputs: c.contract.outputs,
        product: `${c.target.vendor} ${c.target.product}`,
        contentHash: c.contentHash, createdAt: c.metadata.createdAt,
        findings: validateCapability(c).length,
      })),
    });
  });

  app.get('/api/capabilities/:id', requireAuth(), async (req, res) => {
    const cap = await store.getCapability(req.params.id as string, req.query.version as string | undefined);
    if (!cap) { res.status(404).json({ error: 'No such capability' }); return; }
    const versions = await store.listVersions(cap.metadata.id);
    const overlays = (await store.listOverlays()).filter((o) => o.metadata.capabilityId === cap.metadata.id);
    res.json({
      capability: cap, versions, overlays,
      findings: validateCapability(cap),
      tool: toToolDefinition(cap),
      contentHash: computeContentHash(cap),
    });
  });

  app.post('/api/capabilities/:id/approve', requireAuth('capability.approve'), async (req, res) => {
    const { version, note, contentHash } = req.body as { version: string; note?: string; contentHash?: string };
    const cap = await store.getCapability(req.params.id as string, version);
    if (!cap) { res.status(404).json({ error: 'No such capability' }); return; }
    const findings = validateCapability(cap);
    if (findings.some((f) => f.severity === 'error')) {
      res.status(422).json({ error: 'This capability has validation errors and cannot be approved.', findings });
      return;
    }
    if (cap.quality.replays.total === 0) {
      res.status(422).json({ error: 'Approve only what has been replayed. Run it at least once first.' });
      return;
    }
    try {
      const approvedHash = computeContentHash(cap);
      const updated = await store.updateQuality(
        cap.metadata.id, version, contentHash ?? cap.contentHash,
        (q) => ({
          ...q, approvalState: 'approved', approvedBy: userOf(req).id, approvedAt: new Date().toISOString(),
          approvedContentHash: approvedHash,
          notes: note ? [...q.notes, note] : q.notes,
        }),
        { actor: userOf(req).id, action: 'approved', ...(note ? { note } : {}) },
      );
      res.json({ capability: updated });
    } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });

  app.post('/api/capabilities/:id/revoke', requireAuth('capability.approve'), async (req, res) => {
    const { version, note } = req.body as { version: string; note?: string };
    const cap = await store.getCapability(req.params.id as string, version);
    if (!cap) { res.status(404).json({ error: 'No such capability' }); return; }
    const updated = await store.updateQuality(cap.metadata.id, version, cap.contentHash,
      (q) => ({ ...q, approvalState: 'candidate', approvedContentHash: undefined, notes: note ? [...q.notes, `revoked: ${note}`] : q.notes }),
      { actor: userOf(req).id, action: 'approval revoked', ...(note ? { note } : {}) });
    res.json({ capability: updated });
  });

  // ── tenants and overlays ──────────────────────────────────────────────────
  app.get('/api/tenants', requireAuth(), async (_req, res) => {
    const overlays = await store.listOverlays();
    res.json({
      tenants: Object.values(config.tenants).map((t) => ({
        ...t,
        overlays: overlays.filter((o) => o.metadata.tenantId === t.id).map((o) => ({
          id: o.metadata.id, capabilityId: o.metadata.capabilityId,
          patches: o.stepPatches.length, overrides: Object.keys(o.targetOverrides).length,
          vocabulary: o.vocabulary, extraSignals: o.extraSignals.length,
        })),
      })),
    });
  });

  // ── runs and evidence ─────────────────────────────────────────────────────
  app.get('/api/runs', requireAuth(), async (_req, res) => {
    res.json({ runs: await store.listRuns(80) });
  });

  app.get('/api/runs/:runId', requireAuth('evidence.read'), async (req, res) => {
    const run = await store.getRun(req.params.runId as string);
    if (!run) { res.status(404).json({ error: 'No such run' }); return; }
    const manifest = await readJsonFile(join(run.evidenceDir, 'run.json'));
    const eventsRaw = await readFile(join(run.evidenceDir, 'events.jsonl'), 'utf8').catch(() => '');
    const events = eventsRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const chain = await verifyChain(run.evidenceDir);
    res.json({ run, manifest, events, chain });
  });

  /**
   * Serve a file out of an evidence bundle.
   *
   * Path containment is checked explicitly: evidence directories hold
   * screenshots of screens containing member data, and a traversal here reads
   * arbitrary files off the host.
   */
  app.get('/api/runs/:runId/file', requireAuth('evidence.read'), async (req, res) => {
    const run = await store.getRun(req.params.runId as string);
    if (!run) { res.status(404).end(); return; }
    const root = resolvePath(run.evidenceDir);
    const target = resolvePath(join(root, normalize(String(req.query.path ?? ''))));
    if (!target.startsWith(`${root}/`)) { res.status(400).json({ error: 'Path escapes the evidence bundle.' }); return; }
    // Containment is re-checked after symlinks are followed. The lexical check
    // above stops `../` and absolute paths; it does not stop a symlink *inside*
    // a bundle pointing at /etc, and bundles are written by runners that may not
    // be this host.
    let real: string;
    try { real = await realpath(target); }
    catch { res.status(404).end(); return; }
    const realRoot = await realpath(root).catch(() => root);
    if (real !== realRoot && !real.startsWith(`${realRoot}/`)) {
      res.status(400).json({ error: 'Path escapes the evidence bundle.' });
      return;
    }
    res.sendFile(real, (err) => { if (err) res.status(404).end(); });
  });

  // ── interventions and live takeover ───────────────────────────────────────

  app.get('/api/interventions', requireAuth(), (req, res) => {
    const user = userOf(req);
    res.json({ interventions: broker.list().map((i) => visible(i, user)) });
  });

  /** Runs hosted elsewhere mirror their tickets here, with their control URL. */
  app.post('/api/interventions/ingest', requireRunner, (req, res) => {
    const i = req.body as Intervention;
    if (!i?.id || !i?.context?.runId) { res.status(400).json({ error: 'Malformed intervention.' }); return; }
    try {
      const stored = broker.ingest(i);
      pushIntervention(stored);
      res.json({ id: stored.id, status: stored.status });
    } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });

  app.get('/api/interventions/:id', requireAuth(), (req, res) => {
    const i = broker.get(req.params.id as string);
    if (!i) { res.status(404).json({ error: 'No such intervention' }); return; }
    res.json({ intervention: visible(i, userOf(req)) });
  });

  /** Polled by the run that raised the ticket, to learn the operator's decision. */
  app.get('/api/interventions/:id/resolution', requireRunner, (req, res) => {
    const i = broker.get(req.params.id as string);
    if (!i) { res.status(404).json({ error: 'No such intervention' }); return; }
    res.json({
      status: i.status, resolution: i.resolution, note: i.resolutionNote,
      assignee: i.assignee, humanActions: i.humanActions,
    });
  });

  app.post('/api/interventions/:id/claim', requireAuth('operator.takeover'), (req, res) => {
    try {
      const user = userOf(req);
      const i = broker.claim(req.params.id as string, { id: user.id, name: user.name });
      res.json({ intervention: visible(i, user) });
    } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });

  app.post('/api/interventions/:id/return', requireAuth('operator.takeover'), (req, res) => {
    const { resolution, note, sessionDelta } = req.body as { resolution: 'resume' | 'completed_by_human' | 'abort'; note: string; sessionDelta?: Intervention['sessionDelta'] };
    try {
      const user = userOf(req);
      const i = broker.returnControl(req.params.id as string, resolution, note, sessionDelta, { id: user.id, name: user.name });
      res.json({ intervention: visible(i, user) });
    } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });

  app.post('/api/interventions/:id/note', requireAuth('operator.takeover'), (req, res) => {
    const user = userOf(req);
    const i = broker.get(req.params.id as string);
    if (!i) { res.status(404).json({ error: 'No such intervention' }); return; }
    if (i.assignee?.id !== user.id) { res.status(403).json({ error: 'Only the operator holding this ticket can annotate it.' }); return; }
    broker.recordHumanAction(req.params.id as string, { at: new Date().toISOString(), kind: 'note', detail: String((req.body as { note: string }).note) });
    res.json({ ok: true });
  });

  // ── invocation ────────────────────────────────────────────────────────────
  /**
   * The production entry point: an AI agent calls a capability by name.
   *
   * Everything the safety model promises is enforced on this path — approval
   * state, per-invocation confirmation for irreversible capabilities, the
   * principal's roles, the origin allowlist.
   */
  app.post('/api/capabilities/:id/invoke', requireAuth('capability.invoke'), async (req, res) => {
    const body = req.body as { version?: string; tenant: string; inputs: Record<string, unknown>; unattended?: boolean; confirmationToken?: string };
    const cap = await store.getCapability(req.params.id as string, body.version);
    if (!cap) { res.status(404).json({ error: 'No such capability' }); return; }

    let tenant;
    try { tenant = requireTenant(config, body.tenant); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); return; }

    const overlay = await store.getOverlay(tenant.id, cap.metadata.id);
    const user = userOf(req);
    const runner = makeRunner(store, broker, push);

    try {
      const result = await runner.runReplay({
        capability: cap, overlay,
        tenant: { id: tenant.id, institution: tenant.institution, baseUrl: tenant.baseUrl, ...(tenant.vocabulary ? { vocabulary: tenant.vocabulary } : {}) },
        inputs: body.inputs ?? {},
        principal: { id: user.id, kind: body.unattended ? 'agent' : 'human', roles: user.roles },
        unattended: body.unattended ?? false,
        ...(body.confirmationToken ? { confirmationToken: body.confirmationToken } : {}),
        onStart: (h) => push('run.started', { ...h, capabilityId: cap.metadata.id, tenant: tenant.id }),
      });
      push('run.finished', { runId: result.runId, status: result.status });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Machine-facing catalogue: capabilities as callable tool definitions. */
  app.get('/api/tools', requireAuth('capability.invoke'), async (req, res) => {
    const all = (req.query.all as string) === '1';
    const caps = await store.listCapabilities();
    const visible = all ? caps : caps.filter((c) => c.quality.approvalState === 'approved');
    res.json({ tools: visible.map(toToolDefinition) });
  });

  app.get('/api/events', requireAuth(), (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    // The subscription is bound to the authenticated user for its whole life, so
    // that what this socket is allowed to see cannot drift from who opened it.
    const client = { res, user: userOf(req) };
    sseClients.add(client);
    const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(keepalive); sseClients.delete(client); });
  });

  // ── static ────────────────────────────────────────────────────────────────
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  app.get(/.*/, async (_req, res) => {
    res.type('html').send(await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8'));
  });

  return app;
}

function publicUser(u: User) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, roles: u.roles };
}

async function readJsonFile(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

function makeRunner(store: SwivelStore, broker: EscalationBroker, push: (e: string, d: unknown) => void): Runner {
  return new Runner({
    store,
    headless: true,
    ...(process.env.SWIVEL_CHROMIUM_PATH ? { chromiumPath: process.env.SWIVEL_CHROMIUM_PATH } : {}),
    onEvent: (e) => push('run.event', e),
    escalation: { broker },
  });
}

export async function startConsole(): Promise<void> {
  const store = new SwivelStore();
  await store.init();
  const config = await loadConfig();
  const broker = new EscalationBroker();
  const app = await buildConsole({ store, config, broker });
  const port = config.console.port;

  await new Promise<void>((r) => app.listen(port, () => r()));
  const line = (s: string) => console.log(`  ${s}`);
  console.log('');
  line('\u001b[1m\u001b[36m◧ SWIVEL CONSOLE\u001b[0m');
  line(`\u001b[90mcontrol plane · capability catalogue · operator takeover\u001b[0m`);
  console.log('');
  line(`\u001b[32m▸\u001b[0m  http://127.0.0.1:${port}`);
  line(`\u001b[90msign in as\u001b[0m  shivam / swivel   \u001b[90m(admin)\u001b[0m`);
  line(`\u001b[90m           \u001b[0m  operator / swivel \u001b[90m(takeover only)\u001b[0m`);
  console.log('');
  void randomUUID;
  void resolveCapability;
  void ((_c: Capability) => _c);
}
