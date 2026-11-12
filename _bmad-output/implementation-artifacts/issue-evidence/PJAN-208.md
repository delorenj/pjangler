# Evidence: PJAN-208 — BMAD installer pin rots again: a newer upstream stable must not fail a project at the verified pin

## Issue
- Ticket: PJAN-208
- Milestone / horizon: n/a (board bug, high)
- Worker: momo workflow wf_13b9b9fa-76b implementer (Claude Code general-purpose subagent, automaticai/auto/orchestrator), finishing an unreviewed Hermes pjangler-dev draft (3bd55af) that was rescued from the main checkout and reverted
- Orchestrated by: momo

## Acceptance Criteria
1. Reproduce (or refute, with evidence) the fresh-init postcondition failure on the current pin in an isolated fixture.
2. Fix the cause: upstream currency ('behind stable') is advisory; it must not fail a project whose installed version matches the verified pin; a real failure is kept for an unverified or mismatched install.
3. Optionally bump the pin to 6.12.4, only through the verified-installer path.
4. Add a regression in which a newer upstream stable exists and fresh init still succeeds.

## Repo Changes
- Branch: PJAN-208 in `.worktrees/PJAN-208`, squashed and landed on main (base cdf2e4f → head 5d86a50). The worktree and branch were removed locally and on origin.
- Files changed:
  - `src/parity/rules.ts` — the unpinned `bmad.version` audit returns an advisory `pass` (fixable:false) when installed == BMAD_INSTALLER_VERSION and the stable release is newer. The newer stable stays in the summary and details. Installs behind or ahead of the pin keep the fixable `warn`, and a transaction-pinned mismatch still fails. The PJAN-82 skip and pass branches are unchanged. The stale pin comment is corrected.
  - `tests/pjan-208-bmad-pin-currency-regressions.mjs` — new hermetic suite. Its stable version is derived from the pin plus three patch releases, so it cannot rot when the pin moves.
  - `scripts/run-tests.mjs` — registers the suite.
  - `tests/bmad-installer-contract-regressions.mjs` — audits the real pinned install against the real npm registry and asserts an advisory pass.
  - `tests/pjan-57-lifecycle-recipes-regressions.ts` — states the pin vs non-pin split instead of the old warn expectation.
- Migrations / schema: none

## Verification
- Commands executed and results:
  - AC1 reproduction, built from origin/main bf2c4b0 in an isolated HOME/TMPDIR with live npm dist-tags (latest 6.12.4):
    - create `pj init` → exit 0;
    - `pj audit` → warn "6.12.1 is behind stable 6.12.4";
    - sync `pj init --target-dir <same project> -y` → exit 1. bmad.version upgraded 6.12.1 → 6.12.4 off the verified pin, then the postcondition failed on bmad.setup-scripts, bmad.cli-roots and skills.project-manifest.
    - Control, with the dist-tags cache seeded stable == pin → sync init exit 0.
  - The same scenario on the fixed build → create exit 0; audit "matches the verified installer pin; stable 6.12.4 is newer (advisory)"; sync init exit 0 with selectedParityRules [] and the manifest still 6.12.1.
  - `npx tsc --noEmit` → exit 0.
  - `node scripts/check-hermetic-test-env.mjs` → ok (111 registered suites start from the preamble).
  - `heavy node scripts/run-tests.mjs` on the final rebased tree → attempted 113, passed 113, failed 0.
  - `npm run test:bmad-installer-contract` (real network) → pass: "pin 6.12.1, npm stable 6.12.4, advisory pass".
  - `mise run bmad:verify-surface 6.12.4` → exit 0 (fingerprint already in VERIFIED_BMAD_INSTALLERS).
  - Mutation: reverse-applying the fix fails 2 checks in the new suite (audit warn, sync init exit 1). The fix was restored byte-identical.
  - Independent spec-compliance review → PASS (minors only). Independent code-quality review → PASS (minors only).
- AC → evidence mapping:
  - AC1 → refuted as written: create-mode init passes because it pins bmad.version. The real failure, reproduced above, is sync-mode init, which migrates the fixable warn to the unverified stable and then fails its own postcondition.
  - AC2 → the rules.ts advisory pass, plus the pjan-208 suite cases: pin-matching audit pass; sync init selects no bmad.version migration and runs no installer; behind-pin and between-pin-and-stable installs still warn and are fixable; a create init whose installer lands a different version still fails and rolls back.
  - AC3 → deliberately not bumped. A build with the pin at 6.12.4 turned bmad.setup-scripts red on every existing 6.12.1 project, and sync init on 6.12.4 did not converge (skills.project-manifest, bmad.cli-roots). That is evidence for keeping the optional bump out.
  - AC4 → the pjan-208 suite (sync init succeeds with stable three patches ahead), plus the real-registry assertion in the installer contract.

## Ledger Update
- Bloodbank decision/events emitted: see bloodbank-events.jsonl (PJAN-208 no-duplicate-dispatch decision, worktree rescue decision, close decision)
- Ledger updated: yes

## Known Gaps
- The real-installer half of the new AC4 network check could not execute in the reviewer's environment (GitHub API 403 rate limit while the 6.12.1 installer cloned bmb). The implementer ran it green.
- The network contract hard-codes the pin literal separately from BMAD_INSTALLER_VERSION (pre-existing).
- A project at the pin now reports `pass`, so a newer stable is visible only in the summary text. This is deliberate and matches the PJAN-82 prerelease precedent.
- A pin bump to 6.12.4 waits on the PJAN-166 setup-scripts round 2 (byte attestation). After that lands it is a separate, verified-path change.

## Close Recommendation
- Close recommendation: ready
- Rationale: the real failure (sync init chasing an unverified stable) is reproduced, fixed at the rule, and pinned by mutation-proven regressions; both independent reviews PASS; landed on main as 5d86a50 with 113/113.
