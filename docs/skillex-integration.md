# Skillex integration (PJAN-127)

PJangler requires Node 24 or newer. Its project bootstrap, parity audit and
migration use the public Node core of `@delorenj/skillex`, a pinned library
dependency; `pj skills` runs the skillex CLI on PATH instead (below). The packaged
CommonProject template pins the same release.

A generated project has one explicit task, run as `mise run skills:sync`:

```toml
[tasks."skills:sync"]
description = "Reconcile this project's selected skills"
tools = { "npm:@delorenj/skillex" = { version = "0.1.2", allow_low_downloads = true }, node = "24" }
run = "skillex sync --scope project --project '{{config_root}}'"
```

`allow_low_downloads = true` approves this one exact version past mise's npm
`minimumPackageAge` gate (30 days by default in mise 2026.9): without it mise
refuses to install `@delorenj/skillex@0.1.2` at all, and the task never runs.
`node = "24"` is the runtime the Node CLI requires. Inside the task `skillex`
is that pinned Node CLI; do not type bare `skillex sync` in a shell, where it can
resolve to the retired Python reconciler. The legacy plain-string pin
(`"npm:@delorenj/skillex" = "0.1.2"`) fails both `mise.config-root` and
`skills.project-manifest` as fixable drift: on a cold mise (a new machine, CI,
a container) mise refuses to install it, so the task could not run. Either
rule's migrate rewrites it to the table form above.

Every mise.toml rewrite is structural and parse-verified: the rewritten file
must parse and mean exactly the original plus the rule's intended changes
(every hook's kind, order, command and `shell`; every task; tools; env). A
rewrite that cannot be made safely is not written; the rule reports `partial`
with the reason. A hook command that joins a retired skill writer with the
operator's own commands is never split; it is reported for a manual edit.

Copier invokes that task once during bootstrap, with process-local trust for the
rendered configuration. Enter hooks and watch hooks do not sync skills. The
separate Python sync and pack provision scripts are no longer shipped or
reinstalled by parity migration. Other project hooks retain their own lifecycle.

`pj audit` uses `inspectStatus`; `pj migrate skills.project-manifest` uses
`initScope` for an absent declaration and `sync` for activation. Existing
selection bytes and `inherit_global: false` survive. Each operation supplies the
project root explicitly, including when invoked from a nested directory. Registry
discovery, pack exclusivity, canonical names, ownership receipts, pruning and
filesystem refusal rules belong to Skillex. `PJ_SKILLS_REGISTRY_ROOT` remains the
explicit offline registry override. No operation clones a registry.

`skills.project-manifest` is the only rule in this surface, and `agent-hooks`
owns it. Its subject is always a project root. Projecting skills into a Hermes
profile is Flume's, along with the employee rules that inspect one — PJangler
reads a role's profile *name* out of `role.yaml` and never opens its `skills/`.

`pj skills [args...]` runs the ONE Skillex CLI on this machine, with every
argument passed through unchanged and its exit status (or signal) relayed. It
resolves the binary the way `scripts/hermes-skillex-resync.py` in the skillex
repo does: `$SKILLEX_BIN`, then `skillex` on PATH, then the mise shim
(`$MISE_DATA_DIR/shims`, `$XDG_DATA_HOME/mise/shims`, `~/.local/share/mise/shims`),
then `mise which skillex`. If none exists it exits 1 naming every place it
looked; it never falls back to another copy. The child runs with the Node that
runs `pj` first on PATH, so a `#!/usr/bin/env node` launcher gets Node 24+.
Install the CLI with the global mise config
(`"npm:@delorenj/skillex" = { version = "latest", ... }`). Until Story 7.1
(2026-11-19) this spawned a copy bundled in PJangler's node_modules, which froze
`pj skills --version` at whatever release PJangler last depended on (0.4.4 while
the PATH skillex was 0.4.8). The `@delorenj/skillex` dependency remains only as
the library the audit calls in-process. Every Skillex command PJangler names in
a finding or remedy is spelled `pj skills …` (including relayed core fix text),
and tests/pjan-135-guidance-commands-regressions.mjs runs each named command
against the real CLI.

`pj migrate` relocates CLI-root skill entries (`.claude/skills` and the other
supported roots) losslessly into `.agents/skills`, so each root can become the
`../.agents/skills` alias Skillex requires. It never claims ownership of foreign
or installer-owned skills and never deletes content that is not a proven
duplicate. Missing sources, ambiguous legacy selections and content that cannot
be proven disposable remain visible blockers. For those:

```sh
pj skills migrate --project /absolute/project           # preview
pj skills migrate --project /absolute/project --apply   # apply the reviewed plan
```

Add `--mapping <file>` only for content the preview reports as ambiguous, then
run `mise run skills:sync`. PJangler does not run a registry-wide migration
implicitly. The former `--accept-registry-matches` backup/adoption path is retired
and now only refuses with this remedy.

For a new declaration, a PJangler dry-run reports the manifest initialization;
activation is resolved after that declaration exists. For existing declarations,
the dry-run includes the core's complete activation changes. Failure reports use
actual applied changes, so a failed publication is not presented as a saved
manifest. An interruption after saved intent can be resumed with
`mise run skills:sync`.

BMAD remains owned by its installer and the supported CLI projection rules
(`bmad.scaffold`, `bmad.version`, `bmad.cli-roots`), which are separate from
skill activation parity.

Recipe audit/migration dispatch, verification, CLI, MCP and project description
now await asynchronous results. Individual synchronous checks remain valid. The
regression suites exercise delayed checks and postconditions, source and installed
bootstrap, inheritance, explicit nested roots, canonical pack/set selections,
foreign preservation, no-op behavior and failed publication.
