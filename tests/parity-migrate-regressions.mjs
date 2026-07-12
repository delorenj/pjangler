import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, lstatSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");

function run(args, cwd = root, env) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
  if (result.status !== 0) {
    throw new Error(`command failed: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runAllowFailure(args, cwd = root, env) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
  if (!result.stdout.trim()) {
    throw new Error(`command produced no stdout: node ${cli} ${args.join(" ")}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runExpectError(args, cwd = root) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  if (result.status === 0) {
    throw new Error(`expected command to fail: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}`);
  }
  return result.stderr;
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
    run(["migrate", "sot.agent-symlinks", repo, "--json"]);

    const script = join(repo, ".mise", "scripts", "link-agentfiles.sh");
    assert.equal(existsSync(script), true, "migrate must copy .mise/scripts/link-agentfiles.sh");
    assert.match(readFileSync(script, "utf8"), /AI agent symlinks verified/);
    assertAgentSymlinks(repo);
  }

  {
    const repo = makeRepo("path-parity");
    repos.push(repo);
    writeFileSync(join(repo, "mise.toml"), "[env]\n_.path = [\".mise/scripts\", \"bin\"]\n");
    run(["migrate", "mise.config-root", repo, "--json"]);

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.match(mise, /_\.path = \["\.mise\/scripts", "bin", "agents\/hermes\/pm"\]/, "mise.toml _.path should include agents/hermes/pm and preserve existing entries");

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

    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.match(mise, /\[\[hooks\.enter\]\]/, "migrate should emit [[hooks.enter]] tables");
    assert.doesNotMatch(mise, /^\s*enter\s*=\s*\[/m, "migrate must not emit the invalid enter = [ ... ] array form");
    assert.match(mise, /script = "custom-enter-hook"/, "migrate must preserve unrelated enter hooks");
    assert.match(mise, /\[\[hooks\.leave\]\]\nscript = "custom-leave-hook"/, "migrate must preserve unrelated leave hooks as a table");
    assert.match(mise, /\[tasks\.other\]\nrun = "echo still here"/, "migrate must preserve unrelated tasks");
    assert.match(mise, /script = "'\{\{config_root\}\}\/\.mise\/scripts\/link-agentfiles\.sh'"/, "link-agentfiles hook must be single-quoted (space-safe)");
    assert.match(mise, /script = "op inject -i \.env\.op > \.env"/, "migrate should install canonical dotenv hook");
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
    // Codegraph guard is normalized to the single-quoted, space-safe form.
    assert.match(mise, /\[ -f '\{\{config_root\}\}\/\.mise\/scripts\/codegraph\.sh' \] && '\{\{config_root\}\}\/\.mise\/scripts\/codegraph\.sh' \|\| true/, "migrate must preserve+quote the codegraph hook entry");
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

    assert.equal(existsSync(join(repo, "mise.toml")), true, "migrate must create mise.toml when missing");
    const mise = readFileSync(join(repo, "mise.toml"), "utf8");
    assert.match(mise, /\[tasks\.link-agentfiles\]/, "mise.toml from template should contain link-agentfiles task");
    assert.match(mise, /op inject -i \.env\.op > \.env/, "mise.toml should be normalized to current AGENTS-linking contract");
    assert.match(mise, /patterns = \["AGENTS.md"\]/, "mise.toml should include AGENTS.md watch_files pattern");
    assert.doesNotMatch(mise, /init-project|create-plane-project|test-template|lint-template/, "bootstrap must not copy the template repository's dev tasks");
    assert.doesNotMatch(mise, /\{%/, "bootstrap must not leak ANY unevaluated Jinja statement tag into mise.toml");
    assert.match(mise, /\[tasks\.hooks-sync\]/, "agent-hooks layer ON should wire the hooks-sync task");

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
    assert.match(mise, /\[tasks\.link-agentfiles\]/, "mise.toml should still contain the link-agentfiles task");
    assert.match(mise, /op inject -i \.env\.op > \.env/, "mise.toml should retain the dotenv enter hook");
    assert.doesNotMatch(mise, /\[tasks\.hooks-sync\]/, "agent-hooks layer OFF should omit the hooks-sync task");
    assert.doesNotMatch(mise, /link-project-skills-to-clis/, "agent-hooks layer OFF should omit the skill fan-out wiring");

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
    assert.match(staleFinding.summary, /behind next 6\.10\.1-next\.12/, JSON.stringify(staleFinding));

    // dry-run migrate previews the upgrade without writing.
    const dry = JSON.parse(run(["migrate", "bmad.version", stale, "--dry-run", "--json"], root, bmadEnv));
    const dryResult = dry.results.find((r) => r.id === "bmad.version");
    assert.equal(dryResult.status, "applied", JSON.stringify(dryResult));
    assert.match(dryResult.summary, /Would upgrade BMAD 6\.8\.0 -> 6\.10\.1-next\.12/, JSON.stringify(dryResult));

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
    const repo = makeRepo("unknown-rule");
    repos.push(repo);
    const stderr = runExpectError(["migrate", "not-a-real-rule", repo]);
    assert.match(stderr, /Unknown parity rule/);
  }

  {
    const stderr = runExpectError(["migrate"]);
    assert.match(stderr, /interactive terminal/);
  }

  console.log("parity migrate regressions passed");
} finally {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
}
