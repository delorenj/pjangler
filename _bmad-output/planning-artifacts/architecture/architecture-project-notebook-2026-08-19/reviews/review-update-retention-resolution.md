# Retention Update Reviewer Resolution

## Gate verdict

READY. The rubric, current-tech/current-code, and adversarial divergence lenses each completed a final recheck with zero unresolved blocker, critical, high, or major findings.

## Dispositions

| Finding | Disposition in `ARCHITECTURE-SPINE.md` | Final evidence |
| --- | --- | --- |
| RUR-1 — receiptless baseline lifecycle | Added finite `receiptless_session_retention_seconds`, immutable grace, exact equality expiry, replay-before-prune, lock serialization, unreferenced-only cleanup, and absolute protection for baselines referenced by unresolved receipts/journals. | Rubric READY, 0 residual. |
| RUR-2 — raw session identity wording | AD-18 and derivative fixtures now require AD-15's lowercase-hex `session_key`; raw client session ID is forbidden in durable provenance. | Rubric READY, 0 residual. |
| A1 — grace-boundary order | SessionEnd order is fixed as same-receipt dedupe → equality-expired baseline prune/ignore → actual queued candidate → integrity proof → admission. | Adversarial READY, 0 residual. |
| A2 — speculative status/audit candidate | Only SessionEnd serializes a real candidate. Cap refusal records bounded `RetentionRefusalV1`; status/audit are read-only and recompute each marker against current exact usage/current caps. A recovered marker remains only informational `capture-refused-history` in `active_refusals`, never a finding/state, until replay or grace cleanup. | Rubric and adversarial READY, 0 residual. |
| A3 — unmeasurable state | `state-integrity` precedes cap evaluation, preserves suspect entries, refuses without receipt/marker/worker/slow work, and shares nullable exact totals, lower bounds, bounded safe entry evidence, and repair/re-run actions across hook/status/audit. | Adversarial READY, 0 residual. |
| Current implementation fit | Shared `NotebookLimitsV1`, `state.ts` lock/accounting, checks/output schemas, marker lifecycle, retry authorization, and rollout fixtures form one implementable seam. | Current-tech/current-code READY, 0 findings. |

## Preserved invariants

- Receipt states remain exactly `queued`, `processing`, `succeeded`, `failed`, `retry-exhausted`, and `blocked-missing-baseline`.
- Only succeeded receipts expire. Unresolved receipts are never automatically deleted, silently compacted, or dismissed.
- A direct retry reuses one existing receipt and authorizes one attempt; an operator-origin failure returns to `retry-exhausted` without an automatic loop. Missing-baseline retry still requires explicit committed `GIT_REF` and retains all pre-dirty/manual-reference limits.
- `retention-pressure`, `state-integrity`, and `capture-refused-history` are diagnostics/observations, never receipt states.
- OverviewDescriptor, baseline-before-Overview, and pre-existing dirty-document identity rules remain unchanged.

## Reviewer artifacts

- `review-update-retention-rubric.md`
- `review-update-retention-current-tech.md`
- `review-update-retention-adversarial.md`
