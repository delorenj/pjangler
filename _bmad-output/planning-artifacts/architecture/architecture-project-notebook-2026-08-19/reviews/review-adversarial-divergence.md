# Adversarial Divergence Review

Lens: two independent epic teams implement only from `ARCHITECTURE-SPINE.md`; both are assumed competent and literal. Findings below identify places where both implementations can plausibly claim compliance yet fail to interoperate or preserve PJAN-77 guarantees.

## 1. Critical — external-tail commit point and ambiguity journal are not bound

Evidence: AD-3 orders Manifest projection before owned postconditions (line 68), the sequence writes `linked` before postcondition audit (lines 534–535), while the failure table says a failed postcondition leaves a `planned` binding (line 555). The spine also requires a durable blocked ambiguous attempt but assigns no owner, schema, or crash-safe transition to that evidence (lines 86, 401, 552).

- **Team A compliant behavior:** writes `linked` to Manifest, then a failed postcondition writes `planned` to Registry; a possibly-dispatched flag held in memory disappears on process death.
- **Team B compliant behavior:** audits candidate IDs before projecting `linked` and writes ambiguous attempts into an XDG journal; retry therefore blocks rather than posting again.
- **Divergence risk:** identical failures yield contradictory Registry/Manifest states, and Team A can duplicate a notebook or note across the crash window the architecture claims to close.
- **Exact binding fix:** define `RemoteMutationJournalV1` at `.../projects/<project-key>/operations/<sha256(kind,logical-marker)>.json` with `prepared -> possibly-dispatched -> reconciled -> committed`. Fsync `possibly-dispatched` before initiating POST; only a transport proof that no bytes were dispatched may reset it. Reconcile candidate IDs, run remote postconditions against the in-memory candidate, atomically project `linked` to Manifest, persist Registry `linked` last, then mark committed. Every earlier failure keeps both bindings `planned` and the journal durable; retry with `possibly-dispatched` may reconcile only.

## 2. High — managed note and session identities are incomplete

Evidence: every PJangler-created note must carry an envelope (line 104), but the only kinds/logical-ID rules are Overview, document, and session capture (lines 411–415) while `add note` is public (line 426). Separately, SessionStart records a baseline before claiming Overview (line 140), yet only the Overview claim is exclusive and duplicate behavior is defined only for that claim (lines 607–609); receipt identity permits either a session hash or raw nonsecret ID (lines 152, 607).

- **Team A compliant behavior:** creates raw manual notes and overwrites the baseline on resume before noticing the existing Overview claim; it hashes client session IDs for receipt IDs.
- **Team B compliant behavior:** overloads `document` for manual notes, preserves the first baseline, and uses raw session IDs in receipt IDs.
- **Divergence risk:** reconciliation cannot classify manual notes consistently, resumed sessions can lose early changes, and the same close event produces different receipt IDs.
- **Exact binding fix:** add envelope kind `manual` with logical ID `manual:v1:<operation-id>`, where one UUID is persisted in the remote-operation journal before add dispatch; managed updates preserve kind/logical ID and unmanaged updates never invent one. Define `session_key = sha256("pjangler-session-v1\\0" + project_slug + "\\0" + client + "\\0" + client_session_id)` using the required nonempty Claude `session_id`. Create the complete baseline record once with exclusive-create and never replace it on resume; derive claim path, receipt ID, and capture logical ID from that same `session_key`. Missing session ID fails open and later closes become `blocked-missing-baseline`.

## 3. High — lossless config and surgical hook ownership lack canonical representations

Evidence: AD-5 promises passthrough and byte-stable unknown values (line 80), but the PG text also extracts unknown project keys into extensions and overlays validated fields (line 383) without path or merge precedence. Hook ownership is an “exact marker” (lines 128, 200), but the marker's JSON/command representation and predicate are absent.

- **Team A compliant behavior:** keeps nested unknowns in `projects.notebook`, rewrites YAML through a CST, and encodes hook ownership in an extra JSON property.
- **Team B compliant behavior:** moves nested unknowns into extension JSONB, serializes YAML anew, and recognizes any command substring containing `project-notebook.v1`.
- **Divergence risk:** backend switching moves/drops keys or comments, while reinstall/uninstall can miss its own hooks, claim a foreign hook, or duplicate delivery; Bloodbank coexistence tests become implementation-specific.
- **Exact binding fix:** bind a path-preserving merge: `projects.notebook` and global `notebook` store their complete subtrees including unknown descendants; extension JSONB stores only unknown sibling keys at its declared level; known relational/owned fields overlay only their exact paths. YAML mutations must preserve untouched CST nodes byte-for-byte; PG tests compare semantic JSON values because JSONB has no byte fidelity. Publish event-specific canonical hook objects and define ownership as an anchored command prefix exactly `PJ_HOOK_OWNER=project-notebook.v1 `; update/uninstall only that predicate, preserve the original foreign arrays in place, and make both project and Bloodbank coexistence fixtures use those canonical objects.

## 4. High — “JSON v1” and deterministic search are envelopes, not interoperable contracts

Evidence: the JSON section specifies only a common envelope with `data: {}` and uses `notebook.state: healthy` despite separately distinguishing persisted binding state from computed health (lines 448–460, 476 onward). Search merely says case-fold, tokenize, and compute “one deterministic lexical score” (line 418). Error numbers are fixed, but precedence for a membership-list transport failure versus absence/cross-project evidence is not.

- **Team A compliant behavior:** returns `data` as an array, emits `state=linked`, uses substring frequency/OR search, and maps an interrupted scoped list to `NOT_FOUND`.
- **Team B compliant behavior:** returns `{items,next_cursor}`, emits `state=healthy`, uses exact-token/AND search, and maps the same interruption to `TIMEOUT`.
- **Divergence risk:** scripts, fixtures, ordering, and isolation behavior disagree even though both teams satisfy the prose and numeric exit table.
- **Exact binding fix:** add per-command `NotebookJsonV1` schemas: list/search data is `{items, next_cursor}` (`next_cursor:null` for v1 search), and notebook is `{binding_state, health, id, name}`. Bind search v1 to NFKC + Unicode lowercase tokenization with `/[\\p{L}\\p{N}]+/gu`, require every distinct query token, score `10 * title exact-token occurrences + body exact-token occurrences`, then apply the existing tie-breakers and take the first body match for the bounded excerpt. A failed/incomplete scoped list always returns its service/protocol error; only a complete scoped list may yield `NOT_FOUND`/`CROSS_PROJECT`.

## Verdict

**READY-WITH-FIXES** — 4 findings: 1 critical, 3 high. No blocker remains if the four exact bindings are incorporated before epic split.

## Final recheck

- **Finding 1 — PASS.** Both teams now share the XDG operation journal, dispatch latch, candidate-audit-before-linked order, Registry-last finalizer, and post-dispatch no-rollback rule. Crash placement no longer changes whether another POST is legal.
- **Finding 2 — NOT-READY (one residual).** `user-note`, its retry selection, exclusive first baseline, raw-session exclusion, and the exact `session_key` formula are bound. However AD-17 defines receipt/capture hashes only as a prefix “plus” `session_key`; Team A can hash direct concatenation while Team B inserts NUL framing, producing incompatible receipt and capture IDs. Bind exact bytes, for example `sha256("pjangler-receipt-v1\\0" + session_key)` and `sha256("pjangler-capture-v1\\0" + session_key)` over UTF-8.
- **Finding 3 — PASS.** Complete notebook subtrees, exact-level extensions, owned-path overlay, YAML CST fidelity versus PG semantic equality, canonical hook objects, and the anchored recognized-wrapper predicate now force the same preservation behavior.
- **Finding 4 — PASS.** Binding state versus health, per-command schemas, complete-list error precedence, normalization/tokenization, AND matching, scoring, excerpt origin, and tie ordering are now fixed.

**NOT-READY** — 3 passes, 1 residual high-severity identity binding, 0 newly discovered scope findings.

**Final addendum — Finding 2 RESOLVED; READY.** AD-17 now fixes lowercase-hex SHA-256 input to the exact UTF-8 `prefix\0 + session_key` bytes for both receipt and capture IDs; all 4 findings pass with 0 residuals.
