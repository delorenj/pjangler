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
