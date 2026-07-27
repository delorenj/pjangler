# Evidence: PJAN-21 — v8 terminal-review remediation

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent implementation base:
  `224a59fc4cf14b2215a3fbf9f151e4df58f63a86`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes implementation:
  `1aae4c9d9cf9e134b40365fe5593713aa05ae667`
- Hermes feature ref:
  `refs/heads/feature/PJAN-21-post-loop-main`
- Hermes remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`

## Acceptance Criteria

1. Reject credential-shaped substrings anywhere in a normalized repository
   identity before fingerprinting or persistence, with identical standard
   Draft 2020-12 and runtime acceptance.
2. Terminate and reap every provider descendant before finalization or comment
   lock release on success and failure, including `setsid` children and
   reparented double-fork descendants.
3. Use one genuinely cross-user host-global at-most-once lock domain that is
   immune to predictable `/var/tmp` namespace precreation, symlink redirection,
   ownership splits, hash collisions, and stale files without persisting
   repository, credential, issue, marker, or protected values.
4. Preserve every earlier accepted exact-three-decision, final checkpoint,
   schema/runtime parity, durability, root/store binding, malformed-byte,
   provider typing, pagination, bounded-I/O, idempotency, render, privacy, and
   portability guarantee.

## Repo Changes

- Hermes commit `1aae4c9d9cf9e134b40365fe5593713aa05ae667`
  changes exactly these paths relative to
  `14e4865efb691bcbb1e48d8b1277b99dd78ecfbc`:
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `template/.scripts/sentinel/schemas/run-retro.v7.schema.json`
  - `tests/test_run_retro_contract.py`
- The parent advances only the `templates/hermes-agent` gitlink from
  `14e4865efb691bcbb1e48d8b1277b99dd78ecfbc` to
  `1aae4c9d9cf9e134b40365fe5593713aa05ae667`, this evidence file, and
  Bloodbank implementation/close-gate events.
- Provider adapters, package manifests, lockfiles, CommonProject, tasks, live
  boards, both main branches, tags, releases, and unrelated files are unchanged.

## Verification

- Both complete v8 reviewer rollouts were read through their terminal
  `task_complete` records. The specification reviewer held parent
  `224a59fc4cf14b2215a3fbf9f151e4df58f63a86` and Hermes
  `14e4865efb691bcbb1e48d8b1277b99dd78ecfbc` for embedded credential-shaped
  repository labels, successful-provider detached descendants, and per-UID
  lock partitioning. The quality reviewer independently reproduced the per-UID
  split, foreign precreation denial, and timeout double-fork escape.
- Five deterministic v8 tests were added before runtime changes. Against exact
  Hermes `14e4865efb691bcbb1e48d8b1277b99dd78ecfbc`, all five were red:
  embedded Slack/Google/payment/AWS/GitHub labels were accepted; the cross-user
  kernel lock API did not exist; hostile namespace precreation reached the old
  unsafe path; a successful `setsid` child remained live; and a timeout
  double-fork remained alive long enough to perform its delayed effect.
- After the repair, all five focused v8 tests pass. The labeled repository
  values fail in both the standard schema and runtime before artifact creation.
- The comment lock is now a whole-device `flock` on the root-owned `/dev/null`
  character device. Different simulated UIDs and independent processes contend
  on the same kernel inode. No directory, key, repository identity, issue,
  marker, credential, or protected value is written. Collisions serialize, a
  foreign legacy namespace is ignored, symlinked anchors fail closed, and the
  kernel releases stale ownership with the final inherited descriptor.
- Each provider receives a private inherited containment descriptor. Linux
  performs fast descriptor-inode holder discovery; the portable fallback uses
  bounded, timed `lsof`. Holder inventory, process-group signaling, direct-child
  reaping, and PID disappearance checks run on every success or failure before
  the provider result can be finalized.
- Exact success and timeout probes pass for detached `setsid` children and
  reparented double forks: no descendant is live at return, no zombie remains,
  no delayed effect occurs, and no lock holder survives cleanup.
- Full Hermes command
  `PYTHONDONTWRITEBYTECODE=1 PYTHONPYCACHEPREFIX=/var/tmp/pjan21-v8-pycache
  python3 -m unittest discover -s tests -p 'test_*.py' -q`: pass, 82 of 82.
- The entire earlier blocker matrix remains green, including schema integral
  numbers/final newlines, root and store replacement, SIGKILL lock inheritance,
  NUL-bearing Plane lookup, strict Plane/Linear/Trello result typing, bounded
  HTTP/provider/input/artifact reads, failed-final validation, same-run and
  cross-run idempotency, cursor drift, and Darwin execution without
  `/proc/self/fd`.
- Ruff check/format, Python compile, `sh -n`, `dash -n`, 21 embedded provider
  Python blocks, Jinja parse/delimiter counts, exact step numbering,
  prompt/docs parity, schema metaschema/runtime equality, and Hermes
  `git diff --check` pass.
- Step 11 still contains exactly the three locked decisions; step 12 occurs once
  and is final. Generated prompt/docs contain no PJAN reference.
- Exact committed Copier render: Copier 9.14.0,
  `--trust --skip-tasks --defaults --data target_repo=pjangler --data role=pm
  --data ticket_provider=trello`, at
  `1aae4c9d9cf9e134b40365fe5593713aa05ae667`: pass. The helper, v7 schema,
  orchestration docs, and three providers are byte-equal, 6 of 6. The rendered
  prompt contains the v8 lock, containment, credential-substring, numbering,
  and no-PJAN contract, with no rendered cache directory.
- Hermes feature publish/read-back: local HEAD, `git ls-remote`, and freshly
  fetched `FETCH_HEAD` all equal
  `1aae4c9d9cf9e134b40365fe5593713aa05ae667`. Hermes remote main remains
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Parent `npm run typecheck` passes. Parity migration, MCP catalog, MCP server,
  project registry, and PostgreSQL registry suites pass; the PostgreSQL check
  reports `PG_STORE_CHECK_OK`.
- Full parent `npm test` passes parity migration, then reproduces the unchanged
  Skillex installed-package fixture failure because its copied CommonProject
  template directory is absent. The remaining directly relevant suites pass
  when run individually.
- Parent `npm ci --ignore-scripts --dry-run` reproduces the unchanged
  package/lock mismatch beginning with `@types/pg`, `node-pg-migrate`, and `pg`.
  `git diff --quiet` from the exact parent base proves package files,
  CommonProject, fixture tests, and `dist` are unchanged.
- No live Plane, Linear, or Trello mutation was made. Deterministic adapters and
  local fakes cover every comment side effect and failure path.
- Parent `git diff --check`: pass.
- Real parent command
  `bash agents/hermes/pm/.scripts/sentinel/bin/issue-close-gate.sh PJAN-21 .`:
  pass with exact output `CLOSE GATE: PASS for PJAN-21`.

## Ledger Update

Ledger updated: yes

- Original restoration decision event:
  `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Doctor Von Code hold event:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- SyntaxSorcerer hold event:
  `835ed986-fbc2-416a-ace2-fb8479ce61ff`.
- Professor Fiddlesticks hold event:
  `2703a751-2696-4108-89f7-ae8cd800b003`.
- V7 terminal-review implementation event:
  `4c4db949-5447-4161-a30c-358c19a26c1b`.
- V7 terminal-review close-gate event:
  `248cf0f1-a5ea-4660-991c-37e10b009076`.
- V8 terminal-review implementation event:
  `fdc9220a-0eab-452a-8459-d2fb3bdaa757`.

## Known Gaps

- `pjangler:PJAN-23` owns a future create-issue adapter operation. Generated
  Hermes protocol contains no PJAN reference and requires an existing local
  tracking reference.
- The canonical Plane description reflects the earlier protocol-only scope,
  while the user's terminal-review remediation expressly authorized the
  provider/runtime/schema seams required for correctness. Plane and Momo
  mutation were prohibited in this implementation pass, so this evidence
  records the amended scope without rewriting the live ticket.
- Parent dependency hygiene remains outside PJAN-21: `package.json` declares
  packages absent from `package-lock.json`, so clean `npm ci` rejects the
  unchanged baseline.
- The parent Skillex packaged-template fixture remains outside PJAN-21 and
  fails when its copied CommonProject template directory is absent.
- The inherited `.tmp/plugins` gitlink lacks a `.gitmodules` mapping and makes
  recursive submodule status fail; it is unchanged from the parent base.
- The host-global device lock deliberately serializes all retro comment
  deliveries on one host. This favors correctness over parallel throughput.
- Non-Linux containment requires `lsof`; absence fails closed before provider
  launch and performs no board side effect.
- Provider correctness is verified with deterministic adapters and fakes; live
  third-party comments were intentionally excluded.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged by this work.

## Close Recommendation

Close recommendation: ready

- Rationale: every v8 finding has a red-before-green executable regression, all
  82 Hermes tests pass, the exact committed candidate renders cleanly, the
  feature ref reads back at the exact commit, and the real close gate passes.
  This records implementation readiness for fresh independent reviewers; it is
  not a claim of review acceptance.
