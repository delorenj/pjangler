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
