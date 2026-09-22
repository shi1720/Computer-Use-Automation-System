# Execution evidence

Start with [the fresh verified end-to-end run](verified/README.md). It links a genuine OpenAI discovery, the six-step artifact it produced, replay of that exact artifact, runtime outcomes, session recovery, and live operator takeover.

All banking records are synthetic. Existing historical bundles are retained alongside the fresh verification. A model cost stored in a manifest is an estimate derived from recorded usage and a price table, not a billing receipt. Deterministic replay makes no model calls but still uses browser and hosting resources.

## What a bundle contains

| File | Purpose |
| --- | --- |
| `run.json` | Run metadata, result, usage, counts, and final event digest |
| `events.jsonl` | Ordered, hash-chained observations, decisions, actions, and outcomes |
| `steps/*.snapshot.json` | Redacted perception including roles, names, frames, and table relationships |
| `steps/*.png` and `steps/*.html` | Richer evidence captured on failures or escalations |
| `transcript.json` | Redacted model conversation for discovery runs that recorded one |

Verify a bundle from the repository root:

```bash
npm run swivel -- verify evidence/runs/disc_a528a554
npm run swivel -- verify evidence/runs/rep_2ffe6dc9
```

The [chain audit](verified/chain-audit.json) checks every committed bundle. Hash verification detects inconsistency relative to a bundle's own recorded digest. It does not independently prove when a run happened or prevent someone from regenerating an entire chain.

Text redaction and screenshot handling have different limits. Screenshots may show the simulator's synthetic member data. These captures are not a guarantee that arbitrary regulated data would be safe to persist; see [Safety in the design report](../REPORT.md#6-safety).

## Reproduction

[README.md](../README.md) gives exact discovery, replay, and handoff commands. [Saved artifacts](artifacts/) preserve the original demo examples. The newly discovered [verification artifact](verified/meridian.verified-savings.json) has its own typed output contract.

The repeatable acceptance script uses the actual HTTP and WebSocket operator surfaces. Its human actions are scripted test actions, and the narrated recording also demonstrates the same control path through the console UI.

## Bundle index

| Run | Kind | Result | Institution |
| --- | --- | --- | --- |
| [disc_823662b8](runs/disc_823662b8/run.json) | discovery | success | pineridge |
| [disc_a528a554](runs/disc_a528a554/run.json) | discovery | success | pineridge |
| [disc_a78533d6](runs/disc_a78533d6/run.json) | discovery | success | pineridge |
| [disc_b789549c](runs/disc_b789549c/run.json) | discovery | escalated | pineridge |
| [disc_d76e79b5](runs/disc_d76e79b5/run.json) | discovery | success | pineridge |
| [rep_0d2d2631](runs/rep_0d2d2631/run.json) | replay | failed | harborpoint |
| [rep_1544fec4](runs/rep_1544fec4/run.json) | replay | business_outcome | pineridge |
| [rep_1cd03894](runs/rep_1cd03894/run.json) | replay | success | pineridge |
| [rep_2ffe6dc9](runs/rep_2ffe6dc9/run.json) | replay | success | pineridge |
| [rep_3a81c71f](runs/rep_3a81c71f/run.json) | replay | business_outcome | pineridge |
| [rep_59933c1b](runs/rep_59933c1b/run.json) | replay | success | pineridge |
| [rep_67bd4d5a](runs/rep_67bd4d5a/run.json) | replay | success | pineridge |
| [rep_6b99b8a4](runs/rep_6b99b8a4/run.json) | replay | escalated | harborpoint |
| [rep_718dcf5a](runs/rep_718dcf5a/run.json) | replay | success | pineridge |
| [rep_7358e24d](runs/rep_7358e24d/run.json) | replay | business_outcome | pineridge |
| [rep_73e8b307](runs/rep_73e8b307/run.json) | replay | success | pineridge |
| [rep_7f749d21](runs/rep_7f749d21/run.json) | replay | success | harborpoint |
| [rep_8aa62f4e](runs/rep_8aa62f4e/run.json) | replay | success | pineridge |
| [rep_8bbd0b19](runs/rep_8bbd0b19/run.json) | replay | success | pineridge |
| [rep_a05a231a](runs/rep_a05a231a/run.json) | replay | success | harborpoint |
| [rep_a295ec6d](runs/rep_a295ec6d/run.json) | replay | success | pineridge |
| [rep_a3d34a45](runs/rep_a3d34a45/run.json) | replay | failed | pineridge |
| [rep_af1a43ed](runs/rep_af1a43ed/run.json) | replay | success | pineridge |
| [rep_c1c304f9](runs/rep_c1c304f9/run.json) | replay | success | pineridge |
| [rep_caeee4b6](runs/rep_caeee4b6/run.json) | replay | success | pineridge |
| [rep_cdf81bb1](runs/rep_cdf81bb1/run.json) | replay | success | harborpoint |
| [rep_cf482d3f](runs/rep_cf482d3f/run.json) | replay | business_outcome | pineridge |
| [rep_d7bb4889](runs/rep_d7bb4889/run.json) | replay | success | harborpoint |
| [rep_dae571a6](runs/rep_dae571a6/run.json) | replay | success | pineridge |
| [rep_dc883f89](runs/rep_dc883f89/run.json) | replay | business_outcome | pineridge |
| [rep_f0528b5e](runs/rep_f0528b5e/run.json) | replay | success | harborpoint |
| [rep_fd72f400](runs/rep_fd72f400/run.json) | replay | success | pineridge |
| [rep_3404aac0](runs/rep_3404aac0/run.json) | replay | success | harborpoint |
