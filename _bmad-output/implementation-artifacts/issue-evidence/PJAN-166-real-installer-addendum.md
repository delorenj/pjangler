# PJAN-166 candidate evidence — real-installer addendum (2026-11-19)

Branch: `PJAN-166-contract-a-review`. Supersedes the prior candidate's file-existence-only claims with the independent reviewer's five named gaps. Runs and logs: `~/.hermes/profiles/pjangler-pm/cache/scratch/` (`pjan166-real-contract-run.log`, `pjan166-full-run.log`, `pjan166-metadata-rerun.log`).

## 1. AC2 — runtime TOML validity (rules.ts:2010-2070)

The regex `project_name` scan is gone. `bmadProjectNameIssues` now parses the whole `_bmad/config.toml` with `smol-toml` (already a dependency and the same parser class `tomllib` accepts), reading `core.project_name`. Malformed TOML reports `_bmad/config.toml is not valid TOML (the installed resolver cannot read it)` (fail, fixable). A same-named key in a foreign table (e.g. `[agents.pjan166_probe].project_name`) is no longer accepted. Contract A sentinels and detail wording for all other rows are unchanged.

CLI + resolver regression: `tests/pjan-166-config-authority-regressions.mjs` runs the **installed** `resolve_config.py` on both shapes; the audit must fail with the exact new details while the resolver exits 1 (`failed to parse`) or returns no `core.project_name`. 26/26 tests pass.

## 2. AC3 — Core help readback (`npm run test:bmad-config-authority`)

The real contract now, on real trees: reads `_config/bmad-help.csv` and requires the `Core,bmad-help,` row (9 Core entries, 11239 bytes, digest compared) after the first real install, and byte-identically after **each** of three reinstall repairs; parses the fresh `config.toml` and runs the installed resolver on both fresh and existing projects; checks all four TOML layers' team/personal split via the resolver (`core.output_folder`, `modules.bmb.bmad_builder_output_folder` team; `core.user_name` personal); and asserts the seven supported harness `bmad-help/SKILL.md` projections exist on fresh init. `.user.` layers are asserted git-ignored per repo policy (untracked personal layers only; `git check-ignore` per path, since `-q` is single-path only).

## 3. AC5 — real full fresh init + existing migration

`tests/pjan-166-bmb-setup-contract.mjs` now runs a bounded, hermetic real `pj project init --yes --apply --skip-board --registry <private scratch>` into an empty scratch directory (real pinned 6.12.1 installer; skillex fixture catalog and mise shim as in PJAN-76; no live board, no shared registry, no trust mutation), separately from the existing-project `pj migrate bmad.scaffold` path. `foreign` dirty file, `.gitignore`, and all four TOML layer bytes are hashed **before** the first real install invocation and asserted unchanged after it and after every repair. Run log excerpt: `real fresh init: 6.12.1; seven harness help projections; Core help catalog`, `existing migration: bmad-method 6.12.1; bmb v2.2.2, cis v0.3.2; Core help 11239 bytes / 9 entries`.

## 4. AC1 — provenance matrix

`_bmad-output/implementation-artifacts/issue-evidence/PJAN-166-provenance-addendum.md` records per-harness (7 supported `--tools` + `.agents`) native projection, config/help authority, and current read-only 33GOD/pjangler/worktree byte hashes, explicitly distinguishing pin (6.12.1) vs payload (bmb v2.2.2/cis v0.3.2 resolved from stable tags) vs Skillex catalog vs active runtime claimability. 33GOD's bmad-help SKILL.md currently matches the Skillex catalog hash; that is byte provenance, not active-session state.

## 5. Full `npm test` baseline (126 suites, 564.9s)

121 pass, 5 fail:
- `pjan-166-bmad-setup-scripts-regressions` (npm metadata shape: `npm view --json` returned an array) — FIXED here: the assertion accepts the exact single-element array; standalone rerun 45/45 passes (`pjan166-metadata-rerun.log`).
- `check:hermetic-test-env`, `pjan-196-suite-env-canary`, `bmad-version-surface-regressions`, `pjan-167-g33-companion` — unrelated pre-existing failures on this branch (a stale hermetic-env allowlist note for PJAN75_CLI_BUILT; historical 6.10.2 strings in docs/evidence; an unknown-provenance skill-link refusal in the g33 companion suite). None are touched by this ticket's scoped changes; their failure reasons are recorded in `pjan166-full-run.log`.

`bmad.scaffold` audit remains read-only; no installer ran on 33GOD, pjangler, or the shared main preserve.
