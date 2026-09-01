# Epic 1 Context: Registry-Wide Fleet Convergence Control Plane

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make PJangler the registry-wide fleet control plane for the ~28-agent Hermes
fleet: one authoritative inventory, one truthful health read model, and a
plan-first convergence engine covering registry rows, project bindings,
generated profiles, tracked PM scaffolds, systemd units, live processes, and
Bloodbank routing. The mechanisms already exist individually but do not compose
into a control loop — nothing can answer "is the fleet correct?" in one
invocation, every managed PM scaffold has drifted, dozens of Hermes processes
run outside systemd ownership, and machine-readable audit output truncates under
pipe capture. The epic observes truthfully first, then converges safely, then
rolls out through canaries and bounded waves, then keeps the result continuously
proven. Repos stay independent; repo fusion is explicitly not the fix.

## Stories

- Story 1.1: Define Fleet Authority and Managed-State Contract
- Story 1.2: Discover the Complete Fleet and Detect Identity Conflicts
- Story 1.3: Report Fleet Provenance Through Shared CLI and MCP
- Story 1.4: Deliver Parse-Safe Registry-Wide Fleet Status
- Story 1.5: Make Partial Health Truthful and Actionable
- Story 1.6: Audit Tracked PM Scaffold Parity Fleet-Wide
- Story 1.7: Prove Generated Profile Health and Classify Extras
- Story 1.8: Prove Canonical systemd Topology and Service Health
- Story 1.9: Attribute Live Hermes Processes and Expose Runtime Sprawl
- Story 1.10: Prove Bloodbank Routing Readiness Without Granting Activation
- Story 1.11: Produce Scoped, Versioned Dry-Run Reconciliation Plans
- Story 1.12: Apply Only Current Plans with Resumable Outcomes
- Story 1.13: Make Fleet Mutations Crash- and Concurrency-Safe
- Story 1.14: Converge Profiles Through the Canonical Renderer
- Story 1.15: Converge Tracked Scaffolds Without Disturbing Runtime or WIP
- Story 1.16: Reconcile Positively Owned Services and Prove Postconditions
- Story 1.17: Plan and Execute Safe Legacy-Process Drains
- Story 1.18: Roll Out Through Canaries and Evidence-Gated Waves
- Story 1.19: Activate Bloodbank Targets Through a Separate Approval Gate
- Story 1.20: Continuously Detect and Publish Fleet Drift
- Story 1.21: Enforce Fleet-Aware CI and Release Gates
- Story 1.22: Close the Migration with Current End-to-End Evidence

## Requirements & Constraints

- **Read-only by default.** Mutation requires an explicit apply action; each
  destructive, external, process-stop, or activation effect needs its own
  visible authorization on top of that.
- **Truthful under partial failure.** Collection errors, timeouts, missing
  tools, stale observations, skipped domains, and unproven postconditions stay
  visible. An aggregate may never claim healthy when a required domain was
  skipped, truncated, stale, or unobserved. Project health, shared-host health,
  deferred capabilities, unmanaged observations, blocked observations, and
  collection errors are distinct categories, not one boolean.
- **Machine output is a hard contract.** One complete, schema-versioned,
  stable-sorted, bounded JSON document that survives terminals, pipes, files,
  subprocess capture, MCP, and CI without truncation or progress/ANSI noise.
  Prove it at payloads larger than the pipe buffer via real subprocess capture
  and on failure exits — today's audit JSON truncates near 8 KiB because the
  process exits before stdout drains.
- **Idempotent and preservation-safe.** An unchanged rerun writes nothing,
  churns no services, regenerates no timestamps, loses no metadata, duplicates
  no evidence. Ambiguous state is classified for the operator, never purged,
  blindly merged, adopted, deleted, or killed.
- **Crash- and concurrency-safe.** Finite lock/operation deadlines, locks
  released on process death, unsafe symlink and path states rejected, atomic
  commits, crash-recovery evidence, and no rollback over a newer out-of-band
  write.
- **No literal credentials** in tracked files, plans, JSON, logs, diagnostics,
  fixtures, process arguments, or broad child environments — runtime injection
  or `op://` references only.
- **Bounded and scalable.** Bounded concurrency, per-agent and global deadlines,
  cancellation, and resumable checkpoints so one hung repo, systemd query,
  renderer, or adapter cannot stall the fleet. No hard-coded agent lists.
- **Offline-usable.** Status works without n8n or board availability; external
  observations are opt-in and marked stale or skipped. No acceptance criterion
  may require n8n.
- **Evidence beats prose.** Completion is proven by current files, recorded
  pins, live bounded service/process observation, and executable behavior — not
  by docs, cached board state, a mutable submodule worktree, or a zero exit.

## Technical Decisions

**Authority split, not merger.** Project Registry owns project identity and
project-to-board binding; Hermes Agent Registry owns operational
agent/profile/routing records. Every shared projection has one declared
direction plus a drift check; a field claimed writable by both registries fails
validation rather than being silently resolved. Physical consolidation is out of
scope.

**One application core, thin adapters.** A single fleet service composes
adapters for project registry, Hermes registry, repository/parity, template
provenance, profile renderer, systemd, process inventory, Bloodbank, release
state, and evidence. CLI and MCP are equivalent thin adapters over it — same
schemas, safety defaults, cancellation/deadline behavior, registry overrides.
Existing recipe-owned audit rules may feed it as observations, but a host-scoped
rule evaluated inside one repo is not a registry-wide claim; the controller owns
traversal and aggregation.

**Versioned fleet contract as the spine.** Declares schema version, contract
version, compatibility range, canonical service model, authority owners, and
lifecycle classes (managed agent, managed specialist/shared service,
intentionally unmanaged, retired, unclassified). No mutable runtime observation,
credential, or transient health result lives in it. Namespaced extensions must
round-trip byte-stable without becoming implicit policy.

**Canonical runtime model.** One tracked PM role per repo; one real named
profile directory (never a symlink) with identity metadata, override-only
`config.delta.yaml`, generated `config.yaml`, and an explicit Hindsight bank
pin; ignored role-local runtime; exactly one per-agent messaging gateway and one
heartbeat timer/service pair; one fleet-shared Bloodbank command gateway.
Per-agent Bloodbank consumers, checkpoint timers, n8n-owned truth, and
hard-coded Hermes checkout paths are retired drift, not alternate healthy modes.

**Capability-aware health, not liveness theater.** A credential-less gateway is
healthy only when explicitly deferred, disabled, and inactive with inherited
platform enablement overridden false. An enabled gateway needs stable `Result`,
`ExecMainStatus`, restart count, and channel ownership evidence over a bounded
window. Heartbeat health requires a successful latest tick — an active timer
proves nothing.

**Activation is a separate authority.** Discovery, installation, health, routing
readiness, and execution activation are distinct states. A Bloodbank target is
eligible only with a strict explicit activation flag owned by the Hermes
registry, fleet gateway scope, matching target ID, and a nonblank registered
profile. Nothing may infer or auto-grant it; failure or rollback returns to
default-deny.

**Plan/apply transaction shape.** Plans are versioned artifacts carrying the
observation snapshot fingerprint, typed effects, ownership, dependencies,
preconditions, expected postconditions, risk/reversibility class, approval
gates, and a reason for every automatic, deferred, blocked, or manual action.
Apply runs only an explicitly selected, still-current plan and rejects stale
observations or changed preconditions. Follow the proven PJangler pattern —
validate before mutation, record typed effects, persist truth last, preserve
partial outcomes, verify postconditions against the real application path.
Rollout state lives durably outside tracked target repositories.

**Convergence goes through canonical mechanisms.** Profile changes use the
base-plus-delta renderer and its per-profile lock, lock order
`registry -> profile -> snapshot/check -> write/rollback -> unlock`. Scaffold
fanout uses the committed canonical template at the pinned gitlink — never a
mutable worktree — ships every owned changed asset as one versioned set, rejects
dirty sources, and leaves unrelated repo work and ignored runtime bytes
untouched. Service reconciliation touches only positively owned units. Registry
writes preserve unknown/extension metadata and stable timestamps.

**Platform baseline.** Node.js 20+, TypeScript/ESM, the singleton recipe
registry, existing plan/apply transactions, both YAML and PostgreSQL project
registry implementations, current Hermes template and Bloodbank contracts. Paths
resolve from registries and config, canonicalized and contained. Tests run
against isolated HOME, XDG, registries, repos, profiles, process fixtures, and
fake systemd/Bloodbank adapters — never production fleet state.

**Diagnostics are part of the contract.** Every finding names its owning
registry, domain, and repository and whether repair is automatic,
approval-gated, blocked, or another owner's. Output explains the fleet at
summary, domain, agent, finding, and planned-effect levels.

## Cross-Story Dependencies

- **Brownfield, no starter story.** Early work establishes the fleet domain
  model, schemas, observation boundary, and regression harness around live
  production contracts.
- **Five ordered horizons, each enabling the next:** trustworthy inventory →
  real health → safe convergence → canary rollout → continuous proof. The story
  sequence follows that order.
- **Read model before controller.** The mutation controller must not be built on
  incomplete or lossy observations; parse-safe versioned status is the gate.
- **Contract before everything.** Authority, classification, and service-model
  definitions are consumed by every later observation, plan, and mutation.
- **Classification before cleanup.** Extra profile-root entries, unattributed
  processes, and legacy units get classified and owned before any adoption,
  retirement, or drain is planned.
- **Readiness gates effects.** Profile, config, scaffold, and executable
  readiness gate unit-file and runtime-control effects, which gate process
  drains.
- **Fixed rollout order:** shared fleet-wide prerequisites, then the PJangler
  canary, then the ssbnk canary, then bounded waves — each gated on direct
  postcondition evidence.
- **Bloodbank activation is a separate, later gate,** never a side effect of
  convergence or rollout.
- **PJAN-86 defect classes are regression inputs** (status truthfulness,
  immediate post-deploy audit, deferred gateways, template/gitlink fidelity,
  generated-profile semantics, service stabilization, extension-preserving
  registry writes, safe path/lock behavior, real full-live canary proof). Their
  stored open/closed states are not current truth.
- **Closeout depends on everything else** plus reconciled package version, Git
  tag, commit attribution, green CI, template pins, and owning board evidence.
