# Evidence: PJAN-29 — Provision BMAD through the Skillex versioned pack

## Issue
- Ticket: PJAN-29
- Milestone / horizon: current pjangler init repair
- Worker: Codemaster Zigzag / worker agent
- Orchestrated by: Taskforce Kraken / momo

## Acceptance Criteria
1. Fresh `pj init` ships and invokes a resolvable project-local skills sync engine without tilde or host PATH reliance.
2. `.agents/skills.json` records BMAD 6.10.2 as canonical object entries with `name` and `file://` source.
3. `.agents/skills/bmad-*` entries are resolving symlinks into the selected versioned Skillex pack rather than copied trees.
4. Non-BMAD project skills and manifest entries survive provisioning and migration.
5. A regression executes fresh source and npm-packed installs, compares their required outputs, and covers filesystem boundary attacks.

## Repo Changes
- Branch: feature/PJAN-29-skillex-init (base 4615d6c16ef7c3042c84c6a23c166898eec7487f → head 78e894cb5b5a931ccb0f0a1501aba888755bc926)
- Parent commits:
  - `81190b4` — versioned-pack provisioning and source/installed regression
  - `8925de1` — self-contained project-local sync engine
  - `c4402ac` — filesystem containment and URI hardening
  - `78e894c` — hermetic normal suite and explicit mise integration
- CommonProject commits:
  - `4f2f45d` — versioned-pack provisioning
  - `5f60264` — project-local sync engine
  - `960eafe` — filesystem boundary hardening
- Files changed:
  - `src/parity/index.ts` — pinned pack manifest, guarded symlink normalization, executable parity
  - `templates/commonproject` — gitlink to the repaired CommonProject source
  - `tests/parity-migrate-regressions.mjs` — migration, preservation, and attack-boundary coverage
  - `tests/skillex-init-regressions.mjs` — fresh source/packed parity and integration coverage
  - `package.json` — focused regression in the standard suite
  - `dist/index.js`, `dist/mcp-server.js` — rebuilt runtime bundles
  - CommonProject `copier.yml`, `template/mise.toml.jinja`, and `.mise/scripts/*.py` — generated provisioning contract
- Migrations / schema: none

## Verification
- Commands executed and results:
  - `node tests/skillex-init-regressions.mjs` → passed with a temporary pack and no host mise requirement
  - explicit real-pack plus mise integration mode → passed against `/home/delorenj/code/skillex/packs/bmad/6.10.2`
  - `node tests/parity-migrate-regressions.mjs` → passed
  - `npm test` → passed, including a run with a failing mise shim first on PATH
  - `npm run typecheck` → passed
  - `npm run build` → passed and regenerated bundles match source
  - parent and CommonProject `git diff --check` → passed
  - Gate 1 by Sir Fix-a-Lot → spec compliant
  - Gate 2 by Bartholomew the Builder → approved with no findings
- AC → evidence mapping:
  - AC1 → packed fresh init contains and executes `.mise/scripts/sync-skills.py` through `config_root`
  - AC2 → source and packed manifests contain the same 75 BMAD object entries for version 6.10.2
  - AC3 → all 75 BMAD links resolve into the selected pack; copied and broken entries heal
  - AC4 → `project-custom` and adversarial sentinels survive repeated provisioning
  - AC5 → the focused regression executes source and installed CLI paths and blocks traversal, remote URI, and symlink-parent attacks

## Ledger Update
- Bloodbank decision/events emitted: see `_bmad-output/implementation-artifacts/bloodbank-events.jsonl`
- Ledger updated: yes

## Known Gaps
- CommonProject commits are local and must be published before the parent gitlink is safe to push.
- No functional acceptance gap remains in the local branch.

## Close Recommendation
- Close recommendation: ready
- Rationale: all locked acceptance criteria pass source, packed-install, adversarial, and independent review gates.
