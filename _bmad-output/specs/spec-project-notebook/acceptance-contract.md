# Project Notebook Acceptance Contract

Read this file with `SPEC.md`. The adopted PRD addendum carries its technical inputs, and the adopted final Architecture Spine carries the binding implementation rules, diagrams, schemas, state machines, and release gates. This companion preserves the acceptance edges that downstream stories, implementation, and validation must not weaken.

## Traceability

| Capability | PRD coverage | Required outcome |
| --- | --- | --- |
| CAP-1 | UJ-1; FR-1–FR-4 | Deterministic one-to-one binding, truthful init transaction, safe retry and recovery |
| CAP-2 | UJ-1, UJ-3; FR-3, FR-5 | Canonical global/local resolution, typed storage, source-attributed status |
| CAP-3 | UJ-1, UJ-4; FR-5–FR-9, FR-21 | Stable repository-aware CLI and JSON v1 contract |
| CAP-4 | UJ-3; FR-15–FR-17 | Recipe-owned audit and selective preservation-safe migration |
| CAP-5 | UJ-1–UJ-4; FR-18–FR-21 | Bounded runtime integration and cross-project isolation |
| CAP-6 | UJ-2; FR-10 | Single skill source and idempotent master-fanout projection |
| CAP-7 | UJ-2; FR-11 | Once-per-session bounded priming plus trustworthy baseline |
| CAP-8 | UJ-2; FR-12–FR-14 | Non-blocking deduplicated capture, document provenance, factual fallback |

## Architecture-Bound Acceptance

- **Unified external tail:** ProjectRecipe orders ticket-provider, Notebook, then Hermes effects, stops after the first failed or blocked effect, and runs one Registry-only finalizer exactly once as the last mutation. Once `externalDispatchStarted` latches, fresh-target deletion is forbidden and no remote object is auto-deleted.
- **Crash-safe remote mutation:** Every notebook or note create advances a fsynced `RemoteMutationJournalV1` through `prepared`, `possibly-dispatched`, `reconciled`, and `committed`. Only transport proof that no bytes left permits reset; unresolved dispatch reconciles only, zero creates only when safe, one adopts, and many conflicts.
- **Packed skill export:** Skillex `all-skills/project-notebook` is the sole hand-edited source. Build/prepack rejects unsafe files and emits the skill plus `export-manifest.json` and `SHA256SUMS`; runtime verifies source precedence, installs an immutable version-digest payload under XDG data, and replaces only an owned matching global skill link. Packed acceptance runs with the developer Skillex checkout unavailable.
- **Overview proof:** `OverviewDescriptorV1` records project identity, the visible purpose or exact placeholder, ordered contained authoritative references with Git revision and content digest, and compiler policy. SessionStart compares it after baseline creation, emits `PROJECT NOTEBOOK OVERVIEW DRIFT` with bounded paths/reasons before stale-labeled content, and owned live migration updates the same Overview note ID.
- **User-note identity:** Direct add creates `user-note:v1:<operation-id>` from a UUID stored in the prepared journal. An unresolved retry with the same binding, title, and content digest reuses that journal; an identical add after commit is intentionally a distinct user note. Managed updates preserve the embedded envelope; unmarked scoped notes remain unmarked.
- **Exact session identity:** Session key is lowercase-hex SHA-256 over the exact UTF-8 sequence `pjangler-session-v1`, NUL, project slug, NUL, client, NUL, nonempty client session ID. Receipt and capture identities use the architecture's exact prefixed UTF-8 hash inputs with that session key; the raw client session ID is never persisted.
- **Scoped search and JSON:** Search consumes only a complete notebook-scoped list, applies NFKC plus Unicode lowercase tokenization, requires all distinct query tokens, and uses the Architecture Spine's title-weighted score and tie order. Upstream global/vector search is not a v1 fallback. Each command validates its exact JSON-v1 data schema and error precedence; `binding_state` is separate from nullable observed `health`, and stable symbolic outcomes map to exits 0–6.

## Pairing, Initialization, and Recovery

- Repository name supplies the deterministic notebook display name unless an allowed Manifest override is present. Canonical PJangler project identity supplies the binding key; the remote service identifier remains stable across repository renames.
- Two registered repositories cannot claim one remote notebook identifier. A rename is reported as name Drift and never creates a second notebook implicitly.
- Dry-run names binding, configuration, Managed Hook, Overview Note, and Live Action work and changes zero local or remote bytes.
- Live-authorized apply creates or reuses exactly one notebook and one Overview Note, exposes their stable identifiers to the transaction, verifies remote postconditions, then persists the Project Registry.
- Missing configuration, missing authorization, timeout, or service failure leaves an explicit recoverable state and next action; it never reports a healthy binding.
- Re-init and explicit create reconcile existing binding and deterministic remote evidence before creating. Ambiguity returns a conflict instead of guessing.

## Configuration and Status

- Persisted binding states are `disabled`, `planned`, and `linked`. Computed outcomes are `unconfigured`, `healthy`, `drifted`, `unavailable`, and `blocked`.
- The Project Registry owns `notebook_id`, `notebook_name`, `overview_note_id`, and persisted binding state. The Project Manifest mirrors those fields for local inspection and owns repository policy overrides; mirror mismatch is Drift.
- Effective policy precedence is built-in safe defaults, global defaults, Manifest policy, then an explicit option for that invocation. Explicit disable wins for hook behavior.
- Effective global policy includes finite positive succeeded-receipt retention days, receiptless-session grace seconds, unresolved-receipt count and byte caps, and the per-receipt byte ceiling; concrete defaults remain centralized noncontractual limits.
- YAML Registry, its `PJ_PROJECT_REGISTRY` path override, and PostgreSQL RegistryStore all round-trip binding fields through additive migration and preserve unknown fields.
- Credential values are rejected from both configuration surfaces. Environment variable names and secret references may be stored, but effective-config output never exposes the resolved value.
- `status --local-only` makes no remote call. Status reports repository identity, binding outcome, retryability, unresolved receipt summary, and a safe next action.
- Status exposes the shared `CaptureAdmissionSummaryV1`: unresolved count and bytes are exact integers only when fully provable and otherwise `null`, with numeric lower bounds, an unmeasurable-entry count, bounded safe integrity evidence, both caps, receiptless-session counts, and active refusal markers. It never synthesizes candidate bytes or a repository-wide admission boolean.
- Status emits `retention-pressure` only when exact current usage is itself at or over a cap, or when current exact usage plus an active marker's recorded real candidate still fails either prospective gate. A now-fitting marker remains visible only in `active_refusals` with informational outcome `capture-refused-history`; retention pressure is neither a receipt state nor historical inference.
- Running outside a registered repository returns a configuration outcome with a corrective next action instead of guessing a target.

## CLI and Machine Contract

- The command families and option grammar are fixed in the adopted addendum: status, create, note list/add/get/update/delete, search, overview, capture list/retry, audit, migrate, and internal hook/worker entrypoints.
- A new notebook receives one Overview Note containing project identity, a purpose placeholder, and links to authoritative repository documents. Overview replacement updates in place and preserves its note identifier.
- Note create returns a stable identifier. Get, update, and delete require it and reject membership that cannot be proven against the current Companion Notebook. Update preserves identity and reports service-supplied revision metadata; generic deletion rejects the designated Overview Note.
- List ordering and pagination are deterministic. Interactive deletion requires confirmation; non-interactive deletion requires an explicit confirmation flag.
- Search treats empty results as success, returns bounded excerpts and available ordering metadata, and never returns an object from another notebook even when upstream search is global.
- JSON stdout has schema version 1 and contains no ANSI or progress prose. Human progress and bounded diagnostics use stderr in JSON mode.
- Symbolic outcomes distinguish invalid input, not configured, authentication failure, not found, conflict, throttling, timeout, service unavailable, malformed remote protocol, cross-project access, and Drift. Hooks convert integration failures to fail-open outcomes; explicit commands return categorized nonzero failures.
- Additive fields and commands are backward-compatible minor changes. Removing or changing documented fields, meanings, or exit categories requires a major version or compatibility shim; a deprecated form remains functional for at least one minor release.

## Audit and Migration

- Project Notebook checks belong to its recipe and participate in `pj notebook audit`, ordinary `pj audit`, and final init audit.
- Findings use PJangler pass, fail, warn, and skip semantics, state fixability, and cover effective configuration, binding identity and state, remote notebook identity and name, Overview Note, skill availability, Managed Hook projection, and unresolved captures.
- Audit uses the same read-only admission summary, nullable exact totals, numeric lower bounds, active/stale receiptless evidence, and current-predicate `retention-pressure` rule as status. `state-integrity` takes precedence whenever exact admission proof is unavailable; a now-fitting refusal marker is informational `capture-refused-history`, not a finding.
- Local-only audit marks remote checks `skip`, never `pass`.
- Migration defaults to a no-write plan, identifies selected public rule IDs and proposed state transitions, separates local work from Live Actions, and never invokes migrate-all or another recipe.
- Ambiguous or destructive remote work blocks. Applied migration preserves unrelated Manifest, Registry, hook, and service content; it verifies postconditions before reporting success.
- A failed migration retains truthful recoverable state. A successful migration followed by audit has no fixable owned finding, and the second identical migration is a local and remote no-op.

## Managed Hooks and Session Priming

- One canonical global Project Notebook skill supplies all client projections. Fanout preserves foreign records, ordering constraints, conditions, comments, and additional keys; repeating projection produces no duplicate and zero changed bytes.
- A hook acts only when the current repository has an enabled binding. Mutable markers, baselines, and receipts live under the platform state directory with restrictive permissions, atomic writes, bounded retention, and no document bodies or credentials.
- MVP requires Claude Code true `SessionStart` and `SessionEnd`. Another client is supported only after its adapter proves equivalent boundaries; Codex turn-level `Stop` is not session close.
- Supported session start atomically records canonical repository, exact session identity, HEAD, bounded tracked-document working-tree status, and per-file content digests before any Overview decision. It does so even when retrieval is disabled or fails, and resume never overwrites that baseline.
- Overview output is clearly labeled Notebook Service context, remains separate from Hindsight, respects its character ceiling, and emits at most once per session.
- Missing binding, Overview Note, authorization, service availability, or valid response produces only a bounded diagnostic and never prevents the agent session from starting.
- Every Overview write records the ordered contained authoritative references it includes and each reference's revision or content identity. After baseline, start recomputes those identities; any mismatch emits `PROJECT NOTEBOOK OVERVIEW DRIFT`, labels stored context stale, and supplies the exact audit/migrate action. Audit detects the same mismatch and authorized migration repairs the same note ID.

## Session Capture and Document Policy

- Under one bounded per-project lock, true session close validates identity and orders same-receipt deduplication, exact receiptless-baseline expiry and eligible cleanup, serialization of the actual canonical queued candidate, state-integrity proof, then prospective count and byte admission.
- The real `candidate_bytes` is the exact UTF-8 byte length of the canonical queued-receipt JSON plus one trailing line feed. Admission requires both `current_unresolved_count + 1 <= max_count` and `current_unresolved_bytes + candidate_bytes <= max_bytes`; succeeded receipts are excluded from both unresolved measures.
- An actual cap refusal creates or replaces one bounded `RetentionRefusalV1` under the exact lowercase-hex hashed `session_key`. It records the refusal-time reason (`count-cap`, `byte-cap`, or `both`), exact current usage, the real candidate bytes, current caps, and exact list/retry actions, but creates no receipt or worker and performs no slow capture work. Close says the session was not captured and fails open within budget.
- If any entry prevents exact count or byte proof, `state-integrity` takes precedence over cap evaluation: suspect entries are preserved, no refusal marker, receipt, worker, or slow work is created, and the hook fails open with bounded repair guidance. Hook, status, and audit expose the same `null` exact totals, numeric lower bounds, unmeasurable count, and safe relative or digested entry evidence without bodies or absolute paths.
- Receiptless baseline, claim, and refusal state shares one finite grace measured from immutable baseline `created_at`; replacing a marker never extends it. Replay is eligible strictly before `created_at + receiptless_session_retention_seconds`; equality is expired. Only elapsed state with no receipt or journal reference is cleanup-eligible, and read-only status/audit reports rather than prunes it.
- A repeated close within grace replays from the unchanged baseline and reserializes the actual candidate. Continued refusal replaces the marker; successful exclusive receipt creation removes it before worker spawn, and crash recovery ignores or removes any marker shadowed by that receipt. A close after eligible baseline cleanup follows normal missing-baseline behavior rather than inferring provenance.
- Repeated close delivery yields at most one logical Session Capture. Without a trustworthy start baseline, automatic document upload is `blocked-missing-baseline`; a direct retry requires an explicit Git reference rather than inferring one.
- Eligible Documents derive from the recorded HEAD, tracked-document start status, per-file start identities, end identities, and policy—not modification time. A document dirty before start is synchronized only if its end identity proves an additional in-session change; unchanged pre-session dirt is excluded from session attribution.
- Manual `--baseline GIT_REF` recovery proves only committed-reference comparison. It never invents a pre-existing uncommitted start identity; unknown paths are excluded observably, and the same receipt remains `blocked-missing-baseline` if no trustworthy session evidence remains.
- Each synchronized derivative records canonical repository identity, repository-relative path, source revision or content digest, the exact lowercase-hex hashed `session_key`, capture time, and policy version; the raw client session ID is never persisted. Unchanged content is a no-op; changed content updates the same derivative identity.
- The optional low-cost summarizer receives only bounded, redacted, eligible evidence. The summary separates observed changes, verification performed, and unresolved work and never claims deployment or success without evidence.
- Deterministic fallback lists changed eligible documents, other changed path names, verification evidence, observable unresolved work, and an explicit insufficiency statement when evidence is weak.
- Receipt states are exactly `queued`, `processing`, `succeeded`, `failed`, `retry-exhausted`, and `blocked-missing-baseline`; retention pressure is not a state. Automatic retry is finite. One operator-authorized direct retry invocation on one `failed` or `retry-exhausted` receipt compare-and-swaps that same receipt and runs exactly one further attempt; failure returns it to `retry-exhausted` without creating another receipt or automatic loop.
- Succeeded receipts age out under finite configured retention. Unresolved receipts remain visible until recovered and are never automatically deleted or silently compacted. V1 exposes `capture list` and `capture retry`, not dismissal.

## Verification and World-Change Evidence

- Run generated-project and fake-service evidence for zero-write planning, fresh live apply, ambiguous create retry, both Registry backends, preservation of unknown fields, and no production dependency.
- Exercise CRUD and search success, empty results, pagination, every categorized failure, JSON purity, confirmation, foreign note IDs, and contaminated global search.
- Exercise supported and unsupported clients, once-only Overview, exact descriptor match/drift, baseline-before-Overview order, unchanged and additionally changed pre-dirty documents, manual committed-reference limits, timeout, duplicate close, missing baseline, worker restart, deterministic fallback, eligibility exclusions, and one operator-authorized same-receipt retry.
- Exercise both prospective caps with the exact real serialized candidate, `RetentionRefusalV1` replacement and hashed identity, pre-boundary replay, equality expiry, referenced-baseline protection, actual-candidate admission and marker removal, bounded not-captured output, exact list/retry actions, and foreground p95 budgets. Inject unreadable, invalid, and non-regular state to prove state-integrity precedence, preservation, nullable exact totals, lower-bound evidence, and no false pressure marker; prove read-only status/audit distinguish current-predicate `retention-pressure` from now-fitting informational `capture-refused-history`.
- Exercise credential-shaped fixtures, malicious remote payloads, traversal and symlink escape, oversized input and response, redaction, and cross-project isolation.
- In a healthy environment, the generated-project flow must reach one healthy binding in under two minutes. Contract fixtures pass 100%; retries and migration create zero duplicate logical outcomes; injected hook failures leave sessions usable; scans find zero credential disclosure and zero cross-project results.
- Across at least 20 staged captures, every eligible derivative has complete provenance, at least 95% of factual summary claims trace to diff or verification evidence, and no unsupported deployment or success claim appears.
- Do not optimize note count, prompt size, local green status without remote proof, or cosmetic summary freshness. Those are explicit counter-signals, not success.
