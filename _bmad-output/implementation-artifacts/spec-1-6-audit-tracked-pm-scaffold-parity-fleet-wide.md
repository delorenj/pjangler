---
title: 'Story 1.6: Audit Tracked PM Scaffold Parity Fleet-Wide'
type: 'feature'
created: '2026-09-02'
status: 'done'
baseline_revision: 'b6437998e7da61bc875f2c1ebac8e4e313337b54'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-5-make-partial-health-truthful-and-actionable.md'
  - '{project-root}/contracts/fleet-contract.yaml'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `pjangler fleet status` cannot say whether any deployed PM scaffold matches the canonical
template. The `template_scaffold` domain reads `unsupported`/`unobserved` for all 28 agents on a
default run, and the only comparison that exists (`hermes.pm-scaffold`, `src/parity/rules.ts:6005`)
reads DESIRED bytes from pjangler's own mutable submodule worktree, compares bytes only, ignores
`momo`, modes, types, symlinks and extra tracked files, and returns prose. Measured on this repo:
`hermes` and 11 scripts are stale, 6 owned assets are missing, and 13 generated/provisioning files
are tracked inside the role -- none of it visible to the fleet read model. Story 1.15's fanout
planner cannot be built on that.

**Approach:** Add a read-only scaffold observer to the fleet status core. Desired state comes from
the parent repository's committed gitlink for `templates/hermes-agent` and the bytes AT that commit
(git objects, never a worktree), filtered by a contract-declared manifest policy; each managed row's
role directory is resolved from the registry, compared asset-by-asset (blob digest, type, exec bit,
symlink target), and reported as one observation per contract-declared owned-asset group with typed
per-asset items and safe digests. Source integrity is a host finding that marks every agent
incomplete rather than a fallback. The repository rule shares the observer's pure comparison core.

## Boundaries & Constraints

**Always:**
- Read-only, byte-stable `data` across two runs over unchanged state; no timestamps, durations,
  realpaths, file bodies, diffs or credentials in any emitted value. Digests are 12-hex prefixes of
  git blob ids (`sha1("blob <len>\0" + bytes)`), never bodies.
- Desired bytes come from `git cat-file`/`ls-tree` at the COMMITTED gitlink (`git ls-tree HEAD
  templates/hermes-agent` in `resolvePjanglerRoot()`). The submodule worktree, `PJANGLER_HERMES_TEMPLATE`,
  `~/code/hermes-agent-template`, `gh:` and `PATH` are never consulted for desired state.
- Every observation is built through `observation(ctx, input)` (`src/fleet/status.ts:829`); every
  git read through `probe`/the new raw variant in `src/fleet/runtime.ts` with `--no-optional-locks`;
  every per-agent fan-out through `mapBounded` with `throwIfCancelled` and `remainingMs`.
- A `--domain X` run other than `template_scaffold` spawns zero scaffold probes; `--agent <id>` reads
  only that agent's role directory while `data.scope` keeps total/selected counts.
- Role directory comes from the registry row (`role_dir`), defaulting to `<project_path>/agents/hermes/<role>`
  only when the row is silent, and must be contained in `project_path` (realpath containment).
- Ignored runtime bytes (`runtime_dir`, git-ignored entries) and foreign tracked files are never
  compared, never emitted by path, never proposed for deletion. Unrelated WIP is counted, not named.
- Existing suites whose synthetic roles carry only `role.yaml` will now observe drift: fix the FIXTURE
  (render the pinned template's owned assets into the role, or give the fixture template a minimal
  `template/` tree), never weaken the observer or authorize the gap in the tracked contract.
- Ticket PJAN-108 is in every commit message; move it to In Progress before the first code change
  (`agents/hermes/pm/.scripts/providers/plane.sh list_issues` → uuid → `transition <uuid> started`,
  with `PLANE_API_KEY` set from `PLANE_33GOD_API_KEY`). If the board is unreachable, proceed and say so.

**Block If:**
- The committed template at `6bc683d` turns out to need Jinja control flow in a CONTENT-compared asset
  (today only `SOUL.md.jinja` and `role.yaml.jinja` do, and both are presence-only by policy).
- Sharing the comparison core would force a change to `pjangler migrate hermes.pm-scaffold` semantics
  beyond byte-exact comparison (the migrator is story 1.15's; this story must not touch it).

**Never:**
- No writes to any repository, profile, registry, submodule or `.git` (no `stash`, `reset`, `clean`,
  `checkout`, `submodule update`, `update-index`); no network; no `copier` subprocess; no `_tasks`.
- No fallback to "whatever renders": a broken source is `error` for every affected agent.
- No `boundedValue` over any new list (it slices at 100 with no clip record); no new `FleetErrorCode`
  for drift; no change to `statusFindingId`'s tuple, `FLEET_STATUS_STATE_PRECEDENCE`, `rollUp`'s
  `unsupported` step-aside, or `health.healthy`'s story-1.4 meaning.
- No per-asset observations (counts must stay per agent/group); no new CLI flag (`--domain
  template_scaffold` is the surface; `--domain scaffold` is not added as an alias).
- No edits to `templates/hermes-agent` (submodule) or to `dist/` by hand; no `GIT_GUARD_OFF`/`--no-verify`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Matching role | role bytes/modes equal the render at the recorded gitlink | 8 group observations `pass`, `items` absent, agent `scaffold.assets.drifted: 0`, counted `passing` | none |
| Stale verbatim script | `.scripts/_lib.sh` equals an OLDER template blob | `scaffold.scripts` `fail`, item `{path: ".scripts/_lib.sh", kind: "stale-content", desired: <12hex>, observed: <12hex>}` | none |
| Operator-edited asset | `hermes` content matches no template lineage (12 commits / object DB) | `scaffold.hermes` `fail`, item `kind: "locally-modified"` | none |
| Missing / mode / type / link | `momo` absent; `heartbeat.sh` 0644; `.scripts/lib` a file; `hermes` a symlink out of the repo | items `missing`, `wrong-mode`, `wrong-type`, `unsafe-symlink` respectively, each on its own group, paths role-relative | none |
| Tracked droppings | `.scripts/.done-70-systemd`, `.runtime-scaffold/.gitignore.jinja` tracked in the target repo | `unexpected-owned` items on their groups; never a delete proposal | none |
| Runtime + foreign + WIP | `runtime/` ignored; untracked `notes.md`; tracked `README.md` in the role; uncommitted edit to `hermes` | none of the three named; agent `scaffold.wip_preserved` ≥ 1, `foreign_tracked: 1`; `hermes` item carries `wip: true` and path appears in `wip_overlap`; worktree byte-identical after the run | none |
| Presence-only asset | `role.yaml` content differs, `SOUL.md` edited | both groups `pass` (type + mode only) | none |
| Missing render input | row lacks `display_name` | `scaffold.sentinel.prompt.md` `error`, item `kind: "incomplete", detail: "input-missing: display_name"`; other groups unaffected; agent counted `incomplete` | agent `complete: false` |
| Unsupported render | a content-compared `.jinja` contains `{%` or an undeclared `{{ name }}` | that group `error`, item `incomplete` with `render-unsupported` | never rendered "as best it can" |
| Dirty / mismatched / uninitialized / missing object / staged pin | tracked template file modified; worktree HEAD ≠ gitlink; empty submodule dir; gitlink sha absent from object DB; index gitlink ≠ HEAD gitlink | host finding `scaffold.source` `error` naming `source-dirty` / `source-mismatched` / `source-uninitialized` / `source-missing-object` / `gitlink-unstable`; every selected agent's 8 groups `error`; `data.scaffold.source.integrity` = the code; desired bytes still never taken from the worktree | agents `incomplete`, `verdict: unproven` at best |
| Contaminated source | tree at the gitlink under `template/` contains `__pycache__/x.pyc` | `source-contaminated`, same propagation | as above |
| Uncovered asset | a template path matches no `scaffold_manifest.groups` entry | `manifest-uncovered:<path>` integrity error | as above |
| Exception | `health_policy.agent_exceptions` names `(template_scaffold, <agent>)` | drifted groups carry `justification.kind: "exception"`, policy `health_policy.agent_exceptions[i]`, agent counted `exception_authorized`, member class `exception`, `health.healthy` unaffected (conflict-ruling precedent) | none |
| Rule disagreement (`--live`) | `hermes.pm-scaffold` says `pass` while the observer finds drift the rule covers (or vice versa) | finding `scaffold-rule-disagreement` (severity `error`, agent-scoped), `data.scaffold.rule_agreement.disagree` +1; states of both left as reported | never resolved silently |
| Scoping | `--domain registry`; `--agent alpha-pm` | zero probes of kind `scaffold`; only alpha's role dir read, `data.scaffold.agents.selected: 1`, `total_registered: N`, `unobserved: N-1` | none |
| Large payload | 300 stale scripts × several agents through a pipe | complete JSON > 64 KiB, items capped at 100 per observation with a `truncated` note `agents.<id>.observations[scaffold.scripts].items: N of M items dropped; retrieve …`; counts unchanged | none |
| Deadline | `--deadline-ms 1` | `TIMEOUT` failure envelope (exit 6), no partial write | existing taxonomy |
| Domain not selected | `--domain profile` | `data.scaffold: null`, every `agents[].scaffold: null`, key still present | none |

</intent-contract>

## Code Map

**Live evidence (2026-09-02, HEAD b643799):** `templates/hermes-agent` gitlink `6bc683d8…` == worktree
HEAD, worktree clean. Tree under `template/` = 51 files (30 `.scripts/**`, 7 `.runtime-scaffold/**`,
`hermes.jinja` 100755, `momo.jinja` 100755, `.gitignore.jinja`, `SOUL.md.jinja`, `role.yaml.jinja`,
`.scripts/sentinel.prompt.md.jinja`); no symlinks under `template/`; 0 tracked droppings; `copier.yml`
`_subdirectory: template`, `_templates_suffix: .jinja`, `_exclude: **/__pycache__, **/*.pyc, **/*.pyo`.
Placeholders in CONTENT-compared jinja: `hermes` `{{ agent_id }}`; `momo` `{{ role }} {{ target_repo }}`;
`.gitignore` `{{ role }}`; `sentinel.prompt.md` `{{ display_name }} {{ role }} {{ target_repo }}
{{ ticket_provider }}`; `.runtime-scaffold/.gitignore.jinja` none. `SOUL.md.jinja`/`role.yaml.jinja`
carry `{% if %}` and `strftime` → presence-only. Deployed `agents/hermes/pm`: 59 tracked, 24 executable,
12 tracked `.scripts/.done-*`/`.plane-project-id`, tracked `.runtime-scaffold/.gitignore.jinja`,
10 stale, 6 missing (incl. `momo`). Real registry: 28 rows, all with `project_path`, `role_dir`,
`display_name`, `repo`, `role`; project registry 26 projects, 22 `plane`, 2 `trello`.
`fleet status --domain template_scaffold --json` today: 59 observations, 28 `unsupported` + 28 `unobserved`,
`verdict: unproven`.

**New — pure comparison core, no fleet/parity imports (both sides depend on it):**
- `src/scaffold/compare.ts` — `renderTemplate(source, inputs)` (only `{{ name }}` with optional
  whitespace; any leftover `{{`/`{%`/`{#` or undeclared name → `{ok:false, reason:"render-unsupported"|"input-missing", detail}`),
  `blobId(bytes)`, `matchesExcluded(path, patterns)` (segment globs; trailing `/` = directory),
  `groupFor(path, groups)` (longest prefix), `compareAssets(desired[], readObserved, {presenceOnly})`
  → `ScaffoldAssetFinding[]` sorted by path, kinds `missing|stale-content|locally-modified|wrong-mode|
  wrong-type|unsafe-symlink|unexpected-owned|incomplete`. `stale-content` vs `locally-modified` is
  decided by a caller-supplied `inLineage(blobId, path)` predicate so the core stays git-free.
  Byte-exact: no CRLF normalization (the rule's `readText` normalizes today — `rules.ts:392`).

**New — the observer:**
- `src/fleet/scaffold.ts` — `collectScaffoldParity(ctx: FleetScaffoldContext)`. Phases: (1) source
  integrity in `pjanglerRoot`: `ls-tree HEAD -- templates/hermes-agent` and `ls-files --stage --
  templates/hermes-agent` (both 160000, equal → else `gitlink-missing`/`gitlink-unstable`);
  submodule `rev-parse --show-toplevel` with the realpath guard copied from `probeCheckout`
  (`provenance.ts:496-520`) → `source-uninitialized`; `cat-file -e <gitlink>^{commit}` →
  `source-missing-object`; `rev-parse HEAD` ≠ gitlink → `source-mismatched`; `status --porcelain
  --untracked-files=no` non-empty → `source-dirty` (untracked files are NOT dirt for this observer —
  DW-74's measured false dirt came from untracked files once `GIT_CONFIG_GLOBAL` is stripped);
  `ls-tree -r -z -- <gitlink> <template_subdirectory>` → manifest (strip `render_suffix`, record
  `100755` as executable, `120000` as symlink); any excluded match → `source-contaminated`; any path
  with no group → `manifest-uncovered:<path>`; empty tree → `source-empty`. (2) one raw
  `cat-file --batch` over stdin for the rendered sources and symlink targets (≤ 6 blobs). (3) per
  agent under `mapBounded(agents, FLEET_STATUS_SCAFFOLD_CONCURRENCY = 4)`: resolve role dir, `git
  --no-optional-locks -C <project_path> rev-parse --show-toplevel` containment, `ls-files -z --
  <roleDir>` (tracked set), `status --porcelain=v1 -z --ignored=matching --untracked-files=all --
  <roleDir>` (modified/untracked/ignored); `lstat`+read owned paths (bounded `SCAFFOLD_MAX_ASSET_BYTES
  = 4 MiB`, `SCAFFOLD_MAX_ROLE_ENTRIES = 5000`); compare; walk extras. (4) lineage, lazily and
  deduped across agents: verbatim → one raw `cat-file --batch-check` over stdin for every observed
  blob id that mismatched (`missing` lines = not in lineage); rendered → `log --format=%H -n 12
  <gitlink> -- <jinja>` + one `cat-file --batch` for `<commit>:<jinja>`, render per agent, compare
  blob ids (`SCAFFOLD_LINEAGE_DEPTH = 12`). Returns per-agent group results, extras counts, WIP
  overlap, source record, and `FleetProbeRecord`s of kind `scaffold`. Never constructs a
  `FleetStatusObservation`.
- `src/fleet/runtime.ts` — add `input?: string` (stdin, `stdio[0] = "pipe"`) and `raw?: true`
  (Buffers, no `setEncoding`, no `trim`) to `BoundedChildOptions` (`:274-379`; `setEncoding("utf8")`
  and `.trim()` at `:348`/`:364-367` would corrupt blobs); export `probeRaw(ctx, argv, cwd, input?)`
  beside `probe` (`:233`). Same budget, kill and overflow rules.

**Contract (`contracts/fleet-contract.yaml`, schema 2 → 3):**
- New optional root block `scaffold_manifest` (closed keys): `template_submodule: templates/hermes-agent`,
  `template_subdirectory: template`, `render_suffix: .jinja`, `render_inputs` (`agent_id:
  agents.{agent_id}`, `role: agents.{agent_id}.role`, `target_repo: agents.{agent_id}.repo`,
  `display_name: agents.{agent_id}.display_name`, `ticket_provider: projects.{slug}.ticket_provider.type`),
  `groups` (declared leaf → role-relative path: `scaffold.role.yaml: role.yaml`, `scaffold.SOUL.md:
  SOUL.md`, `scaffold.hermes: hermes`, `scaffold.momo: momo`, `scaffold.sentinel.prompt.md:
  .scripts/sentinel.prompt.md`, `scaffold.gitignore: .gitignore`, `scaffold.scripts: .scripts/`,
  `scaffold.runtime-scaffold: .runtime-scaffold/`), `presence_only` (`role.yaml`, `SOUL.md`, each
  with `reason`), `excluded_patterns` (`__pycache__/`, `*.pyc`, `*.pyo`, `*.log`, `.done-*`,
  `.last-run`, `.provision.log`, `.plane-project-id`, `.DS_Store`), `runtime_dir: runtime`. Every
  `groups` key must be in `authorities.tracked_role_scaffold.writable_fields` (`:156-164`); every
  `presence_only.path` must resolve to a group; `render_inputs` values must be `agents.{agent_id}` or a
  declared `agents.{agent_id}.*` / `projects.{slug}.*` writable field. This makes the eight `scaffold.*`
  leaves real (DW-10, DW-50).
- `health_policy.agent_exceptions: []` — entries `{domain, agent_id, reason, owner}`, `(domain,
  agent_id)` unique. Remove `deferred_capabilities[3]` (`template_scaffold` / `scaffold.template_ref`,
  `:396-402`): the observer answers it. `schema_version: 3`, `compatibility.max_schema_version: 3`,
  `contract_version: 1.2.0`. Update the header comment's field-root list note for `scaffold.*`.
- `src/fleet/types.ts` — `FLEET_CONTRACT_SCHEMA_VERSION` 3, `FLEET_SUPPORTED_SCHEMA_VERSIONS` `{min:1,
  max:3}` (`:19`), `FLEET_CONTRACT_ROOT_KEYS` + `scaffold_manifest` (`:37`), `FLEET_CONTRACT_OPTIONAL_ROOT_KEYS`
  + `scaffold_manifest` (`:46`), `FLEET_HEALTH_POLICY_KEYS` + `agent_exceptions` and
  `FLEET_HEALTH_POLICY_AGENT_EXCEPTION_KEYS` (`:54-59`), `FLEET_SCAFFOLD_MANIFEST_KEYS`, types
  `FleetScaffoldManifest`, `FleetStatusObservationItem`, `FleetStatusAgentScaffold`,
  `FleetScaffoldSummary`, `FLEET_SCAFFOLD_ITEM_KINDS`, `FLEET_SCAFFOLD_SOURCE_CODES`, caps
  `FLEET_STATUS_MAX_ITEMS = 100`, `FLEET_STATUS_SCAFFOLD_CONCURRENCY = 4` near `:839-858`;
  `FleetStatusObservation.items?` (`:1236-1298`), `FleetStatusAgent.scaffold: … | null` (`:1300`),
  `FleetStatus.scaffold: FleetScaffoldSummary | null` (`:1477`); `FleetProbeRecord.kind` gains `scaffold`.
- `src/fleet/contract.ts` — `validateScaffoldManifest` stage beside the six at `:215-252`;
  `validateHealthPolicy` (`:793-941`) gains the `agent_exceptions` arm; a schema-1/2 contract with no
  `scaffold_manifest` still loads (the observer then reports every selected agent's `template_scaffold`
  as `unsupported` with `capability: "scaffold.manifest"` — unjustified unless the contract says so).

**Status integration (`src/fleet/status.ts`):**
- `SOURCE_SCAFFOLD = "fleet-scaffold"` beside `:358-361`; `CAPABILITY_SCAFFOLD_MANIFEST` beside `:317`.
- Raw stores `:1596-1612`: add `roleDirByAgent` and `rowInputsByAgent` from the raw agent store
  (`repo`, `role`, `display_name`, `role_dir`); read the project raw store (`readProjectRegistryRaw`,
  already imported for freshness at `:1614-1631`) when `render_inputs` names a `projects.` field, and
  correlate by `project_path` then `repo` slug exactly as `inventory.ts:781-793` does.
- New phase after provenance (`:1725-1760`) and before the audit children: gated on
  `domainSet.has("template_scaffold")`, runs `collectScaffoldParity` over `selectedAgents`, pushes
  probe records, and keeps a `scaffoldByAgent` map. Source integrity becomes ONE host finding
  (`rule_id: "scaffold.source"`, `field: "scaffold"`, `source: SOURCE_SCAFFOLD`, `state: pass|error`)
  built the way `:2020-2060` builds an audit host finding; never an agent record.
- Per-agent loop (`:1888+`): after `observeFromProvenance`, emit the 8 group observations via
  `observation(ctx, …)`: `domain: "template_scaffold"`, `field: <group leaf>` (so `authority.ownerOf`
  resolves `hermes-agent-template` directly and `detectContradictions` cannot join them to the twelve
  recipe rules that all sit on field `scaffold` — DW-75), `ruleId: null`, `ruleScope: "project"`,
  `fixable: false`, `source: SOURCE_SCAFFOLD`, `observed`/`desired` = `"<matching>/<owned> assets match"` /
  `"every asset in <group> at gitlink <12hex>"`, `details` = bounded one-line-per-item summaries,
  `items` = the typed list (sorted, capped, truncation noted), `exceptionId`/`exceptionReason` from
  `health_policy.agent_exceptions` following the conflict-ruling precedent at `:918-975`.
  Drop `template_scaffold` from the per-agent "no scaffold fact" placeholder loop at `:1183-1194`
  (keep `release_provenance`), or every agent gains an `unobserved` beside real observations.
- Rule agreement under `--live`: where `auditByAgent` carries a `hermes.pm-scaffold` result, compute
  the observer's verdict over the RULE-COVERED subset (assets in `hermes`, `.gitignore`, `.scripts/**`,
  presence of `role.yaml`/`SOUL.md`/`.runtime-scaffold/README.md`; kinds `missing|stale-content|
  locally-modified`) and add finding `scaffold-rule-disagreement` when the rule's `pass`/`fail`
  differs; `skip` is `not_compared`.
- `data.scaffold` summary (`source`, `agents{total_registered, selected, applicable, passing, drifted,
  incomplete, exception_authorized, unobserved}`, `rule_agreement{compared, agree, disagree,
  not_compared}`) counted over EVERY selected agent before any cap (`:1855-1867`); `agents[].scaffold`
  summary (`source_gitlink`, `role_dir` via `shownPath`, `role_dir_source: "registry"|"default"`,
  `assets{owned, compared, matching, drifted, incomplete, unexpected_owned}`, `wip_overlap[]` ≤ 20,
  `wip_preserved`, `foreign_tracked`, `ignored_entries`). `unobserved = total_registered − selected`
  plus selected agents whose observation never ran.
- `FLEET_COMMAND_DATA_KEYS["fleet.status"]` (`src/fleet/output.ts:91-94`) gains `"scaffold"`.

**Provenance (`src/fleet/provenance.ts`):** delete the `scaffold.template_ref` `unsupported` fact
(`addUnsupportedFacts` `:883-900`); keep `template.gitlink`/`remote_url`/`worktree_clean` (`:683-732`)
untouched. Update the doc comment at `:871-882`.

**Output (`src/fleet/output.ts`):** `observationLines` (`:899-944`) prints up to 5 items as
`kind path desired→observed`; `agentLine` (`:946-966`) gains a scaffold cell (`scaffold 47/51 · 3 drifted
· gitlink 6bc683d8a265`); Domains section (`:1044-1045`) prints the `data.scaffold.agents` counts and
source integrity for `template_scaffold`. Use `bounded`/`redactHome`; no `boundedValue`.

**Rule (`src/parity/rules.ts:6004-6053`, audit only):** build `desired` from the worktree via fs
(unchanged source, unchanged asset set: verbatim `.scripts/**` minus pycache, rendered `hermes`,
`.gitignore`, `.scripts/sentinel.prompt.md` with inputs from `role.yaml` as `renderSentinelPrompt`
does at `:2820`, presence `role.yaml`/`SOUL.md`/`.runtime-scaffold/README.md`), call `compareAssets`
from `src/scaffold/compare.ts`, map findings to `details` `"<agentId>: <kind> <path>"`. Keep the
non-core checks (`runtime/memories/MEMORY.md`, `.gitmodules` runtime mapping, profile inherit,
registry entry) and `migrate` (`:6101-6144`) as they are. `mcp-server.ts:248-251` still holds: the
rule stays filesystem-only. `renderHermesWrapper`/`renderSentinelPrompt` become thin wrappers over
`renderTemplate` or are removed if unused.

**Index/MCP/CLI:** `src/fleet/index.ts` — new `scaffold` export block between health (`:64-91`) and
status (`:93-107`); new `types.ts` symbols into the types block (`:139-276`). `src/fleet/mcp.ts` —
no schema change (`domain` already a plain string, `:289`); parity is by construction through
`collectFleetStatus`. `src/fleet/cli.ts` — no flag change; `--domain` help text already lists
`template_scaffold` (`:503`).

**Tests:**
- NEW `tests/fleet-scaffold-regressions.mjs` — host-independent end to end. Copy `git`/`GIT_IDENTITY`/
  `isolation`/`cli`/`snapshotIsolated`/`snapshotTree`/`snapshotShared`+`FOREIGN_SCRATCH`/`envelope`/
  `status`/`skipCase` from `tests/fleet-status-regressions.mjs` (`:153,155,313,433,381,345,389-431,455,473,110`);
  `makePackageRoot`+`cliAt`+`contractDocument`/`writeContract`/`policyContract` from
  `tests/fleet-health-regressions.mjs` (`:151-190, 421-438, 531-563`); `update-index --add --cacheinfo
  160000,<sha>,templates/hermes-agent` from `tests/submodule-contract-regressions.mjs:79-80` for
  mismatched/uninitialized pins. Synthetic template repo with ≥ 3 commits (so stale ≠ locally-modified
  is a DELTA), expected rendered bytes written as LITERAL strings in the test, a role dir with a space
  (`agents/hermes/p m`), one agent per matrix row above, a >64 KiB pipe case, two-run byte identity,
  `SECRET_SENTINEL` planted in a drifted file and asserted absent from stdout, zero-write snapshots of
  temp + package root + `git status` before/after, `PJ_FLEET_CLI_ENTRY` shim narrowing the audit child
  for the rule-agreement case, contract negatives for `scaffold_manifest`/`agent_exceptions`, the
  runner/README/mise/ledger registration cases (`fleet-status-regressions.mjs:1549-1572`), and ONE
  live-gated AC10 case: on the real fleet, `--domain template_scaffold --agent pjangler-pm --json`,
  then independently `git ls-tree HEAD templates/hermes-agent` + `git show <gitlink>:template/.scripts/_lib.sh`
  blob id vs `agents/hermes/pm/.scripts/_lib.sh` blob id, and assert the observer's item for that path
  agrees (`stale-content`/`locally-modified` iff different, absent iff equal).
- `tests/fleet-status-regressions.mjs` — `makeRepo` (`:163`) renders the PINNED template into the
  role (read via `git show <gitlink>:…` with `encoding: "buffer"`, `.jinja` stripped, the five simple
  substitutions, presence files as-is) so the eight synthetic agents stay scaffold-clean; add a case
  pinning `--domain registry` spawns zero `scaffold` probes.
- `tests/fleet-health-regressions.mjs` — `makePackageRoot` (`:166-171`) gives the fixture submodule a
  `template/role.yaml.jinja`; `cleanRoot` must stay `proven: true` (`:742`); add a delta case: an
  `agent_exceptions` entry flips a drifted agent to `exception`.
- `tests/fleet-provenance-regressions.mjs:971,987` — drop `scaffold.template_ref` from the unsupported
  list. `tests/fleet-contract-regressions.mjs` — schema 3 loads, schema-2 (no manifest) still loads;
  negatives. `tests/mcp-server-regressions.mjs` — parity for `domain: "template_scaffold"` includes
  `data.scaffold`. `scripts/run-tests.mjs` `SUITES` (`:58-125`) — add at `:108`.
- Hazards already learned: `GIT_CEILING_DIRECTORIES` (`pjan-86:36-51`), `git(ROOT, ["update-index",
  "--refresh"])` once before measuring (`fleet-status:627`), shims outside the snapshotted tree
  (`:78-88`), no `/home/<name>` literal (`portable-test-paths-regressions.mjs:8`), payloads > 65 536 B
  for pipe cases, `maxBuffer` explicit, delta not absolute.

**Docs/ledger:** `README.md:278` row + a `### Scaffold parity` subsection inside `## Fleet status`
(`:248-566`, the slice `fleet-status-regressions.mjs:1558` asserts); `mise.toml:59-74` comment;
`CHANGELOG.md` `## [Unreleased]` `### Added` `feat(PJAN-108)` bullet; `deferred-work.md`: next free
number is **DW-87** (DW-81 is used twice — verify before claiming); annotate DW-10 and DW-50 (leaves
now declared and observed), DW-63 (1.6 half closed), DW-53 (the observer reads the project store for
`ticket_provider`), DW-74 (observer's dirt definition), DW-67 (domain now has real observations).

## Tasks & Acceptance

**Execution:**
- `src/scaffold/compare.ts` -- create the pure core (`renderTemplate`, `blobId`, `matchesExcluded`, `groupFor`, `compareAssets`) with unit-level behaviour pinned by the new suite -- one comparison for the rule and the observer
- `src/fleet/runtime.ts` -- add `input`/`raw` to `runBoundedChild` and export `probeRaw` -- `cat-file --batch` needs stdin and untrimmed bytes
- `contracts/fleet-contract.yaml` -- schema 3: `scaffold_manifest`, `health_policy.agent_exceptions`, remove the `scaffold.template_ref` deferral, bump versions -- the manifest policy the story requires
- `src/fleet/types.ts` -- grammar constants, caps, new types, `items`/`scaffold` fields -- one vocabulary for both adapters
- `src/fleet/contract.ts` -- `validateScaffoldManifest` + `agent_exceptions` validation, schema range -- policy that matches nothing must fail to load
- `src/fleet/scaffold.ts` -- the observer (integrity, manifest, per-agent compare, extras, lineage, probes) -- greenfield
- `src/fleet/provenance.ts` -- delete the `scaffold.template_ref` unsupported fact -- the observer answers it
- `src/fleet/health.ts` -- `resolveJustification` learns `health_policy.agent_exceptions` (policy path from the entry, not the `intentionally_unmanaged` literal at `:293`) -- exceptions must be reachable
- `src/fleet/status.ts` -- raw role/inputs maps, scaffold phase, group observations, host source finding, rule agreement, `data.scaffold`, agent summaries, placeholder loop fix -- the integration
- `src/fleet/output.ts` -- data key, items in observation lines, scaffold cell, domain summary -- the human surface
- `src/fleet/index.ts` -- export blocks -- typed callers
- `src/parity/rules.ts` -- `hermes.pm-scaffold` audit over `compareAssets`, same asset set, same source -- AC7
- `tests/fleet-scaffold-regressions.mjs` -- the new suite (matrix rows, integrity classes, scoping, caps, zero writes, secrets, MCP parity, registration, live AC10 sample) -- proof
- `tests/fleet-status-regressions.mjs`, `tests/fleet-health-regressions.mjs`, `tests/fleet-provenance-regressions.mjs`, `tests/fleet-contract-regressions.mjs`, `tests/mcp-server-regressions.mjs` -- fixture scaffolds, deferral removal, schema 3, exception delta, parity -- keep the existing truth tables green for the right reasons
- `scripts/run-tests.mjs` -- register the suite -- a suite is invisible until listed
- `README.md`, `mise.toml`, `CHANGELOG.md`, `_bmad-output/implementation-artifacts/deferred-work.md` -- docs and ledger -- parity checks assert them

**Acceptance Criteria:**
- Given the recorded gitlink and a template worktree checked out at a DIFFERENT commit with an extra modified file, when `fleet status --domain template_scaffold --json` runs, then `data.host` carries `scaffold.source` `error` with `source-mismatched` (and `source-dirty` once the worktree HEAD matches again), every selected agent's eight groups read `error`, and no agent item carries a digest derived from the worktree bytes.
- Given a managed row whose `role_dir` is `<repo>/agents/hermes/p m`, when parity runs, then that directory is compared, `agents[].scaffold.role_dir_source` is `registry`, and a row without `role_dir` resolves `<project_path>/agents/hermes/<role>` with `role_dir_source: default`.
- Given one agent per drift class, when the run completes, then each class appears as exactly one `items[]` entry with a role-relative path, `desired`/`observed` 12-hex digests or type/mode words, and stdout contains no file body, no planted secret and no absolute path.
- Given ignored runtime state, untracked notes, a foreign tracked file and an uncommitted edit to `hermes`, when parity runs, then the worktree and `git status` are byte-identical before and after, only the `hermes` overlap is named, and `wip_preserved`/`foreign_tracked`/`ignored_entries` are counted but unnamed.
- Given `--live` and a `hermes.pm-scaffold` result that disagrees with the observer over a rule-covered asset, when findings are produced, then `scaffold-rule-disagreement` is present, both readings stand, and when the template worktree is the cause the `scaffold.source` integrity error is present as well.
- Given the same fleet run twice and through the MCP tool, when `data` is compared, then it is byte-identical and `data.scaffold` plus every `agents[].scaffold` is present in all three.
- Given `--agent alpha-pm` on a five-agent registry, when the run completes, then `data.probes` shows scaffold probes only for alpha's repository, `data.scaffold.agents` reads `total_registered: 5, selected: 1, unobserved: 4`, and `--domain registry` shows zero probes of kind `scaffold`.
- Given the live fleet, when the story is closed, then `pjangler fleet status --domain template_scaffold --json` reports 28 applicable agents with pinned source `6bc683d8…` (or the then-current gitlink) and the pjangler agent's `.scripts/_lib.sh` item agrees with an independent `git show` blob-id comparison recorded in the Auto Run Result.

## Spec Change Log

## Review Triage Log

## Design Notes

**Why the gitlink's OBJECTS and not its worktree.** Every existing desired-state read
(`rules.ts:6015`, `preflight.ts:505`, `RunCopierTemplate.ts:231-238`) reads a mutable checkout, and the
last one falls back to a sibling clone and a branch tip. Reading `ls-tree`/`cat-file` at the committed
gitlink makes "newer bytes from a dirty worktree" structurally unreachable, makes pycache contamination
impossible (nothing untracked exists in a tree), and gives one digest notion for free: the blob id git
already computed. Dirty/mismatched worktrees are still reported as integrity ERRORS because the story
says so and because they are the operator's signal that the checkout is not canonical — but they never
change a desired byte.

**Eight observations per agent, on the eight declared leaves.** One observation per agent would need a
second "coverage" observation to keep `complete` honest when drift and an incomplete asset coexist;
one observation per asset would make `by_state` count files, not agents. The contract already names
exactly eight `scaffold.*` writable leaves; mapping each to a role-relative path makes them real
(DW-10), gives `authority.ownerOf` a declared answer (DW-50), and — because the twelve recipe rules in
this domain all sit on field `scaffold` — keeps `detectContradictions` from manufacturing DW-75 false
positives against the new source. Rule agreement is therefore an explicit check, not an accident.

**Stale vs locally modified is lineage, not commit state.** `stale-content` = the observed blob exists
in the template's history (verbatim: object-DB membership; rendered: equals the render of one of the
last 12 versions of the jinja source). `locally-modified` = it does not. Uncommitted edits are an
orthogonal `wip` flag. This is the exact input story 1.15 needs to choose overwrite vs block.

**Presence-only is policy, not a shortcut.** `role.yaml.jinja` embeds `strftime` and is rewritten by the
runtime; `SOUL.md` is the operator's persona and the fanout writes it only when absent. Both are
declared in `scaffold_manifest.presence_only` with reasons, compared for type and mode, and any OTHER
control-flow template is `incomplete`, never "rendered as best we can".

**Exceptions ride the existing axis.** `health_policy.agent_exceptions` is validated like the other
four lists and resolved in `resolveJustification` as `kind: "exception"` with the entry's own policy
path; member class, `proven` and `healthy` behave exactly as for a permitted conflict. Ships empty,
reachable by a delta case.

```yaml
scaffold_manifest:
  groups:
    scaffold.scripts: .scripts/
    scaffold.sentinel.prompt.md: .scripts/sentinel.prompt.md   # longest prefix wins
  presence_only:
    - { path: role.yaml, reason: rendered with strftime and rewritten by deployment state }
```

## Verification

**Commands:**
- `npm run typecheck && npm run build` -- expected: clean
- `node tests/fleet-scaffold-regressions.mjs` -- expected: every case ok, at most the live AC10 case skipped on a host without the real registries
- `npm test` -- expected: all suites green, including the four amended fleet suites and mcp-server
- `node dist/index.js fleet status --domain template_scaffold --json > /tmp/a.json; node dist/index.js fleet status --domain template_scaffold --json > /tmp/b.json; cmp <(jq .data /tmp/a.json) <(jq .data /tmp/b.json)` -- expected: identical; `git status --porcelain` empty before and after
- `node dist/index.js fleet status --domain template_scaffold --agent pjangler-pm --json | jq '.data.agents[0].scaffold, .data.scaffold'` -- expected: pinned source equals `git ls-tree HEAD templates/hermes-agent`, drift matches an independent `git show` blob-id check on one asset
- `node dist/index.js fleet status --domain registry --json | jq '[.data.probes[] | select(.kind=="scaffold")] | length'` -- expected: 0
- `git unpushed` -- expected: clean before reporting done

**Manual checks (if no CLI):**
- Two consecutive live runs: no timestamp, age, realpath, credential or file body in `data`; every item path is role-relative.

## Auto Run Result

Status: done
Blocking condition: none

### Summary of implemented change

`pjangler fleet status` now compares every managed role directory against the
tracked template at the gitlink this repository has COMMITTED for
`templates/hermes-agent`, asset by asset, from git objects and never from a
worktree. A new pure core (`src/scaffold/compare.ts`) is shared by the fleet
observer (`src/fleet/scaffold.ts`) and the `hermes.pm-scaffold` recipe rule,
so both sides mean the same thing by "the same bytes": a git blob id. Each
agent gets eight observations, one per declared `scaffold.*` leaf, with typed
per-asset `items` whose paths are role-relative and whose digests are 12-hex
blob-id prefixes. `stale-content` is decided by lineage (object-database
membership for verbatim assets, the last twelve renders of the Jinja source for
rendered ones); an uncommitted edit is an orthogonal `wip` flag; ignored
runtime, foreign tracked files and unrelated WIP are counted, never named.
Source integrity is one host finding (`scaffold.source`) that marks every
selected agent's groups `error` rather than a fallback. The tracked contract is
schema 3 with a `scaffold_manifest` block and `health_policy.agent_exceptions`;
the `scaffold.template_ref` deferral and provenance fact are deleted.

### Files changed

- `src/scaffold/compare.ts` -- NEW, the pure comparison core.
- `src/fleet/scaffold.ts` -- NEW, the observer: source integrity, manifest, per-agent scans, batched lineage, probe records.
- `src/fleet/runtime.ts` -- `probeRaw`, stdin `input`, raw byte accumulation (fixes the DW-59 byte count in passing).
- `src/fleet/types.ts`, `src/fleet/contract.ts`, `src/fleet/health.ts`, `src/fleet/status.ts`, `src/fleet/output.ts`, `src/fleet/index.ts`, `src/fleet/provenance.ts`, `src/parity/rules.ts`.
- `contracts/fleet-contract.yaml` -- schema 3, contract 1.2.0.
- `tests/fleet-scaffold-regressions.mjs` -- NEW; `tests/fleet-status-regressions.mjs`, `tests/fleet-health-regressions.mjs`, `tests/fleet-provenance-regressions.mjs`, `tests/fleet-contract-regressions.mjs`, `tests/mcp-server-regressions.mjs`, `scripts/run-tests.mjs`.
- `README.md`, `mise.toml`, `CHANGELOG.md`, `deferred-work.md` (DW-10/50/53/63/67/74 annotated; DW-87, DW-88, DW-89 added).

### Verification performed

- `npm run typecheck && npm run build` -- clean.
- `npm test` -- 68/68 suites, 375 s. The new suite runs 26 cases, none skipped on this host.
- Two consecutive live runs of `fleet status --domain template_scaffold --json`: `data` byte-identical (723 626 B); `git status --porcelain` unchanged before and after in this repository and in the submodule.
- `fleet status --domain registry --json`: zero probes of kind `scaffold`.
- No ISO timestamp and no `/home/<user>` string anywhere in the live payload.
- **AC8, independently recorded:** committed gitlink `6bc683d8a265dba96404a45154da283fc289ff3e` (`git ls-tree HEAD templates/hermes-agent`). `git -C templates/hermes-agent rev-parse 6bc683d8:template/.scripts/_lib.sh` = `c185251070a7…`; `git hash-object agents/hermes/pm/.scripts/_lib.sh` = `f1cc30bf9b52…`; the observer's item for `.scripts/_lib.sh` on `pjangler-pm` is `stale-content c185251070a7 -> f1cc30bf9b52`, and `git cat-file -e f1cc30bf…` succeeds in the template's object database, so stale (not locally-modified) is the correct reading. The live suite case re-checks this on every run.
- Live fleet: 28 applicable agents, source `ok` at `6bc683d8a265`, 52 owned assets per role. Per agent on this repository's row: 31 matching, 21 drifted, 13 tracked droppings (`.scripts/.done-*`, `.plane-project-id`, an unrendered `.runtime-scaffold/.gitignore.jinja`), `hermes` correctly read as an older render (stale-content), the sentinel prompt as locally-modified (its paragraph wrapping matches none of the five template renders -- verified by hand).

### Live readings that are fleet facts, not observer defects

- 15 agents carry `scaffold.sentinel.prompt.md: error, input-missing: ticket_provider`: their correlated project record (or the absence of one) supplies no `projects.{slug}.ticket_provider.type`, and the manifest declares no fallback on purpose.
- 3 agents read `repository-unreadable:not-a-repository`: `automatic-ai-pm`'s `project_path` does not exist; `condaleeza` and `delodocs-pm` name a `project_path` that is not a git repository.
- `delonet-company-reporter` reads `role-dir-outside-project`: its registry `role_dir` is not inside its `project_path`.

### Residual risks

- DW-88: while the template source is broken, no `scaffold-rule-disagreement` can be raised (the observer has no verdict to hold the rule against); the integrity error is present and the agent is `not_compared`.
- DW-87: the recipe rule's audit is byte-exact but its migrate still folds CRLF on write; every template asset today is LF.
- DW-89: the `role-entries-exceeded` and `lineage-unobserved` branches are not driven by a case; both fail safe (incomplete, never a pass).
- `unexpected-owned` covers any tracked file under `.scripts/` or `.runtime-scaffold/`, including a script an operator added deliberately; the contract says the template owns every tracked asset in those groups, so this is by declaration, and a ruling for one agent lives in `health_policy.agent_exceptions`.
