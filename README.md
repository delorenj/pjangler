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

## Orienting in a repo

`describe` reads a repo and reports what it actually is — detected type,
installed subsystems, config files present, and what to do next. It is the
first call for an agent (or a human) landing somewhere unfamiliar, and it works
in any repo, 33GOD or not.

```bash
pjangler describe             # current directory
pjangler describe ../some-repo
pjangler describe --json      # machine-parseable, for agent context
```

Subsystem presence and subsystem correctness are reported separately: presence
comes from marker files on disk, parity from the recipe's own audit rules. A
subsystem that was never installed reads `absent`, not `broken`.

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
