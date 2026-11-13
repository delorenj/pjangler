# Project identity and registry

Every repository defines its project in `.project.json`. The canonical key is
`project_id`: lowercase ASCII letters, digits and internal hyphens, at most 128
characters. Lookups are case-insensitive. A project's name and repository path
can change independently of this key. Provider UUIDs and board prefixes are
provider binding metadata, not alternate project lookup keys.

```json
{
  "project_id": "px",
  "project_name": "Pilot",
  "project_description": "Plane management CLI",
  "ticket_provider": {
    "type": "plane",
    "workspace": "33god",
    "board_id": "35730097-d556-4160-ac93-c95c9ead10a0",
    "identifier": "PX"
  },
  "agents": {}
}
```

`agents` is a **one-way projection of the org chart**, not project intent. Flume
writes the employee record; pjangler projects `role_dir` in and carries existing
entries forward. `pj init` never authors one — the handbook's `projections:`
block names `agent_role_directory` as `writable_by: project-registry` and nothing
else. A repo with no employees has an empty map.

## Commands

| Command | Scope |
|---|---|
| `pj info` | Nearest repository manifest, including registry status |
| `pj info PX` | Case-insensitive lookup in the project index |
| `pj list` | All indexed projects |
| `pj doctor` | Current project's manifest and index entry |
| `pj doctor --all` | Every indexed project |
| `pj reindex` | Register or refresh the current repository |
| `pj reindex --all` | Refresh known manifest locations |
| `pj reindex --receipt <path>` | Rebuild discovery from a migration receipt |
| `pj import <checkout-or-url>` | Adopt a checkout or Git remote as a submodule of the current parent |
| `pj init --id px` | Initialize/register a project; use `--apply` to apply |
| `pj link px <board-id>` | Bind an existing provider board |
| `pj rename px px2` | Rename a project: one key becomes the project ID and the board identifier (dry run; `--apply` writes) |
| `pj identity` | Read board identifiers back from the provider and repair the registries |
| `pj identity --all` | Every registered agent, not just the current project |
| `pj board [ref]` | Open the bound board, or one work item |
| `pj remove px --apply` | Remove the index entry, retaining the repository |
| `pj subsystems` | Available project subsystems |

Legacy `pj project` commands remain hidden compatibility aliases. New scripts
should use the top-level commands. `--slug` remains a hidden input alias for
`--id`; manifests written by PJangler contain only `project_id`. Internal
records and existing event envelopes may retain `slug` as an equal-valued
compatibility field while their callers migrate. There is no independent slug
or provider-prefix lookup.

`pj init` validates an existing `.project.json` against the registry's own
manifest shape (`validateManifestShape`) while it is still planning, so a
manifest the registry would refuse fails the dry run and `--apply` with the
precise field error before a board is created or a rule writes. One old,
unambiguous shape is normalized instead: a bare path string in
`source_artifacts` becomes `{"kind": "reference", "path": ...}` and the plan
prints a warning saying so. A rule that only warns or withholds (for example
`bmad.version`, "update withheld") is reported as a warning and does not stop
registration; a rule that fails the project audit still blocks. A second
`pj init --apply` on an adopted repo converges with exit 0 and no changes.

`pj info` reads the local manifest even if the registry is unavailable. Explicit
global lookups require the service; they never silently use YAML. Registration
does not assert that a provider board was contacted. Provider verification is
the separate `pj identity` operation.

`pj identity` reads board identifiers back from the provider and repairs both
the project index and the identifier fields projected into
`~/.hermes/agents-registry.yaml`. It writes only the three fields the handbook
grants it — board identifier, id, workspace — and **never removes a row**. An
agent whose board has gone is reported `dead` with the command that owns the
removal: `flume offboard <agent-id>`. A failed workspace fetch preserves the
recorded value rather than blanking it.

**An archived board answers, and lies.** Plane serves an archived project's
record at HTTP 200 while returning empty `states/`, `labels/` and `issues/`
collections with no error, so a binding to one looks healthy and reads as an
empty board. `archived_at` on the project record is the only field that tells
the truth. `pj identity` and `pj link` both check it: a candidate that matches
only archived boards is refused with the reason named, and a recorded id
pointing at an archived board keeps its binding and says so.

## Renaming a project

`pj rename <old> <new>` (also `pj project rename`) makes one key the project's
identity: `project_id = <new>` and the board identifier `= <NEW>` (upper-cased).
The new key is lowercased, then must match `^[a-z0-9]{1,12}$` (Plane identifiers
are alphanumeric, max 12), so `TOLT` and `tolt` are the same request. `--registry`
takes a registry service URL or a YAML fixture path, as on the other commands. Repo path, project name, board UUID and workspace never change; neither do
Hermes agent ids, Hindsight banks or historical events.

It is a dry run unless `--apply` is passed. Writes happen in a fixed order and
every step first checks whether it is already true, so a run interrupted
anywhere converges when repeated (Plane already showing the new identifier is
success, not an error):

1. **plane**: PATCH the board identifier, then read it back. Plane identifiers
   are editable through the API only here; Trello has no provider write.
2. **manifest**: `.project.json` gets `project_id`, `ticket_provider.identifier`
   and, for a provider-confirmed key, a fresh `identifier_fetched_at`; the legacy
   `project_slug` is dropped and every unknown field is kept. It also records
   `renamed_from: {project_id, identifier, at}`, which is what lets a re-run
   recognise a half-finished rename (the old id is already gone from the
   registry) and still find the old spellings in `AGENTS.md` and the hints file.
   A re-run naming an old id that is not the one in `renamed_from` is refused as
   `unknown_project`; a second rename overwrites `renamed_from`.
3. **registry**: the service re-indexes the manifest (`POST /v1/index`, never
   `PUT /v1/registry`); a YAML `--registry` fixture has its record re-keyed.
4. **downstream**, each reported on its own line: `agents/hermes/*/role.yaml`
   `plane.identifier`, the fleet registry (`~/.hermes/agents-registry.yaml`), the
   `Board:` line of `AGENTS.md`, `~/.config/pilot/harvest/project-hints.json`
   (the old id is kept as an alias) and the Candystore projection
   (`mise run project:sync`; skipped when the checkout or `mise` is absent).

Refusals happen before any write and exit 1 with a code (`--json` prints one
`{ok:false,error,code}` document): `invalid_key`, `unknown_project`,
`identity_collision` (the new id is registered, or another board in the
workspace already uses the identifier), `board_archived`, `board_not_found`,
`provider_unreachable`, `registry_unavailable`, `manifest_missing`,
`manifest_invalid`. A step that fails
once writing has started is reported, exits 1 (`step_failed`) and later steps
that depend on it are `blocked`; re-run the same command to resume.

`--json` prints one document: `ok`, `apply`, `noop`, `resumed`, `oldId`, `newId`,
`oldIdentifier`, `newIdentifier`, `provider`, `workspace`, `boardId`,
`registryPath`, `steps` (`{step, status, detail}` with status `planned`, `done`,
`already`, `skipped`, `blocked` or `failed`), `warnings` and `changedFiles`
(plus `error` and `code` when a step failed). The human output lists the same
files under the step table. An `AGENTS.md` that is a symlink to a file outside
the repo is skipped and left untouched.

Things the command can only warn about: notebook state is keyed by the project
hash and restarts fresh under the new id; old ticket refs (`OLD-n`) stop
resolving once the prefix changes; and the repo files it edited must be
committed and pushed.

## Service and ownership

`pjangler-project-registry.service` is a singleton Node service at
`http://localhost:8764`. It owns `pjangler_index.projects` and
`pjangler_index.settings` in PostgreSQL database `33god`. The project table's
primary key is a case-insensitive PostgreSQL `citext` `project_id`, constrained
to canonical lowercase values; it records manifest locations, hashes, derived
fields, refresh times and missing/invalid statuses. Existing `public.projects`
rows and their UUID foreign keys are unchanged.

The source of project fields is always the repository manifest. A service read
refreshes registered files and indexes direct edits. A service write merges only
the fields changed since the caller's baseline, commits the manifest atomically,
then refreshes its index. Concurrent conflicting edits fail without overwriting
the newer file. A failed database update after a manifest commit reports a stale
index; retrying converges. Snapshot saves never delete omitted projects.

Global notebook connection settings are service settings. Project notebook
binding and policy both belong to `.project.json`. The service index is
rebuildable by registering manifests; it is not a second writable definition.

The synchronous adapter launches a bounded Node HTTP client for existing CLI,
MCP and notebook APIs. No disk cache acts as a fallback authority.
`PJ_REGISTRY_URL` overrides the service endpoint. Explicit `--registry` or
`PJ_PROJECT_REGISTRY` file locations are retained for isolated fixtures and
legacy import tooling; normal installations do not use them.

## Installation and migration

```sh
npm run build
npm run registry:install
node scripts/migrate-project-registry.mjs --repo /path/to/additional/repo
node scripts/migrate-project-registry.mjs --repo /path/to/additional/repo --apply
```

The installer writes a user systemd unit and uses the local PostgreSQL Unix
socket with peer authentication. `registry:serve` honors normal PostgreSQL
environment variables for other deployments. No credential values are written
to the unit. It binds `127.0.0.1:${PJ_REGISTRY_PORT:-8764}`; set
`PJ_REGISTRY_HOST` (for example `0.0.0.0`) only on a host whose registry other
machines must reach. Unset or empty means loopback.

The one-way importer discovers existing manifests from the legacy YAML and any
`--repo` arguments. Manifest values win; missing metadata is recovered from the
legacy record. It checks ID collisions before writing, preserves file modes,
and emits a hash/location receipt under `~/.local/state/pjangler`. It never
creates or changes provider boards. A rerun is idempotent. Once consumers have
been migrated, remove the legacy YAML from its active location; it is no longer
read by default.

For a full index rebuild, register each discovered manifest with
`POST /v1/index {"manifest_path":"/absolute/repo/.project.json"}`. Refresh known
locations using `POST /v1/reindex {}`. The migration receipt retains the discovery
locations independently of the database. A relocated repository must retain its
project ID and be re-registered after the old location is unavailable; a live
duplicate location is rejected.

## Repository import

Run from the root of a standalone Git parent:

```sh
pj import ~/code/pilot --dry-run
pj import ~/code/pilot
pj import github.com/owner/repo
pj import git@github.com:owner/repo.git --name repo
```

Import moves a local checkout with a same-filesystem rename, preserving its
history, origin, staging index, tracked edits, untracked files and ignored
payloads. A remote input is cloned into a private preparation directory, then
uses the same enrollment transaction. Ordinary Git URLs and a local bare remote
are supported. There is no automatic commit. Parent `.gitmodules` and the exact
child HEAD gitlink are staged; unrelated parent staging is retained. The child
keeps its standalone `.git` directory, Git's supported unabsorbed submodule
layout. Its manifest's canonical `repo_path` changes in the working tree while
its staged manifest remains intact. A repository without a manifest receives a
minimal `.project.json` with an ID derived from its destination name.

The registry remains the existing manifest-owned service. Import preflight uses
`GET /v1/index`, which reads recorded index state without refreshing or writing
it; `GET /v1/registry` retains its normal refresh behavior. Upgrade/restart the
registry service from the same build before using import. A service without the
inspection endpoint is refused before a local move. `--registry <URL>` selects
an isolated service for tests or an explicitly configured installation.

Dry-run performs no filesystem/index writes, including no remote clone. Remote
content and binding checks are described as conditional until fetch; an actual
remote import inspects the prepared checkout before enrollment. Repeating the
original input after successful enrollment is a no-op when the gitlink, origin,
manifest and index agree. Drift asks for reconciliation instead of hiding it.

A repeat of a LOCAL import is "unchanged" only when the destination can be proved
to be that import. Two things prove it, and a completed receipt wins: the
receipt under `.git/pjangler-imports/` (status `imported`), or the provenance
record `pjangler-import.<name>.source` that the import transaction writes to the
parent's own `.git/config` (written and rolled back with the gitlink and
`.gitmodules`, so it survives losing the private journal). The former source must
also be gone; a checkout that still exists there, or one that was recreated at
that path, is a different checkout and a collision. On top of provenance the
repeat re-verifies the whole enrollment without writing anything: the gitlink is
the checkout's HEAD, `origin` is the `.gitmodules` URL, the registry binds the
project to this manifest (path and bytes), the manifest's `repo_path` is the
canonical destination, and no symlink in the moved tree or in `~/.local/bin`
still points into the former source. A rolled-back or unfinished receipt proves
nothing; an ambiguous record (more than one value) proves nothing.

If the receipt is lost and there is no record either (an enrollment made before
the record existed, or by hand), the repeat stays refused: exit 1, status
`refused`, nothing written. When the enrollment itself verifies healthy, the
result says so and prints the one safe action, a single `git config --local`
command that records the source. Run it, repeat the import, and every check above
runs again before it reports "unchanged". When the enrollment does not verify,
the result prints the drift to reconcile first instead. A surviving
`recovery_required` (or any unfinished) receipt always stays blocked.

The binding planner preserves relative external symlink targets and retargets
direct executable symlinks in `~/.local/bin` that enter the moved checkout. This
covers the Pilot `px`, `pilot` and `px-supervised` symlink pattern.
`--bindings-home <path>` selects an explicit binding home, primarily for isolated
verification. Opaque launcher scripts and user service references are refused
before a local move. Pilot's `defaultSchema`, `default_schema` and
`manifestRegistry` references into the source also require an owning relocation
adapter. Linked/multiple worktrees, nested submodules, cross-device
moves, destination/ID collisions and unfinished `.gitmodules` changes are also
refused.

Employee identity, profiles and service relocation belong to Flume. Import
refuses declared employees, an existing Hermes role tree or affected employee
bindings observed through Flume's public roster, because there is currently no
public identity-preserving relocation transaction (FLUME-41, Backlog). Skillex owns skill activation
and scopeRoot-bound receipts: existing activation receipts or symlinked skills
also block relocation. Copied skill payloads remain intact. Import does not
rehire employees, replace receipts, erase foreign skills or perform the author's
one-time Pilot repair. Full employee/activation relocation remains an explicit
capability gap, requiring the owners' public plan/execute/rollback APIs.

Each such gate fails before any local move, with nothing written, and names the
missing owner contract: `FLUME-41` for employee/profile/runtime/service
bindings, `Skillex relocation contract missing` for project-scope activation
links and the scopeRoot-keyed receipt, and `Pilot/config path-binding contract`
for Pilot config and opaque executable bindings. Consuming those contracts once
the owners deliver them is the open follow-up (PJAN-165 R2).

Failures return a nonzero exit and distinguish `rolled_back` from
`recovery_required`. A receipt under the parent's
`.git/pjangler-imports/<name>.json` records completed phases, preserved checkout
and recovery instructions. Local rollback restores the checkout, manifest,
symlinks and parent index/config/modules; failed remote preparation is retained
for inspection. Concurrent changes are preserved and reported for recovery.
Interrupted receipts block another import. Git may retain harmless unreachable
objects written while staging `.gitmodules`; it retains no accidental commits.
`pj import --json` exposes this plan and recovery state to automation; a
refusal that has a safe next step carries it in `recovery.instructions`.

## Verification

`tests/pjan-165-import-regressions.mjs` and
`tests/pjan-165-import-receipt-recovery.mjs` run the built CLI against disposable
repositories, bare remotes, an isolated HOME and a uniquely named disposable
database behind a real registry service (`tests/helpers/import-harness.mjs`):
dirty/staged/untracked/ignored preservation, remote import from a local bare
remote, binding rebinding, reruns, rollback, every owner-contract gate and the
receipt-loss convergence and refusal cases. GitHub shorthand is parse-checked
with `--dry-run`; no GitHub network call is made.

`tests/pjan-80-registry-regressions.mjs` creates a disposable PostgreSQL database
and a real service. It tests collisions, case variants, direct edits, concurrent
writes, malformed/missing files, settings updates and recovery from an injected
index failure. CLI and consumer suites additionally cover local/offline info,
current-project doctor, notebook and endpoint forwarding.
