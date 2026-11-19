import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "pjan-146-"));
const home = join(scratch, "home");
mkdirSync(home);
const env = hermeticEnv({ HOME: home, XDG_STATE_HOME: join(home, "state"), NO_COLOR: "1" });

function run(args, cwd = scratch) {
  return spawnSync(process.execPath, [cli, "migrate", ...args], { cwd, env, encoding: "utf8", timeout: 30000 });
}

function refuses(args, expected, cwd = scratch) {
  const result = run(args, cwd);
  assert.equal(result.status, 1, `${args.join(" ")} must fail: ${result.stderr}`);
  assert.equal(result.stdout, "", "refusal must not print a migration report");
  assert.match(result.stderr, expected);
}

try {
  const missing = join(scratch, "new-project");
  refuses(["skills.project-manifest", missing, "--json"], /Target repo must be an existing directory/);
  refuses(["--all", missing, "--json"], /Target repo must be an existing directory/);
  refuses(["--rules", "skills.project-manifest,bmad.cli-roots", missing, "--json"], /Target repo must be an existing directory/);
  assert.equal(existsSync(missing), false, "invalid target must never be scaffolded");

  const twoRules = ["skills.project-manifest", "bmad.cli-roots"];
  const suggestion = /unexpected positional: bmad\.cli-roots; did you mean --rules skills\.project-manifest,bmad\.cli-roots\?/;
  refuses([...twoRules, "--json"], suggestion);
  refuses([...twoRules], suggestion);
  refuses([...twoRules, "--dry-run", "--json"], suggestion);
  refuses(["--all", scratch, missing, "--json"], /unexpected positional/);
  refuses(["--rules", twoRules.join(","), "skills.project-manifest", "--json"], /cannot be combined with --all or a positional rule id/);
  refuses(["--rules", "skills.project-manifest,does.not.exist", "--json"], /Unknown parity rule id\(s\): does\.not\.exist/);
  assert.deepEqual(readdirSync(scratch), ["home"], "refused calls must leave the cwd untouched");
  assert.deepEqual(readdirSync(home), [], "refused calls must not create Skillex receipts");

  // A directory called exactly like a rule is ambiguous: never silently use it as a target.
  const ambiguous = join(scratch, "bmad.cli-roots");
  mkdirSync(ambiguous);
  const marker = join(ambiguous, "keep.txt");
  writeFileSync(marker, "untouched\n");
  refuses(twoRules, suggestion);
  assert.deepEqual(readdirSync(ambiguous), ["keep.txt"]);
  assert.equal(readFileSync(marker, "utf8"), "untouched\n");

  // An ordinary existing target still works, even if it is not initialized yet.
  const existing = join(scratch, "existing-project");
  mkdirSync(existing);
  for (const malformed of ["", "   ", ",,,", "skills.project-manifest,", ",skills.project-manifest", "skills.project-manifest,,bmad.cli-roots", "skills.project-manifest,  ,bmad.cli-roots"]) {
    refuses(["--rules", malformed, existing, "--json"], /--rules requires a non-empty comma-separated list of rule ids/, existing);
    assert.deepEqual(readdirSync(existing), [], `malformed --rules ${JSON.stringify(malformed)} must not scaffold the target`);
    assert.deepEqual(readdirSync(home), [], "refusal must not write to HOME");
  }
  refuses(["--rules", "", "--all", "--json"], /--rules requires a non-empty comma-separated list of rule ids/, existing);
  refuses(["--rules", "", "mise.config-root", existing, "--json"], /--rules requires a non-empty comma-separated list of rule ids/, existing);
  refuses(["--rules", "skills.project-manifest", "--all", "--json"], /cannot be combined with --all or a positional rule id/, existing);
  refuses(["--rules", "skills.project-manifest", "bmad.cli-roots", "--json"], /cannot be combined with --all or a positional rule id/, existing);
  assert.deepEqual(readdirSync(existing), [], "refused combinations must not write to the target or cwd");
  assert.deepEqual(readdirSync(home), [], "refused combinations must not write to HOME");
  assert.deepEqual(readdirSync(scratch).sort(), ["bmad.cli-roots", "existing-project", "home"], "refusals must not write sibling paths");
  const single = run(["bmad.cli-roots", existing, "--dry-run", "--json"]);
  const singleReport = JSON.parse(single.stdout);
  assert.equal(single.status, singleReport.ok ? 0 : 1, single.stderr + single.stdout);
  assert.deepEqual(singleReport.selectedRules, ["bmad.cli-roots"]);
  assert.ok(singleReport.results.length, "existing target reaches the requested rule, not the path guard");
  assert.deepEqual(readdirSync(existing), [], "dry-run must not scaffold the target");

  const multiple = run(["--rules", twoRules.join(","), existing, "--dry-run", "--json"]);
  const multipleReport = JSON.parse(multiple.stdout);
  assert.equal(multiple.status, multipleReport.ok ? 0 : 1, multiple.stderr + multiple.stdout);
  assert.deepEqual(multipleReport.selectedRules, twoRules);
  assert.equal(multipleReport.results.length, 2, "both requested rules run against the existing target");
  assert.deepEqual(readdirSync(existing), [], "multi-rule dry-run must not scaffold the target");

  console.log("PJAN-146 migrate positional and target guards: passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
