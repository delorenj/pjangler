# Evidence: PJAN-21 — Hermes lifecycle post-loop improvement protocol

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent baseline: `3664bd3dac75b152a16276645f4b6751f49d5023`
- Initial parent candidate: `09394060920389a12268718828571bb018938088`
- SyntaxSorcerer-reviewed parent candidate and remediation base:
  `112f40ddea12fe82a2994d3e8a66cdba6df4900f`
- Professor Fiddlesticks-reviewed parent candidate and remediation base:
  `b12963351a676508ab9594486e85e99c2854c519`
- Submodule branch: `feature/PJAN-21-post-loop-main`
- Submodule baseline: `62c05b578cfb5e310292e8034626436335bb1677`
- Initial submodule candidate: `d204c353ec875bb8331569e3c0d28902d2f27118`
- Doctor Von Code-remediated submodule commit:
  `1407bf3f9a94a6635420014e98aa3e4f41aaa632`
- Professor Fiddlesticks-reviewed submodule commit:
  `a6d264cf931a3a671177da7ee624f6efec269573`
- Current run-stable submodule commit:
  `bd9a70aecba0940c66bb4962cbd2720ac867c32f`
- Published submodule ref:
  `refs/heads/feature/PJAN-21-post-loop-main`

## Acceptance Criteria

1. Add an explicit numbered Post-loop improvement / end-of-batch retro step
   directly after the final report-board-status step in the template sentinel
   prompt, with matching orchestration documentation.
2. Ask exactly three decisions: what hurt this batch, what should change, and
   whether the fix is repo-local or external/template/fleet.
3. Persist every invocation under
   `_bmad-output/implementation-artifacts/run-retros/<artifact_fingerprint>.json`
   with a deterministic versioned schema, stable run/correlation identity,
   atomic write, parse/read-back validation, durable retention, and a final
   checkpoint.
4. Store and comment sanitized summaries only. Exclude tokens, credentials, raw
   logs, customer data/PII, and private paths; reference protected evidence
   without reproducing it.
5. Separate a run-scoped artifact fingerprint derived only from schema version,
   canonical repository identity, and `run_id` from a stable content/comment
   fingerprint that deduplicates identical comments across runs. Same-run
   immutable-content drift must stall without overwrite or comment. Route only
   to the single source issue and record
   `posted|already_present|failed|no_target_issue` plus the explicit operator
   flag.
6. Keep the generated protocol provider-neutral: state that create-issue is
   unavailable, allow only an existing installing-repo ticket reference, and
   keep pjangler-local ownership out of generated files.
7. Keep the implementation at the protocol/documentation level with no
   executable behavior changes, and validate numbering, Jinja, source/docs
   parity, and a real Copier render.

## Repo Changes

- Submodule follow-up `bd9a70aecba0940c66bb4962cbd2720ac867c32f`
  makes artifact identity run-stable and retains independent content/comment
  identity in exactly:
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
- The parent gitlink advances from
  `a6d264cf931a3a671177da7ee624f6efec269573` to
  `bd9a70aecba0940c66bb4962cbd2720ac867c32f`.
- This evidence adopts the canonical close-gate headings and exact markers.
- The Bloodbank ledger appends Professor Fiddlesticks' Momo HOLD decision event
  `2703a751-2696-4108-89f7-ae8cd800b003` byte-for-byte from the root ledger and
  records implementation event `7665c7bc-b03d-4763-92e4-c1b3e89f38d0`
  through the established sentinel recorder.
- Migrations and executable behavior changes: none.

## Verification

- Sir Fix-a-Lot independently reviewed parent `093940609` and submodule
  `d204c353`, returned `spec compliant`, and recorded `SPEC_REVIEW_DONE`.
- Doctor Von Code independently returned HOLD on those candidates for six
  concrete findings: noncanonical close-gate evidence, unreachable submodule
  object, nondurable artifact semantics, unsafe disclosure, ambiguous/
  non-idempotent routing, and a generated PJAN-23 leak.
- Agent Buttercup remediated every HOLD finding in the follow-up submodule
  commit, published only the submodule feature ref, and rebuilt this evidence
  around the real close-gate contract.
- SyntaxSorcerer independently reviewed parent
  `112f40ddea12fe82a2994d3e8a66cdba6df4900f` and submodule
  `1407bf3f9a94a6635420014e98aa3e4f41aaa632`, returning `SPEC ISSUES` for one
  substantive defect. The accepted rationale was that the prompt established
  `run_id` at reviewer line 134, excluded it from the artifact fingerprint at
  line 148, and then required reuse at line 172; the matching documentation
  conflict was at reviewer lines 100, 113, and 136. Identical content from
  distinct runs could therefore collapse onto one artifact path.
- Submodule `a6d264cf931a3a671177da7ee624f6efec269573` resolves that finding with schema
  version 2: `artifact_fingerprint` hashes the exact run-scoped preimage
  (`hermes.run-retro.artifact`, version, `run_id`, `comment_fingerprint`), while
  `comment_fingerprint` hashes the exact sanitized content preimage and excludes
  run/correlation identity, timestamps, and routing outcome.
- Professor Fiddlesticks independently reviewed parent
  `b12963351a676508ab9594486e85e99c2854c519` and submodule
  `a6d264cf931a3a671177da7ee624f6efec269573`, returning `SPEC ISSUES` for one
  substantive defect. The accepted rationale was that exactly one artifact was
  required at reviewer prompt line 125 and documentation line 91, but
  `comment_fingerprint` participated in the artifact preimage at prompt line 154
  and documentation line 119. Retry handling at prompt line 195 and
  documentation line 158 therefore derived a second path when sanitized content
  changed for the same `run_id`.
- Submodule `bd9a70aecba0940c66bb4962cbd2720ac867c32f` resolves that finding with schema
  version 3. `artifact_fingerprint` hashes exactly four LF-terminated lines:
  `hermes.run-retro.artifact`, schema version `3`, canonical `repo`, and
  `run_id`. It excludes every mutable or content-derived value.
  `comment_fingerprint` retains its independent version-2 content preimage so
  existing source-comment markers do not change.
- Submodule `git diff --check`: pass.
- Submodule follow-up scope: exactly the two authorized protocol files; 97
  insertions and 58 deletions, with no executable files.
- Prompt numbering: contiguous top-level steps 1 through 12; step 11 directly
  follows step 10 and step 12 is the final retro checkpoint.
- Jinja delimiter counts: `{{` / `}}` = 8 / 8; `{%` / `%}` = 0 / 0.
- Jinja parser: pass.
- Each of the three required decisions appears exactly once in both generated
  protocol surfaces.
- Whitespace-normalized prompt/docs parity checks cover both exact SHA-256
  preimages and field names, the run-stable path, immutable/mutable field split,
  pre-routing corruption/content validation, no-overwrite/no-comment stall,
  cross-run comment deduplication, schema/version, run/correlation identity,
  sanitization boundary, protected evidence, routing statuses, atomic
  rename/read-back, retry behavior, operator flag, local tracking reference,
  and final checkpoint.
- Mechanical scenario matrix: pass, 7 of 7. Same-run/same-content kept one path
  and updated only mutable routing fields. Same-run/changed-content kept that
  same path and returned `stalled` without overwrite or comment. Cross-run
  identical and different content produced distinct artifact paths; identical
  content shared its comment fingerprint. Corrupt artifact, lost response, and
  no-source cases all followed the specified safe disposition.
- Exact matrix identities: `run-a` artifact
  `36a38bf7fcbc1db52a48e2fbaa3d3b957a8b1920dec746eaea8f3f08b66552f9`;
  `run-b` artifact
  `936bf34c5547c6e04aadf49b8c9336a06ab521154344de90521de84e5ebbe91a`;
  shared comment fingerprint
  `3d22084fb1f64bec3f3a1db1e63ce3dd8cc32ae6077623bfad9203aea9941d5c`.
- Generated prompt/docs contain no PJAN reference.
- Copier 9.14.0 render with `--skip-tasks`, defaults, PM role, and Trello
  provider: pass; both rendered files retain the complete schema-v3 contract,
  contain no residual Jinja delimiters, and contain no PJAN reference.
- Submodule publish/read-back: local HEAD, `git ls-remote`, and fetched
  `FETCH_HEAD` all equal `bd9a70aecba0940c66bb4962cbd2720ac867c32f`.
- Submodule `origin/main` remains unchanged at
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Submodule worktree: clean on `feature/PJAN-21-post-loop-main` at
  `bd9a70aecba0940c66bb4962cbd2720ac867c32f`.
- Parent `git diff --check`: pass.
- Parent candidate scope: exactly the Hermes gitlink, this evidence file, and
  the Bloodbank ledger.
- Canonical evidence simulation: all seven required headings, `Ledger updated:
  yes`, `Close recommendation: ready`, and the forbidden-placeholder scan pass.
- Bloodbank JSONL parses with `jq`; Professor Fiddlesticks HOLD decision event
  `2703a751-2696-4108-89f7-ae8cd800b003` occurs once and matches the root-ledger
  source byte-for-byte. Implementation event
  `7665c7bc-b03d-4763-92e4-c1b3e89f38d0` occurs once with the exact Hermes
  commit and worker attribution.

## Ledger Update

Ledger updated: yes

- Reopen decision event: `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Quality HOLD decision event:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- Prior real close-gate pass event:
  `623e32b4-dd4d-41b5-b18f-3770e4697b01`.
- SyntaxSorcerer spec HOLD decision event:
  `835ed986-fbc2-416a-ace2-fb8479ce61ff`.
- Prior dual-identity close-gate pass event:
  `e60a5092-f9fe-4544-af54-8101e645ed60`.
- Professor Fiddlesticks spec HOLD decision event:
  `2703a751-2696-4108-89f7-ae8cd800b003`.
- Run-stable implementation event:
  `7665c7bc-b03d-4763-92e4-c1b3e89f38d0`.
- The real close gate emits its pass event after the remediation commit; that
  event is recorded in the mandated final follow-up commit.

## Known Gaps

- `pjangler:PJAN-23` remains the pjangler-local owner for adding an adapter
  create-issue operation. The generated Hermes protocol contains no PJAN ticket
  reference and never claims automated issue creation.
- Fresh independent spec and quality re-review remain the orchestrator's next
  gate on the run-stable parent/submodule commits.
- The submodule feature branch is published, while submodule `main` and the
  parent remote remain unchanged as required.

## Close Recommendation

Close recommendation: ready

- Rationale: the quality and spec findings have concrete remediations, the full
  seven-case lifecycle matrix passes, the dependency is remotely reachable
  through its feature ref, and the candidate is ready for the real repository
  close gate and fresh independent re-review.
