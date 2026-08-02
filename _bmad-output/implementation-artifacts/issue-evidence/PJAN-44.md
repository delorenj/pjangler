# Evidence: PJAN-44 — Clear PJAN-43 release baselines and publish patch

## Issue
- Ticket: PJAN-44
- Milestone / horizon: PJAN-43 release follow-through
- Worker: /root/pjan44_baseline_repair (Codex) with /root/pjan44_hermes_payload (Codex)
- Orchestrated by: momo

## Acceptance Criteria
1. npm lock parity is restored and a clean `npm ci` succeeds.
2. CommonProject and Hermes pins are remotely reachable before the parent gitlinks ship.
3. PostgreSQL registry coverage passes against a disposable database without touching shared services.
4. The full release gate covers secrets, submodules, typecheck, build, tests, package contents, dependency audit, and version parity.
5. One patch bump keeps package, lock, CLI, MCP, release commit, annotated tag, remote main, and registry version aligned.
6. The exact inspected tarball is pushed and published through a recoverable release transaction.
7. A clean consumer install proves the published CLI, MCP, audit, and migration behavior.

## Repo Changes
- Branch: release/PJAN-44-baseline-publish (base e26b52bd53d56fd0b7be14315d71ce775001a03e -> release ec01574ef22fdec4228d5ad8eb0eeaed0cc40bc1)
- Files changed:
  - `package-lock.json` and `package.json` — restored dependency/version parity, removed production audit findings, and bumped once to 1.2.25.
  - `.mise/scripts/release.sh`, `mise.toml`, and `docs/deployment-guide.md` — added a clean, exact-tarball, recoverable GitHub Packages transaction under Node 24.6/npm 11.
  - `tests/pg-registry-regressions.mjs` — honored `PGPORT`, made release coverage strict, disabled self-test bypass, and stopped on SQL errors.
  - `scripts/check-submodule-contract.mjs` and regressions — rejected nested CodeGraph/Omo runtime payloads without blocking legitimate template sessions.
  - `src/parity/index.ts`, tests, and `dist/` — made failed BMAD projection rollback safe on Node 24.
  - `templates/hermes-agent` — advanced to 7e5c2f3ce3164429b9c78fbe2157b70a62b8ee3f after removing tracked host-runtime files.
- Migrations / schema: test-only schema creation and migration ran in a disposable PostgreSQL 17 container, then the container was removed.

## Verification
- Commands executed and results:
  - `npm ci`, `npm run typecheck`, `npm run build`, and full `npm test` under Node 24.6/npm 11 -> pass.
  - Full `npm test` under the normal Node 26 path -> pass.
  - `npm audit --omit=dev` -> zero vulnerabilities.
  - `npm run check:submodules -- --remote --recursive --archive --npm` -> pass against CommonProject 35a7eb0 and Hermes 7e5c2f3.
  - Strict PG harness on a random loopback port -> `PG_STORE_CHECK_OK` and `pg-registry-regressions OK`; the shared host cluster was excluded.
  - `.mise/scripts/release.sh --dry-run` with disposable PG -> complete pass through exact-tarball publish simulation.
  - Live release -> `ec01574`, annotated `v1.2.25`, remote main/tag parity, and `@delorenj/pjangler@1.2.25` registry verification.
  - Fresh scoped-registry install -> manifest, `pj --version`, and MCP initialize response all report 1.2.25; private Hermes payload hits are zero.
  - Published CLI on disposable HeyMa clone -> audit executed; migration applied safe rules and preserved the real `CLAUDE.md` by returning the designed unsafe-topology hold.
- AC -> evidence mapping:
  - AC1 -> lock parity gate and clean install pass.
  - AC2 -> prerequisite mains were pushed first and the recursive remote/archive gate passes.
  - AC3 -> two strict round trips passed in the disposable container and live databases were excluded.
  - AC4 -> full dry-run plus independent quality review passed with no critical, high, or medium findings.
  - AC5 -> package, lock, CLI, MCP, release commit, annotated tag, remote main, and registry all resolve to 1.2.25/ec01574.
  - AC6 -> exact tarball shasum `0f81fd3031e32f98d9e7dcf6375b4eb1b8a8fbf3` published after atomic main/tag push.
  - AC7 -> fresh package installation, MCP handshake, payload privacy check, audit, and disposable migration were executed.

## Ledger Update
- Bloodbank decision/events emitted: opening decision `2e3324bb-9f60-40f2-86ec-c7ab9f922b86`; close-gate and autonomous-review events follow this evidence commit.
- Ledger updated: yes

## Known Gaps
- The PG harness uses a PID-scoped scratch database name; a random suffix and signal cleanup would further reduce stale scratch risk after abrupt process termination.
- `--resume-push` validates tag placement and remote absence; an explicit annotated-object assertion would add another low-risk defense.

## Close Recommendation
- Close recommendation: ready
- Rationale: every release baseline, publication step, and installed-consumer proof is complete with independent adversarial approval.
