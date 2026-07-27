# Evidence: PJAN-21 — v11 red-first remediation

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent candidate base:
  `bfc1191a2c5173ccd2490615afe8896151f301f0`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes implementation:
  `90ba6e2a9afffbfe19c27653830f9e877aeec94f`
- Hermes feature ref:
  `refs/heads/feature/PJAN-21-post-loop-main`
- Hermes remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`

## Acceptance Criteria

1. Hold one repository descriptor lifetime and perform every artifact and
   binding mutation relative to it, with no transient or durable write into a
   replacement repository pathname.
2. If pidfd signalling fails after pidfd acquisition, retain the exact comment
   lock while a bounded fallback tears down and reaps the Bubblewrap/provider
   subtree; budget the controller deadline for containment discovery and every
   shutdown window.
3. Make terminal delivery evidence unforgeable: a final artifact must carry a
   closed verified transition proof bound to the durable finalized artifact,
   and final validation plus the close gate must reject edited routing claims.
4. Bound Plane issue resolution by one operation-wide deadline, reject every
   cursor cycle, and independently bound Plane and Trello response bytes before
   strict raw-byte, UTF-8, JSON, and typed-ID validation.
5. Preserve exactly three decisions in step 11, step 12 as the final
   checkpoint, provider-neutral routing, closed safe shapes, idempotent
   delivery, strict canonical IDs, bounded I/O, and exact rendered parity.

## Repo Changes

- Hermes commit `90ba6e2a9afffbfe19c27653830f9e877aeec94f`
  changes exactly these paths relative to
  `a65b6afa05ede221bb3b1e3b31646bef7d7c7e0a`:
  - `template/.scripts/providers/plane.sh`
  - `template/.scripts/providers/trello.sh`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/issue-close-gate.sh`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `template/.scripts/sentinel/schemas/run-retro.v8.schema.json`
  - `tests/test_run_retro_contract.py`
- The artifact schema advances from v7 to v8. The closed `routing.proof` shape
  is unverified with no transition ID for prepared or failed routing, and
  verified with a canonical UUID for posted, already-present, or
  no-target-issue routing.
- Each adjacent binding is now closed canonical JSON containing the immutable
  digest plus nullable final-document digest and transition ID. Finalization
  atomically replaces and durability-syncs that binding with the exact
  canonical artifact digest and byte-equal transition ID. `validate --final`
  rejects a schema-valid edited status or invented proof.
- Artifact and binding mutations use the held repository descriptor and fixed
  descriptor-relative components. Repository pathname replacement cannot
  redirect binding creation, temporary creation, linking, or final replacement.
- pidfd signalling failure falls through to bounded process-group teardown and
  confirmed waits/reaping while the keyed comment lock remains held. The
  controller budget covers comment-lock acquisition, provider execution, one
  containment-info window, and three shutdown windows.
- Plane and Trello execute curl through a bounded Python controller that caps
  stdout and stderr independently, kills the curl process group on overflow or
  deadline, and preserves raw response bytes for strict decoding. Plane tracks
  every seen cursor and uses one monotonic resolution deadline across pages.
- The generated close gate validates every durable run-retro artifact and
  invokes final validation for each terminal artifact before recommending
  closure.
- Prompt and orchestration documentation carry the same v8 proof, durability,
  pagination, byte-bound, exactly-three-decision, and final-checkpoint contract.
- The parent advances only the `templates/hermes-agent` gitlink, this evidence
  file, and Bloodbank implementation/close-gate history.

## Verification

- Both fresh v10 reviewer rollouts were read completely through their terminal
  `task_complete` records:
  - specification: `019fa308-326a-74b3-a5ab-3152da08d709`
  - quality: `019fa308-8487-71c1-abe4-65deff78d643`
  Their complete union is represented in the five acceptance criteria above.
- Nine focused regressions were added before runtime repair and run against
  exact Hermes `a65b6afa05ede221bb3b1e3b31646bef7d7c7e0a`.
  Receipt: `Ran 9 tests in 2.486s`,
  `FAILED (failures=4, errors=3)`. The failures demonstrated replacement-path
  binding creation, replacement-path terminal artifact writes, accepted forged
  final status, escaped pidfd signal failure, absent controller budget helper,
  and accepted A-B-A cursor cycling; the operation-wide deadline probe exceeded
  its test bound.
- Two corrected portable streaming-response probes against the same exact base
  produced `Ran 2 tests in 4.008s`, `FAILED (errors=2)`: both Plane and Trello
  exceeded their subprocess bounds when curl did not enforce its advertised
  response-size option.
- Full exact committed Hermes suite:
  `env PYTHONDONTWRITEBYTECODE=1 TMPDIR="${TMPDIR:-/tmp}"
  python3 -m unittest discover -s tests -v`:
  `Ran 107 tests in 23.586s`, `OK`.
- The suite includes exact negative probes for containment-info failure,
  pidfd-open failure, pidfd-signalling failure, controller worst-case budget,
  delayed provider effects, repository replacement during binding creation and
  durable replacement, forged final status and schema-valid forged proof,
  cursor cycles and operation deadlines, and portable streaming byte limits.
  The Linux containment tests exercise actual Bubblewrap behavior; the
  non-Linux boundary proves fail-closed behavior before provider launch.
- Existing coverage remains green for serial 7-of-7 idempotency, concurrent
  identical comments, independent comment keys, controller `SIGKILL`, provider
  descendant containment, strict response types, malformed bytes, cursor
  snapshot drift, artifact/store relocation, symlink attacks, stale
  finalization ordering, bounded input and provider output, canonical identity,
  safe-summary shapes, atomic durability, and schema/runtime acceptance parity.
- Ruff 0.15.15 check and format-check pass. Python compile passes. `sh -n` and
  `dash -n` pass for Plane, Trello, Linear, and the close gate. Draft 2020-12
  metaschema validation passes, and all 28 embedded provider Python blocks
  compile. Hermes `git diff --check HEAD^ HEAD` passes.
- Jinja parses with 8 opening and 8 closing delimiters. Prompt/docs
  whitespace-normalized parity passes. Step 11 contains exactly the three
  locked decisions, step 12 occurs once and is final, and generated protocol
  contains no PJAN reference.
- Exact committed Copier 9.14.0 render from
  `90ba6e2a9afffbfe19c27653830f9e877aeec94f` with
  `--trust --skip-tasks --defaults --data target_repo=pjangler --data role=pm
  --data ticket_provider=trello`: pass. All seven generated implementation
  surfaces are byte-equal to committed source, rendered numbering and no-PJAN
  checks pass, and no rendered Python cache exists.
- Hermes publish/read-back used an exact lease on the prior feature SHA.
  Local HEAD, freshly fetched `FETCH_HEAD`, and `git ls-remote` all equal
  `90ba6e2a9afffbfe19c27653830f9e877aeec94f`. Hermes remote main remains
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Parent `npm run typecheck` passes. MCP catalog, MCP server, project registry,
  and PostgreSQL registry regression suites pass; PostgreSQL reports
  `PG_STORE_CHECK_OK`.
- Full parent `npm test` passes parity migration and then reproduces the
  unchanged Skillex packaged-template fixture failure because the copied
  CommonProject template directory is absent. The remaining directly relevant
  suites pass individually.
- Parent `npm ci --ignore-scripts --dry-run` reproduces the unchanged
  package/lock mismatch beginning with `@types/pg`, `node-pg-migrate`, and `pg`.
  The diff from the exact parent base changes no package file, CommonProject
  content, fixture test, source, or `dist` output.
- No live Plane, Linear, or Trello operation was invoked. No main branch, tag,
  release, package file, task ledger, CommonProject content, or unrelated file
  was changed.

## Ledger Update

Ledger updated: yes

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
- V11 implementation:
  `72f5d5a0-60fc-44df-89e3-4c9b7af87f68`.

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

- Rationale: every v11 reviewer finding has a red-before-green executable
  regression, all 107 Hermes tests pass, exact schema/runtime and render parity
  pass, the feature ref reads back at the exact implementation commit, and
  relevant parent checks pass with unchanged baselines isolated from this diff.
  This records implementation readiness for fresh independent review; it is
  not a claim of acceptance.
