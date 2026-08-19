# Current technology and code reality review

Reviewed the draft spine against the finalized planning contracts and current PJangler, Bloodbank, CommonProject, package, and live Open Notebook 1.14 surfaces.

## Findings

### CT-1 — BLOCKER: the current transaction has no single registry-last external tail

**Current evidence:** `src/recipes/ProjectRecipe.ts:226-234` recognizes only ticket-provider actions as plan-level external actions. `ProjectRecipe.init` persists Registry early when no board effect is armed (`:398-411`), executes the ticket/Registry plan together (`:413-432`), and can run Hermes external effects after that (`:434-448`). `executeProjectInitPlan` merely defers a `registry.upsert` within one supplied plan (`src/project/index.ts:1029-1031,1090-1134`). Later phases are gated by `errors.length === 0`, so a recoverable Notebook failure cannot both return failure and persist truthful `planned` recovery state.

**Exact spine fix:** Require `ProjectRecipe.init` to build one typed `ProjectExternalEffectPlan` containing ticket-provider, Hermes, and Notebook effects; withhold every `registry.upsert`; execute all authorized effects; refresh/commit Manifest; audit; then invoke exactly one Registry-only plan last. Persist a structured recoverable `planned/blocked` outcome before categorizing the command unsuccessful; persist `linked` only after remote postconditions pass. Add an adapter-mutation order test for every effect combination.

### CT-2 — HIGH: fresh-target rollback can erase recovery evidence after dispatch

**Current evidence:** `ProjectRecipe.init` unconditionally removes a newly created target on any error (`src/recipes/ProjectRecipe.ts:485-505`), including errors after ticket-provider or Hermes dispatch. The spine's failure table does not name the required change to this existing branch.

**Exact spine fix:** Require an `externalDispatchStarted`/`possiblyDispatched`
latch in `ProjectRecipe.init`. The existing `rmSync(targetDir, recursive)` path
is legal only while that latch is false. Once any remote adapter may have
received a request, preserve the repository, Manifest marker/binding evidence,
and planned Registry recovery record; never delete or roll back remote objects.
Add injected failures immediately before dispatch, after dispatch, after remote
success, after Manifest write, and after Registry write.

### CT-3 — HIGH: the packed-CLI-to-Skillex distribution bridge is unspecified

**Current evidence:** the spine makes `/home/delorenj/code/skillex/all-skills/project-notebook/` canonical, while `package.json:13-20` ships only `dist`, CommonProject/Hermes templates, and two mise scripts. The adopted packed-CLI/skill-assets gate uses an isolated home; an absolute developer checkout cannot satisfy it.

**Exact spine fix:** Add one binding distribution decision: Skillex remains the
only hand-edited source, while PJangler's build/prepack consumes a versioned,
digest-verified generated export included in `package.json.files` (or declare a
specific installed-package resolver with equivalent offline fixture). Name the
runtime resolver precedence and the `notebook.skill-installed` failure/remedy
when no source/export exists. The packed generated-project test must install
from the tarball into an isolated HOME with the developer Skillex checkout made
unavailable and still project/check the skill and hooks.

### CT-4 — MEDIUM: `/api/config` does not report authentication state

**Current evidence:** live Open Notebook 1.14 `GET /api/config` returns `dbStatus`, `hasUpdate`, `latestVersion`, and `version`; its OpenAPI response is unconstrained and has no `auth_enabled`. Spine lines 313 and 391 incorrectly attribute `auth_enabled:false` to that API.

**Exact spine fix:** Change the adapter table to “version/health only” and label
authentication mode as deployment/config provenance, not a `/api/config`
field. Send bearer credentials only when effective PJangler auth configuration
requires them; normalize an actual 401/403 as `AUTHENTICATION_FAILED`; contract
tests must cover auth-required and auth-disabled fixtures independently of the
config response.

### CT-5 — MEDIUM: Bloodbank preserves structure, not whole-file bytes on change

**Current evidence:** Bloodbank `_merge_hooks` preserves foreign groups, siblings, and relative order (`/home/delorenj/code/33GOD/bloodbank/services/agent-hooks/sync.py:582-621`), but a change serializes the whole live JSON with `json.dump` (`:883-895`). Project Notebook “bytes” therefore do not survive a changing sync. CommonProject separately owns the entire project-scoped Claude `hooks` key (`templates/commonproject/template/.agents/hooks/sync.py:143-155`).

**Exact spine fix:** Specify coexistence assertions as parsed foreign-object
equality plus relative group/sibling order across a changing first sync; reserve
whole-file zero-byte equality for the second identical sync. Keep the mandatory
`project-notebook.v1` survival/no-duplication regression and the separation from
CommonProject's project-scoped owner.

## Compact pass table

| Area | Result | Evidence |
| --- | --- | --- |
| Runtime/dependency pins | PASS | Installed Node 26.5.0 and package-lock versions match the spine; package contract remains Node >=20. |
| Recipe sync/async model | PASS WITH CT-1/2 | Immutable observation plus synchronous checks is feasible; the existing transaction seam must be rewritten explicitly. |
| Lossless YAML/PostgreSQL model | PASS | AD-5 addresses current top-level/project/Manifest reconstruction losses and supplies additive JSONB plus preservation tests. |
| Membership and search | PASS | OpenAPI `NoteResponse` has no notebook ID; scoped note-list membership and local lexical search avoid global-search leakage/incompleteness. |
| Claude events | PASS | True `SessionStart`/`SessionEnd`, no `Stop` equivalence, matches the adopted contract. |
| Global hook ownership | PASS WITH CT-5 | Bloodbank inner-hook merge and CommonProject whole project-hooks ownership are represented accurately. |

## Verdict

**NOT-READY** until CT-1 is resolved in the spine. Counts: **1 blocker, 2 high,
2 medium; 0 low**.

## Final recheck

- **CT-1 — RESOLVED:** AD-3 and the transaction section now bind one fixed-order `ProjectExternalEffectPlan`, withhold all Registry actions, preserve a primary unsuccessful outcome, and run one Registry-only finalizer last.
- **CT-2 — RESOLVED:** `externalDispatchStarted` now latches before every ticket, Notebook, or Hermes dispatch; recursive fresh-target deletion is permitted only before the latch and post-dispatch recovery evidence is preserved.
- **CT-3 — RESOLVED:** AD-23 defines a digest-verified prepack export under shipped `dist`, resolver precedence, XDG installation ownership, conflict behavior, and the isolated-tarball test with the developer Skillex checkout unavailable.
- **CT-4 — RESOLVED:** the adapter table now treats `/api/config` as health/version and obtains auth status separately; configured bearer behavior and actual 401/403 categorization are independent.
- **CT-5 — RESOLVED:** first changing Bloodbank sync now requires parsed object equality plus relative order; whole-file zero-byte equality applies only to the second identical sync.

**Final verdict: READY.** Counts after recheck: **5 resolved; 0 blocker, 0 high, 0 medium, 0 low outstanding**.
