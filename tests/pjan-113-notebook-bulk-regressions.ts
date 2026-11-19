import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emptyProjectRegistry, saveProjectRegistry } from "../src/project/index";
import { createNotebookChecks } from "../src/notebook/checks";
import { prepareRemoteMutation, transitionRemoteMutation, listRemoteMutationJournals } from "../src/notebook/remote-mutation-journal";
import { notebookStateRoot, ensureNotebookState } from "../src/notebook/state";
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
    encoding: "utf8", cwd: repo, env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, ".local", "state"), XDG_DATA_HOME: join(root, "data"), TMPDIR: root, GIT_CEILING_DIRECTORIES: root },
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

  const hostPaths = [join(home, ".agents"), join(home, ".claude")];
  for (const dryRun of [true, false]) {
    const observedHost = cli("migrate", "--all", repo, "--registry", registry, ...(dryRun ? ["--dry-run"] : []), "--json");
    const observedReport = JSON.parse(observedHost.stdout);
    assert.deepEqual(observedReport.results.filter((item: any) => item.scope === "host").map((item: any) => [item.id, item.status]), [
      ["notebook.skill-installed", "skipped"], ["notebook.hooks-projected", "skipped"],
    ], observedHost.stdout + observedHost.stderr);
    assert.ok(observedReport.results.filter((item: any) => item.scope === "host").every((item: any) => item.details.some((line: string) => line.includes("pj notebook migrate --apply"))));
    assert.ok(hostPaths.every((path) => !existsSync(path)), "bulk must not write HOME");
  }
  const foreignSkill = join(home, ".agents", "skills", "project-notebook");
  mkdirSync(foreignSkill, { recursive: true });
  writeFileSync(join(foreignSkill, "foreign.txt"), "leave untouched");
  const foreign = cli("migrate", "--all", repo, "--registry", registry, "--dry-run", "--json");
  const foreignReport = JSON.parse(foreign.stdout);
  assert.deepEqual(foreignReport.results.filter((item: any) => item.scope === "host").map((item: any) => [item.id, item.status]), [
    ["notebook.skill-installed", "skipped"], ["notebook.hooks-projected", "skipped"],
  ], foreign.stdout + foreign.stderr);
  assert.ok(foreignReport.results.filter((item: any) => item.scope === "host").every((item: any) => item.summary.includes("owned outside")));
  assert.equal(readFileSync(join(foreignSkill, "foreign.txt"), "utf8"), "leave untouched");
  rmSync(join(home, ".agents"), { recursive: true });

  const stateRoot = notebookStateRoot({ HOME: home });
  const journal = prepareRemoteMutation({ root: stateRoot, projectSlug: "fixture", kind: "notebook.create", logicalMarker: "pjangler.project.v1:fixture", inputDigest: "f".repeat(64) });
  const journalPath = join(ensureNotebookState(stateRoot, "fixture").journals, `${journal.operation_id}.json`);
  const journalBytes = readFileSync(journalPath);
  for (const dryRun of [true, false]) {
    const run = cli("migrate", "--all", repo, "--registry", registry, ...(dryRun ? ["--dry-run"] : []), "--json");
    const migration = JSON.parse(run.stdout);
    const remote = migration.results.find((item: any) => item.id === "notebook.remote-notebook");
    assert.equal(remote?.status, "blocked", run.stdout + run.stderr);
    assert.ok(remote.details.some((line: string) => line.includes("--apply --live")));
    assert.ok(!migration.selectedRules.includes("notebook.remote-notebook"));
    assert.deepEqual(readFileSync(journalPath), journalBytes, "bulk must not consume a prepared remote journal");
  }

  const notebookCheck = createNotebookChecks().find((check) => check.id === "notebook.remote-notebook")!;
  const focused = { repoRoot: repo, targetDir: repo, homeDir: home, pjanglerRoot: resolve(import.meta.dirname, ".."), registryPath: registry, notebookStateRoot: stateRoot, dryRun: true, force: false } as LifecycleContext;
  assert.equal((await notebookCheck.audit(focused)).fixable, true, "focused migration retains remote journal selection");
  const observedDrift = await notebookCheck.audit({ ...focused, notebookStateRoot: join(root, "remote-observed"), notebookBulkMigration: true, notebookObservation: {
    schema_version: 1, fetched_at: new Date().toISOString(), project_slug: "fixture", binding_used: { state: "planned" },
    remote_check: "fail", health: "drifted", auth_mode: "none", base_url_configured: true,
    notebook_check: { status: "fail", drift: [{ path: "notebook.marker", reason: "mismatch" }] },
    notebook: null, scoped_notes: [], overview: null, error: null,
  } as LifecycleContext["notebookObservation"] });
  assert.equal(observedDrift.fixable, false, "observed remote drift is never selected for bulk migration");
  assert.ok(observedDrift.details.some((line) => line.includes("--apply --live")));
  const focusedDrift = await notebookCheck.audit({ ...focused, notebookStateRoot: join(root, "remote-observed"), notebookObservation: {
    schema_version: 1, fetched_at: new Date().toISOString(), project_slug: "fixture", binding_used: { state: "planned" },
    remote_check: "fail", health: "drifted", auth_mode: "none", base_url_configured: true,
    notebook_check: { status: "fail", drift: [{ path: "notebook.marker", reason: "mismatch" }] },
    notebook: null, scoped_notes: [], overview: null, error: null,
  } as LifecycleContext["notebookObservation"] });
  assert.equal(focusedDrift.fixable, true);
  transitionRemoteMutation({ root: stateRoot, journal, state: "reconciled", candidateIds: ["nb-reconciled"] });
  assert.equal(listRemoteMutationJournals(stateRoot, "fixture")[0]?.state, "reconciled");
  const damaged = join(ensureNotebookState(stateRoot, "fixture").journals, `${journal.operation_id}.json`);
  writeFileSync(damaged, "{broken");
  const corruptBefore = readFileSync(damaged);
  const corrupt = cli("migrate", "--all", repo, "--registry", registry, "--json");
  const corruptReport = JSON.parse(corrupt.stdout);
  const integrity = corruptReport.results.find((item: any) => item.id === "notebook.capture-receipts");
  assert.equal(integrity?.status, "blocked", corrupt.stdout + corrupt.stderr);
  assert.ok(integrity.details.some((line: string) => line.includes("trusted backup")));
  assert.deepEqual(readFileSync(damaged), corruptBefore);
  assert.equal(corruptReport.ok, false);

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
