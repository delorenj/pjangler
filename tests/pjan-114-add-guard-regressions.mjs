import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

// PJAN-114: `pj add project` and `pj add notebook` crashed with a TypeError
// because runRecipeSubsystem passes {} as recipe input, while
// ProjectRecipe.init and NotebookRecipe.init require a resolved
// ProjectInitPlan. The decided fix is a clean rejection at that one seam
// (covering `pj add`, `pj recipe run` and the deprecated `pj init <id>`
// forwarding) naming the real door — plus the sibling trap: `pj migrate
// <typo>` with no repo positional used to fall through to the rule picker
// with the typo as the repo path and audit a directory named after it.
//
// Runs the real built CLI (dist/index.js) in a scratch git repo with a
// private HOME (hermeticEnv), so the crash reproduces exactly as reported.
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");

const tmp = hermeticScratch("pjan-114-");
try {
  assert.ok(existsSync(cli), "dist/index.js is missing; run `npm run build` first");

  const repo = join(tmp, "scratch-repo");
  mkdirSync(repo, { recursive: true });
  const gitEnv = hermeticEnv({
    GIT_AUTHOR_NAME: "pjan-114",
    GIT_AUTHOR_EMAIL: "pjan-114@example.invalid",
    GIT_COMMITTER_NAME: "pjan-114",
    GIT_COMMITTER_EMAIL: "pjan-114@example.invalid",
  });
  const gitInit = spawnSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repo, encoding: "utf8", env: gitEnv });
  assert.equal(gitInit.status, 0, gitInit.stderr);

  /** The real CLI, in the scratch git repo, under the suite's hermetic env. */
  function pj(args) {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: hermeticEnv({ NO_COLOR: "1" }),
      timeout: 120000,
    });
  }

  const rejectCases = [
    { command: ["add", "project"], door: /pj init/ },
    { command: ["add", "notebook"], door: /pj notebook/ },
    { command: ["recipe", "run", "project"], door: /pj init/ },
    { command: ["recipe", "run", "notebook"], door: /pj notebook/ },
  ];
  for (const { command, door } of rejectCases) {
    for (const flags of [[], ["--dry-run"]]) {
      const result = pj([...command, ...flags]);
      const label = `pj ${[...command, ...flags].join(" ")}`;
      assert.notEqual(result.status, 0, `${label} must exit non-zero`);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.doesNotMatch(output, /TypeError/, `${label} must not crash with a TypeError`);
      assert.doesNotMatch(output, /\n\s+at .+\(\w+:\/\/.*:\d+:\d+\)/, `${label} must not print a stack trace`);
      assert.match(output, door, `${label} must name the command to use instead`);
    }
  }

  // --json mode must stay machine-parseable: one error envelope, exit 1.
  // (`pj add` defines no --json flag — commander rejects it before the guard —
  // so JSON mode is exercised through `pj recipe run <id> --json`, the other
  // entry point that funnels through the same seam.)
  for (const command of [["recipe", "run", "project"], ["recipe", "run", "notebook"]]) {
    const door = command[2] === "project" ? /pj init/ : /pj notebook/;
    const jsonResult = pj([...command, "--json"]);
    assert.notEqual(jsonResult.status, 0, `pj ${command.join(" ")} --json must exit non-zero`);
    const payload = JSON.parse(jsonResult.stdout);
    assert.equal(payload.ok, false, `pj ${command.join(" ")} --json must report ok:false`);
    assert.match(payload.error, door, `pj ${command.join(" ")} --json error must name the command to use instead`);
    assert.doesNotMatch(`${jsonResult.stdout}\n${jsonResult.stderr}`, /TypeError/);
  }

  // Check-driven recipes are unaffected: `pj add docker --dry-run` still
  // previews its files and exits 0.
  const docker = pj(["add", "docker", "--dry-run"]);
  assert.equal(docker.status, 0, `pj add docker --dry-run must still succeed\nstdout:\n${docker.stdout}\nstderr:\n${docker.stderr}`);
  assert.match(docker.stdout, /Dockerfile/);

  // `pj migrate <unknown-rule-id>` with no repo positional: rejected with the
  // known-ids list, before any picker or audit runs.
  const typo = "not-a-real-rule";
  const migrate = pj(["migrate", typo]);
  assert.notEqual(migrate.status, 0, "pj migrate <typo> must exit non-zero");
  const migrateOutput = `${migrate.stdout}\n${migrate.stderr}`;
  assert.match(migrateOutput, /Unknown parity rule: not-a-real-rule/);
  assert.match(migrateOutput, /Valid rule ids/);
  assert.match(migrateOutput, /board\.schema/, "the known rule ids are listed");
  assert.doesNotMatch(migrateOutput, /Provide a rule-id/, "the typo is not mistaken for a missing argument");
  assert.ok(!existsSync(join(repo, typo)), "no directory named after the typo is audited or created");
  assert.deepEqual(
    spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8", env: hermeticEnv({ NO_COLOR: "1" }) }).stdout
      .split("\n").map((line) => line.trim()).filter(Boolean),
    [],
    "the scratch git repo is untouched by the rejected commands",
  );

  // Same rejection in --json mode: one machine-parseable error envelope with
  // the valid rule ids, exit 1.
  const migrateJson = pj(["migrate", typo, "--json"]);
  assert.notEqual(migrateJson.status, 0, "pj migrate <typo> --json must exit non-zero");
  const migratePayload = JSON.parse(migrateJson.stdout);
  assert.equal(migratePayload.ok, false);
  assert.match(migratePayload.error, /Unknown parity rule: not-a-real-rule/);
  assert.ok(migratePayload.validRuleIds.includes("board.schema"), "validRuleIds lists the known rule ids");

  // A KNOWN single-positional rule id still runs (no over-broad guard): the
  // migration preview reports on the repo instead of rejecting the rule id.
  const known = pj(["migrate", "bmad.version", "--dry-run"]);
  assert.equal(known.status, 0, `pj migrate bmad.version --dry-run must still run\nstdout:\n${known.stdout}\nstderr:\n${known.stderr}`);
  assert.doesNotMatch(`${known.stdout}\n${known.stderr}`, /Unknown parity rule/);

  console.log("PJAN-114: clean rejections for add project/notebook and migrate rule-id validation passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
