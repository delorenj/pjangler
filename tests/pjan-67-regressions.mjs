import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const serverPath = join(root, "dist", "mcp-server.js");
const temporary = mkdtempSync(join(tmpdir(), "pjangler-pjan-67-"));
const fakeBin = join(temporary, "bin");
const adapters = join(temporary, "providers");
const effectLog = join(temporary, "effects.log");
const providerLog = join(temporary, "provider.log");
const templateConfig = join(temporary, "config", "hermes-agent-template", "config.toml");
const registryPath = join(temporary, "projects.yaml");
const fleetHome = join(temporary, "fleet-home");
const fleetRegistryPath = join(fleetHome, "agents-registry.yaml");

mkdirSync(fakeBin, { recursive: true });
mkdirSync(adapters, { recursive: true });

function executable(path, source) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

executable(join(fakeBin, "copier"), `#!/bin/sh
printf '%s\n' 'PJAN67_CHILD_STDOUT_NOISE'
printf '%s\n' 'PJAN67_CHILD_STDERR_NOISE' >&2
if [ -n "\${PJAN67_EFFECT_LOG:-}" ]; then
  printf 'copier:%s:%s:%s\n' "\${SKIP_RUNTIME_REPO:-unset}" "\${SKIP_PLANE:-unset}" "\${SKIP_SYSTEMD:-unset}" >> "\$PJAN67_EFFECT_LOG"
  if env | grep -Eq '^(PLANE_API_KEY|PLANE_[A-Za-z0-9_]+_API_KEY|TRELLO_KEY|TRELLO_TOKEN|LINEAR_API_KEY)='; then
    printf '%s\n' 'provider-credential-present' >> "\$PJAN67_EFFECT_LOG"
  fi
fi
case "\$*" in
  *pjan67-lifecycle-bootstrap*)
    mkdir -p "\$PJAN67_BOOTSTRAP_TARGET/agents/hermes/pm"
    printf '%s\n' 'repo: lifecycle-bootstrap' 'role: pm' 'agent_id: lifecycle-bootstrap-pm' 'bloodbank:' '  enabled: not-a-boolean' > "\$PJAN67_BOOTSTRAP_TARGET/agents/hermes/pm/role.yaml"
    exit 0
    ;;
  *pjan67-lifecycle-hermes*)
    mkdir -p "\$PJAN67_HERMES_TARGET/agents/hermes/pm"
    printf '%s\n' 'repo: lifecycle-hermes' 'role: pm' 'agent_id: lifecycle-hermes-pm' 'bloodbank:' '  enabled: not-a-boolean' > "\$PJAN67_HERMES_TARGET/agents/hermes/pm/role.yaml"
    exit 0
    ;;
esac
exit 73
`);

executable(join(fakeBin, "systemctl"), `#!/bin/sh
printf 'systemctl:%s\n' "\$*" >> "\$PJAN67_EFFECT_LOG"
exit 0
`);

executable(join(adapters, "plane.sh"), `#!/bin/sh
printf 'provider:%s\n' "\$*" >> "\$PJAN67_PROVIDER_LOG"
printf '%s\n' '{"board_id":"must-not-be-created"}'
`);

executable(join(adapters, "trello.sh"), `#!/bin/sh
printf 'provider:%s\n' "\$*" >> "\$PJAN67_PROVIDER_LOG"
printf '%s\n' '{"board_id":"must-not-be-created"}'
`);

const lifecycleBootstrapTarget = join(temporary, "pjan67-lifecycle-bootstrap");
const lifecycleHermesTarget = join(temporary, "pjan67-lifecycle-hermes");

const serverEnv = {
  ...process.env,
  PATH: `${fakeBin}:${process.env.PATH}`,
  HERMES_TEMPLATE_CONFIG: templateConfig,
  HERMES_FLEET_HOME: fleetHome,
  HERMES_FLEET_REGISTRY_FILE: fleetRegistryPath,
  PJ_PROJECT_REGISTRY: registryPath,
  PJ_TICKET_PROVIDER_ADAPTERS: adapters,
  PLANE_API_KEY: "pjan67-test-key",
  PLANE_TEST_SPACE_API_KEY: "pjan67-workspace-test-key",
  TRELLO_KEY: "pjan67-trello-test-key",
  TRELLO_TOKEN: "pjan67-trello-test-token",
  LINEAR_API_KEY: "pjan67-linear-test-key",
  TELEGRAM_BOT_TOKEN: "123456:pjan67-ambient-telegram-token",
  SLACK_BOT_TOKEN: "xoxb-pjan67-ambient-bot-token",
  SLACK_APP_TOKEN: "xapp-pjan67-ambient-app-token",
  ENABLE_SLACK: "1",
  CF_EMAIL_ROUTING_TOKEN: "pjan67-ambient-email-token",
  PJAN67_EFFECT_LOG: effectLog,
  PJAN67_PROVIDER_LOG: providerLog,
  PJAN67_BOOTSTRAP_TARGET: lifecycleBootstrapTarget,
  PJAN67_HERMES_TARGET: lifecycleHermesTarget,
};

function payload(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string", `missing text result: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

async function expectInvalidParams(client, name, args, label) {
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${label}: expected an MCP error result`);
    assert.match(result.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n"), /-32602|invalid arguments/i, label);
  } catch (error) {
    assert.equal(error?.code, -32602, `${label}: expected -32602, got ${error?.code}: ${error}`);
  }
}

function assertNoHermesEffects(targetDir, label) {
  assert.equal(existsSync(templateConfig), false, `${label}: consent failure must not write host config`);
  assert.equal(existsSync(join(targetDir, "agents")), false, `${label}: consent failure must not create agent files`);
  assert.equal(existsSync(effectLog), false, `${label}: consent failure must not invoke Copier/systemd`);
  assert.equal(existsSync(providerLog), false, `${label}: consent failure must not invoke a provider`);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  cwd: root,
  env: serverEnv,
});
const client = new Client({ name: "pjangler-pjan-67", version: "1.0.0" });

try {
  await client.connect(transport);

  const listed = await client.listTools();
  const generic = listed.tools.find((tool) => tool.name === "pjangler_run_recipe");
  const deploy = listed.tools.find((tool) => tool.name === "pjangler_deploy_hermes_agent");
  const projectInit = listed.tools.find((tool) => tool.name === "pjangler_project_init");
  assert.ok(generic);
  assert.ok(deploy);
  assert.ok(projectInit);

  assert.ok(generic.inputSchema.required.includes("targetDir"), "generic recipes require an explicit targetDir");
  assert.ok(generic.inputSchema.properties.apply, "generic recipe mutation is granted only by apply");
  assert.equal("dryRun" in generic.inputSchema.properties, false, "generic discovery must expose one unambiguous mutation gate");
  assert.equal(generic.inputSchema.properties.recipe.enum.includes("hermes-agent"), false, "interactive Hermes must be absent from the generic recipe enum");

  for (const field of ["apply", "live", "provisionRuntimeRepo", "provisionTicketBoard", "enableSystemd"]) {
    assert.ok(deploy.inputSchema.properties[field], `Hermes discovery must expose ${field}`);
  }
  assert.equal("dryRun" in deploy.inputSchema.properties, false, "Hermes must expose apply rather than a negative dry-run switch");
  assert.equal("quiet" in deploy.inputSchema.properties, false, "MCP callers cannot weaken the forced quiet contract");
  assert.equal("yes" in deploy.inputSchema.properties, false, "MCP Hermes never exposes an interactive confirmation path");
  assert.equal("skipTelegram" in deploy.inputSchema.properties, false, "MCP Hermes cannot expose the Telegram prompt path");
  assert.equal("skipEmail" in deploy.inputSchema.properties, false, "MCP Hermes cannot expose the email prompt path");
  assert.ok(projectInit.inputSchema.properties.skipPlane, "project init must expose the project-board suppression gate");

  const capabilities = payload(await client.callTool({ name: "pjangler_list_capabilities", arguments: {} }));
  assert.equal(capabilities.recipes.some((recipe) => recipe.name === "hermes-agent"), false, "generic capability discovery must not advertise Hermes as a runnable recipe");
  assert.equal(capabilities.dedicatedRecipes.some((recipe) => recipe.name === "hermes-agent" && recipe.tool === "pjangler_deploy_hermes_agent"), true);

  await expectInvalidParams(client, "pjangler_run_recipe", { recipe: "node" }, "generic recipe target omission");
  await expectInvalidParams(client, "pjangler_run_recipe", { recipe: "node", targetDir: "" }, "generic recipe empty target");
  await expectInvalidParams(
    client,
    "pjangler_run_recipe",
    { recipe: "hermes-agent", targetDir: temporary },
    "generic Hermes dispatch",
  );

  const genericPreviewTarget = join(temporary, "generic-preview");
  mkdirSync(genericPreviewTarget);
  const genericPreview = payload(await client.callTool({
    name: "pjangler_run_recipe",
    arguments: { recipe: "node", targetDir: genericPreviewTarget },
  }));
  assert.equal(genericPreview.success, true, JSON.stringify(genericPreview));
  assert.equal(genericPreview.apply, false);
  assert.equal(genericPreview.dryRun, true);
  assert.equal(existsSync(join(genericPreviewTarget, "package.json")), false, "generic default must be preview-only");

  const genericApplyTarget = join(temporary, "generic-apply");
  mkdirSync(genericApplyTarget);
  const genericApply = payload(await client.callTool({
    name: "pjangler_run_recipe",
    arguments: { recipe: "node", targetDir: genericApplyTarget, apply: true },
  }));
  assert.equal(genericApply.success, true, JSON.stringify(genericApply));
  assert.equal(genericApply.apply, true);
  assert.equal(genericApply.dryRun, false);
  assert.equal(existsSync(join(genericApplyTarget, "package.json")), true, "apply=true must permit the selected local recipe mutation");

  const hermesTarget = join(temporary, "hermes-preview");
  mkdirSync(hermesTarget);
  const hermesPreview = payload(await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: { targetDir: hermesTarget, role: "release-captain" },
  }));
  assert.equal(hermesPreview.success, true, JSON.stringify(hermesPreview));
  assert.equal(hermesPreview.apply, false);
  assert.equal(hermesPreview.context.dryRun, true);
  assert.equal(hermesPreview.context.quiet, true);
  assert.equal(existsSync(templateConfig), false, "Hermes preview must not create host config");
  assert.equal(existsSync(join(hermesTarget, "agents")), false, "Hermes preview must not create project files");

  const localFalsePreview = payload(await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: { targetDir: hermesTarget, role: "director", local: false },
  }));
  assert.equal(localFalsePreview.context.skipRuntimeRepo, true, "local=false alone must not arm a runtime repo");
  assert.equal(localFalsePreview.context.skipPlane, true, "local=false alone must not arm a ticket board");
  assert.equal(localFalsePreview.context.skipSystemd, true, "local=false alone must not arm systemd");

  const externalPreview = payload(await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: {
      targetDir: hermesTarget,
      role: "director",
      local: false,
      live: true,
      provisionRuntimeRepo: true,
    },
  }));
  assert.equal(externalPreview.apply, false);
  assert.equal(externalPreview.context.dryRun, true);
  assert.equal(externalPreview.context.skipRuntimeRepo, false, "the exact positive opt-in should appear in the preview");
  assert.equal(externalPreview.context.skipPlane, true, "unselected external effects stay off");
  assert.equal(externalPreview.context.skipSystemd, true, "unselected external effects stay off");

  for (const [label, arguments_] of [
    ["live missing", { targetDir: hermesTarget, role: "pm", apply: true, local: false, provisionRuntimeRepo: true }],
    ["local-only contradiction", { targetDir: hermesTarget, role: "pm", apply: true, live: true, local: true, provisionRuntimeRepo: true }],
    ["positive and negative contradiction", { targetDir: hermesTarget, role: "pm", apply: true, live: true, local: false, provisionRuntimeRepo: true, skipRuntimeRepo: true }],
  ]) {
    const result = await client.callTool({ name: "pjangler_deploy_hermes_agent", arguments: arguments_ });
    assert.equal(result.isError, true, `${label}: insufficient/contradictory consent must be an MCP error`);
    assertNoHermesEffects(hermesTarget, label);
  }

  const bootstrapConsentTarget = join(temporary, "bootstrap-consent-target");
  const invalidBootstrapConsent = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      targetDir: bootstrapConsentTarget,
      projectName: "Contradictory Bootstrap Consent",
      projectSlug: "contradictory-bootstrap-consent",
      dryRun: false,
      live: true,
      local: false,
      provisionTicketBoard: true,
      skipPlane: true,
    },
  });
  assert.equal(invalidBootstrapConsent.isError, true, "bootstrap must reject contradictory board consent");
  assert.equal(existsSync(bootstrapConsentTarget), false, "bootstrap consent failure must precede project filesystem writes");
  assertNoHermesEffects(bootstrapConsentTarget, "bootstrap contradictory consent");

  const projectConsentTarget = join(temporary, "project-consent-target");
  const invalidProjectConsent = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Insufficient Project Consent",
      targetDir: projectConsentTarget,
      apply: true,
      provisionRuntimeRepo: true,
    },
  });
  assert.equal(invalidProjectConsent.isError, true, "project init must reject external effects without live=true");
  assert.equal(existsSync(projectConsentTarget), false, "project consent failure must precede project filesystem writes");
  assert.equal(existsSync(registryPath), false, "project consent failure must precede registry writes");
  assertNoHermesEffects(projectConsentTarget, "project insufficient consent");

  const projectPreviewTarget = join(temporary, "project-preview");
  const bootstrapPreview = payload(await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      projectName: "Skip Plane Bootstrap",
      projectSlug: "skip-plane-bootstrap",
      live: true,
      skipPlane: true,
    },
  }));
  const bootstrapBoardAction = bootstrapPreview.actions.find((action) => action.kind === "ticket-provider.create-or-link");
  assert.ok(bootstrapBoardAction);
  assert.equal(bootstrapBoardAction.enabled, false, "bootstrap skipPlane must dominate live=true in the plan");
  assert.match(bootstrapBoardAction.reason, /skipPlane|disabled|skipped/i);

  const projectPreview = payload(await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Skip Plane Preview",
      targetDir: projectPreviewTarget,
      live: true,
      skipPlane: true,
    },
  }));
  const previewBoardAction = projectPreview.actions.find((action) => action.kind === "ticket-provider.create-or-link");
  assert.ok(previewBoardAction);
  assert.equal(previewBoardAction.enabled, false, "skipPlane must dominate live=true in the plan");
  assert.match(previewBoardAction.reason, /skipPlane|disabled|skipped/i);

  // A real lifecycle blocker already present in the target must be discovered
  // by the filesystem-only preflight, before Copier or any config/profile/
  // fleet/provider/systemd phase receives control.
  const malformedExistingTarget = join(temporary, "malformed-existing-hermes");
  const malformedRole = join(malformedExistingTarget, "agents", "hermes", "pm");
  mkdirSync(malformedRole, { recursive: true });
  writeFileSync(join(malformedRole, "role.yaml"), [
    "repo: malformed-existing-hermes",
    "role: pm",
    "agent_id: malformed-existing-hermes-pm",
    "bloodbank:",
    "  enabled: not-a-boolean",
    "",
  ].join("\n"));
  const configBeforeMalformed = existsSync(templateConfig) ? readFileSync(templateConfig) : undefined;
  const malformedResult = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: { targetDir: malformedExistingTarget, role: "director", apply: true },
  });
  assert.equal(malformedResult.isError, true, "existing non-repairable Hermes lifecycle drift must fail preflight");
  assert.equal(existsSync(join(malformedExistingTarget, "agents", "hermes", "director")), false, "preflight failure must not render a new role");
  assert.equal(existsSync(effectLog), false, "preflight failure must not invoke Copier/Hermes/systemd");
  assert.equal(existsSync(providerLog), false, "preflight failure must not invoke a provider");
  assert.equal(existsSync(fleetRegistryPath), false, "preflight failure must not write the fleet registry");
  assert.deepEqual(existsSync(templateConfig) ? readFileSync(templateConfig) : undefined, configBeforeMalformed, "preflight failure must not create or change host config");

  const existingProject = join(temporary, "existing-project");
  mkdirSync(join(existingProject, ".git"), { recursive: true });
  const failedLifecycle = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Preflight Before Plane Apply",
      targetDir: existingProject,
      apply: true,
      live: true,
      provisionTicketBoard: true,
      skipPlane: false,
      ticketProvider: "plane",
    },
  });
  const failedLifecyclePayload = payload(failedLifecycle);
  assert.equal(failedLifecyclePayload.ok, false, "the intentionally incomplete existing repo must fail its structured lifecycle audit");
  assert.equal(failedLifecycle.isError, true, "structured lifecycle failure must be an MCP error result");
  assert.equal(existsSync(join(existingProject, ".project.json")), false, "lifecycle eligibility must fail before manifest writes");
  assert.equal(existsSync(registryPath), false, "lifecycle eligibility must fail before registry writes");
  assert.equal(existsSync(providerLog), false, "lifecycle eligibility must fail before an armed provider invocation");

  const failedBootstrapLifecycle = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      targetDir: lifecycleBootstrapTarget,
      projectName: "PJAN67 Lifecycle Bootstrap",
      projectSlug: "pjan67-lifecycle-bootstrap",
      dryRun: false,
      provisionAgent: true,
      agentRole: "pm",
      local: false,
      live: true,
      provisionTicketBoard: true,
      skipPlane: false,
      ticketProvider: "trello",
    },
  });
  assert.equal(failedBootstrapLifecycle.isError, true, "an ineligible Copier must be a stable bootstrap MCP error");
  assert.equal(existsSync(lifecycleBootstrapTarget), false, "bootstrap eligibility must fail before creating its target");
  assert.equal(existsSync(templateConfig), false, "bootstrap eligibility must fail before host config writes");
  assert.equal(existsSync(registryPath), false, "bootstrap eligibility must fail before registry writes");
  assert.equal(existsSync(effectLog), false, "bootstrap eligibility must fail before Copier/systemd subprocesses");
  assert.equal(existsSync(providerLog), false, "bootstrap eligibility must fail before Trello invocation");

  mkdirSync(lifecycleHermesTarget);
  const failedHermesLifecycle = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: {
      targetDir: lifecycleHermesTarget,
      role: "pm",
      apply: true,
    },
  });
  assert.equal(failedHermesLifecycle.isError, true, "an ineligible Copier must be a stable dedicated Hermes MCP error");
  assert.equal(existsSync(join(lifecycleHermesTarget, "agents")), false, "Hermes eligibility must fail before agent files");
  assert.equal(existsSync(templateConfig), false, "Hermes eligibility must fail before host config writes");
  assert.equal(existsSync(effectLog), false, "Hermes eligibility must fail before Copier/systemd subprocesses");
  assert.equal(existsSync(providerLog), false, "Hermes eligibility must fail before provider invocation");
} finally {
  await client.close();
}

// Raw stdio proof: the fake Copier deliberately writes to both child streams.
// Use the attested, actually installed Copier with the real vendored template;
// an isolated fake Hermes child emits both streams from a template task. The
// MCP server must capture those bytes and emit only newline-framed JSON-RPC
// messages on its own stdout.
const rawFleet = join(temporary, "raw-fleet");
const rawHermes = join(temporary, "raw-hermes");
mkdirSync(rawFleet, { recursive: true });
executable(rawHermes, `#!/bin/sh
printf '%s\n' 'PJAN67_CHILD_STDOUT_NOISE'
printf '%s\n' 'PJAN67_CHILD_STDERR_NOISE' >&2
printf 'hermes-child:%s:%s:%s\n' "\${SKIP_RUNTIME_REPO:-unset}" "\${SKIP_PLANE:-unset}" "\${SKIP_SYSTEMD:-unset}" >> "\$PJAN67_EFFECT_LOG"
if env | grep -Eq '^(PLANE_API_KEY|PLANE_[A-Za-z0-9_]+_API_KEY|TRELLO_KEY|TRELLO_TOKEN|LINEAR_API_KEY)=.+'; then
  printf '%s\n' 'provider-credential-present' >> "\$PJAN67_EFFECT_LOG"
fi
if env | grep -Eq '^(TELEGRAM_BOT_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|ENABLE_SLACK|WIRE_SLACK|CF_EMAIL_ROUTING_TOKEN)=.+'; then
  printf '%s\n' 'interactive-channel-authority-present' >> "\$PJAN67_EFFECT_LOG"
fi
exit 73
`);
mkdirSync(dirname(templateConfig), { recursive: true });
writeFileSync(templateConfig, `[fleet]
hermes_bin = "${rawHermes}"
hermes_repo = "${join(temporary, "raw-hermes-repo")}"
pjangler_bin = "${join(root, "dist", "index.js")}"
hermes_git_url = "https://example.invalid/hermes.git"
hermes_git_ref = "main"
hermes_git_sha = "0000000000000000000000000000000000000000"
fleet_env = "${join(rawFleet, "fleet.env")}"
registry_file = "${join(rawFleet, "agents-registry.yaml")}"
oauth_file = "${join(rawFleet, "auth.json")}"
codex_home = "${join(rawFleet, "codex")}"
canonical_skills_dir = "${join(rawFleet, "skills")}"

[github]
runtime_repo_owner = ""

[plane]
base = "https://plane.example.invalid"
workspace = "test"
`, "utf8");
const rawTarget = join(temporary, "raw-stdio");
mkdirSync(rawTarget);
const rawInput = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "pjan-67-raw", version: "1.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "pjangler_deploy_hermes_agent",
      arguments: { targetDir: rawTarget, role: "pm", apply: true },
    },
  },
].map((message) => JSON.stringify(message)).join("\n") + "\n";
const raw = spawnSync("node", [serverPath], {
  cwd: root,
  env: {
    ...serverEnv,
    PATH: process.env.PATH,
    HERMES_BIN: rawHermes,
    HERMES_FLEET_ENV: join(rawFleet, "fleet.env"),
    HERMES_FLEET_REGISTRY_FILE: join(rawFleet, "agents-registry.yaml"),
    HERMES_AGENT_REPO: join(temporary, "raw-hermes-repo"),
    HERMES_OAUTH_FILE: join(rawFleet, "auth.json"),
    CODEX_HOME: join(rawFleet, "codex"),
  },
  input: rawInput,
  encoding: "utf8",
  timeout: 15_000,
});
assert.equal(raw.error, undefined, raw.error?.message);
assert.equal(raw.status, 0, `raw MCP server failed:\n${raw.stderr}`);
const frames = raw.stdout.split(/\r?\n/).filter(Boolean).map((line, index) => {
  assert.doesNotMatch(line, /PJAN67_CHILD_STDOUT_NOISE/, "captured child output must never escape onto MCP stdout");
  let frame;
  assert.doesNotThrow(() => { frame = JSON.parse(line); }, `stdout line ${index + 1} is not a JSON-RPC frame: ${JSON.stringify(line)}`);
  assert.equal(frame.jsonrpc, "2.0", `stdout line ${index + 1} lacks the JSON-RPC marker`);
  return frame;
});
const rawCall = frames.find((frame) => frame.id === 2);
assert.ok(rawCall, `missing raw tools/call response: ${raw.stdout}`);
assert.equal(rawCall.result?.isError, true, "the captured trusted-Copier child failure must remain a structured MCP error");
assert.match(readFileSync(effectLog, "utf8"), /hermes-child:1:1:1/, "local apply must keep every unselected external effect disabled");
assert.doesNotMatch(readFileSync(effectLog, "utf8"), /provider-credential-present/, "Copier must not inherit provider credentials without a positive board grant");
assert.doesNotMatch(readFileSync(effectLog, "utf8"), /interactive-channel-authority-present/, "MCP Hermes children must not inherit unavailable interactive-channel authority");
assert.equal(existsSync(providerLog), false, "raw local Hermes apply must not invoke the board provider");

rmSync(temporary, { recursive: true, force: true });
console.log("PJAN-67 MCP fail-closed regressions: PASS");
