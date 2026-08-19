---
title: Project Notebook for PJangler
status: final
intent: update
created: 2026-08-19
updated: 2026-08-19
ticket: PJAN-77
projectType: brownfield
classification:
  product: internal developer tool
  surface: CLI and lifecycle module
  stakes: chain-top planning artifact
inputDocuments:
  - docs/index.md
  - docs/product-brief-pjangler-2026-02-01.md
  - docs/project-overview.md
  - docs/architecture.md
  - /home/delorenj/.codex/attachments/5b7202b7-e13c-4411-9f5e-4e02a7b330c2/pasted-text-1.txt
downstream:
  - bmad-spec
  - bmad-architecture
  - bmad-create-epics-and-stories
  - bmad-check-implementation-readiness
---

# PRD: Project Notebook for PJangler

## 0. Document Purpose

This PRD defines the user-visible behavior and product boundaries for PJAN-77. It is for the product owner, architect, story author, implementer, and validator. Vocabulary is anchored in §3; Features group stable, globally numbered Functional Requirements (FRs); inferred facts are tagged inline and indexed in §13. Technical mechanisms and proposed schemas live in `addendum.md` so this document remains a capability contract rather than an implementation plan.

## 1. Vision

Every repository bootstrapped by PJangler should arrive with durable project memory, not a separate knowledge-infrastructure chore. Project Notebook pairs one repository with one Companion Notebook and makes that pairing part of the same plan, apply, audit, and migrate lifecycle that already governs the rest of a PJangler project.

The product thesis is that repository memory becomes dependable only when PJangler owns its lifecycle contract. A modular Project Notebook Module creates or links the Companion Notebook, projects the Notebook Binding into canonical configuration, offers high-level note operations under `pj notebook`, and detects or repairs drift. A Project Notebook Skill then uses Managed Hooks to prime an agent with one bounded Overview Note and to preserve eligible documentation plus a concise Session Capture after work ends.

The Companion Notebook is a searchable derivative knowledge layer, not a replacement for Git, repository documentation, Hindsight, or PJangler configuration. Version-controlled files remain authoritative. Notebook automation must preserve PJangler's existing user-control promise: dry-run before change, explicit live actions, idempotent reconciliation, bounded context, clear failures, and no credential leakage.

## 2. Target User

### 2.1 Primary User

Jarad is the primary operator: a solo builder managing many repositories and agent sessions. He values automation that is fast and repeatable, but he also expects to see planned changes, preserve unrelated work, and recover from drift without manual configuration surgery.

### 2.2 Secondary Users

- Coding agents that need bounded project context at session start and must leave durable evidence at a true session boundary.
- Scripts and CI jobs that need predictable note CRUD, search, JSON output, exit behavior, and safe retries.
- Future PJangler interfaces that may reuse the Project Notebook Module without duplicating CLI business logic.

### 2.3 Jobs To Be Done

- When I bootstrap a repository, give it a usable Companion Notebook through the normal PJangler lifecycle so I do not perform separate setup.
- When I enter a repository, let me inspect and manage its notes without learning the Notebook Service's raw API.
- When an agent begins work, prime it with only the repository's bounded overview, alongside Hindsight, so context is useful rather than noisy.
- When an agent finishes work, preserve eligible documentation changes and a factual Session Capture without blocking shutdown.
- When configuration or remote state drifts, tell me exactly what is wrong and repair only Project Notebook-owned state.

### 2.4 Non-Users in MVP

- Multi-tenant organizations requiring per-user Notebook Service authorization or enterprise governance.
- People administering the Notebook Service itself.
- Consumers seeking fleet-wide or cross-project notebook discovery.
- Users seeking a graphical notebook-management interface.

### 2.5 Key User Journeys

- **UJ-1. Jarad bootstraps a repository and receives its Companion Notebook.** Jarad runs `pj init` and first sees a dry-run plan naming the Notebook Binding and any Live Action. He applies the plan and, when live provisioning is authorized, PJangler creates or reuses exactly one Companion Notebook. `pj notebook status` shows the paired repository, notebook name, stable binding state, and next action. Repeating init does not create a duplicate. If the Notebook Service is unavailable, the repository remains in an explicit recoverable planned state rather than a falsely healthy one.

- **UJ-2. Jarad starts an agent session with bounded context and closes with durable evidence.** A Managed Hook resolves the current Notebook Binding and emits its Overview Note at most once for the session, alongside the separate Hindsight recall. At a true session-close event, a fast foreground step records work for background processing. The Session Capture includes a concise factual summary and current derivatives of Eligible Documents changed during the session. The agent exits normally even if the Notebook Service or configured summarizer is unavailable, and a retry does not create duplicate notes.

- **UJ-3. Jarad audits and repairs an older repository.** In a repository created before PJAN-77, Jarad runs `pj notebook audit` and receives owned findings for missing or mismatched configuration, Notebook Binding, Overview Note, and Managed Hooks. A dry-run migration names each proposed local and Live Action. Applying it preserves unrelated Project Manifest, Project Registry, and hook content. A second migration is a no-op and the follow-up audit passes.

- **UJ-4. Jarad automates note work through the CLI contract.** Jarad or one of his scripts adds a note, stores its stable identifier from JSON output, lists or retrieves it, updates it, searches only the current Companion Notebook, and deletes it. Empty results, invalid input, missing configuration, authorization failure, timeout, and malformed Notebook Service responses are distinguishable without parsing prose or ANSI control codes.

## 3. Glossary

- **Apply** — Explicit execution of a PJangler Plan. Apply may change local owned state; a remote mutation additionally requires a Live Action gate.
- **Capture Receipt** — Mutable runtime metadata for one Session Capture attempt, including session identity, baseline, outcome, retry count, and bounded diagnostics. It lives outside the repository and contains no credential or document body.
- **Companion Notebook** — The single Notebook Service notebook paired with one repository. Its display name follows the repository name; its stable service identifier preserves identity across renames.
- **Drift** — A difference between desired Project Notebook-owned state and observed local or remote state.
- **Eligible Document** — A version-controlled documentation file selected by Session Capture policy. Source code, ignored files, generated output, binary files, and secret-bearing files are not Eligible Documents by default.
- **Live Action** — A remote mutation embedded in a composite PJangler init, create, or migrate flow and therefore gated by `--live`. Direct `pj notebook` reads and mutations are authorized by invoking that explicit command; autonomous Managed Hooks are authorized by durable Project Manifest policy shown in the Apply Plan.
- **Managed Hook** — A Project Notebook Skill hook registered through the agent master-hook fanout and scoped at runtime by the current repository.
- **Notebook Binding** — The stable one-to-one relationship among a repository identity, Companion Notebook service identifier, display name, Overview Note identifier, and lifecycle state.
- **Notebook Service** — The configured Open Notebook-compatible remote service that stores Companion Notebooks and notes.
- **Overview Note** — The one bounded note designated to prime an agent session for a Companion Notebook.
- **Plan** — A side-effect-free description of proposed PJangler actions and findings. Dry-run emits a Plan and performs no writes.
- **Project Manifest** — The repository-local `.project.json` projection containing project-owned state and repository policy overrides.
- **Project Record** — One project's authoritative entry in the Project Registry, including the owned Notebook Binding fields.
- **Project Notebook Module** — The PJangler lifecycle component that owns Project Notebook planning, configuration, service operations, checks, and migrations.
- **Project Notebook Skill** — The global `project-notebook` skill containing operator guidance, references, and Managed Hook assets.
- **Project Registry** — PJangler's global `~/.config/pjangler/projects.yaml` configuration and per-project binding store, or its explicit test/runtime override.
- **Recipe Registry** — PJangler's singleton lifecycle discovery and execution boundary. It owns recipe dependency order and dispatches initialization, audit, and selected migration.
- **Session Capture** — One deduplicated end-of-session record containing a factual summary and provenance for Eligible Documents processed during that session.

## 4. Features

### 4.1 Repository Pairing and Lifecycle

**Description:** The Project Notebook Module makes a Companion Notebook a normal dependency of PJangler project bootstrap and sync. The immutable service identifier, not the mutable display name, is binding authority. Realizes UJ-1 and UJ-3.

#### FR-1: Deterministic one-to-one binding

PJangler can derive, persist, and resolve one Notebook Binding for one canonical repository identity.

**Consequences (testable):**
- A new repository's Companion Notebook display name deterministically follows its repository name unless the Project Manifest supplies an allowed display-name override.
- Re-running resolution for the same canonical repository returns the same Notebook Binding.
- Two registered repositories cannot claim the same stable Companion Notebook identifier.
- A repository rename produces name Drift against the existing Notebook Binding rather than silently creating another Companion Notebook.

#### FR-2: Notebook-aware project initialization

`pj init` includes Project Notebook actions in its Plan and Apply lifecycle.

**Consequences (testable):**
- Dry-run reports proposed binding, configuration, Managed Hook, Overview Note, and Live Action work and changes zero bytes locally or remotely.
- Apply writes Project Notebook-owned local state only when selected.
- Live-authorized Apply creates or reuses one Companion Notebook and makes the resulting stable identifier available to the Project Registry and Project Manifest transaction.
- Missing configuration, missing authorization, or Notebook Service failure leaves an explicit recoverable state and next action; it never reports a healthy Notebook Binding.
- Project Notebook checks participate in the final registry-wide init audit. Without Live Action authorization, remote checks are `skip` and the binding remains `planned`; with authorization, remote postconditions must hold before the Project Registry is persisted.

#### FR-3: Canonical configuration resolution

The Project Notebook Module resolves global defaults and the authoritative Notebook Binding from the Project Registry, verifies the Project Manifest's read-only binding projection, then applies repository policy overrides from the Project Manifest.

**Consequences (testable):**
- The Project Registry is authoritative for `notebook_id`, `notebook_name`, `overview_note_id`, and persisted binding `state`.
- The Project Manifest mirrors those four fields for local resolution and stores repository policy overrides separately; changing a mirrored field produces Drift rather than overriding the Project Registry.
- MVP supports the YAML Project Registry (including a `PJ_PROJECT_REGISTRY` path override) and the existing PostgreSQL RegistryStore projection. Both round-trip the Notebook Binding through additive schema migration and preserve unknown fields.
- Credentials are rejected from both persistent configuration surfaces.
- Sync and re-init preserve unknown and unrelated Project Registry and Project Manifest fields.
- Effective configuration output identifies each value's source without exposing a credential.

#### FR-4: Idempotent creation and recovery

The Project Notebook Module can safely retry initialization or explicit `create` after interruption or an ambiguous Notebook Service response.

**Consequences (testable):**
- Repeated successful init or `pj notebook create` calls produce one Companion Notebook and one Notebook Binding.
- Before a retry creates remote state, PJangler reconciles existing stable identity evidence and deterministic metadata.
- A partially completed transaction can be audited and resumed without hand-editing configuration.
- A stale display name can be repaired without changing the stable Companion Notebook identifier.

### 4.2 High-Level `pj notebook` Operations

**Description:** Users and automation manage the current repository's Companion Notebook through a stable, repository-aware command group. They do not need raw Notebook Service endpoint knowledge. Realizes UJ-1 and UJ-4.

#### FR-5: Repository context and status

The CLI can resolve a target repository explicitly or from the current Git repository and report its effective Notebook Binding status.

**Consequences (testable):**
- Running outside a registered repository returns a configuration error with a corrective next action.
- Status distinguishes the complete observed outcome set: unconfigured, disabled, planned, linked, healthy, drifted, unavailable, and blocked. Persisted binding states are disabled, planned, and linked; the other outcomes are computed health.
- Status never contacts the Notebook Service when invoked in local-only mode.
- Human output is concise; JSON output contains the resolved repository identity and structured status.
- Status reports queued, processing, failed, retry-exhausted, and `blocked-missing-baseline` Capture Receipts with a safe recovery next action.
- Status reports a bounded retention-pressure finding when either configured unresolved-receipt admission cap is reached. The finding includes current count and byte usage, both caps, and the exact `capture list`/`capture retry` recovery next action; it is not a Capture Receipt state.

#### FR-6: Companion Notebook creation and overview management

The user can idempotently create or link the Companion Notebook and read or replace its Overview Note.

**Consequences (testable):**
- `create` reuses a matching Companion Notebook or returns a conflict that names the ambiguity; it does not guess.
- A new binding receives one Overview Note containing project identity, a purpose placeholder, and links to authoritative repository documents.
- Overview reads return bounded content and stable metadata.
- Replacing Overview Note content is an in-place update that preserves its stored note identifier.

#### FR-7: Note CRUD

The user can list, add, get, update, and delete notes within the current Companion Notebook.

**Consequences (testable):**
- Create returns a stable note identifier; get, update, and delete require that identifier.
- List supports deterministic pagination and ordering.
- Update preserves the note identifier and reports the resulting revision metadata supplied by the Notebook Service.
- Delete requires explicit confirmation in interactive human mode or an explicit non-interactive confirmation flag.
- A note identifier belonging to another Companion Notebook is rejected as out of scope.
- Generic note deletion rejects the designated Overview Note; the overview command owns its lifecycle.

#### FR-8: Notebook-scoped search

The user can search notes while receiving results only from the current Companion Notebook.

**Consequences (testable):**
- Results never include a different repository's Companion Notebook even when the upstream search operation is global.
- Empty search is a successful result with an empty collection.
- Search results expose stable note identifiers, titles, bounded excerpts, and relevance/order metadata when available.
- `[NON-GOAL for MVP: cross-project search, semantic re-ranking, and answer generation are not part of this command.]`

#### FR-9: Stable human and machine contracts

Every public `pj notebook` operation supports readable human output and, where data is returned, a versioned JSON form.

**Consequences (testable):**
- JSON output contains no ANSI sequences or unstructured progress text.
- Success, empty result, invalid input, missing configuration, authentication failure, unavailability/timeout, remote protocol failure, conflict, and detected Drift have distinct structured error codes and documented exit behavior.
- Diagnostic output never contains credential values or complete secret-bearing request headers.
- The public surface and compatibility policy in §8 apply to every command.

### 4.3 Agent Context and Session Capture

**Description:** The Project Notebook Skill participates in the existing agent master-hook fanout. Managed Hooks resolve the repository at runtime, keep mutable state outside Git, fail open, and never replace Hindsight. Realizes UJ-2.

#### FR-10: Global skill and project-scoped hook projection

PJangler can install the Project Notebook Skill globally and register its Managed Hooks through the existing fanout while keeping behavior repository-scoped.

**Consequences (testable):**
- One canonical Project Notebook Skill supplies all client projections; generated clients do not contain divergent copies of hook logic.
- A Managed Hook acts only when the current repository has an enabled Notebook Binding.
- Installing or migrating Managed Hooks preserves foreign hook records, ordering constraints, conditions, comments, and additional keys.
- Re-running hook projection produces no duplicate registration and zero changed bytes.
- MVP supports at least Claude Code `SessionStart` and `SessionEnd`. Other clients enter the supported matrix only when their adapters prove equivalent true lifecycle boundaries; Codex turn-level `Stop` does not qualify as session close.

#### FR-11: Once-per-session overview priming

At a supported session-start boundary, a Managed Hook can emit the current Companion Notebook's bounded Overview Note once.

**Consequences (testable):**
- A second start event with the same session identity emits no duplicate overview.
- Missing Overview Note, missing configuration, authentication failure, timeout, or malformed response does not block the agent session and produces a bounded diagnostic.
- Overview output clearly identifies itself as Notebook Service context and remains separate from Hindsight recall.
- Before any Overview decision, session start records the session identity, HEAD, bounded tracked-document working-tree status, and per-file content digests. A documentation file already dirty at session start is therefore baseline state, not a change attributed to the session.
- Session start records that baseline even when overview retrieval is disabled or fails.
- Overview Note freshness has one narrow v1 invariant: each Overview write records the ordered authoritative document references it contains and each reference's revision or content identity. After recording the session baseline, session start recomputes those identities; any difference labels the emitted context `PROJECT NOTEBOOK OVERVIEW DRIFT` and supplies the exact audit/migrate next action.
- `[ASSUMPTION: the initial Overview Note limit defaults to 4,000 characters and is configurable within a separate safe ceiling.]`

#### FR-12: True session-close capture

At a supported true session-close boundary, a Managed Hook can enqueue one Session Capture without delaying or breaking agent shutdown.

**Consequences (testable):**
- The foreground hook validates repository and session identity, then deduplicates any existing Capture Receipt for the same session.
- For a new session, the foreground hook admits a queued Capture Receipt only when the resulting unresolved-receipt count and byte usage remain within both configured caps, then returns within the NFR-3 budget.
- When either unresolved-receipt cap prevents admission, SessionEnd refuses the new automatic capture before creating its Capture Receipt, states that this session was not captured, emits a bounded operator-visible retention-pressure diagnostic and finding with the exact `pj notebook capture list` and `pj notebook capture retry` recovery next action, exits successfully, and does not delay or break agent shutdown.
- New automatic capture admission resumes only after recovery of existing unresolved work brings both unresolved-receipt measures below their configured caps.
- Turn-level stop events are not treated as session close.
- Repeated close events for one session enqueue at most one logical Session Capture.
- When no trustworthy session baseline exists, Eligible Document upload is blocked; the Capture Receipt reports `blocked-missing-baseline`, and recovery requires an explicit baseline rather than guessing. A manual `--baseline GIT_REF` authorizes committed-reference comparison only and cannot infer pre-existing uncommitted provenance. Paths with an unknown uncommitted start identity are excluded with an observable reason; if no trustworthy session evidence remains, the receipt stays `blocked-missing-baseline`.

#### FR-13: Eligible Document synchronization

Session Capture can identify and synchronize only Eligible Documents changed between the recorded session baseline and session close.

**Consequences (testable):**
- Eligibility is derived from version-control evidence and explicit policy, not modification time alone.
- Session-close comparison uses the recorded start revision, tracked-document working-tree status, and per-file content identities. A pre-existing dirty document is synchronized only when its end identity proves an additional in-session change; unchanged pre-session dirt is not attributed to the session.
- When recovery has only a manual Git reference, synchronization is limited to changes provable from that committed reference; a pre-existing uncommitted state is never inferred.
- Each synchronized derivative records repository-relative path, source revision or content digest, and capture provenance.
- Unchanged content is a no-op; changed content updates the existing derivative identity rather than creating an unbounded duplicate series.
- Ignored, binary, generated, oversized, and secret-like files are excluded with observable reasons.

#### FR-14: Factual summary with deterministic fallback

Session Capture can create one concise summary from the session diff and available transcript metadata, using a configured low-cost summarizer when allowed and a deterministic fallback otherwise.

**Consequences (testable):**
- The summary separates observed changes, verification performed, and unresolved work; it does not claim deployment or success without evidence.
- The summarizer receives only policy-eligible, bounded, redacted input.
- `[ASSUMPTION: a configured low-cost LLM is normally available, but its absence or failure must never prevent the deterministic fallback.]`
- A stable session identity makes repeated processing a no-op or an update of the same Session Capture, never a second logical summary.
- Capture Receipts transition through queued, processing, succeeded, failed, retry-exhausted, or blocked-missing-baseline. Automatic retry is bounded and stops at `retry-exhausted`. After operator correction, one direct `pj notebook capture retry` invocation authorizes one further attempt on the same `failed` or `retry-exhausted` receipt; failure returns it to `retry-exhausted`, without creating another receipt or starting an automatic loop. A `blocked-missing-baseline` retry additionally requires an explicit Git reference.
- Succeeded receipts expire under a finite configured retention policy; unresolved receipts stay visible until recovered and are never automatically deleted or silently compacted. Receipt dismissal is outside v1 and requires separate future UX and safety design.

### 4.4 Audit and Migration

**Description:** Project Notebook follows PJangler's existing recipe-owned parity model. Audit detects owned Drift; migrate reconciles selected owned findings. Realizes UJ-3.

#### FR-15: Module-scoped audit

`pj notebook audit` reports Project Notebook-owned local and, when authorized, remote Drift without mutating either.

**Consequences (testable):**
- Findings use PJangler's existing pass, fail, warn, and skip semantics and state whether each is fixable.
- Audit covers effective configuration, Notebook Binding identity/state, Companion Notebook existence/name, Overview Note, Project Notebook Skill availability, and Managed Hook projection.
- The `notebook.overview-note` check owns the narrow Overview freshness invariant: audit detects a changed ordered reference/revision identity, and an authorized migration repairs the same Overview Note in place without changing its designated note identifier.
- Audit reports unresolved receipt count and byte usage and emits the same retention-pressure finding and exact recovery next action when either configured admission cap prevents new capture.
- These checks are owned by the Project Notebook recipe and also participate in ordinary `pj audit` and the final audit for `pj init`.
- Local-only audit labels remote checks skipped rather than passing them.
- Audit output identifies ownership and next actions without exposing credentials.

#### FR-16: Reviewable migration plan

`pj notebook migrate` defaults to a no-write Plan and can select only Project Notebook-owned fixes.

**Consequences (testable):**
- The Plan separates local changes from Live Actions and identifies blocked findings.
- It does not invoke global migrate-all or mutate an unrelated recipe.
- Destructive or ambiguous remote actions are blocked pending explicit resolution.
- JSON output carries selected rule identifiers and proposed state transitions.

#### FR-17: Idempotent, preservation-safe migration

Applied migration repairs selected Project Notebook Drift and verifies its postconditions.

**Consequences (testable):**
- Migration preserves all unrelated Project Manifest, Project Registry, Managed Hook, and Notebook Service content.
- A successful migration followed by audit yields no fixable Project Notebook finding.
- A second identical migration returns no-op and changes zero bytes locally and remotely.
- Failure leaves a truthful recoverable state and does not persist a healthy Notebook Binding before remote postconditions hold.

### 4.5 Safe Notebook Service Integration

**Description:** The Project Notebook Module contains the external integration behind one reusable boundary. Current live reconnaissance found Open Notebook v1.14 notes CRUD, password authentication disabled, and search without a notebook filter. `[ASSUMPTION: these service behaviors remain compatible through implementation; the adapter contract, not the version string, is authoritative.]` Realizes UJ-1 through UJ-4.

#### FR-18: Runtime-only endpoint and authentication resolution

The Project Notebook Module resolves the Notebook Service hostname and authentication at runtime from operator configuration.

**Consequences (testable):**
- There is no hardcoded LAN address or interactive-only public endpoint default.
- A missing endpoint or required credential produces a configuration finding before a remote mutation.
- Credential values may come from the environment or the existing secret-manager workflow but are never written to the Project Registry, Project Manifest, logs, or JSON output.
- Authentication status is probed or inferred without printing secrets.

#### FR-19: Bounded service calls and actionable failures

The Project Notebook Module bounds Notebook Service requests and normalizes responses into domain outcomes.

**Consequences (testable):**
- Connect and overall request timeouts are configurable and finite.
- Automatic retries are limited to operations proven safe by method or deduplication identity.
- Authentication failure, not found, conflict, throttling, timeout, unavailable service, and malformed response remain distinguishable.
- Hook callers receive fail-open outcomes while explicit CLI callers receive a nonzero categorized failure.

#### FR-20: Cross-project isolation

Every Notebook Service read or write validates the target against the resolved Notebook Binding.

**Consequences (testable):**
- A global search response is filtered and validated before presentation.
- A note read, update, or delete is rejected when its notebook identity cannot be proven to match the current Companion Notebook.
- Session Capture cannot upload into a binding resolved from a different canonical repository.
- `[ASSUMPTION: MVP runs for one trusted operator against one shared Notebook Service; multi-tenant user authorization is deferred.]`

#### FR-21: Public contract evolution

The Project Notebook Module evolves public CLI and JSON contracts according to PJangler semantic versioning.

**Consequences (testable):**
- JSON responses declare schema version 1.
- Additive fields or commands are backward-compatible minor changes; consumers must ignore unknown fields.
- Removing or changing a documented field, command meaning, or exit category requires a major version unless a compatibility shim preserves the old contract.
- A deprecated command form emits a warning and remains functional for at least one minor release before removal.

## 5. Non-Goals (Explicit)

- Project Notebook does not make the Notebook Service, Hindsight, or generated summaries authoritative over repository source or Git history.
- MVP does not provide cross-project search, fleet-wide bulk migration, notebook analytics, scheduled rollups, or knowledge-graph features.
- MVP does not build or administer the Notebook Service, its authentication gateway, deployment, backups, or user management.
- MVP does not upload all source code, ignored files, generated output, binary assets, secrets, or full unbounded transcripts.
- MVP does not add rich-media ingestion, OCR, audio transcription, arbitrary attachments, or webpage import.
- MVP does not add a GUI or modify the Open Notebook web application.
- MVP does not expose new MCP tools. The Project Notebook Module remains reusable so MCP parity can be added without duplicating core logic.
- MVP does not promise identical lifecycle events on unsupported agent clients or treat per-turn stop hooks as session close.
- MVP does not silently mutate every existing registered project; each repository is audited and migrated through normal explicit PJangler flow.
- MVP does not expose Capture Receipt dismissal or discard unresolved Capture Receipts; that capability requires separate future UX and safety design.

## 6. MVP Scope

### 6.1 In Scope

- One Project Notebook Module registered in PJangler's lifecycle catalog and composed into project initialization.
- Typed Notebook Binding and policy projection through the Project Registry and Project Manifest, including supported registry backends.
- Plan, Apply, Live Action, idempotency, recovery, audit, and migrate behavior for one repository at a time.
- `pj notebook` status, creation, note CRUD, search, overview, audit, migrate, human output, and JSON output.
- One global Project Notebook Skill with references and Managed Hooks integrated through the master fanout.
- Bounded once-per-session Overview Note priming and deduplicated background Session Capture.
- Eligible Document synchronization with provenance, low-cost summary generation, deterministic fallback, and observable exclusion reasons.
- Fake-service, isolated-registry, generated-project, hook, security, and compatibility regression evidence.

### 6.2 Out of Scope for MVP

- New MCP commands; deferred until the CLI and JSON v1 contracts stabilize.
- Cross-project or fleet workflows; deferred because the ownership boundary is one repository to one Companion Notebook.
- Background dashboards and operator UIs; structured status and audit output are sufficient for v1.
- Rich ingestion and answer generation; deferred until note/document lifecycle quality is proven.
- Advanced retry/outbox administration; v1 needs durable capture and bounded retry behavior, not a new job platform.
- Capture Receipt dismissal; v1 preserves unresolved recovery evidence and bounds new admission instead, pending separate UX and safety design.
- Multi-tenant identity, authorization, and compliance controls; deferred beyond the trusted single-operator environment.

## 7. Success Metrics

**Primary**

- **SM-1: Zero-touch pairing within the existing setup target.** In a healthy configured environment, a new project reaches a usable healthy Notebook Binding through one `pj init` Plan/Apply sequence in under two minutes, with no separate raw Notebook Service setup. Validates FR-1 through FR-4.
- **SM-2: Complete new-project coverage.** Every successful live-authorized generated-project regression has exactly one Companion Notebook, one Overview Note, typed local/global configuration, and a passing Project Notebook audit. Validates FR-1 through FR-4, FR-10, and FR-15.
- **SM-3: Contract reliability.** The note CRUD/search contract suite passes 100% of success, empty-result, invalid-input, authentication, timeout, unavailable-service, conflict, cross-project, malformed-response, and JSON-output cases. Validates FR-5 through FR-9 and FR-18 through FR-21.

**Secondary**

- **SM-4: Retry and migration idempotency.** Repeated init, create, Managed Hook delivery, and migration produce zero duplicate logical notebooks or Session Captures; a second migration changes zero bytes. Validates FR-4, FR-10 through FR-17.
- **SM-5: Agent execution safety.** At least 95% of supported hook invocations complete their intended bounded action in test and staged use, and 100% of injected failures and retention-pressure cases leave the agent session usable. At either unresolved-receipt cap, 100% of new automatic capture attempts are refused before receipt creation and emit the exact recovery next action. Validates FR-11, FR-12, FR-14, NFR-2, NFR-4, and NFR-7.
- **SM-6: Secret and isolation safety.** Automated scans and adversarial fixtures find zero raw credential disclosures and zero cross-project note results. Validates FR-9, FR-18, FR-20, NFR-5, and NFR-6.
- **SM-7: Captured knowledge is trustworthy and current.** `[ASSUMPTION: in a staged sample of at least 20 Session Captures, 100% of synchronized Eligible Documents carry complete path/digest/session provenance, at least 95% of factual summary claims trace to diff or verification evidence, and zero unsupported deployment or success claims appear.]` In contract fixtures, 100% of changes to an Overview Note's ordered authoritative references or their recorded revision/content identities surface `PROJECT NOTEBOOK OVERVIEW DRIFT` on the next supported session and through `notebook.overview-note` audit; authorized migration repairs the same note identifier. Validates FR-11, FR-13 through FR-15, and NFR-7.

**Counter-metrics (do not optimize)**

- **SM-C1: Note volume is not success.** Do not maximize uploaded document or summary count; zero duplicates and evidence-bearing provenance matter more than capture volume. Counterbalances SM-2 and SM-4.
- **SM-C2: Prompt volume is not success.** Do not maximize Overview Note size; bounded, once-per-session context and session-start reliability matter more than tokens injected. Counterbalances SM-5.
- **SM-C3: Green local state is not remote proof.** Do not increase pass rate by treating skipped remote checks as healthy. Counterbalances SM-2.
- **SM-C4: Apparent freshness is not factual quality.** Do not rewrite or inflate summaries merely to appear current; unsupported assertions and missing provenance fail SM-7. Counterbalances SM-7.

## 8. Developer CLI and Public Contract

The v1 command surface is intentionally narrow. Exact option names and normalized envelopes are specified in `addendum.md`; the behavioral contract below is stable.

| Command family | Required behavior | Primary FRs |
| --- | --- | --- |
| `pj notebook status` | Resolve repository and report effective Notebook Binding health | FR-3, FR-5 |
| `pj notebook create` | Idempotently create or link the Companion Notebook behind a Live Action gate | FR-1, FR-2, FR-4, FR-6 |
| `pj notebook list notes` | List current Companion Notebook notes with pagination | FR-7, FR-9 |
| `pj notebook add note` | Create a note from bounded text or a file | FR-7, FR-9 |
| `pj notebook get note <id>` | Return one binding-validated note | FR-7, FR-20 |
| `pj notebook update note <id>` | Replace allowed note fields without changing identity | FR-7, FR-20 |
| `pj notebook delete note <id>` | Confirm and delete one binding-validated note | FR-7, FR-20 |
| `pj notebook search notes <query>` | Return only current Companion Notebook results | FR-8, FR-20 |
| `pj notebook overview` | Read or replace the Overview Note | FR-6, FR-11 |
| `pj notebook capture list/retry` | Inspect Capture Receipts, requeue the same failed or retry-exhausted receipt for one operator-authorized attempt, recover missing-baseline work with an explicit Git reference, and relieve retention pressure; v1 has no dismissal action | FR-5, FR-12 through FR-14 |
| `pj notebook audit` | Run only Project Notebook-owned checks | FR-15 |
| `pj notebook migrate` | Plan or apply only Project Notebook-owned fixes | FR-16, FR-17 |
| Managed hook entrypoints | Invoke session-start and session-close behavior for fanout adapters | FR-10 through FR-14 |

All public data commands support `--json`. Mutation commands support explicit non-interactive confirmation where needed. Target repository selection follows existing PJangler conventions. JSON envelopes expose schema version, command, success, repository and Notebook Binding identity, data, categorized error, and next actions without emitting ANSI or credentials.

### 8.1 Remote Authorization Matrix

| Operation class | Authorization | No-authorization behavior |
| --- | --- | --- |
| Explicit read-only commands (`status`, list/get/search, overview read, remote audit) | Invoking the command with effective Project Notebook enablement authorizes the read; `--local-only` forbids contact | Local result or remote check marked `skip` |
| Direct note mutation (`add`, `update`, `delete`, overview replace) | Invoking the specific mutation authorizes that mutation; destructive delete also requires confirmation or `--yes` | No mutation |
| Composite init, `create`, or migrate remote mutation | `--live` on the Plan/Apply operation | Local work may apply; Notebook Binding remains planned and remote findings are `skip` |
| Session-start overview read | Durable `session_start_enabled` Project Manifest policy, displayed in the init/migrate Plan | Hook returns without remote contact |
| Session-close Session Capture writes | Durable `session_capture_enabled` Project Manifest policy, displayed in the init/migrate Plan | Hook records no remote work and returns |

New-project Apply may write the two Managed Hook opt-ins only after showing their values in the Plan. Either policy can be disabled per repository without uninstalling the Project Notebook Skill.

## 9. Cross-Cutting Non-Functional Requirements

- **NFR-1 — Safety:** Dry-run performs zero local or remote writes. Live Actions require explicit authorization. Destructive ambiguity blocks rather than guesses.
- **NFR-2 — Reliability:** Managed Hooks fail open; a Notebook Service or summarizer failure cannot prevent an agent session from starting or closing. Explicit CLI failures remain nonzero and actionable.
- **NFR-3 — Foreground performance:** `[ASSUMPTION: on the target workstation, session-start priming completes or fails open within two seconds, and session-close foreground enqueue returns within 250 milliseconds at p95.]` Network-independent CLI planning should remain within PJangler's existing interactive response expectations.
- **NFR-4 — Bounded data:** Every prompt injection, excerpt, diff input, response body, file upload, and diagnostic has a configured size ceiling. Succeeded receipt retention has a finite policy, and unresolved receipt storage has finite configured count and byte admission caps. Oversized content is rejected or safely truncated; a new automatic capture that would breach either receipt cap is refused before receipt creation. Both outcomes are observable and include an exact recovery action.
- **NFR-5 — Security:** No raw credential is accepted into tracked or persistent PJangler configuration, logs, exceptions, fixtures, hook payloads, JSON output, or Notebook Service note content. Secret-like Eligible Documents are excluded before summarization or upload.
- **NFR-6 — Isolation:** Every read, search result, mutation, hook action, and migration is constrained to the canonical repository's Notebook Binding.
- **NFR-7 — Observability:** Human and JSON output identify operation, binding, outcome, retryability, exclusions, and next actions. Background Session Capture records a receipt without storing secret-bearing payloads in the repository. Status and audit expose unresolved count/byte usage and a bounded retention-pressure finding until recovery restores admission.
- **NFR-8 — Compatibility:** Implementation supports PJangler's current Node.js 20+ TypeScript/ESM runtime, thin interfaces, singleton recipe registry, plan/apply transaction, supported registries, and existing hook fanout.
- **NFR-9 — Preservation and idempotency:** Reconciliation preserves unrelated configuration and content. The same logical action, session, document revision, or migration can be retried without duplicate durable outcomes.
- **NFR-10 — Testability:** All acceptance behavior can run against an isolated Project Registry and local fake Notebook Service. Automated tests never require or mutate the operator's live registry or production notebook data.

## 10. Constraints and Guardrails

- Live code is authoritative when the February product brief or generated July documentation conflicts with current PJangler architecture.
- The Project Notebook Module uses the singleton recipe registry and owns its checks; CLI and hooks remain thin adapters.
- The Project Registry owns global defaults and Notebook Bindings. The Project Manifest owns repository policy overrides. The Notebook Service owns note content. Git owns authoritative repository documents.
- Project Registry persistence occurs only after the local/remote transaction has a truthful recoverable Notebook Binding state.
- Service configuration uses hostnames and current routing; no LAN address is hardcoded.
- Managed Hooks participate through the master fanout and preserve foreign hook configuration. They do not re-inject shared per-user client configuration from each repository.
- Session Capture processes documentation only by default and must not convert a working tree diff into an indiscriminate repository export.
- UX design is not required for this CLI/hooks-only MVP. Human-readable CLI quality and predictable machine contracts are required.

## 11. Risks and Mitigations

| Risk | Product impact | Required mitigation |
| --- | --- | --- |
| Upstream search is global | Results could leak another project's notes | Enforce Notebook Binding validation before returning any result (FR-8, FR-20) |
| Remote create times out after succeeding | Retry could create a duplicate Companion Notebook | Reconcile deterministic identity evidence before remote create (FR-4) |
| Client exposes only turn-level stop | Session Capture could run many times or too early | Support only true session-close adapters and deduplicate by session identity (FR-12) |
| A tracked document is already dirty at session start | Session Capture could misattribute unrelated pre-existing work | Record bounded start status and per-file content identities before any Overview decision; compare those identities at close and never infer uncommitted provenance from a manual Git reference (FR-11 through FR-13) |
| Background processing fails silently | Documentation or Session Capture could be lost | Durable receipt, bounded retry, status visibility, and deterministic fallback (FR-12 through FR-14, NFR-7) |
| Unresolved receipts reach their count or byte cap | Runtime state could grow without bound, or recovery evidence could be silently discarded | Preserve every unresolved receipt, refuse new automatic capture before receipt creation, fail open with a bounded retention-pressure finding and exact list/retry recovery action, and resume only below both caps (FR-5, FR-12, FR-14, NFR-4, NFR-7) |
| Registry/manifest projection drops unknown fields | Migration could destroy unrelated project state | Typed round-trip plus preservation tests (FR-3, FR-17) |
| Diff or document contains secrets | Summary or upload could exfiltrate sensitive material | Eligibility filters, size bounds, redaction, runtime-only authentication, and secret scans (FR-13, FR-14, NFR-5) |
| Overview grows without bound | Session-start context becomes slow and noisy | Stable Overview Note, once-per-session fetch, configured ceiling, truncation signal (FR-11, NFR-4) |

## 12. Open Questions

None. MCP parity and richer Overview Note generation are explicit post-MVP scope, not unresolved MVP decisions. The MVP client matrix is non-empty because Claude Code `SessionStart` and `SessionEnd` are required; other clients are supported only after their lifecycle boundaries pass contract tests.

## 13. Assumptions Index

- **A-1 (§4.3, FR-11):** The initial Overview Note limit defaults to 4,000 characters and is configurable within a separate safe ceiling.
- **A-2 (§7, SM-7):** Capture-quality acceptance samples at least 20 staged sessions and requires complete provenance plus at least 95% factual claim support.
- **A-3 (§4.3, FR-14):** A configured low-cost LLM is normally available; deterministic fallback is mandatory when it is not.
- **A-4 (§4.5):** The verified Open Notebook v1.14 behavior remains compatible through implementation; adapter behavior is authoritative if versions drift.
- **A-5 (§4.5, FR-20):** MVP serves one trusted operator through one shared Notebook Service; multi-tenant authorization is deferred.
- **A-6 (§9, NFR-3):** Initial p95 performance budgets are two seconds for session-start priming and 250 milliseconds for session-close foreground enqueue.
