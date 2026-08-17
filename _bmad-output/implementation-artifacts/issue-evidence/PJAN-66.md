# Evidence: PJAN-66 — Harden MCP input and identity contracts

## Issue
- Ticket: PJAN-66
- Milestone / horizon: adversarial MCP remediation workstream 1 of 5
- Worker: mcp-input-implementer (delegated Codex worker)
- Orchestrated by: momo

## Acceptance Criteria
1. Every MCP tool rejects undeclared top-level arguments before any handler or effect runs; `dryrun=true` returns invalid parameters and creates nothing.
2. Explicit slugs and agent roles reject empty values, dot segments, absolute paths, path separators, and traversal; every generated path remains contained beneath the intended parent or project.
3. `boardUrl` remains non-persisted per PJAN-12, is visibly deprecated in tool discovery, and produces a compatibility warning when supplied.
4. MCP does not advertise an ability to enable per-agent Bloodbank; `skipBloodbank=false` is rejected or normalized as deprecated and responses report `bloodbankMode=fleet-shared`.
5. Regression tests cover malicious MCP calls and direct `planProjectInit` callers and prove no escaped files or registry changes; the manifest-sync and agent-preservation regressions fixed by `3ad672e` remain green.

## Repo Changes
- Branch: `fix/PJAN-66-mcp-input-contracts`
- Implementation range: `cb8402f8de47a023fb4ebf4a32ccb958f5fdf5a3..570f11ddce106994bfad54ef8a04db400be9bbd1`
- Pjangler implementation commits: `5b397e01eb7af726a9ce804ac5621315cf327305`, `e45c62921967f88d5da9ecf2c95e8b0e7b48c5f8`, `55bbdaf939fb1a0dcb95f6e5f67458f89e996956`, `570f11ddce106994bfad54ef8a04db400be9bbd1` (pushed to `origin/fix/PJAN-66-mcp-input-contracts`)
- Hermes template commits: `3d5dc09a20bdcdba7f87892465070007b5506af6`, `f6cdf6186a436d565d8a3b87dad8a4ca8d9c0e8b` (pushed to the template feature branch and `origin/main`; parent gitlink advanced by `570f11d`)
- Files changed:
  - `src/mcp-server.ts` — strict MCP schemas, deprecated compatibility metadata and warnings, and fleet-shared Bloodbank contract.
  - `src/project/index.ts` — safe slug/role validation and contained project planning.
  - `src/commands/hermes/RunCopierTemplate.ts` — contained role-template destination handling.
  - `tests/mcp-server-regressions.mjs` — hostile-input and no-side-effect regressions.
  - `tests/project-registry-regressions.mjs` — direct planner and registry-preservation regressions.
  - `tests/fleet-shared-bloodbank-regressions.mjs` — fleet-shared MCP contract regression.
  - `templates/hermes-agent/copier.yml` — safe arbitrary-role validation in the shipped Copier template.
  - `templates/hermes-agent` — gitlink advanced to the published template correction.
  - `dist/index.js`, `dist/mcp-server.js` — regenerated runtime distribution.
- Migrations / schema: none

## Verification
- `npm run typecheck` — passed on the implementation head.
- `node tests/mcp-server-regressions.mjs` — passed on the implementation head.
- `node tests/mcp-catalog-regressions.mjs` — passed on the implementation head.
- `node tests/project-registry-regressions.mjs` — passed on the implementation head.
- `node tests/fleet-shared-bloodbank-regressions.mjs` — passed on the implementation head.
- `npm test` — passed on the exact final implementation tree.
- AC 1 and AC 5: hostile undeclared-key calls are rejected and no-effect behavior is asserted by `tests/mcp-server-regressions.mjs`.
- AC 2 and AC 5: direct planner, traversal, absolute-path, and symlink-containment behavior is asserted by `tests/project-registry-regressions.mjs`.
- AC 3: discovery deprecation and compatibility-warning behavior is asserted by MCP catalog/regression coverage.
- AC 4: removed MCP toggle and `bloodbankMode=fleet-shared` response behavior are asserted by `tests/fleet-shared-bloodbank-regressions.mjs`.
- Independent spec reviewer: `/root/pjan66_spec_review` (Codex code-reviewer, distinct from implementer).
- Spec gate result: failed AC 4 because bootstrap and project-init composite responses omitted `bloodbankMode=fleet-shared` and exposed the legacy `skipBloodbank` action context.
- Mutation-strength check: passed; retained target tests failed against base implementation source for fleet-shared response, strict schema, and direct slug rejection behavior.
- Reviewer verification passed typecheck, reproducible build/dist parity, and all focused suites; the isolated full-suite run reached its canonical-path-only PJAN-65 test, which passed separately from the canonical checkout.
- AC 4 remediation: commit `e45c62921967f88d5da9ecf2c95e8b0e7b48c5f8` adds fleet-shared mode to both composite responses, redacts the legacy action-context detail, and adds response-level regressions for both paths.
- Remediation verification passed build, typecheck, MCP server/catalog, project-registry, fleet-shared Bloodbank, and the full `npm test` suite on the canonical checkout.
- Fresh spec reviewer: `/root/pjan66_spec_rereview` (Codex code-reviewer, distinct from implementer and first reviewer).
- Fresh spec gate result: AC 4 passed; AC 2 failed because the MCP-accepted safe custom role `release-captain` is rejected by the shipped Copier template's fixed role choices on the real apply path.
- Fresh mutation-strength check: passed; retained target tests and direct response probes fail against the base implementation for the intended strict-schema, containment, and fleet-shared behaviors.
- AC 2 remediation: template commit `3d5dc09a20bdcdba7f87892465070007b5506af6` replaces the seven-role enum with matching safe-segment validation; parent commit `55bbdaf939fb1a0dcb95f6e5f67458f89e996956` advances the gitlink and adds real Copier render plus hostile-role regressions.
- Apply-path verification passed exact Copier pretend, real `release-captain` rendering, hostile-role rejection before manifest output, 75 template tests, the remote/archive/npm submodule contract, build, typecheck, all focused suites, and full `npm test`.
- Third spec reviewer: `/root/pjan66_spec_final` (Codex code-reviewer, distinct from implementer and both earlier reviewers).
- Third spec gate result: AC 1, 3, 4, and 5 passed; AC 2 failed because inherited object keys such as `constructor` collide with plain-object registry/agent lookups and YAML-ambiguous safe roles render as non-string scalars.
- Third mutation-strength checks passed for both the parent implementation and the base Hermes template; all disposable worktrees were removed.
- AC 2 map remediation: `570f11ddce106994bfad54ef8a04db400be9bbd1` uses own-key/null-prototype semantics for registry and agent maps; `constructor` and `prototype` now plan, persist, reload, and provision, while `__proto__` rejects without prototype mutation.
- AC 2 scalar remediation: `f6cdf6186a436d565d8a3b87dad8a4ca8d9c0e8b` quotes the emitted role scalar; real Copier renders for `release-captain`, `true`, `false`, `null`, and `123` parse as strings.
- Final remediation verification passed build, typecheck, all focused suites including lifecycle and PostgreSQL registry coverage, full `npm test`, 75 Hermes template tests, hostile Copier probes, and remote/archive/npm publication checks.
- Accepted spec reviewer: `/root/pjan66_spec_acceptance` (fourth fresh Codex code-reviewer, distinct from implementer and earlier reviewers).
- Accepted spec verdict: `spec compliant`; all five ACs passed, exact prior failures passed executable probes, and four targeted mutants were killed.
- Quality reviewer: `/root/pjan66_quality_review` (fresh Codex code-reviewer, distinct from implementer and all spec reviewers).
- Quality verdict: `approved`; every changed parent/template/test/dist hunk passed maintainability, correctness, safety, generated-parity, and publication-integrity review with no findings.

## Ledger Update
- Bloodbank decision/events emitted: `62b0a016-e411-4faa-8ce9-123c4284d916`, `741451f8-0d35-4b44-9d15-af0af57d3a2f`, `dace8e9c-7983-4ae0-8106-ff60f85950aa`, `a8785a2b-482c-49ae-977a-a3047350e31e`
- Ledger updated: yes

## Known Gaps
- No implementation, spec, quality, or publication gaps remain for PJAN-66.

## Close Recommendation
- Close recommendation: ready
- Rationale: all five ACs passed an independent spec review with executable probes and mutation strength, and a distinct quality reviewer approved both repository diffs with no findings.
