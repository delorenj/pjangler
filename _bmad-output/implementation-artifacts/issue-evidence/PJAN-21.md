# Evidence: PJAN-21 — bound, crash-safe Hermes post-loop improvement protocol

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent implementation base:
  `52d41b270f9a2499d54000b13a2ae2a1a0378fe8`
- Parent implementation commit:
  `2171c969a09afc54da5075c368b763ffe0b77a15`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes implementation:
  `3ac772996be757e9b6d611d727cce8a6c26119c0`
- Hermes feature ref:
  `refs/heads/feature/PJAN-21-post-loop-main`
- Hermes remote main, unchanged:
  `62c05b578cfb5e310292e8034626436335bb1677`

## Acceptance Criteria

1. Keep step 11 directly after the final board-status report and ask exactly
   three decisions: what hurt, what should change, and whether the fix is
   repo-local or external/template/fleet. Keep step 12 as the final checkpoint.
2. Persist and durability-sync immutable run intent, including exact provider,
   canonical source/target, marker, body, and operator flag, before any external
   side effect.
3. Use a run-scoped artifact fingerprint and a separate content-scoped comment
   fingerprint. One marker maps to one immutable body; same-run immutable drift
   stalls; distinct runs retain distinct artifacts; identical cross-run content
   deduplicates.
4. Serialize artifact and comment delivery with non-truncating, symlink-rejecting
   locks, unique exclusive temporary files, no-replace creation, atomic replace,
   file fsync, parent-directory fsync, and parse/read-back validation.
5. Route only from the durable artifact. Environment provider selection and an
   independent issue argument cannot redirect prepared intent. Provider and
   target results must match the prepared values exactly.
6. Publish a Draft 2020-12 version 5 schema with exact types, nullability, enums,
   immutable/mutable pointers, canonical UUID/card rules, source/target and
   operator invariants, sanitization patterns, and monotonic terminal routing.
7. Fail closed before artifact or comment on tokens, credentials, private keys,
   AWS access-key shapes, raw logs/traces, email/SSN/phone/payment-card PII, and
   Unix, tilde, Windows, UNC, or file-URI private paths.
8. Use Plane's supported work-item comment list/create endpoints with exhaustive
   documented limit/offset pagination and safe no-post lookup failure.
9. Validate serial 7/7, concurrency, both crash windows, stale finalization,
   malformed bytes, canonical stored values, symlink attacks, provider/target
   preflight, schema/runtime parity, Jinja, and an exact committed Copier 9.14.0
   Trello render.

## Repo Changes

- Hermes commit `3ac772996be757e9b6d611d727cce8a6c26119c0`
  changes exactly:
  - `template/.scripts/lib/ticket-provider.sh`
  - `template/.scripts/providers/linear.sh`
  - `template/.scripts/providers/plane.sh`
  - `template/.scripts/providers/trello.sh`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `template/.scripts/sentinel/schemas/run-retro.v4.schema.json` renamed to
    `template/.scripts/sentinel/schemas/run-retro.v5.schema.json`
  - `tests/test_run_retro_contract.py`
- The parent gitlink advances from
  `4120b904a19fbb75a9b7addec3e788cd73f0c679` to
  `3ac772996be757e9b6d611d727cce8a6c26119c0`.
- Parent changes are limited to the Hermes gitlink, this evidence file, and
  Bloodbank implementation/close-gate events.
- No parent application code, package manifest, lockfile, board, main branch,
  tag, release, deployment, or runtime backfill changes.

## Verification

- Sir Fix-a-Lot gave the original exactly-three-decisions protocol independent
  specification approval.
- Doctor Von Code held the earlier restoration for evidence, durability,
  sanitization, routing, and generated-ticket leakage; those findings were
  remediated before the later identity reviews.
- SyntaxSorcerer held a candidate whose artifact identity did not preserve
  distinct run identity.
- Professor Fiddlesticks held a candidate whose content-derived artifact path
  could fork one stable run.
- WidgetWhisperer held Hermes
  `bd9a70aecba0940c66bb4962cbd2720ac867c32f` for prepared-intent durability,
  safe creation/update serialization, comment idempotency, exact schema, and
  canonical repository/provider issue identity. Hermes
  `4120b904a19fbb75a9b7addec3e788cd73f0c679` addressed that review.
- Fresh Bartholomew review then held parent
  `52d41b270f9a2499d54000b13a2ae2a1a0378fe8` / Hermes
  `4120b904a19fbb75a9b7addec3e788cd73f0c679` because provider/source were not
  bound before delivery, one marker could produce mutable operator-body drift,
  schema/helper UUID and null-source rules differed, and SSN/AWS/private-path
  content crossed the sanitization boundary.
- Fresh Doctor Von Code review held the same candidate for retired Plane issue
  comment endpoints, provider rebinding, symlink/truncation escape, sanitization
  bypass, stale failure regression, noncanonical stored IDs, UUID version
  mismatch, unsafe malformed-byte errors, and GNU-only shell locking.
- Hermes `3ac772996be757e9b6d611d727cce8a6c26119c0` remediates both final reviews:
  - version 5 persists provider, canonical byte-equal source/target, immutable
    operator flag, marker, and exact body before routing;
  - `tp ensure_comment` accepts only the artifact fingerprint and routes through
    the prepared provider/source/body while ignoring provider override attempts;
  - one content fingerprint includes every body-varying immutable value;
  - Python advisory locks replace GNU `flock`/`sha256sum`, reject symlinks, avoid
    truncation, and protect artifact plus cross-run comment delivery;
  - terminal success/no-target results are monotonic over delayed failures;
  - helper and schema accept canonical RFC UUID versions 1-8 with RFC variant,
    reject nil/noncanonical stored IDs, and enforce null-source rules;
  - malformed UTF-8 input/artifacts return declared safe JSON categories without
    traceback or private paths;
  - expanded fail-closed sanitization covers every claimed protected category;
  - Plane retro resolution/list/post uses supported `/work-items/` endpoints,
    with comment lookup exhausting `limit`/`offset` pages.
- Full Hermes command
  `python3 -m unittest discover -s tests -p 'test_*.py' -v`: pass, 40 of 40.
- PJAN-21 adversarial command `python3 tests/test_run_retro_contract.py -q`:
  pass, 33 of 33.
- Serial scenario matrix: pass, 7 of 7 for same-run same/changed content,
  cross-run same/different content, corrupt artifact, lost response, and no
  source.
- Concurrency/crash probes: pass for eight concurrent artifact writers,
  concurrent identical cross-run comments, crash after prepared intent, and
  crash after external post with lost response.
- Adversarial probes: pass for provider override, extra issue argument, invalid
  prepared provider/target with zero provider calls, marker/body stability,
  stale finalization ordering, noncanonical stored IDs, malformed bytes,
  symlinked artifact/comment-lock paths, no-overwrite/fsync, expanded
  sanitization, no-source routing, Plane pagination, and lookup failure with no
  post.
- Draft 2020-12 metaschema and runtime/schema parity: pass for required fields,
  types, nullability, enums, immutable/mutable pointers, UUID versions 1-8,
  null-source/operator rules, and the exact runtime unsafe-summary pattern list.
- Ruff lint/format, Python compile, Bash adapter syntax, dash syntax for all
  provider scripts, and 17 embedded Python heredoc parses: pass.
- Prompt/docs/source parity: whitespace-normalized contract equal; exactly
  three step-11 decisions; one final step 12; no generated PJAN reference.
- Jinja delimiters: balanced at `{{`/`}}` 8/8, `{%`/`%}` 0/0, `{#`/`#}` 0/0.
- Exact committed render: Copier 9.14.0, commit
  `3ac772996be757e9b6d611d727cce8a6c26119c0`, `--skip-tasks`, defaults, PM role,
  Trello provider: pass. Rendered helper, schema, adapter, and Trello provider
  match committed sources byte-for-byte; rendered prompt/docs retain exact
  decision count and normalized parity.
- Hermes feature publish/read-back: local HEAD, `git ls-remote`, and freshly
  fetched `FETCH_HEAD` all equal
  `3ac772996be757e9b6d611d727cce8a6c26119c0`.
- Relevant parent checks pass: parity migration; MCP catalog/server; project
  registry; PostgreSQL registry; TypeScript typecheck; esbuild bundle.
- Parent `npm ci --ignore-scripts --dry-run` reproduces the baseline lock
  mismatch for declared PostgreSQL dependencies. `git diff` from
  `52d41b270f9a2499d54000b13a2ae2a1a0378fe8` confirms PJAN-21 changes neither
  package manifest nor lockfile.
- Full parent `npm test` reaches the pre-existing Skillex/CommonProject packaged
  fixture and stops because that copied local template is absent. PJAN-21
  changes neither that fixture nor CommonProject; all directly relevant parent
  suites listed above pass.
- Hermes and parent `git diff --check`: pass.
- Real parent close gate: `CLOSE GATE: PASS for PJAN-21`; generated event
  `3bbc9865-474d-423a-ba10-055808b758e8`.
- No live Plane, Linear, or Trello call was made; deterministic fakes cover
  posting, pagination, failure, retry, concurrency, and no-post preflight.

## Ledger Update

Ledger updated: yes

- Reopen decision event: `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Doctor Von Code quality HOLD event:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- SyntaxSorcerer specification HOLD event:
  `835ed986-fbc2-416a-ace2-fb8479ce61ff`.
- Professor Fiddlesticks specification HOLD event:
  `2703a751-2696-4108-89f7-ae8cd800b003`.
- Prior final-remediation implementation event:
  `97f10e8a-5f94-4eae-9a9b-fd979828ce73`.
- Prior final-remediation close-gate event:
  `7ecbe29b-084a-4a27-bac3-98e52d4e1420`.
- Bartholomew/Doctor remediation implementation event:
  `c5245292-0ba9-449d-b5f7-ab607c743598`.
- Bartholomew/Doctor remediation close-gate event:
  `3bbc9865-474d-423a-ba10-055808b758e8`.

## Known Gaps

- `pjangler:PJAN-23` owns a future create-issue adapter operation. Generated
  Hermes protocol contains no PJAN reference and states that automated issue
  creation is unavailable without an existing local ticket reference.
- Parent dependency hygiene remains outside PJAN-21: `package.json` declares
  PostgreSQL packages and transitive dependencies absent from
  `package-lock.json`, so clean `npm ci` rejects the unchanged baseline.
- The parent Skillex packaged-template fixture remains outside PJAN-21 and fails
  when its copied CommonProject template directory is absent.
- Provider correctness is verified with deterministic adapters/fakes; live
  third-party comments were intentionally excluded.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged by this work.

## Close Recommendation

Close recommendation: ready

- Rationale: every concrete Bartholomew and Doctor final-review finding now has
  an executable adversarial regression, the exact committed candidate renders
  cleanly, feature-ref reachability is verified, and the remaining parent
  hygiene items are proven baseline surfaces outside this ticket.
