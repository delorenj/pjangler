# Input Reconciliation — Readiness MAJOR-1

## Inputs

- `implementation-readiness-report-2026-08-19.md`, MAJOR-1.
- Headless update directive adopting the recommended MVP decision: defer Capture Receipt dismissal and preserve unresolved recovery evidence behind bounded admission backpressure.

## Prior-decision conflict

The earlier memlog and FR-14 allowed unresolved Capture Receipts to remain visible until recovered or dismissed. That clause conflicted with the adopted v1 architecture and stories, which expose no dismissal command or transition and require separate UX and safety design. The append-only memlog now records the deferral as a superseding decision.

## Reconciled coverage

| Change signal | PRD/addendum coverage |
| --- | --- |
| Keep FR IDs stable | FR-1 through FR-21 remain contiguous; FR-14 retains its identifier |
| Defer dismissal from v1 | PRD FR-14, Non-Goals, MVP Out of Scope, command table; addendum CLI and retention contracts |
| Expire succeeded receipts under bounded policy | PRD FR-14 and NFR-4; addendum §§2 and 7 |
| Never automatically delete or silently compact unresolved receipts | PRD FR-14 and risk register; addendum §7 and options considered |
| Bound unresolved state by count and bytes | PRD FR-5, FR-12, SM-5, NFR-4/NFR-7; addendum §§2, 7, and 9 |
| Refuse new automatic capture before receipt creation at either cap | PRD FR-12 and SM-5; addendum session-close flow and verification matrix |
| Keep SessionEnd fail-open and operator-visible | PRD FR-12, NFR-2/NFR-7, and risk register; addendum §7 |
| Provide exact recovery next action | PRD FR-5, FR-12, and command table; addendum CLI, retention, and verification contracts |
| Make `retry-exhausted` recovery unambiguous | FR-14 and command table; addendum §§4, 7, and 9 authorize one additional operator-requested attempt on the same receipt without an automatic loop |
| Resume only after existing unresolved work is recovered below both caps | PRD FR-12; addendum §7 |
| Add no receipt state or dismissal command | PRD FR-5/FR-14 and command table; addendum §§4 and 7 |

## Verdict

Reconciled within the PRD workspace. MAJOR-1's contradictory dismissal requirement is removed without weakening finite retention, visibility, recovery, or preservation of already-admitted unresolved evidence. At the admission gate, the contract candidly states that the refused session was not captured.
