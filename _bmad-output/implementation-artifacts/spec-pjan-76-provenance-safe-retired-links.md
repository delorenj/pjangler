---
title: 'PJAN-76 provenance-safe retired BMAD links'
type: 'bugfix'
created: '2026-11-18'
status: 'in-review'
baseline_commit: '9a332e3e39fa7faa6af537d201550b6cf2af8577'
review_loop_iteration: 0
context: []
---
<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">
## Intent
**Problem:** `pj migrate bmad.scaffold` unlinks any unreceipted `bmad-*` symlink, including an operator's custom skill, and can falsely claim it retired a pack projection. The installer may then write through a preserved unknown link unless the migration refuses before mutation.
**Approach:** Recognize retired pack links only through their own lexical link target provenance, refuse unknown collisions before installing, and preview/clean proven stale links without following targets.
## Boundaries & Constraints
**Always:** Work in PJAN-76 worktree; retain seven supported roots including ZCode; treat receipt/current selected skills and real installer-owned skill dirs as non-disposable. Never traverse skill-root aliases into foreign trees. Keep tests hermetic.
**Ask First:** Only if a collision cannot be safely refused or installer contract requires deleting an unknown link.
**Never:** Board writes, main merge, deploy/publish, old pack/provisioner resurrection, g33/config/bootstrap changes, unsupported CLI roots.
## I/O & Edge-Case Matrix
| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Retired | bmad-* symlink lexically into packs/bmad/version/skills/same-name, absolute or relative, live or dangling | unlink link only, report exact path; repeat noop | preserve target bytes |
| Unknown | bmad-* symlink into user tree, dangling or live, no receipt | preserve link and target | block with conflicting path before installer writes |
| Current | selected Skillex activation or receipt-owned link | preserve | conservatively refuse every current bmad-* link before installer invocation; no installer inventory is inferred |
| Alias | skills root/parent symlink to unrelated tree | no traversal | refuse named path |
| Preview | mixed links | no mutation; same classifications | report conflicts before installer |
</frozen-after-approval>
## Code Map
- `src/parity/rules.ts` -- classify literal retired-pack paths only when every existing raw source parent is a physical directory, checked before normalization (including components cancelled by `..`). Require `relative(root, target)` containment; allow an extra checkout component only under the registries-cache parent, never an arbitrary configured or legacy registry root. Conservatively refuse all current selected/receipt-owned `bmad-*` links before writes, including names not emitted by the pinned installer; this bounded safety policy does not infer installer inventory. Use the same plan for scaffold and version migrations.
- `tests/pjan-76-regressions.mjs` -- exercise refusals through scaffold/version CLI in preview, apply, and repeat; cover absolute/relative raw aliases, parent/prefix siblings, arbitrary nested checkouts, current noncolliding names, and valid relative/dangling/cache-checkout links. Assert unchanged project/link text and source/catalog bytes on refusal, with no sibling eviction. `tests/pjan-135-skill-roots-safety-regressions.mjs` -- retain selected-activation preflight refusal.
## Tasks & Acceptance
**Execution:**
- [x] `src/parity/rules.ts` -- classify literal symlink text against retired pack path, reject unknown conflicts and unsafe root aliases prior to any edits, dry-run parity; reuse for version migration.
- [x] `tests/pjan-76-regressions.mjs` -- real-entrypoint isolated link matrix, dry-run, repeat, unsupported roots and no implicit pin.
**Acceptance Criteria:**
- Given custom skill links outside retired pack, when scaffold migration runs, then links/targets survive and no retired-removal claim is made.
- Given retired pack links in canonical and every supported CLI root, when migration runs, then only proven symlinks are unlinked, including dangling ones, without changing targets.
- Given unsafe aliases or unknown conflicting links, when migrate or preview runs, then it names paths, refuses without deleting any unknown link, and dry-run is mutation-free.
- Given a clean second migration, when it runs, then it reports no retired-link cleanup.
- Given cold-cache init, when it runs, then BMAD comes from installer, no implicit pack selection, only seven supported CLI roots and ignored projections.
## Spec Change Log
- Independent SPEC and QUALITY review repros found that preserving a selected activation without blocking the installer overwrote its catalog bytes, and that a symlinked intermediate `packs/bmad` component spoofed retired provenance. The repair blocks both before installer or eviction. Keep legitimate absolute, relative, and dangling retired projections, seven CLI roots, and cold-cache init behavior.
- QUALITY round 2 reproduced a parent-directory registry escape and raw `alias/../catalog/...` normalization spoof through both scaffold and version. The repair requires actual relative containment and checks raw path components before applying `..`; only the registries-cache parent allows one checkout component. KEEP legitimate physical `..` traversal, relative/dangling projections, current-activation protection, no partial eviction, seven CLI roots, and cold-cache init. Parent scope clarification accepts conservative refusal for all current `bmad-*` links (including `bmad-html-workspace`); no emitted-name inventory/downloading architecture is part of this repair.
## Verification
**Prior repair record (not a fresh round-2 certification):** `npm run build`, `npm run typecheck`, `node tests/pjan-76-regressions.mjs`, `node tests/parity-migrate-regressions.mjs`, `node tests/pjan-135-skill-roots-safety-regressions.mjs` (28/28), `node tests/pjan-176-bmad-installer-skills-regressions.mjs` (10/10), and `node tests/bmad-version-surface-regressions.mjs` were previously reported passed. The round-2 results below supersede those gate claims for this environment. External reviewer approval remains pending.

### Round-2 repair evidence

Prior candidate: `9b545276478b1d924daa1b1aa4f3bc2f71272a86`. Production and permanent test changes were copied byte-for-byte into a git-archived scratch checkout at `/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/pjan76-round2-zqh_6340`; no operator cache, main checkout, board, deployment, or other repository was modified. Dependencies were linked read-only with a private scratch `node_modules/.cache`. Scratch-only fixture-location adjustments made `tests/helpers/hermetic-env.mjs` use configured TMPDIR and replaced hard-coded `/tmp` locations/ceilings in the skill-roots harness, safety suite, and installer-skills suite. These location-only edits are not delivery changes. The CommonProject `copier.yml` and template were archived from submodule `12cbdc7a80abc2f12ffabb58f03375dc0d074f84` (absolute activation links outside that payload were not extracted).

| Command | Real result |
|---|---|
| `env -u PJ_PROJECT_NOTEBOOK_SKILL_SOURCE -u PJ_PROJECT_NOTEBOOK_SKILL_ROOT -u PJ_SKILLS_REGISTRY_ROOT npm run build` | exit 0; all CLI bundles emitted; `project-notebook skill: verified tracked packed export` |
| `npm run typecheck` | exit 0, both scratch and worktree |
| `node tests/pjan-76-regressions.mjs` | exit 0; 51 checks: three existing checks plus 48 scaffold/version × absolute/relative × boundary cases, each preview/apply/repeat |
| `node --test-name-pattern='F14' tests/pjan-135-skill-roots-safety-regressions.mjs` | exit 0; 1/1 current activation/no sibling eviction safety check |
| `node tests/pjan-176-bmad-installer-skills-regressions.mjs` | exit 0; 10/10 |
| `node tests/pjan-208-bmad-pin-currency-regressions.mjs` | exit 0; all seven currency/init checks |
| `npm run test:bmad-installer-contract` | exit 0; real `bmad-method@6.12.1` core+bmm+bmb+cis project-name contract and pin-currency contract passed (npm stable 6.12.4) |
| `node tests/bmad-version-surface-regressions.mjs` | exit 0; active/default version surface passed |
| `node --check tests/pjan-76-regressions.mjs`; `git diff --check` | exit 0 |
| `node /home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/pjan76-round2-quality-boundaries.mjs` | exit 0; 36/36 blocked preview/apply/repeat outcomes for both rules, absolute/relative parent escape, cancelled alias, and direct alias; empty changedFiles, no retired-removal claim, project snapshots/link text/target bytes all preserved |

The independent boundary script was copied and adapted from the supplied QUALITY repro: expectations now require refusal for all scenarios, with relative-link and repeat coverage added. The original repro/output were left untouched. The new matrix against the prior production source failed 20 provenance cases (parent escapes, nested configured/legacy checkouts, cache-parent escapes, cancelled aliases across both rules/link forms) before adding the actionable-message assertion; valid relative/dangling/cache links passed in both baseline and repaired builds.

**Non-clean wider gates, reproduced unchanged on the prior candidate:**
- Full `node tests/pjan-135-skill-roots-safety-regressions.mjs`: exit 1, 23/28; identical five failed tests F1/A1, F11/D1, F15, F15/s5, and F15 CLI. The ticket-relevant F14 passed.
- `node tests/parity-migrate-regressions.mjs`: exit 1 at `preserve-hooks`; mise template execution invokes the real `op read`, which refuses with canonical service-account token unavailable (exit 78). No token was read or supplied; do not fabricate one to turn this gate green.
- `node scripts/check-hermetic-test-env.mjs`: exit 1 with the same pre-existing `tests/pjan-75-regressions.mjs:55` ungranted `PJAN75_CLI_BUILT` finding.

Logs are under the active profile scratch directory: `pjan76-round2-final-{build,typecheck,regressions,f14,installer-skills}.log`, `pjan76-round2-{currency,real-installer,safety,parity,baseline-regressions}.log`, `pjan76-round2-prior-{safety,parity,hermetic}.log`, and `pjan76-round2-quality-boundaries-output.json`. Independent re-review remains required; this is implementation/test evidence, not reviewer approval.

Final hash identity (worktree source equals exercised scratch source):
- `src/parity/rules.ts`: SHA-256 `82caaece7044f0a2bed3ee7415df7f4ec0242488a9d024db07e1c9a330a35c1c`
- `tests/pjan-76-regressions.mjs`: SHA-256 `f5d98c6804e9257650917bc12f6bc1c1af00e99dd790a3d14eca85bd39368243`
- exercised `dist/index.js`: SHA-256 `d1d781139a28ea710981ebd3f87bc301e036c91fef4cd4f4ed92630219640300`
