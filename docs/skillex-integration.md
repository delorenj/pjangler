# Skillex integration (PJAN-127)

PJangler requires Node 24 or newer and `@delorenj/skillex` 0.1.1. Its project
bootstrap, parity audit, migration and Hermes profile integration use the public
Node core. The packaged CommonProject and Hermes templates pin the same release.

A generated project has one explicit task:

```toml
[tasks."skills:sync"]
description = "Reconcile this project's selected skills"
tools = { "npm:@delorenj/skillex" = "0.1.1", node = "24" }
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

Hermes profile projection uses `showProfile` and `syncProfile` with the role's
explicit project and profile name. Global and project selections form a union;
project exclusions affect only the project contribution. The profile's real
`skills/` directory retains its inode, and existing local entries win without
being adopted. No singleton link points the whole profile skills root at the
fleet. A legacy whole-root skills alias requires explicit migration; its shared
target is preserved.

Fleet byte-policy is separate from activation parity. The shipped
`profile_manifest.skill_core.required` is empty: no fixed list or generic global
activation is required. A custom fleet contract can declare a required list and
canonical bytes as an additional policy. `hermes.runtime-singleton` inspects
actual profile activation through Skillex, including local precedence, independently
of that optional policy. BMAD remains owned by its installer and supported CLI
projection rules.

Recipe audit/migration dispatch, verification, CLI, MCP and project description
now await asynchronous results. Individual synchronous checks remain valid. The
regression suites exercise delayed checks and postconditions, source and installed
bootstrap, inheritance, explicit nested roots, canonical pack/set selections,
foreign preservation, profile overlays, no-op behavior and failed publication.
