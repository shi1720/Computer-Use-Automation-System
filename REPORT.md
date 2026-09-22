# Swivel: design and trade-offs

Swivel turns one model-driven interaction with legacy software into a typed capability that can be replayed without a model. The implementation operates MERIDIAN, a deliberately awkward banking simulator. Its framesets, nested tables, generated control IDs, unlabelled inputs, two vendor versions, and injected runtime errors exercise the integration problems the brief describes. All bank records are synthetic.

## 1. Architecture

The TypeScript core has five boundaries: a `Surface` observes and acts; discovery selects actions through an interchangeable model provider; an artifact describes the reusable job; replay executes that artifact; and a runner assembles sessions, policy, evidence, and control leases. The CLI, console, and MCP adapter share the core.

Playwright drives a real Chromium browser. The extractor reduces each frame to roles, names, geometry, table relationships, and transient references. The model selects a control from that perception. Deterministic code creates its durable descriptor, substitutes parameters, classifies risk, and adds checkpoints. The artifact is separate from the model transcript.

The simulator intentionally has an API for injecting faults, but the automation performs the banking workflow only through its UI. Credentials are resolved by a session provider, outside the model and artifact. The reference discovery uses OpenAI's Responses API with function calls; replay has no model dependency.

The console uses Express and browser ES modules. JSON files are sufficient for this single-process reviewable implementation, with atomic writes and content hashes. The public demo runs in one bounded Cloud Run instance behind Firebase Hosting. It offers five fixed scenarios against loopback-only synthetic banks. Guest sessions have distinct identities, evidence access, invocation permission, and takeover permission, but no approval or financial execution role. Live WebSockets use the Cloud Run TLS endpoint because Firebase Hosting is not the live control transport. Demo runs reset on instance replacement; committed evidence is restored on startup.

## 2. Artifact schema

A capability is a versioned document with metadata, a target product and entry point, a typed contract, named targets, an ordered flow, known signals, success assertions, policy, quality, and provenance. Inputs and outputs declare types, descriptions, validation constraints, and sensitivity. The contract also declares business outcomes and whether the flow has side effects.

Values use explicit namespaces such as `{{input.memberNumber}}`, `{{vocab.member}}`, and `{{tenant.baseUrl}}`. Credentials are references resolved at execution time. Discovery's concrete member number is not copied into reusable selectors. Extract steps address named outputs and apply declared transforms, such as converting a money string to a number.

Targets combine independent evidence: role and name, nearby captions, frame scope, row identity, and column header. Generated IDs are corroborating hints. A balance cell is identified by its product row and column heading, rather than its numeric position. Every target carries a rationale, so a reviewer can assess why it should remain stable.

Zod validates serialization. Semantic validation rejects undeclared outputs, missing input references, unsafe write steps without checkpoints, inconsistent effects, and empty allowlists. A normative content hash identifies behavior; replay statistics and approval metadata do not change that hash. Approval is tied to the reviewed hash. A saved artifact remains a candidate until it has been replayed and reviewed.

## 3. Determinism & error handling

Replay resolves the same descriptors, executes the ordered actions, checks each relevant postcondition, validates typed outputs, and verifies final success. It does not ask a model to choose a fallback. Ambiguous targets are refused. Corroborating evidence can flag version drift without overriding a clear semantic match.

The result is a discriminated union. `success` includes declared outputs. `business_outcome` represents a legitimate answer such as member not found or permission denied. `failed` includes a classified error and failing step. `escalated` records a human completion or abort without presenting unverified human work as automated success.

Signals explicitly distinguish business conditions, recoverable errors, and hard failures. Recovery strategies have retry limits. A mid-flow session timeout re-authenticates in the same browser context and restarts only if no irreversible work has been committed. Known interstitials have explicit actions and checkpoints. The engine avoids blindly retrying state-changing submissions.

The evidence bundle contains a manifest, hash-chained events, and redacted perception snapshots. Failure captures offer more context than a stack trace. Chain verification detects changes relative to the recorded tip; it is not an externally anchored or independently signed audit log. Automated tests cover targeting, policy, redaction, contracts, recovery, control leases, authentication, and hosted boundaries. An additional acceptance script drives the live HTTP service, real browser replays, and WebSocket handoff.

## 4. Heterogeneity & multi-tenant

The flow operates on the `Surface` vocabulary rather than Playwright locators. A desktop adapter could produce equivalent nodes from UI Automation or an accessibility tree and execute native actions. An image-only surface would need visual anchors, recognition confidence, and coordinate calibration. That adapter is a design seam, not an implemented claim.

The two MERIDIAN tenants are concrete demonstrations of reuse. Harbor Point changes terminology, generated IDs, a grid column, and the visibility of the account grid. A small overlay adds vocabulary and target overrides plus one Display step. Without it, replay stops at the unresolved balance cell; with it, the same base capability returns the same outputs.

At larger scale, artifacts would be keyed by vendor, product, and supported version range, with institution overlays reviewed separately. A tenant cannot silently weaken the base safety policy. Canary replays, target-confidence trends, product fingerprints, and version promotion would identify drift. A materially divergent overlay should become a new capability version rather than an ever-growing patch set.

## 5. Escalation & handoff

When replay cannot identify a control or safely recover, it raises an intervention with the capability, step, diagnosis, and evidence. Automation pauses while a control lease records who may act. An authorized operator claims the ticket. The console exposes the same browser's CDP screencast and input channel; it does not open a replacement session.

The live server verifies a per-session bearer token and the current lease. Only the claiming operator receives the token. One connected socket can drive at a time. Leaving the control view closes its socket; reconnecting receives the latest frame even when the bank screen has not changed. Keyboard forwarding is limited to the focused live screen, with Escape returning focus to the console. Clicks and keyboard actions are recorded. The operator can resume automation, report completion by hand, or abort. On resume, the live channel closes and automation reacquires control. The demonstrated rescue opens Harbor Point's collapsed deposit grid, then the recorded extraction and success checks run normally.

Discovery can report a stuck condition, but its interactive resume path is deliberately less complete than replay's. The end-to-end live takeover is implemented and tested on replay. A production discovery editor should convert human rescue actions into reviewable steps before a capability is promoted; silently saving an artifact that depends on unrecorded human work would be misleading.

## 6. Safety

Policy uses explicit origin, route, and action allowlists. Browser request interception also checks document navigation, covering redirects and operator navigation. Risk is classified outside the model. Irreversible capabilities require confirmation and the relevant role. The public demo exposes only fixed read-only scenarios; general invocation remains available locally.

Sensitive fields are redacted in text evidence and parameterized in artifacts. Model API credentials are environment-only and OpenAI response storage is disabled. Passwords use scrypt; session cookies are signed, HttpOnly, SameSite, and Secure over HTTPS. The cookie is named `__session` so Firebase forwards it. Authentication rejects malformed inputs, and API responses are private and non-cacheable.

Screenshots can contain visible data. The demo uses synthetic records, and screenshots are explicitly marked and role-gated. This is not a production guarantee for arbitrary regulated data. Production would default to no image persistence, apply an institution-approved masking pipeline, encrypt storage, and enforce retention and access auditing. Network allowlisting and bounded policies also do not make every unfamiliar page trustworthy; production approval requires testing the actual application.

## 7. Cuts

There is no desktop implementation, distributed queue, production identity provider, durable hosted demo database, OCR-based redaction guarantee, or cross-process locking service. File storage and in-memory leases suit a single review instance, not thousands of concurrent institutional workers. The hosted sandbox caps concurrency to one demo run to prevent scenario resets from interfering with another browser.

Next work would prioritize durable job and evidence storage, per-tenant isolation, SSO, authenticated runner registration, crash recovery, retention controls, and stronger artifact promotion checks. Only after those would I add more surfaces. The small working slice is the deliverable: real model discovery, a reusable artifact, deterministic replay, runtime outcomes, and control transfer on the same live browser.
