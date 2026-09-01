---
title: 'Story 1.5: Make Partial Health Truthful and Actionable'
type: 'feature'
created: '2026-09-01'
status: 'in-progress'
baseline_revision: 'd5caa98b8cd63ead5c7f0594d0b135c4b448e7c6'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-4-deliver-parse-safe-registry-wide-fleet-status.md'
  - '{project-root}/contracts/fleet-contract.yaml'
warnings: ['oversized', 'multiple-goals']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 1.4 reports *what* every domain observed; it cannot say whether the answer is
**trustworthy or actionable**. `health.healthy` is `byState.fail === 0 && byState.error === 0`
(`status.ts:1584`), so a default run over the live fleet — where three of nine domains have no
observer at all (DW-63) and every audit-fed domain is `unobserved` — still reports
`healthy: true`. That is precisely what FR4 forbids: *"its aggregate result cannot claim healthy
when an applicable required domain was skipped, truncated, stale, or left unobserved."* Nothing
declares which gaps are **authorized**: the three `unsupported` domains are literals at
`status.ts:766/780/793` with no contract key behind them, `contract_version` is validated and never
compared, `activation.routing_prerequisites` is read by nothing (DW-2), and `row.classification` is
the constant `"managed_agent"` for every well-formed row (DW-30). And no finding is actionable:
`FleetStatusObservation` (`types.ts:785`) carries no severity, no observed-vs-desired pair, no repair
class and no next action, so FR30 is unmet; `fleet status` exits 0 on any collected result, so a
machine client must parse prose to decide what to do.

**Approach:** A new health evaluator, `src/fleet/health.ts`, that classifies every observation on
four *separate* axes — applicability, evidence strength, freshness, and state — and derives severity,
repair class and one exact next action from real fields (`fixable`, `rule_scope`, the contract) rather
than prose. A new optional `health_policy` block in the fleet contract is the only thing that can
**justify** a skip, warning, deferred capability or managed exception; anything unjustified keeps the
fleet from claiming proof. The aggregate gains a three-way `verdict` (`healthy` / `unhealthy` /
`unproven`) that is what the report and `exit_category` lead with, so "healthy" can no longer be
claimed over an unread fleet — while `health.healthy` keeps its story-1.4 drift-only meaning beside
it. Two runs are correlated read-only through `--baseline <path>`, producing explicit transitions on
stable `finding_id`s.

## Boundaries & Constraints

**Always:**
- **Read-only, still.** No mutation of any registry, repo, profile, unit, or contract at runtime.
  `--baseline` opens a file for reading and nothing else. Snapshot content+mtime around every
  invocation, as story 1.4's suite does.
- **`data` stays deterministic.** No timestamp, age, duration, pid, hostname or completion order may
  enter the envelope — the invariant stated at `status.ts:40` and `provenance.ts:41`. Freshness is
  emitted as a **bucket** (`current`/`stale`/`unknown`/`not_applicable`), never as an age, and the
  reference instant is captured **once** per run and never serialized.
- **A bound on what the envelope CARRIES never moves what it CONCLUDES.** Every new count
  (`members`, `unjustified`, `stale`, `contradictions`) is computed over every *selected* agent, not
  over the emitted records. This is the exact defect story 1.4's review found twice.
- **Every new vocabulary is a `const` tuple in `src/fleet/types.ts` with a doc comment**, in the
  `FLEET_STATUS_*` house style, and every one of them must be *read* by code — a precedence or
  severity constant nothing iterates is decoration (the defect found in
  `FLEET_PROVENANCE_STATUS_PRECEDENCE`).
- **Host-scoped findings stay out of both verdicts and out of every agent record.** PJAN-84's
  category error is not to be re-introduced under a new field name.
- **A recommended command is read-only unless it is labelled.** `next_action_class` is
  `"read-only"` or `"requires-authorization"`, and the second must name the authorization.
- **No credential** in any new field, next action, transition, or baseline echo.

**Block If:**
- The `health_policy` block cannot be added to the contract without changing an *existing* declared
  authority, projection, classification or retired mode. Widening those is story 1.1's authority.
- Making an existing story-1.4 acceptance criterion false is the only way to satisfy a 1.5 criterion.
  (Redefining `health.healthy` is not permitted; add a verdict beside it.)

**Never:**
- Never implement a `systemd`, `live_process` or Bloodbank-liveness observer. Stories 1.8, 1.9 and
  1.10 own those. This story only lets the contract **authorize** their absence.
- Never make `fleet status` exit nonzero on a collected result *by default*. The nonzero projection
  is opt-in behind `--exit-code`; gating CI is story 1.21's job, and `mise run fleet:status` must
  stay green on an unhealthy fleet.
- Never persist state to disk to compute a transition. The baseline is supplied by the operator.
- Never resolve a contradiction by choosing the more favourable value, and never drop either side.
- Never promote a scoped, stale, deferred, exception or unsupported result into `fleet_complete`,
  into `proven`, or into anything equivalent to explicit Bloodbank activation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Default run, unread halves | no `--live`, audit-fed domains `unobserved` | `verdict: "unproven"`, `proven: false`, `healthy` unchanged from 1.4, `exit_category: "incomplete"`, exit 0 | none |
| Proven clean | every required domain observed, no fail/error, every non-pass justified | `verdict: "healthy"`, `proven: true`, `exit_category: "ok"`, exit 0 | none |
| Proven drift | a project-scoped `fail` | `verdict: "unhealthy"`, severity `critical`/`high`, repair class + exact next action, `exit_category: "unhealthy"` | none |
| Deferred capability, declared | contract `health_policy.deferred_capabilities` names `live_process` | state `unsupported`, `applicability: "deferred"`, `justification.policy` names the entry, repair `blocked`, next action names the owning story; does not reduce `proven` | none |
| Deferred capability, undeclared | same domain, policy entry removed | same `unsupported` state, `justification: null`, counted in `health.unjustified`, `proven: false` | none |
| Stale evidence | `board_confirmed_at` older than the policy's `max_age_days` | `freshness: "stale"`, counted in `health.stale`, `proven: false`, verdict `unproven` | none |
| Declared-only capability | registry says `activation: true`, nothing observed it | `capability_readiness: "unproven"`, `evidence: "declared"`, never `ready`, never equivalent to activation | none |
| Contradiction | store read says the profile path is a symlink, the audit rule reports `pass` for the same field | both observations kept, worse state wins the rollup, one `status-contradiction` finding owned by the domain, scope marked incomplete | none |
| Baseline diff | `--baseline <prior status json>` | `transitions[]` with `appeared`/`resolved`/`state_changed`/`severity_changed`/`evidence_changed`; unchanged findings carry the same `finding_id` on both sides and emit nothing | unreadable/unparseable baseline → `INVALID_INPUT`, exit 2, naming the path |
| `--exit-code` on drift | `--exit-code` with `verdict: "unhealthy"` | exit **10**, envelope still `ok: true` with full `data` | none |
| `--exit-code` on gap | `--exit-code` with `verdict: "unproven"` | exit **11**, envelope still `ok: true` | none |
| Contract without `health_policy` | schema-1 contract | loads and validates; every non-pass is unjustified; `proven: false` with a finding naming the missing block | none |
| MCP parity | `pjangler_fleet_status` with `baseline`/`exitCode` | `data` deep-equals the CLI `--json` run; `data.health.exit_category` is the machine discriminant | same error codes as CLI |

</intent-contract>

## Code Map

**New (this story):**
- `src/fleet/health.ts` — the evaluator. Greenfield: `grep -n "severity\|applicab\|freshness\|repair" src/fleet/status.ts` returns **zero** hits for all four.
- `tests/fleet-health-regressions.mjs` — new suite, the truth table.

**The contract, and why it must grow (`contracts/fleet-contract.yaml`, 399 lines):**
- Root keys today: `schema_version` `:27`, `contract_version` `:28`, `compatibility` `:30`,
  `x-delonet/provenance` `:34`, `authorities` `:38`, `projections` `:205`, `classifications` `:242`,
  `service_model` `:330`, `activation` `:348`, `retired` `:368`.
- **Nothing in the contract declares a deferred capability, a freshness policy, an allowed warning,
  or an allowed skip.** Verified: `freshness`, `stale`, `ttl`, `max_age`, `observed_at`,
  `deferred` return zero hits in both the contract and `src/fleet/*.ts`. The only clock anywhere in
  `src/fleet/` is the run deadline (`runtime.ts:45,56,72,85,109`).
- `classifications.managed_shared_service.entries` `:268-285` is the only place `policy_domains`
  carries data; `intentionally_unmanaged.entries` `:300` is `[]`. `FLEET_STATUS_DOMAINS`
  (`types.ts:674`) is deliberately **not** that axis — the doc comment at `types.ts:668` says so and
  cites these lines. Do not conflate them.
- `activation.execution_authority` `:355-359`: `field: agents.{agent_id}.bloodbank.enabled`,
  `owner: hermes-agent-registry`, `strict: true`, `default: deny`. This is the contract basis for
  the `approval-gated` repair class. `activation.routing_prerequisites` `:360-366` is read by no
  code (DW-2) — leave it to story 1.10; do **not** start evaluating it here.
- Root allowlist is `FLEET_CONTRACT_ROOT_KEYS` (`types.ts:30`). **Adding a root key is a grammar
  change**, so `schema_version` goes to `2`, `compatibility.max_schema_version` to `2`, and
  `FLEET_SUPPORTED_SCHEMA_VERSIONS` (`types.ts:12`, consumed at `contract.ts:258`) widens to
  `{min: 1, max: 2}` so a schema-1 contract still loads with `health_policy` absent.
  `contract_version` → `1.1.0` (semver enforced at `contract.ts:304` against `SEMVER`
  `contract.ts:44`; it is validated but never compared, so nothing branches on it).
- Validation seam: `validateFleetContract` `contract.ts:215` → private stages `validateVersion` `:252`,
  `validateStructure` `:288`, `validateAuthorityConflicts` `:631`, `validateClassifications` `:665`,
  `validateRetiredModes` `:704`. A new `validateHealthPolicy` stage belongs beside them, emitting
  `FleetDiagnostic`s in the same shape. `FleetContract` type is at `types.ts:151-152` onward.
- `collectFleetExtensions` `contract.ts:159` strips `x-` keys **before** the root-key check — that is
  why `x-delonet/provenance` is not in the allowlist. `health_policy` is real policy, not an
  extension, so it goes in the allowlist.

**The status core to extend (`src/fleet/status.ts`, 1603 lines):**
- `collectFleetStatus` `:1016` — the composition point. Reads the contract `:1022-1035`, collects the
  inventory **unscoped** at `rowCap: Infinity` `:1053`, resolves and rejects both filters *before any
  spawn* `:1062`, builds `ctx` `:1066`, reads the raw agent registry `:1097`, runs provenance `:1113`,
  runs audit children `:1141-1196`, builds per-agent records `:1240-1394`, rolls up domains
  `:1483-1497`, and computes `totals` `:1533` and `health` `:1583-1611`.
- `observation(ctx, input)` `:618` and `interface ObservationInput` `:605` — the **single**
  construction point for every observation. Every new axis is added here, so a field cannot exist on
  one path and not another.
- `statusFindingId(scope, agentId, domain, ruleId, field, source)` `:360` — the sha256-prefix idiom
  (`conflictGroupId`, `inventory.ts:1019`). **Do not change its tuple.** A changed id breaks the
  baseline join, which is the one thing AC5 requires to be stable across runs and adapters.
- `rollUp` `:435` and `stateRank` `:423` — `unsupported` yields when the domain produced any other
  state (DW-67). Keep. A *justified* `unsupported` and an *unjustified* one roll up identically;
  the difference lives in `justification`/`unjustified`, not in the state.
- `ruleState` `:462` maps `pass|fail|warn|skip`; `provenanceState` `:483` maps provenance status.
  `RULE_DOMAIN` `:104`, `AUDIT_PER_AGENT_DOMAINS` `:188`, `PROVENANCE_FED_DOMAINS` `:199`,
  `DOMAIN_FIELD` `:216`, `FACT_PREFIX_DOMAIN` `:243`, `EXCLUDED_RULES` `:172`.
- Sources: `SOURCE_REGISTRY` `:263`, `SOURCE_PROVENANCE` `:264`, `SOURCE_AUDIT` `:265`,
  `SOURCE_DECLARED_GAP` `:266` — these ARE the evidence-strength axis's raw input.
- The three `unsupported` literals to put behind the contract: `bloodbank` `:766`, `systemd` `:780`,
  `live_process` `:793`.
- Host worst-wins accumulation `:1370-1394` and the disagreement note `:1465-1481` — the existing,
  working contradiction case. AC8 generalizes it; do not rewrite it.
- Per-agent verdicts `:1387-1391`: `healthy: !own.some(fail|error)`,
  `complete: !own.some(unobserved|error) && !clipped`. Keep both; add the member class beside them.
- `readAgentRegistryRaw` `inventory.ts:485`, `readProjectRegistryRaw` `:489`,
  `resolveInventoryStores` `:527` (`stores.agents.inspectedPath` `:562`, `stores.projects` `:569`).
  Status already reads the agent raw store at `status.ts:1097` for `project_path`; the **project**
  raw store is where the freshness timestamps live and is not read yet.
- **The real freshness fields, verified present in the live registry:**
  `projects.{slug}.ticket_provider.board_confirmed_at` (contract authority `:61`; live values dated
  `2026-08-28T20:12:51.748Z` at `~/.config/pjangler/projects.yaml:31,60,106,152,175`),
  `.identifier_fetched_at` (`:59`), `agents.{agent_id}.provisioned_at` (`:93`). These are the only
  declared, populated timestamps in either store.

**Types to widen (`src/fleet/types.ts`, 930 lines):**
- `FleetStatusObservation` `:785-811`, `FleetStatusAgent` `:814-831`, `FleetStatusDomainRollup` `:834`,
  `FleetStatusHostFinding` `:851`, `FleetStatusScope` `:862`, `FleetStatusTotals` `:875`,
  `FleetStatusHealth` `:893`, `FleetStatus` `:917`.
- `FleetInventoryFinding` `:376-383` — `{code, field, agent_id, source, severity, detail}` with
  `FLEET_FINDING_SEVERITIES = ["error","warn","info"]` `:373`. `FleetStatus.findings` is typed as
  this `:926`. Its three-value severity is **not** the finding-priority axis AC7 sorts by; declare a
  separate `FLEET_STATUS_SEVERITIES` rather than overloading it.
- `FleetProvenanceFact.desired`/`.observed` and their renderer `factLines` (`output.ts:699-712`) are
  the **precedent to copy** for the observed-vs-desired pair — do not invent a new shape.
- `FleetInventoryRow.classification` `:326` is `FleetFieldValue<string>`, assigned the bare literals
  `"managed_agent"`/`"unclassified"` at `inventory.ts:984-986` and typed against nothing — DW-30.
  Type it against `FLEET_CLASSIFICATION_IDS` `:46`; that is what makes the `exception` and
  `unclassified` member buckets reachable instead of always empty.
- `matchException(group, contract)` `inventory.ts:1086` (re-exported `index.ts:32`, called once at
  `:1208`) matches **conflict groups only**, by `entry.source` and an exact `participants` set. It
  is the only exception lookup in the codebase. Reuse it for the `exception` member bucket; do not
  widen its signature.

**Output (`src/fleet/output.ts`, 1021 lines):**
- `FLEET_COMMANDS` `:38` (already carries `"fleet.status"`), `FLEET_COMMAND_DATA_KEYS` `:48-74` with
  the `"fleet.status"` entry at `:70-73` (11 keys). The validator asserts **presence, never absence**
  `:384-388`, so adding keys is safe — add the new top-level ones (`transitions`) to the list anyway,
  which is this file's stated discipline `:61-69`.
- `validateFleetEnvelope` `:367` asserts the envelope's **root** keys exactly `:373`. A new root
  field would fail; every new value goes inside `data`.
- `fleetEnvelopeExitCode` `:363` is `return envelope.ok || !envelope.error ? 0 : fleetExitCode(...)`
  at `:364` — **`ok` short-circuits before health is ever consulted.** This is the single choke point
  for the exit taxonomy. `fleetSuccessEnvelope` `:295`, `fleetFailureEnvelope` `:306`,
  `renderFleetJson` `:358`, `normalizeFleetError` `:287`.
- `formatFleetStatusReport` `:892-994`. Headline `:896-904`, the "why" row `:905-914`, scope line
  `:915`, Domains `:917-928`, Host `:930-938`, Agents `:940-948` (cap `REPORT_MAX_AGENTS` 40),
  "Highest-priority observations" `:950-973` (sorts by `actionRank` `:840-844`, then agent, then
  domain, cap 40), Findings `:975-984` (cap `REPORT_MAX_FINDINGS` `:536` = 25 — **and not sorted at
  all**, so a gating finding is silently dropped at position 26), truncation notes `:986-990`.
  Helpers `statusGlyph` `:825`, `statusColor` `:832`, `observationLines` `:846-863`, `agentLine` `:865`,
  `findingGlyph` `:556`, `section` `:412`.
- Bounds: `MAX_STRING` `:76` = 512, `MAX_DETAILS` `:77` = 20, `MAX_NEXT_ACTIONS` `:78` = 20,
  `bounded` `:154`, `redactHome` `:189`, `cappedStrings` `:235`, `boundedNotes` `:241`.
  **Trap, carried from 1.2/1.3/1.4:** never route `transitions` or any findings array through
  `boundedValue` `:249` — it slices arrays at `MAX_ITEMS` `:221` = 100 with no per-item identity.
  28 agents × 9 domains crosses that trivially. Use an explicit `FLEET_STATUS_MAX_*` cap plus a
  recorded `truncated` entry, the `FLEET_INVENTORY_MAX_ROWS` idiom (`types.ts:250-259`).

**CLI and MCP:**
- `src/fleet/cli.ts`: `fleet status` registered `:493`, flags `:495-502`, action `:503-537`,
  `StatusOptions` `:68-71`, `InventoryOptions` `:57-64`. `statusEnvelope` `:254-270` returns
  `ok: true` unconditionally and **must keep doing so** — `validateFleetEnvelope` nulls `data` on
  `ok: false` (documented `:245-253`), so drift may never become an error envelope.
  `write()` `:597-609` is async and awaited at all eight call sites; **`:608`
  (`process.exitCode = fleetEnvelopeExitCode(envelope)`) is the one line the taxonomy touches.**
  `withSignals` `:321-333`, `fleetRunInputs` `:304-311`, `parseDeadlineMs` `:287-295`,
  `requireValue` `:389-393`, `emitLastResort` `:612-622` (hardcodes 6), the null-prototype
  positional map **`:370-374`** (lookup `:375-377`; note: `:325` is the SIGINT listener, not the map).
- `src/index.ts:1485-1492` is the parser-failure path; it uses raw `process.stdout.write`, not
  `writeStdout`. Out of scope here (DW-64) — do not "fix it in passing".
- `src/fleet/mcp.ts`: `registerFleetMcpTools` `:210`, `pjangler_fleet_status` `:254-284`, input schema
  `:265-274` over `FLEET_TOOL_INPUT` `:43-49`, `runFleetTool` `:116-145`, `statusEnvelope` `:180-190`,
  handler returns `{ isError: !envelope.ok, ...asText(envelope) }` `:283`. `fleetEnvelopeExitCode` is
  never imported here, so **an MCP client has no exit category today** — `isError` is `false` for a
  fully unhealthy fleet. `data.health.exit_category` is the placement that gives both adapters the
  same discriminant with no envelope-shape change. `structuredContent`/`outputSchema` are
  deliberately unused (`:205-208`); leave them that way.
- `FleetErrorCode` `types.ts:172-186`, `FleetError` `:201`, `fleetExitCode` `:226-238` — exhaustive
  switch, **no `default`**, bands 2-8 all taken. `AUTHORITY_CONFLICT`/`INVALID_CLASSIFICATION`/
  `RETIRED_MODE`/`UNSUPPORTED_SCHEMA_VERSION` are never constructed directly; they reach a caller by
  first-diagnostic promotion (`status.ts:1026-1034`, `cli.ts:187-192`). **`unhealthy` and
  `incomplete` are `ok: true` states and must NOT become `FleetErrorCode` members** — that would
  force `ok: false` and null the data. They get their own map, applied only under `--exit-code`.

**Test harness:**
- `tests/fleet-status-regressions.mjs` (1863 lines) is the shape to copy, and 52 of its 54 checks are
  host-independent because the whole fleet is synthetic. Helpers: `skip` `:98`, `skipCase` `:110`,
  `check` `:115`, `checkAsync` `:126`, `git` `:155`, `makeRepo` `:163`, `agentRow` `:198`,
  `writeAgentRegistry` `:222`, `writeProjectRegistry` `:229`, `seedScratch` `:263`, `isolation`
  `:313-339`, `snapshotTree` `:345`, `snapshotShared` `:404`, `cli()` `:433`, `envelope` `:455`,
  `status` `:472`, `agentNamed` `:498`, fake-entry seam `entry()` `:518` + `RECORD_PREAMBLE` `:526`
  + `syntheticReport` `:558`, canned rules `:575-589`.
- **DW-54 is the hard lesson and this suite already applies its fix:** skipping is per-case via
  `skipCase` (`:110`, swallowed at `:120`), never a whole-body `SkipSuite`. Only `:1816` and `:1835`
  are live-gated. The new suite must be host-independent end to end.
- `tests/portable-test-paths-regressions.mjs:8` fails the build on `/(home|Users)/<name>` in any
  `*-regressions.mjs`. Derive from `userInfo().homedir`, as `fleet-status-regressions.mjs:74` does.
- `scripts/run-tests.mjs` `SUITES` **:57-123** — a suite is invisible until listed; add the new one
  beside `fleet-status-regressions` (`:105`). `--list` parsed `:127`, prints and exits `:142-146`.
- `.coverage-floor.json`: lines/statements 60.2, functions 46.14, branches 73.46.
  `scripts/coverage-ratchet.mjs:57` fails at `now < min - 0.2`.
- `mise.toml`: `[tasks."fleet:status"]` **:64**, `depends = ["build"]` **:68**, run **:69**, and the
  comment block **:59-63** that states "unhealthy or incomplete fleet still exits 0" — **that
  statement stays true** and the comment gains `--exit-code`. `fleet-status-regressions.mjs:1511`
  pins the task and its `depends` within its first 600 chars.
- **DW-6 is stale:** both suites it names (`tests/pjan-23-regressions.mjs`,
  `tests/pjan-67-trusted-lifecycle-regressions.mjs`) pass on `d5caa98`, fixed by `91e2128` and
  `5f27761`. Close it in the ledger pass; do not attribute a red suite to this story on its word.
- Ledger entries this story touches: **DW-63** (the three observer-less domains — this story gives
  them contract authorization, not observers), **DW-67** (the open modelling question: whether a
  domain with no adapter deserves an axis separate from a domain with an unread half — the
  `applicability` axis is the answer), **DW-68** (a rollup reading `unobserved` over a proven `fail`
  — `evidence` makes the underlying proof visible), **DW-30** (classification is a constant),
  **DW-21** (`healthy` conflates drift with a presentation cap), **DW-44** (exits 4/5 exercised by
  nothing), **DW-55** (`parse: ok` reported where only a stat happened — an evidence-strength lie).

## Tasks & Acceptance

**Execution:**
- `contracts/fleet-contract.yaml` -- add the `health_policy` root block with `required_domains`,
  `deferred_capabilities[]` (`domain`, optional `capability`, `reason`, `owner_story`),
  `allowed_warnings[]` (`rule_id`, `reason`, `owner`), `allowed_skips[]` (`domain` or `rule_id`,
  `reason`), and `freshness[]` (`field`, `max_age_days`, `applies_to`); declare the three
  observer-less capabilities (`systemd`, `live_process`, `bloodbank`/liveness) with the stories that
  own them; bump `schema_version` to `2`, `compatibility.max_schema_version` to `2`, and
  `contract_version` to `1.1.0`. -- the contract is the only place a gap can be *authorized*, and
  DW-63's three literals currently authorize themselves.
- `src/fleet/types.ts` -- add `FLEET_STATUS_APPLICABILITIES`, `FLEET_STATUS_EVIDENCE`,
  `FLEET_STATUS_FRESHNESS`, `FLEET_STATUS_SEVERITIES`, `FLEET_STATUS_SEVERITY_PRECEDENCE`,
  `FLEET_STATUS_REPAIRS`, `FLEET_STATUS_VERDICTS`, `FLEET_STATUS_EXIT_CATEGORIES`,
  `FLEET_STATUS_EXIT_CODES`, `FLEET_STATUS_MEMBER_CLASSES`, `FLEET_STATUS_MEMBER_PRECEDENCE`,
  `FLEET_STATUS_TRANSITION_KINDS`, `FLEET_STATUS_MAX_TRANSITIONS`; widen `FleetStatusObservation` and
  `FleetStatusHostFinding` with `applicability`/`evidence`/`freshness`/`severity`/`repair`/`observed`/
  `desired`/`next_action`/`next_action_class`/`justification`; add `FleetStatusLifecycle`
  (`desired_state`, `observed_state`, `capability_readiness`, `activation` — four fields, never one
  boolean), `FleetStatusMembers`, `FleetStatusTransition`, `FleetHealthPolicy`; extend
  `FleetStatusHealth` with `verdict`, `proven`, `exit_category`, `stale`, `unjustified`,
  `contradictions`, `members`; extend `FleetStatus` with `transitions`; widen
  `FLEET_SUPPORTED_SCHEMA_VERSIONS` to `{min:1, max:2}`; add `health_policy` to
  `FLEET_CONTRACT_ROOT_KEYS`; type `FleetInventoryRow.classification` against
  `FLEET_CLASSIFICATION_IDS`. -- one file owns the vocabulary, so a reported axis cannot exist
  without a declared owner beside it.
- `src/fleet/contract.ts` -- add a `validateHealthPolicy` stage beside the existing five, emitting
  `FleetDiagnostic`s in their shape: reject an unknown domain, a `max_age_days` that is not a
  positive integer, a deferred entry with no `reason`/`owner_story`, and a `field` no authority
  declares; treat the whole block as **optional** so a schema-1 contract still loads. -- an
  unvalidated policy block is a policy that lies once someone typos a domain name.
- `src/fleet/health.ts` -- new: `classifyObservation` (the four axes, plus derived severity, repair,
  next action and justification), `evaluateFreshness(field, isoValue, referenceMs, policy)`
  returning a bucket and never an age, `resolveJustification(observation, policy)`,
  `classifyMember(agent, row, contract)`, `detectContradictions(observations)`,
  `compareStatusFindings(a, b)` (the AC7 sort: gating impact, then severity, then scope, then agent,
  then domain, then `finding_id`), `diffFindings(baseline, current)`, and
  `evaluateFleetHealth(...)` returning `verdict`/`proven`/`exit_category`/`members` and the new
  counts. -- a truth table wants its own file and its own suite; folding it into a 1600-line
  `status.ts` is how it becomes untestable.
- `src/fleet/status.ts` -- thread `health.ts` through: capture `referenceMs` once; read the project
  raw store for the freshness timestamps; enrich every observation at the single construction point
  `observation()` `:618` and at the host-finding construction `:1372-1391`; put the three
  `unsupported` literals `:766/:780/:793` behind `health_policy.deferred_capabilities`; carry
  `FleetStatusLifecycle` on each agent record; run `detectContradictions` and add its findings;
  sort `findings` with `compareStatusFindings` **before** any cap; load and diff `--baseline`;
  replace the `health` literal `:1583-1611` with `evaluateFleetHealth`, leaving `healthy` and
  `fleet_complete` computing exactly as they do now and giving `complete` exactly one new conjunct
  (`contradictions === 0`, which AC8 requires and which can only ever make `complete` *falser*).
  -- 1.4's verdicts are pinned by its own suite; 1.5 adds beside them rather than redefining them.
- `src/fleet/inventory.ts` -- resolve `row.classification` against `FLEET_CLASSIFICATION_IDS` and the
  contract's declared classes instead of emitting the bare literal at `:984-986`. -- DW-30: without
  this the `exception` and `unclassified` member buckets are always empty and AC7's counts are
  decoration.
- `src/fleet/output.ts` -- add `transitions` to `FLEET_COMMAND_DATA_KEYS["fleet.status"]`; make
  `formatFleetStatusReport` lead with `verdict` (not `healthy`) and print the reason it is not
  `healthy`; add severity, repair class, observed→desired and the next action to `observationLines`
  and to the Findings block; **sort the Findings block with `compareStatusFindings` before applying
  `REPORT_MAX_FINDINGS`**; add the `members` line and a Transitions section; make
  `fleetEnvelopeExitCode` accept an optional projected code so `ok: true` can still exit nonzero
  under `--exit-code`. -- a gating finding dropped at position 26 of an unsorted list is the exact
  "one high-volume domain hides a higher-priority blocker" failure AC7 names.
- `src/fleet/cli.ts` -- add `--baseline <path>` and `--exit-code` to `fleet status`; validate
  `--baseline` through `requireValue` and reject an unreadable or unparseable file as
  `INVALID_INPUT` **before any probe or child spawns**; pass the projected exit code through
  `write()` at `:608`. -- DW-56 is the recorded lesson about validating an input after the sweep;
  do not repeat it for a third flag.
- `src/fleet/mcp.ts` -- add `baseline: z.string().optional()` and `exitCode: z.boolean().optional()`
  to the `pjangler_fleet_status` schema `:265-274`, threading both to the same core. -- schema
  equivalence with the CLI is the AC, and `data.health.exit_category` is what finally gives an MCP
  client a discriminant.
- `src/fleet/index.ts` -- re-export the health surface and every new type/const name. -- the barrel
  is how stories 1.6-1.10 consume this instead of re-deriving it.
- `tests/fleet-health-regressions.mjs` -- new suite, host-independent end to end, driving a synthetic
  fleet through the real built `dist/index.js`: the classification truth table over complete, scoped,
  stale, skipped, deferred, exception-authorized, failed, errored, contradictory and recovered
  observations; stable ids across CLI and MCP; every transition kind through `--baseline`; the sort
  order; ownership, repair class and next action on every non-pass; each exit category with and
  without `--exit-code`; a contract with `health_policy` absent; and a content+mtime snapshot around
  every invocation. -- snapshots, mocks and a zero exit are explicitly insufficient evidence for this
  story.
- `tests/fleet-status-regressions.mjs` -- update the checks that assert the story-1.4 report headline
  and the `fleet:status` mise comment, and add a check that `health.healthy` still computes exactly
  as 1.4 defined it. -- the guard against solving 1.5 by quietly redefining 1.4.
- `tests/mcp-server-regressions.mjs` -- add real stdio `pjangler_fleet_status` calls carrying
  `baseline` and `exitCode`, each deep-equal-compared against the same case through the built CLI
  under identical env and cwd. -- only a real subprocess pair proves parity.
- `scripts/run-tests.mjs` -- add `tests/fleet-health-regressions.mjs` to `SUITES` beside the fleet
  entries. -- a suite not listed never runs.
- `README.md` -- document the four axes, the three-way verdict and how it differs from `healthy`, the
  `health_policy` block and what justifies what, the exit categories and `--exit-code`, `--baseline`
  and the transition kinds; add the two new MCP inputs. -- operators and agents both land here first.
- `mise.toml` -- update the `fleet:status` comment block `:59-63` to name `--exit-code` while keeping
  the default-exit-0 statement true. -- the comment is pinned by a check; a stale one fails the build.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- close DW-6 (verified passing on
  `d5caa98`), record what DW-63/DW-67/DW-68/DW-30 look like after this story, and add whatever 1.5
  leaves behind. -- the ledger is how a later story inherits the real state.

**Acceptance Criteria:**
- Given a run in which every required domain was observed, no observation failed or errored, and
  every non-pass carries a `health_policy` justification, when status completes, then
  `health.verdict` is `"healthy"`, `health.proven` is true, `health.exit_category` is `"ok"`, and
  every observation carries a non-null `applicability`, `evidence` and `freshness`.
- Given the same fleet with one `health_policy` entry removed, when status runs, then that
  observation's `justification` is null, `health.unjustified` is at least 1, `health.proven` is
  false, `health.verdict` is `"unproven"`, and `health.healthy` is unchanged — proving the two
  verdicts are independent.
- Given a contract with no `health_policy` block at all, when status runs, then the contract loads
  and validates, every non-pass is unjustified, `proven` is false, and a finding names the missing
  block rather than the run failing.
- Given an agent whose registry row declares `activation: true` and whose gateway nothing observed,
  when status runs, then `lifecycle.desired_state`, `lifecycle.observed_state`,
  `lifecycle.capability_readiness` and `lifecycle.activation` are four separate values,
  `capability_readiness` is `"unproven"` with `evidence: "declared"`, and no field reports the agent
  as routing-ready or activated.
- Given a project registry whose `board_confirmed_at` for one agent is older than the policy's
  `max_age_days` and another agent's is newer, when status runs, then exactly the first is
  `freshness: "stale"`, `health.stale` is 1, `proven` is false, and no age, duration or timestamp
  appears anywhere in `data`.
- Given a store read that proves a failure and an audit rule that reports `pass` for the same agent
  and field, when status runs, then both observations are present, the domain rolls up to the worse
  state, exactly one `status-contradiction` finding names the domain and its owner, and
  `health.contradictions` is 1.
- Given any non-pass observation or host finding, when it is emitted in JSON or rendered in the
  report, then it carries a non-empty `owner`, an `observed` and `desired` pair, a `severity` from
  `FLEET_STATUS_SEVERITIES`, a `repair` from `FLEET_STATUS_REPAIRS`, and a `next_action` whose
  `next_action_class` is `"read-only"` unless the string itself names the required authorization.
- Given an audit rule reporting `fixable: true`, when its finding is rendered, then `repair` is
  `"automatic"` and `next_action` is the exact `pjangler migrate <rule_id> <repo> --dry-run`
  invocation; given a host-scoped rule, then `repair` is `"other-owner"` and the action routes to the
  host rather than to any repository.
- Given a fleet whose findings span several domains and severities, when they are emitted, then they
  are stable-sorted by gating impact, severity, scope, agent, domain and `finding_id`, the human
  report applies that sort **before** its cap, and a single gating finding among 200 low-severity
  ones appears in both outputs.
- Given every selected agent, when member classes are counted, then each agent lands in exactly one
  of healthy/unhealthy/incomplete/deferred/exception/unclassified, the six counts sum to the number
  of **selected** agents rather than to `emitted_agents`, and a fleet clipped past
  `FLEET_STATUS_MAX_AGENTS` produces the same six counts as the same fleet under the cap.
- Given a prior status document supplied through `--baseline`, when the current run differs, then
  `transitions[]` names every `appeared`, `resolved`, `state_changed`, `severity_changed` and
  `evidence_changed` finding by an unchanged `finding_id`, unchanged findings emit no transition,
  and a byte-identical baseline produces an empty `transitions[]`; given an unreadable or
  unparseable baseline, then `INVALID_INPUT` at exit 2 naming the path, with no probe spawned.
- Given `--exit-code`, when the verdict is `unhealthy` the process exits 10 and when it is `unproven`
  the process exits 11, in both cases with `ok: true` and complete `data`; given the same runs
  without `--exit-code`, then both exit 0 and `data.health.exit_category` still carries the
  discriminant.
- Given an MCP client calls `pjangler_fleet_status` with the same agent, domain, live, baseline,
  exitCode, overrides, contract and deadline as a CLI `--json` run under identical env and cwd, when
  both complete, then `command`, `data` and `error` deep-equal, every `finding_id` matches, and
  `data.health.exit_category` is identical.
- Given two consecutive runs over unchanged state, when both `data` payloads are compared, then they
  are byte-identical; and given any invocation under isolated `HOME`/`XDG_*`, then a content+mtime
  snapshot of the scratch tree, the tracked contract, and every probed repository's `.git/index` is
  unchanged.
- Given a clean checkout, when `npm run typecheck && npm run build && npm test` runs, then
  `tests/fleet-health-regressions.mjs` appears in `node scripts/run-tests.mjs --list`, it and both
  MCP suites pass, every one of its cases runs with no live source present, and
  `npm run coverage:check` does not trip the floor.
- Given the live fleet, when `node dist/index.js fleet status --live --json` runs, then the aggregate
  counts and a bounded sample of at least five findings are independently reconciled by hand to the
  current registry files and repository state — the story is not complete on a green suite alone.

## Spec Change Log

## Review Triage Log

## Design Notes

**Why a third verdict instead of redefining `healthy`.** FR4 forbids the *aggregate result* from
claiming healthy under an unobserved required domain. The tempting fix — folding `unobserved` into
`health.healthy` — breaks story 1.4's pinned criterion that a clean scoped slice reads
`healthy: true`, and it destroys the provenance split (`types.ts:614`) that keeps "the fleet is
wrong" separate from "this run did not see all of it". So `healthy` keeps its drift-only meaning,
`complete` keeps its coverage meaning, and `verdict` is the aggregate the report headline and
`exit_category` are derived from:

```
verdict = !healthy                                   -> "unhealthy"   (drift PROVEN)
        : !complete || stale > 0 || unjustified > 0  -> "unproven"    (nothing proven either way)
        : "healthy"
proven  = verdict === "healthy" && fleet_complete
```
A machine client reads `verdict`; `healthy` remains available as the component it always was.

**Four axes, because one word cannot carry four questions.** `state` says what was concluded.
`applicability` says whether it was required (`required` | `optional` | `not_applicable` |
`deferred` | `exception`). `evidence` says how strongly (`direct` — this run read the thing;
`declared` — a registry field asserts it and nothing verified it; `derived` — computed from other
observations; `absent`). `freshness` says whether the evidence is still current. DW-67 left open
"whether a domain with no adapter deserves a separate axis from a domain with an unread half" —
`applicability: "deferred"` beside `evidence: "absent"` is that axis, and it is why `unsupported`
does not need a different rank in `FLEET_STATUS_STATE_PRECEDENCE`.

**Evidence strength is what makes AC4 implementable in a release with three observer-less domains.**
"A timer is active, a gateway process exists, a deploy exited zero, a board says complete" all reduce
to the same thing here: `evidence: "declared"`. A `declared` observation may be `pass` on its own
record, but it may never set `capability_readiness: "ready"` and never contribute to `proven`. That
is the whole of "success text, process presence, ticket state, or historical evidence never overrides
current direct observations", expressed as a rule the type system can carry.

**Freshness is a bucket, never an age.** `data` must be byte-identical across two consecutive runs
(`status.ts:40`). An age in seconds is not. So the reference instant is captured once per run, each
policy entry declares `max_age_days`, and only the bucket is emitted. Two runs milliseconds apart
bucket identically unless a day boundary falls between them — so the suite drives staleness with
timestamps far from the threshold, never near it, and that constraint is stated in the suite.

**Derivation tables — real fields, not invented ones:**

| repair | condition | next action |
|---|---|---|
| `automatic` | audit rule, `rule_scope: "project"`, `fixable: true` | `pjangler migrate <rule_id> <repo> --dry-run` |
| `approval-gated` | touches `activation.execution_authority` (`strict: true`, `default: deny`) | the activation route, labelled `requires-authorization` |
| `blocked` | a contract-declared deferred capability | names the owning story; nothing to run in this release |
| `other-owner` | `rule_scope: "host"` | the host route — no work in any repository changes it |
| `manual` | everything else | the exact `pjangler fleet status` retrieval, or the owning board |

Severity is `state` × `applicability`: `error` → `critical`; `fail` on a required domain →
`critical`, elsewhere `high`; `unobserved` required → `high`, optional → `medium`; unjustified
`warn` or `stale` → `medium`; justified `warn`/`unsupported`, unjustified `skip` → `low`; `pass` and
justified `skip` → `info`.

**Exit categories, and why the projection is opt-in.** `unhealthy` and `incomplete` are `ok: true`
states — the command succeeded, the fleet did not — so they cannot be `FleetErrorCode` members
without nulling `data` (`output.ts:380`). They live in `data.health.exit_category`, which both
adapters carry, and project onto process exits 10 and 11 only under `--exit-code`. Default stays 0
because `fleet status` is an observation command: gating CI is story 1.21's job, and a `mise run
fleet:status` that is permanently red on the real (unhealthy) fleet teaches an operator to ignore it.
`unhealthy` outranks `incomplete` when both apply — a proven failure is more actionable than an
unread half.

**Contradiction, not resolution.** The host worst-wins accumulator (`status.ts:1370-1394`) already
proves the pattern: keep every reading, report the worst, and record the disagreement as data.
`detectContradictions` generalizes it to any two observations sharing `(agent_id, domain, field)`
whose states disagree across sources — which is DW-68's case, reachable today on a default run where
the store read proves a symlinked profile while the audit half is unread.

## Verification

**Commands:**
- `npm run typecheck` -- expected: clean, zero errors.
- `npm run build` -- expected: `dist/index.js` and `dist/mcp-server.js` regenerated.
- `node dist/index.js fleet contract validate --json | cat` -- expected: `ok:true` on the bumped
  schema-2 contract; and against a copy with `health_policy` removed, still `ok:true`.
- `node dist/index.js fleet status` -- expected: headline leads with the verdict, not with `healthy`.
- `node dist/index.js fleet status --json | cat` -- expected: one complete parseable envelope;
  `data.health` carries `verdict`, `proven`, `exit_category`, `stale`, `unjustified`,
  `contradictions`, `members`; every non-pass observation carries severity, repair and a next action.
- `node dist/index.js fleet status --live --json | cat` -- expected: exit 0; `verdict: "unhealthy"`
  on the real fleet; `exit_category: "unhealthy"`.
- `node dist/index.js fleet status --live --exit-code; echo $?` -- expected: `10`.
- `node dist/index.js fleet status --exit-code; echo $?` -- expected: `11` (audit-fed domains unread).
- `node dist/index.js fleet status --json > /tmp/base.json && node dist/index.js fleet status --baseline /tmp/base.json --json | cat`
  -- expected: `transitions: []`.
- `node dist/index.js fleet status --baseline /nonexistent --json; echo $?` -- expected: `2`,
  `INVALID_INPUT`, naming the path, no probe spawned.
- `A=$(node dist/index.js fleet status --json); B=$(node dist/index.js fleet status --json); [ "$A" = "$B" ]`
  -- expected: identical.
- `node dist/index.js fleet inventory --json` and `fleet provenance --json` before and after this
  story -- expected: `data` unchanged apart from `classification` gaining real values.
- `node tests/fleet-health-regressions.mjs` -- expected: all checks ok, exit 0, zero SKIPs.
- `node tests/fleet-status-regressions.mjs`, `node tests/fleet-contract-regressions.mjs`,
  `node tests/mcp-server-regressions.mjs`, `node tests/mcp-catalog-regressions.mjs` -- expected: pass.
- `npm test` -- expected: green; DW-6's two suites pass on `d5caa98` and are not this story's.
- `npm run test:coverage && node scripts/coverage-ratchet.mjs` -- expected: floor not tripped.
- `mise run fleet:status` -- expected: builds first, then reports, exit 0 on the unhealthy live fleet.
- `git status --porcelain` after every run, plus each probed repo's `.git/index` mtime -- expected:
  unchanged.

**Manual checks (if no CLI):**
- Reconcile the live `--live --json` aggregate by hand: pick five findings across at least three
  domains and confirm each one's `observed`, `owner` and `next_action` against the actual registry
  file, profile directory or repository on disk. A green suite over a synthetic fleet is not evidence
  that the real one is described correctly.
