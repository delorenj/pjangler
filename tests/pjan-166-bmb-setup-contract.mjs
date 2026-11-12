import { SUITE_GRANTS } from "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
import { createBmadInstallerFixture } from "./helpers/pack-fixture.mjs";
import { FIXTURE_COMPARABLE_PATHS, applyBmbSetupModel, bmadTreeShape } from "./helpers/bmb-setup-model.mjs";

// PJAN-166 / Contract A, against the REAL thing. Network/cache-backed release contract: it
// FAILS, never skips, when the pinned installer, the bmb module (a GitHub clone) or uv/PyYAML
// are unavailable, so a green publish cannot certify a contract nobody ran. Not part of
// `npm test` (hermetic, offline-safe); `npm run test:bmad-config-authority`.
//
// What it does, with no hand-written imitation of upstream anywhere in the flow:
//   1. installs BMAD through pjangler's own `migrate bmad.scaffold` (the real pinned
//      installer, bmm+bmb+cis) and audits it                         -> Expected-outcomes row 1
//   2. runs the REAL bmad-bmb-setup scripts out of the installed skill, with the commands read
//      from its SKILL.md, headless and accepting defaults, and audits   -> row 2, with the remedy
//   3. repairs with `pj migrate bmad.scaffold` (a reinstall) and audits  -> row 3
//   4. repeats setup and repair (AC3: the two flows flip-flop for good, and must converge at each step)
//   5. deletes config.toml / scripts/ / cis/config.yaml from the real tree -> rows 5, 6, 7
// and it keeps the hermetic suite honest: the structural BMB model and the installer fixture that
// tests/pjan-166-config-authority-regressions.mjs runs on are compared with what really happened.
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const scratch = hermeticScratch("pjan-166-bmb-contract-");
const home = join(scratch, "home");
const target = join(scratch, "target");
const projectName = "PJAN 166 Config Authority";
const MANIFEST_LINE = /^_bmad\/_config\/manifest\.yaml/;

function diagnostics(result) {
  return [result.error?.message, result.stdout, result.stderr, result.signal ? `signal: ${result.signal}` : undefined]
    .filter(Boolean).join("\n").trim().slice(-12_000);
}

// A clean env (the private HOME is an empty npm/uv cache, as on a CI runner) plus what
// SUITE_PASSTHROUGH grants this suite: the GitHub token the real installer reads to resolve the
// bmb/cis tags, and the TLS trust anchors.
const env = hermeticEnv({
  HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"), XDG_DATA_HOME: join(home, ".local", "share"),
  PJ_PROJECT_REGISTRY: join(scratch, "registry.yaml"),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  CI: "true", FORCE_COLOR: "0", NO_COLOR: "1", npm_config_update_notifier: "false", npm_config_fund: "false",
}, { pass: SUITE_GRANTS });

function runRequired(command, args, purpose, { cwd = root, timeout = 600_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout });
  if (result.status !== 0) {
    throw new Error(
      `REAL BMB CONFIG-AUTHORITY CONTRACT FAILED: ${purpose}. This publish gate does not skip when npm, GitHub, uv or PyYAML are unavailable.\n${diagnostics(result)}`,
    );
  }
  return result;
}

function pj(args, purpose) {
  // audit exits 1 for a failing rule and migrate for a blocked one; the JSON is what is judged.
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: target, env, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 600_000 });
  assert.ok(result.stdout.trim(), `${purpose}: pj printed no JSON\n${diagnostics(result)}`);
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`${purpose}: pj printed invalid JSON (${error.message})\n${diagnostics(result)}`); }
}
const audit = (purpose) => {
  const finding = pj(["audit", "--rules", "bmad.scaffold"], purpose).rules.find((rule) => rule.id === "bmad.scaffold");
  assert.ok(finding, `${purpose}: bmad.scaffold finding missing`);
  return finding;
};
const migrate = (purpose) => {
  const report = pj(["migrate", "bmad.scaffold"], purpose);
  const result = report.results.find((entry) => entry.id === "bmad.scaffold");
  assert.ok(result, `${purpose}: bmad.scaffold result missing`);
  return { report, result };
};

const bmad = (...segments) => join(target, "_bmad", ...segments);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const hashes = (paths) => Object.fromEntries(paths.map((path) => [path, existsSync(bmad(path)) ? sha(bmad(path)) : null]));

/** The `uv run ./scripts/...` lines of the installed skill's own SKILL.md, with its placeholders resolved. */
function bmbSetupCommands(skillDir, answersPath) {
  const text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const lines = [...text.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((block) => block[1].split("\n")).map((line) => line.trim()).filter((line) => line.startsWith("uv run "));
  assert.deepEqual(
    lines.map((line) => /\.\/scripts\/([\w-]+\.py)/.exec(line)?.[1]),
    ["merge-config.py", "merge-help-csv.py", "cleanup-legacy.py"],
    "bmad-bmb-setup's SKILL.md no longer prescribes merge-config, merge-help-csv, cleanup-legacy in that order: upstream changed, re-derive Contract A",
  );
  return lines.map((line) => {
    // Tokenize first, substitute second: a resolved path may contain a space.
    const words = [...line.matchAll(/"([^"]*)"|(\S+)/g)]
      .map((match) => (match[1] ?? match[2]).replaceAll("{project-root}", target).replaceAll("{temp-file}", answersPath));
    assert.deepEqual(words.slice(0, 2), ["uv", "run"], line);
    return words.slice(2);
  });
}

let uvAvailable;
function runScript(skillDir, [script, ...args], purpose) {
  uvAvailable ??= spawnSync("uv", ["--version"], { env, encoding: "utf8" }).status === 0;
  // The scripts are PEP 723 (`dependencies = ["pyyaml"]`); uv resolves that. Without uv, python3 must have PyYAML.
  const [command, argv] = uvAvailable ? ["uv", ["run", script, ...args]] : ["python3", [script, ...args]];
  return JSON.parse(runRequired(command, argv, purpose, { cwd: skillDir, timeout: 300_000 }).stdout);
}

/** Replay BMB's setup exactly as its skill prescribes: headless, defaults accepted. */
function runBmbSetup(label) {
  const skillDir = join(target, ".agents", "skills", "bmad-bmb-setup");
  assert.ok(existsSync(join(skillDir, "SKILL.md")), "the real install must provide the bmad-bmb-setup skill (bmb module)");
  // The answers file is the one input the skill leaves to the agent. Headless "accept all defaults":
  // each module variable that has a prompt takes its default from the module's own module.yaml,
  // and `core` is omitted because it already exists (SKILL.md: "omit `core` if it already exists").
  const moduleYaml = YAML.parse(readFileSync(join(skillDir, "assets", "module.yaml"), "utf8"));
  const defaults = Object.fromEntries(Object.entries(moduleYaml)
    .filter(([, value]) => value && typeof value === "object" && "prompt" in value && "default" in value)
    .map(([key, value]) => [key, value.default]));
  assert.ok(Object.keys(defaults).length > 0, "module.yaml defines no prompted variable: upstream changed");
  const answers = join(scratch, `answers-${label.replace(/\W+/g, "-")}.json`);
  writeFileSync(answers, JSON.stringify({ module: defaults }));
  const [mergeConfig, mergeHelp, cleanup] = bmbSetupCommands(skillDir, answers);
  const merged = runScript(skillDir, mergeConfig, `${label}: merge-config.py`);
  const help = runScript(skillDir, mergeHelp, `${label}: merge-help-csv.py`);
  const cleaned = runScript(skillDir, cleanup, `${label}: cleanup-legacy.py`);
  assert.equal(merged.status, "success", JSON.stringify(merged));
  assert.equal(help.status, "success", JSON.stringify(help));
  assert.equal(cleaned.status, "success", JSON.stringify(cleaned));
  return { merged, help, cleaned };
}

function assertBrokenOnlyByTheInstallRecord(label) {
  const finding = audit(label);
  assert.equal(finding.status, "fail", `${label}: ${JSON.stringify(finding)}`);
  assert.equal(finding.fixable, true, label);
  assert.equal(finding.details.length, 1, `${label}: Contract A reports the manifest and nothing else: ${JSON.stringify(finding.details)}`);
  assert.match(finding.details[0], MANIFEST_LINE, label);
  assert.match(finding.details[0], /--also-remove _config/, `${label}: must name the cause`);
  assert.match(finding.details[0], /pj migrate bmad\.scaffold/, `${label}: must name the remedy`);
}

function assertRepaired(label) {
  const { report, result } = migrate(label);
  assert.equal(report.ok, true, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.status, "applied", `${label}: ${JSON.stringify(result)}`);
  assert.ok(result.changedFiles.includes(bmad("_config", "manifest.yaml")), `${label}: ${JSON.stringify(result.changedFiles)}`);
  const finding = audit(`${label} (re-audit)`);
  assert.equal(finding.status, "pass", `${label}: ${JSON.stringify(finding)}`);
}

try {
  assert.ok(existsSync(cli), "build first: npm run build (the contract drives dist/index.js)");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, ".project.json"), `${JSON.stringify({ project_id: "pjan-166-contract", project_name: projectName, bmad: { companion: { enabled: false } } })}\n`);

  // ---- 1. a real install, through pjangler's own path ------------------------------------------
  const installed = migrate("fresh install");
  assert.equal(installed.report.ok, true, JSON.stringify(installed.result));
  assert.equal(installed.result.status, "applied", JSON.stringify(installed.result));
  const fresh = audit("fresh install");
  assert.equal(fresh.status, "pass", `row 1 (fresh install): ${JSON.stringify(fresh)}`);
  const modules = (YAML.parse(readFileSync(bmad("_config", "manifest.yaml"), "utf8")).modules ?? []).map((entry) => entry.name);
  for (const name of ["core", "bmm", "bmb", "cis"]) assert.ok(modules.includes(name), `the real install must select ${name}: ${modules}`);

  // The hermetic suites' installer fixture must look like this install, where the audit is concerned.
  const fixtureTarget = join(scratch, "fixture-target");
  mkdirSync(fixtureTarget);
  runRequired(createBmadInstallerFixture(scratch), ["install", "--yes", "--directory", fixtureTarget, "--modules", "bmm,bmb,cis", "--tools", "claude-code", "--set", `core.project_name=${projectName}`], "running the installer fixture");
  assert.deepEqual(
    bmadTreeShape(fixtureTarget, FIXTURE_COMPARABLE_PATHS).present,
    bmadTreeShape(target, FIXTURE_COMPARABLE_PATHS).present,
    "tests/helpers/pack-fixture.mjs createBmadInstallerFixture no longer writes what the real installer writes where Contract A looks: update the fixture",
  );

  // ---- what BMB must not touch, and a copy to hold the model to ---------------------------------
  const untouchedByBmb = ["config.toml", "scripts/resolve_config.py", "scripts/config_utils.py"];
  const beforeBmb = hashes(untouchedByBmb);
  assert.ok(Object.values(beforeBmb).every(Boolean), `the real install is missing ${JSON.stringify(beforeBmb)}`);
  const preBmbCopy = join(scratch, "pre-bmb");
  cpSync(bmad(), join(preBmbCopy, "_bmad"), { recursive: true });

  // ---- 2. the real BMB setup --------------------------------------------------------------------
  const setup = runBmbSetup("setup 1");
  assert.ok(setup.merged.legacy_configs_deleted.some((path) => path.endsWith("/bmb/config.yaml")), JSON.stringify(setup.merged));
  assert.ok(setup.merged.legacy_configs_deleted.some((path) => path.endsWith("/core/config.yaml")), JSON.stringify(setup.merged));
  for (const dir of ["bmb", "core", "_config"]) assert.ok(setup.cleaned.directories_removed.includes(dir), `cleanup-legacy must remove ${dir}: ${JSON.stringify(setup.cleaned)}`);
  assert.deepEqual(hashes(untouchedByBmb), beforeBmb, "BMB's setup must not touch config.toml or the resolver scripts (Contract A's first two sentinels)");
  assert.ok(Object.hasOwn(YAML.parse(readFileSync(bmad("config.yaml"), "utf8")), "bmb"), "BMB's setup writes a bmb section into the consolidated config.yaml");
  assertBrokenOnlyByTheInstallRecord("post-BMB (row 2)");

  // The model the hermetic suite runs on must produce what the real scripts produced from the same tree.
  applyBmbSetupModel(preBmbCopy);
  assert.deepEqual(bmadTreeShape(preBmbCopy), bmadTreeShape(target), "tests/helpers/bmb-setup-model.mjs diverged from the real BMB setup: update the model");

  // ---- 3. the repair is a reinstall; it must not undo what BMB wrote ------------------------------
  const bmbOwned = ["config.yaml", "config.user.yaml", "module-help.csv"];
  const bmbOwnedBefore = hashes(bmbOwned);
  assert.ok(Object.values(bmbOwnedBefore).every(Boolean), JSON.stringify(bmbOwnedBefore));
  assertRepaired("post-BMB + reinstall (row 3)");
  assert.deepEqual(hashes(bmbOwned), bmbOwnedBefore, "the reinstall must leave BMB's own three files untouched");
  for (const path of ["core/config.yaml", "bmb/config.yaml", "_config/manifest.yaml"]) assert.ok(existsSync(bmad(path)), `the reinstall restores ${path}`);

  // ---- 4. AC3: repeat setup and repair, twice more; each step converges ---------------------------
  for (const round of [2, 3]) {
    runBmbSetup(`setup ${round}`);
    assertBrokenOnlyByTheInstallRecord(`post-BMB again, round ${round}`);
    assertRepaired(`repair again, round ${round}`);
  }

  // ---- 5. the sentinels that must still fail, on the real tree ------------------------------------
  const restoreAfter = (label, relative) => {
    const path = bmad(relative);
    const held = join(scratch, `held-${label.replace(/\W+/g, "-")}`);
    renameSync(path, held);
    try { return audit(label); }
    finally { rmSync(path, { recursive: true, force: true }); renameSync(held, path); }
  };
  let finding = restoreAfter("config.toml missing (row 5)", "config.toml");
  assert.equal(finding.status, "fail");
  assert.ok(finding.details.includes("_bmad/config.toml"), JSON.stringify(finding.details));
  finding = restoreAfter("scripts/ missing (row 6)", "scripts");
  assert.equal(finding.status, "fail");
  assert.deepEqual(finding.details, ["_bmad/scripts/resolve_config.py", "_bmad/scripts/config_utils.py"]);
  finding = restoreAfter("cis/config.yaml missing (row 7)", "cis/config.yaml");
  assert.equal(finding.status, "fail");
  assert.ok(finding.details.some((line) => line.startsWith("_bmad/cis/config.yaml")), JSON.stringify(finding.details));
  finding = restoreAfter("core/config.yaml missing, the dropped sentinel", "core/config.yaml");
  assert.equal(finding.status, "pass", `core/config.yaml is no longer a sentinel: ${JSON.stringify(finding)}`);
  assert.equal(audit("everything restored").status, "pass");

  console.log("PJAN-166 BMB config-authority contract passed (real bmad-method install, real bmad-bmb-setup scripts, Contract A rows 1-3 and 5-7, repeat setup/repair x3)");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
