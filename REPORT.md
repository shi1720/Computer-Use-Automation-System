# Swivel — design write-up

> Computer-use capabilities for systems that were never meant to be automated.

Swivel uses a model **once**, to learn how to do a job inside a legacy
back-office application, and then never again. What it learns becomes a typed,
versioned, reviewable **capability artifact** that a deterministic engine
replays — and that an AI agent calls by name, with typed arguments, at no model
cost.

The argument for that shape is not performance:

> **SR 11-7 requires an institution to perform its own outcomes testing on a
> vendor's model. You cannot outcomes-test a system that does not produce the
> same output twice.**

Everything below follows from taking that seriously. Every number in it came out
of this repository; the bundles are in [`/evidence`](evidence/).

| | |
|---|---|
| Discovery, real model against a live UI | 2 capabilities, 7 and 11 model turns |
| Replay | ~4.6s, **0 model calls**, targets resolving at 100 |
| Determinism | 5/5 identical outcomes and outputs |
| Business outcomes exercised | `RECORD_NOT_FOUND`, `NOT_AUTHORIZED`, `SYSTEM_UNAVAILABLE_EOD` |
| Recoveries exercised | session expiry, transient 503, compliance interstitial |
| Refusals exercised | irreversible without a token, off-allowlist origin, unapproved capability unattended |
| Escalation | live CDP takeover, operator drove the session, run resumed and finished |
| Cross-tenant | same artifact, second institution, one overlay — and the run without it |

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

Four decisions carry the design.

**The model is in the loop exactly once.** Frontier models now clear the human
baseline on OSWorld and still fail roughly one task in six. A 17% failure rate on
an unattended general-ledger posting is not a product. Discovery costs cents and
minutes; every execution after it is deterministic, free, and takes four seconds.

**Perception and action are one narrow seam.** Everything above `Surface` —
resolution, replay, policy, signals, evidence, escalation — is written against a
`Snapshot` of role/name/geometry/table-position nodes and has no idea what a
browser is. That vocabulary is deliberately the one Windows UIA and macOS AX
already expose. The proof it is real: the resolver and the whole error taxonomy
are tested with synthetic screens and no browser at all.

**The artifact describes the vendor product, never the institution.**
`pineridge` appears nowhere in a capability; `meridian-core` does.

**Single process, files on disk, no queue.** The brief does not reward scaling
infrastructure, and a reviewer should be able to clone this and run it in a
minute. The seams that would matter at scale are real interfaces
(`EscalationSink`, `SecretResolver`, `Surface`, the store); the machinery behind
them is not.

---

## 2. Artifact schema

Full schema: [`artifact/schema.ts`](packages/core/src/artifact/schema.ts) ·
targeting: [`target.ts`](packages/core/src/artifact/target.ts) · examples:
[`evidence/artifacts/`](evidence/artifacts/).

A capability is not a recording. A recording says what happened once; a
capability is a contract about what will happen every time — typed for the agent
that calls it, legible to the human who approves it, complete enough that the
engine infers nothing, and free of anything institution-specific so hundreds of
tenants can share it. The model transcript is deliberately not in it: that is
evidence, stored beside the run and referenced by SHA-256. Artifacts outlive the
model that wrote them.

### How a control is identified

The obvious thing to record is a selector, and it is wrong here twice over.
ASP.NET ids like `ctl00_Main_grdResults_ctl03_lnkView` encode a control's
position in a grid *at record time* — add a row and every id below it shifts —
and they differ between builds of the same product (9.2 emits `ctl00_Main_*`,
10.1 emits `ctl00_cphMain_*`). Structural selectors encode layout, and layout is
what tenants customise.

What is stable is what an operator uses: what the control **is**, what it is
**called**, what it is **near**. So a `TargetDescriptor` is a bundle of
independent evidence plus a policy for how much agreement is required before the
engine will act.

```jsonc
{
  "id": "view_member",
  "role": "link",                                  // gate, never scored
  "name": { "value": "View", "match": "normalized" },
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

Two templating namespaces do the cross-tenant work. `{{input.*}}` is the
caller's argument; `{{vocab.*}}` resolves through the tenant's vocabulary map, so
the same artifact addresses a control labelled "Member #" at one institution and
"Customer ID" at the next — **with no override at all**.

Weights encode a claim about what survives change: accessible name 40, grid row
matched by value 45, relational anchor 25 (capped 50), column header 20 — against
generated-id *pattern* 18, literal DOM id 12, tag or nearby text 6–10, ordinal
position 5. Those two groups are scored **separately**. `score` covers evidence
that *identifies* a control and is what the thresholds gate on; `corroboration`
covers evidence that merely *recognises* one, and gates nothing. Mixing them was
a defect worth naming: a link whose name matched exactly, at a tenant emitting
different generated ids, scored 62 against a threshold of 60 — the most volatile
evidence in the system one weight from vetoing a perfect identification. A probe
that cannot discriminate is not scored at all, for the same reason: a container
the pool was already filtered by answers identically for every candidate and
quietly lifts them all toward the threshold.

Below either threshold — `minScore`, or a uniqueness margin over the runner-up —
**the engine refuses rather than guessing**, and reports which evidence matched
and which went missing.

### Division of labour during discovery

This is the decision I would defend hardest:

> **The model chooses which control. Swivel decides how it is described.**

Asking a model for a locator fails three ways: quality varies run to run, so
artifact durability becomes non-deterministic; the model cannot see geometry, so
it reaches for the DOM id, the weakest evidence available; and it does not know
which on-screen value came from a caller parameter, so it hardcodes `0100482`
into a capability meant to serve every member. Deriving the descriptor
mechanically from the perception snapshot
([`descriptor.ts`](packages/core/src/agent/descriptor.ts)) fixes all three, and a
weaker model then produces a *shorter* artifact rather than a more fragile one.

Four rules are load-bearing, and each came from watching a real discovery run
produce a bad artifact:

- **A target's identity is never run-varying data.** A confirmation number is a
  perfect accessible name and will never appear again.
- **A checkpoint must discriminate.** Text already on screen before the step
  cannot tell "the click worked" from "the page never changed".
- **A checkpoint must not assert data.** Models reach for the most salient thing
  on screen, which is the member's name: correct once, wrong forever.
- **Nor may prose.** The summary, the caveats, every step's `intent` and even
  output names reach every institution adopting the capability. They are scrubbed
  sentence by sentence, matching a name in any word order — the screen says
  `WHITFIELD, DOLORES` and the model writes "Dolores Whitfield" — and a field the
  model called `specialSavingsBalance` is generalised to `balance`, because the
  same artifact serves `REGULAR SHARE`.

The fallback for all of it is screen identity: legacy cores stamp
`SCREEN INQ-0420` on every page, stable across runs, identical across tenants,
carrying no member data.

`contract.effects` is enforced rather than documented, and
`quality.approvalState` gates unattended invocation bound to the **content
hash** — the behaviour-determining subset only, so replay statistics do not churn
it while any change to steps, targets or policy silently invalidates the
approval.

---

## 3. Determinism & error handling

Replay ([`replay/engine.ts`](packages/core/src/replay/engine.ts)) consults no
model. It rests on five decisions:

1. **Targets resolve by scored evidence and refuse below threshold.** Never
   "closest match".
2. **Every state change is proven.** A step with a checkpoint does not advance
   until it holds, and the validator refuses to save a mutating step without one.
3. **Waiting is a condition, never a duration.**
4. **Exceptional states are named in advance.** Nothing is discovered at runtime.
5. **Inputs are validated before the browser opens.**

`swivel stability <id> --runs N` replays N times and reports whether outcomes
diverged. Measured: **5/5 identical outcomes, identical outputs.**

### The result contract

The brief names the most common mistake in this problem, and the result type
exists to make it impossible: *"no such member" is an answer, not a crash.*

| Result | Meaning | Caller does |
|---|---|---|
| `success` | flow completed | reads typed outputs |
| `business_outcome` | a declared, legitimate answer — `RECORD_NOT_FOUND`, `NOT_AUTHORIZED`, `VALIDATION_FAILED`, `SYSTEM_UNAVAILABLE_EOD`, `RECORD_LOCKED` | **branches on `code`**; retries only if `retryable` |
| `escalated` | paused; a human drove the live session, and here is what they did | verifies before acting |
| `failed` | an incident — which step, expected, observed, evidence path | pages someone |

Recoveries are deliberately **not** a status. A run that re-authenticated after a
timeout still succeeded, and surfacing that as an outcome trains callers to
handle a non-event. It is recorded as a list, so fleet health sees a capability
quietly recovering twice per run *before* it starts failing.

One rule decides the boundary between `success` and `escalated`, because the
tempting answer is wrong: **if a person performed state-changing work, the run
never reports `success`**, whatever the success checkpoint says. An operator
unblocking read-only navigation is different — the automation still did
everything that changed. Both cases are in
[`/evidence`](evidence/#three-worth-reading-closely), from the same starting
point.

### Signals

After **every** step the engine evaluates the artifact's signal detectors in
order; the first match decides what happens. Four dispositions: `business` →
return that outcome; `recoverable` → apply the declared remedy; `escalate` →
hand the live session to a human; `fatal` → stop.

Critically, these are authored **once per vendor product**, not per capability
([`signals/profiles.ts`](packages/core/src/signals/profiles.ts)). Symitar times
out the same way for every credit union running it, so ten capabilities share one
definition of "your session expired" and one profile change in 10.2 fixes all of
them.

| Signal | Disposition | Response |
|---|---|---|
| session timed out (`MSG 0900`) | recoverable | re-authenticate **on the same browser session** |
| BSA/OFAC interstitial | recoverable | acknowledge, continue |
| record in use (`MSG 0310`) | recoverable ×3 | then business outcome `RECORD_LOCKED` |
| no record found (`MSG 0042`) | business | `RECORD_NOT_FOUND` |
| end-of-day processing (`MSG 0600`) | business | `SYSTEM_UNAVAILABLE_EOD` (retryable) |

…and 503s, permission denials and validation rejections, all declared the same
way.

Recovery is where the sharpest correctness question in the engine lives. A
condition that interrupts a step is ambiguous: the step may have completed or it
may not, and a slow core painting "please wait" looks the same either way. So the
step's own checkpoint is asked, on its full declared budget — and **a step that
changes state is never repeated on a guess**. If its checkpoint will not hold the
run stops and a person confirms what landed, the same call a supervisor makes for
a teller whose session drops mid-posting. Re-running is the default only for
read-only work.

Authentication is **not** part of a capability: credentials must never enter a
shared, version-controlled artifact; one sign-on serves twenty capabilities; and
session expiry is a *recovery* rather than a failure, which only works if sign-on
is a callable thing rather than steps 1–4 of the flow.

**On UI drift**, secondarily: because resolution reports *which* evidence
matched, a capability whose semantic probes start missing is flagged while it is
still passing. That feeds `stabilityScore`, so a capability resolving its
controls at 58 is visibly fragile before it has ever failed.

---

## 4. Heterogeneity & multi-tenant

The seam is [`Surface`](packages/core/src/surface/types.ts): `snapshot()`,
`act()`, `screenshot()`, `exposeForHumanControl()`. A `UiNode` is role, name,
value, bounds, containment and table position — chosen because ARIA, UIA and AX
all already expose exactly that.

- **Legacy web** is the implemented case, and the simulator is deliberately
  hostile: framesets, four-deep layout tables, `<font>` tags, `__VIEWSTATE`,
  generated ids, and almost no `<label for>`. `getByLabel()` does not work there.
  A human reads "the box to the right of the words Member #", so that is what the
  anchor probes express.
- **Desktop (UIA/AX)** implements `snapshot()` by walking the automation tree and
  `act()` via UIA patterns. Role, name and grid position come back directly —
  *better* than the web, where they must be computed. Nothing above the seam
  changes; `exposeForHumanControl()` returns an RDP/VNC channel instead of a CDP
  screencast and the protocol around it is identical.
- **Terminal (5250/3270)** synthesises nodes from the 24×80 buffer: field
  attributes give roles, the label to the left gives the name, column runs give
  table position.

The discipline that keeps this honest: any capability that leaks a browser
concept upward is a defect, because it is a concept the desktop surface cannot
honour. There are no CSS selectors in the replay engine.

### Many tenants, one artifact

Hundreds of institutions, ~20 apps each, many running the same vendor product
configured and branded differently. Re-recording per tenant is 20,000 recordings
and 20,000 things to maintain.

A `TenantOverlay` is a **patch, not a fork** — so when the vendor ships 10.2 and
the base capability is re-recorded, every tenant inherits the fix, where a fork
inherits nothing. It overrides vocabulary, base URL and individual targets, and
can insert, replace or skip steps. Two guardrails: an overlay may add signals but
never remove a base one, and may only *tighten* policy. The validator warns at
~40% divergence, past which the honest answer is a second capability.

Most generalisation happens **without** an overlay, through `{{vocab.*}}`. The
repo ships two institutions on the same product to demonstrate that rather than
assert it:

| | Pine Ridge FCU | Harbor Point Bank |
|---|---|---|
| Product version | Meridian 9.2.14 | Meridian 10.1.3 |
| Vocabulary | "Member #" | "Customer ID" |
| Control ids | `ctl00_Main_*` | `ctl00_cphMain_*` |
| Results grid | Member #, Name, SSN… | **Segment inserted before Name** |
| After sign-on | straight in | extra compliance acknowledgement |
| Balances grid | rendered | **collapsed behind a Display control** |

The control experiment is in the repository, because the claim is only worth what
the run *without* the overlay shows. `--no-overlay` gets four steps in on
semantic evidence alone: the navigation link resolves through `{{vocab.member}}`,
the unlabelled search box by the caption printed beside it whatever that caption
says, and the results row by member number despite the inserted column — which is
precisely what breaks an nth-child locator.

Then it stops. This build collapses the balances grid, so the cell the artifact
describes is not on screen; the best candidate scores **0 against a required 60**
and the engine refuses ([`rep_a1b04bcf`](evidence/runs/rep_a1b04bcf)). Nothing
about that screen is unreadable — there are cells, and a locator that took the
nearest one would have returned a number the caller had no way to distrust. One
step patch is the entire cost of the institution
([`rep_9a7eaef4`](evidence/runs/rep_9a7eaef4)).

Drift shows up in the same scores: Harbor Point's steps identify at 100 and
corroborate at 25–40, because the recorded id patterns do not match this build.
The capability works, and the console says it is working *differently here* —
the signal you want before the vendor's next release.

---

## 5. Escalation & handoff

"Escalate to a human" usually means throwing an error into a queue. By the time
anyone looks the session is gone, and they are starting from scratch on a task
they did not see fail.

**Detecting stuck** is not a heuristic — it is the engine hitting a condition it
declared it would not guess past: a target below threshold or ambiguous, a
checkpoint that did not hold, a recoverable signal out of attempts, a policy
refusal, a step the artifact marks `escalate`, or a budget exhausted.

**Taking control is real.** `exposeForHumanControl()` starts a CDP screencast on
the *same* page and forwards the operator's clicks, scrolls and keystrokes back
as synthetic input. Not a new session, not a copy of the cookies, not a replay of
the steps so far: the identical browser context, mid-flow, with whatever
server-side state the application has built up. A handoff that starts fresh hands
the operator the problem of getting back to where the automation was.

**Who is in control is enforced, not documented.** A `ControlLeaseManager` holds
a single-writer lease and `LeasedSurface` makes acting without the current token
impossible. Perception stays open to everyone — an operator watching, the
recorder capturing — and only mutation is gated: observation is safe, action is
not. Exactly one socket may drive, so a stale tab or a leaked token cannot
interleave keystrokes into a funds-transfer form, and the drive token reaches
only the operator who actually claimed the ticket. Leases expire, so an operator
who goes to lunch does not strand a run — and the automation's wall-clock budget
stops while a person holds the wheel, because charging an operator's thinking
time against an automation timeout makes the whole path unusable.

**Runs stay where they are; control moves.** A run launched from a terminal owns
its own browser and its own live-control websocket and mirrors its ticket into
the console — the shape a real deployment has: runners wherever the network
reaches the core, one console and one queue.

**Handing back is a decision, not a button.** `resume`, `completed_by_human` or
`abort` — and what "resume" means is verified rather than assumed, by asking the
step's own checkpoint who did the work. Every forwarded click and typed string
lands on the evidence chain, which is both the audit answer to "who touched this
account?" and the raw material for promoting a rescue into the capability.
[`scripts/operator-rescue.mjs`](scripts/operator-rescue.mjs) drives this whole
path through the same API and websocket a person's browser uses, so the hardest
claim in this system is reproducible rather than demonstrated.

*Mocked:* multi-operator presence, quality adaptation, an annotation channel.
The control-transfer model and mechanism are real.

---

## 6. Safety

Guardrails are layered, and the deny path is as auditable as the allow path.

**Allowlist, enforced twice.** The policy engine refuses to *issue* an action
outside the capability's origin/path allowlist; the surface also aborts the
request at the network boundary, because policy enforced only at the point of
decision is policy a redirect can defeat. The operator is inside it too.

**Risk is structural before it is lexical.** Typing changes nothing, so `fill`
and `select` are read-only and the risk lands on the control that posts. A
control in a **GET** form is a query; in a **POST** form it is a transaction.
That is in the markup and needs no guessing. Only then do words matter, and
mainly to separate "changes a record" from "cannot be undone". Two exceptions
are in the markup too, and both were defects first: a WebForms grid action link
is `javascript:__doPostBack(…)`, the role of a link with the effect of a submit,
so a link is navigation only when its href is; and legacy cores commit on GET
routinely, so a URL is read like any other control name.

**Irreversible actions need a token the model cannot mint.** Such a capability
refuses to start without a caller-supplied `confirmationToken` — in 4ms, before
the browser opens. Anything that moves money additionally requires a principal
role an agent cannot self-assign; tying that to "irreversible" alone was too
narrow by exactly the case that matters, since a transfer between a member's own
shares is reversible and still moves money. During discovery, high-risk actions
are blocked unless the operator passed `--allow-writes`.

**Approval gates unattended execution**, is bound to the content hash, and is
revoked automatically if an approved capability starts failing. Trust is earned
continuously, not granted once.

**Redaction is contract-driven first, pattern-driven second.** Each field
declares its `sensitivity` at design time; regexes for SSNs, PANs (Luhn-checked,
so a journal reference survives), member and account numbers, emails and bearer
tokens back that up for text scraped off a screen. A declared classification
*tightens* handling and never disables it. Redacted values become **stable salted
hashes** — `«pii:7f3a9c21…0482»` — not `[REDACTED]`, because the first question
in any incident review is "did these two runs touch the same record?".
Credentials resolve from a `SecretResolver` at the moment of typing and are never
stored, logged or cached.

**Evidence is tamper-evident.** Each event carries the digest of its
predecessor, so editing one breaks the chain and `swivel verify` says where. The
manifest records the digest of the *final* event, which is what catches the
easiest and most useful tampering of all: deleting everything after the
interesting line, leaving a chain that otherwise verifies clean.

### Limits, honestly

- The allowlist is origin/path, not semantic. It cannot stop a capability doing
  something harmful *within* an allowed route; that is what risk classification,
  approval and dual control are for.
- Risk classification is a heuristic over markup and wording. It is conservative
  and reviewable, but a reviewer approving a mutating capability is the real
  control.
- **Screenshots are not redacted, and cannot honestly be.** A PNG of a member
  inquiry screen carries the data as pixels, and an OCR pass that misses one
  field produces a file that *looks* redacted — worse than one everybody knows is
  sensitive. They are written only where they earn their place, the manifest says
  a bundle contains them, and reading them needs an `evidence.read` role. The
  pattern backstop has the same shape of limit: it cannot catch an unstructured
  format nobody declared, which is why declared `sensitivity` is the primary
  control.
- The evidence chain detects tampering; it does not prevent it. Real deployments
  ship the digest off-host.
- Prompt injection from screen content is a live risk during **discovery** only
  (replay reads no instructions). It is bounded by the origin allowlist, the
  action allowlist and the high-risk block, but a malicious screen could still
  waste a discovery run.
- The demo secret resolver reads environment variables. The interface is the
  point; a real deployment injects a vault.

---

## 7. Cuts

**Deliberately not built.** Queues, workers and multi-tenant plumbing —
explicitly not rewarded, and the seams that matter are already interfaces. A real
desktop or terminal surface — §4 is the design, and building one would have
bought less than making the seam provable, which the browser-free resolver tests
do. Operator console polish. Postgres, where a directory of atomically-written
JSON documents plus an append-only log fits the access pattern and keeps setup to
`npm install`. Artifact editing in the console — reviewers read and approve;
an artifact editor is a product, not a proof. And bounded LLM repair on replay
failure: the seam is there, and the escalation path covers the same ground today
with a human instead of a model, which is the right default for a first release
into a bank.

**Next, in order.**

1. **Promote human rescues into capabilities.** Every escalation already records
   the operator's actions against a live snapshot. Turning that into a proposed
   step patch — reviewed, never auto-applied — makes each rescue the last of its
   kind.
2. **A UIA desktop surface**, to prove the seam against a thick client rather
   than argue for it.
3. **Fleet drift monitoring.** Targeting and corroboration scores per tenant are
   already recorded; alerting on a *falling* score across a vendor version
   rollout catches a product release before it causes an outage.
4. **Bounded single-step LLM repair**, gated by policy and recorded as evidence —
   with escalation as the fallback, not the other way round.

*Built by Shivam Gupta.*
