# Project Notebook PRD Addendum

This addendum preserves technical mechanisms and options that inform architecture and stories without turning the PRD into a solution design. The PRD remains authoritative for product scope and behavior.

## 1. Brownfield Integration Shape

- Implement one lifecycle-owning Project Notebook Module behind PJangler's singleton recipe registry.
- Keep `src/index.ts`, future MCP handlers, and Managed Hook entrypoints as thin adapters to the same module API.
- Compose Project Notebook into project initialization through a truthful recipe dependency. Extend the side-effect-free project Plan so dry-run shows notebook work before dependency execution.
- Keep Project Notebook checks with their owning recipe. `pj notebook audit` filters to that recipe; `pj notebook migrate` selects only its public rule identifiers and never calls global migrate-all.
- Extend Project Record and Project Manifest projections deliberately. Current planning reconstructs known fields, so an untyped notebook key would be dropped during sync.
- Round-trip Notebook Binding fields in both MVP Project Registry implementations: YAML (including `PJ_PROJECT_REGISTRY` path overrides) and the existing PostgreSQL RegistryStore projection. Each uses an additive schema migration and preserves unknown fields.

## 2. Proposed Configuration Contract

The exact field names may be refined by architecture, but the ownership and precedence are load-bearing.

### 2.1 Global Project Registry

```yaml
schema_version: 1
notebook:
  base_url: https://automation-reachable-notebook-host.example
  auth:
    mode: environment
    env_var: OPEN_NOTEBOOK_PASSWORD
  defaults:
    enabled: true
    overview_max_chars: 4000
    session_start_enabled: true
    session_capture_enabled: true
    documentation_globs:
      - "**/*.md"
      - "**/*.mdx"
projects:
  example:
    notebook:
      state: linked
      notebook_id: stable-service-id
      notebook_name: example
      overview_note_id: stable-note-id
```

The registry may contain secret *references* or environment variable names, never secret values. `base_url` has no built-in v1 default because the verified public URL is protected by interactive identity middleware and is not suitable for unattended hooks.

The effective resolved policy also includes finite positive `receipt_succeeded_retention_days`, `unresolved_receipt_max_count`, and `unresolved_receipt_max_bytes` limits. Concrete defaults are noncontractual and must be centralized with the other versioned limits rather than selected independently by hooks, workers, or CLI adapters.

### 2.2 Project Manifest

```json
{
  "notebook": {
    "binding": {
      "state": "linked",
      "notebook_id": "stable-service-id",
      "notebook_name": "example",
      "overview_note_id": "stable-note-id"
    },
    "policy": {
      "enabled": true,
      "session_start_enabled": true,
      "session_capture_enabled": true,
      "overview_max_chars": 4000,
      "documentation_globs": ["**/*.md", "**/*.mdx"]
    }
  }
}
```

The Project Registry owns `notebook_id`, `notebook_name`, `overview_note_id`, and persisted binding `state`. The Project Manifest `binding` object is a read-only projection for local inspection; a mismatch is Drift and migration projects from the Registry. The Manifest `policy` object owns repository overrides. It stores no credential or derived service URL. Effective policy precedence is: built-in safe defaults → global defaults → Project Manifest policy → explicit CLI option for that invocation. An explicit disable always wins for hook behavior.

## 3. Binding Lifecycle

Persisted Notebook Binding states are `disabled`, `planned`, and `linked`. Status computes the wider observed outcome set:

```text
unconfigured -> planned -> linked -> healthy
                    |         |        |
                    v         v        v
                  blocked   drifted  unavailable
disabled
```

- `disabled`: persisted opt-out for this repository.
- `unconfigured`: computed outcome when no effective Notebook Service configuration exists.
- `planned`: desired local identity exists; remote creation/linking has not completed.
- `linked`: stable Companion Notebook identifier is persisted; full health has not been verified.
- `healthy`: computed outcome when local and authorized remote postconditions hold.
- `drifted`: computed outcome when owned state differs but is fixable.
- `unavailable`: computed outcome when remote health cannot be established; this is not healthy.
- `blocked`: computed outcome when ambiguity, unsafe operation, or a missing recovery input prevents migration or capture.

Repository name is a deterministic display-name input, not immutable identity. The binding key should derive from canonical PJangler project identity. The remote notebook identifier remains stable through a repository rename; audit reports the display-name mismatch and migration can rename it.

## 4. Proposed CLI Grammar

```text
pj notebook status [repo] [--local-only] [--json]
pj notebook create [repo] --live [--json]
pj notebook list notes [repo] [--limit N] [--cursor VALUE] [--json]
pj notebook add note [repo] --title TEXT (--text TEXT | --file PATH) [--json]
pj notebook get note NOTE_ID [repo] [--json]
pj notebook update note NOTE_ID [repo] [--title TEXT] (--text TEXT | --file PATH) [--json]
pj notebook delete note NOTE_ID [repo] [--yes] [--json]
pj notebook search notes QUERY [repo] [--limit N] [--json]
pj notebook overview [repo] [--set-file PATH] [--json]
pj notebook capture list [repo] [--state VALUE] [--json]
pj notebook capture retry RECEIPT_ID [repo] [--baseline GIT_REF] [--json]
pj notebook audit [repo] [--local-only] [--json]
pj notebook migrate [repo] [--apply] [--live] [--json]
```

Managed Hook entrypoints should be treated as internal compatibility surfaces, for example:

```text
pj notebook hook session-start --payload-file PATH
pj notebook hook session-close --payload-file PATH
pj notebook worker capture --receipt-id ID
```

Payload content should normally arrive on stdin or through a permission-restricted state file rather than command-line arguments that may be visible in process listings.

Remote authorization follows PRD §8.1. Reads are authorized by explicit invocation, direct mutations by the specific command, composite create/init/migrate mutations by `--live`, and Managed Hooks by durable Project Manifest policy.

The v1 Capture Receipt recovery surface is intentionally limited to `capture list` and `capture retry`. There is no dismissal command or hidden dismissal transition; adding one requires separate future UX and safety design.

## 5. JSON Envelope and Exit Categories

Representative envelope:

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "notebook.notes.list",
  "project": {
    "slug": "example",
    "repo_path": "/canonical/path"
  },
  "notebook": {
    "state": "healthy",
    "id": "stable-service-id",
    "name": "example"
  },
  "data": {},
  "error": null,
  "next_actions": []
}
```

Suggested error codes are `INVALID_INPUT`, `NOT_CONFIGURED`, `AUTHENTICATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `TIMEOUT`, `SERVICE_UNAVAILABLE`, `REMOTE_PROTOCOL_ERROR`, `CROSS_PROJECT`, and `DRIFT_DETECTED`. Architecture should align numeric exits with existing PJangler conventions; JSON consumers depend on symbolic codes rather than shell numbers.

Empty list or search results are successful `data` values. JSON goes to stdout. Human progress and bounded diagnostics go to stderr when `--json` is active.

## 6. Notebook Service Adapter

- Hide Open Notebook-specific payloads behind a typed domain interface: find/create notebook, get/update notebook metadata, list/create/read/update/delete note, search, and health/auth status.
- Normalize response validation and error categories at the adapter boundary.
- Use finite connect and overall timeouts, response-size limits, and explicit abort support.
- Retry reads and proven-idempotent writes only. A create retry first searches deterministic metadata and existing binding evidence because the upstream service does not provide a caller-controlled idempotency key.
- Treat upstream search as untrusted global output. Validate each result's notebook ownership; if ownership cannot be proven, omit it and return a protocol/isolation diagnostic rather than leaking it.
- Address the Overview Note by stable note identifier. Do not rely on title search after binding.
- At each Overview write, `OverviewDescriptorV1` records the ordered contained authoritative document references plus their revision or content digest. The `notebook.overview-note` check compares a descriptor recomputed after the SessionStart baseline, emits `PROJECT NOTEBOOK OVERVIEW DRIFT` on mismatch, and repairs the same note identifier during authorized migration.
- Preserve source provenance on synchronized derivatives: canonical repository identity, repository-relative path, source revision/content digest, session identity, capture time, and policy version.

The currently verified local deployment is Open Notebook v1.14.0. Notes CRUD exists, password authentication is disabled, and search does not accept a notebook filter. Those facts are reconnaissance, not a permanent version pin; adapter contract tests are the durable gate.

## 7. Managed Hook and Session Capture Flow

```text
true session start
  -> resolve canonical repository
  -> resolve enabled Notebook Binding
  -> atomically record session identity and HEAD
  -> before any Overview decision, record bounded tracked-document working-tree status and per-file content digests
  -> check once-per-session marker
  -> recompute OverviewDescriptorV1 and label PROJECT NOTEBOOK OVERVIEW DRIFT on mismatch
  -> fetch Overview Note with short timeout and size bound
  -> emit bounded context or fail-open diagnostic

true session close
  -> resolve repository and session identity
  -> deduplicate any existing receipt for this session identity
  -> measure the prospective unresolved receipt count and bytes against configured admission caps
  -> if either cap prevents admission, state that this session was not captured, emit bounded retention-pressure finding with exact list/retry recovery action, and return without creating a receipt
  -> otherwise atomically write capture receipt outside repository
  -> return within foreground budget
  -> detached worker loads baseline HEAD/status/digests and end revision/status/digests
  -> identify Eligible Documents from version-control diff
  -> exclude ignored/generated/binary/oversized/secret-like inputs
  -> build factual summary with configured low-cost LLM or deterministic fallback
  -> upsert Eligible Document derivatives by path plus content digest
  -> append/upsert one Session Capture by session identity
  -> record bounded receipt/outcome for status and retry
```

Mutable hook state belongs under the platform state directory (for example, an XDG state root), never in the repository. State files need restrictive permissions, atomic writes, bounded retention or admission as appropriate, and no raw credential. Succeeded receipts age out under policy; unresolved state is bounded by refusing new automatic capture at configured count or byte caps, not by deleting recovery evidence. Before any Overview decision, the session baseline records HEAD plus bounded tracked-document working-tree status and per-file content digests. Close compares against that captured state, so unchanged pre-existing dirty documentation is not attributed to the session; modification time is not a reliable boundary.

Manual `--baseline GIT_REF` recovery can establish only a committed-reference comparison. It must not infer the start state of pre-existing uncommitted content. A path with an unknown uncommitted start identity is excluded with an observable reason rather than uploaded under false session provenance; if no trustworthy session evidence remains, the receipt stays `blocked-missing-baseline`.

Capture Receipt states are `queued`, `processing`, `succeeded`, `failed`, `retry-exhausted`, and `blocked-missing-baseline`. Automatic retry is bounded (initial attempt plus a configurable finite retry count) and ends at `retry-exhausted`. After operator correction, one direct `pj notebook capture retry` invocation authorizes one additional attempt on the same `failed` or `retry-exhausted` receipt; a failed attempt returns to `retry-exhausted` without creating a second receipt or starting an automatic retry loop. Retrying `blocked-missing-baseline` additionally requires an explicit Git reference.

Succeeded receipts expire after a bounded configured retention window. Unresolved receipts remain visible until recovered and are never automatically deleted or silently compacted.

Before creating a receipt for a new session, SessionEnd admits it only when the resulting unresolved receipt count and bytes remain within both configured caps. A refused admission occurs before receipt creation, remains fail-open, states that the current session was not captured, and emits a bounded operator-visible retention-pressure diagnostic/finding containing current usage, both caps, and the exact `pj notebook capture list` plus `pj notebook capture retry` recovery next action. Admission resumes only after recovery brings both measures below their caps. Retention pressure is not a Capture Receipt state. Receipt dismissal is deferred from v1 pending separate UX and safety design.

Agent client adapters may map different event names into the two semantic boundaries. A turn-level `Stop` event is not equivalent to session close. Unsupported clients should skip with a clear audit finding.

## 8. Summary and Document Policy

The low-cost summarizer is configurable and optional at runtime. It receives only bounded, policy-eligible diff or transcript metadata after secret filtering. The deterministic fallback should list:

1. changed Eligible Documents,
2. other changed paths as names only,
3. verification commands or evidence present in the session payload,
4. unresolved or uncommitted work that can be observed,
5. an explicit statement when evidence is insufficient.

Eligible Document derivatives update in place by repository-relative path and content identity. Session Capture summaries are append-only by unique session identity. Neither operation changes the source repository document.

## 9. Verification Matrix

- Side-effect-free Plan: isolated repository and fake service receive zero writes.
- Fresh live Apply: exactly one Companion Notebook and Overview Note, registry persisted last, final Project Notebook audit passes.
- Re-init and create retry: no duplicate remote or local state, including ambiguous timeout fixtures.
- Configuration: global/local precedence, explicit disable, unknown-key preservation, supported registry backend round-trip, no secret values.
- CRUD/search: success, empty result, pagination, foreign note ID, global-search contamination, JSON purity, confirmation, and every error category.
- Managed Hooks: supported/unsupported clients, once-per-session overview, absent overview, OverviewDescriptorV1 match/drift, baseline-before-overview ordering, pre-dirty Eligible Document unchanged/changed fixtures, manual committed-ref recovery limits, timeout, foreground budgets, duplicate close, worker restart, deterministic fallback, eligibility exclusions, no repo state files, failed/retry-exhausted explicit retry transitions, both unresolved-receipt caps, refusal before receipt creation, bounded retention-pressure output, exact list/retry recovery action, and resumed admission only below both caps.
- Audit/migrate: local-only skips, remote Drift, `notebook.overview-note` descriptor mismatch, in-place repair preserving note ID, dry-run, selective rule ownership, preservation, postcondition audit, second-run no-op.
- Packaging: built and packed CLI, Project Notebook Skill assets, projected hooks, Node 20+, isolated home/registry, and no production dependency.
- Security: credential-shaped fixtures, malicious service payloads, path traversal, symlink escape, oversized input/response, redaction, and cross-project isolation.

## 10. Options Considered

| Decision | Selected | Rejected alternative | Reason |
| --- | --- | --- | --- |
| Lifecycle ownership | One Project Notebook Module/recipe | Standalone scripts called by hooks | Scripts would bypass plan/apply, audit ownership, idempotency, and shared interfaces |
| Service topology | One shared Notebook Service with one notebook per repository | One service deployment per repository | Per-repository deployments add infrastructure cost without improving the requested ownership boundary |
| Binding authority | Stable remote identifier plus deterministic display name | Display name alone | Names collide and change; identity must survive rename |
| Configuration | Project Registry defaults/binding plus Project Manifest overrides | Credentials and full config in each repository | Central defaults reduce drift; credentials must remain runtime-only |
| Hook integration | Canonical skill assets through master fanout | Direct per-client config edits from each repository | Fanout prevents dialect drift and shared-config clobbering |
| Session close | Fast durable enqueue plus detached worker | Synchronous upload and LLM call | Remote latency or failure must not block agent shutdown |
| Summary | Configured low-cost LLM plus deterministic fallback | LLM-only capture | Durable evidence cannot depend on model availability |
| Search | Enforce Companion Notebook ownership in adapter | Return upstream global results | Cross-project leakage violates the one-to-one product boundary |
| Unresolved receipt bound | Admission backpressure before creating a new receipt | Automatic deletion, silent compaction, or v1 dismissal | Recovery evidence must remain visible; dismissal needs separate UX and safety design |
