# Evidence: PJAN-21 — crash-safe Hermes post-loop improvement protocol

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent baseline: `3664bd3dac75b152a16276645f4b6751f49d5023`
- WidgetWhisperer-reviewed parent remediation base:
  `45a6844b80a126cdfe45087f155286099ce04189`
- Parent crash-safety remediation commit:
  `eb117451dcab4373c05e3f85bb935e3da97a127e`
- Hermes branch: `feature/PJAN-21-post-loop-main`
- Hermes baseline and unchanged remote main:
  `62c05b578cfb5e310292e8034626436335bb1677`
- WidgetWhisperer-reviewed Hermes remediation base:
  `bd9a70aecba0940c66bb4962cbd2720ac867c32f`
- Current Hermes implementation:
  `4120b904a19fbb75a9b7addec3e788cd73f0c679`
- Published Hermes ref:
  `refs/heads/feature/PJAN-21-post-loop-main`

## Acceptance Criteria

1. Keep step 11 directly after the final board-status report and ask exactly
   three decisions: what hurt, what should change, and whether the fix is
   repo-local or external/template/fleet. Keep step 12 as the final checkpoint.
2. Persist and durability-sync immutable prepared run intent before any board
   comment side effect.
3. Serialize artifact creation and retry updates by run identity. Use unique
   exclusive temporary files, no-replace creation, atomic replacement under
   lock, file fsync, parent-directory fsync, and parse/read-back validation.
4. Replace comment check-then-post with provider-neutral
   `resolve_issue_id` and serialized `ensure_comment` operations. Exhaust every
   provider comment page, including Plane cursor pagination; perform no post on
   lookup or serialization failure.
5. Publish an exact Draft 2020-12 JSON Schema with types, nullability, enums,
   immutable and mutable pointers, and machine-enforced cross-field invariants.
   Only routing result/error metadata may change after preparation, and
   `target_issue` must equal immutable canonical `source_issue` when present.
6. Define canonical identity before fingerprinting: repository identity comes
   only from `.project.json.project_name`; provider comes only from
   `.project.json.ticket_provider.type`; Plane and Linear use canonical UUIDs;
   Trello uses canonical 24-hex card IDs; all input normalization and allowed
   characters are explicit.
7. Preserve sanitization and protected-evidence boundaries. Artifacts and
   comments contain safe categories and summaries only, never credentials,
   tokens, raw logs, customer/PII content, or private/absolute paths.
8. Keep artifact identity run-scoped and comment identity content-scoped.
   Same-run immutable drift stalls without overwrite or comment, while distinct
   runs retain distinct artifacts and identical cross-run comments deduplicate.
9. Validate serial 7/7 semantics, concurrent writers, concurrent cross-run
   comments, both crash windows, Plane pagination, lookup and serialization
   failure, wrong target, schema parity, fsync/no-overwrite, Jinja, and an exact
   committed Copier 9.14.0 Trello render.

## Repo Changes

- Hermes commit `4120b904a19fbb75a9b7addec3e788cd73f0c679`
  changes exactly:
  - `template/.scripts/lib/ticket-provider.sh`
  - `template/.scripts/providers/linear.sh`
  - `template/.scripts/providers/plane.sh`
  - `template/.scripts/providers/trello.sh`
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/bin/run-retro.py`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
  - `template/.scripts/sentinel/schemas/run-retro.v4.schema.json`
  - `tests/test_run_retro_contract.py`
- The parent gitlink advances from
  `bd9a70aecba0940c66bb4962cbd2720ac867c32f` to
  `4120b904a19fbb75a9b7addec3e788cd73f0c679`.
- Parent changes remain limited to the Hermes gitlink, this evidence file, and
  the Bloodbank event ledger.
- No parent application code, ticket board, main branch, release, or deployment
  surface changes.

## Verification

- Sir Fix-a-Lot gave the original protocol its independent specification
  approval.
- Doctor Von Code held the first restoration for evidence, durability,
  sanitization, routing, and generated-ticket leakage; those findings were
  remediated before the later identity reviews.
- SyntaxSorcerer held the next candidate because artifact identity did not
  preserve distinct run identity.
- Professor Fiddlesticks held the next candidate because content identity could
  fork one run into multiple artifact paths.
- WidgetWhisperer reviewed parent
  `45a6844b80a126cdfe45087f155286099ce04189` and Hermes
  `bd9a70aecba0940c66bb4962cbd2720ac867c32f`, returning `QUALITY ISSUES` for
  five concrete defects:
  1. no durable prepared intent before comment side effects;
  2. overwrite-prone and incompletely synced artifact writes;
  3. check-then-post comment routing with incomplete Plane pagination;
  4. an underspecified schema and mutable target identity; and
  5. ambiguous repository/provider issue canonicalization.
- Hermes `4120b904a19fbb75a9b7addec3e788cd73f0c679` remediates all five:
  - schema v4 and `run-retro.py prepare` persist immutable intent first;
  - per-run `flock`, `O_EXCL` temps, no-replace `link`, atomic retry replace,
    file fsync, parent-directory fsync, and final read-back enforce durability;
  - provider `ensure_comment` holds one cross-run lock across exhaustive lookup
    and at-most-once post, with safe `lookup_failed`,
    `serialization_failed`, and indeterminate-response results;
  - the schema publishes exact types/nullability/enums, immutable/mutable JSON
    pointers, and semantic invariants enforced by the helper; and
  - NFKC/trim/casefold and provider-specific canonical ID rules run before either
    fingerprint is derived.
- Full Hermes unit suite: pass, 27 of 27.
- Requested serial scenario matrix: pass, 7 of 7:
  same-run/same-content, same-run/changed-content, cross-run/identical-content,
  cross-run/different-content, corrupt artifact, lost response, and no source.
- Concurrency and crash tests: pass for concurrent artifact writers, concurrent
  cross-run identical comments, crash after prepared intent, and crash after an
  external post with lost response.
- Provider safety tests: pass for Plane multi-page cursor traversal, lookup
  failure without post, adapter serialization failure without post, and
  wrong-target rejection without artifact mutation.
- Durability tests: pass for unique exclusive temps, no-replace creation, file
  fsync, parent-directory fsync, atomic retry replacement, read-back, and
  no-overwrite behavior.
- Schema validation: Draft 2020-12 metaschema check passes; helper/schema field,
  enum, mutability, provider-ID, target/source, and fingerprint contracts agree.
- Sanitization tests reject secret-like content, email/PII-like content,
  multiline raw material, absolute paths, unsafe evidence references, and
  noncanonical identity.
- Prompt/docs/source parity: whitespace-normalized contract is equal, schema and
  helper constants agree, exactly three step-11 decisions exist, and step 12 is
  final.
- Jinja parser: pass. Delimiters are balanced:
  `{{` / `}}` = 8 / 8, `{%` / `%}` = 0 / 0, `{#` / `#}` = 0 / 0.
- Shell syntax: Bash adapter and all three POSIX provider scripts pass their
  syntax parsers.
- Ruff lint and format checks: pass.
- Hermes `git diff --check`: pass.
- Exact committed candidate render: Copier 9.14.0 with `--skip-tasks`, defaults,
  PM role, and Trello provider passes. The rendered helper and schema match the
  committed source byte-for-byte; prompt/docs retain exact decision count and
  parity and contain no PJAN reference.
- A first local render omitted `--skip-tasks` and entered provisioning before
  stopping at runtime setup. It made no repository, board, publish, or release
  change. The one changed profile cwd was restored from the live agent registry,
  and the rendered SOUL matched the installed SOUL byte-for-byte. The validated
  committed render used `--skip-tasks`.
- Hermes feature publish/read-back: local HEAD, `git ls-remote`, and freshly
  fetched `FETCH_HEAD` all equal
  `4120b904a19fbb75a9b7addec3e788cd73f0c679`.
- Hermes remote main remains
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Real parent close gate: `CLOSE GATE: PASS for PJAN-21`; generated event
  `7ecbe29b-084a-4a27-bac3-98e52d4e1420`.
- Live provider writes were excluded from validation; deterministic fake
  provider tests exercise posting, pagination, failure, retry, and concurrency
  without mutating Plane, Linear, or Trello.

## Ledger Update

Ledger updated: yes

- Reopen decision event: `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Doctor Von Code quality HOLD event:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- SyntaxSorcerer specification HOLD event:
  `835ed986-fbc2-416a-ace2-fb8479ce61ff`.
- Professor Fiddlesticks specification HOLD event:
  `2703a751-2696-4108-89f7-ae8cd800b003`.
- Prior run-stable implementation event:
  `7665c7bc-b03d-4763-92e4-c1b3e89f38d0`.
- Prior run-stable close-gate event:
  `a9ed90fb-11ea-498e-b509-8e5aec6967ba`.
- WidgetWhisperer remediation implementation event:
  `97f10e8a-5f94-4eae-9a9b-fd979828ce73`.
- WidgetWhisperer remediation close-gate pass event:
  `7ecbe29b-084a-4a27-bac3-98e52d4e1420`.

## Known Gaps

- `pjangler:PJAN-23` remains the local owner for a future create-issue adapter
  operation. Generated Hermes protocol contains no PJAN reference and never
  claims automated issue creation.
- Provider correctness was verified with deterministic adapters and fakes; no
  live third-party comment was needed for this repository change.
- Hermes feature ref is published. Hermes main and the parent remote remain
  unchanged by this work.

## Close Recommendation

Close recommendation: ready

- Rationale: WidgetWhisperer’s five quality findings have executable
  remediations, deterministic concurrency/crash coverage, an exact schema,
  provider-safe routing, a clean committed render, and verified feature-ref
  reachability. The parent candidate is ready for the real repository close
  gate.
