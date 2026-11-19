---
title: PJAN-105 scoped fleet legacy-tree retirement
type: chore
created: 2026-11-19
status: in-review
baseline_commit: ee51ca74fa74d2f1e435621142f79c11ff2f4f25
context: []
---

## Intent and authorization

Remove only `agents/hermes/pm/.scripts/scrum-master/**`, `75-scrum-master.sh` and `90-chain-scrum-master.sh` from the named ~/code fleet and its present registered worktrees. The active PJAN-105 ticket and PM delegation explicitly authorize exact removal, fresh isolated main-based candidates, normal fast-forward publication, and path-only commits on existing original branches. No additional approval/board mutation is delegated. Independent acceptance review remains with the parent, not this implementer.

## Boundaries

Preserve canonical sentinel/scaffold/configuration bytes, file modes and nonlegacy index entries. Keep all unrelated staged, working and untracked data. Retain KeepyMoney's `agents/hermes/scrum-master/runtime` in place and seal read-only hashes and metadata before/after, including the historical finance-contract worktree. Do not provision live profiles, modify SOUL, remove role settings (PJAN-106), restart services, delete runtime repositories/submodules, rewrite history, change shared branches, stash/reset/rebase or force-push. Exclude ~/.config/zshyzsh and ~/.cache/skillex-adr0002; do not claim all-machine cleanup. Missing/prunable worktrees are explicit inventory dispositions, not inferred cleanups.

## Code map

- `/home/delorenj/code/{TonnyBox,sidepiece,KeepyMoney,skillex,voxxy,gruvato}` and `/home/delorenj/code/33GOD/holocene`: affected repositories; inspect each registered worktree separately.
- `gruvato` history `6d08bcbc09872f2d1675ba754b57122895620c32`, `ad6e997ff0872cd0607e46f906a95c80c265ec26`, `7f9b494b52d208446902d3e852922f6c901c106e`: two historical clones of stemjangler/drumjangler, later Gruvato; old paths no longer exist.
- `/home/delorenj/code/intelliforia-voice-agent`: negative filesystem check; non-Git, no PM directory.
- `flume/packages/flume-hr/src/parity/rules.ts:3214-3284`: owning refresh reads current template scripts, `--scripts-only` skips soul/wrapper/runtime/registry operations. Current Flume source correction unnecessary if template inspection and real refresh prove no legacy restoration.
- `/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/PJAN-105`: task-private inventories, run logs and disposable fixture. No other profile writes.

## Execution

1. Freshly fetch origin/main, inspect worktree/Git hooks, inventory paths/index/dirt/process CWDs and remote branch ancestry.
2. Create PJAN-105 own worktrees at fresh origin/main; run `git pull --no-rebase origin main` clean and verify merge scope before deletions.
3. Delete only explicit paths; `git add -- <paths>` and `git commit --only -- <paths>`; verify deletion-only diff, canonical/index hashes and normal remote publication.
4. Integrate published commit into clean main via fast-forward; dirty main may receive the exact path-only commit with original publication metadata, preserving staging. Stop if parent/tree differs.
5. Recheck original non-main branch active CWDs, dirty legacy paths and remote ancestry, then commit exact deletions on that branch without merging its unrelated history into main; push branch normally. Stop unsafe target only.
6. Exercise `flume remediate hermes.pm-scaffold <disposable-fixture> --scripts-only --json` and check refresh cannot restore any legacy path. Verify no outside-scripts mutation and repeat for convergence.
7. Publish before/after inventories, scoped diffs, raw checks, links and blockers as PJAN-105 evidence only on a fresh pjangler branch; normal fast-forward to main.

## Acceptance and verification

- Given every historical name and registered worktree, when inventoried, then its actual current path, absent/renamed mapping or inaccessible gap is explicit.
- Given an affected target reported complete, when checking `lstat`, filesystem traversal and `git ls-files`, then all three legacy scopes are absent, including original live checkouts rather than only candidate branches.
- Given runtime/canonical/index and unrelated dirt snapshots, when cleanup completes, then all protected content, modes and index IDs match; live data that changes independently is explained, not silently normalized.
- Given current Flume template and disposable fixture, when supported scripts-only refresh runs twice, then legacy scopes remain absent and no deployed soul/profile/service/registry is changed.
- Given tracked changes, when publishing, then every changed branch is durable remotely through normal permission/gates, or a precise rejection/divergence/hook blocker and retained candidate is reported.
- Given handback, when independently reviewed later, then evidence distinguishes implemented/tested/published from unresolved targets and non-task parity drift. Application code does not change, so enormous app suites are not needed absent a repository-enforced hook.
