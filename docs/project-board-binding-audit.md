# Project Board Binding Audit (PJAN-125)

**Date:** 2026-11-19  
**Scope:** All 55 registered projects in the pjangler registry  
**Method:** `pj list --json` grouped by provider, workspace, board_id, scope_label, identifier, repo_path, notebook_id, overview_note_id

---

## Summary

The original PJAN-125 collision (stemjangler + drumjangler both bound to Plane board `fdfbeb2d-4e0f-43a3-9615-f3f13c60a9f1` / identifier DRUMJ) is **resolved by history**: both were two local clones of a single GitHub repository. That repository is now **gruvato** (renamed from drumjangler on 2026-09-19); the board identifier was updated to GRUV; neither stemjangler nor drumjangler slug exists in the current registry (55 projects, no old slugs). No re-link or new board is needed for the retired clone names.

The registry-wide duplicate-board check found exactly **two other shared-board groups**:

| Group | Provider | Board | Projects | Scope labels | Classification |
|-------|----------|-------|----------|--------------|----------------|
| INT pair | Trello | `687535e9873b89478afef689` | intelliforia, intelliforia-mobile | None (both) | **Intentional** — two repos for one product |
| TOLT trio | Plane | `eb302959-0eac-48da-8fd5-ae1666bd500f` | tolt, lost-things-forge, tower-of-lost-things | `repo:tolt`, `repo:forge`, `repo:game` | **Intentional** — scoped shared board |

No other duplicate classes exist (repo_path, identifier+scope, notebook_id, overview_note_id all unique per scope).

---

## Original Collision Resolution

### What happened
- The GitHub repository was originally `delorenj/stemjangler`, then renamed to `delorenj/drumjangler` (GitHub rename redirect).
- Two local clones existed: `~/code/stemjangler` and `~/code/drumjangler`.
- During a slug-rewrite window (commit prior to 2026-08-28), the repo's `.project.json` was temporarily rewritten to use slug `stemjangler` (keeping the same board `fdfbeb2d` / identifier `DRUMJ`).
- `pj init` (or equivalent) ran in **both clones** during this window → two registry rows: `stemjangler` and `drumjangler`, both claiming the same board.
- The slug rewrite was reverted on **2026-08-28** (commit `6d08bcbc`: "revert the stemjangler slug rename — one repo, two clones").
- The repository was later renamed to **gruvato** on **2026-09-19** (commit `7f9b494b`), `.project.json` updated to `project_name: gruvato`, `identifier: GRUV`, same board UUID.
- Current registry (55 projects): only **gruvato** owns board `fdfbeb2d` / identifier `GRUV`. Neither `stemjangler` nor `drumjangler` is registered.

### Root cause timeline
| Date | Event |
|------|-------|
| 2026-07-06 | Registry implementation landed (`18ad347`), including `validateNoDuplicateProject` init-time guard and `validateProjectRegistry` R4 full validation |
| 2026-08-28 | Slug rewrite reverted (`6d08bcbc`); two clones existed with conflicting registrations |
| 2026-09-10 | PJAN-125 filed |
| 2026-09-19 | Repo renamed to gruvato (`7f9b494b`), board identifier updated to GRUV |
| 2026-11-18 | Audit confirms collision resolved; registry clean of both old slugs |

The init-time guard (`validateNoDuplicateProject`) would have rejected the second registration **if it ran during both `pj init` calls**. The fact that both registered suggests either:
- The guard logic is provider-specific (Plane only?), or
- The registrations used a path bypassing `pj init` (e.g., hand-edited `.project.json` + registry), or
- The two `pj init` calls raced before either was indexed.

The full validation (`validateProjectRegistry` R4) keys by `${scope}\u0000${boardId}` and **would reject** unscoped duplicate boards on any write path that invokes it. The current registry tolerates them in reads (`validateIndexedRegistry` deliberately skips board checks).

---

## Registry-Wide Audit Results

### Duplicate board bindings (grouped by provider, workspace, board_id)

| Provider | Workspace | Board | Scope | Projects | Verdict |
|----------|-----------|-------|-------|----------|---------|
| Trello | — | `687535e9873b89478afef689` | *(none)* | intelliforia, intelliforia-mobile | Intentional: two repos, one product, no PM agents |
| Plane | 33god | `eb302959-0eac-48da-8fd5-ae1666bd500f` | `repo:tolt` | tolt | Intentional: scoped shared board |
| Plane | 33god | `eb302959-0eac-48da-8fd5-ae1666bd500f` | `repo:forge` | lost-things-forge | Intentional: scoped shared board |
| Plane | 33god | `eb302959-0eac-48da-8fd5-ae1666bd500f` | `repo:game` | tower-of-lost-things | Intentional: scoped shared board |
| Plane | 33god | `fdfbeb2d-4e0f-43a3-9615-f3f13c60a9f1` | *(none)* | gruvato | **Only owner** (original collision resolved) |

### Other duplicate classes checked

| Class | Result |
|-------|--------|
| `repo_path` | No duplicates |
| `identifier` + scope | Only intelliforia pair (same INT, no scope) |
| `notebook_id` | No duplicates |
| `overview_note_id` | No duplicates |

### Intelliforia pair — intentional sharing evidence

- **Two separate GitHub repos**: `IntelliForia/intelliforia` (Chrome extension + Flask backend) and `IntelliForia/intelliforia-mobile` (planned Dart mobile app).
- Both point to the **same Trello board** (`687535e9873b89478afef689`, identifier `INT`).
- **No PM agents registered** for either project (`agents: {}` in both `.project.json`).
- Status: intelliforia `active`, intelliforia-mobile `planned`.
- **Impact assessment**: The "two PM agents transition same tickets" failure mode does not apply (no PM agents). Per-project reporting would double-count tickets on the shared board, but this is accepted for a single product with two repos.
- **Guard status**: Registered after the registry guard existed (2026-07-09 / 2026-07-14 vs guard 2026-07-06). The init path likely did not enforce the board uniqueness check for Trello, or the projects were added via a path that skipped it. The strict R4 validation would reject this state on any write that runs it.

### TOLT trio — intentional scoped sharing

- Three repos (`tolt`, `lost-things-forge` (subdir), `tower-of-lost-things` (subdir)) share one Plane board.
- Distinct `scope_label` values (`repo:tolt`, `repo:forge`, `repo:game`) — the **scoped shared board pattern** implemented in pjangler's role.yaml `board_scope`.
- Each has its own PM agent(s); `px` routes by scope label.
- This is the designed multi-repo, single-board pattern. No defect.

---

## Limitations & Observations

1. **`pj doctor --all` does not check duplicate board bindings** — it uses `validateIndexedRegistry` which deliberately tolerates shared boards (reads must not fail because of another project's binding policy). Result: `doctor ok: true` for all 55 projects including both shared groups.
2. **Strict validation (`validateProjectRegistry` R4) only runs on write paths** (init, link, registry mutations). It keys by `${scope}\u0000${boardId}` and would reject the intelliforia pair (empty scope) and any future unscoped sharing.
3. **No automated detection** for the class of defect PJAN-125 reported (two repos accidentally sharing a board without scopes). The init-time guard `validateNoDuplicateProject` catches some cases but may not cover all registration paths or providers.

---

## Recommendations

- No code change required. The original collision is resolved; remaining shared boards are intentional.
- If automated detection of unscoped shared boards is desired, a future ticket could extend `pj doctor` with a `--strict` mode that runs `validateProjectRegistry` checks, or add a read-only audit command. This is not blocking.
- The Intelliforia pair's legitimate sharing demonstrates that "shared board" is not inherently a defect — the distinction is **intentional product structure** vs **accidental collision**. The scoped pattern (TOLT) is the supported way to do this on Plane; on Trello, no scope mechanism exists, so intentional sharing lives without scopes.

---

## Evidence Links

- Gruvato rename commit: `gruvato@7f9b494b` (2026-09-19)
- Slug revert commit: `gruvato@6d08bcbc` (2026-08-28) — "revert the stemjangler slug rename — one repo, two clones"
- Registry implementation: `pjangler@18ad347` (2026-07-06) — includes `validateNoDuplicateProject` and `validateProjectRegistry` R4
- Registry read validation: `pjangler/src/project/index.ts` `validateIndexedRegistry` (lines 599–609)
- Full registry validation R4: `pjangler/src/project/index.ts` lines 634–641
- Init-time guard: `pjangler/src/project/index.ts` `validateNoDuplicateProject` (lines 2121–2139)