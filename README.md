# pjangler

Project subsystem bootstrapper CLI + MCP server.

## Install

```bash
npm install
npm run build
```

## CLI usage

```bash
npm run build
node dist/index.js --help
# or if installed globally
pjangler --help
```

## Project notebook

`pjangler notebook` manages one companion Open Notebook for a registered
repository. The binding and stable Overview note IDs live in `.project.json`
and the project registry; endpoint, authentication mode, defaults, and finite
capture limits live in the registry's global `notebook` configuration.

```bash
pjangler notebook status . --json
pjangler notebook create . --live --json
pjangler notebook list notes . --json
pjangler notebook search notes "release evidence" . --json
pjangler notebook audit . --json
pjangler notebook migrate . --live --apply --json
```

True `SessionStart` and `SessionEnd` hooks are projected separately from the
project-scoped hook masters. Their per-repository policy stays fail-open and
disabled until explicitly enabled in `.project.json`.

## Fleet contract

`pjangler fleet` inspects the 33GOD fleet authority and managed-state contract
at `contracts/fleet-contract.yaml`. The contract is a declaration, never an
observation: it records who owns which field, which projections flow in which
direction, the lifecycle class every managed thing lands in, the canonical
systemd service model, the activation gate, and the modes that are retired
drift rather than alternate healthy states.

`validate` is strictly read-only — it opens no registry, profile, service, or
process, and writes nothing anywhere.

```bash
pjangler fleet contract validate                          # human report
pjangler fleet contract validate --json                   # fleet JSON v1 envelope
pjangler fleet contract validate --contract ./candidate.yaml --json
```

Exit codes are categorized: `0` valid, `2` malformed contract, `3` contract not
found, `4` a contract that states something forbidden (dual field ownership, an
incomplete lifecycle entry, a retired mode declared healthy), `5` a schema
version this build cannot read, `6` internal.

Two things about the tracked contract that are easy to trip over:

- **It must be its own canonical serialization.** `contracts/fleet-contract.yaml`
  is re-serialized through `yaml` and compared byte-for-byte, so a hand edit
  with different indentation or a trailing blank line fails with exit `2` even
  though the contract is perfectly valid. Re-save it through the round trip
  (`node -e 'const Y=require("yaml"),f="contracts/fleet-contract.yaml",fs=require("fs");fs.writeFileSync(f,String(Y.parseDocument(fs.readFileSync(f,"utf8"))))'`)
  and the diff disappears. A file passed with `--contract` owes nobody canonical
  formatting: there the round trip is reported as `byte_stable`, not enforced.
- **`x-`-prefixed keys are yours.** At any depth they round-trip verbatim, are
  reported separately under `data.extensions`, and are never read as policy — so
  provenance, ticket references and local annotations have somewhere to live.
  They are still scanned for credentials and host paths, because a secret in an
  extension is still a secret in a tracked file.

## Fleet inventory

`pjangler fleet inventory` reads the two canonical registries — the Hermes agent
registry and the PJangler project registry — plus each repository's
`.project.json`, and answers the question neither store answers alone: what is
the whole fleet, and where does it disagree with itself?

```bash
pjangler fleet inventory                                  # human report
pjangler fleet inventory --json                           # fleet JSON v1 envelope
pjangler fleet inventory --agent pjangler-pm --json       # one row, full-fleet totals
pjangler fleet inventory --agent-registry ./copy.yaml     # inspect a copy
pjangler fleet inventory --project-registry ./copy.yaml   # inspect a copy
pjangler fleet inventory --contract ./candidate.yaml      # read a candidate contract
pjangler fleet inventory --deadline-ms 30000              # bound the whole run
```

`--contract` and `--deadline-ms` are shared with `pjangler fleet provenance`, and
mean the same thing on both: the same options, the same defaults, the same
envelope. `SIGINT` and `SIGTERM` cancel either command (exit `8`).

It is strictly read-only. It opens no service, no process, and no network, and
it creates no directory, project, role, profile, or registry row. Every declared
path is classified with `lstat`, so a link is *seen* as a link: a symlinked
profile directory is reported as a symlink with its target as evidence, and the
target is never substituted for the declared value or used to derive one. (One
read does traverse the filesystem's own links: the `.project.json` under an
agent's `project_path` is opened by path. It is confirming evidence only — it can
never become a field's `source` or its value — but a symlinked `project_path`
does redirect which manifest is read. Nothing else is opened: a `project_path`
the classifier calls `relative`, `absent`, `outside-root`, or `not-a-directory`
is reported as `manifest-not-consulted` and no file is read for it, so the
evidence an agent is judged against never depends on the directory you ran the
command from.)

Every emitted value carries `{value, source, state}`, where `source` is the
authority owner `contracts/fleet-contract.yaml` declares for that field path and
`state` is one of `resolved`, `unresolved`, `conflicted`, or `unobserved`. An
unknown is an explicit `null` at `unresolved`, never a guess from a convenient
basename. `.project.json` is read as confirming evidence only: it is never the
`source` of a field and never a tiebreaker when the two registries disagree.

**An unhealthy fleet is data, not a failure.** A fleet with identity conflicts
exits `0` with `ok: true` and `data.health.healthy: false` — the envelope nulls
`data` on `ok: false`, so reporting drift as a failure would blank the inventory
on exactly the runs that matter. Only a *command* failure is nonzero:

| exit | meaning |
| --- | --- |
| `0` | the command ran — read `data.health.healthy` for the verdict |
| `2` | a malformed flag value, or a registry that could not be parsed |
| `3` | a registry that is not there, or an `--agent` id that is not registered |
| `4` | the fleet contract declares a conflicting authority, an invalid class, or a live retired mode |
| `5` | the fleet contract declares a schema version this build does not support |
| `6` | internal |
| `7` | the run did not finish inside `--deadline-ms` |
| `8` | the run was cancelled (`SIGINT`/`SIGTERM`, or an aborted MCP request) |

Exit `4` and `5` come from the contract, not from a registry: the inventory
validates `contracts/fleet-contract.yaml` before it reads anything, and refuses
to attribute provenance against a contract it cannot trust. Run
`pjangler fleet contract validate` for the diagnostic.

Two more things worth knowing:

- **`--agent` scopes the rows, never the totals or the verdict.** `data.rows`
  carries the one agent and `data.scope` says the result is scoped, but
  `data.totals`, `data.health` and `data.conflicts` still describe the whole
  registered fleet. A scoped run therefore reports `healthy: false` for a fleet
  that is unhealthy elsewhere — deliberately, because a slice that could report
  "healthy" while the fleet is broken is the one thing an aggregate must never
  do.
- **`--agent-registry` / `--project-registry` say which bytes to read, not which
  file is canonical.** `data.stores[].configured_path` keeps naming the
  configured store and `inspected_path` names the override.

An identity conflict is grouped under a stable id —
`conflict:{field-path}:{12 hex}` — identical for every participant, on every
machine, run after run. A group can be declared permitted by adding an entry to
`classifications.intentionally_unmanaged.entries` in the contract whose `source`
equals the group's field path and whose `participants` match the group's set
exactly; a superset never absorbs a claimant nobody ruled on.

## Fleet provenance

`pjangler fleet provenance` answers the question the inventory does not: *which
build is each agent actually running?* It pairs every **recorded, pinned, or
declared** value with its **live** counterpart, each side naming its own source.

```bash
pjangler fleet provenance                                  # human report
pjangler fleet provenance --json                           # fleet JSON v1 envelope
pjangler fleet provenance --agent pjangler-pm --json       # one agent, full-fleet totals
pjangler fleet provenance --agent-registry ./copy.yaml     # inspect a copy
pjangler fleet provenance --project-registry ./copy.yaml   # inspect a copy
pjangler fleet provenance --contract ./candidate.yaml      # read a candidate contract
pjangler fleet provenance --deadline-ms 30000              # bound the whole run
```

`--agent`, `--project-registry`, `--agent-registry`, `--contract` and
`--deadline-ms` are also accepted by `pjangler fleet inventory`, and both
commands are exposed as MCP tools with the same options and the same envelope.

**One global rule: `desired` is the recorded side, `observed` is the live side.**
That is what makes the template gitlink structural rather than defensive — the
recorded gitlink is read from `git ls-files --stage` on the *parent*, so no
worktree move can make it report the worktree's SHA. `observed` is the
submodule's own `HEAD`. A reader never has to ask which side is authoritative.

Every fact lands in exactly one of six statuses, and **absence is never a
match**:

| status | meaning |
| --- | --- |
| `match` | both sides are present and equal |
| `mismatch` | both sides are present and differ |
| `dirty` | a cleanliness fact whose observed side is not clean — always its own fact, never a modifier on the value beside it |
| `missing` | a side that should carry a value carries none |
| `unsupported` | no comparable value exists without inventing one: nothing records the desired value, or it is spelled as an unexpanded `$VAR` |
| `unobserved` | the probe did not run, or ran and failed — nothing may be claimed |

Within one fact the precedence is
`unobserved` > `unsupported` > `missing` > `dirty` > `mismatch` > `match`.
`data.totals.by_status` counts all six, and `data.health` reports `healthy`
(drift-free) and `complete` (everything that should have been observed was) as
two separate verdicts — a run that could not reach half the fleet must never
read as a clean bill.

It is strictly read-only, and provably so. Every git probe passes
`--no-optional-locks`, because a plain `git status` refreshes `.git/index` and a
command that rewrites an index on 28 repositories is not read-only. The observed
`hermes` binary is classified by **path** — against the configured release root
first, then the contract's retired `detect` patterns — and is **never executed**.
Nothing fetches, pulls, clones, or reaches the network. `~/.hermes/fleet.env` is
read through a key allowlist, so the Plane API keys beside the fleet paths never
enter memory at all.

Two failure modes are deliberately different. A **per-probe** timeout downgrades
one fact to `unobserved`, records the probe, sets `health.complete: false`, and
the run still succeeds. A **whole-run** deadline is a command failure, because a
truncated provenance report is exactly the kind of partial that must never be
mistaken for a complete one.

**A drifted fleet is data, not a failure.** It exits `0` with `ok: true` and
`data.health.healthy: false`. Only a *command* failure is nonzero:

| exit | meaning |
| --- | --- |
| `0` | the command ran — read `data.health.healthy` and `data.health.complete` for the verdicts |
| `2` | a malformed flag value |
| `3` | a **registry** that is not there, or an `--agent` id that is not registered — a missing template config or fleet env is a finding, not an exit |
| `4` | the fleet contract declares a conflicting authority, an invalid class, or a live retired mode |
| `5` | the fleet contract declares a schema version this build does not support |
| `6` | internal |
| `7` | the whole-run `--deadline-ms` budget expired; no partial result is reported |
| `8` | the run was cancelled (`SIGINT`/`SIGTERM`, or an aborted MCP request); no probe child survives |

`data` is deterministic: no timestamp, duration, hostname, or ordering by
completion. Two runs over unchanged state produce byte-identical `data`, which is
what lets the MCP tool result be compared to the CLI `--json` envelope by
equality rather than by resemblance.

Two provenance questions this host records nothing to answer used to be
reported here as `unsupported`: a deployed role scaffold carries no template
ref, and a generated profile config carries only the `GENERATED FILE -- DO NOT
EDIT` marker. Both are answered by `fleet status` observers now — scaffold
parity compares the role against the template at the committed gitlink (story
1.6), and profile health proves the generated config through the canonical
renderer's own check (story 1.7) — so neither fact is carried by
`fleet provenance` any more.

## Fleet status

`pjangler fleet status` answers the question the inventory and provenance
commands do not: *is the fleet correct?* One read-only traversal of the registry
reports every registered agent across **all nine observation domains**, plus one
aggregate — in a single invocation.

```bash
pjangler fleet status                                   # human report
pjangler fleet status --json                            # fleet JSON v1 envelope
pjangler fleet status --live --json                     # authorize the recipe-owned audit rules
pjangler fleet status --agent pjangler-pm --json        # one agent, full-fleet totals
pjangler fleet status --domain profile --json           # one domain, nothing else collected
pjangler fleet status --agent-registry ./copy.yaml      # inspect a copy
pjangler fleet status --project-registry ./copy.yaml    # inspect a copy
pjangler fleet status --contract ./candidate.yaml       # read a candidate contract
pjangler fleet status --deadline-ms 60000               # bound the whole run
pjangler fleet status --baseline ./base.json --json     # correlate against a prior run
pjangler fleet status --exit-code                       # project the verdict onto the exit status
```

It is exposed as the `pjangler_fleet_status` MCP tool with the same options and
the same envelope, including `baseline` and `exitCode`.

### The nine domains, and what each observes today

| domain | observed today | what `--live` adds |
| --- | --- | --- |
| `registry` | the agent row itself: well-formedness, identity conflicts, correlation to a project record | `hermes.registry-parity` (**host-scoped** → `data.host`, unfiltered runs only†) |
| `project_binding` | the row's board binding and whether the repository's `.project.json` agrees | the notebook and `sot.project-json` rules |
| `template_scaffold` | the tracked template's gitlink, remote and cleanliness (fleet-wide), and **every managed role directory compared asset by asset against the template at the committed gitlink** — eight group observations per agent, typed per-asset `items`, `data.scaffold` and `agents[].scaffold` summaries (see *Scaffold parity* below) | every tracked-asset parity rule, plus a `scaffold-rule-disagreement` finding where `hermes.pm-scaffold` and the observer disagree |
| `profile` | the profile directory `lstat`ed by the inventory (a symlink is a `fail`, because the contract declares `symlink_allowed: false`), and **five observations per agent from the profile observer**: the path gated (real, contained, safely named, unambiguous), the identity file, the generated config proven by the canonical renderer's own `check` at the committed gitlink, the Hindsight bank pin, and the skill core by bytes — plus `data.profile`, `agents[].profile`, and in fleet scope one host sweep classifying every unregistered root entry (see *Profile health* below). A gated profile's `domains.profile` rolls up to `unobserved` (its four unread dependents outrank the path `fail` under the declared precedence) while the `fail` stays on `profiles.{profile_name}`, in `health.failed`, and demotes the lifecycle (DW-95) | `hermes.runtime-singleton`, plus a `profile-rule-disagreement` finding where it and the observer disagree; `hermes.profile-wiring` (**host-scoped**) |
| `runtime` | the role-local runtime directory derived from `role_dir` | `hermes.untracked-runtimes` |
| `systemd` | **five observations per agent from the systemd observer**, sampled off the user manager itself over a declared stabilization window: the canonical unit topology against the row, the row's `heartbeat_timer` field, the messaging gateway proven against the capability the registry *declares*, the heartbeat timer, and the heartbeat oneshot's latest tick — plus `data.systemd`, `agents[].systemd`, one host finding for the manager (every scope) and, in fleet scope, one for the fleet-shared Bloodbank gateway and one classifying every unregistered `hermes-*` unit (see *systemd topology and service health* below) | `systemd.sentinel` and `hermes.registry-parity` (**host-scoped**, unfiltered runs only†), never promoted to an agent, plus a `systemd-rule-disagreement` finding where either and the observer disagree |
| `live_process` | `unsupported` — there is no `ps`, `pgrep`, or `/proc` read anywhere in this build | nothing |
| `bloodbank` | the stored routing record and the strict activation flag; liveness is `unsupported` | `hermes.fleet-config` (**host-scoped**, unfiltered runs only†) |
| `release_provenance` | every provenance fact for the agent: executable, checkout, remote, HEAD, cleanliness | nothing |

† `registry`, `systemd` and `bloodbank` are each observed live by host-scoped
rules only — they can add nothing to any agent's record, only to `data.host`.
Filters constrain collection, so `--domain systemd --live` spawns no audit child
at all and neither rule runs; the run says so with an
`audit-host-rules-not-collected` finding naming the rules it did not collect,
and `data.systemd.rule_agreement` reads `not_compared`. Run without `--domain`
to get them. The systemd OBSERVER is not gated on `--live` and is not an audit
child: sampling the user manager is a bounded read-only local read that every
scope performs, so a `--domain systemd` run still carries this observer's own
three host findings.

A `--domain` run whose selected domain *is* audit-fed does spawn children, and
those children report every rule — including host-scoped rules for domains you
did not select. Those results are not carried in `data.host` (only the selected
domain is emitted), and the run says so too, with one
`audit-host-rules-not-reported` finding per rule. **An empty `data.host` never
means "this machine is clean"** on a filtered run; the findings say which reading
you are not being shown. For the same reason a host finding's `retrieval` is the
unfiltered `--live` invocation whenever its domain is one of the three above —
the narrowed command could not return it.

Story 1.9 owns the live-process observer and 1.10 Bloodbank routing readiness.
Until then those domains say so, by name, rather than disappearing.

### Scaffold parity

`template_scaffold` compares every managed role directory against the tracked
template **at the gitlink this repository has committed** for
`templates/hermes-agent` — git objects, never the submodule worktree, never a
sibling clone, never a branch tip. The contract's `scaffold_manifest` block
(schema 3) is the policy that says how to read that tree: which subdirectory
holds the rendered files, how a rendered file is named, which registry fields
feed each simple `{{ name }}` placeholder (`render_inputs`), which `scaffold.*`
writable leaf owns each role-relative path (`groups`), which assets are
compared for presence only and why (`presence_only`: `role.yaml`, `SOUL.md`),
what may never appear in a template tree (`excluded_patterns`), and which
role-local directory is ignored runtime nobody owns (`runtime_dir`).

Each agent gets **eight observations, one per declared leaf** — `scaffold.role.yaml`,
`scaffold.SOUL.md`, `scaffold.hermes`, `scaffold.momo`, `scaffold.sentinel.prompt.md`,
`scaffold.gitignore`, `scaffold.scripts`, `scaffold.runtime-scaffold` — each
`pass`, `fail` or `error`, with `observed: "<matching>/<owned> assets match"`
and, on anything but a clean pass, a typed `items[]` list (capped at 100 per
observation, the clip recorded in `truncated`). Every item carries a
**role-relative path**, a kind, and a `desired`/`observed` pair that is a 12-hex
git blob-id prefix or a type/mode word — never a file body, never an absolute
path:

| kind | meaning |
| --- | --- |
| `missing` | the template renders it; the role does not have it |
| `stale-content` | different bytes, and the observed blob exists in the template's lineage — an older release |
| `locally-modified` | different bytes, and no template version ever shipped them — somebody edited it |
| `wrong-mode` | same bytes, executable bit differs |
| `wrong-type` | a directory or symlink where a file was rendered, or the reverse |
| `unsafe-symlink` | a symlink whose target is absolute or leaves the repository |
| `unexpected-owned` | a tracked file inside an owned group the template did not render (a committed `.done-*`, an unrendered `.jinja`) — named, never proposed for deletion |
| `incomplete` | this build could not decide: a render input is missing (`input-missing: display_name`), the template needs control flow (`render-unsupported`), or the bytes were unreadable |

`stale-content` versus `locally-modified` is **lineage, not commit state**: a
verbatim asset is stale when its observed blob exists in the template's object
database, a rendered asset when it equals the render of one of the last twelve
versions of its Jinja source. An uncommitted edit is the orthogonal `wip: true`
flag on the item, and a drifted path that also carries one appears in
`agents[].scaffold.wip_overlap`. Ignored runtime bytes, git-ignored entries and
tracked files outside every owned group are **counted, never named**
(`ignored_entries`, `wip_preserved`, `foreign_tracked`).

**Source integrity is a host finding.** `scaffold.source` in `data.host` reads
`pass` when the committed gitlink is stable (`ls-tree HEAD` and the index
agree), its object exists, the submodule worktree is at it with no modified
tracked file, the tree carries no excluded pattern, and every rendered path
resolves to one declared group. Any other reading — `gitlink-missing`,
`gitlink-unstable`, `source-uninitialized`, `source-missing-object`,
`source-mismatched`, `source-dirty`, `source-contaminated`, `source-empty`,
`manifest-uncovered:<path>` — is `error`, every selected agent's eight groups
are `error`, and **desired bytes are never taken from the worktree as a
fallback**. The same code is carried in `data.scaffold.source.integrity`.

`data.scaffold.agents` counts every selected agent before any cap
(`total_registered`, `selected`, `applicable`, `passing`, `drifted`,
`incomplete`, `exception_authorized`, `unobserved`), and
`data.scaffold.rule_agreement` says, under `--live`, how the observer and the
`hermes.pm-scaffold` rule agreed over the subset both compare — a disagreement
is a `scaffold-rule-disagreement` finding and both readings stand. An operator
ruling on one agent's scaffold drift lives in
`health_policy.agent_exceptions[]` (`domain`, `agent_id`, `reason`, `owner`):
the drifted groups keep their `fail`, carry `justification.kind: "exception"`
with that entry's own path, and the agent is counted `exception` rather than
`unhealthy` — `health.healthy` is unaffected, exactly as for a permitted
identity conflict. A contract with no `scaffold_manifest` still loads; the
domain then reads `unsupported` under capability `scaffold.manifest`.

`--domain template_scaffold` is the surface. A run scoped to any other domain
spawns zero scaffold probes; `--agent <id>` reads only that agent's role
directory while `data.scaffold.agents` keeps the fleet-wide totals. The role
directory is the registry row's `role_dir`, defaulting to
`<project_path>/agents/hermes/<role>` only when the row is silent
(`agents[].scaffold.role_dir_source`), and must sit inside `project_path`.

### Profile health

`profile` proves every registered agent's generated profile, not merely that
its directory exists. The contract's `profile_manifest` block (schema 4) is the
policy: which renderer decides "generated config == deep_merge(base, delta)"
and where its bytes are pinned (`renderer`), which keys an identity file may
carry and which it may carry inertly (`identity`), how the Hindsight bank pin
is spelled and which ids are never an identity (`memory`), which six skills are
the immutable core and where the canonical copies live (`skill_core`), which
root entries are the observer's own footprint or a backup (`extras`), and how
much may be read (`limits`).

Each agent gets **five observations, one per declared `profiles.{profile_name}`
leaf**, in this order:

| field | proves | fails when |
| --- | --- | --- |
| `profiles.{profile_name}` | the path **gate**: a real directory under the root, safely named, named by exactly one registry row, with no case-insensitive twin over a complete root listing, whose singleton links point into this agent's own runtime (`role_dir`, else `<project_path>/agents/hermes/<role>`) | `unnamed`, `symlink`, `missing`, `not-a-directory`, `name-unsafe`, `case-collision:<other>` (or `case-collision:unverified` over a capped listing), `ambiguous:duplicate-profile-name`, `misowned-link:<entry>` (a singleton link pointing outside this agent's runtime) or `not-a-link:<entry>` (a real file or directory where the template provisions a link — the stock `SOUL.md` Hermes seeds into a fresh profile directory); `unverifiable:<entry>` is a `warn` when the row records neither a role directory nor a project path, or the link could not be read; `unreadable` is the one gate that is an `error` |
| `profiles.{profile_name}.profile.yaml` | an identity-only file — the declared identity keys and nothing Hermes reads as config; when it declares `name`, this profile's; when it declares `display_name`, the registry's. Written by Hermes' own profile tooling (`hermes_cli/profiles.py`, `write_profile_meta`), never by the renderer or the template | `missing`, `symlink`, `malformed`, `identity-mismatch:name` / `identity-mismatch:display_name`; `unknown-key:<k>` is a `warn`; a `config:` block is recorded as `inert-config-block` and passes, because Hermes reads it nowhere; an empty file is `malformed` (`empty`); `too-large` and `unreadable` (over `limits.max_file_bytes`, or a read that could not complete) are `error` |
| `profiles.{profile_name}.config.yaml` | `config.yaml == deep_merge(<fleet home>/config.yaml, config.delta.yaml)`, proven by running the **canonical renderer's own `check`**, from an override-only delta | `generated-symlink`, `generated-missing`, `marker-missing`, `delta-missing`, `delta-symlink`, `delta-not-override-only` (the delta carries the generated marker or equals the base or generated mapping), `semantic-drift` naming each drifted top-level section (or `unparsed` when the report names none); `base-missing`, `renderer-unavailable`, `renderer-failed`, `renderer-timeout`, `too-large` and `unreadable` are `error` |
| `profiles.{profile_name}.hindsight/config.json` | the bank pin is exactly `agent-<profile_name>`. Written by the template's provisioning step 10 (`10-hermes-profile.sh`), which never touches `profile.yaml` | `pin-missing`, `pin-symlink`, `pin-malformed`, `bank-missing` (a generic `bank_id_template` never satisfies it), `bank-custom`, `bank-alias` (case or `_`/`-` variant, a `fail`), `bank-mismatch`; `too-large` and `unreadable` are `error` |
| `profiles.{profile_name}.skills` | every core skill resolves **by bytes** — through the profile's `skills` entry (a real directory, or a symlink into the fleet home or the canonical projection) or the generated config's `skills.external_dirs` — to a `SKILL.md` inside an allowed root that equals the canonical copy. The skill links are step 10's too | `core-missing:<n>` (absent, or a directory with no `SKILL.md`), `core-replaced:<n>`, `core-dangling:<n>`, `core-foreign:<n>`, `canonical-missing:<n>` (the canonical projection itself lacks it); optional skills beside the core are listed as `extra-skill`, capped at `limits.max_extra_skills` while `extras_seen` counts them all |

**Gate first, then look.** A profile that fails the gate is a `fail` on the
first field and the other four are `unobserved` naming the gate code — not
`error` (nothing failed to collect) and not `skip` (nothing authorizes
skipping) — and nothing beneath the directory is read, because anything read
through a symlinked or ambiguous profile may belong to another agent. The one
exception is a directory the observer could not `lstat` at all: that gate is
an `error`, and its dependents say the directory could not be collected. The
root itself is gated one level up (`profile.root` in `data.host`): every
component of the fleet home and of the root beneath the home directory (or
beneath the fleet home's parent, when the fleet home lives elsewhere) is
`lstat`ed and none may be a symlink. Its codes are `layout-undeclared`,
`renderer-layout-mismatch` (the contract's root is not the directory the
renderer reads), `root-missing`, `root-not-a-directory`, `root-symlink`,
`root-ancestor-symlink` and `root-unreadable` (a component could not be
`lstat`ed, or the root could not be enumerated — in every scope, `--agent`
included, because no profile can be proven unambiguous over a listing that
never arrived). Any root error makes every selected agent's five fields
`error` naming `root:<code>`, and spawns no renderer.

**The renderer runs at canonical bytes or not at all.** `profile.renderer` in
`data.host` reads `pass` only when the submodule worktree's copies of
`scripts/hermes-profile-config.py` and its lock helper have the same blob ids
as the tree at the **committed gitlink**, and a `python3` with PyYAML at 3.11
or newer answers. Any other reading is `error`, every selected agent's
`config.yaml` field is `error` with a `renderer-unavailable` item naming the
code, and **no renderer child is spawned**. The source codes are
`renderer-gitlink-missing` (the parent's HEAD records no gitlink),
`renderer-gitlink-unstable` (the index gitlink differs from HEAD's),
`renderer-source-missing` (the submodule is not a repository root of its own,
or the pinned tree or the worktree lacks a file), `renderer-source-mismatched`
(a worktree copy's bytes differ from the gitlink's) and
`renderer-source-unobserved` (no verdict: a git probe failed, timed out or was
cancelled, the package root is not a git checkout root of its own, or a
worktree copy could not be read under `limits.max_file_bytes` — the renderer can
only be proven inside a git checkout of pjangler, never from an extracted
package). The interpreter codes are
`renderer-python-unavailable` (no `python3` answered, or it exited with a
status the probe does not own), `renderer-python-too-old` and
`renderer-pyyaml-missing`; the probe script exits 3 and 4 for the last two
itself, so no other exit is ever read as one of them. Both the probe and the
check run under an allowlisted environment — `PATH`, `HOME`, `LANG`,
`HERMES_FLEET_HOME`, the lock timeout and the three `PYTHON*` settings, nothing
else — so a PyYAML reachable only through `PYTHONPATH`, `VIRTUAL_ENV` or
`PYTHONHOME` reads `renderer-pyyaml-missing`; it must be importable by the
`python3` that `PATH` resolves. The renderer's `check` takes the profile's own
persistent zero-byte lock (`profiles/.<name>.config.lock`, `flock`, created on
first use) so a concurrent render cannot hand it a half-written file; that is
its read semantics, not a mutation, and the observer bounds the wait so a held
lock becomes a `renderer-timeout` on that one profile. Lock entries are skipped
by the root sweep and never counted, so the observer's own footprint never
changes its output.

**Extras are findings, never a licence.** In fleet scope the profile root is
enumerated once (the renderer's lock entries, `renderer.lock_pattern` and
`extras.ignored_patterns`, are the observer's own footprint and are skipped)
and every unregistered entry lands in exactly one class on the
`profile.extras` host finding: `approved-managed-exception` (a
`managed_shared_service` entry with `profile` in its policy domains claims it —
the fleet Bloodbank gateway's profile), `intentionally-unmanaged` (an
`intentionally_unmanaged` entry with `source: profiles.<name>` and `profile` in
its policy domains), `retired-candidate` (a `retired` entry that claims it the
same way, a backup shape, an alias of a registered name by case or `_`/`-`, or
a directory whose `config.yaml` is a symlink), `debris-candidate` (a stray
file, an empty directory, a dangling link), or `unclassified` (everything
else, including an entry that vanished or could not be read after the listing,
which is never called debris). Each item carries bounded evidence — kind, a
shown link target, whether a directory is a `complete` standalone profile,
`alias_of`, how many user unit files name it as `HERMES_HOME`,
`process_reference: "unobserved"` until story 1.9 — and a `guidance` of
`adoption`, `exception`, `retirement` or `manual-review`. **Exactly two rulings
make an entry `pass`**: a `managed_shared_service` claim or an
`intentionally_unmanaged` claim. A declared `retired` sighting is still a
`warn` — the contract has recorded that the entry should go, and the finding
stays until it has gone. Every other class is `warn`, unjustified by design, so
the fleet stays `unproven` until the operator classifies the entry; an
`allowed_warnings` entry with `rule_id: profile.extras` blankets every extra
at once and is the blunt instrument, not the ruling. `--agent <id>` inspects
one registered profile and never sweeps: `data.profile.extras.coverage` then
reads `not-swept` and no `profile.extras` finding exists. A second host
finding, `profile.skill-core`, names the core skills the canonical projection
itself lacks (`fail`, with the directory and how it was chosen: the
`CANONICAL_SKILLS_DIR` override, the template config's
`[fleet] canonical_skills_dir`, or the manifest's `{HOME}` placeholder, in that
order), so twenty-six identical per-agent `canonical-missing` items have one
named cause.

Nothing emitted is a file body, a config value, a delta value, a memory, a
timestamp or an absolute path: digests are 12-hex sha256 prefixes, sections and
keys are names, and a bank id is an identifier. `data.profile` counts every
selected agent before any cap (`real`, `blocked_at_path`,
`structurally_healthy`, `drifted`, `incomplete`, `exception_authorized`,
`unobserved`) beside the renderer, bank (`bank_ok`, `bank_alias`,
`bank_custom`, `bank_missing`, `bank_mismatch`, `bank_invalid` — one bucket per
real profile) and skill tallies; under `--live`,
`data.profile.rule_agreement` says how the observer and `hermes.runtime-singleton`
agreed over the state both read (the directory itself — a symlinked or missing
profile is compared even though its dependents are unread — the singleton
links' targets, the two config files, and the pin), and a disagreement is a
gating `profile-rule-disagreement` finding with both readings kept. Drift only
one side reads (semantic drift, a non-override-only delta, the identity file,
the skill core) is `not_compared`. An operator ruling on one agent lives in
`health_policy.agent_exceptions[]` with `domain: profile`, exactly as for a
scaffold. A contract with no `profile_manifest` still loads; the domain then
reads `unsupported` under capability `profile.manifest`.

### systemd topology and service health

`systemd` proves every registered agent's SERVICE state against the user
manager, not merely that the contract can derive its unit names. The contract's
`service_manifest` block (schema 5) is the policy: how many samples make an
observation window and how far apart (`stabilization`), how a `systemctl --user`
child is bounded and which environment keys it may inherit (`probe`), which
`ExecStart` counts as pinned and which environment key names the profile home
(`entrypoint`), how a registry row *declares* its messaging capability
(`messaging`), what the heartbeat schedule and its reconcile evidence are
(`heartbeat`), which unit names are retired shapes (`unregistered`), and how
much may be read (`limits`).

Each agent gets **five observations, one per declared leaf** — two registry
fields and three units, all five declared writable under the contract's
`systemd_lifecycle` authority, so every finding resolves an owner:

| field | proves | fails when |
| --- | --- | --- |
| `agents.{agent_id}.systemd.gateway_unit` | the canonical triple `service_model.per_agent` derives is loaded, the row names it, and nothing retired sits beside it | `gateway-missing`, `heartbeat-timer-missing`, `heartbeat-service-missing`, `misnamed-gateway:<unit>`, `duplicate-gateway:<unit>`, `retired-unit:<unit>`, `registry-retired-key:<key>` |
| `agents.{agent_id}.systemd.heartbeat_timer` | the row records the timer the contract derives, and the manager loads it | `registry-undeclared` (units on disk, no field), `unit-missing`, `misnamed-heartbeat-timer:<unit>` |
| `units.hermes-{agent_id}-gateway.service` | the gateway is in the state its row's *declaration* requires, stable across the whole window, entered from a pinned entrypoint at this agent's own profile home | `deferred-but-enabled`, `deferred-but-active`, `platform-enablement-inherited:<platform>`, `verified-channel-gateway-disabled`, `verified-channel-gateway-inactive`, `channel-undeclared` (`warn` when disabled+inactive), `channel-identity-incomplete:<platform>`, `channel-secret-unreferenced:<platform>`, `unstable`, `crash-looping`, `result-not-success:<result>`/`exec-status:<n>`, `entrypoint-unpinned`, `home-mismatch`/`home-absent`/`home-unsafe`, `fragment-unsafe`, `unit-file-state-unclassified:<state>` (`warn`), `load-error:<state>`, `property-malformed:<Key>` (`error`), `absent` |
| `units.hermes-{agent_id}-heartbeat.timer` | the timer is enabled, active, waiting, paired with its own service, on the declared schedule, its last tick is current, and a tick in flight is progressing | `timer-disabled`, `timer-inactive`, `timer-substate`, `timer-unpaired`, `schedule-off-policy`, `schedule-unknown` (`warn`), `tick-overdue`, `tick-never`, `tick-unknown` (`warn`), `stuck`, `in-progress` (`warn`), `fragment-unsafe`, `load-error:<state>`, `property-malformed:<Key>` (`error`), `absent` |
| `units.hermes-{agent_id}-heartbeat.service` | the oneshot's latest COMPLETED invocation actually succeeded, from a pinned entrypoint, with a declared reconcile policy | `type-not-oneshot`, `latest-result-failed:<result>`, `latest-result-unknown` (`warn`), `never-completed`, `entrypoint-unpinned`, `checkpoint-only`, `reconcile-undeclared` (`warn`), `reconcile-opt-out-undeclared` (`warn`), `reconcile-unverifiable` (`warn`), `policy-unreadable`/`state-unreadable` (`error`), `fragment-unsafe`, `load-error:<state>`, `property-malformed:<Key>` (`error`), `absent` |

**The desired gateway state comes from the DECLARATION, never from the unit.**
`70-systemd.sh` enables a gateway only when a platform's `provisioning_status`
is `verified` and disables it otherwise, so the observer reads that declaration
back off the registry and reports `capability.declared` as `active` (some
platform verified), `deferred` (every declared platform in
`deferred_statuses`), or `undeclared` (no platform declares a status this build
reads). That makes "deferred but enabled" and "verified but disabled" visible as
drift instead of two alternate healthy modes, and makes an active gateway on an
undeclared row the liveness theatre it is. A deferred platform must also end up
DISABLED once the renderer has merged the delta over the fleet base: the
observer reads both halves — the delta's `platforms.<platform>.enabled` pin when
it has one, `HERMES_HOME/config.yaml`'s value when it does not — and reports
`platform-enablement-inherited:<platform>` only where that resolves to `true`.
A deferred platform nothing enables anywhere needs no pin and raises nothing. A verified platform must carry its
`identity_fields` on the row and its `secret_env` keys as `op://` references in
the delta; the observer reads the PRESENCE of those keys and never a value.

**The window is the template's own stability rule.**
`_lib.sh:systemd_wait_for_stable_health` rejects any window in which a unit
looked healthy and then changed, and `systemd_timer_health_snapshot` refuses a
oneshot that has not completed (systemd pre-initialises `Result=success` before
the first exit). Both are encoded here: a sample set that is not unanimous is
`unstable`, a growing `NRestarts` is `crash-looping`, an `activating` gateway is
never proven, and `gateway.stability.transitions` reports the transition
(`active/running -> activating/auto-restart`, `restarts 3 -> 5`) rather than the
most favourable sample.

**The timer leaf owns whether the tick is HAPPENING; the oneshot's owns whether
the last one SUCCEEDED.** `tick-overdue`, `tick-never`, `schedule-off-policy` and
a oneshot that is mid-tick (`in-progress`, a warn) or wedged past its own
`TimeoutStartUSec` (`stuck`, a fail) are all readings about whether the heartbeat
is firing, so they land on `units.hermes-{agent_id}-heartbeat.timer`.
`latest-result-failed:<result>`, `never-completed` and the reconcile evidence are
readings about the last completed run, so they land on the oneshot's own leaf.
The `heartbeat.latest_result` bucket reports `in-progress`/`stuck` either way.

**A property the manager did not report is not a default.** Every sample is
validated against the four properties every reading is built on — `LoadState`,
`UnitFileState`, `ActiveState`, `SubState`, which systemd prints for every unit
type and even for a unit that does not exist. A sample that carries the unit and
omits one errors THAT unit's leaf with `property-malformed:<Key>` rather than
coercing it to `""` and reporting a verdict about a property nobody read; an
absent unit carries all four (with an empty `UnitFileState`) and still reads
`absent`.

**Every time-derived fact is a BUCKET.** No timestamp, age, pid, duration or
completion order reaches `data`. `LastTriggerUSecMonotonic` and the oneshot's
`ExecMain*Monotonic` are compared against `process.hrtime.bigint()` — CLOCK_MONOTONIC,
the same clock systemd uses — and reduced to `tick: current | overdue | never | unknown`
and `latest_result: success | failed | in-progress | stuck | never | unknown`.
Two runs over unchanged manager state produce byte-identical `data`.

**Read-only, and structurally so.** The only `systemctl --user` verbs this build
can spawn are `is-system-running`, `list-units`, `list-unit-files` and `show`;
there is no code path to `enable`, `start`, `daemon-reload` or `reset-failed`
and nothing is ever written under `$XDG_CONFIG_HOME/systemd/user`. Each child
receives an **allowlisted** environment — `service_manifest.probe.env_allowlist`
(`PATH`, `HOME`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`) plus `LC_ALL=C`,
`SYSTEMD_PAGER=`, `SYSTEMD_COLORS=0`, `SYSTEMD_URLIFY=0` — never a copy of this
process's, so a Plane key in the parent's environment cannot reach one. The
child count is bounded and independent of fleet size: one manager probe, two
listings (fleet scope only), `stabilization.samples` multi-unit `show` calls
covering every unit of interest at once, and one classification `show` only when
there is an unregistered unit to classify. A failed manager probe skips sampling
entirely and every selected agent's five leaves read `error` with
`manager-unavailable` or `manager-timeout`; `degraded` is an **available**
manager, because a failed unit elsewhere does not make the fleet unobservable.

**What `--agent` scope cannot see.** An `--agent` run samples that agent's own
units and never lists the manager, so two topology readings are structurally
out of reach: `duplicate-gateway:<unit>` (a second `hermes-<id>-*gateway.service`
is found by the listing, not by the sample) and the units-on-disk half of
`registry-undeclared` for a row that declares no `heartbeat_timer` while its
unit file exists but is not loaded. Both are reported by a fleet-scope run over
the same manager. This is a coverage difference, not a clean reading, and it
sits beside the two the payload names outright (`shared.coverage: "unobserved"`,
`unregistered.coverage: "not-swept"`).

`data.systemd` carries the manager and its window, the unit counts, per-aspect
agent tallies (`complete`, `topology_ok`, `gateway_healthy`, `gateway_deferred`,
`heartbeat_healthy`, `unstable`, `crash_looping`, `drifted`, `incomplete`,
`exception_authorized`, `unobserved`), the capability split, the fleet-shared
gateway and the unregistered sweep. Two coverage labels say what a scope did
NOT do: an `--agent` run samples one agent's units, lists nothing, and reports
`shared.coverage: "unobserved"` and `unregistered.coverage: "not-swept"` rather
than an empty sweep. The shared gateway is `pass` only when the contract's
`service_model.fleet_shared.bloodbank_gateway_unit` and the registry's
`gateways.bloodbank.systemd_unit` name ONE unit and it is enabled, active,
stable and rooted at the declared shared profile; two names is
`identity-mismatch`.

A listing the manager ANSWERED and this run could not read
(`listing-failed`, `listing-timeout`, `listing-malformed`) is its own
`systemd.unregistered` finding at `error`, naming the reason: the manager
finding still reads `pass` because the manager itself answered, and a sweep
nobody performed must never look like a clean one. A listing that hit
`limits.max_units` is reported as a `truncated[]` note for the same reason.

**Unregistered units are findings, never a licence.** Every `hermes-*` unit no
registered row claims lands in exactly one of five classes — `retired` (a name
the contract's `retired[].detect` matches), `transient` (a `systemd-run` scope,
whose `Description` may name a registered profile through an exact
`--profile <name>` token, recorded as `correlated_profile`), `profile-correlated`
(its own `HERMES_HOME` names a directory under the profile root),
`managed-exception` (a `managed_shared_service` or `intentionally_unmanaged`
entry with `systemd` in its `policy_domains` claims it), or `unclassified`. Only
`managed-exception` is `pass`; the rest are `warn`, unjustified by design until
an operator classifies the unit in the contract, and every item carries
`process_reference: "unobserved"` because attributing the process behind a unit
is story 1.9. Nothing is ever assigned to the nearest agent name.

Under `--live`, `data.systemd.rule_agreement` says how the observer and the
`systemd.sentinel` / `hermes.registry-parity` rules agreed over the subset all
three read — unit presence, enablement, activity, retired units and retired
registry keys — and a disagreement is a gating `systemd-rule-disagreement`
finding with both readings kept. Drift only the observer reads (an unstable
window, a crash loop, an undeclared channel, an off-policy schedule, an overdue
or failed tick, an unpinned entrypoint) is `not_compared`. An operator ruling on
one agent lives in `health_policy.agent_exceptions[]` with `domain: systemd`,
exactly as for a scaffold or a profile, and covers `fail` only — never a
collection error. A contract with no `service_manifest` still loads; the domain
then reads `unsupported` under capability `systemd.manifest`.

### Seven states, one precedence

| state | meaning |
| --- | --- |
| `pass` | observed, and in the state it should be in |
| `warn` | observed, imperfect, and not a gate |
| `skip` | declared not applicable; does **not** reduce completeness |
| `fail` | observed, and wrong |
| `unsupported` | no adapter exists in this release; counted and visible, but it does **not** reduce completeness |
| `unobserved` | applicable, and not read; **does** reduce completeness |
| `error` | collection itself failed; never silently a `pass`, never a dropped agent |

Within a domain and then across domains the precedence is

1. `unsupported` **yields** whenever the domain produced any other state. It is a
   statement about this build, not about the fleet, so it is the strongest answer
   for a domain with nothing else (`live_process`) and the weakest thing to report
   for a domain that also has real findings — without this, a
   `template_scaffold` domain carrying one permanent "no template ref is
   recorded" reported `unsupported` while 135 tracked assets were failing.
2. Then, over whatever is left:
   `error` > `unobserved` > `unsupported` > `fail` > `warn` > `skip` > `pass`.

Both halves are the rule; the ordered list alone is not. `rollUp` in
`src/fleet/status.ts` applies them in that order.

### What `--live` does and does not authorize

`--live` authorizes **bounded, read-only host and network observation**, and
nothing else: it runs the recipe-owned audit rules per repository as bounded
child processes, because one of them (`bmad.version`) makes a real `npm view`
call. It never authorizes mutation, process control, service changes, board
changes, or Bloodbank activation, and it does not conjure a systemd,
live-process, or Bloodbank-liveness observer.

Each repository is audited as a child of this build with a **narrow, allowlisted
environment**, so no credential in your shell or in `~/.hermes/fleet.env` ever
reaches it. Each child is time-boxed: one hung `systemctl` downgrades that
repository's audit-fed domains to `unobserved` and leaves every other agent
fully reported.

Filters constrain **collection**, not just emission: `--domain registry` spawns
no audit child and no provenance probe, and `--agent <id>` spawns neither for any
other agent. It holds per probe FAMILY too — `--domain template_scaffold` runs
the gitlink and submodule probes and no checkout probe, and
`--domain release_provenance` the reverse — so a filtered run never pays for
facts it would discard.

### Four axes, because one word cannot carry four questions

Every observation carries four *separate* axes, and collapsing any two of them is
how "we did not look" becomes "it is fine".

| axis | values | what it answers |
| --- | --- | --- |
| `state` | `pass` `warn` `skip` `fail` `unsupported` `unobserved` `error` | what was concluded |
| `applicability` | `required` `optional` `not_applicable` `deferred` `exception` | whether it was required, and if not, on whose authority |
| `evidence` | `direct` `declared` `derived` `absent` | how strongly it is supported |
| `freshness` | `current` `stale` `unknown` `not_applicable` | whether the evidence is still current |

`evidence: "declared"` is the load-bearing one. A registry field that *asserts*
something with nothing verifying it — a stored routing target, an activation
flag, a recorded unit name — is `declared`, never `direct`. A `declared`
observation may be `pass` on its own record, but it can never set
`lifecycle.capability_readiness: "ready"` and never contributes to `proven`.
`derived` is a reading computed across other rows, such as an identity conflict.

**Freshness is a bucket, never an age.** `data` is byte-identical across two runs
over unchanged state, and an age in seconds is not. The reference instant is
captured once per run and never serialized; each `health_policy.freshness` entry
declares a `max_age_days`, and only the bucket is emitted.

### `health_policy`: the only thing that can authorize a gap

`contracts/fleet-contract.yaml` carries an optional `health_policy` root block.
It is the **only** place a skip, a warning, a deferred capability, or a managed
exception can be justified — nothing is inferred from a summary, a severity, or
the absence of other findings.

| key | authorizes |
| --- | --- |
| `required_domains` | which domains must be observed before proof can be claimed |
| `deferred_capabilities[]` | one `unsupported` answer, with a `reason` and the `owner_story` that will implement the observer |
| `allowed_warnings[]` | one rule whose `warn` is upstream cadence rather than fleet drift |
| `allowed_skips[]` | one rule or domain whose `skip` is a declared property of a read-only run |
| `freshness[]` | how long one recorded timestamp counts as current evidence |

An authorized gap is still **reported**, with its own state; what changes is
whether the aggregate may claim it was proven. Every justified observation names
the entry that authorized it in `justification.policy`, so an operator can open
the contract at that path.

`health.unjustified` counts the three states the contract can actually
authorize — `warn`, `skip` and `unsupported` — and no others. A `fail` or an
`error` is not something a policy entry may excuse; those are what
`health.healthy` is for, and an `unobserved` is a coverage question `complete`
already answers. Since story 1.7 the count covers **host findings too**: a host
rule's `warn` or `skip` with no `allowed_warnings`/`allowed_skips` entry (an
unclassified profile-root extra, a host-scoped audit rule that warns) blocks
`proven` exactly as an agent's does, while still never touching `healthy` or
`complete` — a machine condition is not a fleet failure, but a gap nobody has
authorized is not proof either. A contract with **no** `health_policy` block still loads — it
is a schema-1 contract — and then authorizes nothing: every `warn`, `skip` and
`unsupported` is unjustified, `proven` is false, and one
`health-policy-undeclared` finding names the missing block rather than the run
failing.

Adding the block was a grammar change, so the tracked contract is
`schema_version: 2` at `contract_version: 1.1.0`. This build reads schema 1 and 2.

### Three verdicts, and which one to read

```
verdict = !healthy                                    -> "unhealthy"  drift is PROVEN
        : !complete || stale || unknown || unjustified -> "unproven"   nothing is proven either way
        : "healthy"
proven  = verdict === "healthy" && fleet_complete
```

`health.healthy` and `health.complete` keep exactly the meanings they had:
`healthy` is "no `fail`, no `error`" (the fleet is not *wrong*), `complete` is
"nothing unobserved, no collection error, no truncation, no contradiction" (this
run *read* all of it). `health.verdict` is the aggregate built on top of both,
and it is what the report headline and `data.health.exit_category` lead with — so
`healthy` can no longer be claimed over a fleet whose audit-fed half was never
opened, while `healthy` itself still means what story 1.4 pinned it to mean.

`health.proven` is the only field that means *we read all of it and it was right*.

`health.freshness_unknown` sits beside `health.stale` and blocks `proven` just
as hard: a policy entry that applies to a field no row populates buckets every
reading `unknown`, and if that gated nothing the entry would validate, change
nothing, and read as though the fleet had been checked.

Beside them: `health.stale`, `health.freshness_unknown`, `health.unjustified`, `health.contradictions`, and
`health.members` — every **selected** agent in exactly one of `healthy`,
`unhealthy`, `incomplete`, `deferred`, `exception`, `unclassified`. The six counts
sum to `scope.selected_agents`, not to the records the envelope's cap let
through.

### Severity, repair class, and one exact next action

Every non-pass observation and every host finding carries an `owner`, an
`observed`/`desired` pair, a `severity`, a `repair` class, and one `next_action`.
Each is derived from a real field — the audit rule's own `fixable`, its
`rule_scope`, and the contract's `activation.execution_authority` — never from
prose.

| `repair` | condition | next action |
| --- | --- | --- |
| `automatic` | an audit rule, project-scoped, reporting `fixable` | the exact `pjangler migrate <rule_id> <repo> --dry-run` |
| `approval-gated` | the observation's field **is** `activation.execution_authority` (`strict: true`, `default: deny`) | the activation route, and it names the authority |
| `blocked` | a contract-declared deferred capability | nothing to run in this release; the action names the owning story |
| `other-owner` | a host-scoped rule | the host route — no work in any repository changes it |
| `manual` | everything else that needs a decision | the retrieval that returns the observation alone |
| `none` | a pass, or a declared-not-applicable skip | the retrieval |

Severity is `state` × `applicability`: an `error` is `critical`; a `fail` on a
required domain is `critical` and elsewhere `high`; an `unobserved` required
domain is `high`; an unjustified `warn` or a `stale` reading is `medium`; a
**justified** `warn`, `unsupported` or `stale` is `low`; a `pass` and a justified
`skip` are `info`. An *unjustified* `unsupported` outranks a justified one —
same observation, same build, and the only difference is whether anyone wrote
down that it was expected.

**A recommended command is read-only unless it is labelled.**
`next_action_class` is `"read-only"` or `"requires-authorization"`, and a
`requires-authorization` action names the authorization in the string itself.

`data.findings` is stable-sorted by gating impact, then severity, then scope,
then agent, then domain, then `finding_id` — **before** any cap, on both the
machine and the human path. A gating finding at position 26 of an unsorted list
is silently dropped by the report's cap of 25, which is exactly the failure the
sort exists to prevent.

### Lifecycle: four values, never one boolean

Each agent record carries `lifecycle` with four separate fields.
`desired_state` is what the registry declares as the target for that row — a
statement of intent, never a claim about the agent. `observed_state` is the
furthest state this run actually proved, and it can never read `routing_ready` or
`activated` in this release because no observer for either exists.
`capability_readiness` is never `ready` for the same reason: a `declared`
registry field is not a direct observation of the shared gateway. `activation`
reports the strict flag verbatim, and the contract's default is deny.

### `--baseline`: two runs, correlated read-only

```bash
pjangler fleet status --json > base.json
pjangler fleet status --baseline base.json --json
```

`--baseline` opens a prior status document **for reading and nothing else**, and
no state is ever written to disk to compute a transition. Findings are joined on
`finding_id`, a sha256 prefix that is stable across runs and identical on the CLI
and MCP adapters, and `data.transitions[]` reports every `appeared`, `resolved`,
`state_changed`, `severity_changed` and `evidence_changed`. An **unchanged**
finding emits nothing, so a byte-identical baseline produces an empty array. An
baseline is refused as `INVALID_INPUT` at exit 2, naming the path, before a
single probe or audit child spawns, when it is unreadable, unparseable, not a
`fleet.status` document, **taken under a different `--agent`/`--domain` scope**,
or **written by a run whose own output was clipped**. The scope check is the
load-bearing one: a document taken over the whole fleet and diffed by a
`--agent alpha` run would otherwise report `resolved` for every other agent —
"it got fixed" about observations the run never collected. `--live` is
deliberately *not* part of the scope, because reading more than the baseline did
is a real transition.

### The exit taxonomy, and why the projection is opt-in

`data.health.exit_category` is `ok`, `unhealthy`, or `incomplete`, and **both
adapters carry it** — it is the discriminant an MCP client had no way to read
before, because `isError` is `false` for a fully unhealthy fleet.

| category | verdict | `--exit-code` exits |
| --- | --- | --- |
| `ok` | `healthy` | 0 |
| `unhealthy` | `unhealthy` | **10** |
| `incomplete` | `unproven` | **11** |

A contradiction is reported only where one source **proved a failure** and
another reported a **pass** for the same `(agent, domain, field)` — never on a
`warn` against a `pass`, and never on two differing non-pass states. The narrow
rule is deliberate: `DOMAIN_FIELD` gives every rule in a domain one contract
field path, so even this fires on readings that are both true, and widening it
to "any two states that differ" would make `complete` meaningless.

`unhealthy` and `incomplete` are `ok: true` states — the command succeeded, the
fleet did not — so they are not error codes and never null out `data`. The
default exit stays **0**: `fleet status` is an observation command, gating CI is a
later story's job, and a `mise run fleet:status` that is permanently red on a real
fleet teaches an operator to ignore it. A *command* failure still wins: an
unknown `--agent` is exit 3 whether or not `--exit-code` was given.

**Host-scoped findings are reported once**, deduped by rule id, in `data.host`.
They never reach a per-agent record and never make an agent or the fleet
unhealthy: no amount of work in a repository can change a condition about this
machine, so failing the repository for it is a category error.

**An unhealthy fleet is data, not a failure.** By default it exits `0` with
`ok: true` and `data.health.verdict: "unhealthy"`. Only a *command* failure is
nonzero without `--exit-code`:

| exit | meaning |
| --- | --- |
| `0` | the command ran — read `data.health.verdict` for the answer |
| `2` | a malformed flag value, a `--domain` that is not one of the nine, or a `--baseline` that could not be read or parsed |
| `3` | an `--agent` id that is not registered, or a registry that is not there |
| `4` | the fleet contract declares a conflicting authority, an invalid class, or a live retired mode |
| `5` | the fleet contract declares a schema version this build does not support |
| `6` | internal |
| `7` | the whole-run `--deadline-ms` budget expired; no partial result is reported |
| `8` | the run was cancelled (`SIGINT`/`SIGTERM`, or an aborted MCP request); no audit child survives |
| `10` | **`--exit-code` only** — `data.health.verdict` is `unhealthy` |
| `11` | **`--exit-code` only** — `data.health.verdict` is `unproven` |

`data` is deterministic: no timestamp, duration, pid, hostname, or ordering by
completion — the audit child's `auditedAt` is dropped at the boundary and every
path is home-redacted. Two runs over unchanged state produce byte-identical
`data`, and every `--json` document is written through an **awaited stdout
drain**, so it survives a file, a pty, a shell pipe, and a `spawn` capture
identically at any size.

## Orienting in a repo

`describe` reads a repo and reports what it actually is — detected type,
installed subsystems, config files present, and what to do next. It is the
first call for an agent (or a human) landing somewhere unfamiliar, and it works
in any repo, 33GOD or not.

```bash
pjangler describe                # current directory
pjangler describe ../some-repo
pjangler describe --json         # machine-parseable, for agent context
pjangler describe --interactive  # tick off fixable findings, press A to apply
```

Subsystem presence and subsystem correctness are reported separately: presence
comes from marker files on disk, parity from the recipe's own audit rules. A
subsystem that was never installed reads `absent`, not `broken`.

### Last activity, not lifecycle status

Projects report **when work last happened**, not a lifecycle word. The old
`status` field said `planned` for 22 of 27 registered projects — including ones
with commits the same day — so it never varied and never informed.

Activity is computed from git at read time, so it cannot go stale and no cron
has to walk the registry. It spans more than the checked-out branch:

| source | covers |
| --- | --- |
| refs | every local branch, remote-tracking branch, and tag |
| worktrees | every linked worktree's HEAD, including detached ones whose commits are on no ref |
| uncommitted | working-tree edits that are not committed yet |

The newest of those wins, and the winning source is always reported. Remote
state reflects your last fetch — nothing here touches the network.

`pjangler project list` orders by that signal, newest work first.

## Shell prompt

`pjangler-prompt` prints one compact line when the working directory is inside a
pjangler project, and nothing at all when it is not:

```
pjangler (PJAN) · 3m
```

It is a separate binary from the main CLI on purpose — the CLI loads the whole
parity rule set and takes ~52ms to boot, while this runs in ~30ms, well inside
starship's 500ms budget.

Add it to `~/.config/starship.toml` as a second, project-scoped prompt line:

```toml
format = "…$all${custom.pjangler}$line_break$character"

[custom.pjangler]
description = "pjangler project context"
when = true
shell = ["sh"]
symbol = "◆"
style = "bold purple"
# The newline lives INSIDE the conditional group, so nothing is emitted —
# not even a blank line — outside a pjangler project.
format = "(\n[$symbol $output]($style))"
command = 'exec pjangler-prompt 2>/dev/null'
```

`$line_break` must be named explicitly: it is otherwise absorbed by `$all` and
the extra line lands in the wrong place.

## MCP server usage

Run over stdio:

```bash
npm run mcp
# or
pjangler-mcp
```

Exposed tools:

- `pjangler_list_capabilities`
- `pjangler_list_parity_rules`
- `pjangler_audit_project`
- `pjangler_migrate_project`
- `pjangler_bootstrap_33god_project`
- `pjangler_project_init`
- `pjangler_project_list`
- `pjangler_project_show`
- `pjangler_describe_project`
- `pjangler_describe_recipe`
- `pjangler_run_recipe`
- `pjangler_deploy_hermes_agent`
- `pjangler_fleet_inventory`
- `pjangler_fleet_provenance`
- `pjangler_fleet_status`
