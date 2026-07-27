# Evidence: PJAN-21 — v10 red-first remediation

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent implementation base:
  `ac7584e2732900a131a194750936dd4976024127`
- Parent implementation commit:
  `717d9cacdc35880c467e0cb60ef1c33c191acf55`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes implementation:
  `a65b6afa05ede221bb3b1e3b31646bef7d7c7e0a`
- Hermes feature ref:
  `refs/heads/feature/PJAN-21-post-loop-main`
- Hermes remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`

## Acceptance Criteria

1. Bound artifact and comment-lock acquisition; equal logical comment keys
   contend while independent keys remain concurrent in one cross-user host
   domain.
2. Preserve comment exclusion after delivery-controller death and contain
   every provider descendant, including `setsid`, double-fork, reparenting, and
   inherited-descriptor closure, until termination and reaping complete.
3. Bound containment discovery and cleanup, fail closed when the supervisor
   cannot prove containment, and use no predictable writable lock path.
4. Preserve raw Plane and Trello resolver bytes through bounded strict
   UTF-8/JSON/type/canonical-ID validation before shell normalization.
5. Honor `TMPDIR` in portable tests and retain every earlier durability,
   privacy, schema/runtime, source/target/body binding, idempotency, pagination,
   exact-three-decision, final-step, and render guarantee.

## Repo Changes

- Hermes commit `a65b6afa05ede221bb3b1e3b31646bef7d7c7e0a`
  changes exactly these paths relative to
  `1aae4c9d9cf9e134b40365fe5593713aa05ae667`:
  - `template/.scripts/providers/plane.sh`
  - `template/.scripts/providers/trello.sh`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `tests/test_run_retro_contract.py`
- Artifact locks now acquire `flock(LOCK_EX|LOCK_NB)` on a finite retry
  deadline. Comment locks use the complete 64-hex comment fingerprint as an
  exact Linux abstract Unix-socket key: equal keys contend, distinct keys have
  distinct names, and there is no filesystem path, key file, symlink target, or
  hash truncation.
- A detached supervisor owns the keyed comment lock independently of the
  delivery controller. It accepts only a root-owned,
  non-group/world-writable Bubblewrap executable, starts the provider in a
  private PID namespace with `--unshare-pid --as-pid-1`, blocks provider
  execution until a typed bounded `--info-fd` response yields the host PID and
  an open pidfd, and retains the lock until namespace teardown is reaped.
- The provider script, controller source, and bound configuration cross the
  supervisor boundary through inherited descriptors. PID-namespace destruction
  contains descendants after `setsid`, double-fork, reparenting, and closure of
  every inherited descriptor; failed containment returns a sanitized failed
  routing result without final success.
- Plane and Trello resolver HTTP bodies now use bounded private `TMPDIR` files
  and strict raw-byte validation. A malformed HTTP-200 Plane direct response
  fails closed instead of falling through to a second lookup.
- The schema remains v7 because the serialized artifact shape and acceptance
  set did not change. Prompt/docs/runtime parity describes the new supported
  platform boundary and the same immutable retro protocol.
- The parent advances only the `templates/hermes-agent` gitlink, this evidence
  file, and Bloodbank implementation/close-gate history.

## Verification

- Both v9 reviewer rollouts were read completely through their terminal
  `task_complete` records:
  - `019fa2db-17ac-7b41-b6fb-0d482de4d782`
  - `019fa2db-1c54-7510-a618-217ff8b1b719`
  Their complete union was bounded locking, independent-key concurrency,
  all-descriptor-closing descendant escape, bounded fail-closed cleanup, raw
  Plane/Trello resolver bytes, and portable temporary roots.
- Seven deterministic regressions were added before runtime repair and run
  against exact Hermes
  `1aae4c9d9cf9e134b40365fe5593713aa05ae667`.
  Receipt: `Ran 7 tests in 7.333s`, `FAILED (failures=7, errors=2)`.
  The artifact-lock and post-launch inventory probes exceeded their two-second
  subprocess bounds; unrelated comment keys took about 2.535 seconds; a
  descriptor-closing double-fork descendant remained live; Plane and Trello
  accepted NUL-suffixed resolver responses; and hard-coded `/var/tmp` remained.
- The same focused seven-test command after repair passes:
  `Ran 7 tests in 2.741s`, `OK`. An additional exact comment-lock timeout case
  and a malformed-direct-Plane/no-fallback case also pass.
- Full Hermes suite:
  `timeout 180s env PYTHONDONTWRITEBYTECODE=1 TMPDIR="${TMPDIR:-/tmp}"
  python3 -m unittest discover -s tests -v`:
  `Ran 91 tests in 18.963s`, `OK`.
- The full suite includes concurrent identical-comment delivery, independent
  comment-key concurrency, controller `SIGKILL`, success/timeout `setsid`,
  reparented double-fork, closure of every inherited descriptor, containment
  setup failure, bounded artifact/comment lock acquisition, provider
  timeout/output bounds, root/store relocation, symlink attacks, monotonic
  finalization, malformed bytes, strict provider result typing, Plane cursor
  snapshot validation, seven serial idempotency cases, and exact schema/runtime
  acceptance.
- Ruff 0.15.15 check and format-check pass; Python compile passes. `sh -n` and
  `dash -n` pass for Plane, Trello, and Linear. Jinja parse/delimiter counts,
  Draft 2020-12 metaschema validation, and all 24 embedded provider Python
  blocks pass. Hermes `git diff --check` passes.
- Prompt/docs whitespace-normalized parity passes. Step 11 contains exactly the
  three locked decisions and step 12 occurs once and is final. Generated
  prompt/docs contain no ticket-specific PJAN reference.
- Exact committed Copier render from
  `a65b6afa05ede221bb3b1e3b31646bef7d7c7e0a` with Copier 9.14.0,
  `--trust --skip-tasks --defaults --data target_repo=pjangler --data role=pm
  --data ticket_provider=trello`: pass. Helper, v7 schema, orchestration docs,
  and all three provider adapters are byte-equal, 6 of 6; rendered numbering
  and no-PJAN checks pass; no rendered Python cache exists.
- Hermes publish/read-back: normal feature history was updated with
  `--force-with-lease` fixed to the prior remote SHA. Local HEAD, freshly
  fetched `FETCH_HEAD`, and `git ls-remote` all equal
  `a65b6afa05ede221bb3b1e3b31646bef7d7c7e0a`. Hermes remote main remains
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Parent `npm run typecheck` passes. Parity migration, MCP catalog, MCP server,
  project registry, and PostgreSQL registry suites pass; PostgreSQL reports
  `PG_STORE_CHECK_OK`.
- Full parent `npm test` passes parity migration and then reproduces the
  unchanged Skillex packaged-template fixture failure because the copied
  CommonProject template directory is absent. The remaining directly relevant
  suites pass individually.
- Parent `npm ci --ignore-scripts --dry-run` reproduces the unchanged
  package/lock mismatch beginning with `@types/pg`, `node-pg-migrate`, and `pg`.
  A diff from the exact parent base proves package files, CommonProject,
  fixture tests, and `dist` are unchanged.
- No live Plane, Linear, or Trello operation was invoked. No main branch, tag,
  release, package file, task ledger, CommonProject content, or unrelated file
  was changed.
- Parent `git diff --check` passes. Real command
  `bash agents/hermes/pm/.scripts/sentinel/bin/issue-close-gate.sh PJAN-21 .`
  passes with exact output `CLOSE GATE: PASS for PJAN-21`.

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
- V7 implementation and close-gate events:
  `4c4db949-5447-4161-a30c-358c19a26c1b`,
  `248cf0f1-a5ea-4660-991c-37e10b009076`.
- V8 implementation and close-gate events:
  `fdc9220a-0eab-452a-8459-d2fb3bdaa757`,
  `66aa623d-af98-4b1f-bd31-83f56f9aa33e`.
- V10 red-first implementation event:
  `f4d3dd09-f6bb-4fb4-92d0-3f45ac3486e4`.
- V10 close-gate event:
  `e718c14a-2301-46d8-8b49-a11740925ec5`.

## Known Gaps

- `pjangler:PJAN-23` owns a future create-issue adapter operation. Generated
  Hermes protocol contains no PJAN reference and requires an existing local
  tracking reference.
- Provider delivery now requires Linux with a trusted Bubblewrap binary and a
  pidfd-capable kernel. Unsupported or unverifiable containment fails closed
  before a board side effect; it does not degrade to process-tree heuristics.
- The exact abstract-socket key is shared by users in the host network
  namespace. A foreign reservation can cause only bounded fail-closed
  availability loss; it cannot redirect the lock, supply a provider result, or
  permit a duplicate post.
- Parent dependency hygiene remains outside PJAN-21: `package.json` declares
  packages absent from `package-lock.json`, so clean `npm ci` rejects the
  unchanged baseline.
- The parent Skillex packaged-template fixture remains outside PJAN-21 and
  fails when its copied CommonProject template directory is absent.
- Provider correctness is verified with deterministic local fakes; live
  third-party comments were intentionally excluded.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged by this work.

## Close Recommendation

Close recommendation: ready

- Rationale: every v10 reviewer finding has a red-before-green executable
  regression, all 91 Hermes tests pass, the exact committed candidate renders
  cleanly, the feature ref reads back at the exact commit, relevant parent
  checks pass, and unchanged parent baselines are isolated from this diff. This
  records implementation readiness for fresh independent review; it is not a
  claim of acceptance.
