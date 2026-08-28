# Evidence: PJAN-21 — v17 ancestor-bound Copier bootstrap

## Issue

- Ticket: PJAN-21
- State: In Progress; Gate 2 unopened
- Worker: Agent Buttercup / Codex CLI
- V17 Momo Gate 1 hold decision:
  `be2b424c-a555-45b2-9446-a2b4fd210183`
- V17 Momo hold Plane comment:
  `65ee11cd-69ba-4318-9ed5-6e225b910f72`
- Canonical same-UID threat-model decision:
  `43cffa92-7ca9-4369-8f39-9d74d56aa6cb`
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent v17 starting candidate:
  `73c38929e06ba9674610cb46790bc5db5e0d31b4`
- Parent v17 implementation commit:
  `56edc75292c574b2c4eab125fe9ee19e14a4a7bd`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes v17 starting candidate:
  `be4dd9704227f41add9cd62d396aaa22aaeadb27`
- Hermes v17 commit:
  `a5184e9a08eb272a16b1052178ca14c57ae2d18d`
- Hermes feature ref and fresh fetch:
  `a5184e9a08eb272a16b1052178ca14c57ae2d18d`
- Hermes local and remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`
- Parent local and remote main, unchanged:
  `3664bd3dac75b152a16276645f4b6751f49d5023`

## Acceptance Criteria

1. Preserve the post-loop protocol: step 11 asks exactly what hurt, what
   should change, and whether the fix is repo-local versus
   external/template/fleet; step 12 remains the final checkpoint.
2. Copier's first task must not chmod or execute
   `.scripts/02-security-modes.sh` through a rendered pathname before trust is
   established.
3. Before any mutation, trusted Copier-controlled logic must open the rendered
   output, `.scripts`, and the bootstrap entry descriptor-relatively with
   no-follow semantics and validate approved ownership, expected type, and
   stable descriptor/path identity.
4. Normalization must use held descriptors and revalidate those entries. The
   rendered bootstrap entry is data only, becomes non-executable `0644`, and
   is never executed during Copier bootstrap.
5. Bootstrap-file symlinks, `.scripts` parent substitution, and malicious
   regular bootstrap content must not change an external target, create an
   external effect, or execute substituted content.
6. Preserve successful Copier 9.14.0 rendering under umask `002`: required
   directories, providers, controllers, and subsequent tasks become `0755`;
   non-executable inputs become `0644`; run-retro private storage remains
   `0700/0600`; contained deterministic fake delivery succeeds.
7. Select an ancestor repository only when its descriptor-bound
   `.project.json.project_name` is an exact string match for the Copier
   `target_repo` and the output's canonical path is exactly
   `<repo>/agents/hermes/<role>`. Either mismatch must normalize only the
   rendered output and leave all ancestor modes unchanged.
8. Preserve every v16 guarantee: retained configuration/storage/artifact/
   binding descriptors, repository-path validation, environment allowlist,
   read-only-root containment, complete provider-subtree teardown,
   provider-neutral routing, trusted finalization, typed IDs, bounded I/O and
   pagination, schema/runtime parity, and rooted close-gate behavior.

## Repo Changes

- Hermes head `a5184e9a08eb272a16b1052178ca14c57ae2d18d`
  changes exactly four paths relative to
  `be4dd9704227f41add9cd62d396aaa22aaeadb27`:
  - `copier.yml`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `tests/test_run_retro_contract.py`
- The first Copier task is now inline trusted Python held in `copier.yml`.
  Before any chmod, it opens the output root, `.scripts`, and the bootstrap
  entry with `O_NOFOLLOW`, validates owner/type/identity, then changes modes
  only through the retained descriptors and revalidates the path entries.
- The inline task performs the complete tree normalization itself. It never
  invokes the rendered bootstrap file. That file is now source mode `0644`,
  remains rendered data at `0644`, and is documented as a manual helper rather
  than a Copier bootstrap executable.
- Repository-root discovery now retains the candidate repository and manifest
  descriptors, parses at most 65,536 strict UTF-8 JSON bytes, and selects that
  ancestor only when `project_name` is a string byte-equal to Copier
  `target_repo` and the output path is exactly
  `<candidate>/agents/hermes/<role>`. Missing, malformed, mismatched, or
  noncanonical candidates leave `repo_fd` bound to the output root.
- Two red-first v17 regressions cover an unrelated managed ancestor at the
  otherwise canonical role path and a matching-looking manifest at a
  noncanonical output path. A third positive control proves the matching
  project/path pair still normalizes the intended repository.
- Three durable tests cover bootstrap-file symlink substitution, `.scripts`
  parent-directory substitution, and chmod/execution separation with
  malicious regular content. They verify return disposition, exact external
  mode, absence of execution markers, and unchanged ancestor metadata.
- Prompt and orchestration documentation contain the same inline-bootstrap,
  held-descriptor, non-execution, render-mode, and amended same-UID contract.
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
- Fresh SyntaxSorcerer Gate 1 held exact parent
  `73c38929e06ba9674610cb46790bc5db5e0d31b4` / Hermes
  `be4dd9704227f41add9cd62d396aaa22aaeadb27` on one High AC5 finding:
  any same-owner regular ancestor `.project.json` was sufficient for
  repository normalization, even when its project identity and the rendered
  role path did not belong to this Copier invocation. No critical finding was
  reported, and Gate 2 remained unopened.
- Fresh Gate 1 review held exact parent
  `49feda59e04f0134df70fa72154ec5bc26b0856b` / Hermes
  `3132a0f0ca223d499e0870f8a0057fc84f6a17f0` because the first Copier task
  ran `chmod 0755 .scripts/02-security-modes.sh &&
  ./.scripts/02-security-modes.sh` before that rendered path could validate
  its symlink, owner, type, or identity.
- Momo decision `be2b424c-a555-45b2-9446-a2b4fd210183` was copied
  byte-for-byte from the root ledger. No Plane mutation was performed by the
  implementation worker.

### V17 red-first receipts

- The two deterministic ancestor regressions were added before implementation
  and run against unchanged Hermes
  `be4dd9704227f41add9cd62d396aaa22aaeadb27`:

  ```text
  Ran 2 tests in 0.592s
  FAILED (failures=12)
  ```

- Both cases returned success but changed all six ancestor modes:

  ```text
  repository: 0770 -> 0755
  .project.json: 0660 -> 0644
  _bmad-output: 0770 -> 0755
  implementation-artifacts: 0770 -> 0755
  run-retros: 0770 -> 0700
  existing-private.json: 0660 -> 0600
  ```

### V16 red-first receipts

- The three deterministic bootstrap regressions were added before
  implementation and run against Hermes
  `3132a0f0ca223d499e0870f8a0057fc84f6a17f0`:

  ```text
  Ran 3 tests in 0.727s
  FAILED (failures=3)
  ```

- Exact vulnerable outcomes:

  ```text
  bootstrap file symlink: accepted=True outside_mode=0755 executed=True
  .scripts parent symlink: accepted=True outside_mode=0755 executed=True
  regular substituted bootstrap: executed=True
  ```

  Both external targets began at `0644`. The committed v15 task followed the
  substituted pathname, changed the external target to `0755`, and invoked the
  substituted content.

### V17 green receipts and security closure

- The same two hostile regressions plus the canonical legitimate control:

  ```text
  Ran 3 tests in 0.967s
  OK
  ```

- Full Hermes discovery, preserving all prior tests and adding the three v17
  cases:

  ```text
  Ran 143 tests in 40.351s
  OK
  ```

- A clean archive of committed Hermes
  `a5184e9a08eb272a16b1052178ca14c57ae2d18d` reran all six bootstrap
  trust tests, the umask/contained-delivery control, and both protocol parity
  tests:

  ```text
  Ran 9 tests in 3.506s
  OK
  ```

- The exact committed-archive mode audit proves both mismatches return `0`,
  normalize the output to `0755`, and leave the ancestor exactly unchanged:

  ```text
  ancestor_before=0770/0660/0770/0770/0770/0660
  ancestor_after=0770/0660/0770/0770/0770/0660
  ```

  The canonical `pjangler` plus `agents/hermes/pm` control alone changes those
  modes to `0755/0644/0755/0755/0700/0600`.
- The original v17 issue no longer reproduces: neither an unrelated
  `project_name` at the canonical role path nor a matching-looking manifest at
  a standalone path can select or mutate the ancestor. Legitimate matching
  provisioning still succeeds.
- Ruff check and format-check pass for the owned Python test. All seven Python
  sources compile. All template shell scripts pass Bash syntax; the normalizer,
  provider adapters, provider scripts, and close gate pass Dash syntax. The
  inline Copier Python and 33 embedded provider Python blocks compile.
- Draft 2020-12 metaschema validation passes. Jinja parses with 8 opening and
  8 closing delimiters. Prompt/docs v17 wording is whitespace-normalized
  identical. The prompt retains exactly three step-11 decisions and one final
  step 12.
- Exact Copier `9.14.0` committed-archive rendering used
  `--trust --skip-tasks --defaults`, `target_repo=pjangler`, `role=pm`,
  `ticket_provider=trello`, and umask `002`:

  ```text
  render_surfaces=7 byte_equal=yes
  rendered_prompt_values=resolved ancestor_contract=present
  pre_bootstrap_mode=0664 pre_provider_mode=0775
  post_bootstrap_mode=0644 post_provider_mode=0755
  generated_pjan_refs=0 cache_files=0
  rendered_bootstrap_executed=no
  ```

- A normal non-force push advanced only
  `refs/heads/feature/PJAN-21-post-loop-main`. `ls-remote`, a fresh fetch, and
  local Hermes HEAD all read
  `a5184e9a08eb272a16b1052178ca14c57ae2d18d`. Hermes main remained
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Bounded parent typecheck/build; parity migration, MCP catalog, MCP server,
  and project registry direct suites; the PG harness self-test; and the real
  local PG round trip all pass against this candidate.
- From unrelated cwd `/home/delorenj/.claude/tmp`, the exact Copier `9.14.0`
  rendered close-gate bytes and committed Hermes source both had SHA-256
  `cf2de6403f01b540cb23cc31ee3fbf055367849fd2e543ad41e0428077366cbf`.
  Invoking the rendered script through `sh` with the parent repository root
  passed explicitly produced:

  ```text
  CLOSE GATE: PASS for PJAN-21
  ```

### V16 green receipts retained as regression history

- The same three focused regressions after the repair:

  ```text
  Ran 3 tests in 0.864s
  OK
  ```

- Combined bootstrap, umask-delivery, v15 trust-boundary, and protocol parity
  focus:

  ```text
  Ran 19 tests in 7.938s
  OK
  ```

- Full Hermes suite, preserving the previous 137 tests and adding the three
  v16 regressions:

  ```text
  Ran 140 tests in 35.574s
  OK
  ```

- A clean archive of committed Hermes
  `be4dd9704227f41add9cd62d396aaa22aaeadb27` independently reran the three
  hostile probes plus the legitimate contained-delivery control:

  ```text
  Ran 4 tests in 1.211s
  OK
  ```

- The original exploit no longer reproduces:
  - bootstrap and parent symlinks fail before any chmod or execution;
  - the outside target remains exactly `0644`;
  - execution markers remain absent;
  - malicious regular bootstrap content is normalized to `0644` but never
    executed;
  - a synthetic ancestor Git repository without `.project.json` retains its
    original `0770` mode.
- Legitimate behavior remains intact: the exact committed-render test
  normalizes project/provider/controller inputs and completes one contained
  deterministic fake delivery with final routing status `posted`.
- Ruff check and Ruff format-check pass. Python compilation passes.
- Bash and dash syntax checks pass for the manual normalizer,
  issue-close-gate, and provider scripts.
- Draft 2020-12 metaschema validation passes. Jinja parses with 8 opening and
  8 closing delimiters. The inline Copier Python and all 28 embedded provider
  Python blocks compile. Prompt/docs normalized parity passes. The prompt
  contains one step 11 with exactly 3 locked decisions and one final step 12.
- Exact Copier `9.14.0` verification used a clean archive of committed Hermes
  with `--trust --skip-tasks --defaults`, `target_repo=pjangler`, `role=pm`,
  `ticket_provider=trello`, and umask `002`:

  ```text
  render_surfaces=7 byte_equal=yes
  pre_bootstrap_mode=0664 pre_provider_mode=0775
  post_bootstrap_mode=0644 post_provider_mode=0755
  generated_pjan_refs=0 cache_files=0
  ancestor_git_mode_unchanged=yes
  ```

- Normal non-force push advanced only
  `refs/heads/feature/PJAN-21-post-loop-main`. `ls-remote`, a fresh fetch, and
  local Hermes HEAD all read
  `be4dd9704227f41add9cd62d396aaa22aaeadb27`. Hermes main remained
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

- From unrelated cwd `/tmp`, Copier `9.14.0` rendered a clean archive of
  committed Hermes `be4dd9704227f41add9cd62d396aaa22aaeadb27` with
  `--skip-tasks`. The rendered and committed close-gate bytes both had SHA-256
  `cf2de6403f01b540cb23cc31ee3fbf055367849fd2e543ad41e0428077366cbf`.
  Invoking those exact rendered bytes through `sh` with the parent repository
  root passed explicitly produced:

  ```text
  CLOSE GATE: PASS for PJAN-21
  ```

- Parent `npm test` remains an honest bounded baseline failure: parity passes,
  then the unchanged Skillex copied-CommonProject fixture exits `1` because
  its packaged local template directory is absent. PJAN-21 changes no package,
  CommonProject, fixture, parent source, PG harness, or build output.
- Parent and Hermes `git diff --check` pass.
- No live Plane, Linear, or Trello call was made. No parent remote branch,
  main branch, tag, release, version, package file, task ledger, CommonProject,
  root-main event ledger, fleet/runtime state, or unrelated file was changed.

## Ledger Update

Ledger updated: yes

- V17 Gate 1 hold decision copied byte-for-byte:
  `be2b424c-a555-45b2-9446-a2b4fd210183`.
- V17 implementation event:
  `3c1a6326-d3ae-4339-b37b-88bf548f1fa8`.
- V17 close-gate event:
  `87f58908-f2f5-4fa9-92ae-f80acd71b90e`.
- V16 Gate 1 hold decision copied byte-for-byte:
  `1e9f0fa0-2dee-4bb7-a89d-1f6c8b7433de`.
- V16 implementation event:
  `b57bbfb8-a30b-4c15-8a38-c41d0922e033`.
- V16 close-gate event:
  `cf822191-45d8-4cca-97d9-5850eb31a3f4`.
- V15 implementation and close-gate events:
  `5ad71773-a248-4f67-bffa-642c179b1449`,
  `bb6e139b-90e0-4c52-a0dd-60d39ba756e6`.
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
- Full-repository Ruff reaches 13 unchanged style findings in the unrelated
  `template/.scripts/momo-wip-lock.py`; the owned v17 test passes Ruff check
  and format-check.
- `npm ci --ignore-scripts --dry-run` has an unchanged package/lock mismatch
  beginning with `@types/pg`, `node-pg-migrate`, and `pg`.
- Recursive submodule inspection exits `128` because existing `.tmp/plugins`
  lacks a `.gitmodules` mapping. PJAN-21 changes none of these baseline
  surfaces.
- Provider integration uses deterministic local fakes only; no live
  ticket-provider delivery or transition was attempted.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged.

## Close Recommendation

Close recommendation: ready

- Rationale: both v17 ancestor-selection bypasses are locked into executable
  committed-render regressions and now leave unrelated managed ancestors
  unchanged, while the exact matching project/path control, umask-`002`
  normalization, and contained fake delivery still work. All v16 descriptor,
  containment, routing, schema, privacy, and finalization guarantees remain
  green; 143 Hermes tests, static/schema checks, exact seven-surface render,
  feature-ref readback, parent typecheck/build and direct suites, bounded PG
  self-test, and the real local PG round trip pass. Residual failures are
  unchanged out-of-scope baselines. This recommendation means readiness for
  fresh independent Gate 1 review, not acceptance.
# Evidence: PJAN-21 — Hermes lifecycle: add a post-loop continuous-improvement phase

## Issue
- Ticket: PJAN-21
- Milestone / horizon: n/a (fleet-template lifecycle)
- Worker: general-purpose implementer subagent (Claude)
- Orchestrated by: momo

## Acceptance Criteria
1. Explicit "post-loop improvement" step added after the final "report board status" step in the template sentinel prompt (+ docs).
2. Step asks the three questions (what hurt / what should change / repo-local vs external-template-fleet).
3. Reflection always recorded as a run artifact; external/template/fleet improvements surfaced via `tp comment` + operator flag (adapter has no create-issue op); nothing silently dropped.
4. Suggested Momo board-clearing-loop.md mirror produced (handled as a separate reviewed step).
5. Protocol-level only — no new executable code.

## Repo Changes
- Branch: main working tree (uncommitted); base 42d22bf. Change lives in the `templates/hermes-agent` submodule working tree.
- Files changed:
  - `templates/hermes-agent/template/.scripts/sentinel.prompt.md.jinja` — appended numbered step 11 "Post-loop improvement (end-of-batch retro)".
  - `templates/hermes-agent/template/.scripts/sentinel/docs/continuous-ticket-orchestration.md` — appended matching "Post-loop improvement" doc section.
- Migrations / schema: none

## Verification
- Commands executed and results:
  - `git -C templates/hermes-agent diff --stat` → the two retro files changed, append-only; confirmed by both reviewers.
  - Jinja balance check → `{{ }}` 9/9 balanced, no `{% %}`; numbering contiguous 1→11.
- Independent adversarial review (reviewer ≠ implementer): first pass returned HOLD (AC3 over-promised adapter ticket-creation); implementer reworded; a second FRESH reviewer returned ACCEPT.
- AC → evidence mapping:
  - AC1 → step 11 placed directly after step 10 (report board status); numbering/jinja verified.
  - AC2 → three questions present verbatim in prompt + doc.
  - AC3 → always-record artifact + `tp comment` (op exists in contract) + operator flag; no fictional create-issue op; verified by fresh reviewer.
  - AC5 → only a .jinja prompt + .md doc changed; zero scripts.

## Ledger Update
- Bloodbank decision/events emitted: eea7b222 (design approach); accept event this pass (see bloodbank-events.jsonl)
- Ledger updated: yes

## Known Gaps
- The change is reviewed and accepted but UNCOMMITTED (working tree only). The `templates/hermes-agent` submodule tree also carries unrelated PJAN-17 (Linear-removal) WIP; PJAN-21's edits are append-only across two files and separable, so the operator should stage only those two files when committing.
- The Momo `board-clearing-loop.md` mirror is handled as a separate reviewed step (a suggested snippet was produced and captured).
- Full programmatic ticket-filing from the retro awaits PJAN-23 (add adapter create-issue op); the current mechanism is comment + operator flag.

## Close Recommendation
- Close recommendation: ready
- Rationale: all acceptance criteria satisfied and independently re-verified (ACCEPT); residual items are explicit and tracked (PJAN-23). Left in the deferred-QA lane for operator acknowledgement + commit.
