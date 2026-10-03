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
public identity-preserving relocation transaction. Skillex owns skill activation
and scopeRoot-bound receipts: existing activation receipts or symlinked skills
also block relocation. Copied skill payloads remain intact. Import does not
rehire employees, replace receipts, erase foreign skills or perform the author's
one-time Pilot repair. Full employee/activation relocation remains an explicit
capability gap, requiring the owners' public plan/execute/rollback APIs.

Failures return a nonzero exit and distinguish `rolled_back` from
`recovery_required`. A receipt under the parent's
`.git/pjangler-imports/<name>.json` records completed phases, preserved checkout
and recovery instructions. Local rollback restores the checkout, manifest,
symlinks and parent index/config/modules; failed remote preparation is retained
for inspection. Concurrent changes are preserved and reported for recovery.
Interrupted receipts block another import. Git may retain harmless unreachable
objects written while staging `.gitmodules`; it retains no accidental commits.
`pj import --json` exposes this plan and recovery state to automation.

## Verification

`tests/pjan-80-registry-regressions.mjs` creates a disposable PostgreSQL database
and a real service. It tests collisions, case variants, direct edits, concurrent
writes, malformed/missing files, settings updates and recovery from an injected
index failure. CLI and consumer suites additionally cover local/offline info,
current-project doctor, notebook and endpoint forwarding.
