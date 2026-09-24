// PJAN-145: a repository can waive a parity rule in .project.json.
//
// cal.diy is a fork of cal.com, whose upstream ships `.claude/skills ->
// ../agents/skills`. skills.project-manifest and bmad.cli-roots can never pass
// there without rewriting upstream's tracked layout, which conflicts on every
// upstream merge. `"parity": { "waive": { "<ruleId>": "<reason>" } }` turns such
// a rule into a skip that carries its reason and keeps the underlying finding
// in details; migrate never touches it. The registry here is the real
// RecipeRegistry; the checks are real objects over a real temp directory.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, "node_modules", ".cache", `pjan-145-${process.pid}.mjs`);
buildSync({
  stdin: { contents: 'export { RecipeRegistry, projectWaivers } from "./src/recipes/registry";', resolveDir: root },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const { RecipeRegistry, projectWaivers } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

function check(id, status, migrations) {
  return {
    id, title: id,
    audit: () => ({ id, title: id, status, summary: `${id} is ${status}`, details: [`${id} detail`], fixable: true, scope: "project" }),
    migrate: (_ctx, finding) => { migrations.push(id); return { id: finding.id, title: id, status: "applied", summary: "migrated", changedFiles: [], details: [] }; },
  };
}
const recipe = (c) => ({
  metadata: { id: c.id, name: c.title, description: "PJAN-145 regression", dependencies: [], commands: [], publicRuleIds: [c.id] },
  checks: [c],
  audit: async (ctx) => [await c.audit(ctx)],
  migrate: async (ctx) => [await c.migrate(ctx, await c.audit(ctx))],
});

function repo(projectJson) {
  const dir = realpathSync(mkdtempSync("/tmp/pjan-145-"));
  if (projectJson !== undefined) writeFileSync(join(dir, ".project.json"), typeof projectJson === "string" ? projectJson : JSON.stringify(projectJson));
  return { dir, ctx: { repoRoot: dir, targetDir: dir, homeDir: dir, pjanglerRoot: root, dryRun: false, force: false }, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a waived failing rule audits as skip with its reason, keeps the underlying finding, and does not gate ok", async () => {
  const r = repo({ project_name: "fork", parity: { waive: { "fixture.upstream-layout": "upstream owns .claude/skills" } } });
  try {
    const migrations = [];
    const registry = new RecipeRegistry([recipe(check("fixture.upstream-layout", "fail", migrations)), recipe(check("fixture.other", "pass", migrations))]);
    const report = await registry.auditRecipes(r.ctx);
    const finding = report.rules.find((rule) => rule.id === "fixture.upstream-layout");
    assert.equal(finding.status, "skip");
    assert.equal(finding.fixable, false);
    assert.equal(finding.summary, "Waived in .project.json: upstream owns .claude/skills");
    assert.deepEqual(finding.details, ["underlying fail: fixture.upstream-layout is fail", "fixture.upstream-layout detail"]);
    assert.equal(report.ok, true);
    const migrated = await registry.migrateAll(r.ctx);
    assert.deepEqual(migrations, [], "migrate never touches a waived rule");
    assert.equal(migrated.ok, true);
  } finally { r.close(); }
});

test("a waiver without a real reason waives nothing", async () => {
  for (const waive of [{ "fixture.upstream-layout": "" }, { "fixture.upstream-layout": "   " }, { "fixture.upstream-layout": true }, ["fixture.upstream-layout"]]) {
    const r = repo({ parity: { waive } });
    try {
      const registry = new RecipeRegistry([recipe(check("fixture.upstream-layout", "fail", []))]);
      const report = await registry.auditRecipes(r.ctx);
      assert.equal(report.rules[0].status, "fail", JSON.stringify(waive));
      assert.equal(report.ok, false);
    } finally { r.close(); }
  }
});

test("a waiver on a passing rule is reported as removable, not hidden", async () => {
  const r = repo({ parity: { waive: { "fixture.upstream-layout": "upstream owns it" } } });
  try {
    const registry = new RecipeRegistry([recipe(check("fixture.upstream-layout", "pass", []))]);
    const [finding] = (await registry.auditRecipes(r.ctx)).rules;
    assert.equal(finding.status, "pass");
    assert.match(finding.details.at(-1), /waived in \.project\.json \(upstream owns it\) but currently passes; the waiver can be removed/);
  } finally { r.close(); }
});

test("no .project.json, invalid JSON, or no parity block: no waivers", () => {
  for (const content of [undefined, "{ not json", { project_name: "x" }, { parity: {} }, { parity: { waive: null } }]) {
    const r = repo(content);
    try { assert.equal(projectWaivers(r.dir).size, 0, JSON.stringify(content)); } finally { r.close(); }
  }
});
