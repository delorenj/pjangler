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

- `npm run typecheck && npm run build && node tests/mcp-server-regressions.mjs && node tests/mcp-catalog-regressions.mjs && git diff --check`: exit 0 after submodule checkout.
- `npm test`: 122 attempted, 115 passed, 7 failed during the initial unpopulated `templates/commonproject` submodule run (`/home/delorenj/.claude/tmp/pjan68-full-test.log`). The changed MCP suite passed at suite 93/122. After `git submodule update --init templates/commonproject`, five of the six targeted failures passed; the remaining `pjan-166-bmad-setup-scripts-regressions` failed on an unrelated published-release availability check (`6.3.1-next.13 is not a published bmad-method release`), recorded at `/home/delorenj/.claude/tmp/pjan68-submodule-rerun.log`. Full suite not rerun after submodule checkout.

## Verification scope

`tests/mcp-server-regressions.mjs` uses the real SDK client/stdio server, checks discovery equality to this matrix and output schemas for the *entire discovered catalog*, then JSON Schema-validates the structured successful response of every listed tool using isolated fixtures. It exercises formatted `json=false` audit/describe, preview and apply migration, preview init/bootstrap/recipe, successful apply recipe, failed apply bootstrap/init/recipe, and a blocked and partially applied migration retaining `results`, `changedFiles`, and `details`. The fake `copier` exits before provisioning; fixtures use a temporary YAML registry, never live providers. Existing strict parameter/consent/noninteractive/stdio regressions remain in the same client suite. There is no isolated successful full CommonProject apply fixture in this ticket: the existing production lifecycle guards are exercised as preflight failures, not bypassed for a synthetic success. No provider calls, deployment, or publication were performed.
