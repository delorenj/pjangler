import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const serverPath = join(root, "dist", "mcp-server.js");
const temporary = mkdtempSync(join(tmpdir(), "pjangler-pjan-67-"));
const fakeBin = join(temporary, "bin");
const adapters = join(temporary, "providers");
const effectLog = join(temporary, "effects.log");
const providerLog = join(temporary, "provider.log");
const registryPath = join(temporary, "projects.yaml");

mkdirSync(fakeBin, { recursive: true });
mkdirSync(adapters, { recursive: true });

function executable(path, source) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

executable(join(fakeBin, "copier"), `#!/bin/sh
if [ -n "\${PJAN67_EFFECT_LOG:-}" ]; then
  printf 'copier:%s\n' "\$*" >> "\$PJAN67_EFFECT_LOG"
  if env | grep -Eq '^(PLANE_API_KEY|PLANE_[A-Za-z0-9_]+_API_KEY|TRELLO_KEY|TRELLO_TOKEN|LINEAR_API_KEY)='; then
    printf '%s\n' 'provider-credential-present' >> "\$PJAN67_EFFECT_LOG"
  fi
fi
exit 73
`);

executable(join(fakeBin, "systemctl"), `#!/bin/sh
printf 'systemctl:%s\n' "\$*" >> "\$PJAN67_EFFECT_LOG"
exit 0
`);

executable(join(adapters, "plane.sh"), `#!/bin/sh
printf 'provider:%s\n' "\$*" >> "\$PJAN67_PROVIDER_LOG"
printf '%s\n' '{"board_id":"must-not-be-created","identifier":"MUST"}'
`);

executable(join(adapters, "trello.sh"), `#!/bin/sh
printf 'provider:%s\n' "\$*" >> "\$PJAN67_PROVIDER_LOG"
printf '%s\n' '{"board_id":"must-not-be-created","identifier":"MUST"}'
`);

const lifecycleBootstrapTarget = join(temporary, "pjan67-lifecycle-bootstrap");

const serverEnv = {
  ...process.env,
  PATH: `${fakeBin}:${process.env.PATH}`,
  PJ_PROJECT_REGISTRY: registryPath,
  PJ_TICKET_PROVIDER_ADAPTERS: adapters,
  PLANE_API_KEY: "pjan67-test-key",
  PLANE_TEST_SPACE_API_KEY: "pjan67-workspace-test-key",
  TRELLO_KEY: "pjan67-trello-test-key",
  TRELLO_TOKEN: "pjan67-trello-test-token",
  LINEAR_API_KEY: "pjan67-linear-test-key",
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

function assertNoExternalEffects(label) {
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
  const projectInit = listed.tools.find((tool) => tool.name === "pjangler_project_init");
  assert.ok(generic);
  assert.ok(projectInit);

  assert.ok(generic.inputSchema.required.includes("targetDir"), "generic recipes require an explicit targetDir");
  assert.ok(generic.inputSchema.properties.apply, "generic recipe mutation is granted only by apply");
  assert.equal("dryRun" in generic.inputSchema.properties, false, "generic discovery must expose one unambiguous mutation gate");
  assert.ok(projectInit.inputSchema.properties.skipPlane, "project init must expose the project-board suppression gate");

  await expectInvalidParams(client, "pjangler_run_recipe", { recipe: "node" }, "generic recipe target omission");
  await expectInvalidParams(client, "pjangler_run_recipe", { recipe: "node", targetDir: "" }, "generic recipe empty target");

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
  assertNoExternalEffects("bootstrap contradictory consent");

  const projectConsentTarget = join(temporary, "project-consent-target");
  const invalidProjectConsent = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Insufficient Project Consent",
      targetDir: projectConsentTarget,
      apply: true,
      enableSystemd: true,
    },
  });
  assert.equal(invalidProjectConsent.isError, true, "project init must reject external effects without live=true");
  assert.equal(existsSync(projectConsentTarget), false, "project consent failure must precede project filesystem writes");
  assert.equal(existsSync(registryPath), false, "project consent failure must precede registry writes");
  assertNoExternalEffects("project insufficient consent");

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
      local: false,
      live: true,
      provisionTicketBoard: true,
      skipPlane: false,
      ticketProvider: "trello",
    },
  });
  assert.equal(failedBootstrapLifecycle.isError, true, "an ineligible Copier must be a stable bootstrap MCP error");
  assert.equal(existsSync(lifecycleBootstrapTarget), false, "bootstrap eligibility must fail before creating its target");
  assert.equal(existsSync(registryPath), false, "bootstrap eligibility must fail before registry writes");
  assert.equal(existsSync(effectLog), false, "bootstrap eligibility must fail before Copier/systemd subprocesses");
  assert.equal(existsSync(providerLog), false, "bootstrap eligibility must fail before Trello invocation");
} finally {
  await client.close();
}

rmSync(temporary, { recursive: true, force: true });
console.log("PJAN-67 MCP fail-closed regressions: PASS");
