import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import YAML from "yaml";
import { createBmadInstallerFixture, createSkillPackFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";

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
      summary = JSON.stringify({ ok: payload.ok, errors: payload.errors, logs: payload.logs, failedRules: payload.audit?.rules?.filter((rule) => !["pass", "skip"].includes(rule.status)) }, null, 2);
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

function git(args, cwd) {
  if (args[0] === "init") {
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills.json"), JSON.stringify({ inherit_global: false, packs: [], skills: [] }));
  }
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

const tmp = mkdtempSync(join(tmpdir(), "pjangler-project-registry-"));
try {
  // PJAN-66: exercise planProjectInit as a direct API, independently of the
  // CLI/MCP parsers. Invalid explicit path segments must fail before a caller
  // can receive an executable plan, with no registry or filesystem mutation.
  const projectApiBundle = join(tmp, "project-api.cjs");
  buildSync({
    entryPoints: [join(root, "src", "project", "index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: projectApiBundle,
    logLevel: "silent",
  });
  const {
    executeProjectInitPlan: directExecuteProjectInitPlan,
    getProject: directGetProject,
    loadProjectRegistry: directLoadProjectRegistry,
    planProjectInit: directPlanProjectInit,
  } = createRequire(import.meta.url)(projectApiBundle);
  const directSafetyRoot = join(tmp, "direct-plan-safety");
  const directRegistry = join(directSafetyRoot, "projects.yaml");
  const directTarget = join(directSafetyRoot, "safe-target");
  mkdirSync(join(directSafetyRoot, "working"), { recursive: true });

  for (const projectSlug of ["", ".", "..", "__proto__", "../escaped", "/tmp/escaped", "nested/project", "nested\\project"]) {
    assert.throws(
      () => directPlanProjectInit({
        name: "Unsafe Direct Slug",
        projectSlug,
        targetDir: directTarget,
        registryPath: directRegistry,
        scaffold: false,
        pjanglerRoot: root,
      }),
      /Invalid project_id:.*letters, digits and internal hyphens/i,
      `direct planProjectInit must reject ${JSON.stringify(projectSlug)}`,
    );
  }
  assert.equal(existsSync(directRegistry), false, "invalid direct plans must not mutate the registry");
  assert.equal(existsSync(directTarget), false, "invalid direct plans must not create their target");
  assert.equal(existsSync(join(directSafetyRoot, "escaped")), false, "invalid direct plans must not create escaped files");

  const generatedSafePlan = directPlanProjectInit({
    name: "..",
    cwd: join(directSafetyRoot, "working"),
    registryPath: directRegistry,
    scaffold: false,
    pjanglerRoot: root,
  });
  assert.equal(generatedSafePlan.project.repo_path, join(directSafetyRoot, "project"), "generated targets must use the safe generated slug");
  assert.equal(existsSync(directRegistry), false, "a direct dry plan must remain side-effect free");

  // Safe dictionary keys that collide with Object.prototype must remain real
  // project records, while __proto__ stays rejected without mutating any
  // prototype. Exercise planning, YAML persistence, loading, and lookup.
  const prototypeRegistry = join(directSafetyRoot, "prototype-projects.yaml");
  const objectPrototypeNames = Object.getOwnPropertyNames(Object.prototype).sort();
  for (const specialKey of ["constructor", "prototype"]) {
    const specialPlan = directPlanProjectInit({
      name: `${specialKey} project`,
      projectSlug: specialKey,
      targetDir: join(directSafetyRoot, specialKey),
      registryPath: prototypeRegistry,
      scaffold: false,
      apply: true,
      // Board provisioning is on by default now; this case is about
      // prototype-safe dictionary keys and must not reach a provider.
      skipPlane: true,
      pjanglerRoot: root,
    });
    assert.equal(Object.getPrototypeOf(specialPlan.project.agents), null, "planned agent maps must have no inherited keys");
    const applied = await directExecuteProjectInitPlan(specialPlan);
    assert.equal(applied.ok, true, JSON.stringify(applied.errors));
  }
  const specialRegistry = directLoadProjectRegistry(prototypeRegistry);
  assert.equal(Object.getPrototypeOf(specialRegistry.projects), null, "loaded project maps must have no prototype");
  for (const specialKey of ["constructor", "prototype"]) {
    const project = directGetProject(specialRegistry, specialKey);
    assert.equal(project.slug, specialKey);
    assert.equal(Object.getPrototypeOf(project.agents), null, "loaded agent maps must have no prototype");
  }

  const maliciousProjectMap = Object.create(null);
  maliciousProjectMap.__proto__ = {
    ...directGetProject(specialRegistry, "prototype"),
    name: "Unsafe Proto Project",
    slug: "__proto__",
    repo_path: join(directSafetyRoot, "unsafe-proto-project"),
  };
  const maliciousProjectRegistry = join(directSafetyRoot, "malicious-project-key.yaml");
  writeFileSync(maliciousProjectRegistry, YAML.stringify({ schema_version: 1, projects: maliciousProjectMap }, { lineWidth: 0 }), "utf8");
  assert.throws(() => directLoadProjectRegistry(maliciousProjectRegistry), /project registry key.*safe single path segment/i);

  const maliciousAgentMap = Object.create(null);
  maliciousAgentMap.__proto__ = { role: "__proto__", provisioning_state: "planned" };
  const maliciousAgentProject = {
    ...directGetProject(specialRegistry, "prototype"),
    name: "Unsafe Proto Agent",
    slug: "proto-agent-control",
    repo_path: join(directSafetyRoot, "proto-agent-control"),
    agents: maliciousAgentMap,
  };
  const maliciousAgentProjects = Object.create(null);
  maliciousAgentProjects[maliciousAgentProject.slug] = maliciousAgentProject;
  const maliciousAgentRegistry = join(directSafetyRoot, "malicious-agent-key.yaml");
  writeFileSync(maliciousAgentRegistry, YAML.stringify({ schema_version: 1, projects: maliciousAgentProjects }, { lineWidth: 0 }), "utf8");
  assert.throws(() => directLoadProjectRegistry(maliciousAgentRegistry), /agent key __proto__.*safe single path segment/i);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), objectPrototypeNames, "registry operations must not mutate Object.prototype");
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);

  const fixtureRoot = join(tmp, "bmad-fixtures");
  mkdirSync(join(tmp, "isolated-home"), { recursive: true });
  portableLifecycleEnv = {
    HOME: join(tmp, "isolated-home"),
    XDG_CACHE_HOME: join(tmp, "isolated-home", ".cache"),
    XDG_CONFIG_HOME: join(tmp, "isolated-home", ".config"),
    XDG_STATE_HOME: join(tmp, "state"),
    PATH: `${createSkillexMiseFixture(tmp)}:${process.env.PATH}`,
    SKILLEX_REGISTRY_ROOT: fixtureRoot,
    PJ_SKILLS_REGISTRY_ROOT: fixtureRoot,
    PJ_PACK_ROOT_PJTEST: createSkillPackFixture(fixtureRoot),
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

  // Board provisioning is on by default now (a `pj init` that ends with no
  // board fails the ingress gate), and these fixtures are about the scaffold,
  // the registry, and the manifest. They say --skip-board rather than reaching
  // a provider.
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
    "--skip-board",
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
  assert.equal(manifest.project_id, "slowburns");
  assert.equal(manifest.project_slug, undefined);
  assert.equal(manifest.ticket_provider.identifier, "SLOW");
  assert.equal(manifest.ticket_provider.state, "planned");
  assert.deepEqual(manifest.agents, {}, "default apply must not write a planned agent projection");
  // 4a6c659 made `automation.reconcile` a parity FAILURE — a switch the
  // heartbeat never read. A greenfield manifest must therefore carry no
  // `automation` key at all, not an empty one.
  assert.equal(manifest.automation, undefined, "init must not invent automation.reconcile");

  const listed = JSON.parse(run(["project", "list", "--json"], env));
  assert.equal(listed.projects.slowburns.repo_path, targetDir);

  const shown = JSON.parse(run(["project", "show", "slowburns", "--json"], env));
  assert.equal(shown.manifest.project_name, "SlowBurns");

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
    "--skip-board",
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
    "--skip-board",
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
    "--skip-board",
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
    "project", "init", "--yes", "--apply", "--skip-board", "--json",
  ], syncUpdateEnv, syncUpdateRepo));
  assert.equal(syncUpdateFirst.ok, true, JSON.stringify(syncUpdateFirst.errors));
  const firstSyncManifest = JSON.parse(readFileSync(join(syncUpdateRepo, ".project.json"), "utf8"));
  assert.equal(firstSyncManifest.project_description, "Original description");

  const syncUpdateSecond = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--skip-board", "--description", "Updated description", "--json",
  ], syncUpdateEnv, syncUpdateRepo));
  assert.equal(syncUpdateSecond.ok, true, JSON.stringify(syncUpdateSecond.errors));
  assert.ok(syncUpdateSecond.selectedOperations.includes("project.write-manifest"), "sync must select .project.json write when manifest differs");
  const secondSyncManifest = JSON.parse(readFileSync(join(syncUpdateRepo, ".project.json"), "utf8"));
  assert.equal(secondSyncManifest.project_description, "Updated description");

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
    "project", "init", "--yes", "--apply", "--skip-board", "--json",
  ], legacyStatusEnv, legacyStatusRepo));
  assert.equal(legacyStatusFirst.ok, true, JSON.stringify(legacyStatusFirst.errors));
  assert.equal(YAML.parse(readFileSync(legacyStatusRegistry, "utf8")).projects["legacy-status"].status, "active");

  // Simulate a pre-PJAN-26 row that was recorded as "planned".
  const legacyStatusData = YAML.parse(readFileSync(legacyStatusRegistry, "utf8"));
  legacyStatusData.projects["legacy-status"].status = "planned";
  writeFileSync(legacyStatusRegistry, YAML.stringify(legacyStatusData, { lineWidth: 0 }), "utf8");

  const legacyStatusManifestPath = join(legacyStatusRepo, ".project.json");
  const legacyStatusManifest = JSON.parse(readFileSync(legacyStatusManifestPath, "utf8"));
  legacyStatusManifest.status = "planned";
  writeFileSync(legacyStatusManifestPath, JSON.stringify(legacyStatusManifest, null, 2));

  // Reading it back must not rewrite it.
  assert.equal(JSON.parse(run(["project", "show", "legacy-status", "--json"], legacyStatusEnv)).manifest.status, "planned", "loading an existing record must not flip status to active");
  assert.equal(YAML.parse(readFileSync(legacyStatusRegistry, "utf8")).projects["legacy-status"].status, "planned", "a read must not rewrite the stored status");

  // An unrelated update (new description) must not flip it either.
  const legacyStatusUpdate = JSON.parse(run([
    "project", "init", "--yes", "--apply", "--skip-board", "--description", "Updated description", "--json",
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
  // A board id supplied on the command line is not a confirmed identity: the
  // identifier is still a proposal, so the binding stays "planned" until
  // `pj project identity` reads the real identifier back from the provider.
  assert.equal(trelloPlan.project.ticket_provider.state, "planned");
  assert.equal(trelloPlan.project.ticket_provider.identifier_source, "proposed");
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
  assert.ok(trelloUrlPlan.warnings.some((warning) => /boardUrl.*deprecated/i.test(warning)), "legacy boardUrl callers must receive a deprecation warning");

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
  assert.equal(planePlan.project.ticket_provider.state, "planned");
  assert.equal(planePlan.project.ticket_provider.identifier_source, "proposed");

  console.log("project registry regressions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
