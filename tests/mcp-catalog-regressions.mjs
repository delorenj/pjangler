import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "src", "mcp-server.ts"), "utf8");

for (const tool of [
  "pjangler_list_parity_rules",
  "pjangler_audit_project",
  "pjangler_migrate_project",
  "pjangler_bootstrap_33god_project",
  "pjangler_project_init",
  "pjangler_project_list",
  "pjangler_project_show",
]) {
  assert.match(source, new RegExp(`server\\.registerTool\\(\\s*[\"']${tool}[\"']`), `${tool} must be registered`);
}

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
