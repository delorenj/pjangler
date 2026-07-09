import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");

function spawnCli(args, env, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
}

function run(args, env, cwd = root) {
  const result = spawnCli(args, env, cwd);
  if (result.status !== 0) {
    throw new Error(`command failed: ${process.execPath} ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

const tmp = mkdtempSync(join(tmpdir(), "pjangler-project-registry-"));
try {
  const registryPath = join(tmp, "projects.yaml");
  const targetDir = join(tmp, "SlowBurns");
  const sourceSkill = createSkillFixture(tmp);
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
  assert.deepEqual(dryRun.project.agents, {}, "default dry-run must not record a planned agent");
  assert.ok(dryRun.actions.some((action) => action.kind === "registry.upsert"));
  assert.ok(dryRun.actions.some((action) => action.kind === "copier.copy.commonproject"));
  assert.ok(dryRun.actions.some((action) => action.kind === "project.write-manifest"));
  assert.equal(existsSync(registryPath), false, "dry-run must not write the registry");
  assert.equal(existsSync(targetDir), false, "dry-run must not render the project");

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
  assert.equal(registry.projects.slowburns.ticket_provider.state, "planned");
  assert.deepEqual(registry.projects.slowburns.agents, {}, "default apply must not register a planned agent");

  const manifest = JSON.parse(readFileSync(join(targetDir, ".project.json"), "utf8"));
  assert.equal(manifest.project_slug, "slowburns");
  assert.equal(manifest.ticket_provider.identifier, "SLOW");
  assert.equal(manifest.ticket_provider.state, "planned");
  assert.deepEqual(manifest.agents, {}, "default apply must not write a planned agent projection");

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

  // Regression: provisioning a second agent role must preserve existing agents
  const multiAgentRepo = join(tmp, "MultiAgent");
  mkdirSync(multiAgentRepo, { recursive: true });
  git(["init"], multiAgentRepo);
  writeFileSync(join(multiAgentRepo, "package.json"), JSON.stringify({ name: "multi-agent", description: "Multi agent test" }, null, 2), "utf8");
  const multiAgentRegistry = join(tmp, "multi-agent-projects.yaml");
  const multiAgentEnv = { PJ_PROJECT_REGISTRY: multiAgentRegistry };
  const multiAgentFirst = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--provision-agent", "--agent-role", "pm", "--json",
  ], multiAgentEnv, multiAgentRepo));
  assert.equal(multiAgentFirst.ok, true, JSON.stringify(multiAgentFirst.errors));
  const firstMultiRegistry = YAML.parse(readFileSync(multiAgentRegistry, "utf8"));
  assert.equal(firstMultiRegistry.projects["multi-agent"].agents.pm.role, "pm");

  const multiAgentSecond = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--provision-agent", "--agent-role", "dev", "--json",
  ], multiAgentEnv, multiAgentRepo));
  assert.equal(multiAgentSecond.ok, true, JSON.stringify(multiAgentSecond.errors));
  const secondMultiRegistry = YAML.parse(readFileSync(multiAgentRegistry, "utf8"));
  assert.equal(secondMultiRegistry.projects["multi-agent"].agents.pm.role, "pm", "existing pm agent must be preserved in registry");
  assert.equal(secondMultiRegistry.projects["multi-agent"].agents.dev.role, "dev", "new dev agent must be added to registry");
  const secondMultiManifest = JSON.parse(readFileSync(join(multiAgentRepo, ".project.json"), "utf8"));
  assert.equal(secondMultiManifest.agents["multi-agent-pm"].role, "pm", "existing pm agent must be preserved in manifest");
  assert.equal(secondMultiManifest.agents["multi-agent-dev"].role, "dev", "new dev agent must be added to manifest");

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
  assert.equal(trelloPlan.project.ticket_provider.board_url, "https://trello.com/b/687535e9873b89478afef689");
  assert.equal(trelloPlan.project.ticket_provider.workspace, "", "trello workspace defaults blank (not the Plane 33god default)");

  // Regression: an explicit --board-url overrides the derived one
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
  assert.equal(trelloUrlPlan.project.ticket_provider.board_url, "https://trello.com/b/jLl1NE0Z/intelforia");

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

  // Regression: default provider stays Plane with the Plane-style board_url (backward compat)
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
  assert.equal(
    planePlan.project.ticket_provider.board_url,
    "https://plane.delo.sh/33god/projects/82e56896-e7fd-466b-826c-1019441c64ca/issues/",
  );

  console.log("project registry regressions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
