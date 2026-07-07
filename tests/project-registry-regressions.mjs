import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const sourceSkill = "/home/delorenj/code/skillex/all-skills/civilwar-letterifier";

function run(args, env) {
  const result = spawnSync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`command failed: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runExpectFailure(args, env) {
  const result = spawnSync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status === 0) {
    throw new Error(`expected failure: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

const tmp = mkdtempSync(join(tmpdir(), "pjangler-project-registry-"));
try {
  const registryPath = join(tmp, "projects.yaml");
  const targetDir = join(tmp, "SlowBurns");
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
  assert.ok(dryRun.actions.some((action) => action.kind === "registry.upsert"));
  assert.ok(dryRun.actions.some((action) => action.kind === "copier.copy.commonproject"));
  assert.ok(dryRun.actions.some((action) => action.kind === "project.write-manifest"));
  assert.equal(existsSync(registryPath), false, "dry-run must not write the registry");
  assert.equal(existsSync(targetDir), false, "dry-run must not render the project");

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

  const manifest = JSON.parse(readFileSync(join(targetDir, ".project.json"), "utf8"));
  assert.equal(manifest.project_slug, "slowburns");
  assert.equal(manifest.ticket_provider.identifier, "SLOW");
  assert.equal(manifest.ticket_provider.state, "planned");

  const listed = JSON.parse(run(["project", "list", "--json"], env));
  assert.equal(listed.projects.slowburns.repo_path, targetDir);

  const shown = JSON.parse(run(["project", "show", "slowburns", "--json"], env));
  assert.equal(shown.name, "SlowBurns");

  const doctor = JSON.parse(run(["project", "doctor", "slowburns", "--json"], env));
  assert.equal(doctor.ok, true);
  assert.deepEqual(doctor.checkedProjects, ["slowburns"]);

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
  assert.match(duplicate, /Project slug already exists/);

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
  assert.match(missingSkill, /Source skill not found/);
  assert.match(missingSkill, /civilwar-letterifier/);

  console.log("project registry regressions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
