---
title: 'PJAN-27 Complete pjangler Project Lifecycle Surface'
type: 'feature'
created: '2026-07-18'
status: 'ready-for-dev'
review_loop_iteration: 3
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/skills/pjangler-dev/SKILL.md'
warnings:
  - multiple-goals
  - oversized
---

<intent-contract>

## Intent

**Problem:** Pjangler has no canonical GitHub-repository ensure, safe local-repository link, Plane-board ensure, or end-to-end project-create contract. Its CLI/MCP and Hermes paths also disagree about planning, mutation authority, compatibility, errors, output isolation, and receipts, so Toad cannot remain a pure identity/judgment/orchestration layer.

**Approach:** Add one injected lifecycle core with a credential-free static planner, an explicit read-only live-readiness preflight, gated execution, phased Git/generator/Hermes convergence, exact effect ownership, typed outer-surface failures, and `ProjectLifecycleReceipt v1`. Expose the core through four canonical CLI/MCP operations, harden every legacy Hermes entry path, and preserve legacy local bootstrap/init/Trello behavior on lower-level shared primitives rather than forcing it through the GitHub/Plane composite.

## Boundaries & Constraints

**Always:** Default canonical lifecycle calls are offline static plans: they may inspect validated local inputs and files but may not read credentials, contact a provider, create scratch remote clones, or mutate anything. `preflightLive=true` is the only non-executing permission for read-only GitHub/remote/Plane readiness discovery. Canonical execution requires `live=true` and `PJANGLER_ALLOW_LIVE=1`; legacy local writes retain their explicit `apply`/`dryRun` contract, while any selected external, push, or host effect also requires explicit live intent and the gate. `apply`, `--yes`, TTY selection, `local=false`, skip flags, or the gate alone never grant live authority. Run the complete applicable preflight before the first durable target/registry/provider/host mutation, stop forward execution on the first failure, capture every child stream, return one stable result, preserve unrelated/pre-existing state, and make same-input reruns converge.

**Block If:** Input/schema validation fails; a required live-readiness fact is failed or unknown; target, remote history, registry identity, UUID, Plane tenant/board, or generated-path ownership is ambiguous or conflicting; a requested mutation cannot be observed through the effect ledger; an existing path/ID/origin would be reassigned; a non-fast-forward/force push or destructive interpretation would be required; or implementation would require a real provider/host mutation to verify. At runtime, blocked results have no confirmed durable mutation effects.

**Never:** Do not publish, release, tag, globally install, version-bump, push from the implementation worktree, contact live GitHub/Plane during tests, mutate live host services/config/registries during verification, edit Toad, edit either pinned template submodule, change a DB schema/migration, backfill unrelated registry rows, replace a mismatched remote, force push, auto-merge divergent histories, auto-delete/rollback resources, dereference staged symlinks, recursively stage nested repositories, stage unrelated paths, inherit arbitrary credentials/`PGHOST` into tests, or emit child output onto JSON CLI/MCP stdout. Keep package/version declarations at `1.2.19`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Offline default plan | Canonical operation, `live=false`, `preflightLive=false` | Return deterministic ordered actions and planned effects with local static evidence; live-only checks are `deferred`; no credential lookup, network, scratch clone, or mutation | Valid plan is `planned`, `ok=true`, exit `0`, MCP `isError=false` even though live readiness is deferred |
| Explicit readiness | `preflightLive=true`, `live=false` | Run all applicable read-only provider/remote/host readiness checks, keep actions `planned`, perform no durable mutation | All checks pass: `planned`/`0`; any `failed` or `unknown`: `blocked`/`3`, MCP error |
| Live gate denied | `live=true`, gate absent or not exactly `1` | Return the static plan, mark mutation actions `not_run`, and call no live-preflight/provider/mutation adapter | `LIVE_GATE_REQUIRED`, `blocked`, exit `4`, MCP `isError=true` |
| Invalid outer input | Missing/malformed/unknown CLI option or MCP field/type/limit | Serialize one redacted `LifecycleResultV1`; no handler/provider call | `INVALID_INPUT`, `blocked`, exit `2`, MCP `isError=true` |
| GitHub repository absent/present | Exact allowed org/name; provider lookup proves absent or matching | Plan create/reuse; authorized execution creates once or reuses, and description/visibility drift updates only when requested | Auth/permission uncertainty is never treated as absence; conflicts block before mutation |
| Initial standalone link | Non-empty, no `HEAD` target and empty remote | Require exact repeated `initialCommitPaths`; initialize, commit only approved leaf paths, and push normally | Missing approval is `INITIAL_COMMIT_APPROVAL_REQUIRED`; unsafe symlink/nested repo/gitlink is blocked |
| Existing remote history | Remote has a default branch/commits | Empty target clones; matching/ahead/behind ancestry follows the Git matrix; generators run only after safe Git preparation | Divergence, unrelated history, default-branch mismatch, detached HEAD, or non-fast-forward blocks; never force |
| Composite fresh target | Valid fake-live request | Full preflight → GitHub ensure → Git prepare → Plane ensure → CommonProject → provisional state → structured PM/sentinel actions → post-Hermes convergence → owned commit → safe push → verification | Hermes always sees an existing Git root; later actions become `not_run` after failure |
| PM/sentinel selection | `provisionSentinel=true`, `provisionPm=false` | Normalize to PM plus its heartbeat service; one PM agent ID and one sentinel service identity are planned | Sentinel is never represented or provisioned as an independent agent |
| Registry rerun | YAML/optional PG/manifest contain matching provisioning/partial/active identity | Reuse `project_id`/`repo_id`, repair incomplete mirrors, resume unconfirmed actions, and promote only after the active manifest commit is pushed, then re-verify | Any slug/path/UUID cross-assignment blocks; no replacement/backfill |
| Legacy local bootstrap | Existing `pjangler_bootstrap_33god_project` defaults or Trello caller | Preserve `dryRun=true`, `local=true`, `skipPlane=true`, no required GitHub org, and lower-level CommonProject semantics | Never route safe defaults through the GitHub/Plane composite or erase Trello fields |
| Partial execution | At least one confirmed created/updated/deleted effect precedes failure | Stop forward actions; query all declared observers; return confirmed partial receipt/effects and guidance only for changed effects | `partial`, exit `6`, MCP error; no automatic compensation |

</intent-contract>

## Code Map

- `src/project/index.ts` -- Existing local project init plan/apply contract, registry/manifest records, CommonProject action, and legacy formatters.
- `src/project/RegistryStore.ts` -- YAML authority and optional PG adapter; currently discards PG UUIDs and can reassign a repo path.
- `src/project/lifecycle/types.ts` -- New exact Zod/TypeScript input, result, receipt, preflight, action, effect, semantic-context, error, and exit-code contracts.
- `src/project/lifecycle/effects.ts` -- New lstat/hash/git-index snapshots, ownership comparison, effect observers, redaction, and compensation filtering.
- `src/project/lifecycle/providers.ts` -- New injected filesystem/scratch/command/output/GitHub/Plane/registry/clock/UUID/host-service boundaries and production adapters.
- `src/project/lifecycle/git.ts` -- New remote normalization, ref/default-branch/ancestry discovery, clone/adopt/prepare, exact staging, commit, and normal-push primitive.
- `src/project/lifecycle/hermes.ts` -- New structured PM/sentinel planner/executor using Copier `--skip-tasks`, named subactions, injected runners, and before/after observers.
- `src/project/lifecycle/index.ts` -- New sole canonical planner/readiness/executor, authority resolution, phase ordering, failure finalization, convergence, and verification.
- `src/commands/hermes/types.ts` -- Existing Hermes context; needs explicit live/output/effect inputs and PM-only/sentinel service identity.
- `src/commands/hermes/RunCopierTemplate.ts` and `src/recipes/HermesAgentRecipe.ts` -- Existing opaque/inherited-stdio Hermes execution; become compatibility adapters over captured structured execution.
- `src/commands/hermes/WireTelegram.ts` and `src/commands/hermes/WireEmail.ts` -- Existing legacy adapters place resolved secrets in child argv; they enter the universal secret-transport boundary even though composite create skips both integrations.
- `src/parity/index.ts` -- Existing runtime audit/migration currently rejects and untracks every runtime gitlink; must distinguish lifecycle-owned canonical gitlinks from ignored legacy runtimes while retaining the delta-profile contract.
- `src/commands/hermes/UntrackHermesRuntimes.ts` and `src/recipes/HermesAgentRecipe.ts` -- Existing legacy recipe unconditionally invokes runtime untracking; must preserve a verified lifecycle-owned runtime and keep legacy untracked-runtime behavior for every other role/path.
- `src/index.ts` -- Commander registration, legacy init/Hermes aliases, interactive apply behavior, JSON renderer, and current unwrapped `program.parse()`.
- `src/mcp-server.ts` -- MCP catalog/handlers; high-level SDK validation currently returns plain text before handlers and opaque recipe capture can corrupt stdio.
- `tests/project-registry-regressions.mjs`, `tests/_pg_store_check.ts`, `tests/pg-registry-regressions.mjs` -- Legacy/YAML/PG compatibility and current unsafe inherited-PG test setup.
- `tests/mcp-catalog-regressions.mjs`, `tests/mcp-server-regressions.mjs` -- MCP catalog and real stdio integration; current child environment inherits production state.
- `package.json`, `package-lock.json`, `dist/index.js`, `dist/mcp-server.js` -- Test/build contract, explicitly authorized lock-only refresh, and tracked shipped entrypoints; source/build parity is required without a release or version bump.
- `templates/commonproject` at `996ca527598d50f25a80ace146eb3189bf556b68` and `templates/hermes-agent` at `1c6482a0259996b3d0e82f48a2a54c46b19abe0a` -- Read-only pinned generator inputs; PJAN-27 wraps them and does not edit their gitlinks/content.
- `/home/delorenj/code/33GOD/toad/src/tools/hermesDeploy.ts` and `/home/delorenj/code/33GOD/toad/src/util/live.ts` -- Read-only compatibility evidence for Toad's exact `--yes --json` plus `TOAD_ALLOW_LIVE=1` live-Hermes delegation; Toad is not changed.
- `/home/delorenj/code/33GOD/pjangler/node_modules/@modelcontextprotocol/sdk` at locked `1.29.0` and installed Git 2.51 manpages/config -- Read-only primary evidence for the JSON-RPC validation seam and controlled Git-process boundary.

## Tasks & Acceptance

**Execution:**

- `src/project/lifecycle/types.ts` -- Define every strict input and nested output contract in Design Notes as Zod schemas plus inferred TypeScript types, including parent provider identity versus internal UUID, persisted `provisioned_at`, evidence, planned effects, observations, blocked references, nullable errors, indeterminate effects, receipt fields, output-budget accounting, authority sources, and all row/result-wide byte/count bounds. Reject unknown fields, invalid enums/UUIDs/URLs/paths, duplicate semantic keys/IDs, controls, and aggregate excess. Emit snake_case `LifecycleResultV1`; accept camelCase shared/MCP inputs and mechanically mapped kebab-case CLI flags. Validate before serialization; allow the null-receipt constant fallback only before the mutation boundary and rebuild post-mutation failures from the confirmed journal.
- `src/project/lifecycle/effects.ts` -- Implement non-dereferencing snapshots plus the bounded `pjangler.path-ownership/v1` manifest record. Record confirmed created/updated/deleted/reused/none and post-mutation indeterminate effects for files, symlinks, host paths, `.gitmodules`, gitlinks, refs/remotes, providers, mirrors, dependencies, and services. Run every declared observer after child failure; unknown post-mutation outcome is `MUTATION_OUTCOME_INDETERMINATE`, not a clean failure. Reject undeclared/unowned deltas and generate destructive compensation only from confirmed changes.
- `src/project/lifecycle/providers.ts` -- Define injected `CommandRunner`, `OutputSink`, `ScratchFs`, GitHub, Plane, registry, Hermes-host, secret, clock, and UUID boundaries. Children use argv arrays, piped stdio, an allowlisted environment built from scratch, timeouts, ANSI stripping, and bounded redacted evidence. Reject any argv element containing a registered secret or secret-bearing header/assignment; pass secrets only by private stdin/FD, minimal child env, or no-follow mode-0600 agent file. Static planning constructs no credential/network provider.
- `src/project/lifecycle/git.ts` -- Implement physical target identity, context-free full-ref branch validation, the complete target/remote matrix, controlled Git config/env/hook/filter/helper/signing/SSH policy, `core.worktree`/`core.bare` containment, scratch ancestry discovery, exact staging, and runtime/parent commits with the specified identity/date/message. Push only the exact non-force `refs/heads/${branch}:refs/heads/${branch}` refspec to the canonical URL with all documented push-selection/tag/option configuration neutralized and re-observe the one destination OID. Recheck canonical `(dev, ino)` path chains and remote OIDs before mutation. Standalone adoption alone may use `initialCommitPaths`; composite non-git non-empty targets block. Never silently neutralize a required filter or reuse/delete an unbound runtime directory.
- `src/project/lifecycle/hermes.ts` -- Render pinned Hermes with `copier copy --skip-tasks`; do not execute its opaque task scripts. Normalize rendered `role.yaml provisioned_at` to the persisted lifecycle timestamp before ownership comparison. Implement named observed subactions for repo render, private Plane env, runtime identity/allowlisted seed/fail-closed secret scan, deterministic runtime commit and exact push, exact parent gitlink, host profile/fleet state, pre-existing Bloodbank dependency plus consumer, units, and delayed timer. Use the canonical-project lock then heartbeat lock; hold both through runtime push, parent push, verification, and timer decision. Never trust `.done-*` markers, copy global/profile secrets, run `git add -A`, install into the shared Hermes venv, or enable the timer before both pushes verify.
- `src/project/RegistryStore.ts` and `src/project/index.ts` -- Add optional canonical `project_id`/`repo_id`, `automation.lifecycle`, and manifest projection while keeping registry schema `1`, `automation.reconcile`, old records, list/show/doctor/init, Trello, slug-NULL PG ownership, and legacy best-effort PG. Encode the identical bounded service/ownership projection at YAML `automation.lifecycle`, PG `projects.automation->'lifecycle'`, and `.project.json automation.lifecycle`; agents continue to use `project_agents`, never synthetic service rows. Lifecycle mode uses explicit IDs, physical paths, strict collision checks, and exact promotion/resume without migration/backfill or repo-path reassignment.
- `src/project/lifecycle/index.ts` -- Implement static plan, explicit readiness, and gated execution. Normalize `parent_repository_name=slug`, aggregate all applicable input/path/registry/Git/GitHub/Copier/template/Plane/PG/Hermes/host/output-spine checks before a permit or durable mutation, and define omitted-versus-explicit Plane mutable-field reuse exactly. Execute the exact composite phases in Design Notes; stop forward work after failure but run the local redacted effect/state finalizer. Allocate UUIDs and one timestamp only after full preflight, persist parent provider identity/timestamp in provisional state before Hermes, journal each confirmed observation, and apply deterministic output compaction. Verify final YAML/PG/manifest IDs/status, origin/ref/ancestry, provider identities, timestamp, PM/sentinel identities, ownership ledger, a clean lifecycle-owned index with no new unowned worktree delta, preserved pre-existing unrelated state, and pushed HEAD.
- `src/index.ts` -- Register the canonical commands and exact flags, including explicit visibility-update authority. Intercept lifecycle Commander failures around `parseAsync()` and render one bounded ANSI-free JSON result. Preserve explicit Hermes CLI's current `local=false` default, add `--live`/`--json`, and recognize only the unchanged Toad compatibility tuple (`hermes-agent|hermes`, `--yes`, `--json`, no dry-run, `TOAD_ALLOW_LIVE=1`) as delegated intent+gate; direct nonlocal legacy use requires `--live` plus `PJANGLER_ALLOW_LIVE=1`. The Toad tuple grants nothing elsewhere and all near misses block. On that exact tuple only, emit normal JSON on success but empty stdout plus the bounded `PJANGLER_TOAD_FAILURE` lifecycle JSON stderr line on nonzero outcomes so unchanged Toad returns an error.
- `src/mcp-server.ts` -- Preserve every tool and add the four canonical tools through one low-level catalog/router. Protocol-invalid JSON/JSON-RPC or `CallToolRequestSchema` messages remain SDK transport/JSON-RPC errors; after that schema succeeds, known canonical/participating legacy lifecycle names perform strict tool-specific `safeParse` inside the handler and return `LifecycleResultV1` for argument or handler failures. Unknown tools retain SDK semantics. MCP stdout remains JSON-RPC only; canonical tools return bare lifecycle JSON text and participating legacy payloads add nested `lifecycle` with `isError = exit_code !== 0`.
- `src/commands/hermes/types.ts`, `src/commands/hermes/RunCopierTemplate.ts`, `src/recipes/HermesAgentRecipe.ts`, `src/commands/hermes/WireTelegram.ts`, and `src/commands/hermes/WireEmail.ts` -- Make legacy Hermes a structured compatibility adapter with the same secret/output/effect runner. Preserve new `pm|dev|review|ops|qa` legacy requests and all existing opaque role records additively; canonical create owns only PM. Unsupported new roles fail before mutation and no existing role is deleted/coerced/migrated. Composite skips Telegram/email; legacy token payloads move from argv to private stdin.
- `src/parity/index.ts`, `src/commands/hermes/UntrackHermesRuntimes.ts`, `src/recipes/HermesAgentRecipe.ts`, and `tests/parity-migrate-regressions.mjs` -- Reconcile the canonical lifecycle-owned PM runtime gitlink with existing audit/migration and legacy recipe behavior. A runtime is lifecycle-owned only when strict `automation.lifecycle.runtime_repositories` identity, `.gitmodules`, index mode `160000`, canonical URL, and OID all agree; audit passes and both migration/recipe preserve it. Every non-lifecycle legacy runtime retains the existing untracked-plus-ignored contract. Never infer lifecycle ownership from path or role alone.
- `tests/helpers/lifecycle-fixtures.mjs` -- Add temp HOME/registry/repos, deterministic UUID/clock, argv-recording fake binaries/providers, loopback servers, captured output, and an allowlisted child environment built from scratch. Never spread `process.env`; omit all GitHub/Plane/Trello/NATS/AWS/database credentials and all `PG*`/`DATABASE_URL` unless a test explicitly injects a fixture value.
- `tests/project-lifecycle-core-regressions.mjs` -- Cover all I/O/authority rows plus canonical parent naming/provider-ID mirror round trips, stable `provisioned_at`, physical aliases, ownership drift, service JSONB mapping, explicit visibility authority, omitted Plane name/description reuse, output-spine rejection/compaction/emergency partial receipts, runtime identity/seed/scan/lock/OID order, tenant-private env, exact Bloodbank reuse, secret argv rejection, controlled Git config, indeterminate outcomes, and deterministic reruns with injected providers.
- `tests/project-lifecycle-cli-regressions.mjs` -- Exercise built static/readiness/fake-live modes, exact exits/output, Commander failures, successful and failing exact-Toad handoffs plus all near misses, supported/preserved roles, context-free branch validation (including `@{-1}`), deterministic author/committer/date/message, exact single push refspec, push-config neutralization, `core.worktree`/`core.bare` containment, every other Git target/remote/path/config case, lock-only scope evidence, and zero unrelated staging.
- `tests/mcp-catalog-regressions.mjs` and `tests/mcp-server-regressions.mjs` -- Assert exact schemas/capability guidance and real-stdio parity. Send raw protocol-invalid `tools/call` cases and require standard JSON-RPC errors, then protocol-valid lifecycle calls with invalid tool arguments and require `LifecycleResultV1`. Cover handler/indeterminate/legacy-role/Toad-independent behavior and prove no child bytes reach transport stdout.
- `tests/project-registry-regressions.mjs`, `tests/_pg_store_check.ts`, and `tests/pg-registry-regressions.mjs` -- Prove old no-UUID records remain readable; explicit IDs round-trip; global UUID/slug/path/ID collisions and reassignment block before writes; provisional/partial reruns retain IDs; YAML/optional PG/manifest promotion converges; and no schema migration is added. PG tests ignore inherited `PGHOST` and run only with explicit loopback `PJANGLER_TEST_PG_URL`, using a validated unique scratch DB name and exact cleanup.
- `tests/dist-parity-regressions.mjs`, `package.json`, and `package-lock.json` -- Add lifecycle suites, temp-output bundle comparison, and a lock assertion that `node_modules/@modelcontextprotocol/sdk` remains exactly version `1.29.0`, resolved tarball `https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.29.0.tgz`, and integrity `sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==`. `package.json` may change only to wire the named lifecycle suites into the existing test command; its name/version/bin/engines/dependency declarations and every unrelated script stay fixed. After that intentional edit, snapshot all non-lock manifests and authorize exactly `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`; that command may change only `package-lock.json`, must restore root parity including all PG packages, SDK pin, and version `1.2.19`, must not run install scripts or mutate `node_modules`, and must produce an identical hash on its second run. Default tests may skip PG only without the loopback fixture.
- `dist/index.js` and `dist/mcp-server.js` -- Rebuild and commit both tracked entrypoints from the changed source. Do not bump a version, install globally, publish, tag, or push.

**Acceptance Criteria:**

- Given any canonical CLI command or MCP tool with `live` and `preflightLive` omitted/false, when invoked with valid input and no credentials/network, then the outer surface returns the same actionable static plan with live-only rows `deferred`, `status=planned`, `ok=true`, exit `0`/`isError=false`, and no credential/network/scratch/mutation provider is constructed.
- Given `preflightLive=true` and `live=false`, when provider readiness is all proven, failed, or inconclusive, then the outer surface respectively returns a mutation-free planned result or a blocked result whose exact rows are `failed`/`unknown`, exit `3`, and no durable effect is confirmed.
- Given any canonical or selected legacy external/host/push action, when explicit live intent is absent, the gate is not exactly `1`, or only `apply`/`yes`/TTY/`local=false`/skip flags/gate is present, then the authority tables determine the exact plan/block/local-only outcome and no implicit live permit exists.
- Given missing, malformed, oversized, or unknown lifecycle inputs at Commander or inside a protocol-valid lifecycle tool's `params.arguments`, when observed publicly, then one redacted result is returned with `INVALID_INPUT`; given malformed JSON/JSON-RPC or a `tools/call` request that fails locked SDK `CallToolRequestSchema`, then the SDK returns its standard transport/JSON-RPC error and lifecycle code is never invoked; given instead an unexpected lifecycle adapter/handler exception after routing, then the tool result uses `INTERNAL_ERROR`, with no stack/secret/ANSI or pre-validation provider call.
- Given absent/matching/drifted/inaccessible GitHub state, when equivalent CLI/MCP fake calls run, then they create/reuse/update/block identically, distinguish absence from auth failure, and return the same canonical URL/default-branch evidence.
- Given every target/remote-history row and lexical/physical path row in the Git matrix, when repo-link or composite Git preparation runs, then canonical path-chain identity is proved and rechecked, the documented clone/init/ff-only/reuse/block behavior occurs, a Git root exists before Hermes, and neither alias following, origin replacement, history merge, non-fast-forward, nor force push occurs.
- Given a non-empty no-HEAD standalone directory, when exact `initialCommitPaths` are absent or present, then the outer surface respectively blocks without mutation or commits only the approved safe leaf file/symlink/gitlink set; modifications/deletions and `.gitmodules` are represented exactly and unrelated paths remain unstaged.
- Given a non-git non-empty composite target, when its project remote is provider-proved absent, exists headless, or has history, then execution respectively returns `INITIAL_COMMIT_APPROVAL_REQUIRED`, `INITIAL_COMMIT_APPROVAL_REQUIRED`, or `REMOTE_HISTORY_CONFLICT` before any provider/target mutation; given a provider-proved absent standalone remote, when repo-link evaluates it, then it returns `REMOTE_NOT_FOUND` and never infers absence from an auth/transport failure.
- Given a generator or Hermes subaction creates, updates, deletes, reuses, or may have changed a declared target, when it completes, fails, or loses its observer after issuing mutation, then the receipt contains exact confirmed or indeterminate path/external/host/service effects (including symlink targets and gitlink OIDs), any unowned/undeclared delta fails before commit, and an indeterminate outcome is `partial`/6 rather than clean `failed`/5.
- Given `provisionSentinel=true` with either PM value, when the composite is planned/executed, then resolved input includes one PM agent `${slug}-pm`; sentinel identity is the PM-owned `hermes-${slug}-pm-heartbeat` service/timer, not a second agent; requested states and receipt IDs are stable on rerun.
- Given a valid fake-live composite with PM runtime selected, when it succeeds, then all readiness checks precede mutation; a sanitized exact runtime tree passes a fail-closed pre-push scan; runtime commit/push verifies first, the parent gitlink commit/push verifies second, and only then may heartbeat units be enabled; YAML/PG/manifest promote to active with identical IDs/board/agent/service/ownership state and the receipt has confirmed project/repo/runtime/board identities.
- Given a confirmed changed effect or a mutation request whose outcome cannot be observed, when the operation returns, then forward actions are `not_run`, declared observers and the local finalizer run, status is `partial`, exit is `6`, confirmed receipt identities remain exact, unconfirmed identities remain null, and indeterminate effects receive only re-observation guidance rather than destructive compensation.
- Given existing old registry records, PG rows, safe bootstrap/Trello callers, or legacy PM/dev/review/ops/qa and opaque persisted roles, when the full suite runs, then no unrelated row is backfilled, no ID/path/role is reassigned or removed, legacy multi-role payload/default behavior remains additive-compatible, canonical create owns only `${slug}-pm`, and safe local defaults gain no GitHub/Plane requirement.
- Given a requested Plane workspace, when core credentials/base resolve and a PM/sentinel is selected, then only that workspace's key/base/slug enter the captured child env and atomically managed mode-0600 runtime `.env`; every other Plane key and shared fleet credential file is excluded, non-`33god` never consumes a global fallback, and evidence records only the credential source name.
- Given semantic context on CLI and MCP, when values meet or violate the exact types/limits, then both adapters preserve identical ordering/content or return the same `INVALID_INPUT`; pjangler never interprets or persists these values as registry operational truth.
- Given lifecycle or participating legacy children run under normal JSON CLI or MCP stdio, when they emit output or consume credentials, then output is captured/redacted/bounded, registered secrets are rejected from argv, Git executes with the controlled no-hook/no-filter/no-helper/no-signing/no-inherited-SSH boundary, and the only public machine output is the single envelope/MCP JSON-RPC stream; the sole exception is the separately specified nonzero exact-Toad stderr bridge.
- Given Toad invokes its unchanged live Hermes adapter, when argv is exactly `hermes-agent|hermes --yes --json` plus subtractive flags and inherited `TOAD_ALLOW_LIVE=1`, then pjangler records `toad_legacy_handoff` intent/gate and executes only the selected effects; given any near miss or any canonical/MCP/generic alias use of `TOAD_ALLOW_LIVE`, then no delegated permit exists and the normal direct authority table applies.
- Given an existing GitHub repository and omitted visibility, when ensure/create reuses it, then observed visibility is preserved; given explicit drift without `allowVisibilityUpdate=true`, then it blocks without mutation; given an absent repository, then omitted visibility is only a `private` create default.
- Given Bloodbank is selected, when the canonical physical Hermes interpreter is missing or does not report exactly `nats-py==2.15.0`, then full preflight blocks with `MISSING_DEPENDENCY` before mutation; when it matches, then provisioning reuses it, renders/verifies the consumer, and never invokes `uv`, `pip`, or writes the shared venv.
- Given default verification, when the focused/full suites run, then child environments contain only allowlisted fixture values, provider URLs are loopback-only, production credentials are absent, PG is opt-in via loopback URL rather than inherited `PGHOST`, and no real push/provider/host/external-registry mutation occurs.
- Given source changes and the named `package.json` test-script wiring are complete, when build/parity and the authorized lock-only refresh run, then `dist/index.js` and `dist/mcp-server.js` byte-match fresh temp builds, the lock command changes only `package-lock.json` relative to its immediate pre-command snapshot, its root dependencies/bin/engines match `package.json`, both lock versions are `1.2.19`, a second lock-only run is byte-idempotent, and no dependency declaration/install script/version bump/release/global install/tag/push occurs.
- Given composite display name `My Project` with normalized slug `my-project`, when static plan/readiness/execution and an identical rerun derive parent repository identity, then every surface uses exactly `${githubOrg}/my-project` for provider lookup/create, URL, lock, state, runtime marker, receipt, and verification while retaining `My Project` only as display metadata.
- Given a provider-confirmed parent repository, when any provisioning/partial/active mirror or receipt is written and reread, then the immutable GitHub repository ID round-trips separately from internal `repo_id` and agrees across YAML `automation.lifecycle`, PG JSONB, `.project.json`, runtime marker, receipt, and provider re-observation.
- Given the pinned Hermes template emits a fresh wall-clock `role.yaml provisioned_at`, when first execution and same-input reruns render it, then pjangler replaces that scalar with the single persisted lifecycle UTC timestamp, both Git commit dates use that value, and later reruns produce no timestamp-only diff or commit.
- Given a strict lifecycle-owned PM runtime gitlink and a separate legacy untracked runtime, when audit, parity migration, and the legacy Hermes recipe run in fixtures, then the canonical gitlink remains tracked/not ignored and passes while the legacy runtime retains untrack-plus-ignore behavior; malformed/conflicting lifecycle ownership blocks without untracking either path.
- Given a clean host with no Git identity configuration, when lifecycle creates runtime, parent content, or active-state commits, then author/committer names, emails, dates, and exact full messages equal the documented constants, no editor/template/signing source is consulted, and an identical tree/parent/rerun yields no new commit.
- Given hostile local push defaults, remote push refspecs, follow-tags, push options, or upstream settings, when lifecycle performs any push, then captured argv contains the canonical URL and exactly one `refs/heads/${branch}:refs/heads/${branch}` refspec with the documented neutralizers, only that destination changes, and non-fast-forward still fails without force/lease.
- Given the same requested branch including `@{-1}` in repositories with different reflogs, when outer validation runs, then validation depends only on the unchanged `refs/heads/${branch}` bytes, rejects reflog syntax/`HEAD`/leading dash identically, and never resolves a revision or detached commit.
- Given repository-local/worktree-local `core.worktree` or `core.bare=true`, or a controlled top-level outside `physical_target`, when readiness or execution reaches Git preparation, then it returns `UNSAFE_GIT_CONFIG` before mutation (or partial after an issued mutation), and no checkout/add/commit path outside the validated target is touched.
- Given unchanged Toad invokes the exact live handoff and pjangler returns success, blocked, failed, or partial, when Toad processes the child, then only success yields valid stdout JSON and `deployed:true`; every nonzero result yields empty stdout plus one bounded redacted `PJANGLER_TOAD_FAILURE` stderr line, causing Toad `isError=true` while preserving its existing `TOAD_ALLOW_LIVE=1` gate and the embedded partial receipt.
- Given declared rows near the output limit and a failure after confirmed mutations, when result construction budgets or encounters an invalid working DTO, then the preflight spine either blocks before mutation with `OUTPUT_BUDGET_EXCEEDED` or the final document is deterministically at most 8,388,608 bytes, reports compaction counts, preserves receipt identity plus every confirmed/indeterminate effect, and never substitutes the null-receipt constant.
- Given a Plane board with the exact workspace/identifier but an operator-renamed display name and omitted name/description input, when ensure reruns, then it reuses the board by ID/identifier, preserves both observed mutable fields, and performs no name-collision lookup/update; explicit mutable fields instead update drift, while explicit ID/identifier/name collisions block.
- Given the authorized lock-only refresh and every default/full verification run, when `package-lock.json` is inspected, then the SDK package entry remains exactly version `1.29.0` with the documented tarball URL and integrity, and any compatible-range resolution to another SDK version fails before build parity can be accepted.

## Spec Change Log

- 2026-07-18 independent adversarial `REPAIR`: replaced the credential-dependent dry run, incomplete authority model, infeasible Git/Hermes order, ambiguous ownership/push/registry semantics, opaque child execution, incomplete public failures, unsafe tenant/UUID/test behavior, and bundle contradiction with the binding contracts below. KEEP: Toad/pjangler ownership boundary, canonical four operations, YAML authority, no automatic rollback, no release, and both `multiple-goals`/`oversized` warnings.
- 2026-07-18 BMAD readiness repair: completed the canonical scalar schemas/limits and exact MCP names; made primitive/invalid receipts and errors implementable; nested lifecycle metadata under collision-free legacy payloads; delayed authoritative state promotion until the active manifest commit is pushed; removed duplicate Plane-key precedence; and made PG verification explicitly loopback/opt-in. KEEP: all 18 independent finding mappings and the buffered intent contract.
- 2026-07-18 second adversarial `REPAIR`: accepted all 18 new semantic findings and reopened planning. Added the protocol-valid MCP seam, unchanged-Toad delegation tuple, explicit legacy-role policy, existing-JSONB service mapping, bounded manifest ownership, deterministic runtime-repo/seed/push/gitlink/timer ordering, per-agent Plane isolation, secret transport, controlled Git execution, indeterminate effects, complete target/path/visibility/lockfile/output contracts, and no-install Bloodbank preflight. KEEP: the verbatim intent contract, canonical-vs-legacy boundary, pinned templates as read-only inputs, and halt-before-implementation instruction.
- 2026-07-25 third adversarial `REPAIR`: accepted all 12 semantic findings and reopened planning. Fixed canonical parent naming/provider-ID persistence, stable template timestamp reuse, parity/legacy runtime-gitlink coexistence, deterministic Git commit/refspec/branch/worktree contracts, truthful unchanged-Toad failures, mandatory-spine output budgeting, omitted Plane mutable-field reuse, and exact SDK 1.29.0 lock proof. KEEP: the verbatim intent contract, live authority gates, no Toad/template/migration edits, confirmed partial receipts, and halt-before-implementation instruction.

## Review Triage Log

- 2026-07-18 external review: verdict `REPAIR`; 18 material specification findings accepted and resolved in `Review Remediation`. The reviewer supplied no severity labels, so none are invented here.
- 2026-07-18 second external review: verdict `REPAIR`; 18 semantic findings accepted as `bad_spec` and mapped in `Second Review Remediation`. Severity labels were not supplied and are not invented; the prior readiness claim was superseded until the fresh from-disk gate recorded below.
- 2026-07-25 third external review: verdict `REPAIR`; 12 semantic findings accepted as `bad_spec` and mapped in `Third Review Remediation`. Severity labels were not supplied and are not invented; status was held at `draft` until the fresh from-disk seven-quality gate passed.

## Design Notes

### Surface contract and semantic inputs

| Operation | Shared/MCP input | CLI spelling | Required/default behavior |
|-----------|------------------|--------------|---------------------------|
| GitHub ensure | `org`, `name`, `visibility?`, `allowVisibilityUpdate?`, `description?`, `preflightLive?`, `live?` | `github-repo ensure --org --name [--visibility] [--allow-visibility-update] [--description] [--preflight-live] [--live] [--json]` | org/name required; allowed orgs `AutomaticAI-io`, `delorenj`, `IntelliForia`; omitted visibility is `private` only for create and preserves reuse; visibility drift mutates only when both visibility was explicit and update authority is true; booleans false |
| Repo link | `repoUrl`, `dir?`, `branch?`, `initialCommitPaths?`, `preflightLive?`, `live?` | `repo link --repo-url [--dir] [--branch] [--initial-commit-path <path>...] [--preflight-live] [--live] [--json]` | URL required; dir resolved cwd; branch resolved by Git matrix; paths empty; booleans false |
| Plane ensure | `identifier`, `provider?`, `workspace?`, `name?`, `description?`, `boardId?`, `preflightLive?`, `live?` | `ticket-board ensure --identifier [--provider] [--workspace] [--name] [--description] [--board-id] [--preflight-live] [--live] [--json]` | provider `plane`; workspace `33god`; omitted name/description use identifier/`""` on create and do not update those fields on reuse; booleans false |
| Composite create | `name`, `githubOrg`, `targetDir`, `slug?`, `description?`, `visibility?`, `allowVisibilityUpdate?`, `ticketProvider?`, `workspace?`, `identifier?`, `branch?`, `provisionPm?`, `provisionSentinel?`, `sourceContextRefs?`, `relatedProjects?`, `operatorDecisions?`, `preflightLive?`, `live?` | `project create <name> --github-org --target-dir` plus exact kebab-case flags; semantic flags repeat JSON objects | name/org/target required; derive/validate `slug` once, then use that exact slug as the parent GitHub repository `name`; display `name` is never a provider-repository identifier; derive identifier from slug; omitted visibility is a private create default but never reuse-update intent; provider `plane`; workspace `33god`; booleans false; arrays empty; sentinel implies PM |

Exact MCP names are `pjangler_github_repo_ensure`, `pjangler_repo_link`, `pjangler_ticket_board_ensure`, and `pjangler_project_create`. Canonical surfaces reject unknown keys and reject `apply`, `yes`, `dryRun`, and `local`. `preflightLive=true` with `live=true` is allowed but redundant because execution always performs full readiness. `PJANGLER_ALLOW_LIVE=1` with `live=false` grants nothing.

```ts
type SourceContextRefV1 = {
  kind: "path" | "url" | "ticket" | "memory" | "other";
  ref: string;
  label?: string;
};
type RelatedProjectV1 = {
  projectId: string; // canonical UUID
  relation: "depends-on" | "extends" | "replaces" | "shares-market" |
    "shares-infrastructure" | "customer-of" | "custom";
  customRelation?: string; // required iff relation === "custom"
  rationale: string;
};
type OperatorDecisionV1 = {
  key: string;
  decision: string;
  rationale?: string;
  sourceRefs?: string[]; // each must equal a supplied SourceContextRefV1.ref
};
type LiveControlsV1 = { preflightLive?: boolean; live?: boolean };
type GithubRepoEnsureInputV1 = LiveControlsV1 & {
  org: "AutomaticAI-io" | "delorenj" | "IntelliForia";
  name: string;
  visibility?: "public" | "private";
  allowVisibilityUpdate?: boolean;
  description?: string;
};
type RepoLinkInputV1 = LiveControlsV1 & {
  repoUrl: string;
  dir?: string;
  branch?: string;
  initialCommitPaths?: string[];
};
type TicketBoardEnsureInputV1 = LiveControlsV1 & {
  identifier: string;
  provider?: "plane";
  workspace?: string;
  name?: string;
  description?: string;
  boardId?: string;
};
type ProjectCreateInputV1 = LiveControlsV1 & {
  name: string;
  githubOrg: GithubRepoEnsureInputV1["org"];
  targetDir: string;
  slug?: string;
  description?: string;
  visibility?: GithubRepoEnsureInputV1["visibility"];
  allowVisibilityUpdate?: boolean;
  ticketProvider?: "plane";
  workspace?: string;
  identifier?: string;
  branch?: string;
  provisionPm?: boolean;
  provisionSentinel?: boolean;
  sourceContextRefs?: SourceContextRefV1[];
  relatedProjects?: RelatedProjectV1[];
  operatorDecisions?: OperatorDecisionV1[];
};
```

Strict Zod schemas mirror those types. Standalone repository `name` is 1–100 ASCII characters matching `^[A-Za-z0-9._-]+$` and is not `.`/`..`; composite/board display `name` is 1–200 Unicode scalar values and at most 256 UTF-8 bytes. `slug` is 1–100 lower-case characters matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`; composite normalization derives it exactly once from explicit `slug` or `slugifyProjectName(name)`, rejects an empty/invalid result, and sets `parent_repository_name = slug`. That exact value drives provider lookup/create, normalized URL, lock identity, state, receipt, runtime marker, and every rerun. Plane `identifier` is 2–8 upper-case alphanumerics beginning with a letter; workspace is 1–64 characters matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`; optional board IDs are canonical lower-case UUIDs. Descriptions are 0–350 Unicode scalar values. `repoUrl` is at most 2048 UTF-8 bytes and must normalize to an SSH or HTTPS GitHub remote in an allowed org. `dir`/`targetDir` are 1–4096 UTF-8 bytes and resolve to a non-root absolute directory without NUL/control characters. `branch` is 1–255 UTF-8 bytes, must not begin with `-` or equal `HEAD`, and is accepted only when the unchanged bytes pass context-free `git check-ref-format "refs/heads/${branch}"`; never use `--branch`, `--normalize`, revision parsing, or reflog expansion. `initialCommitPaths` has at most 512 unique entries, each 1–4096 UTF-8 bytes, and at most 65,536 serialized bytes; the stricter Git ownership rules below also apply. The complete normalized input is at most 131,072 serialized UTF-8 bytes. All canonical strings reject NUL/C0/DEL controls; identity fields must already be edge-trimmed and values are never silently truncated.

Input presence is retained separately from normalization. `visibility_was_explicit` is true only when the caller supplied the field/flag; `create_visibility = visibility ?? "private"`. On reuse, omission preserves observed visibility. Explicit drift blocks with `VISIBILITY_UPDATE_AUTHORITY_REQUIRED` unless `allowVisibilityUpdate=true`; that authority without an explicit visibility is `INVALID_INPUT`. The same rule applies to standalone ensure and composite create, and evidence records `visibility_source: create_default | explicit | existing`.

Each top-level semantic array has at most 64 entries and preserves order. `ref` is 1–2048 UTF-8 characters; `label`/`customRelation` 1–256; rationale/decision 1–4096; `key` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; `sourceRefs` has at most 16 unique entries. Reject NUL/control characters, duplicate `ref`, duplicate `(projectId, relation, customRelation)`, duplicate decision key, `customRelation` on non-custom relations, and combined serialized semantic payloads over 65,536 bytes. CLI accepts one JSON object per repeated `--source-context-ref`, `--related-project`, or `--operator-decision`; it accepts no implicit file/`@file`/stdin encoding. MCP accepts native arrays under the camelCase names. Output uses snake_case and byte-preserves validated semantic strings; these values live only in plan/receipt, never YAML/PG/`.project.json` operational fields.

### Result, preflight, action, and effect contract

Every object below is strict: all shown keys are required, unknown keys reject, and `null`/`[]` replace omission. Input and output schemas are separate; output is validated before adapter serialization. The constant prevalidated redacted `INTERNAL_ERROR` result with empty row arrays and `receipt=null` is permitted only before any mutation request or durable lifecycle ID exists; read-only provider observations do not cross this boundary. After that boundary, output is rebuilt from the schema-validated append-only identity/effect journal and must retain the best receipt plus every confirmed or indeterminate effect; a serializer/normalization failure becomes bounded `partial`/6 `INTERNAL_ERROR`, never the null-receipt constant.

```ts
type LifecycleEvidenceV1 = {
  source: "input" | "filesystem" | "git" | "github" | "plane" |
    "registry" | "hermes" | "host" | "service" | "package" |
    "child_stdout" | "child_stderr";
  key: string;
  value: string | number | boolean | null;
  redacted: boolean;
  truncated: boolean;
};
type EffectObservationV1 = {
  state: "absent" | "present" | "unknown";
  evidence: LifecycleEvidenceV1[];
};
type EffectDescriptorV1 =
  | { domain: "path"; kind: "file" | "directory" | "symlink" | "gitmodules" | "gitlink" }
  | { domain: "git"; kind: "repository" | "remote" | "branch" | "index" | "commit" | "push" }
  | { domain: "github"; kind: "repository" }
  | { domain: "plane"; kind: "board" }
  | { domain: "registry"; kind: "yaml_project" | "pg_project" | "pg_repo" | "manifest" | "fleet" }
  | { domain: "hermes"; kind: "agent" | "runtime_repo" | "profile" | "consumer" | "binding" }
  | { domain: "host"; kind: "config" | "directory" | "symlink" | "lock" }
  | { domain: "service"; kind: "unit" | "timer" | "enabled" | "started" }
  | { domain: "package"; kind: "python_dependency" };
type PlannedEffectV1 = EffectDescriptorV1 & {
  effect_id: string; action_id: string; target: string;
  intended_effect: "none" | "create" | "update" | "delete" | "reuse";
  owned: boolean;
};
type LifecycleEffectV1 =
  | EffectDescriptorV1 & {
      effect_id: string; action_id: string; target: string;
      effect: "none" | "created" | "updated" | "deleted" | "reused";
      owned: boolean; confirmed: true;
      before: EffectObservationV1; after: EffectObservationV1;
    }
  | EffectDescriptorV1 & {
      effect_id: string; action_id: string; target: string;
      effect: "indeterminate"; owned: boolean; confirmed: false;
      before: EffectObservationV1; after: EffectObservationV1;
    };
type LifecycleErrorV1 = {
  code: LifecycleErrorCodeV1;
  message: string;
  action_id: string | null;
  field: string | null;
};
type PreflightCheckV1 = {
  id: string; phase: "static" | "live";
  status: "passed" | "failed" | "deferred" | "unknown" | "skipped";
  message: string; evidence: LifecycleEvidenceV1[];
};
type LifecycleActionV1 = {
  id: string; kind: string;
  status: "planned" | "succeeded" | "failed" | "indeterminate" | "not_run";
  planned_effects: PlannedEffectV1[];
  effects: LifecycleEffectV1[];
  evidence: LifecycleEvidenceV1[];
  blocked_by: string[];
  error: LifecycleErrorV1 | null;
};
type LifecycleGuidanceV1 = {
  effect_id: string;
  kind: "compensation" | "reconciliation";
  automatic: false;
  guidance: string;
};
type VerificationEvidenceV1 = {
  surface: string;
  status: "passed" | "failed" | "unknown" | "skipped";
  observed: string;
  redacted: boolean;
  truncated: boolean;
};
type RuntimeRepositoryReceiptV1 = {
  agent_id: string;
  github_repository_id: string;
  repo_url: string;
  branch: string;
  runtime_commit_oid: string;
  parent_gitlink_path: string;
  parent_gitlink_oid: string;
};
type ProjectLifecycleReceiptV1 = {
  schema_version: "pjangler.project-lifecycle-receipt/v1";
  lifecycle_status: "projected" | "provisioning" | "partial" | "active";
  project_id: string | null; repo_id: string | null;
  github_repository_id: string | null;
  parent_repository_name: string; repo_url: string | null;
  local_path: string | null; visibility: "public" | "private" | null;
  github_org: "AutomaticAI-io" | "delorenj" | "IntelliForia" | null;
  ticket_provider: "plane" | "trello" | null; board_id: string | null;
  slug: string; name: string; provisioned_at: string | null;
  agent_ids: string[]; service_ids: string[];
  runtime_repositories: RuntimeRepositoryReceiptV1[];
  source_context_refs: Array<{ kind: SourceContextRefV1["kind"]; ref: string; label: string | null }>;
  related_projects: Array<{ project_id: string; relation: RelatedProjectV1["relation"]; custom_relation: string | null; rationale: string }>;
  operator_decisions: Array<{ key: string; decision: string; rationale: string | null; source_refs: string[] }>;
  effects: LifecycleEffectV1[];
  verification_evidence: VerificationEvidenceV1[];
};
type OutputBudgetV1 = {
  limit_bytes: 8388608;
  serialized_bytes: number;
  mandatory_spine_bytes: number;
  evidence_bytes: number;
  truncated_values: number;
  omitted_evidence_rows: number;
};
type LifecycleResultV1 = {
  schema_version: "pjangler.lifecycle/v1";
  operation: "github_repo_ensure" | "repo_link" | "ticket_board_ensure" |
    "project_create" | "legacy_project_init" |
    "legacy_bootstrap_33god_project" | "legacy_hermes" | "unknown";
  ok: boolean;
  status: "planned" | "succeeded" | "blocked" | "failed" | "partial";
  mode: "static_plan" | "readiness" | "execute";
  dry_run: boolean; live: boolean;
  authority_source: "none" | "canonical_live" | "legacy_local_apply" |
    "direct_legacy_live" | "toad_legacy_handoff";
  gate_source: "none" | "pjangler" | "toad";
  local_write_authorized: boolean;
  external_mutation_authorized: boolean;
  exit_code: 0 | 2 | 3 | 4 | 5 | 6;
  preflight: PreflightCheckV1[];
  actions: LifecycleActionV1[];
  errors: LifecycleErrorV1[];
  compensations: LifecycleGuidanceV1[];
  receipt: ProjectLifecycleReceiptV1 | null;
  output_budget: OutputBudgetV1;
};
```

`ok` is true exactly for `planned|succeeded`; `dry_run` is true exactly for `static_plan|readiness`. `mode` reports normalized request intent even when denied, while authority/gate fields and booleans report issued permission. `receipt` is null when composite identity cannot normalize and for standalone primitives; a normalized composite always returns its best projection/partial receipt. Static projections leave unknown IDs null. Canonical `agent_ids` contains only lifecycle-selected `${slug}-pm`; preserved legacy agents are reused evidence. Runtime receipt rows and provider IDs appear only when independently confirmed.

Identifier/action-kind/evidence-key strings are 1–128 ASCII matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; canonical targets are 1–4096 UTF-8 bytes without controls; public messages/guidance are 1–2048 bytes; `field` is null or a canonical JSON Pointer of 1–512 bytes. Evidence string values are at most 65,536 bytes after ANSI stripping/redaction; numbers are finite safe integers. Each evidence container has at most 64 rows and 262,144 serialized bytes. Each action has at most 256 planned and 256 actual effects. Preflight/actions/errors/compensations are each at most 256; there are at most 1,024 result-wide unique effects, 4,096 evidence rows, and 8,388,608 serialized UTF-8 bytes total. Receipt arrays retain the semantic input limits; agent/service/runtime arrays are unique and at most 64, verification rows at most 256, UUID fields are canonical lower-case UUIDs, other surface/ID/name strings are at most 256 UTF-8 bytes, receipt URLs and physical paths are at most 4096 UTF-8 bytes, branches are at most 255 UTF-8 bytes, observed strings are at most 4096 UTF-8 bytes, receipt effects are at most 1,024, and Git object IDs are lowercase 40/64 hex matching the repository object format.

`blocked_by` contains at most 64 unique earlier preflight/action IDs and is nonempty exactly for `not_run`, preventing cycles. An action error is non-null exactly for `failed|indeterminate` and byte-equals one top-level error with the same `action_id`. Effect IDs are result-wide unique and each effect's `action_id` equals its containing action. Confirmed effects have proved non-unknown before/after observations sufficient for their classification. `effect=indeterminate` exactly when a mutation request was issued but response plus independent observer cannot prove the durable result; its after observation is `unknown`, action is `indeterminate`, error is `MUTATION_OUTCOME_INDETERMINATE`, and overall result is conservatively `partial`/6. It receives only `reconciliation` guidance to re-observe/rerun with the same deterministic identity, never delete/rollback guidance. Planned effects are predictions and never compensation evidence.

The preserved intent-contract `Partial execution` row states one sufficient trigger, not an exhaustive definition: a confirmed changed effect followed by failure is partial, and any indeterminate post-mutation effect is independently partial even when no changed effect can yet be confirmed.

Output construction is deterministic and bounded:

1. Before the first business mutation, require every mutation-capable adapter to declare its complete bounded observer target set; no provider/child/host mutation request may issue when its durable outcome could require an effect row outside that set. Build a request-specific worst-case mandatory-partial projection from the normalized scalar/receipt identities, all preflight/action/error skeletons, every planned descriptor, and one maximum-schema-size actual `indeterminate` effect with evidence-free `before`/`after` states for every target that could be issued, including its duplicate receipt projection and the largest applicable public adapter framing. Canonically JSON-serialize that projection using worst-case still-valid unknown provider/result identifiers. If it exceeds 4,194,304 bytes or cannot be represented within the row limits, block with `OUTPUT_BUDGET_EXCEEDED`/3 and zero mutation. Because execution cannot expand the declared target set, every later confirmed/indeterminate effect and minimal partial receipt fits inside this reserved spine.
2. Record provider identities, allocated lifecycle IDs, and effect observations immediately into an append-only schema-validated journal whose row order is action order then effect ID. Result/receipt effects are derived only from this journal. A post-mutation exception may discard untrusted working objects but not the journal.
3. Give evidence the remaining budget, never less than zero, in this fixed priority: indeterminate-effect observers; confirmed created/updated/deleted observers; failed action/error and failed/unknown preflight evidence; final verification; reused/none effects; successful preflight; planned/child-stream diagnostics. Within a priority, order by owning row order, source, then key. ANSI-strip/redact first; UTF-8 truncate a value at a code-point boundary using deterministic prefix plus `…[N bytes omitted]`; if a row still does not fit, omit it and increment `omitted_evidence_rows`.
4. Canonically serialize and measure actual UTF-8 bytes including JSON escaping and the public adapter framing: zero extra lifecycle bytes for bare MCP `content[0].text`, the normal JSON CLI trailing newline, or, for a nonzero exact `toad_legacy_handoff`, the literal `PJANGLER_TOAD_FAILURE ` prefix plus trailing newline. Recompute `output_budget.serialized_bytes` and serialize until that self-referential byte count reaches a fixed point, then repeatedly shorten or remove only the last eligible evidence value/row in the same reverse priority order until the complete framed output is at most 8,388,608 bytes. Mandatory rows, receipt identity, errors, and confirmed/indeterminate effect descriptors/states are never shortened or removed. `output_budget` reports the final counts and is included in the measured document.
5. Validate the compacted DTO and serialize exactly once. If validation fails after the mutation boundary, construct a minimal `partial`/6 `INTERNAL_ERROR` DTO from the journal, with empty optional evidence arrays and the preserved receipt/effects. The preflight spine check guarantees this minimal form fits; failure to serialize it is a programming defect surfaced by the adapter’s fixed bounded emergency encoder, not permission to emit `receipt=null`.

Preflight status meanings are exhaustive:

| Status | Meaning | Overall outcome |
|--------|---------|-----------------|
| `passed` | Check executed and requirement proved | Does not block |
| `failed` | Check executed and definite prerequisite/conflict failure | Explicit readiness/live blocks with exit `3` |
| `deferred` | Intentionally not run because offline static mode gave no network/credential permission | Does not block a static `planned` result |
| `unknown` | Explicit readiness attempted but timeout/ambiguous/provider-safe evidence could not prove pass/fail | Blocks with exit `3`; never treated as absent |
| `skipped` | Resolved action makes the check inapplicable | Does not block |

| Result/error class | `status` | `ok` | CLI exit / payload `exit_code` | MCP `isError` |
|--------------------|----------|------|--------------------------------|---------------|
| Valid plan/readiness or success/no-op | `planned` / `succeeded` | true | `0` | false |
| Parse/schema/size/unknown input | `blocked` | false | `2` | true |
| Preflight/conflict/readiness unknown | `blocked` | false | `3` | true |
| `LIVE_INTENT_REQUIRED` / `LIVE_GATE_REQUIRED` | `blocked` | false | `4` | true |
| Execution/verification/handler failure before any confirmed changed or indeterminate effect | `failed` | false | `5` | true |
| Failure after a confirmed changed effect, or any indeterminate post-mutation effect | `partial` | false | `6` | true |

### Exhaustive authority truth tables

Canonical four operations have no `apply`, `yes`, `dryRun`, or `local` input:

| `live` | `preflightLive` | Gate exactly `1` | Local durable writes | External/host/push mutation | Result |
|--------|-----------------|------------------|----------------------|-----------------------------|--------|
| false | false | either | no | no; no provider read | static `planned`/0 unless invalid/static conflict (2/3) |
| false | true | either | no | no; read-only provider checks permitted | `planned`/0 if ready, otherwise `blocked`/3 |
| true | either | no | no | no; do not run live preflight | `blocked`/4 `LIVE_GATE_REQUIRED` |
| true | either | yes | yes, as planned | yes, as planned | full preflight then `succeeded`/0, `blocked`/3, `failed`/5, or `partial`/6 |

Legacy CLI `init`/deprecated `project init` and MCP `pjangler_project_init` preserve two axes. CLI resolves local apply as `!dryRun && (apply || yes || confirmed TTY selection)`; MCP uses only explicit `apply`. `yes`/TTY selects local operations and never changes `live`:

| Resolved apply | `live` | Gate exactly `1` | Local writes | External/host/push | Result |
|----------------|--------|------------------|--------------|--------------------|--------|
| false (including any `dryRun=true`) | either | either | no | no | additive legacy plan, `planned`/0 |
| true | false | either | yes, selected local actions only | no | `succeeded`/0 or `failed`/5 |
| true | true | no | no (deny before local work) | no | `blocked`/4 `LIVE_GATE_REQUIRED` |
| true | true | yes | yes | selected live actions | standard execute outcomes |

Legacy bootstrap and every Hermes-capable entry (`hermes-agent`/`hermes`, `add hermes-agent`, `recipe run hermes-agent`, deprecated `init hermes-agent`, `pjangler_deploy_hermes_agent`, `pjangler_run_recipe`, bootstrap agent provisioning) resolve an effect set before execution. Defaults remain surface-specific: explicit Hermes CLI keeps current `local=false`; explicit Hermes MCP and bootstrap keep current `local=true`; generic aliases without a live input are permanently repo-local. `local=true` or subtractive skip flags remove effects only and grant no authority. Existing `dryRun` defaults remain bootstrap true and explicit Hermes CLI/MCP false.

Direct nonlocal legacy CLI/MCP execution requires explicit `live=true`/`--live` and `PJANGLER_ALLOW_LIVE=1`. One compatibility route preserves unchanged Toad: only command token `hermes-agent|hermes` with `yes=true`, `json=true`, `dryRun=false`, `live` omitted, and inherited `TOAD_ALLOW_LIVE` exactly `1` normalizes to `authority_source=toad_legacy_handoff`, `gate_source=toad`, and live intent. This is the exact delegation produced only after Toad receives `live:true`; optional `--local` and `--skip-*` still subtract effects. `TOAD_ALLOW_LIVE` alone, `--yes` alone, any near miss, or use through canonical tools, MCP, init/add/recipe/bootstrap aliases grants nothing. Scrub both gate variables from all grandchildren after authority resolution.

Unchanged Toad's `hermesDeploy` treats any parseable child JSON as `deployed: true` even when the child exit is nonzero. Therefore the exact `toad_legacy_handoff` adapter has a narrow output rule: a `succeeded`/0 result writes the normal valid legacy JSON to stdout; a `blocked|failed|partial` result preserves exit `2|3|4|5|6`, writes nothing to stdout, and writes exactly one ANSI-free redacted compact line `PJANGLER_TOAD_FAILURE <LifecycleResultV1-json>\n` to stderr. Before compacting that nonzero result, the adapter includes the exact UTF-8 bytes of the literal prefix and final newline in the 8,388,608-byte limit; `output_budget.serialized_bytes` is the byte length of the complete framed stderr line, not merely the embedded JSON. The embedded result retains any partial receipt/effects. This makes unchanged Toad take its existing `!r.ok && r.json === undefined` error branch and return `isError=true`, never `deployed:true`. No other CLI/MCP surface receives this exception, no gate is weakened, and no Toad edit/test/build is in PJAN-27 scope.

| `dryRun` | Selected non-target effect exists | `live` | Gate exactly `1` | Local writes | External/host/push | Result |
|----------|-----------------------------------|--------|------------------|--------------|--------------------|--------|
| true | either | either | either | no | no | plan, `planned`/0 |
| false | no (`local=true` defaults or all explicit skips) | either | either | repo-owned only | no | execute local, standard 0/5 outcome |
| false | yes | false and no exact Toad handoff | either | no (deny atomically) | no | `blocked`/4 `LIVE_INTENT_REQUIRED` |
| false | yes | true | no | no | no | `blocked`/4 `LIVE_GATE_REQUIRED` |
| false | yes | true | yes | yes | exactly selected effects | standard execute outcome |

For the preceding table, the exact Toad handoff resolves the last two authority columns as `live=true` and gate `yes`; direct requests never use the Toad gate. Tests cover the accepted tuple and every one-field near miss.

Role scope is also surface-specific. Canonical `project_create` selects/owns only `${slug}-pm`; PM-only is not a repository uniqueness rule. New legacy Hermes/init/bootstrap requests accept exactly `pm|dev|review|ops|qa`, retain the requested role, and add it without replacing other roles. Existing persisted custom/opaque role keys, values, role directories, and provisioning states remain readable and round-trip unchanged in YAML, PG, manifest, list/show/doctor, and legacy payloads, but cannot be newly provisioned in this milestone. Unsupported new role input is `INVALID_INPUT` before mutation; there is no deletion, coercion, rename, or migration. Canonical receipt `agent_ids` lists only lifecycle-owned PM, while all other roles appear as preserved/reused evidence.

Legacy result payloads retain current top-level fields (`project`, `plan`, `actions`, `dryRun`, `logs`, `errors`, `context`, etc.) and their existing shapes, then add exactly one collision-free `lifecycle: LifecycleResultV1` field; table status/exit/`isError` values refer to that nested result. The sole representation exception is the explicit nonzero exact-Toad stderr bridge above. No existing safe caller must parse a replacement-only shape. The bootstrap defaults remain `dryRun=true`, `local=true`, `skipPlane=true`, accept Trello, and require neither `githubOrg` nor visibility. It calls the lower-level shared local bootstrap/Hermes primitives, never `project_create`.

### Composite phases and PM/sentinel model

After static validation and gate issuance, run the complete live preflight, acquire the deterministic project lock, then repeat every volatile path/ref/provider identity check under that lock before the first business mutation. The injected lock root is a private mode-0700 runtime/scratch directory keyed by SHA-256 of canonical physical target plus normalized project remote; its mode-0600 lock file is a declared temporary host-lock effect, is never receipt/business state, and is removed on release. Lock timeout is `CONCURRENT_OPERATION` with zero business mutation. Execute exactly:

1. `github.repo.ensure` -- create/reuse/update exactly `${githubOrg}/${slug}` (never display `name`) and capture immutable provider ID, canonical URL, visibility source, and remote default state.
2. `git.prepare` -- clone a non-empty remote into an absent/empty target, or initialize/reuse the safe target; check out/ff-only the resolved branch; add only a missing matching `origin`; leave an existing Git root with no lifecycle commit/push yet.
3. `plane.board.ensure` -- create/reuse/update one project board and capture its verified tenant-scoped ID; Hermes board creation is disabled.
4. `commonproject.render` -- render against the Git root with board identity, capture child streams, and derive exact owned before/after effects.
5. `state.stage` -- allocate/reuse UUIDs and one injected-clock `provisioned_at`, then atomically persist `provisioning` identity/board, the confirmed parent provider repository ID/name/URL/visibility/branch, and planned PM/service/ownership state to YAML, optional PG, and `.project.json`; IDs and timestamp become durable before Hermes and are reused byte-for-byte on every matching rerun.
6. `hermes.render` -- render the pinned initialized template with `--skip-tasks`; `${slug}-pm` is the only lifecycle-owned agent. The pinned template's clock-derived top-level `role.yaml` `provisioned_at` is not authoritative: after render, parse the owned YAML, set that scalar to the persisted lifecycle `provisioned_at`, render canonically, and reject duplicate/malformed/non-scalar fields. On rerun, preserve the same stored value so an identical render is no-diff. Sentinel true implies PM and adds service identity `hermes-${slug}-pm-heartbeat` with `.service`/`.timer`, never a second agent. Preserve every legacy role unchanged.
7. `hermes.runtime.converge` -- acquire the runtime heartbeat lock after the bound runtime exists (project lock first, heartbeat lock second), ensure/reuse the exact runtime repository, build/scan its complete desired tree, create one owned runtime commit when needed, re-read the remote OID, ordinary-push, and prove remote runtime OID equals that commit. Hold both locks afterward.
8. `git.commit-content` -- set/add the parent submodule at the proved runtime OID; verify `.gitmodules` plus index mode `160000`; converge other repo-owned output and a `provisioning` manifest; stage exactly the NUL-delimited ledger, commit once when non-empty, re-read parent remote OID, ordinary-push, and prove the pushed commit contains the exact gitlink.
9. `hermes.host-and-state` -- atomically materialize private Plane env/profile/fleet/consumer/unit effects, then enable/start only selected units while the heartbeat lock prevents autonomous checkpoint work. Observe exact unit states, write the active service/ownership manifest, and make at most one state-only parent commit/push containing exactly `.project.json` when observation changed it. Any service or final state-push ambiguity is partial; no automatic disable/delete occurs.
10. `state.promote-and-verify` -- after remote parent HEAD contains the active manifest, promote PG in one transaction when enabled and authoritative YAML `active` last. Verify YAML/PG/manifest mappings, physical path, internal UUIDs, immutable parent/runtime provider repository IDs, exact names/URLs/refs/OIDs, persisted `provisioned_at`, parent gitlink, Plane tenant/board, roles/services, owned index/worktrees, secret-free evidence, and receipt. Release heartbeat then project lock only after verification/finalization. A partial rerun repairs mirrors/state from the same IDs, timestamp, and observed OIDs without duplicate resources.

Every parent/runtime push is ordinary, preceded immediately by a remote-OID check, and independently observed afterward. A no-diff phase makes no commit. Runtime push precedes the parent content/gitlink push; host/timer activation follows that proved parent push; the optional final parent state commit contains only `.project.json`. The held heartbeat flock makes an early timer tick skip, so it cannot race either parent verification. Same-input reruns ignore `.done-*` markers and derive state only from providers, Git refs/index, physical files, service observers, and the versioned ownership record.

Complete Hermes preflight covers Copier `>=9` plus `--skip-tasks`, both exact pinned gitlinks, physical Git root/targets, controlled Git support, private lock acquisition capability, exact HOME/profile/fleet/runtime/env/unit targets, Hermes/gh/git/systemctl/Python dependencies selected by the plan, runtime provider/local identity, secret transport, user-systemd, and Bloodbank below. Telegram/email are `skipped` in composite scope. No opaque template task script is executed by composite; its unsafe runtime/Bloodbank/systemd scripts are evidence to replace with structured subactions.

### Runtime repository, seed, and rerun contract

PJAN-27 fixes the v1 runtime identity to private GitHub repository `delorenj/agent-hm-${slug}-pm`, branch `main`, agent `${slug}-pm`; no host-config owner derivation exists. Persist immutable provider repo ID, canonical URL, project/repo/agent IDs, final branch/OID, and parent gitlink in ownership state. A tracked strict `.pjangler-runtime.json` (`schema_version: pjangler.hermes-runtime/v1`) contains exactly those non-secret IDs plus parent provider repository ID, `${githubOrg}/${slug}` name-with-owner, canonical URL, project slug, and the persisted `provisioned_at`. Existing remote heads are reusable only when provider ID/name-with-owner/private visibility, marker, branch, timestamp, and prior ownership all agree. A provider-proved headless runtime repository may resume only when a confirmed prior partial create effect binds its immutable provider ID, expected private name-with-owner, project/repo/agent IDs, URL, and branch; otherwise missing marker/ownership is `RUNTIME_REPO_IDENTITY_MISMATCH`. Name coincidence is never adoption.

An existing local runtime is reusable as the registered mode-`160000` submodule at `agents/hermes/pm/runtime`, with matching canonical URL/OID and clean controlled worktree. The sole recovery exception is an interrupted lifecycle-created nested worktree at that exact physical path: a confirmed partial runtime row/effect must bind the same project/repo/agent/provider IDs, URL, branch, remote OID, and before-absent path, while controlled Git proves its origin, marker, HEAD, index, and worktree are exact and clean; recovery may then register that same OID as the gitlink. Any unrecorded ordinary directory, symlink, nested repo, mismatched gitlink, dirty state, or unbound remote blocks; never `rm -rf` or replace it. A bound remote-ahead runtime may ff-only under both locks, then updates the parent gitlink; divergence/unrelated history blocks. Creation/retry uses deterministic provider identity and re-observes before create, so timeout never causes blind duplicate creation.

Runtime tracking is dual-mode and must converge across canonical lifecycle, parity, and legacy recipe surfaces. For each `agents/hermes/<role>/runtime`, `src/parity/index.ts` and `UntrackHermesRuntimes` first parse strict `.project.json automation.lifecycle`. They classify only the exact PM path as `lifecycle-owned` when its runtime row binds the same agent/provider ID/name/URL/branch, `.gitmodules` binds the same canonical URL, the index entry is mode `160000` at the recorded OID, and the owned-path snapshot agrees. A lifecycle-owned row must be tracked and must not be ignored; audit passes it, migration is a no-op, and the legacy recipe preserves it. A missing/malformed/conflicting lifecycle claim is a non-fixable ownership failure and is never "repaired" by untracking. Every runtime without such a claim remains `legacy-untracked`: audit requires it untracked plus `runtime/` ignored and the existing migration/recipe may perform only that legacy untrack/ignore action. No path/role/name heuristic upgrades legacy state into lifecycle ownership.

Build a new/changed runtime in a private mode-0700 scratch directory from exact owned leaves only: `.gitignore`, `.gitattributes`, `README.md`, rendered `bloodbank-consumer.py`, `decisions/.gitkeep`, `logs/.gitkeep`, `memories/MEMORY.md`, `memories/USER.md`, role `SOUL.md`, `profile.yaml`, optional delta `config.yaml`, and `.pjangler-runtime.json`. `profile.yaml` is exactly `config.inherit_from: default` plus `config.save_mode: delta`; `config.yaml` contains only explicit lifecycle model/provider/PM-TTS choices and canonical physical `terminal.cwd`. Never copy global `~/.hermes/config.yaml`, `.env`, auth, sessions, caches, plugins, skills, arbitrary profile content, or unreadable/binary/placeholder-bearing input.

Before staging and again over exact staged blobs, a mandatory in-process fail-closed scan rejects any registered secret byte sequence, private-key block, high-signal credential prefix, or nonempty secret/token/password/API-key assignment. Every regular file is readable, at most 1 MiB, and total scanned bytes are at most 8 MiB. Stage only the sorted allowlist with NUL pathspecs, never `git add -A`; optional gitleaks cannot convert a scan error into success. Post-checkout local plugin links stay untracked or are skipped. Runtime `.env` is written only after the tracked tree is proved and remains ignored.

### Plane runtime credential and secret transport boundary

After tenant-aware core resolution, register the selected secret with `CommandRunner`; build each child env from a public allowlist and pass only selected `PLANE_API_KEY`, `PLANE_BASE`, and `PLANE_WORKSPACE`. Strip every other `PLANE_*`, legacy global key, gate variable, inherited credential, and provider environment entry. Atomically write the same three validated values inside a bounded managed `pjangler.lifecycle-plane/v1` block in `agents/hermes/pm/runtime/.env`, mode `0600`, current uid, regular no-follow file; reject links, other owners, controls/newlines, and unmanaged conflicting assignments. The file is a confirmed private host effect but is ignored and never staged.

Lifecycle-owned PM/sentinel units load only that runtime env for Plane credentials; they do not load `%h/.config/hermes-agent/env`, `%h/.hermes/env`, or `%h/.hermes/hermes-agent.env`. Non-`33god` never resolves or materializes global/33god fallbacks. Plans/receipts expose only source variable/config-field name, never value, hash, header, or derived token evidence.

Across canonical and participating legacy adapters, before spawn reject an argv element containing an exact registered secret or secret-bearing header/assignment with `SECRET_IN_ARGV`. Secrets may enter only the minimal child env, private stdin/FD, or the no-follow file above. Curl receives headers through private stdin config/FD; legacy `op item create` receives Telegram/email fields through stdin JSON/template. Displayed argv, plans, errors, evidence, logs, and exceptions contain no secret or hash.

### Bloodbank dependency contract

PJAN-27 performs no Bloodbank package install. When selected, preflight canonicalizes `${HERMES_AGENT_REPO}/.venv/bin/python`, requires it be an executable regular file contained by the canonical Hermes repo, and runs only `python -I` import/version probes through the captured runner. Both `import nats` and `importlib.metadata.version("nats-py") === "2.15.0"` must pass before any mutation; otherwise `MISSING_DEPENDENCY` blocks with external remediation guidance. Provisioning renders the pinned consumer, rejects unresolved placeholders, points its unit to that exact interpreter, and records the package as confirmed `reused`. Never run `uv`/`pip`, mutate the shared venv/lock, ignore probe failure, or mark dependency success from a marker. `--skip-bloodbank` removes probe/consumer/unit; NATS unreachability remains a bounded warning because the consumer retries.

### Git ownership, refs, and remote history

Target identity is physical, not lexical. Validate and absolutize the input; `lstat` every existing component and capture `(dev, ino, mode)` plus any link target; compute `physical_target` with `realpath.native(existing target)` or `realpath.native(deepest existing ancestor)` plus a validated missing suffix. If any existing component is a symlink or lexical absolute input differs from `physical_target`, block `TARGET_PATH_ALIAS`, return the redacted canonical path, and require a new request using that physical path; never silently follow an alias. Store/compare only `physical_target` in YAML/PG/manifest. Rewalk immediately before every mutation phase and final verification; changed component identity or canonical root is `PATH_IDENTITY_CHANGED` (blocked before business mutation, partial after an attempted mutation). Create missing directories one component at a time and `lstat` each as a real directory. Two aliases resolving to one physical target are one identity and cannot bind different UUIDs.

`initialCommitPaths` are exact normalized repo-relative leaf paths: no absolute paths, `..`, glob metacharacters, directories, `.git` paths, duplicates, or ancestor symlinks from the physical repo root. A safe relative leaf symlink is staged as the link object and records its target; absolute/out-of-root targets block. A nested repository is never converted implicitly: it is allowed only when already indexed as mode `160000`, its OID is captured, and `.gitmodules` is separately approved/owned. Existing-HEAD standalone link rejects `initialCommitPaths`, requires clean index/worktree, and never commits caller changes. Composite updates are owned only when absent or when prior mode/hash/target/OID exactly matches `pjangler.path-ownership/v1`; caller drift blocks. Deletion requires an exact planned path plus matching prior ownership; otherwise it remains unstaged.

| Local target | Remote/default-branch state | Required behavior |
|--------------|-----------------------------|-------------------|
| Any target, provider proves remote resource absent | Standalone repo-link cannot create a provider resource | `REMOTE_NOT_FOUND`; no target mutation |
| Absent/empty, provider proves composite project repository absent | Composite GitHub ensure is authorized to create; creation is re-observed as headless before Git preparation | Create once, then initialize the resolved branch and wait for owned render before the first push |
| Non-git non-empty, provider proves composite project repository absent | Composite has no caller-content adoption authority | `INITIAL_COMMIT_APPROVAL_REQUIRED` before GitHub creation or target mutation |
| Any target, remote/auth/transport state not proved | Absence is never inferred from `ls-remote` failure | Readiness `unknown`; no mutation |
| Absent/empty, provider-proved repository exists with zero heads (headless) | Resolve explicit branch or `main`; init `-b`, add origin; standalone empty target may create one allow-empty commit, composite waits for owned render | Normal first push only |
| Absent/empty, remote has heads | Clone `origin` at remote HEAD/default branch | Reuse history; no initial commit |
| Non-git non-empty, provider-proved repository exists with zero heads | Standalone requires nonempty exact `initialCommitPaths`; initialize and commit only them. Composite has no adoption input and always blocks before target mutation | Standalone normal first push / composite `INITIAL_COMMIT_APPROVAL_REQUIRED` |
| Non-git non-empty, remote has heads | Never overlay or merge | `REMOTE_HISTORY_CONFLICT` |
| Existing repo, origin absent | Add requested origin after identity/history preflight | Preserve every other remote |
| Existing repo, normalized origin mismatch | No change | `REMOTE_MISMATCH` |
| Detached HEAD or explicit branch differs from non-empty remote default | No change | `DETACHED_HEAD` / `DEFAULT_BRANCH_MISMATCH` |
| Local HEAD equals remote branch | Reuse/no push unless later owned commit exists | Idempotent success |
| Remote HEAD is ancestor of local HEAD | Local is ahead | Ordinary push allowed |
| Local HEAD is ancestor of remote HEAD | Local is behind | Clean target ff-only during Git preparation before generators |
| Histories diverge/unrelated, desired branch absent while another remote default exists, or ancestry cannot be proved | No merge/push | `REMOTE_HISTORY_CONFLICT` or readiness `unknown` |
| Remote advances after preflight | Do not retry with force/merge | Normal push fails; result failed/partial according to confirmed prior effects |

Headless means the provider independently proves the repository exists and a successful controlled `ls-remote --heads` returns no refs. Readiness compares ancestry in an injected private scratch repo populated by read-only fetches; scratch creation/cleanup is the only offline-excluded preflight filesystem write and never occurs under target/HOME/registry. Scratch effects are not business effects. Remote identity normalizes SSH/HTTPS and optional `.git`; provider evidence plus `ls-remote --symref` establish immutable repo ID/default branch. No force/lease, merge/rebase, default-branch rewrite, or origin replacement exists.

Every lifecycle Git child uses an allowlisted environment built from scratch. Set `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, fixed `LC_ALL=C`/`TZ=UTC`, and controlled pager/editor values. Remove inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, object/alternate-object/config variables, `GIT_SSH*`, `SSH_AUTH_SOCK`, askpass, signing-agent, credential, identity/date/email, and gate variables before adding explicitly specified values. Every command receives `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, `-c core.attributesFile=/dev/null`, `-c credential.helper=`, `-c commit.gpgSign=false`, `-c tag.gpgSign=false`, `-c push.gpgSign=false`, `-c push.default=nothing`, `-c push.followTags=false`, `-c push.autoSetupRemote=false`, `-c push.pushOption=`, `-c protocol.allow=never`, and explicit allow only for the normalized `https` or `ssh` transport. Commands against an existing worktree also use the independently resolved `--git-dir=<absolute-git-dir>` and `--work-tree=<physical_target>` rather than repository discovery. Commit adds `--no-gpg-sign`; push adds `--porcelain --no-signed --no-recurse-submodules --no-follow-tags`. Init uses an injected empty template directory, so template hooks cannot copy in.

Before checkout/add/commit/push, parse every repository-local and worktree-local config entry with includes disabled and origins/scopes visible. Block any `include/includeIf`, `core.worktree`, `core.bare` other than one unambiguous boolean `false`, `url.*.insteadOf/pushInsteadOf`, multiple fetch URLs, any pushurl, `remote.*.push`, `remote.*.mirror`, `remote.pushDefault`, `branch.*.pushRemote`, `push.default`, `push.followTags`, `push.autoSetupRemote`, `push.pushOption`, hooks/fsmonitor, credential/helper, `core.sshCommand`, signing, remote proxy/helper, external filter, or shell-valued submodule-update configuration. Independently require controlled `rev-parse --is-bare-repository` to be exactly `false` and physical `--show-toplevel` to equal `physical_target` before and after every worktree mutation; a linked-worktree git dir may live outside the target, but its resolved top-level may not. Any violation is `UNSAFE_GIT_CONFIG` before mutation or partial after an issued mutation. Fetch without checkout; inspect committed `.gitattributes` blobs and local `.git/info/attributes`; run controlled `check-attr` for every checkout/owned path. Any active `filter` blocks unless a future explicitly injected filter adapter owns it; never silently bypass required LFS or another transform. This is required even though the current host has configured LFS filters and a credential helper.

HTTPS authentication uses only an injected private askpass/FD boundary; SSH is allowed only through an injected wrapper fixing `-F /dev/null`, batch mode, exact identity/agent FD, known-hosts policy, and protocol. No secret enters argv. Pass the canonical URL directly, verify observed fetch/push URL, and reject rewrite behavior. Every push uses exactly one non-force fully qualified refspec `refs/heads/${branch}:refs/heads/${branch}` after proving the local source ref equals the intended commit and the just-reobserved remote destination is its expected ancestor/absence. Never use `HEAD`, an abbreviated destination, configured remote selection, `--set-upstream`, wildcard/matching refspecs, tags, push options, force, or lease. Parse `--porcelain` and then re-read the destination OID; any additional ref update or mismatch is `UNDECLARED_EFFECT`/partial. All Git children use piped stdio/timeouts/redaction and the same declared effect observers.

Lifecycle-created commits use no host identity, editor, template, signing, or wall-clock default. Set all six variables exactly: `GIT_AUTHOR_NAME=Pjangler Lifecycle`, `GIT_AUTHOR_EMAIL=pjangler@localhost.invalid`, `GIT_COMMITTER_NAME=Pjangler Lifecycle`, `GIT_COMMITTER_EMAIL=pjangler@localhost.invalid`, and both `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` to the persisted UTC `provisioned_at`. Use exactly one `-m` argument and these messages: runtime `chore(pjangler): converge ${agent_id} runtime`; parent content/gitlink `chore(pjangler): converge ${slug} lifecycle`; optional active-state-only parent commit `chore(pjangler): activate ${slug} lifecycle`. Reject controls/newlines in substituted IDs, pass `--no-verify --no-gpg-sign`, and create no commit when the exact owned index tree is unchanged. Tests inspect author, committer, both timestamps, full message, tree, parent, and OID stability across identical reruns.

### Registry identity and convergence

`project_id` and `repo_id` are optional canonical lower-case UUID strings on old YAML records and `.project.json`; new lifecycle records require both. Across loaded YAML, manifest, and all enabled-PG rows selected by slug/project ID/repo ID/physical local path, no UUID binds more than one entity and project/repo IDs never alias. A slug fixes project ID; project ID fixes slug; repo ID fixes project/physical path; physical path fixes both IDs. `force`/overwrite never relaxes identity/ownership.

For old lexical paths, preflight canonicalizes every path in memory only. Two records resolving to one physical path with different identity block. A targeted old record resolving to the requested physical path and otherwise matching may update that same record/PG repo ID to the canonical path during `state.stage`, as a declared effect; unrelated records are never rewritten. Any symlink-chain drift or conflicting PG local path blocks. New and manifest `repo_path` values are physical.

When `PJ_REGISTRY_PG` is disabled, PG rows are not read/written. When enabled for lifecycle mode, live preflight connects and queries by slug/project ID/repo ID/physical path before mutation. Existing matching PG IDs win for an old YAML projection missing IDs; contradiction blocks. New inserts explicitly provide `projects.id`/`repos.id`; matching conflicts update mutable columns only after ID equality. Remove the repo-path reassignment upsert; never use `ON CONFLICT(local_path) DO UPDATE project_id`. Existing slug-NULL rows remain untouched. No migration/schema/backfill is part of PJAN-27.

Existing `projects.automation` JSONB is the no-migration lifecycle carrier. Extend optional `ProjectAutomation` without changing registry schema `1`:

```ts
type LifecycleUnitStateV1 = {
  name: string;
  kind: "service" | "timer";
  file_state: "absent" | "present" | "unknown";
  enablement: "not-applicable" | "disabled" | "enabled" | "unknown";
  active_state: "inactive" | "activating" | "active" | "failed" | "unknown";
};
type LifecycleServiceStateV1 = {
  service_id: string;
  owner_agent_id: string;
  kind: "gateway" | "consumer" | "heartbeat";
  provisioning_state: "planned" | "provisioning" | "active" | "partial" | "skipped";
  units: LifecycleUnitStateV1[];
};
type OwnedPathV1 = {
  path: string;
  state: "present" | "absent";
  kind: "file" | "symlink" | "gitmodules" | "gitlink";
  owner_action_id: string;
  mode: "100644" | "100755" | "120000" | "160000" | null;
  sha256: string | null;
  link_target: string | null;
  gitlink_oid: string | null;
};
type PathOwnershipSnapshotV1 = {
  schema_version: "pjangler.path-ownership/v1";
  object_format: "sha1" | "sha256";
  producers: Array<{
    id: "commonproject" | "hermes-agent" | "pjangler";
    revision: string;
  }>;
  paths: OwnedPathV1[];
};
type RuntimeRepositoryOwnershipV1 = {
  agent_id: string; github_repository_id: string; name_with_owner: string;
  canonical_url: string; branch: string;
  provisioning_state: "provisioning" | "partial" | "active";
  runtime_commit_oid: string | null;
  parent_gitlink_path: string; parent_gitlink_oid: string | null;
};
type ParentRepositoryOwnershipV1 = {
  github_repository_id: string;
  name_with_owner: string;
  repository_name: string;
  canonical_url: string;
  visibility: "public" | "private";
  branch: string;
};
type ProjectAutomation = {
  reconcile?: { enabled: boolean; grace_hours: number; auto_review: boolean };
  lifecycle?: {
    schema_version: "pjangler.lifecycle-state/v1";
    status: "provisioning" | "partial" | "active";
    provisioned_at: string;
    parent_repository: ParentRepositoryOwnershipV1;
    services: LifecycleServiceStateV1[];
    runtime_repositories: RuntimeRepositoryOwnershipV1[];
    ownership: PathOwnershipSnapshotV1;
  };
};
```

All stored objects are strict. `parent_repository.repository_name` equals normalized `slug`, `name_with_owner` equals `${github_org}/${slug}`, and its immutable provider ID, canonical URL, observed visibility, and resolved branch must be independently confirmed before `state.stage`; no internal UUID may substitute for the provider ID. `provisioned_at` is the one injected-clock sample allocated for the lifecycle identity, canonical UTC `YYYY-MM-DDTHH:mm:ssZ`; a matching provisioning/partial/active rerun must reuse it byte-for-byte and never sample a replacement. Services and runtime rows sort by unique identity and each have at most 64 entries. IDs/unit names are 1–256 safe bytes; provider IDs are 1–256 safe bytes; URLs/paths are at most 4096 bytes; branches at most 255; non-null OIDs are lowercase 40/64 hex. A runtime row is created only after immutable provider repository identity is independently confirmed; `null` OIDs mean the corresponding commit/gitlink is not yet confirmed, never that an unknown value was guessed. `provisioning|partial` rows persist only confirmed fields, while `active` requires both non-null OIDs equal the observed remote runtime commit and parent gitlink. Gateway/consumer each have exactly one `.service`; heartbeat has exact `hermes-${agentId}-heartbeat.service` and `.timer`; corresponding base IDs are `hermes-${agentId}-gateway|consumer|heartbeat`. An `active` projection contains no `unknown` state. Preserve `automation.reconcile` and every unrelated automation key.

`PathOwnershipSnapshotV1` has at most 16 unique producers, 4,096 byte-sorted unique leaf paths, and 1,048,576 canonical serialized UTF-8 bytes. Producer revisions are 1–128 bytes and identify pjangler `1.2.19` plus exact pinned template commits. Paths are normalized POSIX repo-relative leaves of 1–4096 bytes with no controls, absolute/`.`/`..`/`.git`/glob semantics. Present file/gitmodules uses mode `100644|100755` and lowercase raw-byte SHA-256; present symlink uses `120000` plus safe relative target; present gitlink uses `160000` plus 40/64-hex OID matching object format. Irrelevant fields are null. Absent tombstones have all content fields null and remain only while the pinned producer still declares that target. `.project.json` is excluded from its own path list to avoid self-reference but remains structurally owned by schema/project/repo identity and a normal ledger effect.

Ownership comparison is exact: unrecorded+absent may be created; recorded-present must match mode and digest/target/OID before reuse/update/delete; recorded-absent must remain absent. Existing unrecorded, missing recorded-present, mismatched recorded state, or a legacy manifest lacking ownership where an existing generated leaf would be touched blocks `OWNERSHIP_RECORD_REQUIRED`/`OWNED_PATH_DRIFT`. Deletion needs prior ownership and an exact planned path. Keep one current snapshot, not history; active promotion replaces it from confirmed state, while partial finalization merges only confirmed observations and never converts an indeterminate effect into ownership.

Persistence mapping is exact: aggregate lifecycle status is YAML `ProjectRecord.status` ↔ PG `projects.status` ↔ manifest lifecycle status; agents are YAML/manifest agent map ↔ PG `project_agents` rows; `provisioned_at`, parent provider repository identity, services, runtime ownership, and path ownership are byte-equivalent canonical `automation.lifecycle` in YAML and `.project.json` and parsed-equivalent PG `projects.automation->'lifecycle'`. Receipt `github_repository_id`, `parent_repository_name`, `repo_url`, visibility, branch evidence, and `provisioned_at` come from that projection; internal `repo_id` remains distinct. Services are never synthetic agent rows. Lifecycle PG writes read/merge only the `lifecycle` key, preserve all other JSONB keys, and propagate transaction errors; legacy dual-write stays best effort. Old records may omit every additive field and remain readable without backfill.

Mirror transitions are exact: absent/old → `provisioning` during `state.stage`; runtime/content convergence merges confirmed substates while retaining provisioning; after selected host/service observers finish, the manifest becomes the active state-only commit candidate; only after that commit is pushed does PG promote transactionally and authoritative atomic YAML promote `active` last. Failure triggers best-effort local `partial` containing only confirmed substates plus visible indeterminate effects in the receipt. If promotion stops midway, YAML remains provisioning/partial and the identical rerun reuses IDs/OIDs/effects and finishes mirrors; no replacement/duplicate. Legacy init retains best-effort optional PG; strict mirroring is lifecycle-only.

### Plane tenant resolution

Normalize workspace for environment lookup with `trim → uppercase → every non-alphanumeric run to '_' → trim '_'`; reject empty output. For workspace key `W`, resolve API key in order: `PLANE_${W}_API_KEY`; `api_key_env` named by the exact workspace entry in `${PJANGLER_PLANE_WORKSPACES_FILE:-~/.claude/plane-workspaces.json}` (safe env-name syntax only); then, only when requested workspace is `33god`, compatibility `PLANE_API_KEY`. Resolve base in order: `PLANE_${W}_BASE_URL`; `PLANE_${W}_BASE`; configured workspace `base_url`; then, only for `33god`, `PLANE_BASE_URL`, `PLANE_BASE`, `https://plane.delo.sh`. Normalize a hostname to HTTPS; require HTTPS except an injected loopback test endpoint. Non-`33god` requests never consume global/legacy/default `33god` values.

Preflight evidence exposes source variable/config field names, never values. Read-only auth must prove that the resolved base returns the exact requested workspace slug; all searches/board IDs must be scoped to it. A base/workspace mismatch is `PLANE_TENANT_MISMATCH`, not absence. Preserve input presence for `name` and `description`. Search the exact workspace by case-insensitive identifier and, when supplied, exact `boardId`; zero identifier matches means absent, one means the candidate, and multiple or an explicit-ID mismatch is `PLANE_BOARD_CONFLICT`. When `name` is omitted, candidate display name is neither a match key nor desired state: reuse its observed name unchanged, even if an operator renamed it. When `description` is omitted, likewise preserve the observed description. On absence, omitted values create with `name=identifier` and `description=""`. Explicit name/description are desired mutable fields: matching execution updates only the explicitly supplied fields whose observed values drift. Independently, a board in the workspace using an explicitly supplied desired name under a different identifier/ID blocks as a name collision; omitted name performs no name-collision search. Persist only tenant/provider/identifier/board ID in the existing board projection and re-observe mutable fields from Plane on rerun; no migration or invented name/description column is allowed.

### Output and outer failure isolation

The core returns data and writes only to an injected sink. Children use piped stdio; captured stdout/stderr are separately ANSI-stripped, secret-redacted, capped at 65,536 UTF-8 bytes, and attached as typed evidence with `redacted`/`truncated`. Normal JSON CLI validates and buffers all rendering, writes exactly one JSON document plus newline to stdout and nothing to stderr. The only exception is a nonzero exact `toad_legacy_handoff`, which writes empty stdout plus the single bounded `PJANGLER_TOAD_FAILURE` stderr line defined in the authority section so unchanged Toad surfaces an error. Canonical human CLI renders the same result; legacy human rendering remains compatible. MCP reserves process stdout for SDK transport; canonical tool data is one validated lifecycle JSON document in `content[0].text`, and `isError` is always exactly `exit_code !== 0`.

Commander uses `exitOverride`, configured writers, and one top-level `parseAsync` catch that infers operation from raw argv (or `unknown`) and serializes lifecycle unknown-command/option, missing value/argument, coercion, and handler failures. Ordinary human help/version stay exit-0 text; combining either with lifecycle `--json` is `INVALID_INPUT` so machine mode remains one envelope.

Locked MCP SDK `1.29.0` creates three normative layers:

1. Malformed JSON or an invalid general JSON-RPC envelope is owned by stdio transport/`JSONRPCMessageSchema` before routing. Preserve SDK transport/error behavior; do not promise `LifecycleResultV1` or even a call result.
2. A transport-accepted `tools/call` message that fails `CallToolRequestSchema` -- including non-string `params.name` or present non-object `params.arguments` -- remains a standard JSON-RPC error and invokes no lifecycle/provider code. Register the low-level handler with a method-literal generic request schema, not exact `CallToolRequestSchema`, so `Server.setRequestHandler` performs its explicit exact `safeParse` and deterministically raises `McpError(InvalidParams, -32602)`; registering the exact schema first is forbidden because the lower protocol parser can map its uncoded Zod failure to `-32603`.
3. Only a request that passes `CallToolRequestSchema` and names a known canonical or participating legacy lifecycle tool enters lifecycle routing. Treat missing arguments as `{}` and run strict tool-specific `safeParse` inside the handler; missing fields, unknown keys, nested type/limit errors return a normal JSON-RPC result containing schema-valid `LifecycleResultV1(INVALID_INPUT)` with exit 2 and `isError=true`. Catch unexpected lifecycle handler errors there as `INTERNAL_ERROR`. A protocol-valid unknown tool name retains SDK not-found semantics, and non-lifecycle tools retain their payload/error semantics.

`tools/list` publishes generated strict schemas from the same registry. Do not use high-level `registerTool` validation for lifecycle names because it validates arguments before callbacks. The preserved intent-contract phrase "invalid MCP field/type/limit" normatively means invalid tool-specific data inside `params.arguments` after layer 2 succeeds; it does not include layers 1 or 2. SDK validation of the generic `CallToolResult` remains the final protocol wrapper check; lifecycle output validation happens first. No stack, raw child object, secret value/hash, ANSI, or unbounded text enters human/JSON/MCP output.

Stable error codes are: `INVALID_INPUT`, `LIVE_INTENT_REQUIRED`, `LIVE_GATE_REQUIRED`, `MISSING_DEPENDENCY`, `AUTH_REQUIRED`, `AUTH_FORBIDDEN`, `READINESS_UNKNOWN`, `OUTPUT_BUDGET_EXCEEDED`, `CONCURRENT_OPERATION`, `TARGET_CONFLICT`, `TARGET_PATH_ALIAS`, `PATH_IDENTITY_CHANGED`, `DIRTY_WORKTREE`, `INITIAL_COMMIT_APPROVAL_REQUIRED`, `UNSAFE_SYMLINK`, `UNSAFE_GIT_CONFIG`, `UNSAFE_GIT_FILTER`, `UNOWNED_PATH_EFFECT`, `UNDECLARED_EFFECT`, `OWNERSHIP_RECORD_REQUIRED`, `OWNED_PATH_DRIFT`, `SECRET_IN_ARGV`, `SECRET_DETECTED`, `GITHUB_REPO_CONFLICT`, `VISIBILITY_UPDATE_AUTHORITY_REQUIRED`, `REMOTE_NOT_FOUND`, `REMOTE_MISMATCH`, `REMOTE_HISTORY_CONFLICT`, `RUNTIME_REPO_IDENTITY_MISMATCH`, `DETACHED_HEAD`, `DEFAULT_BRANCH_MISMATCH`, `NON_FAST_FORWARD`, `PLANE_BOARD_CONFLICT`, `PLANE_TENANT_MISMATCH`, `REGISTRY_IDENTITY_MISMATCH`, `REGISTRY_UUID_COLLISION`, `MUTATION_OUTCOME_INDETERMINATE`, `ACTION_FAILED`, `VERIFICATION_FAILED`, and `INTERNAL_ERROR`.

## Review Remediation

| # | Material finding | Resolved contract location |
|---|------------------|----------------------------|
| 1 | Credential-dependent/default dry run | Offline default I/O row; preflight status table; canonical authority table |
| 2 | Incomplete apply/live/gate/yes/local outcomes | All three exhaustive authority truth tables; exit table |
| 3 | Legacy Hermes had no explicit live intent/safe default | Legacy Hermes table; Hermes adapter/CLI/MCP tasks |
| 4 | Hermes ran before a Git root | Composite phases 1–10; `git.prepare` before all generators |
| 5 | Repo link lacked path approval/edge semantics | Surface `initialCommitPaths`; Git ownership rules |
| 6 | Remote refs/history/push undefined | Git remote-history matrix and scratch ancestry preflight |
| 7 | Bootstrap compatibility could force GitHub/Plane/break Trello | Legacy compatibility paragraph; MCP task |
| 8 | PM/sentinel semantics undefined | PM/sentinel I/O row and composite phase 6 |
| 9 | No coherent post-Hermes registry/manifest path | Registry identity/convergence and composite phases 5/7/10 |
| 10 | No implementable ownership/effect ledger | Result/effect contract; `effects.ts`; Git ownership rules |
| 11 | Opaque Hermes nested effects/preflight/receipts | Structured Hermes task and complete Hermes preflight |
| 12 | Child stdio could corrupt JSON/MCP | Provider/output task and Output isolation section |
| 13 | Commander/MCP outer validation escaped envelope | CLI/MCP tasks and Outer failure isolation |
| 14 | Plane lookup not workspace/tenant aware | Plane tenant resolution section |
| 15 | UUID collision/path reassignment incomplete | Registry identity/convergence; PG regression task |
| 16 | Semantic fields had no exact types/CLI encoding | Semantic TypeScript block, limits, and repeated JSON flags |
| 17 | Tracked shipped bundles excluded | Code Map, dist task, dist parity AC/verification |
| 18 | Tests inherited credentials/arbitrary PGHOST | Fixture/test tasks and contained verification commands |

## Second Review Remediation

| # | Second-review semantic finding | Exact repaired contract location |
|---|--------------------------------|----------------------------------|
| 1 | Protocol-invalid MCP messages cannot use lifecycle envelopes | Output and outer failure isolation, locked-SDK layers 1–3; MCP task/AC |
| 2 | Unchanged Toad live-Hermes handoff would be denied | Exhaustive authority truth tables, exact `toad_legacy_handoff` tuple; CLI task/AC |
| 3 | Legacy roles conflict with canonical PM-only language | Exhaustive authority truth tables, Role scope paragraph; legacy adapter task/AC |
| 4 | PG has no service table/columns | Registry identity and convergence, `automation.lifecycle` JSONB types and persistence mapping |
| 5 | `.project.json` ownership record is undefined | Registry identity and convergence, `PathOwnershipSnapshotV1` shape/bounds/comparison |
| 6 | Runtime commit/gitlink can race immediately enabled timer | Composite phases 7–10 and runtime lock/push/state ordering |
| 7 | Runtime repo reuse lacks identity/ownership proof | Runtime repository, seed, and rerun contract, provider ID/marker/local-submodule rules |
| 8 | Initial runtime seed can publish arbitrary host config | Runtime repository seed allowlist, delta-profile inheritance, two fail-closed scans |
| 9 | Plane tenant isolation does not reach PM/sentinel | Plane runtime credential and secret transport boundary, per-agent env/unit rules |
| 10 | Secret-bearing child argv remains possible | Provider/legacy adapter tasks and `SECRET_IN_ARGV` universal runner contract |
| 11 | Git inherits hooks/filters/helpers/rewrites/signing/SSH | Git ownership, refs, and remote history, controlled environment/config/attribute/transport paragraphs |
| 12 | Unknown post-mutation outcome is misclassified cleanly | Result/action/effect types and invariants; `MUTATION_OUTCOME_INDETERMINATE`, partial/6 |
| 13 | Non-git non-empty plus absent/headless remote is omitted | Git target/remote matrix, explicit absent/headless/standalone/composite rows |
| 14 | Repository identity is lexical and misses ancestor symlinks | Git physical-target algorithm and registry physical-path mapping |
| 15 | Required lock refresh is excluded/unsafe | Package/lock execution task and Verification lock-only scope/idempotence commands |
| 16 | Create default and visibility-update authority are conflated | Surface contract presence normalization and explicit visibility authority AC |
| 17 | Nested lifecycle output fields are untyped/unbounded | Result, preflight, action, and effect strict TypeScript shapes, invariants, and global bounds |
| 18 | Bloodbank performs unpinned shared-host install | Bloodbank dependency contract, exact `nats-py==2.15.0` reuse-only preflight |

## Third Review Remediation

| # | Third-review semantic finding | Exact repaired contract location |
|---|--------------------------------|----------------------------------|
| 1 | Composite parent repository name undefined | Surface contract composite row; strict normalization paragraph; composite phase 1; third-review AC 1 |
| 2 | Parent immutable provider ID absent from output/persistence | Receipt type; `ParentRepositoryOwnershipV1`; persistence mapping; phases 1/5/10; third-review AC 2 |
| 3 | Pinned Hermes `provisioned_at` changes on rerun | `ProjectAutomation.lifecycle.provisioned_at`; phases 5/6; runtime marker; deterministic commit contract; third-review AC 3 |
| 4 | Parity/legacy recipe destroys canonical runtime gitlink | Runtime tracking dual-mode contract; parity/recipe execution task; parity regression task/third-review AC 4 |
| 5 | Commit author/committer/message/date undefined | Git controlled environment and lifecycle-created commit contract; `git.ts` task; third-review AC 5 |
| 6 | Push source/destination/config selection undefined | Git exact refspec/config neutralization paragraphs; `git.ts` task; third-review AC 6 |
| 7 | Branch validation depends on reflog/history | Strict branch normalization paragraph; CLI regression task; third-review AC 7 |
| 8 | `core.worktree`/`core.bare` can escape target | Git local-config/top-level containment paragraph; `git.ts` task; third-review AC 8 |
| 9 | Unchanged Toad turns valid-JSON failures into success | Exact Toad handoff failure bridge; output-isolation exception; `src/index.ts` task; third-review AC 9 |
| 10 | Output fallback erases partial receipt and lacks global budget | Output fallback boundary; `OutputBudgetV1`; deterministic five-step budgeting contract; core regression task; third-review AC 10 |
| 11 | Plane omitted-name preservation contradicts matching | Plane tenant resolution omitted/explicit field rules; lifecycle task; third-review AC 11 |
| 12 | SDK protocol assumptions lack exact 1.29.0 lock proof | Dist/lock execution task; exact SDK verification command; third-review AC 12 |

## Verification

**Commands:**

- `mise run typecheck` -- expected: strict lifecycle/provider/adapter/Zod contracts compile.
- `mise run build` -- expected: both tracked shipped entrypoints rebuild without any version/dependency declaration change.
- `node tests/project-lifecycle-core-regressions.mjs` -- expected: authority, canonical parent identity/provider-ID mirrors, stable provisioning timestamp, physical paths, preflight, deterministic output budgeting/emergency partial receipt, indeterminate effects, ownership/JSONB state, Plane omitted-field reuse, runtime identity/seed/locks/push order, tenant env, secret runner, Bloodbank reuse, convergence, and reruns pass using injected fakes only.
- `node tests/project-lifecycle-cli-regressions.mjs` -- expected: exact exits/JSON, successful/failing exact-Toad and near-miss authority, legacy roles, visibility presence, context-free branch checks, deterministic commit metadata/messages, exact refspec/push config, `core.worktree`/`core.bare` containment, other controlled Git target/config/filter/ref cases, lock scope, and output isolation pass in temp fixtures.
- `node tests/parity-migrate-regressions.mjs` -- expected: verified lifecycle-owned PM runtime gitlinks pass audit and survive migration/legacy recipe handling, legacy runtimes remain untracked/ignored, and malformed ownership blocks without destructive untracking.
- `node tests/mcp-catalog-regressions.mjs && node tests/mcp-server-regressions.mjs` -- expected: exact schemas and real stdio prove raw protocol-invalid `tools/call` yields standard JSON-RPC errors while protocol-valid invalid lifecycle arguments yield `LifecycleResultV1`; handler/legacy/indeterminate cases pass with no transport corruption.
- `node tests/project-registry-regressions.mjs` -- expected: old records/roles/Trello surfaces, physical-path/UUID collision behavior, bounded ownership/service projection, and no migration/backfill pass in temp paths.
- `env -u PJANGLER_TEST_PG_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGDATABASE -u DATABASE_URL node tests/pg-registry-regressions.mjs` -- expected: safe skip with no PG connection; inherited PG is never contacted.
- `PJANGLER_TEST_PG_URL='postgres://test:test@127.0.0.1:55432/postgres' node tests/pg-registry-regressions.mjs` -- expected only when explicitly opted into a disposable loopback fixture published on port `55432`: explicit-ID/collision/no-reassignment round trips pass and only the validated scratch DB is removed.
- `node tests/dist-parity-regressions.mjs` -- expected: `dist/index.js` and `dist/mcp-server.js` byte-match fresh esbuild outputs in a temporary directory.
- `manifest_hashes_before="$(git hash-object package.json version.json src/utils/version.ts)"; npm install --package-lock-only --ignore-scripts --no-audit --no-fund; test "$manifest_hashes_before" = "$(git hash-object package.json version.json src/utils/version.ts)"` -- expected: refresh lock only; no manifest/version file, install script, extension hook, or `node_modules` mutation.
- `lock_hash_once="$(git hash-object package-lock.json)"; npm install --package-lock-only --ignore-scripts --no-audit --no-fund; test "$lock_hash_once" = "$(git hash-object package-lock.json)"` -- expected: the second authorized lock-only resolution is byte-idempotent.
- `node -e 'const a=require("node:assert/strict"),l=require("./package-lock.json"),s=l.packages["node_modules/@modelcontextprotocol/sdk"]; a.ok(s,"missing SDK lock entry"); a.equal(s.version,"1.29.0"); a.equal(s.resolved,"https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.29.0.tgz"); a.equal(s.integrity,"sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==")'` -- expected: the exact reviewed SDK 1.29.0 artifact remains locked after each lock-only refresh.
- `node -e 'const a=require("node:assert/strict"),p=require("./package.json"),l=require("./package-lock.json"),r=l.packages[""]; for(const k of ["name","version","bin","engines","dependencies","devDependencies"]) a.deepStrictEqual(r[k],p[k]); a.equal(l.version,"1.2.19"); a.equal(r.version,"1.2.19"); for(const n of ["pg","@types/pg","node-pg-migrate"]) a.ok(r.dependencies?.[n]||r.devDependencies?.[n],n)'` -- expected: root lock metadata exactly matches package declarations and includes all PG packages without a version bump.
- `npm test` -- expected: full contained default suite passes; no live provider/push/host/external-registry call occurs and a PG skip is not counted as provider proof.
- `rg -n '"version": "1\.2\.19"|"version": 1\.2\.19' package.json package-lock.json version.json src/utils/version.ts` -- expected: every version declaration remains `1.2.19`.
- `git diff --check` -- expected: no whitespace errors.
- `git status --short` -- expected before implementation commit: only specified source/tests, package test wiring, explicitly refreshed `package-lock.json`, and both tracked dist files; no migration, template gitlink/content, Toad, version/release, host/config/service, or unrelated path.

## Auto Run Result

Status: ready-for-dev
Workflow outcome: Third-review planning/spec remediation is complete; implementation intentionally not started.
Readiness review: Passed a complete post-repair from-disk reread against all seven BMAD criteria on 2026-07-25.
Third review remediation: 12/12 findings are individually mapped and resolved; no remaining specification ambiguity was identified.
