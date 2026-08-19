# Current-Tech / Current-Code Retention Update Review

## Verdict

**READY.** The updated receipt-retention, admission, and retry design is implementation-fit against corrected `SPEC.md`, `acceptance-contract.md`, and the finalized PRD/addendum retention clauses.

## Severity Counts

- Blocker: 0
- Critical: 0
- High: 0
- Major: 0
- Minor: 0

## Findings

None.

## Fit Confirmed

- **Shared limits / exact admission:** `Stack > Limits`, `Registry and Manifest contract`, and `Session baseline, receipt, and worker state` use one finite `NotebookLimitsV1`, a per-project admission lock, dedupe-before-accounting, the canonical queued serializer, and exact on-disk unresolved bytes.
- **Refusal / receiptless lifecycle / audit purity:** AD-15–AD-16 and the session-state section create no receipt or worker and invoke no slow port on refusal; preserve the baseline through immutable `created_at + receiptless_session_retention_seconds`; and keep status/audit observational while hook maintenance or selected migration alone prunes eligible unreferenced state.
- **State, expiry, preservation, retry:** AD-16–AD-17 define exactly six states, succeeded-only expiry, indefinite unresolved/corrupt-evidence preservation, and one CAS-authorized same-receipt direct attempt with no hidden automatic loop.
- **Identity / baseline / proof:** AD-15, AD-17–AD-18 specify lowercase-hex SHA-256 identities over exact prefixed UTF-8/NUL inputs, never persist raw client session ID, require the explicit recorded baseline, and constrain manual recovery to a validated committed Git ref.
- **Tests / rollout:** `Verification strategy and release gates` and rollout steps 5–6 cover lock races, exact byte boundaries, refusal before creation, no slow work, replay/prune concurrency, audit parity, six states, same-receipt retry, succeeded-only expiry, unresolved preservation, and both-cap recovery before enablement.

## Final Recheck — Adversarial Fixes

**Verdict: READY.**
**Residual counts:** Blocker 0 · Critical 0 · High 0 · Major 0 · Minor 0

- **Locked order:** AD-15 and SessionEnd now bind dedupe → equality-expired unreferenced-state prune/ignore → real queued serialization → integrity proof → prospective admission under one project lock.
- **Refusal lifecycle:** `RetentionRefusalV1` stores the real candidate byte count and exact actions, replaces without extending baseline grace, and is removed after receipt fsync or ignored/removed when shadowed by dedupe.
- **Read purity:** Status/audit never synthesize candidates or mutate state; they recompute each marker against current exact usage/current caps and demote a now-fitting marker to non-finding `capture-refused-history`.
- **Integrity path:** `state-integrity` precedes cap evaluation, suppresses pressure/marker/receipt/worker/slow work, preserves suspect entries, and shares nullable/lower-bound schemas plus exact repair actions across hook/status/audit.
- **Implementation fit:** `types.ts`, `state.ts`, `checks.ts`, `output.ts`, and shared `NotebookLimitsV1` provide one implementable seam; golden/race fixtures and rollout step 5 lock ordering, marker lifecycle, parity, and integrity behavior before SessionEnd enablement.
