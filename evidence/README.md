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
| [`runs/disc_d0e3aa2a`](runs/disc_d0e3aa2a) | **Discovery.** A real model driving the live legacy UI, 7 turns, producing a 6-step capability. `transcript.json` has its reasoning. |
| [`runs/rep_04d0cb97`](runs/rep_04d0cb97) | **Deterministic replay.** ~4.7s, 6 steps, **zero model calls**, every target resolving at 100/100. |
| [`runs/rep_5be0b4d4`](runs/rep_5be0b4d4) | **A business outcome, not a crash.** `RECORD_NOT_FOUND` — the answer the caller asked for. |
| [`runs/rep_46e74207`](runs/rep_46e74207) | **Recovery.** The session times out mid-flow; the run re-authenticates on the same browser session and restarts safely. |
| [`runs/rep_4e938f5d`](runs/rep_4e938f5d) | **Escalation.** The engine refuses to guess, hands the live session to an operator, and reports `escalated` — because a person, not the automation, finished the work. |
| [`runs/rep_84938152`](runs/rep_84938152) | **A hard failure, fully diagnosed.** Which step, what was expected, what was observed, with a screenshot and a full page capture. |
| [`runs/rep_edc64e94`](runs/rep_edc64e94) | **Cross-tenant.** The same artifact at a second institution on the same vendor product, with one overlay. |

---

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
| `disc_d0e3aa2a` | discovery | success | member-savings-balance | pineridge | 24 |
| `disc_03fcc62a` | discovery | success | stop-payment | pineridge | 33 |
| `rep_04d0cb97` | replay | success | member-savings-balance | pineridge | 22 |
| `rep_46e74207` | replay | success *(recovered: session expiry)* | member-savings-balance | pineridge | 35 |
| `rep_0b3aaf1c` | replay | success *(recovered: BSA/OFAC notice)* | member-savings-balance | pineridge | 25 |
| `rep_d1ae912d` | replay | success *(posted, with confirmation token)* | stop-payment | pineridge | 29 |
| `rep_edc64e94` | replay | success *(second institution, overlay applied)* | member-savings-balance | harborpoint | 26 |
| `rep_51afc102`, `rep_76ab9e3e`, `rep_7a58c06c`, `rep_e8deb232`, `rep_e9529614` | replay | success ×5 | member-savings-balance | pineridge | 22 each |
| `rep_5be0b4d4` | replay | `RECORD_NOT_FOUND` | member-savings-balance | pineridge | 12 |
| `rep_9dcb1a63` | replay | `NOT_AUTHORIZED` | stop-payment | pineridge | 25 |
| `rep_5e680148` | replay | `SYSTEM_UNAVAILABLE_EOD` | stop-payment | pineridge | 18 |
| `rep_4e938f5d` | replay | **escalated** → `completed_by_human` | member-savings-balance | pineridge | 23 |
| `rep_84938152` | replay | **failed** → `TARGET_NOT_FOUND` | member-savings-balance | pineridge | — |
| `rep_ba73d0a4` | replay | **failed** → `POLICY_DENIED` | stop-payment | pineridge | — |

The five identical `success ×5` runs are the determinism check: same inputs, same
outcome, same outputs, five times
(`swivel stability … --runs 5` → **0% flakiness**).

[`demo-transcript.txt`](demo-transcript.txt) is the full terminal output of
`npm run demo`, which produced most of the above in one pass.

---

## Two things worth reading closely

**`rep_84938152` — the failure.** The capability was asked for a share product
this member does not hold. The engine did not click the nearest-looking cell: the
best candidate scored 37 against a required 60, and the report says exactly which
evidence matched (`cell.columnHeader`, `hints.tag`) and which did not
(`cell.rowWhere(Type={{input.shareType}})`). That is the whole targeting
philosophy visible in one line.

It is also an honest limitation. "This member does not hold that product" is
arguably a *business outcome*, not a failure — but the capability's contract only
declares outcomes the discovery run actually observed, and it never saw that case.
The fix is a reviewer adding the outcome to the contract, which is exactly the
kind of thing the approval step exists for.

**`rep_4e938f5d` — the escalation.** Read `events.jsonl` in order: the refusal,
the ticket, control granted to the operator, the operator's forwarded click
recorded as a `human_action`, control returned with their note, the lease
reacquired by the automation. The result is `escalated`, not `success`, with
`outputs: null` — because a person did the work and the automation will not
vouch for it.
