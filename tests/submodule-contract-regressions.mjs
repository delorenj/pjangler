#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const CHECKER = join(ROOT, "scripts", "check-submodule-contract.mjs");
const temporary = [];

function run(command, args, cwd, options = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function git(cwd, args, options = {}) {
  const result = run("git", args, cwd, options);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function standaloneBareSnapshot(source, bare) {
  git(resolve(bare, ".."), ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  const tree = git(source, ["rev-parse", "HEAD^{tree}"]);
  const objects = git(source, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  const env = {
    ...process.env,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const pin = git(bare, ["commit-tree", tree, "-m", "standalone tree snapshot"], { env });
  git(bare, ["update-ref", "refs/heads/main", pin], { env });
  git(bare, ["repack", "-a", "-d", "--quiet"], { env });
  assertStandaloneBare(bare);
  return pin;
}

function assertStandaloneBare(bare) {
  git(bare, ["fsck", "--full", "--strict"]);
  assert.equal(git(bare, ["rev-list", "--count", "HEAD"]), "1", "fixture snapshot must be a fresh root commit");
  assert.notEqual(run("git", ["cat-file", "-e", "HEAD^"], bare).status, 0, "fixture snapshot must not name a parent");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pjangler-submodule-contract-"));
  temporary.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, ["add", "seed.txt"]);
  git(root, ["commit", "--quiet", "-m", "seed"]);
  const pin = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(root, ".gitmodules"),
    `[submodule "templates/commonproject"]
\tpath = templates/commonproject
\turl = git@github.com:delorenj/CommonProject.git
\tbranch = main
[submodule "templates/hermes-agent"]
\tpath = templates/hermes-agent
\turl = git@github.com:delorenj/hermes-agent-template.git
\tbranch = main
`,
  );
  git(root, ["add", ".gitmodules"]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${pin},templates/commonproject`]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${pin},templates/hermes-agent`]);
  return { root, pin };
}

// A fixture with REAL initialized submodules, so `--recursive` has actual
// worktrees to inspect. `.gitmodules` still advertises the canonical GitHub
// URLs the contract pins, while the local clone URL points at the on-disk
// source repo, which is all `git submodule status` and `git status` need.
function worktreeFixture() {
  const cradle = mkdtempSync(join(tmpdir(), "pjangler-submodule-worktree-"));
  temporary.push(cradle);
  const sources = {};
  for (const template of ["commonproject", "hermes-agent"]) {
    const source = join(cradle, `${template}.src`);
    mkdirSync(join(source, "template", ".mise", "scripts"), { recursive: true });
    git(cradle, ["init", "--quiet", "--initial-branch=main", source]);
    git(source, ["config", "user.email", "fixture@example.invalid"]);
    git(source, ["config", "user.name", "Fixture"]);
    writeFileSync(join(source, "template", ".mise", "scripts", "provision-packs.py"), "#!/usr/bin/env python3\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "--quiet", "-m", "seed template"]);
    sources[template] = source;
  }

  const root = join(cradle, "parent");
  mkdirSync(root, { recursive: true });
  git(cradle, ["init", "--quiet", "--initial-branch=main", root]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "protocol.file.allow", "always"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, ["add", "seed.txt"]);
  git(root, ["commit", "--quiet", "-m", "seed"]);
  for (const template of ["commonproject", "hermes-agent"]) {
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", sources[template], `templates/${template}`]);
  }
  writeFileSync(
    join(root, ".gitmodules"),
    `[submodule "templates/commonproject"]
\tpath = templates/commonproject
\turl = git@github.com:delorenj/CommonProject.git
\tbranch = main
[submodule "templates/hermes-agent"]
\tpath = templates/hermes-agent
\turl = git@github.com:delorenj/hermes-agent-template.git
\tbranch = main
`,
  );
  git(root, ["add", ".gitmodules"]);
  git(root, ["commit", "--quiet", "-m", "wire submodules"]);
  return { root, sources };
}

function check(root, ...args) {
  return run(process.execPath, [CHECKER, "--root", root, ...args], ROOT);
}

function materializePackage(root, payloads = []) {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "pjangler-contract-fixture", version: "1.0.0", files: ["templates"] }, null, 2)}\n`,
  );
  for (const template of ["commonproject", "hermes-agent"]) {
    const directory = join(root, "templates", template);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "copier.yml"), "_subdirectory: template\n");
  }
  for (const [path, content] of payloads) {
    const target = join(root, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}

try {
  {
    const { root } = fixture();
    assert.equal(check(root).status, 0);
  }

  {
    const { root, pin } = fixture();
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${pin},.tmp/plugins`]);
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /orphan gitlink: \.tmp\/plugins/);
    assert.match(result.stderr, /host-local \.tmp cache must not be tracked/);
  }

  {
    const { root } = fixture();
    writeFileSync(
      join(root, ".gitmodules"),
      `${readFileSync(join(root, ".gitmodules"), "utf8")}[submodule "legacy-runtime"]
\tpath = agents/hermes/pm/runtime
\turl = git@github.com:example/legacy.git
\tbranch = main
`,
    );
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stale \.gitmodules mapping: agents\/hermes\/pm\/runtime/);
    assert.match(result.stderr, /unsupported mapping/);
  }

  {
    const { root } = fixture();
    const changed = readFileSync(join(root, ".gitmodules"), "utf8")
      .replace("git@github.com:delorenj/CommonProject.git", "https://token@example.invalid/private.git")
      .replace("\tbranch = main\n", "", 1);
    writeFileSync(join(root, ".gitmodules"), changed);
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must declare path, url, and branch|URL must be/);
  }

  {
    const { root } = fixture();
    materializePackage(root, [
      ["templates/hermes-agent/.codegraph/daemon.pid", '{"pid":1234}\n'],
      ["templates/hermes-agent/.omo/run-continuation/ses_private.json", '{"sessionID":"private"}\n'],
      ["templates/hermes-agent/tmp/agent.sock", "socket\n"],
    ]);
    const result = check(root, "--npm");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CodeGraph daemon runtime state/);
    assert.match(result.stderr, /Omo run-continuation state/);
    assert.match(result.stderr, /process or socket runtime state/);
  }

  // A submodule whose worktree carries uncommitted edits or untracked files is
  // shipping nothing: the parent can only pin a commit, so `git archive HEAD`,
  // every fresh clone, and the `npm publish` tarball all get the OLD tree while
  // the local checkout looks correct. `git submodule status` cannot see this —
  // it only compares the checked-out commit to the gitlink — so `--recursive`
  // has to inspect each worktree directly.
  {
    const { root } = worktreeFixture();
    assert.equal(check(root, "--recursive").status, 0, "clean submodule worktrees must verify");

    // 1. An untracked file — exactly the provision-packs.py case: present on
    //    disk, in no commit, therefore absent from everything that ships.
    const untracked = join(root, "templates", "commonproject", "template", ".mise", "scripts", "provision-extra.py");
    writeFileSync(untracked, "#!/usr/bin/env python3\n");
    let result = check(root, "--recursive");
    assert.equal(result.status, 1, "untracked submodule payload must fail the gate");
    assert.match(result.stderr, /templates\/commonproject worktree is dirty/);
    assert.match(result.stderr, /commit and push it, then bump the parent pin/);
    assert.match(result.stderr, /provision-extra\.py/);

    // 2. A tracked-but-uncommitted edit is equally unshippable.
    rmSync(untracked);
    const tracked = join(root, "templates", "commonproject", "template", ".mise", "scripts", "provision-packs.py");
    writeFileSync(tracked, "#!/usr/bin/env python3\n# edited\n");
    result = check(root, "--recursive");
    assert.equal(result.status, 1, "modified submodule payload must fail the gate");
    assert.match(result.stderr, /templates\/commonproject worktree is dirty/);

    // 3. Committing the submodule alone is NOT enough — the parent still pins
    //    the old commit, so the gate must stay red until the pin is bumped.
    const submodule = join(root, "templates", "commonproject");
    git(submodule, ["config", "user.email", "fixture@example.invalid"]);
    git(submodule, ["config", "user.name", "Fixture"]);
    git(submodule, ["add", "-A"]);
    git(submodule, ["commit", "--quiet", "-m", "edit template"]);
    result = check(root, "--recursive");
    assert.equal(result.status, 1, "an un-bumped parent pin must fail the gate");
    assert.match(result.stderr, /not initialized at its exact pin/);

    // 4. Clean worktree + bumped pin is the only shippable state.
    git(root, ["add", "templates/commonproject"]);
    assert.equal(check(root, "--recursive").status, 0, "committed submodule + bumped pin must verify");
  }

  // The dirty-worktree probe is deliberately scoped to `--recursive` (the
  // publish gate: prepublishOnly runs `--remote --recursive --archive --npm`),
  // so plain `npm test` stays green while a template is being iterated on.
  {
    const { root } = worktreeFixture();
    writeFileSync(join(root, "templates", "commonproject", "stray.txt"), "stray\n");
    assert.equal(check(root).status, 0, "the default mode must not police worktree cleanliness");
    assert.equal(check(root, "--recursive").status, 1, "--recursive must police worktree cleanliness");
  }

  {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.match(
      packageJson.scripts.prepublishOnly,
      /check:submodules -- .*--recursive/,
      "the publish gate must run the recursive submodule check",
    );
  }

  {
    const source = ["index.ts", "rules.ts"]
      .map((name) => readFileSync(join(ROOT, "src", "parity", name), "utf8"))
      .join("\n");
    const command = readFileSync(join(ROOT, "src", "commands", "hermes", "UntrackHermesRuntimes.ts"), "utf8");
    const active = readFileSync(join(ROOT, "agents", "hermes", "pm", ".scripts", "20-runtime-repo.sh"), "utf8");
    assert.doesNotMatch(source, /function upsertSubmodule/);
    assert.match(source, /removeRuntimeSubmoduleMapping/);
    assert.match(source, /\["rm", "--cached", "-r", "-f", "--", runtimePath\]/);
    assert.match(source, /runtime remains tracked after index-only removal/);
    assert.match(command, /remove stale \.gitmodules mapping/);
    assert.match(command, /\["rm", "--cached", "-r", "-f", "--", runtimePath\]/);
    assert.match(command, /Runtime remains tracked after index-only removal/);
    for (const forbidden of ["gh repo create", "git submodule add", "git submodule update", 'rm -rf "$RUNTIME_LOCAL"']) {
      assert.ok(!active.includes(forbidden), `active runtime provisioner contains ${forbidden}`);
    }
  }

  {
    const cloneRoot = mkdtempSync(join(tmpdir(), "pjangler-clean-clone-contract-"));
    temporary.push(cloneRoot);
    const commonBare = join(cloneRoot, "common.git");
    const hermesBare = join(cloneRoot, "hermes.git");
    const clone = join(cloneRoot, "pjangler");
    const commonPin = standaloneBareSnapshot(join(ROOT, "templates", "commonproject"), commonBare);
    const hermesPin = standaloneBareSnapshot(join(ROOT, "templates", "hermes-agent"), hermesBare);
    git(cloneRoot, ["clone", "--quiet", "--no-local", ROOT, clone]);
    git(clone, ["checkout", "--quiet", git(ROOT, ["rev-parse", "HEAD"])]);
    git(clone, ["config", "user.email", "fixture@example.invalid"]);
    git(clone, ["config", "user.name", "Fixture"]);
    git(clone, ["update-index", "--cacheinfo", `160000,${commonPin},templates/commonproject`]);
    git(clone, ["update-index", "--cacheinfo", `160000,${hermesPin},templates/hermes-agent`]);
    git(clone, ["commit", "--quiet", "-m", "pin standalone template snapshots"]);
    git(clone, ["config", "submodule.templates/commonproject.url", `file://${commonBare}`]);
    git(clone, ["config", "submodule.templates/hermes-agent.url", `file://${hermesBare}`]);
    git(clone, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
    const result = run(
      process.execPath,
      [join(clone, "scripts", "check-submodule-contract.mjs"), "--root", clone, "--recursive", "--archive", "--npm"],
      clone,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(git(clone, ["status", "--porcelain"]), "");
  }

  // Reproduce the CI precondition explicitly: a depth-1 source has a HEAD
  // whose named parent object is unavailable. Rooting a snapshot at its tree
  // must still produce an internally complete bare repository.
  {
    const shallowRoot = mkdtempSync(join(tmpdir(), "pjangler-shallow-snapshot-contract-"));
    temporary.push(shallowRoot);
    const source = join(shallowRoot, "source");
    const shallow = join(shallowRoot, "shallow");
    const bare = join(shallowRoot, "snapshot.git");
    git(shallowRoot, ["init", "--quiet", "--initial-branch=main", source]);
    git(source, ["config", "user.email", "fixture@example.invalid"]);
    git(source, ["config", "user.name", "Fixture"]);
    writeFileSync(join(source, "fixture.txt"), "first\n");
    git(source, ["add", "fixture.txt"]);
    git(source, ["commit", "--quiet", "-m", "first"]);
    writeFileSync(join(source, "fixture.txt"), "second\n");
    git(source, ["commit", "--quiet", "-am", "second"]);
    git(shallowRoot, ["clone", "--quiet", "--depth=1", `file://${source}`, shallow]);
    assert.equal(git(shallow, ["rev-parse", "--is-shallow-repository"]), "true");
    assert.notEqual(run("git", ["cat-file", "-e", "HEAD^"], shallow).status, 0, "depth-1 fixture must omit HEAD's parent");
    standaloneBareSnapshot(shallow, bare);
  }

  console.log("submodule contract regressions: passed");
} finally {
  for (const path of temporary.reverse()) rmSync(path, { recursive: true, force: true });
}
