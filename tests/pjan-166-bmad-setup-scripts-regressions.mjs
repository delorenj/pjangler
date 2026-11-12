import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs, { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, "node_modules", ".cache", `pjan-166-${process.pid}.mjs`);
buildSync({ stdin: { contents: 'export {planBmadSetupScripts, applyBmadSetupScripts, REQUIRED_BMAD_SETUP_SCRIPTS} from "./src/bmad/setup-scripts"; export {resolveBmadInstallerPackage, BMAD_INSTALLER_VERSION, BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS, createBmadChecks} from "./src/parity/rules";', resolveDir: root }, outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm" });
const { planBmadSetupScripts, applyBmadSetupScripts, REQUIRED_BMAD_SETUP_SCRIPTS, resolveBmadInstallerPackage, BMAD_INSTALLER_VERSION, BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS, createBmadChecks } = await import(pathToFileURL(bundle));
rmSync(bundle);
const pkg = resolveBmadInstallerPackage(BMAD_INSTALLER_VERSION);
assert.equal(pkg.version, BMAD_INSTALLER_VERSION, `real pinned package unavailable: ${pkg.reason}`);
const scripts = [...REQUIRED_BMAD_SETUP_SCRIPTS].sort();
const source = join(pkg.root, "src", "scripts");
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const setup = createBmadChecks().find((check) => check.id === "bmad.setup-scripts");
const bmbMemlogRow = '"py","memlog","bmb","bmb/bmad-eval-runner/scripts/memlog.py","3d18f927cbee3a1b0b46c3d85447742359a09009dfd65819c5584c7142d38d04"';
const fixture = () => {
  const project = mkdtempSync(join(tmpdir(), "pjan-166-"));
  mkdirSync(join(project, "_bmad", "_config"), { recursive: true });
  writeFileSync(join(project, "_bmad", "core"), "fixture-marker");
  writeFileSync(join(project, "_bmad", "_config", "files-manifest.csv"), "type,name,module,path,hash\n" + bmbMemlogRow + "\n" + scripts.map((name) => `"py","${name.slice(0, -3)}","scripts","scripts/${name}","${hash(join(source, name))}"`).join("\n") + "\n");
  return project;
};
const ctx = (project, dryRun) => ({ repoRoot: project, pjanglerRoot: root, homeDir: join(project, "home"), dryRun });

test("PJAN-166: pinned installer provenance, preview no-write, apply from package, repeat convergence", async () => {
  const project = fixture();
  try {
    const dir = join(project, "_bmad", "scripts");
    const before = readFileSync(join(project, "_bmad", "_config", "files-manifest.csv"));
    assert.equal(before.toString().includes(bmbMemlogRow), true, "actual BMB same-name row must be present throughout preview/apply/repeat");
    assert.equal((await setup.audit(ctx(project, true))).status, "fail");
    const preview = await setup.migrate(ctx(project, true), await setup.audit(ctx(project, true)));
    assert.equal(preview.status, "applied", JSON.stringify(preview));
    assert.equal(preview.changedFiles.length, scripts.length);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(readFileSync(join(project, "_bmad", "_config", "files-manifest.csv")), before);
    const applied = await setup.migrate(ctx(project, false), await setup.audit(ctx(project, false)));
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    for (const name of scripts) {
      assert.equal(hash(join(dir, name)), hash(join(source, name)), name);
      assert.equal(lstatSync(join(dir, name)).mode & 0o7777, lstatSync(join(source, name)).mode & 0o7777);
    }
    assert.equal((await setup.audit(ctx(project, false))).status, "pass");
    const repeat = await setup.migrate(ctx(project, false), await setup.audit(ctx(project, false)));
    assert.equal(repeat.status, "noop");
    assert.deepEqual(repeat.changedFiles, []);
    assert.deepEqual(readFileSync(join(project, "_bmad", "_config", "files-manifest.csv")), before);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: missing one script restores only that script, preserving operator data", () => {
  const project = fixture();
  try {
    const dir = join(project, "_bmad", "scripts");
    mkdirSync(dir);
    for (const name of scripts.slice(1)) copyFileSync(join(source, name), join(dir, name));
    writeFileSync(join(dir, "local-notes.txt"), "foreign data", { mode: 0o600 });
    const plan = planBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION);
    assert.deepEqual(plan.files, [join(dir, scripts[0])]);
    assert.deepEqual(applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION).files, plan.files);
    assert.equal(readFileSync(join(dir, "local-notes.txt"), "utf8"), "foreign data");
    assert.equal(lstatSync(join(dir, "local-notes.txt")).mode & 0o7777, 0o600);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: foreign symlink and manifest drift refuse before mutation", () => {
  const project = fixture();
  try {
    const dir = join(project, "_bmad", "scripts");
    mkdirSync(dir);
    symlinkSync("../core", join(dir, scripts[0]));
    let result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION);
    assert.match(result.error, /refusing overwrite/);
    assert.equal(readlinkSync(join(dir, scripts[0])), "../core");
    assert.deepEqual(readdirSync(dir), [scripts[0]]);
    rmSync(join(dir, scripts[0]));
    const manifest = join(project, "_bmad", "_config", "files-manifest.csv");
    const original = readFileSync(manifest, "utf8");
    writeFileSync(manifest, original.replace(hash(join(source, scripts[0])), "0".repeat(64)));
    result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION);
    assert.match(result.error, /does not attest/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: same-byte foreign inode survives rollback after later publish fails", () => {
  const project = fixture();
  try {
    const dir = join(project, "_bmad", "scripts");
    const replacement = join(project, "_bmad", "foreign-replacement");
    const first = join(dir, scripts[0]);
    const second = join(dir, scripts[1]);
    mkdirSync(dir);
    let foreignIdentity;
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count !== 1) return;
      writeFileSync(replacement, readFileSync(first));
      foreignIdentity = lstatSync(replacement);
      renameSync(replacement, first);
      writeFileSync(second, "foreign collision");
    });
    assert.match(result.error, /recovery failed/);
    assert.match(result.error, /recovery incomplete: Concurrent replacement or mutation retained/);
    assert.deepEqual(result.files, []);
    assert.equal(hash(first), hash(join(source, scripts[0])), "same bytes must not imply ownership");
    assert.equal(lstatSync(first).ino, foreignIdentity.ino);
    assert.equal(lstatSync(first).dev, foreignIdentity.dev);
    assert.equal(readFileSync(second, "utf8"), "foreign collision");
    assert.deepEqual(readdirSync(dir), [scripts[0], scripts[1]]);
    assert.equal(readdirSync(join(project, "_bmad")).some((n) => n.startsWith(".scripts-stage-")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: EEXIST on a foreign hard link to staged inode preserves that collision", () => {
  const project = fixture();
  try {
    const bmad = join(project, "_bmad");
    const dir = join(bmad, "scripts");
    mkdirSync(dir);
    const first = join(dir, scripts[0]);
    const collision = join(dir, scripts[1]);
    let foreignIdentity;
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count !== 1) return;
      const stageName = readdirSync(bmad).find((name) => name.startsWith(".scripts-stage-"));
      const staged = join(bmad, stageName, scripts[1]);
      linkSync(staged, collision);
      foreignIdentity = lstatSync(collision);
      assert.equal(foreignIdentity.ino, lstatSync(staged).ino);
    });
    assert.match(result.error, /(?:destination appeared before publication|EEXIST)/);
    assert.match(result.error, /recovery incomplete:.*Publication not confirmed/);
    assert.deepEqual(result.files, []);
    assert.equal(existsSync(first), false, "successful publication rolls back");
    assert.equal(lstatSync(collision).ino, foreignIdentity.ino, "foreign hard link is not our publication");
    assert.equal(hash(collision), hash(join(source, scripts[1])));
    assert.deepEqual(readdirSync(dir), [scripts[1]]);
    assert.equal(readdirSync(bmad).some((name) => name.startsWith(".scripts-stage-")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: exception after link leaves ambiguous output, rolling back confirmed links only", () => {
  const project = fixture();
  const originalLink = fs.linkSync;
  try {
    const bmad = join(project, "_bmad");
    const dir = join(bmad, "scripts");
    mkdirSync(dir);
    const collision = join(dir, scripts[1]);
    fs.linkSync = (src, dest) => {
      originalLink(src, dest);
      if (dest.endsWith(`/${scripts[1]}`)) throw new Error("injected after link");
    };
    syncBuiltinESMExports();
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION);
    assert.match(result.error, /injected after link/);
    assert.match(result.error, /recovery incomplete:.*Publication not confirmed/);
    assert.deepEqual(result.files, []);
    assert.equal(existsSync(join(dir, scripts[0])), false);
    assert.equal(hash(collision), hash(join(source, scripts[1])));
    assert.deepEqual(readdirSync(dir), [scripts[1]]);
    assert.equal(readdirSync(bmad).some((name) => name.startsWith(".scripts-stage-")), false);
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    rmSync(project, { recursive: true, force: true });
  }
});

test("PJAN-166: manifest exact CSV fields, duplicates and quoted column spoof reject without writes", () => {
  const project = fixture();
  try {
    const manifest = join(project, "_bmad", "_config", "files-manifest.csv");
    const original = readFileSync(manifest, "utf8");
    const target = scripts[0];
    const valid = `"py","${target.slice(0, -3)}","scripts","scripts/${target}","${hash(join(source, target))}"`;
    for (const forged of [
      `"py","scripts/${target}","other","elsewhere.py","${hash(join(source, target))}"`,
      valid.replace(`"scripts/${target}"`, `"bmb/bmad-eval-runner/scripts/${target}"`),
      valid.replace('"scripts",', '"other",'),
      valid.replace('"py",', '"md",'),
      valid.replace(`"${target.slice(0, -3)}",`, '"wrong",'),
      `${valid},"extra"`,
      `"py","${target.slice(0, -3)}","scripts","scripts/${target}","${hash(join(source, target))}","`,
    ]) {
      writeFileSync(manifest, original.replace(valid, forged));
      assert.match(planBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION).error, /manifest/i, forged);
      assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
    }
    writeFileSync(manifest, original + valid + "\n");
    assert.match(planBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION).error, /does not attest/);
    writeFileSync(manifest, original.replace(valid, `"py","${target.slice(0, -3)}","scripts","scripts/${target}","${hash(join(source, target))}"`.replace('"scripts",', '"scr""ipts",')));
    assert.match(planBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION).error, /does not attest/);
    writeFileSync(manifest, original.replace(/\n/g, "\r\n"));
    assert.equal(planBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION).files.length, scripts.length);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: swapped script directory never redirects publication or rollback into symlink target", () => {
  for (const throwAfterSwap of [false, true]) {
    const project = fixture();
    try {
      const dir = join(project, "_bmad", "scripts");
      const moved = join(project, "_bmad", "moved-scripts");
      const outside = join(project, "outside");
      mkdirSync(dir); mkdirSync(outside);
      writeFileSync(join(dir, "operator.txt"), "preserve");
      writeFileSync(join(outside, "operator.txt"), "outside preserve");
      const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
        if (count !== 1) return;
        renameSync(dir, moved);
        symlinkSync(outside, dir, "dir");
        if (throwAfterSwap) throw new Error("abort after swap");
      });
      assert.match(result.error, /(?:directory changed|abort after swap)/i);
      assert.deepEqual(result.files, []);
      assert.deepEqual(readdirSync(moved), ["operator.txt"]);
      assert.deepEqual(readdirSync(outside), ["operator.txt"]);
      assert.equal(readFileSync(join(moved, "operator.txt"), "utf8"), "preserve");
      assert.equal(readFileSync(join(outside, "operator.txt"), "utf8"), "outside preserve");
      assert.equal(lstatSync(dir).isSymbolicLink(), true);
      assert.equal(readdirSync(join(project, "_bmad")).some((n) => n.startsWith(".scripts-stage-")), false);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: swapped new directory reports retained directory honestly", () => {
  const project = fixture();
  try {
    const dir = join(project, "_bmad", "scripts");
    const moved = join(project, "_bmad", "moved-scripts");
    const outside = join(project, "outside");
    mkdirSync(outside);
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count === 1) { renameSync(dir, moved); symlinkSync(outside, dir, "dir"); }
    });
    assert.match(result.error, /recovery incomplete: Created script directory moved or retained/);
    assert.deepEqual(readdirSync(moved), []);
    assert.deepEqual(readdirSync(outside), []);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: parent swap never removes foreign staging content and retains owned stage honestly", () => {
  const project = fixture();
  try {
    const bmad = join(project, "_bmad");
    const moved = join(project, "moved-bmad");
    const outside = join(project, "outside");
    mkdirSync(outside);
    let stageName;
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count !== 1) return;
      stageName = readdirSync(bmad).find((name) => name.startsWith(".scripts-stage-"));
      assert.ok(stageName);
      renameSync(bmad, moved);
      mkdirSync(join(outside, stageName));
      writeFileSync(join(outside, stageName, "foreign-data"), "KEEP THIS");
      symlinkSync(outside, bmad, "dir");
    });
    assert.match(result.error, /parent directory changed/);
    assert.deepEqual(result.files, []);
    assert.equal(readFileSync(join(outside, stageName, "foreign-data"), "utf8"), "KEEP THIS");
    assert.equal(existsSync(join(moved, "scripts")), false, "owned empty script directory is removed under pinned parent");
    assert.equal(existsSync(join(moved, stageName)), false, "owned stage is removed under pinned parent");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: foreign additions in owned stage survive cleanup with incomplete recovery reported", () => {
  const project = fixture();
  try {
    const bmad = join(project, "_bmad");
    let stageName;
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count !== 1) return;
      stageName = readdirSync(bmad).find((name) => name.startsWith(".scripts-stage-"));
      assert.ok(stageName);
      writeFileSync(join(bmad, stageName, "foreign-data"), "KEEP THIS");
      throw new Error("abort after foreign addition");
    });
    assert.match(result.error, /abort after foreign addition/);
    assert.match(result.error, /recovery incomplete:.*Staging directory moved or contains foreign entries/);
    assert.equal(readFileSync(join(bmad, stageName, "foreign-data"), "utf8"), "KEEP THIS");
    assert.deepEqual(readdirSync(join(bmad, stageName)), ["foreign-data"]);
    assert.equal(existsSync(join(bmad, "scripts")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: replaced stage pathname never deletes foreign stage or follows its contents", () => {
  const project = fixture();
  try {
    const bmad = join(project, "_bmad");
    const moved = join(bmad, "moved-owned-stage");
    let stageName;
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count !== 1) return;
      stageName = readdirSync(bmad).find((name) => name.startsWith(".scripts-stage-"));
      assert.ok(stageName);
      renameSync(join(bmad, stageName), moved);
      mkdirSync(join(bmad, stageName));
      writeFileSync(join(bmad, stageName, "foreign-data"), "KEEP THIS");
      throw new Error("abort after stage replacement");
    });
    assert.match(result.error, /abort after stage replacement/);
    assert.match(result.error, /recovery incomplete:.*Staging directory moved/);
    assert.deepEqual(result.files, []);
    assert.equal(readFileSync(join(bmad, stageName, "foreign-data"), "utf8"), "KEEP THIS");
    assert.deepEqual(readdirSync(moved), []);
    assert.equal(existsSync(join(bmad, "scripts")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: replaced staged entry is never published; owned outputs roll back and foreign stage survives", () => {
  const project = fixture();
  try {
    const bmad = join(project, "_bmad");
    const dir = join(bmad, "scripts");
    const outside = join(project, "outside-data");
    mkdirSync(dir);
    writeFileSync(outside, "foreign payload");
    let stageName;
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count !== 1) return;
      stageName = readdirSync(bmad).find((name) => name.startsWith(".scripts-stage-"));
      const staged = join(bmad, stageName, scripts[1]);
      rmSync(staged);
      symlinkSync(outside, staged);
    });
    assert.match(result.error, /Staged script changed before publication/);
    assert.match(result.error, /recovery incomplete:.*Staged file replaced/);
    assert.deepEqual(result.files, []);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(lstatSync(join(bmad, stageName, scripts[1])).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(bmad, stageName, scripts[1])), outside);
    assert.equal(readFileSync(outside, "utf8"), "foreign payload");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: same-inode staged content mutation is refused, with truthful retention", () => {
  const project = fixture();
  try {
    const bmad = join(project, "_bmad");
    const dir = join(bmad, "scripts");
    mkdirSync(dir);
    let stageName;
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count !== 1) return;
      stageName = readdirSync(bmad).find((name) => name.startsWith(".scripts-stage-"));
      const staged = join(bmad, stageName, scripts[1]);
      const before = lstatSync(staged);
      const bytes = readFileSync(staged);
      bytes[0] ^= 1;
      writeFileSync(staged, bytes);
      assert.equal(lstatSync(staged).ino, before.ino);
      assert.equal(lstatSync(staged).size, before.size);
    });
    assert.match(result.error, /Staged script changed before publication/);
    assert.deepEqual(result.files, []);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(readdirSync(bmad).some((name) => name.startsWith(".scripts-stage-")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: mutation of already published inode blocks success and does not erase it", () => {
  const project = fixture();
  try {
    const bmad = join(project, "_bmad");
    const dir = join(bmad, "scripts");
    mkdirSync(dir);
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count === 1) writeFileSync(join(dir, scripts[0]), "changed in place");
    });
    assert.match(result.error, /Published script changed before completion/);
    assert.match(result.error, /recovery incomplete: Concurrent replacement or mutation retained/);
    assert.deepEqual(result.files, []);
    assert.equal(readFileSync(join(dir, scripts[0]), "utf8"), "changed in place");
    assert.deepEqual(readdirSync(dir), [scripts[0]]);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: foreign stage addition after last publish invalidates success and rolls back outputs", () => {
  const project = fixture();
  try {
    const bmad = join(project, "_bmad");
    const dir = join(bmad, "scripts");
    let stageName;
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => {
      if (count !== scripts.length) return;
      stageName = readdirSync(bmad).find((name) => name.startsWith(".scripts-stage-"));
      writeFileSync(join(bmad, stageName, "operator.txt"), "retain");
    });
    assert.match(result.error, /staging cleanup incomplete.*recovery incomplete/);
    assert.deepEqual(result.files, []);
    assert.equal(readFileSync(join(bmad, stageName, "operator.txt"), "utf8"), "retain");
    assert.equal(existsSync(dir), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: failed publish leaves no partial scripts or staging and retains foreign files", () => {
  const project = fixture();
  try {
    const dir = join(project, "_bmad", "scripts");
    mkdirSync(dir);
    writeFileSync(join(dir, "foreign.txt"), "keep", { mode: 0o600 });
    const result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION, (count) => { if (count === 2) throw new Error("injected failure after two publishes"); });
    assert.match(result.error, /injected failure/);
    assert.deepEqual(result.files, []);
    assert.deepEqual(readdirSync(dir), ["foreign.txt"]);
    assert.equal(readFileSync(join(dir, "foreign.txt"), "utf8"), "keep");
    assert.equal(lstatSync(join(dir, "foreign.txt")).mode & 0o7777, 0o600);
    assert.equal(readdirSync(join(project, "_bmad")).some((n) => n.startsWith(".scripts-stage-")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: an explicit non-package PJ_BMAD_INSTALLER makes the rule skip visibly, never fail or write", async () => {
  const project = fixture();
  const fakeDir = mkdtempSync(join(tmpdir(), "pjan-166-fake-installer-"));
  const fake = join(fakeDir, "fake-bmad-installer");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const saved = process.env.PJ_BMAD_INSTALLER;
  process.env.PJ_BMAD_INSTALLER = fake;
  try {
    const finding = await setup.audit(ctx(project, false));
    assert.equal(finding.status, "skip", JSON.stringify(finding));
    assert.equal(finding.fixable, false);
    assert.match(finding.summary, /Setup script recovery unavailable: PJ_BMAD_INSTALLER is not a bmad-method package/);
    for (const dryRun of [true, false]) {
      const result = await setup.migrate(ctx(project, dryRun), finding);
      assert.equal(result.status, "skipped", JSON.stringify(result));
      assert.deepEqual(result.changedFiles, []);
    }
    // Even handed a stale failing finding, migrate re-resolves and declines without writing.
    const stale = await setup.migrate(ctx(project, false), { ...finding, status: "fail", fixable: true });
    assert.equal(stale.status, "skipped", JSON.stringify(stale));
    assert.deepEqual(stale.changedFiles, []);
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally {
    if (saved === undefined) delete process.env.PJ_BMAD_INSTALLER; else process.env.PJ_BMAD_INSTALLER = saved;
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("PJAN-166: a pre-manifest install (no files-manifest.csv) makes the rule skip visibly, never fail or write", async () => {
  const project = fixture();
  try {
    rmSync(join(project, "_bmad", "_config", "files-manifest.csv"));
    const finding = await setup.audit(ctx(project, false));
    assert.equal(finding.status, "skip", JSON.stringify(finding));
    assert.equal(finding.fixable, false);
    assert.match(finding.summary, /files-manifest\.csv is absent/);
    for (const dryRun of [true, false]) {
      const result = await setup.migrate(ctx(project, dryRun), finding);
      assert.equal(result.status, "skipped", JSON.stringify(result));
      assert.deepEqual(result.changedFiles, []);
    }
    const stale = await setup.migrate(ctx(project, false), { ...finding, status: "fail", fixable: true });
    assert.equal(stale.status, "skipped", JSON.stringify(stale));
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
    // A symlinked manifest is not "absent": it still refuses visibly rather than being skipped.
    symlinkSync(join(project, "elsewhere.csv"), join(project, "_bmad", "_config", "files-manifest.csv"));
    const refused = await setup.audit(ctx(project, false));
    assert.equal(refused.status, "fail", JSON.stringify(refused));
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PJAN-166 review follow-up. A scratch project below is either
//   - realInstall(): a copy of THIS repo's own tracked `_bmad`, a real install at
//     a version other than the pin (the shape of the bloodbank/genesis/pjangler
//     installs the review measured), or
//   - fixture(): the pinned-version shape above, whose manifest rows come from the
//     real pinned package.
// The package is resolved by the REAL npx wherever a test needs it; a recording
// `npx` shim on PATH is used only to PROVE that nothing resolved it.
// ---------------------------------------------------------------------------
const cli = join(root, "dist", "index.js");
const REMEDY = /pj migrate bmad\.version/;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rowFor = (name) => `"py","${name.slice(0, -3)}","scripts","scripts/${name}","${hash(join(source, name))}"`;

const realInstall = () => {
  const project = mkdtempSync(join(tmpdir(), "pjan-166-real-"));
  cpSync(join(root, "_bmad"), join(project, "_bmad"), { recursive: true });
  return project;
};
const installedVersion = (project) => readFileSync(join(project, "_bmad", "_config", "manifest.yaml"), "utf8").match(/^\s+version:\s*(\S+)/m)?.[1];

/** Run `body` with a recording `npx` first on PATH that always fails. `calls()` is what was invoked. */
const withNpxShim = async (body) => {
  const bin = mkdtempSync(join(tmpdir(), "pjan-166-npx-"));
  const marker = join(bin, "calls");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try { return await body({ calls: () => (existsSync(marker) ? readFileSync(marker, "utf8") : "") }); }
  finally { process.env.PATH = savedPath; rmSync(bin, { recursive: true, force: true }); }
};

const withEnv = async (vars, body) => {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  try { return await body(); }
  finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
};

/** Migrate must decline too, even when handed a stale failing finding, and must write nothing. */
const assertMigrateDeclines = async (project, finding) => {
  for (const dryRun of [true, false]) {
    const result = await setup.migrate(ctx(project, dryRun), { ...finding, status: "fail", fixable: true });
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.deepEqual(result.changedFiles, []);
  }
};

test("PJAN-166: the real install used below really is the shape the review measured", () => {
  const project = realInstall();
  try {
    const dir = join(project, "_bmad", "scripts");
    assert.notEqual(installedVersion(project), BMAD_INSTALLER_VERSION, "this tree must be installed at a version other than the pin, or the version tests prove nothing");
    for (const name of scripts) assert.equal(lstatSync(join(dir, name)).isFile(), true, name);
    assert.ok(scripts.some((name) => hash(join(dir, name)) !== hash(join(source, name))), "its scripts must differ in bytes from the pinned package, or the no-comparison test proves nothing");
    assert.match(readFileSync(join(project, "_bmad", "_config", "files-manifest.csv"), "utf8"), /"scripts\/memlog\.py"/);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: healthy real installs are present at any mode, version or manifest, and never resolve the package", async () => {
  const project = realInstall();
  try {
    const dir = join(project, "_bmad", "scripts");
    const bytes = new Map(scripts.map((name) => [name, hash(join(dir, name))]));
    await withNpxShim(async ({ calls }) => {
      // 664/775 is the flume/holocene/pilot/mobile-deploy-hub shape (umask 002); 644/755 is the package's own.
      for (const modes of [{ exec: 0o775, plain: 0o664 }, { exec: 0o755, plain: 0o644 }]) {
        for (const name of scripts) chmodSync(join(dir, name), name === "resolve_customization.py" ? modes.exec : modes.plain);
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "pass", JSON.stringify(finding));
        assert.equal(finding.fixable, false);
        for (const dryRun of [true, false]) {
          const result = await setup.migrate(ctx(project, dryRun), { ...finding, status: "fail", fixable: true });
          assert.equal(result.status, "noop", JSON.stringify(result));
          assert.deepEqual(result.changedFiles, []);
        }
      }
      // Present scripts are not judged by the manifest either: drop every script row, then the manifest itself.
      const manifest = join(project, "_bmad", "_config", "files-manifest.csv");
      writeFileSync(manifest, readFileSync(manifest, "utf8").split("\n").filter((line) => !line.includes('"scripts/')).join("\n"));
      assert.equal((await setup.audit(ctx(project, false))).status, "pass");
      rmSync(manifest);
      assert.equal((await setup.audit(ctx(project, false))).status, "pass");
      assert.equal(calls(), "", "a healthy project must not invoke npx");
    });
    for (const name of scripts) assert.equal(hash(join(dir, name)), bytes.get(name), `${name} untouched`);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: `pj audit` on real installs is ok, runs no npx, and never reports a fail", async () => {
  assert.ok(existsSync(cli), "dist/index.js is missing; run `npm run build` first");
  const healthy = realInstall();
  const missing = realInstall();
  try {
    rmSync(join(missing, "_bmad", "scripts", "memlog.py"));
    await withNpxShim(({ calls }) => {
      for (const [project, status] of [[healthy, "pass"], [missing, "skip"]]) {
        const run = spawnSync(process.execPath, [cli, "audit", project, "--rules", "bmad.setup-scripts", "--json"], { encoding: "utf8", env: hermeticEnv(), timeout: 60_000 });
        assert.equal(run.status, 0, run.stderr);
        const report = JSON.parse(run.stdout);
        assert.equal(report.ok, true, run.stdout);
        assert.equal(report.rules[0].id, "bmad.setup-scripts");
        assert.equal(report.rules[0].status, status, run.stdout);
      }
      assert.equal(calls(), "", "neither a healthy nor a different-version project may invoke npx");
    });
  } finally {
    rmSync(healthy, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("PJAN-166: a missing script on a different-version install skips with the remedy, resolving and writing nothing", async () => {
  for (const removal of [["memlog.py"], scripts]) {
    const project = realInstall();
    try {
      const dir = join(project, "_bmad", "scripts");
      if (removal.length === scripts.length) rmSync(dir, { recursive: true }); // an alpha-style install has no scripts directory at all
      else for (const name of removal) rmSync(join(dir, name));
      const before = existsSync(dir) ? readdirSync(dir).sort() : null;
      await withNpxShim(async ({ calls }) => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "skip", JSON.stringify(finding));
        assert.equal(finding.fixable, false);
        assert.match(finding.summary, new RegExp(`^Setup script recovery unavailable: this install is bmad-method ${escapeRe(installedVersion(project))}, not the pinned ${escapeRe(BMAD_INSTALLER_VERSION)}`));
        for (const name of removal) assert.ok(finding.summary.includes(name), `${name} named in: ${finding.summary}`);
        assert.match(finding.summary, REMEDY);
        assert.match(finding.summary, /re-run the BMAD installer/);
        await assertMigrateDeclines(project, finding);
        assert.equal(calls(), "", "a version mismatch is decided from the disk; it must not wait on npm");
      });
      assert.deepEqual(existsSync(dir) ? readdirSync(dir).sort() : null, before, "nothing restored");
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: an install whose manifest has no row for a missing script skips without a probe (perth and alpha shapes)", async () => {
  // perth: rows for resolve_config/resolve_customization only, exactly those two present.
  // alpha (CommonProject, castagram, ...): no script rows and no scripts directory.
  for (const attested of [["resolve_config.py", "resolve_customization.py"], []]) {
    const project = fixture();
    try {
      const dir = join(project, "_bmad", "scripts");
      writeFileSync(join(project, "_bmad", "_config", "files-manifest.csv"), "type,name,module,path,hash\n" + bmbMemlogRow + "\n" + attested.map(rowFor).map((row) => row + "\n").join(""));
      if (attested.length) { mkdirSync(dir); for (const name of attested) copyFileSync(join(source, name), join(dir, name)); }
      const unattested = scripts.filter((name) => !attested.includes(name));
      await withNpxShim(async ({ calls }) => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "skip", JSON.stringify(finding));
        assert.equal(finding.fixable, false);
        assert.ok(finding.summary.includes(`has no row for ${unattested.map((name) => `scripts/${name}`).join(", ")},`), finding.summary);
        assert.match(finding.summary, new RegExp(`missing from _bmad/scripts: ${escapeRe(unattested.join(", "))}\\)`));
        assert.match(finding.summary, REMEDY);
        await assertMigrateDeclines(project, finding);
        assert.equal(calls(), "", "an unattestable restore must not wait on npm");
      });
      assert.deepEqual(existsSync(dir) ? readdirSync(dir).sort() : [], attested.slice().sort());
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: a manifest that attests other bytes than the pinned package skips with the remedy, never fails", async () => {
  const project = fixture();
  try {
    const manifest = join(project, "_bmad", "_config", "files-manifest.csv");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(hash(join(source, scripts[1])), "0".repeat(64)));
    const finding = await setup.audit(ctx(project, false));
    assert.equal(finding.status, "skip", JSON.stringify(finding));
    assert.equal(finding.fixable, false);
    assert.match(finding.summary, new RegExp(`does not attest pinned script ${escapeRe(scripts[1])}`));
    assert.match(finding.summary, REMEDY);
    assert.doesNotMatch(finding.summary, /retry when npm is reachable/, "the cause is the manifest, not the network");
    await assertMigrateDeclines(project, finding);
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: an unreachable pinned package is a skip naming the remedy, never a fail (real npx, offline, cold cache)", async () => {
  const project = fixture();
  const cache = mkdtempSync(join(tmpdir(), "pjan-166-npm-cache-"));
  try {
    await withEnv({ npm_config_offline: "true", npm_config_cache: cache }, async () => {
      const finding = await setup.audit(ctx(project, false));
      assert.equal(finding.status, "skip", JSON.stringify(finding));
      assert.equal(finding.fixable, false);
      assert.match(finding.summary, /Setup script recovery unavailable: could not resolve bmad-method@6\.12\.1/);
      assert.match(finding.summary, /retry when npm is reachable/);
      assert.match(finding.summary, REMEDY);
      for (const name of scripts) assert.ok(finding.summary.includes(name), `${name} named in: ${finding.summary}`);
      await assertMigrateDeclines(project, finding);
    });
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("PJAN-166: the probe is capped at 10s, and the resolver honours the timeout it is given", async () => {
  assert.ok(BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS >= 5000 && BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS <= 10_000, `cap is ${BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS}ms`);
  const bin = mkdtempSync(join(tmpdir(), "pjan-166-slow-npx-"));
  writeFileSync(join(bin, "npx"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  try {
    await withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => {
      const started = Date.now();
      const resolved = resolveBmadInstallerPackage(BMAD_INSTALLER_VERSION, { timeoutMs: 1000 });
      assert.ok(Date.now() - started < 8000, `took ${Date.now() - started}ms`);
      assert.equal(resolved.root, undefined);
      assert.match(resolved.reason, /could not resolve bmad-method@6\.12\.1: timed out after 1s/);
    });
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test("PJAN-166: with the registry black-holed the rule skips inside its cap instead of riding out npm's retries", async () => {
  const project = fixture();
  const cache = mkdtempSync(join(tmpdir(), "pjan-166-npm-cache-"));
  try {
    await withEnv({ npm_config_cache: cache, npm_config_registry: "http://10.255.255.1:81/" }, async () => {
      const started = Date.now();
      const finding = await setup.audit(ctx(project, false));
      const elapsed = Date.now() - started;
      assert.equal(finding.status, "skip", JSON.stringify(finding));
      assert.equal(finding.fixable, false);
      assert.match(finding.summary, /could not resolve bmad-method@6\.12\.1/);
      assert.match(finding.summary, REMEDY);
      assert.ok(elapsed < BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS + 4000, `took ${elapsed}ms against a ${BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS}ms cap`);
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("PJAN-166: an unverified pinned-package fingerprint is a skip that says how to enable recovery, never a fail", async () => {
  const project = fixture();
  const copy = mkdtempSync(join(tmpdir(), "pjan-166-patched-pkg-"));
  try {
    cpSync(pkg.root, join(copy, "bmad-method"), { recursive: true });
    appendFileSync(join(copy, "bmad-method", "tools", "installer", "bmad-cli.js"), "\n// patched, so its fingerprint is not a verified one\n");
    const entry = join(copy, "bmad-method", "tools", "installer", "bmad-cli.js");
    await withEnv({ PJ_BMAD_INSTALLER: entry }, async () => {
      const finding = await setup.audit(ctx(project, false));
      assert.equal(finding.status, "skip", JSON.stringify(finding));
      assert.equal(finding.fixable, false);
      assert.match(finding.summary, /Unverified BMAD installer fingerprint/);
      assert.match(finding.summary, /unset PJ_BMAD_INSTALLER to enable recovery/);
      await assertMigrateDeclines(project, finding);
    });
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally {
    rmSync(copy, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("PJAN-166: a mistyped or non-package PJ_BMAD_INSTALLER skips and says to unset it", async () => {
  const project = fixture();
  const fakeDir = mkdtempSync(join(tmpdir(), "pjan-166-fake-installer-"));
  const fake = join(fakeDir, "fake-bmad-installer");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    for (const [installer, reason] of [[join(fakeDir, "no-such-installer"), /PJ_BMAD_INSTALLER is not resolvable/], [fake, /PJ_BMAD_INSTALLER is not a bmad-method package/]]) {
      await withEnv({ PJ_BMAD_INSTALLER: installer }, async () => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "skip", JSON.stringify(finding));
        assert.equal(finding.fixable, false);
        assert.match(finding.summary, reason);
        assert.match(finding.summary, /unset PJ_BMAD_INSTALLER to enable recovery/);
        await assertMigrateDeclines(project, finding);
      });
    }
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("PJAN-166: scripts and manifest both missing skips, says the scripts are missing, and names the remedy", async () => {
  for (const [label, project] of [["pinned shape", fixture()], ["real install", realInstall()]]) {
    try {
      rmSync(join(project, "_bmad", "scripts"), { recursive: true, force: true });
      rmSync(join(project, "_bmad", "_config", "files-manifest.csv"));
      await withNpxShim(async ({ calls }) => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "skip", `${label}: ${JSON.stringify(finding)}`);
        assert.equal(finding.fixable, false);
        assert.ok(finding.summary.includes(`missing from _bmad/scripts: ${scripts.join(", ")}`), finding.summary);
        assert.match(finding.summary, /files-manifest\.csv is absent/);
        assert.match(finding.summary, REMEDY);
        await assertMigrateDeclines(project, finding);
        assert.equal(calls(), "");
      });
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: a dangling or live symlinked _config is a visible refusal, not an absent manifest", async () => {
  for (const dangling of [true, false]) {
    const project = realInstall();
    try {
      const bmad = join(project, "_bmad");
      rmSync(join(bmad, "scripts", "memlog.py"));
      if (dangling) {
        rmSync(join(bmad, "_config"), { recursive: true });
        symlinkSync(join(project, "no-such-config-dir"), join(bmad, "_config"));
      } else {
        renameSync(join(bmad, "_config"), join(project, "moved-config"));
        symlinkSync(join(project, "moved-config"), join(bmad, "_config"));
      }
      await withNpxShim(async ({ calls }) => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "fail", `${dangling ? "dangling" : "live"}: ${JSON.stringify(finding)}`);
        assert.equal(finding.fixable, false);
        assert.match(finding.summary, /Installed BMAD file manifest is missing or not a real file/);
        for (const dryRun of [true, false]) {
          const result = await setup.migrate(ctx(project, dryRun), { ...finding, status: "fail", fixable: true });
          assert.equal(result.status, "blocked", JSON.stringify(result));
          assert.deepEqual(result.changedFiles, []);
        }
        assert.equal(calls(), "");
      });
      assert.equal(existsSync(join(bmad, "scripts", "memlog.py")), false, "nothing restored through the symlink");
      assert.equal(lstatSync(join(bmad, "_config")).isSymbolicLink(), true);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: a symlink, directory or symlinked directory where a script belongs stays a visible refusal", async () => {
  const shapes = [
    ["symlinked script", (dir) => { rmSync(join(dir, "memlog.py")); symlinkSync("../core", join(dir, "memlog.py")); }, /Existing _bmad\/scripts\/memlog\.py is not a regular file; refusing overwrite/],
    ["directory as script", (dir) => { rmSync(join(dir, "memlog.py")); mkdirSync(join(dir, "memlog.py")); }, /Existing _bmad\/scripts\/memlog\.py is not a regular file; refusing overwrite/],
    ["symlinked scripts directory", (dir) => { renameSync(dir, `${dir}-moved`); symlinkSync(`${dir}-moved`, dir); }, /_bmad\/scripts is not a real directory/],
  ];
  for (const [label, mutate, message] of shapes) {
    const project = realInstall();
    try {
      mutate(join(project, "_bmad", "scripts"));
      await withNpxShim(async ({ calls }) => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "fail", `${label}: ${JSON.stringify(finding)}`);
        assert.equal(finding.fixable, false);
        assert.match(finding.summary, message);
        const result = await setup.migrate(ctx(project, false), finding);
        assert.equal(result.status, "blocked", `${label}: ${JSON.stringify(result)}`);
        assert.deepEqual(result.changedFiles, []);
        assert.equal(calls(), "", `${label}: a project hazard is judged from the disk`);
      });
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});
