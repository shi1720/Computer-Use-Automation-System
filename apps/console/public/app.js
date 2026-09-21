/**
 * Swivel console — client.
 *
 * No framework, no build step. The console is dense, mostly read-only, and its
 * one genuinely interactive surface (the live takeover) is a websocket and an
 * <img>. A bundler would add a build to `npm start` and buy nothing.
 */

// ── tiny helpers ─────────────────────────────────────────────────────────────
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
};
/**
 * `replaceChildren`, minus the footgun.
 *
 * The native method stringifies whatever it is given, so a conditional child
 * written `cond ? h(…) : null` — the idiom this file uses everywhere —
 * renders the literal text "null" into the page. Two of them in a row rendered
 * "nullnull" on the run detail view for weeks. `h()` already filters its own
 * children; this makes the top-level call behave the same way.
 */
const setChildren = (el, ...kids) => el.replaceChildren(...kids.flat().filter((c) => c != null && c !== false));
const $ = (s, r = document) => r.querySelector(s);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function toast(message, kind) {
  const t = h('div', { class: `toast${kind === 'err' ? ' err' : ''}` }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 5200);
}

const statePill = (s) => {
  const map = { approved: 'ok', candidate: 'warn', draft: 'muted', deprecated: 'muted' };
  return h('span', { class: `pill ${map[s] ?? 'muted'}` }, s);
};
const statusPill = (s) => {
  const map = { success: 'ok', business_outcome: 'info', escalated: 'warn', failed: 'danger', open: 'warn', claimed: 'info', in_control: 'violet', returned: 'ok', resolved: 'muted', expired: 'muted' };
  const label = { business_outcome: 'outcome', in_control: 'in control' }[s] ?? s;
  return h('span', { class: `pill ${map[s] ?? 'muted'}` }, label);
};
/**
 * Tables are most of this console, so they get one builder rather than eight
 * hand-nested constructions. (The first version of this file had four of them
 * and an unbalanced parenthesis; this is the fix that stays fixed.)
 */
const dataTable = (headers, rows, onRowClick) =>
  h('table', {},
    h('thead', {}, h('tr', {}, headers.map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((cells, i) =>
      h('tr', onRowClick ? { class: 'click', onclick: () => onRowClick(i) } : {},
        cells.map((c) => h('td', {}, c))))));

const riskPill = (r) => h('span', { class: `pill ${r === 'read_only' ? 'ok' : r === 'irreversible' ? 'danger' : 'warn'}` }, r.replace('_', '-'));
const meter = (v) => h('span', { class: `meter ${v < 40 ? 'bad' : v < 70 ? 'low' : ''}`, title: `${v}/100` }, h('span', { style: `width:${Math.max(3, v)}%` }));

// ── app state ────────────────────────────────────────────────────────────────
const state = { user: null, interventions: [], capabilities: [], runs: [], route: location.hash || '#/capabilities', sse: null, live: null };

function go(hash) { location.hash = hash; }
window.addEventListener('hashchange', () => { state.route = location.hash; render(); });

// ── boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  try { state.user = (await api('/api/me')).user; } catch { state.user = null; }
  if (state.user) await refreshAll();
  render();
  if (state.user) connectEvents();
})();

async function refreshAll() {
  const [caps, runs, ints] = await Promise.all([
    api('/api/capabilities').catch(() => ({ capabilities: [] })),
    api('/api/runs').catch(() => ({ runs: [] })),
    api('/api/interventions').catch(() => ({ interventions: [] })),
  ]);
  state.capabilities = caps.capabilities;
  state.runs = runs.runs;
  state.interventions = ints.interventions;
}

function connectEvents() {
  const es = new EventSource('/api/events');
  state.sse = es;
  es.addEventListener('intervention', (e) => {
    const i = JSON.parse(e.data);
    const existing = state.interventions.findIndex((x) => x.id === i.id);
    if (existing >= 0) state.interventions[existing] = i; else state.interventions.unshift(i);
    if (i.status === 'open') toast(`Intervention raised: ${i.context.diagnosis.message.slice(0, 120)}`);

    // Never re-render the live takeover view from a background event.
    //
    // It owns a websocket and a set of DOM nodes the screencast writes into;
    // replacing them mid-session silently detaches the video feed from the
    // page. Claiming a ticket emits an update about the very ticket being
    // watched, so this is not a rare race — it is the common path.
    if (onLiveSession()) { updateNavCounts(); return; }
    if (state.route.startsWith('#/operators')) render();
    else updateNavCounts();
  });
  es.addEventListener('run.finished', async () => {
    state.runs = (await api('/api/runs')).runs;
    if (state.route.startsWith('#/runs') && !onLiveSession()) render();
  });
}

// ── render ───────────────────────────────────────────────────────────────────
function render() {
  const root = $('#root');
  setChildren(root, state.user ? shell() : loginView());
}

function loginView() {
  const err = h('div');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      setChildren(err);
      try {
        const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ id: $('#u').value, password: $('#p').value }) });
        state.user = r.user;
        await refreshAll();
        render();
        connectEvents();
      } catch (e2) { setChildren(err, h('div', { class: 'err-box' }, e2.message)); }
    },
  },
    err,
    h('label', { class: 'field' }, h('span', {}, 'User'), h('input', { id: 'u', autofocus: true, autocomplete: 'username', value: 'shivam' })),
    h('label', { class: 'field' }, h('span', {}, 'Password'), h('input', { id: 'p', type: 'password', autocomplete: 'current-password', value: 'swivel' })),
    h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;justify-content:center' }, 'Sign in'),
  );

  return h('div', { class: 'login' },
    h('div', { class: 'box' },
      h('div', { class: 'brand' },
        h('div', { class: 'mark' }, '◧'),
        h('div', { class: 'name' }, 'SWIVEL'),
        h('div', { class: 'tag' }, 'capability control plane'),
      ),
      h('div', { class: 'card' }, form,
        h('div', { class: 'hint' },
          h('div', {}, h('strong', {}, 'Demo accounts')),
          h('div', { class: 'mono' }, 'shivam / swivel — author, approve, invoke'),
          h('div', { class: 'mono' }, 'reviewer / swivel — approve only'),
          h('div', { class: 'mono' }, 'operator / swivel — session takeover only'),
        )),
    ));
}

function shell() {
  const openInts = state.interventions.filter((i) => ['open', 'claimed', 'in_control'].includes(i.status)).length;
  const navItem = (hash, label, count) => h('a', {
    class: `nav-item${state.route.startsWith(hash) ? ' active' : ''}`, href: hash,
  }, h('span', {}, label), count ? h('span', { class: 'count' }, count) : null);

  return h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'mark' }, '◧'),
        h('div', {}, h('div', { class: 'name' }, 'SWIVEL'), h('div', { class: 'tag' }, 'control plane'))),
      navItem('#/capabilities', 'Capabilities', state.capabilities.length),
      navItem('#/runs', 'Runs', state.runs.length),
      navItem('#/operators', 'Operator queue', openInts || null),
      navItem('#/tenants', 'Tenants'),
      h('div', { class: 'nav-sep' }),
      navItem('#/agents', 'Agent interface'),
      h('div', { class: 'sidebar-foot' },
        h('div', { class: 'small' }, state.user.name),
        h('div', { class: 'small faint mono' }, state.user.role),
        h('button', { class: 'btn ghost sm mt', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); state.user = null; state.sse?.close(); render(); } }, 'Sign out'),
      ),
    ),
    h('main', { class: 'main', id: 'main' }, routeView()),
  );
}

const onLiveSession = () => /^#\/operators\/.+/.test(state.route);

/** Update the sidebar badge in place, without disturbing the current view. */
function updateNavCounts() {
  const open = state.interventions.filter((i) => ['open', 'claimed', 'in_control'].includes(i.status)).length;
  const link = document.querySelector('a[href="#/operators"] .count');
  const item = document.querySelector('a[href="#/operators"]');
  if (link) link.textContent = open ? String(open) : '';
  else if (item && open) item.append(h('span', { class: 'count' }, String(open)));
}

function routeView() {
  const [, section, id] = state.route.split('/');
  switch (section) {
    case 'capabilities': return id ? capabilityDetail(decodeURIComponent(id)) : capabilitiesView();
    case 'runs': return id ? runDetail(id) : runsView();
    case 'operators': return id ? operatorView(id) : operatorsView();
    case 'tenants': return tenantsView();
    case 'agents': return agentsView();
    default: return capabilitiesView();
  }
}

// ── capabilities ─────────────────────────────────────────────────────────────
function capabilitiesView() {
  const caps = state.capabilities;
  const wrap = h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Capabilities'),
        h('div', { class: 'sub' }, 'Recorded once by a model. Replayed deterministically, with no model in the loop.')),
    ),
  );

  if (!caps.length) {
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('div', {}, 'No capabilities recorded yet.'),
      h('div', { class: 'mono mt' }, 'npx swivel discover --goal "…" --param memberNumber=0100482'))));
    return wrap;
  }

  const summary = h('div', { class: 'grid three mb' },
    statCard('Approved', caps.filter((c) => c.approvalState === 'approved').length, 'invocable unattended by an agent'),
    statCard('Read-only', caps.filter((c) => !c.effects.mutating).length, `of ${caps.length} total`),
    statCard('Replays', caps.reduce((a, c) => a + c.replays.total, 0), `${caps.reduce((a, c) => a + c.replays.failed, 0)} failed`),
  );

  const headers = ['Capability', 'Version', 'State', 'Risk', 'Steps', 'Replays', 'Stability', 'Validation'];
  const rows = caps.map((c) => [
    h('div', {}, h('div', { class: 'mono' }, c.id), h('div', { class: 'small muted' }, c.title)),
    h('span', { class: 'mono small' }, c.version),
    statePill(c.approvalState),
    riskPill(c.effects.riskClass),
    h('span', { class: 'mono small' }, String(c.steps)),
    h('span', { class: 'mono small' }, `${c.replays.success + c.replays.businessOutcome}/${c.replays.total}`),
    c.replays.total ? meter(c.stabilityScore) : h('span', { class: 'faint small' }, '—'),
    c.findings ? h('span', { class: 'pill warn' }, `${c.findings} findings`) : h('span', { class: 'pill ok' }, 'clean'),
  ]);

  wrap.append(summary, h('div', { class: 'card' },
    dataTable(headers, rows, (i) => go(`#/capabilities/${encodeURIComponent(caps[i].id)}`))));
  return wrap;
}

function statCard(label, value, sub) {
  return h('div', { class: 'card' },
    h('div', { class: 'small muted' }, label),
    h('div', { style: 'font-size:26px;font-weight:650;letter-spacing:-.02em;margin:2px 0' }, String(value)),
    h('div', { class: 'small faint' }, sub));
}

function capabilityDetail(id) {
  const wrap = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  (async () => {
    let data;
    try { data = await api(`/api/capabilities/${encodeURIComponent(id)}`); }
    catch (e) { setChildren(wrap, h('div', { class: 'err-box' }, e.message)); return; }
    const cap = data.capability;
    const tabs = { Contract: () => contractTab(cap, data), Flow: () => flowTab(cap), Signals: () => signalsTab(cap), Evidence: () => provenanceTab(cap, data), 'Tool definition': () => h('pre', { class: 'json' }, JSON.stringify(data.tool, null, 2)), Artifact: () => h('pre', { class: 'json' }, JSON.stringify(cap, null, 2)) };
    let active = 'Contract';
    const body = h('div', {});
    const paint = () => setChildren(body, tabs[active]());
    const tabBar = h('div', { class: 'tabs' }, Object.keys(tabs).map((t) =>
      h('div', { class: `tab${t === active ? ' active' : ''}`, onclick: (e) => { active = t; [...e.target.parentNode.children].forEach((x) => x.classList.toggle('active', x === e.target)); paint(); } }, t)));
    paint();

    const approve = h('button', {
      class: 'btn primary',
      disabled: cap.quality.approvalState === 'approved' || !state.user.roles.includes('capability.approve'),
      onclick: async () => {
        const note = prompt('Approval note for the audit trail (what did you check?)');
        if (note === null) return;
        try {
          await api(`/api/capabilities/${encodeURIComponent(cap.metadata.id)}/approve`, { method: 'POST', body: JSON.stringify({ version: cap.metadata.version, note, contentHash: data.contentHash }) });
          toast('Approved. AI agents may now invoke this capability unattended.');
          await refreshAll(); render();
        } catch (e) { toast(e.message, 'err'); }
      },
    }, cap.quality.approvalState === 'approved' ? 'Approved' : 'Approve for unattended use');

    setChildren(wrap, 
      h('div', { class: 'crumb' }, h('a', { href: '#/capabilities' }, 'Capabilities'), ' / ', cap.metadata.id),
      h('div', { class: 'page-head' },
        h('div', {},
          h('h1', {}, cap.metadata.title),
          h('div', { class: 'sub' }, cap.metadata.summary)),
        h('div', { class: 'row' }, statePill(cap.quality.approvalState), riskPill(cap.contract.effects.riskClass), approve)),
      h('div', { class: 'card mb' }, runPanel(cap)),
      tabBar, body,
    );
  })();
  return wrap;
}

function contractTab(cap, data) {
  const fields = (list, kind) => list.length
    ? h('table', {}, h('thead', {}, h('tr', {}, ['Field', 'Type', 'Description', kind === 'in' ? 'Required' : 'Sensitivity'].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map((f) => h('tr', {},
          h('td', { class: 'mono' }, f.name),
          h('td', {}, h('span', { class: 'pill muted' }, f.type)),
          h('td', { class: 'muted' }, f.description),
          h('td', {}, kind === 'in' ? (f.required ? h('span', { class: 'pill info' }, 'required') : h('span', { class: 'faint small' }, 'optional'))
            : h('span', { class: `pill ${f.sensitivity === 'pii' || f.sensitivity === 'secret' ? 'danger' : f.sensitivity === 'sensitive' ? 'warn' : 'muted'}` }, f.sensitivity ?? 'internal'))))))
    : h('div', { class: 'faint small' }, 'none');

  return h('div', {},
    h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Effects')),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Mutating'), h('dd', {}, cap.contract.effects.mutating ? h('span', { class: 'pill warn' }, 'changes records') : h('span', { class: 'pill ok' }, 'read-only')),
          h('dt', {}, 'Reversible'), h('dd', {}, cap.contract.effects.reversible ? 'yes' : h('span', { class: 'pill danger' }, 'irreversible')),
          h('dt', {}, 'Financial impact'), h('dd', {}, cap.contract.effects.financialImpact ? h('span', { class: 'pill danger' }, 'yes') : 'no'),
          h('dt', {}, 'Dual control'), h('dd', {}, cap.contract.effects.dualControl ? h('span', { class: 'pill warn' }, 'second approver required') : 'no'),
          h('dt', {}, 'Confirmation'), h('dd', {}, cap.policy.requiresPerInvocationConfirmation ? h('span', { class: 'pill warn' }, 'token required per call') : 'not required'),
        ),
        cap.contract.effects.summary ? h('p', { class: 'small muted mt' }, cap.contract.effects.summary) : null),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Guardrails')),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Allowed origins'), h('dd', { class: 'mono small' }, cap.policy.allowedOrigins.join(', ')),
          h('dt', {}, 'Allowed paths'), h('dd', { class: 'mono small' }, cap.policy.allowedPathPatterns.join(', ') || 'any within origin'),
          h('dt', {}, 'Allowed actions'), h('dd', { class: 'mono small' }, cap.policy.allowedActions.join(' ')),
          h('dt', {}, 'Budgets'), h('dd', { class: 'small' }, `${cap.policy.maxSteps} steps · ${cap.policy.maxDurationMs / 1000}s`),
        )),
    ),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Inputs')), fields(cap.contract.inputs, 'in')),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Outputs')), fields(cap.contract.outputs, 'out')),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Business outcomes'),
      h('span', { class: 'small faint' }, 'answers the caller branches on — not errors')),
      h('table', {}, h('thead', {}, h('tr', {}, ['Code', 'Kind', 'Description', 'Retryable'].map((t) => h('th', {}, t)))),
        h('tbody', {}, cap.contract.outcomes.map((o) => h('tr', {},
          h('td', { class: 'mono' }, o.code),
          h('td', {}, h('span', { class: `pill ${o.kind === 'business' ? 'info' : 'danger'}` }, o.kind)),
          h('td', { class: 'muted' }, o.description),
          h('td', { class: 'small' }, o.retryable ? 'yes' : 'no')))))),
    data.findings?.length ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Validation findings')),
      h('div', {}, data.findings.map((f) => h('div', { class: 'small', style: 'padding:6px 0;border-bottom:1px solid var(--border)' },
        h('span', { class: `pill ${f.severity === 'error' ? 'danger' : f.severity === 'warning' ? 'warn' : 'muted'}` }, f.severity), ' ',
        h('span', { class: 'mono' }, f.code), ' ', h('span', { class: 'faint mono' }, f.at),
        h('div', { class: 'muted', style: 'margin-top:3px' }, f.message))))) : null,
  );
}

function flowTab(cap) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Flow'), h('span', { class: 'small faint' }, `${cap.flow.steps.length} steps · read the intents, not the selectors`)),
    h('div', {}, cap.flow.steps.map((s, i) => h('div', { class: 'step' },
      h('div', { class: 'n' }, String(i + 1)),
      h('div', {},
        h('div', { class: 'intent' }, s.intent, ' ',
          s.risk && s.risk !== 'read_only' ? riskPill(s.risk) : null,
          s.authoredBy === 'human' ? h('span', { class: 'pill violet' }, 'human-authored') : null,
          s.authoredBy === 'overlay' ? h('span', { class: 'pill info' }, 'from overlay') : null),
        s.target ? h('div', { class: 'detail' }, `${s.target.role} · ${s.target.note ?? ''}`) : null,
        s.url ? h('div', { class: 'detail' }, s.url) : null,
        s.value ? h('div', { class: 'detail' }, `value: ${s.value}`) : null,
        s.extract ? h('div', { class: 'detail' }, `→ output "${s.extract.into}" (${s.extract.transform})`) : null,
        s.expect ? h('div', { class: 'check' }, `✓ ${s.expect.description}`) : null,
      )))),
    h('div', { style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--border)' },
      h('h3', { class: 'muted mb' }, 'SUCCESS CONDITION'),
      h('div', { class: 'check' }, `✓ ${cap.flow.successCheckpoint.description}`)));
}

function signalsTab(cap) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Runtime signals'),
      h('span', { class: 'small faint' }, 'evaluated after every step; first match decides what happens')),
    h('table', {}, h('thead', {}, h('tr', {}, ['Signal', 'Disposition', 'Response', 'Detection'].map((t) => h('th', {}, t)))),
      h('tbody', {}, cap.signals.map((s) => h('tr', {},
        h('td', {}, h('div', {}, s.title), h('div', { class: 'mono small faint' }, s.id)),
        h('td', {}, h('span', { class: `pill ${s.kind === 'business' ? 'info' : s.kind === 'recoverable' ? 'violet' : s.kind === 'escalate' ? 'warn' : 'danger'}` }, s.kind)),
        h('td', { class: 'small muted' }, s.outcomeCode ? `→ ${s.outcomeCode}` : s.recovery ? `${s.recovery.strategy} ×${s.recovery.maxAttempts}${s.exhaustedOutcomeCode ? `, then ${s.exhaustedOutcomeCode}` : ''}` : '—'),
        h('td', { class: 'mono small faint' }, (s.detect[0]?.regex ?? s.detect[0]?.text ?? '').slice(0, 60))))))); 
}

function provenanceTab(cap, data) {
  return h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Provenance')),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Discovered'), h('dd', {}, fmtTime(cap.provenance.discoveredAt)),
        h('dt', {}, 'By'), h('dd', { class: 'mono small' }, `${cap.provenance.discoveredBy.kind} · ${cap.provenance.discoveredBy.provider ?? '—'}/${cap.provenance.discoveredBy.model ?? '—'}`),
        h('dt', {}, 'Goal'), h('dd', { class: 'muted' }, cap.provenance.goal),
        h('dt', {}, 'Recorded on'), h('dd', {}, cap.provenance.recordedOnTenant ?? '—'),
        h('dt', {}, 'Content hash'), h('dd', { class: 'mono small' }, data.contentHash),
        h('dt', {}, 'Approved by'), h('dd', {}, cap.quality.approvedBy ? `${cap.quality.approvedBy} · ${fmtTime(cap.quality.approvedAt)}` : h('span', { class: 'faint' }, 'not approved')),
      )),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'History')),
      h('div', { class: 'timeline' }, cap.provenance.history.map((e) => h('div', { class: 'tl-row' },
        h('div', { class: 'tl-seq' }, ''), h('div', { class: 'tl-kind' }, e.action), h('div', { class: 'tl-msg' }, `${e.actor} · ${fmtTime(e.at)}${e.note ? ` — ${e.note}` : ''}`))))),
    data.overlays?.length ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Tenant overlays'),
      h('span', { class: 'small faint' }, 'the same artifact, specialised per institution')),
      h('table', {}, h('thead', {}, h('tr', {}, ['Tenant', 'Overlay', 'Vocabulary', 'Patches', 'Overrides'].map((t) => h('th', {}, t)))),
        h('tbody', {}, data.overlays.map((o) => h('tr', {},
          h('td', {}, o.metadata.institution),
          h('td', { class: 'mono small' }, o.metadata.id),
          h('td', { class: 'mono small muted' }, Object.entries(o.vocabulary).map(([k, v]) => `${k}="${v}"`).join(' ') || '—'),
          h('td', { class: 'mono small' }, o.stepPatches.length),
          h('td', { class: 'mono small' }, Object.keys(o.targetOverrides).length)))))) : null);
}

function runPanel(cap) {
  const inputs = {};
  const tenantSel = h('select', {}, h('option', { value: 'pineridge' }, 'Pine Ridge FCU — Meridian 9.2'), h('option', { value: 'harborpoint' }, 'Harbor Point Bank — Meridian 10.1'));
  const out = h('div', {});
  const fields = cap.contract.inputs.map((f) => h('label', { class: 'field' },
    h('span', {}, f.name, ' ', h('span', { class: 'hint' }, `${f.type}${f.required ? ' · required' : ''}`)),
    h('input', { value: f.example ?? '', oninput: (e) => { inputs[f.name] = e.target.value; } })));
  for (const f of cap.contract.inputs) inputs[f.name] = f.example ?? '';

  const btn = h('button', { class: 'btn primary', onclick: async () => {
    btn.disabled = true; btn.textContent = 'Running…';
    setChildren(out, h('div', { class: 'small muted' }, 'Replaying — no model in the loop.'));
    try {
      const body = { version: cap.metadata.version, tenant: tenantSel.value, inputs, unattended: false };
      if (cap.policy.requiresPerInvocationConfirmation) body.confirmationToken = `console-${Date.now()}`;
      const r = await api(`/api/capabilities/${encodeURIComponent(cap.metadata.id)}/invoke`, { method: 'POST', body: JSON.stringify(body) });
      setChildren(out, resultCard(r));
      await refreshAll();
    } catch (e) { setChildren(out, h('div', { class: 'err-box' }, e.message)); }
    btn.disabled = false; btn.textContent = 'Replay';
  } }, 'Replay');

  return h('div', {},
    h('div', { class: 'card-head' }, h('h2', {}, 'Invoke'), h('span', { class: 'small faint' }, 'deterministic · 0 model calls')),
    h('div', { class: 'grid two' },
      h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Tenant'), tenantSel), fields),
      h('div', {}, btn, out)));
}

function resultCard(r) {
  const rows = [];
  if (r.status === 'success') rows.push(['Outputs', h('pre', { class: 'json' }, JSON.stringify(r.outputs, null, 2))]);
  if (r.status === 'business_outcome') rows.push(['Outcome', h('div', {}, h('span', { class: 'pill info' }, r.outcome.code), ' ', h('span', { class: 'muted small' }, r.outcome.message))]);
  if (r.status === 'failed') rows.push(['Error', h('div', {}, h('span', { class: 'pill danger' }, r.error.class), h('div', { class: 'small muted mt' }, r.error.message),
    r.error.expected ? h('div', { class: 'small faint mono mt' }, `expected: ${r.error.expected}`) : null,
    r.error.observed ? h('div', { class: 'small faint mono' }, `observed: ${r.error.observed}`) : null)]);
  if (r.status === 'escalated') rows.push(['Escalation', h('div', { class: 'small' }, `${r.intervention.reason} → ${r.intervention.resolution ?? 'pending'} (${r.intervention.humanActions} recorded human actions)`)]);
  if (r.recoveries?.length) rows.push(['Recovered', h('div', { class: 'small' }, r.recoveries.map((x) => h('div', {}, `${x.signalTitle} — ${x.strategy} ×${x.attempts}`)))]);

  return h('div', { style: 'margin-top:12px' },
    h('div', { class: 'row mb' }, statusPill(r.status), h('span', { class: 'small faint mono' }, `${r.durationMs}ms · ${r.steps.length} steps · quality ${r.runQuality}`),
      h('a', { class: 'small', href: `#/runs/${r.runId}` }, 'evidence →')),
    h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
}

// ── runs ─────────────────────────────────────────────────────────────────────
function runsView() {
  const rows = state.runs.map((r) => [
    h('span', { class: 'mono small' }, r.runId),
    h('span', { class: `pill ${r.kind === 'discovery' ? 'violet' : 'muted'}` }, r.kind),
    h('span', { class: 'mono small' }, r.capabilityId ?? '—'),
    h('span', { class: 'small' }, r.tenantId ?? '—'),
    statusPill(r.status),
    h('span', { class: 'mono small' }, r.durationMs ? `${r.durationMs}ms` : '—'),
    h('span', { class: 'small muted' }, (r.summary ?? '').slice(0, 60)),
    h('span', { class: 'small faint' }, ago(r.startedAt)),
  ]);

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Runs'),
        h('div', { class: 'sub' }, 'Every run leaves a hash-chained evidence bundle. Nothing is summarised away.'))),
    h('div', { class: 'card' }, state.runs.length
      ? dataTable(['Run', 'Kind', 'Capability', 'Tenant', 'Status', 'Duration', 'Summary', 'When'], rows,
          (i) => go(`#/runs/${state.runs[i].runId}`))
      : h('div', { class: 'empty' }, 'No runs yet.')));
}

function runDetail(runId) {
  const wrap = h('div', {}, h('div', { class: 'empty' }, 'Loading evidence…'));
  (async () => {
    let d;
    try { d = await api(`/api/runs/${runId}`); }
    catch (e) { setChildren(wrap, h('div', { class: 'err-box' }, e.message)); return; }
    const { run, manifest, events, chain } = d;

    const shots = events.filter((e) => e.data?.evidence?.screenshot).map((e) => e.data.evidence.screenshot);
    const kindClass = (k) => k.includes('fail') || k.includes('blocked') ? 'err' : k.startsWith('signal') ? 'sig' : k.startsWith('recovery') ? 'rec' : k.startsWith('escalation') ? 'esc' : k.startsWith('model') ? 'model' : '';

    setChildren(wrap, 
      h('div', { class: 'crumb' }, h('a', { href: '#/runs' }, 'Runs'), ' / ', runId),
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, run.summary ?? runId),
          h('div', { class: 'sub mono small' }, `${run.kind} · ${run.capabilityId ?? ''} · ${run.tenantId ?? ''} · ${fmtTime(run.startedAt)}`)),
        h('div', { class: 'row' }, statusPill(run.status),
          // Three states, not two. A chain can be intact, broken at a named
          // event, or *absent* — and "broken at undefined" is what the last one
          // used to read, which tells a reviewer nothing about the one case
          // they most need to understand.
          h('span', { class: `pill ${chain.ok ? 'ok' : 'danger'}`, title: chain.message },
            chain.ok ? `✓ chain intact (${chain.events})`
              : chain.brokenAt != null ? `✗ chain broken at event ${chain.brokenAt}`
              : chain.events ? '✗ chain incomplete'
              : '✗ no evidence bundle'))),

      // A run row whose bundle is gone is exactly the case an examiner asks
      // about, so it is stated rather than rendered as an empty page.
      !events.length && !manifest
        ? h('div', { class: 'err-box' },
            `This run has no readable evidence bundle at ${run.evidenceDir}. ` +
            `Either it is still in flight, or the directory has been removed since the run finished.`)
        : null,

      manifest ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Manifest')),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Principal'), h('dd', { class: 'mono small' }, `${manifest.principal?.id} (${manifest.principal?.kind})`),
          h('dt', {}, 'Inputs'), h('dd', { class: 'mono small' }, JSON.stringify(manifest.inputs ?? {})),
          h('dt', {}, 'Redactions'), h('dd', { class: 'mono small' }, Object.entries(manifest.redaction ?? {}).map(([k, v]) => `${k}×${v}`).join(' ') || 'none'),
          h('dt', {}, 'Chain tip'), h('dd', { class: 'mono small' }, (manifest.chainTip ?? '').slice(0, 24)),
          h('dt', {}, 'Outcome'), h('dd', {}, h('pre', { class: 'json' }, JSON.stringify(manifest.outcome ?? {}, null, 2))),
        )) : null,

      shots.length ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Screen captures'), h('span', { class: 'small faint' }, 'taken at every failure and escalation')),
        h('div', { class: 'grid two' }, shots.map((p) => h('a', { href: `/api/runs/${runId}/file?path=${encodeURIComponent(p)}`, target: '_blank' },
          h('img', { src: `/api/runs/${runId}/file?path=${encodeURIComponent(p)}`, style: 'width:100%;border:1px solid var(--border);border-radius:6px' }))))) : null,

      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Evidence timeline'), h('span', { class: 'small faint' }, `${events.length} hash-chained events`)),
        h('div', { class: 'timeline' }, events.map((e) => h('div', { class: `tl-row ${kindClass(e.kind)}` },
          h('div', { class: 'tl-seq' }, String(e.seq)),
          h('div', { class: 'tl-kind' }, e.kind),
          h('div', { class: 'tl-msg' }, e.message,
            e.data ? h('div', { class: 'faint', style: 'margin-top:2px' }, JSON.stringify(e.data).slice(0, 260)) : null))))));
  })();
  return wrap;
}

// ── operator queue and live takeover ─────────────────────────────────────────
function operatorsView() {
  const items = state.interventions;
  const rows = items.map((i) => [
    h('span', { class: 'mono small' }, i.id),
    statusPill(i.status),
    h('span', { class: 'pill warn' }, i.reason.replace(/_/g, ' ')),
    h('span', { class: 'small' }, i.context.capability?.title ?? i.context.goal ?? '—'),
    h('span', { class: 'small muted' }, i.context.diagnosis.message.slice(0, 70)),
    h('span', { class: 'small faint' }, ago(i.createdAt)),
  ]);

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Operator queue'),
        h('div', { class: 'sub' }, 'A stuck run pauses and keeps its session alive. You take over the live browser, not a ticket.'))),
    h('div', { class: 'card' }, items.length
      ? dataTable(['Ticket', 'Status', 'Reason', 'Capability', 'Why it stopped', 'Raised'], rows,
          (idx) => go(`#/operators/${items[idx].id}`))
      : h('div', { class: 'empty' },
          h('div', {}, 'Nothing needs a human right now.'),
          h('div', { class: 'small mt' }, 'Trigger one: ', h('span', { class: 'mono' }, 'npm run demo:escalate')))));
}

function operatorView(id) {
  const wrap = h('div', {}, h('div', { class: 'empty' }, 'Loading ticket…'));
  (async () => {
    let i;
    try { i = (await api(`/api/interventions/${id}`)).intervention; }
    catch (e) { setChildren(wrap, h('div', { class: 'err-box' }, e.message)); return; }

    const log = h('div', { class: 'action-log' });
    const statusDot = h('span', { class: 'dot idle' });
    const statusText = h('span', { class: 'small muted' }, 'not connected');
    const frame = h('img', { alt: 'live session', style: 'display:none' });
    const off = h('div', { class: 'live-off' }, 'Claim the session to take control of the live browser.');
    const viewport = i.context.control?.viewport ?? { width: 1280, height: 860 };

    const pushLog = (t) => { log.prepend(h('div', {}, `${new Date().toLocaleTimeString()}  ${t}`)); };

    let ws = null;
    const connect = () => {
      const ctl = i.context.control;
      if (!ctl) { toast('This ticket has no live-control channel — the run may have ended.', 'err'); return; }
      // The token rides in the subprotocol rather than the query string: a URL
      // that can drive a live teller session should not land in an access log.
      ws = new WebSocket(ctl.wsUrl, [`swivel.token.${ctl.token}`]);
      ws.onopen = () => { statusDot.className = 'dot live'; statusText.textContent = 'connected — you are driving the live session'; frame.style.display = 'block'; off.style.display = 'none'; };
      ws.onclose = () => { statusDot.className = 'dot idle'; statusText.textContent = 'disconnected'; };
      ws.onerror = () => { statusDot.className = 'dot err'; statusText.textContent = 'connection error'; };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'frame') frame.src = `data:image/jpeg;base64,${m.data}`;
        else if (m.t === 'denied') pushLog(`denied — ${m.reason}`);
        else if (m.t === 'error') pushLog(`error — ${m.message}`);
      };
    };

    // Map a click on the rendered image back to viewport coordinates.
    const toViewport = (e) => {
      const r = frame.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * viewport.width, y: ((e.clientY - r.top) / r.height) * viewport.height };
    };
    const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

    frame.addEventListener('mousedown', (e) => { e.preventDefault(); const p = toViewport(e); send({ t: 'mouse', type: 'mousePressed', ...p, button: 'left', clickCount: 1 }); });
    frame.addEventListener('mouseup', (e) => { const p = toViewport(e); send({ t: 'mouse', type: 'mouseReleased', ...p, button: 'left', clickCount: 1 }); pushLog(`click (${Math.round(p.x)}, ${Math.round(p.y)})`); });
    frame.addEventListener('wheel', (e) => { e.preventDefault(); const p = toViewport(e); send({ t: 'wheel', ...p, dx: e.deltaX, dy: e.deltaY }); }, { passive: false });

    const keyHandler = (e) => {
      if (!ws || ws.readyState !== 1) return;
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { send({ t: 'text', value: e.key }); }
      else { send({ t: 'key', type: 'down', key: e.key }); send({ t: 'key', type: 'up', key: e.key }); pushLog(`key ${e.key}`); }
    };
    document.addEventListener('keydown', keyHandler);
    window.addEventListener('hashchange', () => document.removeEventListener('keydown', keyHandler), { once: true });

    // The header's status pill, updated in place.
    //
    // Re-rendering the view would be the obvious way to refresh it and is the
    // one thing this page must not do: the live session lives in DOM this view
    // owns, and replacing it drops the operator's connection mid-takeover. So
    // the two things that change on a claim are changed directly.
    const pill = statusPill(i.status);
    const showStatus = (status) => {
      const next = statusPill(status);
      pill.className = next.className;
      pill.textContent = next.textContent;
    };

    const claimBtn = h('button', { class: 'btn primary', disabled: i.status !== 'open', onclick: async () => {
      try {
        claimBtn.disabled = true;
        await api(`/api/interventions/${id}/claim`, { method: 'POST' });
        showStatus('claimed');
        toast('Claimed. Waiting for the run to hand over control…');
        // The run grants control asynchronously; poll briefly for the channel.
        for (let n = 0; n < 40; n++) {
          i = (await api(`/api/interventions/${id}`)).intervention;
          if (i.context.control) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        showStatus(i.context.control ? 'in_control' : i.status);
        if (i.context.control) {
          // The button's job is done and its label should say so. Leaving it
          // reading "Claim and take control" next to a live session invites the
          // operator to wonder whether the claim worked.
          claimBtn.textContent = 'You have control';
          connect();
          pushLog('control granted');
        } else {
          toast('The run has not granted control yet.', 'err');
          claimBtn.disabled = false;
        }
      } catch (e) { claimBtn.disabled = false; toast(e.message, 'err'); }
    } }, 'Claim and take control');

    const handBack = (resolution, label, cls) => h('button', { class: `btn ${cls}`, onclick: async () => {
      const note = prompt(`What did you do? (recorded on the run's evidence chain)`) ?? '';
      try {
        await api(`/api/interventions/${id}/return`, { method: 'POST', body: JSON.stringify({ resolution, note }) });
        ws?.close();
        toast(`Control returned — ${label}.`);
        await refreshAll(); go('#/operators');
      } catch (e) { toast(e.message, 'err'); }
    } }, label);

    // If this operator already holds the channel — they claimed it a moment ago,
    // or reloaded the page mid-session — reconnect straight away. Losing the
    // live session to a browser refresh would be an unforced error.
    if (i.context.control && ['claimed', 'in_control'].includes(i.status)) {
      claimBtn.textContent = 'You have control';
      setTimeout(() => { connect(); pushLog('reconnected to the live session'); }, 0);
    }

    setChildren(wrap, 
      h('div', { class: 'crumb' }, h('a', { href: '#/operators' }, 'Operator queue'), ' / ', id),
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, i.context.capability?.title ?? 'Intervention'),
          h('div', { class: 'sub' }, i.context.diagnosis.message)),
        h('div', { class: 'row' }, pill, claimBtn)),

      h('div', { class: 'grid two' },
        h('div', {},
          h('div', { class: 'live-wrap' },
            h('div', { class: 'live-bar' }, statusDot, statusText, h('span', { class: 'spacer' }),
              h('span', { class: 'mono small faint' }, `${viewport.width}×${viewport.height}`)),
            h('div', { style: 'position:relative' }, frame, off)),
          h('div', { class: 'row mt' },
            handBack('resume', 'Hand back — resume the run', 'primary'),
            handBack('completed_by_human', 'Hand back — I completed it', ''),
            handBack('abort', 'Abort the run', 'danger')),
          h('div', { class: 'small faint mt' }, 'Your clicks and keystrokes are forwarded to the same browser session the automation was using, and every one is recorded on the run\'s evidence chain.')),

        h('div', {},
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Context')),
            h('dl', { class: 'kv' },
              h('dt', {}, 'Run'), h('dd', {}, h('a', { href: `#/runs/${i.context.runId}` }, i.context.runId)),
              h('dt', {}, 'Institution'), h('dd', {}, i.context.tenant?.institution ?? '—'),
              h('dt', {}, 'Step'), h('dd', { class: 'small' }, i.context.stepIntent ?? '—'),
              h('dt', {}, 'Diagnosis'), h('dd', { class: 'small mono' }, i.context.diagnosis.code),
              i.context.diagnosis.expected ? h('dt', {}, 'Expected') : null,
              i.context.diagnosis.expected ? h('dd', { class: 'small mono faint' }, i.context.diagnosis.expected) : null,
              i.context.diagnosis.observed ? h('dt', {}, 'Observed') : null,
              i.context.diagnosis.observed ? h('dd', { class: 'small mono faint' }, i.context.diagnosis.observed) : null,
              h('dt', {}, 'Inputs'), h('dd', { class: 'mono small' }, JSON.stringify(i.context.inputs ?? {})),
              h('dt', {}, 'URL'), h('dd', { class: 'mono small faint' }, i.context.url))),
          i.context.screenshotRef ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Screen when it stopped')),
            h('img', { src: `/api/runs/${i.context.runId}/file?path=${encodeURIComponent(i.context.screenshotRef)}`, style: 'width:100%;border-radius:6px;border:1px solid var(--border)' })) : null,
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Your actions'), h('span', { class: 'small faint' }, 'recorded')), log))),
    );
  })();
  return wrap;
}

// ── tenants ──────────────────────────────────────────────────────────────────
function tenantsView() {
  const wrap = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  (async () => {
    const { tenants } = await api('/api/tenants');
    setChildren(wrap, 
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Tenants'),
        h('div', { class: 'sub' }, 'Institutions running the same vendor product. One capability, one overlay each — never a re-recording.'))),
      h('div', { class: 'grid two' }, tenants.map((t) => h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, t.institution), h('span', { class: 'pill muted' }, t.id)),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Instance'), h('dd', { class: 'mono small' }, t.baseUrl),
          h('dt', {}, 'Product version'), h('dd', { class: 'mono small' }, t.productVersion ?? '—'),
          h('dt', {}, 'Vocabulary'), h('dd', { class: 'mono small muted' }, Object.entries(t.vocabulary ?? {}).map(([k, v]) => `${k}="${v}"`).join('  ') || 'product defaults'),
          h('dt', {}, 'Overlays'), h('dd', {}, t.overlays.length
            ? t.overlays.map((o) => h('div', { class: 'small' }, h('span', { class: 'mono' }, o.capabilityId), ' ',
                h('span', { class: 'faint' }, `${o.patches} patches · ${o.overrides} overrides · ${o.extraSignals} extra signals`)))
            : h('span', { class: 'faint small' }, 'none — runs on the base capability unchanged')),
        )))));
  })();
  return wrap;
}

// ── agent interface ──────────────────────────────────────────────────────────
function agentsView() {
  const wrap = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  (async () => {
    const { tools } = await api('/api/tools?all=1').catch(() => ({ tools: [] }));
    const approved = tools.filter((t) => t.annotations.approvalState === 'approved');
    setChildren(wrap, 
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Agent interface'),
        h('div', { class: 'sub' }, 'Approved capabilities compile straight into tool definitions. This is what the agent-facing product calls.'))),
      h('div', { class: 'card mb' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Connect an agent')),
        h('p', { class: 'small muted' }, 'Over MCP, from Claude Code or Claude Desktop:'),
        h('pre', { class: 'json' }, `{\n  "mcpServers": {\n    "swivel": {\n      "command": "npx",\n      "args": ["tsx", "packages/mcp/src/main.ts"],\n      "env": { "SWIVEL_CONSOLE_URL": "${location.origin}", "SWIVEL_API_USER": "shivam", "SWIVEL_API_PASSWORD": "swivel" }\n    }\n  }\n}`),
        h('p', { class: 'small muted mt' }, 'Or over HTTP:'),
        h('pre', { class: 'json' }, `curl -X POST ${location.origin}/api/capabilities/<id>/invoke \\\n  -H 'content-type: application/json' -b cookies.txt \\\n  -d '{"tenant":"pineridge","inputs":{"memberNumber":"0100482"},"unattended":true}'`)),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Tool catalogue'),
          h('span', { class: 'small faint' }, `${approved.length} approved of ${tools.length} · only approved capabilities are exposed`)),
        tools.map((t) => h('div', { style: 'padding:12px 0;border-bottom:1px solid var(--border)' },
          h('div', { class: 'row' }, h('span', { class: 'mono', style: 'font-weight:600' }, t.name),
            statePill(t.annotations.approvalState),
            t.annotations.readOnlyHint ? h('span', { class: 'pill ok' }, 'read-only') : h('span', { class: 'pill warn' }, 'mutating'),
            t.annotations.destructiveHint ? h('span', { class: 'pill danger' }, 'irreversible') : null,
            t.annotations.requiresConfirmation ? h('span', { class: 'pill warn' }, 'confirmation required') : null),
          h('div', { class: 'small muted', style: 'margin-top:5px;white-space:pre-wrap' }, t.description),
          h('div', { class: 'mono small faint mt' }, `args: ${Object.keys(t.inputSchema.properties).join(', ') || 'none'}   returns: ${Object.keys(t.outputSchema?.properties ?? {}).join(', ') || 'none'}`)))));
  })();
  return wrap;
}
