/**
 * MERIDIAN Core — application server.
 *
 * One Express app per tenant. Each tenant gets its own port, its own in-memory
 * member store and its own scenario state, so two "institutions running the same
 * vendor product" are genuinely separate origins. That matters: the allowlist in
 * Swivel is enforced per origin, and the cross-tenant replay demo is only
 * meaningful if the two apps really are different deployments.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { TENANTS, USERS, type TenantConfig } from './tenants.js';
import { cloneSeed, formatCents, type Member } from './data.js';
import { SimState } from './sim.js';
import * as V from './views.js';

interface Session {
  id: string;
  operatorId: string;
  displayName: string;
  role: 'TELLER' | 'MSR' | 'SUPERVISOR';
  branch: string;
  complianceAcked: boolean;
  /** Member numbers whose compliance notice this session has already cleared. */
  noticesAcked: Set<string>;
}

/** Non-monetary maintenance log — every core has one, and examiners read it. */
export interface AuditEntry {
  ref: string;
  at: string;
  operatorId: string;
  action: string;
  memberNumber: string;
  detail: Record<string, string>;
}

const REF = (prefix: string) => `${prefix}-${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

export interface MeridianApp {
  app: express.Express;
  tenant: TenantConfig;
  sim: SimState;
  members: Member[];
  audit: AuditEntry[];
  reset(): void;
}

export function createMeridian(tenantId: string): MeridianApp {
  const found: TenantConfig | undefined = TENANTS[tenantId];
  if (!found) throw new Error(`Unknown tenant: ${tenantId}. Known tenants: ${Object.keys(TENANTS).join(', ')}`);
  const tenant: TenantConfig = found;

  const app = express();
  const sim = new SimState();
  let members = cloneSeed();
  const sessions = new Map<string, Session>();
  let audit: AuditEntry[] = [];

  const state: MeridianApp = {
    app, tenant, sim, get members() { return members; }, get audit() { return audit; },
    reset() { members = cloneSeed(); audit = []; sessions.clear(); sim.reset(); },
  } as MeridianApp;

  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // ── session plumbing ───────────────────────────────────────────────────────
  const COOKIE = 'MERIDIANSESSID';
  function readSession(req: Request): Session | null {
    const raw = req.headers.cookie ?? '';
    const m = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
    if (!m) return null;
    return sessions.get(m.slice(COOKIE.length + 1)) ?? null;
  }
  function findMember(n: string): Member | undefined {
    return members.find((m) => m.memberNumber === n.trim());
  }
  const field = (req: Request, name: string): string => {
    const p = tenant.ctlPrefix;
    const body = req.body as Record<string, unknown>;
    const q = req.query as Record<string, unknown>;
    return String(body?.[`${p}$${name}`] ?? q?.[`${p}$${name}`] ?? body?.[name] ?? q?.[name] ?? '').trim();
  };

  // ── scenario control surface (never part of the automated app) ─────────────
  app.get('/__sim/state', (_req, res) => {
    res.json({ tenant: tenant.id, institution: tenant.institution, productVersion: tenant.productVersion, scenario: sim.scenario, contentRequests: sim.contentRequestCount });
  });
  app.post('/__sim/scenario', (req, res) => { res.json({ ok: true, scenario: sim.apply(req.body ?? {}) }); });
  app.post('/__sim/reset', (_req, res) => { state.reset(); res.json({ ok: true }); });
  app.get('/__sim/audit', (_req, res) => { res.json({ entries: audit }); });
  app.get('/__sim/member/:id', (req, res) => {
    const m = findMember(req.params.id ?? '');
    if (!m) { res.status(404).json({ error: 'not found' }); return; }
    res.json(m);
  });

  // ── sign on ────────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    const s = readSession(req);
    if (s) { res.redirect('/main'); return; }
    res.type('html').send(V.loginPage(tenant));
  });

  app.post('/signon', (req, res) => {
    const operatorId = field(req, 'txtOperatorId').toLowerCase();
    const password = field(req, 'txtPassword');
    const u = USERS[operatorId];
    if (!u || u.password !== password) {
      res.status(200).type('html').send(V.loginPage(tenant, 'MSG 0012 - SIGN ON FAILED. INVALID OPERATOR ID OR PASSWORD.'));
      return;
    }
    const sess: Session = {
      id: randomUUID(), operatorId, displayName: u.displayName, role: u.role, branch: u.branch,
      complianceAcked: !tenant.requiresComplianceAck, noticesAcked: new Set(),
    };
    sessions.set(sess.id, sess);
    sim.contentRequestCount = 0;
    res.setHeader('Set-Cookie', `${COOKIE}=${sess.id}; Path=/; HttpOnly; SameSite=Lax`);
    res.redirect(sess.complianceAcked ? '/main' : '/compliance-ack');
  });

  app.get('/signoff', (req, res) => {
    const s = readSession(req);
    if (s) sessions.delete(s.id);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
    res.redirect('/');
  });

  app.get('/compliance-ack', (req, res) => {
    if (!readSession(req)) { res.redirect('/'); return; }
    res.type('html').send(V.complianceAckPage(tenant));
  });
  app.post('/compliance-ack', (req, res) => {
    const s = readSession(req);
    if (!s) { res.redirect('/'); return; }
    s.complianceAcked = true;
    res.redirect('/main');
  });

  app.get('/main', (req, res) => {
    const s = readSession(req);
    if (!s) { res.redirect('/'); return; }
    if (!s.complianceAcked) { res.redirect('/compliance-ack'); return; }
    res.type('html').send(V.framesetPage(tenant));
  });

  app.get('/nav', (req, res) => {
    const s = readSession(req);
    if (!s) { res.type('html').send(V.sessionExpiredScreen(tenant)); return; }
    res.type('html').send(V.navFrame(tenant, s));
  });

  // ── content frame ──────────────────────────────────────────────────────────
  const content = express.Router();

  content.use(async (req: Request, res: Response, next: NextFunction) => {
    sim.contentRequestCount += 1;
    if (sim.scenario.latencyMs > 0) await new Promise((r) => setTimeout(r, sim.scenario.latencyMs));
    if (sim.takeTransientFailure()) {
      res.status(503).type('html').send(V.transientErrorPage(tenant));
      return;
    }
    const s = readSession(req);
    if (!s || sim.takeSessionExpiry()) {
      if (s) sessions.delete(s.id);
      res.status(200).type('html').send(V.sessionExpiredScreen(tenant));
      return;
    }
    (req as any).sess = s;
    next();
  });

  const sessOf = (req: Request): Session => (req as any).sess as Session;
  /** Maintenance functions are unavailable during end-of-day processing. */
  const maintenanceGuard = (req: Request, res: Response, next: NextFunction) => {
    if (sim.scenario.eodLockout) { res.type('html').send(V.eodLockoutScreen(tenant, sessOf(req))); return; }
    next();
  };

  content.get('/home', (req, res) => res.type('html').send(V.homeScreen(tenant, sessOf(req))));

  content.get('/member-search', (req, res) => {
    const mode = String(req.query.mode ?? 'inquiry');
    res.type('html').send(V.memberSearchScreen(tenant, sessOf(req), mode));
  });

  content.get('/member-results', (req, res) => {
    const s = sessOf(req);
    const mode = String(req.query.mode ?? 'inquiry');
    const no = field(req, 'txtMemberNo');
    const last = field(req, 'txtLastName').toUpperCase();
    const ssn4 = field(req, 'txtSsn4');

    if (!no && !last && !ssn4) {
      res.type('html').send(V.memberSearchScreen(tenant, s, mode, 'MSG 0021 - ENTER AT LEAST ONE SEARCH CRITERION.'));
      return;
    }
    if (no && !/^\d{1,10}$/.test(no)) {
      res.type('html').send(V.memberSearchScreen(tenant, s, mode, `MSG 0007 - DATA ERROR: ${tenant.vocab.memberNumber.toUpperCase()} MUST BE NUMERIC.`));
      return;
    }
    const q = no || last || `***-**-${ssn4}`;
    let rows = members.filter((m) =>
      (no ? m.memberNumber === no.padStart(7, '0') || m.memberNumber === no : true) &&
      (last ? m.lastName.toUpperCase().startsWith(last) : true) &&
      (ssn4 ? m.ssnLast4 === ssn4 : true));
    if (!rows.length) { res.type('html').send(V.noResultsScreen(tenant, s, q, mode)); return; }
    rows = rows.slice(0, 50);
    res.type('html').send(V.searchResultsScreen(tenant, s, rows, q, mode));
  });

  content.get('/member/:id', (req, res) => {
    const s = sessOf(req);
    const m = findMember(req.params.id ?? '');
    const mode = String(req.query.mode ?? 'inquiry');
    if (!m) {
      res.type('html').send(V.noResultsScreen(tenant, s, String(req.params.id), mode));
      return;
    }
    const needsNotice = (m.complianceFlag || sim.scenario.alwaysShowComplianceInterstitial) && !s.noticesAcked.has(m.memberNumber);
    if (needsNotice && req.query.ack !== '1') {
      res.type('html').send(V.complianceInterstitial(tenant, s, m, mode));
      return;
    }
    if (req.query.ack === '1') s.noticesAcked.add(m.memberNumber);
    // Meridian 10.1 ships with balances collapsed behind an explicit control —
    // a real class of difference between builds of the same vendor product, and
    // exactly the kind that needs a tenant overlay rather than a re-recording.
    const accountsShown = !tenant.showsSegmentColumn || req.query.accts === '1';
    res.type('html').send(V.memberDetailScreen(tenant, s, m, mode, req.query.msg ? String(req.query.msg) : undefined, accountsShown));
  });

  /** Shared preamble for every servicing screen: locking + existence checks. */
  function servicing(req: Request, res: Response): { s: Session; m: Member } | null {
    const s = sessOf(req);
    const id = String(req.params.id ?? '');
    const m = findMember(id);
    if (!m) { res.type('html').send(V.noResultsScreen(tenant, s, id, 'inquiry')); return null; }
    if (m.lockedBy || sim.scenario.forceRecordLocked) {
      res.type('html').send(V.recordLockedScreen(tenant, s, m));
      return null;
    }
    return { s, m };
  }

  // ── Open share / deposit account ───────────────────────────────────────────
  content.get('/member/:id/open-share', maintenanceGuard, (req, res) => {
    const ctx = servicing(req, res); if (!ctx) return;
    res.type('html').send(V.openShareScreen(tenant, ctx.s, ctx.m));
  });

  content.post('/member/:id/open-share', maintenanceGuard, (req, res) => {
    const ctx = servicing(req, res); if (!ctx) return;
    const { s, m } = ctx;
    const type = field(req, 'ddlShareType');
    const depositRaw = field(req, 'txtOpeningDeposit');

    if (m.status === 'DECEASED') {
      res.type('html').send(V.openShareScreen(tenant, s, m, `MSG 0455 - ${tenant.vocab.member.toUpperCase()} ${m.memberNumber} IS FLAGGED DECEASED. NEW ACCOUNTS MAY NOT BE OPENED.`));
      return;
    }
    if (!type) {
      res.type('html').send(V.openShareScreen(tenant, s, m, `MSG 0031 - ${tenant.vocab.share.toUpperCase()} TYPE IS REQUIRED. POSITION CURSOR AND RE-ENTER.`));
      return;
    }
    const cents = Math.round(Number(depositRaw.replace(/[$,]/g, '')) * 100);
    if (!depositRaw || !Number.isFinite(cents)) {
      res.type('html').send(V.openShareScreen(tenant, s, m, 'MSG 0007 - DATA ERROR: OPENING DEPOSIT MUST BE NUMERIC.'));
      return;
    }
    if (cents < 25_00) {
      res.type('html').send(V.openShareScreen(tenant, s, m, 'MSG 0212 - MINIMUM OPENING DEPOSIT FOR THIS PRODUCT IS $25.00.'));
      return;
    }
    // Next available suffix in the 01-09 club range; auto-assigned, never keyed.
    const used = new Set(m.shares.map((x) => x.suffix));
    let suffix = '';
    for (let i = 1; i <= 9; i++) { const c = String(i).padStart(2, '0'); if (!used.has(c)) { suffix = c; break; } }
    if (!suffix) {
      res.type('html').send(V.openShareScreen(tenant, s, m, 'MSG 0233 - NO AVAILABLE SUFFIX IN THE REQUESTED RANGE.'));
      return;
    }
    m.shares.push({ suffix, type: type as any, balanceCents: cents, availableCents: cents, status: 'OPEN', openedOn: '2026-09-21', dividendRate: '0.850%', holds: [] });
    const ref = REF('SVC');
    audit.push({ ref, at: new Date().toISOString(), operatorId: s.operatorId, action: 'OPEN_SHARE', memberNumber: m.memberNumber, detail: { suffix, type, amount: formatCents(cents) } });
    res.type('html').send(V.openShareConfirmScreen(tenant, s, m, suffix, type, formatCents(cents), ref));
  });

  // ── Address maintenance (dual control) ─────────────────────────────────────
  content.get('/member/:id/address', maintenanceGuard, (req, res) => {
    const ctx = servicing(req, res); if (!ctx) return;
    res.type('html').send(V.addressScreen(tenant, ctx.s, ctx.m));
  });

  content.post('/member/:id/address', maintenanceGuard, (req, res) => {
    const ctx = servicing(req, res); if (!ctx) return;
    const { s, m } = ctx;
    const line1 = field(req, 'txtLine1'), city = field(req, 'txtCity'), st = field(req, 'txtState'), zip = field(req, 'txtZip');
    if (!line1 || !city || !st || !zip) {
      res.type('html').send(V.addressScreen(tenant, s, m, 'MSG 0031 - REQUIRED FIELD IS MISSING OR INVALID. POSITION CURSOR AND RE-ENTER.'));
      return;
    }
    if (!/^\d{5}(-\d{4})?$/.test(zip)) {
      res.type('html').send(V.addressScreen(tenant, s, m, 'MSG 0074 - ZIP CODE MUST BE 5 OR 9 DIGITS.'));
      return;
    }
    const ref = REF('FM');
    audit.push({ ref, at: new Date().toISOString(), operatorId: s.operatorId, action: 'ADDRESS_CHANGE_SUBMITTED', memberNumber: m.memberNumber, detail: { line1, city, state: st, zip } });
    // Dual control: the change is queued, NOT applied. This is deliberate — it is
    // the single most common way automation silently "succeeds" while nothing
    // actually changed, so the capability's checkpoint has to assert the
    // pending-approval state rather than the new address.
    res.type('html').send(V.genericConfirmScreen(tenant, s, 'Address Maintenance - Submitted', 'SVC-0519',
      'MSG 0801 - REQUEST SUBMITTED FOR APPROVAL. THE CHANGE WILL NOT TAKE EFFECT UNTIL APPROVED BY A SECOND AUTHORIZED USER.',
      [['Maintenance Reference', ref], ['Status', 'PENDING APPROVAL'], [`${tenant.vocab.member} Number`, m.memberNumber], ['New Address', `${line1}, ${city}, ${st} ${zip}`]],
      `../${m.memberNumber}`));
  });

  // ── Stop payment (irreversible, fee bearing) ───────────────────────────────
  content.get('/member/:id/stop-pay', maintenanceGuard, (req, res) => {
    const ctx = servicing(req, res); if (!ctx) return;
    res.type('html').send(V.stopPaymentScreen(tenant, ctx.s, ctx.m));
  });

  content.post('/member/:id/stop-pay', maintenanceGuard, (req, res) => {
    const ctx = servicing(req, res); if (!ctx) return;
    const { s, m } = ctx;
    if (sim.scenario.forcePermissionDenied || s.role === 'TELLER') {
      res.type('html').send(V.permissionDeniedScreen(tenant, s, 'REQUIRED AUTHORITY LEVEL FOR TRANSACTION CODE STOP: 2. YOUR LEVEL: 1.'));
      return;
    }
    const checkNo = field(req, 'txtCheckNo');
    const amount = field(req, 'txtAmount');
    if (!/^\d{1,8}$/.test(checkNo)) {
      res.type('html').send(V.stopPaymentScreen(tenant, s, m, 'MSG 0007 - DATA ERROR: CHECK NUMBER MUST BE NUMERIC.'));
      return;
    }
    const ref = REF('SP');
    audit.push({ ref, at: new Date().toISOString(), operatorId: s.operatorId, action: 'STOP_PAYMENT', memberNumber: m.memberNumber, detail: { checkNo, amount } });
    res.type('html').send(V.genericConfirmScreen(tenant, s, 'Stop Payment - Confirmation', 'SVC-0749',
      'MSG 0740 - STOP PAYMENT ACCEPTED. A $32.00 FEE HAS BEEN ASSESSED.',
      [['Confirmation Number', ref], ['Check Number', checkNo], ['Amount', amount || '(ANY)'], ['Expires', '03/21/2027']],
      `../${m.memberNumber}`));
  });

  // ── Fee reversal (supervisor override) ─────────────────────────────────────
  content.get('/member/:id/fee-reversal', maintenanceGuard, (req, res) => {
    const ctx = servicing(req, res); if (!ctx) return;
    res.type('html').send(V.feeReversalScreen(tenant, ctx.s, ctx.m));
  });

  content.post('/member/:id/fee-reversal', maintenanceGuard, (req, res) => {
    const ctx = servicing(req, res); if (!ctx) return;
    const { s, m } = ctx;
    const txId = field(req, 'rblFee');
    const reason = field(req, 'txtReason');
    const tx = m.transactions.find((t) => t.id === txId);
    if (!tx) {
      res.type('html').send(V.feeReversalScreen(tenant, s, m, 'MSG 0031 - SELECT A FEE TRANSACTION TO REVERSE.'));
      return;
    }
    if (tx.reversed) {
      res.type('html').send(V.feeReversalScreen(tenant, s, m, `MSG 0244 - THIS FEE HAS ALREADY BEEN REVERSED. DUPLICATE REVERSAL IS NOT PERMITTED.`));
      return;
    }
    if (!reason) {
      res.type('html').send(V.feeReversalScreen(tenant, s, m, 'MSG 0031 - REVERSAL REASON IS REQUIRED.'));
      return;
    }
    const amt = Math.abs(tx.amountCents);
    if (amt > 25_00 && (s.role !== 'SUPERVISOR' || sim.scenario.forcePermissionDenied)) {
      res.type('html').send(V.permissionDeniedScreen(tenant, s, `INSUFFICIENT AUTHORITY FOR TRANSACTION CODE FEE-REV ABOVE $25.00. REQUIRED ROLE: SUPERVISOR. YOUR ROLE: ${s.role}.`));
      return;
    }
    tx.reversed = true;
    const share = m.shares.find((x) => x.suffix === tx.suffix);
    if (share) { share.balanceCents += amt; share.availableCents += amt; }
    const ref = REF('REV');
    audit.push({ ref, at: new Date().toISOString(), operatorId: s.operatorId, action: 'FEE_REVERSAL', memberNumber: m.memberNumber, detail: { transaction: tx.id, amount: formatCents(amt), reason } });
    res.type('html').send(V.genericConfirmScreen(tenant, s, 'Fee Reversal - Confirmation', 'SVC-0819',
      'MSG 0810 - FEE REVERSAL POSTED.',
      [['Journal Reference', ref], ['Original Transaction', tx.id], ['Amount Credited', formatCents(amt)], ['Account', `${m.memberNumber}-${tx.suffix}`]],
      `../${m.memberNumber}`));
  });

  app.use('/content', content);

  app.use((_req, res) => { res.status(404).type('html').send(V.transientErrorPage(tenant)); });

  return state;
}

export function startMeridian(tenantId: string): Promise<MeridianApp & { close(): Promise<void> }> {
  const m = createMeridian(tenantId);
  return new Promise((resolve) => {
    const server = m.app.listen(m.tenant.port, () => {
      // eslint-disable-next-line no-console
      console.log(`  MERIDIAN ${m.tenant.productVersion.padEnd(24)} ${m.tenant.institution.padEnd(38)} http://127.0.0.1:${m.tenant.port}`);
      resolve(Object.assign(m, { close: () => new Promise<void>((r) => server.close(() => r())) }));
    });
  });
}
