# Input Reconciliation — Original Project Notebook Request

## Input

`pasted-text-1.txt`, supplied 2026-08-19.

## Extracted intent and coverage

| Input signal | PRD/addendum coverage |
| --- | --- |
| Every PJangler project receives a Companion Notebook | Vision; FR-1 through FR-4; MVP §6.1 |
| Repository name and notebook name map one-to-one | Glossary; FR-1; addendum §§2–3 |
| Notebook is a modular PJangler component | Vision; FR-2; NFR-8; addendum §1 |
| `pj notebook` lists, adds, searches, and performs related note work | FR-5 through FR-9; PRD §8; addendum §§4–5 |
| Skill pack carries hooks through the agent master fanout | FR-10; NFR-8; addendum §7 |
| Repository-scoped hook behavior | FR-10 consequences; FR-20; addendum §§2, 7 |
| Session start reads an overview alongside Hindsight | UJ-2; FR-11; NFR-3/NFR-4 |
| Session end uses a low-cost LLM to inspect the diff, upload changed docs, and add a summary | FR-12 through FR-14; addendum §§7–8 |
| Build a rich notebook over time | Vision, while SM-C1 and Non-Goals prevent volume from becoming the objective |

## Reconciliation decisions

- The ambiguous “overview page” became one stable, bounded Overview Note, seeded minimally and replaceable through the CLI.
- The uncertain upload hook became a true session-close boundary only; turn-level stop is explicitly rejected.
- “Etc.” after list/add/search was bounded to status, create, note CRUD, search, overview, audit, and migrate.
- Repository name remains the display-name rule; the stable Notebook Service identifier prevents rename/collision duplication.
- The requested low-cost LLM is retained, with a deterministic fallback so capture is not model-dependent.
- Repeated “build a rich notebook” wording is treated as transcription repetition, not three requirements.

## Verdict

Reconciled. Every qualitative and behavioral signal is represented; no blocking gap remains.

