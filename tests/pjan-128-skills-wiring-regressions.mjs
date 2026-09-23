// Exercise the real --all dispatcher with only the two owners involved in the
// incident. Other lifecycle owners must not install BMAD or provision a board.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, `.pjan-128-${process.pid}.mjs`);
buildSync({ stdin: { contents: 'export { RecipeRegistry } from "./src/recipes/registry"; export { createMiseChecks, createAgentHooksChecks } from "./src/parity/rules";', resolveDir: root }, outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm" });
const { RecipeRegistry, createMiseChecks, createAgentHooksChecks } = await import(pathToFileURL(bundle).href);
rmSync(bundle);
const mise = createMiseChecks().find((check) => check.id === "mise.config-root");
const skills = createAgentHooksChecks().find((check) => check.id === "skills.project-manifest");
const recipe = (check) => ({
  metadata: { id: check.id, name: check.title, description: "Regression fixture", dependencies: [], commands: [], publicRuleIds: [check.id] },
  checks: [check],
  audit: async (ctx) => [await check.audit(ctx)],
  migrate: async (ctx) => [await check.migrate(ctx, await check.audit(ctx))],
});
const registry = new RecipeRegistry([recipe(mise), recipe(skills)]);
function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function snapshot(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).sort().map((name) => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, stat.ino, stat.mode, stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? snapshot(path) : readFileSync(path).toString("base64")];
  });
}
async function fixture() {
  const base = mkdtempSync("/tmp/pjan-128-"), project = join(base, "project"), home = join(base, "home"), catalog = join(base, "registry");
  for (const path of [project, home, join(catalog, "all-skills"), join(catalog, "sets"), join(catalog, "packs")]) mkdirSync(path, { recursive: true });
  put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(project, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  const previousRegistry = process.env.PJ_SKILLS_REGISTRY_ROOT;
  process.env.PJ_SKILLS_REGISTRY_ROOT = catalog;
  const ctx = { repoRoot: project, targetDir: project, homeDir: home, pjanglerRoot: root, dryRun: false, force: false };
  // Establish every unrelated mise requirement before introducing the defect.
  await mise.migrate(ctx, await mise.audit(ctx));
  assert.equal((await mise.audit(ctx)).status, "pass");
  const addDeadWiring = () => {
    const path = join(project, "mise.toml");
    put(path, readFileSync(path, "utf8") + '\n[[hooks.enter]]\nscript = "python3 \'{{config_root}}/.mise/scripts/provision-packs.py\' --root \'{{config_root}}\'"\n[[hooks.enter]]\nscript = "python3 \'{{config_root}}/.mise/scripts/sync-skills.py\' --scope project --root \'{{config_root}}\'"\n[[hooks.leave]]\nscript = "echo keep-custom-hook"\n[[watch_files]]\npatterns = [".agents/skills.json"]\ntask = "skills:sync"\n[tasks."skills:provision:packs"]\nrun = "python3 .mise/scripts/provision-packs.py"\n');
  };
  return { base, project, ctx, addDeadWiring, close() { if (previousRegistry === undefined) delete process.env.PJ_SKILLS_REGISTRY_ROOT; else process.env.PJ_SKILLS_REGISTRY_ROOT = previousRegistry; rmSync(base, { recursive: true, force: true }); } };
}

test("missing project manifest uses the public diagnostic and is selected by --all", async () => {
  const f = await fixture(); try {
    const finding = await skills.audit(f.ctx);
    assert.match(finding.details.join("\n"), /E_NO_PROJECT_MANIFEST/);
    assert.equal(finding.fixable, true);
    const report = await registry.migrateAll(f.ctx);
    assert.ok(report.selectedRules.includes(skills.id));
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal((await skills.audit(f.ctx)).status, "pass");
    const before = snapshot(f.base);
    assert.deepEqual((await registry.migrateAll(f.ctx)).changedFiles, []);
    assert.deepEqual(snapshot(f.base), before);
  } finally { f.close(); }
});

for (const declaration of [null, '{ "inherit_global": false, "skills": [] }\n', '{"skills":']) {
  test(`--all repairs dead hooks independently of blocked skill adoption (${declaration === null ? "missing" : declaration.endsWith(":") ? "malformed" : "existing"} manifest)`, async () => {
    const f = await fixture(); try {
      const manifest = join(f.project, ".agents", "skills.json");
      if (declaration !== null) put(manifest, declaration);
      put(join(f.project, ".agents", "skills", "bmad-native", "SKILL.md"), "Installer owned\n");
      put(join(f.project, ".claude", "skills", "bmad-native", "SKILL.md"), "Foreign CLI root\n");
      f.addDeadWiring();
      const foreign = snapshot(join(f.project, ".claude"));
      const native = snapshot(join(f.project, ".agents", "skills"));
      const finding = await mise.audit(f.ctx);
      assert.equal(finding.status, "fail");
      assert.equal(finding.fixable, true);
      assert.match(finding.details.join("\n"), /Skill sync must not run from enter\/leave hooks/);
      const before = snapshot(f.base);
      const preview = await registry.migrateAll({ ...f.ctx, dryRun: true });
      assert.ok(preview.selectedRules.includes(mise.id));
      assert.ok(preview.changedFiles.includes(join(f.project, "mise.toml")));
      assert.deepEqual(snapshot(f.base), before, "dry-run must not mutate any fixture state");
      const report = await registry.migrateAll(f.ctx);
      assert.equal(report.ok, false, "blocked adoption must remain visible");
      assert.ok(report.selectedRules.includes(mise.id));
      assert.equal(report.results.find((item) => item.id === mise.id).status, "applied", JSON.stringify(report));
      assert.ok(["blocked", "partial"].includes(report.results.find((item) => item.id === skills.id).status));
      assert.equal((await mise.audit(f.ctx)).status, "pass");
      const text = readFileSync(join(f.project, "mise.toml"), "utf8");
      assert.doesNotMatch(text, /provision-packs\.py|sync-skills\.py|patterns = \["\.agents\/skills\.json"\]/);
      assert.match(text, /echo keep-custom-hook/);
      assert.match(text, /skillex sync --scope project --project '\{\{config_root\}\}'/);
      assert.deepEqual(snapshot(join(f.project, ".claude")), foreign);
      assert.deepEqual(snapshot(join(f.project, ".agents", "skills")), native);
      if (declaration === null) {
        // Public init remains manifest-only: a subsequent activation refusal
        // reports that write as partial, without claiming adoption succeeded.
        assert.equal(JSON.parse(readFileSync(manifest, "utf8")).inherit_global, true);
        assert.equal(report.results.find((item) => item.id === skills.id).status, "partial");
        assert.ok(report.changedFiles.includes(manifest));
      } else {
        assert.equal(readFileSync(manifest, "utf8"), declaration);
      }
      const repaired = snapshot(f.base);
      const repeat = await registry.migrateAll(f.ctx);
      assert.equal(repeat.ok, false);
      assert.deepEqual(repeat.changedFiles, []);
      assert.deepEqual(snapshot(f.base), repaired);
    } finally { f.close(); }
  });
}

// PJAN-135: the blocked case above differs in content, so it stays blocked. A
// real .claude/skills that only duplicates .agents/skills is converted by the
// same --all run, and the dead wiring is repaired alongside it.
test("--all converts a lossless real .claude/skills and repairs dead hooks in one run", async () => {
  const f = await fixture(); try {
    put(join(f.project, ".agents", "skills.json"), '{ "inherit_global": false, "skills": [] }\n');
    put(join(f.project, ".agents", "skills", "bmad-native", "SKILL.md"), "Installer owned\n");
    put(join(f.project, ".claude", "skills", "bmad-native", "SKILL.md"), "Installer owned\n");
    put(join(f.project, ".claude", "skills", "bmad-claude-only", "SKILL.md"), "Installer owned (claude-code)\n");
    const inode = lstatSync(join(f.project, ".claude", "skills", "bmad-claude-only")).ino;
    f.addDeadWiring();
    const report = await registry.migrateAll(f.ctx);
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.results.find((item) => item.id === skills.id).status, "applied");
    assert.equal(readlinkSync(join(f.project, ".claude", "skills")), "../.agents/skills");
    assert.equal(lstatSync(join(f.project, ".agents", "skills", "bmad-claude-only")).ino, inode);
    assert.equal(readFileSync(join(f.project, ".agents", "skills", "bmad-native", "SKILL.md"), "utf8"), "Installer owned\n");
    assert.equal((await skills.audit(f.ctx)).status, "pass");
    assert.doesNotMatch(readFileSync(join(f.project, "mise.toml"), "utf8"), /provision-packs\.py|sync-skills\.py/);
    const settled = snapshot(f.base);
    assert.deepEqual((await registry.migrateAll(f.ctx)).changedFiles, []);
    assert.deepEqual(snapshot(f.base), settled);
  } finally { f.close(); }
});
