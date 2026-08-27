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
  createSkillPackFixture,
} from "./helpers/pack-fixture.mjs";
import { writeFleetBaseConfig } from "./helpers/fleet-base-config.mjs";
import {
  committedSubmoduleGitlink,
  materializeCommittedSubmodule,
  materializeGitCommit,
  readGitCommitFile,
} from "./helpers/committed-submodule.mjs";

const root = resolve(import.meta.dirname, "..");
const installed = spawnSync("which", ["copier"], { encoding: "utf8" });
if (installed.status !== 0 || !installed.stdout.trim()) {
  console.log("PJAN-67 trusted lifecycle integration: SKIP (Copier is not installed)");
  process.exit(0);
}
const installedPython = spawnSync("which", ["python3"], { encoding: "utf8" });
assert.equal(installedPython.status, 0, installedPython.stderr);
const realPython = realpathSync(installedPython.stdout.trim());

const temporary = mkdtempSync(join(root, ".pjan-67-trusted-lifecycle-"));
const fixturePjanglerRoot = join(temporary, "committed-parent-fixture");
mkdirSync(join(fixturePjanglerRoot, "dist"), { recursive: true });
copyFileSync(join(root, "package.json"), join(fixturePjanglerRoot, "package.json"));
copyFileSync(join(root, "dist", "index.js"), join(fixturePjanglerRoot, "dist", "index.js"));
copyFileSync(join(root, "dist", "mcp-server.js"), join(fixturePjanglerRoot, "dist", "mcp-server.js"));
const fixtureVersioning = join(fixturePjanglerRoot, ".mise", "scripts", "versioning.sh");
mkdirSync(dirname(fixtureVersioning), { recursive: true });
writeFileSync(fixtureVersioning, readGitCommitFile(root, "HEAD", ".mise/scripts/versioning.sh"), "utf8");
chmodSync(fixtureVersioning, 0o755);
materializeCommittedSubmodule(
  root,
  "templates/commonproject",
  join(fixturePjanglerRoot, "templates", "commonproject"),
);

// Build the Hermes fixture from the parent HEAD gitlink through git archive.
// Deliberately dirty an independent source checkout first: neither that byte
// nor the advanced shared submodule worktree may influence this lifecycle run.
const HERMES_GITLINK = committedSubmoduleGitlink(root, "templates/hermes-agent");
const dirtyHermesSource = join(temporary, "dirty-hermes-source");
const clonedHermes = spawnSync(
  "git",
  ["clone", "--quiet", "--no-hardlinks", join(root, "templates", "hermes-agent"), dirtyHermesSource],
  { cwd: root, encoding: "utf8" },
);
assert.equal(clonedHermes.status, 0, clonedHermes.stderr);
writeFileSync(join(dirtyHermesSource, "copier.yml"), "PJAN-67 DIRTY WORKTREE SENTINEL\n");
assert.match(
  spawnSync("git", ["status", "--short"], { cwd: dirtyHermesSource, encoding: "utf8" }).stdout,
  /copier\.yml/,
);
const committedHermesTemplate = join(fixturePjanglerRoot, "templates", "hermes-agent");
materializeGitCommit(dirtyHermesSource, HERMES_GITLINK, committedHermesTemplate);
assert.doesNotMatch(readFileSync(join(committedHermesTemplate, "copier.yml"), "utf8"), /DIRTY WORKTREE SENTINEL/);

const serverPath = join(fixturePjanglerRoot, "dist", "mcp-server.js");
const enclosingProjectManifest = join(temporary, ".project.json");
const enclosingProjectManifestBefore = '{"project_name":"PJAN-67 enclosing sentinel","agents":{}}\n';
writeFileSync(enclosingProjectManifest, enclosingProjectManifestBefore, "utf8");
const enclosingGit = spawnSync("git", ["init", "--quiet"], { cwd: temporary, encoding: "utf8" });
assert.equal(enclosingGit.status, 0, enclosingGit.stderr);
const isolatedHome = join(temporary, "home");
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
const selectedBmadPack = createSkillPackFixture(fixtureRoot);
const selectedBmadInstaller = createBmadInstallerFixture(fixtureRoot);
const fleetAuthoritySentinel = "fleet-rehydrated-sentinel";

function executable(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

executable(fakeHermes, `#!/bin/sh
printf 'local-hermes:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:hermes:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
if [ "$1" = profile ] && [ "$2" = create ]; then
  mkdir -p "$HOME/.hermes/profiles/$3"
fi
exit 0
`);

executable(pjanglerWrapper, `#!/bin/sh
printf 'runtime-migrate:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:pjangler:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
exec "${process.execPath}" "${join(fixturePjanglerRoot, "dist", "index.js")}" "$@"
`);

executable(join(fakeBin, "python3"), `#!/bin/sh
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:python3:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
exec "${realPython}" "$@"
`);

executable(join(fakeBin, "systemctl"), `#!/bin/sh
printf 'systemctl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:systemctl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
case "$*" in
  *is-system-running*) printf '%s\n' running; exit 0 ;;
  *is-active*consumer.service*) printf '%s\n' inactive; exit 4 ;;
  *is-enabled*consumer.service*) printf '%s\n' not-found; exit 4 ;;
  *is-active*gateway.service*) printf '%s\n' inactive; exit 3 ;;
  *is-enabled*gateway.service*) printf '%s\n' disabled; exit 1 ;;
  *show*heartbeat.timer*)
    printf '%s\n' 'LoadState=loaded' 'ActiveState=active' 'SubState=waiting'; exit 0 ;;
  *show*heartbeat.service*)
    printf '%s\n' 'LoadState=loaded' 'ActiveState=inactive' 'SubState=dead' \
      'Result=success' 'ExecMainStatus=0' 'NRestarts=0' \
      'ExecMainStartTimestampMonotonic=100' 'ExecMainExitTimestampMonotonic=200'; exit 0 ;;
  *show*gateway.service*)
    printf '%s\n' 'LoadState=loaded' 'ActiveState=active' 'SubState=running' \
      'Result=success' 'ExecMainStatus=0' 'NRestarts=0'; exit 0 ;;
  *is-active*) printf '%s\n' active; exit 0 ;;
  *is-enabled*) printf '%s\n' enabled; exit 0 ;;
esac
exit 0
`);

executable(join(providerAdapters, "plane.sh"), `#!/bin/sh
printf 'provider:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
printf 'provider:%s\n' "$*" >> "$PJAN67_PROVIDER_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:provider:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
printf '%s\n' '{"board_id":"trusted-positive-board"}'
`);
copyFileSync(join(providerAdapters, "plane.sh"), join(providerAdapters, "trello.sh"));
chmodSync(join(providerAdapters, "trello.sh"), 0o755);

executable(join(fakeBin, "curl"), `#!/bin/sh
printf 'curl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
printf 'curl:%s\n' "$*" >> "$PJAN67_PROVIDER_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:curl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
case "$*" in
  *'-X GET'*projects/trusted-positive-board/*)
    printf '%s\n' '{"id":"trusted-positive-board","identifier":"TRUST"}' ;;
  *'-X GET'*) printf '%s\n' '{"results":[]}' ;;
  *'-X POST'*) printf '%s\n' '{"id":"trusted-positive-board","identifier":"TRUST"}' ;;
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
for (const skill of [
  "33god-projects",
  "delonet-conventions",
  "delonet-dotenv",
  "hermes-pm-template-maintenance",
  "hindsight",
  "subagent-driven-development",
]) {
  const skillDir = join(temporary, "skills", skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\ndescription: PJAN-67 trusted fixture\n---\n`);
}
mkdirSync(fleetHome, { recursive: true });
// See tests/helpers/fleet-base-config.mjs: the fleet base is operator-owned, so
// a sandboxed HOME has none and hermes.fleet-config fails on it.
writeFleetBaseConfig(fleetHome, isolatedHome);
writeFileSync(join(fleetHome, "fleet.env"), [
  `export PLANE_API_KEY=${fleetAuthoritySentinel}`,
  `export PLANE_33GOD_API_KEY=${fleetAuthoritySentinel}`,
  `export PLANE_DYNAMIC_WORKSPACE_API_KEY=${fleetAuthoritySentinel}`,
  `export TRELLO_KEY=${fleetAuthoritySentinel}`,
  `export TRELLO_TOKEN=${fleetAuthoritySentinel}`,
  `export LINEAR_API_KEY=${fleetAuthoritySentinel}`,
  "",
].join("\n"), "utf8");

const serverEnv = {
  ...process.env,
  HOME: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, ".config"),
  // Provenance is anchored to the OS account, not ambient HOME. Execute the
  // actual metadata-bound UV tool while keeping all runtime/host state inside
  // the isolated HOME fixture.
  PATH: `${dirname(installed.stdout.trim())}:${fakeBin}:${process.env.PATH}`,
  HERMES_TEMPLATE_CONFIG: templateConfig,
  HERMES_FLEET_HOME: fleetHome,
  HERMES_FLEET_ENV: join(fleetHome, "fleet.env"),
  HERMES_FLEET_REGISTRY_FILE: join(fleetHome, "agents-registry.yaml"),
  HERMES_BIN: fakeHermes,
  HERMES_AGENT_REPO: join(temporary, "hermes-agent"),
  PJANGLER_BIN: pjanglerWrapper,
  PJANGLER_HERMES_TEMPLATE: "",
  PJ_PROJECT_REGISTRY: registryPath,
  PJ_PACK_ROOT_PJTEST: selectedBmadPack,
  PJ_BMAD_INSTALLER: selectedBmadInstaller,
  PJ_TICKET_PROVIDER_ADAPTERS: providerAdapters,
  PLANE_API_KEY: "trusted-positive-test-key",
  TRELLO_KEY: "trusted-positive-test-key",
  TRELLO_TOKEN: "trusted-positive-test-token",
  PJAN67_EFFECT_LOG: effectLog,
  PJAN67_PROVIDER_LOG: providerLog,
  SYSTEMD_STABILIZATION_ATTEMPTS: "3",
  SYSTEMD_STABLE_SAMPLES: "3",
  SYSTEMD_STABILIZATION_INTERVAL_SECONDS: "0",
};

function assertEnclosingProjectUntouched(label) {
  assert.equal(
    readFileSync(enclosingProjectManifest, "utf8"),
    enclosingProjectManifestBefore,
    `${label}: provisioning must not climb into an enclosing checkout manifest`,
  );
}

function assertNoUngrantAuthority(label) {
  const effects = existsSync(effectLog) ? readFileSync(effectLog, "utf8") : "";
  assert.doesNotMatch(effects, /authority-visible:/, `${label}: FLEET_ENV provider authority must not reach any child`);
  assert.equal(existsSync(providerLog), false, `${label}: no-board grant must invoke no provider`);
}

function payload(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string", JSON.stringify(result));
  return JSON.parse(text);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: fixturePjanglerRoot,
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

  // Every MCP entry point that can reach Hermes must keep the no-board grant
  // authoritative even after the real rendered _lib.sh sources fleet.env.
  // Child wrappers observe the entire environment without relying on source
  // text assertions, and the fleet sentinel is deliberately absent from the
  // parent MCP process environment.
  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  const dedicatedNoBoardResult = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: {
      targetDir: target,
      targetRepo: "trusted-project",
      role: "authority-dedicated",
      apply: true,
      local: true,
      live: false,
      skipPlane: true,
    },
  });
  const dedicatedNoBoard = payload(dedicatedNoBoardResult);
  assert.equal(typeof dedicatedNoBoard.success, "boolean", JSON.stringify(dedicatedNoBoard));
  assertNoUngrantAuthority("dedicated Hermes no-board path");
  assertEnclosingProjectUntouched("dedicated Hermes no-board path");

  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  const projectInitNoBoardTarget = join(temporary, "authority-project-init");
  const projectInitNoBoardResult = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Authority Project Init",
      targetDir: projectInitNoBoardTarget,
      slug: "authority-project-init",
      provisionAgent: true,
      agentRole: "authority-project-init",
      apply: true,
      live: false,
      skipPlane: true,
    },
  });
  const projectInitNoBoard = payload(projectInitNoBoardResult);
  assert.equal(typeof projectInitNoBoard.ok, "boolean", JSON.stringify(projectInitNoBoard));
  assertNoUngrantAuthority("project-init no-board path");
  assertEnclosingProjectUntouched("project-init no-board path");

  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  const bootstrapNoBoardTarget = join(temporary, "authority-bootstrap");
  const bootstrapNoBoardResult = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      targetDir: bootstrapNoBoardTarget,
      projectName: "Authority Bootstrap",
      projectSlug: "authority-bootstrap",
      provisionAgent: true,
      agentRole: "authority-bootstrap",
      dryRun: false,
      local: true,
      live: false,
      skipPlane: true,
    },
  });
  const bootstrapNoBoard = payload(bootstrapNoBoardResult);
  assert.equal(typeof bootstrapNoBoard.ok, "boolean", JSON.stringify(bootstrapNoBoard));
  assertNoUngrantAuthority("bootstrap no-board path");
  assertEnclosingProjectUntouched("bootstrap no-board path");

  // A readable empty fleet registry makes registry parity repairable, allowing
  // the selected non-board external tail itself (rather than an earlier
  // lifecycle blocker) to be exercised.
  writeFileSync(join(fleetHome, "agents-registry.yaml"), "agents: {}\n", "utf8");
  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  const dedicatedNoBoardExternalResult = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: {
      targetDir: target,
      targetRepo: "trusted-project",
      role: "authority-external",
      apply: true,
      local: false,
      live: true,
      // Deprecated compatibility input: deliberately true to prove it cannot
      // arm a remote runtime effect; role-local convergence is unconditional.
      provisionRuntimeRepo: true,
      enableSystemd: true,
      skipPlane: true,
    },
  });
  const dedicatedNoBoardExternal = payload(dedicatedNoBoardExternalResult);
  assert.notEqual(dedicatedNoBoardExternalResult.isError, true, JSON.stringify(dedicatedNoBoardExternal));
  assert.equal(dedicatedNoBoardExternal.success, true, JSON.stringify(dedicatedNoBoardExternal));
  const noBoardExternalEffects = readFileSync(effectLog, "utf8");
  assert.match(noBoardExternalEffects, /runtime-migrate:/, "required role-local runtime convergence must run before external dispatch");
  assert.match(noBoardExternalEffects, /systemctl:--user enable --now/, "non-board systemd grant must reach its selected child");
  assertNoUngrantAuthority("dedicated Hermes selected non-board external path");
  assertEnclosingProjectUntouched("dedicated Hermes selected non-board external path");

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
  assert.match(effectText, /runtime-migrate:/, "required role-local runtime convergence must execute");
  assert.match(effectText, /systemctl:--user enable --now/, "the granted systemd phase must execute");
  const hostSummary = deployed.logs.find((line) => line.includes("Applied deferred Hermes host effects")) ?? "";
  assert.equal((hostSummary.match(/20-runtime-repo\.sh/g) ?? []).length, 1, "role-local runtime must be a required host/local phase");
  const deferredSummary = deployed.logs.find((line) => line.includes("Applied deferred Hermes external effects")) ?? "";
  assert.doesNotMatch(deferredSummary, /20-runtime-repo\.sh/, "external consent must not dispatch the retired runtime-repo effect");
  for (const script of ["42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
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
  const projectHostSummary = projectTail.logs.find((line) => line.includes("Applied deferred Hermes host effects")) ?? "";
  assert.equal((projectHostSummary.match(/20-runtime-repo\.sh/g) ?? []).length, 1, "project-owned role-local runtime must be a required host/local phase");
  const projectDeferredSummary = projectTail.logs.find((line) => line.includes("Applied deferred Hermes external effects")) ?? "";
  assert.doesNotMatch(projectDeferredSummary, /20-runtime-repo\.sh/, "project external consent must not dispatch a runtime repository");
  for (const script of ["42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
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
