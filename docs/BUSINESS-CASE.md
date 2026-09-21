# Why this is a business, not a demo

*Every figure below is sourced. Where a number is widely repeated but I could not
trace it to a primary source, it is **excluded** rather than softened — the
numbers that matter here are the ones that survive a procurement review.*

---

## The market is large, concentrated, and stuck

**~8,500 institutions.** 4,238 FDIC-insured banks and savings institutions
(Q2 2026)¹ and 4,250 federally insured credit unions holding $2.48 trillion for
145.8 million members (Q1 2026)².

**Three vendors, most of the market.** The Kansas City Fed's survey of core
banking providers puts Fiserv at 42% of banks, Jack Henry at 21% and FIS at 9% —
over 70% between them³. Jack Henry's own 10-K names the install base: **520
banks on SilverLake, 260 on CIF 20/20, ~715 credit unions on Symitar**⁴.

**The software is genuinely old.** CCG Catalyst identifies ten "first-generation"
cores — CSI NuPoint, FIS Horizon/IBS/Systematics, Fiserv Cleartouch/Precision/
Premier/Signature, Jack Henry CIF 20/20 and SilverLake — built on COBOL, RPG or
Progress, with origin dates from **1968 to 1989**, and counts **over 50
first-generation cores still supported in the US**⁵. SilverLake and CIF 20/20 are
RPG applications on IBM i, reached through 5250 terminal emulation⁶.

**They are not leaving.** 61% of banks have been with their core provider for
more than ten years³. Switching a core is a multi-year, career-risking project.
**They will buy an overlay; they will not buy a replacement.**

**And they are unhappy.** 46% of banks on a Big Three core report
dissatisfaction — around 80% among banks over $10B³.

**The API is not the answer people assume.** The American Bankers Association
told the OCC in 2025 that some core providers treat APIs as a premium feature
rather than baseline infrastructure, "charging high fees, requiring excessive
implementation times, or failing to support API connections altogether"⁷.

---

## The work being replaced is expensive and manual

US financial clerks earn a median of **$49,990**; tellers **$43,030**⁸. BLS
compensation data puts wages at 70% of total compensation⁹, which makes a
**fully-loaded back-office FTE roughly $71,000** before occupancy, supervision
and IT.

Where systems don't talk to each other, **people are the integration layer** —
the industry's own term for it is *swivel-chair integration*. I have deliberately
not put a percentage on how much of a back-office day that consumes, because I
could not find a study that measures it credibly. The honest way to size it is
bottom-up with a design partner's own time-and-motion data, anchored on that
$71,000.

---

## Why the incumbents leave the opening

**RPA is priced and structured around breakage.** UiPath publishes almost no
pricing, but it does publish this: **Self-Healing at $5,000 per 5,000 heals**¹⁰.
The category leader sells selector repair by the unit. That is the clearest
possible statement of where traditional RPA's cost actually goes.

Deloitte's global RPA survey found only **3% of organisations had scaled past 50
robots**, unchanged at 4% in the follow-up¹¹. The mechanism is not disputed:
traditional RPA binds to specific UI elements — XPaths, object ids, class names —
and any screen change breaks the binding.

**Pure LLM-in-the-loop has been tried, at scale, and withdrawn.** OpenAI's
Operator launched in February 2025 and shut down in August 2025¹². Adept raised
over $415M and was absorbed into Amazon in 2024¹³. On OSWorld, the standard
computer-use benchmark, **humans complete 72.36%** of tasks and the best model at
launch managed 12.24%¹⁴; the frontier has since passed the human line — and
still fails roughly one task in six. **That is a fine assistant and an
unacceptable unattended teller.**

---

## The regulatory argument is the moat

Three requirements apply directly, and they all point the same way:

| Requirement | Source | Pure LLM-in-the-loop | Deterministic replay |
|---|---|---|---|
| The bank must perform **its own outcomes testing** on vendor models | SR 11-7 / OCC 2011-12, adopted by FDIC FIL-22-2017¹⁵ | no stable baseline to test against | a fixed artifact and a fixed expected-output suite |
| Auditable evidence the automation did what was intended | SOX 404 ITGC | the action sequence varies run to run | versioned artifact + hash-chained execution log |
| Change management over anything touching a financial control | FFIEC DA&M¹⁶ | a prompt or model change alters behaviour with no ticket | artifact changes are diffable, reviewable, hash-bound |
| Third-party risk management | Interagency guidance, OCC Bulletin 2023-17¹⁷ | vendor cannot say what the agent will do next | vendor hands over a complete behavioural spec |

**The sharpest form of it:** SR 11-7 requires the institution to outcomes-test a
vendor's model. You cannot outcomes-test a system that does not produce the same
output twice. In this market, determinism is not a nice-to-have — it is the
precondition for the examiner signing off at all.

NCUA's position is consistent and worth knowing: it has issued **no AI-specific
regulations**; existing technology-neutral rules apply, and credit unions must
identify, monitor and control AI-specific risks like any other technology¹⁸.

---

## Unit economics

| | Traditional RPA | LLM-in-the-loop | **Swivel** |
|---|---|---|---|
| Build one automation | weeks of developer time | — | **one discovery run** |
| Cost per execution | licence-amortised | a model call per step | **$0 — no model in the loop** |
| Time per execution | seconds | minutes | **~4.7s, measured** |
| Same output twice | yes | no | **yes — 5/5 measured** |
| When the vendor ships a new version | rebuild | re-reason every run | re-record once; every tenant inherits |
| Onboarding institution #2 on the same product | rebuild | — | **one overlay** |

**The compounding advantage is the overlay.** 100 tenants × 20 apps × 10
capabilities is 20,000 recordings if each institution is rebuilt from scratch. As
base capabilities plus overlays it is ~200 recordings and 20,000 small, reviewable
patches — and the marginal cost of tenant *N* on a product you already support
approaches zero. Demonstrated in this repository: a capability recorded at one
credit union runs unattended at a bank two product versions ahead, with a
**single overlay entry**.

**Every rescue makes the fleet smarter.** When a run escalates, the operator's
actions are recorded against a live snapshot. Promoting that into a reviewed step
patch — the next thing I would build — means each escalation is the last of its
kind, across every tenant on that product.

---

## Where the money is

Sell the **capability**, not the seat. A capability is a unit a bank COO
understands: "look up a member's balance", "place a stop payment", priced per
execution or per capability per month, with an examiner-ready evidence bundle
attached to every run. The AI-agent product on top is the demand generator; this
is the layer that makes it safe to let that agent touch the core.

---

### Sources

1. FDIC, *Quarterly Banking Profile*, Q2 2026.
2. NCUA, *Quarterly Credit Union Data Summary*, Q1 2026.
3. Federal Reserve Bank of Kansas City, *Market Structure of Core Banking Services Providers*, 27 Mar 2024.
4. Jack Henry & Associates, Form 10-K, FY2025 (filed 25 Aug 2025).
5. CCG Catalyst, *Sector Spotlight: Core Banking Systems — First Generation*.
6. IT Jungle, *Jack Henry Reiterates IBM i Support*, Jul 2023.
7. American Bankers Association, comment letter to the OCC, 2025 (OCC-2025-0537-0023).
8. US Bureau of Labor Statistics, OEWS, May 2025 — Financial Clerks; Tellers.
9. US Bureau of Labor Statistics, *Employer Costs for Employee Compensation*, June 2026.
10. UiPath published pricing page (Test Cloud add-ons).
11. Deloitte, *Global RPA Survey* (2017) and *Intelligent Automation* follow-up.
12. OpenAI Operator — launched 1 Feb 2025, discontinued 31 Aug 2025.
13. Reporting on Amazon's 2024 hiring of Adept's founders and technology licence.
14. OSWorld benchmark, official site (human baseline 72.36%; launch SOTA 12.24%).
15. Federal Reserve SR 11-7 / OCC 2011-12, *Supervisory Guidance on Model Risk Management*; FDIC FIL-22-2017.
16. FFIEC IT Examination Handbook, *Development, Acquisition and Maintenance*.
17. *Interagency Guidance on Third-Party Relationships: Risk Management*, Jun 2023 (OCC Bulletin 2023-17).
18. NCUA, Artificial Intelligence resource page; Letters 07-CU-13 and 01-CU-20.

**Deliberately excluded** as untraceable to a primary source, despite being widely
quoted: "EY: 30–50% of RPA projects fail", "Forrester: maintenance is 60% of RPA
cost", "Gartner: 30–40% of RPA team time goes to maintenance", and all per-bot RPA
licence figures (no vendor publishes them; the circulating numbers are reseller
estimates).
