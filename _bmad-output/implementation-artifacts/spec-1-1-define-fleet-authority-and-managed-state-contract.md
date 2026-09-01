---
title: 'Story 1.1: Define Fleet Authority and Managed-State Contract'
type: 'feature'
created: '2026-08-31'
status: 'in-review'
baseline_revision: '0319f67f4c97efa400c74b11638c43e71ab35cde'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/fleet-convergence-live-assessment-2026-08-31.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Many live Hermes registry fields carry no declared owner in the fleet contract.
    evidence: |-
      Cross-checked contracts/fleet-contract.yaml against the live
      ~/.hermes/agents-registry.yaml. Undeclared: hindsight.*, reporting.*,
      internal_role_name, slack.{team_id,team_name,bot_user_id,bot_id,bot_username,workspace,status},
      telegram.{bot_id,bot_username,status}, hermes.codex_home,
      systemd.{cron_tick_timer,artifact_bridge_timer,watchdog_timer,checkpoint_timer},
      and gateways.bloodbank.legacy_profile_consumers. Story 1.1's ACs require
      declaring an owner per domain, not per live key, and Story 1.2 explicitly
      owns "reads the configured canonical registries" - so exhaustive field
      coverage belongs there, driven by real registry reads rather than by hand.
    location: >-
      contracts/fleet-contract.yaml (authorities.*.writable_fields)
    severity: medium
  - summary: >-
      activation.routing_prerequisites is declared but no code evaluates it.
    evidence: |-
      The constraint vocabulary (equals-fleet, equals-agent-id, nonblank) is
      defined nowhere in src/fleet/, the field paths are unchecked, and because
      the activation block is intentionally open-keyed, a typo in the key name
      silently drops the whole block with no diagnostic. It becomes load-bearing
      in Story 1.10 (Bloodbank routing readiness), which is where the resolver
      that consumes it lands.
    location: >-
      contracts/fleet-contract.yaml (activation.routing_prerequisites)
    severity: low
  - summary: >-
      The dotted field-path grammar cannot distinguish file names from nested keys.
    evidence: |-
      scaffold.role.yaml, scaffold.SOUL.md and profiles.{profile_name}.config.delta.memory.provider
      share one namespace with no separator between a file identity and a key
      path. FIELD_PATH forbids a leading dot, so .gitignore had to be written as
      scaffold.gitignore, which no longer names the real file. Nothing validates
      that a {placeholder} is one of the known set, so {agentid} passes.
    location: >-
      src/fleet/contract.ts (FIELD_PATH)
    severity: low
  - summary: >-
      dist/ is tracked, so every build churns 1000+ lines of generated bundle into each diff.
    evidence: |-
      git ls-files dist returns tracked entries, and this story's diff carries
      1000 changed lines of dist/index.js against 2300 lines of real source.
      This contradicts the repo-hygiene rule that generated output whose source
      is already tracked should not be committed, and it makes every review diff
      noisier than the change it represents. Pre-existing, repo-wide, and not
      caused by this story.
    location: >-
      dist/
    severity: low
  - summary: >-
      Several validator branches are unexercised by any test.
    evidence: |-
      No case covers an unknown top-level key, an unknown authority/projection/
      classification/retired key, an invalid detect regex, an oversized (>1 MiB)
      contract, a non-integer schema_version, a compatibility range narrower than
      the supported range, or read_only true alongside a non-empty writable_fields.
      Coverage is not failing (the ratchet rose 57.07 to 57.62 percent), so this is
      hardening rather than a regression.
    location: >-
      tests/fleet-contract-regressions.mjs
    severity: low
---

<intent-contract>

## Intent

**Problem:** PJangler has no declared, versioned statement of who owns which fleet field. Project Registry and Hermes Agent Registry carry overlapping key paths (`repo_path`/`project_path`, `ticket_provider.identifier`/`plane.identifier`, `agents.<role>.role_dir`/`agents.<id>.role_dir`) with no declared direction, no lifecycle classification for the 11 unregistered profile-root entries and 33 unattributed processes, and no separation between Bloodbank discovery and Bloodbank execution authority — so every later observation and reconciliation in Epic 1 would invent its own answer.

**Approach:** Add one tracked, versioned `contracts/fleet-contract.yaml` declaring schema/contract versions, compatibility range, authority owners, one-directional projections, lifecycle classes, the canonical PM service model, retired modes, and the strict activation field; plus a read-only `pjangler fleet contract validate [--contract <path>] [--json]` that loads, validates, and reports it with categorized field-level diagnostics and zero writes.

## Boundaries & Constraints

**Always:**
- The contract is **declaration only**. It records versions, owners, classes, name patterns, and policy. No mutable runtime observation, no credential, no host-specific secret, no transient health result, no absolute host path may appear in it — use env-var/config-key names (`HERMES_FLEET_HOME`, `PJ_PROJECT_REGISTRY`) and `{agent_id}` placeholders.
- Validation is **strictly read-only**: no registry, profile, repository, service, process, Bloodbank, filesystem, or network write. The only file read outside the contract itself is the contract path given by `--contract`.
- Every diagnostic carries a **dotted field path** (e.g. `authorities.project_identity.fields[1]`) and a category code. Never emit raw exception text, absolute host paths under `$HOME`, or unbounded content to stdout/stderr.
- Exit codes are deterministic and categorized (see I/O matrix). Set `process.exitCode`; **never call `process.exit()`** — that is the known truncation defect this repo already avoids in `src/notebook/cli.ts:47-54`.
- Namespaced extensions (`x-`-prefixed keys, at any depth) round-trip verbatim and are never interpreted as policy.
- Field ownership is declared by **real key paths that exist today** (grounded in the Code Map), not invented ones.

**Block If:**
- The tracked contract cannot be made to round-trip byte-stably even after normalising its own formatting (this would mean `yaml` v2 cannot own serialization here, which changes the AC).

**Never:**
- No mutation/reconcile/plan surface — `fleet contract validate` is the only command this story adds. `fleet status`, `fleet reconcile`, adoption, and drain belong to stories 1.2+.
- Do not read, merge, migrate, or write either live registry. Do not touch `~/.hermes`, `~/.config/pjangler`, systemd, or Bloodbank.
- Do not reuse `NotebookEnvelopeV1` — its `project`/`notebook` root blocks are mandatory and notebook-namespaced (`src/notebook/output.ts:15-55`). Define a sibling fleet envelope.
- Do not hand-author parallel "invalid contract" fixture files. Invalid cases are produced by **mutating a copy of the real tracked contract at runtime**; the valid case is the real tracked contract through the real built CLI.
- Do not add n8n concepts, per-agent Bloodbank consumers, or checkpoint timers as healthy modes — they are retired.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Canonical validate | `pjangler fleet contract validate` | Resolves `contracts/fleet-contract.yaml` from the package root; human report lists effective schema/contract version, authority owners, lifecycle classes, service model, superseded modes; exit `0` | No error expected |
| Canonical JSON | `... validate --json` | One complete `schema_version: 1` envelope, `ok: true`, `error: null`, `data.contract_version`/`authorities`/`classifications`/`service_model`/`retired` populated; exit `0` | No error expected |
| Override path | `... validate --contract <tmp copy>` | Validates that file instead; report names the resolved path | No error expected |
| Missing contract | `--contract /nonexistent.yaml` | `ok:false`, code `NOT_FOUND`, exit `3` | Message names the path only, no stack |
| Malformed YAML | contract body truncated mid-mapping | `ok:false`, code `INVALID_INPUT`, exit `2`, diagnostic carries line/col | No parser text echoed verbatim |
| Missing required field | `authorities` deleted | `ok:false`, code `INVALID_INPUT`, exit `2`, diagnostic path `authorities` | — |
| Dual-owner conflict | same field path listed writable under two authorities | `ok:false`, code `AUTHORITY_CONFLICT`, exit `4`; diagnostic names the conflicting field path **and both claimed owners** — never picks one | Deterministic ordering of the two owners |
| Invalid classification | a `managed_shared_service` entry missing `owner`/`source`/`rationale` | `ok:false`, code `INVALID_CLASSIFICATION`, exit `4`, path names the entry + missing key | — |
| Retired mode accepted | `service_model` declares `hermes-{agent_id}-consumer.service` or a checkpoint timer as healthy | `ok:false`, code `RETIRED_MODE`, exit `4` | — |
| Forward-incompatible | `schema_version: 99` | `ok:false`, code `UNSUPPORTED_SCHEMA_VERSION`, exit `5`, diagnostic states supported range | Never partially applies |
| Extension round-trip | contract with `x-delonet/note` keys at root and nested | Validates `ok:true`; extensions present in `data.extensions` and absent from policy evaluation; re-serialization is byte-identical to input | — |
| Zero writes | any of the above, run under isolated `HOME`/`XDG_*` | Scratch `HOME` tree content+mtimes unchanged after every invocation, including the failing ones | — |

</intent-contract>

## Code Map

**New (this story):**
- `contracts/fleet-contract.yaml` — the tracked canonical contract. New top-level dir; must be added to `package.json` `files` (currently `package.json:12-18`) or it will not ship.
- `src/fleet/{types,contract,output,cli,index}.ts` — new module.

**Conventions to match:**
- `src/notebook/cli.ts:115` — `export function registerNotebookCli(program: Command, module = new NotebookModule()): void` is the house pattern for a namespace helper; three-level nesting via a held const (`cli.ts:136-145`). Called from `src/index.ts:413`, after `exitOverride()`/`configureOutput()` (`index.ts:409-412`), before `program.name(...)` (`index.ts:415`).
- `src/notebook/cli.ts:47-54` — `emit()`: `process.stdout.write(...)` then `process.exitCode = ...`, never `process.exit()`. Copy this exactly.
- `src/notebook/output.ts:15-55` — envelope shape to mirror (`schema_version`, `ok`, `command`, `data`, `error{code,message,retryable,details}`, `next_actions`); `bounded()` at `output.ts:11-13` (control-char strip + 512-char cap) and the 20-entry scalar-only `details` cap at `output.ts:75-82`. `normalizeNotebookError` (`output.ts:57-64`) collapses unknown throws to `INTERNAL_ERROR` so paths never leak — reproduce that behaviour.
- `src/notebook/types.ts:50-92` — `NotebookErrorCode` union + `notebookExitCode()` band map. Model the fleet taxonomy on it.
- `src/project/index.ts:348-374, 502-505, 1841-1855` — closest analogue for "tracked YAML + `schema_version` gate + field-path diagnostics". `PROJECT_REGISTRY_OWNED_KEYS` etc. at `index.ts:378-388` are `as const` allowlists; `YamlPath`/`yamlPlain` at `index.ts:390-401`.
- `src/parity/index.ts:33-39` — `resolvePjanglerRoot()`: walk up from `dirname(fileURLToPath(import.meta.url))` for a marker, cwd fallback. **Not exported.** Duplicate the walk (8 existing sites do; e.g. `src/utils/version.ts:14`, `src/mcp-server.ts:129`) using markers `package.json` + `contracts/fleet-contract.yaml`. Must survive the bundled `dist/index.js`.
- `src/utils/style.ts` — `bold/cyan/dim/green/red/yellow/gray/glyph/heading/joinDot/padVisible`. Colour auto-disables off-TTY, so `--json` stays clean. **Pad before colouring** (`style.ts:108-121`). Report shape to copy: `formatAuditReport` at `src/parity/rules.ts:7012-7047` — build `const lines = [""]`, two-space indent, verdict line + dim context line + padded id column, `return lines.join("\n")`; the *caller* does `console.log`.
- YAML lib is **`yaml` v2** (`import YAML from "yaml"`). `YAML.parseDocument()` when comments/formatting must survive (`src/project/index.ts:303,466`). `zod` is a dependency but used only for MCP input schemas (`src/mcp-server.ts:7`) — every domain validator here is hand-rolled; stay hand-rolled.

**Read-only evidence — real field paths the contract must declare (do not invent):**
- Project Registry: `~/.config/pjangler/projects.yaml`, env `PJ_PROJECT_REGISTRY`, `schema_version: 1`. Owns `projects.<slug>.{slug,repo_path,ticket_provider.*}`; `ticket_provider` keys `src/project/index.ts:81` + allowlist `index.ts:385`. Provenance fields `identifier_source`/`identifier_fetched_at`/`board_confirmed_at` exist **only** here.
- Hermes Agent Registry: `~/.hermes/agents-registry.yaml`, env `HERMES_AGENTS_REGISTRY` (TS, `src/project/identity.ts:169`) but `HERMES_FLEET_REGISTRY_FILE` / `fleet.registry_file` (shell, `templates/hermes-agent/template/.scripts/_lib.sh:811`) — **declare both, they disagree today.** Live top-level keys: `schema_version`, `gateways`, `agents`. Per-agent (28/28): `repo, role, display_name, project_path, role_dir, profile_name, provisioned_at, bloodbank.{enabled,gateway_scope,target_agent_id}, systemd.{gateway_unit,heartbeat_timer}, hermes.{bin,repo,fleet_env}`. `gateways.bloodbank.{scope,profile_name,command_subject,target_field,systemd_unit}`.
- Overlap surface (the projections needing a declared direction): `repo_path`↔`project_path`; `slug`↔`repo`; `ticket_provider.identifier`↔`plane.identifier`; `ticket_provider.board_id`↔`plane.project_id`; `ticket_provider.workspace`↔`plane.workspace`; `agents.<role>.role_dir`↔`agents.<id>.role_dir`. Only one write actually happens today: `src/project/identity.ts:445,465` writes `["agents",<id>,"plane","identifier"]` — Plane→project-registry→hermes-registry. `.project.json` is authoritative-on-read and never written (`identity.ts:17-19`).
- Live drift the classes must be able to express: 23/24 project records carry `agents: {}`; 19/28 agents have no project record; 39 profile-root entries for 28 registered names.
- Service model: `hermes-{agent_id}-gateway.service`, `hermes-{agent_id}-heartbeat.{service,timer}` (`templates/hermes-agent/template/.scripts/70-systemd.sh:25-27`); fleet-shared `hermes-fleet-bloodbank-gateway.service`. Retired: `hermes-{agent_id}-consumer.service` (`70-systemd.sh:152`) and `systemd.checkpoint_timer` — `LEGACY_SYSTEMD_KEYS` at `src/parity/rules.ts:582`, guarded by `tests/fleet-shared-bloodbank-regressions.mjs`.
- Profile model: root `$HERMES_FLEET_HOME/profiles` (`src/parity/rules.ts:3591,3608`; `templates/hermes-agent/scripts/hermes-profile-config.py:87-90`), real directory never a symlink; `config.delta.yaml` (override SSOT) → `config.yaml` (generated, marker `src/parity/rules.ts:3559`), identity in `profile.yaml`. `FLEET_OWNED_PATHS` (`hermes-profile-config.py:204`) = `{memory.provider, memory.memory_enabled, memory.user_profile_enabled}` — the existing precedent for a dotted-path ownership set.
- Activation: `agents.<id>.bloodbank.enabled` is strict-boolean, all 28 currently `false`; parity already requires `gateway_scope == "fleet"` and `target_agent_id == <id>` (`src/parity/rules.ts:6757-6762`).
- Superseded prose to reconcile against (do not copy its `service_model: hybrid-n8n-systemd` shape): `templates/hermes-agent/docs/fleet-control-plane/architecture.md:232-240`.

**Test harness:**
- No framework. `npm test` → `scripts/run-tests.mjs`; `SUITES` is a hardcoded array (`run-tests.mjs:57-119`) — **a new suite is invisible until added there**. `tsc --noEmit` is a hard pre-gate (`run-tests.mjs:146-165`).
- Suite shape to copy: `tests/pjan-84-registry-flag-regressions.mjs` (defect-narrative header, `check(label, fn)` accumulating `failures`, `cli()` `spawnSync` wrapper, `try/finally` rmSync). Isolation block to copy verbatim: `tests/pjan-86-hermes-deploy-regressions.mjs:36-58` (`GIT_CEILING_DIRECTORIES: realpathSync(temp)`, `GIT_CONFIG_GLOBAL/SYSTEM: /dev/null`).
- `spawnSync(..., { encoding: "utf8", maxBuffer: 32*1024*1024 })` uses real OS pipes — this is how pipe capture gets exercised. `maxBuffer` must be set explicitly.
- `tests/portable-test-paths-regressions.mjs:26-36` fails the build on any literal `/home/<user>` in a `*-regressions.mjs`.
- `dist/` is **not** rebuilt by `npm test`; build first.
- `.coverage-floor.json` is percentage-based (`scripts/coverage-ratchet.mjs`); new uncovered `src/` code can trip `npm run coverage:check`. Do not hand-edit the floor.

## Tasks & Acceptance

**Execution:**
- `contracts/fleet-contract.yaml` -- author the canonical contract: `schema_version: 1`; `contract_version` (semver); `compatibility.{min_schema_version,max_schema_version}`; `authorities` (one entry per domain: project identity & board binding, agent/profile/routing records, generated profile inputs, tracked role scaffold, systemd lifecycle, live process observations, Bloodbank activation — each with `owner`, `store`, `store_env` (all real env keys), and a `writable_fields` list of real key paths); `projections` (each with `field`, `source`, `target`, `direction`, single `writable_by`); `classifications` (`managed_agent`, `managed_shared_service`, `intentionally_unmanaged`, `retired`, `unclassified`, each declaring `required_fields`); `service_model` (per-agent gateway + heartbeat service/timer name patterns, fleet-shared Bloodbank gateway unit, profile layout with `symlink_allowed: false`); `activation` (`states: [discovered, installed, healthy, routing_ready, activated]`, `execution_authority.{field,owner,strict,default: deny}`); `retired` (per-agent Bloodbank consumer, per-agent checkpoint timer, n8n-owned truth, activation-by-discovery, hard-coded Hermes checkout paths). No absolute host paths, no credentials, no runtime observations. -- this is the artifact every later story consumes.
- `src/fleet/types.ts` -- declare `FLEET_CONTRACT_SCHEMA_VERSION`, the `FleetContract` interface tree, `FleetErrorCode` union (`INVALID_INPUT | NOT_FOUND | AUTHORITY_CONFLICT | INVALID_CLASSIFICATION | RETIRED_MODE | UNSUPPORTED_SCHEMA_VERSION | INTERNAL_ERROR`), `FleetError`, `fleetExitCode()` (2/3/4/4/4/5/6 respectively), and `as const` owned-key allowlists per node -- mirrors `src/notebook/types.ts:50-92` and `src/project/index.ts:378-388`.
- `src/fleet/contract.ts` -- `resolveFleetContractPath(override?)` (walk-up from `import.meta.url`), `loadFleetContract(path)` via `YAML.parseDocument`, `validateFleetContract(doc)` returning ordered `FleetDiagnostic[]` with dotted `path` + `code`, `serializeFleetContract(doc)` for the byte-stable round trip, and extension collection (any `x-`-prefixed key at any depth, preserved and excluded from policy). Validation order: parse → schema version/compatibility → required structure → authority/projection conflicts → classification completeness → retired-mode acceptance. -- pure, no I/O beyond reading the one contract file.
- `src/fleet/output.ts` -- `FleetEnvelopeV1` (`schema_version`, `ok`, `command`, `data`, `error`, `next_actions`), `renderFleetJson()`, `fleetEnvelopeExitCode()`, `normalizeFleetError()` (unknown throws → `INTERNAL_ERROR`, cause preserved only as `{cause}`), bounded strings + capped `details`, and `formatFleetContractReport()` in the `formatAuditReport` house style. -- keeps the notebook envelope untouched while matching its guarantees.
- `src/fleet/cli.ts` -- `export function registerFleetCli(program: Command): void` creating `fleet` → `contract` → `validate` with `--contract <path>` and `--json`; on `--json` write via `process.stdout.write` and set `process.exitCode`; on human path `console.log(formatFleetContractReport(...))` + `process.exitCode`. -- mirrors `registerNotebookCli`; never calls `process.exit()`.
- `src/fleet/index.ts` -- barrel re-exporting the public surface. -- matches `src/notebook`/`src/parity` layout.
- `src/index.ts` -- import and call `registerFleetCli(program)` beside `registerNotebookCli(program)` at line 413. -- single wiring point.
- `package.json` -- add `"contracts"` to the `files` array. -- without it the contract is absent from the published tarball and `validate` breaks for installed users.
- `tests/fleet-contract-regressions.mjs` -- cover every I/O matrix row against the **real** tracked contract and the **real built** `dist/index.js`; derive each invalid case by `YAML.parseDocument`-mutating a copy of the real contract into a scratch dir (never a hand-authored parallel fixture); assert stdout is non-empty and parses before asserting on its content; snapshot scratch-`HOME` content hashes + mtimes before/after every invocation to prove zero writes; assert `serializeFleetContract(parse(real))` is byte-identical to the tracked file. -- the story's evidence bar is a real built-CLI inspection, not typecheck or exit code.
- `scripts/run-tests.mjs` -- add the new suite path to `SUITES` near the other `fleet-*` entry. -- otherwise the suite never runs.

**Acceptance Criteria:**
- Given the tracked contract and a built CLI, when `pjangler fleet contract validate` runs, then it exits `0` and its human report names the effective schema version, contract version, every authority owner, every lifecycle class, the canonical service model, and every superseded mode.
- Given `--json`, when the command runs under real subprocess pipe capture, then stdout is a single complete parseable envelope with `schema_version`, `ok: true`, `error: null`, and non-empty `data` — and the test fails rather than passes if stdout is empty.
- Given any field path listed as writable under two different authority owners, when validation runs, then it fails with `AUTHORITY_CONFLICT`, names the field path and **both** owners, and selects neither.
- Given Project Registry and Hermes Agent Registry both describe related fleet state, when the tracked contract is loaded and inspected, then Project Registry is the declared owner of project identity and project-to-board binding, Hermes Agent Registry is the declared owner of operational agent/profile/routing records, and every projection in the overlap surface declares exactly one direction and one `writable_by`.
- Given every non-`managed_agent` managed classification, when validation runs, then each is required to carry stable identity, kind, owner, source/provenance, lifecycle state, rationale/notes, and applicable policy domains — and an entry missing any of them fails with `INVALID_CLASSIFICATION` naming the entry and the missing key.
- Given a contract that declares a per-agent Bloodbank consumer, a per-agent checkpoint timer, n8n-owned truth, activation-by-discovery, or a hard-coded Hermes checkout path as a healthy mode, when validation runs, then it fails with `RETIRED_MODE` rather than accepting it as an alternate healthy mode.
- Given a target whose Bloodbank metadata is discoverable, when the contract resolves its lifecycle and activation authorities, then discovery, installation, health, routing readiness, and execution activation are five distinct declared states and only `agents.<id>.bloodbank.enabled`, owned by the Hermes Agent Registry and strict-boolean, can grant execution authority; the declared default is deny.
- Given any invalid contract, when validation fails, then the process performs zero registry, profile, repository, service, process, Bloodbank, or external writes — proven by an unchanged content+mtime snapshot of an isolated scratch `HOME`.
- Given a contract carrying `x-`-namespaced extension metadata, when it is read, validated, and re-serialized, then the extensions survive verbatim, are reported separately from policy, and the unchanged round trip is byte-identical.
- Given a clean checkout with the new module in place, when `npm run typecheck && npm run build && npm test` runs, then all three pass and the new suite appears in `node scripts/run-tests.mjs --list`.

## Spec Change Log

## Review Triage Log

## Design Notes

**Why a sibling envelope, not the notebook one.** `validateNotebookEnvelope` (`src/notebook/output.ts:84-197`) requires `project` and `notebook` root blocks and gates on a hardcoded command set at `output.ts:110-114`. A fleet contract is not project-scoped. A parallel `FleetEnvelopeV1` with the same guarantees (bounded strings, capped details, `ok ⟺ error === null`) keeps both contracts honest and leaves story 1.4's registry-wide status free to extend the fleet envelope.

**Conflict detection shape.** Build one `Map<fieldPath, owner[]>` from every authority's `writable_fields` plus every projection's `writable_by`; any entry with length > 1 is a conflict. Emit them sorted by field path, with owners sorted, so diagnostics are deterministic:

```
✖ authority conflict
     → projects.<slug>.ticket_provider.identifier claimed writable by: hermes-agent-registry, project-registry
```

**Byte-stable round trip.** `String(YAML.parseDocument(text))` is the serializer. If the hand-authored contract does not round-trip byte-for-byte, normalise the tracked file until it does — the canonical file is the thing that must be canonical, not the serializer.

**Env-key disagreement is a finding, not a bug to fix here.** The TS and shell paths read the Hermes registry from different env vars. The contract records both under `store_env` so story 1.2+ can converge them; this story does not change either reader.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean, zero errors.
- `npm run build` -- expected: `dist/index.js` regenerated.
- `node dist/index.js fleet contract validate` -- expected: exit `0`, report naming schema version, contract version, authorities, classes, service model, superseded modes.
- `node dist/index.js fleet contract validate --json | cat` -- expected: complete parseable envelope through a real pipe, `ok: true`, non-empty `data`.
- `node dist/index.js fleet contract validate --contract /nonexistent.yaml; echo $?` -- expected: `3`, `NOT_FOUND`, no stack trace.
- `node tests/fleet-contract-regressions.mjs` -- expected: all checks ok, exit `0`.
- `npm test` -- expected: full suite green with the new entry present in the run list (`node scripts/run-tests.mjs --list | grep fleet-contract`).
- `npm run test:coverage && npm run coverage:check` -- expected: floor not tripped.
