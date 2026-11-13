import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
import { createBmadInstallerFixture } from "./helpers/pack-fixture.mjs";
import { applyBmbSetupModel } from "./helpers/bmb-setup-model.mjs";
import { COMPANION_FIXTURE_FILES, writeCompanionAdapter } from "./helpers/g33-companion-fixture.mjs";

// PJAN-166 / Contract A: what bmad.scaffold requires of `_bmad/`, judged by what the
// 6.12.1 runtime and BMB's setup actually read and delete. Spec and acceptance oracle:
// _bmad-output/implementation-artifacts/issue-evidence/PJAN-166-config-authority-trace.md
// ("Chosen sentinel contract: Contract A", "Expected outcomes").
//
// HOW HONEST THIS SUITE CAN BE OFFLINE: the baseline tree comes from the shared
// hermetic installer fixture, and BMB's setup is modelled by tests/helpers/
// bmb-setup-model.mjs, because the real bmad-bmb-setup scripts ship in a module the
// installer clones from GitHub. tests/pjan-166-bmb-setup-contract.mjs
// (`npm run test:bmad-config-authority`, network-backed, fails rather than skips) runs the
// REAL installer and the REAL setup scripts and compares the fixture and the model with what
// really happened in EVERY round, so neither can drift from upstream unnoticed. Every row of
// the trace's Expected-outcomes table is covered here and there; the real-tree rows are built
// from real outputs (row 4 from the real pre-BMB `_config/`), not from this model.
//
// ONE PART IS NOT OFFLINE: the targeted `_bmad/scripts` restore tests need the real pinned bmad-method
// package, because its fingerprint is what the restore verifies. They resolve it with npx exactly as
// tests/pjan-166-bmad-setup-scripts-regressions.mjs does (the npm registry, or a warm npx cache) and FAIL
// when it is unavailable; the first failure is remembered, so the rest fail at once rather than each
// waiting out npm again. No GitHub token is needed: no test here runs the real installer.

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const scratch = hermeticScratch("pjan-166-authority-");
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const home = join(scratch, "home");
const catalog = join(scratch, "catalog");
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
for (const name of ["all-skills", "sets", "packs"]) mkdirSync(join(catalog, name), { recursive: true });
put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
put(join(home, ".cache", "pjangler", "bmad-dist-tags.json"), JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.12.1", next: "6.12.1" } }));
const installer = createBmadInstallerFixture(scratch);

const envFor = (overrides = {}) => hermeticEnv({
  HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"), XDG_DATA_HOME: join(home, ".local", "share"),
  PJ_PROJECT_REGISTRY: join(scratch, "registry.yaml"), PJ_SKILLS_REGISTRY_ROOT: catalog,
  PJ_BMAD_INSTALLER: installer, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  ...overrides,
});

let seq = 0;
/** An empty project that opted out of the g33 companion (the plain scaffold path). */
function emptyProject(label) {
  const target = join(scratch, `${label}-${seq++}`);
  mkdirSync(target);
  put(join(target, ".project.json"), JSON.stringify({ project_id: label, project_name: label, bmad: { companion: { enabled: false } } }));
  put(join(target, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(target, ".agents", "skills", "bmad-fixture", "SKILL.md"), "Native BMAD CLI fixture\n");
  return target;
}

function pj(target, args, { env = envFor() } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: target, env, encoding: "utf8", timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  assert.ok(result.stdout.trim(), `${args.join(" ")} produced no JSON\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
const scaffoldAudit = (target, env) => {
  const finding = pj(target, ["audit", "--rules", "bmad.scaffold"], { env }).rules.find((rule) => rule.id === "bmad.scaffold");
  assert.ok(finding, "bmad.scaffold finding missing");
  return finding;
};
const scaffoldMigrate = (target, flags = [], env) => {
  const report = pj(target, ["migrate", "bmad.scaffold", ...flags], { env });
  return { report, result: report.results.find((entry) => entry.id === "bmad.scaffold") };
};

/** The row-1 tree: a project installed through pjangler's own migrate path (the hermetic installer fixture). */
function freshInstall(label, prepare = () => {}) {
  const target = emptyProject(label);
  prepare(target);
  const { result } = scaffoldMigrate(target);
  assert.equal(result.status, "applied", JSON.stringify(result));
  // A never-installed tree is the installer's to write: no scripts restore is attempted, so none is reported.
  assert.equal(result.details.some((line) => /_bmad\/scripts restore/.test(line)), false, JSON.stringify(result.details));
  const audit = scaffoldAudit(target);
  assert.equal(audit.status, "pass", `fresh install must pass: ${JSON.stringify(audit)}`);
  return target;
}

const bmad = (target, ...segments) => join(target, "_bmad", ...segments);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const MANIFEST = "_bmad/_config/manifest.yaml";
const REMEDY = "pj migrate bmad.scaffold";
const INSTALL_RECORD = `${MANIFEST} (the installer's install record)`;
/** The machine-wide ignore list (~/.agents/git/ignore) names both of these. */
const MACHINE_IGNORES = ["_bmad/scripts/", MANIFEST];

function snapshot(path, skip = () => false) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return ["link", readlinkSync(path)];
  if (stat.isDirectory()) {
    const names = readdirSync(path).filter((name) => !skip(join(path, name))).sort();
    return ["dir", names.map((name) => [name, snapshot(join(path, name), skip)])];
  }
  return ["file", readFileSync(path).toString("base64")];
}

/** Make `target` a git work tree whose .gitignore holds `ignore`, as a clone of a repo that does not track them is. */
function gitWorkTree(target, ignore) {
  const git = spawnSync("git", ["init", "-q"], { cwd: target, env: envFor(), encoding: "utf8" });
  assert.equal(git.status, 0, `git init failed: ${git.stderr}`);
  put(join(target, ".gitignore"), ignore.map((line) => `${line}\n`).join(""));
}

test("row 1, fresh install: passes, and core/config.yaml is no longer a sentinel", () => {
  const target = freshInstall("fresh");
  for (const path of ["config.toml", "scripts/resolve_config.py", "scripts/config_utils.py", "_config/manifest.yaml", "bmm/config.yaml", "bmb/config.yaml", "cis/config.yaml"]) {
    assert.ok(existsSync(bmad(target, path)), `${path} should be part of a fresh install`);
  }
  rmSync(bmad(target, "core", "config.yaml"));
  const audit = scaffoldAudit(target);
  assert.equal(audit.status, "pass", `Contract A drops core/config.yaml: ${JSON.stringify(audit)}`);
});

test("row 2, post-BMB exactly as the skill prescribes: fails on the manifest only, naming the cause and the remedy", () => {
  const target = freshInstall("post-bmb");
  applyBmbSetupModel(target);
  assert.equal(existsSync(bmad(target, "core", "config.yaml")), false, "model precondition: BMB deleted core/config.yaml");
  assert.equal(existsSync(bmad(target, "bmb", "config.yaml")), false, "model precondition: BMB deleted bmb/config.yaml");
  const audit = scaffoldAudit(target);
  assert.equal(audit.status, "fail", JSON.stringify(audit));
  assert.equal(audit.fixable, true);
  assert.deepEqual(audit.details, [
    `${INSTALL_RECORD}. BMB setup's \`--also-remove _config\` cleanup is the likely cause: it deletes all of _bmad/_config. Restore it with: ${REMEDY}`,
  ]);
});

test("row 3, post-BMB + reinstall: preview writes nothing, migrate restores the install record, audit passes", () => {
  const target = freshInstall("reinstall");
  applyBmbSetupModel(target);
  const before = snapshot(bmad(target));
  const preview = scaffoldMigrate(target, ["--dry-run"]).result;
  assert.equal(preview.status, "applied", JSON.stringify(preview));
  assert.deepEqual(preview.changedFiles, [bmad(target, "_config", "manifest.yaml")]);
  assert.deepEqual(snapshot(bmad(target)), before, "a dry run writes nothing");
  const { report, result } = scaffoldMigrate(target);
  assert.equal(report.ok, true, JSON.stringify(result));
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.ok(existsSync(bmad(target, "_config", "manifest.yaml")));
  assert.equal(scaffoldAudit(target).status, "pass");
  // BMB's own consolidated config is not the installer's to touch (trace finding 3).
  assert.match(readFileSync(bmad(target, "config.yaml"), "utf8"), /^bmb:/m);
});

test("AC3 flow: install -> BMB setup -> audit -> repeat setup -> audit -> repair, converging every time", () => {
  const target = freshInstall("flip-flop");
  for (const round of [1, 2, 3]) {
    applyBmbSetupModel(target);
    const broken = scaffoldAudit(target);
    assert.equal(broken.status, "fail", `round ${round}: ${JSON.stringify(broken)}`);
    assert.equal(broken.details.length, 1, `round ${round}: ${JSON.stringify(broken.details)}`);
    assert.match(broken.details[0], /pj migrate bmad\.scaffold/);
    const { report } = scaffoldMigrate(target);
    assert.equal(report.ok, true, `round ${round}`);
    assert.equal(scaffoldAudit(target).status, "pass", `round ${round}: repair must reach parity`);
  }
});

// The configured-adapter path of the same flow: a linked or opted-in g33 project takes the
// update through runBmadUpdateWithCompanionPreservation, which captures the companion's entries
// (including the consolidated `_bmad/config.yaml` BMB writes) around the installer. The repair
// must still restore the install record, leave BMB's three files exactly as BMB wrote them, keep
// the companion's own entries, and say it ran under that preservation (its rollback-scope line):
// the plain installer path would also restore the record and the adapter would rewrite its files,
// so only that line tells the two paths apart.
test("AC3 flow with a configured g33 companion adapter: the repair restores the manifest and leaves BMB's files byte-identical", () => {
  const adapter = join(scratch, "companion-adapter.mjs");
  writeCompanionAdapter(adapter);
  const target = freshInstall("companion-flow", (project) => {
    put(join(project, ".project.json"), JSON.stringify({
      project_id: "companion-flow", project_name: "companion-flow",
      bmad: { companion: { enabled: true, adapter: { module: adapter, exportName: "companion", options: {} } } },
    }));
  });
  const bmbOwned = ["config.yaml", "config.user.yaml", "module-help.csv"];
  for (const round of [1, 2]) {
    applyBmbSetupModel(target);
    // The companion's entries as its adapter writes them; BMB's cleanup took the mapping with `_config/`.
    for (const [path, text] of Object.entries(COMPANION_FIXTURE_FILES)) put(join(target, path), text);
    const written = Object.fromEntries(bmbOwned.map((name) => [name, sha(bmad(target, name))]));
    const broken = scaffoldAudit(target);
    assert.equal(broken.status, "fail", `round ${round}: ${JSON.stringify(broken)}`);
    assert.equal(broken.details.length, 1, `round ${round}: ${JSON.stringify(broken.details)}`);
    assert.ok(broken.details[0].startsWith(MANIFEST), `round ${round}: ${JSON.stringify(broken.details)}`);
    const { report, result } = scaffoldMigrate(target);
    assert.equal(report.ok, true, `round ${round}: ${JSON.stringify(result)}`);
    assert.equal(result.status, "applied", `round ${round}: ${JSON.stringify(result)}`);
    assert.ok(result.details.some((line) => /^rollback scope: /.test(line)), `round ${round}: the update must run under the companion preservation: ${JSON.stringify(result.details)}`);
    assert.ok(["changed", "unchanged"].includes(result.bmadCompanion?.status), `round ${round}: ${JSON.stringify(result.bmadCompanion)}`);
    assert.ok(result.changedFiles.includes(bmad(target, "_config", "manifest.yaml")), `round ${round}: ${JSON.stringify(result.changedFiles)}`);
    assert.ok(existsSync(bmad(target, "_config", "manifest.yaml")));
    for (const name of bmbOwned) assert.equal(sha(bmad(target, name)), written[name], `round ${round}: the repair must leave BMB's ${name} byte-identical`);
    for (const [path, text] of Object.entries(COMPANION_FIXTURE_FILES)) assert.equal(readFileSync(join(target, path), "utf8"), text, `round ${round}: the repair must keep the companion's ${path}`);
    assert.equal(scaffoldAudit(target).status, "pass", `round ${round}: repair must reach parity`);
  }
});

test("row 4, a post-BMB tree whose _config survived (the 33GOD shape): passes", () => {
  const target = freshInstall("survivor");
  applyBmbSetupModel(target, { keepConfigDir: true });
  assert.equal(existsSync(bmad(target, "core", "config.yaml")), false);
  assert.equal(existsSync(bmad(target, "bmb", "config.yaml")), false);
  const audit = scaffoldAudit(target);
  assert.equal(audit.status, "pass", JSON.stringify(audit));
});

test("row 5, config.toml missing: fails, and migrate restores it", () => {
  const target = freshInstall("no-toml");
  rmSync(bmad(target, "config.toml"));
  const audit = scaffoldAudit(target);
  assert.equal(audit.status, "fail");
  assert.ok(audit.details.includes("_bmad/config.toml"), JSON.stringify(audit.details));
  assert.equal(scaffoldMigrate(target).report.ok, true);
  assert.equal(scaffoldAudit(target).status, "pass");
});

test("row 6, scripts/ missing: fails (new coverage), one line per missing resolver script, each naming the repair", () => {
  const target = freshInstall("no-scripts");
  rmSync(bmad(target, "scripts"), { recursive: true });
  const audit = scaffoldAudit(target);
  assert.equal(audit.status, "fail");
  assert.deepEqual(audit.details, [
    `_bmad/scripts/resolve_config.py (restore it with: ${REMEDY})`,
    `_bmad/scripts/config_utils.py (restore it with: ${REMEDY})`,
  ]);
  assert.equal(audit.details.some((line) => /git-ignored/.test(line)), false, "outside a git work tree git ignores nothing, so no such claim");
  put(bmad(target, "scripts", "resolve_config.py"), "# present\n");
  assert.deepEqual(scaffoldAudit(target).details, [`_bmad/scripts/config_utils.py (restore it with: ${REMEDY})`], "each script is its own sentinel");
  const { report, result } = scaffoldMigrate(target);
  assert.equal(report.ok, true, JSON.stringify(result));
  // Without the install's files-manifest.csv nothing can attest a targeted restore: the installer runs, and says
  // why in one line that is only a reason. bmad.setup-scripts' own remedy (a quick-update at the install's
  // version) is not this result's next step, so it is not repeated here.
  const notes = result.details.filter((line) => /_bmad\/scripts restore/.test(line));
  assert.equal(notes.length, 1, JSON.stringify(result.details));
  assert.match(notes[0], /^no targeted _bmad\/scripts restore: _bmad\/_config\/files-manifest\.csv is absent, so recovered scripts cannot be attested \(missing from _bmad\/scripts: [^)]*\); this takes the installer path$/);
  assert.doesNotMatch(notes[0], /quick-update|pj migrate|re-run the installer/);
  assert.equal(scaffoldAudit(target).status, "pass");
});

// The restore is only ever attempted for a sentinel gap: a clean scaffold whose other scripts bmad.setup-scripts
// cannot restore (the fixture install writes only the two sentinels and no files-manifest.csv) must not carry a
// restore line on a migrate that had nothing of the kind to do.
test("a clean scaffold on an install bmad.setup-scripts declines: migrate carries no restore line", () => {
  const target = freshInstall("clean-declined");
  assert.equal(existsSync(bmad(target, "scripts", "memlog.py")), false, "fixture precondition: a runtime script the sentinels do not cover is missing");
  assert.equal(existsSync(bmad(target, "_config", "files-manifest.csv")), false, "fixture precondition: nothing attests a restore");
  const { report, result } = scaffoldMigrate(target);
  assert.equal(report.ok, true, JSON.stringify(result));
  assert.equal(result.details.some((line) => /_bmad\/scripts restore|bmad-method@[\d.]+ \(/.test(line)), false, JSON.stringify(result.details));
});

test("row 6 on a fresh clone or worktree: git ignores _bmad/scripts, and the line says so only when git does", () => {
  const ignored = freshInstall("clone-ignored");
  gitWorkTree(ignored, MACHINE_IGNORES);
  rmSync(bmad(ignored, "scripts"), { recursive: true });
  const finding = scaffoldAudit(ignored);
  assert.equal(finding.status, "fail");
  assert.deepEqual(finding.details, [
    `_bmad/scripts/resolve_config.py (git-ignored in this checkout, so a fresh clone or worktree lacks it; restore it with: ${REMEDY})`,
    `_bmad/scripts/config_utils.py (git-ignored in this checkout, so a fresh clone or worktree lacks it; restore it with: ${REMEDY})`,
  ]);

  // The same tree in a repo that does not ignore them: git says nothing, so neither does the audit.
  const tracked = freshInstall("clone-not-ignored");
  gitWorkTree(tracked, ["node_modules/"]);
  rmSync(bmad(tracked, "scripts"), { recursive: true });
  const plain = scaffoldAudit(tracked);
  assert.deepEqual(plain.details, [
    `_bmad/scripts/resolve_config.py (restore it with: ${REMEDY})`,
    `_bmad/scripts/config_utils.py (restore it with: ${REMEDY})`,
  ]);
});

test("row 7, cis/config.yaml missing: fails, with and without a consolidated config", () => {
  const plain = freshInstall("no-cis");
  rmSync(bmad(plain, "cis", "config.yaml"));
  const audit = scaffoldAudit(plain);
  assert.equal(audit.status, "fail");
  assert.deepEqual(audit.details, ["_bmad/cis/config.yaml"]);

  // After BMB's setup the consolidated config holds a bmb section only: it cannot stand in for cis.
  const postBmb = freshInstall("no-cis-post-bmb");
  applyBmbSetupModel(postBmb, { keepConfigDir: true });
  rmSync(bmad(postBmb, "cis", "config.yaml"));
  const after = scaffoldAudit(postBmb);
  assert.equal(after.status, "fail");
  assert.deepEqual(after.details, ["_bmad/cis/config.yaml (and _bmad/config.yaml has no cis section)"]);
});

test("rule 4: the consolidated config satisfies a module only when it parses to a mapping with that module's key", () => {
  const cases = [
    ["a bmb section", "bmb:\n  name: BMad Builder\n", "pass", []],
    // PyYAML (what BMB's merge-config.py reads and writes with) lets the last key win; the audit must not call such a file unparseable.
    ["a repeated top-level key", "bmb:\n  name: first\nbmb:\n  name: second\n", "pass", []],
    ["only other sections", "cis:\n  name: x\n", "fail", ["_bmad/bmb/config.yaml (and _bmad/config.yaml has no bmb section)"]],
    ["an unparseable file", "bmb: [unterminated\n", "fail", [/^_bmad\/bmb\/config\.yaml \(and _bmad\/config\.yaml could not be parsed: [^:\n]+ at line \d+, column \d+, so it cannot supply a bmb section\)$/]],
    ["a YAML list", "- bmb\n", "fail", ["_bmad/bmb/config.yaml (and _bmad/config.yaml is not a YAML mapping, so it cannot supply a bmb section)"]],
    ["a scalar", "bmb\n", "fail", ["_bmad/bmb/config.yaml (and _bmad/config.yaml is not a YAML mapping, so it cannot supply a bmb section)"]],
    ["an empty file", "", "fail", ["_bmad/bmb/config.yaml (and _bmad/config.yaml is not a YAML mapping, so it cannot supply a bmb section)"]],
  ];
  for (const [label, text, status, expected] of cases) {
    const target = freshInstall("consolidated");
    rmSync(bmad(target, "bmb", "config.yaml"));
    writeFileSync(bmad(target, "config.yaml"), text);
    const audit = scaffoldAudit(target);
    assert.equal(audit.status, status, `${label}: ${JSON.stringify(audit)}`);
    assert.equal(audit.details.length, expected.length, `${label}: ${JSON.stringify(audit.details)}`);
    expected.forEach((want, index) => {
      if (want instanceof RegExp) assert.match(audit.details[index], want, label);
      else assert.equal(audit.details[index], want, label);
    });
  }
});

test("rule 4: the per-module file alone is enough, even beside an unparseable consolidated config", () => {
  const target = freshInstall("per-module");
  writeFileSync(bmad(target, "config.yaml"), "bmb: [unterminated\n");
  assert.equal(scaffoldAudit(target).status, "pass", "an unparseable consolidated config is only a problem when it is the sole source");
});

// The install record is the one sentinel BMB's cleanup deletes, but BMB is only the cause when the
// tree has BMB's shape: `_config/` AND `core/` gone with its consolidated config.yaml left behind.
// Anything else (a hand deletion, a clone that never had the file) must not be blamed on BMB.
test("a missing install record names a cause only when the tree shows it", () => {
  const detailOf = (target) => {
    const audit = scaffoldAudit(target);
    assert.equal(audit.status, "fail", JSON.stringify(audit));
    assert.equal(audit.details.length, 1, JSON.stringify(audit.details));
    return audit.details[0];
  };
  const neutral = `${INSTALL_RECORD} is missing. Restore it with: ${REMEDY}`;
  const bmb = `${INSTALL_RECORD}. BMB setup's \`--also-remove _config\` cleanup is the likely cause: it deletes all of _bmad/_config. Restore it with: ${REMEDY}`;

  const onlyTheFile = freshInstall("no-manifest-only");
  rmSync(bmad(onlyTheFile, "_config", "manifest.yaml"));
  assert.equal(detailOf(onlyTheFile), neutral, "_config/ survived, so BMB's cleanup (which deletes all of it) is not the cause");

  const configGoneCoreStays = freshInstall("no-config-dir");
  rmSync(bmad(configGoneCoreStays, "_config"), { recursive: true });
  assert.equal(detailOf(configGoneCoreStays), neutral, "core/ survived, so BMB's cleanup (which deletes it too) did not run");

  const configGoneCoreStaysWithBmbYaml = freshInstall("no-config-dir-bmb-yaml");
  rmSync(bmad(configGoneCoreStaysWithBmbYaml, "_config"), { recursive: true });
  put(bmad(configGoneCoreStaysWithBmbYaml, "config.yaml"), "bmb:\n  name: BMad Builder\n");
  assert.equal(detailOf(configGoneCoreStaysWithBmbYaml), neutral, "BMB's config.yaml alone is not BMB's cleanup");

  const noConsolidated = freshInstall("no-config-no-core");
  rmSync(bmad(noConsolidated, "_config"), { recursive: true });
  rmSync(bmad(noConsolidated, "core"), { recursive: true });
  assert.equal(detailOf(noConsolidated), neutral, "without BMB's consolidated config.yaml nothing says BMB ran");

  // The 33GOD shape: core/ and bmb/ gone, BMB's config.yaml present, `_config/` survived. The file is
  // missing from a surviving `_config/`, which BMB's cleanup (it deletes the whole directory) cannot have done.
  const survivor = freshInstall("no-manifest-bmb-survivor");
  applyBmbSetupModel(survivor, { keepConfigDir: true });
  rmSync(bmad(survivor, "_config", "manifest.yaml"));
  assert.equal(detailOf(survivor), neutral, "_config/ survived BMB's run, so BMB did not delete the manifest");

  const bmbShaped = freshInstall("bmb-shaped");
  applyBmbSetupModel(bmbShaped);
  assert.equal(detailOf(bmbShaped), bmb, "_config/ and core/ gone, config.yaml present: BMB's shape");

  // A repo that git-ignores the file (every repo on this fleet, via ~/.agents/git/ignore): a clone or worktree never has it.
  const ignored = freshInstall("manifest-git-ignored");
  gitWorkTree(ignored, MACHINE_IGNORES);
  rmSync(bmad(ignored, "_config", "manifest.yaml"));
  assert.equal(detailOf(ignored), `${INSTALL_RECORD} is git-ignored in this checkout, so a fresh clone or worktree lacks it. Restore it with: ${REMEDY}`);

  const notIgnored = freshInstall("manifest-git-not-ignored");
  gitWorkTree(notIgnored, ["node_modules/"]);
  rmSync(bmad(notIgnored, "_config", "manifest.yaml"));
  assert.equal(detailOf(notIgnored), neutral, "git does not ignore it here, so the audit does not say it does");

  const never = emptyProject("never-installed");
  const bare = scaffoldAudit(never);
  assert.equal(bare.status, "fail");
  assert.ok(bare.details.includes(MANIFEST), "no _bmad at all: the bare path, no claim about a cause");
  for (const script of ["resolve_config.py", "config_utils.py"]) {
    assert.ok(bare.details.includes(`_bmad/scripts/${script}`), `no _bmad at all: the bare script path, no remedy: ${JSON.stringify(bare.details)}`);
  }
  assert.equal(bare.details.some((line) => /also-remove|git-ignored|restore it with|Restore it with/.test(line)), false);
});

test("project_name is unchanged: a wrong [core] project_name is reported, previewed, and restored by migrate", () => {
  const target = freshInstall("name-drift");
  const expected = JSON.parse(readFileSync(join(target, ".project.json"), "utf8")).project_name;
  const toml = bmad(target, "config.toml");
  const original = readFileSync(toml, "utf8");
  assert.match(original, new RegExp(`^project_name = ${JSON.stringify(expected)}$`, "m"), "fixture precondition");
  writeFileSync(toml, original.replace(/^project_name\s*=.*$/m, 'project_name = "Somebody Else"'));
  const audit = scaffoldAudit(target);
  assert.equal(audit.status, "fail", JSON.stringify(audit));
  assert.deepEqual(audit.details, [`_bmad/config.toml project_name must be ${JSON.stringify(expected)}`]);
  const drifted = snapshot(bmad(target));
  const preview = scaffoldMigrate(target, ["--dry-run"]).result;
  assert.equal(preview.status, "applied", JSON.stringify(preview));
  assert.ok(preview.changedFiles.includes(toml), JSON.stringify(preview.changedFiles));
  assert.deepEqual(snapshot(bmad(target)), drifted, "a dry run writes nothing");
  const { report, result } = scaffoldMigrate(target);
  assert.equal(report.ok, true, JSON.stringify(result));
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.ok(result.changedFiles.includes(toml), JSON.stringify(result.changedFiles));
  assert.equal(readFileSync(toml, "utf8"), original, "the installer rewrote config.toml with the project's own name");
  assert.equal(scaffoldAudit(target).status, "pass");
});

// ---- the targeted _bmad/scripts restore -----------------------------------------------------------------
//
// `_bmad/scripts/` is git-ignored machine-wide, so a clone or worktree of a repo that does not track it
// lacks the scripts. Where the install's files-manifest.csv attests the pinned package's bytes for every
// missing sentinel, bmad.scaffold restores them as bmad.setup-scripts does, with no tracked change, and the
// installer path (or the g33 boundary that withholds it) takes whatever else is missing. These tests run the
// real package's restore end to end.

let pinned;
/**
 * The real pinned bmad-method package (npx, as bmad.setup-scripts' own suite resolves it) and its script
 * inventory. A failure is remembered: every restore test then fails at once with the same reason instead
 * of waiting out another npm timeout.
 */
async function pinnedPackage() {
  pinned ??= resolvePinnedPackage().catch((error) => ({ error }));
  const resolved = await pinned;
  if (resolved.error) throw resolved.error;
  return resolved;
}
async function resolvePinnedPackage() {
  const bundle = join(root, "node_modules", ".cache", `pjan-166-authority-${process.pid}.mjs`);
  buildSync({
    stdin: { contents: 'export {REQUIRED_BMAD_SETUP_SCRIPTS} from "./src/bmad/setup-scripts"; export {resolveBmadInstallerPackage, BMAD_INSTALLER_VERSION} from "./src/parity/rules";', resolveDir: root },
    outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm",
  });
  try {
    const { REQUIRED_BMAD_SETUP_SCRIPTS, resolveBmadInstallerPackage, BMAD_INSTALLER_VERSION } = await import(pathToFileURL(bundle));
    const pkg = resolveBmadInstallerPackage(BMAD_INSTALLER_VERSION);
    assert.equal(pkg.version, BMAD_INSTALLER_VERSION, `the real pinned bmad-method@${BMAD_INSTALLER_VERSION} package is unavailable (it needs the npm registry or a warm npx cache): ${pkg.reason}`);
    return { pkg, scripts: [...REQUIRED_BMAD_SETUP_SCRIPTS].sort() };
  } finally { rmSync(bundle, { force: true }); }
}

/** A sha256 no bmad-method release ships: a row that attests other bytes, as an install made at another version does. */
const OTHER_BYTES = `fc78866f${"0".repeat(56)}`;

/**
 * What the real installer's files-manifest.csv holds for the runtime scripts: the attestation the restore checks.
 * `otherBytes` names scripts whose row attests OTHER_BYTES instead (an install made at another version).
 */
function attestScripts(target, { pkg, scripts }, { otherBytes = [] } = {}) {
  const rows = scripts.map((name) => `"py","${name.slice(0, -3)}","scripts","scripts/${name}","${otherBytes.includes(name) ? OTHER_BYTES : sha(join(pkg.root, "src", "scripts", name))}"`);
  put(bmad(target, "_config", "files-manifest.csv"), `type,name,module,path,hash\n${rows.join("\n")}\n`);
}

/** Everything under target except `_bmad/scripts`: what a restore that needs no reinstall must leave alone. */
const snapshotExceptScripts = (target) => snapshot(target, (path) => path === join(target, "_bmad", "scripts"));

test("scripts are the only gap: migrate restores them from the verified pinned package, with no reinstall and no other write", async () => {
  const real = await pinnedPackage();
  const env = envFor({ PJ_BMAD_INSTALLER: real.pkg.entry });
  const target = freshInstall("restore-scripts");
  attestScripts(target, real);
  rmSync(bmad(target, "scripts"), { recursive: true });
  const manifestBefore = sha(bmad(target, "_config", "manifest.yaml"));
  const before = snapshotExceptScripts(target);
  const dir = bmad(target, "scripts");
  const wanted = real.scripts.map((name) => join(dir, name));

  const audit = scaffoldAudit(target, env);
  assert.equal(audit.status, "fail");
  assert.equal(audit.fixable, true);
  assert.equal(audit.details.length, 2, JSON.stringify(audit.details));

  const preview = scaffoldMigrate(target, ["--dry-run"], env).result;
  assert.equal(preview.status, "applied", JSON.stringify(preview));
  assert.match(preview.summary, /would restore the missing _bmad\/scripts from the verified pinned bmad-method package \(no reinstall\)/i);
  assert.deepEqual([...preview.changedFiles].sort(), [...wanted].sort());
  assert.equal(existsSync(dir), false, "a dry run writes nothing");
  assert.deepEqual(snapshotExceptScripts(target), before);

  const { report, result } = scaffoldMigrate(target, [], env);
  assert.equal(report.ok, true, JSON.stringify(result));
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.match(result.summary, /Restored the missing _bmad\/scripts from the verified pinned bmad-method package \(no reinstall\)/);
  assert.deepEqual([...result.changedFiles].sort(), [...wanted].sort());
  // The source line and nothing else: no installer ran, so neither did the installer-skill handoff.
  assert.deepEqual(result.details, [`bmad-method@${real.pkg.version} (${real.pkg.root})`], JSON.stringify(result.details));
  for (const name of real.scripts) assert.equal(sha(join(dir, name)), sha(join(real.pkg.root, "src", "scripts", name)), name);
  assert.equal(sha(bmad(target, "_config", "manifest.yaml")), manifestBefore, "a reinstall rewrites the install record; a restore must not");
  assert.deepEqual(snapshotExceptScripts(target), before, "nothing but _bmad/scripts changed");
  assert.equal(scaffoldAudit(target, env).status, "pass");
  // No repeat `migrate` here: a migrate that is asked for runs the installer even on a passing tree, and this
  // suite's PJ_BMAD_INSTALLER is the REAL package (the restore needs its fingerprint), which would reach GitHub.
});

test("scripts are the only gap on a linked g33 project with no companion adapter: restored, not blocked", async () => {
  const real = await pinnedPackage();
  const env = envFor({ PJ_BMAD_INSTALLER: real.pkg.entry });
  const target = freshInstall("restore-no-adapter");
  attestScripts(target, real);
  put(join(target, ".project.json"), JSON.stringify({ project_id: "restore-no-adapter", project_name: "restore-no-adapter", bmad: { companion: { enabled: true } } }));
  const cisConfig = readFileSync(bmad(target, "cis", "config.yaml"));
  rmSync(bmad(target, "scripts"), { recursive: true });
  rmSync(bmad(target, "cis", "config.yaml"));

  // Control: with another gap the rest of the repair is a reinstall, which the g33 boundary withholds. The
  // scripts still come back (that much needs no installer); the result is partial and names the boundary.
  const withheld = scaffoldMigrate(target, [], env);
  assert.equal(withheld.report.ok, false);
  assert.equal(withheld.result.status, "partial", JSON.stringify(withheld.result));
  assert.match(withheld.result.summary, /^Restored the missing _bmad\/scripts from the verified pinned bmad-method package; the rest is not repaired: BMAD update withheld: optional g33 companion adapter is not configured$/);
  assert.equal(existsSync(bmad(target, "scripts", "resolve_config.py")), true);
  assert.equal(existsSync(bmad(target, "cis", "config.yaml")), false, "the boundary withheld the installer");

  writeFileSync(bmad(target, "cis", "config.yaml"), cisConfig);
  rmSync(bmad(target, "scripts"), { recursive: true });
  const { report, result } = scaffoldMigrate(target, [], env);
  assert.equal(report.ok, true, JSON.stringify(result));
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.match(result.summary, /\(no reinstall\)/);
  assert.equal(result.changedFiles.length, real.scripts.length);
  assert.equal(scaffoldAudit(target, env).status, "pass");
});

test("scripts plus another issue: the scripts restore, and the installer path takes only the rest (a wrong project_name)", async () => {
  const real = await pinnedPackage();
  const env = envFor({ PJ_BMAD_INSTALLER: real.pkg.entry });
  const target = freshInstall("restore-with-name-drift");
  attestScripts(target, real);
  const toml = bmad(target, "config.toml");
  writeFileSync(toml, readFileSync(toml, "utf8").replace(/^project_name\s*=.*$/m, 'project_name = "Somebody Else"'));
  rmSync(bmad(target, "scripts"), { recursive: true });
  const preview = scaffoldMigrate(target, ["--dry-run"], env).result;
  assert.equal(preview.status, "applied", JSON.stringify(preview));
  assert.match(preview.summary, /^Would restore the missing _bmad\/scripts from the verified pinned bmad-method package; the rest: Would run non-interactive bmad-method install$/);
  assert.doesNotMatch(preview.summary, /no reinstall/, JSON.stringify(preview));
  assert.ok(preview.changedFiles.includes(toml), JSON.stringify(preview.changedFiles));
  for (const name of real.scripts) assert.ok(preview.changedFiles.includes(bmad(target, "scripts", name)), JSON.stringify(preview.changedFiles));
  assert.equal(existsSync(bmad(target, "scripts")), false, "a dry run writes nothing");
});

// The restore never claims a repair it cannot finish: an install whose files-manifest.csv attests one sentinel as
// other bytes (a clone of an install made at another version, as codegraph-voyage's 6.11.1-next.1 install is) gets
// no restore at all, in the dry run and the real run alike, and the installer path (or the boundary) decides.
test("a sentinel the install cannot attest: no partial restore; the dry run and the real run both take the installer path", async () => {
  const real = await pinnedPackage();
  const env = envFor({ PJ_BMAD_INSTALLER: real.pkg.entry });
  const declined = { otherBytes: ["resolve_config.py", "resolve_customization.py"] };
  const sentinels = ["resolve_config.py", "config_utils.py"];

  // Not g33-linked: the preview is the installer's, led by one line that is only a reason.
  const plain = freshInstall("restore-sentinel-declined");
  attestScripts(plain, real, declined);
  rmSync(bmad(plain, "scripts"), { recursive: true });
  const preview = scaffoldMigrate(plain, ["--dry-run"], env).result;
  assert.equal(preview.status, "applied", JSON.stringify(preview));
  assert.equal(preview.summary, "Would run non-interactive bmad-method install", JSON.stringify(preview));
  assert.match(preview.details[0], /^no targeted _bmad\/scripts restore: scripts\/resolve_config\.py is attested by the manifest as other bytes \(sha256 fc78866f0000\) than bmad-method@[\d.]+'s \([0-9a-f]{12}\); this takes the installer path$/);
  assert.doesNotMatch(preview.details[0], /quick-update|pj migrate/);
  for (const name of sentinels) assert.ok(preview.changedFiles.includes(bmad(plain, "scripts", name)), JSON.stringify(preview.changedFiles));
  assert.equal(existsSync(bmad(plain, "scripts")), false, "a dry run writes nothing");

  // g33-linked with no adapter: the installer is withheld, so both runs are blocked and write nothing (never partial).
  const linked = freshInstall("restore-sentinel-declined-g33");
  attestScripts(linked, real, declined);
  put(join(linked, ".project.json"), JSON.stringify({ project_id: "restore-sentinel-declined-g33", project_name: "restore-sentinel-declined-g33", bmad: { companion: { enabled: true } } }));
  rmSync(bmad(linked, "scripts"), { recursive: true });
  // The audit does not name a repair it knows is withheld: these scripts need the installer here.
  for (const line of scaffoldAudit(linked, env).details) {
    assert.match(line, /^_bmad\/scripts\/(resolve_config|config_utils)\.py \(restore it with: pj migrate bmad\.scaffold, which re-runs the BMAD installer here, withheld until the g33 companion adapter is available: no bmad\.companion\.adapter is configured; run `pj skills enable skill g33-33god-integration` first\)$/);
  }
  const before = snapshot(bmad(linked));
  for (const flags of [["--dry-run"], []]) {
    const { report, result } = scaffoldMigrate(linked, flags, env);
    assert.equal(report.ok, false);
    assert.equal(result.status, "blocked", `${flags}: ${JSON.stringify(result)}`);
    assert.match(result.summary, /BMAD update withheld: optional g33 companion adapter is not configured/);
    assert.match(result.details[0], /^no targeted _bmad\/scripts restore: scripts\/resolve_config\.py is attested by the manifest as other bytes [^;]*$/, `${flags}: a blocked result never ran the installer, so it does not say it takes that path`);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(snapshot(bmad(linked)), before, `${flags}: nothing written`);
  }
});

// A missing script the sentinels do not cover is bmad.setup-scripts' to report; it does not hold back the sentinels.
test("a non-sentinel script the install cannot attest: the sentinels restore, and the result says what was left", async () => {
  const real = await pinnedPackage();
  const env = envFor({ PJ_BMAD_INSTALLER: real.pkg.entry });
  const target = freshInstall("restore-memlog-declined");
  attestScripts(target, real, { otherBytes: ["memlog.py"] });
  rmSync(bmad(target, "scripts"), { recursive: true });
  const wanted = real.scripts.filter((name) => name !== "memlog.py").map((name) => bmad(target, "scripts", name)).sort();
  const left = /^left for bmad\.setup-scripts: scripts\/memlog\.py is attested by the manifest as other bytes /;
  const preview = scaffoldMigrate(target, ["--dry-run"], env).result;
  assert.equal(preview.status, "applied", JSON.stringify(preview));
  assert.deepEqual([...preview.changedFiles].sort(), wanted);
  assert.ok(preview.details.some((line) => left.test(line)), JSON.stringify(preview.details));
  const { report, result } = scaffoldMigrate(target, [], env);
  assert.equal(report.ok, true, JSON.stringify(result));
  assert.match(result.summary, /\(no reinstall\)$/);
  assert.deepEqual([...result.changedFiles].sort(), wanted, "the dry run previewed exactly what the real run wrote");
  assert.ok(result.details.some((line) => left.test(line)), JSON.stringify(result.details));
  assert.equal(existsSync(bmad(target, "scripts", "memlog.py")), false);
  assert.equal(scaffoldAudit(target, env).status, "pass");
});

// The clone of a repo that tracks neither `_bmad/scripts/` nor the install record (about 20 on this fleet):
// both are git-ignored, so both are missing. Only the installer writes the install record, and on a g33-linked
// project with no adapter it is withheld. The scripts still come back from the pinned package; the result is
// partial and names the boundary, and the audit says which repair is withheld instead of naming it bare.
test("a clone missing the scripts AND the install record, g33-linked with no adapter: scripts restored, the rest withheld and said so", async () => {
  const real = await pinnedPackage();
  const env = envFor({ PJ_BMAD_INSTALLER: real.pkg.entry });
  const target = freshInstall("clone-scripts-and-record");
  attestScripts(target, real);
  gitWorkTree(target, MACHINE_IGNORES);
  put(join(target, ".project.json"), JSON.stringify({ project_id: "clone-scripts-and-record", project_name: "clone-scripts-and-record", bmad: { companion: { enabled: true } } }));
  rmSync(bmad(target, "scripts"), { recursive: true });
  rmSync(bmad(target, "_config", "manifest.yaml"));
  const withheld = "which re-runs the BMAD installer here, withheld until the g33 companion adapter is available: no bmad.companion.adapter is configured; run `pj skills enable skill g33-33god-integration` first";
  const recordLine = `${INSTALL_RECORD} is git-ignored in this checkout, so a fresh clone or worktree lacks it. Restore it with: ${REMEDY}, ${withheld}`;

  const audit = scaffoldAudit(target, env);
  assert.deepEqual(audit.details, [
    `_bmad/scripts/resolve_config.py (git-ignored in this checkout, so a fresh clone or worktree lacks it; restore it with: ${REMEDY})`,
    `_bmad/scripts/config_utils.py (git-ignored in this checkout, so a fresh clone or worktree lacks it; restore it with: ${REMEDY})`,
    recordLine,
  ]);

  const wanted = real.scripts.map((name) => bmad(target, "scripts", name)).sort();
  const summary = /^(Would restore|Restored) the missing _bmad\/scripts from the verified pinned bmad-method package; the rest is not repaired: BMAD update withheld: optional g33 companion adapter is not configured$/;
  const preview = scaffoldMigrate(target, ["--dry-run"], env);
  assert.equal(preview.report.ok, false);
  assert.equal(preview.result.status, "partial", JSON.stringify(preview.result));
  assert.match(preview.result.summary, summary);
  assert.deepEqual([...preview.result.changedFiles].sort(), wanted);
  assert.equal(existsSync(bmad(target, "scripts")), false, "a dry run writes nothing");

  const { report, result } = scaffoldMigrate(target, [], env);
  assert.equal(report.ok, false);
  assert.equal(result.status, "partial", JSON.stringify(result));
  assert.match(result.summary, summary);
  assert.deepEqual([...result.changedFiles].sort(), wanted, "the dry run previewed exactly what the real run wrote");
  for (const name of real.scripts) assert.equal(sha(bmad(target, "scripts", name)), sha(join(real.pkg.root, "src", "scripts", name)), name);
  assert.equal(existsSync(bmad(target, "_config", "manifest.yaml")), false, "the install record needs the installer, which is withheld");
  assert.deepEqual(scaffoldAudit(target, env).details, [recordLine], "only the withheld repair is left");
  const setupScripts = pj(target, ["audit", "--rules", "bmad.setup-scripts"], { env }).rules.find((rule) => rule.id === "bmad.setup-scripts");
  assert.equal(setupScripts?.status, "pass", JSON.stringify(setupScripts));
});

// An invalid install record blocks before any write: the restore must not use a fallback module selection to
// decide the scripts are the only gap and write them anyway.
test("an invalid install record: migrate is blocked and restores nothing, even with every script attested", async () => {
  const real = await pinnedPackage();
  const env = envFor({ PJ_BMAD_INSTALLER: real.pkg.entry });
  const target = freshInstall("restore-invalid-record");
  attestScripts(target, real);
  writeFileSync(bmad(target, "_config", "manifest.yaml"), "modules: not-a-list\n");
  rmSync(bmad(target, "scripts"), { recursive: true });
  for (const flags of [["--dry-run"], []]) {
    const { result } = scaffoldMigrate(target, flags, env);
    assert.equal(result.status, "blocked", `${flags}: ${JSON.stringify(result)}`);
    assert.equal(result.summary, "BMAD module manifest is invalid; refusing fallback module selection");
    assert.deepEqual(result.changedFiles, []);
    assert.equal(result.details.some((line) => /_bmad\/scripts|bmad-method@/.test(line)), false, `${flags}: ${JSON.stringify(result.details)}`);
    assert.equal(existsSync(bmad(target, "scripts")), false, `${flags}: nothing restored`);
  }
});

// A symlinked `_bmad/scripts` is a refusal, not a decline: the restore will not write through it, and neither may
// the installer the migrate would otherwise fall through to.
test("a symlinked _bmad/scripts: migrate is blocked with the refusal and writes nothing through the link", () => {
  const target = freshInstall("restore-symlinked-scripts");
  const outside = join(scratch, `outside-scripts-${seq++}`);
  mkdirSync(outside);
  rmSync(bmad(target, "scripts"), { recursive: true });
  symlinkSync(outside, bmad(target, "scripts"));
  for (const flags of [["--dry-run"], []]) {
    const { report, result } = scaffoldMigrate(target, flags);
    assert.equal(report.ok, false);
    assert.equal(result.status, "blocked", `${flags}: ${JSON.stringify(result)}`);
    assert.equal(result.summary, "BMAD script recovery refused: _bmad/scripts is not a real directory");
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(readdirSync(outside), [], `${flags}: nothing written through the link`);
  }
  assert.equal(lstatSync(bmad(target, "scripts")).isSymbolicLink(), true);
});

// bmad.scaffold's result is judged by the shared verifications, not by a check of its own, on both paths a
// caller can take: `pj migrate` (RecipeRegistry.verifyMigration, after every selected rule has run, PJAN-75/84)
// and `pj recipe run bmad` (Recipe.initializeOwnedChecks, right after the check). An installer that exits 0
// and repairs nothing is the case neither may call applied.
function lazyInstallerEnv() {
  const lazy = join(scratch, "installer-that-repairs-nothing");
  writeFileSync(lazy, "#!/bin/sh\nexit 0\n");
  chmodSync(lazy, 0o755);
  return envFor({ PJ_BMAD_INSTALLER: lazy });
}

test("migrate: an installer that exits 0 and repairs nothing is partial, not applied", () => {
  const env = lazyInstallerEnv();
  const target = freshInstall("postcondition-migrate");
  rmSync(bmad(target, "scripts", "resolve_config.py"));
  const { report, result } = scaffoldMigrate(target, [], env);
  assert.equal(result.status, "partial", JSON.stringify(result));
  assert.equal(report.ok, false);
  assert.match(result.summary, /1 BMAD scaffold issue/);
  assert.ok(result.details.some((line) => /^still failing after migrate: /.test(line)), result.details.join("\n"));
  assert.ok(result.details.some((line) => line.startsWith("_bmad/scripts/resolve_config.py")), result.details.join("\n"));

  const healthy = freshInstall("postcondition-migrate-healthy");
  rmSync(bmad(healthy, "scripts", "resolve_config.py"));
  const repaired = scaffoldMigrate(healthy);
  assert.equal(repaired.report.ok, true, JSON.stringify(repaired.result));
  assert.equal(repaired.result.status, "applied", JSON.stringify(repaired.result));
  assert.equal(scaffoldAudit(healthy).status, "pass");
});

test("init (`pj recipe run bmad`): an installer that exits 0 and repairs nothing fails the postcondition", () => {
  // `recipe run bmad` runs its dependency recipes too, and secrets.env-op copies its template out of this
  // submodule: without it the run fails on that, which would read as an init regression.
  assert.ok(existsSync(join(root, "templates", "commonproject", "template", ".env.op")), "the templates/commonproject submodule is not checked out: run `git submodule update --init` first");
  const target = freshInstall("postcondition-init");
  rmSync(bmad(target, "scripts", "resolve_config.py"));
  const run = pj(target, ["recipe", "run", "bmad"], { env: lazyInstallerEnv() });
  assert.equal(run.ok, false, JSON.stringify(run));
  assert.ok(run.errors.some((line) => /^bmad\.scaffold: init postcondition failed: .*1 BMAD scaffold issue.*_bmad\/scripts\/resolve_config\.py/.test(line)), JSON.stringify(run.errors));
});
