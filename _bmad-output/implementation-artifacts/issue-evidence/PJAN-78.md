# Evidence: PJAN-78 — Prevent self-referential skill fanout symlink cycles

## Issue

- Ticket: PJAN-78
- Plane state: In Progress
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

## Close Recommendation

- Ready after the PJangler submodule-pin commit is pushed and the live Toad loop sweep verifies zero remaining filesystem cycles.
