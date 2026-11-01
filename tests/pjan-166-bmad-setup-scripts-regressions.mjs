import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import fs, { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, "node_modules", ".cache", `pjan-166-${process.pid}.mjs`);
buildSync({ stdin: { contents: 'export {planBmadSetupScripts, applyBmadSetupScripts, REQUIRED_BMAD_SETUP_SCRIPTS} from "./src/bmad/setup-scripts"; export {resolveBmadInstallerPackage, BMAD_INSTALLER_VERSION, createBmadChecks} from "./src/parity/rules";', resolveDir: root }, outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm" });
const { planBmadSetupScripts, applyBmadSetupScripts, REQUIRED_BMAD_SETUP_SCRIPTS, resolveBmadInstallerPackage, BMAD_INSTALLER_VERSION, createBmadChecks } = await import(pathToFileURL(bundle));
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
