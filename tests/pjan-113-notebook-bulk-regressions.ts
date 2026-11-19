import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emptyProjectRegistry, saveProjectRegistry } from "../src/project/index";
import { createNotebookChecks } from "../src/notebook/checks";
import { RecipeRegistry } from "../src/recipes/registry";
import type { LifecycleContext, LifecycleRecipe } from "../src/recipes/types";

const root = mkdtempSync(join(tmpdir(), "pjan-113-"));
try {
  const repo = join(root, "repo");
  const home = join(root, "home");
  const registry = join(root, "registry.yaml");
  mkdirSync(repo);
  mkdirSync(home);
  const state = emptyProjectRegistry();
  state.projects.fixture = {
    name: "Fixture", slug: "fixture", repo_path: repo, description: "fixture", status: "active", source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "FIXTURE", board_id: "", state: "planned" },
    agents: {}, notebook: { state: "planned", notebook_name: "Fixture" },
    created_at: "2026-08-19T00:00:00.000Z", updated_at: "2026-08-19T00:00:00.000Z",
  } as never;
  saveProjectRegistry(state, registry);
  const manifest = join(repo, ".project.json");
  const initial = { project_name: "Fixture", project_slug: "fixture", repo_path: repo, notebook: { binding: { state: "planned", notebook_name: "Stale" }, policy: { enabled: true } }, foreign: "keep" };
  writeFileSync(manifest, `${JSON.stringify(initial, null, 2)}\n`);
  const beforeRegistry = readFileSync(registry);
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(resolve(import.meta.dirname, ".."), "dist", "index.js"), ...args], {
    encoding: "utf8", cwd: repo, env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), TMPDIR: root, GIT_CEILING_DIRECTORIES: root },
  });
  const plan = cli("migrate", "--all", repo, "--registry", registry, "--dry-run", "--json");
  const planned = JSON.parse(plan.stdout);
  assert.equal(planned.results.find((item: any) => item.id === "notebook.binding")?.status, "applied", plan.stdout + plan.stderr);
  assert.deepEqual(readFileSync(manifest), Buffer.from(`${JSON.stringify(initial, null, 2)}\n`));
  assert.deepEqual(readFileSync(registry), beforeRegistry);

  // Other repo rules can legitimately block --all in this minimal fixture. The
  // notebook result must still repair and verify without claiming all passed.
  const applied = cli("migrate", "--all", repo, "--registry", registry, "--json");
  const report = JSON.parse(applied.stdout);
  assert.equal(report.results.find((item: any) => item.id === "notebook.binding")?.status, "applied", applied.stdout + applied.stderr);
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).notebook.binding.notebook_name, "Fixture");
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).foreign, "keep");
  assert.deepEqual(readFileSync(registry), beforeRegistry);
  const settled = readFileSync(manifest);
  const second = cli("migrate", "notebook.binding", repo, "--registry", registry, "--json");
  assert.equal(JSON.parse(second.stdout).results[0].status, "noop", second.stdout + second.stderr);
  assert.equal(second.status, 0);
  assert.deepEqual(readFileSync(manifest), settled);

  const checks = createNotebookChecks().filter((check) => ["notebook.skill-installed", "notebook.hooks-projected"].includes(check.id));
  let calls = 0;
  const fake: LifecycleRecipe = {
    metadata: { id: "notebook-host", name: "host", description: "host", dependencies: [], commands: [], publicRuleIds: checks.map((check) => check.id) },
    checks: checks.map((check) => ({ ...check, id: check.id, title: check.title, scope: check.scope,
      audit: async () => ({ id: check.id, title: check.title, status: "fail" as const, summary: "Observed host drift", details: ["host fixture"], fixable: true }),
      migrate: async () => { calls++; throw Error("host repair must never run"); },
    })),
    async init() { throw Error("not used"); },
    async audit(ctx) { return Promise.all(this.checks.map(async (check) => ({ ...await check.audit(ctx), scope: check.scope }))); },
    async migrate(ctx, ids) { return Promise.all(ids.map(async (id) => this.checks.find((check) => check.id === id)!.migrate(ctx, await this.checks.find((check) => check.id === id)!.audit(ctx)))); },
  };
  const context = { repoRoot: repo, targetDir: repo, homeDir: home, pjanglerRoot: root, dryRun: false, force: false } as LifecycleContext;
  const hostReport = await new RecipeRegistry([fake]).migrateAll(context);
  assert.equal(hostReport.ok, true);
  assert.equal(calls, 0);
  assert.deepEqual(hostReport.selectedRules, []);
  assert.deepEqual(hostReport.results.map((item) => [item.id, item.scope, item.status]), [
    ["notebook.skill-installed", "host", "skipped"], ["notebook.hooks-projected", "host", "skipped"],
  ]);
  const projectFailure: LifecycleRecipe = {
    ...fake,
    metadata: { ...fake.metadata, id: "project-failure", publicRuleIds: ["project.failure"] },
    checks: [{ id: "project.failure", title: "Project failure", audit: () => ({ id: "project.failure", title: "Project failure", status: "fail", summary: "Genuine repo defect", details: [], fixable: false }), migrate: () => { throw Error("manual rule must not migrate"); } }],
    async audit() { return [{ id: "project.failure", title: "Project failure", status: "fail", summary: "Genuine repo defect", details: [], fixable: false }]; },
  };
  const mixed = await new RecipeRegistry([fake, projectFailure]).migrateAll(context);
  assert.equal(mixed.ok, false, "host isolation must not hide a project failure");
  assert.equal(mixed.results.find((item) => item.id === "project.failure")?.status, "blocked");
  assert.equal(calls, 0);
  console.log("PJAN-113 CLI dry-run/apply/idempotence and registry host isolation passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
