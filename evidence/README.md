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
| [`runs/disc_d5b26006`](runs/disc_d5b26006) | **Discovery.** A real model driving the live legacy UI, producing a 6-step capability. `transcript.json` has its reasoning. |
| [`runs/rep_5d030101`](runs/rep_5d030101) | **Deterministic replay.** ~4.7s, 6 steps, **zero model calls**, every target resolving at 100/100. |
| [`runs/rep_7291528c`](runs/rep_7291528c) | **A business outcome, not a crash.** `RECORD_NOT_FOUND` — the answer the caller asked for. |
| [`runs/rep_21ce687f`](runs/rep_21ce687f) | **Recovery.** The session times out mid-flow; the run re-authenticates on the same browser session and restarts safely. |
| [`runs/rep_1f026d75`](runs/rep_1f026d75) | **The refusal.** The same artifact at a second institution with its overlay suppressed. The balance cell scores 0 against a required 60 and the engine stops rather than reading whichever cell is nearest. |
| [`runs/rep_062514f4`](runs/rep_062514f4) | **Escalation, resumed.** That refusal, handed to an operator who drove the live session and handed it back. The automation finished the job; the run reports `success` and says a human was involved. |
| [`runs/rep_cfd93909`](runs/rep_cfd93909) | **Escalation, completed by a person.** The same start, a different answer from the operator: `escalated`, with `outputs: null`. |
| [`runs/rep_85a97f60`](runs/rep_85a97f60) | **Refused before the browser opened.** An irreversible capability invoked with no confirmation token: 2 events, 3ms, nothing touched. |
| [`runs/rep_c70518d9`](runs/rep_c70518d9) | **Cross-tenant.** The same artifact at the second institution *with* its overlay — one patch, and it runs. |

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
| `disc_d5b26006` | discovery | success | member-savings-balance | pineridge | 23 |
| `disc_62bb56f6` | discovery | success | stop-payment | pineridge | 33 |
| `rep_5d030101` | replay | success | member-savings-balance | pineridge | 22 |
| `rep_21ce687f` | replay | success *(recovered: session expiry)* | member-savings-balance | pineridge | 35 |
| `rep_330284e8` | replay | success *(recovered: BSA/OFAC notice)* | member-savings-balance | pineridge | 25 |
| `rep_f29094df` | replay | success *(posted, with confirmation token)* | stop-payment | pineridge | 29 |
| `rep_c70518d9` | replay | success *(second institution, overlay applied)* | member-savings-balance | harborpoint | 29 |
| `rep_67a98c35`, `rep_887bb08b`, `rep_8d9b8b0e`, `rep_df99cb5e`, `rep_fb6d5fde` | replay | success ×5 | member-savings-balance | pineridge | 22 each |
| `rep_7291528c` | replay | `RECORD_NOT_FOUND` | member-savings-balance | pineridge | 12 |
| `rep_98241b88` | replay | `NOT_AUTHORIZED` | stop-payment | pineridge | 25 |
| `rep_738f29af` | replay | `SYSTEM_UNAVAILABLE_EOD` | stop-payment | pineridge | 18 |
| `rep_062514f4` | replay | success *(escalated; the operator unblocked it)* | member-savings-balance | harborpoint | 33 |
| `rep_cfd93909` | replay | **escalated** → `completed_by_human` | member-savings-balance | harborpoint | 27 |
| `rep_1f026d75` | replay | **failed** → `TARGET_NOT_FOUND` *(no overlay)* | member-savings-balance | harborpoint | 21 |
| `rep_85a97f60` | replay | **failed** → `POLICY_DENIED` *(no confirmation token)* | stop-payment | pineridge | 2 |

The five identical `success ×5` runs are the determinism check: same inputs, same
outcome, same outputs, five times
(`swivel stability … --runs 5` → **0% flakiness**).

[`demo-transcript.txt`](demo-transcript.txt) is the full terminal output of
`npm run demo`, which produced most of the above in one pass.

---

## Three worth reading closely

**`rep_1f026d75` — the refusal.** The base capability, at the institution it was
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
command without `--no-overlay` (`rep_c70518d9`) and one step patch makes it work.

**`rep_062514f4` — the rescue.** Read `events.jsonl` in order: the refusal, the
ticket, control granted to the operator, their forwarded click recorded as a
`human_action` at (270, 197), control returned with their note, the lease
reacquired by the automation, and then both extracts completing normally. The
operator unblocked *read-only* work, so the automation genuinely did the job and
the run reports `success` — with the escalation, the operator's identity and
their click on the chain, and a note on the result saying a human was involved.

**`rep_cfd93909` — the same start, a different answer.** Here the operator
answers `completed_by_human` instead. The success checkpoint holds either way —
the screen looks finished — and the run still reports `escalated` with
`outputs: null`. Reporting `success` there would put a person's work on the
automation's record, and reconciliation downstream would have no way to tell.
That distinction is why `escalated` is a status rather than a footnote.

Both were produced by [`scripts/operator-rescue.mjs`](../scripts/operator-rescue.mjs),
which signs in, claims the ticket and drives the paused session over the same
websocket a person's browser uses — so this path is reproducible rather than
demonstrated.
