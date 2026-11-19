# PJAN-64 — Historical runtime recovery investigation

- Ticket: [PJAN-64](https://plane.delo.sh/33god/browse/PJAN-64/).
- **Outcome: missing-source blocker; no historical publication candidate.** This is investigation evidence, not recovery completion or a secret-free certification.
- Investigation: **2026-11-19 05:21–05:30 UTC**; remote collection **05:24:08–05:26:58 UTC**; bundle readback **05:29:30 UTC**.
- Evidence branch: `PJAN-64-runtime-evidence`, based on public pjangler `c9dcbbca384db5a5aae49190d6a0c49fbff662b5`.
- Isolated worktree: `/home/delorenj/code/33GOD/pjangler/.worktrees/PJAN-64-runtime-evidence`.

## Findings and acceptance gates

The verified private runtime remote retains the reported old `main` tip and all its ancestors. The detached tip reported to contain 470 unique commits was not found in the bounded sources below. A current remote snapshot cannot replace that unavailable original or establish its disposition.

| AC | Required result | Current disposition |
| --- | --- | --- |
| 1 | Locate actual historical source/archive and remote; prove a separate Git root; account for both originals. | **PARTIAL / BLOCKED.** Remote identity and an isolated bare root are verified. The old main history is preserved. The detached original remains missing; its 470 unique commits and the reported four main-only commits cannot be independently counted against it. |
| 2 | Preserve recoverable sources before changes; isolate live writers. | **PARTIAL.** All currently advertised remote history is retained in a mode-0700 bare snapshot and a verified mode-0600 bundle, with independent bare readback. No live runtime was copied, checked out, stopped or changed. The missing detached source cannot be preserved yet. |
| 3 | Preserve both histories' unique commits; verify reachability, content and conflict resolution. | **BLOCKED.** Ten ancestors including the old main tip are reachable from current remote main. Detached-side reachability, its unique set, content comparison and conflict resolution remain unverified. No merge or replacement history was invented. |
| 4 | Complete outgoing credential/private-state review, safe nondestructive publication only to verified runtime remote, fresh verification. | **BLOCKED / NOT ATTEMPTED.** No historical publication occurred or is authorized by this record. Metadata and integrity checks are not content review. The entire prospective outgoing history, including private state and credentials, still needs review after source recovery and independent approval. |
| 5 | Preserve ignored/untracked runtime policy; no checkpoint, gitlink, submodule or schedule. | **PARTIAL; existing policy gap.** Canonical role runtime is ignored and untracked; checkpoints are declared disabled and no matching user checkpoint/backup units were listed. Root `runtime/` is untracked **but not ignored**, confirmed in both fixture modes. No policy, wiring, schedule or service was changed. Existing unrelated submodule metadata remains untouched. |
| 6 | Short redacted linked provenance, remote readback and policy evidence, independently reviewed. | **PREPARED FOR REVIEW.** Only this document is a delivery artifact. Independent review and eventual main landing remain pending. A landed investigation record must not be treated as completed recovery. |

## Provenance and bounded local discovery

Both reported runtime directories exist but have no `.git` entry. Running `git rev-parse --show-toplevel` inside either resolves to `/home/delorenj/code/33GOD/pjangler`, **not** to a separate runtime repository. Commands accidentally inherited from that parent cannot prove recovery of the runtime history.

The following were read-only metadata probes; unrelated repository names, private filenames and payloads are intentionally omitted:

| Bounded source | Coverage / result |
| --- | --- |
| pjangler `.git/modules` | One retained object-store candidate. |
| parent 33GOD `.git/modules` | Nine direct retained object-store candidates. The specifically reported `agents/hermes/pm` module directory is empty. |
| Nested `modules/` below discovered stores | Two additional object stores, for **12 total**. Each was checked; no origin matched the verified runtime remote. |
| pjangler `.git` and parent 33GOD `.git` | Both additionally probed for the two reported prefixes; neither prefix resolved. |
| All 12 retained module stores | `rev-parse --disambiguate` exited **0** with **0 objects** for each reported prefix, after explicitly overriding obsolete worktree configuration. |
| Project `backups/` and `.backups/` | Absent. |
| Active profile `backups/` | Two directories, five files, maximum depth one; **0 archive files / 0 object stores**. File payloads were not opened. |
| Active profile approved scratch | 21 earlier PJAN-64-named files, no ticket-named repository/archive; no full historical IDs or archive references were recovered from these receipts. Top-level archive metadata scan: **712 entries / 0 archive-shaped files**. |

Module discovery bounded each walk to depth 10 and 2,000 directories, did not follow symlinks, and recursively inspected a discovered repository's own `modules/` directories. No bound was exceeded. Initial direct module-prefix probes for four stores exited 128 because retired `core.worktree` targets were absent; repeating **all** store probes with `--work-tree` set to restricted scratch returned the valid negative results above. These negative results do not cover arbitrary disk locations, other machines/profiles, external backups, GitHub hidden/deleted refs, or unavailable owner-held archives.

No arbitrary home-wide search or backup mount was used for source discovery. No approved external archive location was supplied. The source owner must identify the original object database or an authorized archive if it lies outside this bounded set. The separately required installed `git unpushed` helper unexpectedly produced a machine-wide Git metadata inventory rather than a repository-local result (exit 1, this evidence branch initially had no upstream); that inventory was not treated as recovery evidence or authority to inspect unrelated locations.

## Independently verified remote and preserved main history

The tracked role manifest names `agent-hm-pjangler-pm` but leaves the owner blank. Reading only the relevant legacy template configuration field confirmed `github.runtime_repo_owner` is `delorenj`. GitHub API identity was then independently checked **before** cloning; the clone URL came from that validated response, not from a conjectured publication command.

| Metadata / check | Observed result |
| --- | --- |
| Verified runtime repository | `delorenj/agent-hm-pjangler-pm`, GitHub repository ID **1259794375**, private, not archived, default branch `main` |
| Verified SSH URL | `git@github.com:delorenj/agent-hm-pjangler-pm.git` |
| Advertised `HEAD` | Symbolic to `refs/heads/main` |
| Advertised refs | **1 branch / 0 tags**, with identical before/after advertisements and identical cloned ref map |
| `HEAD` / `refs/heads/main` | `49e31a79a211e38935aa545897fc4d10144c12bc` |
| Reported old main prefix resolved as commit | `5c7d3928b3172bcc7efc2d5dc781afffc28a80cb` |
| Reachable current commits / unique root trees | **13 / 13** |
| Old main ancestor count, including itself | **10** |
| `merge-base --is-ancestor <old-main> main` | **exit 0** |
| `rev-list --count <old-main>..main` / `main..<old-main>` | **3 / 0** |
| Detached prefix `fabf1c0` | `cat-file -e 'fabf1c0^{commit}'`: **exit 128**; disambiguation: **0 matching objects** |
| GitHub detached-prefix lookup | CLI **exit 1 / HTTP 422**, no commit found; not proof of deletion or purge |
| `fsck --full --no-reflogs` | **exit 0**, stdout/stderr **0 lines** |
| `fsck --full --no-reflogs --unreachable` | **exit 0**, stdout/stderr **0 lines** |
| All locally available objects in snapshot | **883**: 13 commits, 236 trees, 634 blobs, 0 tags |

The full detached-tip ID remains unknown; no guessed expansion is recorded. The historical **470 detached-only / 4 main-only** counts are retained as reports, not promoted to fresh measurements. Although all ancestors of the old main tip are present, selecting its four supposedly unique commits requires the missing detached graph.

Clone coverage was all advertised branches/tags, queried specifically as `HEAD`, `refs/heads/*` and `refs/tags/*`. It did not query pull-request, hidden or deleted refs. No arbitrary SHA fetch or historical checkout was attempted.

### Restricted preservation and executable checks

All source receipts and private snapshots remain under the active profile's scratch only:

```sh
R=/home/delorenj/.hermes/profiles/pjangler-pm/cache/scratch/pjan64-recovery/20261119T052249Z
G="$R/runtime-remote.git"
B="$R/advertised-runtime.bundle"
V="$R/bundle-readback.git"
```

The `pjan64-recovery` parent, run directory and both bare roots were verified mode **0700**. Snapshot regular files have no group/other permissions; the snapshot has no object alternates or symlinks. The bundle is **14,442,498 bytes**, mode **0600**, SHA-256 `1b28b8cabf0bbdfda2046ac7a098631767bf9615afadb5e2f439b2135b7d7bbd`. A local file-hash manifest covers 21 snapshot files excluding the repository config. Scratch may be pruned after inactivity; this is a retained investigation snapshot, **not** a new durable backup scheme. Preserve it through an owner-approved private retention mechanism if needed; do not upload it as an evidence artifact.

Executed preservation commands, all exit **0** (SSH was noninteractive with strict host-key checking):

```sh
# Identity was validated before the URL below was used.
gh api repos/delorenj/agent-hm-pjangler-pm \
  --jq '{full_name,id,private,default_branch,archived,ssh_url}'
git ls-remote --symref git@github.com:delorenj/agent-hm-pjangler-pm.git HEAD 'refs/heads/*' 'refs/tags/*'
git clone --bare --no-hardlinks git@github.com:delorenj/agent-hm-pjangler-pm.git "$G"
# Repeat ls-remote; compare exact advertisements and cloned ref maps.
git --git-dir "$G" rev-parse --is-bare-repository
git --git-dir "$G" rev-parse --absolute-git-dir
git --git-dir "$G" fsck --full --no-reflogs
git --git-dir "$G" bundle create "$B" --all
git --git-dir "$G" bundle verify "$B"
git clone --bare --no-hardlinks "$B" "$V"
git --git-dir "$V" fsck --full --no-reflogs
```

Both bare roots were proven distinct from the project root. Readback fsck produced zero stdout/stderr lines; its `HEAD`, ref map and complete reachable commit set matched the original snapshot. Private collector/receipt filenames include `collect_remote.py`, `remote-snapshot.json`, `historical-analysis.json`, `bundle-preservation.json`, `snapshot-file-manifest.json`, `discovery-locations.json`, `retained-probes.json`, `nested-module-probes.json` and `ignore-fixtures.json`. They are local investigation aids, not public artifacts, and are not included in this commit.

Metadata inventory listed every unique reachable root tree recursively, reducing results to counts without printing paths or opening blobs: **0 gitlinks, 0 `.env`/`.env.*` basename entries, 0 narrowly credential-named basename entries, 19 database-shaped basename occurrences across trees**. These are repeated tree-entry counts, not unique files, and do not establish what the blobs contain. No historical blob content scan, credential-validity test or private-state adjudication was performed. Neither absence of particular filenames nor fsck supports the old no-secrets claim.

## Runtime policy readback

- `agents/hermes/pm/role.yaml` declares checkpoint cadence `disabled` and `on_session_end: false`; its legacy GitHub identity is explicitly metadata-only.
- `agents/hermes/pm/.gitignore` ignores `runtime/`. Actual canonical runtime: quiet check-ignore **exit 0**, **0 index entries**, no separate `.git` marker.
- Actual root `runtime/`: quiet check-ignore **exit 1**, **0 index entries**; it remains visible as untracked. **This contradicts an all-runtime-ignored assertion and remains an explicit policy gap.** No content was opened or staged, and this evidence-only pass did not amend ignore rules or ownership.
- Two disposable scratch repositories copied the exact root and role `.gitignore` files: repository-only mode suppressed global/system configuration and effective-machine mode retained normal configuration. Both created only empty probes. In both modes canonical runtime was excluded and root runtime was visible; quiet-ignore exit and actual `ls-files --others --exclude-standard` visibility agreed for all nine probes.
- In both fixtures `.env`, `.env.bak-PJAN-64`, `.env.template` and `.env.example` were ignored; `.env.op`, `.envrc` and `.environment` were visible. The full `.env*` grammar is not uniformly excluded, and ignore rules never purge existing history.
- No runtime gitlinks or tracked runtime entries exist at either tested root. The project has one **unrelated existing** gitlink and a tracked `.gitmodules`; its contents do not name either runtime path or the runtime repository. They were not changed.
- Read-only `systemctl --user list-unit-files` exited **0**, with **0 pjangler checkpoint/backup-named units**. This is bounded unit-name evidence, not proof about every scheduler. No schedule was created or modified. PJAN-14 backup scope remains separate; Flume retains runtime-wiring ownership.

No live gateway, profile, database, credentials, process or service state was modified. Consequently no database or consumer-health claim is made and no invasive health probe was needed. Snapshot writers are isolated from live runtime writers by bare remote fetch and bundle readback, not by stopping a live process.

## Review handoff and executable next step

- Review only [this evidence branch](https://github.com/delorenj/pjangler/blob/PJAN-64-runtime-evidence/docs/evidence/PJAN-64-runtime-history-recovery.md) and its [single-file diff](https://github.com/delorenj/pjangler/compare/c9dcbbca384db5a5aae49190d6a0c49fbff662b5...PJAN-64-runtime-evidence). Pin the immutable evidence commit supplied in the worker receipt. No runtime payload is a publication candidate.
- **Concrete missing-source request:** provide the original runtime Git object database containing `fabf1c0`, or an explicitly authorized backup/archive location preserving that commit and ancestors. Include provenance/date and any alternates; do not transmit credentials or dump runtime contents into a ticket. Do not manufacture a clean replacement.
- On an authorized isolated copy, first run metadata-only `git --git-dir "$SOURCE" --work-tree "$R" rev-parse --disambiguate=fabf1c0` and `cat-file -e 'fabf1c0^{commit}'`; preserve a self-contained restricted snapshot before reconciliation. Resolve both full tips and measure `rev-list --left-right --count <detached>...<old-main>` before claiming the reported 470/4 split.
- Separately resolve the root-runtime ignore-policy gap through the delegated owner and reviewed exact-path change, without reading, deleting, moving or tracking live state.
- Only after both originals are available: verify reachability and tree/blob content, review **all** prospective outgoing commits for credentials/private state, resolve conflicts explicitly, and obtain independent approval before any historical publication. A later publication must remain nondestructive, target only the reverified runtime remote, and be followed by fresh isolated fetch/fsck/reachability verification.
- Parent/reviewer owns board actions and eventual reviewed evidence landing on main. This investigator makes no approval, merge, recovery-complete or historical-publication claim.

The shared checkout began on `main` with unrelated modified `_bmad-output/implementation-artifacts/bloodbank-events.jsonl` and untracked `runtime/`. No unrelated work was staged, committed, stashed, reset, rebased or switched. Only this exact markdown path is authorized for the evidence commit.
