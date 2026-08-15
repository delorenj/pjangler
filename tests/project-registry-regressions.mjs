import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { createBmadInstallerFixture, createBmadPackFixture } from "./helpers/bmad-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
let portableLifecycleEnv = {};

function spawnCli(args, env, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...portableLifecycleEnv, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
}

function run(args, env, cwd = root) {
  const result = spawnCli(args, env, cwd);
  if (result.status !== 0) {
    let summary = result.stdout;
    try {
      const payload = JSON.parse(result.stdout);
      summary = JSON.stringify({ ok: payload.ok, errors: payload.errors, failedRules: payload.audit?.rules?.filter((rule) => !["pass", "skip"].includes(rule.status)) }, null, 2);
    } catch {
      // Preserve raw output for commands that are intentionally not JSON.
    }
    throw new Error(`command failed: ${process.execPath} ${cli} ${args.join(" ")}\nstdout:\n${summary}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runExpectFailure(args, env) {
  const result = spawnCli(args, env);
  if (result.status === 0) {
    throw new Error(`expected failure: ${process.execPath} ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}`);
  }
  return result;
}

function failureOutput(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function createSkillFixture(baseDir) {
  const skillDir = join(baseDir, "skills", "civilwar-letterifier");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: civilwar-letterifier\n---\n# Civil War Letterifier\n", "utf8");
  return skillDir;
}

function createFakeHermes(homeDir) {
  const hermesRepo = join(homeDir, "code", "hermes-agent");
  const hermesBin = join(hermesRepo, "venv", "bin", "hermes");
  const callsFile = join(homeDir, "fake-hermes-calls.jsonl");
  mkdirSync(dirname(hermesBin), { recursive: true });
  writeFileSync(hermesBin, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const callsFile = process.env.FAKE_HERMES_CALLS;
const profileCreate = args.length === 5 && args[0] === "profile" && args[1] === "create" && args[2] && args[3] === "--clone" && args[4] === "--no-alias";
const configSet = args.length === 4 && args[0] === "config" && args[1] === "set" && process.env.HERMES_HOME;
if (!callsFile || (!profileCreate && !configSet)) {
  process.stderr.write("fake hermes: unsupported invocation: " + JSON.stringify(args) + "\\n");
  process.exit(64);
}
fs.appendFileSync(callsFile, JSON.stringify({
  args,
  bin: path.resolve(process.argv[1]),
  hermes_home: process.env.HERMES_HOME || "",
  home: process.env.HOME || "",
}) + "\\n");

if (profileCreate) {
  const fleetHome = path.join(process.env.HOME, ".hermes");
  const profileHome = path.join(fleetHome, "profiles", args[2]);
  if (fs.existsSync(profileHome)) {
    process.stderr.write("fake hermes: profile already exists: " + profileHome + "\\n");
    process.exit(65);
  }
  fs.mkdirSync(profileHome, { recursive: true });
  fs.mkdirSync(path.join(fleetHome, "skills"), { recursive: true });
  for (const [name, contents] of [["config.yaml", "{}\\n"], [".env", "\\n"]]) {
    const shared = path.join(fleetHome, name);
    if (!fs.existsSync(shared)) fs.writeFileSync(shared, contents);
    fs.copyFileSync(shared, path.join(profileHome, name));
  }
  process.exit(0);
}

const configPath = path.join(process.env.HERMES_HOME, "config.yaml");
fs.mkdirSync(process.env.HERMES_HOME, { recursive: true });
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
let cursor = config;
const parts = args[2].split(".");
for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
cursor[parts.at(-1)] = args[3];
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
`, "utf8");
  chmodSync(hermesBin, 0o755);
  return { hermesBin, hermesRepo, callsFile };
}

function readFakeHermesCalls(callsFile) {
  if (!existsSync(callsFile)) return [];
  return readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

const tmp = mkdtempSync(join(tmpdir(), "pjangler-project-registry-"));
try {
  const fixtureRoot = join(tmp, "bmad-fixtures");
  portableLifecycleEnv = {
    HOME: join(tmp, "isolated-home"),
    XDG_CACHE_HOME: join(tmp, "isolated-home", ".cache"),
    XDG_CONFIG_HOME: join(tmp, "isolated-home", ".config"),
    PJ_BMAD_PACK_ROOT: createBmadPackFixture(fixtureRoot),
    PJ_BMAD_INSTALLER: createBmadInstallerFixture(fixtureRoot),
    npm_config_cache: join(tmp, "empty-npm-cache"),
    npm_config_offline: "true",
  };
  const projectSource = readFileSync(join(root, "src", "project", "index.ts"), "utf8");
  assert.doesNotMatch(projectSource, /CoachingAgentFramework/, "generic source-skill lookup must not hard-code project-local skill roots");

  const registryPath = join(tmp, "projects.yaml");
  const targetDir = join(tmp, "SlowBurns");
  const sourceSkill = createSkillFixture(tmp);
  const extraSkillRoot = join(tmp, "extra-source-skills");
  const envOnlySkill = join(extraSkillRoot, "env-only-skill");
  mkdirSync(envOnlySkill, { recursive: true });
  writeFileSync(join(envOnlySkill, "SKILL.md"), "---\nname: env-only-skill\n---\n# Env Only Skill\n", "utf8");
  const env = { PJ_PROJECT_REGISTRY: registryPath };

  const dryRun = JSON.parse(run([
    "project",
    "init",
    "SlowBurns",
    "--description",
    "Civil War letterification experiments",
    "--target-dir",
    targetDir,
    "--source-skill",
    sourceSkill,
    "--json",
  ], env));
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.project.slug, "slowburns");
  assert.equal(dryRun.project.ticket_provider.identifier, "SLOW");
  assert.equal(dryRun.project.source_artifacts[0].path, sourceSkill);
  // PJAN-26: a newly created project record is "active", not "planned".
  assert.equal(dryRun.project.status, "active", "a new project record must default to status active");
  assert.deepEqual(dryRun.project.agents, {}, "default dry-run must not record a planned agent");
  assert.ok(dryRun.actions.some((action) => action.kind === "registry.upsert"));
  assert.ok(dryRun.actions.some((action) => action.kind === "copier.copy.commonproject"));
  assert.ok(dryRun.actions.some((action) => action.kind === "project.write-manifest"));
  assert.equal(existsSync(registryPath), false, "dry-run must not write the registry");
  assert.equal(existsSync(targetDir), false, "dry-run must not render the project");

  const envRootDryRun = JSON.parse(run([
    "project",
    "init",
    "EnvRootSkill",
    "--description",
    "Skill located through an explicit root override",
    "--target-dir",
    join(tmp, "EnvRootSkill"),
    "--source-skill",
    "env-only-skill",
    "--registry",
    join(tmp, "env-root-projects.yaml"),
    "--json",
  ], { PJ_SOURCE_SKILL_ROOTS: extraSkillRoot }));
  assert.equal(envRootDryRun.project.source_artifacts[0].path, envOnlySkill);

  const nonGitParent = join(tmp, "non-git-parent");
  mkdirSync(nonGitParent);
  const nonGitTarget = join(nonGitParent, "FreshProject");
  const nonGitPlan = JSON.parse(run([
    "project",
    "init",
    "FreshProject",
    "--description",
    "Created from outside a git repo",
    "--target-dir",
    nonGitTarget,
    "--registry",
    join(tmp, "non-git-projects.yaml"),
    "--json",
  ], {}, nonGitParent));
  assert.equal(nonGitPlan.mode, "create");
  assert.equal(nonGitPlan.project.repo_path, nonGitTarget);
  assert.ok(nonGitPlan.actions.some((action) => action.kind === "copier.copy.commonproject"));
  assert.equal(existsSync(nonGitTarget), false, "non-git dry-run must not create the target directory");

  const applied = JSON.parse(run([
    "project",
    "init",
    "SlowBurns",
    "--description",
    "Civil War letterification experiments",
    "--target-dir",
    targetDir,
    "--source-skill",
    sourceSkill,
    "--apply",
    "--json",
  ], env));
  assert.equal(applied.ok, true, JSON.stringify(applied.errors));
  assert.equal(existsSync(registryPath), true, "apply must write the registry");
  assert.equal(existsSync(join(targetDir, ".project.json")), true, "apply must write the repo-local projection");
  assert.equal(existsSync(join(targetDir, "AGENTS.md")), true, "apply must render CommonProject files");

  const registry = YAML.parse(readFileSync(registryPath, "utf8"));
  assert.equal(registry.schema_version, 1);
  assert.equal(registry.projects.slowburns.name, "SlowBurns");
  assert.equal(registry.projects.slowburns.repo_path, targetDir);
  // PJAN-26: the persisted record for a new project is "active" …
  assert.equal(registry.projects.slowburns.status, "active", "apply must persist status active for a new project");
  // … but ticket_provider.state is a DIFFERENT lifecycle (planned -> linked)
  // and must still default to "planned" when no board is linked.
  assert.equal(registry.projects.slowburns.ticket_provider.state, "planned");
  assert.deepEqual(registry.projects.slowburns.agents, {}, "default apply must not register a planned agent");

  const manifest = JSON.parse(readFileSync(join(targetDir, ".project.json"), "utf8"));
  assert.equal(manifest.project_slug, "slowburns");
  assert.equal(manifest.ticket_provider.identifier, "SLOW");
  assert.equal(manifest.ticket_provider.state, "planned");
  assert.deepEqual(manifest.agents, {}, "default apply must not write a planned agent projection");
  assert.deepEqual(manifest.automation.reconcile, { enabled: false, grace_hours: 0, auto_review: true });

  const agentPlan = JSON.parse(run([
    "project",
    "init",
    "ReviewBot",
    "--description",
    "Reviewer agent role coverage",
    "--target-dir",
    join(tmp, "ReviewBot"),
    "--provision-agent",
    "--agent-role",
    "review",
    "--registry",
    join(tmp, "agent-role.yaml"),
    "--json",
  ], env));
  assert.equal(agentPlan.project.agents.review.role, "review");
  // PJAN-26 guard: agent provisioning_state is its own lifecycle
  // (planned -> provisioned) and must still default to "planned".
  assert.equal(agentPlan.project.agents.review.provisioning_state, "planned");
  assert.equal(agentPlan.actions.find((action) => action.kind === "hermes.provision-agent").role, "review");

  const listed = JSON.parse(run(["project", "list", "--json"], env));
  assert.equal(listed.projects.slowburns.repo_path, targetDir);

  const shown = JSON.parse(run(["project", "show", "slowburns", "--json"], env));
  assert.equal(shown.name, "SlowBurns");

  const doctor = JSON.parse(run(["project", "doctor", "slowburns", "--json"], env));
  assert.equal(doctor.ok, true);
  assert.deepEqual(doctor.checkedProjects, ["slowburns"]);

  const legacyRepo = join(tmp, "LegacyRepo");
  mkdirSync(legacyRepo);
  git(["init"], legacyRepo);
  writeFileSync(join(legacyRepo, "package.json"), JSON.stringify({ name: "legacy-repo", description: "Pre-pjangler repo" }, null, 2), "utf8");
  writeFileSync(join(legacyRepo, "AGENTS.md"), "# Legacy agent notes\n", "utf8");
  const legacyRegistry = join(tmp, "legacy-projects.yaml");
  const legacyEnv = { PJ_PROJECT_REGISTRY: legacyRegistry };
  const legacySync = JSON.parse(run([
    "project",
    "init",
    "--yes",
    "--apply",
    "--json",
  ], legacyEnv, legacyRepo));
  assert.equal(legacySync.ok, true, JSON.stringify(legacySync.errors));
  assert.equal(legacySync.mode, "sync");
  assert.equal(legacySync.plan.project.slug, "legacy-repo");
  assert.ok(!legacySync.plan.actions.some((action) => action.kind === "copier.copy.commonproject"), "legacy sync must not render the CommonProject copier over an existing repo");
  assert.ok(legacySync.selectedOperations.includes("registry.upsert"), "legacy sync should register the repo");
  assert.ok(legacySync.selectedParityRules.includes("sot.project-json"), "legacy sync should select .project.json parity");
  assert.equal(existsSync(join(legacyRepo, ".project.json")), true, "legacy sync must write .project.json");
  assert.equal(existsSync(legacyRegistry), true, "legacy sync must write the registry");

  const legacyRegistryData = YAML.parse(readFileSync(legacyRegistry, "utf8"));
  assert.equal(legacyRegistryData.projects["legacy-repo"].repo_path, legacyRepo);
  const legacyManifest = JSON.parse(readFileSync(join(legacyRepo, ".project.json"), "utf8"));
  assert.equal(legacyManifest.project_name, "Legacy Repo");
  assert.equal(legacyManifest.project_description, "Pre-pjangler repo");

  const legacySyncAgain = JSON.parse(run([
    "project",
    "init",
    "--yes",
    "--apply",
    "--json",
  ], legacyEnv, legacyRepo));
  assert.equal(legacySyncAgain.ok, true, JSON.stringify(legacySyncAgain.errors));
  assert.equal(legacySyncAgain.mode, "sync");
  assert.deepEqual(legacySyncAgain.changedFiles, [], "legacy sync must be idempotent");
  assert.deepEqual(legacySyncAgain.selectedOperations, [], "idempotent sync should have no selected work when already in parity");

  const emptyBin = join(tmp, "empty-bin");
  mkdirSync(emptyBin);
  const failedRegistryPath = join(tmp, "failed-apply.yaml");
  const failedTarget = join(tmp, "FailedApply");
  const failedApply = JSON.parse(runExpectFailure([
    "project",
    "init",
    "FailedApply",
    "--description",
    "Copier failure should stop dependent writes",
    "--target-dir",
    failedTarget,
    "--source-skill",
    sourceSkill,
    "--registry",
    failedRegistryPath,
    "--apply",
    "--json",
  ], { PATH: emptyBin }).stdout);
  assert.equal(failedApply.ok, false);
  assert.match(failedApply.errors.join("\n"), /copier not found/);
  assert.equal(existsSync(failedRegistryPath), false, "failed apply must not save the registry");
  assert.equal(existsSync(join(failedTarget, ".project.json")), false, "failed apply must not write the repo-local projection");

  const duplicate = runExpectFailure([
    "project",
    "init",
    "SlowBurns",
    "--description",
    "Duplicate",
    "--target-dir",
    join(tmp, "OtherSlowBurns"),
    "--json",
  ], env);
  assert.match(failureOutput(duplicate), /Project slug already exists/);

  const missingSkill = runExpectFailure([
    "project",
    "init",
    "SkillMiss",
    "--description",
    "Missing source skill",
    "--target-dir",
    join(tmp, "SkillMiss"),
    "--source-skill",
    join(tmp, "civilwar-letterifer"),
    "--json",
  ], { PJ_PROJECT_REGISTRY: join(tmp, "missing-skill.yaml") });
  assert.match(failureOutput(missingSkill), /Source skill not found/);
  assert.match(failureOutput(missingSkill), /civilwar-letterifer/);

  // Regression: sync must update .project.json when the planned manifest differs
  const syncUpdateRepo = join(tmp, "SyncUpdate");
  mkdirSync(syncUpdateRepo, { recursive: true });
  git(["init"], syncUpdateRepo);
  writeFileSync(join(syncUpdateRepo, "package.json"), JSON.stringify({ name: "sync-update", description: "Original description" }, null, 2), "utf8");
  const syncUpdateRegistry = join(tmp, "sync-update-projects.yaml");
  const syncUpdateEnv = { PJ_PROJECT_REGISTRY: syncUpdateRegistry };
  const syncUpdateFirst = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--json",
  ], syncUpdateEnv, syncUpdateRepo));
  assert.equal(syncUpdateFirst.ok, true, JSON.stringify(syncUpdateFirst.errors));
  const firstSyncManifest = JSON.parse(readFileSync(join(syncUpdateRepo, ".project.json"), "utf8"));
  assert.equal(firstSyncManifest.project_description, "Original description");

  const syncUpdateSecond = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--description", "Updated description", "--json",
  ], syncUpdateEnv, syncUpdateRepo));
  assert.equal(syncUpdateSecond.ok, true, JSON.stringify(syncUpdateSecond.errors));
  assert.ok(syncUpdateSecond.selectedOperations.includes("project.write-manifest"), "sync must select .project.json write when manifest differs");
  const secondSyncManifest = JSON.parse(readFileSync(join(syncUpdateRepo, ".project.json"), "utf8"));
  assert.equal(secondSyncManifest.project_description, "Updated description");

  // Regression: provisioning a second agent role must preserve existing agents.
  // The fake lives at the path discovered by EnsureTemplateConfig, so this exercises
  // the production HERMES_BIN/HERMES_AGENT_REPO resolution without a host checkout.
  const multiAgentRepo = join(tmp, "MultiAgent");
  mkdirSync(multiAgentRepo, { recursive: true });
  git(["init"], multiAgentRepo);
  writeFileSync(join(multiAgentRepo, "package.json"), JSON.stringify({ name: "multi-agent", description: "Multi agent test" }, null, 2), "utf8");
  const multiAgentRegistry = join(tmp, "multi-agent-projects.yaml");
  const multiAgentHome = join(tmp, "multi-agent-home");
  mkdirSync(multiAgentHome, { recursive: true });
  const { hermesBin: fakeHermesBin, hermesRepo: fakeHermesRepo, callsFile: fakeHermesCalls } = createFakeHermes(multiAgentHome);
  const fleetHome = join(multiAgentHome, ".hermes");
  const fleetRegistry = join(fleetHome, "agents-registry.yaml");
  const multiAgentEnv = {
    PJ_PROJECT_REGISTRY: multiAgentRegistry,
    HOME: multiAgentHome,
    XDG_CACHE_HOME: join(multiAgentHome, ".cache"),
    XDG_CONFIG_HOME: join(multiAgentHome, ".config"),
    HERMES_HOME: fleetHome,
    HERMES_FLEET_HOME: fleetHome,
    HERMES_TEMPLATE_CONFIG: "",
    HERMES_FLEET_ENV: "",
    HERMES_BIN: "",
    HERMES_FLEET_BIN: "",
    HERMES_AGENT_REPO: "",
    HERMES_FLEET_REPO: "",
    HERMES_OAUTH_FILE: "",
    CODEX_HOME: "",
    REGISTRY_FILE: "",
    PJANGLER_HERMES_TEMPLATE: "",
    FAKE_HERMES_CALLS: fakeHermesCalls,
    CANONICAL_SKILLS_DIR: join(multiAgentHome, "absent-canonical-skills"),
    VOXXY_PLUGIN_DIR: join(multiAgentHome, "absent-voxxy-plugin"),
    PLANE_API_KEY: "",
    PLANE_33GOD_API_KEY: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_ALLOWED_USERS: "",
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    SLACK_ALLOWED_USERS: "",
    SKIP_SLACK: "0",
    ENABLE_SLACK: "0",
  };
  const multiAgentFirst = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--provision-agent", "--agent-role", "pm", "--json",
  ], multiAgentEnv, multiAgentRepo));
  assert.equal(multiAgentFirst.ok, true, JSON.stringify(multiAgentFirst.errors));
  const firstMultiRegistry = YAML.parse(readFileSync(multiAgentRegistry, "utf8"));
  assert.equal(firstMultiRegistry.projects["multi-agent"].agents.pm.role, "pm");
  const firstFleetRegistry = YAML.parse(readFileSync(fleetRegistry, "utf8"));
  assert.equal(firstFleetRegistry.agents["multi-agent-pm"].hermes.bin, fakeHermesBin, "fleet registry must record the template-resolved Hermes binary");
  assert.equal(firstFleetRegistry.agents["multi-agent-pm"].hermes.repo, fakeHermesRepo, "fleet registry must record the matching Hermes checkout");
  assert.equal(firstFleetRegistry.agents["multi-agent-pm"].telegram.provisioning_status, "disabled");
  assert.equal(firstFleetRegistry.agents["multi-agent-pm"].slack.provisioning_status, "deferred");
  assert.deepEqual(
    YAML.parse(readFileSync(join(multiAgentRepo, "agents", "hermes", "pm", "role.yaml"), "utf8")).model,
    { provider: "", name: "", base_url: "", api_mode: "", key_env: "" },
    "noninteractive PM provisioning must explicitly render safe model-route defaults",
  );
  assert.equal(
    YAML.parse(readFileSync(join(multiAgentRepo, "agents", "hermes", "pm", "role.yaml"), "utf8")).bloodbank.enabled,
    false,
    "new PM Bloodbank ingress must remain quarantined",
  );

  const multiAgentSecond = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--provision-agent", "--agent-role", "director", "--json",
  ], multiAgentEnv, multiAgentRepo));
  assert.equal(multiAgentSecond.ok, true, JSON.stringify(multiAgentSecond.errors));
  const hermesCalls = readFakeHermesCalls(fakeHermesCalls);
  assert.deepEqual(hermesCalls, [
    {
      args: ["profile", "create", "multi-agent-pm", "--clone", "--no-alias"],
      bin: fakeHermesBin,
      hermes_home: fleetHome,
      home: multiAgentHome,
    },
    {
      args: ["profile", "create", "multi-agent-director", "--clone", "--no-alias"],
      bin: fakeHermesBin,
      hermes_home: fleetHome,
      home: multiAgentHome,
    },
  ], `provisioning must use only the portable Hermes profile contract\n${JSON.stringify(hermesCalls, null, 2)}`);
  const secondMultiRegistry = YAML.parse(readFileSync(multiAgentRegistry, "utf8"));
  assert.equal(secondMultiRegistry.projects["multi-agent"].agents.pm.role, "pm", "existing pm agent must be preserved in registry");
  assert.equal(secondMultiRegistry.projects["multi-agent"].agents.director.role, "director", "new director agent must be added to registry");
  const secondMultiManifest = JSON.parse(readFileSync(join(multiAgentRepo, ".project.json"), "utf8"));
  assert.equal(secondMultiManifest.agents["multi-agent-pm"].role, "pm", "existing pm agent must be preserved in manifest");
  assert.equal(secondMultiManifest.agents["multi-agent-director"].role, "director", "new director agent must be added to manifest");
  assert.deepEqual(
    YAML.parse(readFileSync(join(multiAgentRepo, "agents", "hermes", "director", "role.yaml"), "utf8")).model,
    { provider: "", name: "", base_url: "", api_mode: "", key_env: "" },
    "noninteractive Director provisioning must explicitly render safe model-route defaults",
  );
  assert.equal(
    YAML.parse(readFileSync(join(multiAgentRepo, "agents", "hermes", "director", "role.yaml"), "utf8")).bloodbank.enabled,
    false,
    "new Director Bloodbank ingress must remain quarantined",
  );
  const secondFleetRegistry = YAML.parse(readFileSync(fleetRegistry, "utf8"));
  assert.deepEqual(Object.keys(secondFleetRegistry.agents).sort(), ["multi-agent-director", "multi-agent-pm"], "both isolated fleet profiles must be registered");
  assert.equal(secondFleetRegistry.agents["multi-agent-pm"].bloodbank.enabled, false);
  assert.equal(secondFleetRegistry.agents["multi-agent-director"].bloodbank.enabled, false);

  // PJAN-26: "active" is a default for NEW records, never a migration.
  // A project already recorded as "planned" keeps that status through a load
  // and through an unrelated update (sync re-init with a new description).
  const legacyStatusRepo = join(tmp, "LegacyStatus");
  mkdirSync(legacyStatusRepo, { recursive: true });
  git(["init"], legacyStatusRepo);
  writeFileSync(join(legacyStatusRepo, "package.json"), JSON.stringify({ name: "legacy-status", description: "Original description" }, null, 2), "utf8");
  const legacyStatusRegistry = join(tmp, "legacy-status-projects.yaml");
  const legacyStatusEnv = { PJ_PROJECT_REGISTRY: legacyStatusRegistry };
  const legacyStatusFirst = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--json",
  ], legacyStatusEnv, legacyStatusRepo));
  assert.equal(legacyStatusFirst.ok, true, JSON.stringify(legacyStatusFirst.errors));
  assert.equal(YAML.parse(readFileSync(legacyStatusRegistry, "utf8")).projects["legacy-status"].status, "active");

  // Simulate a pre-PJAN-26 row that was recorded as "planned".
  const legacyStatusData = YAML.parse(readFileSync(legacyStatusRegistry, "utf8"));
  legacyStatusData.projects["legacy-status"].status = "planned";
  writeFileSync(legacyStatusRegistry, YAML.stringify(legacyStatusData, { lineWidth: 0 }), "utf8");

  // Reading it back must not rewrite it.
  assert.equal(JSON.parse(run(["project", "show", "legacy-status", "--json"], legacyStatusEnv)).status, "planned", "loading an existing record must not flip status to active");
  assert.equal(YAML.parse(readFileSync(legacyStatusRegistry, "utf8")).projects["legacy-status"].status, "planned", "a read must not rewrite the stored status");

  // An unrelated update (new description) must not flip it either.
  const legacyStatusUpdate = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--description", "Updated description", "--json",
  ], legacyStatusEnv, legacyStatusRepo));
  assert.equal(legacyStatusUpdate.ok, true, JSON.stringify(legacyStatusUpdate.errors));
  assert.equal(legacyStatusUpdate.plan.project.status, "planned", "an unrelated update must preserve the existing planned status");
  const legacyStatusAfter = YAML.parse(readFileSync(legacyStatusRegistry, "utf8")).projects["legacy-status"];
  assert.equal(legacyStatusAfter.status, "planned", "an unrelated update must not retroactively rewrite status");
  assert.equal(JSON.parse(readFileSync(join(legacyStatusRepo, ".project.json"), "utf8")).project_description, "Updated description", "the unrelated update must still have been applied");

  // PJAN-26 guard: the read-time fallback for a status-less record must stay
  // "planned" — it is a legacy-row fallback, not the new-project default.
  const registryStoreSource = readFileSync(join(root, "src", "project", "RegistryStore.ts"), "utf8");
  assert.match(registryStoreSource, /status: row\.status \?\? "planned"/, "PgRegistryStore.load() must keep the legacy read-time fallback at planned");

  // Regression: --ticket-provider trello yields a Trello-shaped provider block
  const trelloPlan = JSON.parse(run([
    "project", "init", "TrelloProj",
    "--description", "Trello provider coverage",
    "--target-dir", join(tmp, "TrelloProj"),
    "--ticket-provider", "trello",
    "--board-id", "687535e9873b89478afef689",
    "--registry", join(tmp, "trello-projects.yaml"),
    "--json",
  ], {}));
  assert.equal(trelloPlan.project.ticket_provider.type, "trello");
  assert.equal(trelloPlan.project.ticket_provider.board_id, "687535e9873b89478afef689");
  assert.equal("board_url" in trelloPlan.project.ticket_provider, false, "board_url must be derived, not persisted");
  assert.equal(trelloPlan.project.ticket_provider.state, "linked");
  assert.equal(trelloPlan.project.ticket_provider.workspace, "", "trello workspace defaults blank (not the Plane 33god default)");

  // Regression: an explicit --board-url is accepted for old callers but not persisted
  const trelloUrlPlan = JSON.parse(run([
    "project", "init", "TrelloUrlProj",
    "--description", "Trello explicit board-url",
    "--target-dir", join(tmp, "TrelloUrlProj"),
    "--ticket-provider", "trello",
    "--board-id", "abc123",
    "--board-url", "https://trello.com/b/jLl1NE0Z/intelforia",
    "--registry", join(tmp, "trello-url-projects.yaml"),
    "--json",
  ], {}));
  assert.equal("board_url" in trelloUrlPlan.project.ticket_provider, false);

  // Regression: unsupported providers must fail instead of falling through to Plane URL derivation
  const linearProvider = runExpectFailure([
    "project", "init", "LinearProj",
    "--description", "Unsupported provider coverage",
    "--target-dir", join(tmp, "LinearProj"),
    "--ticket-provider", "linear",
    "--board-id", "LIN-123",
    "--registry", join(tmp, "linear-projects.yaml"),
    "--json",
  ], {});
  assert.match(failureOutput(linearProvider), /Unsupported ticket provider: linear/);

  // Regression: default provider stays Plane and derives URL outside the persisted SOT
  const planePlan = JSON.parse(run([
    "project", "init", "PlaneProj",
    "--description", "Plane default coverage",
    "--target-dir", join(tmp, "PlaneProj"),
    "--board-id", "82e56896-e7fd-466b-826c-1019441c64ca",
    "--registry", join(tmp, "plane-projects.yaml"),
    "--json",
  ], {}));
  assert.equal(planePlan.project.ticket_provider.type, "plane");
  assert.equal(planePlan.project.ticket_provider.workspace, "33god");
  assert.equal("board_url" in planePlan.project.ticket_provider, false);
  assert.equal(planePlan.project.ticket_provider.state, "linked");

  console.log("project registry regressions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
