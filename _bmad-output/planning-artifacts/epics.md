---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/fleet-convergence-live-assessment-2026-08-31.md
  - templates/hermes-agent/docs/fleet-control-plane/prd.md
  - templates/hermes-agent/docs/fleet-control-plane/architecture.md
  - docs/architecture.md
  - templates/hermes-agent/docs/architecture.md
  - templates/hermes-agent/docs/operations.md
  - skills/agent-fleet-operations/SKILL.md
  - skills/agent-fleet-operations/references/fleet-self-check.md
  - skills/agent-fleet-operations/references/hermes-fleet-updates.md
  - skills/agent-fleet-operations/references/config-mutation-safety.md
  - _bmad-output/implementation-artifacts/findings/PJAN-86.findings.json
uxDesign: not-applicable
project: pjangler
product: Registry-Wide Fleet Convergence Control Plane
status: complete
authorityOrder:
  - product-owner-approved live assessment
  - current fleet operational contracts and live evidence
  - current pjangler and Hermes architecture
  - historical fleet PRD and architecture
---

# Registry-Wide Fleet Convergence Control Plane - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for the
Registry-Wide Fleet Convergence Control Plane, decomposing the product-owner
approved live assessment, the historical Fleet Control Plane requirements, and
current PJangler and Hermes operational contracts into implementable stories.

The historical fleet PRD and architecture are baseline inputs only. The
2026-08-31 live assessment and current operational contracts explicitly
supersede n8n-centralized orchestration, old Hermes source paths, per-agent
Bloodbank consumers, checkpoint timers, and any assumption that registry
discovery grants execution authority.

## Requirements Inventory

### Functional Requirements

FR1: PJangler can discover the complete fleet from the Hermes Agent Registry,
resolve each agent's project, role, profile, runtime, service, board, and
Bloodbank references, and report registry entries that cannot be resolved
without silently dropping them.

FR2: PJangler exposes a registry-wide `fleet status` operation that inspects
all registered agents in one invocation and reports fleet aggregate health plus
per-agent findings for registry, project binding, template/scaffold, profile,
runtime, systemd, live process, Bloodbank, and release/provenance domains.

FR3: Every fleet status result is available as concise human output and as one
complete, parse-safe, versioned JSON document whose stdout is never truncated,
polluted by progress/ANSI text, or invalidated by immediate process exit.

FR4: Fleet status distinguishes project health, shared-host health, deferred
capabilities, unmanaged observations, blocked observations, and collection
errors; its aggregate result cannot claim healthy when an applicable required
domain was skipped, truncated, stale, or left unobserved.

FR5: The Project Registry and Hermes Agent Registry retain separate near-term
authority, while PJangler defines and validates their explicit ownership,
reference, projection, and update boundaries without requiring an immediate
physical registry merger.

FR6: PJangler validates global identity uniqueness and relationship integrity
across project ID, repository path, agent ID, role, profile name, board binding,
service unit, and Bloodbank target; duplicate ownership and conflicting
cross-registry projections are first-class findings.

FR7: The fleet contract supports explicit classifications for managed agents,
managed specialist/shared services, intentionally unmanaged entries, retired
entries, and unclassified observations, including ownership, rationale,
source, lifecycle state, and applicable policy.

FR8: PJangler reports the exact desired and observed provenance for every
managed deployment, including PJangler version, fleet-contract/schema version,
Hermes release/ref/SHA, template source and gitlink, scaffold manifest/version,
profile render generation, and effective executable.

FR9: PJangler validates tracked PM scaffold parity for every managed PM against
the pinned canonical template, reports missing, stale, locally modified, and
unexpected generated files separately, and never treats ignored runtime state
as tracked scaffold content.

FR10: PJangler validates every managed profile as a real contained directory
with identity metadata, override-only `config.delta.yaml`, generated
`config.yaml`, explicit Hindsight bank pin, canonical skills, and a passing
canonical renderer check; profile symlinks and semantic render drift are
distinct failures.

FR11: PJangler inventories profile-root entries that are not ordinary
registered agents, correlates them with live services/processes and declared
exceptions, and produces adoption, exception, retirement, or manual-review
recommendations without deleting ambiguous state.

FR12: PJangler validates the canonical service topology: at most one per-agent
messaging gateway service and one heartbeat timer/service pair, plus one
fleet-shared Bloodbank gateway; per-agent Bloodbank consumers, checkpoint
timers, duplicate gateways, and stale legacy units are reported as drift.

FR13: Service health evaluation is capability-aware and time-bounded: a
credential-less gateway is healthy only when explicitly deferred, disabled,
and inactive; an enabled gateway requires stable `Result`, `ExecMainStatus`,
restart count, and channel ownership evidence; heartbeat health requires a
successful latest tick rather than timer activity alone.

FR14: PJangler inventories live Hermes processes, attributes each process to a
registered agent, managed exception, systemd unit, profile, and executable
generation when possible, and reports duplicate, legacy, isolated, or
unattributable processes that a systemd-only view would miss.

FR15: PJangler validates Bloodbank routing metadata and the shared gateway
independently from target activation. A target is eligible only when a strict
explicit activation flag, fleet gateway scope, matching target ID, and nonblank
registered profile all pass; discovery or successful provisioning never
auto-enables a target.

FR16: PJangler exposes `fleet reconcile` as a pure dry-run by default and can
scope a plan to the entire fleet, selected agents, selected domains, a canary,
or a bounded rollout wave without changing files, registries, services,
processes, or external systems.

FR17: A reconciliation plan is a versioned machine-readable artifact containing
the observation snapshot/fingerprint, typed effects, ownership, dependencies,
preconditions, expected postconditions, risk and reversibility classification,
required approval gates, and reasons for every automatic, deferred, blocked,
or manual action.

FR18: Apply executes only an explicitly selected, still-current plan; it rejects
stale observations and changed preconditions, honors dependency order and
bounded concurrency, isolates an agent failure from unrelated agents, and
records resumable per-effect outcomes.

FR19: Registry, profile, configuration, and multi-file role mutations use their
canonical lock domains, preserve unknown/extension metadata and stable
timestamps, commit atomically, retain crash-recovery evidence, and restore or
resume without overwriting newer concurrent state.

FR20: Profile convergence uses the canonical base-plus-delta renderer and its
shared lock for seed, absorb, render, channel, voice, recovery, and backfill
paths; it can preview and apply all affected profiles while preserving
intentional overrides and refusing unsafe symlink or concurrent states.

FR21: Scaffold convergence fans the pinned canonical tracked assets to existing
managed roles, preserves unrelated repository work and ignored runtime bytes,
excludes generated caches/runtime droppings, verifies the recorded template
gitlink rather than a mutable worktree, and makes an unchanged rerun byte-stable.

FR22: Service reconciliation installs, updates, enables, disables, starts,
stops, and removes only positively owned units according to declared capability
state, then proves the bounded postconditions before persisting a healthy
service state.

FR23: Process reconciliation classifies isolated or legacy processes and can
produce a bounded drain/restart plan, but requires explicit approval before
terminating an unattributed or ambiguously owned process.

FR24: Fleet rollout starts with PJangler and ssbnk canaries and proceeds in
bounded waves. Each canary or wave has explicit entry criteria, stop conditions,
postcondition checks, evidence, rollback/resume state, and an operator decision
before dependent waves advance.

FR25: Bloodbank activation is a separately selectable rollout action performed
only after the target passes its activation contract and explicit operator
approval; failure or rollback returns the target to default-deny without
changing unrelated registry metadata.

FR26: PJangler exposes one shared fleet application core through CLI and MCP
adapters, with equivalent schemas, safety defaults, cancellation/deadline
behavior, registry overrides, and status/reconcile semantics.

FR27: PJangler can run recurring fleet checks without mutation, emit durable and
attributable drift/health evidence, deduplicate unchanged findings, and surface
new, worsened, recovered, deferred, and manually accepted states to downstream
automation without making that automation a source of truth.

FR28: CI and release gates consume the same fleet contracts to verify template
cleanliness and pinning, machine-output validity, schema compatibility, focused
and aggregate tests, package/version/tag/commit consistency, and absence of
unresolved release-blocking fleet findings.

FR29: Migration closeout produces a durable before/after report that maps every
requirement and planned effect to tests and live evidence, records remaining
exceptions and deferred activation, reconciles the owning ticket/epic status,
and refuses to equate documentation, a successful command exit, or a started
ticket with completion.

FR30: The controller provides actionable diagnostics and next actions for every
finding, including the owning registry/domain/repository and whether the repair
is automatic, approval-gated, blocked, or routed to a separate owner.

### NonFunctional Requirements

NFR1: All inspection and planning commands are read-only by default. Mutation
requires an explicit apply action and any destructive, external, process-stop,
or Bloodbank-activation effect requires its own visible authorization.

NFR2: The system is truthful under partial failure: collection errors,
timeouts, missing tools, stale observations, skipped domains, and unproven
postconditions remain visible and prevent false-green aggregate claims.

NFR3: Human and machine output is deterministic for the same observation,
stable-sorted, schema-versioned, UTF-8, bounded, and parseable through terminals,
pipes, files, subprocess capture, MCP, and CI.

NFR4: Reconciliation is idempotent and preservation-safe. An unchanged second
run produces no writes, service churn, regenerated timestamps, metadata loss,
duplicate external resources, or duplicate evidence events.

NFR5: Mutations are crash-consistent and concurrency-safe, use finite lock and
operation deadlines, release locks on process death, reject unsafe symlink and
path states, and never roll back over a newer out-of-band write.

NFR6: Ambiguous or unclassified profiles, runtimes, processes, services,
registry rows, and operator data are preserved. The MVP performs no automatic
runtime purge and no blind merge, deletion, adoption, or process termination.

NFR7: Literal credentials never enter tracked files, plans, JSON output, logs,
diagnostics, fixtures, process arguments, or broad child environments.
Credentials remain in approved runtime injection or `op://` reference paths.

NFR8: Fleet-wide operations use bounded concurrency, per-agent and global
deadlines, cancellation, and resumable checkpoints so one hung repository,
service manager query, renderer, or external adapter cannot stall or corrupt
the entire fleet.

NFR9: The status path remains useful offline and without n8n or external board
availability. External observations are opt-in or explicitly marked stale/skip;
systemd remains the local service manager and survival layer.

NFR10: Status and reconcile evidence includes safe timestamps, provenance,
observation generation, effect IDs, ownership, outcomes, restart/tick evidence,
and next actions without exposing raw credentials, private payloads, or
unbounded logs.

NFR11: The architecture supports the current 28-agent fleet and growth without
hard-coded agent lists or per-repository command orchestration; runtime and
memory use scale predictably with registered agents and bounded observations.

NFR12: CLI/MCP behavior remains compatible with Node.js 20+, TypeScript/ESM,
the singleton recipe registry, current project plan/apply transactions, YAML
and PostgreSQL project registry implementations, and existing Hermes template
and Bloodbank contracts.

NFR13: Tests run against isolated HOME, XDG, registries, repositories, profiles,
process fixtures, and fake systemd/Bloodbank adapters. They must not read,
mutate, stop, or activate production fleet state.

NFR14: Release and rollout proof uses current files, recorded pins, live bounded
service/process observations, and executable behavior; stale prose, cached
board state, mutable submodule worktrees, and command success text are not
sufficient evidence.

NFR15: Operator-facing commands explain the fleet at progressively useful
levels—summary, domain, agent, finding, and planned effect—without requiring
the operator to correlate multiple raw registry dumps.

NFR16: Host and repository paths are resolved from registries and configuration,
canonicalized and contained before use, and never rely on obsolete hard-coded
checkout paths or LAN addresses.

### Additional Requirements

- AR1: PJangler is the sole fleet control-plane policy owner. Repositories
  remain independent, Hermes owns agent execution, systemd owns local service
  lifecycle, and downstream workflow tools consume PJangler contracts rather
  than storing competing fleet truth.
- AR2: This is a brownfield epic. There is no greenfield starter-template
  story; initial work must establish the fleet domain model, schemas,
  observation boundary, and regression harness around current production
  contracts.
- AR3: The historical `fleet-contract.yaml` concept must be updated to describe
  the current service model, authority boundaries, schema versions, provenance,
  managed exceptions, activation state, and compatibility policy without
  duplicating mutable runtime observations.
- AR4: Project Registry owns project identity and project-to-board binding.
  Hermes Agent Registry owns operational agent/profile/routing records.
  Cross-registry projections must have one declared direction and a drift check;
  no story may silently make both writable owners of the same field.
- AR5: Registry discovery and Bloodbank execution authority are separate domain
  concepts and separate mutations. Global reconciliation may validate or
  preserve activation but cannot infer or automatically grant it.
- AR6: One fleet application service should compose adapters for project
  registry, Hermes registry, repository/parity, template provenance, profile
  renderer, systemd, process inventory, Bloodbank, release state, and evidence.
  CLI and MCP remain thin adapters to this same service.
- AR7: Existing recipe-owned audit rules may be reused as observations, but a
  host-scoped rule evaluated in one repository cannot be presented as a
  registry-wide claim. The controller owns registry traversal and aggregation.
- AR8: Machine output must set `process.exitCode` or otherwise allow stdout to
  drain; tests must exercise payloads larger than the pipe buffer through real
  CLI subprocess capture, file redirection, MCP, and failure exits. Snapshot and
  plan schemas require canonical stable ordering, content digests or equivalent
  generation fingerprints, additive version evolution, and explicit
  compatibility rejection for breaking or stale plans.
- AR9: Apply follows plan/apply transaction patterns already proven in
  PJangler: validate before mutation, record typed effects, persist truth last,
  preserve partial outcomes, and run postcondition observations against the
  actual application path.
- AR10: Profile mutations must use the canonical profile renderer and
  per-profile lock. Registry-aware profile work follows the single lock order
  `registry -> profile -> snapshot/check -> write/rollback -> unlock`.
- AR11: Exact config rollback/recovery must preserve protected original state
  and refuse unsafe hardlink, symlink, out-of-band replacement, or unverifiable
  filesystem conditions before installing a candidate.
- AR12: Canonical PM topology is one tracked PM role per repository, one real
  named profile, ignored role-local runtime state, one messaging gateway, and
  one heartbeat timer. Shared Bloodbank ingress is one fleet service.
- AR13: A gateway with no verified channel credential is intentionally deferred
  and must be disabled/inactive with inherited platform enablement explicitly
  overridden false; a heartbeat may remain independently healthy.
- AR14: Template/scaffold fanout must use the committed canonical template and
  pinned pjangler gitlink, distribute every owned changed asset as one versioned
  set, reject dirty or incomplete sources, and preserve all unrelated repository
  and runtime state.
- AR15: Extra profile and process classification precedes cleanup. The
  `fleet-bloodbank-gateway` shared profile and other specialist profiles need
  explicit kinds/policies rather than being forced into an ordinary PM shape.
- AR16: Rollout state must be durable outside tracked target repositories,
  support canary and bounded-wave selection, and survive interruption without
  losing which effects were planned, applied, proven, failed, rolled back, or
  deferred.
- AR17: Continuous checks publish evidence/findings through the existing event
  and ticket ownership conventions. They do not auto-open/close external issues
  or mutate boards unless a separately authorized adapter action is selected.
- AR18: n8n is optional future orchestration/visualization. No MVP acceptance
  criterion may require n8n availability, generated n8n workflows, or n8n-owned
  state.
- AR19: PJAN-86 defect classes become regression inputs: summary truthfulness,
  immediate post-deploy audit, deferred gateways, template/gitlink fidelity,
  generated-profile semantics, service stabilization, extension-preserving
  registry writes, safe path/lock behavior, and real full-live canary proof.
- AR20: Migration closeout must reconcile package version, Git tag, commit
  attribution, CI, template pins, live services/processes, renderer state,
  registry state, and owning board evidence before the epic can be declared
  complete.

### UX Design Requirements

Not applicable. This epic has CLI, MCP, daemon, registry, and operational
evidence surfaces rather than a graphical UI. Operator comprehension,
progressive detail, accessibility of plain-text output, and automation-safe
machine output are captured in FR3, FR4, FR17, FR30, NFR3, and NFR15.

### FR Coverage Map

FR1: Epic 1 - Discover every registered fleet member and unresolved entry.
FR2: Epic 1 - Inspect registry-wide health in one invocation.
FR3: Epic 1 - Emit complete human and parse-safe versioned JSON status.
FR4: Epic 1 - Preserve truthful aggregate semantics under partial observation.
FR5: Epic 1 - Define separate Project and Hermes registry authorities.
FR6: Epic 1 - Enforce global identity and relationship uniqueness.
FR7: Epic 1 - Classify managed agents, exceptions, retired, and unknown state.
FR8: Epic 1 - Report desired and observed fleet provenance.
FR9: Epic 1 - Validate tracked PM scaffold parity fleet-wide.
FR10: Epic 1 - Validate real generated base-plus-delta profiles.
FR11: Epic 1 - Classify extra profile-root entries without blind deletion.
FR12: Epic 1 - Validate canonical per-agent and shared service topology.
FR13: Epic 1 - Prove capability-aware service health over a bounded window.
FR14: Epic 1 - Attribute live Hermes processes and expose runtime sprawl.
FR15: Epic 1 - Validate Bloodbank routing separately from activation authority.
FR16: Epic 1 - Preview scoped fleet reconciliation without mutation.
FR17: Epic 1 - Produce versioned, reviewable reconciliation plan artifacts.
FR18: Epic 1 - Apply only current selected plans with resumable outcomes.
FR19: Epic 1 - Mutate registry and config state transactionally and safely.
FR20: Epic 1 - Converge generated profiles through the canonical renderer.
FR21: Epic 1 - Fan out pinned tracked scaffolds without disturbing runtime/WIP.
FR22: Epic 1 - Reconcile only positively owned systemd services and prove them.
FR23: Epic 1 - Plan safe handling of isolated or legacy processes.
FR24: Epic 1 - Roll out through canaries and bounded evidence-gated waves.
FR25: Epic 1 - Activate Bloodbank targets only through separate approval.
FR26: Epic 1 - Share one fleet core across equivalent CLI and MCP adapters.
FR27: Epic 1 - Run recurring read-only checks and durable drift evidence.
FR28: Epic 1 - Gate CI and releases on the same fleet contracts.
FR29: Epic 1 - Close migration only with complete current evidence.
FR30: Epic 1 - Provide actionable ownership and next actions for every finding.

## Epic List

### Epic 1: Registry-Wide Fleet Convergence Control Plane

The operator can establish one authoritative fleet view, observe real health,
plan and apply preservation-safe convergence, roll it out through canaries and
bounded waves, activate Bloodbank targets separately, and continuously prove
the resulting fleet.

The epic advances through five ordered delivery horizons that will be
decomposed into independently verifiable, developer-sized stories:

1. One Fleet, One Trustworthy Inventory
2. Know the Fleet's Real Health
3. Converge the Fleet Safely
4. Roll Out with Canary Confidence
5. Keep the Fleet Proven

Each horizon leaves a usable operator outcome and enables the next; none is a
single oversized story or a separate owning epic.

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9, FR10, FR11,
FR12, FR13, FR14, FR15, FR16, FR17, FR18, FR19, FR20, FR21, FR22, FR23,
FR24, FR25, FR26, FR27, FR28, FR29, FR30

## Epic 1: Registry-Wide Fleet Convergence Control Plane

The operator can establish one authoritative fleet view, observe real health,
plan and apply preservation-safe convergence, roll it out through canaries and
bounded waves, activate Bloodbank targets separately, and continuously prove
the resulting fleet.

### Story 1.1: Define Fleet Authority and Managed-State Contract

As a fleet operator,
I want a versioned and inspectable contract for fleet authority and managed-state classifications,
So that every later observation and reconciliation uses the same owners, boundaries, and exception semantics.

**Acceptance Criteria:**

**Given** the tracked canonical fleet contract
**When** PJangler loads and validates it
**Then** it declares a schema version, contract version, supported compatibility range, canonical PM service model, and the authoritative owner for project identity/board binding, agent/profile/routing records, generated profile inputs, tracked role scaffold, systemd lifecycle, live process observations, and Bloodbank activation
**And** no mutable runtime observation, credential, host-specific secret, or transient health result is stored in the contract.

**Given** Project Registry and Hermes Agent Registry describe related fleet state
**When** the authority rules are evaluated
**Then** Project Registry is authoritative for project identity and project-to-board binding, Hermes Agent Registry is authoritative for operational agent/profile/routing records, and every shared projection has one declared direction
**And** a field claimed as writable by both registries fails validation with the conflicting field path and both claimed owners instead of selecting one implicitly.

**Given** a fleet member or observed artifact
**When** it is classified under the contract
**Then** the supported lifecycle classes include managed agent, managed specialist/shared service, intentionally unmanaged, retired, and unclassified
**And** every nonstandard managed class requires stable identity, kind, owner, source/provenance, lifecycle state, rationale/notes, and its applicable policy domains.

**Given** the current canonical runtime model
**When** the contract is inspected
**Then** it specifies one real named profile, ignored role-local runtime, one per-agent messaging gateway, one per-agent heartbeat timer/service pair, and one fleet-shared Bloodbank command gateway
**And** per-agent Bloodbank consumers, checkpoint timers, n8n-owned truth, automatic activation-by-discovery, and obsolete hard-coded Hermes checkout paths are marked retired or invalid rather than accepted as alternate healthy modes.

**Given** a target whose Bloodbank metadata is discoverable
**When** the contract resolves its lifecycle and activation authorities
**Then** discovery, installation, health, routing readiness, and execution activation are separate states
**And** only the strict explicit activation field owned by the Hermes Agent Registry can grant execution authority.

**Given** a contract containing an unknown schema version, missing authority, invalid classification, conflicting owner, or retired service mode
**When** validation runs
**Then** it returns a deterministic nonzero categorized result with safe field-level diagnostics
**And** it performs zero registry, profile, repository, service, process, Bloodbank, or external writes.

**Given** a compatible contract containing namespaced extension metadata
**When** PJangler reads, validates, and serializes it
**Then** the extensions survive without semantic loss or becoming implicit policy
**And** an unchanged round trip is byte-stable where PJangler owns serialization.

**Given** the operator runs `pjangler fleet contract validate [--contract <path>] [--json]`
**When** no contract override is provided
**Then** the command resolves and validates the canonical tracked contract and human output reports its effective version, authorities, classifications, service model, and superseded modes
**And** `--contract` supports isolated fixtures and operator inspection, while `--json` emits the versioned result.

**Given** the operator runs the contract validation command against a malformed temporary contract
**When** validation fails
**Then** it fails before mutation with no credential or unbounded content in stdout or stderr
**And** its categorized diagnostics identify the invalid contract field safely.

**Given** the focused automated test suite runs under isolated HOME/XDG and temporary registry paths
**When** valid, extension-bearing, conflicting, malformed, retired-mode, and forward-incompatible fixtures are exercised
**Then** schema, authority, classification, preservation, and zero-write behavior are proven
**And** story completion additionally includes a real built CLI inspection of the tracked contract; documentation, typechecking, fixture-only mocks, ticket state, or exit code alone is insufficient evidence.

Requirements owned: FR5, FR7. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR6, NFR7, NFR12, NFR13, NFR14, NFR16.

### Story 1.2: Discover the Complete Fleet and Detect Identity Conflicts

As a fleet operator,
I want PJangler to enumerate every agent and correlate its identities across the two registries,
So that missing links, duplicate ownership, and unresolved members are visible before any health or repair claim is made.

**Acceptance Criteria:**

**Given** valid Project and Hermes Agent registries and the approved fleet authority contract from Story 1.1
**When** the fleet inventory core runs
**Then** it emits one stable inventory row for every raw Hermes registry agent entry, including agents with no matching Project Registry record
**And** it reports the independently counted source-row total, emitted-row total, unresolved-row total, and collection errors so no entry can disappear silently.

**Given** one Hermes agent row
**When** PJangler resolves its fleet identity
**Then** the row includes the agent ID, lifecycle classification, project ID when linked, canonical repository path, role and role directory, profile name and contained profile path, expected runtime path, expected owned unit names, stored board binding, and Bloodbank scope/target/activation references
**And** every value records its authoritative source or is explicitly null/unresolved rather than inferred from a convenient basename.

**Given** an agent project path that can be correlated with a Project Registry entry and repository `.project.json`
**When** the three identities agree under the declared projection rules
**Then** the inventory records the relationship as resolved
**And** the Manifest remains a read-only projection for this operation and is not promoted into a competing registry authority.

**Given** an agent whose project is absent from the Project Registry, whose repository or Manifest is missing, or whose referenced role/profile path does not exist
**When** discovery runs
**Then** the agent remains in the inventory with field-level unresolved findings and the owning source/path
**And** discovery continues for unrelated agents without creating a project, Manifest, role, profile, directory, registry row, or board.

**Given** duplicate or conflicting project IDs, canonical repository paths, agent IDs, profile names, board bindings, derived unit names, or Bloodbank target IDs
**When** global identity validation runs
**Then** every participant remains visible and receives the same stable conflict group identifier plus the conflicting field and owners
**And** the aggregate inventory is unhealthy unless the fleet contract explicitly permits that relationship through a matching managed-exception policy.

**Given** a symlinked, relative, nonexistent, or out-of-root registry path
**When** PJangler canonicalizes identity paths
**Then** it applies the configured containment and classification policy without following an unsafe path for mutation
**And** ambiguity is reported rather than silently retargeting an agent to a different repository, role, runtime, or profile.

**Given** one invalid agent row among otherwise valid rows
**When** inventory parsing and validation run
**Then** PJangler returns a bounded safe diagnostic for that row, preserves its raw identity key in the result, and inventories all independently parseable rows
**And** no malformed field value is executed, used as a service name without validation, or echoed as unbounded content.

**Given** the operator runs `pjangler fleet inventory [--agent <id>] [--project-registry <path>] [--agent-registry <path>] [--json]`
**When** no filters are supplied
**Then** the command reads the configured canonical registries and reports the full inventory; `--agent` selects exactly one known row or returns a categorized not-found result
**And** registry overrides support isolated/operator inspection, remain read-only, and never change the configured canonical paths.

**Given** the focused automated suite uses isolated HOME/XDG, temporary registries, repositories, manifests, and profile roots
**When** complete, unlinked, missing, malformed, duplicate, exception-authorized, path-ambiguous, and filtered cases run
**Then** counts, correlations, conflict groups, source provenance, deterministic ordering, partial-result behavior, and zero writes are proven
**And** completion also includes a real built CLI run whose emitted rows and totals match an independent safe count of the current configured agent registry; documentation, mocks, ticket state, or command exit alone is insufficient evidence.

Requirements owned: FR1, FR6. Primary NFRs: NFR1, NFR2, NFR3, NFR6, NFR7, NFR8, NFR10, NFR11, NFR13, NFR14, NFR16.

### Story 1.3: Report Fleet Provenance Through Shared CLI and MCP

As a fleet operator or automation client,
I want the same fleet inventory and provenance from CLI and MCP,
So that I can identify exactly which contract, template, runtime, profile generation, and executable each managed agent actually uses.

**Acceptance Criteria:**

**Given** the authoritative inventory from Story 1.2
**When** PJangler collects desired and observed provenance
**Then** the fleet result includes PJangler package version/source, fleet contract and schema versions, configured Hermes URL/ref/full SHA and release path, observed Hermes executable/repository identity, canonical template source/ref/SHA, recorded pjangler template gitlink, scaffold manifest/version, and profile render generation or digest when present
**And** each desired and observed value identifies its source and reports match, mismatch, dirty, missing, unsupported, or unobserved without guessing.

**Given** the vendored Hermes template worktree contains newer bytes than the parent repository's recorded gitlink
**When** provenance is collected
**Then** the recorded gitlink remains the effective release provenance and the mutable worktree is reported separately as dirty/mismatched
**And** tests or successful rendering from the mutable worktree cannot make the pinned deployment appear current.

**Given** an agent launcher, fleet configuration, registry row, or systemd definition points at a legacy executable or checkout while the contract pins an immutable release
**When** provenance correlation runs
**Then** the inventory identifies the exact observed executable family and mismatch for that agent
**And** it never executes the observed binary, fetches a remote, updates a checkout, or rewrites a launcher while inspecting provenance.

**Given** optional provenance is absent or one bounded Git/filesystem probe fails
**When** the collector completes
**Then** the affected field is explicitly missing or unobserved with safe categorized evidence while independent agents and provenance domains remain available
**And** the aggregate does not turn absence into a match or discard the affected inventory row.

**Given** the operator uses `pjangler fleet inventory ...` or `pjangler fleet provenance [--agent <id>] [--json]`
**When** the command succeeds
**Then** inventory retains the stable rows from Story 1.2 and the provenance command presents desired-versus-observed sources and mismatches at fleet or agent scope
**And** both commands dispatch through the same fleet application core rather than rebuilding registry, identity, or provenance policy in Commander handlers.

**Given** an MCP client calls `pjangler_fleet_inventory` or `pjangler_fleet_provenance`
**When** it supplies the equivalent scope, registry overrides, cancellation, and deadline inputs
**Then** the MCP tool dispatches through that same application core and returns the same versioned data schema, stable ordering, finding identifiers, and categorized outcomes as the corresponding CLI JSON `data`
**And** the adapter adds only MCP protocol wrapping and guidance, never alternate defaults or policy.

**Given** identical isolated inputs are sent through CLI and MCP
**When** success, not-found, malformed-registry, partial-probe, timeout, and cancellation cases run
**Then** normalized data and error categories are equivalent across adapters
**And** cancellation/deadline propagation terminates bounded child probes without converting cancellation into healthy or leaving any child probe running.

**Given** provenance sources contain environment mappings, credential references, remote URLs, Git metadata, or unexpected file content
**When** results and diagnostics are rendered
**Then** only approved nonsecret provenance fields and bounded safe paths/identifiers appear
**And** literal credential values, raw environment dumps, private payloads, and unbounded subprocess output never enter CLI or MCP results.

**Given** focused adapter and provenance tests run under isolated HOME/XDG, temporary registries/repos/profiles, recorded gitlinks, and fake executables
**When** matching, dirty-worktree, stale-gitlink, legacy-executable, missing, partial-failure, timeout, cancellation, and CLI/MCP parity cases execute
**Then** provenance truth, shared-core dispatch, schema equivalence, bounds, and zero mutation are proven
**And** completion includes a built CLI result and a real stdio MCP call compared with independent safe reads of the current package, contract, template gitlink, and configured Hermes pin; documentation, mocked adapters alone, ticket state, or exit code is insufficient evidence.

Requirements owned: FR8, FR26. Primary NFRs: NFR1, NFR2, NFR3, NFR7, NFR8, NFR10, NFR12, NFR13, NFR14, NFR16.

### Story 1.4: Deliver Parse-Safe Registry-Wide Fleet Status

As a fleet operator or automation client,
I want one complete registry-wide status command with trustworthy human and JSON output,
So that I can assess the whole fleet without scripting per-repository audits or working around truncated machine output.

**Acceptance Criteria:**

**Given** the fleet contract, inventory, and provenance capabilities from Stories 1.1–1.3
**When** the fleet status application service runs without a scope filter
**Then** it traverses every inventory row and emits one aggregate plus one stable per-agent status record
**And** it includes explicit domain observations or explicit unobserved/unsupported findings for registry, project binding, template/scaffold, profile, runtime, systemd, live process, Bloodbank, and release/provenance domains so no domain disappears silently.

**Given** existing recipe-owned project or host audit rules can provide an observation
**When** fleet status invokes them
**Then** it calls their shared application APIs for the inventory row's exact repository and preserves rule ID, owner, scope, status, summary, and bounded details
**And** a host-scoped rule evaluated from one repository is not promoted into a registry-wide claim unless the fleet collector independently proves its declared global coverage.

**Given** the operator runs `pjangler fleet status [--agent <id>] [--domain <domain>] [--live] [--json]`
**When** no scope filter is supplied
**Then** human output shows observation time, contract/version provenance, total/resolved/unresolved agent counts, domain pass/fail/warn/skip/unobserved/error counts, overall completeness/health, and the highest-priority actionable findings
**And** the unfiltered result identifies itself as a complete-fleet observation only when every required registered row and applicable domain was actually observed.

**Given** the operator supplies an agent or domain filter
**When** fleet status collects observations
**Then** collection and child probes are constrained to the selected agents/domains rather than probing the entire fleet and hiding results afterward
**And** the result reports total registered fleet size plus selected and observed scope counts, labels health as scoped rather than fleet-complete, and never implies unselected agents or domains were observed.

**Given** the operator supplies `--json`
**When** status completes healthy, unhealthy, or partially observed
**Then** stdout contains exactly one UTF-8 versioned JSON document followed by one newline, with stable ordering and no ANSI, progress, log, warning, or explanatory prose
**And** stderr contains only bounded safe diagnostics while health/completeness/findings remain represented in the JSON result.

**Given** the serialized JSON is larger than the platform pipe buffer
**When** the real built CLI writes to a terminal, regular file, shell pipeline, and captured subprocess stdout
**Then** every destination receives the complete identical JSON bytes and closing newline before process termination
**And** the CLI uses a flush-safe completion path rather than requiring a temporary regular-file workaround.

**Given** one repository audit, filesystem probe, or optional adapter fails, times out, or returns malformed data
**When** unrelated rows and domains remain observable
**Then** status returns their results plus a categorized collection error and explicit incomplete state for the failed scope
**And** it never converts the error to pass, drops the agent, aborts all independent work, or emits malformed JSON.

**Given** a fleet with many agents and findings
**When** human or JSON output is produced
**Then** collections and diagnostic fields enforce documented finite per-agent/per-finding bounds while preserving total counts, stable finding IDs, truncation metadata, and a retrieval scope for omitted detail
**And** memory, child-process concurrency, and collection deadlines are bounded by configuration rather than the raw fleet size.

**Given** an MCP client calls `pjangler_fleet_status` with equivalent agent/domain scope, live-read authorization, registry overrides, cancellation, and deadline
**When** the same isolated fleet observation is used
**Then** MCP returns the same versioned normalized status data, ordering, health, completeness, counts, findings, and error categories as CLI JSON
**And** cancellation stops all outstanding child probes and returns a nonhealthy categorized result without leaving a probe running.

**Given** status is invoked without `--live`
**When** the fleet contains drift or missing optional external integrations
**Then** the operation performs no local or external mutation and no implicit network request
**And** external evidence is marked unobserved or stale rather than silently fetched or assumed healthy.

**Given** the operator explicitly supplies `--live`
**When** a supported external observation is applicable
**Then** PJangler may perform only that adapter's bounded read-only observation under normal timeout, cancellation, credential-redaction, and scope rules
**And** `--live` never authorizes local mutation, remote mutation, process control, service changes, board changes, or Bloodbank activation.

**Given** focused tests run under isolated HOME/XDG with temporary registries/repos and fake bounded probes
**When** zero-agent, healthy, drifted, unresolved, malformed, timeout, cancellation, large-output, stable-order, filter, live-read, and CLI/MCP parity cases execute
**Then** traversal, aggregation, output purity, flush safety, bounds, scoped collection, partial results, exits, and zero writes are proven
**And** completion includes capturing and parsing a real built CLI fleet result larger than the pipe buffer plus a real stdio MCP status call against the configured fleet; snapshots, mocks, documentation, ticket state, a file-redirection-only result, or command exit alone is insufficient evidence.

Requirements owned: FR2, FR3. Primary NFRs: NFR1, NFR2, NFR3, NFR7, NFR8, NFR9, NFR10, NFR11, NFR12, NFR13, NFR14, NFR15.

### Story 1.5: Make Partial Health Truthful and Actionable

As a fleet operator,
I want fleet health to distinguish failure, incompleteness, deferral, and accepted exceptions with clear ownership and next actions,
So that I never mistake a partial or merely running fleet for a proven healthy one.

**Acceptance Criteria:**

**Given** fleet observations from Story 1.4
**When** the health evaluator classifies a finding
**Then** it uses the contract-defined states pass, fail, warn, skip, unobserved, and error plus explicit scope, applicability, freshness, and evidence strength
**And** it keeps desired lifecycle state, observed runtime state, capability readiness, and execution activation as separate fields rather than collapsing them into one boolean.

**Given** an unfiltered fleet observation
**When** aggregate health and completeness are calculated
**Then** fleet-complete is true only when every registered row and every required applicable domain was observed within its freshness policy
**And** fleet-healthy is true only when that complete observation contains no gating fail/error/unobserved result and every allowed skip, warning, deferred capability, or managed exception is justified by explicit contract policy.

**Given** a scoped status result, stale observation, missing optional dependency, unsupported platform capability, intentionally deferred channel, accepted managed exception, or failed required probe
**When** health is evaluated
**Then** each condition receives its distinct truthful state and reason
**And** none can be promoted to complete-fleet health, silently counted as pass, or treated as equivalent to explicit Bloodbank activation.

**Given** a timer is active, a gateway process exists, a deploy command exited zero, a board says complete, or a historical execution succeeded
**When** required postcondition evidence is absent, stale, or contradictory
**Then** the corresponding capability remains unproven or unhealthy according to its policy
**And** success text, process presence, ticket state, or historical evidence never overrides current direct observations.

**Given** the same logical drift is observed repeatedly
**When** findings are generated across runs, adapters, CLI, and MCP
**Then** it retains a deterministic finding ID derived from stable agent/domain/rule identity rather than timestamp or prose
**And** changing evidence, severity, lifecycle state, or resolution produces an explicit transition while unchanged findings remain correlatable.

**Given** any nonpass finding
**When** it is rendered in human or JSON status
**Then** it identifies the affected agent or fleet scope, domain, authoritative owner, observed-versus-desired state, safe evidence, severity/priority, automatic/approval-gated/manual/blocked repair class, and at least one exact next action or owning board/domain route
**And** the recommended command is dry-run/read-only unless the output explicitly labels the separate authorization required for mutation, process stop, external action, or activation.

**Given** findings from different agents and domains
**When** the operator views the fleet summary
**Then** they are stable-sorted by gating impact, severity, scope, agent, domain, and finding ID with bounded detail
**And** the summary reports counts for healthy, unhealthy, incomplete, deferred, exception, and unclassified members without allowing one high-volume domain to hide a higher-priority blocker.

**Given** one observation adapter throws, times out, is cancelled, or returns internally contradictory evidence
**When** the evaluator receives the result
**Then** it emits an error or integrity finding owned by that adapter/domain and marks the affected scope incomplete
**And** it preserves all independent observations and exposes the contradiction rather than choosing the more favorable value.

**Given** CLI or MCP returns scoped, incomplete, or unhealthy status
**When** the process/protocol outcome is finalized
**Then** the documented exit/error category distinguishes invalid input, unhealthy complete observation, incomplete/collection failure, timeout/cancellation, and internal protocol failure
**And** machine clients can decide retry, investigation, or explicit planning without parsing human prose.

**Given** focused health-semantic tests run over a table of complete, scoped, stale, skipped, deferred, exception-authorized, failed, errored, contradictory, and recovered observations
**When** aggregate and finding outputs are evaluated through both CLI JSON and MCP
**Then** truth tables, stable IDs, transitions, sorting, ownership, next actions, exit categories, and zero mutation are proven
**And** completion includes a real built fleet status whose aggregate/counts and at least a bounded sample of findings are independently reconciled to current registry/files/service evidence; snapshots, mocks, documentation, ticket state, or command exit alone is insufficient evidence.

Requirements owned: FR4, FR30. Primary NFRs: NFR1, NFR2, NFR3, NFR6, NFR8, NFR9, NFR10, NFR14, NFR15.

### Story 1.6: Audit Tracked PM Scaffold Parity Fleet-Wide

As a fleet operator,
I want fleet status to compare every managed PM scaffold with the exact pinned canonical template,
So that stale, incomplete, locally modified, or contaminated role deployments are visible before I plan a fanout.

**Acceptance Criteria:**

**Given** the fleet inventory and provenance model
**When** the scaffold observer determines desired state
**Then** it uses the parent repository's recorded Hermes template gitlink and the contract-declared render inputs/owned-asset manifest
**And** it never substitutes newer bytes from a dirty submodule worktree, sibling checkout, mutable branch tip, or operator PATH.

**Given** one managed PM registry row
**When** scaffold parity is evaluated
**Then** PJangler resolves the exact repository and role directory from authoritative inventory fields, renders or derives the expected tracked assets in contained temporary state without running provisioning side effects, and compares content, file type, executable mode, and owned symlink target as applicable
**And** it does not assume every role lives at a hard-coded `agents/hermes/pm` path when the validated registry supplies a different owned role directory.

**Given** expected assets differ from the deployed role
**When** findings are produced
**Then** missing, stale-content, wrong-mode, wrong-type, unsafe-symlink, locally modified, and unexpected positively owned generated assets are reported separately with stable asset-relative paths and safe desired/observed digests
**And** file bodies, credentials, unbounded diffs, and unrelated repository files are not emitted.

**Given** ignored role-local runtime state, logs, caches, compiled Python artifacts, recovery state, or operator-owned files exist near the role
**When** parity runs
**Then** runtime state is checked only for the separate tracked/ignored boundary and is never compared as scaffold source
**And** ignored runtime bytes and foreign role files are neither treated as desired tracked assets nor proposed for deletion by this read-only story.

**Given** the canonical template source itself is missing, dirty, uninitialized, mismatched with the recorded gitlink, contains excluded runtime droppings, or cannot produce a deterministic render
**When** the observer runs
**Then** it emits a source-integrity error that marks scaffold observation incomplete for affected agents
**And** it does not fall back to whatever source happens to render successfully or claim every deployed scaffold stale against an untrusted baseline.

**Given** a repository has unrelated modified or untracked work
**When** scaffold parity is observed
**Then** the worktree is not changed, stashed, reset, cleaned, committed, or conflated with scaffold-owned differences
**And** the result identifies only overlaps with positively owned scaffold paths while recording that unrelated WIP was preserved.

**Given** the existing `hermes.pm-scaffold` repository rule and the new fleet scaffold observer cover the same owned asset
**When** they are evaluated for the same repository and pinned template generation
**Then** they share one desired-state comparison or return equivalent normalized findings
**And** a stale per-repository rule cannot report pass while the authoritative fleet manifest reports a contradictory scaffold generation without an integrity finding.

**Given** the operator runs `pjangler fleet status --domain scaffold [--agent <id>] [--json]` or the equivalent MCP scope
**When** observation completes
**Then** status reports applicable, passing, drifted, incomplete, exception-authorized, and unobserved agent counts plus each agent's pinned source and asset summary
**And** agent scoping constrains rendering/comparison work to that agent while retaining total registered and selected scope counts.

**Given** focused tests use temporary Git repositories, recorded submodule gitlinks, deterministic render fixtures, role paths with spaces, dirty template worktrees, unrelated target WIP, runtime droppings, modes, symlinks, and missing assets
**When** matching and every drift/source-integrity class execute
**Then** source selection, owned-path comparison, digest safety, deterministic ordering, repository-rule equivalence, zero writes, and WIP/runtime preservation are proven
**And** completion includes a built fleet scaffold status for the current configured PM fleet reconciled against an independent safe sample of the recorded template gitlink and deployed files; snapshots, mocked comparisons alone, documentation, ticket state, or command exit is insufficient evidence.

Requirements owned: FR9. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR6, NFR7, NFR8, NFR10, NFR13, NFR14, NFR16.

### Story 1.7: Prove Generated Profile Health and Classify Extras

As a fleet operator,
I want fleet status to validate every registered named profile and classify every extra profile-root entry,
So that generated-config drift, unsafe legacy topology, memory/skill identity errors, and legitimate specialist profiles are distinguished without deleting operator state.

**Acceptance Criteria:**

**Given** a registered managed agent
**When** the profile observer resolves its profile
**Then** the profile path is derived from the authoritative profile name, contained beneath the configured profile root, and required to be a real directory rather than a symlink
**And** a missing, linked, non-directory, escaped, case-colliding, or otherwise ambiguous profile is reported as a pre-mutation hard failure without following it into role/runtime state.

**Given** a real registered profile directory
**When** profile structure is inspected
**Then** it requires identity-only `profile.yaml`, override-only `config.delta.yaml`, generated `config.yaml`, explicit `hindsight/config.json` bank pin, and the immutable canonical skill core
**And** it reports each missing, malformed, misowned, unsafe-linked, or identity-mismatched component separately without treating an inert `profile.yaml` config block as native inheritance.

**Given** the fleet base config and a registered profile delta
**When** generated configuration health is evaluated
**Then** PJangler invokes the canonical profile renderer's read-only check semantics under a bounded deadline and records base/delta/generated digests or generation evidence plus drifted semantic sections
**And** it never hand-edits, renders, absorbs, seeds, locks for mutation, or rewrites either config file during status.

**Given** a shared-base change has not been rendered into one or more named profiles
**When** fleet profile status runs
**Then** every affected registered profile is reported drifted even if its repository-local `hermes.runtime-singleton` rule otherwise passes
**And** contradictory renderer/parity results produce an integrity finding instead of selecting the greener result.

**Given** a profile's Hindsight pin is missing, resolves to `custom`, uses a stale/case-changed/underscore alias, or does not match the contract-approved identity
**When** identity-memory health is checked
**Then** the exact observed bank ID and expected safe identity are reported without reading memory contents
**And** the profile cannot be healthy merely because a generic `bank_id_template` exists.

**Given** a registered profile has missing canonical skills or extra configured skills
**When** skill membership is inspected
**Then** removal/replacement of any immutable core skill is a failure while additive optional skills remain allowed and visible
**And** symlink containment/source validation prevents a dangling or foreign path from satisfying required membership.

**Given** an entry exists under the profile root but no ordinary agent row claims its exact profile identity
**When** extra-entry classification runs
**Then** PJangler correlates it with declared shared-service/specialist exceptions, systemd units, and live process references and classifies it as approved managed exception, intentionally unmanaged, retired candidate, unclassified, or debris candidate
**And** shared profiles such as the fleet Bloodbank gateway are not forced into an ordinary PM shape when their explicit contract class defines a different policy.

**Given** an unregistered profile-like entry is a backup-named directory, alias, symlink, incomplete standalone directory, or live process target
**When** status reports it
**Then** the entry remains untouched and receives bounded safe evidence plus adoption, exception, retirement, or manual-review guidance
**And** no classification automatically deletes, renames, unlinks, merges, renders, stops, or adopts it.

**Given** the operator runs `pjangler fleet status --domain profile [--agent <id>] [--json]` or equivalent MCP scope
**When** collection completes
**Then** status reports registered profile totals, structurally healthy/drifted/incomplete counts, renderer health, memory/skill identity findings, and separately classified extra-root counts
**And** agent scope checks only the selected registered profile while fleet scope alone performs complete extra-root classification and labels that coverage difference.

**Given** profile or renderer files contain secret references, unexpected large values, or malformed YAML/JSON
**When** diagnostics are produced
**Then** output is limited to safe paths, field names, categories, sizes, and digests
**And** credential values, complete configs, private memory, and unbounded parser/renderer output are never emitted.

**Given** focused tests run with isolated profile roots, base configs, canonical renderer fixtures, real directories, symlinks, stale generations, malformed deltas, mismatched pins, core/extra skills, exceptions, aliases, backup names, and live-reference fixtures
**When** all healthy and failure classes execute
**Then** containment, structure, semantic drift, parity contradiction, identity, classification, bounds, deterministic output, and zero mutation are proven
**And** completion includes built fleet profile status reconciled with the canonical renderer check and an independent safe inventory of the current profile root; snapshots, fake renderer results alone, documentation, ticket state, or command exit is insufficient evidence.

Requirements owned: FR10, FR11. Primary NFRs: NFR1, NFR2, NFR3, NFR6, NFR7, NFR8, NFR10, NFR11, NFR13, NFR14, NFR16.

### Story 1.8: Prove Canonical systemd Topology and Service Health

As a fleet operator,
I want fleet status to validate each agent's declared service topology and prove service health over time,
So that enabled files, active timers, deferred gateways, crash loops, and retired units cannot be mistaken for a healthy managed runtime.

**Acceptance Criteria:**

**Given** an ordinary managed PM agent
**When** PJangler derives its desired systemd topology from the fleet contract and registry
**Then** it expects one per-agent messaging gateway service and one heartbeat timer with its single paired oneshot service
**And** any per-agent Bloodbank consumer, checkpoint timer/service, duplicate gateway, duplicate heartbeat, or other retired owned unit is reported as drift rather than an alternate deployment style.

**Given** the fleet-wide service model
**When** shared units are inventoried
**Then** exactly one declared fleet-shared Bloodbank gateway is correlated with its managed shared-service profile and registry/contract identity
**And** an agent-scoped status neither requires nor invents a per-agent command-ingress process.

**Given** an installed or loaded unit associated with a registered agent
**When** the systemd observer collects state
**Then** it records bounded normalized `LoadState`, `UnitFileState`, `ActiveState`, `SubState`, `Result`, `ExecMainStatus`, `NRestarts`, fragment identity, effective executable family, and safe `HERMES_HOME`/profile identity
**And** it validates that owned entrypoints and profile paths match the agent's pinned provenance without dumping the complete environment or credential values.

**Given** an agent has no verified Telegram or Slack credential and its lifecycle declares messaging deferred
**When** gateway health is evaluated
**Then** healthy-deferred requires the gateway to be disabled and inactive and the generated profile delta to explicitly set both unverified platforms disabled
**And** a missing credential, inherited platform enablement, installed-but-enabled gateway, restart loop, or active gateway with no verified channel ownership cannot pass as deferred health.

**Given** an agent declares a verified messaging channel active
**When** gateway health is evaluated over the configured bounded stabilization window
**Then** the unit must remain enabled and active with successful result/status, stable restart count, correct pinned entrypoint/profile, and matching safe channel-identity evidence for the whole window
**And** one successful `is-active` sample, a transient activating state, or a zero deploy exit cannot satisfy the postcondition.

**Given** a heartbeat timer and paired oneshot service
**When** heartbeat health is evaluated
**Then** the timer must be enabled and active/waiting, its schedule must be within policy, and the latest completed oneshot must have successful `Result` and `ExecMainStatus` with current bounded evidence
**And** the oneshot being inactive between ticks is normal while a missing/overdue tick, stuck activation, failed latest result, or checkpoint-only behavior that violates declared reconciliation policy is unhealthy.

**Given** unit state changes during observation
**When** repeated samples disagree or restart count increases
**Then** PJangler reports unstable or crash-looping health with the sample window and safe transition summary
**And** it does not persist or report the most favorable sample as final truth.

**Given** systemd user manager access is unavailable, a query times out, a unit property is malformed, or a referenced fragment/entrypoint path is unsafe
**When** service collection runs
**Then** the affected service domain is error/incomplete with a categorized finding while unrelated filesystem/profile domains remain available
**And** status performs no daemon reload, enable, disable, start, stop, restart, reset-failed, or unit-file write.

**Given** unit files or loaded units exist for unregistered identities
**When** full-fleet topology is observed
**Then** they are correlated with managed exceptions, retired entries, profiles, and processes when possible and otherwise reported unclassified
**And** they remain untouched and are not assigned to the nearest matching agent name.

**Given** the existing `systemd.sentinel` or `hermes.registry-parity` rule disagrees with the canonical topology/service observer
**When** both cover the same agent and observation window
**Then** PJangler emits an integrity finding with both normalized claims
**And** a legacy expectation for consumers/checkpoints or an activity-only pass cannot override the current fleet contract.

**Given** the operator runs `pjangler fleet status --domain systemd [--agent <id>] [--json]` or equivalent MCP scope
**When** the bounded observation completes
**Then** output separates installed topology, desired capability state, current runtime state, stability proof, heartbeat latest-result proof, shared-service health, and unregistered-unit findings
**And** agent scope queries only that agent's owned capability units while clearly labeling fleet-shared/unregistered coverage as unobserved unless requested.

**Given** focused tests use a stateful fake systemd adapter and isolated unit/profile/channel fixtures
**When** active, deferred, disabled, missing, duplicate, retired, crash-looping, activating, overdue/failed heartbeat, property-error, timeout, manager-unavailable, shared-gateway, unregistered-unit, and legacy-rule contradiction cases execute across multiple samples
**Then** topology, capability semantics, stabilization, bounds, adapter cancellation, zero mutation, and deterministic status are proven
**And** completion includes a bounded real user-systemd observation of the current registered gateways, heartbeat timers/latest services, and fleet-shared gateway reconciled with direct `systemctl --user show` evidence; mocks, one `is-active` sample, documentation, ticket state, or command exit alone is insufficient evidence.

Requirements owned: FR12, FR13. Primary NFRs: NFR1, NFR2, NFR3, NFR6, NFR7, NFR8, NFR9, NFR10, NFR11, NFR13, NFR14, NFR16.

### Story 1.9: Attribute Live Hermes Processes and Expose Runtime Sprawl

As a fleet operator,
I want every live Hermes-related process attributed to a registered agent, managed exception, service, profile, and executable generation when possible,
So that legacy, duplicate, isolated, or unattributable runtimes cannot remain invisible behind registry and systemd health.

**Acceptance Criteria:**

**Given** a point-in-time host process snapshot
**When** the process observer identifies Hermes-related processes
**Then** it captures a race-safe identity using PID plus process start identity, parent/process-group relationships, safe executable identity, cgroup/systemd unit when present, and only the allowlisted profile/runtime selectors needed for attribution
**And** it never emits full command lines, prompts, environment blocks, credentials, private payloads, or unrelated process data.

**Given** a process belongs to a registered per-agent gateway, heartbeat invocation, or the fleet-shared Bloodbank gateway
**When** attribution runs
**Then** it correlates the exact systemd unit, registry agent/shared-service identity, profile, expected executable provenance, and process role
**And** child/watchdog/MCP descendants are grouped under their owning root process instead of being misreported as duplicate independent gateways.

**Given** an interactive CLI, isolated server, background worker, MCP/watchdog process, legacy launcher, or process without systemd ownership is running
**When** it can be correlated by exact contained profile/runtime/executable evidence
**Then** PJangler classifies its process kind and registered agent or declared managed exception with evidence strength
**And** it does not infer ownership from substring, nearest name, current working directory basename, or a single ambiguous argument.

**Given** two independent roots claim the same singleton agent/profile capability, a process uses a legacy executable, a unit uses the wrong profile, or a registered active capability has no process
**When** process and service observations are correlated
**Then** fleet status emits duplicate-runtime, legacy-generation, identity-mismatch, or missing-process findings as applicable
**And** contradictory service/process evidence remains visible rather than allowing either domain to overwrite the other.

**Given** a Hermes-related process cannot be attributed safely
**When** full-fleet process status runs
**Then** it remains visible as unclassified with bounded safe executable/profile hints, start age, and evidence confidence
**And** it is not assigned, signaled, reparented, restarted, or ignored merely because its profile is absent from the agent registry.

**Given** a process exits, execs, or changes parentage during collection
**When** its start identity or second bounded verification no longer matches
**Then** the record is marked vanished/changed and excluded from stable-running claims
**And** PID reuse cannot transfer ownership or health evidence to a different process.

**Given** process metadata is permission-denied, malformed, oversized, or unavailable on the platform
**When** collection runs
**Then** the affected fields or process domain are explicitly inaccessible/unobserved with safe categorized evidence
**And** fleet health does not silently treat an incomplete process table as proof that no unmanaged runtimes exist.

**Given** the operator runs `pjangler fleet status --domain process [--agent <id>] [--json]` or equivalent MCP scope
**When** collection completes
**Then** output reports root and grouped-child counts by managed agent, shared/specialist exception, interactive, isolated, legacy, duplicate, and unclassified class plus executable-generation mismatches
**And** agent scope performs only the minimum host snapshot and attribution needed for that exact agent, labels unselected host processes unobserved, and does not imply complete-host process coverage.

**Given** an isolated or legacy process is found
**When** next actions are generated
**Then** status offers read-only inspection/classification guidance and identifies the separate future drain-plan/approval path
**And** this story never sends a signal, invokes a shutdown endpoint, changes a unit, deletes a pid/socket, or mutates registry/profile/runtime state.

**Given** focused tests use synthetic process snapshots with PID reuse, parent/child trees, cgroups, exact and ambiguous profiles, legacy/current executables, permission failures, disappearing processes, duplicates, shared services, and secret-shaped argv/environment fields
**When** attribution and redaction run
**Then** grouping, identity safety, evidence confidence, conflict detection, bounds, scope labeling, deterministic output, and zero process control are proven
**And** completion includes a bounded real process-domain status independently reconciled to a safe `/proc` or `ps`/systemd sample of current Hermes root processes and executable families; synthetic snapshots, documentation, ticket state, process presence alone, or command exit is insufficient evidence.

Requirements owned: FR14. Primary NFRs: NFR1, NFR2, NFR3, NFR6, NFR7, NFR8, NFR10, NFR11, NFR13, NFR14, NFR16.

### Story 1.10: Prove Bloodbank Routing Readiness Without Granting Activation

As a fleet operator,
I want fleet status to prove the shared Bloodbank route and each target's readiness separately from execution activation,
So that a discoverable agent remains default-deny until I explicitly authorize it and a historical success cannot masquerade as current routability.

**Acceptance Criteria:**

**Given** a Hermes Agent Registry row
**When** Bloodbank metadata is validated
**Then** `enabled` must be a strict boolean, `gateway_scope` must equal the canonical fleet scope, `target_agent_id` must exactly equal the owning agent ID, and `profile_name` must be nonblank, unique, and resolve to that agent's registered profile
**And** missing, coerced, duplicate, cross-owned, or contradictory values are field-level findings rather than inferred defaults.

**Given** a target has structurally valid routing metadata
**When** its Bloodbank lifecycle state is evaluated
**Then** status separately reports discovered, configured, profile-resolved, gateway-ready, activation-ready, explicitly activated, and currently eligible states
**And** `enabled: false` remains quarantined/default-deny without being called drift merely because every discovery/readiness check passes.

**Given** a target has `enabled: true`
**When** current eligibility is calculated
**Then** eligibility requires the explicit registry flag plus canonical scope, exact target identity, resolved nonblank profile, healthy fleet-shared gateway, and every additional activation-contract precondition
**And** any failed or unobserved prerequisite makes the target ineligible/blocked without rewriting the explicit activation choice.

**Given** role metadata, project projection, service discovery, profile existence, a past completed execution-journal row, or a historical command event implies the target once existed or ran
**When** current activation is evaluated
**Then** only the strict current Agent Registry activation field grants authority and historical evidence is labeled historical
**And** no projection, successful provisioning, live process, or resolvable target can infer, persist, or auto-enable execution authority.

**Given** fleet command ingress is inspected
**When** the service model is validated
**Then** status requires the one declared fleet-shared Bloodbank gateway and correlates its profile, adapter, registry source, enabled/active/stability proof, and safe routing contract
**And** every installed, active, enabled, or registry-declared per-agent Bloodbank consumer or filesystem inbox bridge is retired drift.

**Given** the shared gateway is active but restart-unstable, loads a different registry/profile, cannot resolve a target, or exposes stale/malformed safe health metadata
**When** routing readiness is evaluated
**Then** affected target readiness and shared-gateway health are nonhealthy with the precise dependency finding
**And** process presence or one active sample cannot satisfy routing readiness.

**Given** the operator runs `pjangler fleet status --domain bloodbank [--agent <id>] [--live] [--json]` or equivalent MCP scope
**When** `--live` is absent
**Then** PJangler uses only registry, profile, unit, process, and local safe gateway evidence and labels external broker/stream observations unobserved
**And** it does not connect to NATS, publish a command, create a consumer, acknowledge a message, invoke Hermes, or mutate any target.

**Given** the operator explicitly supplies `--live`
**When** the configured Bloodbank adapter supports bounded read-only health observation
**Then** PJangler may verify safe broker/stream/consumer/gateway metadata under the selected scope, deadline, and cancellation rules
**And** live-read authorization never publishes a command, changes activation, creates/deletes a consumer, acknowledges work, or treats a read as an execution smoke test.

**Given** human or JSON status is rendered
**When** Bloodbank collection completes
**Then** it reports shared-gateway health plus target counts for quarantined, activation-ready, activated-eligible, activated-blocked, invalid, duplicate, and unobserved states with exact owning findings/next actions
**And** readiness and activation totals remain distinct in every aggregate.

**Given** focused tests use isolated registry/profile/unit/process fixtures and a fake read-only Bloodbank adapter
**When** false/true/nonboolean activation, mismatched/duplicate target, missing profile, healthy/unstable gateway, legacy consumers, historical journal evidence, offline, live-read, timeout, cancellation, and attempted-mutation cases execute
**Then** default-deny semantics, eligibility dependencies, shared ingress, retired drift, bounds, CLI/MCP parity, and zero dispatch/mutation are proven
**And** completion includes built local Bloodbank-domain status whose strict enabled/eligible counts are independently reconciled to the current agent registry and whose shared-gateway state is reconciled to bounded direct service evidence; a real command dispatch is neither required nor authorized by this story, and mocks, documentation, ticket state, or command exit alone are insufficient.

Requirements owned: FR15. Primary NFRs: NFR1, NFR2, NFR3, NFR6, NFR7, NFR8, NFR9, NFR10, NFR13, NFR14, NFR16.

### Story 1.11: Produce Scoped, Versioned Dry-Run Reconciliation Plans

As a fleet operator,
I want every proposed fleet repair expressed as a reviewable, versioned dry-run plan,
So that I can understand exact effects, risks, dependencies, and approval boundaries before anything changes.

**Acceptance Criteria:**

**Given** a current fleet status observation and findings
**When** the reconciliation planner runs without an apply option
**Then** it produces a versioned plan and performs zero target repository, registry, profile, config, service, process, Bloodbank, board, network-mutation, or external-system changes
**And** every selected finding receives an explicit disposition: planned automatic effect, approval-gated effect, manual action, blocked action, deferred action, or no-op/already converged.

**Given** the operator runs `pjangler fleet reconcile [--agent <id>...] [--domain <domain>...] [--finding <finding-id>...] [--live] [--out <path>] [--json]`
**When** no selectors are supplied
**Then** the command plans against a fresh complete-fleet local/offline observation and human output summarizes scope, effects, blockers, approvals, order, and expected postconditions
**And** agent/domain/finding selectors constrain both observation and planning work while the result reports total registered size, selected scope, observed scope, and scoped-not-fleet-complete semantics.

**Given** `--live` is absent or present
**When** plan inputs are collected
**Then** it inherits Story 1.4's exact offline versus explicitly authorized bounded read-only observation contract
**And** neither mode authorizes mutation, process control, service control, board changes, command dispatch, or Bloodbank activation.

**Given** a plan is serialized
**When** human, JSON, or explicit `--out` output is requested
**Then** the machine artifact contains schema/contract versions, stable plan/content digest, creation/freshness metadata, selected scope, observation generation/fingerprints, desired provenance, effect IDs/types/owners, finding links, dependencies, preconditions, risk/reversibility class, required authorization, bounded expected changes, postconditions, and non-effect dispositions
**And** stable effect identity and ordering derive from content rather than timestamps or display prose.

**Given** `--json`, `--out <path>`, or both are supplied
**When** the validated plan is emitted
**Then** `--json` writes the canonical plan document to stdout and `--out` atomically persists that same canonical document with no alternate file schema
**And** when both are used, file bytes and stdout plan bytes before the required trailing-newline convention represent the same validated plan and content digest, while path/write receipts remain outside the plan payload in bounded stderr or human reporting.

**Given** `--out <path>` is supplied
**When** the destination is valid and absent
**Then** PJangler atomically creates only the requested mode-0600 plan artifact after complete schema validation and reports its digest outside the canonical plan payload
**And** it refuses symlinks, unsafe parents, existing destinations without an explicit future replacement contract, partial writes, credentials, file bodies, unbounded diffs, or mutable runtime payloads.

**Given** the target repository contains unrelated modified/untracked work or a planned owned path overlaps current WIP
**When** planning evaluates preservation risk
**Then** unrelated WIP is recorded as preserved and never included as an effect
**And** an overlap with an owned target records exact safe precondition evidence and is manual/blocked unless the applicable domain planner can prove a preservation-safe merge.

**Given** a finding is ambiguous, unclassified, destructive, external, process-stopping, activation-changing, unsupported by a current domain planner, or based on incomplete/stale evidence
**When** the planner handles it
**Then** it cannot become an automatic effect and instead records the precise approval/manual/blocker reason and required fresh evidence
**And** it is never omitted merely to produce an all-automatic plan.

**Given** two planned effects touch the same authority or one effect's postcondition is another's precondition
**When** the dependency graph is built
**Then** effects are deduplicated, ordered by declared authority/lock/dependency rules, and rejected on cycles or incompatible writes
**And** registry/profile lock order, shared-template-before-scaffold ordering, and service-after-config ordering are represented explicitly where applicable.

**Given** a second plan is generated from the same normalized observation, scope, contract, and planner versions
**When** volatile presentation metadata is excluded
**Then** its content digest, effect IDs, dispositions, and dependency order are identical
**And** a changed observation, desired pin, contract, scope, precondition, or planner version changes the corresponding fingerprint/digest visibly.

**Given** an MCP client requests equivalent reconciliation with apply disabled
**When** identical isolated inputs are supplied
**Then** it receives the same normalized plan schema, effects, dispositions, ordering, safety defaults, and errors as CLI JSON
**And** MCP cannot smuggle an apply, activation, process-stop, or external-mutation authorization through unknown or adapter-only fields.

**Given** focused tests run with isolated fleet observations, repositories with WIP, conflicts, incomplete findings, unsafe paths, dependent/cyclic effects, unsupported domains, live-read fixtures, and large plans
**When** every scope and disposition class executes
**Then** zero target mutation, plan schema, canonical stdout/file equivalence, deterministic digests/order, bounds, safe plan-file creation, dependency/risk classification, CLI/MCP parity, and authorization separation are proven
**And** completion includes a built dry-run plan for the current PJangler and ssbnk scope plus independently captured before/after hashes/service/registry state proving no target changes; snapshots, mocks, documentation, ticket state, or a successful command exit alone are insufficient evidence.

Requirements owned: FR16, FR17. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR10, NFR11, NFR13, NFR14, NFR15, NFR16.

### Story 1.12: Apply Only Current Plans with Resumable Outcomes

As a fleet operator,
I want PJangler to execute only the exact reviewed effects whose preconditions are still current and to retain resumable outcome evidence,
So that interruption, drift, or one agent failure cannot cause blind retries, hidden partial work, or unrelated fleet damage.

**Acceptance Criteria:**

**Given** the operator runs `pjangler fleet reconcile --apply <plan-path> [--effect <effect-id>...] [--resume <run-id>] [--json]`
**When** the plan file is loaded
**Then** PJangler requires the canonical schema, valid content digest, compatible contract/planner versions, safe regular-file path, and exact selected effects from Story 1.11
**And** it never regenerates a more favorable plan, widens scope, adds effects, or treats human-rendered output as an executable plan.

**Given** a valid plan before any effect dispatch
**When** apply performs fresh bounded precondition observations
**Then** a changed global authority/contract/pin invalidates the run before mutation, while an effect-specific changed fingerprint marks that effect and its dependents stale/blocked
**And** independent current effects remain eligible only when their dependency graph and the operator's exact selection allow isolated continuation.

**Given** no `--effect` selector or one or more selectors are supplied
**When** apply determines execution scope
**Then** no selector means all plan effects eligible under their recorded authorization class, while selectors execute only the named effects plus explicitly represented required dependencies
**And** unknown, disposition-only, manual, blocked, destructive, external, process-stop, or activation effects are not executed by generic apply without their separate contract-defined authorization.

**Given** apply is about to start a run
**When** no matching completed run exists
**Then** it creates a mode-0600 durable run journal outside tracked target repositories containing plan/run IDs, selected effect IDs, safe precondition fingerprints, dependency state, attempts, and per-effect lifecycle
**And** the journal is fsynced before the first dispatch, contains no credential/file body/private payload, and cannot be redirected through a symlink or unsafe path.

**Given** effects are ready to execute
**When** the engine dispatches them
**Then** it honors declared dependency and lock order, uses configured bounded concurrency only for independent agents/authorities, and records pending, running, succeeded, no-op, failed, blocked, cancelled, or outcome-unknown states durably
**And** a failure stops its dependent branch without cancelling or rolling back unrelated successful branches unless the plan explicitly declares an atomic group.

**Given** the process is interrupted, killed, times out, or loses an adapter response after a possible effect
**When** the operator uses `--resume <run-id>` with the same canonical plan
**Then** PJangler first re-observes the effect's preconditions and postconditions, adopts a proven success/no-op, retries only an effect proven not dispatched or explicitly retry-safe, and leaves ambiguous outcomes blocked for manual resolution
**And** it never blind-replays a possibly dispatched service, registry, external, process, or activation effect.

**Given** an already succeeded/no-op effect is selected again with unchanged postconditions
**When** apply or resume runs
**Then** the effect remains succeeded/no-op without repeating mutation or changing its original completion evidence
**And** an idempotent rerun creates no duplicate registry row, timestamp churn, file replacement, service action, process action, external resource, or event.

**Given** the operator cancels an active run
**When** cancellation is received
**Then** the engine stops dispatching new effects, propagates cancellation/deadlines to bounded active adapters, durably records each known or outcome-unknown state, and returns a resumable nonhealthy result
**And** it leaves no child probe/effect process running after its defined bounded shutdown policy.

**Given** apply or resume completes fully or partially
**When** human or JSON results are emitted
**Then** output reports plan/run digests, selected scope, effect order, attempts, outcomes, blocked dependencies, current postcondition evidence, journal location/identity, and exact next actions with the same complete parse-safe semantics as fleet status
**And** a successful process exit is possible only when every selected effect and dependency has a proven succeeded/no-op postcondition.

**Given** an MCP client requests apply or resume
**When** it supplies the canonical plan/digest, explicit apply mode, exact effect selection, and equivalent authorization inputs
**Then** it uses the same execution engine, journal, precondition checks, result schema, cancellation, and safety rules as CLI
**And** MCP execution is noninteractive and fails closed rather than prompting, widening authorization, or accepting an implicit plan.

**Given** focused tests use isolated plans, journals, temporary repositories, fake effects with dependencies, failures, delays, crashes, unknown outcomes, stale fingerprints, atomic groups, cancellation, and safe no-op/postcondition probes
**When** fresh apply, partial apply, selective apply, interruption, resume, repeated resume, incompatible plan, and CLI/MCP parity cases run
**Then** exact-plan execution, stale rejection, durable state transitions, dependency isolation, idempotency, bounded shutdown, result truth, and preservation are proven
**And** completion includes a real built CLI apply/resume against an isolated disposable target with intentional process interruption and independently verified before/after/journal postconditions; production fleet mutation, mocks alone, documentation, ticket state, or command exit is insufficient evidence.

Requirements owned: FR18. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR10, NFR11, NFR13, NFR14, NFR15, NFR16.

### Story 1.13: Make Fleet Mutations Crash- and Concurrency-Safe

As a fleet operator,
I want every fleet effect to use canonical locks, atomic replacement, conflict detection, and durable recovery,
So that concurrent agents, crashes, or out-of-band edits cannot lose registry, profile, configuration, or role state.

**Acceptance Criteria:**

**Given** a planned mutating effect
**When** the apply engine prepares it
**Then** the effect declares every authority/mutation surface it will read and write, its canonical lock identity/order, snapshot/precondition strategy, atomic commit primitive, recovery strategy, and postcondition observer
**And** an effect with an undeclared surface, unproven writer, conflicting lock order, or unsupported filesystem guarantee is blocked before any mutation.

**Given** a named profile mutation
**When** its transaction begins
**Then** PJangler requires a real contained profile directory and acquires the one canonical per-profile lock before reading any durable state that may be written back
**And** registry-aware profile work follows exactly `registry lock -> profile lock -> snapshot/check -> write/rollback -> unlock`, while no path may reverse or recursively reacquire that order.

**Given** a Project Registry, Hermes Agent Registry, distributable parent config, or other whole-file authority mutation
**When** its transaction begins
**Then** every controller writer/recovery path for that surface uses one canonical whole-window lock acquired before snapshot, existence checks, merge, or recovery
**And** a helper-level lock cannot compensate for a top-level caller that read stale state before entering the lock.

**Given** any canonical lock is opened
**When** ownership is acquired or times out
**Then** the lock path is opened no-follow through a trusted contained parent, verified as a regular mode-0600 file, marked close-on-exec, held by a kernel lock, and governed by a finite validated timeout
**And** invalid/nonfinite timeouts, symlink swaps, unsafe parents, inherited descriptors, or failed target revalidation fail closed before mutation while process death releases ownership without manual lock-file deletion.

**Given** an existing file will be replaced and the platform can meet the exact-recovery contract
**When** a candidate is installed
**Then** the transaction records original device/inode, content digest, mode, nanosecond mtime, link-safety evidence, and candidate fingerprint; creates/fsyncs protected same-directory recovery state; fully writes/fsyncs the candidate; atomically installs it; and fsyncs the directory
**And** it rejects pre-existing unsafe hardlink topology, symlink components, cross-filesystem recovery, backup-like names, or a platform that cannot preserve/restore the required state before installing the candidate.

**Given** validation or a post-install step fails before commit
**When** rollback runs
**Then** the protected original is restored before any optional validator and its inode, bytes, mode, and mtime are verified
**And** validator failure cannot prevent restoration or leave the unverified candidate at the canonical path.

**Given** an out-of-band writer changes the canonical target after snapshot or candidate installation
**When** commit, rollback, or crash recovery compares current state
**Then** compare-and-swap evidence prevents PJangler from overwriting the newer state, preserves recovery evidence, and marks the effect conflict/blocked
**And** neither unconditional rollback nor last-writer-wins success is allowed.

**Given** a crash occurs at any transaction phase
**When** apply resumes or a later run encounters prepared recovery state
**Then** it acquires the same canonical locks, validates the durable journal/recovery record, proves whether original or candidate is canonical, and restores/adopts/blocks deterministically before starting new work
**And** it never deletes unresolved recovery evidence or reports completion while mixed-generation multi-file state remains.

**Given** a registry or YAML/JSON profile/role update changes owned fields
**When** the transaction serializes and commits
**Then** unknown/extension metadata, unrelated keys, comments/style/order where the authority contract promises byte preservation, stable provisioning timestamps, and unmodified sibling files survive
**And** an unchanged logical rerun is byte-identical and does not replace the inode merely to restamp state.

**Given** multiple effects target independent agents and one effect targets registry plus profile
**When** bounded concurrent apply runs
**Then** independent effects can progress while overlapping surfaces serialize under their canonical locks and dependency order
**And** contention yields a truthful bounded timeout or retry decision without deadlock, partial write, lost update, or widening the atomic group.

**Given** current seed, renderer, absorb, channel, voice, backfill, registry, config-recovery, and role writers can touch a declared fleet surface
**When** writer coverage is audited
**Then** each top-level caller either participates in the canonical lock/transaction domain or causes affected controller effects to remain blocked with an exact unsupported-writer finding
**And** no later domain reconciler may claim safe automatic apply until every concurrent writer for its surfaces is covered.

**Given** transaction state or diagnostics are emitted
**When** failures, conflicts, or recovery occur
**Then** output contains only safe effect IDs, paths, phases, digests, metadata, and next actions
**And** original/candidate bodies, credentials, environment dumps, and recovery contents remain private.

**Given** focused multiprocess tests exercise real top-level callers under isolated profile/registry/config/role roots
**When** both lock orders, timeouts, holder death, symlink/hardlink attacks, out-of-band CAS races, validation failures, and crash injection at every recovery phase run
**Then** no lost update, deadlock, unsafe follow, false completion, or partial canonical state occurs; exact restoration/preservation and idempotent cleanup are proven
**And** completion includes a real built apply/resume against disposable files with concurrent writers and killed processes, independently verifying inode/bytes/mode/mtime/journal outcomes; helper-only tests, mocks, documentation, ticket state, or command exit alone are insufficient evidence.

Requirements owned: FR19. Primary NFRs: NFR1, NFR2, NFR4, NFR5, NFR6, NFR7, NFR8, NFR10, NFR13, NFR14, NFR16.

### Story 1.14: Converge Profiles Through the Canonical Renderer

As a fleet operator,
I want PJangler to plan and apply generated-profile convergence through the canonical base-plus-delta renderer,
So that shared defaults propagate without losing agent overrides, channel state, memory identity, skills, or concurrent in-agent changes.

**Acceptance Criteria:**

**Given** profile findings from Story 1.7
**When** the profile domain planner runs
**Then** it emits only typed profile effects needed for the selected agent(s), such as safe structure seed, absorb, delta repair, render, identity metadata, Hindsight pin, and canonical skill repair, with explicit dependencies and postconditions
**And** it blocks legacy symlink, escaped path, ambiguous ownership, unclassified extra, unsafe writer, or unverifiable generated-state cases before mutation.

**Given** a registered real profile has intentional generated `config.yaml` changes not represented by the current base plus delta
**When** planning compares generated, base, and delta state
**Then** it proposes an absorb-before-render effect only when the canonical renderer can prove a safe override delta
**And** it never overwrites or silently discards an in-agent `/model`, onboarding, channel, voice, plugin, or other durable change merely to make renderer check pass.

**Given** a shared fleet base change affects many profiles
**When** the operator plans fleet or selected-agent profile convergence
**Then** each affected profile receives its own fingerprinted effect chain and the plan reports selected/affected/unaffected/blocked totals plus semantic sections that will change
**And** agent scoping does not render, absorb, seed, lock, or rewrite unselected profiles.

**Given** an approved profile effect chain is applied
**When** it touches `config.delta.yaml` or generated `config.yaml`
**Then** it invokes the canonical renderer/absorb implementation under the Story 1.13 per-profile transaction lock, revalidates base/delta/generated inputs after locking, and atomically commits the pair
**And** controller code never recreates merge semantics, hand-edits generated config, duplicates fleet-owned `mcp_servers`/plugins into the delta, or treats `profile.yaml` as config inheritance.

**Given** profile identity, memory pin, or required-skill repair is included
**When** apply executes
**Then** identity-only `profile.yaml`, exact Hindsight bank pin, and contract-declared immutable canonical skill core converge through their positively owned paths while additive optional skills and unrelated profile state remain intact
**And** an identity rename or registry-aware change obeys registry-before-profile order and cannot merge two agents into one memory bank.

**Given** Telegram or Slack is unverified/deferred for the agent
**When** profile convergence renders the result
**Then** the delta continues to explicitly disable that platform and preserves valid `op://` mappings/verified identity without reading or emitting secret values
**And** profile convergence cannot enable a channel, validate/rotate a credential, or change Bloodbank activation as an incidental side effect.

**Given** channel, voice, renderer, absorb, seed, or backfill work races the same profile
**When** the real top-level callers contend
**Then** all participate in the canonical lock domain, re-read durable inputs after locking, and either preserve both nonconflicting changes or return a bounded conflict/timeout without lost update
**And** process death or crash recovery converges through the Story 1.13 transaction journal without manual lock deletion or mixed generations.

**Given** one profile fails validation, lock acquisition, render, postcondition, or recovery
**When** a multi-agent apply continues
**Then** that agent's dependent effects stop and remain resumable while independent profile chains may complete
**And** the failed profile's exact pre-state or protected recovery evidence is preserved rather than replaced with a partial candidate.

**Given** an effect reports success
**When** postconditions are observed
**Then** the profile is a real contained directory with valid identity metadata, delta, generated config equal to the canonical base-plus-delta render, exact memory pin, contract-declared immutable canonical skill core, preserved optional state, and no unresolved recovery record
**And** the fleet profile status and canonical renderer check agree; contradiction makes the effect failed/incomplete.

**Given** the same approved plan is applied after all postconditions already hold
**When** profile effects are re-observed
**Then** every effect is no-op with byte-identical delta/generated/identity/pin state and no timestamp, lock, service, registry, or marker churn
**And** unregistered/ambiguous extra profiles remain untouched.

**Given** focused tests use isolated base/profile roots and real canonical renderer/top-level caller entrypoints
**When** stale base generations, safe/unsafe absorb, seed races, channel/voice interleavings, memory aliases, core/optional skills, symlinks, malformed YAML, lock timeout, crash phases, partial fleet failure, and idempotent reruns execute
**Then** plan accuracy, merge semantics, lock ordering, exact recovery, override/channel/skill preservation, postcondition truth, and zero secret exposure are proven
**And** completion includes a built dry-run plan for current drifted profiles plus real apply/resume against disposable copied profiles reconciled by the canonical renderer check; mutating the production fleet before the canary story, mocks alone, documentation, ticket state, or command exit is insufficient evidence.

Requirements owned: FR20. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR10, NFR11, NFR13, NFR14, NFR16.

### Story 1.15: Converge Tracked Scaffolds Without Disturbing Runtime or WIP

As a fleet operator,
I want PJangler to update only positively owned PM scaffold assets from the pinned canonical template,
So that existing agents receive one coherent generation without overwriting unrelated repository work or mutable runtime state.

**Acceptance Criteria:**

**Given** scaffold findings from Story 1.6
**When** the scaffold domain planner runs
**Then** it derives a deterministic desired render from the parent repository's recorded clean template gitlink and exact registered agent/role inputs
**And** it blocks missing/uninitialized/mismatched/dirty source, nondeterministic render, or manifest disagreement instead of using a sibling checkout, mutable worktree, branch tip, or PATH fallback.

**Given** a selected managed role
**When** its candidate scaffold is prepared
**Then** rendering occurs in contained temporary state with provisioning hooks/external effects disabled and produces a validated owned-asset manifest containing relative path, file type, mode, safe symlink target, and content digest
**And** caches, `__pycache__`, bytecode, logs, runtime state, credentials, recovery files, and other generated droppings are rejected from both source and candidate.

**Given** the target repository has missing or stale owned assets
**When** planning compares candidate and target
**Then** it emits typed create/update/mode/link effects with exact precondition digests and a bounded path-level summary
**And** unexpected assets are removable only when current manifest/provenance positively proves PJangler ownership and unchanged state; otherwise they are preserved and manual/blocked.

**Given** a target owned path contains local modifications or has changed since plan observation
**When** apply revalidates it
**Then** the effect performs a preservation-safe merge only when the domain contract can prove it lossless and deterministic, otherwise it blocks that asset/agent before replacement
**And** it never resolves the conflict by reset, checkout, stash, clean, blind overwrite, or copying the canonical file over user changes.

**Given** unrelated modified/untracked files, submodules, branches, or commits exist in the target repository
**When** scaffold apply runs
**Then** their bytes, index/worktree state, refs, and submodule state remain unchanged and are recorded as preserved
**And** only planned owned paths may appear in the resulting repository delta; the controller does not implicitly commit, push, merge, rebase, or switch branches as part of the scaffold file effect.

**Given** ignored `agents/hermes/<role>/runtime/` state or explicit owned-state profile links exist
**When** scaffold apply prepares, commits, rolls back, or verifies a candidate
**Then** every runtime byte and allowed owned-state link target remains untouched and ignored/untracked
**And** runtime paths, nested repositories, profile directories, sessions, memories, logs, databases, sockets, and credentials are outside the scaffold transaction.

**Given** multiple owned files form one scaffold generation
**When** apply executes the agent's effect group
**Then** it uses Story 1.13 transaction/recovery primitives to stage and validate the complete candidate, commit files in the declared atomic group, and retain durable per-path recovery evidence until postconditions pass
**And** interruption or failure cannot leave a falsely successful mixed generation; recovery restores/adopts/blocks deterministically without touching unrelated paths.

**Given** multiple agents are selected
**When** one repository has a conflict, unsafe path, render failure, or postcondition failure
**Then** that agent's scaffold group stops and remains resumable while independent agent groups may complete under bounded concurrency
**And** the failure never changes the canonical template, parent gitlink, another repository, or global profile/runtime state.

**Given** an agent scaffold effect reports success
**When** postconditions run
**Then** every expected owned asset matches candidate content/type/mode/link target, no forbidden generated asset was installed, runtime remains ignored/untracked, and fleet scaffold status agrees with the pinned generation
**And** the resulting Git delta contains only selected owned scaffold paths and is retained as explicit evidence for the later canary/checkpoint workflow.

**Given** the same approved plan is applied after the scaffold already matches
**When** preconditions/postconditions are re-observed
**Then** every effect is no-op with byte-identical files, modes, links, repository index/WIP, runtime, and timestamps where no write is needed
**And** no render marker, registry timestamp, service action, commit, or evidence duplication is created.

**Given** focused tests use real deterministic renders and temporary Git targets with path spaces, unrelated WIP, owned-path edits, symlink/type/mode drift, forbidden droppings, runtime payloads, stale gitlinks, crashes, partial fleet failure, and idempotent reruns
**When** plan/apply/resume execute
**Then** source fidelity, manifest ownership, conflict handling, atomic generation, exact recovery, path safety, Git/WIP/runtime preservation, postcondition truth, and zero secret exposure are proven
**And** completion includes a built dry-run plan for current scaffold drift plus real apply/resume against disposable repository copies whose Git/runtime before/after inventories are independently verified; production fleet fanout before the canary story, mocks alone, documentation, ticket state, or command exit is insufficient evidence.

Requirements owned: FR21. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR10, NFR11, NFR13, NFR14, NFR16.

### Story 1.16: Reconcile Positively Owned Services and Prove Postconditions

As a fleet operator,
I want PJangler to reconcile only declared fleet-owned systemd units to their intended capability state and prove the result over time,
So that stale units, deferred gateways, and active services converge without disturbing foreign services or reporting transient success.

**Acceptance Criteria:**

**Given** systemd findings from Story 1.8
**When** the service domain planner runs
**Then** it emits typed effects for positively owned unit-file install/update/removal, daemon reload, enable/disable, start/stop/restart, and durable service-state projection with exact unit/precondition fingerprints and dependencies
**And** unknown, unregistered, ambiguously owned, foreign, or unsafe-path units remain manual/blocked rather than becoming deletion or control effects.

**Given** an agent's profile, scaffold, executable, channel, or registry prerequisite is not yet current
**When** service effects are ordered
**Then** unit-file and runtime-control effects depend on the exact prerequisite postconditions and cannot run first
**And** shared daemon reload is deduplicated/batched only where doing so preserves each agent's dependency and recovery boundaries.

**Given** an agent has no verified messaging credential and declares gateway deferred
**When** the service plan is applied
**Then** the owned gateway converges to installed as applicable, disabled, inactive, and nonfailed while the independently healthy heartbeat remains enabled/active
**And** PJangler never starts a credential-less gateway or leaves it enabled to restart-loop merely because a unit file exists.

**Given** an agent declares a verified active messaging capability
**When** gateway effects run
**Then** the unit file points to the selected pinned executable and real named profile, is enabled, and is started/restarted only after configuration/channel postconditions pass
**And** success requires the full bounded stability proof from Story 1.8 rather than one active sample or zero `systemctl` exit.

**Given** an agent heartbeat is managed
**When** heartbeat effects run
**Then** the timer and paired oneshot definition converge to the contract, the timer is enabled/active/waiting, and a completed current tick succeeds within policy
**And** a checkpoint-only, overdue, failed, stuck, or never-run heartbeat cannot be persisted as healthy.

**Given** a positively owned retired per-agent consumer/checkpoint or duplicate unit is present
**When** its removal effect is authorized and applied
**Then** PJangler first proves the unit stopped/inactive and disabled, removes only the exact owned fragment/metadata, reloads systemd, and proves absence plus canonical replacement topology
**And** query errors, ambiguous ownership, failed stop/disable, or uncertain post-state preserve the unit and registry metadata and leave the effect blocked/resumable.

**Given** a plan contains unit-file mutation but no runtime control, or contains start/stop/restart/disable/remove actions
**When** the operator applies it
**Then** file-only automatic effects follow their recorded class while runtime-control effects require the explicit repeatable authorization `--authorize service-control`
**And** `--apply`, `--live`, MCP invocation, or prior service state cannot imply that authorization or widen it to unselected units.

**Given** an owned unit file must change
**When** the effect installs or restores it
**Then** Story 1.13 atomic/recovery rules preserve exact previous bytes/mode and reject symlink/unsafe paths before daemon reload
**And** failed validation/reload restores or retains protected evidence before any attempt to run the candidate unit.

**Given** a systemd command times out, is cancelled, loses its response, or the service changes state during apply
**When** the effect outcome is uncertain
**Then** the run journal records outcome-unknown and re-observes unit-file, enabled, active, result/status, restart, and latest-tick postconditions before retry/adoption
**And** it never blind-repeats a possible stop/start/remove or reports the most favorable sample.

**Given** service postconditions pass
**When** contract-owned role/registry declarative or provisioning state is projected
**Then** only those owned fields and, if defined by the contract, a bounded proof receipt/reference are updated transactionally after direct proof while unknown metadata and stable timestamps are preserved
**And** transient systemd observations such as `ActiveState`, restart count, current result, and latest tick remain owned by systemd and the run journal/evidence rather than being persisted as competing registry truth.

**Given** service state is proven but a declarative projection fails
**When** the run outcome is recorded
**Then** the proven live outcome remains in the journal/evidence and the declarative projection is visibly stale/resumable
**And** PJangler neither rewrites observed reality as planned nor blindly rolls back a healthy service.

**Given** multiple selected agents share the user manager
**When** one service fails or restarts unexpectedly
**Then** its dependency branch stops while unrelated agents continue only within bounded concurrency and no fleet-shared gateway is restarted unless explicitly selected
**And** cancellation leaves no controller child running and records every known/unknown unit outcome.

**Given** the same approved service plan runs after all desired postconditions hold
**When** effects are re-observed
**Then** they are no-op with no unit-file rewrite, daemon reload, enable/disable/start/stop/restart, registry timestamp churn, or duplicate evidence
**And** bounded health proof may refresh observation evidence without mutating service state.

**Given** focused tests use a stateful fake systemd manager plus isolated owned/foreign unit fixtures
**When** active, deferred, missing, changed, retired, duplicate, crash-looping, late-failing, failed reload, uncertain response, projection failure, cancellation, and idempotent cases run
**Then** planning, explicit authorization, ownership, ordering, atomic files, outcome recovery, stabilization, projection truth, and foreign-service preservation are proven
**And** completion includes built plan/apply/resume against uniquely named disposable user units with direct multi-sample `systemctl --user show` proof and cleanup; production agent units remain unchanged until the canary story, and mocks, one active sample, documentation, ticket state, or command exit are insufficient.

Requirements owned: FR22. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR9, NFR10, NFR13, NFR14, NFR16.

### Story 1.17: Plan and Execute Safe Legacy-Process Drains

As a fleet operator,
I want isolated, duplicate, or legacy Hermes processes drained through an exact reviewed process-control plan,
So that runtime sprawl can be removed without signaling the wrong PID, killing interactive work, or deleting preserved agent state.

**Acceptance Criteria:**

**Given** process findings from Story 1.9
**When** the process domain planner evaluates a candidate
**Then** it requires a stable PID/start identity, exact executable/profile/ownership evidence, process kind, parent/group/cgroup context, desired replacement/postcondition, and a contract-approved drain strategy
**And** ambiguous, unclassified, permission-inaccessible, vanished, interactive/foreground, or insufficiently evidenced processes remain manual/blocked rather than becoming signal effects.

**Given** a process is owned by a systemd service
**When** a drain is planned
**Then** PJangler routes control through the Story 1.16 owned service effect and its `service-control` authorization instead of signaling a systemd child directly
**And** direct-process effects are reserved for proven isolated/legacy roots with no live service owner.

**Given** a duplicate or legacy root has a required current replacement
**When** effects are ordered
**Then** drain depends on the replacement's profile/config/service readiness and current bounded health proof
**And** the old process is not stopped first when doing so would remove the agent's only proven required capability.

**Given** a direct isolated-process drain is included in a reviewed plan
**When** the operator applies it
**Then** the effect requires the exact repeatable authorization `--authorize process-stop`, revalidates PID/start/executable/profile/parent identity immediately before action, and uses an argument-safe native process adapter rather than a shell command
**And** generic `--apply`, `--live`, MCP invocation, name matching, or prior process presence cannot imply or widen that authorization.

**Given** graceful shutdown is supported
**When** the drain begins
**Then** PJangler uses the contract-approved graceful request/signal, records dispatch durably, and waits through a finite stabilization window for the exact root and owned descendants to exit without respawn
**And** it does not remove pid files, sockets, profiles, runtime directories, sessions, memories, logs, repositories, registry rows, or unit files as a shortcut.

**Given** the process does not exit within the graceful deadline
**When** escalation is considered
**Then** forced termination is a separate planned risk class requiring explicit `--authorize process-kill`, a second immediate identity check, and proof that no unrelated processes share the selected group/cgroup
**And** without that exact authorization/evidence the effect stops as blocked with the process preserved.

**Given** the PID exits, is reused, execs, reparents, or changes executable/profile before either graceful or force dispatch
**When** identity is revalidated
**Then** PJangler sends no signal to the changed identity and records stale/vanished/conflict as appropriate
**And** a later process can never inherit an earlier plan's authorization solely by reusing the PID.

**Given** dispatch succeeds but the response is lost, cancellation occurs, or postcondition observation is incomplete
**When** apply/resume handles the outcome
**Then** it records outcome-unknown, re-observes the exact process identity and replacement health, and adopts proven exit or blocks ambiguity
**And** it never blind-repeats a signal or reports success from signal syscall/command exit alone.

**Given** a process exits and then respawns during the bounded proof window
**When** postconditions are evaluated
**Then** drain is nonhealthy with the new process identity and likely owning service/supervisor evidence
**And** PJangler does not chase successive PIDs or expand the plan to an unselected supervisor automatically.

**Given** a drain succeeds
**When** final status runs
**Then** the exact legacy/duplicate root and owned descendants are absent for the whole stabilization window, the intended replacement remains healthy when required, and registry/profile/runtime bytes are unchanged
**And** process and service domains agree; any contradiction keeps the effect incomplete.

**Given** the same plan is resumed after a proven successful drain
**When** the old process remains absent and replacement postconditions hold
**Then** the effect is idempotent no-op with no signal, service action, file deletion, registry change, or duplicate event
**And** historical process evidence remains clearly historical rather than a live finding.

**Given** focused tests launch disposable process trees with controlled identities, PID-change simulations, systemd-owned fixtures, graceful/forced behavior, respawn supervisors, response loss, cancellation, and unrelated group members
**When** planning/apply/resume execute with and without each authorization
**Then** routing, identity revalidation, authorization, bounded shutdown, escalation separation, no blind retry, postcondition proof, and state preservation are proven
**And** completion includes a built plan-only classification of current live legacy/isolated candidates plus real drain/resume of uniquely identifiable disposable processes; no production Hermes process is stopped before the canary story, and mocks, documentation, ticket state, a signal return, or command exit alone are insufficient.

Requirements owned: FR23. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR10, NFR13, NFR14, NFR16.

### Story 1.18: Roll Out Through Canaries and Evidence-Gated Waves

As a fleet operator,
I want convergence applied first to PJangler and then ssbnk before bounded approved waves,
So that controller self-proof and a true downstream application-path canary stop a bad generation before it spreads across the fleet.

**Acceptance Criteria:**

**Given** a reviewed complete-fleet or multi-agent reconciliation plan
**When** the operator runs `pjangler fleet rollout create --plan <plan-path> --out <rollout-path> [--wave-size <count>] [--json]`
**Then** PJangler creates a validated mode-0600 rollout artifact whose first agent wave contains only the contract-declared PJangler controller canary, whose second agent wave contains only the contract-declared ssbnk downstream canary, and whose later waves are bounded, stable, and dependency-ordered
**And** unclassified/blocked agents and separately authorized Bloodbank activation effects are excluded rather than silently placed into a normal wave.

**Given** a plan contains fleet-shared prerequisite effects that cannot be scoped to one agent
**When** rollout ordering is built
**Then** they appear in an explicit shared-prerequisite stage with their own risk, authorization, proof, and stop boundary before both single-agent canary waves
**And** no global effect is disguised as a canary-local change or applied merely because a later agent wave was approved.

**Given** the rollout artifact is serialized
**When** it is reviewed or resumed
**Then** it contains plan/contract/provenance digests, the ordered PJangler-then-ssbnk canary identities, wave membership, effect dependencies, entry criteria, required authorizations, stop conditions, expected postconditions, current decisions, attempts, outcomes, evidence references, and next eligible transition
**And** membership/order cannot change without creating a new digest and explicit operator decision.

**Given** PJangler or ssbnk has unrelated WIP, an unsafe branch/worktree state, unresolved recovery, stale plan input, unhealthy controller dependency, red CI/release prerequisite, or a gating pre-canary finding
**When** that single-agent canary's entry criteria are evaluated
**Then** the canary is blocked before mutation with exact preservation/evidence requirements
**And** rollout never stashes, resets, cleans, switches, merges, rebases, overwrites, or drops that WIP to force entry.

**Given** entry criteria pass
**When** the operator runs `pjangler fleet rollout advance --rollout <rollout-path> --wave <wave-id> [--authorize <class>...] [--json]`
**Then** only that exact wave's current effects execute through Stories 1.12–1.17 with their recorded authorization classes, locks, journals, bounds, and domain postconditions
**And** approval of one wave or effect class never authorizes a later wave, process kill, external action, or Bloodbank activation.

**Given** an agent in the active wave changes profile, scaffold, service, or process state
**When** its postconditions are evaluated
**Then** built fleet status proves selected domains directly, canonical renderer check agrees, systemd remains stable through the full window, process ownership is current, Bloodbank readiness is observed without activation, repository delta is limited to planned owned paths, and runtime/WIP inventories remain preserved
**And** deploy output, command exit, unit activity, mocks, or a board transition cannot substitute for those checks.

**Given** tracked repository files changed during a successful wave
**When** wave closeout is attempted
**Then** the exact scoped delta must be attributed to the owning ticket and landed through the existing verified Git checkpoint/push workflow with commit and remote-ref evidence before the wave is complete
**And** unrelated WIP is neither included in that checkpoint nor left altered by the controller; any required Git mutation is explicit in the reviewed workflow rather than an implicit scaffold effect.

**Given** any shared prerequisite or wave member fails, becomes unstable, mutates unplanned state, produces contradictory status, cannot land its tracked delta, or creates a new gating finding
**When** the stop condition fires
**Then** no dependent or later wave starts, successful independent outcomes and all failure/recovery evidence remain durable, and the rollout exposes resume/replan/rollback options appropriate to each proven state
**And** it does not blindly roll back healthy state, retry outcome-unknown effects, or widen the wave to repair the blocker.

**Given** the PJangler controller canary succeeds and is explicitly closed/advanced
**When** the next transition is evaluated
**Then** only the single-agent ssbnk downstream canary becomes eligible after fresh precondition validation
**And** no broader fleet wave can start from PJangler success alone.

**Given** the ssbnk downstream canary succeeds and is explicitly closed/advanced
**When** the first broader wave becomes eligible
**Then** PJangler requires an explicit operator decision based on current evidence from both ordered canaries and freshly validates that broader wave's plan preconditions
**And** time passage, a scheduler, prior global approval, or historical canary health cannot auto-advance the rollout.

**Given** a later bounded wave succeeds
**When** subsequent waves advance
**Then** the same entry, authorization, direct-proof, landing, stop, and explicit-decision boundaries apply to every wave
**And** concurrency never exceeds the artifact's limit or places agents sharing an unsafe authority/lock/failure domain into parallel execution.

**Given** the rollout is interrupted or the controller restarts
**When** `rollout advance` is rerun against the same artifact
**Then** it reconciles plan run journals and live postconditions, resumes only the selected current wave, and preserves all prior decisions/evidence
**And** it cannot recreate, skip, reorder, or mark a wave complete from stale local progress text.

**Given** Bloodbank target activation states before rollout
**When** any shared prerequisite, either canary, or normal convergence wave executes
**Then** every target's strict activation boolean remains byte-identical unless a separately reviewed activation-only plan is selected under the fleet contract's Bloodbank activation boundary
**And** rollout success is readiness/convergence proof, never implicit command-execution authority.

**Given** focused tests use an isolated multi-agent fleet with shared prerequisites, ordered single-agent PJangler and ssbnk canaries, bounded later waves, WIP, failures, crashes, unstable services, plan drift, Git checkpoint fixtures, and authorization classes
**When** create/advance/stop/resume/replan paths execute
**Then** fixed PJangler-then-ssbnk canary order, each explicit close/advance gate, artifact durability, wave bounds, stop propagation, evidence requirements, Git/WIP/runtime preservation, and unchanged activation are proven
**And** story completion includes the real ticketed PJangler controller canary closed first and the real ticketed ssbnk downstream canary closed second through the supported built CLI, each with committed/pushed scoped changes and direct profile/scaffold/systemd/process/Bloodbank-readiness proof before any broader production wave; simulation, documentation, ticket state, or command exit alone is insufficient evidence.

Requirements owned: FR24. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR10, NFR11, NFR13, NFR14, NFR15, NFR16.

### Story 1.19: Activate Bloodbank Targets Through a Separate Approval Gate

As a fleet operator,
I want each Bloodbank target activated or deactivated through its own explicit reviewed plan and live proof,
So that convergence never grants command-execution authority and failed activation returns safely to default-deny.

**Acceptance Criteria:**

**Given** one or more agents have completed their required convergence wave
**When** the operator runs `pjangler fleet bloodbank activate --agent <id>... [--out <plan-path>] [--json]`
**Then** PJangler creates an activation-only canonical reconciliation plan for the exact named agents and performs no registry write or command dispatch
**And** the command requires at least one explicit agent ID, accepts no implicit all-fleet target, and cannot include unrelated profile/scaffold/service/process effects.

**Given** activation is planned for an agent
**When** readiness preconditions are evaluated
**Then** current complete evidence must prove exact registry/profile identity, canonical scope/target, unique target ownership, healthy generated profile, healthy stable fleet-shared gateway using the current registry, no retired per-agent consumer, and every contract-defined ingress policy prerequisite
**And** missing, stale, incomplete, duplicate, contradictory, or historically-only evidence blocks activation rather than being waived by a successful convergence wave.

**Given** an activation plan is reviewed
**When** the operator applies it
**Then** changing `bloodbank.enabled` requires the exact authorization `--authorize bloodbank-activation`, revalidates every precondition under the Agent Registry lock, and changes only the strict authoritative activation field plus any contract-declared one-way role projection/proof reference
**And** generic `--apply`, `--live`, service/process authorization, MCP invocation, a resolvable profile, or prior execution can never imply or widen activation authority.

**Given** activation metadata is committed
**When** the Agent Registry and any declared projection are updated
**Then** Story 1.13 transaction rules preserve all unrelated/extension metadata and stable provisioning fields, publish the registry change atomically, and retain default-deny on incomplete recovery
**And** an unchanged rerun is byte-stable with no timestamp, service, profile, or evidence churn.

**Given** the shared gateway caches or reloads registry state
**When** activation postconditions are observed
**Then** PJangler uses the gateway's contract-defined safe refresh/observation path and proves that its current registry generation resolves the exact target as eligible
**And** any required service reload/control is a separately planned `service-control` effect rather than an implicit activation side effect.

**Given** the operator chooses to prove the real command journey
**When** the activation plan includes a bounded smoke invocation
**Then** dispatch requires the additional exact authorization `--authorize bloodbank-smoke-dispatch`, publishes one canonical uniquely correlated command with required actor/schema fields, and waits under deadline for the gateway's started plus terminal completed/failed lifecycle evidence
**And** activation authorization alone never publishes a command, while historical journal/events or a broker acknowledgement cannot substitute for this invocation's current terminal evidence.

**Given** registry activation succeeds but gateway eligibility or an authorized smoke invocation fails, times out, is cancelled, or has an ambiguous terminal outcome
**When** activation recovery runs
**Then** PJangler returns the newly changed target to strict `enabled: false`, proves the gateway no longer treats it as eligible, preserves the failed/unknown command evidence, and leaves the run nonhealthy/resumable
**And** it never leaves a newly authorized but unproven target enabled merely because the registry write succeeded.

**Given** a target was already explicitly enabled before the selected plan
**When** a later smoke proof fails
**Then** the plan follows its recorded pre-state/compensation policy and never silently revokes pre-existing authority that the operator did not select for deactivation
**And** it reports the target activated-but-blocked/unhealthy with exact manual/deactivation next actions.

**Given** the operator runs `pjangler fleet bloodbank deactivate --agent <id>... [--out <plan-path>] [--json]`
**When** the separately reviewed plan is applied with `--authorize bloodbank-activation`
**Then** the exact targets converge to strict false, the shared gateway proves them ineligible, and no command is dispatched
**And** profiles, services, runtime state, other agents, and routing identity metadata remain unchanged.

**Given** multiple explicit agents are selected
**When** one activation fails
**Then** its compensation/default-deny branch completes before it is final while independent agents follow their own effects only within bounded concurrency
**And** no batch-level success is reported unless every selected target has a proven final enabled/disabled state and gateway eligibility that matches it.

**Given** activation/deactivation status is rendered
**When** plan/apply/recovery completes
**Then** human and JSON results separately report requested authority, registry state, gateway-observed eligibility, smoke-dispatch authorization/use, correlated lifecycle outcome, compensation, and exact next actions
**And** credentials, prompts/responses beyond bounded test identifiers, raw broker payloads, or unrelated agent events are not exposed.

**Given** focused tests use isolated registries/profiles, a stateful shared-gateway adapter, fake broker/events, transaction crashes, stale readiness, duplicate targets, cached generations, smoke success/failure/timeout, pre-enabled targets, compensation, deactivation, and partial batches
**When** plan/apply/resume run with every authorization combination
**Then** exact targeting, default-deny, authority separation, registry preservation, gateway refresh, lifecycle correlation, compensation, idempotency, and zero unintended dispatch are proven
**And** completion includes a real operator-selected canary target activated through the built CLI, one separately authorized bounded command journey with current terminal event proof, and explicit final desired activation state reconciled from registry plus gateway; mocks, old journal rows, documentation, ticket state, broker ack, or command exit alone are insufficient evidence.

Requirements owned: FR25. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR9, NFR10, NFR13, NFR14, NFR16.

### Story 1.20: Continuously Detect and Publish Fleet Drift

As a fleet operator,
I want recurring read-only fleet checks to retain durable finding transitions and publish bounded downstream evidence,
So that new drift, worsening health, recovery, and deliberate exceptions remain visible without turning a scheduler, event bus, or ticket system into fleet truth.

**Acceptance Criteria:**

**Given** the inventory, health, and adapter capabilities from Stories 1.1–1.10
**When** the operator or a scheduler runs `pjangler fleet monitor run [--live] [--publish-events] [--json]`
**Then** PJangler performs a fresh complete-fleet observation through the same status application core and applies the same authority, completeness, deadline, cancellation, and stable-finding semantics
**And** its only default durable writes are the bounded controller-owned local evidence ledger and transactional event outbox defined by this story; only explicit `--publish-events` may additionally publish the sanitized committed finding-transition events defined below, while repository, registry, profile, scaffold, service, process, activation, board, repair, agent-dispatch, and other external-system mutations remain forbidden.

**Given** `monitor run` is invoked without or with `--live` and without or with `--publish-events`
**When** observation and side-effect permissions are selected
**Then** the default remains local/offline/no-network, `--live` permits only supported bounded read-only external observations, and neither mode implies event publication
**And** only `--publish-events` authorizes the defined finding-transition publication after local evidence commits; no flag combination authorizes reconcile/apply, process signals, service control, Bloodbank dispatch/activation, ticket/board mutation, repair, or any other external write.

**Given** a monitor run starts
**When** its result is made durable
**Then** PJangler atomically records a mode-0600 run plus finding-transition generation outside tracked target repositories with run ID, contract/status schema versions, observation generation/time, source commit/package/provenance, registered/observed scope, completeness, finding IDs, safe evidence digests/references, prior/current state, disposition source, and outcome
**And** it stores no credential, file body, prompt/response, raw broker payload, unbounded log, or private environment value and refuses unsafe path/symlink/ownership states before writing.

**Given** the same normalized finding remains unchanged across runs
**When** the later generation is committed
**Then** PJangler retains the deterministic finding ID and open occurrence, updates bounded last-seen/run references and occurrence count, and emits no duplicate transition or downstream outbox item
**And** timestamp, prose wording, adapter ordering, or repeated scheduler delivery cannot manufacture a new logical finding.

**Given** a finding appears, becomes more severe/gating/incomplete, or returns after a proven recovery
**When** transitions are evaluated against the last committed applicable generation
**Then** it is classified as new or worsened with prior/current normalized state, attributable scope/domain/owner, safe evidence, and exact next action
**And** a recurrence after recovery starts a new occurrence generation while preserving its stable logical finding ID and full prior history.

**Given** a previously open finding is absent from current observations
**When** recovery is evaluated
**Then** PJangler records recovered only when a fresh complete observation of the same applicable agent/domain/rule positively proves the healthy postcondition
**And** scope filtering, skipped/unobserved domains, adapter failure, cancellation, stale evidence, missing inventory rows, or an incomplete run can never close or recover the finding.

**Given** a finding is reported as deferred or manually accepted
**When** the monitor resolves that disposition
**Then** it requires a current validated authoritative record naming the exact finding/rule scope, owner/actor, rationale, creation evidence, and bounded expiry or review condition, and emits the deferred/accepted state separately from health
**And** the monitor cannot infer acceptance from age, ticket state, silence, successful publication, or a prior plan; invalid, expired, revoked, or scope-mismatched dispositions remain active and produce an actionable transition.

**Given** a run is partial, cancelled, times out, crashes, or encounters contradictory evidence
**When** the generation is finalized or recovered
**Then** its durable record remains explicitly nonhealthy/incomplete, independently observed findings remain attributable, open findings without complete re-observation remain unresolved, and exact retry/investigation actions are retained
**And** it never rewrites the prior complete generation, fabricates recovery, or publishes an all-healthy aggregate from the partial run.

**Given** the operator runs `pjangler fleet monitor schedule --calendar <systemd-calendar> [--live] [--publish-events] --out <plan-path> [--json]`
**When** the schedule is validated
**Then** PJangler creates a canonical no-mutation plan for the controller-owned `pjangler-fleet-monitor.service` and `.timer` only, with a validated calendar, absolute built executable, explicit local-or-live observation mode, explicit `publish_events` enabled/disabled state, evidence paths, deadlines, missed-run policy, hardening, and postconditions
**And** the service invokes `monitor run` directly without a shell, embedded credential, n8n dependency, per-agent unit, or repository-local runtime file; a nonpublishing schedule's installed command omits `--publish-events`.

**Given** a reviewed monitor schedule plan
**When** it is applied through Story 1.12
**Then** unit installation/enable/start follows Story 1.16's systemd ownership and transaction rules and requires the separate `--authorize service-control` permission, while a schedule whose recorded `publish_events` is enabled additionally requires the distinct exact `--authorize evidence-publish`
**And** a publishing schedule is blocked rather than installed or enabled without both authorizations, a nonpublishing schedule installs a command that omits `--publish-events`, scheduling approval cannot authorize fleet mutation, and schedule removal or cadence/mode/publication change requires its own newly reviewed plan while preserving existing evidence.

**Given** a scheduled run fires while another monitor run holds the controller lock
**When** single-flight handling occurs
**Then** the later invocation exits within a bounded deadline with a durable overlap/skipped outcome and does not start duplicate probes or transition publication
**And** a crashed holder releases or leaves safely recoverable lock state without allowing two writers to corrupt the evidence generation.

**Given** one or more committed finding transitions are ready for downstream automation
**When** a run explicitly authorized with `--publish-events` processes the transactional outbox
**Then** PJangler first commits authoritative local observation/transition evidence and only then publishes the sanitized versioned contract-declared transition events through the existing event convention, with stable delivery/deduplication keys and references back to the committed evidence generation
**And** a run without `--publish-events` performs no publication, while publication or acknowledgement cannot alter health/disposition truth, auto-apply a repair, dispatch an agent command, activate a target, or open/close/mutate an external ticket or board.

**Given** the event transport is unavailable, rejects a message, times out, or returns an ambiguous acknowledgement
**When** the monitor closes the run
**Then** committed observation evidence remains authoritative, publication is reported degraded with its outbox item pending/outcome-unknown as appropriate, and retries reuse the same delivery identity
**And** it never drops the transition, generates a duplicate logical event, rolls back the fleet observation, or accepts downstream state as proof of delivery or recovery.

**Given** the operator runs `pjangler fleet monitor status [--json]`
**When** schedule/evidence health is inspected
**Then** output reports configured cadence/mode, unit/timer state, last started/committed/complete generations, observation freshness/completeness, active and transition counts, overdue/overlap state, outbox backlog/oldest age, and exact next actions with deterministic bounded human/JSON semantics
**And** missing evidence, an overdue timer, a stale complete generation, or pending/unknown publication prevents a false-green monitor aggregate without changing the underlying current fleet finding states.

**Given** focused tests use isolated HOME/XDG, registries, repositories, profiles, evidence ledgers, a stateful systemd adapter, fake clocks/events, repeated and reordered findings, severity changes, complete and partial recovery, deferred/accepted expiry, overlapping runs, crashes, unsafe paths, transport failures, ambiguous acknowledgement, retries, and large JSON output
**When** run/schedule/apply/status/recovery paths execute through CLI and equivalent MCP monitor operations across local, `--live`, and `--publish-events` combinations and both schedule authorization classes
**Then** zero target mutation, exact transitions, deduplication, completeness rules, disposition authority, atomic durability, single-flight bounds, schedule authorization, explicit publication authority, outbox retry identity, adapter parity, and parse-safe output are proven
**And** completion includes the real built CLI plus a disposable real user-systemd monitor timer against isolated registries/evidence paths, observed invoking at least two bounded runs that demonstrate a finding transition and unchanged deduplication before the timer is returned to its recorded prior state; mocks, documentation, ticket state, event acknowledgement, timer activity, or command exit alone are insufficient evidence.

Requirements owned: FR27. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR7, NFR8, NFR9, NFR10, NFR11, NFR12, NFR13, NFR14, NFR15, NFR16.

### Story 1.21: Enforce Fleet-Aware CI and Release Gates

As a fleet operator,
I want CI and every release path gated by the same versioned fleet contracts and current evidence,
So that a package cannot ship with broken machine interfaces, stale template pins, incompatible schemas, red tests, or unresolved release-blocking fleet findings.

**Acceptance Criteria:**

**Given** the tracked fleet contract and a tracked versioned fleet-gate policy
**When** either gate loads its requirements
**Then** the policy declares required build/test/output/schema/template/package/provenance checks, evidence freshness/completeness bounds, release-blocking finding classes, non-waivable classes, and compatible policy/contract versions
**And** an unknown version, missing required check, contradictory rule, or policy that attempts to redefine registry/runtime/activation truth fails closed before running or publishing a favorable gate result.

**Given** a developer or CI runner invokes `pjangler fleet gate ci [--ref <git-ref>] [--out <path>] [--json]`
**When** no ref or a ref is supplied
**Then** PJangler resolves the candidate once to an immutable commit (defaulting to the checked-out CI/local `HEAD`), records that commit, and evaluates it in a clean isolated candidate checkout with its recorded submodule/gitlink state
**And** it never stashes, resets, cleans, checks out over, commits, tags, or otherwise changes the caller's current worktree or unrelated WIP; any uncommitted caller changes are explicitly outside the candidate and reported as such.

**Given** the CI gate runs in a pull-request, branch, or local environment
**When** fleet checks execute
**Then** they use isolated HOME/XDG/registries/profiles/repositories and deterministic fixtures rather than production fleet state, systemd, processes, Bloodbank, boards, n8n, or mutable sibling checkouts
**And** the result identifies itself as a hermetic candidate gate, never as proof that the current deployed fleet is healthy or converged.

**Given** the candidate contains the canonical template and other declared submodules/generated inputs
**When** template cleanliness and pinning are checked
**Then** every required gitlink is initialized at the candidate's exact recorded commit, clean, compatible with the fleet contract, and the sole source for packaged/rendered fleet assets
**And** a dirty, missing, uninitialized, mismatched, unreachable, substituted, or working-tree-only template state blocks the gate instead of being repaired, fetched from an unrecorded source, or accepted from a sibling checkout.

**Given** fleet CLI and MCP machine interfaces are release surfaces
**When** the CI gate exercises their declared contract suite
**Then** real built contract/status/plan/apply-result/rollout/monitor/gate JSON outputs and MCP structured results validate against their versioned schemas for success, unhealthy, partial, cancellation, and categorized-failure cases with stable ordering
**And** real subprocess capture, pipes, redirection, and payloads larger than the pipe buffer prove one complete UTF-8 document and stdout drain; snapshots, direct function calls, or a zero exit alone cannot satisfy the check.

**Given** the current schemas and their supported predecessor fixtures
**When** compatibility checks run
**Then** additive compatible evolution remains readable and deterministically normalized, while removed/renamed required fields, changed authority semantics, ambiguous defaults, or unsupported breaking versions are rejected with the required version/migration action
**And** a breaking plan/evidence/result contract cannot pass merely because current producer and consumer code changed together.

**Given** the gate policy's focused and aggregate suite manifest
**When** build validation runs
**Then** the exact candidate completes dependency/lockfile validation, typecheck, production build, focused fleet-domain regressions, CLI/MCP contract tests, transaction/crash tests, renderer/template tests, and the aggregate repository suite with no required test silently omitted, skipped, quarantined, or allowed to fail
**And** test results, commands, versions, durations, and safe artifact digests are attributable to the candidate commit rather than reused from an earlier checkout or workflow run.

**Given** any required tool is absent, a check times out/cancels/crashes, a result is malformed/truncated, a test report is missing, or independent checks disagree
**When** gate aggregation runs
**Then** the affected check is error/incomplete and the overall gate blocks while preserving every independent outcome and exact next action
**And** optional/skipped semantics are allowed only where the tracked policy explicitly marks a check nonrequired; infrastructure trouble never becomes pass.

**Given** a gate completes
**When** human, `--json`, and/or `--out` output is requested
**Then** PJangler emits one canonical versioned gate document with candidate commit, contract/policy versions, check IDs/outcomes, schema and test evidence, template gitlinks, package/evidence inputs when applicable, blockers, safe provenance/digests, completeness, and exact next actions
**And** `--json`/`--out` follow Story 1.11's canonical stdout/file equivalence and safe atomic file rules, with a successful exit only when every required check is proven pass.

**Given** a release candidate has been built into an exact local npm tarball
**When** the operator or release automation runs `pjangler fleet gate release --ref <git-ref> --tag <tag> --package <tarball> --fleet-evidence <generation> [--live] [--out <path>] [--json]`
**Then** the release gate first requires a passing CI-gate document for the same immutable commit/policy/content inputs or reruns that gate, and performs zero version bump, commit, tag creation, remote push, package publication, service action, fleet mutation, event publication, or board mutation itself
**And** `--live` authorizes only bounded read-only refresh of contract-declared external observations; it never implies `monitor --publish-events`, repair, activation, dispatch, or release mutation.

**Given** the candidate ref, tag, package metadata, lockfile, build output, and tarball
**When** release provenance is verified
**Then** the package name/version and lockfile agree, the exact `v<version>` annotated tag peels to the candidate commit, the tarball name/manifest/content and release provenance identify that version and commit, declared template/gitlink assets match the candidate, and the recorded tarball integrity digest covers the bytes that would be published
**And** an uncommitted build, lightweight/moved/mismatched tag, wrong version, rebuilt or substituted tarball, unexpected generated/runtime/backup file, missing packaged asset, secret-shaped content, or package assembled from another checkout blocks release.

**Given** `--fleet-evidence <generation>` references Story 1.20 evidence
**When** release-blocking fleet health is evaluated
**Then** the generation must be authentic, current within policy, complete for every required registered scope/domain, produced under compatible contracts, and free of active unaccepted release-blocking findings and monitor/outbox integrity failures
**And** missing/stale/partial evidence, an incomplete live refresh, an expired/revoked acceptance, or an unresolved non-waivable finding blocks release; valid deferred/accepted nonblocking findings remain visible with owner/rationale/expiry and are never erased to make the gate green.

**Given** ticket, event, CI-provider, package-registry, or historical release state disagrees with current gate inputs
**When** the release decision is made
**Then** current candidate bytes, Git objects, contracts, tests, and fleet evidence govern the decision and the contradiction is an explicit blocker or warning according to policy
**And** a green workflow badge, ticket state, event acknowledgement, existing npm version, mutable branch name, documentation, or prior successful gate cannot substitute for the exact current proof.

**Given** `mise run release`, `mise run publish`, or the canonical GitHub release workflow reaches its first irreversible/external release step
**When** it prepares to push a release commit/tag or publish/retry the npm tarball
**Then** it invokes the built release gate at the last safe point using the exact commit, annotated tag, tarball bytes, CI-gate digest, and fleet-evidence generation, and revalidates that none changed after the gate
**And** failure prevents the applicable push/publish, success pins the gate document and tarball digest to the release evidence, publish consumes only that exact tarball, and no bypass/continue-on-error path can skip the required gate.

**Given** candidate/tag/tarball/policy/template/evidence inputs change after a passing gate
**When** release automation resumes or retries
**Then** the prior gate is stale by digest and the complete applicable gate reruns before any remaining external action
**And** it never blesses a rebuilt tarball, retargeted tag, advanced branch, newer contract, or refreshed finding disposition under an older green result.

**Given** focused tests use temporary Git repositories/submodules/tags, isolated npm packs, schema predecessor fixtures, large/malformed CLI output, red/skipped/cancelled suites, dirty/missing pins, package tampering, stale/partial fleet evidence, blocking/nonblocking/accepted findings, and release-resume input changes
**When** CI/release gates and canonical workflow wrappers execute
**Then** candidate isolation, preservation, required-check aggregation, schema compatibility, template fidelity, exact tarball/tag/commit consistency, evidence policy, TOCTOU invalidation, parse-safe output, and zero unauthorized external writes are proven
**And** completion includes a real built CLI CI gate on the exact current commit, an actual `npm pack` tarball plus local annotated candidate tag exercised through the release gate, and a required canonical CI workflow run proving the gate is enforced before release side effects; mocks, documentation, ticket state, a green unrelated job, or command exit alone are insufficient evidence.

Requirements owned: FR28. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR9, NFR10, NFR11, NFR12, NFR13, NFR14, NFR15, NFR16.

### Story 1.22: Close the Migration with Current End-to-End Evidence

As a fleet operator,
I want migration closeout to reconcile every requirement and planned effect against current technical, release, repository, and board evidence,
So that the epic is completed only when the managed fleet is proven converged and every remaining exception is explicit, owned, and bounded.

**Acceptance Criteria:**

**Given** the authoritative pre-migration live-assessment baseline and the completed artifacts from Stories 1.1–1.21
**When** the operator runs `pjangler fleet closeout create --baseline <baseline> --rollout <rollout> --release-gate <gate> --fleet-evidence <generation> [--live] --out <report-path> [--json]`
**Then** PJangler validates and content-addresses the exact baseline, contract, requirements, plans, run journals, rollout, monitor generation, release gate, Git/release references, and owning Project Registry/ticket binding before producing a report
**And** the command performs no repository/registry/profile/scaffold/service/process/activation/package/Git/event/board mutation; `--live` authorizes only bounded read-only external observations and never event publication or implicit repair.

**Given** `closeout create` is run without `--live`
**When** completion eligibility is evaluated
**Then** PJangler may produce a durable incomplete diagnostic report with all available mappings, gaps, and next actions, but it cannot report `ready-to-close`, technical-complete, administrative-complete, or finalize-eligible
**And** every completion state and successful finalize requires a fresh complete full-live observation of every policy-required fleet scope/domain within its freshness bounds, collected or revalidated through the explicit `--live` path.

**Given** the baseline is loaded
**When** before/after comparison begins
**Then** it retains the authoritative 2026-08-31 live-assessment decisions and supersession rules plus safe pre-migration inventory/provenance/health counts and evidence references under their original digests
**And** stale n8n-centralized orchestration, obsolete source paths, per-agent Bloodbank consumer/checkpoint assumptions, or registry-discovery-as-activation claims cannot re-enter the target model through an older document.

**Given** the epic defines FR1–FR30, NFR1–NFR16, and AR1–AR20
**When** traceability is generated
**Then** every requirement appears exactly once in a complete matrix linked to its owning Story 1.N, implementation commit/artifact, focused and aggregate tests, current direct/live proof where applicable, and final pass/deferred/accepted/blocked status
**And** a missing, duplicate, prose-only, ticket-only, mock-only, command-exit-only, or evidence-free mapping blocks closeout rather than being marked complete or not applicable without an authoritative rationale.

**Given** one or more reconciliation plans and rollout waves were executed
**When** planned-effect traceability is evaluated
**Then** every stable effect ID maps to its original finding, risk/authorization class, exact run/journal attempt, before/after fingerprints, outcome, postcondition proof, Git checkpoint where applicable, and final fleet observation
**And** outcome-unknown, stale, unproven, compensated-but-unreconciled, unplanned mutation, unlanded tracked delta, skipped dependency, or missing journal state blocks closeout while preserved successful independent effects remain visible.

**Given** a fresh complete full-live fleet evidence generation collected or revalidated through `--live`
**When** managed-state completion is evaluated
**Then** every contract-declared managed agent and specialist/shared service has a resolved unique identity, canonical authority relationships, current desired provenance, healthy applicable scaffold/profile/systemd/process/Bloodbank-readiness state, and complete bounded observation
**And** no unclassified member, duplicate authority, legacy service/process generation, contradictory adapter claim, unresolved recovery, stale required domain, or false-green aggregate may remain.

**Given** lifecycle exceptions and Bloodbank targets exist
**When** closeout classifies them
**Then** intentionally unmanaged, retired, deferred, and manually accepted states require current authoritative owner/rationale/scope/evidence plus bounded review/expiry conditions and cannot hide a non-waivable epic goal
**And** Bloodbank readiness, registry activation, gateway-observed eligibility, and last proven command journey remain separate; each target's final strict desired activation state must match registry and gateway evidence without requiring every ready target to be enabled.

**Given** PJangler, the canonical template, and downstream repositories were changed by the epic
**When** repository closeout runs
**Then** every fleet-owned change is attributed to its ticket, committed, pushed, reachable from the canonical remote branch, and reflected by the recorded template/gitlink pins, while `git unpushed` reports no detached, missing-upstream, uncommitted, or unpushed state for any touched repository
**And** pre-existing unrelated WIP is either proven unchanged from its applicable baseline or independently attributed, committed/pushed/resolved by its owner with evidence outside fleet-owned deltas; it is never swept into a fleet commit, remaining ambiguous/unlanded WIP in a touched repository blocks closeout, and legitimate separately landed evolution does not fail merely because it differs from the original baseline.

**Given** package and release evidence from Story 1.21
**When** release alignment is checked
**Then** package.json/lockfile version, annotated Git tag, tag target commit, canonical remote main ref, passing required CI gate/run, exact published npm tarball integrity/provenance, installed built CLI identity, and all deployed template/gitlink pins reconcile to the declared final release state
**And** a green unrelated workflow, local-only commit/tag, repacked tarball, registry version without matching bytes/provenance, dirty template, stale installed CLI, or mutable branch name blocks closeout.

**Given** the owning Plane epic/story records are resolved through the Project Registry ticket-provider binding
**When** administrative readiness is assessed
**Then** every implementation story has its evidence references and technical completion state reconciled, the one owning epic identifies all 22 story outcomes and remaining bounded exceptions, and any board/API unavailability is reported as administrative-incomplete
**And** ticket text, status, or checked boxes never substitute for technical proof, while no issue is created, edited, transitioned, or closed during `closeout create`.

**Given** a closeout report is written
**When** human, `--json`, and/or `--out` output is produced
**Then** it is a versioned canonical before/after document with content digest, generation/freshness, input digests, complete requirement/effect matrices, fleet and activation summaries, repository/release/CI/board reconciliation, exceptions, blockers, evidence references, and exact next actions
**And** `--json`/`--out` follow Story 1.11's canonical stdout/file equivalence and atomic safe-path rules, stable ordering and bounded redaction prevent secrets/private payloads/unbounded logs, and an incomplete report remains durable without claiming epic completion.

**Given** the report has no technical, release, repository, evidence, or administrative blocker and includes a still-fresh complete full-live observation of every required scope/domain
**When** the operator runs `pjangler fleet closeout finalize --report <report-path> [--authorize board-closeout] [--json]`
**Then** PJangler revalidates the report digest, the complete full-live generation, and every freshness-sensitive input before declaring it technically complete, and without `--authorize board-closeout` returns `ready-to-close` without any external mutation
**And** only the distinct exact authorization may invoke the provider adapter to perform the report's bounded owning-board completion transitions; it cannot mutate fleet state, expand issue scope, rewrite evidence, or create unrelated tickets.

**Given** authorized board closeout runs
**When** one or more exact transitions succeed, fail, time out, or have an ambiguous outcome
**Then** PJangler records a durable idempotent closeout journal/receipt, re-reads each affected issue through the bound provider, and reports technical-complete/administrative-complete only when the observed final states match the report
**And** partial or unknown board outcomes remain resumable and cannot roll back technical state, repeat a proven transition, close the parent ahead of required children, or turn the evidence report green retroactively.

**Given** any contract, registry, runtime, process, activation, repository, template pin, CI, tag, package, published artifact, evidence disposition, or board state changes after a report is created
**When** finalize or a later closeout status check runs
**Then** the affected digest/freshness precondition invalidates the prior completion claim and requires a new closeout generation or exact administrative resume as applicable
**And** prior reports and receipts remain immutable historical evidence rather than being overwritten to match the newer state.

**Given** focused tests use isolated baseline/current snapshots, requirements and effect matrices, run/rollout/monitor journals, mixed lifecycle/activation states, temporary multi-repository remotes, dirty/unpushed/WIP fixtures, local annotated tags and tarballs, fake CI/npm/Plane adapters, crashes, stale evidence, partial board transitions, and post-report drift
**When** create/finalize/resume/status paths run through CLI and equivalent MCP operations
**Then** full traceability, current-state truth, offline-incomplete/full-live-complete boundaries, exception/activation separation, repository/release alignment, safe canonical reporting, digest invalidation, authorization isolation, idempotent administrative closeout, and preservation are proven
**And** completion includes one real full-live complete-fleet observation after all waves, real built renderer/CLI/MCP/systemd/process/Bloodbank evidence, actual committed/pushed remote refs and clean touched-repository `git unpushed` proof, exact CI/tag/published-package reconciliation, and separately authorized owning-board read-back; documentation, mocks, ticket state, historical logs, or command exits alone are insufficient evidence.

Requirements owned: FR29. Primary NFRs: NFR1, NFR2, NFR3, NFR4, NFR5, NFR6, NFR7, NFR8, NFR9, NFR10, NFR11, NFR12, NFR13, NFR14, NFR15, NFR16.
