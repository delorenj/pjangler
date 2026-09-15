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
| `pj identity --all` | Inspect provider bindings |
| `pj remove px --apply` | Remove the index entry, retaining the repository |
| `pj subsystems` | Available project subsystems |

Legacy `pj project` commands remain hidden compatibility aliases. New scripts
should use the top-level commands. `--slug` remains a hidden input alias for
`--id`; manifests written by PJangler contain only `project_id`. Internal
records and existing event envelopes may retain `slug` as an equal-valued
compatibility field while their callers migrate. There is no independent slug
or provider-prefix lookup.

`pj info` reads the local manifest even if the registry is unavailable. Explicit
global lookups require the service; they never silently use YAML. Registration
does not assert that a provider board was contacted. Provider verification is
the separate `pj identity` operation.

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
MCP, fleet and notebook APIs. No disk cache acts as a fallback authority.
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
to the unit.

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
current-project doctor, fleet, notebook and endpoint forwarding.
