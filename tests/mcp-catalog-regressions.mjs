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
]) {
  assert.match(source, new RegExp(`server\\.registerTool\\(\\s*[\"']${tool}[\"']`), `${tool} must be registered`);
}

for (const required of [
  "@33god-projects",
  "audit -> pjangler_audit_project",
  "migrate -> pjangler_migrate_project",
  "bootstrap -> pjangler_bootstrap_33god_project",
  "agent provisioning -> pjangler_deploy_hermes_agent",
]) {
  assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing synergy guidance: ${required}`);
}

for (const required of [
  "getParityRuleIds",
  "runAudit",
  "runMigration",
  "local",
  "skipRuntimeRepo",
  "skipPlane",
  "skipBloodbank",
  "skipSystemd",
]) {
  assert.match(source, new RegExp(required), `mcp-server.ts should reference ${required}`);
}

console.log("mcp catalog regressions passed");
