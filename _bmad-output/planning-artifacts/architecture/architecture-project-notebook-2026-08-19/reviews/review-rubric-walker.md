# BMAD Architecture Rubric Walk — PJangler Project Notebook

## Verdict

**READY-WITH-FIXES.** The spine is unusually complete and mechanically clean, but five load-bearing rules still permit incompatible epic implementations or weaken an explicit acceptance outcome. These are architecture-artifact findings, not evidence that implementation exists or fails.

Deterministic linter: **PASS**, 0 findings.

## Major findings

### RW-1 — Ambiguous create safety has no durable owner or persisted guard

- **Evidence:** `AD-6 — Stable marker reconciliation, never name identity` (spine lines 83–87) forbids another POST after a possibly-dispatched create, including across later calls. `Registry and Manifest contract` (lines 304–365) persists only binding state/IDs/name, while `Session baseline, receipt, and worker state` (lines 590–631) reserves XDG journals for sessions, claims, receipts, and note ownership. No schema records an armed/potentially-dispatched notebook or note create attempt.
- **Why major:** After process death or a timeout before Registry persistence, a new process cannot distinguish “never dispatched” from “possibly created but not yet list-visible.” One epic can retry POST while another blocks forever; either choice violates CAP-1/CAP-5's deterministic recovery contract.
- **Exact fix:** Add one owned, durable `RemoteCreateAttemptV1` journal and state machine for both notebook and note creates. Arm and fsync it before dispatch; record operation kind, project key, deterministic marker/logical ID, safe timestamps, and dispatch classification; clear it only after zero/one/many reconciliation reaches a proved outcome. Bind reconcile/create, status/audit, migration, retention, and the operator recovery next action to this journal. State explicitly that Registry remains last and that an armed attempt survives fresh-target failure.

### RW-2 — The brownfield `ProjectRecipe` seam does not bind sync invocation or the existing rollback guard

- **Evidence:** `AD-2` and `Dependency and lifecycle placement` (lines 59–63 and 278–303) show `ProjectRecipe` invoking `NotebookRecipe` as a dependency without a create/sync rule. `AD-3` and `Apply transaction and recovery` (lines 65–69 and 496–550) require recovery evidence after remote dispatch, but do not explicitly retire the current fresh-target rollback behavior once the external boundary is entered.
- **Why major:** Current code invokes dependencies only for fresh create and unconditionally removes a newly created target on later transaction failure. Merely adding `notebook` to `metadata.dependencies` therefore misses re-init/sync, and a post-dispatch failure can erase the Manifest evidence needed to adopt an orphaned remote object.
- **Exact fix:** Amend AD-2/AD-3 with two enforceable brownfield rules: (1) invoke Notebook lifecycle on create **and** sync/re-init without causing every existing dependency to run on sync—name the dedicated dispatch seam; (2) track `externalBoundaryEntered`/armed create state and prohibit fresh-target deletion after any remote operation is armed or dispatched. Require regression tests for sync re-init and failure at every post-dispatch point.

### RW-3 — Required Overview seed content and Overview Drift proof are absent

- **Evidence:** `Note model and local search` (lines 387–411) fixes Overview identity but not its required project identity, purpose placeholder, authoritative-document links, or source digests. `Global skill and hook projection topology` (lines 553–588) emits fetched Overview content, and `Audit and migration inventory` (lines 657–670) validates membership/envelope/bounds, but no rule compares referenced authoritative documents with current Git evidence.
- **Why major:** The acceptance contract requires the default Overview content and requires the next supported session to surface Overview Drift when referenced authoritative documents change. Two teams could ship a stable but permanently stale Overview and still satisfy the current spine.
- **Exact fix:** Define an `OverviewDescriptorV1` compiler/envelope field set: canonical project identity, purpose placeholder, normalized repository-relative authoritative references, and digest/revision captured at Overview write. On SessionStart, after baseline capture and before emitting context, recompute those references under Git/containment bounds; emit a labeled Drift warning and computed `drifted` status rather than silently presenting stale context. Add this proof to `notebook.overview-note` audit/migrate and generated-project/hook fixtures.

### RW-4 — Baseline capture is not explicitly independent of Overview-read policy

- **Evidence:** `AD-15 — Baseline precedes Overview and close only enqueues` (lines 137–141) begins “After enabled binding/policy resolution” and then records baseline before fetch. The topology/runtime rules (lines 553–615) do not say what happens when `session_start_enabled=false` while `session_capture_enabled=true`.
- **Why major:** The two policies are independently configurable. An implementation may reasonably skip the entire SessionStart handler when Overview priming is disabled, causing every later capture to become `blocked-missing-baseline`, contrary to FR-11's requirement to record a baseline even when Overview retrieval is disabled.
- **Exact fix:** Split SessionStart into two gates: for an enabled project, record the bounded trustworthy baseline whenever either session capture or priming needs it; only the remote Overview read/emission is gated by `session_start_enabled`. If baseline limits/deadline prevent completeness, persist an explicit incomplete status and make capture block rather than truncate silently. Add the policy matrix `(start off, capture on)`, `(start on, capture off)`, and both off to hook tests.

### RW-5 — The managed-note envelope excludes public user-created notes

- **Evidence:** `AD-9` (lines 101–105) requires **every** PJangler-created note to carry `PjanglerNoteEnvelopeV1`. `Note model and local search` (lines 387–405) permits only `overview`, `document`, and `session-capture` kinds, while `Public CLI grammar` (lines 412–444) exposes `pj notebook add note` and update for ordinary notes. The adapter text also claims note-create ambiguity handling without defining an ordinary-note logical identity.
- **Why major:** The CLI and note-domain epics cannot both comply: ordinary add either violates AD-9, invents a fourth kind/identity, or incorrectly deduplicates by title/content. Possible-dispatch recovery for an ordinary note is likewise undefined.
- **Exact fix:** Add a `user-note` kind and define its logical operation identity and marker-preservation rules. Generate the operation identity before dispatch, carry it through RW-1's durable attempt journal, reconcile by that identity, and preserve it on update. State whether two intentional identical adds are distinct. Add create-timeout, retry, update, marker-tamper, and foreign/manual unmarked-note fixtures.

## Rubric disposition

| Rubric item | Result | Note |
| --- | --- | --- |
| Mechanical spine contract | PASS | Linter reports no placeholders, duplicate IDs, missing decision fields, or unpinned Stack rows. |
| Decision integrity | FIX | RW-1, RW-4, and RW-5 need enforceable state/identity rules. |
| CAP-1 through CAP-8 coverage | FIX | Broad mapping is present; Overview Drift/default content and durable ambiguity recovery are not closed. |
| Dependency direction | PASS | Hexagonal inward dependency rule and adapter prohibitions are explicit and coherent. |
| Brownfield reality | FIX | The code's create-only dependency dispatch and unconditional fresh-target rollback need named changes (RW-2). |
| Build-substrate sufficiency | FIX | Five remaining seams allow incompatible epic choices. |
| Security/isolation | PASS | Runtime-only auth, scoped membership proof, URL bounds, no-follow state, and content exclusions are explicit; this is design evidence only. |
| Operability/recovery | FIX | Receipts and rollout are strong; remote-create uncertainty needs durable recovery ownership (RW-1). |
| Testability | PASS | Fake-service, backend, packaged CLI, hook coexistence, restart, security, and generated-project gates are extensive; tests are specified, not yet proven. |
| Deferred boundaries | PASS | Deferred scope is explicit and generally safe; none of the five findings belongs in Deferred. |
| Operational/environmental envelope | PASS | Isolated tests, canary, workstation state, live-service boundary, rollout, and non-destructive rollback are covered. |

## Counts

- Blocker: 0
- Major: 5
- Minor: 0

**Final verdict: READY-WITH-FIXES.** Apply RW-1 through RW-5 and rerun the deterministic linter plus all independent reviewer lenses before setting `status: final`.

## Final recheck

- **RW-1 — RESOLVED:** AD-6/AD-16 and the state topology now bind crash-safe `RemoteMutationJournalV1`, dispatch arming, reconcile-only uncertainty, durable commit points, and visibility.
- **RW-2 — RESOLVED:** AD-2 names the create+sync `runNotebookLifecycle` seam; AD-3 binds one ordered external plan, one Registry-last finalizer, and the post-dispatch rollback latch.
- **RW-3 — RESOLVED:** `OverviewDescriptorV1` now binds required seed content, authoritative reference digests, SessionStart Drift warning, audit/migration, and fixtures.
- **RW-4 — RESOLVED:** AD-15 explicitly records the baseline when either priming or capture is enabled, gates only Overview contact, preserves the first baseline, and blocks incomplete evidence.
- **RW-5 — RESOLVED:** AD-9 now defines `user-note`, per-operation UUID identity, journal-backed retry, intentional duplicate semantics, and marker preservation.
- **Regression check:** The revised rules remain internally aligned with the capability map, verification matrix, rollout, and resolution ledger. No new blocker or major finding was introduced. This is architecture validation, not implementation proof.

**Final recheck verdict: READY — 0 unresolved blockers, 0 unresolved majors.**
