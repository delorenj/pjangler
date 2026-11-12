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

## Verification

`tests/pjan-80-registry-regressions.mjs` creates a disposable PostgreSQL database
and a real service. It tests collisions, case variants, direct edits, concurrent
writes, malformed/missing files, settings updates and recovery from an injected
index failure. CLI and consumer suites additionally cover local/offline info,
current-project doctor, notebook and endpoint forwarding.
