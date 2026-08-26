// PJAN-84: a half-built target is adopted, not re-created forever.
//
// `syncMode` meant "this directory is a git root". A failed init over a
// pre-existing target leaves an orphan carrying .project.json,
// .copier-answers.yml, mise.toml, _bmad/ and the CLI roots — but NO .git and no
// registry row. So re-planning it reported `mode: create` and proposed
// `copier.copy.commonproject` again, re-rendering the template over a populated
// tree. Every retry produced the same orphan.
//
// That is what "it fails in a new way on every repo" actually was: not a new
// failure each time, but the same one, unreachable by the tool meant to fix it.
//
// Adoption is only safe because PJAN-82 made copier's post-render tasks
// idempotent — before that, an adopting render clobbered .gitignore and replaced
// a hand-written CLAUDE.md with a symlink.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const temporary = [];
let failures = 0;

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message.split("\n")[0]}`);
  }
}

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: temporary[0] ?? tmpdir(), ...env },
  });
}

/** The exact shape a failed init leaves behind when the target pre-existed. */
function orphan(root, name, { manifest = true, answers = true } = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, "_bmad"), { recursive: true });
  mkdirSync(join(dir, ".agents"), { recursive: true });
  mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
  writeFileSync(join(dir, "mise.toml"), "[env]\n");
  if (manifest) {
    writeFileSync(
      join(dir, ".project.json"),
      `${JSON.stringify({ project_name: name, project_slug: name, repo_path: dir }, null, 2)}\n`,
    );
  }
  if (answers) {
    writeFileSync(join(dir, ".copier-answers.yml"), `_src_path: x\nproject_name: ${name}\n`);
  }
  assert.equal(existsSync(join(dir, ".git")), false, "the orphan has no git root — that is the whole point");
  return dir;
}

console.log("pjan-84 orphan adoption");
try {
  const root = mkdtempSync(join(tmpdir(), "pjan-84-orphan-"));
  temporary.push(root);
  const registry = join(root, "registry.yaml");

  check("an orphan with a manifest plans as sync, not create", () => {
    const dir = orphan(root, "by-manifest", { answers: false });
    const plan = JSON.parse(cli(["init", "--target-dir", dir, "--registry", registry, "--no-tui", "--json"]).stdout);
    assert.equal(plan.mode, "sync", "a directory that already carries .project.json is not greenfield");
    assert.ok(
      !plan.proposedOperations.includes("copier.copy.commonproject"),
      `adoption must not re-render the template over a populated tree: ${JSON.stringify(plan.proposedOperations)}`,
    );
  });

  check("a copier render with no manifest also plans as sync", () => {
    // .copier-answers.yml alone proves a render already happened, which is the
    // state a failure between the render and the manifest write leaves.
    const dir = orphan(root, "by-answers", { manifest: false });
    const plan = JSON.parse(cli(["init", "--target-dir", dir, "--registry", registry, "--no-tui", "--json"]).stdout);
    assert.equal(plan.mode, "sync");
    assert.ok(!plan.proposedOperations.includes("copier.copy.commonproject"));
  });

  check("a genuinely empty target still plans as create", () => {
    const dir = join(root, "greenfield");
    mkdirSync(dir, { recursive: true });
    const plan = JSON.parse(cli(["init", "greenfield", "--target-dir", dir, "--registry", registry, "--no-tui", "--json"]).stdout);
    assert.equal(plan.mode, "create", "an empty directory is greenfield and must still be rendered");
    assert.ok(plan.proposedOperations.includes("copier.copy.commonproject"));
  });

  check("adopting an orphan converges, and a second run is a no-op", () => {
    const dir = orphan(root, "converges");
    const applied = cli(["init", "--target-dir", dir, "--registry", registry, "--apply", "-y", "--no-tui"]);
    assert.equal(applied.status, 0, `adoption must succeed: ${applied.stdout}${applied.stderr}`);
    assert.match(applied.stdout, /Project synchronized/);

    const audited = JSON.parse(cli(["audit", dir, "--registry", registry, "--json"]).stdout);
    assert.equal(audited.ok, true, `an adopted orphan must reach parity: ${JSON.stringify(audited.rules.filter((r) => r.status === "fail"))}`);

    const again = cli(["init", "--target-dir", dir, "--registry", registry, "--apply", "-y", "--no-tui"]);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Already in parity/, "the second run must have nothing to do");
  });

  check("adoption preserves what the operator already had", () => {
    const dir = orphan(root, "preserves");
    writeFileSync(join(dir, "README.md"), "# hand-written, must survive\n");
    writeFileSync(join(dir, ".gitignore"), "# my own ignore rules\nsecret-local/\n");
    const applied = cli(["init", "--target-dir", dir, "--registry", registry, "--apply", "-y", "--no-tui"]);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# hand-written, must survive\n");
    assert.match(
      readFileSync(join(dir, ".gitignore"), "utf8"),
      /# my own ignore rules/,
      "the operator's own ignore rules must survive adoption",
    );
  });
} finally {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}

if (failures) {
  console.error(`pjan-84 orphan adoption: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pjan-84 orphan adoption regressions passed");
