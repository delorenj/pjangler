# Evidence: PJAN-21 — Hermes lifecycle post-loop improvement protocol

## Issue

- Ticket: PJAN-21
- Worker: Agent Buttercup / Codex CLI
- Parent branch: `feature/PJAN-21-post-loop-main`
- Parent baseline: `3664bd3dac75b152a16276645f4b6751f49d5023`
- Submodule branch: `feature/PJAN-21-post-loop-main`
- Submodule baseline: `62c05b578cfb5e310292e8034626436335bb1677`
- Submodule commit: `d204c353ec875bb8331569e3c0d28902d2f27118`

## Acceptance Criteria

1. Add an explicit numbered Post-loop improvement / end-of-batch retro step
   directly after the final report-board-status step in the template sentinel
   prompt, with matching orchestration documentation.
2. Ask exactly three decisions: what hurt this batch, what should change, and
   whether the fix is repo-local or external/template/fleet.
3. Always record the reflection as a run artifact/evidence. For an
   external/template/fleet improvement, use `tp comment` plus the explicit
   operator flag `operator_action_required: true`. The adapter has no
   create-issue operation; PJAN-23 tracks that capability gap.
4. Keep the implementation at the protocol/documentation level with no
   executable behavior changes.
5. Validate numbered-step placement and balanced Jinja delimiters.

## Repository Changes

- `templates/hermes-agent` advances from `62c05b578cfb5e310292e8034626436335bb1677`
  to `d204c353ec875bb8331569e3c0d28902d2f27118`.
- `template/.scripts/sentinel.prompt.md.jinja` adds step 11 immediately after
  step 10.
- `template/.scripts/sentinel/docs/continuous-ticket-orchestration.md` adds the
  matching post-loop protocol.
- `_bmad-output/implementation-artifacts/bloodbank-events.jsonl` gains only Momo
  decision event `67e6c132-facf-427a-87a0-3263c6fc8005`.
- Migrations and executable changes: none.

## Verification

- Submodule `git diff --check`: pass before commit.
- Cached submodule scope: exactly the two authorized protocol files.
- Prompt numbering: contiguous top-level steps 1 through 11; step 11 directly
  follows step 10.
- Jinja delimiter counts: `{{` / `}}` = 8 / 8; `{%` / `%}` = 0 / 0.
- Required decision prompts: each appears once in the prompt and once in the
  matching documentation.
- External-improvement contract: `tp comment`,
  `operator_action_required: true`, and the PJAN-23 create-issue limitation
  appear in both protocol surfaces.
- Copier 9.14.0 render from the committed submodule archive with
  `--skip-tasks`: pass; both rendered protocol files retain the required text.
- Submodule commit scope review: 2 files, 27 insertions, no executable files.
- Parent `git diff --check`: pass.
- Parent scope review: exactly the Hermes gitlink, this evidence file, and the
  Bloodbank ledger.
- Bloodbank ledger: every JSONL record parses with `jq`; event
  `67e6c132-facf-427a-87a0-3263c6fc8005` occurs once and matches the root-ledger
  source byte-for-byte.
- Evidence placeholder scan against the close-gate vocabulary: pass.
- Submodule worktree: clean on `feature/PJAN-21-post-loop-main` at
  `d204c353ec875bb8331569e3c0d28902d2f27118`.

## Risks

- The adapter cannot create a follow-up issue; PJAN-23 owns that capability.
  Until it lands, the explicit operator flag makes external/template/fleet
  improvements visible without claiming automated issue creation.
- This landing changes template protocol only. Existing deployed agents receive
  the protocol through their normal template update path.

## Close Recommendation

- Recommendation: ready.
- Rationale: the accepted two-file protocol is restored, rendered successfully,
  and isolated from unrelated repository work.
