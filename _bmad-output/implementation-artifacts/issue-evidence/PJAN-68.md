# PJAN-68 MCP discovery review and evidence

Reviewed against the twelve `server.registerTool` handlers in `src/mcp-server.ts`. The columns below are `readOnlyHint / destructiveHint / idempotentHint / openWorldHint` (all explicit booleans). `destructiveHint` describes the *possible* overwrite/removal of existing user-managed files, not only deleting files. `openWorldHint` includes caller-selected directories, subprocesses, host/registry access, and external provider access; it does not claim every invocation calls a provider. A preview default never makes an apply-capable tool read-only. Output schemas describe per-tool stable objects while permitting evolving diagnostic/registry fields; the successful result sends both original full object and readable text (human formatting where `json=false`).

| Tool | Hints | Handler rationale |
| --- | --- | --- |
| `pjangler_list_capabilities` | T/F/T/F | In-memory registries and guidance only. |
| `pjangler_list_parity_rules` | T/F/T/F | In-memory rule IDs and guidance only. |
| `pjangler_audit_project` | T/F/T/T | Read-oriented parity report over caller's repo; audit may inspect host and external state. Its `ok=false` means *findings*, not a failed audit operation. |
| `pjangler_migrate_project` | F/T/F/T | `dryRun=false` can rewrite repo files, run host tools, and read provider/registry state; caller-selected rule may not be repeatably safe. |
| `pjangler_bootstrap_33god_project` | F/T/F/T | `dryRun=false` can overwrite scaffolding, upsert registry, and with explicit live consent provision a ticket board. |
| `pjangler_project_init` | F/T/F/T | `apply=true` can re-render existing files, upsert registry, and with explicit live consent provision a ticket board. |
| `pjangler_info` | T/F/T/T | Reads selected local manifest or PostgreSQL-backed index; index availability can vary. |
| `pjangler_project_list` | T/F/T/T | Reads caller/default registry, including remote service. |
| `pjangler_project_show` | T/F/T/T | Reads caller/default registry then selects one record. |
| `pjangler_describe_project` | T/F/T/T | Inspects caller-selected repo, git and registry/index state; no mutation. |
| `pjangler_describe_recipe` | T/F/T/F | Looks up in-memory recipe metadata. |
| `pjangler_run_recipe` | F/T/F/T | `apply=true` invokes arbitrary registered recipe against explicit target; recipes may overwrite files or call external tools. |

## Executed checks

- `npm run typecheck && npm run build && node tests/mcp-server-regressions.mjs && node tests/mcp-catalog-regressions.mjs && node tests/pjan-67-trusted-lifecycle-regressions.mjs && git diff --check`: exit 0 on the PJAN-68 isolated branch after the lifecycle-variant and describe-schema repair.
- Earlier `npm test`: 122 attempted, 115 passed, 7 failed during the initial unpopulated `templates/commonproject` submodule run. After `git submodule update --init templates/commonproject`, five of the six targeted failures passed; the remaining `pjan-166-bmad-setup-scripts-regressions` failed on an unrelated published-release availability check (`6.3.1-next.13 is not a published bmad-method release`). Full suite was not rerun after submodule checkout; this repair did not change that limitation.

## Verification scope

The SDK client checks explicit hint matrices and schema-valid results for all twelve listed tools, including formatted reads, preview/apply migrations and blocked/partially applied diagnostics. Negative AJV assertions reject empty recipe/command metadata, audit findings, migration results, registry projects, project preview actions and preview projects using live advertised schemas. Preview and execution are separate required variants in the advertised top-level object schema: bogus `{ok:true,dryRun:true|false}` success envelopes and missing preview plan or execution recipe outcomes are rejected. Stable nested keys/types cover project records and agent entries, plan actions, manifests and ticket binding, migration reports, audit findings, lifecycle phases, and describe git/activity/type/identity/notebook/subsystem/config/next-step/parity fields; evolving extra fields remain permitted. `pjangler_info` intentionally contracts only the guaranteed normalized identity on arbitrary existing manifests and the registry lookup status (not a full project registry record).

Successful project apply coverage runs in the existing PJAN-67 hermetic trusted-Copier lifecycle fixture: both bootstrap create and project-init sync assert `ok=true`, `isError` absent, non-preview phase/plan data, JSON text equality, and AJV validation of `structuredContent` against each live `tools/list` schema. Negative assertions reject empty nested apply plans and phases, every missing required execution field, and missing required phase fields. This fixture uses an isolated home/registry, committed CommonProject template, local installer fixtures and a fake provider adapter; these two apply calls opt out of the board and do not contact a real provider. No deployment or publication was performed.
