# pjangler

Project subsystem bootstrapper CLI + MCP server.

## Install

```bash
bun install
```

## CLI usage

```bash
bun run src/index.ts --help
# or if installed globally
pjangler --help
```

## MCP server usage

Run over stdio:

```bash
bun run mcp
# or
pjangler-mcp
```

Exposed tools:

- `pjangler_list_capabilities`
- `pjangler_describe_recipe`
- `pjangler_run_recipe`
- `pjangler_deploy_hermes_agent`
