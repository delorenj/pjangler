# PJAN-166 — BMAD config authority trace (AC1/AC2 research)

- Date: 2026-11-12
- Orchestrated by: momo
- Researcher: read-only general-purpose subagent (Claude Code). It modified no repository; its scratch trees were under `/tmp/pjan166-trace-OkHo` (ephemeral).
- Purpose: ground the AC3 sentinel contract in what upstream actually does, instead of invented precedence.

## Method

- **Fresh install.** Ran the real bmad-method 6.12.1 installer with pjangler's exact arguments (`install --yes --modules bmm,bmb,cis --tools <7> --set core.project_name=…`) via `node <cached entry>`, matching the PJAN-180 path. The package integrity matched the test pin. HOME, XDG_* and TMPDIR all pointed into scratch. At install time it resolved bmb v2.2.2 and cis v0.3.2 from GitHub stable tags.
- **BMB setup.** Replayed the three script commands from `bmad-bmb-setup/SKILL.md:48-49,67` verbatim, headless, accepting defaults. That skill is byte-identical in the fresh install, pjangler's `.agents/skills` and 33GOD's `.agents/skills`.
- **Audits.** Bundled `src/parity/rules.ts` and called the `createBmadChecks()` audits directly on each tree, plus 33GOD and pjangler (read-only).

## Findings (VERIFIED unless marked)

1. **BMB setup deletes more than per-module YAML.** It removes `_bmad/core/` and `_bmad/bmb/`, and `--also-remove _config` deletes all of `_bmad/_config/`. That directory holds `manifest.yaml`, `bmad-help.csv` (bmad-help's only catalog), `skill-manifest.csv` and `files-manifest.csv`. The flag has been in the setup skill at every upstream revision since 2026-03-30.
2. **The audit fails on a post-BMB tree.** pjangler's audit on a replayed post-BMB tree fails on exactly `core/config.yaml`, `_config/manifest.yaml` and `bmb/config.yaml`, and `bmad.version` drops to `skip`.
3. **Reinstalling restores everything without touching BMB's files.** Re-running the installer (what `pj migrate` does) restores every deleted file and leaves BMB's three new files (`config.yaml`, `config.user.yaml`, root `module-help.csv`) untouched. Running BMB setup again deletes the same set again, so the two flows flip-flop for good.
4. **33GOD fails today** on `core/config.yaml` and `bmb/config.yaml`. Its `_config/` survived; why that BMB run kept it is undetermined.
5. **The runtime is unaffected.** `resolve_config.py` returns identical values before and after BMB setup, because BMB never touches the TOML layers.
6. **The consolidated `_bmad/config.yaml` has no `project_name`.** `merge-config.py:87-90`'s `_CORE_KEYS` excludes it.
7. **Upstream's migration rule runs one way only.** TOML is primary and per-module YAML is the legacy fallback (`official-modules.js:928,955`, `manifest-generator.js:491-493`; CHANGELOG v6.8.0, v6.11.0, v6.12.1 #3019). No upstream rule maps BMB's `_bmad/config.yaml` to or from TOML.
8. **The installer pin does not pin bmb.** bmb resolves from stable tags at install time, so a future bmb release can change the setup flow under the same 6.12.1 pin.

## Authority table

- INST = `bmad-method/tools/installer` (npm cache)
- SK = installed `.agents/skills`

| `_bmad/` artifact | Written by | Read by | Survives BMB setup |
|---|---|---|---|
| `config.toml` | Installer, rewritten on every install (`manifest-generator.js:428-436`) | `config_utils.py:102` (required) via `resolve_config.py`; 25 core/bmm skills, bmad-help, `render_skill.py:23`, bmad-customize | yes, byte-identical |
| `config.user.toml`, `custom/config*.toml` | Installer (custom: stubs, then user/g33) | `config_utils.py:103-105` (optional layers) | yes |
| `scripts/resolve_config.py`, `scripts/config_utils.py` | Installer | the 25 skills + bmad-help + build renderer; resolver exits 1 without `config.toml` | yes |
| `_config/manifest.yaml` | Installer | `existing-install.js:55-62`, `ui.js:1513-1518`; pjangler version, module selection, pins, attestation | **no** |
| `_config/bmad-help.csv` | Installer (merged help) | `bmad-help/SKILL.md:25` (only catalog) | **no** |
| `_config/skill-manifest.csv`, `files-manifest.csv` | Installer | pjangler `bmad-attestation.ts:92-93` | **no** |
| `core/config.yaml` | Installer | no 6.12.1 skill (0 refs); installer only as a fallback | **no** |
| `bmb/config.yaml` | Installer | bmb skills, fallback only | **no** |
| `bmm/config.yaml` | Installer | no 6.12.1 skill (#3019); installer `_readOutputFolder` | yes |
| `cis/config.yaml` | Installer | 10 cis skills, directly, no fallback | yes |
| `config.yaml` (consolidated) | BMB setup (`merge-config.py:406-407`); module-builder setup skills; `g33_install.py:9` | bmb skills, first choice; pjangler `companion.ts:424,578` (g33 key) | created by it; no `project_name` |
| `config.user.yaml` | BMB setup | bmb skills; gitignored | created by it |
| root `module-help.csv` | BMB setup | nothing in 6.12.1; g33 fallback | created by it |

Nothing in pjangler `src/` reads `module-help.csv` or `bmad-help.csv`.

## Chosen sentinel contract: Contract A (decision recorded 2026-11-12)

1. Require `_bmad/config.toml`. It is the runtime's only required file, BMB never touches it, and the installer rewrites it on every run.
2. Require `_bmad/scripts/resolve_config.py` and `_bmad/scripts/config_utils.py`. This is new coverage: today a project missing them passes, yet 25 skills, bmad-help and the build renderer depend on them.
3. Keep `_bmad/_config/manifest.yaml`. It is the installer's install record and pjangler's source for version, module selection, pins and attestation. Its loss is real breakage, and `pj migrate` (reinstall) repairs it without harming BMB's files. The finding must name the cause and the remedy: BMB setup's `--also-remove _config` cleanup; run `pj migrate bmad.scaffold`.
4. For each selected module `m`, require `_bmad/<m>/config.yaml` OR a `_bmad/config.yaml` that parses to a mapping with a top-level key `m`. This mirrors bmb's own read order, keeps cis's hard requirement and covers module-builder-built modules.
5. Drop `_bmad/core/config.yaml`. No 6.12.1 consumer reads it, `[core]` in `config.toml` holds the same values, and BMB setup deletes it by design.

The `project_name` check stays as it is; it already skips missing YAML.

Rejected, Contract B: accepting the literal post-BMB tree by treating `config.yaml` + `config.toml` as a substitute for the manifest. That silently hides a deleted install record and bmad-help catalog, and `bmad.version` keeps skipping. It fails the chase-the-check pillar.

### Expected outcomes

The "current" column was verified by running the audit; the Contract A column applies the rules to the verified trees.

| Tree | Current | Contract A |
|---|---|---|
| Fresh install | pass | pass |
| Post-BMB, exactly as the skill prescribes | fail (core, manifest, bmb) | fail (manifest only, with the named remedy) |
| Post-BMB + reinstall (`pj migrate`) | pass | pass |
| 33GOD today | fail (core, bmb) | pass |
| `config.toml` missing | fail | fail |
| `scripts/` missing | pass | fail |
| `cis/config.yaml` missing | fail | fail |

## Open questions (not resolved by this trace)

- Whether bmb skills behave identically on the consolidated YAML: they are LLM instructions; only the text was verified.
- Why 33GOD's `_config/` survived its BMB run (commit `19c56d9`, 33GOD-80).
- Whether upstream bmb has an open issue to stop deleting `_config` or to make setup TOML-aware. GitHub issues were not searched.
- The v7 config layout (advertised preview in 6.12.2+) was not inspected.

## Related finding (separate from AC3)

`bmad.version` warns "6.12.1 is behind stable 6.12.4" on every fresh install (VERIFIED). The comment at `rules.ts:1629-1631` says init treats that warning as a failed postcondition (INFERRED risk to fresh init). 6.12.4's config behaviour is identical to 6.12.1, so Contract A holds across a pin bump.
