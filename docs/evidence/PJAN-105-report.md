# PJAN-105 retirement evidence

Scoped deletion of the three named legacy PM paths only. Baseline and after checks are in [machine inventory](PJAN-105-inventory.json). No Plane mutation by this implementer.

## Remote publications and live checkouts

| Repository | main commit | original main | other worktrees |
|---|---|---|---|
| TonnyBox | [f2a5ea278513](https://github.com/delorenj/HeyMa-Satellite/commit/f2a5ea278513d8b15401f20ff5a190b31cd1280c) | absent + preserved | none |
| sidepiece | [b38e1e7f17d4](https://github.com/delorenj/sidepiece/commit/b38e1e7f17d4ffa5aab07883c3c1adddc09bf661) | absent + preserved | none |
| KeepyMoney | [e92e7978971a](https://github.com/delorenj/keepy-money/commit/e92e7978971a1b18fd5cfffa705762f05be8b4e0) | absent + preserved | published `worktree-finance-contract` [dd81efc20502](https://github.com/delorenj/keepy-money/commit/dd81efc2050262dc3e3222f908eb59871b403eed) |
| skillex | [3dd14bd17620](https://github.com/delorenj/skillex/commit/3dd14bd17620cb5911846cc7a401432ed72fe3d7) | absent + preserved | excluded unowned cache /home/delorenj/.cache/skillex-adr0002; UNPUSHED: hook rejected `33GOD-35-mcp-standalone` local `fbbd28351599`; published `skillex-integration-pilot` [37e48f787069](https://github.com/delorenj/skillex/commit/37e48f78706991d2c7d780e3cd4cf2198bfe7d4b); UNPUSHED: hook rejected `skillex-retire-mise` local `6404fef79e16`; published `fix/skrill20-native-cutover` [a790f488f3c0](https://github.com/delorenj/skillex/commit/a790f488f3c092ad6b8a93ae655bdc4c1426d259) |
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

## Remaining delivery blockers

- Two original skillex branches have scoped deletion-only commits at their delivery checkpoints but their normal Git pre-push hooks refused publication: `33GOD-35-mcp-standalone` fails `npm test` build because its local `node_modules/typescript/bin/tsc` is missing; `skillex-retire-mise` reports 24 failed, 21 errored, 883 passed, 5 skipped in existing test suite. The full hook output and commit hashes are in task-private delivery log and the machine inventory. Hooks were not disabled; neither remote branch was updated. `33GOD-35-mcp-standalone` still points to its local commit; the other branch was concurrently replaced, so that commit is no longer its tip.
- Concurrent activity changed `/home/delorenj/code/skillex` to a bare repository after its original main delivery snapshot (Git `status` now refuses `this operation must be run in a work tree`); it cannot be reverified as a live checkout. `skillex-retire-mise` HEAD changed from the task commit after the hook rejection and its nonlegacy index changed independently; stop this target rather than reverting or overriding the other writer. Baseline/per-delivery snapshots preserve the checkpoint evidence, not a claim about current state.
- A prunable `/tmp/skillex-wip1` worktree has a missing location and was never changed. The detached/unowned `/home/delorenj/.cache/skillex-adr0002` worktree is excluded.
- Independent quality review and board lifecycle remain with parent PM.
