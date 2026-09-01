### DW-1: Many live Hermes registry fields carry no declared owner in the fleet contract.
origin: spec-deferred 229a382c3bbc
location: contracts/fleet-contract.yaml (authorities.*.writable_fields)
source_spec: `spec-1-1-define-fleet-authority-and-managed-state-contract.md`
severity: medium
reason: Cross-checked contracts/fleet-contract.yaml against the live ~/.hermes/agents-registry.yaml. Undeclared: hindsight.*, reporting.*, internal_role_name, slack.{team_id,team_name,bot_user_id,bot_id,bot_username,workspace,status}, telegram.{bot_id,bot_username,status}, hermes.codex_home, systemd.{cron_tick_timer,artifact_bridge_timer,watchdog_timer,checkpoint_timer}, and gateways.bloodbank.legacy_profile_consumers. Story 1.1's ACs require declaring an owner per domain, not per live key, and Story 1.2 explicitly owns "reads the configured canonical registries" - so exhaustive field coverage belongs there, driven by real registry reads rather than by hand.
status: open

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
