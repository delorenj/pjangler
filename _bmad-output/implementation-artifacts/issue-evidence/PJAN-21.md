# Evidence: PJAN-21 — v13 amended-threat-model remediation

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Momo decision:
  `43cffa92-7ca9-4369-8f39-9d74d56aa6cb`
- Canonical Plane amendment comment:
  `5a646310-0f79-4866-a202-9aba6558b7ed`
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent starting candidate:
  `0a49d8e4a1e5811f98b2a0fcd8130ce9b900cbee`
- Parent implementation commit:
  `c18d3567c820f6e820f50fe0d78a1b9e4c30d998`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes starting candidate:
  `08326421dc346886de154270363d59ba4eba72bd`
- Hermes implementation:
  `23e5a4fbdd78adb9af88f3334db69ad71741f2c8`
- Hermes feature ref and fresh fetch:
  `23e5a4fbdd78adb9af88f3334db69ad71741f2c8`
- Hermes local and remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`

## Acceptance Criteria

1. Preserve the post-loop protocol: step 11 follows the final board-status
   report, asks exactly what hurt, what should change, and whether the fix is
   repo-local versus external/template/fleet; step 12 remains the final
   checkpoint.
2. Use the amended unprivileged threat model. Same-OS-UID peers are trusted.
   Reject symlinks, replacement path components or trees, stale identities
   detectable before mutation, and untrusted repository content. Fail closed
   when descriptor/path identity drift is detected.
3. Do not claim that an unprivileged controller can prevent an independent
   trusted same-UID peer from renaming an already-open directory inside the
   final syscall window. Privileged immutable/mount helpers and trusted
   mutation daemons are deferred.
4. Hold the exact `run-retros` and `.bindings` directory descriptors and
   identities for one store lifetime. Revalidate the repository, retro, and
   bindings path identities before mutations; use held descriptors and bare
   filenames for mutations.
5. If retry finds a valid final-name prepared binding after a crash between
   no-replace link and the durability barriers, fsync the final file and
   bindings directory, validate again, and revalidate bound path identities
   before reuse.
6. Binding `schema_version` is exact non-boolean integer `1` for prepared and
   final bindings; JSON `true` and `false` are rejected.
7. Parent PostgreSQL release evidence uses bounded child execution, a finite
   capability scan without a login shell, and deterministic pass, skip, or
   failure output.
8. Preserve every previously passing PJAN-21 property: trusted artifact-bound
   finalization, immutable comment identity/body, provider/source/target
   binding, closed safe persisted shapes, bounded I/O, provider-subtree
   containment, schema/runtime equality, current Plane cursor semantics, and
   provider-neutral behavior.

## Repo Changes

- Hermes commit `23e5a4fbdd78adb9af88f3334db69ad71741f2c8`
  changes exactly these paths relative to
  `08326421dc346886de154270363d59ba4eba72bd`:
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `tests/test_run_retro_contract.py`
- `RetroStore` now holds the `.bindings` descriptor and device/inode identity
  for the complete store lifetime. Store-path checks re-open the current
  repository path with `O_NOFOLLOW` and require byte-current retro and bindings
  identities before a mutation proceeds.
- Binding validation, initial publication, and finalization use the held
  `bindings_fd`; no operation reopens `.bindings` for its mutation target.
- Existing-final binding retry now performs validation, final-file fsync,
  bindings-directory fsync, a second validation, and a final store-identity
  check before returning.
- Binding validation rejects boolean `schema_version` values even though
  Python otherwise compares `True == 1`.
- Prompt and orchestration documentation carry the same amended same-UID trust
  boundary and retry durability sequence. Generated protocol contains no PJAN
  reference. The standard artifact schema remains v8.
- Parent changes are limited to:
  - `templates/hermes-agent` gitlink
  - `tests/pg-registry-regressions.mjs`
  - this evidence file
  - `_bmad-output/implementation-artifacts/bloodbank-events.jsonl`
- The parent PG harness now resolves tools through a bounded finite `PATH`
  scan, runs every child with a timeout and output cap, classifies
  timeout/output/spawn/signal/exit outcomes, checks every setup/migration/test
  and cleanup result, and has a deterministic bounded self-test.

## Verification

### Review lineage and threat-model decision

- Sir Fix-a-Lot gave the original exactly-three-decisions protocol independent
  specification approval.
- Doctor Von Code held the early restoration for evidence, durability,
  sanitization, routing, and generated-ticket leakage. Those repairs remain
  covered by executable regressions.
- Fresh v12 reviewers held parent
  `0a49d8e4a1e5811f98b2a0fcd8130ce9b900cbee` / Hermes
  `08326421dc346886de154270363d59ba4eba72bd` for moved-descriptor visibility,
  incomplete binding retry durability, boolean binding versions, and an
  unbounded login-shell PG probe.
- The original v13 zero-transient peer-rename demand was tested before the
  amendment. Against exact Hermes
  `08326421dc346886de154270363d59ba4eba72bd`:

  ```text
  Ran 6 tests in 0.206s
  FAILED (failures=6)
  ```

  The six probes directly observed:
  - artifact create wrote its temporary JSON into the relocated directory;
  - artifact link published its final JSON there;
  - artifact replace changed the relocated artifact to `posted`;
  - binding create wrote its temporary binding there;
  - binding link published the final `.sha256` there; and
  - binding replace wrote the final document digest there.

  Those probes inspected the moved descriptor-backed directories at each
  syscall boundary, not merely the replacement pathname.
- Kernel feasibility receipts:

  ```text
  OPEN_FD_FLOCK_RENAME=allowed outside_write=outside-write
  unshare: write failed /proc/self/uid_map: Operation not permitted
  UNSHARE_BIND_STATUS=1
  IMMUTABLE_SET_STATUS=errno:1:Operation not permitted
  ```

  An open directory descriptor plus exclusive `flock` does not prevent an
  independent same-UID rename. `openat2` constrains resolution but does not pin
  a directory against later rename; Landlock cannot constrain an independent
  peer and does not revoke pre-opened descriptors; a private mount namespace
  does not stop a host peer renaming the underlying tree. Enforcing the
  stronger demand requires a privileged immutable/mount helper or a trusted
  mutation daemon.
- Momo decision `43cffa92-7ca9-4369-8f39-9d74d56aa6cb` and Plane comment
  `5a646310-0f79-4866-a202-9aba6558b7ed` therefore amend the contract: same-UID
  peers are trusted, detectable stale/path drift must fail closed, and the
  impossible final-syscall peer exclusion is not claimed. The intentionally
  failing six-test class was removed rather than committed or disguised as
  expected failure.

### Red-first receipts

- The amended five-test v13 set was added before runtime changes. Against exact
  Hermes `08326421dc346886de154270363d59ba4eba72bd`:

  ```text
  Ran 5 tests in 0.160s
  FAILED (failures=4)
  ```

  The replacement `.bindings` tree was accepted, retry emitted no binding file
  or directory fsync, and prepared/final binding validators accepted JSON
  `true` as version `1`. The honest `run-retros` relocation-before-mutation
  rejection already passed; JSON `false` was already rejected. Both boolean
  values remain explicit committed subtests.
- Parent PG pre-repair probe exited `1`:

  ```text
  PG_HARNESS_RED login_shell=true spawn=true bounded=false
  ```

### Green receipts

- Amended v13 focused suite:
  `Ran 5 tests in 0.154s`, `OK`.
- Full exact Hermes suite:
  `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p
  'test_*.py' -v`:
  `Ran 124 tests in 26.350s`, `OK`.
- Coverage includes relocation detected before mutation with unchanged moved
  and replacement trees, `.bindings` replacement rejection, crash immediately
  after the no-replace link, retry fsync ordering, prepared/final boolean
  rejection, and prompt/docs contract parity.
- Existing coverage remains green for serial 7-of-7 idempotency, concurrent
  cross-run comments, independent lock keys, controller death, provider
  descendants, canonical provider/source/target/body binding, malformed bytes,
  bounded HTTP/provider data, Plane pagination cycles/snapshot drift/terminal
  cursors, symlink attacks, monotonic finalization, durability, and
  schema/runtime acceptance parity.
- Ruff check passes; Ruff format-check reports both Python files formatted.
  Python compilation passes.
- `sh -n` and `dash -n` pass for Plane, Linear, Trello, the provider adapter,
  and the issue close gate.
- Draft 2020-12 metaschema validation passes. Jinja parses with 8 opening and
  8 closing delimiters. All 28 embedded provider Python blocks compile. The
  rendered prompt contains exactly the three locked step-11 decisions and one
  final step 12. Prompt/docs normalized parity passes.
- Hermes and parent `git diff --check` pass.
- Exact Copier `9.14.0` render used `--trust --skip-tasks --defaults` with
  `target_repo=pjangler`, `role=pm`, and `ticket_provider=trello` from a clean
  `git archive` of committed Hermes
  `23e5a4fbdd78adb9af88f3334db69ad71741f2c8`. All seven generated
  implementation/schema/doc surfaces are byte-equal; decisions are 3/3 and
  final step 12 occurs once.
- Normal non-force feature push advanced only
  `refs/heads/feature/PJAN-21-post-loop-main`. Local HEAD, fresh
  `ls-remote`, and fetched `FETCH_HEAD` all equal
  `23e5a4fbdd78adb9af88f3334db69ad71741f2c8`. Hermes local and remote main
  remain `62c05b578cfb5e310292e8034626436335bb1677`.
- Parent `npm run typecheck` and `npm run build` pass.
- Direct parent suites pass:
  - parity migration
  - MCP catalog
  - MCP server
  - project registry
  - deterministic bounded PG harness self-test
  - real PostgreSQL registry round trip
- PG output:

  ```text
  PASS pg-registry-regressions self-test bounded_children=2 capability_probes=2
  PG_STORE_CHECK_OK: yaml + pg round-trip correct; dual-write ok; legacy slug-NULL row untouched.
  pg-registry-regressions OK
  ```
- Full parent `npm test` still stops at the unchanged copied-CommonProject
  Skillex fixture because the packaged template directory is absent. This
  ticket changes no CommonProject, fixture, package, source, or generated
  parent build file.
- `npm ci --ignore-scripts --dry-run` still exits `1` on the unchanged
  package/lock mismatch beginning with `@types/pg`, `node-pg-migrate`, and
  `pg`.
- `git submodule status --recursive` still exits `128` because the existing
  `.tmp/plugins` gitlink has no `.gitmodules` mapping. This ticket does not
  change `.gitmodules` or orphan gitlinks.
- The real absolute close gate was invoked from unrelated cwd `/tmp` using the
  exact committed Copier `9.14.0` render and explicit parent root. Exact output:

  ```text
  CLOSE GATE: PASS for PJAN-21
  ```

  It emitted close-gate event
  `f6a062d2-caf3-4abe-bad8-e40efdc62f04`.
- No live Plane, Linear, or Trello mutation was invoked. No parent remote
  branch, main branch, tag, release, version, package file, task ledger,
  CommonProject, root-main event ledger, or unrelated file was changed.

## Ledger Update

Ledger updated: yes

- Canonical threat-model decision copied byte-for-byte:
  `43cffa92-7ca9-4369-8f39-9d74d56aa6cb`.
- V13 implementation event:
  `c0a9e9c1-bb7f-4793-9d9e-feb956b3644c`.
- V13 close-gate event:
  `f6a062d2-caf3-4abe-bad8-e40efdc62f04`.
- V12 implementation and close-gate events:
  `253284c2-fecb-4a06-aa18-250808c7b85f`,
  `ac67c0d3-87f9-4405-a1bd-01ffd37fa31d`.
- V11 implementation and close-gate events:
  `72f5d5a0-60fc-44df-89e3-4c9b7af87f68`,
  `ec5a1814-e6d6-4275-bcf7-687e80c8ed12`.
- V10 implementation and close-gate events:
  `f4d3dd09-f6bb-4fb4-92d0-3f45ac3486e4`,
  `e718c14a-2301-46d8-8b49-a11740925ec5`.
- V8 implementation and close-gate events:
  `fdc9220a-0eab-452a-8459-d2fb3bdaa757`,
  `66aa623d-af98-4b1f-bd31-83f56f9aa33e`.
- Original restoration decision:
  `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Doctor Von Code hold:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- SyntaxSorcerer hold:
  `835ed986-fbc2-416a-ace2-fb8479ce61ff`.
- Professor Fiddlesticks hold:
  `2703a751-2696-4108-89f7-ae8cd800b003`.

## Known Gaps

- `pjangler:PJAN-23` owns a future create-issue adapter operation. Generated
  Hermes protocol contains no PJAN reference and requires an existing local
  tracking reference.
- The unprivileged runtime intentionally trusts same-OS-UID peers and does not
  prevent an independent trusted peer from renaming an already-open directory
  inside the final syscall window. Privileged immutable/mount helpers and a
  trusted mutation daemon remain deferred architecture options.
- Successful provider delivery requires Linux with a trusted Bubblewrap binary
  and a pidfd-capable kernel. Unsupported or unverifiable containment fails
  closed before a board side effect.
- Parent dependency hygiene remains outside PJAN-21: package declarations and
  `package-lock.json` are not synchronized, so clean `npm ci` rejects the
  unchanged baseline.
- The parent copied-CommonProject Skillex fixture remains outside PJAN-21 and
  fails when its packaged template directory is absent.
- Recursive submodule inspection remains outside PJAN-21 because existing
  `.tmp/plugins` and `memories` gitlinks lack `.gitmodules` mappings.
- Provider integration is verified with deterministic local fakes; no live
  comment delivery or ticket transition was attempted.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged by this work.

## Close Recommendation

Close recommendation: ready

- Rationale: the impossible six-probe demand is preserved as feasibility
  evidence and replaced by the canonical amended threat model; all in-scope
  defects have red/green executable coverage; 124 Hermes tests, static/schema
  checks, the exact committed seven-surface render, feature-ref readback,
  parent typecheck/build, bounded PG self-test, and real PostgreSQL round trip
  pass. The real close gate passes and its canonical event is recorded. This is
  implementation readiness for fresh independent specification and quality
  review, not a claim of acceptance.
