import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import YAML from "yaml";
import {
  BMAD_INSTALLER_FIXTURE_VERSION,
  createBmadInstallerFixture,
  createBmadPackFixture,
} from "./helpers/bmad-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const serverPath = join(root, "dist", "mcp-server.js");
const installed = spawnSync("which", ["copier"], { encoding: "utf8" });
if (installed.status !== 0 || !installed.stdout.trim()) {
  console.log("PJAN-67 trusted lifecycle integration: SKIP (Copier is not installed)");
  process.exit(0);
}

const temporary = mkdtempSync(join(root, ".pjan-67-trusted-lifecycle-"));
const enclosingProjectManifest = join(temporary, ".project.json");
const enclosingProjectManifestBefore = '{"project_name":"PJAN-67 enclosing sentinel","agents":{}}\n';
writeFileSync(enclosingProjectManifest, enclosingProjectManifestBefore, "utf8");
const enclosingGit = spawnSync("git", ["init", "--quiet"], { cwd: temporary, encoding: "utf8" });
assert.equal(enclosingGit.status, 0, enclosingGit.stderr);
const isolatedHome = join(temporary, "home");
const uvCopier = join(isolatedHome, ".local", "share", "uv", "tools", "copier", "bin", "copier");
const userCopier = join(isolatedHome, ".local", "bin", "copier");
const fakeBin = join(temporary, "bin");
const registryPath = join(temporary, "projects.yaml");
const providerAdapters = join(temporary, "providers");
const effectLog = join(temporary, "effects.log");
const providerLog = join(temporary, "provider.log");
const templateConfig = join(isolatedHome, ".config", "hermes-agent-template", "config.toml");
const fleetHome = join(isolatedHome, ".hermes");
const fakeHermes = join(fakeBin, "hermes");
const pjanglerWrapper = join(fakeBin, "pj");
const fixtureRoot = join(temporary, "fixtures");
const selectedBmadPack = createBmadPackFixture(fixtureRoot);
const selectedBmadInstaller = createBmadInstallerFixture(fixtureRoot);

function executable(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

mkdirSync(dirname(uvCopier), { recursive: true });
copyFileSync(realpathSync(installed.stdout.trim()), uvCopier);
chmodSync(uvCopier, 0o755);
mkdirSync(dirname(userCopier), { recursive: true });
symlinkSync(uvCopier, userCopier);

executable(fakeHermes, `#!/bin/sh
printf 'local-hermes:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
if [ "$1" = profile ] && [ "$2" = create ]; then
  mkdir -p "$HOME/.hermes/profiles/$3"
fi
exit 0
`);

executable(pjanglerWrapper, `#!/bin/sh
printf 'runtime-migrate:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
exec "${process.execPath}" "${join(root, "dist", "index.js")}" "$@"
`);

executable(join(fakeBin, "systemctl"), `#!/bin/sh
printf 'systemctl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
case "$*" in
  *is-system-running*) printf '%s\n' running; exit 0 ;;
  *is-active*consumer.service*) printf '%s\n' inactive; exit 4 ;;
  *is-enabled*consumer.service*) printf '%s\n' not-found; exit 4 ;;
  *is-active*) printf '%s\n' active; exit 0 ;;
  *is-enabled*) printf '%s\n' enabled; exit 0 ;;
esac
exit 0
`);

executable(join(providerAdapters, "plane.sh"), `#!/bin/sh
printf 'provider:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
printf 'provider:%s\n' "$*" >> "$PJAN67_PROVIDER_LOG"
printf '%s\n' '{"board_id":"trusted-positive-board"}'
`);
copyFileSync(join(providerAdapters, "plane.sh"), join(providerAdapters, "trello.sh"));
chmodSync(join(providerAdapters, "trello.sh"), 0o755);

executable(join(fakeBin, "curl"), `#!/bin/sh
printf 'curl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
printf 'curl:%s\n' "$*" >> "$PJAN67_PROVIDER_LOG"
case "$*" in
  *'-X GET'*) printf '%s\n' '{"results":[]}' ;;
  *'-X POST'*) printf '%s\n' '{"id":"trusted-positive-board"}' ;;
  *) printf '%s\n' '{}' ;;
esac
`);

mkdirSync(dirname(templateConfig), { recursive: true });
const bmadCache = join(isolatedHome, ".cache", "pjangler", "bmad-dist-tags.json");
mkdirSync(dirname(bmadCache), { recursive: true });
writeFileSync(bmadCache, JSON.stringify({
  fetchedAt: Date.now(),
  distTags: { next: BMAD_INSTALLER_FIXTURE_VERSION, latest: BMAD_INSTALLER_FIXTURE_VERSION },
}), "utf8");
writeFileSync(templateConfig, `[fleet]
hermes_bin = "${fakeHermes}"
hermes_repo = "${join(temporary, "hermes-agent") }"
pjangler_bin = "${pjanglerWrapper}"
hermes_git_url = "https://example.invalid/hermes.git"
hermes_git_ref = "main"
hermes_git_sha = "0000000000000000000000000000000000000000"
runtime_scaffold_dir = "${join(temporary, "runtime-scaffold") }"
fleet_env = "${join(fleetHome, "fleet.env") }"
registry_file = "${join(fleetHome, "agents-registry.yaml") }"
oauth_file = "${join(fleetHome, "auth.json") }"
codex_home = "${join(isolatedHome, ".codex") }"
canonical_skills_dir = "${join(temporary, "skills") }"
canonical_pm_config = "${join(fleetHome, "config.yaml") }"
symlinked_runtime_skills = []

[github]
runtime_repo_owner = ""

[plane]
base = "https://plane.example.invalid"
workspace = "test"
`, "utf8");

const serverEnv = {
  ...process.env,
  HOME: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, ".config"),
  PATH: `${dirname(userCopier)}:${fakeBin}:${process.env.PATH}`,
  HERMES_TEMPLATE_CONFIG: templateConfig,
  HERMES_FLEET_HOME: fleetHome,
  HERMES_FLEET_ENV: join(fleetHome, "fleet.env"),
  HERMES_FLEET_REGISTRY_FILE: join(fleetHome, "agents-registry.yaml"),
  HERMES_BIN: fakeHermes,
  HERMES_AGENT_REPO: join(temporary, "hermes-agent"),
  PJANGLER_BIN: pjanglerWrapper,
  PJ_PROJECT_REGISTRY: registryPath,
  PJ_BMAD_PACK_ROOT: selectedBmadPack,
  PJ_BMAD_INSTALLER: selectedBmadInstaller,
  PJ_TICKET_PROVIDER_ADAPTERS: providerAdapters,
  PLANE_API_KEY: "trusted-positive-test-key",
  TRELLO_KEY: "trusted-positive-test-key",
  TRELLO_TOKEN: "trusted-positive-test-token",
  PJAN67_EFFECT_LOG: effectLog,
  PJAN67_PROVIDER_LOG: providerLog,
};

function assertEnclosingProjectUntouched(label) {
  assert.equal(
    readFileSync(enclosingProjectManifest, "utf8"),
    enclosingProjectManifestBefore,
    `${label}: provisioning must not climb into an enclosing checkout manifest`,
  );
}

function payload(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string", JSON.stringify(result));
  return JSON.parse(text);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: serverEnv,
});
const client = new Client({ name: "pjan-67-trusted-positive", version: "1.0.0" });

try {
  await client.connect(transport);
  const target = join(temporary, "trusted-project");
  const createdResult = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      targetDir: target,
      projectName: "trusted-project",
      projectSlug: "trusted-project",
      dryRun: false,
      skipPlane: true,
    },
  });
  const created = payload(createdResult);
  assert.notEqual(createdResult.isError, true, JSON.stringify(created));
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  assert.equal(created.audit?.ok, true, JSON.stringify(created.audit?.rules?.filter((rule) => !["pass", "skip"].includes(rule.status))));
  assert.equal(existsSync(join(target, ".project.json")), true);
  assertEnclosingProjectUntouched("trusted project create");

  const copierAnswersBefore = readFileSync(join(target, ".copier-answers.yml"), "utf8");
  rmSync(join(target, ".project.json"));
  const syncedResult = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "trusted-project",
      targetDir: target,
      slug: "trusted-project",
      apply: true,
      skipPlane: true,
    },
  });
  const synced = payload(syncedResult);
  assert.notEqual(syncedResult.isError, true, JSON.stringify(synced));
  assert.equal(synced.ok, true, JSON.stringify(synced.errors));
  assert.equal(synced.mode, "sync");
  assert.equal(readFileSync(join(target, ".copier-answers.yml"), "utf8"), copierAnswersBefore, "existing sync must not rerun Copier");
  assertEnclosingProjectUntouched("trusted project sync");

  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  const deployedResult = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: {
      targetDir: target,
      targetRepo: "trusted-project",
      role: "director",
      apply: true,
      local: false,
      live: true,
      provisionRuntimeRepo: true,
      provisionTicketBoard: true,
      enableSystemd: true,
      ticketProvider: "plane",
    },
  });
  const deployed = payload(deployedResult);
  assert.notEqual(deployedResult.isError, true, JSON.stringify(deployed));
  assert.equal(deployed.success, true, JSON.stringify(deployed.errors));
  const effectText = readFileSync(effectLog, "utf8");
  assert.equal((readFileSync(providerLog, "utf8").match(/-X POST/g) ?? []).length, 1, "the granted board provider must create exactly once");
  assert.match(effectText, /runtime-migrate:/, "the granted runtime phase must execute");
  assert.match(effectText, /systemctl:--user enable --now/, "the granted systemd phase must execute");
  const deferredSummary = deployed.logs.find((line) => line.includes("Applied deferred Hermes external effects")) ?? "";
  for (const script of ["20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    assert.equal((deferredSummary.match(new RegExp(script.replace(".", "\\."), "g")) ?? []).length, 1, `${script} must be dispatched exactly once`);
  }
  assert.ok(effectText.indexOf("local-hermes:") < effectText.indexOf("curl:-fsS"), "local rendering must precede the deferred provider effect");
  const deployedRole = YAML.parse(readFileSync(join(target, "agents", "hermes", "director", "role.yaml"), "utf8"));
  assert.equal(deployedRole.deployment.local_only, false, "successful live deployment must clear temporary local-only metadata");
  assert.equal(deployedRole.deployment.systemd, "required", "successful systemd grant must persist required deployment metadata");
  assertEnclosingProjectUntouched("trusted dedicated Hermes deploy");

  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  const projectTailTarget = join(temporary, "trusted-project-tail");
  const projectTailResult = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      targetDir: projectTailTarget,
      projectName: "trusted-project-tail",
      projectSlug: "trusted-project-tail",
      projectIdentifier: "TAIL",
      dryRun: false,
      provisionAgent: true,
      agentRole: "director",
      local: false,
      live: true,
      provisionRuntimeRepo: true,
      provisionTicketBoard: true,
      enableSystemd: true,
      skipPlane: false,
      ticketProvider: "trello",
    },
  });
  const projectTail = payload(projectTailResult);
  assert.notEqual(projectTailResult.isError, true, JSON.stringify(projectTail));
  assert.equal(projectTail.ok, true, JSON.stringify(projectTail.errors));
  const phaseIds = projectTail.phases.map((phase) => phase.id);
  const eligibilityIndex = phaseIds.indexOf("project.audit:eligibility");
  const gitIndex = phaseIds.indexOf("project.git");
  const providerIndex = phaseIds.indexOf("project.external:ticket-provider");
  const hermesIndex = phaseIds.indexOf("project.external:hermes");
  const postconditionIndex = phaseIds.indexOf("project.audit");
  assert.ok(
    eligibilityIndex >= 0 && eligibilityIndex < gitIndex && gitIndex < providerIndex,
    "project eligibility and ordinary local Git work must complete before the provider tail",
  );
  assert.ok(providerIndex < hermesIndex && hermesIndex < postconditionIndex, "project external phases must precede only the read-only postcondition audit");
  assert.equal((readFileSync(providerLog, "utf8").match(/create_board/g) ?? []).length, 1, "project-owned board grant must invoke its adapter exactly once");
  const projectDeferredSummary = projectTail.logs.find((line) => line.includes("Applied deferred Hermes external effects")) ?? "";
  for (const script of ["20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    assert.equal((projectDeferredSummary.match(new RegExp(script.replace(".", "\\."), "g")) ?? []).length, 1, `project owner must dispatch ${script} exactly once`);
  }
  const projectRole = YAML.parse(readFileSync(join(projectTailTarget, "agents", "hermes", "director", "role.yaml"), "utf8"));
  assert.equal(projectRole.deployment.local_only, false);
  assert.equal(projectRole.deployment.systemd, "required");
  assertEnclosingProjectUntouched("trusted project-owned Hermes deploy");

  console.log("PJAN-67 trusted Copier create/sync/deferred-external regressions: PASS");
} finally {
  await client.close().catch(() => undefined);
  rmSync(temporary, { recursive: true, force: true });
}
