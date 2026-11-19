# PJAN-72 — ticket-provider deep links

Candidate source: [pjangler `566544eea3b578948721a432e68456b1c8387498`](https://github.com/delorenj/pjangler/commit/566544eea3b578948721a432e68456b1c8387498) and [zshyzsh `cc1c5ffd4ebd9747d7f4cc54563cc7440077ed30`](https://github.com/delorenj/zshyzsh/commit/cc1c5ffd4ebd9747d7f4cc54563cc7440077ed30). These are the reviewed implementation commits; this document records the subsequent launcher/Alt-O repair and delivery evidence, not a new URL authority.

| Acceptance boundary | Executable proof |
| --- | --- |
| One provider-derived URL: Plane work item/board fallback, Trello board, no invented missing `board_id` URL, Plane base precedence | `node tests/pjan-72-regressions.mjs` exercises provider, branch, config and no-board fixtures. |
| Explicit ref beats own branch; case-insensitive own identifier, no foreign-prefix match | Same focused regression exercises normalization, inference, detached/no-match and explicit reference. |
| `pjangler-prompt --url [ref]` and bare prompt; `pjangler board [ref] [--print]` resolve alike | Focused regression invokes prompt bundle, source CLI bundle, and built CLI; verifies output, absence outside project and prompt contract. |
| Headless (no display or SSH even with display), failure of absent `xdg-open`, desktop handoff | Focused regression checks OSC 8 and no fake launcher on headless paths; missing-launcher fallback has no unhandled error; desktop case only calls a fake launcher. No real browser was launched or delivery claimed. |
| `board` shell command and Alt-O ZLE widget | `python3 -I tests/test_board.py` covers command/widget with fake launcher; independent SPEC private PTY pressed Alt-O and observed OSC 8 target message, unchanged edited buffer and no fake launch in no-display and SSH-with-display cases. |

Independent SPEC and QUALITY reviewers each returned **PASS without findings** against the two candidate commits. The parent independently reran `node tests/pjan-72-regressions.mjs` (47 cases), `npm run typecheck`, `python3 -I tests/test_board.py` (2 tests with subcases), and `zsh -n board.zsh`: all passed. `git diff --check` passed on both candidate worktrees. The focused test checks both source and rebuilt `dist/index.js`, as well as `dist/prompt.js`. The full suite was **not** run. `dist/*.js` is ignored and not published in Git: downstream CLI installations must rebuild bundles (`npm run build`) from source. No board state or browser was touched during verification.
