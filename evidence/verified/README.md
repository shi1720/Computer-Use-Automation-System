# Verified end-to-end evidence

Recorded on 22 September 2026 against the local MERIDIAN simulator using real Chromium and OpenAI gpt-5.1. All banking data is synthetic.

| Item | Evidence |
| --- | --- |
| Fresh live discovery | [disc_a528a554](../runs/disc_a528a554/run.json) |
| Discovery event log | [events.jsonl](../runs/disc_a528a554/events.jsonl) |
| Reusable six-step artifact | [meridian.verified-savings.json](meridian.verified-savings.json) |
| Replay of that exact artifact | [rep_2ffe6dc9](../runs/rep_2ffe6dc9/run.json) |
| Replay event log | [events.jsonl](../runs/rep_2ffe6dc9/events.jsonl) |
| Member not found | [rep_dc883f89](../runs/rep_dc883f89/run.json) |
| Mid-flow session recovery | [rep_a295ec6d](../runs/rep_a295ec6d/run.json) |
| Same base flow at another institution | [rep_d7bb4889](../runs/rep_d7bb4889/run.json) |

Discovery took seven model turns and emitted six steps. Its recorded usage was 8,951 uncached input tokens, 26,368 cached input tokens, and 1,092 output tokens. The estimated model cost was $0.0254 using the repository's price table; this is an estimate, not a billing receipt.

The subsequent deterministic replay completed in 3,811 ms with zero model calls and returned `balance: 18402.66` and `available: 18402.66`. Output names are part of each generated contract; the pre-existing demo capability uses `currentBalance` and `availableBalance`.

Reproduce from the repository root while MERIDIAN is running:

```bash
npm run swivel -- import evidence/verified/meridian.verified-savings.json
npm run swivel -- replay meridian.verified-savings --tenant pineridge \
  --input memberNumber=0100482 --input "shareType=SPECIAL SAVINGS" --no-escalate
npm run swivel -- verify evidence/runs/disc_a528a554
npm run swivel -- verify evidence/runs/rep_2ffe6dc9
```

The earlier `disc_b789549c` attempt stopped after another test injected a session timeout into the shared simulator. It is retained as failure evidence rather than represented as a successful discovery. Run simulator tests serially.

All five local acceptance scenarios passed, including [live handoff](../runs/rep_cdf81bb1/run.json). Each completed bundle passed hash-chain verification. See [machine-readable acceptance results](local-acceptance.json).

All five scenarios also passed against [the public deployment](https://swivel-demo.web.app). The [hosted acceptance results](hosted-acceptance.json) include the real TLS WebSocket handoff and evidence verification. These hosted run IDs are ephemeral; the committed local bundles above preserve the detailed evidence.

[Responsive checks](responsive-check.json) recorded no page errors or horizontal overflow at 1440, 768, and 390 pixel widths. The automated suite passed 192 tests across 46 suites, and TypeScript validation passed. The [chain audit](chain-audit.json) verifies every committed evidence bundle.

The [console handoff check](local-handoff-ui.json) also verified a decoded live frame, navigation away and reconnection to the same ticket, Escape returning keyboard focus, and keyboard activation of Resume automation. The associated preserved bundle is [rep_3404aac0](../runs/rep_3404aac0/run.json).

The same console test passed against the [final public backend](hosted-handoff-ui.json), including reconnect and keyboard hand-back, with no browser page errors.
