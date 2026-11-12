import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
import { createBmadInstallerFixture } from "./helpers/pack-fixture.mjs";
import { applyBmbSetupModel } from "./helpers/bmb-setup-model.mjs";

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
// REAL installer and the REAL setup scripts and compares their result with this fixture and
// this model, so neither can drift from upstream unnoticed. Every row of the trace's
// Expected-outcomes table is covered here; the same rows are covered there on real trees.

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
const scaffoldAudit = (target) => {
  const finding = pj(target, ["audit", "--rules", "bmad.scaffold"]).rules.find((rule) => rule.id === "bmad.scaffold");
  assert.ok(finding, "bmad.scaffold finding missing");
  return finding;
};
const scaffoldMigrate = (target, ...flags) => {
  const report = pj(target, ["migrate", "bmad.scaffold", ...flags]);
  return { report, result: report.results.find((entry) => entry.id === "bmad.scaffold") };
};

/** The row-1 tree: a project installed through pjangler's own migrate path (the hermetic installer fixture). */
function freshInstall(label) {
  const target = emptyProject(label);
  const { result } = scaffoldMigrate(target);
  assert.equal(result.status, "applied", JSON.stringify(result));
  const audit = scaffoldAudit(target);
  assert.equal(audit.status, "pass", `fresh install must pass: ${JSON.stringify(audit)}`);
  return target;
}

const bmad = (target, ...segments) => join(target, "_bmad", ...segments);
const MANIFEST_LINE = /^_bmad\/_config\/manifest\.yaml/;

function snapshot(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return ["link", readlinkSync(path)];
  if (stat.isDirectory()) return ["dir", readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))])];
  return ["file", readFileSync(path).toString("base64")];
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
  assert.equal(audit.details.length, 1, `only the manifest may be reported: ${JSON.stringify(audit.details)}`);
  assert.match(audit.details[0], MANIFEST_LINE);
  assert.match(audit.details[0], /--also-remove _config/, "must name the cause");
  assert.match(audit.details[0], /pj migrate bmad\.scaffold/, "must name the remedy");
});

test("row 3, post-BMB + reinstall: preview writes nothing, migrate restores the install record, audit passes", () => {
  const target = freshInstall("reinstall");
  applyBmbSetupModel(target);
  const before = snapshot(bmad(target));
  const preview = scaffoldMigrate(target, "--dry-run").result;
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

test("row 6, scripts/ missing: fails (new coverage), one line per missing resolver script", () => {
  const target = freshInstall("no-scripts");
  rmSync(bmad(target, "scripts"), { recursive: true });
  const audit = scaffoldAudit(target);
  assert.equal(audit.status, "fail");
  assert.deepEqual(audit.details, ["_bmad/scripts/resolve_config.py", "_bmad/scripts/config_utils.py"]);
  put(bmad(target, "scripts", "resolve_config.py"), "# present\n");
  assert.deepEqual(scaffoldAudit(target).details, ["_bmad/scripts/config_utils.py"], "each script is its own sentinel");
  assert.equal(scaffoldMigrate(target).report.ok, true);
  assert.equal(scaffoldAudit(target).status, "pass");
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
    ["only other sections", "cis:\n  name: x\n", "fail", ["_bmad/bmb/config.yaml (and _bmad/config.yaml has no bmb section)"]],
    ["an unparseable file", "bmb: [unterminated\n", "fail", [/^_bmad\/bmb\/config\.yaml \(and _bmad\/config\.yaml could not be parsed: .+, so it cannot supply a bmb section\)$/]],
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

test("a missing install record names the BMB cause only for a tree that was installed once", () => {
  const target = freshInstall("no-manifest");
  rmSync(bmad(target, "_config", "manifest.yaml"));
  const installed = scaffoldAudit(target);
  assert.match(installed.details.join("\n"), /--also-remove _config[\s\S]*pj migrate bmad\.scaffold/);

  const never = emptyProject("never-installed");
  const bare = scaffoldAudit(never);
  assert.equal(bare.status, "fail");
  assert.ok(bare.details.includes("_bmad/_config/manifest.yaml"), "no _bmad at all: the bare path, no claim about BMB");
  assert.equal(bare.details.some((line) => /also-remove/.test(line)), false);
});

// The rule's own migrate result must be re-derived from disk. The CLI path is covered anyway by
// RecipeRegistry.verifyMigration, so this calls the rule directly, where only the rule can say it.
test("bmad.scaffold migrate re-audits its own result: an installer that exits 0 and repairs nothing is partial, not applied", async () => {
  const bundle = join(root, "node_modules", ".cache", `pjan-166-authority-${process.pid}.mjs`);
  buildSync({ stdin: { contents: 'export {createBmadChecks} from "./src/parity/rules";', resolveDir: root }, outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm" });
  const { createBmadChecks } = await import(pathToFileURL(bundle));
  rmSync(bundle);
  const scaffold = createBmadChecks().find((check) => check.id === "bmad.scaffold");
  const lazy = join(scratch, "installer-that-repairs-nothing");
  writeFileSync(lazy, "#!/bin/sh\nexit 0\n");
  chmodSync(lazy, 0o755);
  const ctx = (target) => ({ repoRoot: target, pjanglerRoot: root, homeDir: home, dryRun: false });
  const saved = process.env.PJ_BMAD_INSTALLER;
  try {
    const stuck = freshInstall("postcondition-stuck");
    rmSync(bmad(stuck, "scripts", "resolve_config.py"));
    process.env.PJ_BMAD_INSTALLER = lazy;
    const failed = await scaffold.migrate(ctx(stuck), await scaffold.audit(ctx(stuck)));
    assert.equal(failed.status, "partial", JSON.stringify(failed));
    assert.match(failed.summary, /1 BMAD scaffold issue/);
    assert.ok(failed.details.some((line) => /still failing after the install/.test(line)), failed.details.join("\n"));
    assert.ok(failed.details.includes("_bmad/scripts/resolve_config.py"), failed.details.join("\n"));

    const healthy = freshInstall("postcondition-healthy");
    rmSync(bmad(healthy, "scripts", "resolve_config.py"));
    process.env.PJ_BMAD_INSTALLER = installer;
    const repaired = await scaffold.migrate(ctx(healthy), await scaffold.audit(ctx(healthy)));
    assert.equal(repaired.status, "applied", JSON.stringify(repaired));
    assert.equal((await scaffold.audit(ctx(healthy))).status, "pass");
  } finally {
    if (saved === undefined) delete process.env.PJ_BMAD_INSTALLER; else process.env.PJ_BMAD_INSTALLER = saved;
  }
});
