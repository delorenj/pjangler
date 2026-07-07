import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const serverPath = resolve(root, "dist", "mcp-server.js");
const mcpTmp = mkdtempSync(join(tmpdir(), "pjangler-mcp-registry-"));
const sourceSkill = join(mcpTmp, "skills", "civilwar-letterifier");
mkdirSync(sourceSkill, { recursive: true });
writeFileSync(join(sourceSkill, "SKILL.md"), "---\nname: civilwar-letterifier\n---\n# Civil War Letterifier\n", "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  cwd: root,
  env: { ...process.env, PJ_PROJECT_REGISTRY: join(mcpTmp, "projects.yaml") },
});
const client = new Client({ name: "pjangler-mcp-regression", version: "1.0.0" });

await client.connect(transport);
try {
  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const tool of [
    "pjangler_list_capabilities",
    "pjangler_list_parity_rules",
    "pjangler_audit_project",
    "pjangler_migrate_project",
    "pjangler_bootstrap_33god_project",
    "pjangler_deploy_hermes_agent",
    "pjangler_project_init",
    "pjangler_project_list",
    "pjangler_project_show",
  ]) {
    assert.ok(toolNames.has(tool), `${tool} should be exposed by the MCP server`);
  }

  const rulesResult = await client.callTool({ name: "pjangler_list_parity_rules", arguments: {} });
  const rulesPayload = JSON.parse(rulesResult.content[0].text);
  assert.ok(rulesPayload.parityRules.includes("sot.agent-symlinks"), "parity rule ids should be returned");
  assert.equal(rulesPayload.guidance.skill, "@33god-projects");

  const dryRun = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: { parentDir: tmpdir(), projectName: "MCP Smoke Project", dryRun: true, provisionAgent: true, agentRole: "dev" },
  });
  const dryRunPayload = JSON.parse(dryRun.content[0].text);
  assert.equal(dryRunPayload.ok, true);
  assert.equal(dryRunPayload.dryRun, true);
  assert.equal(dryRunPayload.project.agents.dev.role, "dev");
  assert.ok(dryRunPayload.actions.some((action) => action.kind === "copier.copy.commonproject"));
  assert.ok(dryRunPayload.actions.some((action) => action.kind === "hermes.provision-agent" && action.role === "dev"));

  const projectDryRun = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "SlowBurns",
      description: "Civil War letterification experiments",
      targetDir: join(mcpTmp, "SlowBurns"),
      sourceSkill,
    },
  });
  const projectPayload = JSON.parse(projectDryRun.content[0].text);
  assert.equal(projectPayload.project.slug, "slowburns");
  assert.ok(projectPayload.actions.some((action) => action.kind === "registry.upsert"));
  assert.ok(projectPayload.actions.some((action) => action.kind === "copier.copy.commonproject"));

  const projectList = await client.callTool({ name: "pjangler_project_list", arguments: {} });
  const projectListPayload = JSON.parse(projectList.content[0].text);
  assert.deepEqual(projectListPayload.projects, {});

  const repo = mkdtempSync(join(tmpdir(), "pjangler-mcp-audit-"));
  try {
    writeFileSync(join(repo, "README.md"), "# MCP Audit Fixture\n");
    const auditResult = await client.callTool({ name: "pjangler_audit_project", arguments: { targetDir: repo } });
    const auditPayload = JSON.parse(auditResult.content[0].text);
    assert.equal(auditPayload.repo, repo);
    assert.ok(Array.isArray(auditPayload.rules));
    assert.ok(auditPayload.summary.nextActions.some((action) => action.includes("sot.agent-symlinks")));

    const migrateResult = await client.callTool({
      name: "pjangler_migrate_project",
      arguments: { targetDir: repo, ruleId: "sot.agent-symlinks", dryRun: true },
    });
    const migratePayload = JSON.parse(migrateResult.content[0].text);
    assert.equal(migratePayload.dryRun, true);
    assert.deepEqual(migratePayload.selectedRules, ["sot.agent-symlinks"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
} finally {
  await client.close();
  rmSync(mcpTmp, { recursive: true, force: true });
}

console.log("mcp server regressions passed");
