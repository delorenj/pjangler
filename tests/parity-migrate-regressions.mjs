import assert from "node:assert/strict";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, lstatSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSkillPackFixture } from "./helpers/pack-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const bmadFixtureRoot = mkdtempSync(join(tmpdir(), "pjangler-parity-bmad-fixture-"));
const selectedBmadPack = createSkillPackFixture(bmadFixtureRoot);

function childEnv(env = {}) {
  const merged = {
    ...process.env,
    PJ_PACK_ROOT_PJTEST: selectedBmadPack,
    ...env,
  };
  if (env.PJ_PACK_ROOT_PJTEST && !env.PJ_PACK_ROOT_PJTEST) {
    merged.PJ_PACK_ROOT_PJTEST = env.PJ_PACK_ROOT_PJTEST;
  }
  return merged;
}

function run(args, cwd = root, env) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", env: childEnv(env) });
  if (result.status !== 0) {
    throw new Error(`command failed: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runAllowFailure(args, cwd = root, env) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", env: childEnv(env) });
  if (!result.stdout.trim()) {
    throw new Error(`command produced no stdout: node ${cli} ${args.join(" ")}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runExpectError(args, cwd = root) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", env: childEnv() });
  if (result.status === 0) {
    throw new Error(`expected command to fail: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}`);
  }
  return result.stderr;
}

function git(cwd, args, env) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

let miseChecked = false;
let miseOnPath = false;
function miseAvailable() {
  if (!miseChecked) {
    miseChecked = true;
    miseOnPath = spawnSync("mise", ["--version"], { encoding: "utf8" }).status === 0;
  }
  return miseOnPath;
}

// End-to-end guard: the real `mise` binary must parse the generated config. Skips
// silently where mise is not installed (e.g. minimal CI). Catches TOML syntax
// regressions like a stray `]`; the structural assertions guard the hook shape.
function assertMiseParses(repo, label) {
  if (!miseAvailable()) return;
  const misePath = join(repo, "mise.toml");
  spawnSync("mise", ["trust", misePath], { encoding: "utf8" });
  const result = spawnSync("mise", ["tasks"], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, `${label}: mise must parse the generated mise.toml\n${result.stderr}`);
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjangler-${name}-`));
  writeFileSync(join(repo, "mise.toml"), "[env]\n_.path = [\".mise/scripts\"]\n");
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n");
  return repo;
}

function makeRepoWithoutMiseToml(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjangler-${name}-`));
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n");
  return repo;
}

function makeLegacyRuntimeRepo(name) {
  const repo = makeRepo(name);
  const runtimeSource = mkdtempSync(join(tmpdir(), `pjangler-${name}-runtime-source-`));
  repos.push(repo, runtimeSource);

  git(runtimeSource, ["init", "--quiet", "-b", "main"]);
  git(runtimeSource, ["config", "user.email", "fixture@example.invalid"]);
  git(runtimeSource, ["config", "user.name", "Fixture"]);
  writeFileSync(join(runtimeSource, "version.txt"), "one\n");
  git(runtimeSource, ["add", "version.txt"]);
  git(runtimeSource, ["commit", "--quiet", "-m", "one"]);
  const firstPin = git(runtimeSource, ["rev-parse", "HEAD"]);
  writeFileSync(join(runtimeSource, "version.txt"), "two\n");
  git(runtimeSource, ["commit", "--quiet", "-am", "two"]);
  const secondPin = git(runtimeSource, ["rev-parse", "HEAD"]);

  const roleDir = join(repo, "agents", "hermes", "pm");
  const runtimeDir = join(roleDir, "runtime");
  const privatePath = join(runtimeDir, "private-state.bin");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), "repo: demo\nrole: pm\nagent_id: demo-pm\nprofile: demo-pm\n");
  writeFileSync(join(roleDir, ".gitignore"), ".scripts/.provision.log\nruntime/\n");
  writeFileSync(privatePath, Buffer.from([0, 17, 34, 51, 68, 255]));
  writeFileSync(
    join(repo, ".gitmodules"),
    `[submodule "templates/commonproject"]
\tpath = templates/commonproject
\turl = git@github.com:delorenj/CommonProject.git
[submodule "legacy-runtime-name"]
\tpath = agents/hermes/pm/runtime
\turl = git@github.com:example/agent-hm-demo-pm.git
`,
  );

  git(repo, ["init", "--quiet", "-b", "main"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["fetch", "--quiet", runtimeSource, "main"]);
  git(repo, ["add", ".gitmodules", "AGENTS.md", "mise.toml", "agents/hermes/pm/role.yaml", "agents/hermes/pm/.gitignore"]);
  git(repo, ["update-index", "--add", "--cacheinfo", `160000,${firstPin},agents/hermes/pm/runtime`]);
  git(repo, ["commit", "--quiet", "-m", "legacy runtime gitlink"]);
  git(repo, ["update-index", "--cacheinfo", `160000,${secondPin},agents/hermes/pm/runtime`]);

  return {
    repo,
    roleDir,
    runtimeDir,
    privatePath,
    privateBytes: readFileSync(privatePath),
    runtimeEntries: readdirSync(runtimeDir),
    secondPin,
  };
}

function assertAgentSymlinks(repo) {
  for (const file of ["CLAUDE.md", "GEMINI.md"]) {
    const full = join(repo, file);
    assert.equal(lstatSync(full).isSymbolicLink(), true, `${file} should be a symlink`);
    assert.equal(readlinkSync(full), "AGENTS.md");
  }
}

const repos = [];
try {
  {
    const repo = makeRepo("link-script");
    repos.push(repo);
    run(["migrate", "mise.config-root", repo, "--json"]);
    run(["migrate", "secrets.env-op", repo, "--json"]);
    run(["migrate", "sot.agent-symlinks", repo, "--json"]);

    const script = join(repo, ".mise", "scripts", "link-agentfiles.sh");
    assert.equal(existsSync(script), true, "migrate must copy .mise/scripts/link-agentfiles.sh");
    const scriptText = readFileSync(script, "utf8");
    assert.match(scriptText, /AGENTS\.md links verified in/);
    // PJAN-82: the two load-bearing halves of the hardened script. Assert the
    // BEHAVIOUR, not just that a file arrived — the previous version was copied
    // faithfully for months while destroying hand-written CLAUDE.md files.
    assert.match(scriptText, /refusing to replace the real file/, "must refuse to clobber a regular CLAUDE.md");
    assert.match(scriptText, /refusing to act on/, "must refuse a root it does not belong to");
    assertAgentSymlinks(repo);

    // PJAN-84: the audit must reject a hook that runs a managed script without
    // handing it config_root as its SUBJECT.
    //
    // The old check only asserted the hook string CONTAINED
    // `'{{config_root}}/.mise/scripts/link-agentfiles.sh'`, which the
    // subject-bearing form also contains — so it passed on both, and never
    // looked at the two python hooks at all. Every cwd hazard sat under a green
    // audit. Re-running the audit here found 22 more repos on this machine.
    {
      const bare = makeRepo("subjectless-hooks");
      repos.push(bare);
      writeFileSync(join(bare, "mise.toml"), `[env]
_.path = [".mise/scripts"]

[[hooks.enter]]
script = "'{{config_root}}/.mise/scripts/link-agentfiles.sh'"
[[hooks.enter]]
script = "python3 '{{config_root}}/.mise/scripts/sync-skills.py' --scope project"
[[hooks.enter]]
script = "python3 '{{config_root}}/.mise/scripts/provision-packs.py'"
`);
      const audited = JSON.parse(runAllowFailure(["audit", bare, "--json"], root));
      const rule = audited.rules.find((entry) => entry.id === "mise.config-root");
      const subjectIssues = rule.details.filter((detail) => detail.includes("as its subject"));
      assert.equal(subjectIssues.length, 3, `all three managed hooks must be reported: ${JSON.stringify(rule.details)}`);
      for (const name of ["link-agentfiles.sh", "sync-skills.py", "provision-packs.py"]) {
        assert.ok(subjectIssues.some((detail) => detail.includes(name)), `${name} must be named`);
      }
      run(["migrate", "mise.config-root", bare, "--json"], root);
      const repaired = JSON.parse(runAllowFailure(["audit", bare, "--json"], root))
        .rules.find((entry) => entry.id === "mise.config-root");
      assert.equal(
        repaired.details.filter((detail) => detail.includes("as its subject")).length,
        0,
        `migrate must clear every subject issue: ${JSON.stringify(repaired.details)}`,
      );
    }

    // Prove it, rather than trusting the text.
    const precious = join(repo, "CLAUDE.md");
    rmSync(precious, { force: true });
    writeFileSync(precious, "HAND-WRITTEN, MUST SURVIVE\n");
    const clobber = spawnSync(script, [repo], { cwd: repo, encoding: "utf8" });
    assert.notEqual(clobber.status, 0, "a real CLAUDE.md must make the script refuse");
    assert.equal(readFileSync(precious, "utf8"), "HAND-WRITTEN, MUST SURVIVE\n", "the file must be untouched");
    rmSync(precious, { force: true });

    // And that a foreign root is refused, which is what stops a parent mise
    // config's enter hook from relinking whichever child you cd'd into.
    const foreign = mkdtempSync(join(tmpdir(), "pjangler-foreign-root-"));
    repos.push(foreign);
    writeFileSync(join(foreign, "AGENTS.md"), "other\n");
    const crossRepo = spawnSync(script, [foreign], { cwd: foreign, encoding: "utf8" });
    assert.notEqual(crossRepo.status, 0, "a foreign root must be refused");
    assert.equal(existsSync(join(foreign, "CLAUDE.md")), false, "nothing may be written into the foreign root");
  }

  {
    const repo = makeRepo("path-parity");
    repos.push(repo);
    writeFileSync(join(repo, "mise.toml"), "[env]\n_.path = [\".mise/scripts\", \"bin\"]\n");
    run(["migrate", "mise.config-root", repo, "--json"]);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.match(mise, /_\.path = \["\.mise\/scripts", "bin", "agents\/hermes\/pm"\]/, "mise.toml _.path should include agents/hermes/pm and preserve existing entries");
    assert.match(mise, /sync-skills\.py' --scope project/, "mise.toml should install the project-local skills sync hook");
    assert.doesNotMatch(mise, /script = "sync-skills\.py --scope project"/, "mise.toml must not invoke a missing bare sync-skills executable");

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"]));
    const finding = audit.rules.find((rule) => rule.id === "mise.config-root");
    assert.equal(finding.status, "pass", JSON.stringify(finding));
  }

  {
    const repo = makeRepo("hermes-executable-path");
    repos.push(repo);
    mkdirSync(join(repo, "agents", "hermes", "pm"), { recursive: true });
    writeFileSync(join(repo, "agents", "hermes", "pm", "hermes"), "#!/usr/bin/env bash\necho hermes\n");
    run(["migrate", "mise.config-root", repo, "--json"]);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.match(mise, /agents\/hermes\/pm\/hermes/, "mise.toml _.path should include agents/hermes/pm/hermes when that executable exists");

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"]));
    const finding = audit.rules.find((rule) => rule.id === "mise.config-root");
    assert.equal(finding.status, "pass", JSON.stringify(finding));
  }

  {
    const repo = makeRepo("preserve-hooks");
    repos.push(repo);
    writeFileSync(join(repo, "mise.toml"), `[env]
_.path = [".mise/scripts"]

[hooks]
enter = [
  ".mise/scripts/link-agentfiles.sh",
  "custom-enter-hook",
]
leave = [
  "custom-leave-hook",
]

[tasks.other]
run = "echo still here"
`);
    run(["migrate", "mise.config-root", repo, "--json"]);
    run(["migrate", "secrets.env-op", repo, "--json"]);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.match(mise, /\[\[hooks\.enter\]\]/, "migrate should emit [[hooks.enter]] tables");
    assert.doesNotMatch(mise, /^\s*enter\s*=\s*\[/m, "migrate must not emit the invalid enter = [ ... ] array form");
    assert.match(mise, /script = "custom-enter-hook"/, "migrate must preserve unrelated enter hooks");
    assert.match(mise, /\[\[hooks\.leave\]\]\nscript = "custom-leave-hook"/, "migrate must preserve unrelated leave hooks as a table");
    assert.match(mise, /\[tasks\.other\]\nrun = "echo still here"/, "migrate must preserve unrelated tasks");
    // PJAN-82: every path is still single-quoted (space-safe), and the script is
    // now handed config_root as its SUBJECT. An enter hook's cwd is the entered
    // directory, so a script that reads its subject from cwd reshapes whichever
    // nested repo you cd'd into.
    assert.match(mise, /script = "'\{\{config_root\}\}\/\.mise\/scripts\/link-agentfiles\.sh' '\{\{config_root\}\}'"/, "link-agentfiles hook must be single-quoted (space-safe) and carry its subject root");
    assert.match(
      mise,
      /script = "'\{\{config_root\}\}\/\.mise\/scripts\/materialize-env\.sh'"/,
      "the env materialization recipe should install the managed script hook"
    );
    assert.match(
      mise,
      /script = "python3 '\{\{config_root\}\}\/\.mise\/scripts\/sync-skills\.py' --scope project --root '\{\{config_root\}\}'"/,
      "migrate should install the shipped project-local skills sync engine, rooted at config_root"
    );
    assert.match(mise, /\[tasks\."skills:sync"\]/, "migrate should add the canonical skills:sync task");
    assertMiseParses(repo, "preserve-hooks");
  }

  {
    // Regression guard: a preserved hook entry whose command contains a literal
    // `]` (e.g. a `[ -f ... ]` shell test) must not be mistaken for the enter
    // array's closing bracket. Previously the real `]` leaked one line down,
    // producing a duplicate `]` that crashed `mise` with a TOML parse error.
    const repo = makeRepo("preserve-hooks-bracket-in-string");
    repos.push(repo);
    writeFileSync(join(repo, "mise.toml"), `[env]
_.path = [".mise/scripts"]

[hooks]
enter = [
  ".mise/scripts/link-agentfiles.sh",
  "op inject -i .env.op > .env",
  "[ -f {{config_root}}/.mise/scripts/codegraph.sh ] && {{config_root}}/.mise/scripts/codegraph.sh || true",
]

[tasks.other]
run = "echo still here"
`);
    run(["migrate", "mise.config-root", repo, "--json"]);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.doesNotMatch(mise, /\]\s*\n\s*\]/, "migrate must not emit a duplicate closing bracket");
    assert.match(mise, /\[\[hooks\.enter\]\]/, "migrate should convert the array to [[hooks.enter]] tables");
    assert.doesNotMatch(mise, /^\s*enter\s*=\s*\[/m, "migrate must not emit the invalid enter = [ ... ] array form");
    assert.match(
      mise,
      /script = "\[ -f \{\{config_root\}\}\/\.mise\/scripts\/codegraph\.sh \] && \{\{config_root\}\}\/\.mise\/scripts\/codegraph\.sh \|\| true"/,
      "migrate must preserve a foreign codegraph hook entry verbatim",
    );
    assert.match(mise, /\[tasks\.other\]\nrun = "echo still here"/, "migrate must preserve unrelated tasks");
    // Bracket balance (ignoring quoted strings) must be even — a stray `]` breaks it.
    const structural = mise.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''");
    assert.equal(
      (structural.match(/\[/g) ?? []).length,
      (structural.match(/\]/g) ?? []).length,
      "generated mise.toml must have balanced brackets outside of strings"
    );
    assertMiseParses(repo, "preserve-hooks-bracket-in-string");
  }

  {
    // Self-heal guard: a mise.toml already corrupted by a prior buggy run (a
    // duplicate `]` closing the enter array) must be repaired on the next
    // migrate, not left broken.
    const repo = makeRepo("selfheal-duplicate-bracket");
    repos.push(repo);
    writeFileSync(join(repo, "mise.toml"), `[env]
_.path = [".mise/scripts"]

[hooks]
enter = [
  "{{config_root}}/.mise/scripts/link-agentfiles.sh",
  "op inject -i .env.op > .env",
  "[ -f {{config_root}}/.mise/scripts/codegraph.sh ] && {{config_root}}/.mise/scripts/codegraph.sh || true",
]
]

[tasks.other]
run = "echo still here"
`);
    run(["migrate", "mise.config-root", repo, "--json"]);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.doesNotMatch(mise, /\]\s*\n\s*\]/, "migrate must repair a duplicate closing bracket left by a prior run");
    assert.match(mise, /\[\[hooks\.enter\]\]/, "repaired mise.toml should use [[hooks.enter]] tables");
    assert.doesNotMatch(mise, /^\s*enter\s*=\s*\[/m, "repaired mise.toml must not carry the invalid array form");
    const structural = mise.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''");
    assert.equal(
      (structural.match(/\[/g) ?? []).length,
      (structural.match(/\]/g) ?? []).length,
      "repaired mise.toml must have balanced brackets outside of strings"
    );
    assertMiseParses(repo, "selfheal-duplicate-bracket");
  }

  {
    // Idempotency: a full `pj init` pass (mise.config-root + mise.versioning),
    // re-run, must be byte-identical. Regression guard for the config-root pass
    // swallowing the `# >>> mise-versioning >>>` marker and duplicating the
    // hooks comment header on re-run.
    const repo = makeRepo("hooks-idempotent");
    repos.push(repo);
    const initOnce = () => {
      run(["migrate", "mise.config-root", repo, "--json"]);
      run(["migrate", "mise.versioning", repo, "--json"]);
    };
    initOnce();
    const first = readFileSync(join(repo, "mise.toml"), "utf8");
    initOnce();
    const second = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.equal(second, first, "re-running the full init (config-root + versioning) must be idempotent");
    assert.match(first, /\[\[hooks\.enter\]\]/, "canonical mise.toml uses [[hooks.enter]] tables");
    assert.equal((first.match(/# >>> mise-versioning >>>/g) ?? []).length, 1, "exactly one versioning open marker");
    assert.equal((first.match(/# <<< mise-versioning <<</g) ?? []).length, 1, "exactly one versioning close marker");
    assert.equal((first.match(/This block will handle the linking of/g) ?? []).length, 1, "exactly one hooks comment header");
    assertMiseParses(repo, "hooks-idempotent");
  }

  {
    // Bootstrap mise.toml from the CommonProject template with the agent-hooks
    // layer ENABLED. Regression guard for PJAN: the naive renderer used to leave
    // literal `{% if agent_hooks_layer %}` Jinja in the generated mise.toml,
    // producing "TOML parse error ... invalid key-value pair". Force the layer via
    // env so the assertions are deterministic regardless of ~/.agents/hooks.
    const repo = makeRepoWithoutMiseToml("missing-mise-toml");
    repos.push(repo);
    run(["migrate", "mise.config-root", repo, "--json"], root, { PJ_AGENT_HOOKS_LAYER: "1" });

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.doesNotMatch(mise, /\{%/, "bootstrap must not leak ANY unevaluated Jinja statement tag into mise.toml");
    assert.match(mise, /\[tasks\."link:agentfiles"\]/, "mise.toml from template should contain the link:agentfiles task");
    assert.match(mise, /script = "'\{\{config_root\}\}\/\.mise\/scripts\/materialize-env\.sh'"/, "mise.toml should retain the managed env materialization hook");
    assert.match(mise, /sync-skills\.py' --scope project/, "mise.toml should run project skill sync on enter");
    assert.match(mise, /\[tasks\."skills:sync"\]/, "mise.toml should include the skills:sync task");
    assert.match(mise, /patterns = \["\.agents\/skills\.json"\]/, "mise.toml should watch the project skills manifest");
    assert.match(mise, /patterns = \["AGENTS.md"\]/, "mise.toml should include AGENTS.md watch_files pattern");
    assert.doesNotMatch(mise, /init-project|create-plane-project|test-template|lint-template/, "bootstrap must not copy the template repository's dev tasks");
    assert.doesNotMatch(mise, /\{%/, "bootstrap must not leak ANY unevaluated Jinja statement tag into mise.toml");
    assert.match(mise, /\[tasks\."hooks:sync"\]/, "agent-hooks layer ON should wire the hooks:sync task");

    const script = join(repo, ".mise", "scripts", "link-agentfiles.sh");
    assert.equal(existsSync(script), true, "migrate must copy .mise/scripts/link-agentfiles.sh");

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"], root, { PJ_AGENT_HOOKS_LAYER: "1" }));
    const finding = audit.rules.find((rule) => rule.id === "mise.config-root");
    assert.equal(finding.status, "pass", JSON.stringify(finding));
  }

  {
    // Same bootstrap with the agent-hooks layer DISABLED (a global ~/.agents/hooks
    // install exists). The conditional blocks must be dropped cleanly — still no
    // literal Jinja, and no per-project hooks-sync wiring.
    const repo = makeRepoWithoutMiseToml("missing-mise-toml-no-hooks-layer");
    repos.push(repo);
    run(["migrate", "mise.config-root", repo, "--json"], root, { PJ_AGENT_HOOKS_LAYER: "0" });

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.doesNotMatch(mise, /\{%/, "bootstrap must not leak ANY unevaluated Jinja statement tag into mise.toml");
    assert.match(mise, /\[tasks\."link:agentfiles"\]/, "mise.toml should still contain the link:agentfiles task");
    assert.match(mise, /script = "'\{\{config_root\}\}\/\.mise\/scripts\/materialize-env\.sh'"/, "mise.toml should retain the managed env materialization hook");
    assert.match(mise, /sync-skills\.py' --scope project/, "skills sync should stay enabled even when the hook layer is skipped");
    assert.match(mise, /\[tasks\."skills:sync"\]/, "skills:sync task should remain when the hook layer is skipped");
    assert.doesNotMatch(mise, /\[tasks\."hooks:sync"\]/, "agent-hooks layer OFF should omit the hooks:sync task");
    assert.doesNotMatch(mise, /link-project-skills-to-clis/, "agent-hooks layer OFF should omit the legacy skill fan-out wiring");

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"], root, { PJ_AGENT_HOOKS_LAYER: "0" }));
    const finding = audit.rules.find((rule) => rule.id === "mise.config-root");
    assert.equal(finding.status, "pass", JSON.stringify(finding));
  }

  {
    const repo = makeRepoWithoutMiseToml("missing-mise-toml-dry-run");
    repos.push(repo);
    const report = JSON.parse(run(["migrate", "mise.config-root", repo, "--dry-run", "--json"]));
    const result = report.results.find((r) => r.id === "mise.config-root");
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(existsSync(join(repo, "mise.toml")), false, "dry-run must not create mise.toml");
    assert.ok(result.changedFiles.some((f) => f.endsWith("mise.toml")), "dry-run should report mise.toml would be created");
  }

  {
    const repo = makeRepo("skills-manifest-legacy");
    repos.push(repo);
    mkdirSync(join(repo, ".agents", "skills", "example-skill"), { recursive: true });
    mkdirSync(join(repo, ".agents", "skills", "bmad-agent-pm"), { recursive: true });
    writeFileSync(join(repo, ".agents", "skills", "example-skill", "SKILL.md"), "# project skill\n");
    writeFileSync(join(repo, ".agents", "skills", "bmad-agent-pm", "COPIED"), "legacy copied tree\n");
    writeFileSync(
      join(repo, ".agents", "skills.json"),
      JSON.stringify({
        inherit_global: false,
        skills: [{ name: "example-skill", source: `file://${join(repo, ".agents", "skills", "example-skill")}` }],
      }, null, 2) + "\n"
    );
    mkdirSync(join(repo, ".mise", "scripts"), { recursive: true });
    writeFileSync(join(repo, ".mise", "scripts", "link-project-skills-to-clis.sh"), "#!/bin/bash\n");
    writeFileSync(join(repo, ".mise", "scripts", "unlink-project-skills-from-clis.sh"), "#!/bin/bash\n");
    writeFileSync(
      join(repo, ".agents", "local.example.json"),
      JSON.stringify({ hooks: { disabled: [] }, skills: { defer_to_global: true } }, null, 2) + "\n"
    );
    writeFileSync(
      join(repo, "mise.toml"),
      `[env]\n_.path = [".mise/scripts"]\n\n[[hooks.enter]]\nscript = "sync-skills.py --scope project"\n\n[tasks.skills-relink]\nrun = "{{config_root}}/.mise/scripts/link-project-skills-to-clis.sh"\n`
    );

    // Pin the pack root the way every other pack block here does. The implicit
    // PJAN-76: no pack is pinned implicitly, so this block asserts only what
    // the repo itself declares. The pack-root override stays so a declared pack
    // resolves to the fixture rather than to whichever registry checkout
    // happens to exist on the host — a property of the machine, not of the
    // migration under test.
    const packEnv = { PJ_PACK_ROOT_PJTEST: selectedBmadPack };
    const staleAudit = JSON.parse(runAllowFailure(["audit", repo, "--json"], root, packEnv));
    const staleFinding = staleAudit.rules.find((r) => r.id === "skills.project-manifest");
    assert.equal(staleFinding.status, "fail", JSON.stringify(staleFinding));

    run(["migrate", "skills.project-manifest", repo, "--json"], root, packEnv);

    const manifest = JSON.parse(readFileSync(join(repo, ".agents", "skills.json"), "utf8"));
    assert.equal(manifest.inherit_global, true, "migrate should create the canonical skills manifest");
    assert.equal(manifest.registry, "https://github.com/delorenj/skillex.git");
    assert.deepEqual(manifest.skills[0], { name: "example-skill", source: `file://${join(repo, ".agents", "skills", "example-skill")}` }, "non-BMAD manifest entries must be preserved");
    assert.equal(
      manifest.skills.length,
      1,
      `migrate must record only what the repo declares: ${JSON.stringify(manifest.skills)}`,
    );
    assert.equal(existsSync(join(repo, ".agents", "skills", "example-skill", "SKILL.md")), true, "non-BMAD skill trees must remain intact");
    // bmad-* is the installer's namespace. A copied tree there is left exactly
    // as found rather than rewritten into a pack symlink.
    assert.equal(
      lstatSync(join(repo, ".agents", "skills", "bmad-agent-pm")).isSymbolicLink(),
      false,
      "a bmad-* tree belongs to bmad-method and must be left alone",
    );
    assert.equal(existsSync(join(repo, ".mise", "scripts", "provision-packs.py")), true, "migrate should install the generic Skillex pack provisioner");
    assert.equal(existsSync(join(repo, ".mise", "scripts", "provision-bmad-skills.py")), false, "migrate should retire the BMAD-only provisioner");
    assert.equal(existsSync(join(repo, ".mise", "scripts", "sync-skills.py")), true, "migrate should install the project-local skills sync engine");
    assert.equal(existsSync(join(repo, ".mise", "scripts", "link-project-skills-to-clis.sh")), false, "legacy link script should be removed");
    assert.equal(existsSync(join(repo, ".mise", "scripts", "unlink-project-skills-from-clis.sh")), false, "legacy unlink script should be removed");
    const localExample = JSON.parse(readFileSync(join(repo, ".agents", "local.example.json"), "utf8"));
    assert.equal(Object.hasOwn(localExample, "skills"), false, "legacy skills overrides should be removed from local.example");

    const currentAudit = JSON.parse(runAllowFailure(["audit", repo, "--json"], root, packEnv));
    const currentFinding = currentAudit.rules.find((r) => r.id === "skills.project-manifest");
    assert.equal(currentFinding.status, "pass", JSON.stringify(currentFinding));
  }

  // PACKS-CONTRACT: a repo that declares `packs[]` gets its members projected as
  // symlinks and must NOT carry them in `skills[]` any more. The audit reports
  // (a) redundant skills[] entries, (b) the dead $schema host, (c) the retired
  // provision-bmad-skills.py and (d) the retired skills-provision-bmad task, and
  // `migrate` fixes all four.
  {
    const repo = makeRepo("skills-manifest-declared-pack");
    repos.push(repo);
    const localSkill = join(repo, ".agents", "skills", "local-thing");
    mkdirSync(localSkill, { recursive: true });
    writeFileSync(join(localSkill, "SKILL.md"), "# local\n");
    mkdirSync(join(repo, ".mise", "scripts"), { recursive: true });
    writeFileSync(join(repo, ".mise", "scripts", "provision-bmad-skills.py"), "#!/usr/bin/env python3\n");
    writeFileSync(
      join(repo, ".agents", "skills.json"),
      JSON.stringify(
        {
          $schema: "https://raw.githubusercontent.com/skillex/schemas/main/skills.schema.json",
          inherit_global: true,
          registry: "https://github.com/delorenj/skillex.git",
          packs: ["pjtest"],
          skills: [
            { name: "local-thing", source: `file://${localSkill}` },
            { name: "pjtest-agent-pm", source: `file://${join(selectedBmadPack, "pjtest-agent-pm")}` },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(repo, "mise.toml"),
      `[env]\n_.path = [".mise/scripts"]\n\n[tasks.skills-sync]\ndepends = ["skills-provision-bmad"]\nrun = "python3 '{{config_root}}/.mise/scripts/sync-skills.py' --scope project"\n\n[tasks.skills-provision-bmad]\nrun = "python3 '{{config_root}}/.mise/scripts/provision-bmad-skills.py'"\n`,
    );

    const packEnv = { PJ_PACK_ROOT_PJTEST: selectedBmadPack };
    const before = JSON.parse(runAllowFailure(["audit", repo, "--json"], root, packEnv));
    const beforeFinding = before.rules.find((entry) => entry.id === "skills.project-manifest");
    assert.equal(beforeFinding.status, "fail", JSON.stringify(beforeFinding));
    const beforeDetails = beforeFinding.details.join("\n");
    assert.match(beforeDetails, /duplicates 1 declared pack member\(s\).*pjtest-agent-pm/);
    assert.match(beforeDetails, /\$schema still points at the retired/);
    assert.match(beforeDetails, /provision-bmad-skills\.py is the retired BMAD-only provisioner/);
    assert.match(beforeDetails, /still references the retired skills-provision-bmad/);

    const migrated = JSON.parse(run(["migrate", "skills.project-manifest", repo, "--json"], root, packEnv));
    assert.equal(
      migrated.results.find((entry) => entry.id === "skills.project-manifest").status,
      "applied",
      JSON.stringify(migrated),
    );

    const declaredManifest = JSON.parse(readFileSync(join(repo, ".agents", "skills.json"), "utf8"));
    assert.equal(declaredManifest.$schema, "https://raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json");
    assert.deepEqual(declaredManifest.packs, ["pjtest"], "declared packs must be preserved verbatim");
    assert.deepEqual(
      declaredManifest.skills,
      [{ name: "local-thing", source: `file://${localSkill}` }],
      "a declared pack replaces its hand-expanded members and leaves everything else alone",
    );
    assert.equal(
      resolve(join(repo, ".agents", "skills"), readlinkSync(join(repo, ".agents", "skills", "pjtest-agent-pm"))),
      join(selectedBmadPack, "pjtest-agent-pm"),
      "declared pack members must still be projected as symlinks",
    );
    assert.equal(existsSync(join(localSkill, "SKILL.md")), true, "non-pack skills must survive");
    assert.equal(existsSync(join(repo, ".mise", "scripts", "provision-packs.py")), true);
    assert.equal(existsSync(join(repo, ".mise", "scripts", "provision-bmad-skills.py")), false);
    const declaredMise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.match(declaredMise, /\[tasks\."skills:provision:packs"\]/);
    assert.doesNotMatch(declaredMise, /skills-provision-bmad/);
    assert.doesNotMatch(declaredMise, /provision-bmad-skills\.py/);

    const after = JSON.parse(runAllowFailure(["audit", repo, "--json"], root, packEnv));
    const afterFinding = after.rules.find((entry) => entry.id === "skills.project-manifest");
    assert.equal(afterFinding.status, "pass", JSON.stringify(afterFinding));
    const rerun = JSON.parse(run(["migrate", "skills.project-manifest", repo, "--json"], root, packEnv));
    assert.equal(rerun.results.find((entry) => entry.id === "skills.project-manifest").status, "noop", JSON.stringify(rerun));
  }

  // A skills[] entry pointing OUTSIDE the declared pack is the user's and must
  // never be removed, even when its name collides with a pack member.
  {
    const repo = makeRepo("skills-manifest-declared-pack-override");
    repos.push(repo);
    const override = join(repo, ".agents", "skills.bak", "pjtest-agent-pm");
    mkdirSync(override, { recursive: true });
    writeFileSync(join(override, "SKILL.md"), "# customized\n");
    writeFileSync(
      join(repo, ".agents", "skills.json"),
      JSON.stringify(
        {
          $schema: "https://raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json",
          inherit_global: true,
          registry: "https://github.com/delorenj/skillex.git",
          packs: ["pjtest"],
          skills: [{ name: "pjtest-agent-pm", source: `file://${override}` }],
        },
        null,
        2,
      ) + "\n",
    );
    const packEnv = { PJ_PACK_ROOT_PJTEST: selectedBmadPack };
    run(["migrate", "skills.project-manifest", repo, "--json"], root, packEnv);
    const manifest = JSON.parse(readFileSync(join(repo, ".agents", "skills.json"), "utf8"));
    assert.deepEqual(
      manifest.skills,
      [{ name: "pjtest-agent-pm", source: `file://${override}` }],
      "an override pointing outside the pack must survive migration",
    );
    assert.equal(readFileSync(join(override, "SKILL.md"), "utf8"), "# customized\n");
  }

  // PJAN-76: nothing is pinned implicitly, so a block that is ABOUT pack
  // resolution has to declare the pack it means. Before, these leaned on the
  // implicit BMAD pin being present in every repo.
  const declarePjtestPack = (repo) => {
    mkdirSync(join(repo, ".agents"), { recursive: true });
    writeFileSync(
      join(repo, ".agents", "skills.json"),
      `${JSON.stringify({ packs: [{ name: "pjtest", version: "6.10.1-next.31" }], skills: [] }, null, 2)}\n`,
    );
  };

  {
    // A DECLARED pack that cannot be resolved must block the migration rather
    // than quietly producing a project missing the skills it asked for. Before
    // PJAN-76 this was exercised through the implicit BMAD pin; the safety
    // property is the same, it just needs something declared to be about.
    const repo = makeRepo("skills-manifest-missing-pack");
    repos.push(repo);
    declarePjtestPack(repo);
    const report = JSON.parse(runAllowFailure(
      ["migrate", "skills.project-manifest", repo, "--json"],
      root,
      { PJ_PACK_ROOT_PJTEST: join(repo, "missing-pack") }
    ));
    const result = report.results.find((r) => r.id === "skills.project-manifest");
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.ok(result.details.some((detail) => detail.includes("pjtest")), JSON.stringify(result));
  }

  {
    const repo = makeRepo("skills-manifest-partial-pack");
    repos.push(repo);
    declarePjtestPack(repo);
    const partialPack = mkdtempSync(join(tmpdir(), "pjangler-partial-bmad-pack-"));
    repos.push(partialPack);
    copyFileSync(join(selectedBmadPack, "SHA256SUMS"), join(partialPack, "SHA256SUMS"));
    copyFileSync(join(selectedBmadPack, "pack.toml"), join(partialPack, "pack.toml"));
    cpSync(join(selectedBmadPack, "pjtest-agent-pm"), join(partialPack, "pjtest-agent-pm"), { recursive: true });

    const report = JSON.parse(runAllowFailure(
      ["migrate", "skills.project-manifest", repo, "--json"],
      root,
      { PJ_PACK_ROOT_PJTEST: partialPack }
    ));
    const result = report.results.find((entry) => entry.id === "skills.project-manifest");
    assert.equal(result.status, "blocked", JSON.stringify(result));
    // Generic contract: every DECLARED skill directory must exist before the
    // payload is hashed, so a half-copied pack fails to resolve outright.
    assert.match(result.details.join("\n"), /could not be resolved/);
    assert.match(result.details.join("\n"), /is not present/);
    assert.equal(existsSync(join(repo, ".agents", "skills")), false, "partial pack rejection must precede project mutation");
  }

  {
    const repo = makeRepo("skills-manifest-tampered-pack");
    repos.push(repo);
    declarePjtestPack(repo);
    const tamperedPack = mkdtempSync(join(tmpdir(), "pjangler-tampered-bmad-pack-"));
    repos.push(tamperedPack);
    cpSync(selectedBmadPack, tamperedPack, { recursive: true });
    writeFileSync(join(tamperedPack, "pjtest-agent-pm", "SKILL.md"), "tampered\n");

    const report = JSON.parse(runAllowFailure(
      ["migrate", "skills.project-manifest", repo, "--json"],
      root,
      { PJ_PACK_ROOT_PJTEST: tamperedPack }
    ));
    const result = report.results.find((entry) => entry.id === "skills.project-manifest");
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.match(result.details.join("\n"), /digest mismatch/);
    assert.equal(existsSync(join(repo, ".agents", "skills")), false, "tampered pack rejection must precede project mutation");

    copyFileSync(join(selectedBmadPack, "pjtest-agent-pm", "SKILL.md"), join(tamperedPack, "pjtest-agent-pm", "SKILL.md"));
    mkdirSync(join(tamperedPack, "pjtest-agent-pm", "unauthenticated-empty"));
    const topologyReport = JSON.parse(runAllowFailure(
      ["migrate", "skills.project-manifest", repo, "--json"],
      root,
      { PJ_PACK_ROOT_PJTEST: tamperedPack }
    ));
    const topologyResult = topologyReport.results.find((entry) => entry.id === "skills.project-manifest");
    assert.equal(topologyResult.status, "blocked", JSON.stringify(topologyResult));
    assert.match(topologyResult.details.join("\n"), /unauthenticated empty directories/);
    assert.equal(existsSync(join(repo, ".agents", "skills")), false, "unauthenticated topology rejection must precede project mutation");
  }

  {
    const repo = makeRepo("skills-manifest-symlink-boundary");
    repos.push(repo);
    declarePjtestPack(repo);
    const outside = mkdtempSync(join(tmpdir(), "pjangler-outside-skills-"));
    repos.push(outside);
    writeFileSync(join(outside, "sentinel"), "do-not-touch\n");
    mkdirSync(join(repo, ".agents"), { recursive: true });
    symlinkSync(outside, join(repo, ".agents", "skills"), "dir");
    const report = JSON.parse(runAllowFailure(["migrate", "skills.project-manifest", repo, "--json"]));
    const result = report.results.find((r) => r.id === "skills.project-manifest");
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.match(result.details.join("\n"), /symlinked project skills directory/);
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "do-not-touch\n");
    assert.deepEqual(readdirSync(outside), ["sentinel"], "migration must not mutate a symlinked skills target");
  }

  {
    const repo = makeRepo("all-rules");
    repos.push(repo);
    const report = JSON.parse(runAllowFailure(["migrate", "--all", repo, "--json"]));
    assert.ok(report.selectedRules.length > 1, "--all should select more than one rule");
    assert.ok(report.results.length === report.selectedRules.length, "results should match selected rules");
    assert.ok(report.results.some((r) => r.status === "applied"), "at least one rule should be applied");
  }

  {
    // bmad.version: detect drift against the target npm channel and offer an
    // upgrade. Seed the dist-tags cache (via XDG_CACHE_HOME) so the rule is
    // deterministic and offline — no live npm lookup in the test.
    const cacheHome = mkdtempSync(join(tmpdir(), "pjangler-bmadcache-"));
    repos.push(cacheHome);
    mkdirSync(join(cacheHome, "pjangler"), { recursive: true });
    writeFileSync(
      join(cacheHome, "pjangler", "bmad-dist-tags.json"),
      JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.10.0", next: "6.10.1-next.12" } })
    );
    const bmadEnv = { XDG_CACHE_HOME: cacheHome };

    const writeManifest = (repo, version) => {
      mkdirSync(join(repo, "_bmad", "_config"), { recursive: true });
      writeFileSync(join(repo, "_bmad", "_config", "manifest.yaml"), `installation:\n  version: ${version}\nmodules:\n  - name: core\n    version: ${version}\n`);
    };

    // Stale install -> warn + fixable.
    const stale = makeRepo("bmad-version-stale");
    repos.push(stale);
    writeManifest(stale, "6.8.0");
    const staleAudit = JSON.parse(runAllowFailure(["audit", stale, "--json"], root, bmadEnv));
    const staleFinding = staleAudit.rules.find((r) => r.id === "bmad.version");
    assert.equal(staleFinding.status, "warn", JSON.stringify(staleFinding));
    assert.equal(staleFinding.fixable, true, "stale BMAD should be fixable");
    assert.match(staleFinding.summary, /behind stable 6\.10\.0/, JSON.stringify(staleFinding));

    // dry-run migrate previews the upgrade without writing.
    const dry = JSON.parse(run(["migrate", "bmad.version", stale, "--dry-run", "--json"], root, bmadEnv));
    const dryResult = dry.results.find((r) => r.id === "bmad.version");
    assert.equal(dryResult.status, "applied", JSON.stringify(dryResult));
    assert.match(dryResult.summary, /Would upgrade BMAD 6\.8\.0 -> 6\.10\.1-next\.12/, JSON.stringify(dryResult));

    // PJAN-82: at or ahead of STABLE but behind the moving `next` prerelease
    // -> pass, with the prerelease still reported. `next` advances every few
    // days, so warning here made every repository on the machine permanently
    // non-parity: auditRecipes counts anything but pass/skip as not-ok and
    // ProjectRecipe turns a not-ok postcondition audit into a transaction
    // error, so a brand-new project broke the moment upstream cut a release.
    const prerelease = makeRepo("bmad-version-prerelease-only");
    repos.push(prerelease);
    writeManifest(prerelease, "6.10.1-next.3");
    const preAudit = JSON.parse(runAllowFailure(["audit", prerelease, "--json"], root, bmadEnv));
    const preFinding = preAudit.rules.find((r) => r.id === "bmad.version");
    assert.equal(preFinding.status, "pass", JSON.stringify(preFinding));
    assert.equal(preFinding.fixable, false, "a moving prerelease is news, not a fixable defect");
    assert.match(preFinding.summary, /at or ahead of stable 6\.10\.0/, JSON.stringify(preFinding));
    assert.ok(preFinding.details.some((d) => d.includes("6.10.1-next.12")), `the available prerelease stays visible: ${JSON.stringify(preFinding)}`);
    // ... and an explicit, targeted migrate still takes it, even though the
    // audit passed. `migrate --all` does not, because it only selects fail/warn.
    const preDry = JSON.parse(run(["migrate", "bmad.version", prerelease, "--dry-run", "--json"], root, bmadEnv));
    const preDryResult = preDry.results.find((r) => r.id === "bmad.version");
    assert.equal(preDryResult.status, "applied", JSON.stringify(preDryResult));
    assert.match(preDryResult.summary, /Would upgrade BMAD 6\.10\.1-next\.3 -> 6\.10\.1-next\.12/, JSON.stringify(preDryResult));

    // Current install (== target channel) -> pass, not fixable.
    const current = makeRepo("bmad-version-current");
    repos.push(current);
    writeManifest(current, "6.10.1-next.12");
    const currentAudit = JSON.parse(runAllowFailure(["audit", current, "--json"], root, bmadEnv));
    const currentFinding = currentAudit.rules.find((r) => r.id === "bmad.version");
    assert.equal(currentFinding.status, "pass", JSON.stringify(currentFinding));

    // No BMAD install -> skip (bmad.scaffold owns absence).
    const none = makeRepo("bmad-version-none");
    repos.push(none);
    const noneAudit = JSON.parse(runAllowFailure(["audit", none, "--json"], root, bmadEnv));
    const noneFinding = noneAudit.rules.find((r) => r.id === "bmad.version");
    assert.equal(noneFinding.status, "skip", JSON.stringify(noneFinding));
    assert.equal(noneFinding.fixable, false, "absent BMAD version rule must not be fixable");
  }

  {
    const repo = makeRepo("director-scaffold-parity");
    const home = mkdtempSync(join(tmpdir(), "pjangler-director-scaffold-home-"));
    repos.push(repo, home);
    git(repo, ["init", "--quiet", "-b", "main"]);
    const roleDir = join(repo, "agents", "hermes", "director");
    mkdirSync(join(roleDir, ".scripts"), { recursive: true });
    mkdirSync(join(roleDir, ".runtime-scaffold"), { recursive: true });
    mkdirSync(join(roleDir, "runtime", "memories"), { recursive: true });
    writeFileSync(
      join(roleDir, "role.yaml"),
      "repo: demo\nrole: director\nagent_id: demo-director\nprofile: demo-director\ndisplay_name: Demo Director\nbloodbank:\n  enabled: false\nticket_provider:\n  name: plane\n",
    );
    writeFileSync(join(roleDir, "SOUL.md"), "custom director soul\n");
    writeFileSync(join(roleDir, "hermes"), "#!/usr/bin/env bash\n# stale wrapper\n");
    writeFileSync(join(roleDir, ".gitignore"), "stale\n");
    writeFileSync(join(roleDir, ".scripts", "70-systemd.sh"), "#!/usr/bin/env bash\n# stale systemd\n");
    writeFileSync(join(roleDir, ".runtime-scaffold", "README.md"), "scaffold\n");
    writeFileSync(join(roleDir, "runtime", "memories", "MEMORY.md"), "private state\n");
    writeFileSync(join(roleDir, "runtime", "profile.yaml"), "config:\n  inherit_from: default\n  save_mode: delta\n");
    writeFileSync(
      join(repo, ".project.json"),
      `${JSON.stringify({
        project_name: "Demo",
        repo_path: repo,
        agents: {
          "demo-director": {
            role: "director",
            role_dir: "agents/hermes/director",
            provisioning_state: "planned",
          },
        },
      }, null, 2)}\n`,
    );
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "agents-registry.yaml"),
      `schema_version: 1\nagents:\n  demo-director:\n    bloodbank:\n      enabled: false\n      gateway_scope: fleet\n      target_agent_id: demo-director\n`,
    );
    const env = { HOME: home, XDG_CACHE_HOME: join(home, ".cache") };

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"], root, env));
    const finding = audit.rules.find((entry) => entry.id === "hermes.pm-scaffold");
    assert.equal(finding.status, "fail", JSON.stringify(finding));
    assert.match(finding.details.join("\n"), /demo-director: stale agents\/hermes\/director\/hermes/);
    assert.match(finding.details.join("\n"), /demo-director: stale agents\/hermes\/director\/\.scripts\/70-systemd\.sh/);
    assert.match(finding.details.join("\n"), /demo-director: missing agents\/hermes\/director\/\.scripts\/20-runtime-repo\.sh/);

    const migrated = JSON.parse(run(["migrate", "hermes.pm-scaffold", repo, "--json"], root, env));
    const result = migrated.results.find((entry) => entry.id === "hermes.pm-scaffold");
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(readFileSync(join(roleDir, "SOUL.md"), "utf8"), "custom director soul\n", "existing role contract must be preserved");
    assert.match(readFileSync(join(roleDir, "hermes"), "utf8"), /TERMINAL_CWD="\$REPO_ROOT"/);
    // TERMINAL_CWD used to be a literal `Environment="TERMINAL_CWD=$REPO_ROOT"`
    // line in the generated script. It now goes through
    // parse-fleet-env.py --systemd-environment, which validates and quotes the
    // value first; the line that reaches the unit is byte-identical
    // (Environment="TERMINAL_CWD=<repo root>"). Assert the wiring rather than
    // one spelling of the output — matching the spelling is what rotted here.
    const systemdScript = readFileSync(join(roleDir, ".scripts", "70-systemd.sh"), "utf8");
    assert.match(systemdScript, /ENV_TERMINAL_CWD="\$\(systemd_environment TERMINAL_CWD "\$REPO_ROOT"\)"/);
    assert.match(systemdScript, /^\$ENV_TERMINAL_CWD$/m);
    assert.match(readFileSync(join(roleDir, ".scripts", "20-runtime-repo.sh"), "utf8"), /migrate hermes\.runtime-singleton/);
    assert.equal(readFileSync(join(roleDir, "runtime", "memories", "MEMORY.md"), "utf8"), "private state\n");

    const postAudit = JSON.parse(runAllowFailure(["audit", repo, "--json"], root, env));
    const postFinding = postAudit.rules.find((entry) => entry.id === "hermes.pm-scaffold");
    assert.equal(postFinding.status, "pass", JSON.stringify(postFinding));
  }

  {
    const fixture = makeLegacyRuntimeRepo("retired-runtime-submodule-mapping");
    const { repo, roleDir, runtimeDir, privatePath, privateBytes, runtimeEntries, secondPin } = fixture;
    assert.match(git(repo, ["ls-files", "--stage", "--", "agents/hermes/pm/runtime"]), new RegExp(`^160000 ${secondPin} 0\\t`));
    const report = JSON.parse(run(["migrate", "hermes.untracked-runtimes", repo, "--json"]));
    const result = report.results.find((entry) => entry.id === "hermes.untracked-runtimes");
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.deepEqual(readFileSync(privatePath), privateBytes, "index-only retirement must preserve private runtime bytes");
    assert.deepEqual(readdirSync(runtimeDir), runtimeEntries, "index-only retirement must preserve the runtime tree");
    assert.equal(git(repo, ["ls-files", "--stage", "--", "agents/hermes/pm/runtime"]), "", "runtime gitlink must be absent from the index");
    const gitmodules = readFileSync(join(repo, ".gitmodules"), "utf8");
    assert.match(gitmodules, /templates\/commonproject/);
    assert.doesNotMatch(gitmodules, /agents\/hermes\/pm\/runtime/);
    assert.match(readFileSync(join(roleDir, ".gitignore"), "utf8"), /^runtime\/$/m);

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"]));
    const auditFinding = audit.rules.find((entry) => entry.id === "hermes.untracked-runtimes");
    assert.equal(auditFinding.status, "pass", JSON.stringify(auditFinding));

    const rerun = JSON.parse(run(["migrate", "hermes.untracked-runtimes", repo, "--json"]));
    const rerunResult = rerun.results.find((entry) => entry.id === "hermes.untracked-runtimes");
    assert.equal(rerunResult.status, "noop", JSON.stringify(rerunResult));
  }

  {
    const fixture = makeLegacyRuntimeRepo("retired-runtime-submodule-git-failure");
    const { repo, runtimeDir, privatePath, privateBytes, runtimeEntries, secondPin } = fixture;
    const fakeBin = mkdtempSync(join(tmpdir(), "pjangler-failing-git-"));
    repos.push(fakeBin);
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const wrapper = join(fakeBin, "git");
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash
if [[ "$1" == "rm" ]]; then
  printf 'injected git rm failure\\n' >&2
  exit 97
fi
exec "$REAL_GIT" "$@"
`,
    );
    chmodSync(wrapper, 0o755);

    const report = JSON.parse(runAllowFailure(
      ["migrate", "hermes.untracked-runtimes", repo, "--json"],
      root,
      { PATH: `${fakeBin}:${process.env.PATH}`, REAL_GIT: realGit },
    ));
    const result = report.results.find((entry) => entry.id === "hermes.untracked-runtimes");
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.match(result.details.join("\n"), /injected git rm failure/);
    assert.match(git(repo, ["ls-files", "--stage", "--", "agents/hermes/pm/runtime"]), new RegExp(`^160000 ${secondPin} 0\\t`), "failed removal must preserve the staged gitlink");
    assert.match(readFileSync(join(repo, ".gitmodules"), "utf8"), /agents\/hermes\/pm\/runtime/, "failed removal must preserve the stale mapping");
    assert.deepEqual(readFileSync(privatePath), privateBytes, "failed removal must preserve private runtime bytes");
    assert.deepEqual(readdirSync(runtimeDir), runtimeEntries, "failed removal must preserve the runtime tree");
  }

  {
    const repo = makeRepo("unknown-rule");
    repos.push(repo);
    const stderr = runExpectError(["migrate", "not-a-real-rule", repo]);
    assert.match(stderr, /Unknown parity rule/);
  }

  // PJAN-61: a dash-era repo must be renamed onto the colon namespace in every
  // syntactic position mise resolves a task name from — section header,
  // watch_files dispatch, and depends entry — while the dashed SCRIPT filenames
  // (link-agentfiles.sh, provision-packs.py) are left alone. The dash/colon
  // split is what left `depends` pointing at a task that no longer existed.
  {
    const repo = makeRepo("retired-task-names");
    repos.push(repo);
    writeFileSync(
      join(repo, "mise.toml"),
      [
        "[env]",
        '_.path = [".mise/scripts"]',
        "",
        "[[watch_files]]",
        'patterns = ["AGENTS.md"]',
        'task = "link-agentfiles"',
        "",
        "[[watch_files]]",
        'patterns = [".agents/skills.json"]',
        'task = "skills-sync"',
        "",
        "[tasks.link-agentfiles]",
        `run = "'{{config_root}}/.mise/scripts/link-agentfiles.sh'"`,
        "",
        "[tasks.skills-sync]",
        'depends = ["skills-provision-packs"]',
        `run = "python3 '{{config_root}}/.mise/scripts/sync-skills.py' --scope project"`,
        "",
        "[tasks.skills-provision-packs]",
        `run = "python3 '{{config_root}}/.mise/scripts/provision-packs.py'"`,
        "",
        "[tasks.hooks-check]",
        `run = "'{{config_root}}/.agents/hooks/sync.py' --check"`,
        "",
      ].join("\n"),
    );

    const before = JSON.parse(runAllowFailure(["audit", repo, "--json"], root));
    const beforeFinding = before.rules.find((entry) => entry.id === "mise.config-root");
    assert.equal(beforeFinding.status, "fail", JSON.stringify(beforeFinding));
    const beforeDetails = beforeFinding.details.join("\n");
    for (const retired of ["link-agentfiles", "skills-sync", "skills-provision-packs", "hooks-check"]) {
      assert.match(
        beforeDetails,
        new RegExp(`still uses the retired task name "${retired}"`),
        `audit should report the retired ${retired} task: ${beforeDetails}`,
      );
    }

    run(["migrate", "mise.config-root", repo, "--json"], root);
    const mise = readFileSync(join(repo, "mise.toml"), "utf8");

    for (const name of ["link:agentfiles", "skills:sync", "skills:provision:packs", "hooks:check"]) {
      assert.match(mise, new RegExp(`\\[tasks\\."${name.replace(/:/g, ":")}"\\]`), `${name} task header must be quoted-colon: ${mise}`);
    }
    assert.match(mise, /task = "link:agentfiles"/, "watch_files must dispatch the renamed task");
    assert.match(mise, /task = "skills:sync"/, "watch_files must dispatch the renamed skills task");
    assert.match(mise, /depends = \["skills:provision:packs"\]/, "depends must follow the rename");
    // A bare TOML key may not contain `:` — an unquoted header would make the
    // whole file unparseable, which is worse than the drift it replaced. The
    // real mise binary is the only honest check that the rename is loadable.
    assert.doesNotMatch(mise, /^\[tasks\.[a-z]+:[^\]]*\]$/m, `colon task headers must stay quoted: ${mise}`);
    assertMiseParses(repo, "retired task rename");
    // Parsing is not enough: the renamed tasks must actually be ADDRESSABLE by
    // their new names, or `mise run skills:sync` dies with "task not found" —
    // the exact failure the dash/colon split caused.
    if (miseAvailable()) {
      const listed = spawnSync("mise", ["tasks", "--no-header"], { cwd: repo, encoding: "utf8" });
      assert.equal(listed.status, 0, `mise tasks must succeed after the rename\n${listed.stderr}`);
      for (const name of ["link:agentfiles", "skills:sync", "skills:provision:packs", "hooks:check"]) {
        assert.match(listed.stdout, new RegExp(`^${name}\\b`, "m"), `mise must list ${name}:\n${listed.stdout}`);
      }
    }
    for (const retired of ["link-agentfiles", "skills-sync", "skills-provision-packs", "hooks-check"]) {
      assert.doesNotMatch(
        mise,
        new RegExp(`^\\[tasks\\.(?:"${retired}"|${retired})\\]`, "m"),
        `retired ${retired} task header must be gone: ${mise}`,
      );
      assert.doesNotMatch(mise, new RegExp(`task = "${retired}"`), `retired ${retired} dispatch must be gone`);
    }
    // Script FILENAMES stay dashed — only task names moved.
    assert.match(mise, /link-agentfiles\.sh/, "the dashed script filename must survive the task rename");
    assert.match(mise, /provision-packs\.py/, "the dashed provisioner filename must survive the task rename");

    const after = JSON.parse(runAllowFailure(["audit", repo, "--json"], root));
    const afterDetails = (after.rules.find((entry) => entry.id === "mise.config-root").details ?? []).join("\n");
    assert.doesNotMatch(afterDetails, /still uses the retired task name/, afterDetails);

    const rerun = JSON.parse(run(["migrate", "mise.config-root", repo, "--json"], root));
    assert.equal(
      rerun.results.find((entry) => entry.id === "mise.config-root").status,
      "noop",
      `rename must be idempotent: ${JSON.stringify(rerun)}`,
    );
  }

  {
    const stderr = runExpectError(["migrate"]);
    assert.match(stderr, /interactive terminal/);
  }

  console.log("parity migrate regressions passed");
} finally {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  rmSync(bmadFixtureRoot, { recursive: true, force: true });
}
