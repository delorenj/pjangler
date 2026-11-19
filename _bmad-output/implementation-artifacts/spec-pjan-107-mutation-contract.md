---
title: 'PJAN-107 single-PATCH mutation contract regression'
type: 'bugfix'
created: '2026-11-19'
status: 'in-review'
review_loop_iteration: 0
baseline_commit: 'c1c4e0700c3b3bf35e6af633cc19513274e887f3'
context: []
---

<frozen-after-approval reason="dispatched Plane acceptance criteria">
## Intent

**Problem:** A retried Plane transition PATCH without a version guard can overwrite a different actor's change. A 2xx response alone cannot prove the transition persisted.

**Approach:** Pin the canonical Krebs adapter's single-PATCH/read-back contract with a hermetic recording transport and document its rationale in pjangler; do not change the adapter.

## Boundaries & Constraints

**Always:** Resolve the actual adapter using `tests/helpers/tp-adapters.mjs`; stage its bytes under a fixture `.project.json`; contain all network and credentials. Commit and push a candidate for independent review, not integration.

**Ask First:** Changes to the Krebs-owned adapter or live board/runtime are outside this handoff.

**Never:** Reinstate mutation retries; claim concurrency safety, rollout, deployment, or a live PM projection check; touch the shared checkout's dirty files or merge to main.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Normal | 2xx PATCH, matching same-issue readback | `ok <sequence>`, one PATCH | None |
| Unapplied | non-2xx PATCH, unchanged readback, former retry setting >1 | nonzero, no `ok`, one PATCH | Ambiguous/unapplied failure |
| Applied response lost | PATCH applied, transport failure, matching readback | `ok <sequence>`, one PATCH | Readback confirms despite transport error |
| Divergence | 2xx PATCH, different current state | nonzero, no `ok`, one PATCH | Mismatch/concurrent divergence |
| Readback unavailable or unverifiable | failed GET, wrong issue, malformed/missing state or sequence | nonzero, no `ok`, one PATCH | No retry or success |

</frozen-after-approval>

## Code Map
- `tests/helpers/tp-adapters.mjs` resolves canonical Krebs adapter, env override before tree walk.
- `tests/helpers/hermetic-suite.mjs`, `tests/helpers/hermetic-env.mjs` isolate suite/child env; latter must grant the new suite adapter path.
- `scripts/run-tests.mjs` explicitly lists all regression suites.
- Krebs `adapters/tp/plane.sh` `api()` and `transition)` implement one PATCH and exact readback; read-only external dependency.
- `tests/pjan-23-regressions.mjs`, `tests/pjan-50-regressions.mjs` demonstrate staged adapter and recording curl fixture patterns.

## Tasks & Acceptance
**Execution:**
- [x] `tests/pjan-107-mutation-contract.mjs` — exercise actual staged canonical adapter across every matrix row with a recording curl, isolated fixture binding, and exact request count.
- [x] `tests/helpers/hermetic-env.mjs`, `scripts/run-tests.mjs` — grant canonical path only to the suite and register it in the normal regression gate.
- [x] `docs/ticket-provider-mutation-contract.md` — explain single-attempt/readback semantics and boundaries.
- [x] `_bmad-output/implementation-artifacts/issue-evidence/PJAN-107.md` — record real checks and distinguish canonical from installed projection.

**Acceptance Criteria:**
- Given a canonical Krebs Plane adapter and only fixture credentials, when the normal runner executes the new suite, then each matrix scenario checks the requested same-issue outcome and no second PATCH occurs.
- Given the existing provider suites and build/typecheck gates, when the candidate is verified, then their real results and any blockers are recorded without a live board write.

## Spec Change Log

## Verification
**Commands:**
- `node scripts/run-tests.mjs pjan-107 pjan-23 pjan-50` — typecheck, build, adapter suites pass.
- `node scripts/run-tests.mjs check:hermetic-test-env` — suite containment gate passes.
