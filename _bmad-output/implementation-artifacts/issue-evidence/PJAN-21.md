# Evidence: PJAN-21 — v12 red-first remediation

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent candidate base:
  `5828f6cefa26c453bea852b6114bd8e770e1805d`
- Parent implementation commit:
  `e87e5def7c44835ea7028ca398b6ca39a585efbc`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes implementation:
  `08326421dc346886de154270363d59ba4eba72bd`
- Hermes feature ref:
  `refs/heads/feature/PJAN-21-post-loop-main`
- Hermes remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`

## Acceptance Criteria

1. A public caller-supplied routing result cannot produce terminal delivery
   proof. Delivery must issue one artifact- and immutable-intent-bound trusted
   transition after provider execution or a local null-source decision, and
   that transition cannot be forged, replayed, split, or self-attested.
2. Every artifact mutation uses the held retro directory descriptor and every
   binding mutation uses the held bindings directory descriptor with bare
   filenames. Intermediate pathname replacement cannot redirect create, link,
   or replace into a replacement tree.
3. Initial binding publication is crash-atomic: unique exclusive temp, file
   fsync, validation, no-replace link, final-file and directory fsync, and
   retry-safe cleanup with no zero-byte final-name poison.
4. Plane and Trello bounded curl controllers terminate and verify the original
   process group even after its leader exits, within their hard deadline and
   before the keyed delivery lock can be released.
5. A close-gate invocation without an explicit repository root binds to the
   repository containing the installed role, never the caller working
   directory.
6. Plane treats a typed `next_page_results=false` as terminal even when the
   live response includes a non-empty typed terminal cursor, while preserving
   strict active-page cursor progress, cycle checks, typed IDs, and one total
   resolution deadline.
7. Preserve the v8 closed schema/runtime/prompt/docs/render contract, exactly
   three decisions in step 11, final step 12, bounded raw output, provider
   neutrality, Linux containment, and fail-closed unsupported-platform
   behavior.

## Repo Changes

- Hermes commit `08326421dc346886de154270363d59ba4eba72bd`
  changes exactly these paths relative to
  `90ba6e2a9afffbfe19c27653830f9e877aeec94f`:
  - `template/.scripts/providers/plane.sh`
  - `template/.scripts/providers/trello.sh`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/issue-close-gate.sh`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `tests/test_run_retro_contract.py`
- The schema remains v8. Public `finalize` now returns
  `untrusted_finalization`; only internal delivery can issue a canonical
  one-shot transition sealed to the artifact fingerprint, immutable digest,
  transition UUID, and normalized routing result. Consumption is single-use,
  and the consumed UUID is the terminal artifact/binding proof.
- Artifact create/link/replace operations use the already-held `retro_fd`;
  binding create/link/replace operations use the already-held `bindings_fd`.
  All mutation operands are bare filenames, so a replaced intermediate
  pathname cannot redirect a write into the replacement tree.
- Initial bindings are published through a unique exclusive temp, write/fsync,
  parse/read-back validation, no-replace link, final-file fsync, and directory
  fsync. A crash before publication leaves no final binding; retry safely
  republishes the same immutable intent.
- Plane and Trello reserve teardown time inside the hard HTTP deadline, signal
  the original curl process group after leader exit, reap the leader, and
  verify the group no longer exists before returning.
- The close gate resolves its default root from installed `ROLE_DIR` and
  rejects invalid explicit roots. Plane accepts live terminal collection
  envelopes with `next_page_results=false` plus a typed non-empty terminal
  cursor, but never follows that cursor.
- Prompt and orchestration documentation carry the same trusted-transition,
  descriptor, binding-publication, process-group, gate-root, and terminal
  pagination rules.
- The parent advances only the `templates/hermes-agent` gitlink, this evidence
  file, and PJAN-21 implementation/close-gate event history.

## Verification

- The first temporal red run added ten focused v12 regressions before the
  runtime repair and executed them against exact Hermes
  `90ba6e2a9afffbfe19c27653830f9e877aeec94f`:
  `Ran 10 tests in 2.116s`, `FAILED (failures=10)`.
- The final twelve-case test set was independently replayed against that same
  exact base:
  - core trust, descriptor, atomic-binding, and gate-root cases:
    `Ran 8 tests in 0.298s`,
    `FAILED (failures=7, errors=1)`;
  - live terminal Plane envelope cases:
    `Ran 2 tests in 0.273s`, `FAILED (failures=2)`;
  - Plane/Trello post-leader-exit process-group cases:
    `Ran 2 tests in 1.618s`, `FAILED (failures=2)`.
  The error is the expected absence of the trusted-transition implementation
  on the base candidate.
- Full exact committed Hermes suite:
  `python -m unittest discover -s tests -v`:
  `Ran 119 tests in 26.212s`, `OK`.
- Green coverage includes public fabricated finalization, transition
  replay/split/self-attestation, binding and artifact intermediate swaps,
  crash-before-binding-write retry, unrelated-CWD absolute gate invocation,
  live terminal Plane work-item/comment envelopes, and delayed Plane/Trello
  descendant effects after curl leader exit.
- Existing coverage remains green for serial 7-of-7 idempotency, concurrent
  comments, independent lock keys, controller death, provider descendant
  containment, canonical provider/source/target/body binding, malformed bytes,
  response bounds, pagination cycles and snapshot drift, store/root relocation,
  symlink attacks, stale finalization ordering, safe persisted shapes,
  durability, and schema/runtime acceptance parity.
- Ruff check passes; Ruff format-check reports both Python files formatted.
  Python compilation passes. `sh -n` and `dash -n` pass for Plane, Trello,
  Linear, and the close gate. Hermes and parent `git diff --check` pass.
- Draft 2020-12 metaschema validation passes. Jinja parses with 8 opening and
  8 closing delimiters, all 28 embedded provider Python blocks compile, step
  11 contains exactly the three locked decisions, step 12 occurs once and is
  final, prompt/docs parity passes, and generated protocol contains no PJAN
  reference.
- Exact Copier 9.14.0 render used `--trust --skip-tasks --defaults` with
  `target_repo=pjangler`, `role=pm`, and `ticket_provider=trello` from a clean
  `git archive` of committed Hermes
  `08326421dc346886de154270363d59ba4eba72bd`. All seven generated
  implementation/schema/doc surfaces are byte-equal, the rendered prompt has
  exactly three decisions and final step 12, and the archived candidate
  contains no Python cache.
- A normal non-force feature push advanced only
  `refs/heads/feature/PJAN-21-post-loop-main`. Fresh `ls-remote`, fetched
  `FETCH_HEAD`, and local Hermes HEAD all equal
  `08326421dc346886de154270363d59ba4eba72bd`. Hermes local and remote main both
  remain `62c05b578cfb5e310292e8034626436335bb1677`.
- Parent `npm run typecheck` passes. MCP catalog, MCP server, project registry,
  and PostgreSQL registry regression suites pass; PostgreSQL reports
  `PG_STORE_CHECK_OK`.
- Full parent `npm test` passes parity migration and then reproduces the
  unchanged Skillex packaged-template fixture failure because the copied
  CommonProject template directory is absent. The remaining directly relevant
  suites pass individually.
- Parent `npm ci --ignore-scripts --dry-run` reproduces the unchanged
  package/lock mismatch beginning with `@types/pg`, `node-pg-migrate`, and
  `pg`. The diff from parent base changes no package file, CommonProject
  content, fixture test, source, or `dist` output.
- No live Plane, Linear, or Trello operation was invoked. No main branch, tag,
  release, package file, task ledger, CommonProject content, or unrelated file
  was changed.
- The real close gate was run from the exact clean Copier 9.14.0 render of
  committed Hermes `08326421dc346886de154270363d59ba4eba72bd` against parent
  implementation commit `e87e5def7c44835ea7028ca398b6ca39a585efbc`.
  Exact output: `CLOSE GATE: PASS for PJAN-21`.

## Ledger Update

Ledger updated: yes

- V12 implementation event:
  `253284c2-fecb-4a06-aa18-250808c7b85f`.
- V12 close-gate event:
  `ac67c0d3-87f9-4405-a1bd-01ffd37fa31d`.
- Original restoration decision:
  `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Doctor Von Code hold:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- SyntaxSorcerer hold:
  `835ed986-fbc2-416a-ace2-fb8479ce61ff`.
- Professor Fiddlesticks hold:
  `2703a751-2696-4108-89f7-ae8cd800b003`.
- V7 implementation and close gate:
  `4c4db949-5447-4161-a30c-358c19a26c1b`,
  `248cf0f1-a5ea-4660-991c-37e10b009076`.
- V8 implementation and close gate:
  `fdc9220a-0eab-452a-8459-d2fb3bdaa757`,
  `66aa623d-af98-4b1f-bd31-83f56f9aa33e`.
- V10 implementation and close gate:
  `f4d3dd09-f6bb-4fb4-92d0-3f45ac3486e4`,
  `e718c14a-2301-46d8-8b49-a11740925ec5`.
- V11 implementation and close gate:
  `72f5d5a0-60fc-44df-89e3-4c9b7af87f68`,
  `ec5a1814-e6d6-4275-bcf7-687e80c8ed12`.

## Known Gaps

- `pjangler:PJAN-23` owns a future create-issue adapter operation. Generated
  Hermes protocol contains no PJAN reference and requires an existing local
  tracking reference.
- Provider delivery requires Linux with a trusted Bubblewrap binary and a
  pidfd-capable kernel. Unsupported or unverifiable containment fails closed
  before a board side effect.
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

- Rationale: all fresh v12 findings have executable red and green receipts,
  all 119 Hermes tests pass, schema/runtime/static/render parity passes, the
  feature ref reads back at the exact implementation commit, and relevant
  parent checks pass with unchanged baselines isolated from this diff. This
  records implementation readiness for fresh independent review; it is not a
  claim of acceptance.
