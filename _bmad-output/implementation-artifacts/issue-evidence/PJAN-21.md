# Evidence: PJAN-21 — Hermes lifecycle post-loop improvement protocol

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent baseline: `3664bd3dac75b152a16276645f4b6751f49d5023`
- Initial parent candidate: `09394060920389a12268718828571bb018938088`
- Submodule branch: `feature/PJAN-21-post-loop-main`
- Submodule baseline: `62c05b578cfb5e310292e8034626436335bb1677`
- Initial submodule candidate: `d204c353ec875bb8331569e3c0d28902d2f27118`
- Hardened submodule commit: `1407bf3f9a94a6635420014e98aa3e4f41aaa632`
- Published submodule ref:
  `refs/heads/feature/PJAN-21-post-loop-main`

## Acceptance Criteria

1. Add an explicit numbered Post-loop improvement / end-of-batch retro step
   directly after the final report-board-status step in the template sentinel
   prompt, with matching orchestration documentation.
2. Ask exactly three decisions: what hurt this batch, what should change, and
   whether the fix is repo-local or external/template/fleet.
3. Persist every retro under
   `_bmad-output/implementation-artifacts/run-retros/<fingerprint>.json` with a
   deterministic versioned schema, stable run/correlation identity, atomic
   write, parse/read-back validation, durable retention, and a final checkpoint.
4. Store and comment sanitized summaries only. Exclude tokens, credentials, raw
   logs, customer data/PII, and private paths; reference protected evidence
   without reproducing it.
5. Route only to the single source issue, use a stable fingerprint marker to
   prevent duplicate comments, and record
   `posted|already_present|failed|no_target_issue` plus the explicit operator
   flag.
6. Keep the generated protocol provider-neutral: state that create-issue is
   unavailable, allow only an existing installing-repo ticket reference, and
   keep pjangler-local ownership out of generated files.
7. Keep the implementation at the protocol/documentation level with no
   executable behavior changes, and validate numbering, Jinja, source/docs
   parity, and a real Copier render.

## Repo Changes

- Submodule follow-up `1407bf3f9a94a6635420014e98aa3e4f41aaa632`
  hardens exactly:
  - `template/.scripts/sentinel.prompt.md.jinja`
  - `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md`
- The parent gitlink advances from
  `d204c353ec875bb8331569e3c0d28902d2f27118` to
  `1407bf3f9a94a6635420014e98aa3e4f41aaa632`.
- This evidence adopts the canonical close-gate headings and exact markers.
- The Bloodbank ledger appends Momo HOLD event
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c` byte-for-byte from the root ledger.
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
- Submodule `git diff --check`: pass.
- Submodule follow-up scope: exactly the two authorized protocol files; 122
  insertions and 12 deletions, with no executable files.
- Prompt numbering: contiguous top-level steps 1 through 12; step 11 directly
  follows step 10 and step 12 is the final retro checkpoint.
- Jinja delimiter counts: `{{` / `}}` = 8 / 8; `{%` / `%}` = 0 / 0.
- Jinja parser: pass.
- Each of the three required decisions appears exactly once in both generated
  protocol surfaces.
- Prompt/docs parity checks cover the deterministic path, schema/version and
  fields, run/correlation identity, sanitization boundary, SHA-256 fingerprint,
  routing statuses, comment deduplication, atomic rename/read-back, operator
  flag, local tracking reference, and final checkpoint.
- Generated prompt/docs contain no PJAN-23 reference.
- Copier 9.14.0 render with `--skip-tasks`: pass; rendered prompt/docs retain the
  complete hardened contract.
- Submodule publish/read-back: local HEAD, `git ls-remote`, and fetched
  `FETCH_HEAD` all equal `1407bf3f9a94a6635420014e98aa3e4f41aaa632`.
- Submodule `origin/main` remains unchanged at
  `62c05b578cfb5e310292e8034626436335bb1677`.
- Submodule worktree: clean on `feature/PJAN-21-post-loop-main` at
  `1407bf3f9a94a6635420014e98aa3e4f41aaa632`.
- Parent `git diff --check`: pass.
- Parent candidate scope: exactly the Hermes gitlink, this evidence file, and
  the Bloodbank ledger.
- Canonical evidence simulation: all seven required headings, `Ledger updated:
  yes`, `Close recommendation: ready`, and the forbidden-placeholder scan pass.
- Bloodbank JSONL parses with `jq`; HOLD event
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c` occurs once and matches the root-ledger
  source byte-for-byte.

## Ledger Update

Ledger updated: yes

- Reopen decision event: `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Quality HOLD decision event:
  `132cbd1c-b5b0-42cc-8571-ea44f3f25e9c`.
- The real close gate emits its pass event after the remediation commit; that
  event is recorded in the mandated final follow-up commit.

## Known Gaps

- `pjangler:PJAN-23` remains the pjangler-local owner for adding an adapter
  create-issue operation. The generated Hermes protocol contains no PJAN ticket
  reference and never claims automated issue creation.
- Fresh independent spec and quality re-review remain the orchestrator's next
  gate on the remediated parent/submodule commits.
- The submodule feature branch is published, while submodule `main` and the
  parent remote remain unchanged as required.

## Close Recommendation

Close recommendation: ready

- Rationale: the quality findings have concrete remediations, the dependency is
  remotely reachable through its feature ref, and the candidate is ready for
  the real repository close gate and fresh independent re-review.
