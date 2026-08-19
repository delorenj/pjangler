---
id: SPEC-project-notebook
companions:
  - acceptance-contract.md
  - ../../planning-artifacts/prds/prd-pjangler-project-notebook-2026-08-19/addendum.md
  - ../../planning-artifacts/architecture/architecture-project-notebook-2026-08-19/ARCHITECTURE-SPINE.md
sources:
  - ../../planning-artifacts/prds/prd-pjangler-project-notebook-2026-08-19/prd.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only.

# PJangler Project Notebook

## Why

PJangler-managed repositories need durable, searchable project context without a separate knowledge-infrastructure chore. Each repository must gain one Companion Notebook through the same reviewable, idempotent lifecycle that governs project setup, while Git remains authoritative and agent sessions remain usable when the Notebook Service or summarizer fails.

## Capabilities

- **CAP-1 — Repository pairing and bootstrap**
  - **intent:** An operator can bootstrap or link each registered repository to exactly one Companion Notebook through the normal PJangler lifecycle.
  - **success:** Dry-run writes nothing; one ordered external tail yields one notebook and one Overview Note, persists a truthful binding through one final Registry mutation after remote outcome is known, leaves recoverable `planned` or `blocked` state on uncertainty, and creates no duplicate when retried.

- **CAP-2 — Authoritative binding and policy resolution**
  - **intent:** PJangler can resolve and report a repository's authoritative Notebook Binding and effective Project Notebook policy.
  - **success:** Registry-owned binding fields and Manifest-owned policy round-trip through YAML and PostgreSQL stores, the Manifest binding projection is checked for Drift, unknown fields survive sync, and effective values report provenance without exposing credentials.

- **CAP-3 — Repository-scoped notebook operations**
  - **intent:** Users and automation can inspect status, create or link a notebook, manage the Overview Note, perform note CRUD, recover captures, and search through `pj notebook` without using the raw service API.
  - **success:** Operations use stable identifiers, deterministic pagination and local text search, reject foreign-note and Overview deletion, return only the current notebook's results, and validate exact JSON-v1 data and categorized exit contracts before rendering.

- **CAP-4 — Owned audit and migration**
  - **intent:** An operator can detect and repair only Project Notebook-owned Drift.
  - **success:** Audit is side-effect free, local-only mode skips remote proof, migrate plans only owned rules, unrelated state survives, successful apply verifies postconditions, failure remains recoverable, and an identical second migration changes nothing locally or remotely.

- **CAP-5 — Safe Notebook Service boundary**
  - **intent:** PJangler can use an Open Notebook-compatible service through one bounded, reusable, repository-isolating boundary.
  - **success:** Endpoint and authentication resolve at runtime, calls have finite bounds and normalized outcomes, every create is crash-journaled, unresolved dispatch reconciles without a blind second request, and every returned or mutated object proves membership in the resolved Notebook Binding.

- **CAP-6 — Canonical skill and project-scoped hooks**
  - **intent:** PJangler can install one canonical Project Notebook skill and register repository-scoped Managed Hooks through the agent master fanout.
  - **success:** A packed CLI installs a digest-verified immutable projection from the sole Skillex source even without the developer checkout; hooks act only for enabled bindings, preserve foreign order, project idempotently, support true Claude `SessionStart` and `SessionEnd`, and never treat `Stop` as session close.

- **CAP-7 — Bounded session priming**
  - **intent:** A supported agent session can receive its repository's Overview Note once while establishing a trustworthy capture baseline.
  - **success:** Before remote access, start exclusive-creates an exact session-keyed baseline containing HEAD plus bounded tracked-document status and content identities, so pre-existing dirty work is not attributed without an additional proven change; it then emits one bounded Overview with exact descriptor Drift and fails open without overwriting the baseline on resume.

- **CAP-8 — Durable session capture**
  - **intent:** A true session-close boundary can preserve one factual Session Capture and current derivatives of eligible changed documents without delaying shutdown.
  - **success:** Close deduplicates by exact session identity, serializes the real candidate, and admits a new receipt only when prospective unresolved count and bytes remain within both configured caps; refusal creates no receipt, preserves a grace-bounded replay marker, states that the session was not captured with exact list/retry actions, and exits successfully. Admitted work reuses stable identities, protects pre-existing dirty baselines, and remains recoverable through the same receipt.

## Constraints

- Git and version-controlled repository documents remain authoritative; notebook content is derivative context. One canonical repository identity maps to one stable remote notebook identifier, while its display name may drift after a rename.
- The singleton recipe registry owns lifecycle orchestration and checks. CLI, future MCP, and hook entrypoints remain thin adapters. The Project Registry owns global defaults and bindings, the Project Manifest owns repository policy and mirrors binding read-only, and the Notebook Service owns note bodies.
- Dry-run performs zero writes. Composite effects share one ordered external tail and one final Registry mutation; remote creates use a durable dispatch journal and never blind-retry uncertainty. Init, create, and migrate remote work requires `--live`; direct mutations and hooks retain their operation-scoped authorization.
- YAML, including `PJ_PROJECT_REGISTRY`, and PostgreSQL RegistryStore projections use additive changes, preserve unknown and unrelated fields, and remain compatible with PJangler's Node.js 20+ TypeScript/ESM plan/apply and recipe architecture.
- Service configuration uses an explicit hostname and runtime-only authentication. Raw credentials and hardcoded LAN addresses are forbidden in tracked or persistent configuration, logs, exceptions, fixtures, hook payloads, JSON, and notebook content.
- Managed Hooks fail open, use true lifecycle boundaries, and keep atomic, permission-restricted mutable state outside the repository. Every logical init, hook delivery, capture, document revision, and migration is idempotent.
- Context, excerpts, diffs, uploads, responses, diagnostics, calls, and retries are bounded. Capture is documentation-only by default. Succeeded receipts expire; unresolved receipts are never auto-deleted or compacted, and prospective count/byte admission gates fail open before receipt creation. Unreferenced receiptless baseline, claim, and refusal state has one finite baseline-created grace and expires at equality; receipt or journal references protect it.
- Upstream search is global and untrusted; every read, result, mutation, hook action, and migration is constrained to the resolved repository binding. Tests use isolated registries and a fake service, never live operator data.

## Non-goals

- Replacing Git, repository documentation, Hindsight, or PJangler configuration as the source of truth.
- Cross-project or fleet search and migration, analytics, scheduled rollups, knowledge graphs, or silent mutation of existing projects.
- Building or administering the Notebook Service, its gateway, backups, users, GUI, or Open Notebook web application.
- Uploading all source code, ignored or generated files, binaries, secrets, full transcripts, rich media, webpages, OCR, or audio.
- New MCP commands, unsupported-client lifecycle equivalence, a general outbox platform, or multi-tenant authorization in MVP.
- Capture Receipt dismissal or automatic discard of unresolved recovery evidence in MVP.

## Success signal

In an isolated generated-project demonstration, one `pj init` plan and live-authorized apply produce exactly one Companion Notebook, Overview Note, typed Registry and Manifest state, and idempotent Managed Hooks; Project Notebook audit passes and scoped CRUD/search returns clean JSON. A supported start/close pair primes once and produces one evidence-grounded capture without attributing pre-existing dirty work. At either unresolved-receipt cap, close creates no receipt, says the session was not captured, supplies exact list/retry recovery, and resumes admission only after existing measures recover below both caps and replay of the real candidate passes both prospective gates.

## Assumptions

- **A-1:** Overview Note content defaults to 4,000 characters and is configurable only within a separate safe ceiling.
- **A-2:** Capture quality is sampled across at least 20 staged sessions, requires complete provenance, and accepts at least 95% factual claim support.
- **A-3:** A configured low-cost LLM is normally available, but its absence or failure never prevents deterministic fallback capture.
- **A-4:** Verified Open Notebook v1.14 note CRUD, disabled password authentication, and unfiltered search remain sufficiently compatible; adapter contract tests, not the version string, are authoritative.
- **A-5:** MVP serves one trusted operator through one shared Notebook Service; multi-tenant authorization is deferred.
- **A-6:** Initial p95 budgets are two seconds for session-start priming and 250 milliseconds for session-close foreground enqueue.
