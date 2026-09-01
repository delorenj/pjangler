import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
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

function assertFleetSharedCompositeResponse(payload, label) {
  assert.equal(payload.bloodbankMode, "fleet-shared", `${label} must report the fleet-shared Bloodbank mode`);
  const plan = payload.plan ?? payload;
  const action = plan.actions.find((entry) => entry.kind === "hermes.provision-agent");
  assert.ok(action, `${label} must include its Hermes provisioning action`);
  assert.equal(action.enabled, true, `${label} must reflect provisionAgent=true`);
  assert.equal("skipBloodbank" in action.context, false, `${label} must not expose the legacy per-agent Bloodbank toggle`);
  assert.equal(JSON.stringify(payload).includes('"skipBloodbank"'), false, `${label} must redact skipBloodbank from the complete response`);
}

function copyHermesRoleWithCopier(role, destination) {
  return spawnSync(
    "copier",
    [
      "copy",
      "--skip-tasks",
      "--defaults",
      "--trust",
      "--vcs-ref=HEAD",
      resolve(root, "templates", "hermes-agent"),
      destination,
      "--data", "target_repo=probe",
      "--data", `role=${role}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

await client.connect(transport);
try {
  // PJAN-66: exercise the real vendored Copier contract, not just the MCP
  // dry-run argv. Extensible safe roles must render, while values that could
  // become ambiguous or escaping path segments must fail before rendering.
  for (const safeRole of ["release-captain", "true", "false", "null", "123"]) {
    const customRoleTarget = join(mcpTmp, `copier-safe-role-${safeRole}`);
    const customRoleCopy = copyHermesRoleWithCopier(safeRole, customRoleTarget);
    assert.equal(
      customRoleCopy.status,
      0,
      `Copier must render arbitrary safe role ${JSON.stringify(safeRole)}:\n${customRoleCopy.stdout}\n${customRoleCopy.stderr}`,
    );
    const roleManifest = YAML.parse(readFileSync(join(customRoleTarget, "role.yaml"), "utf8"));
    assert.equal(roleManifest.role, safeRole, `Copier must preserve role ${JSON.stringify(safeRole)}`);
    assert.equal(typeof roleManifest.role, "string", `Copier role ${JSON.stringify(safeRole)} must remain a YAML string`);
  }

  for (const [index, unsafeRole] of ["", ".", "..", "../escaped", "/tmp/escaped", "ops/review", "ops\\review"].entries()) {
    const unsafeTarget = join(mcpTmp, `copier-unsafe-role-${index}`);
    const unsafeCopy = copyHermesRoleWithCopier(unsafeRole, unsafeTarget);
    assert.notEqual(unsafeCopy.status, 0, `Copier must reject unsafe role ${JSON.stringify(unsafeRole)}`);
    assert.equal(existsSync(join(unsafeTarget, "role.yaml")), false, "an invalid Copier role must not render a manifest");
  }
  assert.equal(existsSync(join(mcpTmp, "escaped", "role.yaml")), false, "Copier role traversal must not escape its target");

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
    ["pjangler_run_recipe", { recipe: "node", targetDir: strictRecipeTarget, apply: true }],
    ["pjangler_deploy_hermes_agent", { targetDir: strictDeployTarget, role: "pm", local: true, apply: true }],
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
  assertFleetSharedCompositeResponse(dryRunPayload, "bootstrap response");

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
      provisionAgent: true,
      agentRole: "release-captain",
    },
  });
  const projectPayload = JSON.parse(projectDryRun.content[0].text);
  assert.equal(projectPayload.project.slug, "slowburns");
  assert.equal(projectPayload.project.agents["release-captain"].role, "release-captain");
  assert.ok(projectPayload.actions.some((action) => action.kind === "registry.upsert"));
  assert.ok(projectPayload.actions.some((action) => action.kind === "copier.copy.commonproject"));
  assertFleetSharedCompositeResponse(projectPayload, "project-init response");

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
      { targetDir: strictDeployTarget, role, local: true, apply: true },
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
    arguments: { targetDir: strictDeployTarget, role: "release-captain", local: true },
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
    arguments: { targetDir: strictDeployTarget, role: "security-reviewer", local: true },
  });
  assert.equal(symlinkEscape.isError, true, "Hermes role directories must not escape through an existing symlink");
  assert.match(symlinkEscape.content[0].text, /contained beneath parent/i);
  assert.equal(existsSync(join(escapedHermesRoot, "hermes", "security-reviewer")), false);

  await expectInvalidParams(
    "pjangler_deploy_hermes_agent",
    { targetDir: strictDeployTarget, role: "pm", local: true, skipBloodbank: false },
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

  // The Hermes dry-run exposes copier argv without performing external writes.
  // With no existing role, --overwrite can only come from the MCP force input.
  const hermesForceTarget = join(mcpTmp, "hermes-force");
  mkdirSync(hermesForceTarget);
  const hermesForced = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: { targetDir: hermesForceTarget, role: "pm", local: true, force: true },
  });
  const hermesForcedPayload = JSON.parse(hermesForced.content[0].text);
  assert.equal(hermesForcedPayload.success, true, JSON.stringify(hermesForcedPayload));
  assert.equal(hermesForcedPayload.bloodbankMode, "fleet-shared");
  assert.equal("skipBloodbank" in hermesForcedPayload.context, false);
  assert.match(hermesForcedPayload.logs.join("\n"), /copier .*--overwrite/, "MCP Hermes force must reach RunCopierTemplate");
  const hermesUnforced = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: { targetDir: hermesForceTarget, role: "dev", local: true, force: false },
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

  // -------------------------------------------------------------------------
  // PJAN Epic 1 / Story 1.3: the fleet tools and the CLI are one core.
  //
  // Schema equivalence is the acceptance criterion, and only a real subprocess
  // PAIR can prove it: the tool result must parse to an envelope whose
  // `command`, `data` and `error` deep-equal the CLI `--json` envelope's, under
  // identical env and cwd, and `isError` must equal `!ok`. Each case runs its
  // own short-lived stdio server, because the shim cases need their own PATH and
  // the session above deliberately starts with no project registry on disk.
  // -------------------------------------------------------------------------
  const fleetHome = (() => { try { return userInfo().homedir; } catch { return homedir(); } })();
  const fleetSources = {
    agents: process.env.HERMES_AGENTS_REGISTRY?.trim() || join(fleetHome, ".hermes", "agents-registry.yaml"),
    projects: process.env.PJ_PROJECT_REGISTRY?.trim() || join(fleetHome, ".config", "pjangler", "projects.yaml"),
    config: process.env.HERMES_TEMPLATE_CONFIG?.trim() || join(fleetHome, ".config", "hermes-agent-template", "config.toml"),
  };
  const fleetMissing = Object.entries(fleetSources).find(([, path]) => !existsSync(path));
  if (fleetMissing) {
    // Loud, never silent: an unguarded copy of the operator's live sources turns
    // a portable skip into a FAIL on any other host.
    console.log(`  SKIP fleet MCP parity: ${fleetMissing[0]} is not on this host (${fleetMissing[1].replace(fleetHome, "~")})`);
  } else {
    const fleetTmp = mkdtempSync(join(tmpdir(), "pjangler-mcp-fleet-"));
    try {
      const scratch = join(fleetTmp, "home");
      mkdirSync(join(scratch, ".hermes", "profiles"), { recursive: true });
      mkdirSync(join(scratch, ".config", "pjangler"), { recursive: true });
      mkdirSync(join(scratch, ".config", "hermes-agent-template"), { recursive: true });
      copyFileSync(fleetSources.agents, join(scratch, ".hermes", "agents-registry.yaml"));
      copyFileSync(fleetSources.projects, join(scratch, ".config", "pjangler", "projects.yaml"));
      copyFileSync(fleetSources.config, join(scratch, ".config", "hermes-agent-template", "config.toml"));
      // CONSTRUCTED, never copied. `scripts/run-tests.mjs` points
      // HERMES_FLEET_ENV at a file that does not exist so an inherited
      // PLANE_33GOD_API_KEY can never be live ammunition again; copying the real
      // file would either defeat that or make this whole block skip under
      // `npm test`. The fleet paths come from the real template config, which is
      // the same source the provisioner reads.
      const fleetConfigText = readFileSync(fleetSources.config, "utf8");
      const fleetSection = fleetConfigText.slice(fleetConfigText.indexOf("[fleet]"));
      const fleetBody = fleetSection.slice(0, fleetSection.indexOf("\n[", 1) === -1 ? fleetSection.length : fleetSection.indexOf("\n[", 1));
      const fleetScalar = (key) => (new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(fleetBody) ?? [])[1] ?? "";
      writeFileSync(join(scratch, ".hermes", "fleet.env"), [
        `HERMES_FLEET_HOME=${join(scratch, ".hermes")}`,
        `HERMES_FLEET_BIN=${fleetScalar("hermes_bin")}`,
        `HERMES_FLEET_REPO=${fleetScalar("hermes_repo")}`,
        "HERMES_FLEET_REGISTRY_FILE=$HERMES_FLEET_HOME/agents-registry.yaml",
        "PLANE_33GOD_API_KEY=not-a-real-credential",
        "",
      ].join("\n"), "utf8");

      const fleetEnvFor = (extra = {}) => ({
        ...process.env,
        HOME: scratch,
        XDG_CONFIG_HOME: join(scratch, ".config"),
        HERMES_FLEET_HOME: join(scratch, ".hermes"),
        HERMES_AGENTS_REGISTRY: join(scratch, ".hermes", "agents-registry.yaml"),
        HERMES_FLEET_REGISTRY_FILE: join(scratch, ".hermes", "agents-registry.yaml"),
        HERMES_FLEET_ENV: join(scratch, ".hermes", "fleet.env"),
        HERMES_TEMPLATE_CONFIG: join(scratch, ".config", "hermes-agent-template", "config.toml"),
        PJ_PROJECT_REGISTRY: join(scratch, ".config", "pjangler", "projects.yaml"),
        NO_COLOR: "1",
        ...extra,
      });

      const gitShim = (name, body) => {
        const dir = join(fleetTmp, `shim-${name}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "git"), body, "utf8");
        chmodSync(join(dir, "git"), 0o755);
        return dir;
      };

      /** The same case, through the built CLI, under byte-identical env and cwd. */
      const cliEnvelope = (args, env) => {
        const result = spawnSync(process.execPath, [resolve(root, "dist", "index.js"), ...args, "--json"], {
          cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024, env,
        });
        assert.notEqual(result.stdout, "", `pj ${args.join(" ")} wrote nothing`);
        return JSON.parse(result.stdout);
      };

      const withFleetClient = async (env, body) => {
        const fleetTransport = new StdioClientTransport({ command: "node", args: [serverPath], cwd: root, env });
        const fleetClient = new Client({ name: "pjangler-mcp-fleet", version: "1.0.0" });
        await fleetClient.connect(fleetTransport);
        try { return await body(fleetClient); } finally { await fleetClient.close(); }
      };

      /** Tool result -> envelope, with the `isError <=> !ok` invariant checked. */
      const toolEnvelope = (result) => {
        const text = result.content.map((entry) => entry.type === "text" ? entry.text : "").join("");
        const parsed = JSON.parse(text);
        assert.equal(result.isError ?? false, !parsed.ok, "isError must equal !ok");
        return parsed;
      };

      const cleanEnv = fleetEnvFor();
      await withFleetClient(cleanEnv, async (fleetClient) => {
        const listed = await fleetClient.listTools();
        for (const name of ["pjangler_fleet_inventory", "pjangler_fleet_provenance"]) {
          const tool = listed.tools.find((entry) => entry.name === name);
          assert.ok(tool, `${name} should be exposed by the MCP server`);
          assert.equal(tool.inputSchema.additionalProperties, false, `${name} must reject unknown top-level arguments`);
          assert.deepEqual(
            Object.keys(tool.inputSchema.properties ?? {}).sort(),
            ["agent", "agentRegistry", "contract", "deadlineMs", "projectRegistry"],
            `${name} must expose the CLI's option surface one-for-one`,
          );
        }
        await expectInvalidParams("pjangler_fleet_provenance", { deadline_ms: 5 }, "a misspelled deadline_ms must not be silently dropped into an unbounded run");

        for (const [tool, command, argv, args] of [
          ["pjangler_fleet_provenance", "fleet.provenance", ["fleet", "provenance"], {}],
          ["pjangler_fleet_inventory", "fleet.inventory", ["fleet", "inventory"], {}],
          ["pjangler_fleet_provenance", "fleet.provenance", ["fleet", "provenance", "--agent", "definitely-not-registered"], { agent: "definitely-not-registered" }],
          ["pjangler_fleet_provenance", "fleet.provenance", ["fleet", "provenance", "--agent-registry", join(fleetTmp, "not-a-registry.yaml")], { agentRegistry: join(fleetTmp, "not-a-registry.yaml") }],
          ["pjangler_fleet_provenance", "fleet.provenance", ["fleet", "provenance", "--deadline-ms", "1"], { deadlineMs: 1 }],
        ]) {
          const mcp = toolEnvelope(await fleetClient.callTool({ name: tool, arguments: args }));
          const cli = cliEnvelope(argv, cleanEnv);
          assert.equal(mcp.command, command, `${tool} must report ${command}`);
          assert.equal(mcp.command, cli.command, `${tool}: command must match the CLI's`);
          assert.deepEqual(mcp.data, cli.data, `${tool} ${JSON.stringify(args)}: data must deep-equal the CLI envelope's`);
          assert.deepEqual(mcp.error, cli.error, `${tool} ${JSON.stringify(args)}: error must deep-equal the CLI envelope's`);
        }
      });

      // A partial probe: one broken `git` on PATH, both adapters. The run still
      // succeeds and both sides report the same downgraded facts.
      const brokenGitEnv = fleetEnvFor({ PATH: `${gitShim("fail", "#!/bin/sh\nexit 3\n")}:${process.env.PATH}` });
      await withFleetClient(brokenGitEnv, async (fleetClient) => {
        const mcp = toolEnvelope(await fleetClient.callTool({ name: "pjangler_fleet_provenance", arguments: {} }));
        const cli = cliEnvelope(["fleet", "provenance"], brokenGitEnv);
        assert.equal(mcp.ok, true, "a failed probe is not a command failure");
        assert.equal(mcp.data.health.complete, false, "and the run must say it could not observe everything");
        assert.deepEqual(mcp.data, cli.data, "a partial probe must produce the same data on both adapters");
      });

      // Cancellation: an aborted MCP request must report CANCELLED in the same
      // shape a CLI SIGINT does, and neither may leave a probe child behind.
      const hangPids = join(fleetTmp, "hang-pids");
      const hangingGitEnv = fleetEnvFor({ PATH: `${gitShim("hang", `#!/bin/sh\necho $$ >> ${JSON.stringify(hangPids)}\nsleep 120\n`)}:${process.env.PATH}` });
      const cliCancel = await new Promise((settle) => {
        const child = spawn(process.execPath, [resolve(root, "dist", "index.js"), "fleet", "provenance", "--json"], {
          cwd: root, env: hangingGitEnv, stdio: ["ignore", "pipe", "ignore"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        const killer = setTimeout(() => child.kill("SIGINT"), 1500);
        const guard = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.on("close", (code) => { clearTimeout(killer); clearTimeout(guard); settle({ code, envelope: JSON.parse(out) }); });
      });
      assert.equal(cliCancel.code, 8, "a cancelled CLI run must exit 8");
      assert.equal(cliCancel.envelope.error?.code, "CANCELLED");

      await withFleetClient(hangingGitEnv, async (fleetClient) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 1500);
        let mcp;
        try {
          mcp = toolEnvelope(await fleetClient.callTool({ name: "pjangler_fleet_provenance", arguments: {} }, undefined, { signal: controller.signal, timeout: 60_000 }));
        } catch (error) {
          // Some SDK versions surface an aborted request as a client-side
          // rejection rather than a tool result. Either is an honest report of
          // the same thing; what must NOT happen is a successful envelope.
          assert.match(String(error?.message ?? error), /abort|cancel/i, `an aborted request must not resolve successfully: ${error}`);
          mcp = null;
        }
        if (mcp) {
          assert.equal(mcp.ok, false, "an aborted request must not report success");
          assert.equal(mcp.command, cliCancel.envelope.command);
          assert.deepEqual(mcp.error, cliCancel.envelope.error, "the MCP cancellation must be the same shape the CLI reports");
          assert.equal(mcp.data, null);
        }
      });
      await new Promise((wake) => setTimeout(wake, 2000));
      const survivors = (existsSync(hangPids) ? readFileSync(hangPids, "utf8").trim().split("\n").filter(Boolean) : [])
        .filter((pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } });
      assert.deepEqual(survivors, [], "no probe child may survive a cancellation on either adapter");
    } finally {
      rmSync(fleetTmp, { recursive: true, force: true });
    }
  }
} finally {
  await client.close();
  rmSync(mcpTmp, { recursive: true, force: true });
}

console.log("mcp server regressions passed");
