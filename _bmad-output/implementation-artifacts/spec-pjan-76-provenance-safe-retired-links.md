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
| Current | selected Skillex activation or receipt-owned link | preserve | refuse installer collision if it would write there |
| Alias | skills root/parent symlink to unrelated tree | no traversal | refuse named path |
| Preview | mixed links | no mutation; same classifications | report conflicts before installer |
</frozen-after-approval>
## Code Map
- `src/parity/rules.ts` -- classify literal retired-pack paths only when every existing source parent is a physical directory; a symlinked intermediate registry component is unknown provenance. Treat current selected/receipt-owned `bmad-*` links as installer collisions and refuse before writes; use the same plan for scaffold and version migrations.
- `tests/pjan-76-regressions.mjs` -- exercise both refusals through the real CLI in apply and preview, preserving links and catalog/personal target bytes. `tests/pjan-135-skill-roots-safety-regressions.mjs` -- update the selected-activation contract to require preflight refusal and no sibling eviction.
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
## Verification
**Passed:** `npm run build`, `npm run typecheck`, `node tests/pjan-76-regressions.mjs`, `node tests/parity-migrate-regressions.mjs`, `node tests/pjan-135-skill-roots-safety-regressions.mjs` (28/28), `node tests/pjan-176-bmad-installer-skills-regressions.mjs` (10/10), and `node tests/bmad-version-surface-regressions.mjs`. Both independent scratch repro scripts now report blocked preview/apply, unchanged links and unchanged selected/personal target bytes. External reviewer approval remains pending.
