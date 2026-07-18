---
title: 'PJAN-27 Complete pjangler Project Lifecycle Surface'
type: 'feature'
created: '2026-07-18'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/skills/project-jangler/SKILL.md'
warnings:
  - multiple-goals
  - oversized
---

<intent-contract>

## Intent

**Problem:** Pjangler can plan and apply local registry/CommonProject initialization, but it has no real GitHub-repository ensure, local-repository link, Plane-board ensure, or end-to-end project-create contract. CLI and MCP wrappers also diverge in targeting, errors, safety, and receipts, leaving Toad unable to remain a pure identity/judgment/orchestration layer.

**Approach:** Add one injected, deterministic lifecycle core that owns planning, preflight, execution, convergence, verification, typed failures, compensation guidance, and `ProjectLifecycleReceipt v1`. Expose that same core through four canonical CLI/MCP operations while retaining existing init/list/show/doctor compatibility and enforcing one pjangler-owned live-action gate everywhere an existing or new surface can reach an external mutation.

## Boundaries & Constraints

**Always:** Pjangler owns deterministic GitHub, mutating-git, registry/scaffold, Plane, and Hermes lifecycle operations; Toad owns identity, memory, judgment, ProjectIntent synthesis, approval dialogue, and semantic interpretation. Every new operation defaults to dry-run. A mutation-capable path requires both an explicit live request and `PJANGLER_ALLOW_LIVE=1`; `--yes`, interactivity, `local=false`, `apply=true`, or a skip flag may never substitute for either factor. Run and report every preflight before the first mutation, stop on the first execution failure, return one stable machine-readable result envelope, preserve pre-existing resources and unrelated work, and make same-input reruns converge without duplicates. CLI and MCP are adapters over the same core. Tests use injected fakes or loopback/temp fixtures and never contact live GitHub, Plane, the user's registry, or host services.

**Block If:** Implementation would require a destructive registry migration/backfill, automatic deletion or remote replacement, a real external/host mutation to verify behavior, a Toad implementation change, or a release/install/publish step. At runtime, represent resource collisions, dirty/unsafe local state, missing dependencies/auth, and identity mismatches as typed blocked results with zero mutations; do not choose a destructive interpretation.

**Never:** Do not publish, release, tag, globally install, push from the implementation worktree, create or mutate live GitHub/Plane resources, mutate host configuration/systemd/Bloodbank, mutate an external registry, retire or edit Toad surfaces, bump package or registry schema versions, auto-replace a mismatched `origin`, auto-delete/rollback resources, stage unrelated files, or overwrite unrelated work. Keep `package.json` at `1.2.19`; restrict verification mutations to temp directories, fake providers, loopback servers, and isolated scratch fixtures.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Default dry-run | Any primitive or composite call with `live` omitted/false | Return the full ordered plan, preflight rows, planned action effects, and a receipt-shaped projection; perform no local or external mutation | Missing prerequisites are reported together as typed blockers while the plan remains inspectable |
| Live gate denied | `live=true`, but `PJANGLER_ALLOW_LIVE` is absent or not exactly `1` | No mutation adapter is called; overall status is `blocked` | `LIVE_GATE_REQUIRED`; CLI nonzero and MCP `isError: true` |
| GitHub repo absent | Allowed org + name not found and preflight passes | Dry-run plans create; fake/live execution creates once and returns canonical repo URL/identity with effect `created` | Provider failure stops execution and returns typed provider error |
| GitHub repo present | Same org/name exists | Matching fields return effect `reused`; description/visibility drift plans and, only in authorized live execution, applies an update with effect `updated` | Inaccessible/ambiguous state is blocked; never infer “not found” from auth failure |
| Local directory absent/new | Composite owns a new target | Scaffold/provision local content first; link last so the initial commit contains only files created/reported by this run, then push only in authorized live execution | Failure retains partial evidence and manual compensation guidance; no automatic removal |
| Existing local repo, correct remote | Clean repo with `origin` normalized to the requested host/org/name | Reuse Git metadata; do not replace remote; push current/generated commit only when authorized; rerun is `reused`/no-op | A pre-existing dirty tree blocks composite before any mutation; standalone link never stages unrelated files |
| Existing local repo, missing remote | Clean repo, no `origin` | Plan/add `origin`; preserve all other remotes | Failure is typed and nonzero/`isError` |
| Existing local repo, wrong remote | `origin` resolves to another repository after normalizing SSH/HTTPS and optional `.git` | Zero mutation; report expected and observed normalized identities | `REMOTE_MISMATCH`; never call `remote set-url` automatically |
| Unsafe initial commit | Standalone link targets a non-empty directory with no `HEAD`, or composite target existed dirty | Zero mutation | `UNSAFE_INITIAL_COMMIT` or `DIRTY_WORKTREE`; caller must make state safe explicitly |
| Plane board absent | Provider `plane`, workspace exists, identifier/name unused | Dry-run plans create; authorized execution creates once and returns board ID with effect `created` | Missing key, auth, workspace, or connectivity is a preflight blocker |
| Plane board present | One board matches workspace + case-insensitive identifier and expected name | Reuse and return its board ID; description-only drift may converge with effect `updated` | Same identifier with another name, same name with another identifier, or conflicting explicit board ID returns `PLANE_BOARD_CONFLICT` with zero mutation |
| Existing project rerun | Registry, remote, repo, board, and requested agents already match | Return the same canonical IDs, effects `reused`, no changed files, and successful verification | Any cross-surface mismatch is reported, not overwritten silently |
| Preflight failure | Any required binary/template/path/registry/credential/auth/workspace check fails | Return all failed preflight rows and mark every action `not_run`; zero mutations across all adapters | Overall `blocked`; CLI nonzero and MCP `isError: true` |
| Partial execution failure | One or more actions mutated state before a later action fails | Stop immediately; mark later actions `not_run`; return confirmed IDs/evidence plus guidance only for actions changed by this invocation | Overall `partial`; never compensate automatically; CLI nonzero and MCP `isError: true`; rerun remains safe |

</intent-contract>

## Code Map

- `src/project/index.ts` -- Current synchronous project plan/apply core, registry/manifest types, local idempotency comparisons, and Copier execution; ticket-provider and Hermes actions are placeholders.
- `src/project/RegistryStore.ts` -- Existing async YAML/PG storage seam; YAML is live-code authority, PG is optional, and persisted PG UUIDs are currently discarded from public records.
- `src/project/lifecycle/types.ts` -- New canonical inputs, plans, error/status vocabulary, action/preflight rows, compensation records, and receipt/result schemas.
- `src/project/lifecycle/providers.ts` -- New injected command/filesystem/GitHub/git/Plane/registry/Hermes/clock/UUID boundaries plus production adapters; tests substitute fakes.
- `src/project/lifecycle/index.ts` -- New sole planner/executor for the four lifecycle operations, live permit, aggregate preflight, dependency ordering, convergence, compensation guidance, and final verification.
- `src/index.ts` -- Commander surface; current `init`/deprecated `project init` share `runProjectInit`, while lifecycle commands do not yet exist.
- `src/mcp-server.ts` -- MCP registration and text-JSON response adapter; current bootstrap duplicates orchestration and can reach Hermes external side effects without the canonical gate.
- `tests/project-registry-regressions.mjs` -- Existing temp-dir CLI coverage for dry-run, apply ordering, failures, and local rerun idempotency.
- `tests/mcp-catalog-regressions.mjs` -- Existing source-level MCP catalog assertion.
- `tests/mcp-server-regressions.mjs` -- Existing real stdio MCP integration harness using a temp registry.
- `package.json` -- Builds both shipped entrypoints and defines the full regression suite; version stays `1.2.19`.
- `mise.toml` -- Existing canonical `build` and `typecheck` tasks; release/publish/version tasks are out of scope.

## Tasks & Acceptance

**Execution:**

- `src/project/lifecycle/types.ts` -- Define the exact shared camelCase inputs listed in Design Notes and a versioned snake_case output contract: `LifecycleResultV1 { schema_version, operation, ok, status, dry_run, live, preflight, actions, errors, compensations, receipt }`. Use overall statuses `planned | succeeded | blocked | partial | failed`; `ok` is true only for `planned` and `succeeded`. Preflight rows are `{ id, status: passed | failed | skipped, message, details? }`. Action rows are `{ id, kind, status: planned | succeeded | failed | not_run, effect: none | created | updated | reused, resource?, error? }`. Errors contain stable `code`, safe `message`, optional `action_id`, `retryable`, and structured details. Compensations are `{ action_id, effect, automatic: false, guidance }` and never include secrets. `ProjectLifecycleReceipt v1` contains `project_id`, `repo_id`, `slug`, `name`, `repo_url`, `local_path`, `visibility`, `github_org`, `ticket_provider`, `board_id`, `agent_ids`, pass-through `source_context_refs`, `related_projects`, `operator_decisions`, and `verification_evidence[{ surface, status, observed }]`. Dry-run/primitive fields may be null; successful live composite receipts require non-null canonical project/repo/repo-URL/board identities and requested agent IDs.
- `src/project/RegistryStore.ts` and `src/project/index.ts` -- Add backward-compatible optional `project_id`/`repo_id` UUID identity to `ProjectRecord`, preserve it across planning/reruns, expose identity lookup/upsert results from YAML and PG stores, and round-trip existing PG row IDs. Allocate missing IDs through the injected UUID seam for a new lifecycle record, reuse existing IDs, and block contradictory YAML/PG identities rather than rewriting them. Keep YAML authority, schema version 1, existing registry/list/show/doctor/init behavior, atomic YAML writes, and the slug-NULL PG ownership boundary; do not perform a migration/backfill or make PG mandatory.
- `src/project/lifecycle/providers.ts` -- Implement narrow injected adapters. The GitHub adapter uses argv-based `gh` calls and distinguishes not-found from auth/permission failures. The git adapter normalizes SSH/HTTPS/`.git` repository identity, never shells through interpolated strings, never replaces mismatched `origin`, and stages only core-reported owned files. The Plane adapter supports only `plane`, resolves base by `PLANE_BASE_URL` then `PLANE_BASE` then `https://plane.delo.sh`, and key by `PLANE_API_KEY` then the legacy `PLANE_33GOD_API_KEY`, using `X-API-Key`; it searches before creating/updating. Registry and Hermes adapters wrap existing pjangler operations and return structured IDs/evidence rather than console-log inference. Mutation methods require an unforgeable live permit issued only by the lifecycle core.
- `src/project/lifecycle/index.ts` -- Validate the allowed GitHub orgs (`AutomaticAI-io`, `delorenj`, `IntelliForia`), visibility (`public`, `private`), provider (`plane`), names/slug/identifier/paths, and mutually consistent existing identities. Produce deterministic plans without writes. Aggregate complete preflight for live gate, target safety, `git`, `gh` and auth/org access, Copier/template, registry parse/write capability, Plane key/auth/workspace, and requested Hermes roles before issuing a permit or mutation. Implement primitive ensure/link convergence and composite execution in dependency order: GitHub ensure → Plane ensure → project init/scaffold + bound registry/manifest → requested PM/sentinel provisioning → local repo link/owned commit/push → final re-read verification. Stop on first execution failure, never auto-rollback, emit manual compensation only for effects created/updated by this invocation, and prefer rerun as the primary recovery path.
- `src/index.ts` -- Register exact CLI surfaces `pjangler github-repo ensure`, `pjangler repo link`, `pjangler ticket-board ensure`, and `pjangler project create`, with kebab-case flags mapping mechanically to shared inputs, `--live` default false, and `--json`. Human output is a renderer only. JSON mode writes exactly one ANSI-free `LifecycleResultV1` to stdout; exit 0 only for valid `planned`/`succeeded` results and meaningful nonzero for `blocked`/`partial`/`failed`. Retain existing init commands. Add the same live-gate enforcement before legacy `hermes-agent` can enable runtime-repo/Plane/Bloodbank/systemd effects; interactivity and `--yes` never grant live authority.
- `src/mcp-server.ts` -- Register exact tools `pjangler_github_repo_ensure`, `pjangler_repo_link`, `pjangler_ticket_board_ensure`, and `pjangler_project_create` with Zod schemas matching the shared inputs (`githubOrg`, `targetDir`, `ticketProvider`, `provisionPm`, `provisionSentinel`, and optional semantic pass-through fields). Each handler only normalizes input, calls the shared core, and serializes the same result as CLI JSON; set `isError: true` exactly when CLI would exit nonzero. Update capability guidance. Retain `pjangler_bootstrap_33god_project` as a compatibility adapter that delegates the shared core rather than duplicating orchestration, and require the canonical gate before legacy deploy-Hermes inputs can enable external/host effects.
- `tests/project-lifecycle-core-regressions.mjs` -- Add source-level focused tests (bundle the core to a temp module with the existing esbuild dependency if needed) using injected in-memory providers, deterministic clock/UUIDs, call recording, and failure injection. Cover every I/O matrix row, all gate truth-table combinations, full-preflight-before-mutation, exact action order/status/effect/IDs, compensation selection, final-verification failure, same-ID reruns, semantic-field pass-through, and proof that production network/provider calls are unreachable from the test harness.
- `tests/project-lifecycle-cli-regressions.mjs` -- Exercise built CLI dry-run and fake-live paths with temp repositories, fake argv executables, an isolated registry, and loopback-only Plane behavior. Assert stdout JSON parity, meaningful exit codes, correct/wrong/missing `origin`, new/existing/dirty targets, no unrelated staging, and zero production endpoints or pushes. All fake-live invocations may set `PJANGLER_ALLOW_LIVE=1` only while PATH/providers point exclusively at fixtures.
- `tests/mcp-catalog-regressions.mjs` and `tests/mcp-server-regressions.mjs` -- Assert the four tool registrations/capability guidance and exercise their dry-run, fake-live success, blocked preflight, partial failure, `isError`, receipt, and CLI-equivalent payload behavior through the real stdio server. Preserve all existing MCP assertions.
- `tests/project-registry-regressions.mjs` -- Add compatibility coverage proving old records without UUIDs still load, new lifecycle IDs persist and rerun unchanged, board bindings/agents are not erased by convergence, identity collisions fail before writes, Copier failure still prevents dependent registry/manifest writes, and existing init/list/show/doctor behaviors remain intact.
- `package.json` -- Add the focused lifecycle tests to `npm test` after a build or otherwise guarantee integration tests cannot exercise stale `dist`; preserve all current regressions and keep version `1.2.19`. Do not add release, install, publish, or version-bump work.

**Acceptance Criteria:**

- Given any of the four CLI commands or MCP tools with `live` omitted/false, when invoked with valid inputs, then the outermost surface returns the same complete ordered `LifecycleResultV1` plan and no mutation adapter is called.
- Given omitted optional fields, when any public surface normalizes input, then it applies exactly the defaults in the Surface contract table and exposes those resolved values in the plan/receipt projection.
- Given any mutation-capable new or legacy path, when either explicit live intent is false or `PJANGLER_ALLOW_LIVE` is not exactly `1`, then the outermost surface returns `LIVE_GATE_REQUIRED`/dry-run as appropriate and no GitHub, mutating-git, Plane, external registry, Hermes-cloud, Bloodbank, systemd, or push operation runs.
- Given multiple missing dependencies, credentials, auth grants, invalid target conditions, or resource collisions, when preflight runs, then all failures are returned before the first mutation and every action is `not_run`.
- Given an absent, matching, or attribute-drifted GitHub repository, when `pjangler github-repo ensure --json` and `pjangler_github_repo_ensure` run against equivalent fakes, then both report respectively `created`, `reused`, or `updated`, return the same canonical repo identity, and never confuse auth denial with absence.
- Given an uninitialized safe directory, a correctly linked repo, a missing `origin`, a mismatched `origin`, or an unsafe dirty/non-empty state, when the repo-link surfaces run, then they follow the matrix exactly, normalize equivalent SSH/HTTPS URLs, preserve other remotes/unrelated files, and never auto-replace `origin`.
- Given no Plane board, one matching board, description drift, or an identifier/name/explicit-ID conflict, when the board-ensure surfaces run, then they create, reuse, update, or block exactly as specified and return a verified board ID only after provider confirmation.
- Given a valid fake-live composite request, when execution succeeds, then every dependency was preflighted before mutation, actions execute in the specified dependency order, the initial push contains only run-owned files, requested PM/sentinel IDs are verified, and the receipt has stable non-null project/repo/repo-URL/board identities plus verification evidence.
- Given a failure injected after at least one mutation, when the composite returns, then it stops before later actions, returns `partial`, includes confirmed partial receipt data and manual compensation only for run-created/updated effects, performs no rollback, and CLI/MCP both signal failure.
- Given the same desired state is invoked twice, when the second call runs, then it returns the same IDs with `reused` effects, no duplicates, no changed files, no extra commit/push, and successful final verification.
- Given existing registry records and legacy CLI/MCP callers, when the implementation suite runs, then old records remain readable, existing project-init/list/show/doctor behavior and source/installed package version declarations remain unchanged, and no board/agent/identity data is silently erased.
- Given a JSON-mode CLI failure or equivalent MCP failure, when observed at the public surface, then the CLI emits one parseable envelope and exits nonzero while MCP returns the same envelope with `isError: true`; no stack trace, secret, ANSI sequence, or human-only parsing is required.
- Given the focused and full verification suite, when run with production credentials removed and fake/loopback providers installed, then every required success/failure path is exercised without a live GitHub/Plane call, host mutation, external-registry write, or real push.

## Spec Change Log

## Review Triage Log

## Design Notes

- The canonical mapping is fixed: CLI `github-repo ensure` ↔ MCP `pjangler_github_repo_ensure`; CLI `repo link` ↔ MCP `pjangler_repo_link`; CLI `ticket-board ensure` ↔ MCP `pjangler_ticket_board_ensure`; CLI `project create` ↔ MCP `pjangler_project_create`. MCP inputs follow the repository's camelCase convention; CLI flags are kebab-case; receipt/output fields follow the upstream snake_case `ProjectLifecycleReceipt v1` contract.

### Surface contract

| Operation | Shared/MCP input | CLI spelling | Required/default behavior |
|-----------|------------------|--------------|---------------------------|
| GitHub repo ensure | `org`, `name`, `visibility`, `description?`, `live?` | `github-repo ensure --org --name --visibility [--description] [--live] [--json]` | `org`, `name`, and `visibility` required; description defaults `""`; live defaults false |
| Local repo link | `repoUrl`, `dir?`, `live?` | `repo link --repo-url [--dir] [--live] [--json]` | repo URL required; dir defaults resolved cwd; live defaults false |
| Plane board ensure | `identifier`, `provider?`, `workspace?`, `name?`, `description?`, `boardId?`, `live?` | `ticket-board ensure --identifier [--provider] [--workspace] [--name] [--description] [--board-id] [--live] [--json]` | provider defaults `plane`; workspace `33god`; name defaults identifier; description `""`; live false |
| Composite project create | `name`, `githubOrg`, `targetDir`, `slug?`, `description?`, `visibility?`, `ticketProvider?`, `workspace?`, `identifier?`, `provisionPm?`, `provisionSentinel?`, `sourceContextRefs?`, `relatedProjects?`, `operatorDecisions?`, `live?` | `project create <name> --github-org --target-dir` plus kebab-case optional flags and `--json` | name/org/target required; slug and identifier use existing pjangler derivation; description `""`; visibility `private`; provider `plane`; workspace `33god`; booleans/live false; arrays empty |

`sourceContextRefs`, `relatedProjects`, and `operatorDecisions` are opaque Toad-owned semantic values: pjangler validates their JSON shape, passes them through, and never interprets or persists them as operational registry truth. The stable error-code set is `INVALID_INPUT`, `LIVE_GATE_REQUIRED`, `MISSING_DEPENDENCY`, `AUTH_REQUIRED`, `AUTH_FORBIDDEN`, `TARGET_CONFLICT`, `DIRTY_WORKTREE`, `UNSAFE_INITIAL_COMMIT`, `GITHUB_REPO_CONFLICT`, `REMOTE_MISMATCH`, `PLANE_BOARD_CONFLICT`, `REGISTRY_IDENTITY_MISMATCH`, `ACTION_FAILED`, and `VERIFICATION_FAILED`; provider-safe details may refine the message but not replace these codes.

| Overall status | `ok` | CLI exit | MCP `isError` | Meaning |
|----------------|------|----------|---------------|---------|
| `planned` | true | 0 | false/omitted | Complete mutation-free dry-run with no failed preflight rows |
| `succeeded` | true | 0 | false/omitted | Authorized execution or verified no-op completed |
| `blocked` | false | nonzero | true | Validation/gate/preflight/conflict prevented all mutation |
| `failed` | false | nonzero | true | Execution or verification failed before any mutation succeeded |
| `partial` | false | nonzero | true | At least one mutation succeeded before a later failure |

- A dry-run with failed prerequisite/auth/resource preflight retains its complete plan but has overall `blocked`, `ok: false`, nonzero CLI exit, and MCP `isError: true`. This makes the plan inspectable without misrepresenting readiness for live execution.
- The result envelope and receipt are separate concerns inside one payload. The envelope carries execution mechanics (preflight, per-action status/effect, errors, compensation); the receipt carries stable operational and semantic identities. Partial results still include known receipt fields, but only `succeeded` composite receipts are retention-ready for Toad.
- Canonical registry UUIDs are additive optional fields on existing records. After every preflight passes but before the first mutation, a live new lifecycle allocates missing UUIDs through the injected factory and persists them with the registry action; dry-run projections leave unknown IDs null. Existing PG rows supply their UUIDs, YAML-only records may receive newly allocated UUIDs, and later PG inserts must honor those IDs. Old readers/records remain valid. If YAML and an existing PG row prove different UUIDs, block rather than silently choose or backfill. This closes receipt identity without changing registry authority, schema version, or external data during implementation.
- Composite order intentionally places the repo-link commit/push after all local generators and board binding so the initial commit is coherent. This refines the upstream high-level sequence (`ensure → link → init → board`) to satisfy its stated safe-push outcome without an empty first commit or unpushed scaffold. Preflight still plans every primitive before execution begins.
- Compensation is guidance, never automatic rollback. It must distinguish resources created by this invocation from reused resources, prefer safe rerun/convergence, and avoid suggesting deletion of pre-existing resources.
- Planning observed repository metadata/local build at `1.2.19` while the globally resolved mise installation reported `1.2.18`; this environment drift is explicitly out of PJAN-27 scope and must not trigger a version bump, release, install, tag, or host change.

## Verification

**Commands:**

- `mise run typecheck` -- expected: TypeScript passes with the shared core/provider/adapter contracts.
- `mise run build` -- expected: both `dist/index.js` and `dist/mcp-server.js` build locally; no version file changes.
- `node tests/project-lifecycle-core-regressions.mjs` -- expected: all injected-provider planning, gate, preflight, convergence, receipt, failure, compensation, and verification cases pass with zero network access.
- `node tests/project-lifecycle-cli-regressions.mjs` -- expected: CLI surface/exit/JSON/repo safety cases pass only against temp fixtures and fake providers.
- `node tests/mcp-catalog-regressions.mjs` -- expected: all existing and four new MCP tools/guidance are registered.
- `node tests/mcp-server-regressions.mjs` -- expected: real stdio MCP integration returns CLI-equivalent results and correct `isError`, using isolated fakes only.
- `node tests/project-registry-regressions.mjs` -- expected: lifecycle identity additions and all existing registry/init behaviors pass in temp directories.
- `npm test` -- expected: the relevant full suite passes; the PG regression either proves its isolated scratch contract or clearly reports its existing environment skip, and no skip is claimed as lifecycle-provider proof.
- `git diff --check` -- expected: no whitespace errors.
- `git status --short` -- expected: only implementation files required by this spec are modified; no build artifact, version, Toad, host, or unrelated work is included.

## Auto Run Result

Status: ready-for-dev
Workflow outcome: Halted after planning as requested.
Readiness review: Passed after one repair pass.
