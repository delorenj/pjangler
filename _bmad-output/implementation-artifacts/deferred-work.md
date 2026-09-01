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
note: Story 1.5 gave the answer a typed home (`lifecycle.capability_readiness`, reported `unproven`) without evaluating the prerequisite list, deliberately -- deriving a routing verdict from registry fields is the inference story 1.10 exists to prevent. Carried forward as DW-71.

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
status: closed
addressed: Verified on `d5caa98` while story 1.5 was in progress: `node tests/pjan-23-regressions.mjs` and `node tests/pjan-67-trusted-lifecycle-regressions.mjs` both pass. The curl stub now honours `-o`, `-D` and `-w` (`91e2128`) and the PJAN-67 ordering check states what it means (`5f27761`), so the status line this entry carried was stale evidence rather than a red suite. Do not attribute either suite to a later story on its word.

### DW-7: Sourcemaps are about 59 percent of the published npm tarball.
origin: spec-deferred 4c2b4b4b77c9
location: package.json (files) / tests/generated-project-lifecycle-regressions.mjs
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: low
reason: dist/index.js.map, dist/mcp-server.js.map and dist/prompt.js.map compress to ~904 KB of a 1.54 MB tarball. That is why the packed-size guard in generated-project-lifecycle-regressions had only 8 KB of headroom before this story and had to be raised. Dropping maps from package.json `files` would take the package to roughly 630 KB, but it changes what installed users get, so it is a packaging decision rather than part of this story.
measured: 2026-09-01 (story 1.4). Published tarball 1_864_558 bytes; the same tree with `dist/*.map` excluded from package.json `files` packs to 729_149 bytes -- 61% of every download is sourcemap. The size gate in tests/generated-project-lifecycle-regressions.mjs has now been raised three times (1_500_000 -> 1_750_000 -> 1_850_000 -> 1_950_000) and each raise has been mostly map bytes, so it no longer constrains anything it was written to constrain. The one-line fix is replacing `"dist"` in package.json `files` with `"dist/**/*.js"` + `"dist/assets"`; the cost is that a consumer's stack trace resolves to bundle offsets in an unminified bundle rather than to original source. That is a publishing decision with an owner, which is why three stories in a row have declined to make it in passing.
status: open
note: Story 1.5 raised the packed-tarball ceiling for the FOURTH time -- 1 947 627 -> 1 975 285 bytes for roughly a thousand lines of new source, against a 1 950 000 gate. The bundles are 1.2 MB and 1.0 MB; their sourcemaps are 2.6 MB and 2.3 MB. Every raise so far has been paying for sourcemap. The next story to reach the ceiling should take this entry's fix rather than move the number again; the gate's own comment now says so.


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
location: src/fleet/inventory.ts (resolveInventoryStores) / src/fleet/provenance.ts (expandHome, isRecord, nonEmptyString)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `envKeys` is the literal ["HERMES_AGENTS_REGISTRY","HERMES_FLEET_REGISTRY_FILE"] / ["PJ_PROJECT_REGISTRY"], duplicating `authorities.*.store_env`, which the contract already declares and `fleet contract validate` already projects. `resolveInventoryStores` likewise reimplements the exported `hermesAgentsRegistryPath` and `projectRegistryPath`, and diverges from both (it adds the fleet-key fallback and applies expandHome). Same class as the re-hardcoding the story's Always list forbids for unit patterns, one step outside the three surfaces that list names.
status: open, NEITHER reduced nor closed by `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`; net slightly extended
addressed: Story 1.3 reused every resolver the spec named rather than re-deriving one: `resolveTemplateConfigPath` and `readTomlScalar` from `src/project/boardUrl.ts`, `ticketProviderFleetEnvPath` and `resolvePjanglerRoot` from `src/project/index.ts`, `resolveFleetContractPath`/`loadFleetContract`/`validateFleetContract` from `src/fleet/contract.ts`, and `resolveInventoryStores`/`readAgentRegistryRaw`/`buildAuthorityIndex`/`classifyPath` from `src/fleet/inventory.ts`. It also EXPORTED two things rather than copying them: `readShellAssignments` (`src/project/index.ts`), because a second copy of the credential allowlist would be a second copy of the risk, and `resolveProfileLayout` (`src/fleet/inventory.ts`), because a row's `profile_path` is home-redacted for display and cannot be opened.
remaining: The specific re-derivations DW-18 names are untouched -- `envKeys`, `hermesAgentsRegistryPath`, `projectRegistryPath` -- because story 1.3 calls `resolveInventoryStores` rather than replacing it. And the ledger should record that the class GREW by three: `src/fleet/provenance.ts` carries its own `expandHome`, `isRecord` and `nonEmptyString`, each a third copy of a helper that is private to `src/project/index.ts` and `src/fleet/inventory.ts`. Exporting the trio from one place is the fix; it was out of scope here because the story's Never list forbids reworking story 1.2's module beyond the threading it names.

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
note: Unchanged, and this entry is about the fleet INVENTORY. Story 1.5 did not widen it: `FleetStatusHealth.healthy` is a different field on a different command, keeps provenance's split, and excludes truncation -- and the new `health.verdict` reads from `healthy`, `complete`, `stale` and `unjustified` rather than folding a presentation cap into any of them.

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

### DW-28: An ancestor symlink defeats every profile-path classification beneath it.
origin: spec-deferred e48d265748db
location: src/fleet/inventory.ts (classifyPath)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: `classifyPath` lstats the leaf only. If `~/.hermes/profiles` itself were a symlink, every derived profile path would lstat through it to a real directory and classify `ok`, so the contract's `symlink_allowed: false` would be violated by the root and reported by nothing. Same blind spot as the profile-root sweep, one level up.
status: open

### DW-29: `expected_units` discards which pattern produced which name.
origin: spec-deferred 25f78968641a
location: src/fleet/inventory.ts (unitPatternsFrom) / src/fleet/types.ts
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `unitPatternsFrom` sorts the `per_agent` keys, maps to values and drops the keys, so the row emits a bare `string[]`. A consumer cannot tell the gateway service from the heartbeat timer, which is exactly the distinction the drift comparison had to be repaired to make. The contract declares them as named roles; the row flattens them.
status: open

### DW-30: `classification` is a constant dressed as an attributed field.
origin: spec-deferred 0f34d8bc5734
location: src/fleet/inventory.ts (buildInventoryRow, classification)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: Every well-formed row gets the literal `managed_agent` at state `resolved`; malformed rows get `unclassified`. Neither literal is typed against `FLEET_CLASSIFICATION_IDS` in the same `types.ts`, so a typo compiles and ships, and the field can never report `intentionally_unmanaged` or `retired` even though the contract declares both and four live profile entries are exactly the `intentionally_unmanaged` shape. AC3's "lifecycle classification" is satisfied by a value that carries no information.
status: open
addressed (both halves): The TYPE half -- `FleetInventoryRow.classification` is `FleetFieldValue<FleetClassificationId>`, so a typo no longer compiles. The RESOLUTION half -- `declaredRowClass` (`src/fleet/inventory.ts`) promotes a row to `retired` or `intentionally_unmanaged` when the contract has recorded an entry naming it, matched either by the entry's `participants` list (the convention `matchException` already uses) or by a CONCRETE `source: agents.<agent_id>`. The `{agent_id}` placeholder form deliberately claims nobody: it is the shape of a path, not an instance, and honouring it would let one entry sweep the whole fleet into a class no operator ruled on. `managed_agent` remains the default and a malformed row is never promoted.

DECLARED ONLY, and that is the boundary. Nothing infers a class from an observed conflict or from a permitted exception -- the first cut did (a row whose every conflict group was contract-permitted became `intentionally_unmanaged`) and it made `classifyMember`'s `else if (classification === \"intentionally_unmanaged\")` arm DEAD CODE, because such a row always has a registry `fail` and never reaches the arm. The `exception` member bucket therefore had one live path and one unreachable one, and satisfied the acceptance criterion's letter while being unable to hold a non-zero count for a healthy agent. It is now reached by making the branch fire: `tests/fleet-health-regressions.mjs`, \"a contract-declared lifecycle class puts its row in the exception bucket\", declares one entry, asserts the row resolves to it and the bucket counts one, and pins it as a DELTA against the identical run on a contract that declares nothing. Mutation-checked: stubbing `declaredRowClass` to return null turns that case red.

The shipped contract declares zero entries in both classes, so every live row still resolves `managed_agent` and `fleet inventory`/`fleet provenance` `data` is byte-identical to the pre-story build read against the same contract -- verified directly, not inferred.

Still open, and it is STORY 1.7's: `managed_shared_service` remains unreachable from a registry row (it describes state that is not a per-agent row at all), and nothing OBSERVED can put a row in any class -- the four live symlinked profile-root entries this ticket's original evidence names are exactly the `intentionally_unmanaged` shape but must be classified by an observer, not by a declaration. \"Prove Generated Profile Health and Classify Extras\" owns that; this story deliberately shipped contract-declared resolution and no observer.

### DW-31: The `outside-root` classification is unreachable from every call site.
origin: spec-deferred d3e97c666ddb
location: src/fleet/inventory.ts (classifyPath call sites)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `classifyPath` applies containment only when `root` is passed. `project_path` and `role_dir` pass none; `runtime_path` passes `role_dir` with a value built as `join(role_dir, "runtime")`, inside by construction; `profile_path` passes the profile root with a value built from a segment already forced through `isSafePathSegment`. AC8 names "a path outside the declared profile root" as a scenario and `FLEET_PATH_CLASSIFICATIONS` declares the state, but no call site or test can produce it. Either a declared profile path becomes readable input, or the AC is satisfied vacuously and should say so.
status: open

### DW-32: Malformed project-registry records are normalized in silence.
origin: spec-deferred 6badffcd11ec
location: src/fleet/inventory.ts (projectIndex)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: `projectIndex` does `isRecord(entry.value) ? entry.value : {}` and raises no finding and no counter, then `slug: nonEmptyString(record.slug) ?? entry.key` INFERS the slug from the mapping key -- an inference the module header forbids. Agents get `agent-row-malformed`, `totals.malformed_rows` and a raw-key row; projects get nothing equivalent. There is no `project_records_malformed`.
status: open

### DW-33: `matchException` ignores `lifecycle_state` and `kind`.
origin: spec-deferred 201b41cb5abb
location: src/fleet/inventory.ts (matchException)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: It matches on `source` plus an exact `participants` set and nothing else, so an entry whose `lifecycle_state` is `retired` or `rejected` keeps suppressing its conflict forever, and any `intentionally_unmanaged` entry that happens to carry a `participants` list can permit a group it was never written for. The design note's own example shape carries `kind: identity-conflict-exception` and `lifecycle_state: accepted`; neither is enforced.
status: open

### DW-34: Two agents legitimately sharing one project read as an identity conflict.
origin: spec-deferred f1e3a37092d0
location: src/fleet/inventory.ts (DIMENSIONS.projectId) / the story's AC5
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: AC5 names project id as a conflict dimension and the code implements it, so this is not a deviation -- but the project registry models `projects.{slug}.agents` as a MAP, which makes several agents per project the schema's normal case. A PM plus a reviewer on one repo reports `healthy: false` indistinguishably from real contention. The dimension probably wants the registry's own `agents` map as its permission list rather than a blanket group.
status: open

### DW-35: A duplicate agent id stamps both rows and emits the finding twice.
origin: spec-deferred 3f00cf887d1d
location: src/fleet/inventory.ts (conflict stamping loop)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `byParticipant` is keyed by agent id, so when one id names two rows every group of that id stamps BOTH rows' cells -- including a cell whose value differs between them and is therefore uncontested -- and emits two byte-identical `identity-conflict` findings. Same class as the mis-stamping a previous pass fixed, reachable only through a duplicate key.
status: open

### DW-36: Conflict detection trims whitespace; correlation and `--agent` do not.
origin: spec-deferred 4294c28c4266
location: src/fleet/inventory.ts (claim / correlation / scope filter)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `claim()` normalizes NFC and trims before grouping, while `projectsBySlug.get` and the `--agent` filter compare the raw bounded value. An id or slug carrying a trailing space is therefore groupable but not selectable and not correlatable -- three comparisons of one value under two rules.
status: open

### DW-37: `authority-owner-undeclared` is raised once per row.
origin: spec-deferred 367785a4c4d4
location: src/fleet/inventory.ts (buildInventoryRow)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: It describes a property of the CONTRACT, not of a row, so a single contract defect would add one error finding per agent and scale `health.contract_violations` with fleet size. It belongs beside the other contract-level findings in `collectFleetInventory`, with `agent_id: null`.
status: open

### DW-38: The human report caps rows and findings but not conflict groups.
origin: spec-deferred 8019d29f3738
location: src/fleet/output.ts (formatFleetInventoryReport)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `data.conflicts` is capped at `MAX_CONFLICT_GROUPS` (500) and the report prints every group it is handed, three lines apiece. A badly drifted fleet buries the capped sections under up to 1500 lines. Every other section of the report has a "... N more" line.
status: open

### DW-39: `isSafePathSegment` duplicates `validateSafePathSegment` with nothing pinning them.
origin: spec-deferred 69599f377d7f
location: src/fleet/inventory.ts (isSafePathSegment) / src/project/index.ts:1018
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: The comment asserts they are the same rule, and the AC requires values to pass `validateSafePathSegment`, but the regex is copied (minus the `win32.isAbsolute` clause) and no check ties the two. Tightening the exported guard leaves the inventory's copy behind, silently.
status: open

### DW-40: The one real-registry case bypasses the zero-write harness.
origin: spec-deferred 4f9e6e5ead09
location: tests/fleet-inventory-regressions.mjs (the live-registry case / snapshot)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: It spawns directly rather than through `cli()`, so the four-root content+mtime snapshot never applies and read-only is proven by fingerprinting exactly two files. Every `.project.json` the command opens across the live fleet, and the profile root, are unchecked on the one run that touches real paths. `snapshot()` is also shallower than the spec's `git status --porcelain` line implies: it records names and types of top-level ROOT entries, so a content change to a tracked file outside `contracts/` would not be seen.
status: open

### DW-41: Two duplicate-key fixtures share one filename and assume `agents:` is last.
origin: spec-deferred e29edfd4654a
location: tests/fleet-inventory-regressions.mjs (rawCopy fixtures)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `rawCopy("duplicate-agent-key", ...)` is written twice with different content, and both build the duplicate by appending two-space-indented text to the end of the file. If the registry's top-level key order changes, the appended block nests under whatever key is last and the fixture silently tests something else.
status: open

### DW-42: A numeric agent key collides with a string key into a false duplicate.
origin: spec-deferred c96c37d83cdd
location: src/fleet/inventory.ts (readKeyedStore key coercion / idCounts)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `bounded(String(rawKey ?? ""), 128)` turns a YAML key of `1234` into `"1234"`, which then matches a genuine string key `"1234"` in `idCounts` and mints a duplicate-identity group for two rows that are not duplicates. Two null or empty keys likewise both collapse to `""`. Same family as the 128-char key bounding already deferred.
status: open

### DW-43: `manifest-notes-truncated` can never fire.
origin: spec-deferred 07f7b70374a8
location: src/fleet/inventory.ts (manifest notes cap)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `manifestNotes` receives at most four entries from the four `compare()` calls, or one string on the unreadable branch, and `MAX_MANIFEST_NOTES` is 10. The announced-clip finding a previous pass added, and its `.slice()`, are both dead as written -- correct if the note set ever grows, inert today.
status: open

### DW-44: Exits 4 and 5 are documented and specially handled but exercised by nothing.
origin: spec-deferred 30b196b9c778
location: tests/fleet-inventory-regressions.mjs / src/fleet/cli.ts (contractFault)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: The README ships a row for each and `cli.ts` has a dedicated `contractFault` branch producing different `next_actions`. No check drives a contract fault, even though `packageWithContract` already builds a relocated package around a mutated contract and could produce one. `profile-layout-undeclared` and `service-model-undeclared` are unreachable in the suite for the same reason.
status: open
note: Still open for 4 and 5. Story 1.5 added exits 10 and 11 (`--exit-code` projecting `data.health.exit_category`) and exercises both, plus the case that a COMMAND failure still wins over them -- `tests/fleet-health-regressions.mjs`, "--exit-code projects the category". The contract-fault bands are unchanged and still unexercised.

### DW-45: `row.findings` can name a code whose finding the cap dropped.
origin: spec-deferred cd3e9594019e
location: src/fleet/inventory.ts (note / addFinding)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: `note()` pushes the code onto the row before `addFinding` decides whether the MAX_FINDINGS cap has room. Past the cap a row advertises a code that appears nowhere in `data.findings`. `truncated` records the drop, so it is disclosed in aggregate, but the per-row join still dangles -- the same shape as the conflict clip fixed in this pass.
status: open

### DW-46: `health.unresolved_rows` is an undocumented hand-picked triple.
origin: spec-deferred 027a820ff764
location: src/fleet/inventory.ts (health.unresolved_rows) / README.md
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: A row counts as unresolved when any of `project_id`, `profile_path`, `role_dir` is not `resolved` -- excluding `repo_path`, `runtime_path`, `board`, `bloodbank_*` and `activation`, which are equally capable of being unresolved. The human report now prints "19 unresolved" as a headline with the composition defined nowhere and pinned by nothing, so adding or dropping a field from that expression moves the number silently.
status: open

### DW-47: A scoped run can flip the verdict on a fleet past the row cap.
origin: spec-deferred 2982a690fe50
location: src/fleet/inventory.ts (truncated / health.healthy vs the scope filter)
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: medium
reason: `truncated` is computed AFTER the `--agent` filter, and `truncated.length === 0` is a conjunct of `healthy`. On a fleet over `FLEET_INVENTORY_MAX_ROWS`, `--agent X` therefore reports `healthy: true` where the unscoped run reports `false` -- precisely what the README says a scoped run must never do. The two existing entries name the conflation and the untestability of the cap; neither names this interaction, and the check that pins the README promise uses a conflict rather than a cap, so it cannot see it.
status: open

### DW-48: Follow-up review still recommended for 1-2-discover-the-complete-fleet-and-detect-identity-conflicts after the damping cap was spent
origin: review-budget-followup
location: n/a
source_spec: `spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md`
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260901-004935-c48b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-49: Provenance facts about host artifacts have no declared authority owner.
origin: spec-deferred story-1.3
location: contracts/fleet-contract.yaml (authorities.*.writable_fields) / src/fleet/provenance.ts (ownerFor)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: medium
reason: Three fleet-scoped facts -- `fleet.hermes_bin`, `fleet.hermes_repo`, `fleet.registry_file` -- compare `~/.config/hermes-agent-template/config.toml` against `~/.hermes/fleet.env`. Neither file is a store the contract declares, so no `writable_fields` entry covers those field paths and `ownerFor` reports `owner: null` plus one deduplicated `authority-owner-undeclared` finding. That is the honest answer and the story's Block If forbids inventing one, but it means the host's own pin -- the value every agent fact is compared against -- is the one value with no declared authority. Declaring a `hermes_host_configuration` authority (store `hermes-template-config`, store_env `HERMES_TEMPLATE_CONFIG`/`HERMES_FLEET_ENV`) is Story 1.1's surface.
status: open

### DW-50: Template and scaffold facts are attributed by namespace walk-up, not by a declared leaf.
origin: spec-deferred story-1.3
location: src/fleet/provenance.ts (ownerFor) / contracts/fleet-contract.yaml (authorities.tracked_role_scaffold)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: low
reason: `template.gitlink`, `template.remote_url`, `template.worktree_clean` and `scaffold.template_ref` carry field path `scaffold`, which the contract declares no leaf for. `ownerFor` walks up and `buildAuthorityIndex`'s modal-namespace fallback answers `hermes-agent-template` -- correct today, because all eight declared `scaffold.*` paths are that owner's and the answer is unanimous rather than merely modal. It is still derived rather than declared, and a contract that moved enough `scaffold.*` paths elsewhere would flip it silently. Same class as the `agents.{agent_id}` gap story 1.2 recorded.
status: open

### DW-51: Provenance inherits the inventory's project-registry hard dependency.
origin: spec-deferred story-1.3
location: src/fleet/provenance.ts (collectFleetProvenance) / src/fleet/inventory.ts (readProjectRegistryRaw)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: medium
reason: `collectFleetProvenance` calls `collectFleetInventory` -- deliberately, because the story's Never list forbids rebuilding registry or identity policy here, and because `--project-registry` must mean something on both commands. But `readProjectRegistryRaw` throws NOT_FOUND before any row is built (DW-15), so a host with a Hermes registry and no `~/.config/pjangler/projects.yaml` gets exit 3 and NO provenance -- even though provenance reads nothing out of the project registry. Provenance is strictly more fragile than the question it answers requires. Fixing DW-15 fixes this; degrading the project store to a finding is the same one-line change for both.
status: open

### DW-52: A remote spelled ssh and a pin spelled https are reported as drift.
origin: spec-deferred story-1.3
location: src/fleet/provenance.ts (addCheckoutFacts, hermes.checkout_identity)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: low
reason: The configured pin declares `https://github.com/delorenj/hermes-agent.git`; the pinned release checkout on this host has `git@github.com:delorenj/hermes-agent.git`. Same repository, two transports, and `hermes.checkout_identity` reports `mismatch` for all six correctly-pinned agents. Normalizing the two spellings would be this command inventing an equivalence it cannot verify (the two URLs are not required to resolve to one repository), so it reports what it sees -- but an operator reading 15 identity mismatches cannot tell the six transport spellings from the nine that really are NousResearch. A `remote_equivalence` declaration in the contract, or a separate `transport` sub-fact, is the fix.
status: open

### DW-53: `--project-registry` is accepted by `fleet provenance` and changes nothing it reports.
origin: spec-deferred story-1.3
location: src/fleet/cli.ts (fleet provenance) / src/fleet/mcp.ts (FLEET_TOOL_INPUT)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: low
reason: The spec requires the flag on both commands so the two adapters share one option surface, and it is honoured -- it is threaded into `collectFleetInventory`, which provenance calls. But no provenance FACT reads the project registry, so the only observable effect of the flag is which file a NOT_FOUND names. An operator could reasonably expect it to change the answer. Either provenance grows a project-correlated fact (story 1.6 territory), or the flag's no-op nature is documented at the flag rather than only here.
status: open

### DW-54: The whole provenance suite, and the MCP fleet block, skip on any host without the operator's three live sources.
origin: review-deferred story-1.3
location: tests/fleet-provenance-regressions.mjs (SkipSuite guard) / tests/mcp-server-regressions.mjs (fleet block)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: medium
reason: Every case derives from a copy of `~/.hermes/agents-registry.yaml`, `~/.config/pjangler/projects.yaml` or `~/.config/hermes-agent-template/config.toml`, so the suite throws `SkipSuite` for its ENTIRE body when any is absent -- taking the mise-gate, README, ledger and source-text checks with it, none of which needs a live source. On a fresh clone or in CI the story's read-only, credential-exclusion, cancellation and CLI/MCP-parity guarantees are verified by nothing, and the suite prints one SKIP and exits 0. The skip is loud and the derive-from-real rule is deliberate (a fixture would confirm the assumption instead of testing it), so this is not a defect in the idiom -- it is that the host-independent cases are inside the host-gated block. Splitting them out is the fix and it is mechanical.
status: open

### DW-55: `sources[].parse` reports a stat, not a parse, and `salvaged` is unreachable.
origin: review-deferred story-1.3
location: src/fleet/provenance.ts (resolveProvenanceSources, readConfiguredPin)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: medium
reason: `FleetProvenanceSourceView.parse` is typed `"ok" | "salvaged" | "unreadable" | "unread"`, but it is set once from an `lstat`: a path that is a file, directory or symlink is `"ok"`. `readConfiguredPin` then swallows read failures with `catch { text = ""; }` and nothing updates the field. A template config that exists but is unreadable, is a directory, or exceeds `CONFIG_MAX_BYTES` reports `exists: true, parse: "ok"` with every pin silently `missing` and no finding -- an operator reading `parse: ok` beside a wall of `missing` has been told the file was read. `"salvaged"` is produced by nothing at all. The fix is to set `parse` where the parse actually happens and emit a `provenance-source-unreadable` finding when an existing source yields no text.
status: open
note: Unchanged. Story 1.5's `evidence` axis is about how strongly an OBSERVATION is supported, not about whether a source was parsed, so `parse: "ok"` beside a wall of `missing` is still the same lie in the provenance payload. The fix is still "set `parse` where the parse happens, and raise `provenance-source-unreadable`".

### DW-56: The `--agent` id is validated after the whole probe sweep has run.
origin: review-deferred story-1.3
location: src/fleet/provenance.ts (collectFleetProvenance, the NOT_FOUND throw)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: low
reason: The `NOT_FOUND` check runs after `addTemplateFacts`, every deduplicated checkout probe and every per-agent fact have been built, so `fleet provenance --agent typo` spawns and reaps the full probe sweep before failing. Behind a hanging checkout it can exit 7 (`TIMEOUT`) rather than the documented 3, which makes a typo indistinguishable from a slow fleet. The envelope and exit code the matrix specifies are correct on a healthy host; the work avoided is not. Validating the id against `agentRaw.entries` before the first probe is a move, not a redesign.
status: open

### DW-57: Provenance builds and discards a full inventory to read one integer.
origin: review-deferred story-1.3
location: src/fleet/provenance.ts (collectFleetProvenance) / src/fleet/inventory.ts
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: medium
reason: `collectFleetInventory` is called solely for `inventory.totals.registered_agents`, which is `allRows.length` -- identical to the `agentRaw.entries.length` provenance already holds. The cost is a second full registry parse plus an `lstat` and a `.project.json` read per agent, and, through `readProjectRegistryRaw`, the hard project-registry dependency recorded as DW-51: a host with a Hermes registry and no `~/.config/pjangler/projects.yaml` gets exit 3 and NO provenance from a command that reads nothing out of that store. Calling the inventory was the right call for `--project-registry` to mean the same thing on both commands (the story's Never list forbids rebuilding registry policy here); reading one integer out of the result is what makes the cost hard to justify. Compounds DW-51 and DW-15.
status: open

### DW-58: `withSignals` removes its listeners without aborting its controller.
origin: review-deferred story-1.3
location: src/fleet/cli.ts (withSignals)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: low
reason: The `finally` block calls `process.off` for both signals but never `controller.abort()`, so a `TIMEOUT` or any other throw escaping `body` leaves in-flight probe children unaborted. MEASURED, and it does not currently leak: `--deadline-ms 2500` behind a pid-recording hang shim exits 7 with zero survivors, because each probe's own `min(probeTimeoutMs, remainingMs)` timer kills its child first. So this is defence-in-depth that is currently redundant rather than an observable defect -- which is exactly why it should be written down instead of patched blind: `controller.abort()` in `finally` is one line, but the case that would prove it load-bearing does not exist yet.
status: open

### DW-59: `PROBE_MAX_BYTES` counts UTF-16 code units, and a dirty-tree probe buffers output it only tests for emptiness.
origin: review-deferred story-1.3
location: src/fleet/runtime.ts (probe)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: low
reason: `child.stdout.setEncoding("utf8")` then `size += chunk.length` counts code units, not bytes, so the cap is name-inaccurate by up to 3x on non-ASCII paths. Separately, `git status --porcelain` on a very dirty tree is accumulated into `out` in full when the only thing ever read from it is `value === ""` -- so a checkout that is merely very dirty can trip the byte cap and be reported `unobserved` rather than `dirty`, which is a wrong answer for the one input it most needs to get right. Counting `Buffer.byteLength` and short-circuiting the cleanliness probe on its first byte are both small; neither is reachable on this fleet today.
status: open

### DW-60: MCP rejects an invalid VALUE at the protocol boundary, where the CLI emits an INVALID_INPUT envelope.
origin: review-deferred story-1.3
location: src/fleet/mcp.ts (FLEET_TOOL_INPUT) / src/fleet/cli.ts (parseDeadlineMs)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: low
reason: The matrix asks for "Bad flag value -> INVALID_INPUT, exit 2" AND "MCP parity -> same categories both sides", and on the MCP side those pull apart: `deadlineMs: 0` is a zod `-32602` transport error with no envelope, while `--deadline-ms 0` is an `INVALID_INPUT` envelope at exit 2. Rejecting at the schema is the MCP-appropriate answer and is probably right, but it is a divergence nothing tests -- the existing case covers an UNKNOWN KEY, not an invalid value of a known one. Either the divergence is stated in the tool description, or the schema loosens and the core rejects. Deciding which is a contract question, not a patch.
status: open

### DW-61: Three verification depths this story's ACs name and its suite does not reach.
origin: review-deferred story-1.3
location: tests/fleet-provenance-regressions.mjs / tests/mcp-server-regressions.mjs
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: low
reason: (1) AC4 asks for a process trace containing no execution of the observed binary AND NO NETWORK CALL; non-execution is proved at the filesystem-sentinel surface (a real `touch <sentinel>` shim, asserted absent), but the network half has no assertion at any surface -- the guarantee is structural (a closed subcommand argv plus `GIT_TERMINAL_PROMPT=0`). (2) The `--deadline-ms 1` case is measured to spawn ZERO children: the budget is blown by contract load and `collectFleetInventory` before the first `probe()`, so it proves the pre-spawn guard, not the mid-probe escalation in `min(probeTimeoutMs, remainingMs)`; `--deadline-ms 2500` behind the same shim does exercise it and is untested. (3) AC13 says "any invocation" writes nothing, and `cliAt` snapshots around every CLI call -- but the MCP fleet block takes no snapshot at all, including for the aborted request. Same core, so the risk is low; the evidence is CLI-only.
status: open

### DW-62: The `.bmad-loop` session timeout was raised without fixing the commit detection it names.
origin: review-deferred story-1.3
location: .bmad-loop/policy.toml (limits.session_timeout_min)
source_spec: `spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md`
severity: low
reason: The 90 -> 240 raise is justified in its own comment by a real event: the orchestrator killed story 1.3's dev session at the handoff to review, with the work committed and 63/65 suites green, then recorded `committed=False` and demanded a manual rollback. Raising the ceiling was the right immediate call and the reasoning is sound, but the defect it describes is a COMMIT-DETECTION bug in the orchestrator, and nothing in this story's diff touches it -- a 4-hour ceiling only widens the window before it recurs. Out of scope here (the orchestrator owns its own state), recorded so it is not lost.
status: open

### DW-63: Three observation domains have no observer in this release and can only report a declared gap.
origin: spec-deferred story-1.4
location: src/fleet/status.ts (observeFromInventory)
source_spec: `spec-1-4-deliver-parse-safe-registry-wide-fleet-status.md`
severity: medium
reason: `systemd`, `live_process` and the Bloodbank LIVENESS half of `bloodbank` are reported `unsupported` with a named reason and the story that owns them, because this story's Never list forbids implementing any of the three. Concretely: `systemd` carries the contract-derived expected unit names as evidence and observes nothing (story 1.8 owns canonical topology and service health); `live_process` observes nothing at all -- there is no `ps`, `pgrep` or `/proc` read anywhere in `src/` (story 1.9); `bloodbank` observes the stored routing RECORD and the strict activation flag, and reports routing readiness `unsupported` (story 1.10). The consequence a later story inherits: `health.complete` on this build is only ever about the domains that DO have an adapter, and three of the nine contribute a permanent `unsupported` to `totals.by_state` that no run can clear.
status: open
addressed: The three `unsupported` literals no longer authorize themselves. `health_policy.deferred_capabilities` in the tracked contract declares `systemd`/`unit_topology` (story 1.8), `live_process`/`process_attribution` (1.9) and `bloodbank`/`routing_liveness` (1.10), each with a reason and an owning story, and story 1.5's evaluator reports the same observations with `applicability: "deferred"`, `repair: "blocked"` and a `justification.policy` naming the entry. Remove an entry and the identical observation is reported unjustified and blocks `proven` -- pinned by a delta case in `tests/fleet-health-regressions.mjs`. The domains still have no observer; the gap is now authorized rather than assumed, and two more of the same kind (`scaffold.template_ref` for 1.6, `profile.render_generation` for 1.7) are declared beside them.

### DW-64: Thirty-four JSON-emitting `process.exit()` sites in src/index.ts are still unflushed.
origin: spec-deferred story-1.4
location: src/index.ts
source_spec: `spec-1-4-deliver-parse-safe-registry-wide-fleet-status.md`
severity: medium
reason: This story replaced four of the file's 38 `process.exit()` calls -- the audit action's two write sites and two exit sites -- with `writeStdout` + `exitAfterFlush`, because the status core parses `pjangler audit --json` and its truncation became a correctness dependency. The other 34 are unchanged and carry the same latent defect: on Linux `process.stdout` is asynchronous for a pipe, so `console.log(...)` followed by `process.exit(n)` discards whatever is still queued AND still reports the exit code it meant to. MEASURED on the pre-fix build: `node dist/index.js project doctor --json --registry <1500-project registry>` produced 300 218 valid bytes to a file, 131 072 INVALID bytes through `| cat`, and 146 176 INVALID bytes through a `spawn` capture -- exit 0 every time. `project doctor` and `project identity` are the two with a documented `--json` contract and the two most likely to be captured by automation. `src/utils/stdout.ts` is now the shared mechanism; converting the rest is mechanical and was left out only because this story's Execution list scopes it to the audit path.
status: open

### DW-65: `collectFleetProvenance` gained a collection-narrowing option that only one caller passes.
origin: spec-deferred story-1.4
location: src/fleet/provenance.ts (FleetProvenanceOptions.probeAgentIds)
source_spec: `spec-1-4-deliver-parse-safe-registry-wide-fleet-status.md`
severity: low
reason: The story's own boundary -- "a `--agent`/`--domain` scope must not spawn probes or audit children for unselected agents and then hide the results" -- could not be met through the provenance core as story 1.3 shipped it: `collectFleetProvenance` collects the fleet UNSCOPED and filters for emission, so `agentId` reduces what is reported and nothing about what is probed. Rather than fork the traversal, an optional `probeAgentIds` was added; `fleet provenance` never passes it, so 1.3's behaviour and payload are unchanged. The debt is that `fleet provenance --agent X` still probes all 28 checkouts (DW-56's neighbour), and the two commands now differ in whether a scope constrains collection. Aligning them means deciding whether provenance's fleet-wide `probes[]` array is part of its contract.
status: open

### DW-66: The audit child receives an allowlisted environment, which is a list that can go stale.
origin: spec-deferred story-1.4
location: src/fleet/status.ts (AUDIT_CHILD_ENV_KEYS)
source_spec: `spec-1-4-deliver-parse-safe-registry-wide-fleet-status.md`
severity: low
reason: "No literal credential in any child environment" is enforced structurally: the recipe-audit child receives only the ~25 keys `AUDIT_CHILD_ENV_KEYS` names, so `PLANE_33GOD_API_KEY` and anything like it never exists in that process. The trade is that a rule which later needs a new environment key will silently see it as unset rather than fail loudly -- and the failure mode is a wrong audit answer, not an error. It also makes test injection through the environment impossible (measured: a `PJ_SHIM_MODE` was stripped before the shim could read it), which is why the suite's injected entries discriminate on their own file path instead. A future story that adds an env-reading rule has to extend the list; nothing currently detects that it needs to.
status: open

### DW-67: `unsupported` steps aside in `rollUp`, which is a documented refinement of the declared precedence.
origin: spec-deferred story-1.4
location: src/fleet/status.ts (rollUp)
source_spec: `spec-1-4-deliver-parse-safe-registry-wide-fleet-status.md`
severity: low
reason: The declared precedence is `error > unobserved > unsupported > fail > warn > skip > pass`, and `rollUp` iterates that constant. Applied literally to a MIXED domain it inverts into a lie: `template_scaffold` carries one permanent "a deployed role scaffold records no template ref" (`unsupported`) beside eighteen stale tracked assets (`fail`), and the raw precedence rolls that domain up to `unsupported` -- telling an operator this release cannot see the scaffold when it can see it and it is broken. It also contradicts the story's own acceptance criterion that a project-scoped `warn` rolls its domain up to `warn`. So an `unsupported` observation is filtered out of the candidate set when the domain produced anything else. The refinement is correct and tested; what was left open was that a later story reasoning from the constant alone would be surprised by it.
status: documented, behaviour unchanged
addressed: The review pass corrected every place that stated the one-line rule. `FLEET_STATUS_STATE_PRECEDENCE`'s doc comment now says the yield is PART of the rule and why (a statement about the build, not about the fleet); the README's precedence paragraph is a two-step list rather than a single ordering; and the spec's `## Design Notes` says the same. The array order is unchanged and `rollUp` still iterates it, so nothing behavioural moved -- the divergence is now impossible to read as an accident. What remains genuinely open is the underlying modelling question: whether `unsupported` should have been given a rank at all, or whether a domain with no adapter deserves a separate axis from a domain with an unread half.
resolved (modelling question): The open half was "whether a domain with no adapter deserves a separate axis from a domain with an unread half". Story 1.5 answers yes and adds it: `applicability: "deferred"` beside `evidence: "absent"` IS that axis, so `unsupported` needs no different rank in `FLEET_STATUS_STATE_PRECEDENCE`. The array order and `rollUp`'s behaviour are untouched.

### DW-68: A domain rollup can read `unobserved` while a real failure sits underneath it.
origin: spec-deferred story-1.4
location: src/fleet/status.ts (collectFleetStatus)
source_spec: `spec-1-4-deliver-parse-safe-registry-wide-fleet-status.md`
severity: low
reason: Without `--live`, every audit-fed domain receives an explicit `unobserved` observation naming the flag, and `unobserved` outranks `fail` -- correctly, because nothing may be claimed about a half that was not read. The consequence is that on a DEFAULT run `profile` reads `unobserved` for an agent whose profile directory is a symlink, even though the store read alone proves the failure. Nothing is hidden: the `fail` observation is emitted, `data.domains[].counts` shows it, and `health.failed` counts it -- but the single-word domain state under-reports what the run actually knows. A later story may want a separate "observed so far" state, or to rank `fail` above `unobserved` when the failure came from a source that WAS read.
status: open
addressed (visibility, not ranking): The `evidence` axis makes the underlying proof visible without moving the state ordering -- on a default run the symlinked profile is `fail` with `evidence: "direct"` beside the audit half's `unobserved` with `evidence: "absent"`, so a consumer can tell a proven failure from a silence at the observation level. `detectContradictions` deliberately requires BOTH sides to have read something, so a fail beside an unread half is not reported as a disagreement. Still open: the single-word domain state reads `unobserved`, and ranking `fail` above it when the failure came from a source that WAS read is a separate decision.

### DW-69: The recipe audit's own git calls omit `--no-optional-locks`.
origin: review-deferred story-1.4
location: src/parity/rules.ts:2901, :2922, :6118
source_spec: `spec-1-4-deliver-parse-safe-registry-wide-fleet-status.md`
severity: low
reason: The fleet namespace's own probes all pass `--no-optional-locks` -- verified by logging all 13 git invocations of a `fleet status --json` run through a PATH shim -- and with a reconciled index a plain run and a `--live` run both leave this repository's `.git/index` byte-identical across three build/run cycles. The audit rules the `--live` path invokes as children do NOT pass the flag on their `git ls-files --stage` calls. It did not produce an observable write in any measurement here (`ls-files` does not refresh a clean index), so this is a latent inconsistency rather than a reproduced defect: a rule that later reaches for `git status` or `git diff` on that path would refresh the index of a repository the caller was told is only being read. The flag belongs on every git call in `src/parity/rules.ts`, which is that file's owner to change.
status: open

### DW-70: The whole-suite zero-write assertion cannot attribute a change to the command.
origin: review-deferred story-1.4
location: tests/fleet-status-regressions.mjs (snapshotShared)
source_spec: `spec-1-4-deliver-parse-safe-registry-wide-fleet-status.md`
severity: low
reason: This repository's own `.git/index` and top-level direntries are worth checking -- a command that writes the repo it runs in rather than the isolated HOME is exactly the defect -- but this machine runs parallel agents by design and any of them can move both. Measured during one run of this suite: `.pjan-67-trusted-lifecycle-FmLEQj` and `.pjan-67-trusted-lifecycle-R2bRQf` appeared in this root mid-invocation, created by a different process. The check now measures tracked CONTENT rather than stat bytes, ignores other suites' dot-prefixed scratch directories, and runs once per suite with wording that names both possible causes -- which removes the misattribution but not the shared surface. A real fix needs either a run-level exclusive lock on the repo for the test suite, or a control measurement that proves the machine is quiet before the assertion is allowed to fail.
status: open

### DW-71: `activation.routing_prerequisites` is still read by no code.
origin: spec-deferred story-1.5
location: contracts/fleet-contract.yaml (activation.routing_prerequisites) / src/fleet/health.ts
source_spec: `spec-1-5-make-partial-health-truthful-and-actionable.md`
severity: low
reason: DW-2's original finding is unchanged, and this story deliberately did not close it. `lifecycle.capability_readiness` now reports `unproven` for every row that records a routing target, derived from "nothing observed the gateway" rather than from the three declared prerequisites (`gateway_scope` equals-fleet, `target_agent_id` equals-agent-id, `profile_name` nonblank). Evaluating them here would have produced a `routing_ready`-shaped answer out of registry fields alone, which is exactly the inference story 1.10 exists to prevent. What changed is that the field the answer belongs in now exists and is typed; story 1.10 fills it from a real gateway observation and may then also consume the prerequisite list.
status: open

### DW-72: `evidence: "declared"` is asserted by construction, not by a check on the reader side.
origin: spec-deferred story-1.5
location: src/fleet/status.ts (observeFromInventory, the Bloodbank observations)
source_spec: `spec-1-5-make-partial-health-truthful-and-actionable.md`
severity: low
reason: The rule "a `declared` observation may never set `capability_readiness: ready` and never contributes to `proven`" is enforced by the two places that could do either -- `agentLifecycle` never returns `ready` at all, and `evaluateFleetHealth` reads states rather than evidence. Nothing asserts the INVARIANT: a later story that derives readiness from a `declared` observation would compile, ship, and pass every current case. A cheap fix is a check in `evaluateFleetHealth` that refuses to return `proven: true` when any observation contributing to a `ready` readiness carries `evidence: "declared"`; it was left out because there is no `ready` producer yet to guard against.
status: open

### DW-73: freshness attaches to the store read only, so an audit-fed domain has no age at all.
origin: spec-deferred story-1.5
location: src/fleet/status.ts (observation, the freshness gate)
source_spec: `spec-1-5-make-partial-health-truthful-and-actionable.md`
severity: low
reason: A freshness bucket is computed only for observations whose source is the registry store read, because those are the only ones with a recorded timestamp behind them and because `health.stale` has to count readings rather than agents -- giving the audit half of `project_binding` the store read's bucket counted one stale board confirmation twice. The consequence is that a recipe-audit observation always reads `freshness: "not_applicable"` even though the audit itself has an age (the run that produced it), and a `--live` run whose audit child answered from `npm view`'s one-hour disk cache is not distinguishable from one that reached the network. Closing it needs the audit report to carry an observation instant the status core can trust, which today it deliberately drops at the boundary because it would make `data` nondeterministic.
status: open

### DW-74: the fleet-scoped template facts describe the operator's checkout, not the fleet.
origin: review-deferred story-1.5
location: src/fleet/provenance.ts (addTemplateFacts) / tests/fleet-health-regressions.mjs
source_spec: `spec-1-5-make-partial-health-truthful-and-actionable.md`
severity: medium
reason: `template.gitlink`, `template.remote_url` and `template.worktree_clean` are read out of `resolvePjanglerRoot()/templates/hermes-agent` -- the running build's own checkout. MEASURED while building story 1.5's suite: the same submodule reads clean through this repository's git and DIRTY through a probe, because `probeEnv` strips `GIT_CONFIG_GLOBAL` and `git status --porcelain` then reports untracked files a global excludes file had been hiding. So a fleet-scoped `fail` can be produced by the operator's editor droppings rather than by anything about the fleet. The suite works around it by building its own package root with its own committed template submodule; the command has no such option. Either the fact set should be scoped to what is TRACKED (`git status --porcelain --untracked-files=no`), or the probe should stop stripping the global config, and both are decisions about what "clean" means for a pinned template.
status: open

### DW-75: a contradiction is detected per FIELD PATH, which is coarser than per thing.
origin: review-deferred story-1.5
location: src/fleet/health.ts (detectContradictions) / src/fleet/status.ts (DOMAIN_FIELD)
source_spec: `spec-1-5-make-partial-health-truthful-and-actionable.md`
severity: medium
reason: `detectContradictions` groups on `(agent_id, domain, field)`, which is the tuple the spec names -- but `DOMAIN_FIELD` gives EVERY rule in a domain the same field path, so a store read and an audit rule that examine different properties of one domain register as a disagreement about one field. MEASURED on the live fleet: 10 contradictions, and every one is of that shape. `zshyzsh-pm` is representative -- the store read reports `pass` because the role-local runtime directory really is a real directory, and `hermes.untracked-runtimes` reports `fail` because `agents/hermes/pm/.gitignore` is missing its `runtime/` entry. Both readings are TRUE and neither refutes the other; they are answers to different questions filed under one path. The report is defensible at the granularity it claims (two sources, one declared field, two states) and every one of the ten is actionable, but `health.complete` now reads false for ten agents on a ground that is partly an artefact of the field table. Sharpening it needs an observation-level subject finer than the domain's contract field -- which is a modelling decision about what an audit rule is ABOUT, not a bug fix.
status: open
