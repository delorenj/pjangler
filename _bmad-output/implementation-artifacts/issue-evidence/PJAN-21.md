# Evidence: PJAN-21 — v15 storage provenance and render portability

## Issue

- Ticket: PJAN-21
- State: In Progress; Gate 2 unopened
- Worker: Agent Buttercup / Codex CLI
- Momo Gate 1 hold decision:
  `9fa71fff-87fc-4f9f-a9ef-ab47ac9b8054`
- Momo hold Plane comment:
  `66677550-987e-4cde-a54a-b8fd1922baca`
- Canonical same-UID threat-model decision:
  `43cffa92-7ca9-4369-8f39-9d74d56aa6cb`
- Canonical threat-model Plane comment:
  `5a646310-0f79-4866-a202-9aba6558b7ed`
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent starting candidate:
  `7cf98590fda77613e3175dd183e1e491f7cf9b8d`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes starting candidate:
  `c373f9b11ef962f4493c3b6cd6859faaca68d253`
- Hermes v15 implementation:
  `3132a0f0ca223d499e0870f8a0057fc84f6a17f0`
- Hermes feature ref and fresh fetch:
  `3132a0f0ca223d499e0870f8a0057fc84f6a17f0`
- Hermes local and remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`
- Parent local and remote main, unchanged:
  `3664bd3dac75b152a16276645f4b6751f49d5023`

## Acceptance Criteria

1. Preserve the post-loop protocol: step 11 asks exactly what hurt, what
   should change, and whether the fix is repo-local versus
   external/template/fleet; step 12 remains the final checkpoint.
2. From read through provider launch, retain and revalidate safe ownership,
   expected regular-file/directory type, mode `& 0022 == 0`, stable
   descriptor identity, current path identity, and byte digest for run-retro
   storage, the immutable artifact, and its deterministic binding.
3. Open `.project.json` once, retain that descriptor through launch, and
   revalidate its identity, bytes, canonical repository, provider, and bound
   provider configuration before the external effect.
4. Descriptor-walk and validate every relevant repository-origin containing
   directory before pathname reuse. Detectable unsafe metadata, replacement,
   or identity drift must fail closed before provider launch and before routing
   finalization.
5. A Copier 9.14.0 render created under umask `002` must not rely on source
   checkout modes. Its first provisioning task must reject untrusted
   symlink/ownership metadata, normalize required directories and executables
   to `0755`, normalize non-executable repository inputs to `0644`, and retain
   private run-retro storage at `0700/0600`.
6. Preserve the amended unprivileged threat model: same-OS-UID peer processes
   are trusted, while symlinks, replacement trees, stale identities detectable
   before mutation, and repository content writable by other identities are
   rejected.
7. Preserve the v14 environment allowlist, read-only-root plus dedicated-temp
   containment, bounded complete provider-subtree teardown, provider-neutral
   routing, trusted one-shot finalization, closed safe shapes, typed IDs,
   bounded I/O/pagination, binding durability, schema/runtime parity, and
   rooted close-gate guarantees.

## Repo Changes

- Hermes commit `3132a0f0ca223d499e0870f8a0057fc84f6a17f0`
  changes exactly six paths relative to
  `c373f9b11ef962f4493c3b6cd6859faaca68d253`:
  - `copier.yml`
  - `template/.scripts/02-security-modes.sh`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `tests/test_run_retro_contract.py`
- The controller now retains `.project.json`, the prepared artifact, and its
  binding as validated descriptors. The detached supervisor inherits the
  repository, configuration, retro-store, bindings-store, artifact, and
  binding descriptors and revalidates their metadata, identities, current
  entries, bytes, and immutable intent after acquiring the keyed comment lock
  and before starting the provider.
- Repository, storage, controller, provider, and configuration path walks use
  descriptor-relative no-follow opens and validate every traversed
  repository-origin component. Unsafe owner, type, group/world write mode,
  replacement, or digest drift raises a sanitized failure before provider
  launch; delivery does not finalize routing after such a trust failure.
- Copier runs the new local-only `.scripts/02-security-modes.sh` task first.
  It performs no network or fleet action, rejects symlinks and foreign
  ownership, then normalizes rendered repository inputs to the documented
  `0755`, `0644`, `0700`, and `0600` modes.
- Positive delivery fixtures now create their own safe controller and provider
  modes rather than inheriting mode bits from the Hermes source checkout.
- Prompt and orchestration documentation contain the same retained-descriptor,
  metadata, identity, render-portability, and amended same-UID trust contract.
  Generated surfaces contain no PJAN-local reference.
- Parent changes are limited to the Hermes gitlink, this PJAN-21 evidence, and
  the candidate BloodBank event ledger.

## Verification

### Review lineage

- Sir Fix-a-Lot approved the original exactly-three-decisions protocol
  specification.
- Doctor Von Code's prior holds established the durable artifact,
  sanitization, provider/source/target binding, pagination, containment,
  idempotency, and trusted-finalization properties retained by the current
  suite.
- Fresh Gate 1 review held exact parent
  `7cf98590fda77613e3175dd183e1e491f7cf9b8d` / Hermes
  `c373f9b11ef962f4493c3b6cd6859faaca68d253`: writable retro storage could
  substitute another closed-shape artifact/binding target; `.project.json`
  was not retained; repository/controller parent chains were incomplete; and
  umask-`002` render modes caused normal delivery to fail.
- Momo decision `9fa71fff-87fc-4f9f-a9ef-ab47ac9b8054` was copied
  byte-for-byte from the root ledger. No Plane mutation was performed by the
  implementation worker.

### Red-first receipts

- Six deterministic v15 regressions were frozen and run against Hermes
  `c373f9b11ef962f4493c3b6cd6859faaca68d253` before runtime changes:

  ```text
  Ran 6 tests in 2.850s
  FAILED (failures=3, errors=3)
  ```

- Exact candidate failures:
  - a group/world-writable artifact and binding could be replaced with a
    valid closed-shape document targeting another canonical issue without the
    controller rejecting delivery;
  - foreign-owned artifact/binding and foreign replacement-tree probes reached
    their protected-file read oracles instead of failing closed earlier;
  - `RepositorySession` had no retained `project_fd`;
  - a world-writable controller component was not rejected;
  - the umask-`002` Copier render had no security-mode task.
- Independent exact-candidate render receipt:

  ```text
  copier_result=0
  775 output
  775 output/.scripts
  775 output/.scripts/sentinel
  775 output/.scripts/sentinel/bin
  775 output/.scripts/providers
  775 output/.scripts/sentinel/bin/run-retro.py
  775 output/.scripts/providers/plane.sh
  ```

### Green receipts and boundary evidence

- The same six focused regressions after the repair:

  ```text
  Ran 6 tests in 2.875s
  OK
  ```

- The combined trust, render, and protocol parity focus:

  ```text
  Ran 16 tests in 6.995s
  OK
  ```

- Those executable tests prove:
  - writable storage substitution, foreign ownership, and foreign replacement
    trees fail before provider launch, endpoint use, environment exposure, or
    routing finalization;
  - the exact configuration, artifact, and binding descriptors remain held
    and byte-bound through the supervisor's post-lock validation;
  - controller/provider/repository/storage path components must retain safe
    owner, type, mode, and identity;
  - the v14 explicit provider environment, read-only root, dedicated temporary
    directory, and full subtree cleanup remain effective;
  - an exact Copier 9.14.0 umask-`002` render normalizes modes and completes a
    contained deterministic fake delivery.
- Full exact Hermes suite after Ruff formatting:

  ```text
  Ran 137 tests in 34.314s
  OK
  ```

- Ruff check and Ruff format-check pass for the controller and contract tests.
  Python compilation passes.
- Bash and dash syntax checks pass for the security-mode task, Plane, Linear,
  Trello, issue-close-gate, and related shell providers.
- Draft 2020-12 metaschema validation passes. Jinja parses with 8 opening and
  8 closing delimiters. All 28 embedded provider Python blocks compile.
  Prompt/docs normalized parity passes. The prompt contains one step 11 with
  exactly 3 locked decisions and one final step 12.
- Exact Copier `9.14.0` verification used a clean archive of committed Hermes
  `3132a0f0ca223d499e0870f8a0057fc84f6a17f0` with `--trust --skip-tasks
  --defaults`, `target_repo=pjangler`, `role=pm`, `ticket_provider=trello`,
  and umask `002`. All seven generated controller/schema/docs/provider
  surfaces are byte-equal to committed source; generated PJAN references and
  cache files both count zero. The expected pre-task `0775` inputs became
  `0755/0644` after the exact first Copier task. A second exact committed
  render completed the contained fake-provider delivery:

  ```text
  test_umask_002_render_normalizes_modes_and_delivers_with_rendered_controller ... ok
  Ran 1 test in 0.374s
  OK
  ```

- Normal non-force push advanced only
  `refs/heads/feature/PJAN-21-post-loop-main`. `ls-remote`, a fresh fetch, and
  local Hermes HEAD all read
  `3132a0f0ca223d499e0870f8a0057fc84f6a17f0`. Hermes main remained
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Bounded parent `npm run typecheck` and `npm run build` pass.
- Bounded direct parent parity migration, MCP catalog, MCP server, and project
  registry suites pass.
- Bounded PostgreSQL harness self-test:

  ```text
  PASS pg-registry-regressions self-test bounded_children=2 capability_probes=2
  ```

- Real local PostgreSQL round trip:

  ```text
  PG_STORE_CHECK_OK: yaml + pg round-trip correct; dual-write ok; legacy slug-NULL row untouched.
  pg-registry-regressions OK
  ```

- Parent `npm test` remains an honest bounded baseline failure: parity passes,
  then the unchanged Skillex copied-CommonProject fixture exits `1` because
  its packaged local template directory is absent. PJAN-21 changes no package,
  CommonProject, fixture, parent source, or build output.
- Parent and Hermes `git diff --check` pass.
- No live Plane, Linear, or Trello call was made. No parent remote branch,
  main branch, tag, release, version, package file, task ledger, CommonProject,
  root-main event ledger, or unrelated file was changed.

## Ledger Update

Ledger updated: yes

- V15 Gate 1 hold decision copied byte-for-byte:
  `9fa71fff-87fc-4f9f-a9ef-ab47ac9b8054`.
- V15 implementation event:
  `5ad71773-a248-4f67-bffa-642c179b1449`.
- V14 implementation and close-gate events:
  `84702a1e-df9c-484c-a2bd-b7f5a46acef0`,
  `5a517fe5-0775-4253-be71-ff2881098c93`.
- Canonical same-UID threat-model decision:
  `43cffa92-7ca9-4369-8f39-9d74d56aa6cb`.
- Original restoration decision:
  `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Doctor Von Code hold:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- SyntaxSorcerer identity hold:
  `835ed986-fbc2-416a-ace2-fb8479ce61ff`.
- Professor Fiddlesticks identity hold:
  `2703a751-2696-4108-89f7-ae8cd800b003`.

## Known Gaps

- This is implementation readiness for a completely fresh Gate 1 review. It
  is not a claim of acceptance, and Gate 2 remains unopened.
- `pjangler:PJAN-23` owns a future create-issue adapter operation. Generated
  Hermes protocol contains no PJAN reference and requires an existing local
  tracking reference.
- The unprivileged runtime intentionally trusts same-OS-UID peers and does not
  claim to prevent an independent trusted peer from renaming an already-open
  directory inside the final syscall window. Privileged immutable/mount
  helpers and a trusted mutation daemon remain deferred architecture options.
- Successful provider delivery requires Linux with trusted Bubblewrap and
  pidfd support. Unsupported or unverifiable containment fails closed before a
  board side effect.
- Full parent `npm test` reaches the unchanged Skillex copied-CommonProject
  fixture and exits `1` because its packaged template directory is absent.
- `npm ci --ignore-scripts --dry-run` has an unchanged package/lock mismatch
  beginning with `@types/pg`, `node-pg-migrate`, and `pg`.
- Recursive submodule inspection exits `128` because existing `.tmp/plugins`
  lacks a `.gitmodules` mapping. PJAN-21 changes none of these baseline
  surfaces.
- Provider integration uses deterministic local fakes and a local test
  endpoint; no live ticket-provider delivery or transition was attempted.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged.

## Close Recommendation

Close recommendation: ready

- Rationale: the exact Gate 1 failures are locked into executable regressions
  and now fail closed; `.project.json`, retro storage, artifacts, and bindings
  remain descriptor- and byte-bound through provider launch; rendered modes
  are deterministic under umask `002`; 137 Hermes tests, static/schema checks,
  exact seven-surface render, feature-ref readback, parent typecheck/build and
  direct suites, bounded PG self-test, and the real local PG round trip pass.
  The residual parent failures are unchanged out-of-scope baselines. This
  recommendation means readiness for fresh independent Gate 1 review, not
  acceptance.
