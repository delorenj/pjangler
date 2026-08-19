---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-pjangler-project-notebook-2026-08-19/prd.md
  - _bmad-output/planning-artifacts/prds/prd-pjangler-project-notebook-2026-08-19/addendum.md
  - _bmad-output/specs/spec-project-notebook/SPEC.md
  - _bmad-output/specs/spec-project-notebook/acceptance-contract.md
  - _bmad-output/planning-artifacts/architecture/architecture-project-notebook-2026-08-19/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/architecture/architecture-project-notebook-2026-08-19/reviews/review-resolution.md
  - _bmad-output/planning-artifacts/architecture/architecture-project-notebook-2026-08-19/reviews/review-update-retention-resolution.md
uxDesign: not-applicable
project: pjangler
ticket: PJAN-77
status: final
---

# pjangler - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for PJAN-77 Project Notebook, decomposing the finalized PRD, SPEC, acceptance contract, and Architecture Spine into implementation-sized, dependency-safe work. UX design is not applicable because the feature surface is CLI, lifecycle, hooks, and machine contracts.

## Requirements Inventory

### Functional Requirements

- **FR-1 — Deterministic one-to-one binding:** PJangler can derive, persist, and resolve exactly one stable Notebook Binding for one canonical repository identity; display-name drift or rename never creates a second binding, and two projects cannot claim the same notebook ID.
- **FR-2 — Notebook-aware project initialization:** `pj init` includes notebook configuration, binding, skill, hooks, Overview, and remote work in a zero-write Plan; Apply executes only authorized work, preserves truthful recovery state, and persists the Registry only after remote postconditions are known.
- **FR-3 — Canonical configuration resolution:** Resolve global defaults and authoritative binding from the Project Registry, verify the Manifest's read-only binding projection, overlay Manifest policy, support YAML and PostgreSQL stores, preserve unknown fields, reject persistent credentials, and report value provenance safely.
- **FR-4 — Idempotent creation and recovery:** Re-init and explicit create reconcile deterministic identity and durable operation evidence before mutation, converge after interruption or ambiguous responses without duplicates, and repair a display name without changing remote identity.
- **FR-5 — Repository context and status:** Resolve an explicit or current registered repository and report structured local/observed binding health plus the shared capture-admission summary: nullable exact unresolved totals, numeric lower bounds, integrity evidence, finite caps, receiptless state, and active refusal history. Local-only status performs no remote contact; `retention-pressure` reflects only the current predicate, while a recovered marker is informational `capture-refused-history`.
- **FR-6 — Companion Notebook creation and overview management:** Idempotently create or link the Companion Notebook, create one stable Overview Note, return conflicts for ambiguity, bound reads, and replace Overview content in place without changing its note ID.
- **FR-7 — Note CRUD:** List, add, get, update, and explicitly confirmed delete are deterministic and notebook-scoped; stable note identity is preserved, foreign IDs are rejected, and generic deletion cannot delete the Overview Note.
- **FR-8 — Notebook-scoped search:** Search only a complete scoped note list for the current Companion Notebook and return bounded, deterministic results or a successful empty collection without leaking other projects.
- **FR-9 — Stable human and machine contracts:** Every public notebook operation has concise human output and an exact JSON-v1 contract with pure stdout, categorized symbolic errors/exits, safe diagnostics, and no credential disclosure.
- **FR-10 — Global skill and project-scoped hook projection:** Install one canonical Project Notebook skill and idempotently project its Managed Hooks through the master fanout while preserving every foreign record, order, condition, comment, and extra key; only true supported session boundaries qualify.
- **FR-11 — Once-per-session overview priming:** At supported SessionStart, establish the repository/session baseline first, emit the bounded Overview at most once with separate Notebook/Hindsight labeling and explicit drift/staleness, and fail open on every integration problem.
- **FR-12 — True session-close capture:** At true SessionEnd and under one project lock, validate exact session identity, deduplicate an existing same-session receipt, apply the strict-before/equality-expired receiptless-baseline boundary, serialize the real queued candidate, prove state integrity, and admit only when prospective unresolved count and bytes fit both caps. A cap refusal creates no receipt or slow work, records one bounded hashed replay marker, states that the session was not captured, and fails open within budget; missing trustworthy provenance never gets guessed.
- **FR-13 — Eligible Document synchronization:** Select changed version-controlled documentation from baseline-to-close Git evidence, exclude unsafe/ineligible content observably, preserve path/revision/digest/session provenance, and update stable derivatives rather than duplicating them.
- **FR-14 — Factual summary with deterministic fallback:** Produce one evidence-grounded, bounded session summary with an optional low-cost summarizer or mandatory deterministic fallback, prohibit unsupported success/deployment claims, and deduplicate by session identity. Receipt recovery reuses the same receipt for exactly one operator-authorized attempt with no automatic loop; only succeeded receipts expire, unresolved receipts remain visible indefinitely, and v1 has no dismissal.
- **FR-15 — Module-scoped audit:** Audit Project Notebook-owned configuration, binding, remote notebook, exact OverviewDescriptor freshness, skill, hooks, and captures without mutation; use pass/fail/warn/skip semantics, make remote skips explicit, share status admission/integrity semantics, preserve suspect or unresolved state, and participate in focused, ordinary, and final audits.
- **FR-16 — Reviewable migration plan:** `pj notebook migrate` defaults to a pure Plan, selects only public Project Notebook rule IDs, separates local work from Live Actions, identifies blocked ambiguity, and exposes rule/state transitions in JSON.
- **FR-17 — Idempotent, preservation-safe migration:** Apply selected owned repairs, preserve unrelated Manifest/Registry/hook/service content, verify postconditions, retain truthful recovery on failure, and make the second identical migration a zero-byte/zero-remote no-op.
- **FR-18 — Runtime-only endpoint and authentication resolution:** Resolve an explicit hostname/loopback endpoint and runtime-only authentication, reject unsafe or missing configuration before mutation, and never persist or emit secret values or hardcoded LAN addresses.
- **FR-19 — Bounded service calls and actionable failures:** Bound every service call and payload, retry only proven-safe logical operations, normalize auth/not-found/conflict/throttle/timeout/unavailable/protocol outcomes, fail hooks open, and return categorized CLI failures.
- **FR-20 — Cross-project isolation:** Prove every read, result, mutation, hook action, capture, and migration belongs to the resolved binding; never use an unscoped object lookup or return unproven global-search data.
- **FR-21 — Public contract evolution:** Declare JSON schema version 1, treat additive changes as compatible, require a major version or shim for breaking changes, and keep deprecated command forms functional for at least one minor release.

### NonFunctional Requirements

- **NFR-1 — Safety:** Dry-run performs zero local or remote writes; Live Actions require explicit authorization; ambiguity blocks instead of guessing.
- **NFR-2 — Reliability:** Managed Hooks fail open and never prevent start/close; explicit CLI failures remain nonzero, categorized, and actionable.
- **NFR-3 — Foreground performance:** SessionStart completes or fails open within two seconds p95 and SessionEnd enqueue returns within 250 milliseconds p95 on the target workstation; planning remains interactive.
- **NFR-4 — Bounded data:** Prompt injection, excerpts, diffs, stdin, uploads, responses, lists, diagnostics, and successful-receipt retention have finite configured ceilings. Unresolved storage uses finite prospective count/byte admission gates rather than deletion or compaction; receiptless state has a separate finite baseline-created grace.
- **NFR-5 — Security:** Raw credentials never enter tracked/persistent config, logs, errors, fixtures, payloads, JSON, receipts, or notebook content; secret-like documents are excluded before summarization or upload.
- **NFR-6 — Isolation:** Every operation is constrained to the canonical repository's resolved Notebook Binding.
- **NFR-7 — Observability:** Human/JSON output exposes safe operation, binding, outcome, retryability, exclusions, next actions, nullable exact/lower-bound admission evidence, current `retention-pressure`, informational `capture-refused-history`, and precedence-taking `state-integrity` without repository runtime state, raw session IDs, or secret-bearing payloads.
- **NFR-8 — Compatibility:** Support Node.js 20+ TypeScript/ESM, thin adapters, the singleton recipe registry, current plan/apply transaction, YAML and PostgreSQL registries, and the existing global hook fanout.
- **NFR-9 — Preservation and idempotency:** Preserve unrelated state, every unresolved receipt, every suspect entry, and every referenced baseline; make repeated logical init, hook delivery, refusal replay, note reconciliation, capture, document revision, and migration converge without duplicate durable outcomes.
- **NFR-10 — Testability:** Run all behavior against isolated HOME/XDG/Registry and a fake Notebook Service without reading or mutating production operator data.

### Additional Requirements

- **AR-1 — Hexagonal ownership:** `src/notebook/` owns Project Notebook domain/application behavior; Commander, `NotebookRecipe`, hooks, worker, and future transports are thin inbound adapters, while Registry, Manifest, Git, state, summarizer, Open Notebook, and projector are outbound ports.
- **AR-2 — Singleton lifecycle composition:** Construct one `NotebookRecipe` immediately before `ProjectRecipe`, declare the `notebook` dependency, and use a dedicated non-recursive `runNotebookLifecycle(plan, mode, context)` seam for create and sync/re-init.
- **AR-3 — Unified external transaction:** ProjectRecipe builds one fixed-order external tail—ticket provider, Notebook, then Hermes—stops at the first failed/blocked effect, latches `externalDispatchStarted` before any request, and forbids fresh-target deletion after that latch.
- **AR-4 — Registry-only finalizer:** Withhold all Registry writes until one finalizer runs exactly once as the final mutation on both success and failure, persisting accumulated linked results or truthful planned/blocked recovery; no remote object is automatically deleted.
- **AR-5 — Four authorities:** Git owns authoritative documents, Registry owns global defaults/binding, Manifest owns policy and a read-only binding mirror, Open Notebook owns note bodies, and XDG state owns baselines/journals/receipts.
- **AR-6 — Lossless YAML:** Use YAML CST/path-aware mutation so bytes outside owned changed node spans—including comments, scalar style, order, and unknown nodes—remain identical; honor `PJ_PROJECT_REGISTRY`.
- **AR-7 — Additive PostgreSQL support:** Add notebook and extension JSONB storage, singleton registry settings, and a partial unique nonempty notebook-ID index; preserve unknown fields semantically, leave legacy rows intact, and make dual-write failure observable without YAML data loss.
- **AR-8 — Manifest preservation:** Parse the original JSON and replace only `notebook.binding` and explicitly changed policy keys; retain all unknown sibling and descendant fields.
- **AR-9 — Binding marker:** Use canonical persisted project slug as identity and exact notebook description marker `pjangler.project.v1:<slug>`; never adopt by nonunique display name.
- **AR-10 — RemoteMutationJournalV1:** Every notebook or note create advances an atomic, fsynced XDG journal through `prepared`, `possibly-dispatched`, `reconciled`, and `committed`, storing only safe identity/digest metadata.
- **AR-11 — Ambiguous-create discipline:** Only transport proof that no bytes left permits a safe retry reset; an unresolved possibly-dispatched operation reconciles zero/one/many, creates only from a proved safe zero, adopts one, conflicts on many, and never blind-POSTs again.
- **AR-12 — Bounded service boundary:** Validate all remote responses with typed schemas; impose connect/overall timeouts, abort propagation, request/response ceilings, finite safe retries, and redirect-origin rejection.
- **AR-13 — Safe URL/auth contract:** Permit configured HTTPS hostnames or HTTP loopback only; reject userinfo, query/fragment, unsafe schemes, numeric non-loopback hosts, and cross-origin redirects; store only an authentication environment-variable name and read its value at call time.
- **AR-14 — Scoped membership proof:** List notes with `notebook_id` before get/update/delete and expose no unscoped access methods; distinguish `CROSS_PROJECT` only when other binding ownership is already proven and otherwise return `NOT_FOUND` without probing.
- **AR-15 — Local deterministic search:** Search only a complete scoped list; normalize NFKC plus Unicode lowercase, tokenize letters/numbers, require every distinct query token, score title matches at 10x body matches, and sort by score, update time, then ID. No upstream global/vector fallback is allowed in v1.
- **AR-16 — Managed note envelope:** Prefix PJangler-created note bodies with a bounded base64url canonical-JSON `PjanglerNoteEnvelopeV1` marker and exact kinds `overview`, `user-note`, `document`, or `session-capture`; strip it from human excerpts.
- **AR-17 — Stable note identities:** Address Overview by stored ID; derive document/session logical IDs deterministically; use a prepared-journal UUID for each user-note operation; preserve envelopes on managed updates, leave manual notes unmarked, and conflict on duplicate logical IDs.
- **AR-18 — Exact CLI surface:** Implement only the accepted `status`, `create`, note list/add/get/update/delete/search, `overview`, capture list/retry, `audit`, and `migrate` grammar plus internal hook/worker entrypoints; payload uses stdin or a contained mode-0600 XDG file, never user/secret argv.
- **AR-19 — JSON v1 schemas:** Emit one UTF-8 schema-v1 envelope plus newline, validate exact per-command `data` schemas before serialization, separate persisted `binding_state` from nullable observed `health`, place safe diagnostics on stderr, and keep stdout ANSI/progress-free.
- **AR-20 — Stable exit contract:** Use exits 0 success/skip/fail-open, 2 invalid input, 3 configuration/auth, 4 object/conflict/isolation/drift, 5 retryable service, and 6 protocol/internal; enforce input→config/auth→scoped service→membership→mutation error precedence.
- **AR-21 — Immutable observation:** Async command paths prepare bounded credential-free `NotebookObservation`; synchronous checks never hide network calls, fresh init can audit provisional plan state, ordinary audit skips remote without an observation, and focused audit/migrate re-observe explicitly.
- **AR-22 — Seven owned rules:** Keep public IDs stable: `notebook.configuration`, `notebook.binding`, `notebook.remote-notebook`, `notebook.overview-note`, `notebook.skill-installed`, `notebook.hooks-projected`, and `notebook.capture-receipts`; migrate selects only these and verifies postconditions.
- **AR-23 — Sole skill source:** `/home/delorenj/code/skillex/all-skills/project-notebook/` is the only hand-edited skill source; its `SKILL.md`, agent metadata, hook master/wrappers, projector, references, and tests are the canonical distribution unit.
- **AR-24 — Digest-verified packaged skill:** Build/prepack rejects unsafe files and symlinks, exports the skill with `export-manifest.json` and `SHA256SUMS`, resolves validated source precedence, installs an immutable version-digest payload under XDG data, and replaces only an owned matching global skill link. A packed CLI must work without the developer Skillex checkout.
- **AR-25 — Surgical global projector:** Own only commands beginning exactly `PJ_HOOK_OWNER=project-notebook.v1 ` plus the recognized event wrapper; update the earliest owned hook, remove only later owned duplicates, preserve all foreign groups/siblings/order/conditions/comments/extra keys, and make the second projection zero bytes.
- **AR-26 — Hook coexistence:** Install only Claude `SessionStart` and `SessionEnd`, never `Stop`; prove a changing Bloodbank sync preserves parsed Project Notebook objects and relative order, a second Bloodbank sync changes zero bytes, and reverse Project Notebook reinstall preserves Bloodbank entries.
- **AR-27 — Hook installation safety:** Projector check is pure; install validates/locks/re-reads, keeps a permission-restricted XDG recovery snapshot, atomically replaces only changed semantic owned state, and uninstall removes only marked entries/containers made empty by removal.
- **AR-28 — OverviewDescriptorV1:** Compile identity, visible purpose or exact placeholder, ordered contained authoritative references, Git revision/content digests, missing-reference facts, and policy version; compare after baseline, warn `PROJECT NOTEBOOK OVERVIEW DRIFT`, label stale/truncated content, and update the same note ID in live migration.
- **AR-29 — Exact session identity:** Derive lowercase-hex SHA-256 from exact UTF-8 `pjangler-session-v1`, NUL, project slug, NUL, client, NUL, nonempty client session ID; persist no raw client session ID.
- **AR-30 — Baseline-first SessionStart:** Exclusive-create a complete/incomplete baseline before remote access whenever start or capture policy is enabled; never overwrite it on resume; both policies off does nothing, and missing/incomplete identity/evidence fails open but blocks capture.
- **AR-31 — Once-only Overview claim:** Derive an atomic exclusive claim from the session key, emit at most one Overview, label Project Notebook separately from Hindsight, use a code-point-safe 4,000-character default ceiling, and always exit zero on hook integration failures.
- **AR-32 — Restricted XDG state:** Store baselines, claims, refusal markers, admission locks, receipts, leases, journals, and ownership below `$XDG_STATE_HOME/pjangler/notebook/v1` with directories 0700, files 0600, no-follow containment, same-directory atomic writes/fsync, and no credentials or bodies. Only succeeded receipts have age-based expiry; unreferenced receiptless baseline/claim/refusal state uses its own finite baseline-created grace.
- **AR-33 — SessionEnd durability and admission boundary:** Derive deterministic receipt/capture IDs from exact prefixed UTF-8 hashes of the session key and, under one bounded project lock, order same-receipt dedupe, equality-expired receiptless cleanup, real queued-candidate serialization, state-integrity proof, and prospective count/byte admission. Exclusive-create/fsync an admitted receipt before spawn; refusal performs no network, Git diff, upload, or summarizer work.
- **AR-34 — Safe detached worker:** Spawn with `process.execPath`, argv array, `shell:false`, ignored stdio, detached/unref, and receipt ID only; claim via compare-and-swap lease, recover expired work within finite budget, and converge through idempotent remote journals.
- **AR-35 — Receipt state and retry contract:** Implement exactly `queued`, `processing`, `succeeded`, `failed`, `retry-exhausted`, and `blocked-missing-baseline`. Only succeeded receipts expire; unresolved receipts are never automatically deleted, silently compacted, or dismissed. One direct retry reuses one failed/retry-exhausted receipt for exactly one operator-origin attempt whose failure returns directly to `retry-exhausted`; blocked-missing-baseline additionally requires an explicit validated committed Git reference.
- **AR-36 — Git evidence and eligibility:** Use NUL-delimited non-shell Git evidence from recorded baseline to close; normalize physical repo-relative paths and exclude ignored/untracked-by-default/generated/binary/symlink escape/traversal/submodule/device/FIFO/socket/oversized/secret-like/unchanged content before prompts or service calls.
- **AR-37 — Capture provenance and idempotency:** Derivative notes record repository identity, relative path, revision/digest, session, capture time, and policy; unchanged content no-ops, changed documents update stable note identity, and a session retry updates/no-ops one capture note.
- **AR-38 — Summarizer boundary:** Parse trusted global config into fixed executable/argv, allowlist environment, send bounded redacted evidence on stdin with `shell:false`, require structured evidence citations, and reject unsupported deployment/success claims.
- **AR-39 — Deterministic fallback:** On absent/timed-out/error/invalid summarizer output, produce fixed sections for eligible documents, other path names, verification evidence, unresolved/uncommitted work, and explicit insufficient evidence.
- **AR-40 — Literal authorization:** Direct reads authorize only that read unless local-only; direct mutations authorize only the chosen mutation; delete also confirms; init/create/migrate remote effects require `--live`; hooks require planned durable Manifest policy, and explicit disable wins.
- **AR-41 — Incremental rollout:** Land schema/adapter, lifecycle transaction, CLI, one isolated/live canary, packaged skill/hooks, start priming, receipt-only close, then capture worker and opt-in migrations; never auto-enable fleet-wide.
- **AR-42 — Non-destructive rollback:** Disable capture, then priming, then project policy; remove only owned hooks/projections; preserve Registry/Manifest bindings, remote notebooks/notes, Git content, additive database columns, unresolved receipts, referenced baselines, and suspect entries. Rollback is never a hidden dismissal path.
- **AR-43 — Isolated release evidence:** Require unit/domain, YAML and scratch-PG, fake-service, lifecycle failure injection, exact CLI/JSON, packed Node 20+, hooks, Bloodbank coexistence, capture/restart, both prospective cap boundaries, refusal replay/prune races, state-integrity corruption, pre-dirty/manual-ref limits, eligibility/security, and generated-project suites without production data.
- **AR-44 — Quantified release gates:** Contract fixtures pass 100%; retries/migrations produce zero duplicate logical outcomes; every cap/integrity refusal creates no receipt and invokes no slow-work port; scans find zero credential disclosure/cross-project results; fresh healthy generated project completes under two minutes; hook p95 budgets pass; and staged quality evidence covers at least 20 captures with complete provenance, at least 95% supported factual claims, and zero unsupported deployment/success claims.
- **AR-45 — Deferred boundaries:** Do not add MCP commands, unsupported hook clients, semantic/vector search, Open Notebook Sources/rich ingestion, multi-tenant auth, generalized outbox/admin UI, fleet bulk migration/default-on, destructive remote deletion, ambiguity force-clear, receipt dismissal, or operational down migration in v1.
- **AR-46 — Receiptless replay and refusal marker:** `receiptless_session_retention_seconds` is measured from immutable baseline `created_at`; replay is valid strictly before expiry and equality is expired. A refused real candidate atomically creates or replaces one bounded `RetentionRefusalV1` keyed by the hashed session key without extending grace; admission fsync removes it, shadowing receipt dedupe ignores/removes it, and only elapsed unreferenced baseline/claim/refusal state may be pruned.
- **AR-47 — Shared admission and integrity observation:** Hook, status, and `notebook.capture-receipts` share nullable exact totals, numeric lower bounds, unmeasurable count, safe entry evidence, finite caps, receiptless counts, and active refusal markers. `state-integrity` preserves suspect entries and precedes cap evaluation; `retention-pressure` is emitted only while the current exact predicate fails, while a now-fitting marker remains non-finding `capture-refused-history` until replay/removal or grace cleanup.

### UX Design Requirements

Not applicable. PJAN-77 introduces no graphical interface; human-readable CLI behavior and machine-readable JSON/error contracts are captured by FR-5 through FR-9, FR-21, AR-18 through AR-20, and their stories.

### FR Coverage Map

- **FR-1:** Epic 1 — Pair each repository with one stable Companion Notebook.
- **FR-2:** Epic 1 — Include notebook work in truthful `pj init` Plan/Apply.
- **FR-3:** Epic 1 — Resolve and preserve authoritative Registry/Manifest configuration.
- **FR-4:** Epic 1 — Retry and recover remote creation without duplicate notebooks.
- **FR-5:** Epic 2 — Resolve repository context and inspect binding plus capture-admission/integrity status.
- **FR-6:** Epic 2 — Create/link and manage the stable Overview Note.
- **FR-7:** Epic 2 — Perform binding-validated note CRUD.
- **FR-8:** Epic 2 — Search only the current Companion Notebook.
- **FR-9:** Epic 2 — Consume stable human, JSON-v1, and exit contracts.
- **FR-10:** Epic 4 — Install one canonical skill and coexistence-safe Managed Hooks.
- **FR-11:** Epic 4 — Prime each supported session once with bounded, drift-labeled Overview context.
- **FR-12:** Epic 5 — Deduplicate, validate, prospectively admit, refuse/replay, or durably enqueue one capture at a true session close.
- **FR-13:** Epic 5 — Synchronize only safe Git-evidenced changed documentation with provenance.
- **FR-14:** Epic 5 — Produce one evidence-grounded capture with deterministic fallback and same-receipt recovery without dismissal.
- **FR-15:** Epic 3 — Audit only Project Notebook-owned local and observed remote state, including capture admission and integrity.
- **FR-16:** Epic 3 — Review a selective, no-write Project Notebook migration plan.
- **FR-17:** Epic 3 — Apply preservation-safe repairs and prove second-run idempotency.
- **FR-18:** Epic 1 — Resolve safe endpoint/authentication at runtime only.
- **FR-19:** Epic 1 — Use a bounded typed service boundary with actionable outcomes.
- **FR-20:** Epic 2 — Prove repository binding membership for every note operation and result.
- **FR-21:** Epic 2 — Evolve the public CLI/JSON contract compatibly.

## Epic List

### Epic 1: Bootstrap a Trustworthy Companion Notebook

Jarad can run the normal PJangler project lifecycle and receive exactly one recoverable, correctly bound Companion Notebook without separate raw-service setup or configuration surgery.

**FRs covered:** FR-1, FR-2, FR-3, FR-4, FR-18, FR-19

**Implementation boundary:** Delivers lossless Registry/Manifest support, the typed and bounded service adapter, `RemoteMutationJournalV1`, `NotebookRecipe`, and the single Registry-last external transaction/finalizer. It is independently usable through `pj init` and produces truthful planned/linked outcomes before any later note-management or hook capability exists.

### Epic 2: Manage and Find Repository Knowledge Safely

Jarad and scripts can inspect the current binding, manage its Overview and notes, and search the repository's knowledge through stable human and JSON-v1 commands without leaking another project's content.

**FRs covered:** FR-5, FR-6, FR-7, FR-8, FR-9, FR-20, FR-21

**Implementation boundary:** Builds on the bound notebook from Epic 1 and completes the public CLI surface, membership proof, note envelopes/identities, deterministic scoped list/search, capture-admission status schema, JSON schemas, error precedence, and exit compatibility. It delivers complete direct notebook operations without requiring audit migration or agent hooks.

### Epic 3: Detect and Repair Project Notebook Drift

Jarad can audit an existing or newly initialized repository, review only Project Notebook-owned repairs, apply authorized local/live fixes without disturbing foreign state, and prove the second run is a no-op.

**FRs covered:** FR-15, FR-16, FR-17

**Implementation boundary:** Uses the lifecycle and CLI contracts from Epics 1–2 to deliver the seven stable owned rules, immutable observations, read-only capture-admission/integrity findings, local-only skips, selective migrations, preservation proofs, and postcondition audits. It does not require hook delivery or a running capture worker.

### Epic 4: Start Agent Sessions with Bounded Project Context

Jarad can install one canonical globally distributed skill whose coexistence-safe Claude SessionStart hook establishes a trustworthy baseline and emits the current repository's bounded Overview at most once, alongside rather than instead of Hindsight.

**FRs covered:** FR-10, FR-11

**Implementation boundary:** Delivers Skillex canonical source, digest-verified packed export and immutable runtime install, the surgical global projector, Bloodbank coexistence, true-boundary support matrix, restricted XDG state, exact session identity, Overview descriptor/drift proof, and fail-open performance evidence. It is useful with priming alone and does not require SessionEnd capture.

### Epic 5: Close Agent Sessions with Durable Evidence

Jarad can end a supported agent session without delay and either obtain one recoverable, evidence-grounded Session Capture or receive truthful bounded refusal/integrity evidence that preserves safe replay and recovery without deleting unresolved work.

**FRs covered:** FR-12, FR-13, FR-14

**Implementation boundary:** Builds on Epic 4's baseline/session identity and completes locked same-session dedupe, receiptless grace, real-candidate prospective admission, refusal-marker replay, integrity precedence, admitted receipt enqueue, leased detached worker, Git eligibility/security filters, document and capture idempotency, exact one-attempt retry, succeeded-only expiry, unresolved preservation, and staged quality evidence.

## Epic 1: Bootstrap a Trustworthy Companion Notebook

Jarad can run the normal PJangler project lifecycle and receive exactly one recoverable, correctly bound Companion Notebook without separate raw-service setup or configuration surgery.

### Story 1.1: Resolve and Preserve a Planned Notebook Binding

As a PJangler operator,
I want notebook defaults, binding state, and repository policy resolved from their proper authorities,
So that project bootstrap starts from a trustworthy, inspectable, and losslessly persisted configuration.

**Requirements:** FR-1, FR-3, FR-18; NFR-1, NFR-5, NFR-8, NFR-9, NFR-10; AR-4, AR-5, AR-6, AR-8, AR-13, AR-40.

**Acceptance Criteria:**

1. **Given** an isolated YAML Project Registry and registered repository with a `.project.json`
   **When** the Project Notebook configuration is resolved
   **Then** built-in safe defaults, global Registry defaults, Manifest policy, and explicit invocation options apply in that order
   **And** an explicit disable wins for hook behavior while service URL and authentication never come from the Manifest.

2. **Given** Registry binding fields and a Manifest binding projection
   **When** their values differ
   **Then** Registry `state`, `notebook_id`, `notebook_name`, and `overview_note_id` remain authoritative
   **And** the mismatch is returned as Drift rather than silently copying Manifest values into the Registry.

3. **Given** unknown top-level, project, notebook-descendant, comment, key-order, and scalar-style content in YAML plus unknown Manifest fields
   **When** an owned notebook value is applied
   **Then** only the exact owned path changes
   **And** bytes outside the changed YAML node spans and every unrelated JSON sibling/descendant remain identical.

4. **Given** `PJ_PROJECT_REGISTRY` points to an isolated Registry
   **When** resolution, planning, or apply runs
   **Then** that Registry is used instead of the operator default
   **And** no test reads or mutates live Registry data.

5. **Given** a configured service URL or authentication setting
   **When** configuration is validated
   **Then** HTTPS hostnames and HTTP loopback URLs with runtime auth environment-variable names are accepted
   **And** userinfo, query/fragment, unsafe schemes, numeric non-loopback hosts, raw credential values, and hardcoded LAN endpoints are rejected with safe provenance and next actions.

6. **Given** a canonical project slug and repository display-name change
   **When** a planned binding is derived again
   **Then** the slug remains the stable binding key and the existing remote ID remains the intended identity
   **And** name change is represented as Drift, not a new binding.

7. **Given** dry-run mode
   **When** binding/configuration planning executes
   **Then** no Registry, Manifest, filesystem, XDG, or remote byte changes
   **And** the plan identifies value sources without revealing resolved credential values.

### Story 1.2: Round-Trip Notebook State Through PostgreSQL

As an operator using PJangler's PostgreSQL RegistryStore,
I want the same Notebook Binding and global defaults preserved as in YAML,
So that backend choice cannot change project identity or destroy unrelated data.

**Requirements:** FR-3; NFR-8, NFR-9, NFR-10; AR-7.

**Acceptance Criteria:**

1. **Given** the pre-PJAN-77 PostgreSQL schema
   **When** the additive migration runs
   **Then** project notebook JSONB, project extension JSONB, singleton global notebook/settings storage, and a partial unique nonempty notebook-ID index exist
   **And** legacy rows, including rows without a PJangler slug, remain intact.

2. **Given** unknown top-level, project-sibling, and notebook-descendant JSON values
   **When** a Project Record and global settings are loaded and saved
   **Then** complete notebook subtrees round-trip semantically
   **And** extension values merge at their exact documented level without being copied into owned fields.

3. **Given** two PJangler-owned project rows
   **When** both attempt to bind the same nonempty `notebook_id`
   **Then** the store rejects the second claim deterministically
   **And** empty/unbound legacy rows are not incorrectly constrained.

4. **Given** current dual-write behavior with YAML authoritative
   **When** the PostgreSQL write is injected to fail
   **Then** the failure is observable and categorized
   **And** no successfully preserved YAML or unrelated PostgreSQL data is lost or falsely reported as synchronized.

5. **Given** a scratch PostgreSQL instance and isolated YAML Registry fixtures
   **When** equivalent bindings/defaults are round-tripped through each backend
   **Then** owned semantic values and computed resolution outcomes match
   **And** the test requires no production Registry or database.

### Story 1.3: Call Open Notebook Through a Bounded Domain Port

As a PJangler operator,
I want Notebook Service calls hidden behind a validated, bounded adapter,
So that service failures are actionable and cannot hang the lifecycle or expose credentials.

**Requirements:** FR-18, FR-19; NFR-2, NFR-4, NFR-5, NFR-6, NFR-10; AR-12, AR-13, AR-14.

**Acceptance Criteria:**

1. **Given** the local fake Open Notebook service
   **When** the adapter performs health/auth checks, notebook list/create/update, or notebook-scoped note operations
   **Then** request and response payloads are schema-validated into domain records
   **And** raw vendor payloads never escape the adapter boundary.

2. **Given** configured connect/overall deadlines, response ceilings, abort signals, and redirect policy
   **When** the service hangs, returns an oversized response, or redirects to a different origin
   **Then** the call terminates within its bound with a normalized safe outcome
   **And** the client does not follow the unsafe redirect or include a body in diagnostics.

3. **Given** fake responses for 401/403, 404, 409, 429, timeout, connection failure, malformed JSON, and invalid schema
   **When** each response is processed
   **Then** it maps respectively to stable authentication, not-found, conflict, throttled, timeout, unavailable, or remote-protocol categories
   **And** retryability is explicit and does not depend solely on `/api/config` or auth-status metadata.

4. **Given** runtime authentication is disabled by service status
   **When** a request is sent
   **Then** no Authorization header is added
   **And** when effective runtime configuration requires auth, the environment value is read only at call time and never logged, serialized, journaled, or stored.

5. **Given** a read or proven-idempotent write that receives a retryable result
   **When** retry policy is applied
   **Then** attempts and delays remain finite
   **And** create operations are excluded from generic retry and routed through crash-safe reconciliation.

6. **Given** the adapter's exported port
   **When** a caller inspects its methods
   **Then** note access accepts a resolved binding and no unscoped get/update/delete method is exposed
   **And** all list counts, titles, bodies, and diagnostics honor centralized `NotebookLimitsV1` ceilings.

### Story 1.4: Reconcile Remote Creation After Crashes and Ambiguous Responses

As a PJangler operator retrying interrupted work,
I want durable remote-mutation evidence reconciled before another create request,
So that a timeout or process crash never silently creates a duplicate notebook or note.

**Requirements:** FR-1, FR-4, FR-19; NFR-1, NFR-7, NFR-9, NFR-10; AR-9, AR-10, AR-11, AR-16, AR-17, AR-32.

**Acceptance Criteria:**

1. **Given** a notebook or note create intent
   **When** it is prepared and dispatched
   **Then** a contained mode-0600 `RemoteMutationJournalV1` is atomically fsynced through `prepared` and `possibly-dispatched` before the POST can leave
   **And** it stores only safe kind, project/binding identity, marker/logical ID, input digest, timestamps, candidate IDs, and outcome metadata—not request bodies or credentials.

2. **Given** transport proof that no request bytes left the process
   **When** the attempt fails
   **Then** the prepared operation may be safely reset/retried within finite policy
   **And** absence of that proof leaves the operation `possibly-dispatched`.

3. **Given** an unresolved possibly-dispatched operation
   **When** reconciliation finds zero, one, or multiple exact `pjangler.project.v1:<slug>`/logical-note markers
   **Then** zero remains blocked unless a safe pre-dispatch retry is proven, one is adopted by stable ID, and many returns `CONFLICT`
   **And** no blind second POST or arbitrary name-based adoption occurs.

4. **Given** a candidate has been reconciled
   **When** its binding or note ownership becomes durable
   **Then** the journal advances through `reconciled` to `committed`
   **And** a crash at every transition converges on restart without duplicate durable objects.

5. **Given** a repository rename or two notebooks sharing a display name
   **When** creation is retried
   **Then** the stable marker and remote ID, not the display name, control adoption
   **And** name Drift is repairable without replacing identity.

6. **Given** an unresolved journal at command start
   **When** status or recovery is evaluated
   **Then** the operation remains visible with bounded category and exact next action
   **And** it is never discarded by normal retention while unresolved.

### Story 1.5: Plan Notebook Bootstrap Through the Singleton Recipe

As a PJangler operator,
I want `pj init` to show Project Notebook work through the existing recipe lifecycle,
So that I can review every local and remote consequence before anything changes.

**Requirements:** FR-2, FR-15; NFR-1, NFR-8; AR-1, AR-2, AR-21, AR-22.

**Acceptance Criteria:**

1. **Given** the production recipe catalog
   **When** it is constructed
   **Then** exactly one `NotebookRecipe` is registered immediately before the singleton `ProjectRecipe`
   **And** `ProjectRecipe.metadata.dependencies` truthfully includes `notebook` without recursive invocation.

2. **Given** project create or sync/re-init
   **When** `runNotebookLifecycle(plan, mode, context)` is called
   **Then** it invokes the one Notebook dependency for both modes
   **And** sync does not awaken unrelated create-only dependencies.

3. **Given** `pj init` dry-run
   **When** the Project Notebook plan is built
   **Then** proposed configuration, binding/projection, skill, hooks, Overview, and Live Actions appear in the Plan in deterministic order
   **And** planning creates no files, Registry rows, hooks, journals, receipts, service calls, or remote objects.

4. **Given** missing endpoint configuration, missing `--live`, or an explicitly disabled policy
   **When** the plan is evaluated
   **Then** it reports `unconfigured`, `planned` with remote skip, or `disabled` respectively
   **And** it never calls the state healthy or invents a service endpoint.

5. **Given** fresh init before Registry persistence
   **When** synchronous recipe checks run
   **Then** they use the provisional `NotebookPlan`, repo-local state, and any supplied immutable observation
   **And** no check performs a hidden network request.

6. **Given** the recipe's public checks
   **When** metadata is inspected
   **Then** all seven stable `notebook.*` rule IDs belong to `NotebookRecipe`
   **And** CLI, hook, and future transport adapters contain no duplicate policy or service orchestration.

### Story 1.6: Finalize One Registry-Last External Transaction

As a PJangler operator applying a bootstrap plan,
I want all external effects and recovery state finalized in one ordered transaction,
So that every failure leaves the repository truthful and safely retryable.

**Requirements:** FR-2, FR-4; NFR-1, NFR-2, NFR-7, NFR-9; AR-3, AR-4, AR-21, AR-40.

**Acceptance Criteria:**

1. **Given** an applied Project Plan with multiple external effects
   **When** external execution begins
   **Then** one typed `ProjectExternalEffectPlan` executes ticket provider, Notebook, then Hermes in fixed order
   **And** execution stops after the first failed or blocked effect while preserving its primary categorized outcome.

2. **Given** any external adapter dispatch
   **When** the adapter is about to receive the request
   **Then** `externalDispatchStarted` is latched first and never resets in the transaction
   **And** fresh-target recursive deletion is permitted only before the latch and no remote object is automatically deleted.

3. **Given** a Notebook effect returns candidate notebook and Overview IDs
   **When** the transaction considers a linked projection
   **Then** an observation proves the notebook marker, scoped Overview membership/envelope, and owned metadata before linkage
   **And** failed, ambiguous, or unobserved candidates retain planned/blocked recovery state.

4. **Given** success or failure at any local/external/postcondition point
   **When** mutation sequencing completes
   **Then** one Registry-only finalizer runs exactly once as the last mutation
   **And** it persists all accumulated linked results or truthful planned/blocked recovery before the command returns its outcome.

5. **Given** remote success followed by Manifest update, scoped commit, Registry finalizer, or read-only audit failure
   **When** the operator retries
   **Then** marker/journal evidence is adopted and reconciled without deletion or duplicate creation
   **And** existing repository user work is never auto-committed or rolled back.

6. **Given** injected failures before dispatch, after each external effect, after candidate observation, during Manifest update, and during Registry finalization
   **When** lifecycle regression tests run
   **Then** mutation ordering, one-finalizer behavior, latch safety, and durable recovery match the architecture failure table
   **And** dry-run remains byte-for-byte side-effect free.

### Story 1.7: Prove Fresh Bootstrap and Retry Convergence

As a PJangler operator creating a project,
I want generated-project evidence that bootstrap creates one healthy pairing and safely converges on retry,
So that the initial user journey is proven without risking production notebook data.

**Requirements:** FR-1, FR-2, FR-3, FR-4, FR-18, FR-19; NFR-1, NFR-6, NFR-9, NFR-10; AR-41, AR-43, AR-44.

**Acceptance Criteria:**

1. **Given** an isolated HOME, XDG state/data root, YAML Registry, generated repository, and fake Notebook Service
   **When** `pj init` first plans and then applies with live authorization
   **Then** exactly one marker-bearing Companion Notebook and one required Overview Note are created
   **And** Registry and Manifest contain the same stable binding only after remote postconditions pass.

2. **Given** the successful generated project
   **When** init is repeated and the explicit create/reconcile path is exercised
   **Then** no duplicate notebook or Overview is created
   **And** the second converged run changes zero owned bytes or remote objects.

3. **Given** injected missing config, pre-dispatch failure, ambiguous create timeout, Overview failure, remote candidate mismatch, and Registry-write failure
   **When** each bootstrap scenario completes
   **Then** persisted/computed state is truthful and includes an exact recovery action
   **And** no scenario reports healthy without authorized remote proof.

4. **Given** a duplicate notebook marker or duplicate Registry claim
   **When** bootstrap reconciles
   **Then** it returns a conflict and performs no destructive choice
   **And** both candidates remain available for explicit operator resolution.

5. **Given** the generated-project contract suite on Node.js 20+
   **When** it is timed in the healthy fake-service environment
   **Then** pairing completes within the two-minute product target
   **And** all tests prove production Registry/notebook endpoints were neither required nor contacted.

## Epic 2: Manage and Find Repository Knowledge Safely

Jarad and scripts can inspect the current binding, manage its Overview and notes, and search the repository's knowledge through stable human and JSON-v1 commands without leaking another project's content.

### Story 2.1: Inspect Repository Notebook Status Through a Stable Contract

As a PJangler operator or automation author,
I want repository-aware notebook status in concise human and validated JSON forms,
So that I can distinguish healthy, incomplete, drifted, and unavailable state without parsing prose.

**Requirements:** FR-5, FR-9, FR-21; NFR-4, NFR-5, NFR-7, NFR-8; AR-18, AR-19, AR-20, AR-21, AR-35, AR-46, AR-47.

**Acceptance Criteria:**

1. **Given** an explicit repository argument or a current working directory inside a registered Git repository
   **When** `pj notebook status` resolves its target
   **Then** it returns the canonical project slug/path and authoritative binding
   **And** running outside a registered repository returns `NOT_CONFIGURED` with an exact corrective next action instead of guessing.

2. **Given** persisted states `disabled`, `planned`, or `linked` and optional local/remote observations
   **When** status is computed
   **Then** `binding_state` remains distinct from nullable observed `health`
   **And** the complete outcomes unconfigured, disabled, planned, linked, healthy, drifted, unavailable, and blocked are represented without persisting computed health.

3. **Given** `--local-only`
   **When** status runs
   **Then** no service adapter is constructed or contacted, `remote_check` is `skip`, and `health` is null
   **And** linked local state is never presented as remotely healthy.

4. **Given** an empty or populated Project Notebook state directory
   **When** status renders
   **Then** `CaptureAdmissionSummaryV1` reports nullable exact unresolved count/bytes, numeric lower bounds, unmeasurable-entry count, bounded safe integrity evidence, both finite caps, receiptless/stale counts, and active refusal markers
   **And** it reports receipt retryability and safe next actions without bodies, raw session IDs, absolute suspect paths, or credentials; an empty state is a successful zero-count result.

5. **Given** human mode
   **When** status succeeds or fails
   **Then** output is concise and identifies operation, project, binding outcome, remote proof, and next action
   **And** no raw vendor payload or secret-bearing header is shown.

6. **Given** `--json`
   **When** status serializes
   **Then** stdout contains exactly one schema-version-1 envelope plus newline conforming to `notebook.status`
   **And** stdout has no ANSI/progress text while bounded diagnostics use stderr.

7. **Given** exact current usage and an active `RetentionRefusalV1`
   **When** status recomputes the marker using its stored real `candidate_bytes` and the current caps
   **Then** it emits `retention-pressure` only while the current prospective predicate still fails
   **And** after both measures recover it retains the marker only in `active_refusals` as informational `capture-refused-history`, with no pressure finding or invented repository-wide admission boolean.

8. **Given** an invalid, unreadable, or non-regular receipt entry prevents exact measurement
   **When** status evaluates capture admission
   **Then** `state-integrity` takes precedence, preserves the suspect entry, and reports null exacts, numeric lower bounds, an unmeasurable count, safe entry evidence, and exact local audit/repair actions
   **And** it does not infer `retention-pressure` from incomplete evidence.

### Story 2.2: Read and Replace the Stable Overview Note

As a project operator,
I want to inspect and update the designated Overview in place,
So that agent-facing project context stays bounded and keeps one stable identity.

**Requirements:** FR-6, FR-7, FR-9, FR-20; NFR-4, NFR-6, NFR-9; AR-14, AR-16, AR-17, AR-28, AR-40.

**Acceptance Criteria:**

1. **Given** a linked binding with `overview_note_id`
   **When** `pj notebook overview` reads it
   **Then** a complete notebook-scoped note list first proves membership
   **And** the command returns bounded content and stable metadata without exposing the envelope marker in human excerpts.

2. **Given** a contained readable file within configured size limits
   **When** `pj notebook overview --set-file PATH` runs
   **Then** direct invocation authorizes only this update and the service note is updated in place
   **And** `overview_note_id`, Overview logical identity, and required envelope are preserved.

3. **Given** a replacement Overview
   **When** its descriptor is compiled
   **Then** it contains project identity, visible purpose or exact `Purpose not yet documented` placeholder, ordered contained authoritative references with Git revision/digest or missing status, and policy version
   **And** no absolute path, credential, or unbounded source content enters the note.

4. **Given** an absent, foreign, duplicate-logical-ID, malformed, or oversized Overview
   **When** read or replacement is attempted
   **Then** the command returns the correct not-found, cross-project, conflict, remote-protocol, or invalid-input outcome according to error precedence
   **And** no unrelated note is read or mutated.

5. **Given** a successful Overview read or replacement in JSON mode
   **When** the result is serialized
   **Then** it validates the exact `notebook.overview.get` or `.set` data schema
   **And** the result reports `updated` and descriptor Drift without leaking raw marker internals.

### Story 2.3: List and Add Binding-Owned Notes

As a project operator,
I want to list current notes and add a bounded note from text or a file,
So that project knowledge can be managed without using the raw service API.

**Requirements:** FR-7, FR-9, FR-19, FR-20; NFR-4, NFR-5, NFR-6, NFR-9; AR-10, AR-14, AR-16, AR-17, AR-18, AR-19, AR-40.

**Acceptance Criteria:**

1. **Given** a linked binding with a complete scoped note list
   **When** `pj notebook list notes` runs
   **Then** items sort by `updated_at` descending and ID ascending with bounded summaries
   **And** pagination uses a bounded opaque base64url canonical-JSON cursor carrying schema version and last sort tuple.

2. **Given** malformed, mismatched, or oversized cursor/limit input
   **When** list validates arguments
   **Then** it returns `INVALID_INPUT` before any remote request
   **And** an empty valid list is exit 0 with `items: []` and `next_cursor: null`.

3. **Given** exactly one of bounded `--text` or a contained regular `--file`
   **When** `pj notebook add note --title TEXT` runs
   **Then** direct invocation authorizes one add, creates a prepared journal with a UUID operation ID, and writes a `user-note:v1:<operation-id>` envelope
   **And** the returned note detail contains a stable remote identifier.

4. **Given** an add response is lost after possible dispatch
   **When** the same binding/title/content digest is retried
   **Then** the active unresolved journal and marker are reconciled before any POST
   **And** one candidate is adopted, zero remains safely blocked, and multiple candidates conflict.

5. **Given** one add has committed
   **When** the operator intentionally adds identical title/content again
   **Then** a new operation UUID creates a distinct user note
   **And** this intentional duplicate content is not confused with an unresolved retry.

6. **Given** a secret-like, oversized, traversing, symlink-escaping, binary, or non-regular input file
   **When** add validates it
   **Then** it rejects the request before summarization or remote contact with only a bounded safe reason
   **And** no matching content enters logs, JSON, journals, or diagnostics.

7. **Given** list/add JSON mode
   **When** output is produced
   **Then** it validates the exact list or note-detail schema and emits a pure single envelope
   **And** service/progress diagnostics remain on stderr.

### Story 2.4: Read and Update Only Proven Member Notes

As a project operator,
I want to retrieve or revise a note only after its notebook membership is proven,
So that a guessed foreign note ID cannot cross the repository boundary.

**Requirements:** FR-7, FR-9, FR-19, FR-20; NFR-5, NFR-6, NFR-9; AR-8, AR-14, AR-16, AR-17, AR-20.

**Acceptance Criteria:**

1. **Given** a note ID
   **When** get or update begins
   **Then** the adapter first consumes a complete list scoped by the resolved `notebook_id` and proves the ID is present
   **And** it never issues an unscoped get/update request for an absent target.

2. **Given** Registry/ownership evidence proves the absent ID belongs to another binding
   **When** membership classification completes
   **Then** the command returns `CROSS_PROJECT`
   **And** without that proof it returns `NOT_FOUND` and does not probe the foreign object.

3. **Given** a managed note
   **When** title or bounded content is updated
   **Then** its remote ID, envelope kind, logical ID, and safe provenance remain unchanged except for explicitly allowed revision fields
   **And** service-supplied revision metadata is returned.

4. **Given** an unmarked scoped manual service note
   **When** it is updated
   **Then** it remains unmarked and is not assigned fabricated PJangler ownership
   **And** no other note content changes.

5. **Given** the scoped list times out, is throttled, unavailable, oversized, or malformed
   **When** get/update evaluates the result
   **Then** that service/protocol outcome wins over `NOT_FOUND` or `CROSS_PROJECT`
   **And** no mutation request is dispatched.

6. **Given** JSON mode
   **When** get/update succeeds or fails
   **Then** the exact note-detail or bounded error schema validates before serialization
   **And** raw note/service bodies appear only in the allowed bounded data field, never diagnostics.

### Story 2.5: Delete a Note with Explicit Scope and Confirmation

As a project operator,
I want destructive note deletion to require both ownership proof and explicit confirmation,
So that automation cannot erase the Overview or another project's knowledge accidentally.

**Requirements:** FR-7, FR-9, FR-20; NFR-1, NFR-6; AR-14, AR-17, AR-20, AR-40.

**Acceptance Criteria:**

1. **Given** interactive human mode without confirmation
   **When** `pj notebook delete note NOTE_ID` is invoked
   **Then** it prompts for explicit confirmation before any remote request
   **And** a declined confirmation exits safely without mutation.

2. **Given** non-interactive or JSON mode
   **When** delete lacks `--yes`
   **Then** it returns `INVALID_INPUT` before service contact
   **And** `--yes` authorizes only deletion of that one requested note.

3. **Given** `NOTE_ID` equals the binding's `overview_note_id` or resolves to an Overview envelope
   **When** generic deletion is requested
   **Then** deletion is rejected regardless of confirmation
   **And** the next action points to Overview replacement rather than removal.

4. **Given** a non-Overview note
   **When** membership cannot be proven from a complete scoped list
   **Then** the same not-found/cross-project and error-precedence rules as read/update apply
   **And** no delete endpoint is called.

5. **Given** confirmed scoped deletion succeeds
   **When** output is rendered
   **Then** the result contains exactly the deleted stable ID under the JSON-v1 schema or concise human confirmation
   **And** any owned local note index is updated atomically without disturbing other identities.

### Story 2.6: Search a Complete Scoped Note Set Locally

As a project operator,
I want deterministic text search over only my Companion Notebook,
So that search is useful without trusting the service's global and incomplete search endpoint.

**Requirements:** FR-8, FR-9, FR-20; NFR-4, NFR-6, NFR-9; AR-14, AR-15, AR-19, AR-20.

**Acceptance Criteria:**

1. **Given** a bounded query and complete notebook-scoped note list
   **When** `pj notebook search notes QUERY` runs
   **Then** titles, marker-stripped bodies, and query use NFKC normalization plus Unicode lowercase and `/[\p{L}\p{N}]+/gu` tokenization
   **And** every distinct query token is required for a result.

2. **Given** matching notes
   **When** scores are computed
   **Then** exact-token title occurrences count ten times body occurrences
   **And** results order by score descending, `updated_at` descending, then ID ascending with bounded excerpts beginning at the first body match.

3. **Given** no matching notes
   **When** the complete scoped list is searched
   **Then** the command succeeds with an empty collection
   **And** it does not reinterpret empty as an error.

4. **Given** a fake upstream global search response contaminated by another notebook
   **When** public v1 search executes
   **Then** the global text/vector endpoint is not called at all
   **And** no cross-project item can enter results even when its `parent_id` appears plausible.

5. **Given** the scoped list is incomplete, capped beyond allowed count, timed out, throttled, unavailable, or malformed
   **When** search evaluates it
   **Then** it returns the original bounded service/protocol error rather than a partial or empty result
   **And** local/vector semantic fallback is not falsely advertised.

6. **Given** JSON mode
   **When** search returns results
   **Then** `next_cursor` is null, normalized query tokens and bounded summaries validate the exact schema, and stdout remains pure
   **And** stable ordering fixtures cover Unicode normalization and tie cases.

### Story 2.7: Lock the Public CLI, JSON, Exit, and Packaging Contract

As an automation author,
I want every delivered `pj notebook` command to obey one documented compatibility contract,
So that scripts can upgrade PJangler without brittle prose parsing or hidden behavior changes.

**Requirements:** FR-5 through FR-9, FR-18 through FR-21; NFR-4, NFR-5, NFR-8, NFR-10; AR-18, AR-19, AR-20, AR-43, AR-44, AR-45.

**Acceptance Criteria:**

1. **Given** the accepted public grammar
   **When** Commander help and parser tests run
   **Then** status, create, note list/add/get/update/delete/search, Overview, capture list/retry, audit, and migrate forms match the Architecture Spine
   **And** internal hook/worker entrypoints are labeled compatibility surfaces rather than public user commands.

2. **Given** every currently implemented data-returning command
   **When** success, empty, no-op, and failure fixtures run
   **Then** each output validates its exact command-specific JSON-v1 data/error schema before serialization
   **And** `binding_state`, nullable `health`, safe `next_actions`, and one trailing newline remain stable.

3. **Given** invalid input, not configured/auth failure, object/conflict/isolation/drift, retryable service failure, or protocol/internal invariant failure
   **When** the CLI exits
   **Then** stable symbolic codes map to exits 2, 3, 4, 5, or 6 respectively while success/empty/no-op/local skip is 0
   **And** exit 1 remains compatibility fallback only and is not emitted by new domain paths.

4. **Given** malicious titles/payloads, ANSI text, oversized responses, credential-shaped fixtures, and absolute secret paths
   **When** human/JSON/log renderers process them
   **Then** bounds and redaction prevent control-sequence injection or credential/body disclosure
   **And** the service payload is never interpolated into an executable shell or raw diagnostic.

5. **Given** a backwards-compatible additive field/command or a breaking field/meaning/exit change
   **When** compatibility checks evaluate it
   **Then** additive consumers are required to ignore unknown fields
   **And** a breaking change requires a major version or compatibility shim, while deprecated syntax remains functional with warning for at least one minor release.

6. **Given** the built and packed CLI on Node.js 20+
   **When** it runs in isolated HOME/XDG/Registry against the fake service
   **Then** direct status, create, Overview, CRUD, and search contracts pass without a source checkout assumption
   **And** no production endpoint or operator data is contacted.

7. **Given** the full CRUD/search/error matrix
   **When** contract tests run
   **Then** success, empty, invalid input, auth, timeout, unavailable, conflict, malformed response, confirmation, foreign ID, and contaminated search fixtures pass 100%
   **And** scans report zero raw credential disclosures and zero cross-project results.

8. **Given** the v1 package and command surface
   **When** exported commands, adapters, and help are inspected
   **Then** no MCP command, unsupported-client lifecycle claim, semantic/vector search, rich/source ingestion, multi-tenant control, fleet bulk operation, destructive remote deletion, ambiguity force-clear, receipt dismissal, or down-migration behavior is exposed
   **And** those deferred capabilities require separate product and safety design rather than hidden flags.

## Epic 3: Detect and Repair Project Notebook Drift

Jarad can audit an existing or newly initialized repository, review only Project Notebook-owned repairs, apply authorized local/live fixes without disturbing foreign state, and prove the second run is a no-op.

### Story 3.1: Evaluate Seven Stable Notebook Ownership Rules

As a PJangler operator,
I want Project Notebook state evaluated by one stable set of recipe-owned checks,
So that init, general audit, focused audit, and migration agree about Drift and ownership.

**Requirements:** FR-15; NFR-1, NFR-4, NFR-5, NFR-7, NFR-8, NFR-9; AR-1, AR-21, AR-22, AR-35, AR-46, AR-47.

**Acceptance Criteria:**

1. **Given** the `NotebookRecipe` check catalog
   **When** its public rule IDs are enumerated
   **Then** it contains exactly `notebook.configuration`, `notebook.binding`, `notebook.remote-notebook`, `notebook.overview-note`, `notebook.skill-installed`, `notebook.hooks-projected`, and `notebook.capture-receipts`
   **And** each ID has stable ownership, severity semantics, fixability, and safe next-action metadata.

2. **Given** local Registry, Manifest, skill, hook, XDG journal/receipt, and provisional plan state
   **When** checks execute synchronously
   **Then** they perform no filesystem mutation or hidden network request
   **And** fresh init can use plan/repository-local evidence before Registry persistence.

3. **Given** an async caller with remote-read authorization
   **When** it prepares `NotebookObservation`
   **Then** the immutable observation records fetch time, binding, safe config/auth provenance, categorized health, bounded notebook/note/Overview metadata, and diagnostics
   **And** it contains no credential, request/response body, or unbounded content.

4. **Given** ordinary `pj audit` without a supplied observation
   **When** remote-owned rules run
   **Then** they return `skip`, not `pass` or a hidden fetch
   **And** local findings still participate in ordinary and final init audit.

5. **Given** pass, fail, warn, or skip outcomes
   **When** a finding is rendered
   **Then** ownership, observed evidence, fixability, retryability, and an exact safe next action are explicit
   **And** neither secrets nor foreign configuration bodies appear.

6. **Given** `notebook.capture-receipts` evaluates runtime state
   **When** exact admission proof is available, unavailable, or represented by a prior refusal marker
   **Then** it uses the same `CaptureAdmissionSummaryV1`, current-predicate pressure rule, informational history outcome, and state-integrity precedence as status
   **And** it never adds a seventh receipt state or treats historical refusal as current pressure by itself.

### Story 3.2: Run a Side-Effect-Free Focused Notebook Audit

As a project operator,
I want `pj notebook audit` to inspect only notebook-owned local and authorized remote state,
So that I can see precisely what drifted without changing anything.

**Requirements:** FR-5, FR-15; NFR-1, NFR-4, NFR-6, NFR-7, NFR-9, NFR-10; AR-9, AR-21, AR-22, AR-28, AR-35, AR-46, AR-47.

**Acceptance Criteria:**

1. **Given** a registered target repository
   **When** `pj notebook audit` runs normally
   **Then** it prefetches one bounded observation and filters results to the `notebook` recipe
   **And** no Registry, Manifest, hook, XDG, or remote state is mutated.

2. **Given** `--local-only`
   **When** focused audit runs
   **Then** it forbids adapter construction/contact and explicitly marks remote notebook and Overview checks `skip`
   **And** local configuration, binding projection, skill, hooks, journals, and receipt integrity still evaluate.

3. **Given** observed remote state
   **When** remote notebook and Overview rules evaluate
   **Then** they verify exact stable IDs, notebook marker/name/archive state, scoped Overview membership/envelope/bounds, and current descriptor reference digests
   **And** zero/multiple marker candidates or Overview logical IDs report blocked/conflict rather than choosing one.

4. **Given** missing config, missing binding, stale name, missing Overview, stale descriptor, missing skill, hook drift/duplicates, unresolved mutation journal, incomplete baseline, expired lease, or failed receipt
   **When** audit runs
   **Then** each condition maps to its owning rule and a precise fixable/blocked outcome
   **And** unrelated recipe findings are absent from focused output.

5. **Given** JSON mode
   **When** audit completes
   **Then** the exact `notebook.audit` schema returns rules, audit time, and remote-check state in one pure envelope
   **And** Drift uses the documented symbolic code/exit without writing a repair.

6. **Given** exact unresolved usage and active refusal markers
   **When** `notebook.capture-receipts` audits them
   **Then** it reports current totals/caps and recomputes each stored real candidate against current usage, emitting `retention-pressure` only for a predicate that still fails
   **And** a now-fitting marker remains only in `active_refusals` as non-finding `capture-refused-history`, without synthesizing candidate bytes for any absent session.

7. **Given** an invalid, unreadable, or non-regular state entry
   **When** focused or local-only audit evaluates capture admission
   **Then** `state-integrity` is a failing precedence outcome with null exact totals, numeric lower bounds, bounded safe entry identifiers/reasons, and exact in-place repair/re-run actions
   **And** the suspect entry is preserved and no retention-pressure finding is emitted.

8. **Given** succeeded, unresolved, referenced-baseline, and unreferenced receiptless fixtures
   **When** audit evaluates retention and cleanup eligibility
   **Then** only an elapsed succeeded receipt and equality-expired unreferenced receiptless state are eligible for their distinct cleanup paths
   **And** queued, processing, failed, retry-exhausted, blocked-missing-baseline, journal-referenced, corrupt, and unreadable evidence is never proposed for deletion, compaction, or dismissal.

### Story 3.3: Review a Selective Notebook Migration Plan

As a PJangler operator,
I want migration to begin with a no-write plan of only owned repairs,
So that I can authorize local and remote effects independently and never trigger a global migrate-all.

**Requirements:** FR-16; NFR-1, NFR-7, NFR-9; AR-20, AR-22, AR-40.

**Acceptance Criteria:**

1. **Given** focused audit findings
   **When** `pj notebook migrate` runs without `--apply`
   **Then** it selects only failing/fixable public `notebook.*` rule IDs from the same check objects
   **And** it performs zero Registry, Manifest, hook, XDG, or remote writes.

2. **Given** proposed repairs
   **When** the Plan is rendered
   **Then** local changes and Live Actions are separated with proposed state transitions, ownership, preconditions, and exact next actions
   **And** it never selects another recipe or invokes global migrate-all.

3. **Given** remote rename, adopt, Overview create/update, or other remote-needed repair
   **When** `--live` is absent
   **Then** the action remains planned/skipped and the binding does not become healthy
   **And** generic synchronous migration reports the exact `pj notebook migrate --apply --live` path rather than pretending completion.

4. **Given** duplicate markers, destructive ambiguity, unresolved possibly-dispatched mutation, or an absent required endpoint
   **When** migration plans
   **Then** the finding is blocked with safe evidence and no guessed action
   **And** v1 never proposes remote deletion, ambiguity force-clear, or invented configuration.

5. **Given** JSON mode
   **When** the migration plan returns
   **Then** `dry_run`, selected rule IDs, proposed results/state transitions, and changed-file predictions validate the exact `notebook.migrate` schema
   **And** no secret value or complete foreign configuration is exposed.

### Story 3.4: Apply Repairs with Preservation and No-Op Proof

As a PJangler operator repairing an older repository,
I want selected notebook migrations to preserve every foreign byte and verify their postconditions,
So that repair is safe, recoverable, and idempotent.

**Requirements:** FR-15, FR-16, FR-17; NFR-1, NFR-2, NFR-4, NFR-6, NFR-9, NFR-10; AR-6 through AR-11, AR-22, AR-27, AR-28, AR-35, AR-40, AR-42, AR-43, AR-44, AR-46, AR-47.

**Acceptance Criteria:**

1. **Given** an approved plan and `--apply` without `--live`
   **When** migration executes
   **Then** only selected local Registry/Manifest/skill/hook/state repairs run
   **And** remote-required rules remain explicit skips/blocked outcomes with truthful planned state.

2. **Given** `--apply --live` and unambiguous remote evidence
   **When** selected remote repairs run
   **Then** rename/reconcile/adopt/Overview recompile-update use stable markers, journals, scoped membership, and the existing Overview ID
   **And** no notebook/note is blindly retried or deleted.

3. **Given** unrelated Registry/Manifest keys, YAML formatting/comments/order, foreign hook groups/siblings/keys, manual notes, and unrelated Notebook Service content
   **When** migration applies
   **Then** all unrelated state remains byte-identical where format permits and semantically identical otherwise
   **And** only explicitly selected owned state changes.

4. **Given** an injected failure during a local or live repair
   **When** migration stops
   **Then** it retains journals and truthful planned/blocked recovery state and reports categorized failure
   **And** it does not persist healthy/linked postconditions that were not proven.

5. **Given** all selected repairs complete
   **When** migration re-observes and runs focused postcondition audit
   **Then** no fixable Project Notebook finding remains before success is reported
   **And** skipped remote proof remains skipped rather than green.

6. **Given** the now-repaired repository
   **When** the identical migration and audit run a second time
   **Then** the migration is a no-op with zero local bytes and zero remote mutations
   **And** the audit continues to pass all authorized owned postconditions.

7. **Given** isolated pre-PJAN-77 repository fixtures for YAML and PostgreSQL
   **When** dry-run, local apply, live apply, injected failure, and second-run scenarios execute
   **Then** every preservation/idempotency assertion passes without production data
   **And** rollback testing proves disable/uninstall preserves bindings, remote knowledge, foreign hooks, Git content, database columns, and unresolved recovery evidence.

8. **Given** a selected `notebook.capture-receipts` migration with elapsed receiptless state
   **When** local apply runs under the project state lock
   **Then** it may prune only a baseline, claim, and refusal marker whose immutable baseline grace is expired and which has no receipt or mutation-journal reference
   **And** it never expires unresolved receipts, removes suspect entries, dismisses recovery evidence, or extends grace by marker replacement.

## Epic 4: Start Agent Sessions with Bounded Project Context

Jarad can install one canonical globally distributed skill whose coexistence-safe Claude SessionStart hook establishes a trustworthy baseline and emits the current repository's bounded Overview at most once, alongside rather than instead of Hindsight.

### Story 4.1: Establish an Exact, Trustworthy Session Baseline

As a coding agent beginning work in an enabled project,
I want SessionStart to record one trustworthy repository baseline before any remote context call,
So that later capture has an exact change boundary even when Overview priming is disabled or fails.

**Requirements:** FR-10, FR-11, FR-12; NFR-2, NFR-3, NFR-5, NFR-7, NFR-9; AR-18, AR-29, AR-30, AR-32.

**Acceptance Criteria:**

1. **Given** canonical project slug, client name, and a nonempty Claude `session_id`
   **When** `pj notebook hook session-start` parses a bounded stdin payload or contained mode-0600 XDG payload file
   **Then** it derives lowercase-hex SHA-256 over the exact UTF-8 sequence `pjangler-session-v1`, NUL, project slug, NUL, client, NUL, client session ID
   **And** the raw client session ID and payload body are never persisted, logged, or placed in argv.

2. **Given** an enabled project where either `session_start_enabled` or `session_capture_enabled` is true
   **When** SessionStart runs
   **Then** it exclusive-creates and fsyncs one baseline before any Overview/service access
   **And** the baseline records safe project/repository hash, client, start time, HEAD, eligible tracked path digests, Git-status digest, policy version, and completeness only.

3. **Given** a resumed or duplicate SessionStart with the same exact session key
   **When** it sees an existing baseline
   **Then** it never overwrites or advances that baseline
   **And** concurrent delivery converges on one complete/incomplete file.

4. **Given** policy combinations for disabled project, start off/capture on, start on/capture off, both on, or both off
   **When** SessionStart executes
   **Then** the architecture policy matrix determines baseline and Overview eligibility exactly
   **And** both policies off or project disabled performs no work while capture-on still records a baseline even if priming is off.

5. **Given** missing/empty session ID, Git/limit/deadline failure, or incomplete evidence
   **When** baseline creation cannot be trusted
   **Then** the hook exits 0 with a bounded diagnostic and retains an incomplete reason where claimable
   **And** it never substitutes current HEAD/mtime later as a guessed baseline.

6. **Given** XDG state path creation
   **When** session metadata is written
   **Then** no-follow containment, 0700 directories, 0600 files, same-directory temporary write, fsync, atomic rename/exclusive create, and bounded retention are enforced
   **And** symlink escape, traversal, credentials, source bodies, transcripts, and diffs are rejected from state.

### Story 4.2: Prime One Bounded Overview with Explicit Drift

As a coding agent starting a supported session,
I want the repository's Overview emitted once with freshness evidence,
So that I receive useful project context without duplicate prompts or stale content being presented as current.

**Requirements:** FR-11; NFR-2, NFR-3, NFR-4, NFR-6, NFR-9; AR-28, AR-30, AR-31.

**Acceptance Criteria:**

1. **Given** a complete baseline and enabled `session_start_enabled` policy
   **When** SessionStart prepares Overview delivery
   **Then** it atomically exclusive-creates a claim from the exact session key
   **And** a duplicate/resumed event neither emits the Overview twice nor rewrites the baseline.

2. **Given** the stored OverviewDescriptor and current authoritative references
   **When** descriptor proof runs after baseline creation
   **Then** contained tracked reference revision/content digests are recomputed under bounds
   **And** any difference emits `PROJECT NOTEBOOK OVERVIEW DRIFT` with bounded relative paths/reasons before stale-labeled content.

3. **Given** a current Overview
   **When** it is emitted
   **Then** output carries a clear Project Notebook/Notebook Service heading separate from Hindsight recall
   **And** content is bounded to the effective limit (default 4,000 characters) at a code-point-safe boundary with explicit truncation labeling.

4. **Given** missing binding, disabled priming, missing Overview, auth failure, timeout, malformed/oversized response, or descriptor failure
   **When** SessionStart handles the condition
   **Then** it returns exit 0 within the foreground deadline with one bounded actionable diagnostic
   **And** the agent session and already-recorded baseline remain usable.

5. **Given** controlled latency and injected failure fixtures
   **When** SessionStart performance is sampled
   **Then** successful priming or fail-open completes within two seconds p95 on the target profile
   **And** every injected failure leaves the session usable with no unbounded output.

6. **Given** `session_start_enabled` is false but capture remains enabled
   **When** SessionStart runs
   **Then** baseline creation still occurs while no adapter is contacted and no Overview claim/output is made
   **And** explicit disable wins over all lower-precedence enables.

### Story 4.3: Publish One Canonical Skill and Surgical Hook Projector

As a PJangler operator,
I want one globally discoverable Project Notebook skill to own the hook wrappers and projection logic,
So that every client projection uses the same reviewed implementation without clobbering foreign hooks.

**Requirements:** FR-10; NFR-1, NFR-5, NFR-8, NFR-9; AR-23, AR-25, AR-26, AR-27, AR-40.

**Acceptance Criteria:**

1. **Given** the Skillex repository
   **When** the skill is inspected
   **Then** `/home/delorenj/code/skillex/all-skills/project-notebook/` is the sole hand-edited source containing `SKILL.md`, agent metadata, hook master/generated Claude fragment, thin start/end wrappers, projector, references, and projector tests
   **And** no PJangler or generated client copy is treated as a second editable source.

2. **Given** the canonical hook master
   **When** the Claude fragment is rendered
   **Then** it contains exactly `PJ_HOOK_OWNER=project-notebook.v1 "$HOME/.agents/skills/project-notebook/hooks/session-start.sh"` at `SessionStart` timeout 3 and the corresponding `session-end.sh` command at true `SessionEnd` timeout 1, in master order
   **And** it contains and modifies no `Stop` entry.

3. **Given** a live-like `~/.claude/settings.json` with foreign groups, matchers, siblings, order, conditions, comments/representable extra keys, and one/multiple/missing owned entries
   **When** projector install runs under its advisory lock
   **Then** it re-reads while locked, updates the earliest owned inner hook, removes only later owned duplicates, or appends a dedicated group when absent
   **And** every foreign parsed object and relative order is preserved.

4. **Given** projector check, install, repeat install, and uninstall
   **When** each mode executes
   **Then** check is pure; install makes only the required owned change; the repeat changes zero bytes; and uninstall removes only recognized owned hooks/containers made empty by removal
   **And** no Hindsight, Bloodbank, Git checkpoint, notification, CommonProject, or arbitrary prefix-similar command is removed.

5. **Given** projector mutation
   **When** it writes live settings
   **Then** it validates paths/JSON/recognized wrappers, takes a permission-restricted recovery snapshot under XDG state, and atomically replaces only changed content
   **And** live settings and recovery state contain no credentials or repository runtime droppings.

6. **Given** a repository without an enabled binding or with both hook policies disabled
   **When** a globally installed wrapper fires
   **Then** runtime scoping exits 0 without remote contact or state changes
   **And** global installation alone never silently enables a repository.

7. **Given** the SessionEnd wrapper is globally present before capture rollout is enabled
   **When** it invokes the implemented compatibility entrypoint for a repository whose capture policy/capability is disabled
   **Then** the entrypoint exits 0 without enqueue, network, Git diff, upload, or summarizer work
   **And** audit reports capture as disabled/deferred rather than allowing a dangling or failing hook command.

### Story 4.4: Export and Install the Skill from a Packed CLI

As a PJangler user installing the published package,
I want the canonical skill available even without the developer's Skillex checkout,
So that generated projects receive verified hooks from the shipped CLI rather than an absolute workstation path.

**Requirements:** FR-10, FR-21; NFR-5, NFR-8, NFR-9, NFR-10; AR-23, AR-24, AR-27, AR-43.

**Acceptance Criteria:**

1. **Given** build or prepack
   **When** the export script reads the canonical Skillex source
   **Then** it rejects symlinks, traversal, unsafe/generated/runtime/secret files, and source drift
   **And** it writes deterministic `dist/assets/project-notebook-skill/`, `export-manifest.json`, and `SHA256SUMS` included by the existing package contract.

2. **Given** runtime skill resolution
   **When** PJangler locates a source
   **Then** it validates precedence `PJ_PROJECT_NOTEBOOK_SKILL_ROOT`, then `PJ_SKILLS_REGISTRY_ROOT/all-skills/project-notebook`, then package-relative export
   **And** it fails safely with reinstall/build guidance if no digest-valid source exists.

3. **Given** a verified skill payload
   **When** installation applies
   **Then** it copies an immutable payload to `$XDG_DATA_HOME/pjangler/skills/project-notebook/<version>-<digest>` and owns only a matching `~/.agents/skills/project-notebook` link
   **And** an existing foreign/custom link or path conflicts instead of being overwritten.

4. **Given** the same verified version/digest is installed again
   **When** resolver and projector run
   **Then** immutable payload, owned link, and live hooks change zero bytes
   **And** audit can distinguish source/export/link/hook Drift without partially installing anything.

5. **Given** an npm-packed PJangler tarball on Node.js 20+ in isolated HOME/XDG with the developer Skillex checkout unavailable
   **When** a project installs/checks the skill and invokes both wrappers against controlled payloads
   **Then** digest verification, immutable install, command resolution, and fail-open behavior pass
   **And** no production Registry, hook file, or Notebook Service is touched.

### Story 4.5: Prove Hook Coexistence, Boundaries, and Canary Safety

As an operator sharing global hooks among agent systems,
I want Project Notebook installation and normal fanout updates to coexist deterministically,
So that enabling session priming cannot erase or duplicate Bloodbank, Hindsight, or project-scoped behavior.

**Requirements:** FR-10, FR-11; NFR-2, NFR-3, NFR-8, NFR-9, NFR-10; AR-25, AR-26, AR-27, AR-41, AR-42, AR-43, AR-44.

**Acceptance Criteria:**

1. **Given** live-like settings seeded with canonical Project Notebook entries, Bloodbank publishers, and unrelated hooks
   **When** a changing Bloodbank `sync.py` run updates its own generated entry
   **Then** parsed Project Notebook objects and foreign relative group/sibling order remain equal and unduplicated
   **And** a second identical Bloodbank sync changes zero bytes.

2. **Given** Bloodbank entries already installed
   **When** Project Notebook install/reinstall/uninstall executes
   **Then** every Bloodbank and other foreign entry survives with relative order intact
   **And** exactly one Project Notebook command remains per supported event after reinstall and zero after owned uninstall.

3. **Given** CommonProject project-scoped hooks or an unsupported client such as Codex/Hermes/Copilot without proven true boundaries
   **When** Project Notebook audit/projection evaluates them
   **Then** global delivery is checked separately, duplicate project-local Project Notebook entries are prevented, and unsupported clients return audit `skip`
   **And** a per-turn `Stop` is never relabeled as session close.

4. **Given** all four start/capture policy combinations, duplicate SessionStart, missing session ID, missing Overview, timeout, malformed response, and Overview Drift fixtures
   **When** hook contract tests run
   **Then** baseline/claim/remote-contact/output behavior matches the architecture matrix exactly
   **And** 100% of injected failures exit 0 and leave the agent session usable.

5. **Given** incremental rollout
   **When** one isolated canary is planned and enabled
   **Then** skill/hook actions are visible before apply, no repository is globally auto-enabled, and rollback disables policy then removes only owned hooks
   **And** remote notebooks/notes, bindings, Git content, foreign hooks, and XDG recovery evidence are preserved.

6. **Given** the hook release suite
   **When** canonical render/export, packaged install, coexistence, idempotency, security, and performance fixtures run
   **Then** all contract fixtures pass, the second projection is zero bytes, no secret finding occurs, and SessionStart meets its two-second p95 budget
   **And** a read-only live compatibility check, if run, never substitutes for isolated evidence or mutates operator data.

## Epic 5: Close Agent Sessions with Durable Evidence

Jarad can end a supported agent session without delay and later find one recoverable, evidence-grounded Session Capture plus current derivatives of eligible changed documentation, even when remote service or summarizer work fails and retries occur.

### Story 5.1: Prospectively Admit or Refuse One Capture at True SessionEnd

As a coding agent ending a supported session,
I want close handling to deduplicate, validate, and either durably admit one logical capture or refuse it truthfully within budget,
So that agent shutdown remains usable without silently discarding prior recovery evidence or overstating what was captured.

**Requirements:** FR-12; NFR-2, NFR-3, NFR-4, NFR-5, NFR-7, NFR-9; AR-14, AR-29, AR-30, AR-32, AR-33, AR-35, AR-46, AR-47.

**Acceptance Criteria:**

1. **Given** the same canonical project, client, and nonempty Claude session ID used at SessionStart
   **When** true `SessionEnd` invokes `pj notebook hook session-close`
   **Then** it derives the identical session key and lowercase-hex receipt/capture IDs from exact UTF-8 `pjangler-receipt-v1\0<session_key>` and `pjangler-capture-v1\0<session_key>` inputs
   **And** no decoded-hash substitution, JSON framing, or raw client session ID is persisted.

2. **Given** an enabled capture policy and the bounded per-project admission lock
   **When** SessionEnd evaluates the fixed receipt path
   **Then** a valid existing same-session receipt is deduplicated before any admission accounting and consumes no new count or bytes
   **And** duplicate close never grants a retry; a malformed or mismatched same-ID entry instead takes the preserving `state-integrity` path.

3. **Given** no same-session receipt and a receiptless baseline created at time `T`
   **When** SessionEnd compares `now` with `T + receiptless_session_retention_seconds`
   **Then** replay is eligible only while `now` is strictly before that boundary
   **And** equality is expired: under the same lock only unreferenced baseline/Overview claim/refusal metadata may be pruned or ignored before normal missing-baseline handling, while any receipt or mutation-journal reference protects the baseline regardless of age.

4. **Given** an eligible new-session candidate after the expiry check
   **When** SessionEnd serializes it
   **Then** `candidate_bytes` is the exact UTF-8 length of the canonical queued-receipt JSON plus one trailing line feed, using the bytes intended for exclusive creation
   **And** admission occurs only when `current_unresolved_count + 1 <= max_count` and `current_unresolved_bytes + candidate_bytes <= max_bytes`, with succeeded receipts excluded from both unresolved measures.

5. **Given** an invalid, unreadable, or non-regular entry prevents exact count or byte proof
   **When** SessionEnd reaches integrity proof
   **Then** `state-integrity` takes precedence, preserves every suspect entry, creates no receipt or refusal marker, invokes no worker/network/Git-diff/upload/summarizer work, and exits 0
   **And** its bounded diagnostic reports nullable exacts, numeric lower bounds, unmeasurable count, safe relative/digested entry evidence, and exact local audit plus in-place repair/re-run actions.

6. **Given** exact measurement proves the real candidate would exceed the count cap, byte cap, or both
   **When** admission is refused
   **Then** no receipt or worker is created and no network, Git diff, document read/upload, or summarizer port is called
   **And** one bounded `RetentionRefusalV1` keyed by the lowercase-hex hashed `session_key` is atomically created or replaced with immutable baseline time, refusal time, exact reason, current usage, actual candidate bytes, both caps, and exact `capture list`/`capture retry` recovery actions; the hook states that this session was not captured and exits 0 within the foreground budget.

7. **Given** a refused session is delivered again strictly before grace expiry
   **When** current state is re-evaluated under the same lock
   **Then** it reuses the unchanged baseline and real candidate, replaces the same marker without extending grace if still blocked, or exclusive-creates/fsyncs one receipt and removes the marker before worker spawn when both gates pass
   **And** crash-safe receipt dedupe ignores/removes a shadowed marker, while a close after eligible cleanup follows normal missing-baseline behavior and never infers provenance.

8. **Given** missing/empty session identity, disabled project/capture policy, or missing/incomplete baseline
   **When** SessionEnd evaluates the event
   **Then** disabled work exits 0 without enqueue and missing evidence follows the admitted `blocked-missing-baseline` recovery path where identity permits
   **And** no mtime, reflog, current HEAD, or pre-existing uncommitted identity is guessed.

9. **Given** normal, duplicate, refusal, integrity, and injected slow/failure fixtures
   **When** SessionEnd foreground timing is sampled
   **Then** every path returns within 250 milliseconds p95 on the target workstation and admitted work is durable before spawn
   **And** all integration failures and not-captured outcomes remain bounded, exit 0, and leave agent shutdown usable.

### Story 5.2: Process Receipts with a Recoverable Leased Worker

As a project operator,
I want capture work claimed and retried through durable leases,
So that crashes and concurrent workers converge without duplicate processing or abandoned receipts.

**Requirements:** FR-12, FR-14; NFR-2, NFR-4, NFR-5, NFR-7, NFR-9; AR-10, AR-32, AR-33, AR-34, AR-35, AR-46.

**Acceptance Criteria:**

1. **Given** a queued receipt
   **When** SessionEnd starts the detached worker
   **Then** it uses `process.execPath`, a fixed argv array, `shell:false`, ignored stdio, detached/unref, and receipt ID only
   **And** no user content, credential, diff, transcript, or environment dump appears in argv.

2. **Given** one or more workers race for a receipt
   **When** lease acquisition occurs
   **Then** compare-and-swap state permits exactly one live lease owner and atomically advances `queued` to `processing`
   **And** another worker cannot process a nonexpired lease.

3. **Given** a processing worker crashes or its lease expires
   **When** recovery runs
   **Then** work requeues only within the configured finite attempt budget
   **And** exhausted work becomes `retry-exhausted` instead of looping indefinitely.

4. **Given** retryable failure, nonretryable/blocked missing baseline, successful completion, or explicit retry after correction
   **When** the state machine advances
   **Then** only the documented queued/processing/failed/retry-exhausted/blocked-missing-baseline/succeeded transitions occur
   **And** state, timestamps, counters, categories, lease metadata, exclusions, and note IDs update atomically.

5. **Given** a Capture Receipt on disk
   **When** its schema and permissions are inspected
   **Then** it contains only safe project/session-key identity, baseline/end revision/status digest, attempts, lease/outcome, exclusion counts, stable note IDs, and bounded diagnostic
   **And** it contains no raw client session ID, transcript, diff, source/note body, auth, full environment, or vendor response.

6. **Given** remote note creation during processing
   **When** a crash occurs before dispatch, after dispatch, after response, after ownership index update, or before journal commit
   **Then** `RemoteMutationJournalV1` plus receipt/ownership state reconciles to one stable note
   **And** a restart never blind-creates a duplicate.

7. **Given** retention processing
   **When** receipts age
   **Then** only a `succeeded` receipt whose configured `updated_at + receipt_succeeded_retention_days` has elapsed may expire
   **And** queued, processing, failed, retry-exhausted, blocked-missing-baseline, unresolved journals, and every baseline they reference remain visible indefinitely and are never automatically deleted, silently compacted, dismissed, or truncated to satisfy aggregate admission caps; no runtime state is written into the repository.

### Story 5.3: Inspect and Explicitly Recover Capture State

As a PJangler operator,
I want to list capture outcomes and explicitly retry recoverable work,
So that background failures never disappear or require hand-editing state files.

**Requirements:** FR-5, FR-12, FR-14, FR-15; NFR-4, NFR-5, NFR-7, NFR-9; AR-18, AR-19, AR-20, AR-35, AR-40, AR-46, AR-47.

**Acceptance Criteria:**

1. **Given** receipts in multiple states
   **When** `pj notebook capture list` runs with optional state filter
   **Then** it returns bounded summaries sorted by created time descending then receipt ID ascending with opaque deterministic pagination
   **And** summaries expose retryability/next action without bodies, raw session IDs, credentials, or unsafe absolute paths.

2. **Given** no matching receipts
   **When** capture list runs
   **Then** it succeeds with an empty collection
   **And** status and audit unresolved totals agree with the same state source without treating a refusal marker as a receipt.

3. **Given** a `failed` or `retry-exhausted` receipt after operator correction
   **When** `pj notebook capture retry RECEIPT_ID` is invoked
   **Then** direct invocation authorizes exactly one compare-and-swap attempt on that same receipt, increments manual retry provenance, sets operator origin, and never creates a second receipt or session-capture identity
   **And** failure returns directly to `retry-exhausted` with no automatically scheduled loop; duplicate SessionEnd, status, audit, or worker restart cannot grant that operator attempt.

4. **Given** `blocked-missing-baseline`
   **When** retry is invoked without `--baseline`
   **Then** it remains blocked with the exact explicit-baseline next action
   **And** when a contained valid committed Git ref is supplied, that ref is recorded safely and the same receipt receives one operator-origin attempt that compares committed evidence only, excludes unknowable pre-existing uncommitted paths observably, and remains blocked if no trustworthy evidence remains.

5. **Given** invalid receipt ID, foreign-project receipt, malformed state, invalid Git ref, or a receipt already `queued`, `processing`, or `succeeded`
   **When** retry validates
   **Then** it returns the correct invalid-input, not-found, cross-project, conflict, or internal outcome before worker spawn
   **And** no foreign or in-flight receipt is modified.

6. **Given** JSON mode
   **When** list or retry returns
   **Then** exact `CaptureReceiptSummaryV1` list/retry schemas validate in one pure envelope
   **And** human and JSON next actions use the same categorized state.

7. **Given** one or more active `RetentionRefusalV1` markers
   **When** status or audit recomputes each stored real candidate against exact current usage and current caps
   **Then** a still-failing predicate emits bounded `retention-pressure` with current usage, both caps, actual candidate bytes, and exact `pj notebook capture list` then `pj notebook capture retry` recovery actions
   **And** a now-fitting marker remains only as informational `capture-refused-history` until SessionEnd replay admits/removes it or grace cleanup prunes it; it never appears in `capture list` as a receipt or state.

8. **Given** any capture state or operator command surface in v1
   **When** help, parsing, transition, audit, migration, rollback, and retention behavior are inspected
   **Then** only `capture list` and one-attempt `capture retry` recovery are exposed
   **And** there is no dismissal command, hidden dismissal transition, automatic unresolved deletion, or silent compaction path.

### Story 5.4: Select Eligible Documents from Git Evidence Safely

As a project operator,
I want capture to consider only policy-eligible documentation changed during the session,
So that durable knowledge stays relevant without exporting code, secrets, or unrelated files.

**Requirements:** FR-13; NFR-4, NFR-5, NFR-6, NFR-9, NFR-10; AR-32, AR-36, AR-37.

**Acceptance Criteria:**

1. **Given** a complete recorded start baseline and bounded close-time Git state
   **When** the worker computes changed paths
   **Then** it uses NUL-delimited machine Git output with no shell interpolation and compares baseline-to-close version-control evidence
   **And** modification time alone never makes a file eligible.

2. **Given** default policy
   **When** candidates are selected
   **Then** only tracked changed `**/*.md` and `**/*.mdx` regular files are eligible
   **And** configured globs may narrow that set but cannot override security exclusions or hard ceilings.

3. **Given** ignored, untracked-by-default, generated, binary, oversized, disallowed, unchanged, traversal, absolute, symlink-escaping, submodule-boundary, device, FIFO, socket, or other non-regular candidates
   **When** filtering runs
   **Then** each is excluded before summarizer or service access with a bounded reason code/path digest
   **And** no excluded body enters memory beyond what its specific safety check requires.

4. **Given** secret-like content or path fixtures
   **When** secret screening runs
   **Then** the file is excluded before prompt construction or remote upload
   **And** only the safe reason/path digest—not matched text—is stored or emitted.

5. **Given** eligible documents and other changed paths
   **When** evidence is assembled
   **Then** eligible evidence contains bounded content plus repository-relative path/revision-or-digest IDs while other changes contribute names only
   **And** every path resolves within the physical canonical repository and current binding.

6. **Given** a missing/incomplete baseline or end-evidence failure
   **When** eligibility cannot be proven
   **Then** automatic document upload remains blocked or the receipt fails with a retryable categorized outcome as appropriate
   **And** no partial list is treated as complete evidence.

7. **Given** a tracked Eligible Document was already dirty at SessionStart
   **When** its close-time content identity matches the recorded start identity or proves an additional in-session change
   **Then** the unchanged pre-session dirt is excluded from attribution, while only the additionally changed identity is eligible with start/end provenance
   **And** neither current worktree state nor modification time is substituted for the recorded pre-dirty baseline.

8. **Given** recovery uses an explicit manual `--baseline GIT_REF`
   **When** document evidence is selected
   **Then** comparison is limited to that validated contained committed reference
   **And** paths whose pre-existing uncommitted start identity is unknowable are excluded with a bounded reason; if no trustworthy evidence remains, the same receipt stays `blocked-missing-baseline`.

### Story 5.5: Upsert Provenance-Bearing Document Derivatives

As a project operator,
I want changed eligible documents mirrored as stable notebook derivatives,
So that searchable context stays current while Git remains the authoritative source.

**Requirements:** FR-13, FR-19, FR-20; NFR-4, NFR-5, NFR-6, NFR-9; AR-10, AR-14, AR-16, AR-17, AR-37.

**Acceptance Criteria:**

1. **Given** an eligible document
   **When** its derivative identity is created
   **Then** logical ID is the architecture's SHA-256 over version, project slug, and normalized repository-relative path
   **And** its envelope records project identity, source path, revision/content digest, AR-29's lowercase-hex hashed session key, capture time, and policy version, never the raw client session ID.

2. **Given** no existing matching document logical ID
   **When** the derivative is created
   **Then** scoped marker reconciliation and `RemoteMutationJournalV1` guard the POST
   **And** stable service note ID is recorded in ownership/receipt before journal commit.

3. **Given** one existing derivative with the same path and content digest
   **When** capture processes it again
   **Then** the operation is a no-op with no remote mutation
   **And** receipt provenance can reference the existing stable note.

4. **Given** one existing derivative with the same path but changed digest
   **When** capture applies
   **Then** the same remote note is updated in place with the new source document plus preserved managed identity/envelope
   **And** Git/source content itself is never rewritten.

5. **Given** duplicate logical IDs, unproven scoped membership, ambiguous dispatch, or a service failure
   **When** upsert cannot converge safely
   **Then** the operation conflicts/fails with a bounded categorized receipt outcome
   **And** no candidate is guessed, deleted, or written into another binding.

6. **Given** a captured derivative
   **When** security and provenance validation runs
   **Then** every required provenance field is complete and no credential, absolute path, ignored content, or generated/source-code body is present
   **And** search/read rendering strips the envelope from human excerpts while retaining machine identity.

### Story 5.6: Produce One Factual Session Capture with Deterministic Fallback

As a project operator reviewing completed work,
I want one concise capture grounded in changes and verification evidence,
So that the notebook records what actually happened without inventing success when a model is unavailable or overconfident.

**Requirements:** FR-14; NFR-2, NFR-4, NFR-5, NFR-7, NFR-9; AR-17, AR-34, AR-38, AR-39.

**Acceptance Criteria:**

1. **Given** eligible document evidence, other changed path names, bounded transcript metadata, verification evidence, and observed unresolved work
   **When** a configured low-cost summarizer is allowed
   **Then** PJangler invokes a trusted fixed executable/argv with allowlisted environment, bounded redacted stdin, `shell:false`, and finite timeout
   **And** no user content or credential becomes shell syntax, argv, or ambient environment leakage.

2. **Given** summarizer output
   **When** it is validated
   **Then** it conforms to `CaptureSummaryV1`, each factual statement cites supplied evidence IDs, and observed changes, verification, and unresolved work remain separate
   **And** deployment/success claims without corresponding verification evidence are rejected.

3. **Given** absent configuration, timeout, process error, malformed schema, missing citations, unsafe claim, or oversized output
   **When** summarization cannot be accepted
   **Then** deterministic fallback is selected without failing the capture solely because the model failed
   **And** it lists changed eligible documents, other path names, verification evidence, unresolved/uncommitted work, and an explicit insufficient-evidence statement.

4. **Given** the exact session capture logical ID derived from the session key
   **When** its note is reconciled/upserted
   **Then** zero candidates creates once under a journal, one updates/no-ops the same stable note, and multiple candidates conflict
   **And** repeated worker/retry delivery never creates a second logical Session Capture.

5. **Given** all document and session-note upserts succeed
   **When** the worker finalizes
   **Then** the receipt atomically becomes `succeeded` with safe note IDs, exclusion counts, and summary mode
   **And** service/summarizer failure instead records bounded failed/retry state without changing source files or blocking the already-ended agent session.

6. **Given** the final session note
   **When** content is inspected
   **Then** its managed envelope records project/session identity and safe provenance while the human body contains only bounded evidence-grounded summary
   **And** it contains no raw transcript, credential, full diff, unsupported deployment claim, or unrelated project data.

### Story 5.7: Prove Capture Safety, Recovery, Performance, and Quality

As a PJangler operator deciding whether to enable session capture by default,
I want staged evidence across failures, retries, and real session-like samples,
So that default-on behavior is gated by trustworthy provenance and measurable factual quality.

**Requirements:** FR-12, FR-13, FR-14, FR-15; NFR-2 through NFR-10; AR-35 through AR-47.

**Acceptance Criteria:**

1. **Given** isolated HOME/XDG/Registry, generated repositories, and fake service/summarizer fixtures
   **When** duplicate close, concurrent admissions/workers, worker crash/restart, expired lease, every remote journal crash point, service/model outage, bounded retry, and explicit recovery scenarios run
   **Then** each session converges on at most one receipt, one session capture, and one derivative per logical document path
   **And** source repositories and production operator data remain untouched.

2. **Given** missing/empty session ID, missing/incomplete baseline, duplicate SessionStart/SessionEnd, unsupported client/Stop, and all start/capture policy combinations
   **When** lifecycle tests run
   **Then** exact session identity, baseline preservation, blocked-missing-baseline recovery, fail-open exit, and no-work cases match the architecture
   **And** no per-turn event triggers a session capture.

3. **Given** ignored/untracked/generated/binary/traversal/symlink/submodule/device/secret/oversized/malicious path and payload fixtures
   **When** eligibility, summarization, output, receipts, and service calls are scanned
   **Then** every exclusion is bounded/observable and zero raw credential/body disclosures or path escapes occur
   **And** zero cross-project note results or mutations occur.

4. **Given** supported SessionStart/SessionEnd hooks under healthy and injected slow/failure loads
   **When** foreground timings are measured
   **Then** SessionStart meets two seconds p95 and every SessionEnd dedupe, admitted enqueue, retention refusal, or integrity-refusal path meets 250 milliseconds p95
   **And** 100% of injected integration failures leave the agent session usable.

5. **Given** at least 20 staged Session Captures spanning changed docs, no-op sessions, fallback summaries, failed verification, and retry/restart cases
   **When** quality evidence is audited
   **Then** 100% of synchronized derivatives have complete path/digest/session provenance, at least 95% of factual claims trace to diff or verification evidence, and zero unsupported deployment/success claims appear
   **And** note volume, prompt size, cosmetic freshness, and local-only green status are not counted as success.

6. **Given** the full generated-project journey with packed CLI and canonical hooks
   **When** init, binding, CRUD/search, SessionStart, SessionEnd, audit/migrate, retry, and second-run scenarios execute
   **Then** all contract fixtures pass 100%, one healthy binding is achieved under two minutes, retries/migration add zero logical duplicates, and repeated owned projections/migrations change zero bytes
   **And** the developer Skillex checkout and all production endpoints are unavailable to the fixture.

7. **Given** the staged quality gate has not passed
   **When** rollout policy is evaluated
   **Then** capture remains explicit per-project opt-in and no fleet-wide default enable occurs
   **And** after evidence passes, rollout still follows one-canary incremental enablement with non-destructive rollback.

8. **Given** count-cap, byte-cap, both-cap, equality-boundary, and concurrent distinct-session fixtures
   **When** SessionEnd performs locked admission
   **Then** same-session receipt dedupe occurs before accounting, the exact canonical queued JSON plus trailing-LF byte cost drives both prospective inequalities, and succeeded receipts are excluded from unresolved totals
   **And** every genuine cap refusal creates no receipt, starts no worker, calls no network/Git-diff/upload/summarizer port, says the session was not captured, and records the exact bounded hashed marker/actions.

9. **Given** start-only, repeated-refusal, replay, marker-shadow, close-versus-prune, and referenced-baseline fixtures
   **When** time is strictly before or exactly at `created_at + receiptless_session_retention_seconds`
   **Then** replay before the boundary reuses one immutable baseline, continued refusal replaces one marker without extending grace, successful admission removes it, and equality is expired
   **And** cleanup prunes only unreferenced receiptless baseline/claim/refusal state while every receipt- or journal-referenced baseline survives regardless of age; a post-prune close never invents provenance.

10. **Given** recovery reduces unresolved usage below both caps without replaying the refused close
    **When** status and audit run read-only
    **Then** they emit no `retention-pressure` for a now-fitting stored candidate while retaining bounded informational `capture-refused-history` in `active_refusals`
    **And** a later in-grace close replay admits one receipt and removes the marker; neither command synthesizes candidate bytes for an absent session or mutates state.

11. **Given** invalid, unreadable, and non-regular receipt-state fixtures
    **When** hook, status, audit, migration, and repair/re-run paths execute
    **Then** `state-integrity` precedes pressure with matching null exacts, numeric lower bounds, unmeasurable counts, safe evidence/actions, no receipt/refusal/worker/slow work, and preservation of every suspect entry
    **And** fixtures also prove succeeded-only expiry, indefinite unresolved/reference preservation, one operator-authorized same-receipt attempt with no automatic loop, explicit committed-ref recovery limits, and the complete absence of dismissal behavior.
