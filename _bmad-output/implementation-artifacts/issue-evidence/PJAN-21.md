# Evidence: PJAN-21 — adversarially hardened Hermes post-loop protocol

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent implementation base:
  `36b11d20c495d5fe25d7f9c072bf7107f449e1fd`
- Parent implementation commit:
  `c2d6b6a189de179590509fa3f66da11c258b3402`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes implementation:
  `025e6ab42648abdf374530ac7ff4c93b6910c65a`
- Hermes feature ref:
  `refs/heads/feature/PJAN-21-post-loop-main`
- Hermes remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`

## Acceptance Criteria

1. Keep step 11 directly after the final board-status report with exactly three
   decisions: what hurt, what should change, and whether the fix is repo-local
   or external/template/fleet. Keep step 12 as the final checkpoint.
2. Persist immutable provider/source/target, run identity, content identity,
   operator flag, marker, and body before any external side effect.
3. Keep artifact identity run-scoped and comment identity content-scoped. Same
   run with changed immutable content stalls; distinct runs retain distinct
   artifacts; identical cross-run content deduplicates.
4. Use descriptor-relative `O_NOFOLLOW` traversal and operations across the
   complete run-retro path, exclusive temporary files, no-replace creation,
   atomic replacement, file and directory fsync, read-back, and symlink
   rejection.
5. Hold the serialized comment lock for the complete provider subtree so a
   controller death cannot permit a second post while the first provider still
   runs.
6. Accept only a closed signal/action summary vocabulary. Arbitrary credentials,
   tokens, PII, raw logs, and private paths cannot enter artifacts or comments;
   protected details remain behind opaque or safe repo-relative references.
7. Publish an executable Draft 2020-12 version 6 schema with runtime parity for
   summaries, evidence references, canonical IDs, null-source rules, fixed safe
   routing errors, and strict six-digit UTC `Z` timestamps.
8. Use the supported Plane work-item comment endpoints, exhaust the locked
   limit/offset contract, and treat malformed or ambiguous successful lookup
   envelopes as `lookup_failed` with zero post.
9. Preserve provider/source/target binding, immutable marker/body, canonical
   stored IDs, monotonic terminal results, malformed-byte taxonomy, durability,
   concurrency, exact three decisions, and provider-neutral behavior.

## Repo Changes

- Hermes commit `025e6ab42648abdf374530ac7ff4c93b6910c65a`
  changes exactly these paths relative to
  `3ac772996be757e9b6d611d727cce8a6c26119c0`:
  - `template/.scripts/providers/plane.sh`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `template/.scripts/sentinel/schemas/run-retro.v5.schema.json` renamed to
    `template/.scripts/sentinel/schemas/run-retro.v6.schema.json`
  - `tests/test_run_retro_contract.py`
- The parent gitlink advances from
  `3ac772996be757e9b6d611d727cce8a6c26119c0` to
  `025e6ab42648abdf374530ac7ff4c93b6910c65a`.
- Parent changes are limited to this gitlink, this evidence file, and
  Bloodbank implementation/close-gate events.
- Package manifests, lockfiles, CommonProject, tasks, live boards, both main
  branches, tags, releases, and runtime agents are unchanged.

## Verification

- Sir Fix-a-Lot gave the original exactly-three-decisions protocol independent
  specification approval.
- Doctor Von Code held the early restoration for evidence, durability,
  sanitization, routing, and generated-ticket leakage; those findings were
  repaired before the identity and crash-safety reviews.
- SyntaxSorcerer, Professor Fiddlesticks, WidgetWhisperer, Bartholomew the
  Builder, and Doctor Von Code each held earlier candidates for concrete
  identity, durability, routing, schema, privacy, endpoint, or crash-safety
  defects. Their accepted repairs remain covered by executable regressions.
- Fresh post-repair specification review held Hermes
  `3ac772996be757e9b6d611d727cce8a6c26119c0` for a finite privacy denylist,
  pathname-based directory-swap escape, and schema/runtime disagreement for
  `..` evidence segments and offset UTC timestamps.
- Fresh post-repair quality review held the same commit for the privacy bypass,
  controller-death lock release, and malformed Plane lookup envelopes that
  could reach POST.
- Hermes `025e6ab42648abdf374530ac7ff4c93b6910c65a` repairs every terminal finding:
  - decisions use a finite safe signal/action grammar rather than arbitrary
    prose or a secret-pattern denylist;
  - artifact directories, locks, temporary files, links, replacements, reads,
    unlinks, and fsyncs operate relative to held no-follow descriptors;
  - the provider process tree inherits the serialized comment-lock descriptor;
  - schema v6 and runtime share the exact summary, evidence-reference, safe
    routing-error, and strict timestamp patterns; and
  - Plane accepts only typed, internally consistent lookup envelopes before it
    can post.
- Full Hermes command
  `python3 -m unittest discover -s tests -p 'test_*.py' -v`: pass, 44 of 44.
- PJAN-21 adversarial command `python3 tests/test_run_retro_contract.py -q`:
  pass, 37 of 37.
- Serial scenario matrix: pass, 7 of 7 for same-run same/changed content,
  cross-run identical/different content, corrupt artifact, lost response, and
  no source.
- Real subprocess crash probe: pass. SIGKILL of the Python controller leaves
  the provider subtree holding the comment lock; retry waits, rescans, returns
  `already_present`, and the external-post counter remains one.
- Deterministic directory-swap probe: pass. Swapping `run-retros` after lock
  acquisition returns the safe `unsafe_artifact_path` category and writes zero
  files to the external target.
- Closed-vocabulary privacy probes reject synthetic Slack, Google, Stripe,
  Basic-auth, AWS-key, password, SSN, international-phone, email, payment-card,
  raw-log, traceback, private-path, and arbitrary-prose forms before artifact
  creation.
- Draft 2020-12 metaschema and bidirectional runtime probes: pass for the exact
  safe summary grammar, `..` evidence rejection, canonical IDs, null-source
  rules, fixed routing errors, and strict UTC timestamps; `+00:00` is rejected
  by both schema and runtime.
- Plane probes: pass for exhaustive multi-page lookup, malformed HTTP-200
  objects/types/bounds, transport failure, zero-post failure disposition, and
  the `/work-items/{id}/comments/` list/create paths.
- Prior guarantees pass: provider override and extra issue arguments produce
  zero provider calls; wrong prepared provider/target is rejected; one marker
  maps to one immutable body; stale failure cannot replace terminal success;
  malformed bytes produce sanitized declared errors; static artifact,
  directory, and lock symlinks are rejected; concurrent writers and cross-run
  comments remain idempotent.
- Ruff lint/format, Python compilation, Bash adapter syntax, dash syntax for
  all providers, 17 embedded Python heredoc parses, schema metaschema, Jinja
  delimiter counts, prompt/docs normalized parity, and both repository
  `git diff --check` checks: pass.
- Jinja delimiters are balanced: `{{`/`}}` 8/8, `{%`/`%}` 0/0, and
  `{#`/`#}` 0/0.
- Exact committed Copier render: version 9.14.0, commit
  `025e6ab42648abdf374530ac7ff4c93b6910c65a`, `--skip-tasks`, defaults, PM
  role, and Trello provider: pass. Helper, v6 schema, adapter, Plane provider,
  and Trello provider are byte-equal; decisions are 3/3; step 12 appears once;
  prompt/docs parity holds; generated protocol contains no PJAN reference.
- The first feature push was rejected by secret protection because adversarial
  fixtures contained literal synthetic token shapes. The unpushed candidate
  was amended so tests construct the same shapes from fragments; 44/44 and the
  exact render were repeated before a successful non-force push.
- Hermes feature publish/read-back: local HEAD, `git ls-remote`, and freshly
  fetched `FETCH_HEAD` all equal
  `025e6ab42648abdf374530ac7ff4c93b6910c65a`. Hermes main remains
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Relevant parent validation passes: parity migration, MCP catalog/server,
  project registry, PostgreSQL registry, TypeScript typecheck, and esbuild.
- Parent `npm ci --ignore-scripts --dry-run` reproduces the baseline
  package/lock mismatch for PostgreSQL and transitive dependencies.
- Full parent `npm test` reaches the baseline Skillex/CommonProject packaged
  fixture and stops because its copied local template directory is absent.
  `git diff` from the parent base proves package files, CommonProject, and the
  fixture test are unchanged; the five directly relevant parent suites pass.
- No live Plane, Linear, or Trello call was made. Deterministic fakes cover all
  comment side effects and failure paths.

## Ledger Update

Ledger updated: yes

- Reopen decision event: `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Doctor Von Code quality-hold event:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- SyntaxSorcerer specification-hold event:
  `835ed986-fbc2-416a-ace2-fb8479ce61ff`.
- Professor Fiddlesticks specification-hold event:
  `2703a751-2696-4108-89f7-ae8cd800b003`.
- Prior final-remediation implementation event:
  `c5245292-0ba9-449d-b5f7-ab607c743598`.
- Prior final-remediation close-gate event:
  `3bbc9865-474d-423a-ba10-055808b758e8`.
- Post-repair adversarial implementation event:
  `4177a469-5ac7-4101-bb17-7477e0169986`.
- Post-repair adversarial close-gate event:
  `0d26974f-7fc3-4f77-b837-f5ba7e72d664`.

## Known Gaps

- `pjangler:PJAN-23` owns a future create-issue adapter operation. Generated
  Hermes protocol contains no PJAN reference and requires an existing local
  tracking reference.
- Parent dependency hygiene remains outside PJAN-21: `package.json` declares
  packages absent from `package-lock.json`, so clean `npm ci` rejects the
  unchanged baseline.
- The parent Skillex packaged-template fixture remains outside PJAN-21 and
  fails when its copied CommonProject template directory is absent.
- Provider correctness is verified with deterministic adapters and fakes; live
  third-party comments were intentionally excluded.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged by this work.

## Close Recommendation

Close recommendation: ready

- Rationale: all terminal post-repair findings have executable regressions,
  the exact committed candidate renders cleanly, feature-ref reachability is
  verified, the real close gate reports `CLOSE GATE: PASS for PJAN-21`, and the
  remaining parent failures are proven baseline surfaces outside this ticket.
