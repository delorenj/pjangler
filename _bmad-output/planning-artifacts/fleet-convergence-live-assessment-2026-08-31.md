---
title: Registry-Wide Fleet Convergence Live Assessment
status: product-owner-approved
created: 2026-08-31
updated: 2026-08-31
authority: authoritative-supplement
supersedes:
  - stale n8n-centralized fleet orchestration assumptions
  - old Hermes source-path assumptions
  - per-agent Bloodbank consumer assumptions
  - per-agent checkpoint-timer assumptions
  - registry discovery as activation authority
---

# Registry-Wide Fleet Convergence Live Assessment

## Purpose and authority

This document records the product owner's approved 2026-08-31 live assessment
and planning decisions for the Registry-Wide Fleet Convergence Control Plane.
It is the authoritative supplement to the historical Fleet Control Plane PRD
and architecture. When those historical documents conflict with this
assessment or the current fleet operational contracts, this assessment and the
current contracts win.

The target is not another one-off drift repair. The target is a unified,
registry-wide managed fleet in which `pjangler` can truthfully inspect, plan,
converge, prove, and continuously enforce the complete fleet contract.

## Current product conclusion

The fleet architecture is established, but migration and operational
convergence are incomplete. The system has most of the intended mechanisms:

- a central Hermes agent registry and a PJangler project registry;
- a version-pinned Hermes runtime and tracked PM scaffold;
- generated base-plus-delta named profiles;
- one per-agent messaging gateway and one heartbeat timer as the canonical
  per-agent systemd topology;
- one fleet-shared Bloodbank command gateway;
- project identity, audit, migration, deployment, and release machinery.

Those mechanisms do not yet compose into one registry-wide control loop. There
is no trustworthy global status surface or controller that continuously
reconciles registry records, project bindings, profiles, tracked scaffolds,
systemd units, live processes, Bloodbank eligibility, and closeout evidence.

## Live evidence snapshot

The read-only assessment was refreshed from current files, registries, renderer
output, systemd state, process state, package/release state, and targeted fleet
audits on 2026-08-31.

### Registry and identity

- The PJangler project registry contains 24 projects and `project doctor`
  reports no issues.
- The Hermes registry contains 28 agents across 28 unique project paths.
- Global project identity dry-run checks all 28 agents: 25 resolve a board
  identity and three are intentionally or currently `no-board`.
- Project Registry `agents` projections are mostly empty while the Hermes
  registry owns the operational agent rows. The two registries are correlated
  but do not yet expose one explicit authority and projection contract.
- Duplicate or exceptional relationships can appear valid in isolation; for
  example, separate agents may resolve to the same board without the global
  identity surface treating ownership duplication as a conflict.

### Fleet parity and deployment

- A registry-driven audit sweep completed for all 28 unique project paths with
  no collection errors.
- Zero of 28 project paths were fully green; 16 of 28 passed the separate host
  health aggregate.
- All 25 managed PM scaffolds failed current template parity. PJangler had 18
  stale or missing scaffold files; the ssbnk canary had 26.
- `hermes.fleet-config` passed for 25 applicable paths, showing that shared
  invariants are substantially deployed even while tracked scaffolds drift.
- `hermes.registry-parity` passed 21, failed five, and skipped two paths, but
  its current implementation evaluates only the audited repository rather than
  providing a true registry-wide convergence claim.

### Profiles

- Every registered agent names a profile, but the profile root contains 39
  entries for 28 registered names.
- Eleven entries are not ordinary registered agent profiles; some are
  legitimate shared or specialist profiles and some are debris or historical
  aliases. They require explicit classification, not blind deletion.
- Four observed profile paths are symlinks despite the current real-directory
  profile contract.
- The canonical renderer reported all 38 renderable profiles drifted after a
  shared-base change. This demonstrates that base-plus-delta generation exists
  but fleet fanout is still manual and unenforced.
- Existing repository parity can report profile/runtime checks green while the
  canonical renderer reports semantic drift, so the two checks do not yet form
  one complete health contract.

### Services and processes

- The registry describes 27 gateway-bearing agents, but only 11 had a complete
  installed gateway-plus-heartbeat pair at assessment time.
- Nineteen registered gateways and ten registered heartbeat timers were active;
  additional timers were installed but not all were proven active and healthy.
- The fleet-shared Bloodbank gateway was enabled, active, and stable with zero
  observed restarts.
- No per-agent Bloodbank consumer or checkpoint timer is part of the current
  canonical model; sightings are retired drift.
- Thirty-three isolated Hermes server processes existed outside systemd fleet
  ownership. Eight used profiles outside the agent registry, and some processes
  still used legacy executables instead of the pinned release.
- PJangler's own PM heartbeat was checkpoint-only because reconciliation was
  disabled, and its runtime repository was detached and dirty, preventing its
  checkpoint loop from pushing. A running timer therefore did not prove a
  functioning managed agent.

### Bloodbank activation

- All 28 agent rows had structurally valid fleet-scoped Bloodbank metadata and
  matching target identifiers.
- All 28 had strict `bloodbank.enabled: false` at assessment time. The shared
  gateway was healthy, but there were zero registry-authorized dispatch
  targets.
- Discovery, installation, and a resolvable target are not execution authority.
  Activation must remain explicit, default-deny, and independently auditable.

### CLI, automation, and release evidence

- `pjangler audit --json` can truncate around 8 KiB when stdout is captured by
  a pipe or subprocess because the CLI exits before buffered stdout is fully
  flushed. The same output is complete when directed to a regular file. This
  makes the current automation-facing JSON contract unreliable.
- The existing project-wide audit command and per-repository host-scoped rules
  cannot answer one complete fleet question without an external sweep.
- Package version 1.4.3 is published and the PJAN-86 deploy hardening is largely
  present, but release proof is inconsistent: the corresponding Git tag is
  absent, current CI is not fully green, and the Plane issue remains in
  progress.
- Historical PJAN-86 findings are valuable defect classes and regression
  requirements, but their stored open/closed states are not by themselves
  current truth; live tests and runtime evidence decide closure.

## Authoritative product decisions

1. `pjangler` is the registry-wide fleet control plane. The independent repos
   remain independent; repo fusion is not the solution.
2. The first deliverable is a trustworthy, versioned, parse-safe global fleet
   status/read model. A global mutation controller must not be built on
   incomplete or lossy observations.
3. Project Registry and Hermes Agent Registry retain distinct authority in the
   near term. Their ownership, references, projections, and uniqueness
   invariants must become explicit before any physical registry consolidation
   is considered.
4. Reconciliation is plan-first, dry-run by default, scoped, transactional,
   crash-recoverable, preservation-safe, and resumable. Ambiguous or unmanaged
   state is classified for operator action rather than destroyed.
5. Profile rendering and tracked-scaffold fanout are first-class convergence
   domains. Both must be versioned, observable, idempotent, and covered by the
   global status contract.
6. The canonical PM service model is exactly one per-agent messaging gateway
   plus one heartbeat timer, with one fleet-shared Bloodbank command gateway.
   Per-agent consumers and checkpoint timers are retired.
7. Process ownership is part of fleet health. Unregistered or isolated Hermes
   processes must be inventoried and classified instead of being invisible to
   a systemd-only view.
8. Bloodbank routing activation is a separate explicit authority gate. Neither
   provisioning nor generic reconciliation may infer or auto-enable it.
9. Rollout proceeds through a PJangler and ssbnk canary, then bounded waves.
   Each wave requires direct postcondition evidence before the next begins.
10. Continuous enforcement must publish durable, attributable findings and
    evidence. n8n may consume stable fleet APIs later, but n8n-centralized
    orchestration is not an MVP requirement or a source of truth.
11. Migration closeout includes current tests, live service/process proof,
    registry/profile/scaffold evidence, release consistency, and board state.
    Documentation or a started ticket is not completion.

## Scope boundary

In scope:

- global fleet status and versioned machine/human contracts;
- explicit cross-registry authority and identity invariants;
- plan/apply reconciliation and recovery evidence;
- profile, scaffold, systemd, runtime, process, and Bloodbank convergence;
- managed-exception classification and safe adoption/retirement plans;
- canary and wave rollout;
- recurring enforcement, CI/release gates, and closeout evidence.

Out of scope for the initial epic:

- an immediate physical rewrite or merger of the two registries;
- making n8n a mandatory orchestration dependency or source of truth;
- rewriting Hermes core when PJangler adapters and contracts are sufficient;
- automatically deleting ambiguous profiles, runtimes, processes, or operator
  state;
- automatically enabling Bloodbank targets;
- replacing systemd as the local service manager.
