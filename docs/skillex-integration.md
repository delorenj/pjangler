# Skillex integration (PJAN-127)

PJangler requires Node 24 or newer and `@delorenj/skillex` 0.1.1. Its project
bootstrap, parity audit and migration use the public Node core. The packaged
CommonProject template pins the same release.

A generated project has one explicit task:

```toml
[tasks."skills:sync"]
description = "Apply this project's declared skills with Skillex"
tools = { "npm:@delorenj/skillex" = "0.1.1" }
run = "skillex sync --scope project --project '{{config_root}}'"
```

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

Missing sources, ambiguous legacy selections and conflicting real CLI roots
remain visible blockers. Preview `skillex migrate --project /absolute/project`,
provide an explicit mapping where requested, review the inventory, then apply
that migration before syncing. PJangler does not run a registry-wide migration
implicitly. The former `--accept-registry-matches` backup/adoption path is retired;
foreign and installer-owned definitions remain in place.

For a new declaration, a PJangler dry-run reports the manifest initialization;
activation is resolved after that declaration exists. For existing declarations,
the dry-run includes the core's complete activation changes. Failure reports use
actual applied changes, so a failed publication is not presented as a saved
manifest. An interruption after saved intent can be resumed with explicit sync.

BMAD remains owned by its installer and the supported CLI projection rules
(`bmad.scaffold`, `bmad.version`, `bmad.cli-roots`), which are separate from
skill activation parity.

Recipe audit/migration dispatch, verification, CLI, MCP and project description
now await asynchronous results. Individual synchronous checks remain valid. The
regression suites exercise delayed checks and postconditions, source and installed
bootstrap, inheritance, explicit nested roots, canonical pack/set selections,
foreign preservation, no-op behavior and failed publication.
