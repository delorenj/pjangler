import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import YAML from "yaml";
import Ajv from "ajv";

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
  env: hermeticEnv({
    PATH: `${fakeBin}:${process.env.PATH}`,
    PJ_PROJECT_REGISTRY: join(mcpTmp, "projects.yaml"),
  }),
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
  const ajv = new Ajv({ strict: false });
  const advertised = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const validated = new Set();
  function rejectMalformed(name, payload, mutate, label) {
    const malformed = structuredClone(payload);
    mutate(malformed);
    const validate = ajv.compile(advertised.get(name).outputSchema);
    assert.equal(validate(malformed), false, `${name}: ${label} must violate advertised schema`);
  }
  async function callContract(name, args, { error = false, formatted = false } = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError === true, error, `${name} unexpected error state: ${JSON.stringify(result)}`);
    const text = result.content.find((item) => item.type === "text")?.text;
    assert.ok(text?.length, `${name}: readable text is required`);
    assert.ok(result.structuredContent && typeof result.structuredContent === "object", `${name}: missing structuredContent`);
    const validate = ajv.compile(advertised.get(name).outputSchema);
    assert.ok(validate(result.structuredContent), `${name} schema: ${ajv.errorsText(validate.errors)} ${JSON.stringify(result.structuredContent)}`);
    if (!formatted) assert.deepEqual(JSON.parse(text), result.structuredContent, `${name}: text and structured content must agree`);
    validated.add(name);
    return result;
  }
  const expectedHints = {
    pjangler_list_capabilities: [true, false, true, false],
    pjangler_list_parity_rules: [true, false, true, false],
    pjangler_audit_project: [true, false, true, true],
    pjangler_migrate_project: [false, true, false, true],
    pjangler_bootstrap_33god_project: [false, true, false, true],
    pjangler_project_init: [false, true, false, true],
    pjangler_info: [true, false, true, true],
    pjangler_project_list: [true, false, true, true],
    pjangler_project_show: [true, false, true, true],
    pjangler_describe_project: [true, false, true, true],
    pjangler_describe_recipe: [true, false, true, false],
    pjangler_run_recipe: [false, true, false, true],
  };
  assert.deepEqual(Object.keys(expectedHints).sort(), listed.tools.map((tool) => tool.name).sort(), "review every actual tool, not a stale catalog");
  for (const tool of listed.tools) {
    assert.ok(tool.outputSchema && tool.outputSchema.type === "object", `${tool.name}: missing object output schema`);
    const keys = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
    for (const key of keys) {
      assert.equal(typeof tool.annotations?.[key], "boolean", `${tool.name}: ${key} must be explicit`);
    }
    assert.deepEqual(keys.map((key) => tool.annotations[key]), expectedHints[tool.name], `${tool.name}: hints must match reviewed handler effects`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown top-level arguments`);
  }
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

  // PJAN-169: the project type is part of both strict schemas, an unknown one
  // is refused at the boundary, and the plan carries it into Copier.
  const pluginDryRun = await client.callTool({
    name: "pjangler_project_init",
    arguments: { name: "Mcp Plugin", targetDir: join(mcpTmp, "McpPlugin"), projectType: "obsidian-plugin" },
  });
  const pluginPayload = JSON.parse(pluginDryRun.content[0].text);
  assert.equal(pluginPayload.project.template.commonproject.project_type, "obsidian-plugin");
  assert.equal(pluginPayload.project.template.commonproject.primary_language, "typescript");
  const pluginCopier = pluginPayload.actions.find((action) => action.kind === "copier.copy.commonproject");
  assert.ok(pluginCopier, "a new plugin project must render through Copier");
  assert.ok(pluginCopier.command.includes("project_type=obsidian-plugin"), JSON.stringify(pluginCopier.command));
  const bootstrapPlugin = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: { parentDir: mcpTmp, projectName: "Mcp Boot Plugin", projectSlug: "mcp-boot-plugin", projectType: "obsidian-plugin", dryRun: true },
  });
  assert.equal(JSON.parse(bootstrapPlugin.content[0].text).project.template.commonproject.project_type, "obsidian-plugin");
  await expectInvalidParams(
    "pjangler_project_init",
    { name: "Bogus Type", targetDir: join(mcpTmp, "BogusType"), projectType: "vscode-extension" },
    "an unknown projectType must be rejected by the schema",
  );

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

  // PJAN-68: exercise discovery and every success contract with isolated inputs.
  const catalog = await callContract("pjangler_list_capabilities", {});
  assert.ok(catalog.structuredContent.recipes.length);
  rejectMalformed("pjangler_list_capabilities", catalog.structuredContent, (p) => { p.recipes[0] = {}; }, "empty recipe metadata");
  rejectMalformed("pjangler_list_capabilities", catalog.structuredContent, (p) => { p.commands[0] = {}; }, "empty command metadata");
  await callContract("pjangler_list_parity_rules", {});
  const registryContract = await callContract("pjangler_project_list", { registryPath: infoRegistry });
  rejectMalformed("pjangler_project_list", registryContract.structuredContent, (p) => { p.projects["test-info"] = {}; }, "empty registry project");
  await callContract("pjangler_project_show", { slug: "test-info", registryPath: infoRegistry });
  await callContract("pjangler_info", { project_id: "TEST-INFO", registryPath: infoRegistry });
  await callContract("pjangler_describe_recipe", { recipe: "node" });
  const initPreview = await callContract("pjangler_project_init", { name: "Contract Preview", targetDir: join(mcpTmp, "contract-preview"), registryPath: infoRegistry });
  const bootPreview = await callContract("pjangler_bootstrap_33god_project", {
    parentDir: mcpTmp, projectName: "Contract Boot", projectSlug: "contract-boot", dryRun: true, registryPath: infoRegistry,
  });
  for (const [name, preview] of [
    ["pjangler_project_init", initPreview.structuredContent],
    ["pjangler_bootstrap_33god_project", bootPreview.structuredContent],
  ]) {
    assert.equal(preview.dryRun, true);
    rejectMalformed(name, preview, (p) => { p.project = {}; }, "empty preview project");
    rejectMalformed(name, preview, (p) => { delete p.actions; }, "preview missing actions");
    rejectMalformed(name, preview, (p) => { delete p.manifest; }, "preview missing manifest");
    rejectMalformed(name, preview, (p) => { delete p.registryPath; }, "preview missing registry path");
    rejectMalformed(name, preview, (p) => { p.dryRun = false; }, "preview masquerading as execution");
    for (const minimal of [{ ok: true, dryRun: true }, { ok: true, dryRun: false }]) {
      const validate = ajv.compile(advertised.get(name).outputSchema);
      assert.equal(validate(minimal), false, `${name} must reject minimal ${JSON.stringify(minimal)}`);
    }
  }
  rejectMalformed("pjangler_project_init", initPreview.structuredContent, (p) => { p.actions[0] = {}; }, "empty preview action");
  rejectMalformed("pjangler_project_init", initPreview.structuredContent, (p) => { p.manifest.ticket_provider = {}; }, "empty manifest ticket provider");
  rejectMalformed("pjangler_project_init", initPreview.structuredContent, (p) => { p.manifest.agents.maintainer = {}; }, "empty manifest agent");
  rejectMalformed("pjangler_project_init", initPreview.structuredContent, (p) => { p.project.agents.maintainer = {}; }, "empty registry agent");
  const recipePreviewDir = join(mcpTmp, "contract-recipe-preview");
  mkdirSync(recipePreviewDir);
  const previewRecipe = await callContract("pjangler_run_recipe", { recipe: "node", targetDir: recipePreviewDir });
  assert.equal(previewRecipe.structuredContent.dryRun, true);
  assert.equal(existsSync(join(recipePreviewDir, "package.json")), false);
  const contractAuditDir = join(mcpTmp, "contract-audit");
  mkdirSync(contractAuditDir);
  writeFileSync(join(contractAuditDir, "README.md"), "# Isolated contract fixture\n");
  const auditJson = await callContract("pjangler_audit_project", { targetDir: contractAuditDir });
  rejectMalformed("pjangler_audit_project", auditJson.structuredContent, (p) => { p.rules[0] = {}; }, "empty audit finding");
  const auditText = await callContract("pjangler_audit_project", { targetDir: contractAuditDir, json: false }, { formatted: true });
  assert.deepEqual(auditText.structuredContent.rules, auditJson.structuredContent.rules);
  assert.ok(!auditText.content[0].text.startsWith("{"));
  const describeJson = await callContract("pjangler_describe_project", { targetDir: recipePreviewDir, registryPath: infoRegistry });
  for (const field of ["git", "activity", "type", "identity", "parity", "notebook"]) {
    rejectMalformed("pjangler_describe_project", describeJson.structuredContent, (p) => { p[field] = {}; }, `empty ${field}`);
  }
  for (const field of ["subsystems", "configFiles", "nextSteps"]) {
    rejectMalformed("pjangler_describe_project", describeJson.structuredContent, (p) => { p[field] = [{}]; }, `empty ${field} entry`);
  }
  rejectMalformed("pjangler_describe_project", describeJson.structuredContent, (p) => { p.activity.scanned = {}; }, "empty activity scan");
  rejectMalformed("pjangler_describe_project", describeJson.structuredContent, (p) => { p.identity.agents = [{}]; }, "empty identity agent");
  rejectMalformed("pjangler_describe_project", describeJson.structuredContent, (p) => { p.subsystems[0].rules = [{}]; }, "empty subsystem rule");
  rejectMalformed("pjangler_describe_project", describeJson.structuredContent, (p) => { p.parity.counts = {}; }, "empty parity counts");
  const describeText = await callContract("pjangler_describe_project", { targetDir: recipePreviewDir, registryPath: infoRegistry, json: false }, { formatted: true });
  assert.deepEqual(describeText.structuredContent.identity, describeJson.structuredContent.identity);
  const migrationPreview = await callContract("pjangler_migrate_project", { targetDir: contractAuditDir, ruleId: "sot.agent-symlinks", dryRun: true }, { error: false });
  assert.equal(migrationPreview.structuredContent.dryRun, true);
  rejectMalformed("pjangler_migrate_project", migrationPreview.structuredContent, (p) => { p.results[0] = {}; }, "empty migration result");
  const migrationApply = await callContract("pjangler_migrate_project", { targetDir: contractAuditDir, ruleId: "sot.agent-symlinks", dryRun: false });
  assert.equal(migrationApply.structuredContent.dryRun, false);
  const blockedMigrationDir = join(mcpTmp, "blocked-migration");
  mkdirSync(blockedMigrationDir);
  const blockedMigration = await callContract("pjangler_migrate_project", {
    targetDir: blockedMigrationDir, ruleId: "sot.agent-symlinks", dryRun: false,
  }, { error: true });
  assert.equal(blockedMigration.structuredContent.ok, false);
  assert.equal(blockedMigration.structuredContent.results[0].status, "blocked");
  assert.ok(blockedMigration.structuredContent.results[0].details.length);
  const partialMigrationDir = join(mcpTmp, "partial-migration");
  mkdirSync(partialMigrationDir);
  writeFileSync(join(partialMigrationDir, "AGENTS.md"), "# Canonical\n");
  writeFileSync(join(partialMigrationDir, "CLAUDE.md"), "# User-owned conflict\n");
  const partialMigration = await callContract("pjangler_migrate_project", {
    targetDir: partialMigrationDir, ruleId: "sot.agent-symlinks", dryRun: false,
  }, { error: true });
  assert.equal(partialMigration.structuredContent.ok, false);
  assert.equal(partialMigration.structuredContent.results[0].status, "blocked");
  assert.ok(partialMigration.structuredContent.results[0].changedFiles.length, "partial migration records completed work");
  assert.ok(partialMigration.structuredContent.results[0].details.length, "partial migration retains conflict diagnostics");
  const failedBootstrap = await callContract("pjangler_bootstrap_33god_project", {
    parentDir: mcpTmp, projectName: "Failed Contract Bootstrap", projectSlug: "failed-contract-bootstrap", dryRun: false,
  }, { error: true });
  assert.equal(failedBootstrap.structuredContent.ok, false);
  assert.ok(failedBootstrap.structuredContent.phases?.length);
  assert.ok(failedBootstrap.structuredContent.errors?.length);
  assert.equal(existsSync(join(mcpTmp, "failed-contract-bootstrap")), false);
  // PJAN-57: MCP recipe dispatch must preserve the caller's force flag.
  const forceRecipeTarget = join(mcpTmp, "force-recipe");
  mkdirSync(forceRecipeTarget);
  const forceSentinel = '{"name":"keep-me"}\n';
  writeFileSync(join(forceRecipeTarget, "package.json"), forceSentinel);
  const noForceRecipe = await callContract("pjangler_run_recipe", {
    recipe: "node", targetDir: forceRecipeTarget, force: false, apply: true,
  }, { error: true });
  assert.equal(noForceRecipe.structuredContent.success, false);
  assert.ok(noForceRecipe.structuredContent.errors.length);
  assert.equal(readFileSync(join(forceRecipeTarget, "package.json"), "utf8"), forceSentinel);
  const forceRecipe = await callContract("pjangler_run_recipe", {
    recipe: "node", targetDir: forceRecipeTarget, force: true, apply: true,
  });
  assert.notEqual(forceRecipe.isError, true, JSON.stringify(forceRecipe));
  assert.equal(JSON.parse(readFileSync(join(forceRecipeTarget, "package.json"), "utf8")).name, "my-project");

  // PJAN-57: applying project registration to an existing Git repository goes
  // through ProjectRecipe but must not silently turn into migrate-all. The
  // postcondition may fail and recommend explicit migrations; user files and
  // unrelated parity drift stay untouched.
  const existingRepo = join(mcpTmp, "existing-sync");
  mkdirSync(existingRepo);
  assert.equal(spawnSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: existingRepo, env: hermeticEnv() }).status, 0);
  writeFileSync(join(existingRepo, "package.json"), '{"name":"existing-sync","description":"MCP sync fixture"}\n');
  writeFileSync(join(existingRepo, "mise.toml"), "# user-owned sentinel\n[env]\nVALUE = \"keep\"\n");
  const existingSync = await callContract("pjangler_project_init", {
    name: "Existing Sync", targetDir: existingRepo, apply: true,
  }, { error: true });
  const existingPayload = existingSync.structuredContent;
  assert.equal(existingPayload.mode, "sync");
  assert.equal(existingPayload.ok, false, "dirty existing repo should fail the final audit without implicit repair");
  assert.ok(existingPayload.phases?.length, "failed init keeps lifecycle phases");
  assert.ok(existingPayload.errors?.length, "failed init keeps diagnostics");
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
  for (const tool of listed.tools) {
    assert.ok(validated.has(tool.name), `${tool.name}: successful call must be schema-validated`);
  }
} finally {
  await client.close();
  rmSync(mcpTmp, { recursive: true, force: true });
}

console.log("mcp server regressions passed");
