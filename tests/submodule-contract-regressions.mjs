#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function git(cwd, args) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
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

function check(root, ...args) {
  return run(process.execPath, [CHECKER, "--root", root, ...args], ROOT);
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
    const source = readFileSync(join(ROOT, "src", "parity", "index.ts"), "utf8");
    const command = readFileSync(join(ROOT, "src", "commands", "hermes", "UntrackHermesRuntimes.ts"), "utf8");
    const active = readFileSync(join(ROOT, "agents", "hermes", "pm", ".scripts", "20-runtime-repo.sh"), "utf8");
    assert.doesNotMatch(source, /function upsertSubmodule/);
    assert.match(source, /removeRuntimeSubmoduleMapping/);
    assert.match(command, /remove stale \.gitmodules mapping/);
    for (const forbidden of ["gh repo create", "git submodule add", "git submodule update", 'rm -rf "$RUNTIME_LOCAL"']) {
      assert.ok(!active.includes(forbidden), `active runtime provisioner contains ${forbidden}`);
    }
  }

  {
    const cloneRoot = mkdtempSync(join(tmpdir(), "pjangler-clean-clone-contract-"));
    temporary.push(cloneRoot);
    const commonBare = join(cloneRoot, "common.git");
    const hermesBare = join(cloneRoot, "hermes.git");
    const commonBundle = join(cloneRoot, "common.bundle");
    const hermesBundle = join(cloneRoot, "hermes.bundle");
    const clone = join(cloneRoot, "pjangler");
    git(join(ROOT, "templates", "commonproject"), ["bundle", "create", commonBundle, "HEAD"]);
    git(join(ROOT, "templates", "hermes-agent"), ["bundle", "create", hermesBundle, "HEAD"]);
    git(cloneRoot, ["clone", "--quiet", "--bare", commonBundle, commonBare]);
    git(cloneRoot, ["clone", "--quiet", "--bare", hermesBundle, hermesBare]);
    git(cloneRoot, ["clone", "--quiet", "--no-local", ROOT, clone]);
    git(clone, ["checkout", "--quiet", git(ROOT, ["rev-parse", "HEAD"])]);
    git(clone, ["config", `url.file://${commonBare}.insteadOf`, "git@github.com:delorenj/CommonProject.git"]);
    git(clone, ["config", `url.file://${hermesBare}.insteadOf`, "git@github.com:delorenj/hermes-agent-template.git"]);
    git(clone, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
    const result = run(
      process.execPath,
      [join(clone, "scripts", "check-submodule-contract.mjs"), "--root", clone, "--recursive", "--archive", "--npm"],
      clone,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(git(clone, ["status", "--porcelain"]), "");
  }

  console.log("submodule contract regressions: passed");
} finally {
  for (const path of temporary.reverse()) rmSync(path, { recursive: true, force: true });
}
