import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const serverPath = resolve(root, "dist", "mcp-server.js");
const mcpTmp = mkdtempSync(join(tmpdir(), "pjangler-mcp-registry-"));
const fakeBin = join(mcpTmp, "bin");
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "copier"), "#!/bin/sh\nexit 97\n", "utf8");
chmodSync(join(fakeBin, "copier"), 0o755);
const sourceSkill = join(mcpTmp, "skills", "civilwar-letterifier");
mkdirSync(sourceSkill, { recursive: true });
writeFileSync(join(sourceSkill, "SKILL.md"), "---\nname: civilwar-letterifier\n---\n# Civil War Letterifier\n", "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    PJ_PROJECT_REGISTRY: join(mcpTmp, "projects.yaml"),
  },
});
const client = new Client({ name: "pjangler-mcp-regression", version: "1.0.0" });

async function expectInvalidParams(name, args, message) {
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${message}: expected an MCP error result`);
    const text = result.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n");
    assert.match(text, /MCP error -32602:/, `${message}: expected MCP InvalidParams (-32602)`);
    assert.match(text, /invalid arguments|unrecognized key/i, message);
  } catch (error) {
    assert.equal(error?.code, -32602, `${message}: expected MCP InvalidParams (-32602), got ${error?.code}\n${error}`);
    assert.match(String(error?.message ?? error), /invalid arguments|unrecognized key/i, message);
  }
}

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
    "pjangler_project_init",
    "pjangler_project_list",
    "pjangler_project_show",
    "pjangler_info",
  ]) {
    assert.ok(toolNames.has(tool), `${tool} should be exposed by the MCP server`);
  }
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown top-level arguments`);
  }

  const infoRepo = join(mcpTmp, "info-other-repository");
  mkdirSync(infoRepo);
  writeFileSync(join(infoRepo, ".project.json"), JSON.stringify({ project_id: "test-info", project_name: "Authoritative Info", ticket_provider: { type: "plane", board_id: "provider-only", identifier: "OTHER" } }));
  const infoRegistry = join(mcpTmp, "info-registry.yaml");
  writeFileSync(infoRegistry, YAML.stringify({ schema_version: 1, projects: { "test-info": {
    slug: "test-info", project_id: "test-info", name: "Stale index", repo_path: infoRepo, description: "", status: "active", source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } }, ticket_provider: { type: "plane", board_id: "provider-only", identifier: "OTHER" }, agents: {}, created_at: "", updated_at: "",
  } } }));
  for (const args of [{ project_id: "TEST-INFO", registryPath: infoRegistry }, { targetDir: infoRepo, registryPath: infoRegistry }]) {
    const result = await client.callTool({ name: "pjangler_info", arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const info = JSON.parse(result.content.find((item) => item.type === "text").text);
    assert.equal(info.project_id, "test-info");
    assert.equal(info.manifest.project_name, "Authoritative Info");
    assert.equal(info.repo_path, infoRepo, "targetDir must win over the MCP server cwd");
  }

  const bootstrapTool = listed.tools.find((tool) => tool.name === "pjangler_bootstrap_33god_project");
  const projectInitTool = listed.tools.find((tool) => tool.name === "pjangler_project_init");
  for (const tool of [bootstrapTool, projectInitTool]) {
    assert.equal(tool.inputSchema.properties.boardUrl.deprecated, true, `${tool.name} boardUrl must be visibly deprecated`);
    assert.match(tool.inputSchema.properties.boardUrl.description, /deprecated/i);
  }

  // PJAN-66: every tool rejects unknown top-level arguments at the protocol
  // boundary, before its handler can read state or perform an effect.
  const strictRecipeTarget = join(mcpTmp, "strict-recipe-target");
  const strictProjectTarget = join(mcpTmp, "strict-project-target");
  const strictBootstrapTarget = join(mcpTmp, "strict-bootstrap-target");
  mkdirSync(strictRecipeTarget);
  writeFileSync(join(strictRecipeTarget, "package.json"), '{"name":"strict-sentinel"}\n');
  const strictCalls = [
    ["pjangler_list_capabilities", {}],
    ["pjangler_list_parity_rules", {}],
    ["pjangler_audit_project", { targetDir: root }],
    ["pjangler_migrate_project", { targetDir: root, ruleId: "sot.agent-symlinks", dryRun: true }],
    ["pjangler_bootstrap_33god_project", { parentDir: mcpTmp, projectName: "Strict Bootstrap", projectSlug: "strict-bootstrap-target", dryRun: false }],
    ["pjangler_project_init", { name: "Strict Project", targetDir: strictProjectTarget, apply: true }],
    ["pjangler_project_list", {}],
    ["pjangler_project_show", { slug: "missing" }],
    ["pjangler_info", { project_id: "TEST-INFO", registryPath: infoRegistry }],
    ["pjangler_describe_project", { targetDir: root }],
    ["pjangler_describe_recipe", { recipe: "node" }],
    ["pjangler_run_recipe", { recipe: "node", targetDir: strictRecipeTarget, apply: true }],
  ];
  for (const [name, args] of strictCalls) {
    await expectInvalidParams(name, { ...args, pjan66Unknown: true }, `${name} must reject an unknown argument`);
  }
  assert.equal(readFileSync(join(strictRecipeTarget, "package.json"), "utf8"), '{"name":"strict-sentinel"}\n');
  assert.equal(existsSync(strictProjectTarget), false, "strict validation must run before project init creates its target");
  assert.equal(existsSync(strictBootstrapTarget), false, "strict validation must run before bootstrap creates its target");
  assert.equal(existsSync(join(mcpTmp, "projects.yaml")), false, "strict validation must run before registry mutation");

  const typoTarget = join(mcpTmp, "dryrun-typo-target");
  await expectInvalidParams(
    "pjangler_bootstrap_33god_project",
    { parentDir: mcpTmp, projectName: "Dryrun Typo", projectSlug: "dryrun-typo-target", dryrun: true },
    "dryrun must not be silently accepted as dryRun",
  );
  assert.equal(existsSync(typoTarget), false, "the rejected dryrun typo must create nothing");

  const rulesResult = await client.callTool({ name: "pjangler_list_parity_rules", arguments: {} });
  const rulesPayload = JSON.parse(rulesResult.content[0].text);
  assert.ok(rulesPayload.parityRules.includes("sot.agent-symlinks"), "parity rule ids should be returned");
  assert.equal(rulesPayload.guidance.skill, "@33god-projects");

  const dryRun = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: { parentDir: tmpdir(), projectName: "MCP Smoke Project", dryRun: true },
  });
  const dryRunPayload = JSON.parse(dryRun.content[0].text);
  assert.equal(dryRunPayload.ok, true);
  assert.equal(dryRunPayload.dryRun, true);
  assert.ok(dryRunPayload.actions.some((action) => action.kind === "copier.copy.commonproject"));

  const boardUrlBootstrap = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: mcpTmp,
      projectName: "Deprecated Board URL Bootstrap",
      projectSlug: "deprecated-board-url-bootstrap",
      boardUrl: "https://legacy.example.invalid/board",
      dryRun: true,
    },
  });
  const boardUrlBootstrapPayload = JSON.parse(boardUrlBootstrap.content[0].text);
  assert.ok(boardUrlBootstrapPayload.warnings.some((warning) => /boardUrl.*deprecated/i.test(warning)));
  assert.equal("board_url" in boardUrlBootstrapPayload.project.ticket_provider, false);
  assert.equal("board_url" in boardUrlBootstrapPayload.manifest.ticket_provider, false);

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

  const trelloProjectDryRun = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Trello MCP Project",
      targetDir: join(mcpTmp, "TrelloMcpProject"),
      ticketProvider: "trello",
      boardId: "687535e9873b89478afef689",
    },
  });
  const trelloProjectPayload = JSON.parse(trelloProjectDryRun.content[0].text);
  assert.equal(trelloProjectPayload.project.ticket_provider.type, "trello");
  assert.equal("board_url" in trelloProjectPayload.project.ticket_provider, false);
  // A boardId handed to MCP is an unconfirmed binding: the identifier is still
  // a proposal, so the record stays "planned" until `pj project identity`
  // reads the real identifier back from the provider.
  assert.equal(trelloProjectPayload.project.ticket_provider.state, "planned");
  assert.equal(trelloProjectPayload.project.ticket_provider.identifier_source, "proposed");

  const boardUrlProject = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Deprecated Board URL Project",
      targetDir: join(mcpTmp, "DeprecatedBoardUrlProject"),
      boardUrl: "https://legacy.example.invalid/project",
    },
  });
  const boardUrlProjectPayload = JSON.parse(boardUrlProject.content[0].text);
  assert.ok(boardUrlProjectPayload.warnings.some((warning) => /boardUrl.*deprecated/i.test(warning)));
  assert.equal("board_url" in boardUrlProjectPayload.project.ticket_provider, false);
  assert.equal("board_url" in boardUrlProjectPayload.manifest.ticket_provider, false);

  // Explicit slugs are safe single path segments. Malicious inputs fail
  // validation before handlers run and cannot escape.
  for (const projectSlug of ["", ".", "..", "../escaped", "/tmp/escaped", "nested/project", "nested\\project"]) {
    await expectInvalidParams(
      "pjangler_bootstrap_33god_project",
      { parentDir: mcpTmp, projectName: "Unsafe Slug", projectSlug, dryRun: false },
      `unsafe bootstrap projectSlug ${JSON.stringify(projectSlug)} must fail`,
    );
  }
  assert.equal(existsSync(join(mcpTmp, "escaped")), false, "malicious segments must not create escaped files");

  const containedParent = join(mcpTmp, "contained-parent");
  const escapedTarget = join(mcpTmp, "escaped-explicit-target");
  mkdirSync(containedParent);
  const escapedBootstrap = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: containedParent,
      targetDir: escapedTarget,
      projectName: "Escaped Explicit Target",
      projectSlug: "escaped-explicit-target",
      dryRun: false,
    },
  });
  assert.equal(escapedBootstrap.isError, true, "an explicit bootstrap target outside parentDir must fail");
  assert.match(escapedBootstrap.content[0].text, /contained|beneath|parent/i);
  assert.equal(existsSync(escapedTarget), false);

  const projectList = await client.callTool({ name: "pjangler_project_list", arguments: {} });
  const projectListPayload = JSON.parse(projectList.content[0].text);
  assert.deepEqual(projectListPayload.projects, {});

  // PJAN-57: MCP recipe dispatch must preserve the caller's force flag.
  const forceRecipeTarget = join(mcpTmp, "force-recipe");
  mkdirSync(forceRecipeTarget);
  const forceSentinel = '{"name":"keep-me"}\n';
  writeFileSync(join(forceRecipeTarget, "package.json"), forceSentinel);
  const noForceRecipe = await client.callTool({
    name: "pjangler_run_recipe",
    arguments: { recipe: "node", targetDir: forceRecipeTarget, force: false, apply: true },
  });
  assert.equal(noForceRecipe.isError, true, "MCP recipe without force must refuse existing output");
  assert.equal(readFileSync(join(forceRecipeTarget, "package.json"), "utf8"), forceSentinel);
  const forceRecipe = await client.callTool({
    name: "pjangler_run_recipe",
    arguments: { recipe: "node", targetDir: forceRecipeTarget, force: true, apply: true },
  });
  assert.notEqual(forceRecipe.isError, true, JSON.stringify(forceRecipe));
  assert.equal(JSON.parse(readFileSync(join(forceRecipeTarget, "package.json"), "utf8")).name, "my-project");

  // PJAN-57: applying project registration to an existing Git repository goes
  // through ProjectRecipe but must not silently turn into migrate-all. The
  // postcondition may fail and recommend explicit migrations; user files and
  // unrelated parity drift stay untouched.
  const existingRepo = join(mcpTmp, "existing-sync");
  mkdirSync(existingRepo);
  assert.equal(spawnSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: existingRepo }).status, 0);
  writeFileSync(join(existingRepo, "package.json"), '{"name":"existing-sync","description":"MCP sync fixture"}\n');
  writeFileSync(join(existingRepo, "mise.toml"), "# user-owned sentinel\n[env]\nVALUE = \"keep\"\n");
  const existingSync = await client.callTool({
    name: "pjangler_project_init",
    arguments: { name: "Existing Sync", targetDir: existingRepo, apply: true },
  });
  const existingPayload = JSON.parse(existingSync.content[0].text);
  assert.equal(existingPayload.mode, "sync");
  assert.equal(existingPayload.ok, false, "dirty existing repo should fail the final audit without implicit repair");
  assert.equal(existingPayload.migrationReport, undefined);
  assert.deepEqual(existingPayload.selectedParityRules, []);
  assert.equal(existsSync(join(existingRepo, ".env.op")), false, "MCP sync must not run migrate-all");
  assert.equal(readFileSync(join(existingRepo, "mise.toml"), "utf8"), "# user-owned sentinel\n[env]\nVALUE = \"keep\"\n");

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
