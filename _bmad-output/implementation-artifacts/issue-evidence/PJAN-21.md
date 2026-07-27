# Evidence: PJAN-21 — terminal-review post-loop hardening

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent implementation base:
  `4eefb51ed2245116bf4caa9d1c975d84939becbf`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes implementation:
  `3aa5e803a7b669e32ccecb391da8ae8507c600ab`
- Hermes feature ref:
  `refs/heads/feature/PJAN-21-post-loop-main`
- Hermes remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`

## Acceptance Criteria

1. Keep step 11 directly after the final board-status report with exactly three
   decisions: what hurt, what should change, and whether the fix is repo-local
   or external/template/fleet. Keep step 12 as the final checkpoint.
2. Durably persist the immutable prepared intent before any board side effect.
   Bind the canonical repository, provider, source, content, operator flag, and
   delivery body for every retry.
3. Use a run-scoped artifact fingerprint and a separate content-scoped comment
   fingerprint. Same-run changed intent stalls; distinct runs keep distinct
   artifacts; identical cross-run improvements deduplicate one immutable
   marker/body pair.
4. Hold one descriptor-anchored repository, configuration, store, provider, and
   finalization lifetime. Use descriptor-relative `O_NOFOLLOW` traversal,
   exclusive temporary files, no-replace creation, atomic replacement, file
   and directory fsync, parse/read-back, and no new transient artifact or lock
   write after store relocation.
5. Hold the serialized comment lock for the complete provider subtree. Start a
   provider session/process group and terminate and reap every descendant after
   timeout or bounded-output failure before releasing the lock.
6. Persist only closed canonical shapes: RFC UUID invocation and Plane/Linear
   identities, Trello IDs, finite signal/action summaries, finite categories,
   and opaque `evidence:<uuid>` references. No arbitrary secret, PII, path, log,
   or prose content may enter an artifact or comment.
7. Publish a standard Draft 2020-12 version 7 schema whose executable acceptance
   set matches runtime. Derive fingerprints, marker, body, target, and immutable
   binding outside the serialized shape when portable JSON Schema cannot assert
   their computed equality.
8. Use Plane's current work-item comment endpoints with `per_page`/`cursor`
   pagination, stable typed envelope and collection-snapshot validation, bounded
   reads, and canonical string-UUID POST confirmation. Malformed, drifting, or
   oversized responses fail closed without a second post.
9. Preserve provider/source/target/body binding, monotonic finalization,
   malformed-byte sanitization, concurrency, controller-SIGKILL lock inheritance,
   exact rendering, portability, and provider-neutral routing.

## Repo Changes

- Hermes commit `3aa5e803a7b669e32ccecb391da8ae8507c600ab`
  changes exactly these paths relative to
  `025e6ab42648abdf374530ac7ff4c93b6910c65a`:
  - `template/.scripts/providers/plane.sh`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `template/.scripts/sentinel/schemas/run-retro.v6.schema.json` renamed to
    `template/.scripts/sentinel/schemas/run-retro.v7.schema.json`
  - `tests/test_run_retro_contract.py`
- The parent advances only the `templates/hermes-agent` gitlink from
  `025e6ab42648abdf374530ac7ff4c93b6910c65a` to
  `3aa5e803a7b669e32ccecb391da8ae8507c600ab`, this evidence file, and
  Bloodbank implementation/close-gate events.
- Package manifests, lockfiles, CommonProject, tasks, live boards, both main
  branches, tags, releases, and runtime agents are unchanged.

## Verification

- Sir Fix-a-Lot gave the original exactly-three-decisions protocol independent
  specification approval. Doctor Von Code held the first restoration for
  evidence, durability, sanitization, routing, and generated-ticket leakage.
  Every later concrete hold remains represented by an executable regression.
- The terminal specification review of parent
  `4eefb51ed2245116bf4caa9d1c975d84939becbf` and Hermes
  `025e6ab42648abdf374530ac7ff4c93b6910c65a` held for live Plane cursor
  pagination, transient writes after directory relocation, artifact-wide
  privacy, strict POST response typing, and portable schema/runtime parity.
- The terminal quality review held the same candidate for collection-snapshot
  drift, repository-path reopen during finalization, surviving provider
  descendants, non-summary protected shapes, non-string POST IDs, unbounded
  input/artifact/provider reads, and divergence between the board description
  and the expanded terminal remediation.
- Regressions were locked before implementation: the old candidate failed 21
  new assertions spanning descriptor lifetime, relocated artifact/binding/lock
  writes, provider group timeout/output, cursor pages and drift, POST typing,
  HTTP/input/artifact bounds, persisted shapes, and standard-schema parity.
- Focused command `python3 tests/test_run_retro_contract.py -q`: pass, 54 of 54.
- Full command
  `PYTHONDONTWRITEBYTECODE=1 PYTHONPYCACHEPREFIX=/var/tmp/pjan21-pycache
  python3 -m unittest discover -s tests -p 'test_*.py' -q`: pass, 61 of 61.
- The scenario matrix passes same-run same/changed content, cross-run
  identical/different content, corrupt artifact, lost response, and no source.
  Same-run binding-only crash retries the identical immutable intent and rejects
  changed intent without overwrite or comment.
- Descriptor/adversarial probes pass for static symlinks, deterministic
  run-retros relocation, artifact/binding/lock create interception, whole-root
  path replacement during delivery, provider-script path replacement, and
  finalization through the held original store. Relocation creates no new file
  outside the repository.
- Provider lifecycle probes pass for controller SIGKILL, timeout descendants,
  delayed side effects, inherited lock holders, infinite stdout, infinite
  stderr, and bounded reaping. Retry blocks or rescans and the external-post
  counter remains one.
- Plane probes pass for `per_page=100` and cursor advancement, page-two marker
  lookup, pinned totals, cumulative counts, unique typed item IDs, cursor
  progress, 2,000-comment bounds, malformed/ambiguous HTTP-200 envelopes,
  oversized bodies, and transport failure. Every lookup failure produces zero
  POST calls. POST success requires a canonical lowercase RFC UUID string;
  null, numeric, malformed, and noncanonical IDs record a safe retryable
  failure.
- The implementation uses the official current
  `/work-items/{id}/comments/` list/create contract for both Plane comment
  paths. Legacy `/issues/{id}/comments/` comment paths are absent.
- Closed persisted-shape probes reject arbitrary token, credential, SSN,
  phone, customer, password, private-path, backtick-path, raw-log, timestamped
  log, and free-prose values. Protected evidence is represented only by an
  opaque canonical UUID token without protected contents.
- Draft 2020-12 metaschema and bidirectional acceptance probes pass for every
  serialized field, provider-specific source/reference type, null-source rule,
  operator flag, routing status/error relation, finite summary grammar, and
  bounded integer epoch-microsecond value. The schema has no custom assertion
  keyword.
- Prior guarantees pass: provider or target overrides produce zero provider
  calls; wrong stored values and wrong result provider/target are rejected; one
  marker maps to one body; stale failure cannot replace terminal success;
  corrupt and malformed-byte inputs yield safe declared categories without
  traceback or private-path output; concurrent writers and identical cross-run
  comments remain idempotent.
- Ruff format/check, Python compile, `sh -n`, `dash -n` for every provider,
  embedded Python parsing, Jinja delimiter counts, exact numbering, normalized
  prompt/docs parity, schema metaschema validation, and both repository
  `git diff --check` checks pass.
- Jinja delimiters remain balanced. Step 11 contains exactly three decisions;
  step 12 occurs once and is final. Generated prompt/docs contain no PJAN
  reference.
- Exact committed Copier render: Copier 9.14.0,
  `--trust --skip-tasks --defaults`, PM role, Trello provider, and exact commit
  `3aa5e803a7b669e32ccecb391da8ae8507c600ab`: pass. Helper, v7 schema,
  orchestration docs, adapter, Plane provider, and Trello provider are
  byte-equal, 6 of 6.
- Hermes feature publish/read-back: local HEAD, `git ls-remote`, and freshly
  fetched `FETCH_HEAD` all equal
  `3aa5e803a7b669e32ccecb391da8ae8507c600ab`. Hermes remote main remains
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Parent TypeScript typecheck passes. Parity migration, MCP catalog, MCP server,
  project registry, and PostgreSQL registry regression suites pass.
- Full parent `npm test` passes parity migration, then reproduces the unchanged
  Skillex packaged-template fixture failure because its copied local
  CommonProject template directory is absent. The remaining directly relevant
  suites pass when run individually.
- Parent `npm ci --ignore-scripts --dry-run` reproduces the unchanged
  package/lock mismatch beginning with `@types/pg`, `node-pg-migrate`, and `pg`.
  Parent diff inspection proves package files, CommonProject, and fixture tests
  are unchanged.
- No live Plane, Linear, or Trello mutation was made. Deterministic adapters and
  fakes cover comment side effects and failure paths.

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

## Known Gaps

- `pjangler:PJAN-23` owns a future create-issue adapter operation. Generated
  Hermes protocol contains no PJAN reference and requires an existing local
  tracking reference.
- The canonical Plane description still reflects the earlier protocol-only
  scope, while the user's terminal-review remediation expressly authorized the
  provider/runtime/schema seams needed for correctness. Plane and Momo mutation
  were prohibited in this implementation pass, so this evidence records the
  amended implementation scope without rewriting the live ticket.
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

- Rationale: every terminal finding has a locked executable regression, all 61
  Hermes tests pass, the exact committed candidate renders cleanly, the feature
  ref reads back at the exact commit, and remaining parent failures and ticket
  wording are explicitly isolated unchanged surfaces outside this branch
  implementation.
