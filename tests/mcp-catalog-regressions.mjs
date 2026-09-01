import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "src", "mcp-server.ts"), "utf8");
// The fleet tools register from their own module, so the catalog assertion has
// to read that module too. Pointed only at `mcp-server.ts`, this check would
// silently stop covering `pjangler_fleet_inventory` and
// `pjangler_fleet_provenance` -- green because the text it greps no longer
// contains them, not because they are gone.
const fleetSource = readFileSync(resolve(root, "src", "fleet", "mcp.ts"), "utf8");
const registrations = `${source}\n${fleetSource}`;

for (const tool of [
  "pjangler_list_parity_rules",
  "pjangler_audit_project",
  "pjangler_migrate_project",
  "pjangler_bootstrap_33god_project",
  "pjangler_project_init",
  "pjangler_project_list",
  "pjangler_project_show",
  "pjangler_fleet_inventory",
  "pjangler_fleet_provenance",
]) {
  // `server\.` is kept, not dropped. `src/fleet/mcp.ts` registers through
  // `server.registerTool(` exactly like `mcp-server.ts` does, so widening the
  // pattern to a bare `registerTool(` bought nothing and cost the seven
  // pre-existing tools their guarantee that the call is made ON THE SERVER --
  // any `registerTool("name"` text anywhere in either file would have satisfied
  // it. A review that adds coverage must not quietly remove some.
  assert.match(registrations, new RegExp(`server\\.registerTool\\(\\s*[\"']${tool}[\"']`), `${tool} must be registered on the server`);
}

// The wiring itself, not just the registration: a tool defined in a module
// nothing calls is a tool nobody can reach.
assert.match(source, /registerFleetMcpTools\(server, asText\)/, "mcp-server.ts must call the fleet tool registrar with the shared asText helper");
assert.doesNotMatch(fleetSource, /from "\.\.\/mcp-server"/, "src/fleet/mcp.ts must not import mcp-server.ts, which connects a transport at module scope");

for (const required of [
  "@33god-projects",
  "audit -> pjangler_audit_project",
  "migrate -> pjangler_migrate_project",
  "bootstrap -> pjangler_bootstrap_33god_project",
  "agent provisioning -> pjangler_deploy_hermes_agent",
  "pjangler_project_init",
]) {
  assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing synergy guidance: ${required}`);
}

for (const required of [
  "getParityRuleIds",
  "runAudit",
  "runMigration",
  "local",
  "RUNTIME_REPO_COMPAT_SCHEMA",
  "skipPlane",
  "skipBloodbank",
  "skipSystemd",
  "planProjectInit",
  "loadProjectRegistry",
]) {
  assert.match(source, new RegExp(required), `mcp-server.ts should reference ${required}`);
}

assert.match(source, /recipeRegistry\.initRecipe\(\s*["']project["']/, "MCP project init must dispatch through ProjectRecipe");
assert.doesNotMatch(source, /executeProjectInitPlan\(/, "MCP must not duplicate ProjectRecipe plan execution");

console.log("mcp catalog regressions passed");
