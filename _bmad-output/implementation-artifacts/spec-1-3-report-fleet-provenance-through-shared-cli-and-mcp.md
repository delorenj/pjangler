---
title: 'Story 1.3: Report Fleet Provenance Through Shared CLI and MCP'
type: 'feature'
created: '2026-09-01'
status: 'in-review'
baseline_revision: '25fb40682a32f09364f041f2cf59d64fa7b6e38a'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-2-discover-the-complete-fleet-and-detect-identity-conflicts.md'
  - '{project-root}/contracts/fleet-contract.yaml'
warnings: ['oversized', 'multiple-goals']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 1.2 answers *what the fleet is*; nothing answers *which build each
agent actually runs*. The live evidence: 21 of 28 agents point `hermes.bin` at the legacy
`~/.hermes/hermes-agent` checkout — whose `origin` is **NousResearch/hermes-agent** at
`513d10d`, with 3 modified files and an untracked `agents/` — while the configured pin
(`~/.config/hermes-agent-template/config.toml` `[fleet]`, and `~/.hermes/fleet.env`) is
`delorenj/hermes-agent` at `0408fec`. 13 agents declare `hermes.repo:
/home/delorenj/code/hermes-agent`, a path that **does not exist**. 21 carry no
`hermes.git_sha` at all. And the whole fleet namespace is invisible to MCP: `src/mcp-server.ts`
imports nothing from `src/fleet/*`, so an automation client cannot read the fleet at all.

**Approach:** Add a read-only provenance core (`src/fleet/provenance.ts`) that pairs every
**desired** (recorded/pinned/declared) value with its **observed** (live) counterpart, each
naming its own source, categorized `match | mismatch | dirty | missing | unsupported |
unobserved` and never guessed; give it bounded, cancellable, deadline-aware git/filesystem
probes that never execute the observed binary; expose it as `pjangler fleet provenance` and —
together with Story 1.2's inventory — as `pjangler_fleet_inventory` /
`pjangler_fleet_provenance` MCP tools that are thin adapters over the same core and return
the same envelope.

## Boundaries & Constraints

**Always:**
- **`desired` is the recorded/pinned side; `observed` is the live side.** This is the model's
  one global rule and it is what makes AC2 hold: the recorded gitlink is `desired`, so no
  worktree move can ever make it report the worktree's SHA.
- **Strictly read-only, and provably so.** No registry, profile, repo, unit, launcher, or
  network write. Every git probe passes `--no-optional-locks` (a plain `git status` refreshes
  `.git/index` and would be caught as a write by the suite's content+mtime snapshot).
- **Never execute the observed hermes binary**, and never `fetch`, `pull`, `clone`, or write
  in any probed checkout. `rev-parse` / `remote get-url` / `status --porcelain` only.
- **Credentials are excluded structurally, not filtered.** `~/.hermes/fleet.env` carries
  `PLANE_33GOD_API_KEY` and `PLANE_AUTOMATICAI_API_KEY` on the live host. Read it only through
  a key-allowlisted reader, so an unlisted key never enters memory. Never emit raw environment
  maps, file contents, or subprocess stdout — subprocess output is parsed into a value or
  discarded, never carried.
- **Absence is never a match.** `missing`, `unsupported`, and `unobserved` are distinct from
  `match` in the fact, in `totals.by_status`, and in `health`. A failed probe downgrades its
  own fact and leaves every other agent and domain intact.
- **CLI and MCP dispatch the same core with the same defaults.** The adapter adds envelope
  wrapping and `next_actions` guidance and nothing else — no extra option, no different
  default, no alternate policy.
- **Bounded everywhere:** capped facts/probes/findings, deduped probes keyed by canonical
  path, bounded probe concurrency, per-probe timeout, whole-run deadline, and every emitted
  string through `bounded` + `redactHome`.
- **Deterministic payload.** `data` carries no timestamp, duration, ordering-by-completion, or
  hostname. Two runs over identical state produce byte-identical `data`; that is what makes
  the CLI/MCP parity assertion an equality and not a resemblance.

**Block If:**
- The contract would have to declare a new authority, field path, or root key to attribute a
  provenance value. Declaring is Story 1.1's surface; record a deferred entry instead.
- A provenance value can only be obtained by executing the observed binary or touching the
  network.

**Never:**
- Do not probe systemd, live processes, or Bloodbank (Stories 1.8/1.9/1.10), and do not
  compare scaffold or profile *content* against the template (Stories 1.6/1.7). This story
  reports version/identity provenance only.
- Do not repair, adopt, retire, or plan anything. No mutation controller.
- Do not rebuild registry, identity, or provenance policy inside Commander handlers or inside
  the MCP handlers.
- Do not re-derive resolvers that already exist and are exported (`resolveTemplateConfigPath`,
  `readTomlScalar`, `resolvePjanglerRoot`, `PJANGLER_VERSION`) — DW-18 already records that
  class of duplication as debt.
- Do not add a `latest`-style mutable reference or a fallback that invents a pin.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Live fleet | configured registries + host config | `ok:true`, exit 0, one fact set per agent, `health.healthy:false` (21 legacy executables) | No error expected |
| Pinned agent | agent whose `hermes.git_sha` equals the configured pin | `hermes.git_sha` status `match` | No error expected |
| Legacy executable | `hermes.bin` under `~/.hermes/hermes-agent` | `hermes.executable` `mismatch`, `observed.family` names the retired family, binary never executed | No error expected |
| Absent checkout | `hermes.repo: ~/code/hermes-agent` (does not exist) | `hermes.repository` path classification `absent`; `hermes.checkout_identity` `unobserved` with a probe record, not `match` | Probe skipped, recorded |
| Not a repo root | `hermes.repo` inside another repo | `checkout_identity` `unobserved`, reason `not-a-repository-root` — never the parent repo's identity | Recorded, run continues |
| Dirty upstream | probed checkout has modified files | `hermes.checkout_clean` status `dirty` | No error expected |
| Moved submodule worktree | `templates/hermes-agent` HEAD ≠ recorded gitlink | `template.gitlink.desired.value` still the index SHA; `observed.value` the worktree HEAD; status `mismatch`; `health.healthy:false` | No error expected |
| Nothing records it | deployed role scaffold, rendered profile config | `scaffold.template_ref` / `profile.render_generation` status `unsupported`, observed evidence still reported | No error expected |
| Probe fails | fake `git` on PATH exits nonzero | affected facts `unobserved`, `probes[].outcome:"failed"`, `health.complete:false`, every other domain intact | Run succeeds, exit 0 |
| Probe hangs | fake `git` sleeps past the per-probe budget | affected facts `unobserved`, `probes[].outcome:"timeout"`, child killed | Run succeeds, exit 0 |
| Deadline exceeded | `--deadline-ms 1` with a hanging probe | `ok:false`, code `TIMEOUT`, exit 7, no partial claimed healthy | Failure envelope |
| Cancelled | SIGINT (CLI) / aborted request (MCP) mid-probe | `ok:false`, code `CANCELLED`, exit 8; no `git` child survives | Failure envelope |
| Unknown agent | `--agent nope` | `ok:false`, `NOT_FOUND`, exit 3 | Failure envelope |
| Bad flag value | `--agent ""` / `--agent --json` / `--deadline-ms abc` | `ok:false`, `INVALID_INPUT`, exit 2 | Failure envelope |
| MCP parity | same inputs to tool and CLI | `data` and `error` deep-equal the CLI `--json` envelope's | Same categories both sides |

</intent-contract>

## Code Map

**New (this story):**
- `src/fleet/provenance.ts` — the provenance core. Greenfield; no `provenance` symbol exists in `src/fleet/`.
- `src/fleet/runtime.ts` — the run context (deadline + `AbortSignal` + bounded child probes). Greenfield: `grep AbortController|signal|timeout|deadline|cancel` over `src/fleet/*.ts` **and** `src/mcp-server.ts` returns **zero** matches today.
- `src/fleet/mcp.ts` — `registerFleetMcpTools(server)`. Keeping the adapter out of `src/mcp-server.ts` is what makes "adds only wrapping, never policy" inspectable.
- `tests/fleet-provenance-regressions.mjs` — new suite.

**Blockers in the existing fleet module (change, do not work around):**
- `src/fleet/output.ts:29` `FLEET_COMMANDS` is a closed allowlist (`validateFleetEnvelope` rejects anything else, `:354`). Add `"fleet.provenance"`.
- `src/fleet/output.ts:39-51` `FLEET_COMMAND_DATA_KEYS` — add the provenance entry. Story 1.2's own note explains why omitting a key here waves through a lossy envelope.
- `src/fleet/cli.ts:207` `fleetParserFailureEnvelope` picks the command from `words[1] === "inventory"` (`:214-215`). Add the `provenance` word; keep it positional-only (an option *value* may legally be `provenance`).
- `src/fleet/cli.ts:337` `write()` already takes a formatter thunk — reuse as-is, no third copy.
- `src/fleet/types.ts:172-186` `FleetErrorCode`/`FLEET_ERROR_CODES` and `:220` `fleetExitCode` — add `TIMEOUT` → 7 and `CANCELLED` → 8. `fleetExitCode`'s switch is exhaustive with no `default`, so the compiler forces both to be handled.
- `src/fleet/cli.ts:243` `registerFleetCli` — actions become `async`; `src/index.ts:1451` already `await program.parseAsync()`.
- `src/fleet/inventory.ts:1265` `collectFleetInventory(options)` — accept the run context and check cancellation at the row-build loop (`:1400`) so both tools honour the same inputs. Add `--contract`/`contract` to the CLI surface: `FleetInventoryOptions.contract` (`:137`) exists but no adapter exposes it, and the MCP tool must not be the first to.

**Reuse verbatim:**
- `src/fleet/output.ts:131` `bounded`, `:166` `redactHome`, `:192` `boundedContext`, `:212` `cappedStrings`, `:260` `ignoreBrokenPipe`, `:264` `normalizeFleetError`, `:272/283` success/failure envelopes, `:335` `renderFleetJson`, `:340` `fleetEnvelopeExitCode`, `:656` `formatFleetErrorReport`. Report style: `formatFleetInventoryReport` (`:570`).
- **Trap (carried from 1.2):** `boundedValue` (`:226`) caps arrays at 100. Never run `facts`/`probes` through it; bound each string and cap the arrays explicitly with a recorded `truncated` note.
- `src/fleet/types.ts:428` `FleetInventoryScope` and `:368` `FleetInventoryFinding` — reuse both; do not fork a parallel finding shape.
- `src/fleet/inventory.ts:253` `classifyPath` (exported, `lstat`-based, never follows a link) for every declared path. `:1002` `conflictGroupId` shows the sha256-prefix id idiom.
- `src/fleet/contract.ts:108` `resolveFleetContractPath` (walks up on `package.json` + `contracts/fleet-contract.yaml`, survives bundled `dist/`), `:120` `loadFleetContract`, `:215` `validateFleetContract`.
- `src/utils/version.ts:12` `PJANGLER_VERSION` — reads `package.json` at runtime by walking up from `import.meta.url`.
- `src/project/index.ts:1812` `resolvePjanglerRoot()` — exported; same walk, `templates/commonproject/copier.yml` as the second marker. Both `dist/index.js` and `dist/mcp-server.js` live in `dist/`, so CLI and MCP resolve the same root regardless of cwd.
- `src/project/boardUrl.ts:47` `resolveTemplateConfigPath(env, home)` — exported and env/home-injectable (the `EnsureTemplateConfig.ts:28` twin is not; do not use that one). `:63` `readTomlScalar(text, section, key)` — exported, deliberately minimal, returns `undefined` for anything it cannot read confidently. Exactly the `[fleet]` reader needed.
- `src/describe/activity.ts:82` `git` / `:138` `gitLine` — the only exported, both-bounded git pair (5 s, 16 MB). **Do not use them here:** they hardcode `["-C", repo, ...args]` with no slot for `--no-optional-locks`, return a bare `undefined` that cannot distinguish timeout from failure, and are synchronous. `runtime.ts` needs its own async twin; model it on `gitAsync` (`:93`), which already does SIGKILL-on-timeout and manual byte counting.

**Provenance sources (verified live on 2026-09-01):**
- **Configured pin** — `~/.config/hermes-agent-template/config.toml` `[fleet]`: `hermes_bin`, `hermes_repo`, `hermes_git_url` = `https://github.com/delorenj/hermes-agent.git`, `hermes_git_ref` = `main`, `hermes_git_sha` = `0408fec7a153e6c32c064acd2b8053917f1525f1`.
- **Fleet env** — `~/.hermes/fleet.env` holds `HERMES_FLEET_{HOME,REPO,BIN,REGISTRY_FILE,CODEX_HOME,OAUTH_FILE}` **and two live Plane API keys**. `readShellAssignments(path, keys)` (`src/project/index.ts:716`, **currently not exported — export it**) reads only allowlisted keys, so a credential never enters memory. It does **not** expand `$VAR`: `HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/agents-registry.yaml` must be reported unexpanded and classified, never expanded. Path resolver: `ticketProviderFleetEnvPath(env)` (`src/project/index.ts:711`, exported, honours `HERMES_FLEET_ENV`).
- **Template gitlink** — `.gitmodules` declares `templates/hermes-agent` → `git@github.com:delorenj/hermes-agent-template.git`. `git ls-files --stage templates/hermes-agent` → mode `160000`, SHA `77d3a0023d6953ac13b6b8ed06d3f1bf22f1cc84`; worktree HEAD matches today. The only existing reader is `scripts/check-submodule-contract.mjs:43` `trackedEntries` (a non-importable `.mjs`, `spawnSync`, **no timeout**) — read the gitlink through the bounded probe runner instead.
- **Agent registry** — `agents.{id}.hermes.*`. Live counts: `bin` 28/28, `repo` 28/28, `fleet_env` 28/28, `git_url`/`git_ref`/`git_sha` **7/28**. `bin` splits 21 `~/.hermes/hermes-agent/.venv/bin/hermes` · 6 pinned release · 1 `~/.local/bin/hermes` (a symlink into `~/.hermes/hermes-agent/venv/bin/hermes`). `repo` splits 13 `~/code/hermes-agent` (**absent**) · 9 `~/.hermes/hermes-agent` · 6 pinned release. `~/.hermes/hermes-agent` probes to `git@github.com:NousResearch/hermes-agent.git` at `513d10d…`, dirty.
- **Contract** — `contracts/fleet-contract.yaml:99-104` declares `agents.{agent_id}.hermes.{bin,repo,git_url,git_ref,git_sha}` under `project_identity`; `:393-399` `retired[hard-coded-hermes-checkout-path]` carries the `detect` patterns (`~/[^\s]*hermes`, `(?:^|/)code/hermes-agent`) that classify the observed executable family. Compile them the way `contract.ts:743` already does — `new RegExp(pattern, "iu")` inside `try/catch`, skipping anything that will not compile.
- **Scaffold** — `agents/hermes/<role>/` carries `role.yaml`, `SOUL.md`, `hermes`, `.scripts/`, `.runtime-scaffold/` and **no `.copier-answers.yml`**; `templates/hermes-agent/template/` renders no answers file. The repo-root `.copier-answers.yml` is CommonProject's, has `_src_path` (a host path — redact) and **no `_commit`**. So `scaffold.template_ref` is genuinely `unsupported`.
- **Profile render** — `~/.hermes/profiles/<name>/config.yaml` carries only the header marker `GENERATED FILE -- DO NOT EDIT` (`src/parity/rules.ts:3559`; emitted at `templates/hermes-agent/scripts/hermes-profile-config.py:92`) — no generation counter, digest, sidecar, or yaml key. 38 of 39 live profile dirs carry it. So `profile.render_generation` is `unsupported`, with an observed sha256 of the file's bytes as the only stable evidence. Hash only; never carry content (mode is `0600`).

**Traps this story must not step in:**
- `git -C <path>` **walks up**: `git -C src rev-parse --show-toplevel` on this repo answers the repo root. Verified. Every checkout probe must assert `rev-parse --show-toplevel` realpath-equals the probed directory, else classify `not-a-repository-root` — otherwise an agent pointed at a subdirectory inherits an unrelated repo's identity and reports it as fact.
- A plain `git status` **writes** `.git/index`. Use `git --no-optional-locks -C <repo> …` (flag before `-C`; verified on git 2.51.0). The suite's content+mtime snapshot is what catches a regression here.
- Spawn `git` by name so `PATH` applies — that is what makes the fake-shim probe-failure and probe-timeout cases real rather than mocked.

**MCP surface:**
- `src/mcp-server.ts:29-32` `new McpServer(...)`; `:1025-1026` top-level `await server.connect(new StdioServerTransport())`; separate bin `pjangler-mcp` → `dist/mcp-server.js` (`package.json:9`), bundled by the same esbuild call (`package.json:32`). **esbuild does not typecheck** — `npm run typecheck` is the gate (`scripts/run-tests.mjs:147-166`), and `dist` must be rebuilt before the MCP suite runs.
- Registration idiom: `server.registerTool(name, { title, description, inputSchema: z.strictObject({…}) }, handler)` — see `:444-464`. Result idiom: `asText(payload)` (`:139-141`) returns `{content:[{type:"text",text:…}]}`; failures use `{ isError: !ok, ...asText(payload) }` (`:487`, `:726`). `structuredContent`/`outputSchema` are never used — do not introduce them.
- Handler signature is `(args, extra)` with `extra.signal: AbortSignal` (`@modelcontextprotocol/sdk` `dist/esm/shared/protocol.d.ts:177`); the client can cancel via `RequestOptions.signal` (`:71`). No handler takes `extra` today.
- `tests/mcp-catalog-regressions.mjs:8-19` regex-asserts the tool-name list against `src/mcp-server.ts` **as text** — a tool registered from `src/fleet/mcp.ts` will not match. Point that assertion at the fleet module too, or the catalog silently stops covering these two tools.
- `tests/mcp-server-regressions.mjs:11` runs `dist/mcp-server.js` over real stdio; `:21-30` prepends a fake-binary dir to `PATH` and pins `PJ_PROJECT_REGISTRY` — the exact idiom the fake-`git` cases need.

**Test harness:**
- `tests/fleet-inventory-regressions.mjs` is the shape to copy: `skip()` `:62`, `check()` `:67`, `seedHome()` `:87` (**guard it — an unguarded copy of the operator's live registries turns SKIP into FAIL on any other host**), `isolation` `:95-115`, `snapshotTree()` `:126` (content hash + mtime, records dirs and symlinks as themselves), `fileFingerprint()` `:146`, `snapshot()` `:152`, `cliAt/cli()` `:170-186` (`maxBuffer: 32 MB`, real OS pipes, asserts zero writes on **every** call), `envelope()` `:189`, `mutatedRegistry()` `:225`, `rawCopy()` `:233`.
- `tests/portable-test-paths-regressions.mjs:7-8` fails the build on a literal `/(home|Users)/<name>` in any `*-regressions.mjs` — derive from `userInfo().homedir` (precedent `:49`).
- `scripts/run-tests.mjs:95-112` `SUITES` — a suite is invisible until listed; fleet entries at `:102-103`.
- `.coverage-floor.json` lines/statements 57.07, functions 43.61, branches 72.22; `scripts/coverage-ratchet.mjs:57` fails at `now < min - 0.2`. Never hand-edit the floor.
- `mise.toml:40-45` `[tasks."fleet:inventory"]` with `depends = ["build"]` is the pattern.
- README: `## Fleet inventory` occupies 79-153; `## Orienting in a repo` starts 154; the MCP tool list is 236-248.
- DW-6 records two suites already red on main (a stale curl stub). Do not attribute them to this story.

## Tasks & Acceptance

**Execution:**
- `src/fleet/types.ts` -- add `TIMEOUT`/`CANCELLED` to `FleetErrorCode`, `FLEET_ERROR_CODES`, and `fleetExitCode` (7/8); add `FLEET_PROVENANCE_STATUSES` (`match|mismatch|dirty|missing|unsupported|unobserved`), `FLEET_PROVENANCE_SIDE_STATES`, `FLEET_PROVENANCE_MAX_FACTS`, `FLEET_PROVENANCE_MAX_PROBES`, `FleetProvenanceSide`, `FleetProvenanceFact`, `FleetProbeRecord`, `FleetProvenanceSourceView`, `FleetProvenanceTotals`, `FleetProvenanceHealth`, `FleetProvenance`. -- the fleet vocabulary already lives in one file so a reported field cannot exist without a declared owner beside it.
- `src/fleet/runtime.ts` -- `FleetRunContext` (`signal`, `deadlineAt`, `probeTimeoutMs`), `createRunContext(options)`, `throwIfCancelled(ctx)` (`CANCELLED`) / `remainingMs(ctx)` (`TIMEOUT`), and `probe(ctx, argv, cwd)`: spawns by name with `--no-optional-locks` where applicable, bounds bytes and time by `min(probeTimeoutMs, remainingMs)`, SIGKILLs on abort or timeout, resolves `{outcome: "ok"|"failed"|"timeout"|"cancelled", value}` and never surfaces raw stderr. -- AC6 requires cancellation to kill live children; nothing in `src/fleet/` or `src/mcp-server.ts` can express that today.
- `src/project/index.ts` -- export `readShellAssignments`. -- the allowlist is the credential guarantee; duplicating it would duplicate the risk.
- `src/fleet/provenance.ts` -- the core: `resolveProvenanceSources(options)` (host template config, fleet env, pjangler root, template submodule, agent registry -- each with `configured_path`/`inspected_path`/`exists`/`parse`); `readConfiguredPin(...)` via `readTomlScalar` + key-allowlisted `readShellAssignments`; `classifyExecutableFamily(path, pin, contract)` using the configured release root and the contract's `retired[].detect` patterns, never executing anything; `probeCheckout(ctx, path)` (top-level-equality guard, `remote.origin.url`, `HEAD`, `--no-optional-locks` dirty read, deduped by canonical path, bounded concurrency); `compareFact(desired, observed)` implementing the documented status precedence; `collectFleetProvenance(options)` composing them over Story 1.2's rows and returning `FleetProvenance`. -- one core; every adapter calls exactly this.
- `src/fleet/inventory.ts` -- thread `FleetRunContext` through `collectFleetInventory` and call `throwIfCancelled` per row; accept `contract` from the adapters. -- both tools must honour the same scope, override, cancellation, and deadline inputs.
- `src/fleet/output.ts` -- add `"fleet.provenance"` to `FLEET_COMMANDS` and to `FLEET_COMMAND_DATA_KEYS` (`contract_path`, `contract_version`, `scope`, `sources`, `totals`, `health`, `facts`, `probes`, `findings`, `truncated`); add `formatFleetProvenanceReport(provenance)` in the `formatFleetInventoryReport` house style, leading with the verdict and naming mismatched/dirty/missing/unsupported/unobserved counts and every probe error. -- an operator on the human path must see *why* provenance is unhealthy, not only that it is.
- `src/fleet/cli.ts` -- register `fleet provenance` with `--agent`, `--project-registry`, `--agent-registry`, `--contract`, `--deadline-ms`, `--json`; add `--contract` and `--deadline-ms` to `fleet inventory`; make both actions `async`; parse `--deadline-ms` as a positive integer through the existing `requireValue` guards; install a `SIGINT`/`SIGTERM` listener that aborts the run context and remove it in `finally`; extend `fleetParserFailureEnvelope`'s positional word map. -- the CLI is one of two equal adapters, so it owns no policy beyond argument shaping.
- `src/fleet/mcp.ts` -- `registerFleetMcpTools(server)` exposing `pjangler_fleet_inventory` and `pjangler_fleet_provenance` with `z.strictObject` inputs matching the CLI flags one-for-one, passing `extra.signal` into the run context, returning the complete fleet envelope as JSON text via the server's `asText` idiom with `isError: !envelope.ok`. -- keeping it out of `src/mcp-server.ts` makes "wrapping only, no policy" reviewable.
- `src/mcp-server.ts` -- import and call `registerFleetMcpTools(server)`; export the `asText` helper (or accept it as a parameter) rather than cloning it. -- one result shape across the whole tool surface.
- `src/fleet/index.ts` -- re-export the runtime, provenance, and MCP-adapter surface. -- the barrel is how later stories consume this instead of re-deriving it.
- `tests/fleet-provenance-regressions.mjs` -- cover every I/O matrix row against the real built `dist/index.js`; derive registry and submodule cases by mutating copies of real state into scratch; drive probe failure, probe timeout, deadline, and cancellation with fake `git` shims on `PATH` (the pidfile shim proves no child survives); assert stdout is non-empty and parses before asserting content; snapshot scratch content+mtimes around every invocation; add `skip()`-guarded checks against the real configured sources asserting the recorded template gitlink equals an independent `git ls-files --stage` read and the configured pin equals an independent `readTomlScalar`-free grep, with every real file's content+mtime unchanged. -- the story's evidence bar is a real built CLI against real state.
- `tests/mcp-server-regressions.mjs` -- add real stdio calls for both fleet tools: success, `NOT_FOUND`, malformed registry, partial probe, deadline, and cancellation, each deep-equal-compared against the same case run through the built CLI with identical env and cwd. -- schema equivalence is the AC, and only a real subprocess pair can prove it.
- `tests/mcp-catalog-regressions.mjs` -- add both tool names and point the source-text assertion at `src/fleet/mcp.ts` as well. -- otherwise the catalog check silently stops covering the two new tools.
- `scripts/run-tests.mjs` -- add `tests/fleet-provenance-regressions.mjs` to `SUITES` beside the fleet entries. -- a suite not listed never runs.
- `mise.toml` -- add `[tasks."fleet:provenance"]` with `depends = ["build"]`, mirroring `fleet:inventory`. -- a gate that fails with `ERR_MODULE_NOT_FOUND` on a fresh clone teaches nothing.
- `README.md` -- add `## Fleet provenance` after line 153 (flags, the six statuses, the desired/observed rule, the exit taxonomy including 7 and 8, and that an unhealthy fleet still exits 0), and add both tools to the MCP list. -- operators and agents both land here first.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- record what this story leaves: the scaffold and profile-render provenance gaps it can only report as `unsupported`, and whether DW-18's re-derivation is reduced or extended. -- the ledger is how a later story inherits the real state.

**Acceptance Criteria:**
- Given the live sources and a built CLI, when `pjangler fleet provenance --json` runs, then every registered agent id appears in `data.facts`, `data.totals.agents` equals the inventory's `registered_agents`, and no fact carries a value whose `source` is null while its state is `present`.
- Given an agent whose `hermes.git_sha` is absent, when provenance runs, then that fact is `missing` — never `match` — the agent's other facts are still emitted, and `totals.by_status.missing` counts it.
- Given the `templates/hermes-agent` worktree checked out at a different commit than the parent's recorded gitlink, when provenance runs, then `template.gitlink.desired.value` still equals the recorded gitlink SHA, `observed.value` is the worktree HEAD, the status is `mismatch`, and `health.healthy` is false; with the worktree restored the same run reports `match`.
- Given an agent whose `hermes.bin` resolves under a checkout the contract's retired `detect` patterns match, when provenance runs, then `hermes.executable` is `mismatch`, `observed.family` names that family, and a process trace of the run contains no execution of the observed binary and no network call.
- Given an agent whose `hermes.repo` is absent, is not a repository root, or is inside an unrelated repository, when provenance runs, then `hermes.checkout_identity` is `unobserved` with a `probes[]` record naming the reason, and no other repository's identity is reported for that agent.
- Given a fake `git` on `PATH` that exits nonzero for one probed checkout, when provenance runs, then the run exits 0, that checkout's facts are `unobserved`, `health.complete` is false, and every fact for every other agent and every non-git domain is unchanged from the same run without the shim.
- Given `--deadline-ms` smaller than a deliberately hanging probe needs, when provenance runs, then the envelope is `ok:false` with code `TIMEOUT` and exit 7, and no result claiming `healthy` is emitted.
- Given the CLI is sent `SIGINT` while a probe is hanging, when it exits, then the envelope is `ok:false` with code `CANCELLED` and exit 8, and the shim's recorded child pid is gone within two seconds.
- Given an MCP client calls `pjangler_fleet_provenance` and `pjangler_fleet_inventory` with the same scope, overrides, contract, and deadline as a CLI `--json` run under identical env and cwd, when both complete, then the tool result parses to an envelope whose `command`, `data`, and `error` deep-equal the CLI envelope's, and `isError` equals `!ok`.
- Given an MCP request is aborted mid-probe, when the tool settles, then it reports `CANCELLED` in the same shape the CLI does and no probe child survives.
- Given `~/.hermes/fleet.env` containing `PLANE_33GOD_API_KEY` and an extra unlisted secret, when provenance runs, then neither key name nor value appears anywhere in the JSON, the human report, or the findings, and no fact's evidence contains a raw environment map or subprocess stderr.
- Given a rendered profile config and a deployed role scaffold, when provenance runs, then `profile.render_generation` and `scaffold.template_ref` are `unsupported` with their observed evidence still reported, and neither counts toward `match`.
- Given any invocation, successful or failing, under isolated `HOME`/`XDG_*`, when it completes, then a content+mtime snapshot of the scratch tree, the tracked contract, and every probed repository's `.git/index` is unchanged.
- Given two consecutive runs over unchanged state, when both `data` payloads are compared, then they are byte-identical.
- Given a clean checkout, when `npm run typecheck && npm run build && npm test` runs, then the new suite appears in `node scripts/run-tests.mjs --list`, it and both MCP suites pass, and `npm run coverage:check` does not trip the floor.

## Spec Change Log

## Review Triage Log

## Design Notes

**Desired is recorded, observed is live.** One rule for the whole model, and it is what makes
AC2 structural rather than defensive: the recorded gitlink is read from
`git ls-files --stage` on the *parent* and lands in `desired`, so no amount of worktree
movement, local rendering, or test activity can move it. `observed` is the submodule's own
`HEAD`. A reader never has to ask which side is authoritative.

**Status precedence, applied within one fact:**
`unobserved` > `unsupported` > `missing` > `dirty` > `mismatch` > `match`.
`dirty` can never shadow a `mismatch`, because cleanliness is always its own fact
(`template.worktree_clean`, `hermes.checkout_clean`) and never a modifier on a value
comparison. `unobserved` outranks everything: if the probe did not run, nothing may be
claimed. This is the concrete form of "the aggregate does not turn absence into a match".

**Unhealthy is data, not a failure exit** — carried from Story 1.2 unchanged.
`validateFleetEnvelope` enforces `ok ⟺ error === null` and `ok ? data !== null : data === null`
(`src/fleet/output.ts:344`), so reporting drift as `ok:false` would null out `data` on exactly
the runs that matter. A mismatched fleet is `ok:true`, exit 0, `health.healthy:false`. Only a
command failure — unreadable source, unknown `--agent`, bad flag, deadline, cancellation — is
`ok:false`.

**Two failure modes, deliberately different.** A *per-probe* timeout downgrades one fact to
`unobserved`, records a probe entry, sets `health.complete:false`, and the run still succeeds —
AC4's requirement that independent agents and domains stay available. A *whole-run* deadline is
a command failure (`TIMEOUT`, exit 7), because a truncated provenance report is exactly the
kind of partial that must never be mistaken for a complete one.

**One fact shape, both scopes.**

```ts
{ id: "hermes.git_sha", scope: "agent", agent_id: "candystore-pm",
  field: "agents.{agent_id}.hermes.git_sha", owner: "project-registry",
  desired:  { value: "0408fec…", source: "hermes-template-config", state: "present" },
  observed: { value: null,       source: "hermes-agent-registry",  state: "missing" },
  status: "missing",
  detail: "the registry row records no git_sha; the configured pin cannot be confirmed" }
```

`id` is the fact *kind*, not a unique key; the array key is `(scope, agent_id, id)` and that
tuple is also the sort order. Determinism is load-bearing: it is what turns the CLI/MCP parity
check into a deep equality instead of a resemblance, so nothing time-, duration-, host-, or
completion-order-dependent may enter `data`.

**Credentials are excluded by construction.** `~/.hermes/fleet.env` holds two live Plane API
keys today. `readShellAssignments(path, keys)` only ever materializes allowlisted keys, so
there is no moment at which an unlisted value exists to be leaked, and no redaction pass that
can be forgotten. Same discipline for probes: `probe()` parses stdout into a single value and
discards the rest, and never carries stderr.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean, zero errors.
- `npm run build` -- expected: `dist/index.js` and `dist/mcp-server.js` regenerated.
- `node dist/index.js fleet provenance` -- expected: exit 0; report names 28 agents, `healthy: false`, and the legacy-executable and missing-`git_sha` counts.
- `node dist/index.js fleet provenance --json | cat` -- expected: one complete parseable envelope through a real pipe, `ok:true`.
- `git ls-files --stage templates/hermes-agent` compared with `data.facts[template.gitlink].desired.value` -- expected: identical SHA.
- `node dist/index.js fleet provenance --agent pjangler-pm --json` -- expected: exit 0, facts scoped to one agent, totals still fleet-wide.
- `node dist/index.js fleet provenance --agent nope; echo $?` -- expected: `3`, `NOT_FOUND`, no stack trace.
- `node dist/index.js fleet provenance --deadline-ms 1; echo $?` (with a hanging `git` shim on `PATH`) -- expected: `7`, `TIMEOUT`.
- SIGINT to a run behind a hanging `git` shim -- expected: exit `8`, `CANCELLED`, the shim's recorded pid gone.
- `node dist/index.js fleet inventory --json` before and after this story -- expected: `data` unchanged (Story 1.2's rows are not disturbed).
- `node tests/fleet-provenance-regressions.mjs` -- expected: all checks ok, exit 0.
- `node tests/mcp-server-regressions.mjs` and `node tests/mcp-catalog-regressions.mjs` -- expected: pass, including the CLI/MCP deep-equality cases.
- `npm test` -- expected: no new failures beyond the two pre-existing ones recorded as DW-6; `node scripts/run-tests.mjs --list | grep fleet-provenance` shows the suite.
- `npm run test:coverage && node scripts/coverage-ratchet.mjs` -- expected: floor not tripped.
- `mise run fleet:provenance` -- expected: builds first, then reports.
- `git status --porcelain` after every run, plus the mtime of each probed repo's `.git/index` -- expected: unchanged (proves `--no-optional-locks` and read-only probing).
