---
title: 'PJAN-199 pj project rename: one project key across registry and board'
type: 'feature'
created: '2026-11-02'
status: 'done'
baseline_commit: f77e516b776550e33bf814a080ddac6647c3bada
route: 'dispatch'
ticket: PJAN-199
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="human-owned intent — approved 2026-11-02 ('Take your recommendation and continue')">

## Intent

**Problem:** A project carries a lowercase registry `project_id` and an uppercase board identifier that are spelled independently (`tower-of-lost-things` vs `TOWE`), and nothing can rename either safely: the registry refuses re-keyed records and Plane identifiers are only editable in the UI.

**Approach:** `pj project rename <old> <new>` (also `pj rename`) makes one key the project's identity: `project_id = <new>` and board identifier `= <NEW>`. Dry run by default; `--apply` renames the live Plane board identifier, rewrites `.project.json`, rekeys the registry index and reconciles downstream references. Repo path, project name, board UUID and workspace never change.

## Boundaries & Constraints

**Always:** Validate the new key before any write: `^[a-z0-9]{1,12}$` (Plane identifiers are alphanumeric, max 12); not registered to another project; not the identifier of another board in the workspace (live read). Order writes Plane PATCH → read back → manifest → registry `/v1/index` → downstream; every step idempotent so a re-run after partial failure converges (Plane already showing `NEW` is success, not an error). Report each step's outcome; a failed downstream step is reported, never silently skipped, and exits 1. Preserve every unknown manifest field. Support both the service registry and a YAML `--registry` fixture.

**Never:** Rename the repo directory, `project_name`, `board_id`, `workspace`, Hermes agent ids, Hindsight banks, or historical events. Never write Plane in dry run. Never pass through `saveProjectRegistry`/`PUT /v1/registry` for the id change. Never print a credential.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Dry run | `pj project rename towe tolt` | Plan: manifest fields, board `TOWE→TOLT`, downstream files; nothing written | — |
| Apply, Plane | `--apply` | Plane identifier `TOLT`, manifest `project_id: tolt`, identifier `TOLT`, index row rekeyed, downstream reconciled | — |
| Trello board | binding type trello | No provider write; local identifier + id renamed | — |
| Invalid key | `tolt-x`, 13 chars, empty | Refused before any read/write | exit 1, `invalid_key` |
| Collision | new id registered, or another board uses `TOLT` | Refused before any write | exit 1, `identity_collision` |
| Unknown old id | not in registry | Refused | exit 1, `unknown_project` |
| Partial failure | Plane renamed, manifest write failed | Reports Plane done, manifest failed; re-run completes | exit 1, resumable |
| Same key | old == new (case-insensitive) and board matches | No-op success | — |
| Archived board | Plane `archived_at` set | Refused | exit 1, `board_archived` |

</frozen-after-approval>

## Code Map

All paths under `pjangler/` unless noted.

- `src/index.ts` `registerProjectCommands` (~868, called for top-level and `project`): add `rename` beside `remove` (924) / `link` (959); copy their `--apply`/`--registry`/`--json` pattern, `{ok:false,error,code}` + `process.exit(1)` on failure.
- New `src/project/rename.ts`: `renameProject(opts)` returning a step report; logic lives here, not in `index.ts`.
- `src/project/identity.ts`: reuse `planeBase`, `planeApiKeyFor` (207, export it), `fetchPlaneBoards` (215; returns `PlaneBoardFacts` with `archived`), `liveKeyIndex` (555), `atomicWrite` (433, export), `reconcileProjectIdentity` (959; `{target:newId, apply:true}` pushes the new identifier into `~/.hermes/agents-registry.yaml` via `applyHermesIdentifiers`), Trello check `fetchTrelloBoard`. Add `patchPlaneBoardIdentifier(workspace, boardId, key, env, home)` (PATCH `{base}/api/v1/workspaces/{ws}/projects/{id}/` `{identifier}`, `X-API-Key`, 20s timeout) with test seams `fetchBoards`/`patchBoard` like `IdentityOptions.fetchBoards`.
- `src/project/registryClient.ts`: `resolveRegistryLocation`, `isRegistryServiceLocation`, `registryRequest(loc,"POST","/v1/index",{manifest_path})`, `normalizeProjectId`. `ManifestIndex.register/persist` (`manifestIndex.ts:225-243`) already deletes the old-id row for the same manifest path — no service change needed.
- YAML fixture mode: `loadProjectRegistry`/`saveProjectRegistry` (`index.ts:429/542`); rename the key, `project_id`, `slug`, identifier; `validateProjectRegistry` (601) requires key == project_id == slug and unique identifiers.
- Manifest edit: set `project_id`, delete `project_slug`, set `ticket_provider.identifier`, `identifier_fetched_at`=now; keep everything else (pattern: `writeManifestTicketProvider`, identity.ts:1212).
- Downstream, applied in `--apply`, each reported:
  - `<repo>/agents/hermes/*/role.yaml` `plane.identifier` scalar (re-provision copies it into the fleet registry).
  - `<repo>/AGENTS.md` (CLAUDE.md is a symlink): replace `(OLD)` only on the `Board:` line.
  - `~/.config/pilot/harvest/project-hints.json`: move `projects.<old>` to `<new>`, append old id to its `aliases`; absent file/key → `skipped`.
  - Candystore projection: run `mise run project:sync` in `~/code/33GOD/candystore` (`spawnSync`, `shell:false`, timeout, missing tool → `skipped`).
  - Report-only warnings: notebook state under `~/.local/state/pjangler/notebook/v1/projects/` is keyed by slug hash and restarts fresh; old ticket refs (`OLD-n`) stop resolving; repo files changed must be committed.
- Tests: new `tests/pjan-199-project-rename.mjs` (line 1 `import "./helpers/hermetic-suite.mjs";`, env via `hermeticEnv()`/`hermeticScratch()`), registered in `SUITES` of `scripts/run-tests.mjs`. Model on `tests/init-board-ingress-regressions.mjs` (spawns `dist/index.js` with YAML `--registry` and a Plane stub process; add a PATCH handler). Suites run `dist/`: `npm run build` first.
- Rename provenance (loop 1): `manifestStep` also writes `renamed_from: {project_id: <old>, identifier: <OLD>, at: <iso>}` (unknown manifest fields are preserved by `validateManifestFields` and Pilot). Resume is allowed only when the old id is unregistered AND the new id's manifest carries `renamed_from.project_id === <old input>`; otherwise `unknown_project`. On resume, `oldId` stays the old input and `renamed_from.identifier` joins the old identifiers, so AGENTS.md and harvest-hints steps still find the old spellings. A second rename overwrites `renamed_from`.
- Do not touch: the existing uncommitted PJAN-196/198 test-harness edits in this checkout.

## Tasks & Acceptance

**Execution:**
- [x] `src/project/identity.ts` -- export helpers, add `patchPlaneBoardIdentifier` + seams -- the only Plane write.
- [x] `src/project/rename.ts` -- validation, plan, ordered idempotent apply, downstream steps, step report.
- [x] `src/index.ts` -- register `rename` with `--apply`, `--registry`, `--json`, human output with dry-run hint.
- [x] `tests/pjan-199-project-rename.mjs` + `scripts/run-tests.mjs` -- cover every matrix row against a stub Plane and YAML registry in a hermetic scratch home.
- [x] `README.md` / `docs` CLI reference (where `link`/`remove` are documented) -- document the command and its warnings.

**Acceptance Criteria:**
- Given a dry run, when it completes, then no file, registry row or Plane field changed and the plan lists every step.
- Given an apply interrupted after the Plane step, when re-run, then it finishes all remaining steps and reports success.
- Given `--json`, when any refusal occurs, then stdout is one `{ok:false,error,code}` document.

## Implementation Notes

- 6c03b3c: command, rename.ts, Plane PATCH helper, docs, 13-case suite. b04d0c0: review loop 1 (renamed_from provenance, containment, read-back on thrown PATCH, hints merge, fleet read-back, 20-case suite).
- Deviation: `identifier_source`/`identifier_fetched_at` are set only when Plane confirms the key (bound Plane board); Trello/unbound keep their source, per the repo rule that a proposal has no fetch instant.
- Live check 2026-11-02 on the TEST scratch board (56 tickets): Plane PATCH {identifier} returns 200, read-back shows the new key, tickets re-prefix at once (TEST-1 -> TSTX-1, old ref stops resolving), 13 chars refused with 400 "no more than 12 characters"; board restored to TEST.
- Full suite: 99/100; the one failure (pjan-184-tree-primitives-regressions) also fails at baseline f77e516.

## Spec Change Log

- 2026-11-02 loop 1 — trigger: review found that a resumed run (old id already gone from the registry) cannot know the old id or old identifier, so (a) `pj rename <any-typo> <new> --apply` reports success instead of `unknown_project`, and (b) a re-run after a downstream failure skips the AGENTS.md `Board:` line and the harvest-hints move while reporting ok. Amended: Code Map (rename provenance in the manifest) and Design Notes. Known-bad state avoided: false success on a wrong old id; a "resumed" rename that silently leaves stale references. KEEP: the critical-chain ordering and step report, Plane PATCH + read-back, `/v1/index` re-key (never PUT), the role.yaml single-scalar splice with its integrity check, the YAML-fixture branch, `pj rename` alias, `--json` refusal shape, and the existing 13 test cases.

## Review Triage Log

| # | Source | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|---|
| 1 | blind, edge | Resume accepts any unregistered old id when new id already reads NEW | medium | rename.ts:195-208 resumes on `existing && recorded === NEW` with no link to the old input; candystore re-syncs and exits 0 | bad_spec |
| 2 | edge | Resume loses old identifier, AGENTS.md/hints never fixed on re-run | medium | rename.ts:263-269 builds oldIdentifiers from records that already read NEW; oldId=newId so hintsStep skips | bad_spec (same root cause as 1) |
| 3 | blind | `changedFiles` repo warning uses bare prefix | low | rename.ts:578 `startsWith(repoPath)` matches sibling dirs | patch |
| 4 | blind, edge, vgap | AGENTS.md symlink resolving outside repo edits a shared file; symlink branch untested | medium | rename.ts:448 `realpathSync` then `atomicWrite` with no containment check; test symlinks only CLAUDE.md | patch |
| 5 | blind | Board: matcher narrow | false | Spec scopes the step to the `Board:` line `(OLD)` form; non-matching lines report `skipped` with detail | reject |
| 6 | blind | Human output omits changed files | low | formatRenameResult prints no changedFiles; JSON carries them | patch |
| 7 | blind | Docs omit `registry_unavailable`, `--registry`, JSON shape; uppercase input normalization | low | docs/project-registry.md section vs RenameErrorCode | patch |
| 8 | blind | PATCH timeout reported as unreachable though it may have applied | low | rename.ts:298-302 returns failed without read-back; re-run converges via `already` but message misleads | patch |
| 9 | blind | Plane identifier PATCH on a board with tickets unverified live | false | Verified live on TEST (56 tickets): 200, read-back matches, tickets re-prefix | reject |
| 10 | blind | YAML mode re-keys registry when manifest missing | false | In file mode the YAML registry is authoritative and a manifest is optional; nothing reindexes from manifests | reject |
| 11 | blind, edge | Hints collision drops old entry while claiming alias kept | low | rename.ts:499-501 keeps existing new entry, discards old entry's aliases | patch |
| 12 | blind | Candystore path hardcoded, blocking spawn, full sync | low | CLI-only, bounded timeout; one-off command | reject |
| 13 | blind | Static warnings print on no-op/Trello/resumed runs | low | rename.ts:574-577 unconditional | patch |
| 14 | blind, vgap | Refusal codes, mise missing/failing, read-back mismatch, wrong-old-id resume untested | medium | grep of tests/ for those codes finds only rename.ts | patch |
| 15 | blind | 12-char alnum key enforced for non-Plane | false | Frozen intent: one key, `^[a-z0-9]{1,12}$` always | reject |
| 16 | blind | identity.ts exports widened | false | No caller harmed; named harm absent | reject |
| 17 | edge | Fleet step reports already while an out-of-scope agent stays stale | low | status derives from reconcile's change count, not a read-back of bound agents | patch |
| 18 | edge | readdirSync in roleStep outside try | low | rename.ts:382 throws past the step report after Plane/manifest writes | patch |
| 19 | edge | role.yaml unrelated identifier overwritten | false | Agents under this repo's agents/hermes are bound to this repo's board | reject |
| 20 | edge | null ticket_provider / empty repo_path | maybe-false | Registry validation should guarantee both; would only be low | reject |
| 21 | edge | Unbound Plane project gets no live collision check | low | `pj project link` re-checks the key later; adding a read adds a branch for a rare state | reject |
| 22 | edge | Dry-run downstream failure says "re-run to resume" | low | rename.ts:601-603 message is apply-only wording | patch |
| 23 | edge | fleetStep may PUT the registry in service mode | maybe-false | After manifest+index, record identifier equals live so reconcile has no project changes; would need drift elsewhere | reject |
| 24 | edge | roleStep silently skips non-scalar identifiers | low | rare hand-edited shape; no named consumer | reject |
| 25 | vgap | yamlScalarFor quoting and YAML-registry `project_id` branch untested | low | plainSafe already quotes YAML words; tests only | defer |
| 26 | vgap | Human failure rendering untested | low | --json covers refusal shape | reject |

## Design Notes

Plane is written first because it is the step most likely to be refused (identifier taken, permission) and the cheapest to leave untouched; once it succeeds, every later step is local and retryable. Identifier is uppercase of the key, so `rename` cannot desynchronize them. Resume needs evidence of what the project used to be called; the manifest is the one durable place every step already reads, so it carries `renamed_from`.

## Verification

**Commands:**
- `npm run typecheck && npm run build` -- clean.
- `node tests/pjan-199-project-rename.mjs` -- all cases pass.
- `npm test` -- no new failures versus baseline.
