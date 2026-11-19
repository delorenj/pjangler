# PJAN-166 isolated candidate — Contract A audit and metadata gate

Base: main `7ec15e12f520104849be5429d4e177e3bdae30fb`. Branch: `PJAN-166-contract-a-review`. Ticket remains In Progress; this branch is not integrated. Hermes trust onboarding (AC4) is explicitly excluded.

## Authority and acceptance matrix

| Scope | Evidence / disposition |
| --- | --- |
| AC1/2 source, version, config and help authority | Existing [`PJAN-166-config-authority-trace.md`](PJAN-166-config-authority-trace.md) records real 6.12.1 installer/BMB observations and the TOML runtime and manifest/help authority. No production rewrite needed. |
| Config formats and consumers | Existing Contract A requires config.toml and both resolver scripts; module YAML or the matching consolidated YAML section, but not core/config.yaml. `pjan-166-config-authority-regressions` passed 2/2 with the setup-scripts suite on this branch. |
| Setup, repeat, migration | `npm run test:bmad-config-authority` passed: real pinned installer through `pj migrate`, installed BMB skill's real three setup scripts, audit, repair, three setup/repair rounds, real-tree sentinel deletions and attested scripts-only recovery. No project, service or profile was installed/updated. |
| Existing/clone preservation | Existing structural regressions cover protected BMB files, manifest-removal diagnosis, missing ignored scripts, g33 withholding, foreign symlinks/hardlinks and recovery. Source does not turn a missing installer record into a pass; repair uses installer. Fresh target and surviving-config shape exercised in the real contract. |
| Metadata test gap | Baseline full runner failed the first-scripts boundary assertion even though `npm view bmad-method@6.3.1-next.13 version --json` returned `"6.3.1-next.13"`. The broad `npm view bmad-method versions --json` list is not a reliable oracle in that execution. Candidate checks exact versions next.12 and next.13 from npm, then checks both real packages' `src/scripts` inventories; focused runner passed. |
| Independent review | **Pending.** Do not integrate without a fresh independent SPEC and QUALITY review at this pushed SHA. |

## Gate receipts

- Baseline full runner, before metadata change: `/home/delorenj/.claude/tmp/pjan166-baseline-full.log` — exit 1; 126 attempted, 121 passed, 5 failed (`check:hermetic-test-env`, `bmad-version-surface-regressions`, `pjan-166-bmad-setup-scripts-regressions`, `pjan-167-g33-companion`, `pjan-196-suite-env-canary`). Other failures were present on base main and are not repaired by this scoped candidate. The PJAN-167 failure is separately owned.
- Focused normal runner, after change: `/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/pjan166-focused.log` — exit 0; typecheck/build succeeded; both PJAN-166 suites passed (2/2).
- Real upstream contract: `/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/pjan166-real-contract.log` — exit 0, real installer and BMB scripts, three rounds.
- Separate direct baseline-suite reproduction: `/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/pjan166-metadata-probe.log` — exit 0 when run standalone; broad-list failure is intermittent/contextual, not evidence that the release is unpublished.

The full runner remains red for four unrelated base failures; the baseline log includes the fifth PJAN-166 failure now covered by the focused green gate. No claim of all-suite green or rollout is made. Scratch logs are local, not committed; this matrix is the durable branch receipt.
