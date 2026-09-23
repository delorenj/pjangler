// PJAN-130: a positional name means "make a project called that", never
// "rename the repo I happen to be standing in".
//
// `pj init sidepiece`, run from inside the 33GOD checkout, created no
// directory. It adopted 33GOD itself: renamed the registry row to "sidepiece",
// renamed the notebook to "sidepiece", and re-rendered the CommonProject
// template over a live checkout carrying 30+ uncommitted files.
//
// resolveProjectInitTarget (src/index.ts) decided the target BEFORE it ever
// looked at `name`:
//
//     let targetDir = options.targetDir ? resolve(options.targetDir) : undefined;
//     if (!targetDir && cwdGitRoot) targetDir = cwdGitRoot;   // <-- hijack
//
// With targetDir already set, the block that would have produced ./<name> was
// unreachable, `name` survived only as the DISPLAY name, and `syncMode` came
// back true because the cwd is a git root -- so "create a new project" executed
// as "adopt this one and call it something else". The CLI's own help for the
// positional has said "omit inside an existing git repo" the whole time, which
// is exactly the case that was never enforced.
//
// The plan is asserted through `--dry-run --json`, which is where target
// resolution is observable with no side effects at all; the last check applies
// a real init and proves the enclosing repo came out byte-identical.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createBmadInstallerFixture, createSkillPackFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const temporary = [];
let failures = 0;
let lifecycleEnv = {};

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    // NOT .split("\n")[0]: assert.match/deepEqual put the expectation on line 1
    // and the actual value below it.
    console.log(`  FAIL ${label}: ${error.message}`);
  }
}

/** Every run is launched FROM a directory, because cwd is the input under test. */
function cli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: temporary[0] ?? tmpdir(), ...lifecycleEnv },
    maxBuffer: 32 * 1024 * 1024,
  });
}

function plan(args, cwd) {
  const run = cli([...args, "--dry-run", "--no-tui", "--json"], cwd);
  assert.equal(run.status, 0, `init plan must succeed: ${run.stdout}${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** A real git repo that is already a pjangler project -- i.e. what 33GOD is. */
function hostRepo(root, dirName, { projectName, projectId }) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir }).status, 0, "git init");
  writeFileSync(
    join(dir, ".project.json"),
    `${JSON.stringify({ project_name: projectName, project_id: projectId, repo_path: dir, status: "active" }, null, 2)}\n`,
  );
  // Both markers, because the live repo carries both and either one alone is
  // enough to make resolveProjectInitTarget call the directory "already
  // scaffolded".
  writeFileSync(join(dir, ".copier-answers.yml"), `_src_path: commonproject\nproject_name: ${projectName}\n`);
  writeFileSync(join(dir, "README.md"), `# ${projectName}\nhand-written, must survive\n`);
  return dir;
}

/** sha256 of every file in `dir`, skipping .git and any named child. */
function digest(dir, skip = []) {
  const hash = createHash("sha256");
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      const rel = relative(dir, path);
      if (entry.name === ".git" || skip.includes(rel)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(`${rel}\0`).update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

console.log("pjan-130 init target resolution");
try {
  const root = mkdtempSync(join(tmpdir(), "pjan-130-init-target-"));
  temporary.push(root);
  mkdirSync(join(root, "home", ".cache", "pjangler"), { recursive: true });
  writeFileSync(
    join(root, "home", ".cache", "pjangler", "bmad-dist-tags.json"),
    JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.11.1-next.1", next: "6.11.1-next.1" } }),
  );
  const fixtureRoot = join(root, "skill-registry");
  createSkillPackFixture(fixtureRoot);
  lifecycleEnv = {
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "home", ".cache"),
    XDG_STATE_HOME: join(root, "state"),
    PATH: `${createSkillexMiseFixture(root)}:${process.env.PATH}`,
    SKILLEX_REGISTRY_ROOT: fixtureRoot,
    PJ_SKILLS_REGISTRY_ROOT: fixtureRoot,
    PJ_BMAD_INSTALLER: createBmadInstallerFixture(fixtureRoot),
  };
  // A fixture PATH, never the service on :8764 -- these assertions must not be
  // able to rename a row in the operator's real registry, which is precisely
  // the damage being regressed.
  const registry = join(root, "registry.yaml");
  const base = ["--registry", registry, "--skip-board"];

  const repo = hostRepo(root, "host-repo", { projectName: "Host Repo", projectId: "host-repo" });

  check("a positional name inside a git repo targets ./<name>, not the repo root", () => {
    const planned = plan(["init", "sidepiece", ...base], repo);
    assert.equal(
      planned.project.repo_path,
      join(repo, "sidepiece"),
      "`pj init sidepiece` names a NEW project; the cwd git root is not its target",
    );
    assert.equal(planned.mode, "create", "a named project that does not exist yet is greenfield, not an adoption");
  });

  check("a positional name never rewrites the enclosing project's identity", () => {
    const planned = plan(["init", "sidepiece", ...base], repo);
    assert.notEqual(
      planned.project.project_id,
      "host-repo",
      "the plan must not carry the enclosing project's id -- that is the row that got renamed",
    );
    assert.equal(planned.project.name, "sidepiece", "the name belongs to the new project");
    assert.notEqual(planned.manifest.repo_path, repo, "the enclosing repo is not the manifest's home");
    // Independent of the plan: planning is read-only, so the repo's own
    // manifest must still say what it said.
    const manifest = JSON.parse(readFileSync(join(repo, ".project.json"), "utf8"));
    assert.equal(manifest.project_name, "Host Repo");
    assert.equal(manifest.project_id, "host-repo");
  });

  check("no positional name inside a git repo still adopts that repo", () => {
    const planned = plan(["init", ...base], repo);
    assert.equal(planned.mode, "sync", "an omitted name is the documented way to adopt the current repo");
    assert.equal(planned.project.repo_path, repo);
    assert.equal(planned.project.name, "Host Repo", "adoption keeps the existing name");
    assert.equal(planned.project.project_id, "host-repo");
  });

  check("--target-dir still wins over a positional name", () => {
    const explicit = join(root, "explicit-target");
    const planned = plan(["init", "sidepiece", "--target-dir", explicit, ...base], repo);
    assert.equal(planned.project.repo_path, explicit, "an explicit --target-dir is the most specific instruction there is");
    assert.equal(planned.mode, "create");
  });

  check("--target-dir pointing at the cwd repo is still an adoption", () => {
    const planned = plan(["init", "--target-dir", repo, ...base], repo);
    assert.equal(planned.mode, "sync");
    assert.equal(planned.project.repo_path, repo);
  });

  // `.` and `..` survive the old inline `[^A-Za-z0-9._-]` filter untouched, so
  // before projectTargetDirUnder they resolved to the cwd and to its PARENT.
  // `pj init ..` adopting the directory above you is the same defect with a
  // wider blast radius, and nothing on screen would have named it.
  for (const traversal of [".", "..", "../sibling", "nested/child"]) {
    check(`a name that is really a path is refused: ${JSON.stringify(traversal)}`, () => {
      const run = cli(["init", traversal, ...base, "--dry-run", "--no-tui", "--json"], repo);
      assert.notEqual(run.status, 0, "a path-shaped name must not resolve to a directory");
      assert.match(JSON.parse(run.stdout).error, /is a path, not a name/);
    });
  }

  // The rename guard lives in planProjectInit, so it defends the MCP tools too,
  // not just this CLI. `--target-dir` at an existing project is the one route
  // left that can still ask for a rename.
  check("a name that disagrees with the target's manifest is refused", () => {
    const run = cli(["init", "sidepiece", "--target-dir", repo, ...base, "--dry-run", "--no-tui", "--json"], repo);
    assert.notEqual(run.status, 0, "renaming a registered project is never implicit");
    assert.match(JSON.parse(run.stdout).error, /conflicts with authoritative manifest "Host Repo"/);
  });

  check("--force is the one way to rename a project on purpose", () => {
    const planned = plan(["init", "sidepiece", "--target-dir", repo, "--force", ...base], repo);
    assert.equal(planned.project.repo_path, repo);
    assert.equal(planned.project.name, "sidepiece", "an explicit --force rename is still allowed");
  });

  // DeLoDocs is Syncthing-only: a .project.json, no .git. `pj init` with no
  // name used to demand --target-dir there, because adoption keyed only on the
  // cwd git root. GIT_CEILING_DIRECTORIES (see cli) keeps git from finding a
  // parent repo, so this directory really is outside any work tree.
  check("no positional name in a non-git project adopts the manifest directory", () => {
    const vault = join(root, "syncthing-vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(
      join(vault, ".project.json"),
      `${JSON.stringify({ project_name: "Vault", project_id: "vault", repo_path: vault, status: "active" }, null, 2)}\n`,
    );
    const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: vault,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
    });
    assert.notEqual(probe.status, 0, "fixture must sit outside every git work tree");
    const planned = plan(["init", ...base], vault);
    assert.equal(planned.mode, "sync", "a directory carrying .project.json is an adoption, git or not");
    assert.equal(planned.project.repo_path, vault);
    assert.equal(planned.project.project_id, "vault");
  });

  check("no positional name in a bare non-git directory is still refused", () => {
    const bare = join(root, "bare-dir");
    mkdirSync(bare, { recursive: true });
    const run = cli(["init", ...base, "--dry-run", "--no-tui", "--json"], bare);
    assert.notEqual(run.status, 0, "nothing to adopt and nothing to create");
    assert.match(JSON.parse(run.stdout).error, /--target-dir is required/);
  });

  // Parity with the MCP bootstrap tool, which has refused a populated target
  // since day one. The CLI would render copier straight over it.
  check("a populated, non-pjangler target directory is refused", () => {
    const occupied = join(root, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "notes.txt"), "someone else's work\n");
    const run = cli(["init", "occupied", ...base, "--dry-run", "--no-tui", "--json"], root);
    assert.notEqual(run.status, 0, "init must not render over a directory that already has contents");
    assert.match(JSON.parse(run.stdout).error, /Target already exists and is not empty/);
  });

  // The applied run: the plan can be right and the execution still land in the
  // wrong tree, and a corrupted 33GOD checkout is the actual reported damage.
  check("an applied `init <name>` creates ./<name> and leaves the repo byte-identical", () => {
    const before = digest(repo);
    const beforeManifest = readFileSync(join(repo, ".project.json"));
    const beforeAnswers = readFileSync(join(repo, ".copier-answers.yml"));

    const applied = cli(["init", "sidepiece", ...base, "--apply", "-y", "--no-tui"], repo);
    assert.equal(applied.status, 0, `applied init must succeed: ${applied.stdout}${applied.stderr}`);

    const child = join(repo, "sidepiece");
    assert.equal(existsSync(child) && statSync(child).isDirectory(), true, "init must create ./sidepiece");
    assert.equal(existsSync(join(child, ".project.json")), true, "the new project owns the new manifest");
    assert.equal(
      JSON.parse(readFileSync(join(child, ".project.json"), "utf8")).project_name,
      "sidepiece",
      "the positional name names the CHILD project",
    );

    assert.deepEqual(
      readFileSync(join(repo, ".project.json")),
      beforeManifest,
      "the enclosing repo's manifest must be byte-identical -- renaming it is the bug",
    );
    assert.deepEqual(
      readFileSync(join(repo, ".copier-answers.yml")),
      beforeAnswers,
      "no template may be re-rendered over the enclosing repo",
    );
    assert.equal(
      digest(repo, ["sidepiece"]),
      before,
      "apart from the new child directory, not one byte of the enclosing repo may change",
    );
  });
} finally {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}

if (failures) {
  console.error(`pjan-130 init target resolution: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pjan-130 init target resolution regressions passed");
