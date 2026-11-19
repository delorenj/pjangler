# PJAN-70 — MCP cancellation and subprocess deadlines

## Contract

All four mutation tools (`pjangler_migrate_project`, `pjangler_bootstrap_33god_project`, `pjangler_project_init`, `pjangler_run_recipe`) accept an integer `timeoutMs`: default **120000 ms**, range **1–600000 ms**. The SDK request signal is captured before handler work. Both read and mutation handlers share an operation-local, monotonic deadline across preflight, registry snapshots, lifecycle dispatch and subprocesses. Lifecycle contexts expose `signal`, `deadlineMs`, and `assertActive`. A pre-aborted request cannot start work. Stops return `isError: true` with distinct stable `MCP operation cancelled` or `MCP operation deadline-exceeded` reasons; stopped work cannot be reported as success. The SDK client may locally reject a cancelled call rather than receive its server-side result.

`runChild` uses asynchronous `spawn` (`shell: false`), bounded combined stdout/stderr (16 MiB default), and a fresh POSIX process group. It sends SIGTERM to the group on stop, escalates to SIGKILL after **500 ms** even if the leader has exited but descendants hold stdio, and settles at most **100 ms** after escalation. Spawn/kill failures remain visible; overflow remains a distinct diagnostic. Individual subprocess timeouts outside an MCP operation retain a conventional ETIMEDOUT outcome. Windows lacks a process-tree guarantee and needs a separate implementation before claiming parity. This change does **not** promise transactional rollback of writes already completed before cancellation or compensation for external services.

## Reachability inventory

MCP handlers (`src/mcp-server.ts`) execute inside `withOperation` and request-local registry snapshots. Mutation paths dispatch project planning/initialization, recipe lifecycle and parity migration; read handlers use the same operation boundary. Their reachable processes now use cancellable `runChild` or an asynchronous operation-specific branch:

- Project preflight/version probe, Copier apply, project Git, operator name and project registry read/write: `src/lifecycle/preflight.ts`, `src/project/{index,registryClient}.ts`, `src/recipes/ProjectRecipe.ts`.
- BMAD installer/version/npx, provider/px smoke checks, git/index/skill roots, and g33 module resolution: `src/parity/{rules,skill-roots,skills}.ts`, `src/bmad/{companion,update-scope}.ts`.
- Provider secret lookup and board query, identity/rename/import actions and postcondition probes: `src/project/{boardQuery,identity,rename,import}.ts`.
- Read-side activity/description, notebook Git evidence, entropy, hooks/projector and summarizer: `src/describe/activity.ts`, `src/notebook/{git-evidence,entropy,hooks,summarizer,module}.ts`.

A source-wide `spawnSync|execSync|execFileSync` inventory retains synchronous calls in CLI-only `src/index.ts`, crank and prompt-refresh, plus CLI fallbacks in dual-use modules. Dual-use MCP paths use asynchronous wrappers; `registryRequest` refuses an uncached synchronous MCP service call rather than blocking, and MCP primes its snapshot first. Parity, recipe and migration catch/loop boundaries check the active operation before subsequent phases/writes, including installer completion and migration fallback. This inventory describes the current reachable routes, not a promise that a newly added entrypoint automatically inherits their discipline.

## Verification

`tests/pjan-70-operation.mjs` exercises pre-abort, timeout, grace and forced process-group cleanup, descendants holding inherited stdio, no delayed child writes at their original completion time, bounded settle, overflow, normal completion, and a subsequent child. `tests/pjan-70-protocol.mjs` uses a real SDK stdio client/server and a scratch slow recipe: expiry and request cancellation, no child **or handler-after-child** writes even at original completion time, and a valid subsequent request on the same transport. Both are registered in `scripts/run-tests.mjs`. Existing consent/noninteractive, preview/apply and lifecycle suites remain registered. Scratch fixtures do not contact live registry/provider services.

At this edit, the focused command `npm run typecheck && node tests/pjan-70-operation.mjs && node tests/pjan-70-protocol.mjs` exited **0**. `node tests/pjan-166-bmad-setup-scripts-regressions.mjs` also exited **0** (45/45); `node scripts/check-hermetic-test-env.mjs` exited **0** after its spy-env correction. A previous full run completed **114/123** before these async regression repairs; that number is **not** final acceptance evidence. Final complete-suite outcome must be read from the supervised run, not inferred from a launch or an in-progress log.
