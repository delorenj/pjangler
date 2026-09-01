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

Two provenance questions this host records nothing to answer, and which are
therefore reported as `unsupported` with their observed evidence rather than
guessed: a deployed role scaffold carries no template ref (it renders no
`.copier-answers.yml`), and a generated profile config carries only the
`GENERATED FILE -- DO NOT EDIT` marker — no generation counter, digest, or
sidecar — so a sha256 of its bytes is the only stable evidence.

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
| `template_scaffold` | the tracked template's gitlink, remote and cleanliness (fleet-wide); `scaffold.template_ref` is `unsupported` — a deployed role scaffold records none | every tracked-asset parity rule |
| `profile` | the generated profile directory, `lstat`ed and never followed; a symlink is a `fail`, because the contract declares `symlink_allowed: false` | `hermes.runtime-singleton`; `hermes.profile-wiring` (**host-scoped**) |
| `runtime` | the role-local runtime directory derived from `role_dir` | `hermes.untracked-runtimes` |
| `systemd` | `unsupported` — no systemd observer exists in this release; the unit names are the contract's expectations, carried as evidence | `systemd.sentinel` (**host-scoped**, unfiltered runs only†), never promoted to an agent |
| `live_process` | `unsupported` — there is no `ps`, `pgrep`, or `/proc` read anywhere in this build | nothing |
| `bloodbank` | the stored routing record and the strict activation flag; liveness is `unsupported` | `hermes.fleet-config` (**host-scoped**, unfiltered runs only†) |
| `release_provenance` | every provenance fact for the agent: executable, checkout, remote, HEAD, cleanliness | nothing |

† `registry`, `systemd` and `bloodbank` are each observed live by exactly one
rule, and that rule is **host-scoped** — it can add nothing to any agent's
record, only to `data.host`. Filters constrain collection, so
`--domain systemd --live` spawns no audit child at all and `data.host` comes back
empty; the run says so with an `audit-host-rules-not-collected` finding naming
the rule it did not collect. Run without `--domain` to get them.

A `--domain` run whose selected domain *is* audit-fed does spawn children, and
those children report every rule — including host-scoped rules for domains you
did not select. Those results are not carried in `data.host` (only the selected
domain is emitted), and the run says so too, with one
`audit-host-rules-not-reported` finding per rule. **An empty `data.host` never
means "this machine is clean"** on a filtered run; the findings say which reading
you are not being shown. For the same reason a host finding's `retrieval` is the
unfiltered `--live` invocation whenever its domain is one of the three above —
the narrowed command could not return it.

Story 1.8 owns the systemd observer, 1.9 the live-process observer, and 1.10
Bloodbank routing readiness. Until then those domains say so, by name, rather
than disappearing.

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
already answers. A contract with **no** `health_policy` block still loads — it
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
