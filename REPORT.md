# Swivel — design write-up

> Computer-use capabilities for systems that were never meant to be automated.

Swivel uses a model **once**, to learn how to do a job inside a legacy back-office
application, and then never again. What the model learns becomes a typed,
versioned, reviewable **capability artifact** that a deterministic engine replays —
and that an AI agent calls by name, with typed arguments, at no model cost.

The argument for that shape is not performance. It is this:

> **SR 11-7 requires an institution to perform its own outcomes testing on a
> vendor's model. You cannot outcomes-test a system that does not produce the
> same output twice.**

Everything below follows from taking that seriously.

---

## 1. Architecture

```
                    ┌───────────────────────── discovery (a model, once) ─────────────────────────┐
  goal + params ──▶ │  observe ──▶ decide ──▶ act        the model chooses WHICH control          │
                    │     ▲                     │        Swivel decides HOW it is described,      │
                    │     └─────────────────────┘        what proves the step worked, and         │
                    └──────────────┬──────────────────── how risky it was ─────────────────────────┘
                                   │  emits
                                   ▼
                    ╔══════════════════════════════════╗
                    ║  CAP-1 capability artifact       ║  typed contract · durable targets
                    ║  + TenantOverlay per institution ║  · checkpoints · signals · policy
                    ╚══════════════╤═══════════════════╝
                                   │  resolved (base + overlay)
                                   ▼
  AI agent ──MCP/HTTP──▶ ┌────────────────────┐ ──▶ evidence bundle (hash-chained)
                         │  replay engine     │ ──▶ typed outputs │ business outcome │ failure
                         │  0 model calls     │ ──▶ escalation ──▶ operator drives the LIVE session
                         └─────────┬──────────┘
                                   │ perceive / act
                                   ▼
                         ┌────────────────────┐
                         │  Surface (seam)    │  web today · desktop (UIA/AX) · terminal (5250)
                         └────────────────────┘
```

**Four decisions carry the design.**

**The model is in the loop exactly once.** Frontier models now clear the human
baseline on OSWorld — and still fail roughly one task in six. A 17% failure rate
on an unattended general-ledger posting is not a product. Discovery costs a few
cents and a few minutes; every subsequent execution is deterministic, costs
nothing, and takes about four seconds. The economics and the compliance argument
point the same way.

**Perception and action are one narrow seam.** Everything above `Surface` —
target resolution, replay, policy, signals, evidence, escalation — is written
against a `Snapshot` of role/name/geometry/table-position nodes and has no idea
what a browser is. That vocabulary is deliberately the one Windows UI Automation
and macOS AX already expose, so a thick-client surface is an implementation of
two methods, not a second system. The proof that the seam is real: the resolver
and the whole error taxonomy are tested exhaustively with synthetic screens and
no browser at all.

**The artifact describes the vendor product, never the institution.** `pineridge`
appears nowhere in a capability; `meridian-core` does. Everything
institution-specific — base URL, the word for "member", one control that moved —
lives in a small `TenantOverlay`. One artifact, N overlays.

**Single process, files on disk, no queue.** The brief explicitly does not reward
scaling infrastructure, and a reviewer should be able to clone this and run it in
a minute. The seams that would matter at scale are real (`EscalationSink`,
`SecretResolver`, `Surface`, the store interface); the machinery behind them is
not built.

### Stack and why

| Choice | Reason |
|---|---|
| TypeScript / Node 22 | One language across engine, simulator, console and CLI; structural types suit a schema-centric system. |
| Playwright (via `playwright-core`) | Trusted input, frame handling, and CDP — which is what makes the live operator takeover possible at all. |
| Zod | The artifact schema is the product. One definition validates, parses and types it. |
| Claude (Opus 5 by default) | Discovery is hard multi-step reasoning over an unfamiliar legacy screen. A `claude-cli` provider also lets a reviewer run a genuine LLM discovery with no API key. |
| No frontend framework | The console is dense and mostly read-only; its one interactive surface is a websocket and an `<img>`. A bundler would add a build step to `npm start` and buy nothing. |

---

## 2. Artifact schema

Full schema: [`packages/core/src/artifact/schema.ts`](packages/core/src/artifact/schema.ts) ·
targeting: [`target.ts`](packages/core/src/artifact/target.ts) · example:
[`evidence/artifacts/`](evidence/artifacts/).

A capability is not a recording. A recording says what happened once; a
capability is a contract about what will happen every time. Four consumers shape
it:

1. **An AI agent calls it** → typed inputs, typed outputs, and an enumerated set
   of outcomes. It compiles 1:1 into an MCP tool definition
   ([`apps/console/src/tools.ts`](apps/console/src/tools.ts)); if that file had
   to be clever, the schema would be wrong.
2. **A human approves it** → every step carries an `intent` in plain language,
   every risky step is labelled, and the document is diffable. A reviewer reads
   intents, not selectors.
3. **A deterministic engine runs it** → targets, waits, checkpoints and error
   handling are all declared. Anything the engine would have to infer is a bug in
   the schema.
4. **Hundreds of tenants share it** → nothing institution-specific inside.

The raw model transcript is deliberately **not** in the artifact. It is evidence,
stored beside the run and referenced by SHA-256. Artifacts outlive the model that
wrote them.

### The part that matters most: how a control is identified

The obvious thing to record is a selector. It is wrong here twice over.
ASP.NET ids like `ctl00_Main_grdResults_ctl03_lnkView` encode a control's
position in a grid *at record time* — add a row and every id below it shifts —
and they differ between builds of the same product (Meridian 9.2 emits
`ctl00_Main_*`, 10.1 emits `ctl00_cphMain_*`). Structural selectors encode
layout, and layout is exactly what tenants customise.

What is stable is what a human operator uses: what the control **is**, what it is
**called**, and what it is **near**. So a `TargetDescriptor` is not a selector —
it is a bundle of independent evidence, plus a policy for how much agreement is
required before the engine will act.

```jsonc
{
  "id": "view_member",
  "role": "link",                                  // gate, never scored
  "name": { "value": "View", "match": "normalized" },
  "frame": { "path": ["contentFrame"] },
  "cell": {                                        // "the View link in the row
    "columnHeader": { "value": "Action" },         //  where Member # is 0100482"
    "rowWhere": {
      "columnHeader": { "value": "{{vocab.memberNumber}}" },
      "equals": "{{input.memberNumber}}"
    }
  },
  "hints": { "idPattern": "ctl\\d+_Main_grdResults_ctl\\d+_lnkView" },
  "require": { "minScore": 60, "unique": true }
}
```

Two templating namespaces do the cross-tenant work. `{{input.*}}` is the caller's
argument. `{{vocab.*}}` resolves through the tenant's vocabulary map, so the same
artifact addresses a control labelled "Member #" at one institution and
"Customer ID" at the next — **with no override at all.**

Evidence weights encode a claim about what survives change:

| Probe | Weight | |
|---|---:|---|
| accessible name (exact) | 40 | what the app calls it |
| grid row matched by value | 45 | what row a human means |
| relational anchor (e.g. "right of «Member #»") | 25 ea, capped 50 | how you find an unlabelled box |
| grid column header | 20 | |
| generated-id **pattern** | 18 | shape survives; digits do not |
| literal DOM id | 12 | the most volatile thing on the screen |
| CSS / nearby text / attributes / tag | 6–10 | corroboration only |
| **ordinal position** | **5** | tie-break of last resort |

Score is `matched ÷ available × 100`, so a sparse descriptor is not punished for
probes it never recorded. Two thresholds gate action: `minScore`, and a
uniqueness margin over the runner-up. **Below either, the engine refuses rather
than guessing** — and reports which evidence matched and which went missing.
That report is also the drift signal: a control that still resolves but has lost
its semantic evidence is a capability about to break, surfaced before an
incident rather than after one.

### Division of labour during discovery

This is the decision I would defend hardest:

> **The model chooses which control. Swivel decides how it is described.**

Asking a model for a locator fails three ways: quality varies run to run, so
artifact durability becomes non-deterministic; the model cannot see geometry, so
it reaches for the DOM id — the weakest evidence available; and it does not know
which on-screen value came from a caller parameter, so it hardcodes `0100482`
into a capability meant to serve every member.

Deriving the descriptor mechanically from the perception snapshot
([`descriptor.ts`](packages/core/src/agent/descriptor.ts)) fixes all three. The
same snapshot and the same chosen node produce byte-identical descriptors every
time, and a weaker model produces a *shorter* artifact rather than a more
fragile one.

Three rules there are load-bearing, and each came from watching a real discovery
run produce a bad artifact:

- **A target's identity is never run-varying data.** A confirmation number
  `SP-3028287` is a perfect accessible name and will never appear again.
- **A checkpoint must discriminate.** Text that was already on screen before the
  step proves nothing — it cannot tell "the click worked" from "the page never
  changed".
- **A checkpoint must not assert data.** Models reach for the most salient thing
  on screen, which is the member's name. Correct once, wrong forever — and it
  puts member data in a shared artifact.

The fallback is screen identity: legacy cores stamp `SCREEN INQ-0420` on every
page, which is stable across runs, identical across tenants, and carries no
member data.

### Contract, effects and quality

`contract.effects` is enforced, not documentation: `riskClass: irreversible`
makes the engine refuse to run without a per-invocation confirmation token.
`quality.approvalState` (`draft → candidate → approved → deprecated`) gates
unattended invocation, and approval is bound to the **content hash** — which
covers the behaviour-determining subset only, so replay statistics don't churn
it, and any change to steps, targets or policy silently invalidates an approval.

---

## 3. Determinism & error handling

### Determinism

Replay ([`replay/engine.ts`](packages/core/src/replay/engine.ts)) consults no
model. It rests on five things, each a decision rather than an accident:

1. **Targets resolve by scored evidence and refuse below threshold.** Never
   "closest match".
2. **Every state change is proven.** A step with a checkpoint does not advance
   until it holds. The validator *refuses to save* a mutating step without one.
3. **Waiting is a condition, never a duration.** Re-perceive on an interval
   until the condition holds or the budget expires. No sleeps tuned to one
   machine.
4. **Exceptional states are named in advance** (below). Nothing is discovered at
   runtime.
5. **Inputs are validated before the browser opens.** A malformed member number
   is rejected in microseconds, not after four screens.

`swivel stability <id> --runs N` replays N times and reports whether outcomes
diverged. Measured: **5/5 identical outcomes, identical outputs.**

### The error model

The brief names the most common mistake in this problem, and the result type
exists to make it impossible: *"no such member" is an answer, not a crash.*

| Result | Meaning | Caller does |
|---|---|---|
| `success` | flow completed | reads typed outputs |
| `business_outcome` | a declared, legitimate answer — `RECORD_NOT_FOUND`, `NOT_AUTHORIZED`, `VALIDATION_FAILED`, `SYSTEM_UNAVAILABLE_EOD`, `RECORD_LOCKED` | **branches on `code`**; retries only if `retryable` |
| `escalated` | paused, a human drove the live session, here is what they did | verifies before acting |
| `failed` | an incident — which step, expected, observed, evidence path | pages someone |

Recoveries are deliberately **not** a status. A run that re-authenticated after a
timeout still succeeded; surfacing that as an outcome trains callers to handle a
non-event. It is recorded as a list, so fleet health can see a capability quietly
recovering twice per run *before* it starts failing.

### Signals: naming exceptional states in advance

After **every** step the engine evaluates the artifact's signal detectors in
order; the first match decides what happens. Four dispositions: `business` →
return that outcome; `recoverable` → apply the declared remedy and re-run the
step; `escalate` → hand the live session to a human; `fatal` → stop.

Critically, these are authored **once per vendor product**, not per capability
([`signals/profiles.ts`](packages/core/src/signals/profiles.ts)). Symitar times
out the same way for every credit union running it. Ten capabilities share one
definition of "your session expired"; when the vendor changes that screen in
10.2, one profile changes and every capability inherits the fix. Asking each
discovery run to rediscover session-timeout handling would be expensive,
unreliable, and would produce ten subtly different definitions of one condition.

| Signal | Disposition | Response |
|---|---|---|
| session timed out (`MSG 0900`) | recoverable | re-authenticate **on the same browser session**, resume the step |
| app server 503 | recoverable | back off, retry ×3 |
| BSA/OFAC interstitial | recoverable | acknowledge, continue |
| record in use by another operator (`MSG 0310`) | recoverable ×3 | then business outcome `RECORD_LOCKED` |
| no record found (`MSG 0042`) | business | `RECORD_NOT_FOUND` |
| not authorised (`MSG 0451`) | business | `NOT_AUTHORIZED` + captured detail |
| end-of-day processing (`MSG 0600`) | business | `SYSTEM_UNAVAILABLE_EOD` (retryable) |
| validation rejected | business | `VALIDATION_FAILED` + the core's own wording |

Authentication is **not** part of a capability, for three reasons: credentials
must never enter a shared, version-controlled artifact; one sign-on serves twenty
capabilities; and session expiry is a *recovery* rather than a failure, which
only works if sign-on is a callable thing rather than steps 1–4 of the flow.

### On UI drift, secondarily

The brief is right that drift is not the main event here. The design still
handles it, and more usefully than a self-healing selector would: because
resolution reports *which* evidence matched, a capability whose semantic probes
start missing is flagged while it is still passing. That feeds `stabilityScore`,
which blends outcome history with targeting margin — so a capability resolving
its controls at 58 is visibly fragile before it has ever failed.

---

## 4. Heterogeneity & multi-tenant

### Other surfaces

The seam is [`Surface`](packages/core/src/surface/types.ts): `snapshot()`,
`act()`, `screenshot()`, `exposeForHumanControl()`. A `UiNode` is role, name,
value, bounds, containment and table position — chosen because that is what
ARIA, Windows UIA and macOS AX all already expose.

- **Legacy web** is the implemented case, and the simulator is deliberately
  hostile: framesets, four-deep layout tables, `<font>` tags, `__VIEWSTATE`,
  generated ids, and **almost no `<label for>`**. `getByLabel()` does not work
  there. A human reads "the box to the right of the words Member #" — so that is
  what the anchor probes express.
- **Desktop (UIA/AX):** implement `snapshot()` by walking the automation tree and
  `act()` via UIA patterns or synthetic input. Role, name and grid position come
  back directly — *better* than the web, where they must be computed. Nothing
  above the seam changes. `exposeForHumanControl()` returns an RDP/VNC channel
  instead of a CDP screencast; the protocol around it is identical.
- **Terminal (5250/3270):** synthesise nodes from the 24×80 character buffer —
  field attributes give roles, the label to the left of an input field gives the
  name, and column runs give table position. `act()` sends keystrokes. The
  `visual.bboxRatio` / `ocrText` probes exist in the schema from day one for a
  screenshot-only surface (Citrix-published thick clients); retrofitting a
  coordinate model later is how you end up with two formats.

The discipline that keeps this honest: any capability that leaks a browser
concept upward is a defect, because it is a concept the desktop surface cannot
honour. There are no CSS selectors in the replay engine.

### Many tenants, one artifact

Hundreds of institutions, ~20 apps each, many running the same vendor product
configured and branded differently. Re-recording per tenant is 20,000 recordings
and 20,000 things to maintain.

A `TenantOverlay` is a **patch, not a fork** — because when the vendor ships
10.2 and the base capability is re-recorded, every tenant inherits the fix; a
fork inherits nothing. It can override vocabulary, the base URL, individual
targets, and can insert/replace/skip steps. Two guardrails: a tenant can add
signals but never remove a base one, and can never widen the action allowlist.
The validator warns at ~40% divergence, because past that the two tenants are
not really running the same flow and the honest answer is a second capability.

Most of the generalisation happens **without** an overlay, through
`{{vocab.*}}`. This is demonstrated, not asserted — the repo ships two
institutions on the same product:

| | Pine Ridge FCU | Harbor Point Bank |
|---|---|---|
| Product version | Meridian 9.2.14 | Meridian 10.1.3 |
| Vocabulary | "Member #" | "Customer ID" |
| Control ids | `ctl00_Main_*` | `ctl00_cphMain_*` |
| Results grid | Member #, Name, SSN… | **Segment inserted before Name** |
| After sign-on | straight in | extra compliance acknowledgement |

Replaying the Pine Ridge artifact against Harbor Point **with no overlay**, the
engine got through sign-on (the optional post-sign-on step absorbed the extra
screen), failed on exactly one control — a nav link this bank calls "Customer
Search" — escalated, and after a human did that one step by hand, **completed
the entire remaining flow**: the anchor resolved against "Customer ID", the grid
row matched by value despite the inserted column, and the balance cells resolved
at score 100. The inserted column is precisely what breaks nth-child locators.

Per-tenant drift is detected by the same scores: Harbor Point's steps resolve at
67–86 rather than 100 because the recorded id pattern no longer matches. The
capability works, and the console says it is working *less well here* — which is
the signal you want before the vendor's next release.

---

## 5. Escalation & handoff

"Escalate to a human" usually means throwing an error into a queue. That is not
useful: by the time anyone looks, the session is gone and they are starting from
scratch on a task they did not see fail.

**Detecting stuck** is not a heuristic — it is the engine hitting a condition it
declared it would not guess past: a target below threshold or ambiguous, a
checkpoint that did not hold, a recoverable signal that exhausted its attempts, a
policy refusal, a step the artifact marks `escalate`, or a budget exhausted.
Discovery escalates too, when the model calls `escalate` or the provider dies.

**Taking control is real.** `exposeForHumanControl()` starts a CDP screencast
(`Page.startScreencast`) on the *same* page, and forwards the operator's clicks,
scrolls and keystrokes back as synthetic input. Not a new session, not a copy of
the cookies, not a replay of the steps so far: the identical browser context,
mid-flow, with whatever server-side session state the application has built up.
A handoff that starts fresh hands the operator the problem of getting back to
where the automation was.

**Who is in control is enforced, not documented.** A `ControlLeaseManager` holds
a single-writer lease, and `LeasedSurface` wraps the surface so acting without
the current token is impossible. Perception stays open to everyone — an operator
watching, the evidence recorder capturing — and only mutation is gated. That
asymmetry is the point: observation is safe, action is not. The live-control
server drops operator input unless the lease is theirs, so a stale browser tab or
a second operator cannot interleave keystrokes into a funds-transfer form. Leases
expire, so an operator who goes to lunch does not strand a run.

**Runs stay where they are; control moves.** A run launched from a terminal owns
its own browser and its own live-control websocket, and mirrors its ticket into
the console. The operator opens it there and drives *that* browser. That is the
shape a real deployment has: runners wherever the network reaches the core, one
console and one queue.

**Handing back is a decision, not a button.** `resume` (I did this step, carry
on), `completed_by_human` (I finished the job), or `abort`. Every forwarded click
and typed string lands on the run's evidence chain — which is both the audit
answer to "who touched this account?" and the raw material for promoting a rescue
into the capability so the same escalation stops recurring.

*Mocked:* multi-operator presence, screencast quality adaptation, and an
annotation channel. The control-transfer model and mechanism are real.

---

## 6. Safety

Guardrails are layered, and the deny path is as auditable as the allow path.

**Allowlist, enforced twice.** The policy engine refuses to *issue* an action
outside the capability's origin/path allowlist; the surface also aborts the
request at the network boundary. Policy enforced only at the point of decision is
policy a redirect can defeat. The operator is inside it too — a human driving the
live session cannot navigate out of scope either.

**Risk is structural before it is lexical.** Typing changes nothing, so `fill`
and `select` are read-only and the risk lands on the control that posts. A link
is navigation. A control in a **GET** form is a query; in a **POST** form it is a
transaction. That is in the markup and needs no guessing. Only then do words
matter, and mainly to separate "changes a record" from "cannot be undone". This
was rewritten after the first version classified a menu link named "Stop Payment"
as irreversible — which would demand a confirmation token to *open a form*, and
teach people to supply tokens reflexively.

**Irreversible actions need a token the model cannot mint.** A capability whose
effects are irreversible refuses to start without a `confirmationToken` supplied
by the caller — in 3ms, before the browser opens. A fee-bearing capability
additionally requires a principal role (`capability.invoke.financial`) an agent
cannot self-assign. During discovery, high-risk actions are blocked outright
unless the operator explicitly passed `--allow-writes`; the model's own opinion
of the risk is recorded and never trusted.

**Approval gates unattended execution**, is bound to the content hash, and is
revoked automatically if an approved capability starts failing. Trust is
continuously earned, not granted once.

**Redaction is contract-driven first, pattern-driven second.** Each field
declares its `sensitivity` at design time; regexes for SSNs, PANs (Luhn-checked,
so a 16-digit journal reference survives), emails and bearer tokens are a
backstop for text scraped off a screen. Redacted values become **stable salted
hashes** — `«pii:7f3a9c21…0482»` — not `[REDACTED]`, because the first question
in any incident review is "did these two runs touch the same record?". Passwords
are never read into a snapshot in the first place; credentials resolve from a
`SecretResolver` at the moment of typing and are never stored, logged or cached.

**Evidence is tamper-evident.** Every run writes a hash-chained event log; each
event carries the digest of its predecessor, so removing or editing one breaks
the chain and `swivel verify` says exactly where. Not a blockchain — it makes
tampering *detectable*, which is what an examiner asks for.

### Limits, honestly

- The allowlist is origin/path, not semantic. It cannot stop a capability doing
  something harmful *within* an allowed route; that is what risk classification,
  approval and dual control are for.
- Risk classification is a heuristic over markup and wording. It is conservative
  and reviewable, but a reviewer approving a mutating capability is the real
  control.
- The redaction backstop cannot catch an unstructured PII format nobody declared.
  Declared `sensitivity` is the primary control precisely because regexes miss.
- The evidence chain detects tampering; it does not prevent it. Real deployments
  ship the digest off-host.
- Prompt injection from screen content is a live risk during **discovery** only
  (replay reads no instructions). It is bounded by the allowlist, the action
  allowlist, and the high-risk block — but a malicious screen could still waste a
  discovery run.
- The demo secret resolver reads environment variables. The interface is the
  point; a real deployment injects a vault.

---

## 7. Cuts

**Deliberately not built**

- **Queues, workers, multi-tenant plumbing.** Explicitly not rewarded, and the
  seams that matter (`EscalationSink`, `Surface`, `SecretResolver`, the store)
  are already interfaces.
- **A real desktop or terminal surface.** Section 4 is the design; building one
  would have bought less than making the seam provable, which the browser-free
  resolver tests do.
- **Operator console polish** — multi-operator presence, quality adaptation,
  annotation. The control-transfer *mechanism* is real; the console around it is
  minimal.
- **Postgres.** A directory of atomically-written JSON files fits the access
  pattern (small, immutable, version-addressed documents plus an append-only
  log) and keeps setup to `npm install`.
- **Artifact editing in the console.** Reviewers can read and approve; authoring
  is CLI plus the JSON file. An artifact editor is a product, not a proof.
- **Bounded LLM repair on replay failure.** The seam is there (a failing step has
  a full diagnosis and a live session), and the escalation path covers the same
  ground today with a human instead of a model — which is the right default for
  a first release into a bank.

**Known limitations**

- The in-page perception routine is compiled with `new Function`, so an
  application serving a CSP without `unsafe-eval` would need it injected via an
  init script instead. One function; no such policy on the surfaces targeted.
- Perception tags elements with an ephemeral `data-swivel-ref` attribute to get
  trusted, auto-waiting interaction. It never leaves the client DOM. The
  alternative — JS-dispatched events — produces untrusted events that legacy
  handlers sometimes ignore.
- Grid detection keys on a `<th>` belonging to the table itself. A data grid
  built entirely from `<td>` would be read as layout. Desktop and terminal
  surfaces supply grid semantics directly and need no heuristic.

**Next, in order**

1. **Promote human rescues into capabilities.** Every escalation already records
   the operator's actions against a live snapshot. Turning that into a proposed
   step patch — reviewed, never auto-applied — closes the loop and makes each
   rescue the last of its kind.
2. **A UIA desktop surface**, to prove the seam against a thick client rather
   than arguing for it.
3. **Fleet drift monitoring.** Targeting scores per tenant are already recorded;
   alerting on a *falling* score across a vendor version rollout catches a
   product release before it causes an outage.
4. **Bounded single-step LLM repair**, gated by policy and recorded as evidence —
   with escalation as the fallback, not the other way round.

---

## Appendix: what was actually run

Every number here came out of this repository; the evidence bundles are in
[`/evidence`](evidence/).

| | |
|---|---|
| Discovery, real LLM against a live UI | 2 capabilities, 6 and 10 steps |
| Replay | ~4.7s, **0 model calls**, all targets resolving at 100 |
| Determinism | 5/5 identical outcomes and outputs |
| Business outcomes exercised | `RECORD_NOT_FOUND`, `VALIDATION_FAILED`, `NOT_AUTHORIZED` |
| Recoveries exercised | session expiry (re-auth mid-flow), transient 503, compliance interstitial |
| Safety refusals exercised | irreversible without token, origin outside allowlist, draft capability unattended |
| Escalation | live CDP takeover, operator drove the session, run resumed and finished |
| Cross-tenant | same artifact, second institution, one overlay |

*Built by Shivam Gupta.*
