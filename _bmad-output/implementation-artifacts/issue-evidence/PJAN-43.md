# Evidence: PJAN-43 — Fix these skill, audit, and migrate bugs

## Issue
- Ticket: PJAN-43
- Milestone / horizon: no active Plane cycle
- Worker: codex-worker/gpt-5.6
- Orchestrated by: momo

## Acceptance Criteria
1. Generated project skill sync accepts the supported `.claude/skills -> ../.agents/skills` alias while unsafe, broken, external, or parent-symlink topology blocks before mutation.
2. `pj audit` detects manifest, provisioner, mise, executable-mode, and CLI-topology drift that would break project entry; canonical topology audits cleanly.
3. `pj migrate --all` repairs only pinned-pack-owned BMAD projections, preserves every unowned custom directory and manifest entry, and converges to an idempotent no-op.
4. `.env.op` validation catches malformed `op://` references in active values, comments, and examples; generated malformed examples are neutralized without exposing or overwriting valid references.
5. BMAD scaffold audit and migration preserve explicit manifest/config module selection, including core/custom-only, and block malformed installed manifests rather than choosing defaults.
6. `migrate --all` selects only actionable, fixable findings; unsafe topology and skipped no-PM rules are excluded.
7. Any owned or declared PM without `role.yaml` is a truthful non-fixable blocker and is never deleted, including when another valid role exists.

## Repo Changes
- Branch: `feature/PJAN-43-skill-audit-migrate` (base `4fa74e4a201ca1df2d23c83957cf0f59f8c52090` -> implementation `79100a33a9981d1315cdfdcb4b2c294d2a3730d8`)
- Files changed:
  - `src/parity/index.ts` — hardened audit/migrate ownership, topology, secret-reference, BMAD-module, registry, and executable convergence contracts.
  - `tests/pjan-43-regressions.mjs` — executable counterexamples and disposable HeyMa-shaped end-to-end coverage for all acceptance criteria.
  - `tests/bmad-transaction-regressions.ts` — pack-provenance preservation coverage.
  - `package.json` — added the PJAN-43 regression suite to the package test chain.
  - `dist/index.js` and `dist/mcp-server.js` — rebuilt tracked bundles; independent byte-parity check passed.
  - `templates/commonproject` — advanced to CommonProject commit `35a7eb0c487b60bf890ed9aae4c948f1346f2bc2`.
  - CommonProject `template/.mise/scripts/sync-skills.py` — safe alias support plus repeated full-chain containment checks at mutation boundaries.
  - CommonProject `template/.mise/scripts/provision-bmad-skills.py` — pack-provenance ownership and executable template mode.
  - CommonProject focused Python tests — topology, parent-swap, ownership, rollback, and idempotency coverage.
- Migrations / schema: none

## Verification
- Commands executed and results:
  - `npm run typecheck` -> passed.
  - `npm run build` -> passed; fresh temporary builds matched both committed bundles byte-for-byte.
  - `node tests/pjan-43-regressions.mjs` -> passed.
  - `node tests/parity-migrate-regressions.mjs` -> passed.
  - `node tests/bmad-transaction-regressions.mjs` -> passed.
  - `node tests/bmad-version-surface-regressions.mjs` -> passed.
  - CommonProject focused suites -> 11 of 11 passed.
  - `npm run check:submodules` -> passed.
  - `npm run check:tracked-secrets` -> passed across 1,613 paths.
  - Gate 1 reviewer `codex-code-reviewer-gate1-final/gpt-5.6` -> spec compliant.
  - Gate 2 reviewer `codex-code-reviewer-final-quality/gpt-5.6` -> approved with no findings.
- AC -> evidence mapping:
  - AC1 -> canonical alias, external symlink, broken symlink, parent-swap, and special-target fixtures prove containment and zero mutation.
  - AC2 -> audit fixtures cover manifest links, shipped script bytes and modes, mise ordering, dependencies, and CLI topology.
  - AC3 -> custom `bmad-private-custom`, canonical collision, stale pack-owned projection, executable-mode, rollback, and second-run no-op fixtures pass in TypeScript and Python.
  - AC4 -> malformed comment example is detected and neutralized while valid references and active malformed-value blockers are preserved truthfully.
  - AC5 -> core-only, custom-only, selected-module, malformed-manifest, and post-migration audit fixtures pass; real BMAD install with `--modules core` produced core only.
  - AC6 -> unsafe topology audits non-fixable and is absent from `--all`; skipped no-PM rules are also absent.
  - AC7 -> mixed valid plus missing-role fixture blocks explicit migration and preserves registry and `.project.json` bytes.

## Ledger Update
- Bloodbank decision/events emitted: decision `c8e0a33d-2048-404a-9ed2-a91ea908e17b`; see `bloodbank-events.jsonl` for gate events.
- Ledger updated: yes

## Known Gaps
- The consolidation baseline has a stale `package-lock.json`, so `npm ci` exits before tests; PJAN-43 did not modify the lockfile.
- The unchanged Hermes submodule pin `2a2da607e7f72a340c70dabbe8ace2b30abd960b` is unavailable from its configured remote, so the full package chain halts in the clean-clone submodule regression.
- PostgreSQL registry coverage self-skipped because PostgreSQL was unreachable; the non-database registry suites passed.
- CommonProject commit `35a7eb0c487b60bf890ed9aae4c948f1346f2bc2` and this branch are local-only and must become remotely reachable before publication.
- A syscall-width parent-swap race remains theoretically possible without a larger `dirfd`/`openat` rewrite; repeated immediate containment checks close the reproduced same-user preflight-to-mutation race and the independent reviewer accepted the residual for this local CLI threat model.

## Close Recommendation
- Close recommendation: ready
- Rationale: all seven criteria pass executable counterexamples, independent spec review, independent quality review, and source-to-bundle parity checks; remaining gaps are explicit baseline or local-publication constraints.
