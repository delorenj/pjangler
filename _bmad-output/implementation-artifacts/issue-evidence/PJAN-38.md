# Evidence: PJAN-38 — Remove tracked authentication artifacts and add publication secret gate

## Issue
- Ticket: PJAN-38
- Milestone / horizon: pjangler consolidation and release safety
- Worker: bloodbank_gateway_recon / delegated implementation agent
- Orchestrated by: momo

## Acceptance Criteria
1. Remove the tracked review and session artifacts containing raw signed JWTs from the repository tip.
2. Fail publication truthfully and without value leakage when the Git index, differing tracked worktree, or npm package payload contains high-confidence JWTs or credential-bearing review/session artifacts.
3. Accept safe environment-variable and `op://` references while failing closed on scan infrastructure errors.
4. Cover prior adversarial bypasses including merge-conflict index stages, populated gitlinks, read failures, hostile filenames, quoted and unquoted assignments, case variants, punctuation-bearing values, and post-build package content.
5. Preserve published history and ignored runtime credentials during this reversible tip-hardening increment.

## Repo Changes
- Branch: feature/PJAN-38-secret-publication-gate (base 15397d986227f7599ae4775bd76ae47091bda266 → head d79f7842f837b9e623d71da4fb50c7d6133a6384)
- Files changed:
  - `.gitignore` — excludes repository-local review and session artifacts that can carry credentials.
  - `package.json` — wires the scanner into tests and runs build before the final prepublication scan.
  - `scripts/check-tracked-secrets.mjs` — scans Git state and the exact npm dry-run payload with sanitized, fail-closed results.
  - `tests/secret-publication-gate-regressions.mjs` — exercises the acceptance and adversarial matrix.
  - `review.md` — removed credential-bearing tracked artifact.
  - `sessions/2026/06/07/rollout-2026-06-07T15-30-48-019ea390-fdc8-7a93-a8c1-95aec7444c7e.jsonl` — removed credential-bearing tracked artifact.
- Migrations / schema: none

## Verification
- Commands executed and results:
  - `node tests/secret-publication-gate-regressions.mjs` → passed the focused adversarial matrix.
  - `node scripts/check-tracked-secrets.mjs` → passed with 809 tracked/package paths and no value output.
  - `npm test` in a disposable clone with both template submodules populated → passed; PostgreSQL coverage reported its existing truthful environment skip.
  - `npm run typecheck` → passed.
  - `npm run build` → passed with no unintended bundle drift.
  - `npm run prepublishOnly` → built first and scanned the final payload successfully.
  - `git diff --check` → passed.
  - Fresh Gate 1 by `pjan38_spec_final` → spec compliant.
  - Fresh Gate 2 by `pjan38_quality_final` → approved with no critical, important, or minor findings.
- AC → evidence mapping:
  - AC1 → both unsafe tracked paths are absent and the tip contains zero high-confidence JWT matches.
  - AC2 → scanner plus adversarial fixtures cover index, worktree, package, gitlink, filename, assignment, and post-build cases.
  - AC3 → safe `.npmrc` and `.env.op` references remain accepted; infrastructure failures return status 2.
  - AC4 → three independent specification reviews and two quality reviews reproduced then closed every reported bypass.
  - AC5 → no history rewrite, credential rotation, submodule pointer movement, or ignored runtime mutation occurred.

## Ledger Update
- Bloodbank decision/events emitted: `ce8ec06d-edb6-48d2-afec-7a622917e19f`, `6658f9c8-9b4a-403a-bc57-6190a28da0cc`, `84597bb2-107e-4cdd-9625-f733c530ed4d`, `0f3cde92-8eac-403a-af03-b0941c41f85a`
- Ledger updated: yes

## Known Gaps
- Published Git history retains expired artifacts from older commits. This ticket removes them from the branch tip and prevents ordinary recurrence; rewriting shared history requires separate authorization.
- The scanner is a focused publication gate rather than a replacement for layered tools such as gitleaks.

## Close Recommendation
- Close recommendation: ready
- Rationale: the clean ticket branch removes the unsafe tip artifacts, passes the complete adversarial matrix, and has independent specification and quality approval.
