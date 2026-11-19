---
title: 'PJAN-113 notebook bulk migration ownership'
type: 'bugfix'
created: '2026-11-19'
status: 'in-review'
baseline_commit: 'c1c4e0700c3b3bf35e6af633cc19513274e887f3'
review_loop_iteration: 0
context: []
---

## Intent
`pj migrate --all` must not select a notebook check that promises a fix without an implemented migration. Its project repairs must reach verified parity; shared host findings must remain visible without failing the repository or modifying HOME. The focused `pj notebook migrate --apply` remains the host repair owner.

## Boundaries
- Keep PJAN-75's accounting for genuine project failures and PJAN-135's bounded second pass.
- No implicit remote mutation or host projection from repo bulk migration.
- Exercise source-bundled CLI with a hermetic registry, repository, state and HOME.

## Code Map
- `src/notebook/checks.ts`: binding audit and previously missing migration; shares `persistProjectNotebookBinding` with focused notebook migration.
- `src/notebook/config.ts`: authoritative binding resolution, atomic Manifest projection and conflict detection.
- `src/recipes/registry.ts`: bulk selection, manual blockers, postcondition verification and bounded second pass.
- `src/recipes/types.ts`, `src/parity/rules.ts`: migration result scope and human display.
- `tests/pjan-113-notebook-bulk-regressions.ts`: isolated CLI and registry cases; `.mjs` launcher registered in `scripts/run-tests.mjs`.

## Tasks & Acceptance
- [x] `src/notebook/checks.ts` — implement a local binding migration with dry-run and verified apply, and stop presenting malformed linked IDs as locally fixable.
- [x] `src/recipes/registry.ts` — report host drift separately as skipped, never select host migration during repo bulk run, retain manual project blockers.
- [x] `tests/pjan-113-notebook-bulk-regressions.ts` — cover the CLI and registry ownership boundaries.

1. Given a declared notebook with a drifted local Manifest binding and an authoritative fixture Registry, when source-bundled `pj migrate --all --dry-run --json` runs, then notebook.binding is planned as repairable and Manifest/Registry bytes remain unchanged.
2. Given the same drift, when bulk apply runs, then notebook.binding projects only the authoritative binding, verifies the postcondition, preserves unrelated Manifest keys, and a second selected migration is noop and byte-idempotent.
3. Given observed host skill/hooks failures marked fixable, when registry bulk migration runs, then neither migration callback executes, host results are separate scoped skipped findings, and project `ok` remains true.
4. Given the same host drift plus a genuine nonfixable project failure, when bulk runs, then the project failure remains blocked and `ok` is false.
5. Given remote work is required, when the repo bulk run lacks explicit live consent, then no remote mutation occurs; focused notebook repair retains its explicit `--apply --live` path.

## Verification
`npm run typecheck`, `npm run build`, `node tests/pjan-113-notebook-bulk-regressions.mjs`, `node tests/pjan-77-notebook-hooks-capture.mjs`, and `node tests/pjan-77-notebook-cli-contract.mjs` passed after initializing only the pinned `templates/commonproject` submodule. The filtered `node scripts/run-tests.mjs --no-build pjan-113 pjan-75 pjan-84-finding pjan-135-guidance pjan-57-lifecycle pjan-77-notebook-cli-contract pjan-77-notebook-hooks-capture` passed 7/7. Full `npm test` (prior to the focused-audit correction): 121/126 passed, 5 failed. Four failures (`check:hermetic-test-env`, `bmad-version-surface-regressions`, `pjan-167-g33-companion`, `pjan-196-suite-env-canary`) were independently reproduced in unchanged main; they are baseline failures, not attributed to PJAN-113. The fifth (`pjan-77-notebook-cli-contract`) was caused by a changed focused-audit detail and was repaired; its standalone rerun passes. A full-suite rerun after that correction remains outstanding. The previous candidate's 24 failures were not individually attributed and must not be described collectively as unrelated.
