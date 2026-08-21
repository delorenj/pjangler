# Evidence: PJAN-78 — Prevent self-referential skill fanout symlink cycles

## Issue

- Ticket: PJAN-78
- Plane state: Completed
- Worker: Codex
- Trigger: Drumjangler Vite OOM caused by a repo-root Toad skill being linked back inside the Toad repository.

## Acceptance Criteria

1. Fanout rejects a proposed skill link when its destination is inside the resolved source directory.
2. A catalog symlink that resolves to the current repository root is rejected identically.
3. The complete proposed topology is checked before any destination directory or skill link mutation.
4. Every link is checked again at its mutation boundary.
5. Existing cross-repository fanout and the canonical real managed-directory case continue to pass.

## Repo Changes

- CommonProject `4d1b8dd`:
  - `template/.mise/scripts/sync-skills.py` adds the recursive source/destination topology guard.
  - `tests/test_sync_skills_topology.py` adds direct repo-root and catalog-alias regression fixtures.
- PJangler advances `templates/commonproject` from `36ea890` to `4d1b8dd`.

## Verification

- CommonProject focused topology suite: 10/10 passed.
- CommonProject full Python suite: 24 passed, 6 skipped.
- PJangler TypeScript typecheck: passed.
- PJangler build: passed.
- PJangler focused CommonProject topology suite: 10/10 passed.
- PJangler test chain passed lock parity, package-lock parity, submodule contract, tracked-secret gate, release/security/BMAD transaction/parity/fanout suites through the PJAN-57 dogfood fixture.
- Full PJangler suite baseline gap: current `mise` rejects the unrelated PJAN-57 fixture's quoted `[[hooks.enter]]` TOML before later suites run.
- `git diff --check`: passed in CommonProject.
- PJangler pins the guard on published `main` at `ff29bfc`; Drumjangler installs
  the byte-identical generated script at `fddcc86`.
- Toad was removed from the 33GOD component registry and submodule graph at
  `8a04200`; its self-projection was removed from the recovery repository at
  `dd66ae6` and its Skillex catalog projections at `23eeccf`.
- A target-string sweep across active code, CLI, Hermes, HeyMa, and user skill
  roots removed 64 runtime-only projections and then reported zero remaining
  links into the retired Toad checkout.
- The live Drumjangler Vite process remained HTTP 200 after more than 44 minutes;
  the final 60-second sample showed bounded RSS rather than the former rapid
  climb to OOM. TypeScript and the production Vite build also passed.

## Ledger Update

- Bloodbank evidence event: `88da80ff-f59c-4fce-ae78-3c8710b2139b`.
- Bloodbank close-gate event: `621c041b-d518-466d-8f9f-f58d8e6e5f66`.
- Ledger updated: yes

## Known Gaps

- The full PJangler chain still stops at the unrelated existing PJAN-57 fixture
  because the installed `mise` rejects that fixture's quoted
  `[[hooks.enter]]` TOML. All fanout, security, parity, typecheck, build, and
  focused topology checks complete before that baseline failure.

## Close Recommendation

- Close recommendation: ready
- Rationale: the source guard, consumer pin, live projection sweep, and real
  runtime proof are complete; no Toad link remains in the audited active roots.
