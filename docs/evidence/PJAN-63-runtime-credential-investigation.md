# PJAN-63 — Runtime credential investigation evidence

- Ticket: [PJAN-63](https://plane.delo.sh/33god/browse/PJAN-63/)
- Status: **partial investigation only; security remediation blocked; not closure evidence**.
- Fresh remote inspection: **2026-11-19 04:59:59–05:00:13 UTC**. Ignore fixtures: **05:01:48 UTC**. All advertised-tip tree check: **05:02:33 UTC**.
- Evidence branch: `PJAN-63-runtime-evidence`, based on pjangler `9a332e3e39fa7faa6af537d201550b6cf2af8577`.
- Worktree: `/home/delorenj/code/33GOD/pjangler/.worktrees/PJAN-63-runtime-evidence`.

## Conclusion and scope

The reported original runtime and commit remain unavailable. Fresh remote clones establish the currently advertised refs and bounded filename/tree results, **not** that historical credentials were purged, revoked, rotated, or safe to reuse. No replacement runtime or runtime safety branch was created.

This pass made no runtime, credential, profile, live configuration, schedule, service, board, or history changes. It did not provision `candybar-pm`, restart consumers, push to Candybar or its runtime remote, or test old credentials. The only intended published change is this redacted markdown in pjangler, pending independent review and landing. No secret values, runtime file contents, private-key material, or raw runtime payloads are included.

Both snapshots are bare repositories, without checkouts or submodule recursion. Inspection used ref, commit, object-existence and tree metadata. `git fsck` checked repository integrity; it is not a secret scanner. The only source blob extracted was Candybar's public root `.gitignore`, for the disposable fixtures. No runtime blob was displayed or checked out, and no broad blob/content secret scan was performed.

## Acceptance criteria disposition

The six criteria below follow the delegated PJAN-63 acceptance scope; this pass did not edit or independently re-read the board.

| AC | Required outcome | Disposition and evidence |
| --- | --- | --- |
| 1 | Identify the actual historical source and current runtime. | **BLOCKED.** The original path is absent; `edd7b71` resolves in neither fresh snapshot. The intended private remote exists, but its current `main` is not established as the original affected history or as a running consumer. Local profile/runtime discovery remains negative. See source observations and remote results below. |
| 2 | Preserve unique nonsecret work before isolated purge or clean replacement. | **BLOCKED.** Without the original object database/working copy, unique work cannot be inventoried or preserved. No purge, replacement, export of runtime work, or runtime branch was attempted. Fresh remote snapshots do not preserve unavailable local/unpushed work. |
| 3 | Verify complete outgoing secret-free history, `.env*` exclusions and no live runtime tracking. | **BLOCKED; bounded probes PASS.** No outgoing remediation history exists to certify. Candybar's current tip has no gitlinks, `.gitmodules`, or entries at the two runtime roots tested. `.env` and the named backup probes are ignored in both fixture modes. The full `.env*` grammar is **not** excluded: `.env.op`/`.env.template` are exceptions, while `.envrc`/`.environment` remain visible. Ignore rules do not remove tracked files or history. No content-wide secret-free claim is made. |
| 4 | Verify a fresh Candybar clone is safe, with no unsafe ref. | **BLOCKED for the full safety claim; metadata subchecks PASS.** Fresh bare clone and fsck succeeded, all seven advertised branch tips were inspected, and neither reported filename nor the reported commit was found within the inspected coverage. No known affected ref was identified there. This does not establish secret-free contents, purge success, or absence from hidden/deleted/unadvertised refs or objects. |
| 5 | Revoke/rotate every real credential, prove old credentials invalid and consumers healthy. | **BLOCKED / UNKNOWN.** No provider/secret-store revocation or rotation receipts, old-invalid tests, consumer migration receipts, or health checks were available or performed. The historical report names GLM, KIMI, HF, FAL, TINKER, WANDB and Slack and reports 23 live keys; neither that count nor present validity was independently verified here. |
| 6 | Provide redacted linked handback with independent code review. | **PARTIAL.** This record links the ticket and evidence branch and records reproducible metadata checks. Independent review, approval and landing remain pending with the parent/delivery worker. The investigator does not approve or merge this work. |

## Historical source and current local observations

Read-only filesystem/config-shape observations at **2026-11-19 05:01:48 UTC**:

| Probe | Observed result |
| --- | --- |
| `/home/delorenj/code/33GOD/candybar/agents/hermes/pm/runtime` | Absent; not a symlink. |
| `/home/delorenj/code/33GOD/candybar/.git/modules` | Absent. |
| `/home/delorenj/code/33GOD/.git/modules/agents/hermes/pm` | Exists; directory-entry count **0**. |
| `/home/delorenj/code/33GOD/candybar/runtime` | Absent. |
| `/home/delorenj/.hermes/profiles/candybar-pm` | Absent. |
| Candybar working `.project.json` | `agents` is an empty object; no other configuration values copied. |
| Candybar local `HEAD` | `6ae66b9a98487e14cdddfad29932c0f4098948fe`; matches fresh remote `main`. |
| Candybar working root `.gitignore` | Byte-equal to fresh remote `HEAD:.gitignore`. |

These were checked using `pathlib.Path.exists()`, `is_symlink()`, directory-entry counting for existing directories, a JSON comparison of `agents` to `{}`, and `git -C /home/delorenj/code/33GOD/candybar rev-parse HEAD`. No live runtime files were opened. A parent-reported earlier `flume roster candybar-pm --json` returned `NOT_FOUND`; that roster command was **not rerun** in this pass. The fleet skill was quarantined and was not read via an alternate path; no fleet mutation was attempted.

The historical report identifies `.env.bak-20260524-124132` and `.env.bak-20260524-124141` in purported unpushed history near `edd7b71`. Neither missing paths nor a changed/current remote can establish what happened to that original local history.

## Fresh remote snapshots

The local Candybar `origin` was allowlist-verified as `git@github.com:delorenj/candybar.git`. GitHub metadata confirmed both repositories are not archived and default to `main`; Candybar is public and `agent-hm-candybar-pm` is private. Authentication used installed GitHub/SSH auth with noninteractive SSH; no authentication values were printed or exported.

| Result | Candybar | Intended runtime remote |
| --- | --- | --- |
| Remote | `git@github.com:delorenj/candybar.git` | `git@github.com:delorenj/agent-hm-candybar-pm.git` |
| Clone coverage | All advertised branch refs; no tags advertised | `main` only, `--single-branch --no-tags`; only `main` advertised |
| Clone start UTC / exit | `05:00:00.750091` / **0** | `05:00:09.101787` / **0** |
| `HEAD` / `refs/heads/main` | `6ae66b9a98487e14cdddfad29932c0f4098948fe` | `203374bfe20ce252218fd9acbe3e09d26bb63315` |
| Branches / tags advertised | **7 / 0** | **1 / 0** |
| Before/after advertisement | Identical | Identical |
| `git fsck --full --no-reflogs` | **exit 0**, stdout/stderr **0 lines**; start `05:00:01.666618 UTC` | **exit 0**, stdout/stderr **0 lines**; start `05:00:11.453053 UTC` |
| Reachable commits / unique root trees inspected | **332 / 331** | **11 / 11** |
| `cat-file -e 'edd7b71^{commit}'` | **exit 128** | **exit 128** |
| `rev-parse --disambiguate=edd7b71` | **0 matching objects** | **0 matching objects** |

Advertised Candybar refs, preserved exactly:

| Ref | Full object ID |
| --- | --- |
| `refs/heads/docs/cand-51-finite-schedules` | `fa548d4178e56a85cf5f20f7018606cb932ec79c` |
| `refs/heads/fix-policy-local-only` | `8adf45de45b0ba579ecaaffde7bf47623c9beb0d` |
| `refs/heads/fix-steward-notification-noise` | `4b735f498d478667efc7e709ae3f1ac5aabb8421` |
| `refs/heads/fix-target-watch-selftest-noise` | `20613df44c24682bf2f6b7ecf5abb751579e6081` |
| `refs/heads/fix/cand-53` | `7495136cf8c805b1d085a3e5980102267823181c` |
| `refs/heads/fix/cand-53-followup` | `f2b14404d27f8cf7e6e4b7f0ab6bfbcb87c4b922` |
| `refs/heads/main` | `6ae66b9a98487e14cdddfad29932c0f4098948fe` |

The runtime advertised only `refs/heads/main`, at the full ID above. Clone ref maps matched the inspected advertisements. `HEAD` was symbolic to `refs/heads/main` in both clones. Ref advertisements were queried for `HEAD`, `refs/heads/*` and `refs/tags/*`, **not** pull-request, hidden, deleted or arbitrary server refs.

At Candybar's current `HEAD`, recursive tree metadata counted **0 gitlinks**, **0 `.gitmodules` declarations**, **0 entries at/under `agents/hermes/pm/runtime`**, and **0 at/under root `runtime`**. Repeating those four counts for each of its seven advertised branch tips also returned **0** for every count. This is a path/declaration test, not a search for all possible live/private state locations.

### Named-file tree inventory (counts only)

Every unique root tree reachable from the cloned refs was listed recursively, with exact basename equality against the two reported files. Counts below do not disclose other runtime paths, object payloads or secret values.

| Snapshot | Reported basename | Matching unique paths | Matching blob IDs | Trees with match | Commits with match |
| --- | --- | ---: | ---: | ---: | ---: |
| Candybar, all cloned refs | `.env.bak-20260524-124132` | 0 | 0 | 0 | 0 |
| Candybar, all cloned refs | `.env.bak-20260524-124141` | 0 | 0 | 0 | 0 |
| Runtime, `main` | `.env.bak-20260524-124132` | 0 | 0 | 0 | 0 |
| Runtime, `main` | `.env.bak-20260524-124141` | 0 | 0 | 0 | 0 |

At **05:01:50.261319 UTC**, `gh api repos/delorenj/agent-hm-candybar-pm/commits/edd7b71` returned **CLI exit 1 / HTTP 422**, message `No commit found for SHA: edd7b71`. This is a failed lookup, not a proof of deletion, purge or rotation. No full canonical ID for the historical prefix could be recovered.

**Coverage limit:** these negative results apply to the available cloned refs and objects, not to missing local/unpushed history, old clones, reflogs, alternate object stores, GitHub retention, hidden refs, or all possible filenames/secret encodings. Absent filenames are not proof of absent secrets anywhere.

### Executed command record

The following aliases abbreviate exact paths used in the executed command argv. Set up used `umask 077`. The scratch parent, run directory and both bare snapshot top-level directories were verified mode **0700**. Raw runtime repositories/receipts remain restricted scratch only, never committed or uploaded. Scratch is temporary and may be pruned; the durable handback is this record, not a promise of permanent snapshot retention.

```sh
R=/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/pjan63-evidence/20261119T045826Z
C="$R/candybar.git"
H="$R/runtime.git"

# Metadata (each exit 0); Candybar origin verification also exit 0.
git -C /home/delorenj/code/33GOD/candybar remote get-url origin
gh api repos/delorenj/candybar --jq '{full_name,private,archived,default_branch,ssh_url}'
gh api repos/delorenj/agent-hm-candybar-pm --jq '{full_name,private,archived,default_branch,ssh_url}'

# Each ls-remote ran before and after its clone, with exit 0 and identical output.
git ls-remote --symref git@github.com:delorenj/candybar.git HEAD 'refs/heads/*' 'refs/tags/*'
git clone --bare git@github.com:delorenj/candybar.git "$C"
git ls-remote --symref git@github.com:delorenj/agent-hm-candybar-pm.git HEAD 'refs/heads/*' 'refs/tags/*'
git clone --bare --single-branch --branch main --no-tags git@github.com:delorenj/agent-hm-candybar-pm.git "$H"

# Applied separately to C and H. All exit 0 except cat-file, which exits 128.
git --git-dir "$C" rev-parse HEAD
git --git-dir "$C" symbolic-ref HEAD
git --git-dir "$C" for-each-ref '--format=%(refname) %(objectname)'
git --git-dir "$C" fsck --full --no-reflogs
git --git-dir "$C" ls-tree -r -z HEAD
git --git-dir "$C" cat-file -e 'edd7b71^{commit}'
git --git-dir "$C" rev-parse --disambiguate=edd7b71
git --git-dir "$C" rev-list --all --format=%T
# For each distinct root-tree ID emitted above: ls-tree -r -z <tree-id> (exit 0).
# Later: for-each-ref --format=%(refname), then ls-tree -r -z <ref> for every ref.
# The same argv pattern with H in place of C was executed for the runtime.
git --git-dir "$C" show HEAD:.gitignore
# Expected failed historical lookup: CLI exit 1, HTTP 422.
gh api repos/delorenj/agent-hm-candybar-pm/commits/edd7b71
```

Python subprocess capture held tree output in memory and reduced it to counts. Inventory used `rev-list --all --format=%T`, deduplicated tree IDs while retaining commit multiplicities, split `ls-tree -r -z` entries at the first tab, and compared the final path component to each exact reported basename. It did not search blob contents. Snapshot collection scripts exited **0**; the expected failing historical commit probes were recorded separately, not relabeled as successful lookups.

## Disposable environment-ignore fixtures

At **05:01:48 UTC**, `git -C /home/delorenj/code/33GOD/candybar config --show-origin --path --get core.excludesFile` exited **0** and resolved `file:/home/delorenj/.gitconfig` to `/home/delorenj/.agents/git/ignore`.

Two new mode-0700 disposable fixture repositories used byte-identical copies of fresh Candybar `HEAD:.gitignore` (SHA-256 `7ea18beaec0e1987b33463d8d9db6b0875b274f4fcc4a95c176f405ec0cb9a23`):

1. `ignore-repository_only`: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `git -c core.excludesFile=/dev/null` to verify portable repository rules without machine help.
2. `ignore-effective_machine`: normal installed Git configuration, including the resolved global excludes, to verify effective behavior on this machine.

Both started with empty indexes and created only empty probe files (no environment values). For each row, actual commands were:

```sh
# F is respectively "$R/ignore-repository_only" or "$R/ignore-effective_machine".
# Repository-only mode adds the environment/config isolation described above to each Git argv.
git -C "$F" init --quiet
git -C "$F" check-ignore --no-index -q -- "$probe"
git -C "$F" check-ignore --no-index -v -- "$probe"
git -C "$F" ls-files --others --exclude-standard -z
```

The quiet command's exit code and actual untracked visibility determine ignored/not-ignored status. Verbose output can exit **0 for a negation rule**, so verbose exit alone was not treated as proof of exclusion. Every visibility assertion passed; the fixture script exited **0**.

| Probe | Repository-only / effective-machine quiet exit | Ignored in both? | Winning repository rule |
| --- | --- | --- | --- |
| `.env` | 0 / 0 | Yes | `.gitignore:2` — `.env` |
| `.env.bak-PJAN-63` | 0 / 0 | Yes | `.gitignore:3` — `.env.*` |
| `.env.bak-20260524-124132` | 0 / 0 | Yes | `.gitignore:3` — `.env.*` |
| `.env.bak-20260524-124141` | 0 / 0 | Yes | `.gitignore:3` — `.env.*` |
| `.env.production` | 0 / 0 | Yes | `.gitignore:3` — `.env.*` |
| `nested/.env` | 0 / 0 | Yes | `.gitignore:2` — `.env` |
| `nested/.env.bak-PJAN-63` | 0 / 0 | Yes | `.gitignore:3` — `.env.*` |
| `.env.op`, `nested/.env.op` | 1 / 1 each | No | `.gitignore:4` — `!.env.op` |
| `.env.template`, `nested/.env.template` | 1 / 1 each | No | `.gitignore:5` — `!**/.env.template` |
| `.envrc`, `.environment` | 1 / 1 each | No | No matching rule |

Across **13 paths × 2 modes**, each mode had **7 ignored** and **6 visible** probes. All matched/negated probes reported the repository `.gitignore` as the winning source, not the global file. This does not certify nested overrides in a real working tree, all possible `.env*` spellings, the unavailable original runtime's ignore policy, or absence of already tracked credentials. The full acceptance requirement remains pending rather than being silently narrowed to these passing examples. No ignore policy was changed.

## Handback and remaining gates

- Evidence record: [branch copy](https://github.com/delorenj/pjangler/blob/PJAN-63-runtime-evidence/docs/evidence/PJAN-63-runtime-credential-investigation.md); [review diff](https://github.com/delorenj/pjangler/compare/9a332e3e39fa7faa6af537d201550b6cf2af8577...PJAN-63-runtime-evidence). These are branch links; use the immutable commit ID in the delivery receipt for review pinning.
- **Source-owner action required:** locate the original unpushed runtime object database/working copy or establish an independently supported disposition of it. Do not fabricate a clean replacement or call the current remote a purge of unknown history. Preserve authorized nonsecret unique work before any destructive remediation.
- **Security-owner action required:** establish the actual credential inventory and provide redacted revocation/rotation, old-invalid and consumer-health receipts. Do not place key values in Git, tickets or this record. A history rewrite cannot revoke a credential.
- **Implementation gate:** only after provenance and authorization are established, perform isolated preservation/remediation and verify the entire intended outgoing history and agreed ignore contract, not just two filenames.
- **Independent delivery gate:** parent/reviewer must inspect this exact evidence commit, verify its claims and single-file scope, and arrange landing. No independent review, merge, approval, ticket completion or security remediation is asserted by this record.

The shared pjangler checkout began on `main` with unrelated modified `_bmad-output/implementation-artifacts/bloodbank-events.jsonl` and untracked `runtime/`. Neither was read for payloads, staged, committed, stashed, reset, removed, or included in this evidence branch. No shared-checkout branch switch, rebase or history rewrite was used. The evidence branch is an investigation handback, not a runtime remediation branch.
