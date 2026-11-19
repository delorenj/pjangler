# PJAN-105 retirement evidence

Scoped deletion of the three named legacy PM paths only. Baseline and after checks are in [machine inventory](PJAN-105-inventory.json). No Plane mutation by this implementer.

## Remote publications and live checkouts

| Repository | main commit | original main | other worktrees |
|---|---|---|---|
| TonnyBox | [f2a5ea278513](https://github.com/delorenj/HeyMa-Satellite/commit/f2a5ea278513d8b15401f20ff5a190b31cd1280c) | absent + preserved | none |
| sidepiece | [b38e1e7f17d4](https://github.com/delorenj/sidepiece/commit/b38e1e7f17d4ffa5aab07883c3c1adddc09bf661) | absent + preserved | none |
| KeepyMoney | [e92e7978971a](https://github.com/delorenj/keepy-money/commit/e92e7978971a1b18fd5cfffa705762f05be8b4e0) | absent + preserved | published `worktree-finance-contract` [dd81efc20502](https://github.com/delorenj/keepy-money/commit/dd81efc2050262dc3e3222f908eb59871b403eed) |
| skillex | [3dd14bd17620](https://github.com/delorenj/skillex/commit/3dd14bd17620cb5911846cc7a401432ed72fe3d7) | absent + preserved at delivery; root later became bare | published `skillex-integration-pilot` [37e48f787069](https://github.com/delorenj/skillex/commit/37e48f78706991d2c7d780e3cd4cf2198bfe7d4b) and `fix/skrill20-native-cutover` [a790f488f3c0](https://github.com/delorenj/skillex/commit/a790f488f3c092ad6b8a93ae655bdc4c1426d259); exact previously blocked cleanup commits now preserved on [PJAN-105-recover-standalone](https://github.com/delorenj/skillex/tree/PJAN-105-recover-standalone) (`fbbd28351599`) and [PJAN-105-recover-retire-mise](https://github.com/delorenj/skillex/tree/PJAN-105-recover-retire-mise) (`6404fef79e16`); original branches unchanged |
| holocene | [c6f5ac176e83](https://github.com/delorenj/holocene/commit/c6f5ac176e834a944ee01bbf8b3312863fcd5ec0) | absent + preserved | none |
| voxxy | [d2acbee8c4f5](https://github.com/delorenj/voxxy/commit/d2acbee8c4f5902c2d5f74d80b8a12726a1efb4c) | absent + preserved | published `feat/voxxy-1-telegram-clone` [21c6b3cc0695](https://github.com/delorenj/voxxy/commit/21c6b3cc0695f3a87dab555e8eec8d54ffb0d1be) |
| gruvato | [1a06891d2eaf](https://github.com/delorenj/gruvato/commit/1a06891d2eafa1505f40e7af2a2bb1faa488b388) | absent + preserved | published `gruv-189-copy-gate` [116d43881851](https://github.com/delorenj/gruvato/commit/116d438818513dcd131ee3358a874c4e8c3a2574) |

## Verification

- Live original worktrees passing all legacy-absence and canonical/index/runtime preservation checks: **12**. Fleet-wide clean claim: **False**; see explicit concurrent-state blockers below.
- KeepyMoney runtime directory hashes, modes, inode/mtime metadata checked before/after, including the finance-contract branch. Unrelated dirt retained unchanged at scoped delivery checkpoints.
- Remote `ls-remote` refs verified for every row marked published; no force push, no hook bypass. Main branches and published non-main branches are durable.
- `intelliforia-voice-agent` is a negative filesystem check (non-Git, no PM scaffold). Historical stemjangler/drumjangler names resolve to gruvato based on commits `6d08bcbc`, `ad6e997f`, `7f9b494b`.
- Unowned ~/.config/zshyzsh and ~/.cache/skillex-adr0002 are outside named ~/code fleet scope; not touched.

## Disposable Flume refresh

- Ran `flume remediate hermes.pm-scaffold <fixture> --scripts-only --json` dry-run and twice live on a disposable TonnyBox copy; a missing script was restored, no named legacy path appeared, and all files outside `.scripts` stayed byte/metadata-identical. The tool reports `partial`/exit 1 post-migration because its comprehensive check also sees existing missing runtime/profile/soul/registry metadata in isolated fixture; the scripts-only operation explicitly does not modify those.
- A second fixture copied current Flume template scripts and performed a dry-run and one live refresh; missing heartbeat was restored and no legacy path appeared. Post-migration comprehensive check returned `partial` (five non-script fixture deviations). This is a status limitation, not an assertion of whole-repo parity. Exact diagnostics are in JSON.

## Independent quality review

The separate read-only reviewer (session `b13615e6-5045-5e1c-b887-3d389d1f54dd`) verified all seven main and five non-main remote refs, deletion-only diffs within the three authorized paths, unchanged canonical snapshots, and KeepyMoney runtime metadata preservation (15 main entries and 644 finance-contract entries). It independently repeated the current-Flume missing-heartbeat fixture: heartbeat restored, no legacy path returned, outside-script state unchanged; comprehensive fixture parity remained `partial` for five explicitly unrelated deviations. Its verdict at review was **partial: AC6 failed because two cleanup commits were unpublished**. [Preserved independent output](PJAN-105-independent-review.json) is attributed to that reviewer, not this recovery worker.

The reviewer also reproduced inherited `GIT_DIR` escaping nested test fixtures during linked-worktree push hooks, changing fixture shared bare config/HEAD; a standalone-clone control did not. Recovery therefore used standalone disposable clones after initial linked-worktree dependency setup, without changing the real Skillex bare config.

## Bounded publication recovery — 2026-11-19

- Both exact objects are now remote: [standalone `fbbd28351599`](https://github.com/delorenj/skillex/commit/fbbd28351599300f1df61995b1488fb12d7f4357) on `PJAN-105-recover-standalone`, and [retire-mise `6404fef79e16`](https://github.com/delorenj/skillex/commit/6404fef79e1608c23ac5cfd440d96a445d654726) on `PJAN-105-recover-retire-mise`. `ls-remote` returned those exact hashes; the original branch refs were not pushed or overwritten.
- `npm ci` and `uv sync --locked` succeeded in clean isolated checkouts; TypeScript was installed. Standalone clone setup used the repository's normal `lefthook install`. Exact `all-skills` gitlinks were then initialized successfully (`f706512212de` standalone, `89e046495fc2` retire-mise). No lockfiles, application code, tests or hook definitions changed.
- **Important gate qualification:** each ordinary `git push --set-upstream origin HEAD:refs/heads/PJAN-105-recover-…` returned 0 and invoked installed normal pre-push hooks, but Lefthook skipped its jobs with `no matching push files`. This proves archive durability, **not passing tests**. No hook-disable variables, `--no-verify`, config bypass, or force push were used.
- To eliminate that skip, explicitly ran `lefthook run pre-push --force` (select every configured job, not a Git force push). After complete setup, standalone Node reported **1,333 passed / 0 failed / 1 skipped**, Ruff and mypy passed; Python reported **15 failed / 962 passed / 5 skipped**, then its configured last-failed retry still failed all 15. Failures are three resync installer layout assumptions and twelve existing alias tests. [Exact full gate output](PJAN-105-recovery-standalone-full-gate.txt).
- Retire-mise Node reported **923 passed / 1 failed / 1 skipped**; `tests/node/resolution.test.mjs`'s outside-project auto-target test reads the surrounding home manifest and reports `W_SCOPE_MISMATCH` / `E_PACK_MISSING`. Ruff and mypy passed. Python reported **15 failed / 913 passed / 5 skipped**, in the same resync-layout/alias families. [Exact full gate output](PJAN-105-recovery-retire-mise-full-gate.txt).
- [Recovery receipt](PJAN-105-recovery.json) preserves commands, actual push output, remote readbacks, gate summaries and log SHA-256s. [Original machine inventory](PJAN-105-inventory.json) remains an immutable earlier checkpoint, so its historical `published: null` values are superseded only by this recovery receipt.

## Remaining owner gates

- **Do not claim full acceptance.** The two deletion commits are no longer local-only, but original-branch reconciliation and non-green owner test gates remain. The reviewer has not reviewed this follow-up, and board lifecycle remains with parent PM. If AC6 requires original branch publication rather than durable archive publication, it remains unmet.
- The original Skillex root still reports bare; recovery did not change its config. `33GOD-35-mcp-standalone` still points to `fbbd28351599`; the concurrent `skillex-retire-mise` tip remains `d0c3406a6330`, a descendant of cleanup `6404fef79e16`. Do not replace it with the archive's older tip.
- **Owner/executable next step:** Skillex owner can use preserved isolated clones under `/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/PJAN-105/recovery-{standalone,retire-mise}` with locked dependencies and exact gitlinks already installed. Resolve the baseline resync-layout/alias failures and retire-mise resolution-scope assumption, rerun `lefthook run pre-push --force`, then reconcile the original branches while preserving concurrent commits. No unrelated fixes were attempted here.
- The missing `/tmp/skillex-wip1` and unowned `~/.cache/skillex-adr0002` worktrees remain untouched/excluded.

## Cleanup and final durability check

[Cleanup receipt](PJAN-105-cleanup.json) records normal non-force removal of all seven clean, remote-main-landed `PJAN-105-legacy-retirement` worktrees/branches plus both clean, remote-archive-landed recovery worktrees/branches. All original target worktrees were retained. The evidence worktree is removed only after this report is pushed to main.

Ran `git unpushed` bounded to all seven touched fleet roots plus pjangler. Relevant remaining warnings are the original standalone branch's missing upstream and retire-mise's 21 commits ahead of its old upstream; the cleanup commits themselves are reachable on the new remote archive refs. Unrelated dirt and submodule-detached warnings were neither changed nor incorporated. Final pjangler evidence publication is scoped exclusively to `docs/evidence/PJAN-105*`; no board edits.
