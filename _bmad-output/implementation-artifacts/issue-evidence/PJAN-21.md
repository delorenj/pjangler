# Evidence: PJAN-21 — v7 terminal-review remediation

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent implementation base:
  `0d2fe25640be3714b6c3d79f1773ad0af7fab0d4`
- Parent implementation commit:
  `506c5f79dd5feeca496e7f40236e15dc953c2458`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes implementation:
  `14e4865efb691bcbb1e48d8b1277b99dd78ecfbc`
- Hermes feature ref:
  `refs/heads/feature/PJAN-21-post-loop-main`
- Hermes remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`

## Acceptance Criteria

1. Keep step 11 directly after the final board-status report with exactly three
   decisions: what hurt, what should change, and whether the fix is repo-local
   or external/template/fleet. Keep step 12 as the final checkpoint.
2. Make standard Draft 2020-12 and runtime accept the same v7 documents,
   including integral JSON numbers and true end-of-string regex behavior.
3. Hold repository, configuration, provider, artifact store, and finalization
   to one descriptor-bound repository lifetime. Detect root replacement before
   an external effect, and execute providers portably without `/proc/self/fd`.
4. Keep one non-forkable comment lock domain across repository copies or path
   replacement. Bind the immutable canonical provider, source, target, marker,
   and body before any external side effect.
5. Permit no transient or durable write after the artifact store is relocated,
   at either exclusive temporary creation or durable replacement.
6. Terminate and reap the complete provider descendant tree, including
   descendants that create a new session, before releasing the comment lock.
7. Preserve malformed bytes such as NUL through provider validation so malformed
   lookups fail closed before POST. Bound and time every Plane, Linear, and
   Trello HTTP response read.
8. Reject protected repository identities, require canonical string provider
   IDs, and make `validate --final` stall for retryable failed delivery.
9. Preserve every earlier accepted cursor, typed-envelope, idempotency,
   crash/durability, privacy, source-target-body, bounded-I/O, exact rendering,
   portability, and provider-neutral guarantee.

## Repo Changes

- Hermes commit `14e4865efb691bcbb1e48d8b1277b99dd78ecfbc`
  changes exactly these paths relative to
  `3aa5e803a7b669e32ccecb391da8ae8507c600ab`:
  - `template/.scripts/providers/linear.sh`
  - `template/.scripts/providers/plane.sh`
  - `template/.scripts/providers/trello.sh`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `template/.scripts/sentinel/schemas/run-retro.v7.schema.json`
  - `tests/test_run_retro_contract.py`
- The parent advances only the `templates/hermes-agent` gitlink from
  `3aa5e803a7b669e32ccecb391da8ae8507c600ab` to
  `14e4865efb691bcbb1e48d8b1277b99dd78ecfbc`, this evidence file, and
  Bloodbank implementation/close-gate events.
- Package manifests, lockfiles, CommonProject, tasks, live boards, both main
  branches, tags, releases, and unrelated runtime agents are unchanged.

## Verification

- Sir Fix-a-Lot gave the original exactly-three-decisions protocol independent
  specification approval. Doctor Von Code held the first restoration for
  evidence, durability, sanitization, routing, and generated-ticket leakage.
  Every concrete hold since then remains represented by an executable
  regression.
- The fresh v7 specification review of parent
  `0d2fe25640be3714b6c3d79f1773ad0af7fab0d4` and Hermes
  `3aa5e803a7b669e32ccecb391da8ae8507c600ab` held for schema/runtime numeric
  and final-newline divergence, replacement-root provider binding, escaped
  descendants, transient relocated-store writes, and unbounded Linear/Trello
  response reads.
- The fresh v7 quality review held the same candidate for a root-copy lock
  fork that posted twice, a durable relocated-store write, escaped-session
  effects, NUL normalization followed by Plane POST, protected repository
  identity, failed-delivery final-checkpoint success, numeric provider IDs,
  and Linux-only provider execution.
- The exact focused red run covered 14 v7 adversarial reproductions. Before the
  repair, 13 failed or errored as expected; the existing Linear oversize probe
  was already safe. The same reproductions are green after the repair.
- Full Hermes command
  `python3 -m unittest discover -s tests -p 'test_*.py' -q`: pass, 77 of 77.
- Schema/runtime differential probes now agree for integral JSON numbers and
  reject trailing-newline strings identically. Draft 2020-12 metaschema and
  bidirectional acceptance checks pass.
- Descriptor-lifetime probes prove replacement repository/provider/config
  values produce zero provider calls. A cross-root-copy concurrent retry uses
  one global lock domain, one immutable marker/body, and one external comment.
- Both relocated-store race windows pass: no temporary entry is created outside
  the repository, and no posted final state is durably replaced outside it.
  Static artifact, lock, and provider symlinks remain rejected.
- A real provider descendant calling `setsid()` is terminated and reaped before
  delivery returns or the lock is released. It leaves no delayed side effect,
  live descendant, zombie, or inherited lock holder.
- Plane preserves NUL-bearing lookup bytes and classifies the response as
  `lookup_failed` with zero POST calls. Plane cursor/envelope/snapshot checks and
  current work-item comment endpoints remain exhaustive and fail closed.
- Trello and Linear require canonical string result IDs; null, numeric,
  malformed, noncanonical, oversized, and timed-out responses are safe failures.
  All three providers bound response sizes and deadlines.
- Protected-value probes reject synthetic Slack, Google, Stripe, AWS, and
  GitHub credential-shaped repository identities. Closed persisted shapes and
  opaque `evidence:<uuid>` references retain the protected-evidence boundary.
- A retryable failed delivery remains a valid stored attempt, but
  `validate --final` returns nonzero and stalls until a terminal checkpoint
  status exists.
- Provider execution is descriptor-bound yet portable: the exact regression
  runs with a mocked Darwin platform and verifies no `/proc/self/fd` path.
- Prior matrices remain green for same-run same/changed content, cross-run
  identical/different content, corrupt artifacts, lost responses, no source,
  controller SIGKILL, monotonic stale finalization, bounded input/artifacts,
  pagination drift, immutable target/body binding, and concurrent writers.
- Ruff check/format, Python compile, `sh -n`, `dash -n`, embedded provider
  Python parsing, Jinja delimiter counts, exact numbering, normalized
  prompt/docs parity, schema metaschema/parity, and Hermes `git diff --check`
  pass.
- Jinja delimiters remain balanced. Step 11 contains exactly three decisions;
  step 12 occurs once and is final. Generated prompt/docs contain no PJAN
  reference.
- Exact committed Copier render: Copier 9.14.0,
  `--trust --skip-tasks --defaults --data target_repo=pjangler --data role=pm
  --data ticket_provider=trello`, at
  `14e4865efb691bcbb1e48d8b1277b99dd78ecfbc`: pass. The helper, v7 schema,
  orchestration docs, and three providers are byte-equal, 6 of 6; the rendered
  prompt numbering and no-PJAN checks pass. No cache directory is rendered.
- Hermes feature publish/read-back: local HEAD, `git ls-remote`, and freshly
  fetched `FETCH_HEAD` all equal
  `14e4865efb691bcbb1e48d8b1277b99dd78ecfbc`. Hermes remote main remains
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
  fakes cover comment side effects and failure paths.
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
- Prior post-repair implementation event:
  `4177a469-5ac7-4101-bb17-7477e0169986`.
- Prior post-repair close-gate event:
  `0d26974f-7fc3-4f77-b837-f5ba7e72d664`.
- Terminal-review implementation event:
  `4c5194c0-ac4f-4302-830f-34652b882393`.
- Terminal-review close-gate event:
  `31cfd3fd-149a-47aa-a36f-ac7dfc995a3d`.
- V7 terminal-review implementation event:
  `4c4db949-5447-4161-a30c-358c19a26c1b`.
- V7 terminal-review close-gate event:
  `248cf0f1-a5ea-4660-991c-37e10b009076`.

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
- Provider correctness is verified with deterministic adapters and fakes; live
  third-party comments were intentionally excluded.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged by this work.

## Close Recommendation

Close recommendation: ready

- Rationale: every v7 finding has a locked executable regression, all 77 Hermes
  tests pass, the exact committed candidate renders cleanly, the feature ref
  reads back at the exact commit, the real close gate passes, and the remaining
  parent failures and ticket wording are isolated unchanged surfaces outside
  this branch implementation.
