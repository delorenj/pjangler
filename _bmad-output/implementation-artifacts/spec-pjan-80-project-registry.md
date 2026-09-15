---
title: One project identity and manifest-owned PostgreSQL registry
type: refactor
created: 2026-09-15
status: validating
baseline_commit: 8f1497c0644f8687873b62e2b41b3d6330ce4f4d
ticket: PJAN-80
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="User approved this contract with do it after selecting PostgreSQL">

## Intent

**Problem:** Pilot declares its project locally but PJangler cannot find it because the CLI reads a competing YAML definition. Doctor reports success while omitting this project. Slugs, board prefixes and provider UUIDs expose conflicting identities.

**Approach:** Repository `.project.json` owns a lowercase, case-insensitive `project_id` and the complete definition. A singleton service indexes manifests in PostgreSQL for cross-project queries. Top-level `pj info` reads the current repository; explicit project IDs resolve through the index. Existing provider UUIDs remain API binding metadata.

## Boundaries & Constraints

**Always:** Preserve unknown manifest fields, current provider bindings, global notebook settings, unrelated WIP and existing shared PostgreSQL relationships. Normalize IDs consistently. Report unavailable or stale index state truthfully. Persist manifest changes before indexing and make retry converge. Keep one writable project definition. Land commits and prove the installed CLI.

**Ask First:** Only unresolved destructive data conflicts with no evidence-bound resolution.

**Never:** Silent YAML fallback in production, bidirectional authority, bulk deletion of shared database projects, credential literals, automatically renaming provider boards, or declaring a live migration complete from unit tests alone.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Current repository | Valid manifest, no index entry | Local info succeeds with not-indexed status | Doctor identifies missing registration |
| Explicit lookup | px, PX, Px | Same canonical project_id px | Unknown ID gives actionable error |
| Index unavailable | Service down | Local info remains available; global lookup fails | No fallback to YAML |
| Direct edit | Manifest changed since indexing | Reads refresh the derived record and hash | Invalid manifest is reported, not silently overwritten |
| Collision | Two repositories declare same normalized ID | Reject second registration | Preserve existing binding and both files |
| Concurrent change | Stale client attempts update | Reject conflicting write or apply only unchanged fields | Never overwrite newer manifest content |
| Migration | Legacy YAML plus local manifests | Manifests win; registry-only metadata reconciled where missing | Preserve unresolved records for review |

</frozen-after-approval>

## Code Map

- `src/project/index.ts`: sync registry boundary, bootstrap plan/apply, manifest rendering, doctor and remove. Default locator currently resolves to YAML; several callers incorrectly assume filesystem paths.
- `src/project/RegistryStore.ts`: unused-in-most-commands PG and dual-write adapters; legacy full-save deletes missing owned rows. Do not reuse snapshot deletion semantics.
- `src/notebook/{config,module,cli,hooks}.ts`, `src/recipes/NotebookRecipe.ts`: synchronous config and file snapshots; separately mirrors YAML into PG. Binding ownership must move into manifests.
- `src/fleet/inventory.ts`: bypasses loader with direct YAML parsing. `src/project/identity.ts` and `src/describe/index.ts` also require locator-aware adaptation.
- `src/index.ts`, `src/project/boardQuery.ts`, `src/prompt.ts`, `src/recipes/ProjectRecipe.ts`: public CLI and local project identity surfaces.
- Existing `33god.public.projects` has eight legacy UUID records and no PJangler migrations applied. Preserve their references. A dedicated manifest index has the canonical string key; legacy surrogate IDs remain internal historical relationships.

## Tasks & Acceptance

**Execution:**
- [x] `src/project/registry*.ts`, migration and service files: implement PostgreSQL index, bounded transport, atomic manifest writes, conflict detection, hash refresh, health and registration endpoints. Keep the synchronous client boundary for existing public APIs.
- [x] `src/project/index.ts`, `RegistryStore.ts`: route production readers and writers through service; retire dual-writing; render canonical project_id; keep explicit fixture/import file handling isolated.
- [x] Consumer files in Code Map: resolve service locators correctly, use canonical identity, remove duplicated notebook persistence and filesystem checks on URLs.
- [x] CLI files in Code Map: top-level info/list/doctor and project operations; implicit nearest-repo scope; legacy spellings only transitional compatibility.
- [x] `tests/pjan-80-*.mjs`: real disposable PostgreSQL/service integration and CLI matrix regression tests.
- [x] Service installation and migration script: deploy singleton, reconcile registered manifests plus Pilot, retire active YAML, validate idempotent rerun.
- [ ] Documentation and ticket: record authority, migration and verification; commit/push changes and merge to main, preserving existing work.

**Acceptance Criteria:**
- Given the installed CLI in Pilot, when info and doctor run, then both identify px and correctly report its live PostgreSQL index entry.
- Given a valid repo manifest, when the registry is unavailable, then info returns local facts with explicit unavailable status.
- Given current registry consumers, when fleet, notebook, bootstrap and MCP read project state, then all use manifest-derived identity through the same registry boundary.
- Given migrated project records, when rebuilding the index, then definitions and provider bindings survive without reading a second authoritative configuration.

## Spec Change Log

## Design Notes

Existing APIs are synchronous; a bounded child-process HTTP bridge avoids changing every notebook and lifecycle API to async. The singleton uses native Node HTTP and pg. Runtime state stays outside source checkouts. Global service settings are separate from indexed project definitions. `slug` may exist as an internal compatibility field equal to project_id, never a separately editable identity.

## Verification

**Commands:**
- `npm run typecheck` and `npm run build`: compile all consumers.
- `node tests/pjan-80-registry-regressions.mjs`: isolated live PostgreSQL and service proof including matrix cases.
- Focused CLI, notebook, fleet, bootstrap and existing project regression suites: preserve compatibility.
- Installed `pj info`, `pj info PX`, `pj doctor`, `pj list --json`: verify Pilot and indexed population.
- SQL counts/hashes, service health and migration rerun: verify durable runtime state.

## Review disposition

Three independent reviews covered the implementation, edge cases and missing verification.
The resulting changes are covered by focused regressions:

- Manifest writes preserve unrelated concurrent edits; link and notebook consumers use the
  service baseline before writing. Bootstrap rejects plans whose manifest changed.
- Missing or malformed files retain their last valid snapshot with an unhealthy status.
  Snapshot saves cannot revive removed projects or implicitly delete omitted projects.
- Rebuild accepts discovery receipts; relocation rejects live duplicate repositories and
  allows replacing a missing location.
- Settings writes validate types, preserve newer values and support baseline-aware deletion.
- Migration preflights identity/path collisions, preserves provider extensions, respects an
  explicit agent map, skips empty legacy URL placeholders and is idempotent.
- PostgreSQL upgrades the original TEXT index key to citext transactionally, preserving
  rows while enforcing canonical lowercase storage and case-insensitive SQL lookup.
- Installer restarts an existing service and verifies readiness. Packaged distribution
  includes the service, installer and import dependencies.

Registry clients serialize their writes. An arbitrary external editor does not participate
in that lock; hash comparison immediately before rename detects changes observed at that
point, but the filesystem cannot guarantee CAS against an uncoordinated process.

## Live acceptance evidence (2026-09-15)

- Installed singleton restarted successfully at `http://localhost:8764`.
- All 18 registered manifests migrated; rerun reported zero changed manifests.
- Pilot `pj info` and `pj info PX` resolve canonical `px`, registry indexed.
- `pj doctor --all --json`: all 18 checked, zero issues.
- Receipt-based rebuild succeeded after removing active `projects.yaml`.
- Historical YAML import retained outside source repositories at
  `~/.local/state/pjangler/migrations/2026-09-15-projects.yaml`.
- Original shared `public.projects` rows and their foreign-key relationships preserved.
- Eight focused core suites, bootstrap regression, migration regression, typecheck,
  package-lock parity, submodule contract and tracked-secret gate passed.

## Suggested review order

1. [Registry service and manifest ownership](../../src/project/manifestIndex.ts)
2. [Compatibility boundary](../../src/project/registryClient.ts)
3. [CLI commands](../../src/index.ts) and [local info](../../src/project/info.ts)
4. [Migration](../../scripts/migrate-project-registry.mjs) and [operations](../../docs/project-registry.md)
5. [Real PostgreSQL regression suite](../../tests/pjan-80-registry-regressions.mjs)
