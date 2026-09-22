# Evidence

Everything in this directory was produced by running this repository. Nothing is
hand-written or edited after the fact — and because each bundle is hash-chained,
that claim is checkable:

```bash
npx swivel verify evidence/runs/<runId>
```

Each run directory contains:

| file | |
|---|---|
| `run.json` | manifest — who ran what, against which institution, with what result, plus a count of what was redacted and the digest of the final event |
| `events.jsonl` | the hash-chained log: every observation, decision, action and refusal, in order |
| `steps/*.snapshot.json` | what the system perceived at each step — roles, names, values, grid positions |
| `steps/*.png`, `steps/*.html` | full screen and page capture, written at every failure and every escalation |
| `transcript.json` | *(discovery only)* the whole conversation with the model, in order, redacted — and tied to the artifact it produced by SHA-256, recorded in `provenance.transcriptSha256` |

All member data is synthetic. Values classified `pii` or `sensitive` appear as
stable salted hashes — `«pii:7f3a9c21…0482»` — so two runs touching the same
record can still be correlated without the record being readable.

The two discovery runs here were driven by **`gpt-5.1`** through the Responses
API, and their cost is measured rather than estimated: **$0.021** and **$0.028**,
for capabilities that then replay for nothing. To check that the artifact is the
one that transcript produced:

```bash
shasum -a 256 evidence/runs/<discoveryRun>/transcript.json
# compare with provenance.transcriptSha256 in the capability
```

---

## Start here

| Run | What it shows |
|---|---|
| [`runs/disc_823662b8`](runs/disc_823662b8) | **Discovery.** `gpt-5.1` driving the live legacy UI, 7 turns, producing a 6-step capability — for **$0.021**, measured. `transcript.json` is the whole conversation. |
| [`runs/disc_a78533d6`](runs/disc_a78533d6) | **The same goal, a different vendor's model.** The other half of the cross-model comparison below. |
| [`runs/rep_59933c1b`](runs/rep_59933c1b) | **Deterministic replay.** ~4.6s, 6 steps, **zero model calls**, every target resolving at 100/100. |
| [`runs/rep_3a81c71f`](runs/rep_3a81c71f) | **A business outcome, not a crash.** `RECORD_NOT_FOUND` — the answer the caller asked for. |
| [`runs/rep_67bd4d5a`](runs/rep_67bd4d5a) | **Recovery.** The session times out mid-flow; the run re-authenticates on the same browser session and restarts safely. |
| [`runs/rep_0d2d2631`](runs/rep_0d2d2631) | **The refusal.** The same artifact at a second institution with its overlay suppressed. The balance cell scores 0 against a required 60 and the engine stops rather than reading whichever cell is nearest. |
| [`runs/rep_7f749d21`](runs/rep_7f749d21) | **Escalation, resumed.** That refusal, handed to an operator who drove the live session and handed it back. The automation finished the job; the run reports `success` and says a human was involved. |
| [`runs/rep_6b99b8a4`](runs/rep_6b99b8a4) | **Escalation, completed by a person.** The same start, a different answer from the operator: `escalated`, with `outputs: null`. |
| [`runs/rep_a3d34a45`](runs/rep_a3d34a45) | **Refused before the browser opened.** An irreversible capability invoked with no confirmation token: 2 events, 4ms, nothing touched. |
| [`runs/rep_f0528b5e`](runs/rep_f0528b5e) | **Cross-tenant.** The same artifact at the second institution *with* its overlay — one patch, and it runs. |

---

## One goal, two vendors' models

`disc_823662b8` (`gpt-5.1`) and `disc_a78533d6` (Claude) recorded the same goal
against the same screens. Diffing the two artifacts on everything that decides
behaviour:

```bash
node scripts/compare-artifacts.mjs <a> <b>
```

| | |
|---|---|
| Flow: which controls, in which order | identical |
| Every target descriptor — role, name, anchors, grid row and column | identical |
| Every checkpoint, and the success condition | identical |
| Declared inputs, risk class, effects | identical |
| The *names* the model gave the two outputs | `currentBalance`/`availableBalance` vs `balance`/`available` |

The difference falls exactly on the line the design draws: everything Swivel
derives came out the same, and the one thing the model is genuinely asked for
came out differently.

## Artifacts

[`artifacts/`](artifacts) holds the capabilities these runs execute, exactly as
the discovery runs emitted them:

- `meridian.member-savings-balance@0.1.0.json` — read-only, 6 steps
- `meridian.stop-payment@0.1.0.json` — mutating, **irreversible**, 9 steps
- `meridian.member-savings-balance--harborpoint.overlay.json` — one step patch,
  which is the entire cost of onboarding the second institution

They are the same files as [`/capabilities`](../capabilities), which the CLI
imports on `npm run setup` so the demonstration works on a fresh clone with no
API key.

---

## Complete run index

| Run | Kind | Result | Capability | Tenant | Events |
|---|---|---|---|---|---|
| `disc_823662b8` | discovery | success · `gpt-5.1` · $0.021 | member-savings-balance | pineridge | 24 |
| `disc_d76e79b5` | discovery | success · `gpt-5.1` · $0.028 | stop-payment | pineridge | 34 |
| `disc_a78533d6` | discovery | success · Claude *(comparison run)* | member-savings-balance | pineridge | 24 |
| `rep_59933c1b` | replay | success | member-savings-balance | pineridge | 22 |
| `rep_67bd4d5a` | replay | success *(recovered: session expiry)* | member-savings-balance | pineridge | 35 |
| `rep_8aa62f4e` | replay | success *(recovered: BSA/OFAC notice)* | member-savings-balance | pineridge | 25 |
| `rep_1cd03894` | replay | success *(posted, with confirmation token)* | stop-payment | pineridge | 29 |
| `rep_f0528b5e` | replay | success *(second institution, overlay applied)* | member-savings-balance | harborpoint | 29 |
| `rep_718dcf5a`, `rep_8bbd0b19`, `rep_af1a43ed`, `rep_dae571a6`, `rep_fd72f400` | replay | success ×5 | member-savings-balance | pineridge | 22 each |
| `rep_3a81c71f` | replay | `RECORD_NOT_FOUND` | member-savings-balance | pineridge | 12 |
| `rep_cf482d3f` | replay | `NOT_AUTHORIZED` | stop-payment | pineridge | 25 |
| `rep_1544fec4` | replay | `SYSTEM_UNAVAILABLE_EOD` | stop-payment | pineridge | 18 |
| `rep_7f749d21` | replay | success *(escalated; the operator unblocked it)* | member-savings-balance | harborpoint | 33 |
| `rep_6b99b8a4` | replay | **escalated** → `completed_by_human` | member-savings-balance | harborpoint | 27 |
| `rep_0d2d2631` | replay | **failed** → `TARGET_NOT_FOUND` *(no overlay)* | member-savings-balance | harborpoint | 21 |
| `rep_a3d34a45` | replay | **failed** → `POLICY_DENIED` *(no confirmation token)* | stop-payment | pineridge | 2 |

The five identical `success ×5` runs are the determinism check: same inputs, same
outcome, same outputs, five times
(`swivel stability … --runs 5` → **0% flakiness**).

[`demo-transcript.txt`](demo-transcript.txt) is the full terminal output of
`npm run demo`, which produced most of the above in one pass.

---

## Three worth reading closely

**`rep_0d2d2631` — the refusal.** The base capability, at the institution it was
not recorded against, with its overlay suppressed (`--no-overlay`). It gets four
steps in on semantic evidence alone — the navigation link, the unlabelled search
box, the results row — and then stops: this build ships the balances grid
collapsed behind a Display control, so the cell the artifact describes is not on
screen. The best candidate scores **0 against a required 60**, and the report
names what matched (`hints.tag`) and what did not
(`cell.columnHeader`, `cell.rowWhere(Type={{input.shareType}})`).

Nothing about that screen is *unreadable*. There are cells; a locator that took
the nearest one would have returned a number, and the caller would have had no
way to know it was the wrong number. That is the entire argument for scored
resolution, and this bundle is the control experiment for it: run the same
command without `--no-overlay` (`rep_f0528b5e`) and one step patch makes it work.

**`rep_7f749d21` — the rescue.** Read `events.jsonl` in order: the refusal, the
ticket, control granted to the operator, their forwarded click recorded as a
`human_action` at (270, 197), control returned with their note, the lease
reacquired by the automation, and then both extracts completing normally. The
operator unblocked *read-only* work, so the automation genuinely did the job and
the run reports `success` — with the escalation, the operator's identity and
their click on the chain, and a note on the result saying a human was involved.

**`rep_6b99b8a4` — the same start, a different answer.** Here the operator
answers `completed_by_human` instead. The success checkpoint holds either way —
the screen looks finished — and the run still reports `escalated` with
`outputs: null`. Reporting `success` there would put a person's work on the
automation's record, and reconciliation downstream would have no way to tell.
That distinction is why `escalated` is a status rather than a footnote.

Both were produced by [`scripts/operator-rescue.mjs`](../scripts/operator-rescue.mjs),
which signs in, claims the ticket and drives the paused session over the same
websocket a person's browser uses — so this path is reproducible rather than
demonstrated.
