---
title: 'Story 1.2: Discover the Complete Fleet and Detect Identity Conflicts'
type: 'feature'
created: '2026-09-01'
status: 'done'
baseline_revision: '9f0693eb10247aeb85d8eb7d1d3dfa7d6e8f42e6'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-1-define-fleet-authority-and-managed-state-contract.md'
  - '{project-root}/contracts/fleet-contract.yaml'
warnings: ['oversized']
deferred:
  - summary: >-
      The agent-row identity key has no declared owner of its own.
    evidence: |-
      The contract declares agents.{agent_id}.repo, .role, .role_dir and so on,
      but never agents.{agent_id} itself -- and the row KEY is a value the
      inventory has to attribute: it is the agent id, and it is one of AC5's
      conflict dimensions. buildAuthorityIndex therefore falls back to the modal
      owner of everything declared beneath the namespace, which answers
      hermes-agent-registry today because 20 of the 25 declared agents.* paths
      are that authority's. The answer is right, but it is derived rather than
      declared, and a contract that moved enough agents.* paths elsewhere would
      flip it silently. The same fallback covers profiles.{profile_name}.
      Declaring the two namespaces is Story 1.1's surface, and this story's
      Block If forbids inventing an owner.
    location: >-
      contracts/fleet-contract.yaml (authorities.agent_operational_records) /
      src/fleet/inventory.ts (buildAuthorityIndex)
    severity: low
  - summary: >-
      DW-1's undeclared field list is still undeclared; this story reads none of it.
    evidence: |-
      Every field path the inventory attributes resolves to exactly one declared
      owner against the live 28-agent registry, so DW-1 is closed for the fields
      this story reads. hindsight.*, reporting.*, internal_role_name, slack.*,
      telegram.*, hermes.codex_home, systemd.{cron_tick,artifact_bridge,
      watchdog,checkpoint}_timer and gateways.bloodbank.legacy_profile_consumers
      remain undeclared, because inventory reads none of them. They become
      load-bearing in Story 1.8 (systemd topology) and Story 1.10 (routing
      readiness).
    location: >-
      contracts/fleet-contract.yaml (authorities.*.writable_fields)
    severity: medium
  - summary: >-
      One store, three declared authorities, and `stores[].owner` reports the first.
    evidence: |-
      `authorityFor` returns the first authority whose `store` matches. The
      contract declares three against `hermes-agent-registry`:
      agent_operational_records (owner hermes-agent-registry),
      board_identity_projection (owner PROJECT-REGISTRY) and bloodbank_activation.
      So `data.stores[].owner` says hermes-agent-registry and silently hides the
      one cross-store write the contract goes out of its way to call out. A
      derived answer, in a module whose stated rule is that it never invents an
      owner. Reporting the owner SET, or the authority ids, is the fix.
    location: >-
      src/fleet/inventory.ts (authorityFor / storeView)
    severity: medium
  - summary: >-
      A missing PROJECT registry aborts the whole run instead of degrading.
    evidence: |-
      `readProjectRegistryRaw` throws NOT_FOUND before any row is built, so a
      host with a Hermes registry but no ~/.config/pjangler/projects.yaml gets
      exit 3 and NO inventory -- rather than 28 rows each carrying
      `project-record-missing`, which is what the uncorrelated case already does
      when the file merely lacks the record. Two consequences of the same choice:
      `FleetStoreView.exists` can never be false and the `parse: "unreadable"`
      fallback is unreachable, because `raw` is never null by the time
      `storeView` is called.
    location: >-
      src/fleet/inventory.ts (readProjectRegistryRaw / storeView)
    severity: medium
  - summary: >-
      The store env keys and both registry path resolvers are re-derived, not read.
    evidence: |-
      `envKeys` is the literal ["HERMES_AGENTS_REGISTRY","HERMES_FLEET_REGISTRY_FILE"]
      / ["PJ_PROJECT_REGISTRY"], duplicating `authorities.*.store_env`, which the
      contract already declares and `fleet contract validate` already projects.
      `resolveInventoryStores` likewise reimplements the exported
      `hermesAgentsRegistryPath` and `projectRegistryPath`, and diverges from both
      (it adds the fleet-key fallback and applies expandHome). Same class as the
      re-hardcoding the story's Always list forbids for unit patterns, one step
      outside the three surfaces that list names.
    location: >-
      src/fleet/inventory.ts (resolveInventoryStores)
    severity: low
  - summary: >-
      A duplicate-key conflict group names one participant, itself.
    evidence: |-
      `participants: [agentId]` for the duplicate-agent-id dimension, and the
      same shape for duplicate project keys. The finding renders as
      "candystore-pm is claimed by candystore-pm", the group cannot say WHICH two
      rows collided, and `matchException`'s exact-set rule then forces an
      operator to declare `participants: [<the-id-itself>]` to permit it.
      Occurrences (index-qualified) rather than the key repeated.
    location: >-
      src/fleet/inventory.ts (detectConflicts, duplicate-key branches)
    severity: medium
  - summary: >-
      Values are bounded BEFORE they are lstat'd, correlated, and matched.
    evidence: |-
      `scalar()` runs every registry value through `bounded()` (512-char cap, C0
      stripped, CR/LF folded) and the bounded string is what `classifyPath`
      lstats and what correlation looks up -- so a path longer than 512 chars, or
      one containing a control character, is classified and correlated against a
      value the registry does not contain, and reports `absent` for a directory
      that exists. Agent identity keys are bounded to 128 in `readKeyedStore` and
      `--agent` matches the truncated key, so an id longer than 128 chars is
      inventoried but can never be selected: NOT_FOUND, exit 3, for a genuinely
      registered agent.
    location: >-
      src/fleet/inventory.ts (scalar / readKeyedStore key bounding)
    severity: medium
  - summary: >-
      `health.healthy` conflates fleet drift with an envelope presentation cap.
    evidence: |-
      `truncated.length === 0` is a conjunct of `healthy`, so a fleet of 1001
      well-formed agents, or one that trips MAX_FINDINGS, gets the identical
      UNHEALTHY verdict a real identity conflict produces. `health.truncated`
      already exists as its own signal. Defensible as "you did not see all of
      it", but the verdict should read from the fleet, and the two states should
      not be indistinguishable to a consumer.
    location: >-
      src/fleet/inventory.ts (health.healthy)
    severity: low
  - summary: >-
      Nothing drives the row cap, so FLEET_INVENTORY_MAX_ROWS is unproven.
    evidence: |-
      No case produces more than MAX_ROWS rows or more than MAX_FINDINGS
      findings, so neither the rows clip nor its `truncated` note has ever
      executed; the findings-clip assertion is conditional and never fires on a
      28-agent fleet. The cap is exactly the code path whose first cut was
      already wrong once in this story (it stopped pushing at the cap, so the
      clip could never be recorded).
    location: >-
      tests/fleet-inventory-regressions.mjs
    severity: medium
  - summary: >-
      `--agent` leaves `data.findings` fleet-wide, undocumented and unpinned.
    evidence: |-
      Findings are never filtered by scope, so `--agent pjangler-pm` returns
      every other agent's findings. That is consistent with the
      totals/health/conflicts rule and is probably right, but the README bullet
      enumerates only `data.totals`, `data.health` and `data.conflicts`, and no
      check pins the behaviour either way -- so it can flip silently.
    location: >-
      src/fleet/inventory.ts (scope filter) / README.md
    severity: low
  - summary: >-
      The exported surface is inconsistent and partly uncallable in typed code.
    evidence: |-
      `readAgentRegistryRaw`/`readProjectRegistryRaw` are exported and barrelled
      but their return type `RawStore` is not; `detectConflicts` is exported
      while its `ConflictInput` parameter type is not, so it cannot be called
      from typed code; `buildInventoryRow` and `ClassifyPathOptions` are exported
      from the module but absent from `src/fleet/index.ts`; `FleetFindingSeverity`
      is missing from the barrel while `FLEET_FINDING_SEVERITIES` is present.
    location: >-
      src/fleet/inventory.ts / src/fleet/index.ts
    severity: low
  - summary: >-
      Two of the four live symlinked profile directories are reported; two are invisible.
    evidence: |-
      ~/.hermes/profiles holds four symlinks. Inventory is row-driven, and only
      `delonet-company-reporter` and `hermes-agent-pm` are named by a registered
      agent's profile_name, so those two raise `profile-path-symlinked`.
      `intelliforia-voice-agent` and `stemjangler-adversarial-review` are
      symlinks in the declared profile root that no row reaches, so the contract
      violation they represent is reported by nothing. A profile-root sweep is
      the missing half; AC8 is written per-row, so this is beyond it.
    location: >-
      src/fleet/inventory.ts (per-row profile classification)
    severity: medium
  - summary: >-
      The tracked contract has no exercised managed-exception path.
    evidence: |-
      `FleetInventoryOptions.contract` exists in the core and is reachable from
      no CLI caller (the command ships four flags by design, and --contract is
      not one). The suite proves the exception mechanism by RELOCATING the built
      bundle beside a mutated contract and leaning on the walk-up in
      `resolveFleetContractPath`. That is a real end-to-end run, but it exercises
      a synthetic package root; nothing exercises an exception against
      contracts/fleet-contract.yaml itself.
    location: >-
      tests/fleet-inventory-regressions.mjs (packageWithContract)
    severity: low
  - summary: >-
      The independence of `source_rows` is not observable from outside the CLI.
    evidence: |-
      This pass replaced the tautological count (items.length over the array the
      row builder walks) with a genuinely separate parse, and PROVED it by
      mutation: breaking the reader's node extraction now yields source_rows 28,
      emitted_rows 0 and an UNHEALTHY verdict where it used to yield "healthy,
      0 of 0". But no black-box check can inject a reader defect, so the suite
      pins only the consequence (raw keys, duplicates included; an unreadable
      collection is loud). A source-shape assertion was deliberately NOT added:
      a text match would be green because the text matched, not because the
      property held.
    location: >-
      src/fleet/inventory.ts (countCollectionRows) / tests/fleet-inventory-regressions.mjs
    severity: low
---

<intent-contract>

## Intent

**Problem:** Story 1.1 declared *who owns which fleet field*, but nothing reads the two canonical registries and correlates them. Today the only registry-wide agent enumeration in TypeScript is `readHermesAgentBoards` (`src/project/identity.ts:316`), which projects 6 of the ~43 live per-agent field paths and throws raw `ENOENT` on a missing file; the only registry-wide correlation, `reconcileProjectIdentity` (`identity.ts:873`), makes network calls and can write. Everything else (`ownedRegistryEntries`, `src/parity/rules.ts:3779`) is deliberately scoped to one repo. So no invocation can answer "what is the whole fleet, and where does it disagree with itself?" — and the live fleet already disagrees: 19 of 28 agents have no project record, `automatic-ai` is claimed as `repo` by two agents, board identifier `CANDYS` is claimed by two agents, and 4 profile entries are symlinks the contract declares illegal.

**Approach:** Add a read-only fleet inventory core (`src/fleet/inventory.ts`) that tolerantly reads both canonical registries plus each repo's `.project.json`, emits one stable row per raw Hermes agent entry with per-field authoritative-source provenance, groups identity conflicts under stable group IDs, and reports independently counted totals; expose it as `pjangler fleet inventory [--agent <id>] [--project-registry <path>] [--agent-registry <path>] [--json]` through the existing fleet envelope.

## Boundaries & Constraints

**Always:**
- **Strictly read-only.** No registry, manifest, profile, repo, service, or network write; no directory, project, role, profile, or registry row is ever created. `--agent`/`--project-registry`/`--agent-registry` never change the configured canonical paths; the result reports both `configured_path` and `inspected_path` per store.
- **Tolerant parsing is mandatory, not optional.** `loadProjectRegistry` (`src/project/index.ts:348`) **throws** on duplicate slug / repo_path / board_id / identifier — exactly the duplicates AC5 requires this command to *report*. Inventory must own its own `YAML.parseDocument` + per-record salvage for both stores. One unparseable row never sinks the run.
- **Counts are independent of row-building.** `totals.source_rows` is counted from the raw `agents:` mapping keys in a separate pass, before any row is built, so a row-builder bug shows up as `source_rows != emitted_rows` instead of vanishing.
- **Every emitted field value carries `{value, source, state}`**, where `source` is the authority `owner` the contract declares for that field path and `state` is one of `resolved | unresolved | conflicted | unobserved`. Never infer a value from a convenient basename; unknown is explicitly `null` + `unresolved`.
- **Paths are classified, never followed for mutation.** `lstat` first. A symlink is reported as `symlink` with its bounded target; a relative, absent, or out-of-root path is classified, not silently retargeted.
- Set `process.exitCode`; **never call `process.exit()`** (pinned by an existing check, `tests/fleet-contract-regressions.mjs:824`). No raw NUL bytes in any `src/` file (pinned at `:1123`).
- Deterministic ordering everywhere: rows by `agent_id` byte order (`<`, never `localeCompare`), conflict groups by group id, findings by `(field, code)`.
- The contract is the source of the service model, activation gate, and authority owners — load it via `loadFleetContract`/`validateFleetContract`; do not re-hardcode unit-name patterns or the activation field.

**Block If:**
- The tracked contract cannot supply an authority owner for a field path the inventory must attribute, and inventing one would be the only way forward. (Declaring new owners is Story 1.1's surface, not this one.)

**Never:**
- No health, provenance, systemd, live-process, or Bloodbank *probing* — those are Stories 1.3–1.10. Inventory reports **expected** unit names and **stored** Bloodbank references only.
- Do not call `loadProjectRegistry`, `readHermesAgentBoards`, `reconcileProjectIdentity`, `applyHermesIdentifiers`, `saveProjectRegistry`, `upsertRegistryEntry`, or `synchronizeCopierIdentity`.
- Do not promote `.project.json` into a registry authority — it is a read-only third opinion used to confirm or contradict.
- Do not hand-author invalid registry fixtures. Derive every invalid/duplicate/malformed case by `YAML.parseDocument`-mutating a **copy of a real registry** into a scratch dir, the discipline Story 1.1 used.
- Do not add a new top-level key to `contracts/fleet-contract.yaml` (`FLEET_CONTRACT_ROOT_KEYS` is a closed set and a change bumps `contract_version`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Full inventory | `pjangler fleet inventory` | Human report: totals, health, per-agent rows, conflict groups, top findings; exit `0` | No error expected |
| Full inventory JSON | `... --json` | One complete `schema_version: 1` envelope, `ok: true`, `error: null`, `data.totals`/`rows`/`conflicts`/`stores`/`findings`/`truncated` populated; exit `0` | No error expected |
| Unlinked agent | agent whose `project_path` matches no project record | Row emitted; `project_id` `null`/`unresolved`; finding `project-record-missing` naming the store + path; other agents unaffected | No error |
| Missing repo / manifest / role dir / profile dir | referenced path absent | Row emitted; that field `unresolved` with the owning source and bounded path; nothing created | No error |
| Symlinked profile dir | profile root entry is a symlink (4 live today) | Field state `unresolved`, finding `profile-path-symlinked` + bounded link target; contract's `symlink_allowed: false` cited; link never followed | No error |
| Duplicate board identifier | two agents share `plane.identifier` (`CANDYS` live) | Both rows carry the **same** conflict group id, the conflicting field path, and both owners; `data.health.healthy: false`; exit `0` | No error |
| Duplicate repo slug | two agents share `repo` (`automatic-ai` live) | Same as above under field `agents.{agent_id}.repo` | No error |
| Permitted conflict | an `classifications.intentionally_unmanaged` entry matches the group | Group `permitted: true`, `exception_id` set; aggregate stays healthy; group still fully reported | No error |
| Malformed agent row | one row is a scalar / has a non-string `role_dir` | Row emitted carrying the **raw identity key**, `state: unresolved`, one bounded diagnostic; all other rows inventoried; `totals.malformed_rows` ≥ 1 | Value never used as a unit name unverified, never echoed unbounded |
| Registry-wide duplicate slug | project registry has two records with the same `slug` | Reported as a conflict group; command still succeeds (where `loadProjectRegistry` would throw) | No error |
| `--agent <known>` | exact known agent id | Exactly that row; `totals` still reports the full registered fleet size plus `selected`/`observed`; result labelled scoped | No error |
| `--agent <unknown>` | id not in the registry | `ok:false`, code `NOT_FOUND`, exit `3`, `details.agent_id` bounded | Message names the id only, no stack |
| Registry override | `--agent-registry <tmp copy>` | Inspects that file; `data.stores[].configured_path` still names the canonical path and `inspected_path` the override | No error |
| Missing registry | `--agent-registry /nonexistent.yaml` | `ok:false`, code `NOT_FOUND`, exit `3` | Path bounded + home-redacted |
| Unparseable registry | agent registry truncated mid-mapping | `ok:false`, code `INVALID_INPUT`, exit `2` | No parser text echoed verbatim |
| Empty flag value | `--agent ""` / `--agent-registry ""` / a `--`-prefixed value | `ok:false`, code `INVALID_INPUT`, exit `2` | Mirrors the `--contract` guards at `cli.ts:229,236` |
| Zero writes | any of the above under isolated `HOME`/`XDG_*` | Scratch tree content+mtimes unchanged after every invocation, including failing ones | — |

</intent-contract>

## Code Map

**New (this story):**
- `src/fleet/inventory.ts` — the application core. Entirely greenfield; no `inventory` symbol exists in `src/` today.
- `tests/fleet-inventory-regressions.mjs` — new suite.

**Existing fleet module — five blockers that must be changed, not worked around:**
- `src/fleet/output.ts:24` — `FLEET_COMMANDS = ["fleet.contract.validate"]` is a **closed allowlist**; `validateFleetEnvelope` rejects anything else (`output.ts:300`). Add `"fleet.inventory"`.
- `src/fleet/output.ts:307-309` — `validateFleetEnvelope` hardcodes validate's ten `data.*` keys for every `ok` envelope. Must become per-command (a `command → required data keys` map).
- `src/fleet/cli.ts:263-267` — `write()` is typed to `FleetContractInspection` and hardwires `formatFleetContractReport`. Generalize (pass a formatter thunk) rather than adding a second copy.
- `src/fleet/cli.ts:198-203` — `fleetParserFailureEnvelope(_args)` ignores its args and always reports `fleet.contract.validate`. Its own comment (`cli.ts:199-201`) says a second command is exactly when to fix it. Derive the command id from `args`. `isFleetJsonInvocation` (`cli.ts:186`) is already command-agnostic and needs no change.
- `src/fleet/cli.ts:75-79` `cappedStrings` and `:61-65` `boundedNotes` are private to `cli.ts`. Promote to `output.ts` beside `bounded`.

**Reuse verbatim:**
- `src/fleet/output.ts:102-107` `bounded()` (512 cap, strips C0+DEL, folds CR/LF); `:137-149` `redactHome`; `:159-165` `boundedContext`; `:210-216` `normalizeFleetError`; `:218/229` `fleetSuccessEnvelope`/`fleetFailureEnvelope`; `:246-254` `sanitizeDetails`; `:263-279` `diagnosticDetails`; `:281` `renderFleetJson`; `:286` `fleetEnvelopeExitCode`; `:206` `ignoreBrokenPipe`.
- **Trap:** `boundedValue` (`output.ts:172-197`) caps arrays at `MAX_ITEMS = 100` (`:167-169`). Do **not** run the rows array through it — 101+ agents would vanish silently. Bound each row's strings individually and cap the rows array explicitly with a recorded `truncated` note.
- `src/fleet/types.ts:172-179` `FleetErrorCode`; `:220-230` `fleetExitCode` (INVALID_INPUT 2, NOT_FOUND 3, AUTHORITY_CONFLICT/INVALID_CLASSIFICATION/RETIRED_MODE 4, UNSUPPORTED_SCHEMA_VERSION 5, INTERNAL_ERROR 6); `:193-197` `FleetDiagnostic`; `:199-211` `FleetError`.
- `src/fleet/contract.ts:108-118` `resolveFleetContractPath` (walk-up on `package.json` **+** `contracts/fleet-contract.yaml`, survives bundled `dist/index.js`); `:120` `loadFleetContract`; `:215` `validateFleetContract`.
- `src/fleet/cli.ts:214-261` `registerFleetCli` — hang `fleet.command("inventory")` off the existing `fleet` const at `:215`, **not** off `contract` (`:216`). Copy the empty-value guard (`:229-231`), the `--`-prefixed-value guard (`:236-238`), and the nested render-failure catch (`:257-258`).
- `src/fleet/index.ts` — barrel; new public symbols go here too.
- `src/index.ts:416` — `registerFleetCli(program)` is already wired; no change needed there. `src/index.ts:1465-1471` routes parser failures through `fleetParserFailureEnvelope`.

**Registry read surface (read-only evidence, verified against live stores today):**
- `src/project/index.ts:322-324` `projectRegistryPath(env)` — exported; `PJ_PROJECT_REGISTRY` else `~/.config/pjangler/projects.yaml`. Not XDG-aware. `expandHome` at `:1910`.
- `src/project/identity.ts:169-172` `hermesAgentsRegistryPath(env, home)` — exported; `HERMES_AGENTS_REGISTRY` else `~/.hermes/agents-registry.yaml`. `HERMES_FLEET_REGISTRY_FILE` (the shell provisioner's key, declared in the contract) has **zero** TS references — read it as a fallback and emit a finding when the two disagree; do not change either writer.
- `src/project/index.ts:1051` `resolveContainedPath(parentDir, candidate, label)` — exported, realpath-based containment, but it **throws**. Inventory needs classification, so wrap it or use `lstatSync`/`realpathSync` in try/catch. `:1018` `validateSafePathSegment` is the exported segment guard to use before any value is treated as a unit-name component.
- `src/project/identity.ts:368` `readManifestBoard(repoPath)` — exported, `existsSync`-guarded, `JSON.parse` in try/catch, never writes. Covers only the board block; read `agents`/`project_name` from the same JSON directly if needed.
- Profile root: `join(process.env.HERMES_FLEET_HOME || join(home, ".hermes"), "profiles", profile_name)` — mirrors the unexported `fleetHome` (`src/parity/rules.ts:3592`) and `singletonPlan` (`:3608`). Duplicate the one line; do not export parity internals.
- Expected runtime path: `join(role_dir, "runtime")` — `src/parity/rules.ts:3609`.
- Types to mirror, not import wholesale: `ProjectRecord` `src/project/index.ts:123`, `ProjectTicketProvider` `:81`, `ProjectAgentRecord` `:109`, `ProjectManifest` `:153`.

**Live ground truth (2026-09-01, `~/.hermes/agents-registry.yaml` + `~/.config/pjangler/projects.yaml`):**
- 28 agents, 24 project records; `schema_version: 1` on both. Top-level agent-registry keys: `schema_version`, `gateways`, `agents`.
- Universal per-agent fields (28/28): `repo, role, display_name, project_path, role_dir, profile_name, provisioned_at, telegram.bot_username, bloodbank.{enabled,gateway_scope,target_agent_id}, systemd.gateway_unit, hermes.{bin,repo,fleet_env}`. Sparse: `plane.*` 26, `runtime_repo` 11, `systemd.heartbeat_timer` 11, `hermes.codex_home` 10, `slack.*` 8-9, `hermes.git_{url,ref,sha}` 7, `telegram.*` 8, and one-offs `hindsight.*`, `reporting.*`, `internal_role_name`, `systemd.{cron_tick,artifact_bridge,watchdog,checkpoint}_timer`. **DW-1 in `deferred-work.md` is the ledger entry this story closes for the fields it actually reads.**
- `gateways.bloodbank` carries an undeclared `legacy_profile_consumers: retired-disabled-2026-07-31`.
- 9/28 agents correlate to a project record; 19 do not. 23/24 project records have `agents: {}`.
- Real conflicts present: `repo: automatic-ai` (`automatic-ai-pm`, `condaleeza`); `plane.identifier: CANDYS` (`candystore-pm`, `candybar-pm`). No `project_path`, `profile_name`, or `bloodbank.target_agent_id` duplicates today.
- Profile root: 77 entries, 35 dirs, **4 symlinks** (`delonet-company-reporter`, `hermes-agent-pm`, `intelliforia-voice-agent`, `stemjangler-adversarial-review`) — every one violates `service_model.profile_layout.symlink_allowed: false`.
- 24/28 agent `project_path`s contain a `.project.json`; missing for `nautilus-trader-pm`, `delonet-company-reporter`, `hermes-agent-pm`, `condaleeza`.
- All 28 `project_path` and `role_dir` values exist; all 28 profile directories exist.

**Contract facts that gate the design:**
- `classifications.*.entries` are validated only for (a) being mappings (`contract.ts:472`) and (b) carrying that class's `required_fields` (`:684-698`). **Extra keys on an entry are accepted** — that is what makes the exception shape below legal without a schema change.
- `contract.ts:737` feeds `classifications.*.entries` into the retired-mode / credential / host-path scan. An exception entry containing an absolute host path is refused by `HOST_PATH` (`:51`). Express exceptions in field-path and identity terms only.
- `service_model.per_agent` supplies the expected unit names; `activation.execution_authority.field` = `agents.{agent_id}.bloodbank.enabled`, `strict: true`, `default: deny`.

**Test harness:**
- `scripts/run-tests.mjs:57-120` `SUITES` — a suite is invisible until listed; fleet entries at `:101-102`. `tsc --noEmit` pre-gate at `:147-166`. `--list` at `:139-143`.
- `tests/fleet-contract-regressions.mjs` is the shape to copy: `skip()` `:59`, `check()` `:64-72`, `snapshotTree()` `:125-145` (content hash + mtime + symlink target), `snapshot()` `:156-165`, `cli()` `:174-186` (`maxBuffer: 32*1024*1024`, real OS pipes, asserts zero writes on every call), `envelope()` `:189`, `mutated()` `:214`, `rawCopy()` `:222`. Isolation block `:93-115` already sets `HERMES_FLEET_HOME`, `HERMES_AGENTS_REGISTRY`, `HERMES_FLEET_REGISTRY_FILE`, `PJ_PROJECT_REGISTRY`, `GIT_CEILING_DIRECTORIES`, `TMPDIR`, `NO_COLOR` — reuse verbatim.
- `tests/portable-test-paths-regressions.mjs:7-8` fails the build on any literal `/(home|Users)/<name>` in a `*-regressions.mjs`. Derive real paths from `os.userInfo().homedir` (precedent: `fleet-contract-regressions.mjs:53-54`).
- `.coverage-floor.json`: lines/statements 57.07, functions 43.61, branches 72.22; `scripts/coverage-ratchet.mjs:57` fails at `now < min - 0.2`. Do not hand-edit the floor.
- `mise.toml:30-35` `[tasks."fleet:contract"]` with `depends = ["build"]` is the pattern for a `fleet:inventory` task.
- `dist/` is **not** rebuilt by `npm test`; build first.
- README `## Fleet contract` occupies lines 41-77; next section starts at 79.

## Tasks & Acceptance

**Execution:**
- `src/fleet/types.ts` -- add `FLEET_INVENTORY_MAX_ROWS = 1000`, the `FleetFieldState` union (`resolved | unresolved | conflicted | unobserved`), `FleetFieldValue<T> = {value: T | null; source: string | null; state: FleetFieldState}`, `FleetInventoryRow`, `FleetConflictGroup`, `FleetInventoryFinding`, `FleetInventoryTotals`, `FleetStoreView`, and `FleetInventory`. -- keeps the story's vocabulary beside the contract's, matching how `FleetContract` already lives here.
- `src/fleet/output.ts` -- add `"fleet.inventory"` to `FLEET_COMMANDS`; replace the hardcoded `data`-key check at `:307-309` with a `command → required keys` map (validate keeps its ten, inventory declares `stores, totals, health, rows, conflicts, findings, truncated`); move `cappedStrings`/`boundedNotes` in from `cli.ts` and export them; add `formatFleetInventoryReport(inventory)` in the `formatFleetContractReport` house style (`:339-424`). -- without the first two edits `renderFleetJson` throws `INTERNAL_ERROR` for every inventory run.
- `src/fleet/inventory.ts` -- the core: `resolveInventoryStores(overrides, env)` (configured vs inspected paths for both registries, plus the `HERMES_AGENTS_REGISTRY`/`HERMES_FLEET_REGISTRY_FILE` disagreement finding); tolerant `readAgentRegistryRaw`/`readProjectRegistryRaw` via `YAML.parseDocument` with per-row salvage and an independent source-row count; `classifyPath(raw, {root})` returning `absent | relative | symlink | outside-root | ok` from `lstat`, never following a link; `buildInventoryRow(agentId, raw, ctx)` attributing every field to its contract authority owner; `detectConflicts(rows, projects, contract)` over the seven AC5 dimensions with stable group ids; `matchException(group, contract)` against `classifications.intentionally_unmanaged.entries`; `collectFleetInventory(options)` composing them and returning `FleetInventory`. -- one core, no I/O beyond reading the two registries, the contract, each `.project.json`, and `lstat` on referenced paths.
- `src/fleet/cli.ts` -- generalize `write()` to take a formatter thunk instead of a `FleetContractInspection`; make `fleetParserFailureEnvelope` derive the command id from `args`; register `inventory` on the existing `fleet` const with `--agent <id>`, `--project-registry <path>`, `--agent-registry <path>`, `--json`, reusing the empty-value and `--`-prefixed guards for all three path/id options. -- second command in the namespace; the existing single-command shortcuts stop being true here.
- `src/fleet/index.ts` -- re-export the new inventory surface. -- matches the module's existing barrel discipline.
- `tests/fleet-inventory-regressions.mjs` -- cover every I/O matrix row against the real built `dist/index.js`; derive every registry case by `YAML.parseDocument`-mutating **copies of the real registries** into scratch (never hand-authored fixtures); assert stdout is non-empty and parses before asserting on content; snapshot scratch content+mtimes around every invocation; add one `skip()`-guarded check that runs against the **real configured** registries and asserts emitted row count and `totals.source_rows` equal an independent `YAML.parse` count of the live `agents` keys, with the two real registry files' content+mtime unchanged. -- the story's evidence bar is a real built-CLI run against real state, not mocks or exit codes.
- `scripts/run-tests.mjs` -- add `tests/fleet-inventory-regressions.mjs` to `SUITES` beside the fleet entries at `:101-102`. -- otherwise the suite never runs.
- `mise.toml` -- add `[tasks."fleet:inventory"]` with `depends = ["build"]`, mirroring `fleet:contract` at `:30-35`. -- a gate that fails with `ERR_MODULE_NOT_FOUND` on a fresh clone teaches nothing.
- `README.md` -- document `fleet inventory`, its four flags, the exit-code taxonomy, and the healthy-vs-unhealthy-versus-failed distinction, in a block after line 77. -- operators need to know an unhealthy fleet still exits 0.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- mark DW-1 addressed for the field paths this story reads, or restate precisely what remains. -- DW-1 explicitly hands exhaustive field coverage to this story.

**Acceptance Criteria:**
- Given the live agent registry and a built CLI, when `pjangler fleet inventory --json` runs, then `data.totals.source_rows` equals an independent count of the raw `agents:` keys, `emitted_rows` equals `source_rows`, and every agent id appears exactly once in `data.rows`.
- Given an agent with no matching project record, when inventory runs, then its row is still emitted with `project_id.state: "unresolved"` and a finding naming the project registry as the owning source — and the run still reports every other agent.
- Given every emitted row, when the JSON is inspected, then agent id, lifecycle classification, project id, canonical repository path, role, role directory, profile name, contained profile path, expected runtime path, expected owned unit names, stored board binding, and Bloodbank scope/target/activation reference are each present with a non-empty `source` or an explicit `null` value at state `unresolved`/`unobserved`.
- Given an agent whose `project_path` correlates with a project record and a repository `.project.json`, and the three agree under the contract's declared projections, when inventory runs, then the row's correlation is `resolved`, each correlated field names the registry that owns it, and the manifest appears only as confirming evidence — never as the `source` of a field and never as a tiebreaker when the two registries disagree.
- Given two agents sharing any of project id, canonical repository path, agent id, profile name, board binding, derived unit name, or Bloodbank target id, when conflict detection runs, then both rows remain fully emitted, both carry the identical conflict group id, and the group names the conflicting field path and both owners.
- Given a `classifications.intentionally_unmanaged` entry whose declared identity matches a conflict group, when inventory runs, then the group reports `permitted: true` with that entry's id and the aggregate stays healthy; with the entry removed the identical fleet reports `healthy: false`.
- Given a registry containing one malformed agent row, when inventory runs, then the run succeeds, the malformed row's raw identity key is present in `data.rows`, `totals.malformed_rows` is 1, all other rows are complete, and no malformed value appears unbounded or is used as a unit name without passing `validateSafePathSegment`.
- Given a profile path that is a symlink, a relative path, an absent path, or a path outside the declared profile root, when inventory runs, then the classification and bounded evidence are reported and no `realpath` target is substituted for the declared value.
- Given `--agent <known-id>`, when inventory runs, then exactly one row is emitted, the result is labelled scoped, and totals still report the full registered fleet size; given `--agent <unknown-id>`, then the envelope is `ok:false` with code `NOT_FOUND` and exit `3`.
- Given `--project-registry` and `--agent-registry` overrides, when inventory runs, then only the override files are read, `data.stores[].configured_path` still names the canonical path, and a content+mtime snapshot proves both the overrides and the canonical files are unwritten.
- Given any invocation, successful or failing, when it completes under isolated `HOME`/`XDG_*`, then a content+mtime snapshot of the scratch tree is unchanged.
- Given a clean checkout, when `npm run typecheck && npm run build && npm test` runs, then the new suite appears in `node scripts/run-tests.mjs --list`, it passes, and `npm run coverage:check` does not trip the floor.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 20: (high 2, medium 10, low 8)
- defer: 12: (high 0, medium 6, low 6)
- reject: 9: (high 0, medium 2, low 7)
- addressed_findings:
  - `[high]` `[patch]` A `agents.{agent_id}.project_path` conflict stamped the row's `repo_path` cell -- a different field, in a different store, under a different owner -- and on an uncorrelated row emitted `{value: null, state: "conflicted"}`, which the row's own value/state rule forbids. Removed the mapping; the group still reaches the row through `row.conflicts`. Pinned by a check that also asserts, across every row, that no cell is `conflicted` without a value.
  - `[high]` `[patch]` A registry whose `agents:` key was missing, mistyped, or not a mapping reported "Fleet inventory healthy · 0 of 0 rows" at exit 0 -- the whole fleet vanishing behind a typo, one level above the count that exists to prevent it. Added a `registry-collection-unreadable` finding, wired it into `health.collection_errors` and `health.healthy`.
  - `[medium]` `[patch]` `totals.source_rows` was `items.length` over the very array the row builder then walks, so the advertised `source_rows != emitted_rows` invariant was structurally unable to fire. Replaced with `countCollectionRows`, a separate parse reaching the node by a different route; verified by mutation (a broken reader now reports 28 vs 0, UNHEALTHY).
  - `[medium]` `[patch]` AC5's seventh conflict dimension, the derived unit name, had no entry in `DIMENSIONS`. Added `agents.{agent_id}.systemd.gateway_unit` -- the name systemd actually sees, and the only one two distinct agents can collide on -- and emitted `gateway_unit` on the row so the existing drift finding names a value the envelope shows.
  - `[medium]` `[patch]` `health.contract_violations` double-booked a malformed row: the `!startsWith("agent-row")` prefix match excluded `agent-row-malformed` but let `agent-id-not-a-string` and `agent-id-unsafe` through, so one bad row added one or two to a metric the exclusion exists to keep at zero. Replaced with an explicit `ROW_INTEGRITY_CODES` set.
  - `[medium]` `[patch]` Correlation keyed the index with `resolve(expandHome(repo_path))` but looked up with `resolve(project_path)` -- no `expandHome` -- so a `~/...` spelling could never correlate, and a relative value silently resolved against the caller's working directory. Made both sides symmetric and refused non-absolute values outright.
  - `[medium]` `[patch]` The control-character check injected escapes into `display_name` and `repo`, neither of which the human report renders (`display_name` is not even a row field), so it passed because the values were never emitted and would have stayed green with `bounded()` deleted. Now injects into rendered fields, proves they were rendered, and asserts the JSON surface too.
  - `[medium]` `[patch]` `seedHome()` copied the operator's live registries unguarded, so on any host without them the ENOENT escaped the harness and the whole suite reported FAIL rather than SKIP -- indistinguishable from a regression. Added a suite-level guard that skips loudly, keeping the derive-from-real discipline intact.
  - `[medium]` `[patch]` The `projects.{slug}.repo_path` dimension hashed `resolve(...)`, baking this host's `$HOME` into a group id the README promises is identical on every machine, while the agent-side path dimension deliberately hashes the home-redacted normalized value. Both now normalize the same way.
  - `[medium]` `[patch]` AC10 names both override flags but only `--agent-registry`'s store view was ever asserted; swapping the project store's configured/inspected fields would have told automation a scratch copy was canonical with nothing failing. Added the matching assertions.
  - `[medium]` `[patch]` Every failing case was asserted through `--json`; the human path an operator and `mise run fleet:inventory` actually take was unpinned, so a formatter fault there would fall through to the last-resort JSON at exit 6 with the suite green. Added human-path checks for both failure modes, following the sibling suite's own precedent.
  - `[medium]` `[patch]` AC4 was pinned only by asserting no field's `source` string matched /manifest/ -- which a manifest-derived VALUE passes too, since `source` always comes from the contract's authority index. Added two value-level cases: a manifest that contradicts the registries, and one that tries to fill a gap they left. The gap-fill case was mutation-verified.
  - `[low]` `[patch]` The README claimed a handed path is "classified with `lstat`, never followed", while `readManifest` opens `.project.json` through a symlinked `project_path`. Stated the guarantee that actually holds.
  - `[low]` `[patch]` The README's exit table omitted 4 and 5, which `collectFleetInventory` produces by rethrowing a contract diagnostic's own code. Documented both, and where the fix lives.
  - `[low]` `[patch]` The human failure report rendered code and message only, so the operator most likely to have fat-fingered a path was the one who could not see which path was tried. It now prints `error.details` through the same `sanitizeDetails` the JSON path uses.
  - `[low]` `[patch]` `health.unresolved_rows`, `contract_violations`, `permitted_conflicts` and `collection_errors` were computed, shipped in JSON, and never rendered -- so a terminal operator saw THAT the fleet was unhealthy and never why. The report now carries them on the line under the verdict, and names the "19 unresolved" this spec's Verification section expects.
  - `[low]` `[patch]` `manifest.notes` clipped with a bare `.slice(0, 10)` while every other cap in the module records what it dropped. Added a `manifest-notes-truncated` finding.
  - `[low]` `[patch]` The env-disagreement finding said "the TypeScript reader would use the default path" on the exact branch where `configured_path` is set to the fleet key -- one run asserting two different canonical files. The detail now names the file this run actually treated as configured.
  - `[low]` `[patch]` A contract fault produced `next_actions` telling the operator to fix a store path. Exit 4 and 5 now point at `pjangler fleet contract validate`.
  - `[low]` `[patch]` `let findings` is never reassigned; made it `const`.


## Design Notes

**Unhealthy is data, not a failure exit.** `validateFleetEnvelope` enforces `ok ⟺ error === null` **and** `ok ? data !== null : data === null` (`src/fleet/output.ts:303`). Reporting an unhealthy fleet as `ok:false` would therefore null out `data` on exactly the runs where the inventory matters most. So: a fleet with conflicts is `ok: true`, exit `0`, `data.health.healthy: false`. Only a *command* failure (unreadable registry, unknown `--agent`, bad flag) produces `ok:false` and a nonzero code. The human report must lead with the health verdict so this is not mistaken for "all clear".

**Where a managed exception is declared.** AC5's "matching managed-exception policy" reuses the existing `classifications.intentionally_unmanaged.entries` list rather than a new contract key: entries already require `id, kind, owner, source, lifecycle_state, rationale, policy_domains`, extra keys are accepted (`contract.ts:684-698`), and the class's own notes describe exactly this — state an operator decided to observe and leave alone. A new root key would edit `FLEET_CONTRACT_ROOT_KEYS`, bump `contract_version`, and re-open Story 1.1's surface. Shape:

```yaml
- id: candys-shared-board-identifier
  kind: identity-conflict-exception
  owner: project-registry
  source: agents.{agent_id}.plane.identifier
  lifecycle_state: accepted
  rationale: candystore and candybar intentionally share one Plane board.
  policy_domains: [identity, board]
  participants: [candystore-pm, candybar-pm]
```
A group matches an exception when the entry's `source` equals the group's field path **and** its `participants` set equals the group's participant set exactly — a superset must not silently absorb a new third claimant.

**Stable conflict group ids.** `conflict:{field-path}:{first 12 hex of sha256(normalized-value)}` — stable across runs and across machines, independent of row order, and identical for every participant. Normalize with NFC + trim before hashing; do not casefold the value into the id (a case-only collision is itself a finding, and folding it would merge two distinct groups).

**Do not ship this story's own exception entries.** The two live conflicts (`automatic-ai`, `CANDYS`) are real drift for an operator to rule on. Detecting them is the deliverable; declaring them permitted is not. The suite proves the exception mechanism with a scratch-registry case.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean, zero errors.
- `npm run build` -- expected: `dist/index.js` regenerated; a second build byte-identical.
- `node dist/index.js fleet inventory` -- expected: exit `0`; report names 28 source rows, 28 emitted, 19 unresolved, and the two live conflict groups.
- `node dist/index.js fleet inventory --json | cat` -- expected: one complete parseable envelope through a real pipe, `ok: true`, `data.totals.source_rows === 28`.
- `node -e '...'` independent count of `agents` keys in the configured registry -- expected: equals `data.totals.source_rows` above.
- `node dist/index.js fleet inventory --agent pjangler-pm --json` -- expected: exit `0`, one row, scoped label, totals still report 28.
- `node dist/index.js fleet inventory --agent nope; echo $?` -- expected: `3`, `NOT_FOUND`, no stack trace.
- `node dist/index.js fleet inventory --agent-registry /nonexistent.yaml; echo $?` -- expected: `3`, path home-redacted.
- `node tests/fleet-inventory-regressions.mjs` -- expected: all checks ok, exit `0`.
- `npm test` -- expected: no new failures beyond the two pre-existing ones recorded as DW-6; `node scripts/run-tests.mjs --list | grep fleet-inventory` shows the suite.
- `npm run test:coverage && node scripts/coverage-ratchet.mjs` -- expected: floor not tripped.
- `mise run fleet:inventory` -- expected: builds first, then inventories.
- `git status --porcelain` after every read-only run -- expected: empty (proves the command did not dirty the repo).

## Auto Run Result

Status: done
Blocking condition: none

### Summary of implemented change

Story 1.2 adds a read-only fleet inventory core (`src/fleet/inventory.ts`) and
exposes it as `pjangler fleet inventory [--agent <id>] [--project-registry
<path>] [--agent-registry <path>] [--json]`. It reads both canonical registries
plus each repository's `.project.json`, emits one row per raw Hermes agent entry
with per-field authoritative-source provenance drawn from the contract, groups
identity conflicts under stable ids, and reports independently counted totals.

Five blockers in the existing fleet module were changed rather than worked
around: `FLEET_COMMANDS` gained `fleet.inventory`; `validateFleetEnvelope`'s
hardcoded ten-key `data` check became a per-command map; `write()` now takes a
formatter thunk instead of a `FleetContractInspection`; `fleetParserFailureEnvelope`
derives the command id from its args; and `cappedStrings`/`boundedNotes` moved
from `cli.ts` to `output.ts`.

Against the live fleet the command reports 28 source rows, 28 emitted, 9
correlated / 19 uncorrelated, the two live conflict groups (`automatic-ai` under
`agents.{agent_id}.repo`, `CANDYS` under `agents.{agent_id}.plane.identifier`),
and the two symlinked profile directories a registered agent points at, which
violate the contract's `symlink_allowed: false`. No exception entry is shipped
for the live conflicts: detecting them is the deliverable, ruling on them is the
operator's.

This follow-up review pass then fixed twenty defects in that work. The two that
mattered most were both cases of the envelope asserting something untrue: a
`project_path` conflict stamped a DIFFERENT field's cell (`repo_path`, in the
other store, under the other owner) and could emit `{value: null, state:
"conflicted"}`; and a registry whose `agents:` key was missing or mistyped
reported "Fleet inventory healthy · 0 of 0 rows" at exit 0 -- the whole fleet
vanishing behind a typo. The module's advertised independent row count was also
a tautology (`items.length` over the array the row builder walks), AC5's
unit-name dimension was missing entirely, and the suite failed rather than
skipped on any machine without the operator's live registries.

### Files changed

- `src/fleet/inventory.ts` -- the read-only core: tolerant store reads with
  per-row salvage, an independent row count, contract-derived provenance, path
  classification, conflict grouping, exception matching. This pass added
  `countCollectionRows`, the unreadable-collection finding, the `gateway_unit`
  field and dimension, `ROW_INTEGRITY_CODES`, symmetric correlation, and
  host-independent project-path group ids.
- `src/fleet/types.ts` -- the inventory vocabulary beside the contract's; this
  pass added `FleetInventoryRow.gateway_unit` and `RawStore.collection`.
- `src/fleet/output.ts` -- `fleet.inventory` in `FLEET_COMMANDS`, the per-command
  required-data-key map, the promoted bound helpers, the inventory report; this
  pass added the health line under the verdict and the detail lines on the
  failure report.
- `src/fleet/cli.ts` -- generalized `write()`, args-derived parser-failure
  command id, the `inventory` subcommand and its guards; this pass made
  `next_actions` point at the contract for exit 4 and 5.
- `src/fleet/index.ts` -- barrel re-exports.
- `tests/fleet-inventory-regressions.mjs` -- the suite: every case a real built
  `dist/index.js` in a real subprocess, every registry case derived by mutating a
  copy of a real registry, every invocation bracketed by a content+mtime
  snapshot. This pass added nine checks and a host guard.
- `scripts/run-tests.mjs` -- registers the suite.
- `mise.toml` -- `fleet:inventory`, building first.
- `README.md` -- the command, its flags, the exit taxonomy (now including 4 and
  5), and the healthy/unhealthy/failed distinction.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- DW-1 records what
  story 1.2 closed and what it still owes.

### Review findings breakdown

- Patches applied: 20 (2 high, 10 medium, 8 low). Listed individually in the
  Review Triage Log above.
- Items deferred: 12, appended to this spec's `deferred` frontmatter. The ones
  worth an operator's attention first: two of the four live symlinked profile
  directories are reported by nothing because no registered row reaches them; a
  missing project registry aborts the run instead of degrading to 28 uncorrelated
  rows; and duplicate-key conflict groups name a single participant, itself.
- Items rejected: 9. Chiefly: `requireValue` not refusing single-dash values (the
  spec explicitly says mirror the `--contract` guards, which do the same); the
  DW-13/DW-14 ledger duplication (the orchestrator owns the ledger, and this run
  was told not to rewrite its entries); the spec/sprint-status status mismatch
  (orchestrator bookkeeping); and assorted defensive guards for states no live
  or plausible registry produces.

### Follow-up review recommendation

`true`. Patched findings by severity: high 2, medium 10, low 8. The high count
alone sets it; the score `3 x 10 + 1 x 8` is 38, well past 5. Twenty patches in
one pass on a 1300-line core is itself the argument for another look.

### Verification performed

- `npm run typecheck` -- clean.
- `npm run build` -- reproducible; a second build byte-identical to the first.
- `node dist/index.js fleet inventory` -- exit 0, `UNHEALTHY`, and the verdict
  line now reads `19 unresolved · 2 contract violations · 0 permitted ·
  0 unreadable stores`.
- `node dist/index.js fleet inventory --json | cat` -- one complete envelope
  through a real pipe; `source_rows` 28, `emitted_rows` 28, matching an
  independent `YAML.parse` count of the live `agents` keys.
- `--agent pjangler-pm` one row, scoped label, fleet-wide totals; `--agent nope`
  NOT_FOUND exit 3; `--agent-registry /nonexistent.yaml` NOT_FOUND exit 3 with
  the path shown and home-redacted on the human path; empty and option-shaped
  flag values INVALID_INPUT exit 2.
- `node tests/fleet-inventory-regressions.mjs` -- all checks green; and with
  `HERMES_AGENTS_REGISTRY` pointed at a nonexistent file it SKIPS loudly and
  exits 0, which is the behaviour the host guard was added for.
- `npm test` -- 62/64. The two failures are `pjan-23-regressions` and
  `pjan-67-trusted-lifecycle-regressions`, DW-6's pre-existing curl-stub defect,
  failing at its recorded signature and untouched by this diff.
- `npm run test:coverage && node scripts/coverage-ratchet.mjs` -- floor not
  tripped; lines rose 57.07 -> 58.20 percent.
- `mise run fleet:inventory` -- builds first, then inventories.
- `git status --porcelain` after every read-only run -- no repository dirt.
- Seven deliberate mutations were injected, rebuilt, and run against the suite.
  Six were caught by the check that claims to cover them: restoring the
  `project_path -> repo_path` stamp, dropping the unreadable-collection finding,
  dropping the gateway-unit dimension, restoring the prefix-match violation
  count, silencing the human error details, and letting a manifest fill a
  registry gap. The seventh -- reverting the row count to share the reader's
  array -- was NOT caught, and cannot be by a black-box suite; it was verified by
  hand instead (the reverted build reports `0 of 0` and healthy where the fixed
  build reports `0 of 28` and UNHEALTHY) and is recorded in the deferred list.

### Residual risks

- One review-introduced regression was caught by this suite mid-pass and fixed:
  reading the registry bytes before `readYamlDocument`'s existence guard turned a
  missing registry from NOT_FOUND/exit 3 into INTERNAL_ERROR/exit 6. It is worth
  recording that the failure was found by an existing check rather than by
  inspection.
- Twelve deferred items remain; six are medium. None blocks the command, and none
  is a wrong answer on the live fleet -- they are unreached surfaces, unexercised
  caps, and derived answers in a module whose rule is not to derive.
- Agent-namespace and profile-namespace provenance is still resolved by the modal
  fallback rather than by a declared owner (the two pre-existing deferred entries
  above). Declaring those namespaces is Story 1.1's surface, and this story's
  Block If forbids inventing an owner here.
