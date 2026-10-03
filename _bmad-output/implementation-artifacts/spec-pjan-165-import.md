---
title: 'PJAN-165: Import a repository into a parent project'
type: feature
created: '2026-10-03'
status: in-progress
route: dispatch
baseline_commit: 74200d94e4e4f9c9d6d8dddf1fac4a93d1aff0b8
context: []
independent_review_needed: true
---

<frozen-after-approval reason="intent supplied by the PJAN-165 worker dispatch">

## Intent

`pj import <checkout-or-url>` adopts a repository into the current Git parent as
a submodule. Local and remote inputs share one enrollment transaction. Preserve
the repository's history and local payloads, stable project and provider
identities, and expose the resulting canonical path through the project index.

## Boundaries & Constraints

Implement only PJAN-165 on `PJAN-165-import`. The PM's verified claim is the edit
gate; the worker cannot approve, merge, or mark Done. Live Pilot, the parent
checkout, Flume, Skillex, profiles, executables, services and provider settings
are read-only during this task. Execute imports only in disposable Git
repositories against a disposable PostgreSQL registry.

Local moves preserve tracked changes, the complete child index, ignored and
untracked files, HEAD and origin. Import never commits. Parent enrollment stages
only `.gitmodules` and the gitlink while preserving unrelated parent staging.
Do not invent a parallel project registry or transfer employee authority.
Unsupported relocation capabilities must fail before moving user data and
remain an explicit AC3 gap. No operator sign-off pause or child workers.

## I/O & Edge-Case Matrix

| Scenario | Input / state | Expected behavior |
| --- | --- | --- |
| Local | Dirty standalone checkout with upstream | Move into parent, enroll, preserve all Git state and payload bytes |
| Remote | GitHub shorthand, Git URL, local bare remote | Clone fresh, then use the same enrollment path |
| Preview | `--dry-run` | Explain paths, registry and bindings without filesystem or index writes; remote content inspection remains conditional |
| Identity | Existing canonical manifest | Preserve project ID, board, memory and unknown fields; change canonical repository path only |
| Executables | Symlinks into source in the selected binding home | Retarget px/pilot/px-supervised equivalents; keep executable modes and targets usable |
| Capability gap | Flume employees, services, opaque launchers, active Skillex receipt | Reject before move; identify owner and required contract |
| Collision | Existing unrelated path, gitlink, config or live duplicate ID | Reject without moving source or changing parent |
| Worktree | Linked/multiple worktrees or external Git directory | Reject before mutation |
| Rerun | Exact completed enrollment | No additional writes or identity changes |
| Failure | Registry rejects after move/enrollment | Restore source, bindings and parent Git state; retain recovery receipt if restoration cannot finish |

</frozen-after-approval>

## Code Map

- `src/index.ts`: Commander registration and JSON/human output conventions.
- `src/commands/Command.ts`: command seam; import is an explicit operation, not a subsystem scaffold.
- `src/project/registryClient.ts`: bounded service adapter; production registry stays authoritative.
- `src/project/manifestIndex.ts`: canonical manifest validation and enrollment; missing old location permits relocation.
- `src/project/registryService.ts`: add read-only inspection of index state, since normal GET refreshes manifests and may mutate the index.
- `src/parity/skill-roots.ts`: preserve its nested repository/gitlink safeguards; do not reuse it to erase project activation ownership.
- `docs/skillex-integration.md`: public `readActivationReceipt` can inspect ownership, but no supported scope relocation operation exists in pinned 0.1.2.
- Flume `packages/flume-hr/src/index.ts`, `org/cli.ts`: public hire/onboard/remediate and read-only roster surfaces; no employee relocation plan/execute/rollback contract found. Rehiring is not relocation.
- `scripts/run-tests.mjs`: authoritative suite list; supports name filters and builds current source.

## Tasks & Acceptance

- [x] `tests/pjan-165-import-regressions.mjs`: real CLI tests using Git repositories, a local bare remote and disposable PostgreSQL; capture AC evidence.
- [x] `src/project/import.ts`, `src/commands/ImportProject.ts`: shared plan/execute/rollback transaction, bounded Git argv calls, collisions, convergence, binding checks and structured recovery.
- [x] `src/index.ts`: expose `pj import`, dry-run, destination name, isolated registry and binding-home selection.
- [x] `src/project/manifestIndex.ts`, `src/project/registryService.ts`: read-only index inspection through the existing service.
- [x] `scripts/run-tests.mjs`, `docs/project-registry.md`: register verification and document usable scope and ownership blockers.
- [x] Build generated dist using npm; run required gates and registry/lifecycle regressions; commit explicitly staged task files.

Acceptance maps to the ticket's five criteria, without weakening them:

- AC1: Given dirty/staged/untracked/ignored state, when a local import succeeds, then HEAD, origin, child index and payload bytes survive and the parent contains the exact gitlink.
- AC2: Given a supported URL or bare remote, when imported, then a fresh initialized submodule uses the same enrollment path. Shorthand parsing is verified locally; no fabricated GitHub execution.
- AC3: Given supported project/executable bindings, when imported, then stable IDs and memory values survive and `pj info` resolves the new path. Given employee/service/receipt ownership, then preflight reports the missing relocation capability. Full AC3 remains unproven until the owning APIs support relocation.
- AC4: Given previews, collisions, unsupported worktrees, reruns and an induced failure, then state remains unchanged or rollback/recovery is explicit and tested.
- AC5: Given the built CLI, when the fixture and required regression commands run, then recorded real output substantiates coverage and separates environmental/baseline failures.

## Implementation Notes

The dispatch authorizes ordinary design decisions and overrides BMAD approval
and delegation checkpoints. This worker performs implementation and its own
verification; independent spec and quality gates remain with the supervisor.
Keep an unabsorbed child `.git` directory: this is a supported Git submodule
layout and avoids rewriting dirty child index or origin. Use an alternate parent
index and compare before publication. Same-filesystem rename preserves ignored
payloads. A failed remote import retains its prepared checkout for recovery.

## Verification

`npm ci`; `npm run build`; `npm run typecheck`; focused import, registry and
lifecycle suites; `npm test`; `npm run check:lock`; `npm run check:submodules`;
`npm run check:tracked-secrets`. Store outputs and AC evidence in the worker spool.

## Ownership blockers

The minimum Flume follow-up is a public project relocation capability accepting
stable project ID, old/new paths, returning an identity-preserving binding plan,
and supporting execution and rollback for employee registry, profiles and
services. The minimum Skillex follow-up is public project-scope relocation of
activation links and scopeRoot-keyed ownership receipts while preserving foreign
and copied skills. PJangler must not fabricate either capability.

## Worker verification and remaining acceptance gap

Final `npm test`: 75 steps attempted, 75 passed, zero failures (187.6 seconds).
Focused import/registry/lifecycle run: 6/6 passed. Actual npm build, typecheck,
lock, submodule and tracked-secret gates pass. The import suite records real
Git and disposable PostgreSQL executions, including staged manifest bytes,
ignored/copy payloads, executable link rollback, an existing index row's failed
relocation, fresh file-URL enrollment, and retained remote recovery checkout.
GitHub shorthand was parsed locally; no GitHub import execution is claimed.

AC1 PASS; AC2 PASS; AC3 FAIL; AC4 PASS; AC5 PASS. AC3's supported identity,
index and executable properties pass, but employee/service/activation and
Pilot defaultSchema relocation are not implemented without their owners'
public relocation contracts. `Pilot/src/config.js:31-49` confirms the config
location and defaultSchema/default_schema path resolution. The minimum Pilot
follow-up is a public path-binding relocation adapter preserving unrelated
user configuration. Import refuses those observed bindings before a move.

Worker handback status is BLOCKED, and this spec remains in-progress. No
independent spec/quality gate has run; worker verification approves neither.
