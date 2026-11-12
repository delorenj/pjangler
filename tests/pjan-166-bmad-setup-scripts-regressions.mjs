import { SUITE_GRANTS } from "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import fs, { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

// This suite is a network contract (tests/helpers/hermetic-env.mjs, NPM_PROBE_SUITES):
// it resolves the REAL pinned bmad-method@6.12.1 package through the real npx at
// import, because the restore it tests copies that package's bytes and the sha256
// table in src/bmad/setup-scripts.ts is held to them here. Everything that does
// not need the package's bytes decides from the disk and proves it with a
// recording `npx` shim or spawnSync stub; the one black-hole case is bounded to
// seconds and never reaches a real host.
const realSpawnSync = childProcess.spawnSync;
const root = resolve(import.meta.dirname, "..");
const bundle = join(root, "node_modules", ".cache", `pjan-166-${process.pid}.mjs`);
buildSync({ stdin: { contents: 'export {planBmadSetupScripts, applyBmadSetupScripts, inspectBmadSetupScripts, PINNED_SETUP_SCRIPT_SHA256, REQUIRED_BMAD_SETUP_SCRIPTS} from "./src/bmad/setup-scripts"; export {resolveBmadInstallerPackage, readInstalledBmadVersion, BMAD_INSTALLER_VERSION, BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS, BMAD_RESOLVE_DEFAULT_TIMEOUT_MS, createBmadChecks, BMAD_FIRST_SCRIPTS_RELEASE} from "./src/parity/rules";', resolveDir: root }, outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm" });
const { planBmadSetupScripts, applyBmadSetupScripts, inspectBmadSetupScripts, PINNED_SETUP_SCRIPT_SHA256, REQUIRED_BMAD_SETUP_SCRIPTS, resolveBmadInstallerPackage, readInstalledBmadVersion, BMAD_INSTALLER_VERSION, BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS, BMAD_RESOLVE_DEFAULT_TIMEOUT_MS, createBmadChecks, BMAD_FIRST_SCRIPTS_RELEASE } = await import(pathToFileURL(bundle));
rmSync(bundle);
const pkg = resolveBmadInstallerPackage(BMAD_INSTALLER_VERSION);
assert.equal(pkg.version, BMAD_INSTALLER_VERSION, `real pinned package unavailable: ${pkg.reason}`);
const scripts = [...REQUIRED_BMAD_SETUP_SCRIPTS].sort();
const source = join(pkg.root, "src", "scripts");
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const setup = createBmadChecks().find((check) => check.id === "bmad.setup-scripts");
const bmbMemlogRow = '"py","memlog","bmb","bmb/bmad-eval-runner/scripts/memlog.py","3d18f927cbee3a1b0b46c3d85447742359a09009dfd65819c5584c7142d38d04"';

/**
 * This repo's own TRACKED `_bmad` (git archive of HEAD, not the working tree): a
 * real install at a version other than the pin, whose scripts and manifest rows
 * are the same bytes on a workstation and in CI. The working tree's gitignored
 * files (the scripts here, a stray manifest) never leak into a scratch project.
 */
const trackedRoot = mkdtempSync(join(tmpdir(), "pjan-166-tracked-"));
process.on("exit", () => rmSync(trackedRoot, { recursive: true, force: true }));
{
  const archive = realSpawnSync("git", ["archive", "--format=tar", "HEAD", "_bmad"], { cwd: root, env: hermeticEnv(), maxBuffer: 512 * 1024 * 1024 });
  assert.equal(archive.status, 0, `git archive HEAD _bmad failed: ${archive.stderr}`);
  const extract = realSpawnSync("tar", ["-x", "-C", trackedRoot], { input: archive.stdout, env: hermeticEnv() });
  assert.equal(extract.status, 0, `tar failed: ${extract.stderr}`);
}
const trackedManifestYaml = readFileSync(join(trackedRoot, "_bmad", "_config", "manifest.yaml"), "utf8");
// The version of that real install, read through the production export. Nothing below names it: a dogfood
// quick-update of this repo's _bmad moves it, and the tests follow.
const trackedVersion = readInstalledBmadVersion(trackedRoot);

/**
 * A scratch project in the pinned-version shape: `_bmad/core` plus a files-manifest.csv whose
 * script rows are the real pinned package's hashes. `installedVersion` adds the real manifest.yaml
 * (this repo's tracked one) relabelled to that version, read back through the production export.
 */
const fixture = ({ installedVersion } = {}) => {
  const project = mkdtempSync(join(tmpdir(), "pjan-166-"));
  mkdirSync(join(project, "_bmad", "_config"), { recursive: true });
  writeFileSync(join(project, "_bmad", "core"), "fixture-marker");
  writeFileSync(join(project, "_bmad", "_config", "files-manifest.csv"), "type,name,module,path,hash\n" + bmbMemlogRow + "\n" + scripts.map((name) => `"py","${name.slice(0, -3)}","scripts","scripts/${name}","${hash(join(source, name))}"`).join("\n") + "\n");
  if (installedVersion !== undefined) {
    writeFileSync(join(project, "_bmad", "_config", "manifest.yaml"), trackedManifestYaml.replace(/^(installation:\r?\n\s+version: ).*$/m, `$1${installedVersion}`));
    assert.equal(readInstalledBmadVersion(project), installedVersion, "the fixture's manifest.yaml must read back at the version asked for");
  }
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
    assert.deepEqual(plan.declined, []);
    assert.deepEqual(applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION).files, plan.files);
    assert.equal(readFileSync(join(dir, "local-notes.txt"), "utf8"), "foreign data");
    assert.equal(lstatSync(join(dir, "local-notes.txt")).mode & 0o7777, 0o600);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: a foreign symlink refuses before mutation; a manifest that attests other bytes withholds only that script", () => {
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
    // One script's row attests other bytes: the other four are still restored (per file, never all-or-nothing).
    writeFileSync(manifest, original.replace(hash(join(source, scripts[0])), "0".repeat(64)));
    result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(result.files, scripts.slice(1).map((name) => join(dir, name)));
    assert.deepEqual(result.declined.map((d) => d.name), [scripts[0]]);
    assert.match(result.declined[0].why, /other bytes/);
    assert.deepEqual(readdirSync(dir).sort(), scripts.slice(1));
    for (const name of scripts.slice(1)) assert.equal(hash(join(dir, name)), hash(join(source, name)), name);
    // Every row wrong: nothing is restorable, so it is a decline (an error naming each script), and nothing is written.
    for (const name of scripts.slice(1)) rmSync(join(dir, name));
    writeFileSync(manifest, original.replace(new RegExp(scripts.map((name) => hash(join(source, name))).join("|"), "g"), "0".repeat(64)));
    result = applyBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION);
    assert.match(result.error, /does not attest/);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.declined.map((d) => d.name), scripts);
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

// ---------------------------------------------------------------------------
// Rewritten PJAN-166 review round. A scratch project below is either
//   - realInstall(): a copy of THIS repo's own TRACKED `_bmad` (git archive of
//     HEAD, never the working tree), a real bmad-method install (see trackedVersion) whose
//     memlog.py attests other bytes than the pinned 6.12.1 (the shape of the
//     Wingman, bloodbank and pjangler installs the review measured), or
//   - fixture(): the pinned-version shape, whose manifest rows are the real
//     pinned package's bytes, optionally with a real manifest.yaml.
// The pinned package is resolved by the REAL npx wherever a test needs its
// bytes. A recording `npx` shim on PATH proves where NOTHING resolved it, or
// stands in for npx where the test needs a package it cannot get from npm (a
// patched or corrupted copy, a hung registry).
// ---------------------------------------------------------------------------
const cli = join(root, "dist", "index.js");
const REINSTALL = (version) => new RegExp(`npx -y bmad-method@${escapeRe(version)} install --yes --directory \\. --action quick-update \\(it rewrites tracked _bmad config files: review \`git diff _bmad\` before committing\\)`);
// What an install with no manifest.yaml (a fresh clone) is told: no raw installer command, which drops the installed modules there.
const MANIFEST_LESS_REMEDY = /this install's version is unknown here \(_bmad\/_config\/manifest\.yaml is absent, and it is git-ignored\) and a bare installer run on such a clone drops the installed modules from the tracked _bmad config, so run `pj migrate bmad\.scaffold` \(it passes this project's module set\), or restore manifest\.yaml first and review `git diff _bmad` afterwards/;
const NO_RAW_INSTALLER = /npx -y bmad-method@|--action quick-update|<the version/;
const OPTIONAL_MEMLOG = /memlog\.py is not needed by bmad\.scaffold \(it requires only resolve_config\.py and config_utils\.py\), so there is nothing to do unless a skill uses it; to restore anyway: /;
const NETWORK_HINT = /retry when npm is reachable/;
const BMAD_VERSION_REMEDY = /pj migrate bmad\.version/;
const manifestOf = (project) => join(project, "_bmad", "_config", "files-manifest.csv");
const rowFor = (name) => `"py","${name.slice(0, -3)}","scripts","scripts/${name}","${hash(join(source, name))}"`;

function escapeRe(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

const realInstall = () => {
  const project = mkdtempSync(join(tmpdir(), "pjan-166-real-"));
  cpSync(join(trackedRoot, "_bmad"), join(project, "_bmad"), { recursive: true });
  return project;
};

/** Run `body` with a recording `npx` first on PATH. `script` is what it does after recording (default: fail). */
const withNpxShim = async (body, { script = "exit 1" } = {}) => {
  const bin = mkdtempSync(join(tmpdir(), "pjan-166-npx-"));
  const marker = join(bin, "calls");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$@" >> '${marker}'\n${script}\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try { return await body({ calls: () => (existsSync(marker) ? readFileSync(marker, "utf8") : "") }); }
  finally { process.env.PATH = savedPath; rmSync(bin, { recursive: true, force: true }); }
};

/**
 * Record every spawnSync the production code makes (command, args, and the
 * options it passed: timeout and env), then run the REAL spawnSync, optionally
 * with the timeout clamped so a deliberately hung npx shim is killed in a blink.
 * The recorded timeout is what production asked for, not the clamp.
 */
const withSpawnSpy = async (body, { clampMs } = {}) => {
  const calls = [];
  childProcess.spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    // The env production passed is already the suite's hermetic one (plus its own npm_config_* pins); hermeticEnv() re-states it as the child's complete env.
    return realSpawnSync(command, args, { encoding: options?.encoding, cwd: options?.cwd, timeout: clampMs && options?.timeout ? Math.min(options.timeout, clampMs) : options?.timeout, env: hermeticEnv({ ...options?.env }) });
  };
  syncBuiltinESMExports();
  try { return await body(() => calls.filter((call) => call.command === "npx")); }
  finally { childProcess.spawnSync = realSpawnSync; syncBuiltinESMExports(); }
};

const withEnv = async (vars, body) => {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  try { return await body(); }
  finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
};

/** A copy of the real pinned package after `mutate(root)`, and the entry path npx would print for it. */
const patchedPackage = (mutate) => {
  const copy = mkdtempSync(join(tmpdir(), "pjan-166-patched-pkg-"));
  const packageRoot = join(copy, "bmad-method");
  cpSync(pkg.root, packageRoot, { recursive: true });
  mutate(packageRoot);
  return { copy, entry: join(packageRoot, "tools", "installer", "bmad-cli.js") };
};

/** Migrate must decline too, even when handed a stale failing finding, and must write nothing. */
const assertMigrateDeclines = async (project, finding) => {
  for (const dryRun of [true, false]) {
    const result = await setup.migrate(ctx(project, dryRun), { ...finding, status: "fail", fixable: true });
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.deepEqual(result.changedFiles, []);
  }
};

test("PJAN-166: every pinned sha256 is the real package's, for each pinned version and every script", () => {
  assert.deepEqual(Object.keys(PINNED_SETUP_SCRIPT_SHA256[BMAD_INSTALLER_VERSION] ?? {}).sort(), scripts, `the pin ${BMAD_INSTALLER_VERSION} has no constants: a pin bump must add them`);
  for (const [version, table] of Object.entries(PINNED_SETUP_SCRIPT_SHA256)) {
    const resolved = version === BMAD_INSTALLER_VERSION ? pkg : resolveBmadInstallerPackage(version);
    assert.equal(resolved.version, version, `real bmad-method@${version} unavailable: ${resolved.reason}`);
    assert.deepEqual(Object.keys(table).sort(), scripts, version);
    for (const name of scripts) assert.equal(table[name], hash(join(resolved.root, "src", "scripts", name)), `${version} ${name}`);
  }
});

test("PJAN-166: the inspection decides from the disk alone, by the pinned bytes, and restorable means attested", () => {
  const project = fixture();
  try {
    const inspected = inspectBmadSetupScripts(project, BMAD_INSTALLER_VERSION);
    assert.deepEqual(inspected, { state: "missing", missing: scripts, restorable: scripts, declined: [] });
    // One row attesting other bytes: that script is declined, the rest stay restorable.
    const manifest = manifestOf(project);
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(hash(join(source, "memlog.py")), "0".repeat(64)));
    const partial = inspectBmadSetupScripts(project, BMAD_INSTALLER_VERSION);
    assert.equal(partial.state, "missing");
    assert.deepEqual(partial.restorable, scripts.filter((name) => name !== "memlog.py"));
    assert.deepEqual(partial.declined.map((d) => d.name), ["memlog.py"]);
    // A version this build holds no constants for is judged structurally; the package's bytes decide later.
    assert.equal(inspectBmadSetupScripts(project, "99.0.0").state, "missing");
    assert.equal(planBmadSetupScripts(project, pkg, "99.0.0").declinable, "unverified");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: manifest rows that are not exactly the installer's attestation decline that script, never restore it", () => {
  const project = fixture();
  try {
    const manifest = manifestOf(project);
    const original = readFileSync(manifest, "utf8");
    const target = scripts[0];
    const others = scripts.slice(1).map((name) => join(project, "_bmad", "scripts", name));
    const valid = rowFor(target);
    const declinedBy = (reason) => ({ reason });
    for (const [label, forged, expectation] of [
      ["row for another path", `"py","scripts/${target}","other","elsewhere.py","${hash(join(source, target))}"`, declinedBy(/has no row in _bmad\/_config\/files-manifest\.csv/)],
      ["same name in another module's path", valid.replace(`"scripts/${target}"`, `"bmb/bmad-eval-runner/scripts/${target}"`), declinedBy(/has no row/)],
      ["other module", valid.replace('"scripts",', '"other",'), declinedBy(/not the installer's py\/scripts row/)],
      ["other type", valid.replace('"py",', '"md",'), declinedBy(/not the installer's py\/scripts row/)],
      ["other name", valid.replace(`"${target.slice(0, -3)}",`, '"wrong",'), declinedBy(/not the installer's py\/scripts row/)],
      ["quoted column spoof", valid.replace('"scripts",', '"scr""ipts",'), declinedBy(/not the installer's py\/scripts row/)],
      ["extra column", `${valid},"extra"`, { malformed: /Invalid BMAD file manifest columns/ }],
      ["unterminated quote", `"py","${target.slice(0, -3)}","scripts","scripts/${target}","${hash(join(source, target))}","`, { malformed: /manifest/i }],
    ]) {
      writeFileSync(manifest, original.replace(valid, forged));
      const plan = planBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION);
      assert.equal(existsSync(join(project, "_bmad", "scripts")), false, label);
      if (expectation.malformed) {
        assert.match(plan.error, expectation.malformed, label);
        assert.equal(plan.declinable, undefined, `${label}: a malformed manifest is damage, not a decline`);
        assert.deepEqual(plan.files, [], label);
      } else {
        assert.equal(plan.error, undefined, `${label}: ${plan.error}`);
        assert.deepEqual(plan.files, others, `${label}: the other four are never held back`);
        assert.deepEqual(plan.declined.map((d) => d.name), [target], label);
        assert.match(plan.declined[0].why, expectation.reason, label);
      }
    }
    writeFileSync(manifest, original + valid + "\n");
    const duplicate = planBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION);
    assert.match(duplicate.declined.find((d) => d.name === target).why, /has 2 rows/);
    assert.deepEqual(duplicate.files, others);
    writeFileSync(manifest, original.replace(/\n/g, "\r\n"));
    assert.equal(planBmadSetupScripts(project, pkg, BMAD_INSTALLER_VERSION).files.length, scripts.length);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: an install whose manifest.yaml names the pinned version and whose scripts are missing fails fixably, lists the paths, and migrates to a pass", async () => {
  const project = fixture({ installedVersion: BMAD_INSTALLER_VERSION });
  try {
    const finding = await setup.audit(ctx(project, false));
    assert.equal(finding.status, "fail", JSON.stringify(finding));
    assert.equal(finding.fixable, true);
    assert.deepEqual(finding.details, scripts.map((name) => `_bmad/scripts/${name}`), "one line per missing script, and nothing declined");
    assert.match(finding.summary, /^Ignored BMAD installer scripts are missing$/);
    const result = await setup.migrate(ctx(project, false), finding);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.changedFiles.length, scripts.length);
    assert.equal((await setup.audit(ctx(project, false))).status, "pass");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: restorability is the manifest row's bytes, not the manifest.yaml version label", async () => {
  // 6.12.0 and a prerelease are what a mid-bump or canary install carries; the tracked install's own version and 99.0.0 prove it is
  // the bytes and not an allow-list of labels. Every one of them attests the pinned package's own rows.
  for (const label of ["6.12.0", "6.12.1-next.0", trackedVersion, "99.0.0"]) {
    const project = fixture({ installedVersion: label });
    try {
      const finding = await setup.audit(ctx(project, false));
      assert.equal(finding.status, "fail", `${label}: ${JSON.stringify(finding)}`);
      assert.equal(finding.fixable, true, label);
      assert.deepEqual(finding.details, scripts.map((name) => `_bmad/scripts/${name}`), label);
      const preview = await setup.migrate(ctx(project, true), finding);
      assert.equal(preview.status, "applied", `${label}: ${JSON.stringify(preview)}`);
      assert.equal(preview.changedFiles.length, scripts.length, label);
      assert.equal(existsSync(join(project, "_bmad", "scripts")), false, `${label}: a preview writes nothing`);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: `pj migrate --all --dry-run` (the built CLI) reports bmad.setup-scripts applied for a manifest-labelled pinned install, never blocked", () => {
  assert.ok(existsSync(cli), "dist/index.js is missing; run `mise run build` first");
  const project = fixture({ installedVersion: BMAD_INSTALLER_VERSION });
  try {
    // The child's npx caches under the SUITE's scratch HOME, warm from the import-time resolve above.
    const run = realSpawnSync(process.execPath, [cli, "migrate", "--all", "--dry-run", "--json", project], { encoding: "utf8", env: hermeticEnv({ HOME: process.env.HOME }, { pass: SUITE_GRANTS }), timeout: 170_000 });
    const report = JSON.parse(run.stdout);
    const result = report.results.find((entry) => entry.id === "bmad.setup-scripts");
    assert.ok(result, `bmad.setup-scripts was not run: ${run.stdout.slice(0, 600)} ${run.stderr.slice(0, 300)}`);
    assert.equal(report.dryRun, true);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.deepEqual(result.changedFiles.map((path) => path.slice(project.length + 1)), scripts.map((name) => `_bmad/scripts/${name}`));
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false, "a dry run writes nothing");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: the real install used below really is the shape the review measured", () => {
  const project = realInstall();
  try {
    const dir = join(project, "_bmad", "scripts");
    assert.equal(readInstalledBmadVersion(project), trackedVersion);
    assert.notEqual(readInstalledBmadVersion(project), BMAD_INSTALLER_VERSION, "this tree must be installed at a version other than the pin, or the tests below prove nothing");
    for (const name of scripts) assert.equal(lstatSync(join(dir, name)).isFile(), true, name);
    // The shape the review measured on 6.12.4: memlog.py differs from the pinned package's, the other four are byte-identical to it.
    assert.deepEqual(scripts.filter((name) => hash(join(dir, name)) !== hash(join(source, name))), ["memlog.py"]);
    const manifest = readFileSync(manifestOf(project), "utf8");
    assert.ok(manifest.includes(`"py","memlog","scripts","scripts/memlog.py","${hash(join(dir, "memlog.py"))}"`), "its manifest row attests its own (installed) bytes");
    for (const name of scripts.filter((n) => n !== "memlog.py")) assert.ok(manifest.includes(rowFor(name)), name);
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
      const manifest = manifestOf(project);
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
  assert.ok(existsSync(cli), "dist/index.js is missing; run `mise run build` first");
  const healthy = realInstall();
  const missing = realInstall();
  try {
    rmSync(join(missing, "_bmad", "scripts", "memlog.py"));
    await withNpxShim(({ calls }) => {
      for (const [project, status] of [[healthy, "pass"], [missing, "skip"]]) {
        const run = realSpawnSync(process.execPath, [cli, "audit", project, "--rules", "bmad.setup-scripts", "--json"], { encoding: "utf8", env: hermeticEnv(), timeout: 60_000 });
        assert.equal(run.status, 0, run.stderr);
        const report = JSON.parse(run.stdout);
        assert.equal(report.ok, true, run.stdout);
        assert.equal(report.rules[0].id, "bmad.setup-scripts");
        assert.equal(report.rules[0].status, status, run.stdout);
      }
      assert.equal(calls(), "", "neither a healthy project nor an unattestable one may invoke npx");
    });
  } finally {
    rmSync(healthy, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("PJAN-166: a missing memlog.py on a real install at another version skips with a remedy that is not the no-op bmad.version, resolving and writing nothing", async () => {
  const project = realInstall();
  try {
    const dir = join(project, "_bmad", "scripts");
    rmSync(join(dir, "memlog.py"));
    const before = readdirSync(dir).sort();
    const shortOfPinned = hash(join(source, "memlog.py")).slice(0, 12);
    const shortOfInstalled = hash(join(trackedRoot, "_bmad", "scripts", "memlog.py")).slice(0, 12);
    await withNpxShim(async ({ calls }) => {
      const finding = await setup.audit(ctx(project, false));
      assert.equal(finding.status, "skip", JSON.stringify(finding));
      assert.equal(finding.fixable, false);
      assert.ok(finding.summary.startsWith(`Setup script recovery unavailable: scripts/memlog.py is attested by the manifest as other bytes (sha256 ${shortOfInstalled}) than bmad-method@${BMAD_INSTALLER_VERSION}'s (${shortOfPinned})`), finding.summary);
      assert.match(finding.summary, /\(missing from _bmad\/scripts: memlog\.py\)/);
      assert.match(finding.summary, REINSTALL(trackedVersion));
      assert.match(finding.summary, OPTIONAL_MEMLOG, "memlog.py is not a script bmad.scaffold needs, and the remedy says so");
      assert.doesNotMatch(finding.summary, BMAD_VERSION_REMEDY, "bmad.version is a no-op for an install that is already current");
      assert.doesNotMatch(finding.summary, NETWORK_HINT, "the cause is the install's manifest, not the network");
      await assertMigrateDeclines(project, finding);
      assert.equal(calls(), "", "an unattestable script is decided from the disk; it must not wait on npm");
    });
    assert.deepEqual(readdirSync(dir).sort(), before, "nothing restored");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: a real install at another version missing every script restores the four it can attest and declines memlog.py, with the reason and the remedy", async () => {
  const project = realInstall();
  try {
    const dir = join(project, "_bmad", "scripts");
    rmSync(dir, { recursive: true });
    const attested = scripts.filter((name) => name !== "memlog.py");
    const finding = await setup.audit(ctx(project, false));
    assert.equal(finding.status, "fail", JSON.stringify(finding));
    assert.equal(finding.fixable, true, "the four attested scripts are fixable whatever memlog.py is");
    assert.deepEqual(finding.details.slice(0, attested.length), attested.map((name) => `_bmad/scripts/${name}`));
    assert.match(finding.summary, /declined scripts\/memlog\.py is attested by the manifest as other bytes/);
    assert.match(finding.summary, REINSTALL(trackedVersion));
    assert.match(finding.summary, OPTIONAL_MEMLOG);
    assert.ok(finding.details.some((line) => line.startsWith("declined scripts/memlog.py is attested by the manifest as other bytes")), JSON.stringify(finding.details));
    const preview = await setup.migrate(ctx(project, true), finding);
    assert.equal(preview.status, "applied", JSON.stringify(preview));
    assert.deepEqual(preview.changedFiles, attested.map((name) => join(dir, name)));
    assert.match(preview.summary, /declined scripts\/memlog\.py/);
    assert.equal(existsSync(dir), false, "a preview writes nothing");
    const applied = await setup.migrate(ctx(project, false), finding);
    assert.equal(applied.status, "applied", `an unattested script must not block the attested ones: ${JSON.stringify(applied)}`);
    assert.deepEqual(applied.changedFiles, attested.map((name) => join(dir, name)));
    assert.match(applied.summary, /^Restored ignored BMAD installer scripts; declined scripts\/memlog\.py is attested by the manifest as other bytes/);
    assert.match(applied.summary, REINSTALL(trackedVersion));
    for (const name of attested) assert.equal(hash(join(dir, name)), hash(join(source, name)), name);
    assert.equal(existsSync(join(dir, "memlog.py")), false, "the unattested script is never written");
    // What is left is a declined skip, not a failure, and a second migrate changes nothing.
    const after = await setup.audit(ctx(project, false));
    assert.equal(after.status, "skip", JSON.stringify(after));
    assert.match(after.summary, /scripts\/memlog\.py is attested by the manifest as other bytes/);
    const again = await setup.migrate(ctx(project, false), { ...after, status: "fail", fixable: true });
    assert.equal(again.status, "skipped", JSON.stringify(again));
    assert.deepEqual(again.changedFiles, []);
    assert.deepEqual(readdirSync(dir).sort(), attested);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: an install whose manifest has no row for a missing script skips without a probe, and is told the remedy that works for its shape (perth and alpha)", async () => {
  // perth: rows for resolve_config/resolve_customization only, exactly those two present.
  // alpha (CommonProject, castagram, ...): no script rows and no scripts directory.
  const perth = ["resolve_config.py", "resolve_customization.py"];
  const shapes = [
    // A fresh clone has no manifest.yaml: the version is unknown, so no raw installer command is printed at all.
    ["perth, no manifest.yaml", perth, undefined, (summary) => { assert.match(summary, MANIFEST_LESS_REMEDY); assert.doesNotMatch(summary, NO_RAW_INSTALLER); }],
    ["alpha, no manifest.yaml", [], undefined, (summary) => { assert.match(summary, MANIFEST_LESS_REMEDY); assert.doesNotMatch(summary, NO_RAW_INSTALLER); }],
    // An install that predates the first release shipping _bmad/scripts cannot get them from its own installer.
    ["alpha, manifest.yaml tracked at 6.0.0-alpha.23", [], "6.0.0-alpha.23", (summary) => {
      assert.match(summary, new RegExp(`this install \\(bmad-method@6\\.0\\.0-alpha\\.23\\) predates the first release that ships _bmad/scripts \\(${escapeRe(BMAD_FIRST_SCRIPTS_RELEASE)}\\), so re-running its own installer cannot create them: run \`pj migrate bmad\\.version\` to upgrade it`));
      assert.doesNotMatch(summary, NO_RAW_INSTALLER);
    }],
    // One release before the boundary is still before it; the boundary itself and later are not.
    ["perth, manifest.yaml at the release before the boundary", perth, "6.3.1-next.12", (summary) => assert.match(summary, BMAD_VERSION_REMEDY)],
    ["perth, manifest.yaml at the boundary release", perth, BMAD_FIRST_SCRIPTS_RELEASE, (summary) => { assert.match(summary, REINSTALL(BMAD_FIRST_SCRIPTS_RELEASE)); assert.doesNotMatch(summary, BMAD_VERSION_REMEDY); }],
  ];
  for (const [label, attested, installedVersion, remedy] of shapes) {
    const project = fixture({ installedVersion });
    try {
      const dir = join(project, "_bmad", "scripts");
      writeFileSync(manifestOf(project), "type,name,module,path,hash\n" + bmbMemlogRow + "\n" + attested.map(rowFor).map((row) => row + "\n").join(""));
      if (attested.length) { mkdirSync(dir); for (const name of attested) copyFileSync(join(source, name), join(dir, name)); }
      const unattested = scripts.filter((name) => !attested.includes(name));
      await withNpxShim(async ({ calls }) => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "skip", `${label}: ${JSON.stringify(finding)}`);
        assert.equal(finding.fixable, false);
        for (const name of unattested) assert.ok(finding.summary.includes(`scripts/${name} has no row in _bmad/_config/files-manifest.csv, so it cannot be attested`), `${label}: ${name} in: ${finding.summary}`);
        assert.match(finding.summary, new RegExp(`missing from _bmad/scripts: ${escapeRe(unattested.join(", "))}\\)`));
        remedy(finding.summary);
        assert.doesNotMatch(finding.summary, NETWORK_HINT, label);
        await assertMigrateDeclines(project, finding);
        assert.equal(calls(), "", `${label}: an unattestable restore must not wait on npm`);
      });
      assert.deepEqual(existsSync(dir) ? readdirSync(dir).sort() : [], attested.slice().sort());
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: BMAD_FIRST_SCRIPTS_RELEASE is the first bmad-method release that ships src/scripts (real packages, both sides of the boundary)", () => {
  const shipped = (version) => {
    const resolved = resolveBmadInstallerPackage(version, { timeoutMs: 120_000 });
    assert.equal(resolved.version, version, `real bmad-method@${version} unavailable: ${resolved.reason}`);
    const dir = join(resolved.root, "src", "scripts");
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".py")) : [];
  };
  assert.deepEqual(shipped("6.3.1-next.12"), [], "the release before the boundary ships no _bmad/scripts source");
  assert.notDeepEqual(shipped(BMAD_FIRST_SCRIPTS_RELEASE), [], "the boundary release ships one");
});

test("PJAN-166: a manifest that attests other bytes than the pinned package skips with the remedy, never fails", async () => {
  const project = fixture({ installedVersion: trackedVersion });
  try {
    const dir = join(project, "_bmad", "scripts");
    mkdirSync(dir);
    for (const name of scripts.filter((n) => n !== scripts[1])) copyFileSync(join(source, name), join(dir, name));
    writeFileSync(manifestOf(project), readFileSync(manifestOf(project), "utf8").replace(hash(join(source, scripts[1])), "0".repeat(64)));
    await withNpxShim(async ({ calls }) => {
      const finding = await setup.audit(ctx(project, false));
      assert.equal(finding.status, "skip", JSON.stringify(finding));
      assert.equal(finding.fixable, false);
      assert.match(finding.summary, new RegExp(`scripts/${escapeRe(scripts[1])} is attested by the manifest as other bytes \\(sha256 000000000000\\) than bmad-method@${escapeRe(BMAD_INSTALLER_VERSION)}'s`));
      assert.match(finding.summary, REINSTALL(trackedVersion));
      assert.doesNotMatch(finding.summary, NETWORK_HINT, "the cause is the manifest, not the network");
      assert.doesNotMatch(finding.summary, BMAD_VERSION_REMEDY);
      await assertMigrateDeclines(project, finding);
      assert.equal(calls(), "");
    });
    assert.equal(existsSync(join(dir, scripts[1])), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: a malformed manifest is a visible failure decided from the disk, never a decline or a write", async () => {
  for (const [label, text] of [["garbage", "this is not a manifest\n"], ["wrong header", "a,b,c\n1,2,3\n"], ["wrong header, five columns", "kind,label,module,file,sum\n" + bmbMemlogRow + "\n"], ["unterminated quote", 'type,name,module,path,hash\n"py,"x\n']]) {
    const project = realInstall();
    try {
      const dir = join(project, "_bmad", "scripts");
      rmSync(join(dir, "memlog.py"));
      writeFileSync(manifestOf(project), text);
      await withNpxShim(async ({ calls }) => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "fail", `${label}: ${JSON.stringify(finding)}`);
        assert.equal(finding.fixable, false);
        assert.match(finding.summary, /manifest/i);
        for (const dryRun of [true, false]) {
          const result = await setup.migrate(ctx(project, dryRun), { ...finding, status: "fail", fixable: true });
          assert.equal(result.status, "blocked", `${label}: ${JSON.stringify(result)}`);
          assert.deepEqual(result.changedFiles, []);
        }
        assert.equal(calls(), "", label);
      });
      assert.equal(existsSync(join(dir, "memlog.py")), false, label);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: an unreachable pinned package is a skip naming the network remedy, never a fail (real npx, offline, cold cache)", async () => {
  const project = fixture();
  const cache = mkdtempSync(join(tmpdir(), "pjan-166-npm-cache-"));
  try {
    await withEnv({ npm_config_offline: "true", npm_config_cache: cache }, async () => {
      const finding = await setup.audit(ctx(project, false));
      assert.equal(finding.status, "skip", JSON.stringify(finding));
      assert.equal(finding.fixable, false);
      assert.match(finding.summary, new RegExp(`Setup script recovery unavailable: could not resolve bmad-method@${escapeRe(BMAD_INSTALLER_VERSION)}`));
      assert.match(finding.summary, NETWORK_HINT);
      assert.doesNotMatch(finding.summary, BMAD_VERSION_REMEDY);
      for (const name of scripts) assert.ok(finding.summary.includes(name), `${name} named in: ${finding.summary}`);
      await assertMigrateDeclines(project, finding);
    });
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("PJAN-166: the resolver keeps its 180s default, honours a given timeout, and reads only an exact version from the npx cache", async () => {
  assert.equal(BMAD_RESOLVE_DEFAULT_TIMEOUT_MS, 180_000, "bmad.scaffold and bmad.version migrate rely on this default");
  await withNpxShim(async () => withSpawnSpy(async (npxCalls) => {
    resolveBmadInstallerPackage(BMAD_INSTALLER_VERSION);
    resolveBmadInstallerPackage(BMAD_INSTALLER_VERSION, { timeoutMs: 1234 });
    resolveBmadInstallerPackage("latest");
    resolveBmadInstallerPackage("6.13.0-next.1");
    const [bare, given, tag, prerelease] = npxCalls();
    assert.equal(bare.options.timeout, 180_000, "no options keeps the 180s default");
    assert.equal(given.options.timeout, 1234);
    assert.equal(bare.options.env.npm_config_prefer_offline, "true", "an exact version is immutable, so the cached copy is as good as a fresh one");
    assert.equal(prerelease.options.env.npm_config_prefer_offline, "true");
    assert.equal(tag.options.env.npm_config_prefer_offline, undefined, "a dist-tag moves; it is never read from a stale cache");
    assert.deepEqual(bare.args.slice(0, 3), ["-y", "-p", `bmad-method@${BMAD_INSTALLER_VERSION}`]);
  }));
});

test("PJAN-166: the audit waits at most the probe cap for the package, and a migrate waits the resolver's default", async () => {
  assert.equal(BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS, 10_000);
  const project = fixture({ installedVersion: BMAD_INSTALLER_VERSION });
  try {
    await withSpawnSpy(async (npxCalls) => {
      const finding = await setup.audit(ctx(project, true));
      assert.equal(finding.status, "fail", JSON.stringify(finding));
      const preview = await setup.migrate(ctx(project, true), finding);
      assert.equal(preview.status, "applied", JSON.stringify(preview));
      const [audit, migrate] = npxCalls();
      assert.equal(npxCalls().length, 2);
      assert.equal(audit.options.timeout, BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS, "the audit never rides out npm's retries");
      assert.equal(migrate.options.timeout, BMAD_RESOLVE_DEFAULT_TIMEOUT_MS, "a migrate is an explicit request to repair");
      for (const call of [audit, migrate]) assert.equal(call.options.env.npm_config_prefer_offline, "true");
    });
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: with npx hung, the audit skips at its cap naming the network remedy, and migrate declines the same way (hermetic: a local shim, killed fast)", async () => {
  const project = fixture();
  try {
    await withNpxShim(async ({ calls }) => withSpawnSpy(async (npxCalls) => {
      const started = Date.now();
      const finding = await setup.audit(ctx(project, false));
      assert.equal(finding.status, "skip", JSON.stringify(finding));
      assert.equal(finding.fixable, false);
      assert.match(finding.summary, new RegExp(`could not resolve bmad-method@${escapeRe(BMAD_INSTALLER_VERSION)}: timed out after 10s`));
      assert.match(finding.summary, NETWORK_HINT);
      for (const name of scripts) assert.ok(finding.summary.includes(name), `${name} named in: ${finding.summary}`);
      await assertMigrateDeclines(project, finding);
      assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms`);
      const [audit, ...migrates] = npxCalls();
      assert.equal(audit.options.timeout, BMAD_SETUP_SCRIPTS_PROBE_TIMEOUT_MS);
      assert.deepEqual(migrates.map((call) => call.options.timeout), [BMAD_RESOLVE_DEFAULT_TIMEOUT_MS, BMAD_RESOLVE_DEFAULT_TIMEOUT_MS]);
      assert.match(calls(), new RegExp(`-y -p bmad-method@${escapeRe(BMAD_INSTALLER_VERSION)}`));
    }, { clampMs: 400 }), { script: "exec sleep 30" });
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: a migrate handed the audit's give-up finding retries with its own wait, and restores", async () => {
  const project = fixture();
  try {
    let gaveUp;
    await withNpxShim(async () => withSpawnSpy(async () => {
      gaveUp = await setup.audit(ctx(project, false));
    }, { clampMs: 400 }), { script: "exec sleep 30" });
    assert.equal(gaveUp.status, "skip", JSON.stringify(gaveUp));
    assert.equal(gaveUp.fixable, false);
    // npm is reachable again (the real npx, warm): the stale skip must not stop the repair.
    const preview = await setup.migrate(ctx(project, true), gaveUp);
    assert.equal(preview.status, "applied", JSON.stringify(preview));
    assert.equal(preview.changedFiles.length, scripts.length);
    const applied = await setup.migrate(ctx(project, false), gaveUp);
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    for (const name of scripts) assert.equal(hash(join(project, "_bmad", "scripts", name)), hash(join(source, name)), name);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: each package-side decline names its own remedy, and only a resolver failure suggests waiting for npm", async () => {
  const causes = [
    ["a patched installer (fingerprint mismatch)", (root) => appendFileSync(join(root, "tools", "installer", "bmad-cli.js"), "\n// patched, so its fingerprint is not a verified one\n"), /Unverified BMAD installer fingerprint/, /clear the npx cache \(rm -rf "\$\(npm config get cache\)\/_npx"\) and re-run/],
    ["a corrupted npx copy (the scripts directory is gone)", (root) => rmSync(join(root, "src", "scripts"), { recursive: true }), /Pinned installer scripts are unreadable: .*ENOENT/, /corrupted npx cache\): clear it/],
    ["a corrupted npx copy (a script is not a file)", (root) => { rmSync(join(root, "src", "scripts", "memlog.py")); mkdirSync(join(root, "src", "scripts", "memlog.py")); }, /Installer script memlog\.py is unreadable in the pinned package/, /corrupted npx cache\): clear it/],
    ["an installer whose script inventory changed", (root) => writeFileSync(join(root, "src", "scripts", "surprise.py"), "# a sixth script\n"), /Pinned installer script inventory changed/, /clear the npx cache/],
    // The read errors of a corrupted copy that precede the scripts directory: each is a package decline, never the network's and never a project fail.
    ["a corrupted npx copy (package.json is gone)", (root) => rmSync(join(root, "package.json")), /whose package\.json is unreadable: .*ENOENT/, /corrupted npx cache\): clear it/],
    ["a corrupted npx copy (package.json is not JSON)", (root) => writeFileSync(join(root, "package.json"), "{ truncated"), /whose package\.json is unreadable: /, /corrupted npx cache\): clear it/],
    ["a corrupted npx copy (the installer cannot be fingerprinted)", (root) => { rmSync(join(root, "tools", "installer"), { recursive: true }); writeFileSync(join(root, "tools", "installer"), "not a directory"); }, /Could not fingerprint pinned BMAD installer: .*ENOTDIR/, /corrupted npx cache\): clear it/],
    ["a copy that is another package", (root) => writeFileSync(join(root, "package.json"), JSON.stringify({ name: "not-bmad-method", version: "1.0.0" })), /is not inside a bmad-method package/, /clear the npx cache/],
  ];
  for (const [label, mutate, reason, remedy] of causes) {
    const project = fixture();
    const patched = patchedPackage(mutate);
    try {
      await withNpxShim(async () => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "skip", `${label} is a host condition, never a project failure: ${JSON.stringify(finding)}`);
        assert.equal(finding.fixable, false, label);
        assert.match(finding.summary, reason, label);
        assert.match(finding.summary, remedy, label);
        assert.doesNotMatch(finding.summary, NETWORK_HINT, `${label}: re-running when npm is reachable cannot cure it`);
        assert.doesNotMatch(finding.summary, /PJ_BMAD_INSTALLER/, `${label}: no override is set`);
        assert.doesNotMatch(finding.summary, BMAD_VERSION_REMEDY, label);
        await assertMigrateDeclines(project, finding);
      }, { script: `printf '%s' '${patched.entry}'` });
      // With an explicit PJ_BMAD_INSTALLER the override is the thing to fix, whatever the cause.
      await withEnv({ PJ_BMAD_INSTALLER: patched.entry }, async () => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "skip", `${label} (override): ${JSON.stringify(finding)}`);
        assert.match(finding.summary, /fix or unset PJ_BMAD_INSTALLER to enable recovery from the pinned package/, label);
        assert.doesNotMatch(finding.summary, NETWORK_HINT, label);
        assert.doesNotMatch(finding.summary, /clear the npx cache|corrupted npx cache/, `${label}: an override is not the npx cache`);
        await assertMigrateDeclines(project, finding);
      });
      assert.equal(existsSync(join(project, "_bmad", "scripts")), false, label);
    } finally {
      rmSync(patched.copy, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }
});

test("PJAN-166: a mistyped or non-package PJ_BMAD_INSTALLER skips and says to fix or unset it", async () => {
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
        assert.match(finding.summary, /fix or unset PJ_BMAD_INSTALLER to enable recovery from the pinned package/);
        assert.doesNotMatch(finding.summary, NETWORK_HINT);
        await assertMigrateDeclines(project, finding);
        // Handed a stale failing finding, migrate re-resolves and declines without writing.
        const stale = await setup.migrate(ctx(project, false), { ...finding, status: "fail", fixable: true });
        assert.equal(stale.status, "skipped", JSON.stringify(stale));
      });
    }
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("PJAN-166: a pre-manifest install (no files-manifest.csv) skips with the install remedy, never fails or writes", async () => {
  const project = fixture();
  try {
    rmSync(manifestOf(project));
    const finding = await setup.audit(ctx(project, false));
    assert.equal(finding.status, "skip", JSON.stringify(finding));
    assert.equal(finding.fixable, false);
    assert.match(finding.summary, /files-manifest\.csv is absent/);
    assert.match(finding.summary, MANIFEST_LESS_REMEDY);
    assert.doesNotMatch(finding.summary, NO_RAW_INSTALLER);
    assert.doesNotMatch(finding.summary, NETWORK_HINT);
    await assertMigrateDeclines(project, finding);
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
    // A symlinked manifest is not "absent": it still refuses visibly, naming the path, rather than being skipped.
    symlinkSync(join(project, "elsewhere.csv"), manifestOf(project));
    const refused = await setup.audit(ctx(project, false));
    assert.equal(refused.status, "fail", JSON.stringify(refused));
    assert.match(refused.summary, /_bmad\/_config\/files-manifest\.csv cannot attest recovered scripts \(missing from _bmad\/scripts: /);
    assert.equal(existsSync(join(project, "_bmad", "scripts")), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("PJAN-166: scripts and manifest both missing skips, says the scripts are missing, and names the install remedy", async () => {
  // Each project is made inside its own try, so a failure while building one leaks no other.
  for (const [label, make, remedy] of [
    ["pinned shape (no manifest.yaml)", fixture, (summary) => { assert.match(summary, MANIFEST_LESS_REMEDY); assert.doesNotMatch(summary, NO_RAW_INSTALLER); }],
    ["real install", realInstall, (summary) => assert.match(summary, REINSTALL(trackedVersion))],
  ]) {
    let project;
    try {
      project = make();
      rmSync(join(project, "_bmad", "scripts"), { recursive: true, force: true });
      rmSync(manifestOf(project));
      await withNpxShim(async ({ calls }) => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "skip", `${label}: ${JSON.stringify(finding)}`);
        assert.equal(finding.fixable, false);
        assert.ok(finding.summary.includes(`missing from _bmad/scripts: ${scripts.join(", ")}`), finding.summary);
        assert.match(finding.summary, /files-manifest\.csv is absent/);
        remedy(finding.summary);
        assert.doesNotMatch(finding.summary, BMAD_VERSION_REMEDY);
        await assertMigrateDeclines(project, finding);
        assert.equal(calls(), "");
      });
    } finally { if (project) rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: a g33-enabled project is pointed at bmad.scaffold, never at a bare installer run, and told the g33 prerequisite while its adapter is unavailable", async () => {
  const bareInstaller = /npx -y bmad-method@|--action quick-update/;
  const cases = [
    ["g33 on, no adapter configured", { enabled: true }, false, [/run `pj migrate bmad\.scaffold` \(it re-runs the BMAD installer and keeps the g33 companion, but it stays blocked while the g33 adapter is unavailable: no bmad\.companion\.adapter is configured; run `pj skills enable skill g33-33god-integration` first\); a bare installer run would bypass the g33 update boundary/], [bareInstaller]],
    ["g33 on, adapter source absent (a fresh clone)", { enabled: true, adapter: { module: "./adapter.mjs", exportName: "g33Adapter" } }, false, [/stays blocked while the g33 adapter is unavailable: its adapter source \.\/adapter\.mjs is absent; run `pj skills enable skill g33-33god-integration` first/], [bareInstaller]],
    ["g33 on, adapter source present", { enabled: true, adapter: { module: "./adapter.mjs", exportName: "g33Adapter" } }, true, [/run `pj migrate bmad\.scaffold` \(it re-runs the BMAD installer and keeps the g33 companion\); a bare installer run would bypass the g33 update boundary/], [/stays blocked/, /pj skills enable/, bareInstaller]],
    ["g33 explicitly off", { enabled: false }, false, [REINSTALL(trackedVersion)], [/pj migrate bmad\.scaffold/, /g33/]],
  ];
  for (const [label, companion, adapterPresent, wanted, unwanted] of cases) {
    const project = realInstall();
    try {
      rmSync(join(project, "_bmad", "scripts", "memlog.py"));
      writeFileSync(join(project, ".project.json"), JSON.stringify({ bmad: { companion } }));
      if (adapterPresent) writeFileSync(join(project, "adapter.mjs"), "export const g33Adapter = () => ({});\n");
      await withNpxShim(async ({ calls }) => {
        const finding = await setup.audit(ctx(project, false));
        assert.equal(finding.status, "skip", `${label}: ${JSON.stringify(finding)}`);
        for (const pattern of wanted) assert.match(finding.summary, pattern, label);
        for (const pattern of unwanted) assert.doesNotMatch(finding.summary, pattern, label);
        assert.match(finding.summary, OPTIONAL_MEMLOG, `${label}: the declined script is optional, and the remedy says so`);
        assert.equal(calls(), "", label);
      });
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: a dangling or live symlinked _config is a visible refusal naming the path and the missing scripts, not an absent manifest", async () => {
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
        assert.match(finding.summary, /Installed BMAD file manifest is missing or not a real file: _bmad\/_config cannot attest recovered scripts \(missing from _bmad\/scripts: memlog\.py\)/);
        for (const dryRun of [true, false]) {
          const result = await setup.migrate(ctx(project, dryRun), { ...finding, status: "fail", fixable: true });
          assert.equal(result.status, "blocked", JSON.stringify(result));
          assert.match(result.summary, /_bmad\/_config cannot attest recovered scripts \(missing from _bmad\/scripts: memlog\.py\)/);
          assert.deepEqual(result.changedFiles, []);
        }
        assert.equal(calls(), "");
      });
      assert.equal(existsSync(join(bmad, "scripts", "memlog.py")), false, "nothing restored through the symlink");
      assert.equal(lstatSync(join(bmad, "_config")).isSymbolicLink(), true);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
});

test("PJAN-166: scripts that appear while the package is being resolved (a concurrent installer) read as present, never a decline or a double write", async () => {
  const project = fixture();
  try {
    const dir = join(project, "_bmad", "scripts");
    // npx stands in for the concurrent installer: it restores every script, then reports the real package's entry.
    const copies = scripts.map((name) => `cp '${join(source, name)}' '${dir}/${name}'`).join("\n");
    const installerRace = { script: `mkdir -p '${dir}'\n${copies}\nprintf '%s' '${pkg.entry}'` };
    await withNpxShim(async ({ calls }) => {
      const finding = await setup.audit(ctx(project, false));
      assert.match(calls(), /-y -p bmad-method@/, "the package was resolved, so the disk had been judged restorable first");
      assert.equal(finding.status, "pass", JSON.stringify(finding));
      assert.equal(finding.fixable, false);
      assert.deepEqual(readdirSync(dir).sort(), scripts);
    }, installerRace);
    // The same race on a migrate: nothing is left to write, so it is a noop, not a blocked or declined result.
    rmSync(dir, { recursive: true });
    await withNpxShim(async () => {
      const result = await setup.migrate(ctx(project, false), { id: "bmad.setup-scripts", title: "x", status: "fail", summary: "", details: [], fixable: true });
      assert.equal(result.status, "noop", JSON.stringify(result));
      assert.deepEqual(result.changedFiles, []);
    }, installerRace);
  } finally { rmSync(project, { recursive: true, force: true }); }
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
