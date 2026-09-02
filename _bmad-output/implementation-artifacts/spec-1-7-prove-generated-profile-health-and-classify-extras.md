---
title: 'Story 1.7: Prove Generated Profile Health and Classify Extras'
type: 'feature'
created: '2026-09-02'
status: 'done'
baseline_revision: 'c93503709badcd13a9f0ec14174101f15cfa3620'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-6-audit-tracked-pm-scaffold-parity-fleet-wide.md'
  - '{project-root}/contracts/fleet-contract.yaml'
warnings: ['oversized']
deferred:
  - summary: >-
      resolveProfileLayout takes HERMES_FLEET_HOME verbatim, so a `~`-prefixed or relative value resolves against the process cwd and every profile reads root-missing.
    evidence: |-
      Pre-existing in src/fleet/inventory.ts (story 1.2). The story-1.7 observer now resolves the fleet home through that same function (review patch 20), so the two adapters can no longer disagree, but neither expands `~`. Surfaced by the edge-case review; the live fleet.env carries an absolute path, so the live fleet is unaffected.
    location: >-
      src/fleet/inventory.ts (resolveProfileLayout)
    severity: low
---

<intent-contract>

## Intent

**Problem:** `pjangler fleet status --domain profile` proves almost nothing today: the only observation is the
inventory's `lstat` of the profile directory, generated-config health is a declared deferral
(`profile.render_generation`), nothing validates `profile.yaml`, the Hindsight bank pin, or the canonical skill
core against the registry, and the profile root's unregistered entries (live: one `.bak` directory, four
symlinks, a case-variant and an underscore-variant of registered names, five standalone directories) are
reported by nothing (DW-25, DW-28). Every mutation story from 1.14 onward needs this read model first.

**Approach:** Add a read-only profile observer (`src/fleet/profile.ts`, modeled on the story-1.6 scaffold
observer) that, for every selected registered agent, gates the profile path (real directory, contained,
unambiguous), then reports five observations on the `profile` domain -- path, identity file, generated config
via the canonical renderer's `check` invoked at bytes proven identical to the committed gitlink, Hindsight bank
identity, skill-core membership -- plus, in fleet scope only, one host finding that classifies every extra
profile-root entry into the five contract classes with bounded safe evidence and guidance. Policy lives in a new
`profile_manifest` contract block; the `profile.render_generation` deferral is answered and removed.

## Boundaries & Constraints

**Always:**
- Ticket `PJAN-109`; every commit message references it. Work lands on `main`.
- Read-only. Bounded child processes only through `runBoundedChild`/`probe` with a narrow allowlisted env; every
  file read is capped (`PROFILE_MAX_FILE_BYTES` = 1 MiB) and `lstat`ed first; symlinks are classified, never
  followed into role/runtime state; the profile root is enumerated once, bounded (`PROFILE_MAX_ROOT_ENTRIES`).
- The canonical renderer is `templates/hermes-agent/scripts/hermes-profile-config.py` with its lock helper
  `template/.scripts/lib/profile-config-lock.py`, executed from the submodule worktree ONLY after both files'
  blob ids equal the blobs at the gitlink the parent repository has COMMITTED; otherwise `profile.renderer` is
  an `error` host finding and no renderer is spawned. Invocation is exactly `python3 -B <script> check --profile
  <name>` per gate-passing registered profile, `cwd` = the submodule, env limited to `PATH HOME LANG
  HERMES_FLEET_HOME HERMES_PROFILE_CONFIG_LOCK_TIMEOUT_SECONDS PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0
  PYTHONIOENCODING=utf-8`, under `mapBounded(…, FLEET_STATUS_PROFILE_CONCURRENCY = 4)` and the run deadline.
- Every observation carries `source: "fleet-profile"`, `evidence: direct`, `ruleScope: "project"`,
  `fixable: false`, a field under `profiles.{profile_name}` (never `agents.{agent_id}.profile_name`, which
  `detectContradictions` joins against the inventory's own observation), and typed `items[]` with role-safe
  paths, kinds from `FLEET_PROFILE_ITEM_KINDS`, 12-hex digests or identifier words -- never a file body, a
  config value, a delta value, a memory, or an absolute path.
- `data` is byte-identical across two runs over unchanged state: no timestamps, no ages, no counts that depend
  on the observer's own earlier runs (renderer lock files matching `extras.ignored_patterns` are skipped and
  NOT counted).
- Counts in `data.profile` are taken over every selected agent before any cap; `agents[].profile` is present on
  every emitted record when the domain is selected.
- Agent scope (`--agent`) inspects only that registered profile and labels `data.profile.extras.coverage:
  "not-swept"`; only fleet scope sweeps the root and emits `profile.extras`.
- The renderer's `check` takes the renderer's OWN per-profile lock (`profiles/.{profile_name}.config.lock`,
  `O_CREAT`, persistent, zero bytes). That is the canonical read semantics, not a mutation lock; document it
  in README and pre-create the lock files in every fixture so zero-write snapshots stay exact.
- Tests use isolated `HOME`/`XDG`/`HERMES_FLEET_HOME`/registries/package roots exactly as
  `tests/fleet-scaffold-regressions.mjs` does; the fixture submodule carries the REAL renderer and lock-helper
  bytes read from this repository's committed gitlink, so the suite exercises the canonical check, never a fake.

**Block If:**
- The committed gitlink for `templates/hermes-agent` no longer contains `scripts/hermes-profile-config.py` with a
  `check` subcommand whose stdout begins `OK:` or `PROFILE CONFIG DRIFT:` (verified at `6bc683d8…`, lines
  435-461). A changed renderer contract needs a human decision, not a guessed parser.

**Never:**
- Never run `init`, `render`, `absorb`, `memory-pin`, `status`, `check --all`, `profile-config-seed.py`, or any
  renderer path from a sibling checkout (`profileRendererPath`, `src/parity/rules.ts:3710-3722`, is the WRONG
  locator for this observer). Never write, rename, unlink, symlink, merge, adopt, stop, or "repair" anything.
- Never read Hindsight memory contents, call the Hindsight API, `systemctl`, `ps`, `/proc`, or the network.
  Live-process attribution (1.9) and unit STATE (1.8) stay deferred; unit FILE references are bounded text reads.
- Never emit renderer stdout verbatim, a delta value, a `profile.yaml` value other than identity keys, a
  `SKILL.md` body, a link target outside `shownPath`, or more than `FLEET_STATUS_MAX_ITEMS` items.
- Never treat a `profile.yaml` `config:` block (`inherit_from: default`, `save_mode: delta`) as inheritance --
  Hermes reads it nowhere (`hermes_cli/profiles.py:878-902`); inheritance is proven only by the renderer check.
- Never let a generic `bank_id_template` satisfy the pin, and never accept `custom`/`hermes` as an identity.
- Never let a dangling, foreign (realpath outside the canonical skills dir, the fleet home, or the profile), or
  byte-different core skill satisfy required membership.
- Never change `FLEET_STATUS_DOMAINS`, add CLI flags, touch `sprint-status.yaml`, or implement systemd/process/
  Bloodbank-liveness observers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clean registered profile | real dir, identity-only `profile.yaml`, `config.delta.yaml` `{}`, generated `config.yaml` == merge, pin `agent-<name>`, six core skills resolve | five `pass` observations; `agents[].profile.renderer.state: "in-sync"`; digests recorded | No error expected |
| Symlinked / missing / file / escaped / case-colliding profile | `profiles/<name>` is a symlink, absent, a regular file, name fails `isSafePathSegment` or `^[a-z0-9][a-z0-9_-]{0,63}$`, or another root entry equals it case-insensitively | `profiles.{profile_name}` `fail` with code (`symlink`,`missing`,`not-a-directory`,`name-unsafe`,`case-collision:<other>`); the other four fields `unobserved` naming the gate code; nothing beneath is read; no renderer spawn | `fail`, not `error` |
| Profile root itself under a symlink | `~/.hermes` or `~/.hermes/profiles` is a symlink (DW-28) | host finding `profile.root` `error`; every selected agent's five fields `error` | `error` |
| Base changed, profile not re-rendered | base `config.yaml` edited after render | renderer `drifted`, items `semantic-drift` per top-level section (≤ 6, `^[A-Za-z0-9_.-]{1,64}$` else `unparsed`); `profiles.{profile_name}.config.yaml` `fail` even when `hermes.runtime-singleton` passes | No error expected |
| Generated `config.yaml` symlinked / marker missing / delta missing | legacy topology | items `generated-symlink` / `marker-missing` / `delta-missing`; state `fail`; renderer still invoked only when both files are regular | No error expected |
| Renderer worktree bytes ≠ gitlink | submodule copy edited or submodule uninitialized | host finding `profile.renderer` `error` (`renderer-source-mismatched` / `renderer-source-missing`); zero probes of kind `profile` targeting the renderer; every selected agent's `config.yaml` field `error` | `error` |
| Python or PyYAML unavailable, lock timeout, renderer crash | `python3` missing / `import yaml` fails / exit 1 without drift block / deadline | host-level `renderer-python-unavailable`/`renderer-pyyaml-missing`; per-agent `renderer-failed` or `renderer-timeout` → `error` | `error`, run still succeeds |
| Bank pin variants | `hindsight/config.json` absent / symlink / malformed / `{bank_id_template: …}` only / `custom` / `agent-nautilus_trader-pm` for `nautilus-trader-pm` / other | items `pin-missing`,`pin-symlink`,`pin-malformed`,`bank-missing`,`bank-custom`,`bank-alias`,`bank-mismatch`; `observed`/`desired` carry the exact ids; memory never read | `fail` |
| Skill membership | core skill absent / SKILL.md bytes differ from canonical / dangling link / realpath outside allowed roots / extra optional skills present | items `core-missing:<n>`,`core-replaced:<n>`,`core-dangling:<n>`,`core-foreign:<n>` → `fail`; extras listed (≤ 20) with state unchanged | No error expected |
| `profile.yaml` shapes | absent / symlink / not a mapping / unknown key / `config:` block / `name` ≠ dir name / `display_name` ≠ registry | `missing`,`symlink`,`malformed` → `fail`; `unknown-key:<k>` → `warn`; `inert-config-block` recorded, state unchanged; `identity-mismatch` → `fail` | No error expected |
| Misowned singleton link | `<profile>/SOUL.md` → another agent's `runtime/` | item `misowned-link:SOUL.md` → `fail` | No error expected |
| Extra root entries (fleet scope) | `33god-pm.bak`, `nautilus_trader-pm`, `OptionJangler-pm`, `raw-stdio-pm`, symlinked `intelliforia-voice-agent`, `fleet-bloodbank-gateway`, a stray file, an empty dir, a dangling link | one host finding `profile.extras` with typed items: class ∈ {`approved-managed-exception`,`intentionally-unmanaged`,`retired-candidate`,`unclassified`,`debris-candidate`}, bounded evidence, guidance; state `pass` iff every entry is approved/unmanaged else `warn` (unjustified → `unproven`, by design) | No error expected |
| Extra root entries (agent scope) | `--agent <id>` | no sweep, no `profile.extras`, `data.profile.extras.coverage: "not-swept"` | No error expected |
| `--live` disagreement | rule `hermes.runtime-singleton` passes but observer reads `generated-symlink`/`delta-missing`/`marker-missing`/`bank-mismatch`/`symlink` (or vice versa over that shared subset) | finding `profile-rule-disagreement` (gating, `error`/`high`); both readings kept; semantic drift, identity file and skills are `not_compared` | No error expected |
| Secrets in inputs | `op://` in delta, a token-shaped `description`, a sentinel in a drifted section value | stdout contains none of them; only names, kinds, sizes, digests | No error expected |

</intent-contract>

## Code Map

**Live evidence (2026-09-02, HEAD c935037):** registry `~/.hermes/agents-registry.yaml` = 28 rows, every
`profile_name` equals the agent id; root `~/.hermes/profiles` = 33 real dirs + 4 symlinks
(`delonet-company-reporter`, `hermes-agent-pm` registered; `intelliforia-voice-agent`,
`stemjangler-adversarial-review` not) + `33god-pm.bak` + 38 zero-byte `.<name>.config.lock`. Unregistered:
`OptionJangler-pm`/`optionjangler-pm` (case pair), `nautilus_trader-pm` (underscore alias of a registered row,
no delta, no pin), `carrie`, `coachingagentframework-pm`, `raw-stdio-pm`, `tonnybox-pm`,
`fleet-bloodbank-gateway` (declared `managed_shared_service`, `policy_domains` incl. `profile`). `pjangler-pm`:
`profile.yaml` = `ui_meta` only; delta = a `secret.onepassword.env` block (no memory keys); generated header
lines 1-11 fixed text (no digest/timestamp); pin `agent-pjangler-pm`; `skills -> ~/.hermes/skills` (27 profiles
link there; it holds none of the six core skills; they reach agents via base `skills.external_dirs` =
`~/.agents/skills`); singleton links `SOUL.md`, `memories`, `sessions`, … → `<role_dir>/runtime/*`.
`33god-pm.bak` has `config.yaml -> ~/.hermes/config.yaml` (retired topology). Renderer `check --all` today
exits 1 (`nautilus_trader-pm` no delta). Host: python 3.11.13 + PyYAML 6.0.2; CI `publish.yml:76-100` installs
3.12 + PyYAML for this renderer already.

**Renderer contract (`templates/hermes-agent`, gitlink `6bc683d8a265dba96404a45154da283fc289ff3e`, worktree ==
gitlink, sibling `hermes-agent-template` copy identical):** `scripts/hermes-profile-config.py` (667 lines):
`HERMES_HOME = env HERMES_FLEET_HOME or ~/.hermes` (`:87`), `BASE = HERMES_HOME/config.yaml`, `PROFILES =
HERMES_HOME/profiles` (`:88-90`) -- no flags; `--profile` follows dir symlinks (`:622-624`); loads
`template/.scripts/lib/profile-config-lock.py` via importlib and refuses if missing or a symlink (`:65-85`) --
not relocatable, run in place; lock `profiles/.<name>.config.lock`, `flock LOCK_EX|LOCK_NB` polled 50 ms, env
`HERMES_PROFILE_CONFIG_LOCK_TIMEOUT_SECONDS` default 30 (`lock.py:28-29,43,80-105`), never unlinked
(`:112-119`); `cmd_check` (`:435-461`): per profile `current != deep_merge(base, delta)` on PARSED dicts,
stdout `OK: every profile config.yaml == deep_merge(base, delta)` exit 0, or `PROFILE CONFIG DRIFT:` then
`  <name>  drift in: a, b` (sorted top-level keys, max 6) / `config.yaml is a SYMLINK (no override
capability)` / `no config.delta.yaml (not under inheritance)` (`:441-453`) exit 1; FATALs go to stderr with
exit 1 (`:289,624,659,663`; `runBoundedChild` ignores stderr, so classify by stdout prefix + exit); strace of
`check --profile`: opens base, delta, generated, lock only; `-B` avoids a `__pycache__` write. `deep_merge`
`:170-187` (+ `x-pjangler-merge.list_patches` `:129-167`); `GENERATED_HEADER` `:92-104`; `FLEET_OWNED_PATHS`
`:204-208` only guard `init`/`absorb`. Skill core: `template/.scripts/10-hermes-profile.sh:36-45`
`CANONICAL_SKILLS_DIR=${CANONICAL_SKILLS_DIR:-$(config_get fleet.canonical_skills_dir "$HOME/.agents/skills")}`,
`CORE_RUNTIME_SKILLS=(33god-projects delonet-conventions delonet-dotenv hermes-pm-template-maintenance
hindsight subagent-driven-development)`, per-skill symlinks `<profile>/skills/<name> -> $CANONICAL/<name>`
(`:187-203`) plus a COPIED `skills/software-development/subagent-driven-development/SKILL.md` (`:206-212`) --
so membership is by BYTES, not by link. Pin: `:146-152` `{"bank_id": "agent-<PROFILE_NAME>"}`. Hermes reads the
pin only from `$HERMES_HOME/hindsight/config.json` and falls back to `custom` when the home is not directly
under `profiles/` or fails `^[a-z0-9][a-z0-9_-]{0,63}$` (`hermes_cli/profiles.py:40,2007-2031`).

**New -- the observer `src/fleet/profile.ts`:** `collectProfileHealth(ctx: FleetProfileContext)` with
`{ run, pjanglerRoot, home, env, fleetHome, root, manifest, contract classifications, gatewayProfileName,
agents: FleetProfileAgentInput[] {agentId, profileName, displayName, roleDir}, sweep: boolean, shown }` →
`{ root: {state, code}, renderer: {source: ok|<code>, python: ok|<code>, gitlink}, agents: Map<agentId,
FleetProfileAgentResult>, extras: FleetProfileExtras | null, probes }`. Phases: (1) root gate: walk the
components of `root` below `home`, `lstat` each, none may be a symlink (DW-28); `root` must equal
`<fleetHome>/profiles` or `renderer-layout-mismatch`. (2) renderer integrity, once: gitlink via `git -C
pjanglerRoot ls-files --stage -- templates/hermes-agent` (copy the `ls-tree`/`ls-files` equality and the
`rev-parse --show-toplevel` realpath guard from `scaffold.ts` / `provenance.ts:496-520`); expected blob ids
`git -C <submodule> rev-parse <gitlink>:scripts/hermes-profile-config.py` and
`<gitlink>:template/.scripts/lib/profile-config-lock.py`; worktree ids via `blobId()` from
`src/scaffold/compare.ts` over `lstat`-checked regular files; python probe `python3 -B -c "import sys, yaml;
sys.exit(0 if sys.version_info >= (3, 11) else 3)"`. (3) per agent under `mapBounded(…, 4)`, each probe
followed by `throwIfCancelled`: path gate → identity file → config (digests: 12-hex sha256 of base/delta/
generated bytes; marker within the first 800 bytes; then the renderer child) → pin → skills (resolution roots:
`<profile>/skills` if it is a real dir or a symlink whose realpath is contained in the fleet home or the
canonical dir, then each ABSOLUTE `skills.external_dirs` entry parsed from the generated config under the byte
cap; relative entries recorded `unresolvable`; a core skill is present when `<root>/<name>/SKILL.md` resolves
to a regular file whose realpath is contained in the canonical dir, the fleet home, or the profile AND whose
bytes equal the canonical `<canonical>/<name>/SKILL.md` digest). (4) fleet scope only: `readdir` the root,
skip `ignored_patterns` and exact registered names, classify the rest (`approved-managed-exception`: a
`managed_shared_service` entry with `profile` in `policy_domains` whose `source` is `gateways.bloodbank` →
registry `gateways.bloodbank.profile_name`, or `profiles.<name>`; `intentionally-unmanaged` / `retired-candidate`:
the matching `classifications.*.entries` `source: profiles.<name>`, plus for retired: `backup_patterns` match,
alias of a registered name (case-insensitive, `_`↔`-`, or name + backup suffix), or a dir whose `config.yaml`
is a symlink; `debris-candidate`: regular file, empty dir, dangling symlink; else `unclassified`), evidence
`{kind, link_target?, standalone: complete|incomplete, alias_of?, unit_file_references: n (bounded text scan of
`<home>/.config/systemd/user/*.{service,timer}` for `HERMES_HOME=<entry path>`, ≤ 500 files × 64 KiB),
process_reference: "unobserved" (1.9), guidance ∈ adoption|exception|retirement|manual-review}`. Probe records
`{ id: "profile:<target>", kind: "profile", target: shown(...), outcome, reason }`.

**Runtime (`src/fleet/runtime.ts`):** `runBoundedChild` `:323` already takes `env` (replaces `probeEnv()`),
`cwd`, `timeoutMs`, `keepStdoutOnFailure` (needed: the drift report is on stdout with exit 1); `probe` `:257`
discards stdout on nonzero exit, so add `probeText(ctx, command, argv, { cwd, env, keepStdoutOnFailure })`
beside `probeRaw` `:278` returning `{outcome, status, value}`; budget `:337` = `min(timeoutMs ?? probeTimeoutMs,
remaining)`.

**Contract (`contracts/fleet-contract.yaml`, schema 3 → 4, `contract_version` 1.3.0, `max_schema_version` 4):**
new optional root block `profile_manifest` (closed keys): `renderer {submodule: templates/hermes-agent, script:
scripts/hermes-profile-config.py, lock_helper: template/.scripts/lib/profile-config-lock.py, check_argv:
[check, --profile, "{profile_name}"], lock_timeout_seconds: 2, lock_pattern: ".{profile_name}.config.lock"}`,
`identity {file: profile.yaml, allowed_keys: [name, display_name, description, description_auto, role,
ui_meta], inert_keys: [config]}`, `memory {pin_file: hindsight/config.json, bank_id_template:
"agent-{profile_name}", reserved_bank_ids: [custom, hermes]}`, `skill_core {canonical_dir:
"{HOME}/.agents/skills", canonical_dir_env: CANONICAL_SKILLS_DIR, required: [the six], source:
"template/.scripts/10-hermes-profile.sh CORE_RUNTIME_SKILLS"}`, `extras {ignored_patterns:
[".{profile_name}.config.lock"], backup_patterns: ["*.bak", "*.bak-*", "*.orig", "*~", "*-backup*"]}`,
`limits {max_file_bytes: 1048576, max_root_entries: 5000, max_unit_files: 500, max_extra_skills: 20}`. New
authority block `provisioned_profile_state` (owner `hermes-agent-template`, store `hermes-profile-tree`,
`store_env: [HERMES_FLEET_HOME]`, `writable_fields: profiles.{profile_name}.profile.yaml,
profiles.{profile_name}.hindsight.config.json, profiles.{profile_name}.skills`) -- `ownerOf`
(`inventory.ts:233-251`) still resolves the `profiles.{profile_name}` prefix to `hermes-profile-renderer`
(4 leaves vs 3). Remove `deferred_capabilities[3]` (`release_provenance` / `profile.render_generation`,
`:400-406`); update the header comment (`profiles.*` root note) and `health_policy` comment.
- `src/fleet/types.ts` -- `FLEET_CONTRACT_SCHEMA_VERSION` 4 (`:18`), `FLEET_SUPPORTED_SCHEMA_VERSIONS` max 4
  (`:21`), `FLEET_CONTRACT_ROOT_KEYS`/`OPTIONAL_ROOT_KEYS` + `profile_manifest` (`:39-56`),
  `FLEET_PROFILE_MANIFEST_KEYS` (+ per-sub-block key lists), `FleetProfileManifest`, `FleetContract.profile_manifest?`
  (`:307-320`); `FLEET_STATUS_PROFILE_CONCURRENCY = 4`, `PROFILE_MAX_FILE_BYTES`, `PROFILE_MAX_ROOT_ENTRIES`,
  `PROFILE_MAX_UNIT_FILES`, `PROFILE_MAX_EXTRA_SKILLS` beside `:941-954`; `FLEET_PROFILE_ITEM_KINDS`,
  `FLEET_PROFILE_EXTRA_CLASSES`, `FLEET_PROFILE_PATH_CODES`, `FLEET_PROFILE_RENDERER_CODES`;
  `FleetStatusObservationItem.kind` (`:1454-1465`) widened to `FleetScaffoldItemKind | FleetProfileItemKind`;
  `FleetStatusAgentProfile` and `FleetProfileSummary`; `FleetStatusAgent.profile` (`:1529-1546`),
  `FleetStatus.profile` (`:1708-1729`).
- `src/fleet/contract.ts` -- `validateProfileManifest` stage appended at `:257`, shaped like
  `validateScaffoldManifest` `:1004-1106`: closed keys at every level; `bank_id_template` and `lock_pattern`
  contain `{profile_name}`; `check_argv` non-empty with one `{profile_name}`; `required` unique safe segments;
  `canonical_dir` carries a `{HOME}`/`{HERMES_FLEET_HOME}` placeholder (no absolute host path); `renderer.submodule`
  equals `scaffold_manifest.template_submodule` when both exist; every new field root-checks against
  `authorities` writable fields as `render_inputs` does (`:1027-1050`). A schema-1..3 contract without the
  block still loads; the observer then reports every selected agent's five fields `unsupported` with
  `capability: "profile.manifest"` (unjustified unless the contract says so).
- `src/fleet/health.ts` -- `SOURCE_EVIDENCE["fleet-profile"] = "direct"` (`:262-269`); `resolveJustification`
  (`:283-331`) needs nothing new (`agent_exceptions` with `domain: profile` already resolve).

**Status integration (`src/fleet/status.ts`):** constants `SOURCE_PROFILE = "fleet-profile"`,
`PROFILE_ROOT_RULE_ID = "profile.root"`, `PROFILE_RENDERER_RULE_ID = "profile.renderer"`, `PROFILE_EXTRAS_RULE_ID
= "profile.extras"`, `CAPABILITY_PROFILE_MANIFEST` beside `:333,:377-380`. Manifest gate beside `:1842`
(`domainSet.has("profile")`). Raw inputs beside `:1823-1836`: `profileNameByAgent`, `displayNameByAgent`,
`roleDirByAgent` (already), and `gateways.bloodbank.profile_name` from the raw store. Collection phase after
the scaffold phase (`:2034-2049`) and before the audit children, `sweep = selectedAgents covers every registered
row` (fleet scope, i.e. no `--agent`); push probes; counters beside `:2052-2058`. Per-agent emission beside
`:2252-2276` via a new `observeFromProfile(ctx, {agentId, result, manifestDeclared, exception, notes})` returning
`{observations, summary}` with the five fields (`profiles.{profile_name}`, `.profile.yaml`, `.config.yaml`,
`.hindsight.config.json`, `.skills`), `items` capped at `FLEET_STATUS_MAX_ITEMS` with the `truncated` note
idiom (`:1327-1332`), `exceptionId/Reason/Policy` from `health_policy.agent_exceptions` where `domain ===
"profile"` (`:2030-2033` pattern). Host findings built exactly like `scaffold.source` (`:2172-2225`) and
registered in `hostByRule`: `profile.root`, `profile.renderer`, and (fleet scope only) `profile.extras` with
`items`. Rule agreement beside `:2490-2512` against `hermes.runtime-singleton` (`auditByAgent` lookup idiom
`:2491`; detail regexes from `src/parity/rules.ts:3730-3790`: `config.yaml is a symlink`, `not a rendered
artifact`, `profile config missing`, `config.delta.yaml missing`, `must be a real file`, `identity-memory`,
`profile dir is a symlink`), finding code `profile-rule-disagreement` with the `addFinding` shape at `:2503`.
`data.profile` beside `:2751-2769` (`null` when the domain is not selected): `{ source, root: {state, code},
renderer: {source, python, gitlink, checked, in_sync, drifted, failed, timeout}, agents: {total_registered,
selected, real, blocked_at_path, structurally_healthy, drifted, incomplete, exception_authorized, unobserved},
identity: {bank_ok, bank_alias, bank_custom, bank_missing, bank_mismatch}, skills: {core_complete, core_missing,
core_replaced, extras_seen}, extras: {coverage: swept|not-swept, reason?, entries_total, by_class{5}, listed,
truncated}, rule_agreement: {compared, agree, disagree, not_compared} }`; `agents[].profile` at `:2588`:
`{ profile_name, path: {state, code}, identity: {state, keys}, renderer: {state, sections[]}, digests: {base,
delta, generated}, bank: {observed, expected, state}, skills: {core_present, core_missing[], extra[],
sources_unresolvable} }`. `profileProven` (`:1522-1524`) stays on the inventory observation; the observer's
`fail` demotes via `anyFailure` (`:1527-1529`) -- do not change lifecycle rules. Keep the inventory profile
observation (`:1046-1069`) untouched.
- `src/fleet/provenance.ts` -- delete the `profile.render_generation` unsupported fact (`addUnsupportedFacts`
  `:888-911`) and `profileDigest` if unused; update the doc comment.
- `src/fleet/output.ts` -- `FLEET_COMMAND_DATA_KEYS["fleet.status"]` + `"profile"` (`:91-94`);
  `observationLines` item painting handles the new kinds (`:927-938`); `agentLine` profile cell after the
  scaffold cell (`:978-990`, e.g. `profile in-sync · bank ok · skills 6/6`); Domains section block for
  `profile` mirroring `:1072-1091` (root, renderer source, agent counts, extras by class). `bounded`/`redactHome`
  only.
- `src/fleet/index.ts` -- `profile` export block between scaffold (`:100-112`) and status (`:114-129`); new
  types into `:270-278`. `src/fleet/cli.ts:503` and `src/fleet/mcp.ts:291` need no change.

**Tests:**
- NEW `tests/fleet-profile-regressions.mjs` -- copy the helper set from `tests/fleet-scaffold-regressions.mjs`
  (`skipCase :81`, `git :110`, `seedFleet :295`, `agentRow :383`, `writeAgentRegistry :411`, `isolation :431`,
  `contractDocument/writeContract/policyContract :465-476`, `makePackageRoot :487`, `snapshotTree :522`,
  `snapshotIsolated :543`, `snapshotShared :553`, `assertUnchanged :567`, `cliAt :575`, `envelope :585`,
  `status :601`, `entry :640`, `syntheticReport :648`). Add `seedProfile(home, name, opts)` writing base
  `.hermes/config.yaml`, `profile.yaml`, `config.delta.yaml` (`{}` by default), generated `config.yaml` =
  `# GENERATED FILE -- DO NOT EDIT` header + `YAML.stringify(deepMerge(base, delta))` (the renderer compares
  PARSED dicts, so the serializer need not match PyYAML), `hindsight/config.json`, `skills/` with six symlinks
  into `<home>/.agents/skills/<name>/SKILL.md` (created), singleton links into the agent's `runtime/`, and the
  pre-created zero-byte `.{name}.config.lock`. The fixture submodule from `makePackageRoot` must carry the REAL
  `scripts/hermes-profile-config.py` and `template/.scripts/lib/profile-config-lock.py` read from this repo via
  `git show <gitlink>:<path>` (`encoding: "buffer"`), committed and pinned (`update-index --add --cacheinfo
  160000,…` idiom, `tests/submodule-contract-regressions.mjs:79-80`). Cases: one agent per matrix row above
  (path codes, identity shapes, config/renderer states incl. a base edit → `semantic-drift` naming the section,
  pin variants, skill variants, misowned link), renderer-source-mismatch → zero renderer probes, python-missing
  via a `PATH` shim → `renderer-python-unavailable`, lock held by a fixture `flock` → `renderer-timeout` within
  the deadline, extras sweep covering all five classes with `fleet-bloodbank-gateway` approved through the
  contract entry + registry gateway block and `nautilus_trader-pm`-style alias → `retired-candidate`, agent
  scope → `coverage: not-swept` and zero sweep, `--domain registry` → zero `profile` probes, `--live` with a
  `PJ_FLEET_CLI_ENTRY` shim (`:1051` idiom) producing a passing `hermes.runtime-singleton` beside an observer
  `delta-missing` → `profile-rule-disagreement`, `agent_exceptions` delta flipping a drifted agent to
  `exception`, contract negatives (unknown key, template without placeholder, duplicate skill, absolute
  `canonical_dir`), schema-3 contract without the block → `unsupported`/`profile.manifest`, > 64 KiB pipe case,
  two-run byte identity, zero-write snapshots (temp + package root + submodule `git status --porcelain`),
  `SECRET_SENTINEL` planted in delta/description/drifted value/SKILL.md absent from stdout, no `/home/<user>`
  and no ISO timestamp in the payload, MCP parity (`pjangler_fleet_status` `{domain: "profile"}` deep-equals
  CLI `data`), a skill-core parity case that reads `10-hermes-profile.sh` at the gitlink and asserts the
  `CORE_RUNTIME_SKILLS=( … )` names equal `profile_manifest.skill_core.required`, registration cases
  (runner/README `### Profile health`/mise/ledger, `tests/fleet-status-regressions.mjs:1607-1628` idiom), and
  ONE live-gated AC11 case: real fleet `--domain profile --json`, then an independent `readdir`+`lstat` of the
  real root asserting every non-registered, non-lock entry appears in `profile.extras` items with a class and
  every symlink entry is reported as `symlink`, plus an independent `python3 -B <script> check --profile
  pjangler-pm` whose exit/sections agree with `agents[pjangler-pm].profile.renderer` (`skipCase` on missing
  registries, profile, or python).
- `tests/fleet-status-regressions.mjs` (`:323-344`), `tests/fleet-health-regressions.mjs` (`:364-376`,
  `cleanRoot` must stay `proven: true` at `:742`), `tests/fleet-scaffold-regressions.mjs` (`:358-362`) --
  registered fixture profiles become renderer-clean via the same seeding (base config, delta, generated, pin,
  skills, locks), fixture submodules gain the two real renderer files; update the `--domain profile` pins at
  `fleet-status-regressions.mjs:1425-1429` (`beta-pm` now carries the inventory `fail` plus the observer's
  path `fail`).
- `tests/fleet-provenance-regressions.mjs:969-996` -- drop `profile.render_generation` from the unsupported
  list. `tests/fleet-contract-regressions.mjs` -- schema 4 loads, schema 1-3 still load, negatives.
  `tests/mcp-server-regressions.mjs` -- parity for `domain: "profile"` includes `data.profile`.
  `scripts/run-tests.mjs` `SUITES` -- add beside `:116`.
- Hazards already learned: `GIT_CEILING_DIRECTORIES`, `update-index --refresh` before measuring, shims outside
  the snapshotted tree, no `/home/<name>` literal, payloads > 65 536 B, `maxBuffer` explicit, delta not absolute,
  `python3 -B` (a cold `__pycache__` under the submodule is a write), pre-created locks (a created lock changes
  the root's mtime).

**Docs/ledger:** `README.md:279` `profile` row rewritten; new `### Profile health` subsection between
`### Scaffold parity` (`:307-382`) and `### Seven states` (`:383`) naming the five fields, the renderer lock
semantics, the five extra classes, and the coverage label; `mise.toml:59-72` comment; `CHANGELOG.md`
`## [Unreleased]` `### Added` `feat(PJAN-109)` bullet; `deferred-work.md`: next free number is **DW-90** (DW-81
is used twice); annotate DW-25 (root sweep exists), DW-28 (ancestor components checked), DW-31 (containment now
reachable through the registry-derived path gate, or say why not), DW-63 (`profile.render_generation` removed).

## Tasks & Acceptance

**Execution:**
- `src/fleet/runtime.ts` -- add `probeText` (stdout kept on nonzero exit, `cwd`/`env`/`timeoutMs`) -- the renderer's drift report rides exit 1
- `contracts/fleet-contract.yaml` -- schema 4: `profile_manifest`, `provisioned_profile_state` authority, remove the `profile.render_generation` deferral, bump versions -- the policy the observer consumes
- `src/fleet/types.ts` -- schema constants, manifest keys/types, caps, item kinds, extra classes, `FleetStatusAgentProfile`, `FleetProfileSummary`, `agents[].profile`, `data.profile` -- one vocabulary for CLI and MCP
- `src/fleet/contract.ts` -- `validateProfileManifest` stage -- policy that names nothing real must fail to load
- `src/fleet/profile.ts` -- the observer (root gate, renderer integrity, per-agent path/identity/config/pin/skills, extras sweep, probes) -- greenfield
- `src/fleet/health.ts` -- `fleet-profile` evidence mapping -- direct evidence, not `derived`
- `src/fleet/status.ts` -- raw inputs, collection phase, `observeFromProfile`, three host findings, rule agreement, `data.profile`, `agents[].profile` -- the integration
- `src/fleet/provenance.ts` -- delete the `profile.render_generation` fact -- the observer answers it
- `src/fleet/output.ts` -- data key, item painting, profile cell, Domains block -- the human surface
- `src/fleet/index.ts` -- export block -- typed callers
- `tests/fleet-profile-regressions.mjs` -- the new suite (matrix rows, integrity classes, scoping, caps, zero writes, secrets, MCP parity, skill-core parity, registration, live AC11) -- proof against the canonical renderer
- `tests/fleet-status-regressions.mjs`, `tests/fleet-health-regressions.mjs`, `tests/fleet-scaffold-regressions.mjs`, `tests/fleet-provenance-regressions.mjs`, `tests/fleet-contract-regressions.mjs`, `tests/mcp-server-regressions.mjs` -- renderer-clean fixtures, deferral removal, schema 4, parity -- keep the existing truth tables green for the right reasons
- `scripts/run-tests.mjs` -- register the suite -- a suite is invisible until listed
- `README.md`, `mise.toml`, `CHANGELOG.md`, `_bmad-output/implementation-artifacts/deferred-work.md` -- docs and ledger -- parity checks assert them

**Acceptance Criteria:**
- Given a five-agent isolated fleet where one profile is a symlink, one is missing, one is a regular file, one has an uppercase twin in the root, and one is clean, when `fleet status --domain profile --json` runs, then each of the four reads `profiles.{profile_name}` `fail` with its code, its other four fields `unobserved` naming that code, `data.profile.agents.blocked_at_path` is 4, and `data.probes` shows renderer probes only for the clean agent.
- Given a clean registered profile and a base `config.yaml` then edited in one section, when status runs twice, then the first run's `config.yaml` field is `pass` with `renderer.state: "in-sync"` and three 12-hex digests, the second is `fail` with exactly one `semantic-drift` item naming that section, and no digest, body, or value of either file appears in stdout.
- Given the fixture submodule's worktree copy of the renderer edited by one byte, when status runs, then `data.host` carries `profile.renderer` `error` with `renderer-source-mismatched`, every selected agent's `config.yaml` field is `error`, and no child named `python3` is spawned.
- Given pins reading `agent-alpha-pm`, `agent-Alpha-pm`, `agent-alpha_pm`, `custom`, `{"bank_id_template": "agent-{profile}"}`, and an absent file, when identity health runs, then the states are `pass`, `bank-alias`, `bank-alias`, `bank-custom`, `bank-missing`, `pin-missing`, each observation's `observed`/`desired` carry the exact ids, and no path under `memories/` is opened.
- Given a profile whose `skills/hindsight` is a dangling link, whose `skills/33god-projects/SKILL.md` is a byte-different copy, whose `skills/extra-tool` is a valid optional skill, and whose generated config lists the canonical dir under `skills.external_dirs`, when skill membership runs, then items `core-dangling:hindsight` and `core-replaced:33god-projects` make the field `fail`, `extra[]` lists `extra-tool`, and the remaining four core skills read present through `external_dirs`.
- Given a fleet-scope run over a root holding a backup-named dir, an underscore alias of a registered name, a dir whose `config.yaml` is a symlink, a symlink to a real dir, an incomplete standalone dir, a stray file, an empty dir, a dangling link, and the declared gateway profile, when classification runs, then `profile.extras` lists each with the expected class (`retired-candidate` ×3, `unclassified` ×2, `debris-candidate` ×3, `approved-managed-exception` ×1), each with `kind`, `guidance`, and `process_reference: "unobserved"`, the finding is `warn`, `health.verdict` is `unproven`, and the worktree, root mtimes, and every entry are byte-identical before and after.
- Given `--agent alpha-pm` on that fleet, when the run completes, then `data.profile.extras.coverage` is `not-swept`, no `profile.extras` host finding exists, `data.profile.agents` reads `total_registered: 5, selected: 1, unobserved: 4`, and `--domain registry` spawns zero probes of kind `profile`.
- Given `--live` with a shimmed audit child reporting `hermes.runtime-singleton` `pass` for an agent whose `config.delta.yaml` is absent, when findings are produced, then `profile-rule-disagreement` is present and gating, both readings stand, and an agent whose only divergence is semantic drift is `not_compared`.
- Given the same fleet run twice and through the MCP tool, when `data` is compared, then it is byte-identical and `data.profile` plus every `agents[].profile` is present in all three, including after the renderer has created its lock files.
- Given the live fleet, when the story is closed, then `pjangler fleet status --domain profile --json` reports 28 registered agents with `profile.renderer` `ok` at gitlink `6bc683d8…` (or the then-current gitlink), the two registered symlinked profiles as path `fail`, `profile.extras` classifying every unregistered non-lock root entry, and the `pjangler-pm` renderer reading agrees with an independent `check --profile pjangler-pm` recorded in the Auto Run Result.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 38: (high 0, medium 6, low 32)
- defer: 1: (high 0, medium 0, low 1)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` `health.unjustified` silently generalized to every host finding — documented in README/CHANGELOG and pinned by a non-profile host warn → `unproven` test with an `allowed_warnings` lift
  - `[medium]` `[patch]` `readdir(root)` failure or a capped listing let the case-collision gate pass vacuously — `root-unreadable` root error in every scope, `case-collision:unverified` hard gate over a truncated listing, indexed `unparsed:<n>` rows
  - `[medium]` `[patch]` two registry rows naming one profile proved the same directory twice with lock contention — `ambiguous:duplicate-profile-name` hard gate, tested
  - `[medium]` `[patch]` the symlinked `skills` entry branch (27 of 28 live profiles) was unexercised — three fixture shapes added (fleet-home link accepted, foreign link `core-foreign:skills`, dangling `core-dangling:skills`)
  - `[medium]` `[patch]` `canonical-missing`, the headline live reading, had no case — added, plus the once-per-host `profile.skill-core` finding naming the missing core skills
  - `[medium]` `[patch]` `bank_ok` was asserted against itself and `core_complete`/fleet `core_missing` were unpinned — exact fixture counts asserted
  - `[low]` `[patch]` `renderer.lock_pattern` was never consumed — the sweep derives its lock exclusion from it and the validator rejects `ignored_patterns` that do not cover it
  - `[low]` `[patch]` code vocabularies — `FLEET_PROFILE_ROOT_CODES`/`FLEET_PROFILE_PYTHON_CODES` added, `renderer-layout-mismatch` moved, record fields typed, dead `unparsed` kind check and unreachable renderer-report branches removed
  - `[low]` `[patch]` rule agreement could never compare a gated `symlink` — the path aspect is compared on its own, `misowned-link` maps to the rule's wrong-target, and the symlink disagreement assertion is pinned
  - `[low]` `[patch]` rule detail regexes proven only against a synthetic report — pinned against the literal strings in `src/parity/rules.ts`
  - `[low]` `[patch]` `provisioned_profile_state` note named a writer that does not write `profile.yaml` — note and README name the real writers
  - `[low]` `[patch]` README overstated which rulings lift the extras warn — exact rulings stated; `allowed_warnings: profile.extras` lift tested
  - `[low]` `[patch]` fleet base derived from `profile_layout.generated_file` by coincidence — named explicitly as the renderer's `config.yaml`
  - `[low]` `[patch]` canonical skills dir ignored the template config — `[fleet] canonical_skills_dir` honoured between the env override and the placeholder, tested
  - `[low]` `[patch]` failed git probes reported as gitlink verdicts — `renderer-source-unobserved`; git-checkout precondition documented
  - `[low]` `[patch]` `pin-symlink`/`pin-malformed` fell in no identity bucket — `bank_invalid` added, agent cell reads `bank invalid`, `bank-alias` painted as the fail it is
  - `[low]` `[patch]` every declared cap untested — lowered-limit cases prove counts before the cap, `truncated`, `max_extra_skills`, item clipping; fleet `core_missing` counts dangling/foreign; `extras_seen` uncapped
  - `[low]` `[patch]` `unreadable` gate wording, `core-dangling` for a directory without `SKILL.md`, and the `skills/` listing reusing the root cap — corrected
  - `[low]` `[patch]` held-lock test raced a fixed sleep and assumed `flock` — `skipCase` without `flock`, holder polled with `flock -n`
  - `[low]` `[patch]` README omitted renderer/root codes, the contract-`retired` path and misdescribed `profile.root` — completed
  - `[low]` `[patch]` identity `desired` text was vacuous — reworded to what is checked
  - `[low]` `[patch]` registry re-parsed for the gateways block, exception resolved twice, dead `layout` local in provenance — removed
  - `[low]` `[patch]` `readBounded` cap advisory and torn reads digested — capped read, re-`lstat`, retry once then `unreadable`
  - `[low]` `[patch]` python probe mapped unrelated exit codes to `renderer-pyyaml-missing` — probe script exits 3/4 itself; anything else `renderer-python-unavailable`
  - `[low]` `[patch]` rows without `role_dir` skipped singleton-link checks silently — scaffold-style default, else `unverifiable` warn
  - `[low]` `[patch]` a drift report with no parseable section could pass, and summaries claimed in-sync beside items — one `semantic-drift`/`unparsed` item; in-sync only with no item
  - `[low]` `[patch]` unreadable/vanished/unlistable extras landed in `debris-candidate` — `unclassified`/`manual-review`; `intentionally_unmanaged`/`retired` claims require `profile` in `policy_domains`
  - `[low]` `[patch]` override-only delta proven only transitively — `delta-not-override-only` item for a delta carrying the marker or equal to base/generated, tested
  - `[low]` `[patch]` fleet home resolved twice — one function shared with `resolveProfileLayout`
  - `[low]` `[patch]` gated rollup reads `unobserved` — documented in README and recorded as DW-95
  - `[low]` `[patch]` `base-missing`/`base-symlink`, `renderer-layout-mismatch`, `renderer-gitlink-unstable`, `unnamed`, contract-`retired` claim — cases added
  - `[low]` `[patch]` the whole suite skipped on a python-less host — renderer-dependent cases skip individually; the rest run
  - `[low]` `[patch]` live AC11 case did not snapshot the real root — names/types/mtimes snapshotted before and after
  - `[low]` `[patch]` README/CHANGELOG lines quoting changed strings updated

### 2026-09-02 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 36: (high 0, medium 3, low 33)
- defer: 0
- reject: 19: (high 0, medium 0, low 19)
- addressed_findings:
  - `[medium]` `[patch]` an identity file, generated config, delta or pin the observer could not open was reported `malformed` / `generated-missing` / `delta-missing` / `pin-malformed` — `unreadable` is its own error-ranked kind on every file field, and a config or delta that could not be read is a renderer `error`, not a `fail`
  - `[medium]` `[patch]` a real file where the template provisions a singleton link (the stock `SOUL.md` Hermes seeds) passed the gate silently — `misowned-link` with `not-a-link:<entry>`, matched to the rule's `not-a-symlink` detail for agreement, tested
  - `[medium]` `[patch]` singleton-link containment compared paths textually, so a `role_dir` or link target spelled through a symlinked ancestor read `misowned-link` — realpath containment as the second reading, tested
  - `[low]` `[patch]` a package root nested inside a foreign repository read that repository's HEAD and reported `renderer-gitlink-missing` — a `rev-parse --show-toplevel` guard on the package root, `renderer-source-unobserved`
  - `[low]` `[patch]` a renderer worktree copy that could not be lstat'ed or read under the cap read `renderer-source-mismatched` — `renderer-source-unobserved`, with the cap named
  - `[low]` `[patch]` a singleton link whose `readlink` failed was silently treated as owned — `unverifiable`
  - `[low]` `[patch]` an empty identity file passed as identity-only with zero keys — `malformed` (`empty`), tested
  - `[low]` `[patch]` an empty fleet base flagged every non-empty delta `delta-not-override-only` (`equals-generated`) — the copy check requires a base that holds keys, tested against the renderer
  - `[low]` `[patch]` a `skills` entry that is a regular or special file was never named — recorded as `source-unresolvable` (`skills-not-a-directory:<kind>`), tested
  - `[low]` `[patch]` the skills summary read "…; do not" with an empty list when only the entry itself failed — names the entry defects
  - `[low]` `[patch]` a backup pattern not leading with `*` (`old.*`) took its suffix as the alias stem — the stem comes only from a leading wildcard, tested
  - `[low]` `[patch]` `?*`-shaped ignore patterns match every entry and were accepted — wildcard-only patterns refused, tested in both suites
  - `[low]` `[patch]` symlinked user units were skipped and a multi-assignment `Environment=` line produced a bogus path — units read through the link, the value ends at whitespace, both fixture-pinned
  - `[low]` `[patch]` a symlinked template config was silently ignored while the template's own `config_get` follows it — read through the link, tested
  - `[low]` `[patch]` the dead `not-run` renderer state, the never-emitted `root` path code and an untyped `path.code` — vocabularies corrected, `FleetProfilePathCode` typed with `root:<code>` end to end
  - `[low]` `[patch]` the `result === undefined` branch emitted one observation against the five-field invariant — five `unobserved`
  - `[low]` `[patch]` the report painted a path warn red, printed `skills 0/0` for an errored field, kept a dead `too-large` bank code and painted `renderer manifest-undeclared` red beside a grey root — corrected
  - `[low]` `[patch]` the `health.unjustified` widening sat mid-way through the `### Added` bullet — its own bullet under `### Changed`
  - `[low]` `[patch]` an orphaned JSDoc block in `inventory.ts` documenting nothing, its "exported for provenance.ts" claim stale, stray blank lines in two source files — corrected
  - `[low]` `[patch]` the health suite's exception case removed its unregistered profile only after every assertion passed — `finally`
  - `[low]` `[patch]` two hand-rolled glob converters could diverge — one exported `rootEntryGlob` shared by the validator and the sweep
  - `[low]` `[patch]` README never said the renderer runs under an allowlisted environment — stated, with the `PYTHONPATH`/`VIRTUAL_ENV` consequence
  - `[low]` `[patch]` the live AC11 snapshot would fail on a newly registered profile whose lock the check creates on first use, and the mise comment said "strictly read-only" — lock entries excluded from the snapshot, the one footprint stated
  - `[low]` `[patch]` an unnamed row's gate item carried an empty path — `(unnamed)`, tested
  - `[low]` `[patch]` `FLEET_PROFILE_ROOT_CODES`, `FLEET_PROFILE_PYTHON_CODES`, their types, `FleetProfileSkillCoreRecord` and three observer constants were not exported — exported
  - `[low]` `[patch]` lock entries counted toward `max_root_entries` before the ignore list applied — filtered before the cap; first-use lock creation proven byte-stable across two runs and invisible to a cap of one
  - `[low]` `[patch]` three renderer-dependent assertions ran ungated on a python-less host — gated on `RENDERER_AVAILABLE`
  - `[low]` `[patch]` `renderer-source-unobserved` was never driven — nested package root, a git exiting 128 and a 1 KiB cap
  - `[low]` `[patch]` `root-unreadable` and the `unreadable` path gate had no case — mode 0300 / 0400 roots and mode 0 files, skipped as root, in both scopes
  - `[low]` `[patch]` `too-large` and `max_unit_files` were never exercised — an oversized identity file and pin (`bank_invalid`, `bank error` in the report), a one-unit cap
  - `[low]` `[patch]` `core-missing` was never produced — a core skill absent from every root and a core entry with no `SKILL.md`
  - `[low]` `[patch]` seven validator rejections had no negative — lock timeout (negative, over a minute), lock pattern (no placeholder, a path), `canonical_dir_env`, an empty `required`, an empty ignore list
  - `[low]` `[patch]` fleet-wide duplicate-name detection was proven only in fleet scope — an `--agent` run against the duplicate registry
  - `[low]` `[patch]` the `skip` half of the host justification gate was unpinned — a host skip counts against proof until an `allowed_skips` entry lifts it
  - `[low]` `[patch]` human-report cells beyond the clean row were unasserted — drifted, gated, unverifiable, bank invalid / unpinned / alias, identity warn, `skills 4/6`, and an `--agent` report's `extras not swept`
  - `[low]` `[patch]` the renderer child's cwd and environment were never observed — a recording shim proves the submodule cwd, the lock wait, the allowlist and that the parent's Plane key never reaches the child

## Design Notes

**Run the canonical bytes, not a canonical location.** The renderer cannot be relocated (it insists on its
sibling lock helper by relative path), and the sibling-first locator PJangler already has is exactly the
"newer bytes from a different checkout" hazard 1.6 removed for scaffolds. Proving both files' blob ids equal
the committed gitlink's before spawning gives the same guarantee without extraction: what runs IS what is
pinned, or nothing runs and the operator sees why.

**Five fields, not one, and none shared with the inventory.** `detectContradictions` joins on `(agent, domain,
field)`; the inventory's profile observation sits on `agents.{agent_id}.profile_name`. Putting the observer on
`profiles.{profile_name}.*` leaves keeps a path `fail` from being reported as a contradiction of the inventory's
`lstat`, lets `authority.ownerOf` answer, and makes `by_state` count agents per aspect rather than files.

**Gate first, then look.** A symlinked or ambiguous profile is a hard failure precisely because anything read
through it may belong to another agent. The four dependent fields are `unobserved` (coverage is honestly
incomplete), not `error` (nothing failed to collect) and not `skip` (nothing authorizes skipping).

**The renderer's lock is its read semantics.** `check` takes `flock` on a persistent per-profile lock so a
concurrent `render` cannot hand it a half-written file. That is a consistency guarantee the observer wants,
not a mutation lock; the observer never takes the registry lock or any lock of its own, sets a 2-second
timeout so a held lock becomes a bounded `renderer-timeout`, and excludes lock entries from every count so its
own footprint never changes its output.

**Membership is bytes.** The template both symlinks core skills and copies one of them, and 27 live profiles
reach the core only through `skills.external_dirs`. Comparing the resolved `SKILL.md` digest to the canonical
one, over the roots Hermes actually loads, answers "does this agent run the immutable core?" without pretending
one wiring shape is the only healthy one -- while a foreign realpath or a different digest never counts.

**Extras are findings for an operator, never a licence.** Every class carries guidance and evidence; `warn`
without an `allowed_warnings` ruling keeps the fleet `unproven` until the operator classifies the entry in the
contract -- which is the only way an extra becomes `pass`.

```yaml
profile_manifest:
  renderer: { script: scripts/hermes-profile-config.py, check_argv: [check, --profile, "{profile_name}"] }
  memory:   { pin_file: hindsight/config.json, bank_id_template: "agent-{profile_name}" }
  skill_core: { canonical_dir: "{HOME}/.agents/skills", required: [33god-projects, …] }
```

**Review pass (documented behaviour changes).** Host findings reach the
justification gate: a host `warn`/`skip` with no `allowed_warnings`/`allowed_skips`
entry counts into `health.unjustified` and blocks `proven`, never `healthy`. A
third host finding, `profile.skill-core`, names the core skills the canonical
projection lacks; the canonical directory resolves `CANONICAL_SKILLS_DIR`, then
the template config's `[fleet] canonical_skills_dir`, then the manifest
placeholder. The fleet base is the renderer's own `config.yaml`
(`RENDERER_BASE_FILE`), never derived from `profile_layout.generated_file`. The
root vocabulary is its own (`FLEET_PROFILE_ROOT_CODES`), the interpreter codes
their own (`FLEET_PROFILE_PYTHON_CODES`, the probe script exiting 3/4 itself),
and a failed git probe is `renderer-source-unobserved`, never a content verdict.
Gate additions: `ambiguous:duplicate-profile-name` for a profile more than one
row claims, `case-collision:unverified` over a capped root listing,
`root-unreadable` in every scope when the root cannot be enumerated, an
`unreadable` directory as the one `error` gate, and `unverifiable` (warn) for
singleton links a row without `role_dir` or `project_path` cannot have judged
(with `role_dir` defaulting to `<project_path>/agents/hermes/<role>` as the
scaffold observer does). Config additions: `delta-not-override-only` for a
delta carrying the generated marker or equal to the base or generated mapping;
a drift report naming no parseable section is one `semantic-drift` item
(`unparsed`); `in-sync` is claimed only with no item at all. Rule agreement
compares the path aspect on its own (a symlinked or missing profile against
the rule's own detail), treats `misowned-link` as the rule's `wrong-target`,
and pins every detail pattern against the rule's literals. `agents[].profile.bank.code`
and `data.profile.identity.bank_invalid` make the bank buckets sum to `real`;
`extras_seen` is uncapped; fleet `core_missing` counts dangling, foreign and
canonical-missing kinds; every read is opened without following and re-checked
after the read. A gated profile's `domains.profile` rollup reading is recorded
as DW-95.

## Verification

**Commands:**
- `npm run typecheck && npm run build` -- expected: clean
- `npm test` -- expected: every suite green, including the new `tests/fleet-profile-regressions.mjs`; the live AC11 case runs (not skipped) on this host
- `node dist/index.js fleet status --domain profile --json > /tmp/p1.json; node dist/index.js fleet status --domain profile --json > /tmp/p2.json; diff <(jq -S .data /tmp/p1.json) <(jq -S .data /tmp/p2.json)` -- expected: no diff; `git -C templates/hermes-agent status --porcelain` unchanged before and after
- `python3 -B templates/hermes-agent/scripts/hermes-profile-config.py check --profile pjangler-pm; echo $?` -- expected: agrees with `agents[pjangler-pm].profile.renderer` in the payload
- `node dist/index.js fleet status --domain registry --json | jq '[.data.probes[] | select(.kind=="profile")] | length'` -- expected: 0
- `node dist/index.js fleet contract validate` -- expected: exit 0 at schema 4
- `grep -c 'GENERATED FILE\|op://\|/home/' <payload>` -- expected: 0 secrets, 0 absolute home paths

## Auto Run Result

Status: done
Blocking condition: none

### Summary of implemented change

Follow-up review pass over the story-1.7 profile observer (the first pass recommended one at
score 50). Four review layers over the whole story diff since `c935037` produced 36 patches, all
applied in commit `ecee7bd6dc6778787074481b57b116c2582b477f`. The theme: a collection failure is
never a verdict. A file the observer cannot open is `unreadable` (an error on its own field, and
a renderer `error` when it is the config or the delta), a renderer copy it cannot read or a
package root that is not a git checkout root of its own is `renderer-source-unobserved`, and a
singleton link it cannot read is `unverifiable`. The gate now catches a real file where the
template provisions a link (the stock `SOUL.md` Hermes seeds, `not-a-link:<entry>`, agreed with
the rule's `not-a-symlink`) and stops flagging a link whose role directory is spelled through a
symlinked ancestor. Smaller readings: an empty identity file is `malformed`, an empty base no
longer marks every delta a frozen copy, a non-directory `skills` entry is recorded, a
non-leading backup wildcard names no stem, wildcard-only ignore patterns are refused, unit files
and the template config are read through links, and lock entries are excluded before the root
cap. One glob grammar is shared by the validator and the sweep; the dead `not-run` state and the
never-emitted `root` path code are gone and `path.code` is typed end to end; the report paints a
path warn yellow and an errored skills field by state. Nineteen findings were rejected as
design-as-specified (the `unobserved` rollup DW-95, the SIGKILL timeout DW-94, the optional-skill
listing DW-90, the namespace-majority owner, counts versus exceptions, the mismatch probe record),
as orchestrator bookkeeping (`sprint-status.yaml`, the DW-96 ledger entry), or as noise. Nothing
was deferred this pass.

### Files changed

- `src/fleet/profile.ts` -- package-root toplevel guard; unobserved for unreadable renderer copies; `unreadable` kind on identity/config/delta/pin; `not-a-link` and realpath containment for singleton entries; `unverifiable` on a failed readlink; empty identity file; empty-base guard; non-directory `skills` entry; skills summary wording; leading-wildcard stem; unit files through links with a whitespace-terminated value; template config through its link; lock entries filtered before the cap; `(unnamed)` item path; `rootEntryGlob` import; typed path code.
- `src/fleet/contract.ts` -- `rootEntryGlob` exported (one grammar, capturing); wildcard-only patterns refused.
- `src/fleet/status.ts` -- `not-a-symlink` rule pattern; five `unobserved` on a missing result; typed path code on the summary.
- `src/fleet/output.ts` -- path warn painted yellow; errored/unobserved skills cell by state; dead `too-large` bank code removed; `renderer manifest-undeclared` painted grey.
- `src/fleet/types.ts` -- `FleetProfilePathCode` with `root:<code>`, `root` dropped from the list; `not-run` dropped; `renderer-source-unobserved` documented; `FleetStatusAgentProfile.path.code` typed.
- `src/fleet/index.ts` -- root/python code vocabularies, their types, the skill-core record and three constants exported.
- `src/fleet/inventory.ts` -- JSDoc restored to `resolveProfileLayout`, its consumer named; blank lines.
- `tests/fleet-profile-regressions.mjs` -- 45 cases (34 + 11 new: unobserved shapes, singleton entries, unreadable root/gate/files, too-large + unit cap + backup stem, core-missing, empty identity, empty base, first-use lock, renderer child environment, host skip; plus scoped duplicate names, linked template config, `not-a-symlink` agreement, seven validator negatives, human-report cells, unit-file fixtures, three gated assertions).
- `tests/fleet-contract-regressions.mjs` -- three `profileRejects` negatives. `tests/fleet-health-regressions.mjs` -- exception-case cleanup in `finally`.
- `README.md` (kinds per field, `not-a-link`, `renderer-source-unobserved` causes, the allowlisted environment), `CHANGELOG.md` (`### Changed` bullet for `health.unjustified`), `mise.toml` (the lock footprint), `dist/` rebuilt.

### Review findings

- Four review layers (blind hunter 22, edge-case hunter 24, verification-gap 8 + 2 notes, intent alignment 12 observations) over the story diff since `c935037` (7,204 lines without `dist/`).
- intent_gap 0, bad_spec 0; **36 patches applied** (high 0, medium 3, low 33); 0 deferred; 19 rejected.
- Follow-up review recommendation: **true** -- patched counts high 0 / medium 3 / low 33, score 3 x 3 + 33 = 42 (threshold 5).

### Verification performed

- `npm run typecheck && npm run build` -- clean; `dist/` rebuilt and committed with the source.
- `npm test` -- 69/69 suites (417.3 s). `node tests/fleet-profile-regressions.mjs` -- 45 cases, none skipped, the live AC11 case ran; the health, contract, status, scaffold, provenance and MCP suites green on their own too.
- Two consecutive live runs of `fleet status --domain profile --json`: `data` byte-identical (`diff <(jq -S .data p1) <(jq -S .data p2)` empty); `git -C templates/hermes-agent status --porcelain` empty before and after.
- `fleet status --domain registry --json`: zero probes of kind `profile`. `fleet contract validate`: ok, schema 4, contract 1.3.0.
- Payload scan: 0 occurrences of `GENERATED FILE`, `op://`, `/home/`; no ISO timestamp.
- **AC11, independently recorded:** `python3 -B templates/hermes-agent/scripts/hermes-profile-config.py check --profile pjangler-pm` printed `OK: every profile config.yaml == deep_merge(base, delta)` and exited 0; the payload's `agents[pjangler-pm].profile.renderer` is `{state: "in-sync", sections: []}`; renderer source `ok` at gitlink `6bc683d8a265`, python `ok`.
- Live fleet: 28 registered, 26 real, 2 blocked at path (`symlink`), renderer checked 26 / in sync 26, bank ok 25 + 1 alias, 11 unregistered root entries (1 `approved-managed-exception`, 2 `retired-candidate`, 8 `unclassified`). Verdict `unhealthy`, `unjustified: 1` (the extras warn), `failed: 47`. Unchanged from the first pass.

### Residual risks

- DW-90 .. DW-96 stand as ledgered; nothing this pass changes their readings.
- On the skills field a `SKILL.md` that cannot be read or is over the cap still reads `core-replaced` (a `fail`): bytes that cannot be proven do not prove membership. The other four fields now say `unreadable`.
- Under `--agent`, `extras.reason` reads `agent-scope` even when the root is `root-unreadable`; the root error is on `profile.root` and `data.profile.root` regardless.
- `renderer-gitlink-missing` (a checkout root whose HEAD records no gitlink) still has no driving case; the nested-root and broken-git shapes that used to reach it now read `renderer-source-unobserved`.
