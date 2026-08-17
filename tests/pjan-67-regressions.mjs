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
fi
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

const serverEnv = {
  ...process.env,
  PATH: `${fakeBin}:${process.env.PATH}`,
  HERMES_TEMPLATE_CONFIG: templateConfig,
  PJ_PROJECT_REGISTRY: registryPath,
  PJ_TICKET_PROVIDER_ADAPTERS: adapters,
  PLANE_API_KEY: "pjan67-test-key",
  PJAN67_EFFECT_LOG: effectLog,
  PJAN67_PROVIDER_LOG: providerLog,
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

  const existingProject = join(temporary, "existing-project");
  mkdirSync(join(existingProject, ".git"), { recursive: true });
  const failedLifecycle = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Skip Plane Apply",
      targetDir: existingProject,
      apply: true,
      live: true,
      skipPlane: true,
    },
  });
  const failedLifecyclePayload = payload(failedLifecycle);
  assert.equal(failedLifecyclePayload.ok, false, "the intentionally incomplete existing repo must fail its structured lifecycle audit");
  assert.equal(failedLifecycle.isError, true, "structured lifecycle failure must be an MCP error result");
  assert.equal(existsSync(providerLog), false, "skipPlane=true must prevent provider invocation even when live=true and credentials exist");
} finally {
  await client.close();
}

// Raw stdio proof: the fake Copier deliberately writes to both child streams.
// The MCP server must capture those bytes and emit only newline-framed JSON-RPC
// messages on its own stdout.
mkdirSync(dirname(templateConfig), { recursive: true });
writeFileSync(templateConfig, "[github]\nruntime_repo_owner = \"\"\n", "utf8");
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
  env: serverEnv,
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
assert.equal(rawCall.result?.isError, true, "the fake Copier failure must remain a structured MCP error");
assert.match(readFileSync(effectLog, "utf8"), /copier:1:1:1/, "local apply must keep every unselected external effect disabled");
assert.equal(existsSync(providerLog), false, "raw local Hermes apply must not invoke the board provider");

rmSync(temporary, { recursive: true, force: true });
console.log("PJAN-67 MCP fail-closed regressions: PASS");
