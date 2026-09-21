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
| `transcript.json` | *(discovery only)* the model's turns, redacted |

All member data is synthetic. Values classified `pii` or `sensitive` appear as
stable salted hashes — `«pii:7f3a9c21…0482»` — so two runs touching the same
record can still be correlated without the record being readable.

---

## Start here

| Run | What it shows |
|---|---|
| [`runs/disc_bf8c1661`](runs/disc_bf8c1661) | **Discovery.** A real model driving the live legacy UI, 7 turns, producing a 6-step capability. `transcript.json` has its reasoning. |
| [`runs/rep_1882c14e`](runs/rep_1882c14e) | **Deterministic replay.** ~4.6s, 6 steps, **zero model calls**, every target resolving at 100/100. |
| [`runs/rep_3aee72c0`](runs/rep_3aee72c0) | **A business outcome, not a crash.** `RECORD_NOT_FOUND` — the answer the caller asked for. |
| [`runs/rep_1541fe2d`](runs/rep_1541fe2d) | **Recovery.** The session times out mid-flow; the run re-authenticates on the same browser session and restarts safely. |
| [`runs/rep_a1b04bcf`](runs/rep_a1b04bcf) | **The refusal.** The same artifact at a second institution with its overlay suppressed. The balance cell scores 0 against a required 60 and the engine stops rather than reading whichever cell is nearest. |
| [`runs/rep_669975c3`](runs/rep_669975c3) | **Escalation, resumed.** The refusal above, handed to an operator who drove the live session by hand and handed it back. The automation finished the job; the run reports `success` with the rescue on the record. |
| [`runs/rep_f036f0d1`](runs/rep_f036f0d1) | **Escalation, completed by a person.** The same start, a different answer from the operator. The run reports `escalated` and `outputs: null` — the automation will not claim work it did not do. |
| [`runs/rep_f50e0192`](runs/rep_f50e0192) | **Refused before the browser opened.** An irreversible capability invoked with no confirmation token: 2 events, 4ms, nothing touched. |
| [`runs/rep_9a7eaef4`](runs/rep_9a7eaef4) | **Cross-tenant.** The same artifact at the second institution *with* its overlay — one patch, and it runs. |

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
| `disc_bf8c1661` | discovery | success | member-savings-balance | pineridge | 24 |
| `disc_586b5fdc` | discovery | success | stop-payment | pineridge | 37 |
| `rep_1882c14e` | replay | success | member-savings-balance | pineridge | 22 |
| `rep_1541fe2d` | replay | success *(recovered: session expiry)* | member-savings-balance | pineridge | 35 |
| `rep_f0778480` | replay | success *(recovered: BSA/OFAC notice)* | member-savings-balance | pineridge | 25 |
| `rep_a482dc03` | replay | success *(posted, with confirmation token)* | stop-payment | pineridge | 31 |
| `rep_9a7eaef4` | replay | success *(second institution, overlay applied)* | member-savings-balance | harborpoint | 29 |
| `rep_209a75c4`, `rep_9a2c0f78`, `rep_b8245319`, `rep_cb695ca8`, `rep_f9d3aab8` | replay | success ×5 | member-savings-balance | pineridge | 22 each |
| `rep_3aee72c0` | replay | `RECORD_NOT_FOUND` | member-savings-balance | pineridge | 12 |
| `rep_b45dd9d7` | replay | `NOT_AUTHORIZED` | stop-payment | pineridge | 27 |
| `rep_e7ee0900` | replay | `SYSTEM_UNAVAILABLE_EOD` | stop-payment | pineridge | 18 |
| `rep_669975c3` | replay | success *(escalated, operator resumed it)* | member-savings-balance | harborpoint | 33 |
| `rep_f036f0d1` | replay | **escalated** → `completed_by_human` | member-savings-balance | harborpoint | 27 |
| `rep_a1b04bcf` | replay | **failed** → `TARGET_NOT_FOUND` *(no overlay)* | member-savings-balance | harborpoint | 21 |
| `rep_f50e0192` | replay | **failed** → `POLICY_DENIED` *(no confirmation token)* | stop-payment | pineridge | 2 |

The five identical `success ×5` runs are the determinism check: same inputs, same
outcome, same outputs, five times
(`swivel stability … --runs 5` → **0% flakiness**).

[`demo-transcript.txt`](demo-transcript.txt) is the full terminal output of
`npm run demo`, which produced most of the above in one pass.

---

## Three worth reading closely

**`rep_a1b04bcf` — the refusal.** The base capability, at the institution it was
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
command without `--no-overlay` (`rep_9a7eaef4`) and one step patch makes it work.

**`rep_669975c3` — the rescue.** Read `events.jsonl` in order: the refusal, the
ticket, control granted to the operator, their forwarded click recorded as a
`human_action` at (270, 197), control returned with their note, the lease
reacquired by the automation, and then the two extracts completing normally. The
operator unblocked *read-only* work, so the automation genuinely did the job and
the run reports `success` — with the escalation, the operator's identity and
their click all on the chain.

**`rep_f036f0d1` — the same start, a different answer.** Here the operator
answers `completed_by_human` instead. The success checkpoint holds either way —
the screen looks finished — and the run still reports `escalated` with
`outputs: null`. Reporting `success` there would put a person's work on the
automation's record, and reconciliation downstream would have no way to tell.
That distinction is the reason `escalated` is a status rather than a footnote.
