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
- `src/index.ts` -- Commander registration, legacy init/Hermes aliases, interactive apply behavior, JSON renderer, and current unwrapped `program.parse()`.
- `src/mcp-server.ts` -- MCP catalog/handlers; high-level SDK validation currently returns plain text before handlers and opaque recipe capture can corrupt stdio.
- `tests/project-registry-regressions.mjs`, `tests/_pg_store_check.ts`, `tests/pg-registry-regressions.mjs` -- Legacy/YAML/PG compatibility and current unsafe inherited-PG test setup.
- `tests/mcp-catalog-regressions.mjs`, `tests/mcp-server-regressions.mjs` -- MCP catalog and real stdio integration; current child environment inherits production state.
- `package.json`, `dist/index.js`, `dist/mcp-server.js` -- Test/build contract and tracked shipped entrypoints; source/build parity is required without a release.
- `templates/commonproject` at `996ca527598d50f25a80ace146eb3189bf556b68` and `templates/hermes-agent` at `1c6482a0259996b3d0e82f48a2a54c46b19abe0a` -- Read-only pinned generator inputs; PJAN-27 wraps them and does not edit their gitlinks/content.

## Tasks & Acceptance

**Execution:**

- `src/project/lifecycle/types.ts` -- Define the exact contracts in Design Notes as strict Zod schemas plus inferred TypeScript types. Reject unknown fields, control/NUL characters, invalid enums/UUIDs/URLs/paths, duplicate semantic keys, per-field/array/aggregate size excess, and canonical-surface legacy authority fields. Emit snake_case `LifecycleResultV1`; accept camelCase shared/MCP inputs and mechanically mapped kebab-case CLI flags.
- `src/project/lifecycle/effects.ts` -- Implement path/effect snapshots without following symlinks. Record every created/updated/deleted/reused file, symlink, host path, `.gitmodules` entry, mode-`160000` gitlink, git ref/remote, provider resource, registry/manifest row, package install, and service enable/start state. Compare declared observers before/after even after child failure; turn unowned or undeclared deltas into `UNOWNED_PATH_EFFECT`/`UNDECLARED_EFFECT`; generate compensation only from confirmed changed effects.
- `src/project/lifecycle/providers.ts` -- Define injected `CommandRunner`, `OutputSink`, `ScratchFs`, GitHub, Plane, registry, Hermes-host, clock, and UUID interfaces. Production children always use argv arrays, `stdio: pipe`, a deliberate environment, timeouts, ANSI stripping, and redacted captured evidence; no core/provider code writes directly to console. Implement workspace-aware Plane resolution and wrong-tenant checks exactly as specified. Static planning must not instantiate credential/network providers.
- `src/project/lifecycle/git.ts` -- Implement the Git state machine and ownership rules in Design Notes. Live readiness may use only an injected private scratch repo to fetch/compare refs, cleaning it afterward; it never changes the target. Execution prepares an existing Git root before generators, stages with a NUL pathspec containing exactly confirmed owned leaf effects, verifies the index equals the ledger, commits only when needed, and uses ordinary push after a last remote-head check. Standalone non-empty/no-HEAD adoption requires `initialCommitPaths`; composite commits use only generator/subaction ownership.
- `src/project/lifecycle/hermes.ts` -- Render the pinned Hermes template with `copier copy --skip-tasks` and captured stdio, then execute/observe named subactions: repo-owned render; host template config/fleet env/profile stage; runtime GitHub ensure/seed; runtime submodule gitlink and profile link; Bloodbank consumer/dependency; PM gateway/consumer units; optional PM-owned heartbeat service/timer; fleet registry; and manifest agent binding. Preflight every selected subaction before any mutation. Core Plane ensure supplies the board, so Hermes never creates another board; Telegram/email remain outside the composite. Return stable PM agent/service identities and confirmed nested effects even when a child fails.
- `src/project/RegistryStore.ts` and `src/project/index.ts` -- Add optional canonical `project_id`/`repo_id` to old records and manifest projection; keep schema version `1`, YAML authority, old records, list/show/doctor/init, Trello, slug-NULL PG ownership, and legacy best-effort PG behavior. Lifecycle mode is strict: validate global cross-field UUID uniqueness and no reassignment, load PG IDs, preselect collisions, insert explicit project/repo IDs, and never `ON CONFLICT(local_path) DO UPDATE project_id`. Add provisioning/partial/active agent/service state and the exact mirror promotion/resume procedure; do not edit migrations or backfill unrelated rows.
- `src/project/lifecycle/index.ts` -- Implement static plan, explicit readiness, and gated execution. Aggregate all applicable input/path/registry/Git/GitHub/Copier/template/Plane/PG/Hermes/host checks before a permit or durable mutation. Execute the exact composite phases in Design Notes; stop forward work after failure but run the local redacted effect/state finalizer. Allocate UUIDs only after full preflight and persist them in provisional state before Hermes. Verify final YAML/PG/manifest IDs/status, origin/ref/ancestry, provider identities, PM/sentinel identities, ownership ledger, a clean lifecycle-owned index with no new unowned worktree delta, preserved pre-existing unrelated state, and pushed HEAD.
- `src/index.ts` -- Register `github-repo ensure`, `repo link`, `ticket-board ensure`, and `project create` with the exact flags/defaults in the Surface contract. Intercept lifecycle parse/unknown/missing-value/coercion failures around `parseAsync()` and pass every lifecycle error through the result serializer; preserve ordinary human help/version behavior, while JSON mode writes one ANSI-free JSON document plus newline to stdout and nothing else. Preserve human legacy output/aliases and `--yes`/TTY local-apply semantics. Add `--live`/`--json` to explicit Hermes CLI, default Hermes `local=true`, and route every Hermes alias through the same authority resolver; aliases lacking live flags remain repo-local only.
- `src/mcp-server.ts` -- Preserve every existing tool and add the four canonical tools. Replace lifecycle tools' high-level pre-handler validation with one low-level SDK tool registry/request router that publishes exact JSON Schemas but performs `safeParse` inside the call handler, so schema and handler failures serialize as `LifecycleResultV1`. MCP stdio is reserved exclusively for JSON-RPC; each canonical tool returns one bare lifecycle JSON document and each participating legacy lifecycle tool returns its additive legacy object with nested `lifecycle` in `content[0].text`, with `isError` derived from the lifecycle `exit_code`. Existing non-lifecycle tools retain their payloads and error semantics. Retain `pjangler_bootstrap_33god_project` on the lower-level local bootstrap primitive with all existing input aliases/defaults/Trello behavior; do not require GitHub/Plane for safe legacy calls.
- `src/commands/hermes/types.ts`, `src/commands/hermes/RunCopierTemplate.ts`, and `src/recipes/HermesAgentRecipe.ts` -- Make legacy Hermes execution a compatibility adapter over the structured provider/output sink. Add explicit `live` intent; make `local` select defaults only; prevent `--yes`, `dryRun=false`, skip flags, or `local=false` from issuing a live permit. Preserve existing success fields/aliases additively, but return stable denied-gate/error envelopes and exact exit/`isError` behavior.
- `tests/helpers/lifecycle-fixtures.mjs` -- Add temp HOME/registry/repos, deterministic UUID/clock, argv-recording fake binaries/providers, loopback servers, captured output, and an allowlisted child environment built from scratch. Never spread `process.env`; omit all GitHub/Plane/Trello/NATS/AWS/database credentials and all `PG*`/`DATABASE_URL` unless a test explicitly injects a fixture value.
- `tests/project-lifecycle-core-regressions.mjs` -- Cover the complete I/O matrix, preflight statuses, all authority-table rows, zero provider construction in static mode, full-preflight-before-mutation, exact phase/effect order, PM/sentinel expansion, state promotion/resume, declared observer failures, compensation selection, handler/final-verification failure, and same-ID/effect reruns with injected providers.
- `tests/project-lifecycle-cli-regressions.mjs` -- Exercise built CLI static/readiness/fake-live modes, exact exits, one-document ANSI-free output, Commander outer failures, legacy init/Hermes truth rows, Git ownership/symlink/deletion/gitlink/ref/history cases, and zero unrelated staging. Fake live uses only fixture binaries and loopback endpoints.
- `tests/mcp-catalog-regressions.mjs` and `tests/mcp-server-regressions.mjs` -- Assert exact schemas/capability guidance and real-stdio parity for success, Zod missing/malformed/unknown input, gate denial, readiness block, handler failure, partial receipt, semantic inputs, legacy bootstrap/Trello defaults, Hermes compatibility, and `isError`; assert no child bytes appear on transport stdout.
- `tests/project-registry-regressions.mjs`, `tests/_pg_store_check.ts`, and `tests/pg-registry-regressions.mjs` -- Prove old no-UUID records remain readable; explicit IDs round-trip; global UUID/slug/path/ID collisions and reassignment block before writes; provisional/partial reruns retain IDs; YAML/optional PG/manifest promotion converges; and no schema migration is added. PG tests ignore inherited `PGHOST` and run only with explicit loopback `PJANGLER_TEST_PG_URL`, using a validated unique scratch DB name and exact cleanup.
- `tests/dist-parity-regressions.mjs` and `package.json` -- Add lifecycle suites and a temp-output esbuild byte comparison for both shipped bundles. Default `npm test` may skip PG only when `PJANGLER_TEST_PG_URL` is absent; a skip is not lifecycle-provider evidence. Keep version/scripts unrelated to testing unchanged.
- `dist/index.js` and `dist/mcp-server.js` -- Rebuild and commit both tracked entrypoints from the changed source. Do not bump a version, install globally, publish, tag, or push.

**Acceptance Criteria:**

- Given any canonical CLI command or MCP tool with `live` and `preflightLive` omitted/false, when invoked with valid input and no credentials/network, then the outer surface returns the same actionable static plan with live-only rows `deferred`, `status=planned`, `ok=true`, exit `0`/`isError=false`, and no credential/network/scratch/mutation provider is constructed.
- Given `preflightLive=true` and `live=false`, when provider readiness is all proven, failed, or inconclusive, then the outer surface respectively returns a mutation-free planned result or a blocked result whose exact rows are `failed`/`unknown`, exit `3`, and no durable effect is confirmed.
- Given any canonical or selected legacy external/host/push action, when explicit live intent is absent, the gate is not exactly `1`, or only `apply`/`yes`/TTY/`local=false`/skip flags/gate is present, then the authority tables determine the exact plan/block/local-only outcome and no implicit live permit exists.
- Given missing, malformed, oversized, or unknown lifecycle inputs at Commander, MCP schema, or handler boundaries, when observed publicly, then one redacted result is returned with `INVALID_INPUT`; given instead an unexpected adapter/handler exception, then it uses `INTERNAL_ERROR`, with exact exit/`isError`, no stack/secret/ANSI, and no provider call before validation succeeds.
- Given absent/matching/drifted/inaccessible GitHub state, when equivalent CLI/MCP fake calls run, then they create/reuse/update/block identically, distinguish absence from auth failure, and return the same canonical URL/default-branch evidence.
- Given every target/remote-history row in the Git matrix, when repo-link or composite Git preparation runs, then the documented clone/init/ff-only/reuse/block behavior occurs, a Git root exists before Hermes, and neither origin replacement, history merge, non-fast-forward, nor force push occurs.
- Given a non-empty no-HEAD standalone directory, when exact `initialCommitPaths` are absent or present, then the outer surface respectively blocks without mutation or commits only the approved safe leaf file/symlink/gitlink set; modifications/deletions and `.gitmodules` are represented exactly and unrelated paths remain unstaged.
- Given a generator or Hermes subaction creates, updates, deletes, reuses, or partially changes a declared target, when it completes or fails, then the receipt contains exact confirmed path/external/host/service effects (including symlink targets and gitlink OIDs), and any unowned/undeclared delta fails before commit.
- Given `provisionSentinel=true` with either PM value, when the composite is planned/executed, then resolved input includes one PM agent `${slug}-pm`; sentinel identity is the PM-owned `hermes-${slug}-pm-heartbeat` service/timer, not a second agent; requested states and receipt IDs are stable on rerun.
- Given a valid fake-live composite, when it succeeds, then all readiness checks precede durable mutation; phase order matches the composite table; YAML/PG/manifest promote to active with identical IDs/board/agent/service state; the commit index equals the ownership ledger; normal push verifies remote HEAD; and the retention-ready receipt has non-null project/repo/repo-URL/board identities.
- Given a failure after one or more durable effects, when the operation returns, then forward actions are `not_run`, declared observers and the local failure-state finalizer run, status is `partial`, exit is `6`, receipt fields reflect only confirmed evidence, and compensation guidance exists only for effects changed by that invocation.
- Given existing old registry records, optional PG rows, legacy init callers, safe bootstrap callers, or Trello callers, when the full suite runs, then no unrelated row is backfilled, no ID/path is reassigned, old payload fields/defaults remain additive-compatible, and no GitHub/Plane requirement is introduced into safe local defaults.
- Given a requested non-`33god` Plane workspace, when credentials/base resolve, then only its normalized workspace variables or exact workspace config may authorize access; global/legacy `33god` fallback is refused, and provider evidence must prove the exact workspace/board tenant before mutation.
- Given semantic context on CLI and MCP, when values meet or violate the exact types/limits, then both adapters preserve identical ordering/content or return the same `INVALID_INPUT`; pjangler never interprets or persists these values as registry operational truth.
- Given lifecycle children run under JSON CLI or MCP stdio, when they emit stdout/stderr/ANSI or fail, then bytes are captured/redacted into action evidence and the only public machine output is the single envelope/MCP JSON-RPC stream.
- Given default verification, when the focused/full suites run, then child environments contain only allowlisted fixture values, provider URLs are loopback-only, production credentials are absent, PG is opt-in via loopback URL rather than inherited `PGHOST`, and no real push/provider/host/external-registry mutation occurs.
- Given source changes are complete, when build/parity verification runs, then `dist/index.js` and `dist/mcp-server.js` byte-match fresh temp builds and are committed with source while package/version declarations remain `1.2.19` and no release/install/tag/push occurs.

## Spec Change Log

- 2026-07-18 independent adversarial `REPAIR`: replaced the credential-dependent dry run, incomplete authority model, infeasible Git/Hermes order, ambiguous ownership/push/registry semantics, opaque child execution, incomplete public failures, unsafe tenant/UUID/test behavior, and bundle contradiction with the binding contracts below. KEEP: Toad/pjangler ownership boundary, canonical four operations, YAML authority, no automatic rollback, no release, and both `multiple-goals`/`oversized` warnings.
- 2026-07-18 BMAD readiness repair: completed the canonical scalar schemas/limits and exact MCP names; made primitive/invalid receipts and errors implementable; nested lifecycle metadata under collision-free legacy payloads; delayed authoritative state promotion until the active manifest commit is pushed; removed duplicate Plane-key precedence; and made PG verification explicitly loopback/opt-in. KEEP: all 18 independent finding mappings and the buffered intent contract.

## Review Triage Log

- 2026-07-18 external review: verdict `REPAIR`; 18 material specification findings accepted and resolved in `Review Remediation`. The reviewer supplied no severity labels, so none are invented here.

## Design Notes

### Surface contract and semantic inputs

| Operation | Shared/MCP input | CLI spelling | Required/default behavior |
|-----------|------------------|--------------|---------------------------|
| GitHub ensure | `org`, `name`, `visibility`, `description?`, `preflightLive?`, `live?` | `github-repo ensure --org --name --visibility [--description] [--preflight-live] [--live] [--json]` | org/name/visibility required; allowed orgs `AutomaticAI-io`, `delorenj`, `IntelliForia`; omitted description is `""` on create and no update on reuse; booleans false |
| Repo link | `repoUrl`, `dir?`, `branch?`, `initialCommitPaths?`, `preflightLive?`, `live?` | `repo link --repo-url [--dir] [--branch] [--initial-commit-path <path>...] [--preflight-live] [--live] [--json]` | URL required; dir resolved cwd; branch resolved by Git matrix; paths empty; booleans false |
| Plane ensure | `identifier`, `provider?`, `workspace?`, `name?`, `description?`, `boardId?`, `preflightLive?`, `live?` | `ticket-board ensure --identifier [--provider] [--workspace] [--name] [--description] [--board-id] [--preflight-live] [--live] [--json]` | provider `plane`; workspace `33god`; omitted name/description use identifier/`""` on create and do not update those fields on reuse; booleans false |
| Composite create | `name`, `githubOrg`, `targetDir`, `slug?`, `description?`, `visibility?`, `ticketProvider?`, `workspace?`, `identifier?`, `branch?`, `provisionPm?`, `provisionSentinel?`, `sourceContextRefs?`, `relatedProjects?`, `operatorDecisions?`, `preflightLive?`, `live?` | `project create <name> --github-org --target-dir` plus exact kebab-case flags; semantic flags repeat JSON objects | name/org/target required; existing slug/identifier derivation; visibility `private`; provider `plane`; workspace `33god`; booleans false; arrays empty; sentinel implies PM |

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
  visibility: "public" | "private";
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

Strict Zod schemas mirror those types. Repository `name` is 1–100 ASCII characters matching `^[A-Za-z0-9._-]+$` and is not `.`/`..`; composite/board display `name` is 1–200 Unicode scalar values. `slug` is 1–100 lower-case characters matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`; Plane `identifier` is 2–8 upper-case alphanumerics beginning with a letter; workspace is 1–64 characters matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`; optional board IDs are canonical lower-case UUIDs. Descriptions are 0–350 Unicode scalar values. `repoUrl` is at most 2048 UTF-8 bytes and must normalize to an SSH or HTTPS GitHub remote in an allowed org. `dir`/`targetDir` are 1–4096 UTF-8 bytes, resolve to a non-root absolute directory without NUL/control characters, and `branch` is 1–255 UTF-8 bytes accepted by `git check-ref-format --branch`. `initialCommitPaths` has at most 512 unique entries, each 1–4096 UTF-8 bytes, and at most 65,536 serialized bytes; the stricter Git ownership rules below also apply. The complete normalized input is at most 131,072 serialized UTF-8 bytes. All canonical strings reject NUL/C0/DEL controls; identity fields must already be edge-trimmed and values are never silently truncated.

Each top-level semantic array has at most 64 entries and preserves order. `ref` is 1–2048 UTF-8 characters; `label`/`customRelation` 1–256; rationale/decision 1–4096; `key` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; `sourceRefs` has at most 16 unique entries. Reject NUL/control characters, duplicate `ref`, duplicate `(projectId, relation, customRelation)`, duplicate decision key, `customRelation` on non-custom relations, and combined serialized semantic payloads over 65,536 bytes. CLI accepts one JSON object per repeated `--source-context-ref`, `--related-project`, or `--operator-decision`; it accepts no implicit file/`@file`/stdin encoding. MCP accepts native arrays under the camelCase names. Output uses snake_case and byte-preserves validated semantic strings; these values live only in plan/receipt, never YAML/PG/`.project.json` operational fields.

### Result, preflight, action, and effect contract

`LifecycleResultV1` has exact required keys: `schema_version: "pjangler.lifecycle/v1"`, `operation`, `ok`, `status`, `mode`, `dry_run`, `live`, `local_write_authorized`, `external_mutation_authorized`, `exit_code`, `preflight`, `actions`, `errors`, `compensations`, and `receipt`. Operations are `github_repo_ensure | repo_link | ticket_board_ensure | project_create | legacy_project_init | legacy_bootstrap_33god_project | legacy_hermes | unknown`; modes are `static_plan | readiness | execute`; statuses are `planned | succeeded | blocked | failed | partial`. `ok` is true only for planned/succeeded. `mode` reflects normalized request intent even when permission is denied; `dry_run` is true exactly for `static_plan`/`readiness`. The two authorization booleans report the issued permit, never merely the requested flags.

Errors are ordered `LifecycleErrorV1` records with exact keys `{ code, message, action_id?, field? }`; `code` is one of the stable codes below, `message` is a redacted 1–2048-character public explanation, and optional identifiers are 1–256 characters. Input violations use `INVALID_INPUT`; only an unexpected adapter/handler exception uses `INTERNAL_ERROR`. `errors` has at most 256 rows. `receipt` is exactly `ProjectLifecycleReceiptV1 | null`: it is null when outer parsing cannot normalize composite project identity and for standalone primitives outside a composite regardless of outcome; primitive resource evidence remains in actions/effects. A normalized `project_create` contains the best projected or confirmed partial receipt. Invalid-input results still populate every other required array with zero or applicable static rows.

Preflight rows are `{ id, phase: static | live, status, message, evidence? }`. Status meanings are exhaustive:

| Status | Meaning | Overall outcome |
|--------|---------|-----------------|
| `passed` | Check executed and requirement proved | Does not block |
| `failed` | Check executed and definite prerequisite/conflict failure | Explicit readiness/live blocks with exit `3` |
| `deferred` | Intentionally not run because offline static mode gave no network/credential permission | Does not block a static `planned` result |
| `unknown` | Explicit readiness attempted but timeout/ambiguous/provider-safe evidence could not prove pass/fail | Blocks with exit `3`; never treated as absent |
| `skipped` | Resolved action makes the check inapplicable | Does not block |

Action rows are `{ id, kind, status: planned | succeeded | failed | not_run, planned_effects, effects, blocked_by?, error? }`. Effects are discriminated records with `effect_id`, `action_id`, `domain: path | git | github | plane | registry | hermes | host | service | package`, `kind`, canonical safe `target`, `effect: none | created | updated | deleted | reused`, `owned`, `confirmed`, and redacted `before?`/`after?`. Domain/kind pairs are closed literals: path `file | directory | symlink | gitmodules | gitlink`; git `repository | remote | branch | index | commit | push`; GitHub `repository`; Plane `board`; registry `yaml_project | pg_project | pg_repo | manifest | fleet`; Hermes `agent | runtime_repo | profile | consumer | binding`; host `config | directory | symlink`; service `unit | timer | enabled | started`; package `python_dependency`. Path evidence records repo-relative/approved absolute path, mode, before/after SHA-256, symlink target without dereference, or gitlink OID as applicable; repo directories are observed but never staged. External/service evidence records stable resource ID and observed state. Planned effects are predictions, never compensation evidence. Compensation records require a confirmed created/updated/deleted effect, are `{ effect_id, automatic: false, guidance }`, contain no secret, never propose force push, and never target reused/pre-existing state.

`ProjectLifecycleReceiptV1` has literal schema `pjangler.project-lifecycle-receipt/v1`, `lifecycle_status: projected | provisioning | partial | active`, nullable `project_id`, `repo_id`, `repo_url`, `local_path`, `visibility: public | private | null`, `github_org: AutomaticAI-io | delorenj | IntelliForia | null`, `ticket_provider: plane | trello | null`, and `board_id`, non-null normalized `slug`/`name`, `agent_ids: string[]`, `service_ids: string[]`, the three snake_case semantic arrays, `effects`, and `verification_evidence[{ surface, status: passed | failed | unknown | skipped, observed }]`. UUID identity fields are canonical lower-case UUIDs; provider/resource IDs are opaque redacted strings. Agent/service arrays have at most 64 unique entries; verification evidence has at most 256 rows, with `surface` at most 256 and redacted `observed` at most 4096 characters. A static projection leaves unknown new IDs null. A retention-ready succeeded composite is `active` with non-null project/repo/repo URL/board identities, requested PM ID, requested sentinel service ID, and verified effects. Partial receipts include only confirmed identities/effects.

| Result/error class | `status` | `ok` | CLI exit / payload `exit_code` | MCP `isError` |
|--------------------|----------|------|--------------------------------|---------------|
| Valid plan/readiness or success/no-op | `planned` / `succeeded` | true | `0` | false/omitted |
| Parse/schema/size/unknown input | `blocked` | false | `2` | true |
| Preflight/conflict/readiness unknown | `blocked` | false | `3` | true |
| `LIVE_INTENT_REQUIRED` / `LIVE_GATE_REQUIRED` | `blocked` | false | `4` | true |
| Execution/verification/handler failure before any confirmed changed effect | `failed` | false | `5` | true |
| Failure after any confirmed changed effect | `partial` | false | `6` | true |

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

Legacy bootstrap and every Hermes-capable entry (`hermes-agent`/`hermes`, `add hermes-agent`, `recipe run hermes-agent`, deprecated `init hermes-agent`, `pjangler_deploy_hermes_agent`, `pjangler_run_recipe`, bootstrap agent provisioning) resolve an effect set before execution. `local=true` is the default and selects repo-owned render/manifest effects only; `local=false` selects full legacy PM defaults but grants no authority. Explicit skip flags may only remove effects. Generic aliases with no live input are permanently repo-local. Existing `dryRun` defaults remain: bootstrap true, explicit Hermes CLI/MCP false.

| `dryRun` | Selected non-target effect exists | `live` | Gate exactly `1` | Local writes | External/host/push | Result |
|----------|-----------------------------------|--------|------------------|--------------|--------------------|--------|
| true | either | either | either | no | no | plan, `planned`/0 |
| false | no (`local=true` defaults or all explicit skips) | either | either | repo-owned only | no | execute local, standard 0/5 outcome |
| false | yes | false | either | no (deny atomically) | no | `blocked`/4 `LIVE_INTENT_REQUIRED` |
| false | yes | true | no | no | no | `blocked`/4 `LIVE_GATE_REQUIRED` |
| false | yes | true | yes | yes | exactly selected effects | standard execute outcome |

Legacy result payloads retain current top-level fields (`project`, `plan`, `actions`, `dryRun`, `logs`, `errors`, `context`, etc.) and their existing shapes, then add exactly one collision-free `lifecycle: LifecycleResultV1` field; table status/exit/`isError` values refer to that nested result. No existing safe caller must parse a replacement-only shape. The bootstrap defaults remain `dryRun=true`, `local=true`, `skipPlane=true`, accept Trello, and require neither `githubOrg` nor visibility. It calls the lower-level shared local bootstrap/Hermes primitives, never `project_create`.

### Composite phases and PM/sentinel model

After static validation, gate issuance, and a complete live preflight, execute exactly:

1. `github.repo.ensure` -- create/reuse/update the requested project repo and capture canonical URL/remote default state.
2. `git.prepare` -- clone a non-empty remote into an absent/empty target, or initialize/reuse the safe target; check out/ff-only the resolved branch; add only a missing matching `origin`; leave an existing Git root with no lifecycle commit/push yet.
3. `plane.board.ensure` -- create/reuse/update one repo board and capture its verified ID; Hermes board creation is disabled.
4. `commonproject.render` -- render against the Git root with board identity, capture child streams, and derive exact before/after target effects.
5. `state.stage` -- allocate/reuse UUIDs and atomically persist identical `provisioning` identity/board plus planned PM/sentinel state to YAML, optional PG, and `.project.json`; this makes IDs durable before Hermes.
6. `hermes.render` and named Hermes subactions -- render with `--skip-tasks`; run each selected observed subaction in dependency order. `${slug}-pm` is the only agent. `provisionSentinel=true` normalizes `provisionPm=true` and adds PM-owned service identity `hermes-${slug}-pm-heartbeat` with `.service`/`.timer`; it never adds an agent ID. PM without sentinel omits heartbeat units while retaining selected PM runtime/gateway/consumer behavior.
7. `state.converge` -- write confirmed agent/service/board/ownership state as `provisioning` to YAML, optional PG, and the manifest. After every selected non-Git action succeeds, prepare only the repo-owned manifest as the `active` commit candidate; YAML/PG remain `provisioning` until the push is proven. On forward failure, the local finalizer attempts `partial` plus confirmed substates without calling external/host actions; every successful or failed mirror update is recorded.
8. `git.commit-owned` -- stage the NUL-delimited confirmed repo-owned ledger only; verify `git diff --cached --name-status -z` exactly equals that ledger (including approved deletion, symlink, `.gitmodules`, and mode-160000 gitlink); commit only when non-empty.
9. `git.push-safe` -- re-read remote HEAD, require the preflight ancestry still holds, and ordinary-push the resolved branch; no force/lease/merge.
10. `state.promote-and-verify` -- only after pushed HEAD contains the active manifest candidate, promote PG in one transaction when enabled, write authoritative YAML `active` last, then verify YAML/PG/manifest identity/status, repo URL/origin/default branch/local and remote HEAD, clean lifecycle-owned index/worktree, Plane board, PM/sentinel identities, external/host effects, and receipt evidence. A post-push promotion failure is `partial`; the next same-input run repairs mirrors without another provider resource or replacement UUID.

Complete Hermes preflight covers Copier `>=9` plus `--skip-tasks`, initialized pinned template, existing Git root, exact HOME/config/profile/fleet/registry write targets, Hermes/gh/git/systemctl/uv/Python dependencies selected by the plan, runtime repo state, Bloodbank consumer/dependency and endpoint configuration, and user-systemd availability for requested units. NATS reachability may be a non-blocking observed warning because the installed consumer retries; missing configuration/dependency is blocking. Telegram/email are always `skipped` in composite scope. Each opaque rendered script may be invoked only through the injected captured runner with declared before/after observers for every effect it can produce; any unobserved domain fails the action.

### Git ownership, refs, and remote history

`initialCommitPaths` are exact normalized repo-relative leaf paths: no absolute paths, `..`, glob metacharacters, directories, `.git` paths, duplicates, or ancestor symlink escapes. A safe relative symlink is staged as the link object and its target string is recorded; absolute/out-of-root targets block. A nested repository is never converted implicitly: it is allowed only when already represented in the index as a mode-`160000` gitlink, its OID is captured, and `.gitmodules` is separately approved/owned. Existing-HEAD standalone link never commits working changes and rejects `initialCommitPaths`; it requires a clean index/worktree. Composite generator updates are owned only when the path was absent, or its prior hash/target/OID matches the last `.project.json` lifecycle ownership record; a caller-edited collision blocks. Deletions are recorded but allowed only when the plan explicitly names that exact owned path; otherwise they fail and remain unstaged.

| Local target | Remote/default-branch state | Required behavior |
|--------------|-----------------------------|-------------------|
| Absent/empty, remote absent or no heads | Resolve explicit branch or `main`; init `-b`, add origin; standalone empty target may create an allow-empty initial commit, non-empty target uses approvals | Normal first push only |
| Absent/empty, remote has heads | Clone `origin` at remote HEAD/default branch | Reuse history; no initial commit |
| Non-git non-empty, remote has heads | Never overlay or merge | `REMOTE_HISTORY_CONFLICT` |
| Existing repo, origin absent | Add requested origin after identity/history preflight | Preserve every other remote |
| Existing repo, normalized origin mismatch | No change | `REMOTE_MISMATCH` |
| Detached HEAD or explicit branch differs from non-empty remote default | No change | `DETACHED_HEAD` / `DEFAULT_BRANCH_MISMATCH` |
| Local HEAD equals remote branch | Reuse/no push unless later owned commit exists | Idempotent success |
| Remote HEAD is ancestor of local HEAD | Local is ahead | Ordinary push allowed |
| Local HEAD is ancestor of remote HEAD | Local is behind | Clean target ff-only during Git preparation before generators |
| Histories diverge/unrelated, desired branch absent while another remote default exists, or ancestry cannot be proved | No merge/push | `REMOTE_HISTORY_CONFLICT` or readiness `unknown` |
| Remote advances after preflight | Do not retry with force/merge | Normal push fails; result failed/partial according to confirmed prior effects |

Readiness compares ancestry in an injected private scratch repo populated by read-only fetches from the local repository and requested remote; scratch creation/cleanup is the only allowed preflight filesystem write and can never occur in offline static mode or under target/HOME/registry paths. Scratch effects never count as lifecycle business effects. Remote identity normalizes SSH/HTTPS and optional `.git`; remote HEAD comes from `git ls-remote --symref` plus provider evidence. No `--force`, `--force-with-lease`, automatic merge/rebase, default-branch rewrite, or origin replacement exists in any plan.

### Registry identity and convergence

`project_id` and `repo_id` are optional canonical lower-case UUID strings on old YAML records and `.project.json`; new successful lifecycle records require both. Across the whole loaded YAML registry, the current manifest, and every enabled-PG row selected by slug/project ID/repo ID/local path, no UUID may bind to more than one entity and project/repo IDs may not alias each other. A slug fixes its project ID; a project ID fixes its slug; a repo ID fixes its project/path; and a normalized repo path fixes its repo/project IDs. `force`/overwrite never relaxes identity/path ownership.

When `PJ_REGISTRY_PG` is disabled, PG rows are not read/written. When enabled for lifecycle mode, live preflight must connect and query by slug/project ID/repo ID/local path before any mutation. Existing matching PG IDs win for an old YAML projection missing IDs; any contradictory mapping blocks rather than rewriting YAML or PG. New PG inserts explicitly provide `projects.id` and `repos.id`; matching slug/path conflicts update only mutable columns after ID equality is proved. Remove the current repo-path reassignment upsert. Existing slug-NULL rows remain untouched. No migration/schema/backfill is part of PJAN-27.

Mirror transitions are exact: absent/old → `provisioning` during `state.stage`; post-Hermes convergence updates confirmed substates while retaining provisioning; the manifest becomes the repo-owned active commit candidate only after all selected non-Git actions succeed; after its commit is pushed, PG promotes transactionally when enabled and authoritative atomic YAML promotes `active` last. Execution failure → best-effort `partial` with confirmed agent/service substates. If promotion stops midway, YAML remains provisioning/partial and the next identical run reuses IDs/effects and finishes mirrors; it never allocates replacements or duplicates resources. Legacy init retains its existing best-effort optional PG policy; strict mirror failure applies only to lifecycle operations.

### Plane tenant resolution

Normalize workspace for environment lookup with `trim → uppercase → every non-alphanumeric run to '_' → trim '_'`; reject empty output. For workspace key `W`, resolve API key in order: `PLANE_${W}_API_KEY`; `api_key_env` named by the exact workspace entry in `${PJANGLER_PLANE_WORKSPACES_FILE:-~/.claude/plane-workspaces.json}` (safe env-name syntax only); then, only when requested workspace is `33god`, compatibility `PLANE_API_KEY`. Resolve base in order: `PLANE_${W}_BASE_URL`; `PLANE_${W}_BASE`; configured workspace `base_url`; then, only for `33god`, `PLANE_BASE_URL`, `PLANE_BASE`, `https://plane.delo.sh`. Normalize a hostname to HTTPS; require HTTPS except an injected loopback test endpoint. Non-`33god` requests never consume global/legacy/default `33god` values.

Preflight evidence exposes source variable/config field names, never values. Read-only auth must prove that the resolved base returns the exact requested workspace slug; all searches/board IDs must be scoped to it. A base/workspace mismatch is `PLANE_TENANT_MISMATCH`, not absence. Board matching is workspace + case-insensitive identifier + expected name/optional explicit ID; identifier/name/ID collisions block with zero mutation.

### Output and outer failure isolation

The core returns data and writes only to an injected sink. Production children use piped stdio; captured stdout and stderr are each ANSI-stripped, redacted, limited to 65,536 UTF-8 bytes, and attached to action evidence with an explicit truncation flag. JSON CLI buffers all rendering and writes exactly one JSON document plus newline to stdout, with stderr empty. Canonical human CLI is a renderer over the same result; legacy human rendering remains compatible. MCP reserves process stdout exclusively for the SDK transport; tool data is the one JSON document in `content[0].text`.

Commander uses `exitOverride`, configured writers, and one top-level `parseAsync` catch that infers the operation from raw argv (or `unknown`) and serializes lifecycle unknown-command/unknown-option/missing-value/missing-argument/coercion/handler failures. Ordinary human `--help`/`--version` remain non-error Commander text with exit `0`; combining either with lifecycle `--json` is `INVALID_INPUT`, so machine mode still emits one envelope. The MCP server uses the low-level SDK request/list handlers with a shared exact Zod registry: `tools/list` publishes generated strict schemas, while `tools/call` runs `safeParse` inside the handler so Zod failures become lifecycle results rather than SDK plain text. Unexpected handler errors are redacted `INTERNAL_ERROR`; execution errors use their stable action code. No stack or secret enters human/JSON/MCP output.

Stable error codes are: `INVALID_INPUT`, `LIVE_INTENT_REQUIRED`, `LIVE_GATE_REQUIRED`, `MISSING_DEPENDENCY`, `AUTH_REQUIRED`, `AUTH_FORBIDDEN`, `READINESS_UNKNOWN`, `TARGET_CONFLICT`, `DIRTY_WORKTREE`, `INITIAL_COMMIT_APPROVAL_REQUIRED`, `UNSAFE_SYMLINK`, `UNOWNED_PATH_EFFECT`, `UNDECLARED_EFFECT`, `GITHUB_REPO_CONFLICT`, `REMOTE_MISMATCH`, `REMOTE_HISTORY_CONFLICT`, `DETACHED_HEAD`, `DEFAULT_BRANCH_MISMATCH`, `NON_FAST_FORWARD`, `PLANE_BOARD_CONFLICT`, `PLANE_TENANT_MISMATCH`, `REGISTRY_IDENTITY_MISMATCH`, `REGISTRY_UUID_COLLISION`, `ACTION_FAILED`, `VERIFICATION_FAILED`, and `INTERNAL_ERROR`.

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

## Verification

**Commands:**

- `mise run typecheck` -- expected: strict lifecycle/provider/adapter/Zod contracts compile.
- `mise run build` -- expected: both tracked shipped entrypoints rebuild without any package/version change.
- `node tests/project-lifecycle-core-regressions.mjs` -- expected: planning/authority/preflight/phases/effects/Hermes/convergence/failure/rerun cases pass using injected fakes only.
- `node tests/project-lifecycle-cli-regressions.mjs` -- expected: outer CLI, exact exits/JSON, legacy truth rows, Git safety/ownership, and output isolation pass against temp fixtures.
- `node tests/mcp-catalog-regressions.mjs && node tests/mcp-server-regressions.mjs` -- expected: exact schemas plus real-stdio parity, Zod/handler failures, legacy compatibility, and no transport corruption.
- `node tests/project-registry-regressions.mjs` -- expected: old records/legacy surfaces and UUID/state collision/convergence behavior pass in temp paths.
- `env -u PJANGLER_TEST_PG_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGDATABASE -u DATABASE_URL node tests/pg-registry-regressions.mjs` -- expected: safe skip with no PG connection; inherited PG is never contacted.
- `PJANGLER_TEST_PG_URL='postgres://test:test@127.0.0.1:55432/postgres' node tests/pg-registry-regressions.mjs` -- expected only when explicitly opted into a disposable loopback fixture published on port `55432`: explicit-ID/collision/no-reassignment round trips pass and only the validated scratch DB is removed.
- `node tests/dist-parity-regressions.mjs` -- expected: `dist/index.js` and `dist/mcp-server.js` byte-match fresh esbuild outputs in a temporary directory.
- `npm test` -- expected: full contained default suite passes; no live provider/push/host/external-registry call occurs and a PG skip is not counted as provider proof.
- `rg -n '"version": "1\.2\.19"|"version": 1\.2\.19' package.json package-lock.json version.json src/utils/version.ts` -- expected: every version declaration remains `1.2.19`.
- `git diff --check` -- expected: no whitespace errors.
- `git status --short` -- expected before implementation commit: only source/tests/package test wiring and both tracked dist files required by this spec; no migration, template submodule, Toad, version, release, host, or unrelated path.

## Auto Run Result

Status: ready-for-dev
Workflow outcome: Planning/spec-repair and the on-disk readiness gate are complete; implementation intentionally not started.
Readiness review: Passed 2026-07-18 after complete from-disk rereads against all seven BMAD READY FOR DEVELOPMENT criteria, including a post-repair reread.
Independent review remediation: 18/18 material findings individually re-audited and resolved; no remaining contract ambiguity identified.
