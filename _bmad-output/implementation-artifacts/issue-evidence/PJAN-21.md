# Evidence: PJAN-21 — v14 provider execution boundary

## Issue

- Ticket: PJAN-21
- State: In Progress; Gate 2 unopened
- Worker: Agent Buttercup / Codex CLI
- SyntaxSorcerer Gate 1 comment:
  `2029058e-b78c-42ec-a0dd-96f24cf5e47f`
- Momo hold decision:
  `777944dd-4959-42cd-bc0a-275867cd8d9b`
- Canonical same-UID threat-model decision:
  `43cffa92-7ca9-4369-8f39-9d74d56aa6cb`
- Canonical threat-model Plane comment:
  `5a646310-0f79-4866-a202-9aba6558b7ed`
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent starting candidate:
  `8641351ac7dbb0596745b9ed23e1de23adaed6be`
- Parent implementation commit:
  `7b33b32c5ccacce507b254bb9a4d4718132c085f`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes starting candidate:
  `23e5a4fbdd78adb9af88f3334db69ad71741f2c8`
- Hermes implementation:
  `c373f9b11ef962f4493c3b6cd6859faaca68d253`
- Hermes feature ref and fresh fetch:
  `c373f9b11ef962f4493c3b6cd6859faaca68d253`
- Hermes local and remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`
- Parent local and remote main, unchanged:
  `3664bd3dac75b152a16276645f4b6751f49d5023`

## Acceptance Criteria

1. Preserve the post-loop protocol: step 11 asks exactly what hurt, what
   should change, and whether the fix is repo-local versus
   external/template/fleet; step 12 remains the final checkpoint.
2. Before provider launch, validate stable descriptor identity, approved
   ownership, expected file type, executability where required, and absence
   of group/world write permission for the provider, controller,
   `.project.json`, repository root, and every repository-origin path
   component consumed by delivery.
3. Revalidate those bound identities and configuration bytes immediately
   before launch. Detectable drift fails closed with sanitized output.
4. Give the provider an explicit environment containing fixed runtime fields
   and only provider-specific artifact-bound configuration. Controller-only
   environment values are absent and secrets are never printed.
5. Execute inside a read-only root with only the identity-checked prepared
   repository and a fresh dedicated temporary directory writable. Reap the
   complete provider subtree before removing the temporary directory and
   releasing the exact keyed comment lock.
6. Preserve the amended unprivileged threat model: same-OS-UID peers are
   trusted, while symlinks, replacement trees, stale identities detectable
   before mutation, and repository content writable by other identities are
   rejected.
7. Preserve prior durability, binding schema typing, closed persisted shapes,
   source/target/body binding, pagination and typed-ID behavior, bounded I/O,
   schema/runtime parity, and provider-neutral behavior.

## Repo Changes

- Hermes commit `c373f9b11ef962f4493c3b6cd6859faaca68d253`
  changes exactly four paths relative to
  `23e5a4fbdd78adb9af88f3334db69ad71741f2c8`:
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `tests/test_run_retro_contract.py`
- Delivery opens repository-origin inputs descriptor-relatively with
  no-follow semantics. It checks every containing directory plus the provider,
  controller, repository root, and `.project.json` for stable device/inode
  identity, approved ownership, expected type, and no group/world write bit.
  Provider and controller files must also be executable.
- The repository and configuration digest are rebound and revalidated
  immediately before provider launch. Provider and repository descriptors are
  passed into the trusted supervisor and validated there again.
- Provider execution no longer inherits the controller environment. A fixed
  system `PATH`, bounded locale/proxy/certificate fields, the bound provider
  name/configuration, and only the selected adapter's required credential and
  endpoint fields are supplied.
- Bubblewrap exposes `/` read-only, then overlays only the identity-checked
  prepared repository and a fresh dedicated temporary directory as writable.
  Provider-subtree containment completes before that temporary directory is
  removed or the keyed comment lock is released.
- Prompt and orchestration documentation describe the same descriptor,
  environment, containment, and same-UID trust contract. Generated surfaces
  contain no PJAN-local reference.
- Parent changes are limited to the Hermes gitlink, this PJAN-21 evidence, and
  the candidate BloodBank event ledger.

## Verification

### Review lineage

- Sir Fix-a-Lot approved the original exactly-three-decisions protocol
  specification.
- Doctor Von Code's earlier holds drove the durable artifact, sanitization,
  deterministic routing, idempotency, and generated-protocol repairs retained
  by the current suite.
- SyntaxSorcerer held exact parent
  `8641351ac7dbb0596745b9ed23e1de23adaed6be` / Hermes
  `23e5a4fbdd78adb9af88f3334db69ad71741f2c8` because an untrusted provider
  file could execute with the full controller environment and a writable
  containment root.
- Momo decision `777944dd-4959-42cd-bc0a-275867cd8d9b` keeps PJAN-21 active
  for this narrow Gate 1 remediation. No Plane mutation was performed by the
  implementation worker.

### Red-first receipts

- The two exact regressions were added before runtime changes and run against
  Hermes `23e5a4fbdd78adb9af88f3334db69ad71741f2c8`:

  ```text
  test_mode_0666_provider_is_rejected_before_launch ... FAIL
  test_world_writable_provider_component_is_rejected_before_launch ... FAIL
  Ran 2 tests in 1.212s
  FAILED (failures=2)
  ```

- An exact-candidate diagnostic confirmed all prohibited effects:

  ```text
  mode_0666: result=posted routing=posted marker_read=True outside_write=True endpoint_calls=1
  world_writable_component: result=posted routing=posted marker_read=True outside_write=True endpoint_calls=1
  ```

### Green receipts and boundary evidence

- Focused seven-test provider-boundary suite:
  `Ran 7 tests in 4.134s`, `OK`.
- Those tests prove, without exposing credentials:
  - mode-`0666` and non-executable providers fail before launch;
  - group/world-writable provider components and repository roots fail before
    launch;
  - a group/world-writable `.project.json` and an untrusted controller fail
    before launch;
  - the provider cannot observe a synthetic controller-only marker or the
    controller's temporary-directory setting;
  - Plane, Trello, and Linear receive only their selected bound adapter fields;
  - a realistic local provider can use its dedicated temporary directory and
    complete one endpoint call, while an outside write is blocked;
  - the temporary directory is removed and a delayed descendant cannot make a
    second endpoint call after subtree cleanup.
- Full exact Hermes suite:

  ```text
  Ran 131 tests in 31.468s
  OK
  ```

- Existing executable coverage remains green for serial 7-of-7 idempotency,
  concurrent comment keys, controller death, provider descendants,
  artifact-bound finalization, immutable marker/body, canonical
  provider/source/target binding, malformed bytes, bounded HTTP/provider data,
  Plane cursor and terminal-page behavior, symlink and replacement attacks,
  binding retry durability, non-boolean binding versions, monotonic
  finalization, and schema/runtime acceptance parity.
- Ruff check and Ruff format-check pass. Python compilation passes.
- `sh -n` and `dash -n` pass for the Plane, Linear, Trello, provider-adapter,
  and issue-close-gate scripts.
- Draft 2020-12 metaschema validation passes. Jinja has 8 opening and 8 closing
  delimiters. All 28 embedded provider Python blocks compile. Prompt/docs
  normalized parity passes. The prompt has exactly 3 locked step-11 decisions
  and one final step 12.
- Exact Copier `9.14.0` render used a clean archive of committed Hermes
  `c373f9b11ef962f4493c3b6cd6859faaca68d253` with `--trust --skip-tasks
  --defaults`, `target_repo=pjangler`, `role=pm`, and
  `ticket_provider=trello`. All seven generated controller/schema/docs/provider
  surfaces are byte-equal to committed source; generated PJAN references and
  cache files both count zero.
- Normal non-force push advanced only
  `refs/heads/feature/PJAN-21-post-loop-main`. `ls-remote`, a fresh fetch, and
  local Hermes HEAD all read
  `c373f9b11ef962f4493c3b6cd6859faaca68d253`. Hermes main remains
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Parent `npm run typecheck` and `npm run build` pass.
- Direct parent parity migration, MCP catalog, MCP server, and project registry
  suites pass.
- Bounded PostgreSQL harness self-test:

  ```text
  PASS pg-registry-regressions self-test bounded_children=2 capability_probes=2
  ```

- Real local PostgreSQL round trip:

  ```text
  PG_STORE_CHECK_OK: yaml + pg round-trip correct; dual-write ok; legacy slug-NULL row untouched.
  pg-registry-regressions OK
  ```

- Parent and Hermes `git diff --check` pass.
- The real close gate was invoked from unrelated cwd `/tmp` through the
  absolute script path from the exact committed Copier render, with the parent
  repository supplied explicitly:

  ```text
  CLOSE GATE: PASS for PJAN-21
  ```

  It emitted event `5a517fe5-0775-4253-be71-ff2881098c93`.
- No live Plane, Linear, or Trello mutation was invoked. No parent remote
  branch, main branch, tag, release, version, package file, task ledger,
  CommonProject, root-main ledger, or unrelated file was changed.

## Ledger Update

Ledger updated: yes

- Gate 1 hold decision copied byte-for-byte:
  `777944dd-4959-42cd-bc0a-275867cd8d9b`.
- V14 implementation event:
  `84702a1e-df9c-484c-a2bd-b7f5a46acef0`.
- V14 close-gate event:
  `5a517fe5-0775-4253-be71-ff2881098c93`.
- Canonical same-UID threat-model decision:
  `43cffa92-7ca9-4369-8f39-9d74d56aa6cb`.
- V13 implementation and close-gate events:
  `c0a9e9c1-bb7f-4793-9d9e-feb956b3644c`,
  `f6a062d2-caf3-4abe-bad8-e40efdc62f04`.
- Original restoration decision:
  `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Doctor Von Code hold:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- SyntaxSorcerer identity hold:
  `835ed986-fbc2-416a-ace2-fb8479ce61ff`.
- Professor Fiddlesticks identity hold:
  `2703a751-2696-4108-89f7-ae8cd800b003`.

## Known Gaps

- This is implementation readiness for a fresh Gate 1 review. It is not a
  claim of acceptance, and Gate 2 remains unopened.
- `pjangler:PJAN-23` owns a future create-issue adapter operation. Generated
  Hermes protocol contains no PJAN reference and requires an existing local
  tracking reference.
- The unprivileged runtime intentionally trusts same-OS-UID peers and does not
  prevent an independent trusted peer from renaming an already-open directory
  inside the final syscall window. Privileged immutable/mount helpers and a
  trusted mutation daemon remain deferred architecture options.
- Successful provider delivery requires Linux with trusted Bubblewrap and
  pidfd support. Unsupported or unverifiable containment fails closed before a
  board side effect.
- Full parent `npm test` reaches the unchanged Skillex copied-CommonProject
  fixture and exits `1` because its packaged template directory is absent.
  PJAN-21 changes no CommonProject, fixture, package, parent source, or
  generated parent build file.
- `npm ci --ignore-scripts --dry-run` exits `1` on the unchanged package/lock
  mismatch beginning with `@types/pg`, `node-pg-migrate`, and `pg`.
- Recursive submodule inspection exits `128` because existing `.tmp/plugins`
  lacks a `.gitmodules` mapping. PJAN-21 changes neither surface.
- Provider integration uses deterministic local fakes and a local HTTP
  endpoint; no live ticket-provider delivery or transition was attempted.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged.

## Close Recommendation

Close recommendation: ready

- Rationale: the exact Gate 1 exploit fails closed under executable
  regressions; the environment and writable-filesystem boundaries are explicit
  and tested; 131 Hermes tests, static/schema checks, exact seven-surface
  render, feature-ref readback, parent typecheck/build/direct suites, bounded
  PG self-test, real PostgreSQL round trip, and unrelated-cwd close gate pass.
  The residual parent failures are unchanged out-of-scope baselines. This
  recommendation means readiness for fresh independent Gate 1 review, not
  acceptance.
