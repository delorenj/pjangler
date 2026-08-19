# Updated Retention Semantics — Rubric Review

**Verdict:** NEEDS CHANGES

**Severity counts:** blocker 0 · critical 0 · major 2 · medium 0 · low 0

The amended receipt/admission/retry rules otherwise cover the corrected canonical contract: dismissal is deferred, only succeeded receipts expire, unresolved receipts are preserved, same-session dedupe precedes prospective count/byte accounting, pressure refusal is pre-create/fail-open/no-slow-work, `retention-pressure` is computed rather than a seventh state, status/audit share the rule, direct retry reuses one receipt, and missing-baseline recovery requires an explicit committed ref.

## Findings

### RUR-1 — Major — Refused captures leave receiptless baselines with no bounded lifecycle

- **Spine:** AD-15 and SessionEnd admission, especially lines 140 and 696–706; cleanup rule at line 741.
- **Canonical clause:** `acceptance-contract.md` lines 75 and 84–85 require mutable baselines/receipts to have bounded retention and cap refusal to create no receipt; `addendum.md` lines 197 and 205 require bounded state while preserving unresolved receipt evidence.
- **Problem:** A pressure-refused close intentionally creates no receipt and leaves its SessionStart baseline intact. Line 741 permits baseline/claim pruning only after a referenced `succeeded` receipt expires. Therefore a refused session's baseline can never reach the only documented cleanup path. Repeated refusals can grow `sessions/` and `claims/` without either receipt admission accounting or finite retention, contradicting the spine's bounded-state/NFR-4 claim. This does not justify deleting any unresolved receipt; the leak is receiptless session state.
- **Actionable fix:** Bind a separate finite lifecycle for session baselines/claims that have no receipt, with an explicit grace/replay rule and a fixture. Preserve every baseline referenced by an unresolved receipt; allow pruning only an unreferenced receiptless baseline/claim after its independent bounded window. Add refusal/replay/cleanup tests and include this state in `notebook.capture-receipts` integrity reporting (or assign it to another named existing check).

### RUR-2 — Major — AD-18 permits raw `session ID` provenance despite the canonical hashed identity rule

- **Spine:** AD-18 line 158 says each derivative records `session ID`; AD-15 line 140, the note envelope section, and receipt schema line 735 instead bind `session_key` and forbid persisting the raw client session ID.
- **Canonical clause:** `acceptance-contract.md` line 27 requires the exact hashed session identity and says the raw client session ID is never persisted; CAP-8 provenance must use that identity.
- **Problem:** Two compliant implementations can now choose incompatible and privacy-different provenance: raw client `session_id` from AD-18 or the lowercase-hex `session_key` required everywhere else. Because AD-18 is itself an adopted Rule, later prose does not safely disambiguate it.
- **Actionable fix:** Amend AD-18 in place to require the AD-15 `session_key` (or explicitly named stable hashed session identity) and state `never the raw client session ID`; use the same field name in derivative envelopes and CAP-8 fixtures.

## Final recheck

**Final verdict:** NEEDS CHANGES

**Residual severity counts:** blocker 0 · critical 0 · major 1 · medium 0 · low 0

- **RUR-1 — RESOLVED.** AD-16 and the session-state contract now bind finite positive `receiptless_session_retention_seconds`, immutable-baseline grace, equality expiry, replay before grace, prune/reference protection, refusal-marker replacement/removal, and side-effect-free status/audit reporting. The audit inventory and hook/capture/rollout fixtures cover stale sets, replay/prune races, and integrity parity without expiring or dismissing an unresolved receipt.
- **RUR-2 — RESOLVED.** AD-18 now requires AD-15's lowercase-hex `session_key` and expressly forbids derivative persistence of the raw client session ID; envelope and capture fixtures use the same field.
- **A1 — RESOLVED.** The locked order is now dedupe → equality-expired receiptless prune/ignore → actual candidate → integrity proof → prospective admission, with equality and concurrency fixtures.
- **A2 — REOPENED AS MAJOR.** The marker-based fix removes speculative candidates from status/audit, but lines 518 and 713 emit `retention-pressure` for any active unexpired `RetentionRefusalV1`, while line 711 says that marker is only an observed past refusal and is not persisted truth that pressure still exists. After recovery lowers current usage enough for the stored real candidate to pass, the marker can remain until replay or grace expiry, so status/audit can still report pressure from stale refusal-time evidence. That conflicts with the canonical current-condition semantics in `acceptance-contract.md` lines 48, 66, and 84–85 and makes "admission resumed" disagree with the reported finding. Keep status/audit pure, but compute marker-backed pressure from **current exact usage + that marker's actual `candidate_bytes`**; when it now passes, suppress `retention-pressure` while retaining the marker as bounded uncaptured-session history (under a separately named informational outcome if operator visibility is required). Bind current rather than refusal-time usage in the finding and add recovery-below-cap-without-close-replay parity fixtures.
- **A3 — RESOLVED.** `state-integrity` now has precedence, exact nullable/lower-bound fields, safe entry evidence/actions, preserved suspect state, no receipt/refusal marker/slow work, and identical hook/status/audit fixtures.

No other blocker/critical/high/major rubric gap was found in the A1–A3 amendments.

### Final A2 addendum

**Disposition:** RESOLVED

**Verdict:** READY

**Residual severity counts:** blocker 0 · critical 0 · major 0 · medium 0 · low 0

Lines 518 and 713 now require read-only status/audit to recompute each marker's prospective result from current exact unresolved usage, current caps, and that marker's recorded real `candidate_bytes`. A marker whose candidate now fits is reported as `capture-not-recorded`, not `retention-pressure`; the marker remains bounded uncaptured-session history and is not treated as a receipt state. The audit inventory binds the same distinction, and the capture/restart matrix plus release criteria explicitly require recovery below both caps without close replay to demote pressure immediately. Reopened A2 is closed with no residual rubric finding.

**Final terminology recheck — READY (0 residual):** status/audit pressure is current-predicate-only; a recovered marker remains solely an `active_refusals` entry with non-finding/non-state outcome `capture-refused-history`, and the recovery-without-replay fixture requires later replay to admit the receipt and remove the marker.
