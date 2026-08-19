# Updated Retention — Adversarial Divergence Review

**Verdict:** NEEDS CHANGES
**Severity counts:** blocker 0 · critical 0 · high 0 · major 3 · minor 0

Scope: corrected SPEC/acceptance/PRD/addendum retention clauses against AD-15–AD-17 and the session-state contract only.

## A1 — Major — Grace-boundary close has no required prune/admission order

- **Team A:** Under `admission.lock`, dedupe, prune an elapsed unreferenced baseline, then admit the new receipt; capture becomes `blocked-missing-baseline`.
- **Team B:** Under the same lock, dedupe, admit the receipt first, then run maintenance; the new reference preserves and uses the already-expired baseline.
- **Divergence:** Both satisfy lines 697 and 709: the close is deduped first, and maintenance prunes only elapsed state that is unreferenced when inspected. They disagree on capture provenance and whether the same close succeeds.
- **Exact fix:** After same-receipt dedupe and before candidate serialization, require SessionEnd to classify `now >= baseline.created_at + receiptless_session_retention_seconds` as ineligible, atomically prune/ignore that unreferenced state, and continue only through missing-baseline behavior. Add a golden equality-boundary fixture.

## A2 — Major — Status/audit have no canonical prospective receipt

- **Team A:** Status/audit serialize a zero-filled fixed-width queued probe; **Team B:** they serialize a maximum-width valid queued probe (timestamps/counters/policy fields differ).
- **Divergence:** Both use the mandated serializer and current on-disk bytes, yet return different `next_receipt_bytes`, `admission_blocked`, reasons, and pressure findings near the byte cap; neither command has a real session candidate.
- **Exact fix:** Normatively define `CaptureReceiptQueuedV1` key order, omitted fields, timestamp precision, newline rule, numeric encoding, and one exact status/audit probe value whose byte length equals every admissible queued receipt; lock it with a golden-byte fixture. Otherwise remove prospective fields from observational output and define a separate conservative predicate.

## A3 — Major — Unmeasurable state has no exact parity-safe output path

- **Team A:** Block admission with a separate state-integrity diagnostic and `reasons=[]`; **Team B:** emit the exact `retention-pressure` text/actions using only the stat-able byte subtotal.
- **Divergence:** Line 699 requires an unmeasurable entry to block, but the exact pressure schema permits only `count-cap|byte-cap` and requires numeric bytes; lines 707/518 do not define code, precedence, fields, or actions for this non-cap refusal. Status, audit, and hook output can therefore disagree while preserving the file.
- **Exact fix:** Add an exact `state-integrity` admission outcome and precedence, nullable/lower-bound byte representation plus unmeasurable-entry count, identical status/audit fields, and exact hook/audit repair actions; reserve `retention-pressure` for an evaluable count/byte predicate. Add corrupt, unreadable, and non-regular fixtures.

## Final recheck

**Verdict:** READY
**Residual severity counts:** blocker 0 · critical 0 · high 0 · major 0 · minor 0

- **A1 — RESOLVED:** AD-15 and the session-state contract now require the exact locked order dedupe → equality-expired baseline prune/ignore → real queued candidate → integrity proof → admission; equality and close/prune race fixtures bind the boundary.
- **A2 — RESOLVED:** `RetentionRefusalV1` records the actual candidate bytes and exact cap reason/actions, is replaced within immutable baseline grace and removed/shadowed after receipt fsync; read-only status/audit consume markers/current totals and explicitly forbid speculative candidates or admission prediction.
- **A3 — RESOLVED:** `state-integrity` now precedes cap evaluation, preserves suspect entries, has nullable/lower-bound schemas plus exact diagnostics/actions, and is covered by corrupt, unreadable, and non-regular parity fixtures.

## Final recheck addendum — RUR-A2 refinement

**Verdict:** READY
**Residual severity counts:** blocker 0 · critical 0 · high 0 · major 0 · minor 0

- **Current pressure — RESOLVED:** Status/audit recompute each marker with exact current usage and current caps plus its stored real `candidate_bytes`; no speculative candidate or global admission prediction remains.
- **Recovered history — RESOLVED:** A now-fitting marker stays only in `active_refusals` as informational `capture-refused-history`, expressly neither finding nor receipt/state; it cannot keep `retention-pressure` active.
- **Integrity/replay — RESOLVED:** `state-integrity` has precedence and suppresses cap findings/markers, while successful replay fsyncs the receipt and removes the marker before spawn; crash-safe dedupe ignores/removes a shadowed marker. Fixtures cover pressure demotion without replay and replay removal.
