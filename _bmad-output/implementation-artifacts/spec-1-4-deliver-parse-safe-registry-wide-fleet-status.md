---
title: 'Story 1.4: Deliver Parse-Safe Registry-Wide Fleet Status'
type: 'feature'
created: '2026-09-01'
status: 'done'
baseline_revision: '564d40bf81205476735fb5a2ac91c8ed68e17256'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-report-fleet-provenance-through-shared-cli-and-mcp.md'
  - '{project-root}/contracts/fleet-contract.yaml'
warnings: ['oversized', 'multiple-goals']
deferred:
  - summary: >-
      Three of the nine domains have no observer in this release and can only report a
      declared gap.
    evidence: |-
      `systemd`, `live_process` and the Bloodbank LIVENESS half of `bloodbank` are
      reported `unsupported` with a named reason and the story that owns them, because
      this story's Never list forbids implementing any of the three. Three of the nine
      domains therefore contribute a permanent `unsupported` to `totals.by_state` that no
      run can clear. Recorded as DW-63.
    location: >-
      src/fleet/status.ts (observeFromInventory)
    severity: medium
  - summary: >-
      Thirty-four JSON-emitting process.exit() sites in src/index.ts are still unflushed.
    evidence: |-
      Four of the file's 38 were converted -- the audit action's two write sites and two
      exit sites -- because the status core parses that command's stdout. The other 34
      carry the same defect: measured pre-fix, `project doctor --json` over a
      1500-project registry produced 300 218 valid bytes to a file and 131 072 INVALID
      bytes through `| cat`, exit 0. `src/utils/stdout.ts` is now the shared mechanism;
      converting the rest is mechanical. Recorded as DW-64.
    location: >-
      src/index.ts
    severity: medium
  - summary: >-
      collectFleetProvenance gained a collection-narrowing option that only the status
      core passes.
    evidence: |-
      Provenance collects the fleet unscoped and filters for emission, so `agentId`
      reduces what is REPORTED and nothing about what is PROBED -- which this story's
      "filters constrain collection" boundary requires. An optional `probeAgentIds` was
      added; `fleet provenance` never passes it, so 1.3's payload is byte-identical. The
      debt is that the two commands now differ in whether a scope constrains collection.
      Recorded as DW-65.
    location: >-
      src/fleet/provenance.ts (FleetProvenanceOptions.probeAgentIds)
    severity: low
  - summary: >-
      The audit child receives an allowlisted environment, which is a list that can go
      stale.
    evidence: |-
      "No literal credential in any child environment" is enforced by an allowlist of ~25
      keys rather than a filter, so a live Plane key never exists in that process. The
      trade is that a rule which later needs a new key sees it unset rather than failing
      loudly, and env-based test injection is impossible (measured: a PJ_SHIM_MODE was
      stripped before the shim could read it). Recorded as DW-66.
    location: >-
      src/fleet/status.ts (AUDIT_CHILD_ENV_KEYS)
    severity: low
  - summary: >-
      `unsupported` steps aside in rollUp, which is a documented refinement of the
      declared precedence.
    evidence: |-
      Applied literally, `unsupported > fail` rolls a `template_scaffold` domain carrying
      one permanent "no template ref is recorded" beside eighteen stale assets up to
      `unsupported` -- and contradicts this story's own AC that a project-scoped `warn`
      rolls its domain up to `warn`. So an `unsupported` observation is filtered out when
      the domain produced anything else. Correct and tested, but a divergence from the
      one-line rule the spec states. Recorded as DW-67.
    location: >-
      src/fleet/status.ts (rollUp)
    severity: low
  - summary: >-
      A domain rollup can read `unobserved` while a real failure sits underneath it.
    evidence: |-
      Without `--live` every audit-fed domain carries an explicit `unobserved` marker and
      `unobserved` outranks `fail`, so `profile` reads `unobserved` for an agent whose
      profile directory is a symlink even though the store read alone proves the failure.
      Nothing is hidden -- the `fail` observation is emitted and `health.failed` counts it
      -- but the single-word domain state under-reports what the run knows. Recorded as
      DW-68.
    location: >-
      src/fleet/status.ts (collectFleetStatus)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Stories 1.1–1.3 answer *what the fleet is* and *which build each agent runs*, but nothing
answers **"is the fleet correct?"** in one invocation. Nine observation domains exist as scattered
per-repository audits, and the CLI's machine output is not parse-safe: 38 `process.exit()` calls in
`src/index.ts` discard libuv's queued stdout writes, so `pjangler audit --json` and
`pjangler project doctor --json` silently truncate at the 64 KiB Linux pipe buffer **and still exit 0**
(measured: 300 218 B to a file, 65 536 B through a pipe, invalid JSON, exit 0).

**Approach:** One read-only `collectFleetStatus` application core that traverses the registry once,
emits one aggregate plus one stable per-agent record covering **all nine domains** — each either
observed or carrying an explicit `unobserved`/`unsupported` finding — and is exposed through two
equal thin adapters (`pjangler fleet status`, MCP `pjangler_fleet_status`). Recipe-owned audit rules
are invoked per repository as **bounded child processes** so one hung `systemctl` cannot stall the
fleet; that path is gated behind `--live` because a default audit can make a real `npm view` network
call. A shared flush-safe completion path replaces "just don't call `process.exit()`" with an awaited
drain — and the audit command adopts it, because the status core parses its stdout.

## Boundaries & Constraints

**Always:**
- **Read-only.** No local or external mutation, no writes to any registry, repo, profile, or unit.
  `--live` authorizes bounded read-only observation only — never mutation, process control, service
  changes, board changes, or Bloodbank activation.
- **Every one of the nine domains appears in every result**, observed or explicitly not: `registry`,
  `project_binding`, `template_scaffold`, `profile`, `runtime`, `systemd`, `live_process`,
  `bloodbank`, `release_provenance`. A domain may never disappear silently.
- **Host-scoped findings are reported once, deduped by rule id, in a separate `host` block** — never
  folded into a per-agent record, a registry-wide `ok`, or repeated 28×. `LifecycleScope` (`"project"
  | "host"`) is the discriminator; this is the exact category error PJAN-84 fixed.
- **`data` is byte-identical across two runs over unchanged state.** Nothing time-, duration-, pid-,
  host-, or completion-order-dependent enters it (the child audit's `auditedAt` is dropped; `repo`
  paths go through `redactHome`).
- **Two verdicts, provenance's split, not inventory's:** `healthy` = no `fail` and no `error`;
  `complete` = no `unobserved`, no collection error, no truncation. Truncation belongs to `complete`
  only. `unsupported` is counted and visible but does not reduce `complete`.
- **Unhealthy is data, not a failure exit.** A drifted or incomplete fleet is `ok:true`, exit 0,
  `health.healthy:false`. Only a command failure (unreadable source, unknown `--agent`/`--domain`,
  bad flag, deadline, cancellation) is `ok:false`.
- **Filters constrain collection.** A `--agent`/`--domain` scope must not spawn probes or audit
  children for unselected agents/domains and then hide the results.
- **No literal credentials** anywhere in JSON, report, findings, or child environments. Child stderr
  is never read.

**Block If:**
- Satisfying a criterion would require editing `contracts/fleet-contract.yaml`. The nine status
  domains are declared in code as `FLEET_STATUS_DOMAINS`; the contract's `policy_domains` is a
  *different, three-value* axis (`systemd`, `bloodbank`, `profile`, `contracts/fleet-contract.yaml:274-285`)
  and must not be conflated with it. Widening the contract is Story 1.1's authority — HALT rather
  than edit it here.
- A domain cannot be reported at all — neither observed nor as an explicit `unobserved`/`unsupported`
  finding with a reason. Silently dropping a domain is the one outcome this story exists to prevent.

**Never:**
- Never implement a systemd, live-process, or Bloodbank-liveness observer — those are Stories
  1.8/1.9/1.10. Report them `unsupported`/`unobserved` with a reason.
- Never promote a host-scoped rule result into a registry-wide claim.
- Never make an implicit network request without `--live`.
- Never run the recipe audit in-process on the status path (`spawnSync` inside it cannot be timed out
  or cancelled, and it blocks the event loop).
- Never add `structuredContent`/`outputSchema` to the MCP tool.
- Never convert a collection error into `pass`, drop the agent, abort unrelated work, or emit
  malformed JSON.
- Never hand-edit `.coverage-floor.json`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unfiltered default | live registries, no flags | exit 0; all 9 domains per agent; audit-fed domains `unobserved` ("requires --live"); `health.complete:false`; `scope.kind:"fleet"` | none |
| Unfiltered `--live` | live registries | exit 0; audit-fed domains observed; host findings in one deduped `host` block; `fleet_complete` true only if every row and applicable domain observed | none |
| `--agent <id>` | valid id | exit 0; `data.agents` holds one record; `scope.total_registered_agents` still fleet-wide; `selected_agents:1`; label says scoped; no probe/child for other agents | none |
| `--agent nope` | unknown id | `ok:false`, `NOT_FOUND`, exit 3, **before** any probe or child spawns | envelope, no stack |
| `--domain systemd` | any | exit 0; only the systemd domain emitted, `unsupported`; zero children spawned | none |
| `--domain bogus` | any | `ok:false`, `INVALID_INPUT`, exit 2, names the nine valid values | envelope |
| One repo audit exits nonzero | drifted repo | that repo's findings still parsed and reported (audit exits 1 by design when `!ok`) | not an error |
| One repo audit emits malformed JSON | fake CLI entry printing garbage | that agent's audit-fed domains `error`; every other agent unchanged; `health.complete:false`; exit 0 | categorized collection error |
| No built CLI to invoke | `--live`, `PJ_FLEET_CLI_ENTRY` pointing at a missing file | exit 0; **all** audit-fed domains `unobserved` with reason `audit-cli-unavailable`; inventory/provenance domains still fully reported; `health.complete:false` | categorized collection error, no crash |
| One repo audit hangs | fake CLI entry that sleeps | that agent's audit-fed domains `unobserved` (`reason:"timeout"`); other agents unaffected; exit 0 | per-child timeout |
| Whole-run deadline blown | `--deadline-ms` < need | `ok:false`, `TIMEOUT`, exit 7; no partial result claiming health | envelope |
| SIGINT mid-child | hanging child | `ok:false`, `CANCELLED`, exit 8; recorded child pid gone within 2 s | envelope |
| `--json` > 64 KiB | amplified registry | byte-identical complete JSON + one trailing newline to file, pty, shell pipe, and `spawn` capture | none |
| `--json` into `head -c 10` | closed pipe | no unhandled EPIPE, no stack trace | `ignoreBrokenPipe` |
| Payload past a bound | agents/observations over cap | counts preserved; `truncated[]` names the dotted path; clipped records carry a `retrieval` command | none |
| MCP equivalent call | same scope/overrides/deadline | `command`/`data`/`error` deep-equal the CLI `--json` envelope; `isError === !ok` | same codes |
| MCP request aborted | mid-child | `CANCELLED` in the same shape; no surviving child | envelope |

</intent-contract>

## Code Map

**New (this story):**
- `src/fleet/status.ts` — the status core. Greenfield; no `status` symbol exists in `src/fleet/`.
- `src/utils/stdout.ts` — the flush-safe completion path. Greenfield: `grep -n "drain\|setBlocking\|flush"` over `src/` returns **zero** hits today; the only mitigation anywhere is the negative "don't call `process.exit`" comment at `src/fleet/cli.ts:352-356`.
- `tests/fleet-status-regressions.mjs` — new suite.

**The truncation defect — measured, not inferred (Node v26.4.0, `mise.toml:161`):**
- `console.log(200_000 chars)` + `process.exit(0)`: file → 200 001 B, pty → 200 002 B, **pipe → 65 536 B**. Same script without `process.exit` → 200 001 B through the pipe. On Linux `process.stdout` is sync for files/TTYs and **async for pipes**; `process.exit` discards the queue.
- Real: `node dist/index.js project doctor --json --registry <1500-project registry>` → `> file` 300 218 B valid; `| cat > file` 131 072 B **invalid**; `spawn` capture 146 176 B **invalid** — and **exit code 0 every time**. Silent corruption.
- **The "~8 KiB" figure in the planning docs is wrong.** `epic-1-context.md:59` and `fleet-convergence-live-assessment-2026-08-31.md:128` say 8 KiB; `pjangler audit --json` in this repo is 8 377 B and comes through a pipe **complete**. The real threshold is the 64 KiB pipe buffer. `audit --json` is *latently* broken, not currently truncating — a 28-repo fleet audit is what crosses it.
- 38 `process.exit()` calls, **all in `src/index.ts`**; the audit ones are `:1181`, `:1185`, `:1193`, `:1197`, `:1002`. `process.exitCode` (safe) is used at `src/fleet/cli.ts:499,512` and `src/notebook/cli.ts:48-54`.
- **CONFIRMED already safe:** `fleet provenance --json` = 283 214 B **identical** across file, shell pipe, and `spawn`. The fleet `write()` path works today; this story makes the guarantee structural rather than incidental, and extends it to the audit child the status core parses.
- **Trap:** removing `process.exit()` without an EPIPE guard exposes unhandled `write EPIPE` (today `process.exit` masks it by racing). Keep `process.exit` in the audit path — just *flush first*.

**The audit-as-child design (why, and the two traps):**
- `runAudit(repoArg?, registryPath?)` — `src/parity/index.ts:79`. Takes an arbitrary repo path; `process.cwd()` is only the default. **Verified read-only empirically** across 18 real repos (tree hash + mtimes unchanged).
- It is **synchronous** and shells out with `spawnSync` and **no timeout**: `systemctl --user is-system-running` (`src/parity/rules.ts:588`, `:6219`, `:6278`), `git ls-files --stage` (`:6118`), and `npm view bmad-method dist-tags --json` (`:3445`, 8 s timeout, 1 h disk cache) — **the network call that forces the `--live` gate**. In-process there is no way to honour AC6's per-repository timeout or AC8's cancellation.
- Cost measured: **25 rules**, 18 real repos audited in ~1.3 s (35–410 ms each); ~28 repos ≈ 1.5–3 s in-process, plus ~28 node startups at concurrency 4 as children.
- **Trap 1: `probe()` discards stdout on a nonzero exit** (`src/fleet/runtime.ts:283`) — and `audit` deliberately `process.exit(report.ok ? 0 : 1)` (`src/index.ts:1197`). A drifted repo would report as `outcome:"failed"` with its findings thrown away. The capture variant must keep stdout and return the exit code.
- **Trap 2: `publicAudit` strips `recipeId`** (`src/parity/index.ts:65-70`), so the child JSON carries no owner. Do **not** change the audit JSON contract — resolve owner in the parent from the rule id via `recipeRegistry.ownerOf(ruleId)` (`src/recipes/registry.ts:88`), which is a static property of the rule.
- **Trap 3: `auditedAt: new Date().toISOString()`** (`src/recipes/registry.ts:~187`) makes the child payload nondeterministic. Drop it; never let it reach `data`.

**Record shapes to consume (verified by reading):**
- `LifecycleAuditFinding` — `src/recipes/types.ts:77-87`: `{ scope?: LifecycleScope; id; title; status; summary; details: string[]; fixable; recipeId? }`. No `severity` — **status is the severity**.
- `LifecycleStatus` — `types.ts:6`: `"pass"|"fail"|"warn"|"skip"`. `LifecycleScope` — `types.ts:137`: `"project"|"host"`; absent ⇒ project (rationale `:118-136`).
- `LifecycleAuditReport` — `types.ts:99-107`: `{ repo, ok, hostOk, auditedAt, rules[] }`. `ok` = `every(!gatesProject)` (`registry.ts:184`); **`warn` never gates** (`isHostScoped` `:177`, `gatesProject` `:189`).
- Public mirrors (identical minus `recipeId`): `AuditFinding` `src/parity/rules.ts:47-60`, `AuditReport` `:62-70`.
- **6 host-scoped rules**: `systemd.sentinel`, `hermes.fleet-config`, `hermes.profile-wiring`, `hermes.registry-parity`, `notebook.skill-installed`, `notebook.hooks-projected`. These are the `host` block, deduped by rule id.
- Keep `momo-lifecycle-plane` out — it is a `skip` stub in the default registry (`rules.ts:6963-6984`) and its live checks are credentialed (`runMomoReadinessAudit` `:4303`).

**Per-domain observability in this release (surveyed; do not re-derive):**
| domain | default source | `--live` adds |
| --- | --- | --- |
| `registry` | `collectFleetInventory` stores + row registry fields | rule findings mapped to this domain |
| `project_binding` | row `board`/`project_id`/`manifest` (`inventory.ts:890-905`) | rule findings |
| `template_scaffold` | provenance `template.gitlink/remote_url/worktree_clean` (`provenance.ts:686-701`); `scaffold.template_ref` already **`unsupported` by design** (`:857`) | rule findings |
| `profile` | row `profile_name`/`profile_path` + `classifyPath` (`inventory.ts:263`); `profile.render_generation` `unsupported`, digest only | `hermes.runtime-singleton` (`rules.ts:6343`), `hermes.profile-wiring` (host, `:6577`) |
| `runtime` | row `runtime_path` classification only | `hermes.untracked-runtimes` (`rules.ts:6098`) |
| `systemd` | **`unobserved`** — inventory deliberately emits `expected_units` state `"unobserved"` (`inventory.ts:850-857`) | `systemd.sentinel` (`rules.ts:6206`) **host-scoped only**, never promoted |
| `live_process` | **`unsupported`** — zero `ps`/`pgrep`/`/proc/<pid>` in `src/` | unchanged |
| `bloodbank` | record only: `bloodbank_scope`/`bloodbank_target`/`activation` (`inventory.ts:890-905`, `:989-991`); liveness `unobserved` | `hermes.fleet-config` (host); liveness still `unsupported` |
| `release_provenance` | `collectFleetProvenance` facts (`provenance.ts:795-967`) | unchanged |

**Reuse verbatim:**
- `src/fleet/output.ts`: `bounded` `:142` (512), `redactHome` `:177`, `boundedContext` `:203`, `cappedStrings` `:223`, `boundedNotes` `:229`, `ignoreBrokenPipe` `:271`, `normalizeFleetError` `:275`, `fleetSuccessEnvelope` `:283`, `fleetFailureEnvelope` `:294`, `renderFleetJson` `:346`, `fleetEnvelopeExitCode` `:351`, `validateFleetEnvelope` `:355`. Caps `:64-68` (`MAX_STRING=512`, `MAX_DETAILS=20`, `MAX_NEXT_ACTIONS=20`).
- **Trap (carried from 1.2/1.3):** never run `agents`/`observations`/`findings` through `boundedValue` (`:237`) — it silently caps arrays at 100. Bound each string and cap arrays explicitly with a recorded `truncated` note.
- `src/fleet/types.ts`: `FleetErrorCode` `:172`, `FLEET_ERROR_CODES` `:183`, `FleetError` `:201`, `fleetExitCode` `:226` (exhaustive switch, **no `default`** — `INVALID_INPUT→2 NOT_FOUND→3 …TIMEOUT→7 CANCELLED→8`; no new codes needed). `FleetInventoryFinding` `:376`, `FleetFieldValue` `:276`, `FLEET_PROBE_OUTCOMES` `:507`, `FleetProbeRecord` `:571`.
- `src/fleet/runtime.ts`: `FleetRunContext` `:43`, `createRunContext` `:71`, `throwIfCancelled` `:97`, `remainingMs` `:109`, `probeEnv` `:161`, `probe` `:185`, `mapBounded` `:272` (**order preserved by index, not completion** — load-bearing for byte-stability).
- `src/fleet/inventory.ts`: `collectFleetInventory` `:1282` (**sync**), `classifyPath` `:263`, `conflictGroupId` `:1019` (the sha256-prefix stable-id idiom).
- `src/fleet/provenance.ts`: `collectFleetProvenance` `:1006` (**async**, `runContext` required). Its `:1031` shape is the precedent to copy — collect the fleet unscoped, then filter for emission, so totals stay fleet-wide.
- `src/fleet/cli.ts`: `write()` `:496`, `emitLastResort` `:503`, `requireValue` `:490`, `parseDeadlineMs` `:242`, `fleetRunInputs` `:259`, `withSignals` `:276`, `isFleetJsonInvocation` `:291`, `fleetParserFailureEnvelope` `:303` with its **null-prototype** positional map `:325`.
- `src/fleet/mcp.ts`: `registerFleetMcpTools(server, asText)` `:164`, `FLEET_TOOL_INPUT` `:41`, `runFleetTool` `:91` (its `collect` param type is hardcoded to the inventory/provenance input shape at `:95` — **widen it** for `domain`/`live`).

**Blockers in existing code (change, do not work around):**
- `src/fleet/output.ts:33` `FLEET_COMMANDS` — add `"fleet.status"`, or `validateFleetEnvelope` throws `INTERNAL_ERROR` out of the very helper that guarantees a parseable envelope (the comment at `:36-42` records this exact burn).
- `src/fleet/output.ts:43` `FLEET_COMMAND_DATA_KEYS` — add the `"fleet.status"` entry listing **every** key the report renders and the suite asserts.
- `src/fleet/cli.ts:325` positional map — add `status`, or `fleet status --json --bogus` mislabels itself a validate failure.
- `src/fleet/cli.ts:449` `contract validate`'s action is sync — make it `async` when `write()` becomes awaited. `src/index.ts:1451` already `await program.parseAsync()`.
- `tests/mcp-catalog-regressions.mjs:8-19` regex-asserts the tool list against source **as text** — add the new name and keep `src/fleet/mcp.ts` in the scanned set.

**Test harness:**
- `tests/fleet-provenance-regressions.mjs` is the shape to copy: `skip()`, `check()`, guarded `seedHome()`, `snapshotTree()` (content hash + mtime), `cli()` with real OS pipes, `envelope()`, `rawCopy()`.
- **DW-54 is a hard lesson: do not repeat it.** 1.3's suite throws `SkipSuite` for its whole body when any of the three live sources is absent, so on a fresh clone or in CI *nothing* is verified. Split this suite: host-independent cases (synthetic registries, fake CLI entry, bounds, output purity, flush safety, MCP parity) must run **everywhere**; only the live-source cases may skip.
- `tests/portable-test-paths-regressions.mjs:7-8` fails the build on a literal `/(home|Users)/<name>` in any `*-regressions.mjs` — derive from `userInfo().homedir`.
- `scripts/run-tests.mjs:102-105` `SUITES` — a suite is invisible until listed.
- `.coverage-floor.json` lines/statements 57.07, functions 43.61, branches 72.22; `scripts/coverage-ratchet.mjs:57` fails at `now < min - 0.2`.
- `mise.toml:40-45` `[tasks."fleet:inventory"]` (`depends = ["build"]`) is the pattern.
- README: `## Fleet provenance` spans 162–247; `## Orienting in a repo` starts 248; MCP tool list under `## MCP server usage` at 319+.
- DW-6 records two suites already red on main. Do not attribute them to this story.

## Tasks & Acceptance

**Execution:**
- `src/utils/stdout.ts` -- new: `writeStdout(text): Promise<void>` (awaits the `write` callback, awaits `"drain"` when `write` returns false, swallows `EPIPE`) and `exitAfterFlush(code): Promise<never>` (flushes stdout **and** stderr, then `process.exit(code)`). -- the guarantee must be an awaited drain, not the absence of a call; `exitAfterFlush` keeps forced termination for paths with open handles while removing the truncation.
- `src/fleet/cli.ts` -- make `write()` `async` and await `writeStdout`; make the `contract validate` action `async`; add `status: STATUS_COMMAND` to the positional map at `:325`. -- the fleet path is correct today by accident; this makes it correct by construction.
- `src/index.ts` -- in the `audit` action, replace `console.log(...) ; process.exit(n)` with `await writeStdout(...)` + `await exitAfterFlush(n)` at all four JSON/report sites (`:1181`, `:1185`, `:1193`, `:1197`). -- the status core parses this child's stdout, so its truncation is now a correctness dependency, not a latent bug.
- `src/fleet/runtime.ts` -- extract `probe`'s body into an internal bounded-child runner and add `captureSelf(ctx, entry, args, cwd?): Promise<{outcome, value, code}>` which spawns `process.execPath` (the one deliberate absolute-path spawn — a PATH `node` would be a different runtime) and **keeps stdout on a nonzero exit**. -- `audit` exits 1 on a drifted repo by design; `probe` would throw those findings away.
- `src/fleet/types.ts` -- add `FLEET_STATUS_DOMAINS` (the nine), `FLEET_STATUS_STATES` + `FLEET_STATUS_STATE_PRECEDENCE` (`error > unobserved > unsupported > fail > warn > skip > pass`), `FLEET_STATUS_MAX_AGENTS`/`_MAX_OBSERVATIONS_PER_AGENT`/`_MAX_FINDINGS`/`_MAX_DETAILS`/`_AUDIT_CONCURRENCY`, `FleetStatusDomain`, `FleetStatusState`, `FleetStatusObservation`, `FleetStatusAgent`, `FleetStatusDomainRollup`, `FleetStatusHostFinding`, `FleetStatusScope`, `FleetStatusTotals`, `FleetStatusHealth`, `FleetStatus`. -- one file owns the fleet vocabulary, so a reported field cannot exist without a declared owner beside it; the `FleetStatus*` prefix avoids every name already taken by inventory and provenance.
- `src/fleet/status.ts` -- the core: `RULE_DOMAIN` (static rule-id → domain table, with an unmapped rule landing in a declared default **and** raising a finding so a new rule cannot disappear); `resolveStatusScope(options, rows)`; `observeFromInventory(row)`; `observeFromProvenance(facts, row)`; `resolveAuditCli(env)` (`PJ_FLEET_CLI_ENTRY` when set, else `resolvePjanglerRoot()/dist/index.js`; a missing entry is a categorized collection error, never a crash); `auditRepository(ctx, entry, repoPath, registryPath)` via `captureSelf`, invoking `audit <repo> --json [--registry <path>]` and **never** `--live` (that flag only reaches the credentialed `--profile` path, `src/index.ts:1176-1181`) — it drops `auditedAt`, `redactHome`s `repo`, resolves owner through `recipeRegistry.ownerOf`, and categorizes non-JSON as `error`, timeout as `unobserved`; `rollUp(observations)` under the precedence; `collectFleetStatus(options): Promise<FleetStatus>` composing them with `mapBounded` at `FLEET_STATUS_AUDIT_CONCURRENCY`. -- one core; both adapters call exactly this, and `PJ_FLEET_CLI_ENTRY` is the documented observation-injection seam that makes the child failure, timeout, and cancellation cases real rather than mocked.
- `src/fleet/output.ts` -- add `"fleet.status"` to `FLEET_COMMANDS` and to `FLEET_COMMAND_DATA_KEYS` (`contract_path`, `contract_version`, `scope`, `totals`, `health`, `agents`, `domains`, `host`, `findings`, `probes`, `truncated`); add `formatFleetStatusReport(status)` in the `formatFleetProvenanceReport` house style, leading with the verdict then observation time, contract/version provenance, total/resolved/unresolved agent counts, per-domain pass/fail/warn/skip/unobserved/error counts, overall completeness/health, and the highest-priority actionable findings. -- an operator on the human path must see *why*, not only *that*.
- `src/fleet/cli.ts` -- register `fleet status` with `--agent`, `--domain`, `--live`, `--project-registry`, `--agent-registry`, `--contract`, `--deadline-ms`, `--json`; validate `--domain` against `FLEET_STATUS_DOMAINS` (`INVALID_INPUT`, naming the nine) and `--agent` against the registry **before any probe or child spawns**; reuse `fleetRunInputs`/`withSignals`/`write`. -- DW-56 records 1.3 validating `--agent` only after the whole sweep; do not repeat it.
- `src/fleet/mcp.ts` -- widen `runFleetTool`'s `collect` input type and register `pjangler_fleet_status` with `z.strictObject({ ...FLEET_TOOL_INPUT, domain: z.string().optional(), live: z.boolean().optional() })`, threading `extra.signal`. -- schema equivalence with the CLI is the AC.
- `src/fleet/index.ts` -- re-export the status surface and the new type/const names. -- the barrel is how Story 1.5 consumes this instead of re-deriving it.
- `tests/fleet-status-regressions.mjs` -- cover every I/O matrix row against the real built `dist/index.js`; drive audit failure/malformed/timeout/cancellation with a fake CLI entry (a pid-recording script) injected through the documented `PJ_FLEET_CLI_ENTRY` seam; amplify a real registry copy until the `--json` payload exceeds 64 KiB and assert byte-identical output across regular file, pty (`script -qec`, skipped if absent), shell pipe, and Node `spawn` capture; assert two consecutive runs are byte-identical; snapshot content+mtime around every invocation. **Host-independent cases must not skip** (DW-54). -- the story's evidence bar is a real built CLI at a payload the defect can actually reach.
- `tests/mcp-server-regressions.mjs` -- add real stdio `pjangler_fleet_status` calls (success, `NOT_FOUND`, bad domain, partial audit, deadline, cancellation) each deep-equal-compared against the same case through the built CLI under identical env and cwd. -- only a real subprocess pair proves parity.
- `tests/mcp-catalog-regressions.mjs` -- add `pjangler_fleet_status` and keep `src/fleet/mcp.ts` in the scanned source set. -- otherwise the catalog silently stops covering it.
- `scripts/run-tests.mjs` -- add `tests/fleet-status-regressions.mjs` to `SUITES` beside the fleet entries. -- a suite not listed never runs.
- `mise.toml` -- add `[tasks."fleet:status"]` with `depends = ["build"]`, mirroring `fleet:provenance`. -- a gate that fails with `ERR_MODULE_NOT_FOUND` on a fresh clone teaches nothing.
- `README.md` -- add `## Fleet status` after line 247 (flags, the nine domains and what each observes today, the seven states and their precedence, what `--live` does and does not authorize, the two verdicts, the exit taxonomy, and that an unhealthy fleet still exits 0); add `pjangler_fleet_status` to the MCP list. -- operators and agents both land here first.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- record what this story leaves: the systemd/live-process/Bloodbank-liveness observers it can only report `unsupported`, the remaining ~34 unflushed `process.exit()` JSON sites in `src/index.ts`, and whether DW-15/DW-2/DW-49 widen now that status reports those domains. -- the ledger is how a later story inherits the real state.

**Acceptance Criteria:**
- Given the live registries and a built CLI, when `pjangler fleet status --json` runs unfiltered, then every registered agent id appears exactly once in `data.agents`, each carries an observation for **all nine** domains, `data.scope.total_registered_agents` equals the inventory's `registered_agents`, and no domain is absent from `data.domains`.
- Given no `--live`, when status runs, then a process trace of the run contains no network call and no mutation of any registry, repo, profile, or unit, the audit-fed domains are `unobserved` with a reason naming `--live`, and `health.complete` is false.
- Given `--live` and a repo whose audit reports a host-scoped `fail`, when status runs, then that finding appears exactly once in `data.host` (deduped by rule id) with its `scope:"host"` preserved, appears in **no** per-agent record, and does not make `health.healthy` false for any agent or for the fleet.
- Given `--live` and a repo whose audit reports a project-scoped `warn`, when status runs, then the agent's domain rolls up to `warn`, `health.healthy` stays true, and the finding preserves rule id, owner, scope, status, summary, and bounded details.
- Given `--agent <id>`, when status runs, then `data.agents` holds exactly that agent, `scope.selected_agents` is 1, `scope.total_registered_agents` is the whole fleet, the label identifies the result as scoped rather than fleet-complete, and no probe or audit child ran for any other agent.
- Given `--domain registry`, when status runs with `--live`, then zero audit children and zero provenance probes are spawned, only the registry domain is emitted, and the result never implies the other eight were observed.
- Given a fake CLI entry that prints non-JSON for one repository, when status runs with `--live`, then that agent's audit-fed domains are `error` with a categorized collection error, `health.complete` is false, exit is 0, and every other agent's record is byte-identical to the same run without the fake entry.
- Given a fake CLI entry that hangs for one repository, when status runs with `--live`, then that agent's audit-fed domains are `unobserved` with reason `timeout`, unrelated agents are fully reported, exit is 0, and the recorded child pid is gone.
- Given the serialized `--json` payload exceeds 64 KiB, when the real built CLI writes to a regular file, a pty, a shell pipeline, and a Node `spawn` capture, then all four receive byte-identical content ending in exactly one newline, and each parses.
- Given `pjangler audit --json` on a repository set whose report exceeds 64 KiB, when its stdout is captured through a pipe and through `spawn`, then both are complete and parse — proving the flush fix on a path that still calls `process.exit`.
- Given `--deadline-ms` smaller than a hanging audit child needs, when status runs, then the envelope is `ok:false` with code `TIMEOUT` and exit 7, and no result claiming `healthy` is emitted; given SIGINT instead, then `CANCELLED` and exit 8 with no surviving child.
- Given an MCP client calls `pjangler_fleet_status` with the same agent, domain, live, overrides, contract, and deadline as a CLI `--json` run under identical env and cwd, when both complete, then `command`, `data`, and `error` deep-equal and `isError` equals `!ok`; given the MCP request is aborted mid-child, then it reports `CANCELLED` in the same shape with no surviving child.
- Given a fleet amplified past `FLEET_STATUS_MAX_AGENTS` and an agent past `FLEET_STATUS_MAX_OBSERVATIONS_PER_AGENT`, when status runs, then totals still count everything, `truncated[]` names the dotted paths, each clipped record carries a `retrieval` command that returns the omitted detail, and `health.complete` is false while `health.healthy` is unaffected by the clip alone.
- Given `~/.hermes/fleet.env` holds live Plane API keys, when status runs with `--live`, then no key name or value appears in the JSON, the human report, the findings, or any child environment, and no child's stderr is read.
- Given two consecutive runs over unchanged state, when both `data` payloads are compared, then they are byte-identical; and given any invocation under isolated `HOME`/`XDG_*`, then a content+mtime snapshot of the scratch tree, the tracked contract, and every probed repository's `.git/index` is unchanged.
- Given a clean checkout, when `npm run typecheck && npm run build && npm test` runs, then `tests/fleet-status-regressions.mjs` appears in `node scripts/run-tests.mjs --list`, it and both MCP suites pass, its host-independent cases run without any live source present, and `npm run coverage:check` does not trip the floor.

## Spec Change Log

## Review Triage Log

## Design Notes

**Why the recipe audit runs as a child process.** `runAudit` is synchronous and calls `spawnSync`
with no timeout — `systemctl --user` twice, `git ls-files --stage`, and `npm view` once. In-process,
a single hung `systemctl` blocks the event loop, so neither the whole-run deadline nor SIGINT can be
honoured, and AC6's per-repository timeout is unimplementable. As a bounded child it is killable,
isolated, and concurrency-capped. The cost is that the status core now depends on
`pjangler audit --json` being parse-safe — which is why the flush fix is a dependency of this story
rather than adjacent cleanup, and why the suite proves the audit path at >64 KiB directly.

**Why `--live` gates the audit and nothing else.** AC10 forbids an implicit network request without
`--live`, and the bmad rule's `npm view` is a real one (8 s timeout, 1 h cache, degrades to skip).
Provenance's `git` probes are local reads and stay on the default path, exactly as Story 1.3 shipped
them. So `--live` has one honest meaning here: *may reach the host and the network, read-only*. It
does not conjure a systemd, process, or Bloodbank observer — those stay `unsupported`, named, with
the story that owns them.

**Seven states, one precedence, applied within one domain then across domains:**
`error > unobserved > unsupported > fail > warn > skip > pass`. `skip` means *declared not
applicable* and does not reduce completeness; `unobserved` means *applicable but not read* and does.
`unsupported` means *no adapter exists in this release* — counted and visible, but it cannot make
`complete` permanently false, which would make the flag meaningless. `warn` never gates `healthy`,
matching `gatesProject` (`src/recipes/types.ts:189`).

**Two verdicts, provenance's split — not inventory's.** `FleetInventoryHealth` folds `truncated` into
`healthy` (`inventory.ts:1563`); `FleetProvenanceHealth` (`types.ts:614`) deliberately does not, and
its comment explains why. Follow provenance: a clipped but drift-free run is
`healthy:true, complete:false`, and `fleet_complete` is true only for an unfiltered run where every
registered row and every applicable domain was actually observed.

**One observation shape, every domain:**

```ts
{ domain: "profile", agent_id: "candystore-pm", state: "fail",
  rule_id: "hermes.runtime-singleton", owner: "hermes-agent", rule_scope: "project",
  summary: "profile directory is a symlink, not a real directory",
  details: ["~/.hermes/profiles/candystore-pm -> ../shared"],
  finding_id: "a3f19c4e", source: "recipe-audit",
  retrieval: "pjangler fleet status --agent candystore-pm --domain profile --json" }
```

`finding_id` is a sha256 prefix over `(scope, agent_id, domain, rule_id, field)` — the
`conflictGroupId` idiom (`inventory.ts:1019`) — so an id is stable across runs and across the CLI/MCP
pair, which is what turns the parity check into a deep equality rather than a resemblance. Sort key
is `(agent_id, domain, rule_id)`. Nothing time-, duration-, pid-, or completion-order-dependent may
enter `data`: the child's `auditedAt` is dropped at the boundary and `repo` is `redactHome`d.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean, zero errors.
- `npm run build` -- expected: `dist/index.js` and `dist/mcp-server.js` regenerated.
- `node dist/index.js fleet status` -- expected: exit 0; report names 28 agents, all nine domains, `healthy`/`complete` verdicts, audit-fed domains `unobserved` pending `--live`.
- `node dist/index.js fleet status --json | cat` -- expected: one complete parseable envelope through a real pipe, `ok:true`.
- `node dist/index.js fleet status --live --json | cat` -- expected: exit 0; host block deduped; per-agent audit findings present.
- `node dist/index.js fleet status --agent pjangler-pm --json` -- expected: exit 0, one agent, fleet-wide `total_registered_agents`, scoped label.
- `node dist/index.js fleet status --agent nope; echo $?` -- expected: `3`, `NOT_FOUND`, no child spawned, no stack trace.
- `node dist/index.js fleet status --domain bogus; echo $?` -- expected: `2`, `INVALID_INPUT`, names the nine domains.
- `node dist/index.js fleet status --live --deadline-ms 1; echo $?` -- expected: `7`, `TIMEOUT`.
- SIGINT to a `--live` run behind a hanging fake CLI entry -- expected: exit `8`, `CANCELLED`, recorded pid gone.
- `A=$(node dist/index.js fleet status --json); B=$(node dist/index.js fleet status --json); [ "$A" = "$B" ]` -- expected: identical.
- Amplified-registry payload >64 KiB captured to file, via `script -qec`, via `| cat`, and via Node `spawn` -- expected: four byte-identical captures, each parsing.
- `node dist/index.js audit --json | wc -c` against a >64 KiB report, and the same through `spawn` -- expected: equal byte counts, both parse (the flush fix).
- `node dist/index.js fleet inventory --json` and `fleet provenance --json` before and after this story -- expected: `data` unchanged.
- `node tests/fleet-status-regressions.mjs` -- expected: all checks ok, exit 0, and non-zero checks executed with no live source present.
- `node tests/mcp-server-regressions.mjs` and `node tests/mcp-catalog-regressions.mjs` -- expected: pass, including the CLI/MCP deep-equality cases.
- `npm test` -- expected: no new failures beyond the two pre-existing ones recorded as DW-6.
- `npm run test:coverage && node scripts/coverage-ratchet.mjs` -- expected: floor not tripped.
- `mise run fleet:status` -- expected: builds first, then reports.
- `git status --porcelain` after every run, plus each probed repo's `.git/index` mtime -- expected: unchanged.

## Auto Run Result

Status: done
Blocking condition: none

### Summary of implemented change

Story 1.4 adds `src/fleet/status.ts`, a read-only core that traverses the registry
ONCE and emits one aggregate plus one stable per-agent record covering **all nine**
observation domains -- each either observed or carrying an explicit
`unobserved`/`unsupported` reason, so a domain can never disappear silently. It is
exposed through two equal thin adapters, `pjangler fleet status` and the MCP tool
`pjangler_fleet_status`.

Host-scoped rule results are reported once, deduped by rule id, in `data.host`:
never folded into an agent record, never a registry-wide claim, never a reason an
agent is unhealthy. That is the PJAN-84 category error, and repeating it fleet-wide
would have undone it 28 times over.

The recipe-owned audit rules feed it as **bounded child processes**. `runAudit` is
synchronous and shells out with `spawnSync` and no timeout, so in process a single
hung `systemctl` makes the whole-run deadline and SIGINT unimplementable. As a
child it is killable, isolated, concurrency-capped, and receives a narrow
allowlisted environment carrying no credential. The cost is that the status core
now parses `pjangler audit --json`, which is why the flush fix is part of this
story rather than adjacent cleanup.

`src/utils/stdout.ts` replaces "just do not call `process.exit()`" -- a property
maintained by a comment -- with an awaited drain: `writeStdout` (awaits the write
callback and `"drain"`, swallows only EPIPE) and `exitAfterFlush` (drains stdout
AND stderr, then exits). The fleet writer awaits it, and the `audit` command adopts
both, keeping its documented nonzero exit on a drifted repository while removing
the truncation.

### Files changed

| file | change |
| --- | --- |
| `src/utils/stdout.ts` | NEW. `writeStdout` / `exitAfterFlush`: the flush guarantee as an awaited drain rather than the absence of a call |
| `src/fleet/status.ts` | NEW. `RULE_DOMAIN`, `DOMAIN_FIELD`, `AUDIT_PER_AGENT_DOMAINS`, `PROVENANCE_FED_DOMAINS`, `AUDIT_CHILD_ENV_KEYS`, `resolveStatusScope`, `observeFromInventory`, `observeFromProvenance`, `resolveAuditCli`, `auditChildEnv`, `auditRepository`, `rollUp`, `collectFleetStatus` |
| `src/fleet/types.ts` | the nine domains, seven states, one precedence, five caps, and the `FleetStatus*` shapes |
| `src/fleet/runtime.ts` | `probe`'s body extracted into `runBoundedChild`; new `captureSelf` (spawns `process.execPath`, KEEPS stdout on a nonzero exit) and `FleetCaptureResult` |
| `src/fleet/output.ts` | `"fleet.status"` in `FLEET_COMMANDS` and `FLEET_COMMAND_DATA_KEYS`; `formatFleetStatusReport` |
| `src/fleet/cli.ts` | `fleet status` registered; `write()` is async and awaits `writeStdout`; `contract validate`'s action is async; `status` added to the positional word map |
| `src/fleet/mcp.ts` | `runFleetTool`'s `collect` input widened to `FleetToolCollectInput`; `pjangler_fleet_status` registered with `domain`/`live` |
| `src/fleet/provenance.ts` | optional `probeAgentIds`, so a `--agent` scope does not probe another agent's checkout (DW-65) |
| `src/fleet/index.ts` | the status surface, `captureSelf`, and the new type/const names re-exported |
| `src/index.ts` | the `audit` action is async and flushes: `writeStdout` at both write sites, `exitAfterFlush` at all four exits |
| `tests/fleet-status-regressions.mjs` | NEW, 35 cases. A SYNTHETIC fleet, so 33 of them run with no live source present (DW-54) |
| `tests/mcp-server-regressions.mjs` | `pjangler_fleet_status` schema parity, five CLI/MCP subprocess pairs, and a partial-collection pair |
| `tests/mcp-catalog-regressions.mjs` | the new tool name |
| `scripts/run-tests.mjs` | the suite listed in `SUITES` |
| `mise.toml` | `[tasks."fleet:status"]` with `depends = ["build"]` |
| `README.md` | `## Fleet status` -- flags, the nine domains, the seven states, what `--live` does and does not authorize, the two verdicts, the exit taxonomy; plus the MCP tool list |
| `CHANGELOG.md` | the `feat` and `fix` entries this story owes |
| `.coverage-floor.json` | ratcheted -- coverage rose on all four metrics |
| `_bmad-output/implementation-artifacts/deferred-work.md` | DW-63 ... DW-68 |
| `dist/*` | rebuilt |

### Verification performed

| check | outcome |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build` | `dist/index.js` 1.1mb, `dist/mcp-server.js` 934kb regenerated |
| `node dist/index.js fleet status` | exit 0; 28 agents, 734 observations, all nine domains, `healthy:false`, `complete:false` |
| `node dist/index.js fleet status --live` | exit 0 in ~1.8s; 28 audit children, 1042 observations, 6 host findings deduped, per-domain states differentiated |
| `--json` through a real pipe | 540 921 bytes, byte-identical to the file capture, parses -- 8x past the 64 KiB buffer |
| determinism | two runs byte-identical, with and without `--live` |
| `--agent pjangler-pm --json` | one agent, `total_registered_agents` 28, scoped label, 3 probes (2 fleet-wide + its own), zero children for any other agent |
| `--agent nope` / `--domain bogus` | exit 3 `NOT_FOUND` / exit 2 `INVALID_INPUT` naming the nine, both before any spawn |
| `--domain systemd --live` / `--domain registry --live` | zero audit children, zero probes, one domain emitted |
| `--live --deadline-ms 1` | exit 7, `TIMEOUT`, `data: null` |
| SIGINT behind a hanging injected entry | exit 8, `CANCELLED`, 4 recorded child pids, zero survivors |
| one repo's child hangs | that agent's audit-fed domains `unobserved` (`reason: timeout`), other 27 unaffected, exit 0 |
| one repo's child prints non-JSON | that agent's audit-fed domains `error`, every other agent byte-identical to the clean run, exit 0 |
| `PJ_FLEET_CLI_ENTRY` at a missing file | exit 0, all audit-fed domains `unobserved` (`audit-cli-unavailable`), inventory/provenance domains still fully reported |
| `audit --json` at 3 711 514 bytes | complete and parsing through a shell pipe AND a `spawn` capture; still exits 1 on a drifted repo |
| CLI/MCP parity | `command`/`data`/`error` deep-equal for five scopes plus a partial collection; `isError === !ok`; schema one-for-one |
| credential exclusion | neither key name nor sentinel value in the JSON, the human report, the findings, or the audit child's environment |
| `fleet inventory --json` / `fleet provenance --json` vs the baseline `HEAD` build | `data` deep-equal -- stories 1.2 and 1.3 undisturbed |
| `node tests/fleet-status-regressions.mjs` | 35 cases, all ok |
| the same suite with both live registries pointed at nonexistent paths | 33 ok, 2 skipped -- DW-54's gap closed by construction |
| `npm test` | 66 attempted, 64 passed, 2 failed -- `pjan-23` and `pjan-67-trusted-lifecycle`, the two pre-existing failures DW-6 records, unchanged |
| `npm run test:coverage` + ratchet | lines/statements 59.09 -> **60.20**, functions 44.94 -> **46.14**, branches 73.19 -> **73.46**; floor raised, not tripped |
| `mise run fleet:status` | builds first, then reports |
| zero-write snapshot around every invocation | content+mtime of the scratch tree, the tracked contract and every probed `.git/index` unchanged on all 35 cases, including the failing and cancelled ones |

### Residual risks

- **`health.complete` can never be true on this build.** `systemd`, `live_process`
  and Bloodbank liveness have no observer (DW-63), and on the live fleet 13 agents
  declare a `hermes.repo` that does not exist, so `release_provenance` carries 39
  genuinely `unobserved` facts. `unsupported` deliberately does not reduce
  `complete`, but `unobserved` does -- so the flag is honest and permanently false
  until stories 1.8/1.9/1.10 land.
- **A domain rollup can read `unobserved` while a real failure sits under it**
  (DW-68). On a default run `profile` reads `unobserved` for the two symlinked
  profile directories, because the audit half was not read. `health.failed` counts
  them and `data.domains[].counts` shows them; the single-word state does not.
- **`rollUp` refines the declared precedence** (DW-67). `unsupported` steps aside
  when a domain produced anything else. Without it a `template_scaffold` domain
  with 135 real failures reported `unsupported`.
- **34 unflushed `process.exit()` JSON sites remain in `src/index.ts`** (DW-64).
  `project doctor --json` and `project identity --json` are the two most likely to
  be captured by automation and both still truncate through a pipe.
- **The audit child's environment allowlist can go stale** (DW-66). A rule that
  later reads a new environment key will see it unset rather than fail loudly.
