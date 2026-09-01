### DW-1: Many live Hermes registry fields carry no declared owner in the fleet contract.
origin: spec-deferred 229a382c3bbc
location: contracts/fleet-contract.yaml (authorities.*.writable_fields)
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: medium
reason: Cross-checked contracts/fleet-contract.yaml against the live ~/.hermes/agents-registry.yaml. Undeclared: hindsight.*, reporting.*, internal_role_name, slack.{team_id,team_name,bot_user_id,bot_id,bot_username,workspace,status}, telegram.{bot_id,bot_username,status}, hermes.codex_home, systemd.{cron_tick_timer,artifact_bridge_timer,watchdog_timer,checkpoint_timer}, and gateways.bloodbank.legacy_profile_consumers. Story 1.1's ACs require declaring an owner per domain, not per live key, and Story 1.2 explicitly owns "reads the configured canonical registries" - so exhaustive field coverage belongs there, driven by real registry reads rather than by hand.
status: partially addressed by `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
addressed: Story 1.2 reads both canonical registries for real and attributes every value it emits through `buildAuthorityIndex`, which resolves owners from the contract's `writable_fields` and nothing else. Verified against the live 28-agent registry: every field path the inventory reads - agents.{agent_id}.{repo,role,project_path,role_dir,profile_name}, agents.{agent_id}.plane.{workspace,project_id,identifier}, agents.{agent_id}.bloodbank.{enabled,gateway_scope,target_agent_id}, agents.{agent_id}.systemd.gateway_unit, projects.{slug}.{slug,repo_path}, projects.{slug}.ticket_provider.{identifier,board_id,workspace} - resolves to exactly one declared owner, so the declarations are now anchored by live reads rather than only by a second copy in the tests (which is also what DW-11 asked for). The gap is no longer invisible either: an undeclared path yields `source: null` plus an `authority-owner-undeclared` finding instead of an invented owner.
remaining: The DW-1 field list itself is untouched, because the inventory reads none of those keys. hindsight.*, reporting.*, internal_role_name, slack.*, telegram.*, hermes.codex_home, systemd.{cron_tick,artifact_bridge,watchdog,checkpoint}_timer and gateways.bloodbank.legacy_profile_consumers still carry no declared owner. They become load-bearing when a later story reads them: the retired timers in Story 1.8 (systemd topology), the messaging blocks in Story 1.10 (routing readiness), and gateways.bloodbank.legacy_profile_consumers wherever the retired per-agent consumer is finally drained. Declaring an owner is Story 1.1's surface, and this story's Block If forbids inventing one.

### DW-2: activation.routing_prerequisites is declared but no code evaluates it.
origin: spec-deferred 4ae962bf1f82
location: contracts/fleet-contract.yaml (activation.routing_prerequisites)
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: low
reason: The constraint vocabulary (equals-fleet, equals-agent-id, nonblank) is defined nowhere in src/fleet/, the field paths are unchecked, and because the activation block is intentionally open-keyed, a typo in the key name silently drops the whole block with no diagnostic. It becomes load-bearing in Story 1.10 (Bloodbank routing readiness), which is where the resolver that consumes it lands.
status: open

### DW-3: The dotted field-path grammar cannot distinguish file names from nested keys.
origin: spec-deferred a81dfebc7446
location: src/fleet/contract.ts (FIELD_PATH)
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: low
reason: scaffold.role.yaml, scaffold.SOUL.md and profiles.{profile_name}.config.delta.memory.provider share one namespace with no separator between a file identity and a key path. FIELD_PATH forbids a leading dot, so .gitignore had to be written as scaffold.gitignore, which no longer names the real file. Nothing validates that a {placeholder} is one of the known set, so {agentid} passes.
status: open

### DW-4: dist/ is tracked, so every build churns 1000+ lines of generated bundle into each diff.
origin: spec-deferred 241bdbafe8f2
location: dist/
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: low
reason: git ls-files dist returns tracked entries, and this story's diff carries 1000 changed lines of dist/index.js against 2300 lines of real source. This contradicts the repo-hygiene rule that generated output whose source is already tracked should not be committed, and it makes every review diff noisier than the change it represents. Pre-existing, repo-wide, and not caused by this story.
status: open

### DW-5: Several validator branches are unexercised by any test.
origin: spec-deferred 0f9c16e2d6e6
location: tests/fleet-contract-regressions.mjs
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: low
reason: No case covers an unknown top-level key, an unknown authority/projection/ classification/retired key, an invalid detect regex, an oversized (>1 MiB) contract, a non-integer schema_version, a compatibility range narrower than the supported range, or read_only true alongside a non-empty writable_fields. Coverage is not failing (the ratchet rose 57.07 to 57.62 percent), so this is hardening rather than a regression.
status: open

### DW-6: Two suites are red on main from a curl stub that no longer matches plane.sh.
origin: spec-deferred 3c03dfbfa18e
location: tests/pjan-23-regressions.mjs (makeCurlStub) vs templates/hermes-agent/template/.scripts/providers/plane.sh:204
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: medium
reason: pjan-23-regressions and pjan-67-trusted-lifecycle-regressions both fail at "plane: <METHOD> <path> returned invalid HTTP status {json body}". The provider reads the status from `curl -w '%{http_code}'` with the body sent to `-o <file>`; the test's curl stub ignores -o/-D/-w and writes the body to stdout, so the status check receives JSON. Verified pre-existing: both fail identically at baseline 0319f67 in a clean worktree, and this story's diff touches neither the tests, the provider, nor the hermes-agent submodule pinning it.
status: open

### DW-7: Sourcemaps are about 59 percent of the published npm tarball.
origin: spec-deferred 4c2b4b4b77c9
location: package.json (files) / tests/generated-project-lifecycle-regressions.mjs
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: low
reason: dist/index.js.map, dist/mcp-server.js.map and dist/prompt.js.map compress to ~904 KB of a 1.54 MB tarball. That is why the packed-size guard in generated-project-lifecycle-regressions had only 8 KB of headroom before this story and had to be raised. Dropping maps from package.json `files` would take the package to roughly 630 KB, but it changes what installed users get, so it is a packaging decision rather than part of this story.
status: open

### DW-8: Every suite runs dist/index.js and nothing proves dist matches src.
origin: spec-deferred 929cd684e703
location: scripts/run-tests.mjs
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: medium
reason: scripts/run-tests.mjs gates on `tsc --noEmit` -- its own header says a run against un-typechecked source "reports fiction" -- but it never builds. A stale bundle means the whole suite certifies old code while passing. dist happened to be current here (a rebuild was byte-identical), which is luck, not a guarantee. Repo-wide and pre-existing.
status: open

### DW-9: classifications[].entries[].lifecycle_state accepts any string.
origin: spec-deferred 3293ed08b818
location: src/fleet/contract.ts (validateClassifications)
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: low
reason: Required-field presence is enforced but the value is not: lifecycle_state "totally-made-up" validates clean. The only value in use today is `managed`, and the right closed vocabulary is not derivable from this story's intent -- the five activation states are a different axis. It belongs with the stories that actually populate the other classes.
status: open

### DW-10: scaffold.* and units.* are namespaces this contract invented, not key paths.
origin: spec-deferred 4262bd5ac39d
location: contracts/fleet-contract.yaml (authorities.tracked_role_scaffold, systemd_lifecycle)
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: medium
reason: The intent requires field ownership declared by "real key paths that exist today". projects.*, agents.* and gateways.* are real; scaffold.* and units.* are not paths in any store. The dotted grammar then makes them wrong rather than merely synthetic: FIELD_PATH forbids a leading dot, so `.gitignore` is declared as `scaffold.gitignore`, and `scaffold.sentinel.prompt.md` names a file that actually lives at `.scripts/sentinel.prompt.md`. Related to the grammar entry above but a distinct claim about the contract's content.
status: open

### DW-11: The contract's declarations are anchored only by a second copy in the tests.
origin: spec-deferred 64fd53515ff2
location: src/fleet/contract.ts (FIELD_PATH) / tests/fleet-contract-regressions.mjs
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: medium
reason: Validation of field paths is lexical (FIELD_PATH), so `projects.{slug}.repo_pathh` and the unknown placeholder `{agentid}` both pass. The tests re-assert the same strings as literals, so contract and test are two copies of one authorship and neither can notice the declaration going false against src/project/index.ts or templates/hermes-agent/.../80-registry.sh. Spot-checked: every declaration is accurate TODAY. This is a durability gap, and Story 1.2 is where the real registry reads land.
status: open

### DW-12: The npm-pack check is the least hermetic case in an otherwise sealed suite.
origin: spec-deferred 948cde8c0d49
location: tests/fleet-contract-regressions.mjs (the packed npm artifact check)
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: low
reason: It shells out to `npm pack` against the live working tree, so a concurrent edit or an untracked stray changes what is packed, and it requires npm and tar on PATH with no skip path (unlike the root-user case, which skips properly). It is also the only case that bypasses the cli() wrapper, so the four-root zero-write snapshot is not applied to it. Packing from a `git archive` snapshot would fix all three.
status: open

### DW-13: The agent-row identity key has no declared owner of its own.
origin: story-1.2 implementation
location: contracts/fleet-contract.yaml (authorities.agent_operational_records.writable_fields) / src/fleet/inventory.ts (buildAuthorityIndex)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: The contract declares `agents.{agent_id}.repo`, `.role`, `.role_dir` and so on, but never `agents.{agent_id}` itself - and the row KEY is a value the inventory has to attribute (it is the agent id, and it is one of AC5's conflict dimensions). `buildAuthorityIndex` therefore falls back to the modal owner of everything declared beneath the namespace, which answers `hermes-agent-registry` today because 20 of the 25 declared `agents.*` paths are that authority's. The answer is right, but it is derived rather than declared, and a future contract that moved enough `agents.*` paths to another authority would flip it silently. The same fallback covers `profiles.{profile_name}` (the profile directory, as opposed to the files inside it). Declaring the two namespaces explicitly is Story 1.1's surface; this story's Block If forbids inventing an owner here.
status: open

### DW-14: The agent-row identity key has no declared owner of its own.
origin: spec-deferred 0b7946ae09f7
location: contracts/fleet-contract.yaml (authorities.agent_operational_records) / src/fleet/inventory.ts (buildAuthorityIndex)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: The contract declares agents.{agent_id}.repo, .role, .role_dir and so on, but never agents.{agent_id} itself -- and the row KEY is a value the inventory has to attribute: it is the agent id, and it is one of AC5's conflict dimensions. buildAuthorityIndex therefore falls back to the modal owner of everything declared beneath the namespace, which answers hermes-agent-registry today because 20 of the 25 declared agents.* paths are that authority's. The answer is right, but it is derived rather than declared, and a contract that moved enough agents.* paths elsewhere would flip it silently. The same fallback covers profiles.{profile_name}. Declaring the two namespaces is Story 1.1's surface, and this story's Block If forbids inventing an owner.
status: open

### DW-15: DW-1's undeclared field list is still undeclared; this story reads none of it.
origin: spec-deferred f9d4bef858d0
location: contracts/fleet-contract.yaml (authorities.*.writable_fields)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: Every field path the inventory attributes resolves to exactly one declared owner against the live 28-agent registry, so DW-1 is closed for the fields this story reads. hindsight.*, reporting.*, internal_role_name, slack.*, telegram.*, hermes.codex_home, systemd.{cron_tick,artifact_bridge, watchdog,checkpoint}_timer and gateways.bloodbank.legacy_profile_consumers remain undeclared, because inventory reads none of them. They become load-bearing in Story 1.8 (systemd topology) and Story 1.10 (routing readiness).
status: open

### DW-16: One store, three declared authorities, and `stores[].owner` reports the first.
origin: spec-deferred 3843c755939b
location: src/fleet/inventory.ts (authorityFor / storeView)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: `authorityFor` returns the first authority whose `store` matches. The contract declares three against `hermes-agent-registry`: agent_operational_records (owner hermes-agent-registry), board_identity_projection (owner PROJECT-REGISTRY) and bloodbank_activation. So `data.stores[].owner` says hermes-agent-registry and silently hides the one cross-store write the contract goes out of its way to call out. A derived answer, in a module whose stated rule is that it never invents an owner. Reporting the owner SET, or the authority ids, is the fix.
status: open

### DW-17: A missing PROJECT registry aborts the whole run instead of degrading.
origin: spec-deferred 2a2a69fd049a
location: src/fleet/inventory.ts (readProjectRegistryRaw / storeView)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: `readProjectRegistryRaw` throws NOT_FOUND before any row is built, so a host with a Hermes registry but no ~/.config/pjangler/projects.yaml gets exit 3 and NO inventory -- rather than 28 rows each carrying `project-record-missing`, which is what the uncorrelated case already does when the file merely lacks the record. Two consequences of the same choice: `FleetStoreView.exists` can never be false and the `parse: "unreadable"` fallback is unreachable, because `raw` is never null by the time `storeView` is called.
status: open

### DW-18: The store env keys and both registry path resolvers are re-derived, not read.
origin: spec-deferred ee567c48ce60
location: src/fleet/inventory.ts (resolveInventoryStores)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `envKeys` is the literal ["HERMES_AGENTS_REGISTRY","HERMES_FLEET_REGISTRY_FILE"] / ["PJ_PROJECT_REGISTRY"], duplicating `authorities.*.store_env`, which the contract already declares and `fleet contract validate` already projects. `resolveInventoryStores` likewise reimplements the exported `hermesAgentsRegistryPath` and `projectRegistryPath`, and diverges from both (it adds the fleet-key fallback and applies expandHome). Same class as the re-hardcoding the story's Always list forbids for unit patterns, one step outside the three surfaces that list names.
status: open

### DW-19: A duplicate-key conflict group names one participant, itself.
origin: spec-deferred 114ba23d42b0
location: src/fleet/inventory.ts (detectConflicts, duplicate-key branches)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: `participants: [agentId]` for the duplicate-agent-id dimension, and the same shape for duplicate project keys. The finding renders as "candystore-pm is claimed by candystore-pm", the group cannot say WHICH two rows collided, and `matchException`'s exact-set rule then forces an operator to declare `participants: [<the-id-itself>]` to permit it. Occurrences (index-qualified) rather than the key repeated.
status: open

### DW-20: Values are bounded BEFORE they are lstat'd, correlated, and matched.
origin: spec-deferred 25b181d0725c
location: src/fleet/inventory.ts (scalar / readKeyedStore key bounding)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: `scalar()` runs every registry value through `bounded()` (512-char cap, C0 stripped, CR/LF folded) and the bounded string is what `classifyPath` lstats and what correlation looks up -- so a path longer than 512 chars, or one containing a control character, is classified and correlated against a value the registry does not contain, and reports `absent` for a directory that exists. Agent identity keys are bounded to 128 in `readKeyedStore` and `--agent` matches the truncated key, so an id longer than 128 chars is inventoried but can never be selected: NOT_FOUND, exit 3, for a genuinely registered agent.
status: open

### DW-21: `health.healthy` conflates fleet drift with an envelope presentation cap.
origin: spec-deferred 6873f8f39379
location: src/fleet/inventory.ts (health.healthy)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `truncated.length === 0` is a conjunct of `healthy`, so a fleet of 1001 well-formed agents, or one that trips MAX_FINDINGS, gets the identical UNHEALTHY verdict a real identity conflict produces. `health.truncated` already exists as its own signal. Defensible as "you did not see all of it", but the verdict should read from the fleet, and the two states should not be indistinguishable to a consumer.
status: open

### DW-22: Nothing drives the row cap, so FLEET_INVENTORY_MAX_ROWS is unproven.
origin: spec-deferred 3f62718a26a7
location: tests/fleet-inventory-regressions.mjs
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: No case produces more than MAX_ROWS rows or more than MAX_FINDINGS findings, so neither the rows clip nor its `truncated` note has ever executed; the findings-clip assertion is conditional and never fires on a 28-agent fleet. The cap is exactly the code path whose first cut was already wrong once in this story (it stopped pushing at the cap, so the clip could never be recorded).
status: open

### DW-23: `--agent` leaves `data.findings` fleet-wide, undocumented and unpinned.
origin: spec-deferred ee89678698d3
location: src/fleet/inventory.ts (scope filter) / README.md
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: Findings are never filtered by scope, so `--agent pjangler-pm` returns every other agent's findings. That is consistent with the totals/health/conflicts rule and is probably right, but the README bullet enumerates only `data.totals`, `data.health` and `data.conflicts`, and no check pins the behaviour either way -- so it can flip silently.
status: open

### DW-24: The exported surface is inconsistent and partly uncallable in typed code.
origin: spec-deferred 7cf364e9d96d
location: src/fleet/inventory.ts / src/fleet/index.ts
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `readAgentRegistryRaw`/`readProjectRegistryRaw` are exported and barrelled but their return type `RawStore` is not; `detectConflicts` is exported while its `ConflictInput` parameter type is not, so it cannot be called from typed code; `buildInventoryRow` and `ClassifyPathOptions` are exported from the module but absent from `src/fleet/index.ts`; `FleetFindingSeverity` is missing from the barrel while `FLEET_FINDING_SEVERITIES` is present.
status: open

### DW-25: Two of the four live symlinked profile directories are reported; two are invisible.
origin: spec-deferred fc8474c21851
location: src/fleet/inventory.ts (per-row profile classification)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: ~/.hermes/profiles holds four symlinks. Inventory is row-driven, and only `delonet-company-reporter` and `hermes-agent-pm` are named by a registered agent's profile_name, so those two raise `profile-path-symlinked`. `intelliforia-voice-agent` and `stemjangler-adversarial-review` are symlinks in the declared profile root that no row reaches, so the contract violation they represent is reported by nothing. A profile-root sweep is the missing half; AC8 is written per-row, so this is beyond it.
status: open

### DW-26: The tracked contract has no exercised managed-exception path.
origin: spec-deferred 6d10ef420003
location: tests/fleet-inventory-regressions.mjs (packageWithContract)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `FleetInventoryOptions.contract` exists in the core and is reachable from no CLI caller (the command ships four flags by design, and --contract is not one). The suite proves the exception mechanism by RELOCATING the built bundle beside a mutated contract and leaning on the walk-up in `resolveFleetContractPath`. That is a real end-to-end run, but it exercises a synthetic package root; nothing exercises an exception against contracts/fleet-contract.yaml itself.
status: open

### DW-27: The independence of `source_rows` is not observable from outside the CLI.
origin: spec-deferred edd731a20837
location: src/fleet/inventory.ts (countCollectionRows) / tests/fleet-inventory-regressions.mjs
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: This pass replaced the tautological count (items.length over the array the row builder walks) with a genuinely separate parse, and PROVED it by mutation: breaking the reader's node extraction now yields source_rows 28, emitted_rows 0 and an UNHEALTHY verdict where it used to yield "healthy, 0 of 0". But no black-box check can inject a reader defect, so the suite pins only the consequence (raw keys, duplicates included; an unreadable collection is loud). A source-shape assertion was deliberately NOT added: a text match would be green because the text matched, not because the property held.
status: open
