import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";

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
    "pjangler_deploy_hermes_agent",
    "pjangler_project_init",
    "pjangler_project_list",
    "pjangler_project_show",
  ]) {
    assert.ok(toolNames.has(tool), `${tool} should be exposed by the MCP server`);
  }
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown top-level arguments`);
  }

  const bootstrapTool = listed.tools.find((tool) => tool.name === "pjangler_bootstrap_33god_project");
  const projectInitTool = listed.tools.find((tool) => tool.name === "pjangler_project_init");
  const deployTool = listed.tools.find((tool) => tool.name === "pjangler_deploy_hermes_agent");
  assert.equal(deployTool.inputSchema.properties.role.enum, undefined, "MCP deployment roles must remain extensible rather than a fixed enum");
  assert.equal("skipBloodbank" in deployTool.inputSchema.properties, false, "MCP must not advertise per-agent Bloodbank enablement");
  for (const tool of [bootstrapTool, projectInitTool]) {
    assert.equal(tool.inputSchema.properties.boardUrl.deprecated, true, `${tool.name} boardUrl must be visibly deprecated`);
    assert.match(tool.inputSchema.properties.boardUrl.description, /deprecated/i);
  }

  // PJAN-66: every tool rejects unknown top-level arguments at the protocol
  // boundary, before its handler can read state or perform an effect.
  const strictRecipeTarget = join(mcpTmp, "strict-recipe-target");
  const strictDeployTarget = join(mcpTmp, "strict-deploy-target");
  const strictProjectTarget = join(mcpTmp, "strict-project-target");
  const strictBootstrapTarget = join(mcpTmp, "strict-bootstrap-target");
  mkdirSync(strictRecipeTarget);
  mkdirSync(strictDeployTarget);
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
    ["pjangler_describe_project", { targetDir: root }],
    ["pjangler_describe_recipe", { recipe: "node" }],
    ["pjangler_run_recipe", { recipe: "node", targetDir: strictRecipeTarget, dryRun: false }],
    ["pjangler_deploy_hermes_agent", { targetDir: strictDeployTarget, role: "pm", local: true, dryRun: false }],
  ];
  for (const [name, args] of strictCalls) {
    await expectInvalidParams(name, { ...args, pjan66Unknown: true }, `${name} must reject an unknown argument`);
  }
  assert.equal(readFileSync(join(strictRecipeTarget, "package.json"), "utf8"), '{"name":"strict-sentinel"}\n');
  assert.equal(existsSync(join(strictDeployTarget, "agents")), false, "strict validation must run before Hermes creates a role parent");
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
    arguments: { parentDir: tmpdir(), projectName: "MCP Smoke Project", dryRun: true, provisionAgent: true, agentRole: "dev" },
  });
  const dryRunPayload = JSON.parse(dryRun.content[0].text);
  assert.equal(dryRunPayload.ok, true);
  assert.equal(dryRunPayload.dryRun, true);
  assert.equal(dryRunPayload.project.agents.dev.role, "dev");
  assert.ok(dryRunPayload.actions.some((action) => action.kind === "copier.copy.commonproject"));
  assert.ok(dryRunPayload.actions.some((action) => action.kind === "hermes.provision-agent" && action.role === "dev"));

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
  assert.equal(trelloProjectPayload.project.ticket_provider.state, "linked");

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

  // Explicit slugs and arbitrary Hermes roles are safe single path segments.
  // Malicious inputs fail validation before handlers run and cannot escape.
  for (const projectSlug of ["", ".", "..", "../escaped", "/tmp/escaped", "nested/project", "nested\\project"]) {
    await expectInvalidParams(
      "pjangler_bootstrap_33god_project",
      { parentDir: mcpTmp, projectName: "Unsafe Slug", projectSlug, dryRun: false },
      `unsafe bootstrap projectSlug ${JSON.stringify(projectSlug)} must fail`,
    );
  }
  for (const role of ["", ".", "..", "../escaped", "/tmp/escaped", "ops/review", "ops\\review"]) {
    await expectInvalidParams(
      "pjangler_deploy_hermes_agent",
      { targetDir: strictDeployTarget, role, local: true, dryRun: false },
      `unsafe Hermes role ${JSON.stringify(role)} must fail`,
    );
  }
  assert.equal(existsSync(join(mcpTmp, "escaped")), false, "malicious segments must not create escaped files");
  assert.equal(existsSync(join(strictDeployTarget, "agents")), false, "malicious roles must not create Hermes paths");

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

  const arbitraryRole = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: { targetDir: strictDeployTarget, role: "release-captain", local: true, dryRun: true },
  });
  const arbitraryRolePayload = JSON.parse(arbitraryRole.content[0].text);
  assert.equal(arbitraryRolePayload.success, true, JSON.stringify(arbitraryRolePayload));
  assert.equal(arbitraryRolePayload.context.role, "release-captain");
  assert.equal(arbitraryRolePayload.bloodbankMode, "fleet-shared");

  const escapedHermesRoot = join(mcpTmp, "escaped-hermes-root");
  mkdirSync(escapedHermesRoot);
  symlinkSync(escapedHermesRoot, join(strictDeployTarget, "agents"), "dir");
  const symlinkEscape = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: { targetDir: strictDeployTarget, role: "security-reviewer", local: true, dryRun: true },
  });
  assert.equal(symlinkEscape.isError, true, "Hermes role directories must not escape through an existing symlink");
  assert.match(symlinkEscape.content[0].text, /contained beneath parent/i);
  assert.equal(existsSync(join(escapedHermesRoot, "hermes", "security-reviewer")), false);

  await expectInvalidParams(
    "pjangler_deploy_hermes_agent",
    { targetDir: strictDeployTarget, role: "pm", local: true, dryRun: true, skipBloodbank: false },
    "the retired per-agent Bloodbank toggle must be rejected",
  );

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
    arguments: { recipe: "node", targetDir: forceRecipeTarget, force: false },
  });
  assert.equal(noForceRecipe.isError, true, "MCP recipe without force must refuse existing output");
  assert.equal(readFileSync(join(forceRecipeTarget, "package.json"), "utf8"), forceSentinel);
  const forceRecipe = await client.callTool({
    name: "pjangler_run_recipe",
    arguments: { recipe: "node", targetDir: forceRecipeTarget, force: true },
  });
  assert.notEqual(forceRecipe.isError, true, JSON.stringify(forceRecipe));
  assert.equal(JSON.parse(readFileSync(join(forceRecipeTarget, "package.json"), "utf8")).name, "my-project");

  // The Hermes dry-run exposes copier argv without performing external writes.
  // With no existing role, --overwrite can only come from the MCP force input.
  const hermesForceTarget = join(mcpTmp, "hermes-force");
  mkdirSync(hermesForceTarget);
  const hermesForced = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: { targetDir: hermesForceTarget, role: "pm", local: true, dryRun: true, force: true },
  });
  const hermesForcedPayload = JSON.parse(hermesForced.content[0].text);
  assert.equal(hermesForcedPayload.success, true, JSON.stringify(hermesForcedPayload));
  assert.equal(hermesForcedPayload.bloodbankMode, "fleet-shared");
  assert.equal("skipBloodbank" in hermesForcedPayload.context, false);
  assert.match(hermesForcedPayload.logs.join("\n"), /copier .*--overwrite/, "MCP Hermes force must reach RunCopierTemplate");
  const hermesUnforced = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: { targetDir: hermesForceTarget, role: "dev", local: true, dryRun: true, force: false },
  });
  const hermesUnforcedPayload = JSON.parse(hermesUnforced.content[0].text);
  assert.equal(hermesUnforcedPayload.success, true, JSON.stringify(hermesUnforcedPayload));
  assert.doesNotMatch(hermesUnforcedPayload.logs.join("\n"), /--overwrite/, "MCP Hermes no-force dispatch must remain non-overwriting");
  const directorDryRun = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: {
      targetDir: hermesForceTarget,
      role: "director",
      local: true,
      dryRun: true,
      modelProvider: "custom",
      modelName: "hermes",
      modelBaseUrl: "https://gateway.example.test/v1",
      modelApiMode: "chat_completions",
      modelKeyEnv: "DIRECTOR_LITELLM_KEY",
    },
  });
  const directorPayload = JSON.parse(directorDryRun.content[0].text);
  assert.equal(directorPayload.success, true, JSON.stringify(directorPayload));
  const directorCopier = directorPayload.logs.join("\n");
  for (const expected of [
    "role=director",
    "model_base_url=https://gateway.example.test/v1",
    "model_api_mode=chat_completions",
    "model_key_env=DIRECTOR_LITELLM_KEY",
  ]) assert.match(directorCopier, new RegExp(expected));

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
