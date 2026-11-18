# PJAN-17 — provider removal and fail-closed regression evidence

## Change boundary

Candidate branches: pjangler `PJAN-17-two-providers`, CommonProject `PJAN-17-commonproject`, Hermes `PJAN-17-hermes-template`, Flume `PJAN-17-flume-guidance`, Krebs `PJAN-17-krebs-adapters`. No live board, deployment, or migration was changed. The protected CommonProject `AGENTS.md` was not edited. Published refs were checked with `git ls-remote`; this is review evidence, not a merge recommendation.

Pjangler's canonical manifest and Copier provenance checks now refuse unsupported explicit/legacy provider bindings before migrating, retaining the source records byte-for-byte. Missing/no-provider/skipped records never acquire an implicit Plane binding; an unbound canonical record has `type: none, state: skipped`. `board.schema` audits and migrations require an explicitly linked Plane board and never call `px` for Trello, Linear, missing or malformed types. The Hermes rendered sentinel gates its Plane-only lifecycle on the repository manifest and describes Trello as read-only for the supported operations; the disposable render regression exercises opposite render-time and manifest bindings. Flume's PM launch guidance assertion verifies its existing Plane guard.

## Executed checks

Logs below are absolute paths under `/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/`. An exit is the child command's recorded status, not a shell wrapper's status. The tests use disposable fixtures; their CLI fixtures never call a live ticket service.

| Owner / command | Exit and result | Log |
| --- | --- | --- |
| Pjangler `node scripts/run-tests.mjs pjan-17-provider pjan-43 board-schema` after the unbound-contract fix | 0; 3/3 suites | `pjan17-r2-final-fix-target.log` |
| Pjangler targeted provider/board/read/CLI regression selection (`pjan-17 pjan-23 pjan-30 pjan-50 pjan-67-regressions pjan-72 pjan-87`) | 0; 12/12 suites | `pjan17-r2-targeted.log` |
| CommonProject provider binding pytest | 0; 5 passed | `pjan17-r2-common-provider.log` |
| Hermes `pytest -q tests/test_two_provider_dispatch.py` after rendered sentinel update | 0; 13 passed | `pjan17-r3-hermes-dispatch.log` |
| Flume PM launch-mode test against an isolated candidate tree and isolated built Skillex, with updated assertion copied in | 0; passed | `pjan17-r2-flume-candidate-isolated-pm-fixed.log` |
| Isolated Skillex `npm run build` in disposable directory | 0 | `pjan17-r2-skillex-isolated-build.log` |
| Pjangler final full `npm test`, after the unbound-contract fix | 1; 116/118 suites passed, including PJAN-17, PJAN-43 and board-schema; only `check:submodules` and PJAN-166 failed | `pjan17-r3-pjangler-full.log` |
| Pjangler initial full `npm test` (before final unbound-contract fix) | 1; 115/118 suites passed | `pjan17-r2-pjangler-full.log` |
| CommonProject full pytest | 1; 30 passed, 7 failed, 16 subtests passed | `pjan17-r2-common-full.log` |
| Hermes full pytest before sentinel wording change | 1; 880 passed, 3 failed | `pjan17-r2-hermes-candidate-full.log` |
| Flume worktree PM test, with installed unbuilt Skillex | 1; `ERR_MODULE_NOT_FOUND` for `@delorenj/skillex/dist/index.js` | `pjan17-r3-flume-pm.log` |

## Full-gate attribution and limits

- Pjangler initial full gate failed `check:submodules` because the candidate CommonProject pin `f0e4e7cfdd` is on the published PJAN-17 branch but not in local `main` (`de7a78b242`); no merge or main-branch alteration was permitted. Its PJAN-166 failure (`6.3.1-next.13 is not a published bmad-method release`) reproduces on the candidate and a disposable baseline checkout built at `ffeab8396f5e44db2c77fcb834bf3839e58952d0`, each exit 1 (`pjan17-r2-pjangler-candidate-166.log`, `pjan17-r2-pjangler-base-166-built.log`). The third `pjan-43-regressions` failure was introduced by the first fail-closed edit: it expected the missing-provider canonical contract to audit cleanly. That edit was corrected; the exact suite and new provider/board tests pass together in `pjan17-r2-final-fix-target.log` (exit 0).
- CommonProject's seven `test_skillex_integration.py` failures reproduce identically on a disposable git baseline at `de7a78b242d7ba16bbcb65789032c111f6b31d71`: `pjan17-r2-common-base-skillex-git.log` (exit 1, 7 failed, 2 passed). The expectation includes a missing `skills:sync` task. No unrelated Skillex template repair was attempted.
- Hermes's three `test_project_skills_policy.py` failures reproduce on its disposable baseline `cbc0d6a9957cdaedf4667dc104872d442afdc406`: `pjan17-r2-hermes-base-policy-retry.log` (exit 1, 3 failed, 48 passed). The policy script reports `status: blocked` (return 3); the candidate full suite reports the same three failures. No policy repair was attempted.
- Flume's worktree lacks the built `@delorenj/skillex/dist/index.js`; do not treat this environment failure as a passing full gate. Isolated dependency build and PM test provided an executable path without modifying installed/global packages. The first isolated candidate PM test also exposed an outdated assertion against the old unguarded guidance (exit 1); the PJAN-17 assertion was updated and the same isolated test passed. No complete Flume gate is certified.

## F1/F2 remediation on the pjangler candidate

`pj init` now validates the existing binding before considering an explicit provider override or default. It rejects Linear even with `--ticket-provider plane`, refuses to inherit a Trello board into Plane, and refuses a nonempty board without a declared provider. A boardless existing `none` binding can still select Trello explicitly. `pj project link` reads and validates the canonical `.project.json` before any credential lookup or provider request, rejects unsupported/missing/conflicting provider, board, and workspace bindings, and retains registry-only compatibility when no manifest exists. Neither rejection writes a manifest or registry row.

Verification on this candidate:

- `node scripts/run-tests.mjs init-board-ingress pjan-17-provider project-identity project-registry pjan-30 pjan-43 board-schema`: exit 0, 8/8 suites, with typecheck and build. The ingress suite checks unchanged registry/manifest bytes, zero `fetch` requests in both dry-run and apply rejection cases, plus registry-only Trello and supported Plane linking.
- `node /home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/pjan17-review-published-gla9ruvv/reproduce-binding-gaps.mjs /home/delorenj/code/33GOD/pjangler/.worktrees/PJAN-17-two-providers`: exit 0, failures 0, requests `[]` for all three canonical mismatch fixtures.
- `npm test`: exit 1, 117/118 suites passed. Only `check:submodules` failed: the pinned CommonProject PJAN-17 commit `f0e4e7cfdd` is not contained in the local CommonProject `main` at `de7a78b242`; this work did not alter or merge that branch. The PJAN-166 suite that previously failed passed on this run.
- After adding an adapter-invocation marker and a workspace-conflict fixture: `node scripts/run-tests.mjs init-board-ingress pjan-17-provider project-identity pjan-30 pjan-43 board-schema`: exit 0, 7/7 suites, with typecheck and build. `git diff --check`: exit 0.

A passing overall full gate is **not** claimed; the candidate remains for review without a main merge or Plane write.
