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
//   6. deletes only scripts/ and runs `pj migrate bmad.scaffold`: the missing scripts come back from
//      the verified pinned package with no reinstall (install record byte-identical), also on a
//      project the g33 boundary would withhold a reinstall from
// and it keeps the hermetic suite honest: the structural BMB model and the installer fixture that
// tests/pjan-166-config-authority-regressions.mjs runs on are compared with what really happened,
// the model after EVERY real setup run. Row 4 is built from real outputs too: the real post-BMB
// tree plus the real pre-BMB `_config/`.
//
// A failure prints the bmb and cis versions the install resolved: they come from GitHub stable
// tags at install time, so a red run may be an upstream release under an unchanged installer pin.
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

// A clean env per kind of child (the private HOME is an empty npm/uv cache, as on a CI runner),
// plus what SUITE_PASSTHROUGH grants this suite. The GITHUB_TOKEN, which the real installer reads
// to resolve the bmb/cis tags, reaches only the `pj` children that run it; the scripts BMB's setup
// replays and the installer fixture never see it. Every child gets the TLS trust anchors (npm,
// GitHub and, for those scripts, PyPI through uv).
const base = {
  HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"), XDG_DATA_HOME: join(home, ".local", "share"),
  PJ_PROJECT_REGISTRY: join(scratch, "registry.yaml"),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  CI: "true", FORCE_COLOR: "0", NO_COLOR: "1", npm_config_update_notifier: "false", npm_config_fund: "false",
};
const pjEnv = hermeticEnv(base, { pass: SUITE_GRANTS });
const scriptEnv = hermeticEnv(base, { pass: SUITE_GRANTS.filter((name) => name !== "GITHUB_TOKEN") });

// What the real install resolved, appended to every failure: bmb and cis come from GitHub stable
// tags at install time, so a failure here can be an upstream release under an unchanged pin.
let resolvedModules = "not resolved yet (the real install had not completed)";
function withResolvedModules(error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\nResolved at install time: ${resolvedModules}`, { cause: error });
}

function runRequired(command, args, purpose, { cwd = root, timeout = 600_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env: scriptEnv, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout });
  if (result.status !== 0) {
    throw new Error(
      `REAL BMB CONFIG-AUTHORITY CONTRACT FAILED: ${purpose}. This publish gate does not skip when npm, GitHub, uv or PyYAML are unavailable.\n${diagnostics(result)}`,
    );
  }
  return result;
}

function pj(args, purpose) {
  // audit exits 1 for a failing rule and migrate for a blocked one; the JSON is what is judged.
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: target, env: pjEnv, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 600_000 });
  assert.ok(result.stdout.trim(), `${purpose}: pj printed no JSON\n${diagnostics(result)}`);
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`${purpose}: pj printed invalid JSON (${error.message})\n${diagnostics(result)}`); }
}
const audit = (purpose) => {
  const finding = pj(["audit", "--rules", "bmad.scaffold"], purpose).rules.find((rule) => rule.id === "bmad.scaffold");
  assert.ok(finding, `${purpose}: bmad.scaffold finding missing`);
  return finding;
};
const migrate = (purpose, flags = []) => {
  const report = pj(["migrate", "bmad.scaffold", ...flags], purpose);
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
  uvAvailable ??= spawnSync("uv", ["--version"], { env: scriptEnv, encoding: "utf8" }).status === 0;
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

/** Run the real BMB setup on the real tree AND the structural model on a copy of the tree it starts from, and hold the model to the result. */
function runBmbSetupAgainstModel(label) {
  const modelRoot = join(scratch, `model-${label.replace(/\W+/g, "-")}`);
  cpSync(bmad(), join(modelRoot, "_bmad"), { recursive: true });
  const outcome = runBmbSetup(label);
  applyBmbSetupModel(modelRoot);
  assert.deepEqual(bmadTreeShape(modelRoot), bmadTreeShape(target), `${label}: tests/helpers/bmb-setup-model.mjs diverged from the real BMB setup: update the model`);
  return outcome;
}

function assertRepaired(label) {
  const { report, result } = migrate(label);
  assert.equal(report.ok, true, `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.status, "applied", `${label}: ${JSON.stringify(result)}`);
  assert.ok(result.changedFiles.includes(bmad("_config", "manifest.yaml")), `${label}: ${JSON.stringify(result.changedFiles)}`);
  const finding = audit(`${label} (re-audit)`);
  assert.equal(finding.status, "pass", `${label}: ${JSON.stringify(finding)}`);
}

const RUNTIME_SCRIPTS = ["resolve_config.py", "config_utils.py"];
/** The line for a missing resolver script: the sentinel path, then the repair (and git's word when it ignores the path). */
function assertScriptLines(label, finding, scripts = RUNTIME_SCRIPTS) {
  assert.deepEqual(finding.details.map((line) => line.replace(/ \(.*$/s, "")), scripts.map((name) => `_bmad/scripts/${name}`), `${label}: ${JSON.stringify(finding.details)}`);
  for (const line of finding.details) {
    assert.match(line, /\(restore it with: pj migrate bmad\.scaffold\)$/, `${label}: each missing script names the repair`);
    assert.doesNotMatch(line, /git-ignored/, `${label}: the target is not a git work tree, so git ignores nothing`);
  }
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
  const manifest = YAML.parse(readFileSync(bmad("_config", "manifest.yaml"), "utf8"));
  const modules = (manifest.modules ?? []).map((entry) => entry.name);
  resolvedModules = `bmad-method ${manifest.installation?.version ?? "?"}; ${(manifest.modules ?? []).filter((entry) => ["bmb", "cis"].includes(entry.name)).map((entry) => `${entry.name} ${entry.version ?? "(no version recorded)"}`).join(", ") || "no bmb/cis recorded"}`;
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

  // ---- what BMB must not touch, and the real pre-BMB `_config/` (row 4 is built from it) ----------
  const untouchedByBmb = ["config.toml", "scripts/resolve_config.py", "scripts/config_utils.py"];
  const beforeBmb = hashes(untouchedByBmb);
  assert.ok(Object.values(beforeBmb).every(Boolean), `the real install is missing ${JSON.stringify(beforeBmb)}`);
  const preBmbConfig = join(scratch, "pre-bmb-config");
  cpSync(bmad("_config"), preBmbConfig, { recursive: true });

  // ---- 2. the real BMB setup --------------------------------------------------------------------
  // runBmbSetupAgainstModel also holds the structural model the hermetic suite runs on to what the
  // real scripts did to the same tree. It does so in every round below, not just this one.
  const setup = runBmbSetupAgainstModel("setup 1");
  assert.ok(setup.merged.legacy_configs_deleted.some((path) => path.endsWith("/bmb/config.yaml")), JSON.stringify(setup.merged));
  assert.ok(setup.merged.legacy_configs_deleted.some((path) => path.endsWith("/core/config.yaml")), JSON.stringify(setup.merged));
  for (const dir of ["bmb", "core", "_config"]) assert.ok(setup.cleaned.directories_removed.includes(dir), `cleanup-legacy must remove ${dir}: ${JSON.stringify(setup.cleaned)}`);
  assert.deepEqual(hashes(untouchedByBmb), beforeBmb, "BMB's setup must not touch config.toml or the resolver scripts (Contract A's first two sentinels)");
  assert.ok(Object.hasOwn(YAML.parse(readFileSync(bmad("config.yaml"), "utf8")), "bmb"), "BMB's setup writes a bmb section into the consolidated config.yaml");
  assertBrokenOnlyByTheInstallRecord("post-BMB (row 2)");

  // ---- row 4, from real outputs: the 33GOD shape (BMB's real result with `_config/` surviving) ------
  // 33GOD's `_config/` survived its BMB run for a reason the trace could not determine; the tree it
  // leaves is the real post-BMB tree plus the real pre-BMB `_config/`, with nothing imitated.
  cpSync(preBmbConfig, bmad("_config"), { recursive: true });
  const survivor = audit("post-BMB with the real pre-BMB _config/ surviving (row 4)");
  assert.equal(survivor.status, "pass", `row 4 (the 33GOD shape): ${JSON.stringify(survivor)}`);
  // The same tree with the install record then deleted by hand: `_config/` survived BMB, so BMB's cleanup
  // (which deletes the whole directory) cannot be the cause, and the finding must not say it is.
  rmSync(bmad("_config", "manifest.yaml"));
  const handDeleted = audit("real 33GOD shape, install record deleted by hand");
  assert.equal(handDeleted.status, "fail", JSON.stringify(handDeleted));
  assert.equal(handDeleted.details.length, 1, JSON.stringify(handDeleted.details));
  assert.match(handDeleted.details[0], MANIFEST_LINE);
  assert.doesNotMatch(handDeleted.details[0], /also-remove|BMB/, "a surviving _config/ rules BMB's cleanup out");
  assert.match(handDeleted.details[0], /is missing\. Restore it with: pj migrate bmad\.scaffold$/);
  rmSync(bmad("_config"), { recursive: true });
  assertBrokenOnlyByTheInstallRecord("post-BMB again after row 4");

  // ---- 3. the repair is a reinstall; it must not undo what BMB wrote ------------------------------
  const bmbOwned = ["config.yaml", "config.user.yaml", "module-help.csv"];
  const bmbOwnedBefore = hashes(bmbOwned);
  assert.ok(Object.values(bmbOwnedBefore).every(Boolean), JSON.stringify(bmbOwnedBefore));
  assertRepaired("post-BMB + reinstall (row 3)");
  assert.deepEqual(hashes(bmbOwned), bmbOwnedBefore, "the reinstall must leave BMB's own three files untouched");
  for (const path of ["core/config.yaml", "bmb/config.yaml", "_config/manifest.yaml"]) assert.ok(existsSync(bmad(path)), `the reinstall restores ${path}`);

  // ---- 4. AC3: repeat setup and repair, twice more; each step converges ---------------------------
  for (const round of [2, 3]) {
    runBmbSetupAgainstModel(`setup ${round}`);
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
  assertScriptLines("scripts/ missing (row 6)", finding);
  finding = restoreAfter("cis/config.yaml missing (row 7)", "cis/config.yaml");
  assert.equal(finding.status, "fail");
  assert.ok(finding.details.some((line) => line.startsWith("_bmad/cis/config.yaml")), JSON.stringify(finding.details));
  finding = restoreAfter("core/config.yaml missing, the dropped sentinel", "core/config.yaml");
  assert.equal(finding.status, "pass", `core/config.yaml is no longer a sentinel: ${JSON.stringify(finding)}`);
  assert.equal(audit("everything restored").status, "pass");

  // ---- 6. scripts are the only gap: restored from the verified pinned package, never reinstalled ----
  // `_bmad/scripts/` is git-ignored machine-wide, so every fresh clone and new worktree of a repo that
  // does not track it starts exactly here. A reinstall rewrites tracked files and the install record,
  // and on a linked g33 project with no companion adapter it is withheld outright (`blocked`), though
  // bmad.setup-scripts closes the same gap from the pinned package with no reinstall.
  const scriptsDir = bmad("scripts");
  const heldScripts = join(scratch, "held-installed-scripts");
  cpSync(scriptsDir, heldScripts, { recursive: true });
  const recordBefore = sha(bmad("_config", "manifest.yaml"));
  const assertScriptsRestored = (label, flags = []) => {
    const { report, result } = migrate(label, flags);
    assert.equal(report.ok, true, `${label}: ${JSON.stringify(result)}`);
    assert.equal(result.status, "applied", `${label}: ${JSON.stringify(result)}`);
    assert.match(result.summary, /\(no reinstall\)/, `${label}: ${JSON.stringify(result)}`);
    return result;
  };

  rmSync(scriptsDir, { recursive: true });
  assertScriptLines("only scripts/ missing", audit("only scripts/ missing"));
  const preview = assertScriptsRestored("scripts only: preview", ["--dry-run"]);
  assert.ok(preview.changedFiles.length >= RUNTIME_SCRIPTS.length, JSON.stringify(preview.changedFiles));
  assert.equal(existsSync(scriptsDir), false, "a dry run writes nothing");
  const restored = assertScriptsRestored("scripts only: restore");
  assert.ok(restored.changedFiles.length >= RUNTIME_SCRIPTS.length && restored.changedFiles.every((path) => path.startsWith(`${scriptsDir}/`)), JSON.stringify(restored.changedFiles));
  assert.equal(sha(bmad("_config", "manifest.yaml")), recordBefore, "a reinstall rewrites the install record; the restore must not");
  for (const path of restored.changedFiles) {
    assert.equal(sha(path), sha(join(heldScripts, path.slice(scriptsDir.length + 1))), `${path} must be byte-identical to what the real installer wrote`);
  }
  assert.equal(audit("scripts restored").status, "pass");

  // The same gap on a project the g33 boundary governs: enabled, with no adapter configured.
  const projectJson = readFileSync(join(target, ".project.json"), "utf8");
  writeFileSync(join(target, ".project.json"), `${JSON.stringify({ project_id: "pjan-166-contract", project_name: projectName, bmad: { companion: { enabled: true } } })}\n`);
  try {
    const cisConfig = readFileSync(bmad("cis", "config.yaml"));
    rmSync(scriptsDir, { recursive: true });
    rmSync(bmad("cis", "config.yaml"));
    // Control: a second gap makes the repair a reinstall, which the boundary withholds. Without it
    // the next step proves nothing about the boundary.
    const withheld = migrate("scripts and cis missing, g33 enabled with no adapter");
    // The scripts are still restorable from attested bytes, so that part lands ("partial"); the
    // installer-only gap (cis/config.yaml) stays withheld and is named, never reinstalled around.
    assert.equal(withheld.result.status, "partial", JSON.stringify(withheld.result));
    assert.match(withheld.result.summary, /BMAD update withheld: optional g33 companion adapter is not configured/);
    assert.equal(existsSync(bmad("cis", "config.yaml")), false, "the withheld installer must not have rewritten cis/config.yaml");
    rmSync(scriptsDir, { recursive: true });
    writeFileSync(bmad("cis", "config.yaml"), cisConfig);
    assertScriptsRestored("scripts only, g33 enabled with no adapter: restore, not blocked");
    assert.equal(sha(bmad("_config", "manifest.yaml")), recordBefore, "no reinstall under the boundary either");
    assert.equal(audit("scripts restored under the g33 boundary").status, "pass");
  } finally {
    writeFileSync(join(target, ".project.json"), projectJson);
  }

  console.log("PJAN-166 BMB config-authority contract passed (real bmad-method install, real bmad-bmb-setup scripts, Contract A rows 1-7 on real trees, repeat setup/repair x3 each checked against the model, scripts-only restore with no reinstall)");
} catch (error) {
  throw withResolvedModules(error);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
