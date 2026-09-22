# Why Swivel matters

When a legacy application has no usable API, routine work still depends on someone finding a record, opening the right screen, and copying the result. Swivel explores a practical way to make that work reusable.

A model discovers a workflow in the application. Swivel records a typed, versioned capability with inputs, outputs, targets, policy, and success checks. Later invocations execute that reviewed flow without asking a model to choose each action. If the system cannot safely continue, a person can claim the same live browser and return control after the missing step.

## What this implementation demonstrates

- A fresh OpenAI discovery completed seven turns and emitted six reusable steps.
- Replay of that exact artifact returned the expected balances in 3,811 ms with zero model calls.
- Five hosted scenarios passed: lookup, member not found, session recovery, another institution, and live operator handoff.
- The UI passed checks at desktop, tablet, and mobile widths.
- All 192 automated tests passed.

These are measurements from a synthetic banking simulator, not performance guarantees for a real institution. See [verified evidence](../evidence/verified/README.md) and [the design report](../REPORT.md).

## The value to test with a real design partner

The hypothesis is that a reviewed capability can reduce repetitive manual work while making execution easier to inspect. Reuse across similar product versions may reduce implementation effort, but each institution still needs validation, access controls, and its own approved data handling.

A useful pilot would measure successful task completion, operator intervention rate, median and tail latency, maintenance after product updates, and total operating cost. Zero model calls on replay means no model inference charge for those decisions; browser hosting, support, and maintenance still cost money.

The next investment should be durable evidence, tenant isolation, institutional identity, retention controls, and safe artifact promotion. Swivel does not claim regulatory approval or production readiness for financial data.

[Try the demo](https://swivel-demo.web.app) · [Watch the recording](demo/swivel-demo.mp4)
