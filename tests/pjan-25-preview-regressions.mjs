import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createBmadInstallerFixture, createSkillPackFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const scratch = hermeticScratch("pjan-25-preview-");
const home = join(scratch, "home");
const registryRoot = join(scratch, "skills-registry");
mkdirSync(join(home, ".cache", "pjangler"), { recursive: true });
writeFileSync(join(home, ".cache", "pjangler", "bmad-dist-tags.json"), JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.12.1", next: "6.12.1" } }));
createSkillPackFixture(registryRoot);
const env = hermeticEnv({
  HOME: home, XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(scratch, "state"),
  PJ_PROJECT_REGISTRY: join(scratch, "registry.yaml"), PJ_AGENT_HOOKS_LAYER: "false",
  GIT_CEILING_DIRECTORIES: scratch, SKILLEX_REGISTRY_ROOT: registryRoot, PJ_SKILLS_REGISTRY_ROOT: registryRoot,
  PJ_BMAD_INSTALLER: createBmadInstallerFixture(registryRoot), PATH: `${createSkillexMiseFixture(scratch)}:${process.env.PATH}`,
});
function call(target, args = [], extra = {}) {
  const registry = join(scratch, `registry-${target.includes("javascript") ? "javascript" : "python"}.yaml`);
  const result = spawnSync(process.execPath, [CLI, "init", "sample", "--target-dir", target, "--registry", registry, "--skip-board", "--no-tui", "--json", ...args], {
    cwd: scratch, env: { ...env, PJ_PROJECT_REGISTRY: registry, ...extra }, encoding: "utf8", timeout: 180_000,
  });
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { payload = { error: result.stdout + result.stderr }; }
  return { result, payload };
}
function tree(root) {
  const entries = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name), key = relative(root, full).split("\\").join("/");
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        entries.set(key, ["directory", "directory"]);
        if (key !== ".git") walk(full);
      } else if (stat.isSymbolicLink()) entries.set(key, ["symlink", readlinkSync(full)]);
      else entries.set(key, ["file", `${createHash("sha256").update(readFileSync(full)).digest("hex")}:${stat.mode & 0o7777}`]);
    }
  };
  if (existsSync(root)) walk(root);
  return entries;
}
function delta(before, after) {
  const changes = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(path), current = after.get(path);
    if (JSON.stringify(old) === JSON.stringify(current)) continue;
    if (old && old[0] !== current?.[0]) changes.push({ path, type: old[0], operation: "remove" });
    if (current) changes.push({ path, type: current[0], operation: old?.[0] === current[0] ? "modify" : "create" });
  }
  return changes;
}

try {
  for (const language of ["python", "javascript"]) {
    const target = join(scratch, `fresh-${language}`, "sample");
    mkdirSync(join(scratch, `fresh-${language}`));
    const before = tree(target);
    const homeBefore = tree(home);
    const stateBefore = tree(join(scratch, "state"));
    const preview = call(target, [...(language === "javascript" ? ["--obsidian-plugin"] : []), "--primary-language", language, "--dry-run"]);
    assert.equal(preview.result.status, 0, JSON.stringify(preview.payload));
    assert.deepEqual(tree(home), homeBefore, "preview must not write user configuration");
    assert.deepEqual(tree(join(scratch, "state")), stateBefore, "preview must not write user state");
    assert.deepEqual(tree(target), before, "preview must not write target");
    assert.equal(existsSync(join(scratch, `registry-${language}.yaml`)), false, "preview must not write registry");
    assert.deepEqual(preview.payload.affectedPaths.map(({ path, type, operation }) => ({ path, type, operation })), preview.payload.affectedPaths);
    assert.ok(preview.payload.affectedPaths.some((entry) => entry.path === "mise.toml"));
    assert.ok(preview.payload.affectedPaths.some((entry) => entry.path === ".mise/scripts/link-agentfiles.sh"));
    assert.ok(preview.payload.affectedPaths.some((entry) => entry.path === ".gitignore"));
    assert.ok(preview.payload.affectedPaths.some((entry) => entry.path === ".env.op"));
    assert.ok(preview.payload.affectedPaths.some((entry) => entry.path === ".copier-answers.yml"));
    assert.ok(preview.payload.affectedPaths.some((entry) => entry.path.startsWith("_bmad/")));
    assert.ok(preview.payload.affectedPaths.some((entry) => entry.path.startsWith(".claude/")));
    for (const root of [".claude", ".codex", ".gemini", ".copilot", ".opencode", ".kimi-code"]) {
      assert.ok(preview.payload.affectedPaths.some((entry) => entry.path === root || entry.path.startsWith(`${root}/`)), `${root} projection missing`);
    }
    if (language === "javascript") assert.ok(preview.payload.affectedPaths.some((entry) => entry.path === "manifest.json"), "plugin-specific input must add output");
    else assert.ok(!preview.payload.affectedPaths.some((entry) => entry.path === "manifest.json"), "base must exclude plugin output");
    assert.ok(!preview.payload.affectedPaths.some((entry) => entry.path.startsWith(".agents/hooks/")), "disabled hooks excluded");
    const text = spawnSync(process.execPath, [CLI, "init", "sample", "--target-dir", target, "--registry", join(scratch, `registry-${language}.yaml`), "--skip-board", "--no-tui", "--dry-run", ...(language === "javascript" ? ["--obsidian-plugin"] : []), "--primary-language", language], { cwd: scratch, env: { ...env, PJ_PROJECT_REGISTRY: join(scratch, `registry-${language}.yaml`) }, encoding: "utf8", timeout: 180_000 });
    assert.equal(text.status, 0, text.stdout + text.stderr);
    for (const { path, type, operation } of preview.payload.affectedPaths) assert.ok(text.stdout.includes(`${operation} ${type} ${path}`), `${path} missing in text preview`);
    const applied = call(target, [...(language === "javascript" ? ["--obsidian-plugin"] : []), "--primary-language", language, "--apply", "--yes"]);
    assert.equal(applied.result.status, 0, JSON.stringify(applied.payload));
    assert.deepEqual(delta(before, tree(target)), preview.payload.affectedPaths, "apply delta must equal preview");
    console.log(`ok fresh ${language}: ${preview.payload.affectedPaths.length} paths match apply`);
    if (language === "python") {
      const stale = join(target, "GEMINI.md");
      unlinkSync(stale);
      const changedBefore = tree(target);
      const repairPreview = call(target, ["--dry-run"]);
      assert.equal(repairPreview.result.status, 0, JSON.stringify(repairPreview.payload));
      assert.ok(repairPreview.payload.affectedPaths.some((entry) => entry.path === "GEMINI.md" && entry.type === "symlink" && entry.operation === "create"));
      const repairApply = call(target, ["--apply", "--yes"]);
      assert.equal(repairApply.result.status, 0, JSON.stringify(repairApply.payload));
      assert.deepEqual(delta(changedBefore, tree(target)), repairPreview.payload.affectedPaths, "sync repair must match preview");
      console.log(`ok sync repair: ${repairPreview.payload.affectedPaths.length} paths match apply`);
    }
    const syncBefore = tree(target);
    const syncPreview = call(target, ["--dry-run"]);
    assert.equal(syncPreview.result.status, 0, JSON.stringify(syncPreview.payload));
    assert.equal(syncPreview.payload.mode, "sync");
    assert.ok(!syncPreview.payload.proposedOperations.includes("copier.copy.commonproject"));
    const syncApply = call(target, ["--apply", "--yes"]);
    assert.equal(syncApply.result.status, 0, JSON.stringify(syncApply.payload));
    assert.deepEqual(delta(syncBefore, tree(target)), syncPreview.payload.affectedPaths, "sync delta must equal preview");
    console.log(`ok sync ${language}: ${syncPreview.payload.affectedPaths.length} paths match apply`);
  }
  const unavailable = join(scratch, "unavailable", "sample");
  mkdirSync(join(scratch, "unavailable"));
  const failed = call(unavailable, ["--dry-run", "--force"], { PJ_BMAD_INSTALLER: join(scratch, "missing-installer") });
  assert.notEqual(failed.result.status, 0, "unsafe/incomplete inventory must fail");
  assert.match(failed.payload.error, /Incomplete init preview/);
  assert.equal(existsSync(unavailable), false);
  console.log("ok incomplete preview fails closed without target mutation");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
