# Demo video — script

**Target length:** 4:30–5:00 · **Format:** screen recording with voice-over
**Tone:** calm, specific, unhurried. Let the terminal do the work; don't narrate every keystroke.

Read the **spoken** lines verbatim. The bracketed lines are what to have on screen.

---

## 0:00 — Cold open (15s)

> *[Full-screen: the MERIDIAN sign-on page. Grey, beige, Tahoma, a `<frameset>`.]*

**"This is what a credit union's back office actually looks like.**

**Framesets. Table layouts. Generated control ids. No API. Roughly eight and a
half thousand US banks and credit unions run software like this, and staff move
data between these screens by hand, all day."**

---

## 0:15 — The problem with the obvious answer (30s)

> *[Cut to the goal being typed in a terminal. Don't run it yet.]*

**"The obvious answer is to point a computer-use model at the screen. And a
model can do this — I'll show you in a second.**

**But you can't run a bank on it. Frontier models now beat the human baseline on
computer-use benchmarks and still fail about one task in six. A seventeen
percent failure rate on an unattended posting isn't a product. It costs a
model round-trip per click. And there's a regulatory problem underneath both of
those: SR 11-7 says the *bank* has to do its own outcomes testing on a vendor's
model."**

> *[On screen, plain text on black:]*
> **You cannot outcomes-test a system that does not produce the same output twice.**

**"So Swivel uses a model exactly once."**

---

## 0:45 — Discovery (60s)

> *[Run `swivel discover`. Let the event stream scroll. Don't pause it.]*

**"A goal in English, the institution, and the parameters this capability should
take. The model signs in, reads the screen, and works out what a trained
operator would do.**

**Watch what it's doing: opening member search — typing the member number —
submitting — picking the right row out of the results grid — and pulling two
balances off the share accounts table."**

> *[Discovery finishes. The flow prints.]*

**"Six steps. And here's the part that matters: the model chose *which*
controls. It did not write a single selector.**

**Swivel decided how each one is described — because models are bad at that, and
because a model doesn't know which value on screen came from a parameter and
which is this member's data. Look at step two."**

> *[Point at the step-two line.]*

**"That search box has no label. None. The application never associated one. So
it's recorded the way a human finds it: the box to the right of the words
'Member #'. And 'Member #' isn't stored as text — it's stored as a reference to
this institution's vocabulary. That one decision is why this artifact will work
at a bank that calls it 'Customer ID'."**

---

## 1:45 — Replay (30s)

> *[Run `swivel replay`.]*

**"Now the same job, from the saved artifact."**

> *[Result lands.]*

**"Four point seven seconds. Six steps. Zero model calls. Typed output — the
balance came back as a number, not as the string '18,402.66'.**

**Every target resolved at a hundred out of a hundred. That score is real: the
engine scores the evidence it has for a control, and below its threshold it
refuses to act rather than clicking the wrong row of a fee-reversal screen."**

---

## 2:15 — Errors are the product (55s)

**"Happy paths are the easy ten percent. Here's the rest."**

> *[Run the not-found case.]*

**"A member that doesn't exist. That is not a crash — it's a declared business
outcome. The calling agent branches on `RECORD_NOT_FOUND`. Conflating that with
a failure is the most common way this kind of system goes wrong."**

> *[Run `--inject session-expiry-midflow`.]*

**"Now the session times out mid-flow, the way a real core does after fifteen
minutes. It re-authenticates on the *same* browser session, and then it
restarts the flow — and it checks something first: nothing had been committed
yet, so replaying is safe. If a step had already posted a transaction, it
refuses to restart and asks a human, because replaying would post it twice."**

> *[Run the stop-payment with no `--confirm`.]*

**"And a stop payment — irreversible, fee-bearing. Refused in four
milliseconds, before a browser even opened, because the caller didn't supply a
confirmation token. A model can't talk its way past that; the token has to come
from a human or a policy decision upstream."**

---

## 3:10 — Escalation (60s)

**"Now the interesting failure. Same artifact, different institution — same
vendor product, two versions apart — and I'm deliberately running it with
nothing adapted for that institution at all."**

> *[Run the Harbor Point replay with `--no-overlay`. Let it get several steps in.]*

**"Watch how far it gets on meaning alone. The navigation link, the unlabelled
search box, the right row of the results grid — even though this build inserts
an extra column in the middle of that grid, which is exactly what breaks a
locator that counts columns."**

> *[It stops.]*

**"And then it refuses. This build hides the balances behind a button, so the
cell the artifact describes isn't on the screen. The best candidate scored zero
out of a required sixty, and it tells you precisely which evidence went missing.**

**That refusal is the whole product. There were other cells on that screen. A
locator that grabbed the nearest one would have handed the caller a number —
and the caller would have had no way to know it was the wrong number.**

**Then it pauses. And the browser session is still alive."**

> *[Switch to the console, operator queue, open the ticket, claim it.]*

**"This is the operator console. One click, and I'm looking at a live screencast
of that paused session — not a new one. The same browser, mid-flow, with
whatever the application has built up server-side."**

> *[Click the Display control inside the live view. The remote screen updates.]*

**"That click went to the real session. I'll do the one thing it couldn't — and
hand control back."**

> *[Hand back with "resume". Switch to the terminal.]*

**"And it picks up where it stopped, and finishes. Both balances, extracted by
the automation. Everything I did is on the run's evidence chain — my account,
my click, my note.**

**One more thing worth seeing: if I'd told it *I* finished the job instead, it
reports `escalated`, not `success` — with null outputs. The screen looks the
same either way. The automation just won't claim work a person did."**

---

## 4:10 — Multi-tenant and the agent interface (35s)

**"Now the same command with the overlay. Most of the differences needed no
override at all — that's what you just watched. This institution needed exactly
one entry: a step to press that Display button."**

> *[Run the Harbor Point replay with the overlay. It succeeds.]*

**"Second institution. Unattended. One overlay — not a re-recording.**

**And this is what the agent-facing product actually calls."**

> *[Show the MCP tool listing.]*

**"The capability compiles straight into a tool definition. Only approved
capabilities are listed. The description tells the calling model whether this
changes records, whether it can be undone, and which business outcomes it can
return."**

---

## 4:45 — Close (20s)

> *[Console: the run's evidence timeline, chain verified.]*

**"Every run leaves a hash-chained evidence bundle. Edit one event and
verification tells you which one.**

**The model discovers. The artifact is the capability. Deterministic replay is
how it runs in production — and how a bank examiner can check it."**

> *[Last frame: the repo URL.]*

---

## Recording checklist

- [ ] `npm run meridian`, `npm run console` up; terminals at ~16pt
- [ ] `.swivel` reset so the catalogue starts empty for the discovery shot
- [ ] Browser zoom 100% for the console; dark OS theme
- [ ] Discovery takes minutes — record it, then **speed it up 8–10×** under the voice-over
- [ ] Two terminals side by side for the escalation section, or a clean cut
- [ ] Nothing on screen but the demo: no notifications, no other tabs

## If you only have 90 seconds

Discovery (sped up) → replay → not-found outcome → stop payment refused →
escalation takeover → Harbor Point success. Skip everything else.
