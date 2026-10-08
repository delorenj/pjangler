import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRecipe, type ProjectRecipeRuntime } from "../src/recipes/ProjectRecipe";
import { BmadRecipe } from "../src/recipes/BmadRecipe";
import { RecipeRegistry } from "../src/recipes/registry";
import { NotebookRecipe } from "../src/recipes/NotebookRecipe";
import { snapshotTree } from "../src/utils/tree-diff";
import type { ProjectInitPlan } from "../src/project/index";

// The actual ProjectRecipe/BmadRecipe transaction topology, with filesystem-only
// external boundaries and unrelated checks removed. No live provider/registry or
// canonical owner delivery is certified by this test.
const root = resolve(import.meta.dirname, "..");
const { createBmadInstallerFixture } = await import(join(root, "tests", "helpers", "pack-fixture.mjs"));
const scratch = mkdtempSync(join(tmpdir(), "pjan-167-enrollment-"));
const home = join(scratch, "home");
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
process.env.HOME = home;
process.env.PJ_BMAD_INSTALLER = createBmadInstallerFixture(scratch);
process.env.PJ_PROJECT_REGISTRY = join(scratch, "registry.yaml");
process.env.PJ_SKILLS_REGISTRY_ROOT = join(scratch, "catalog");
process.env.PJ_G33_ADAPTER_MODULE = "";
process.env.PJ_G33_ADAPTER_EXPORT = "";
for (const name of ["all-skills", "sets", "packs"]) mkdirSync(join(scratch, "catalog", name), { recursive: true });
put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}');
put(join(home, ".cache", "pjangler", "bmad-dist-tags.json"), JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.12.0", next: "6.12.0" } }));
const adapter = join(scratch, "adapter.mjs");
put(adapter, `import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs'; import {join} from 'node:path';
export function companion(req) {
  const path=join(req.projectRoot,'_bmad','g33','companion.md'); const valid=existsSync(path);
  const result=(status)=>({schemaVersion:1,status,summary:status,details:[],evidence:valid?['actual fixture content checked']:[]});
  if(req.options.unavailable)return result('unavailable');
  if(req.operation==='observe')return result(valid?'installed':'missing');
  if(req.operation==='plan')return result(valid?'unchanged':'planned');
  mkdirSync(join(req.projectRoot,'_bmad','g33'),{recursive:true}); writeFileSync(path,'enrollment fixture');
  const count=join(req.projectRoot,'_bmad','g33','apply-count');
  writeFileSync(count,String((existsSync(count)?Number(readFileSync(count,'utf8')):0)+1));
  if(req.options.partial)throw new Error('optional apply failed after writing content');
  return result('changed');
}`);
const outcome = (id: string) => ({ recipeId: id, ok: true, dryRun: false, changedFiles: [], logs: [], errors: [], phases: [] });
const noop = (id: string, dependencies: string[] = []) => ({ metadata: { id, name: id, description: "isolated topology", dependencies, commands: [], publicRuleIds: [] }, checks: [],
  init: async () => outcome(id), audit: async () => [], migrate: async () => [] });

try {
  for (const scenario of ["available", "unavailable", "optout", "ordinary", "partial", "provider-failure", "finalizer-failure", "optin-partial", "unconfirmed"]) {
    const target = join(scratch, scenario);
    const companionPath = join(target, "_bmad", "g33", "companion.md");
    const binding = { type: "plane", workspace: scenario === "ordinary" ? "another-workspace" : "33god", identifier: "PROB", identifier_source: "provider", board_id: "", state: "planned" };
    const manifest = { project_id: `enrollment-${scenario}`, project_name: scenario, project_description: "topology fixture", repo_path: target, agents: {}, ticket_provider: binding,
      bmad: { companion: { ...(scenario === "optout" ? { enabled: false } : scenario === "optin-partial" ? {enabled:true} : {}), adapter: { module: adapter, exportName: "companion", options: { unavailable: scenario === "unavailable", partial: ["partial","optin-partial"].includes(scenario) } } } } };
    const project = { name: scenario, project_id: manifest.project_id, slug: manifest.project_id, repo_path: target, description: "topology fixture", ticket_provider: binding, agents: {},
      template: { commonproject: { enabled: true, primary_language: "typescript" } }, status: "active", source_artifacts: [], created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z" };
    const registryPath = join(scratch, `${scenario}-registry.json`);
    const plan = { ok: true, apply: true, dryRun: false, live: false, registryPath, project, manifest, actions: [
      { kind: "project.write-manifest", path: join(target, ".project.json"), manifest },
      { kind: "ticket-provider.create-or-link", enabled: true, live: false, provider: "plane", workspace: binding.workspace, identifier: "PROB", repoPath: target, boardName: scenario, description: "topology fixture", boardId: "", state: "planned" },
      { kind: "registry.upsert", registryPath, slug: manifest.project_id, project },
    ] } as unknown as ProjectInitPlan;
    let finalSnapshot: ReturnType<typeof snapshotTree> | undefined;
    let linkedAtFinalizer = false;
    let companionAtFinalizer = false;
    let finalizerCount = 0;
    const runtime: ProjectRecipeRuntime = {
      preflightBmad: () => ({ ok: true, details: [] }),
      runGit: () => ({ status: 0, stdout: "", stderr: "" }), // known repository; no real Git mutation
      executePlan: async (selected) => {
        const changedFiles: string[] = [];
        for (const action of selected.actions) {
          if (action.kind === "project.write-manifest") {
            put(action.path, JSON.stringify(manifest));
            mkdirSync(join(target, ".git"), { recursive: true });
            put(join(target, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}');
            put(join(target, ".agents", "skills", "bmad-fixture", "SKILL.md"), "Native BMAD topology fixture");
            changedFiles.push(action.path);
          } else if (action.kind === "ticket-provider.create-or-link") {
            assert.equal(existsSync(companionPath), scenario === "optin-partial", "only explicit opt-in can apply before external enrollment");
            assert.ok(existsSync(join(target, "_bmad", "_config", "manifest.yaml")), "actual BmadRecipe dependency installed required BMAD first");
            if (scenario === "provider-failure") return { ok: false, plan: selected, logs: [], errors: ["filesystem provider dispatch failure"], changedFiles: [] };
            Object.assign(binding, { board_id: "fixture-board", state: "linked", board_confirmed_at: "2026-10-04T00:00:00Z" });
            if (scenario === "unconfirmed") delete (binding as Record<string, unknown>).board_confirmed_at;
            project.ticket_provider = binding;
            put(join(target, ".project.json"), JSON.stringify(manifest)); changedFiles.push(join(target, ".project.json"));
          } else if (action.kind === "registry.upsert") {
            finalizerCount++;
            linkedAtFinalizer = action.project.ticket_provider.state === "linked";
            companionAtFinalizer = existsSync(companionPath);
            put(registryPath, JSON.stringify(action.project)); changedFiles.push(registryPath);
            finalSnapshot = snapshotTree(target);
            if (scenario === "finalizer-failure") return { ok: false, plan: selected, logs: [], errors: ["filesystem registry finalization failure"], changedFiles };
          }
        }
        return { ok: true, plan: selected, logs: [], errors: [], changedFiles };
      },
    };
    class LocalProject extends ProjectRecipe { override readonly checks = []; override readonly metadata = { ...new ProjectRecipe(runtime).metadata, publicRuleIds: [] }; }
    const notebook = new NotebookRecipe();
    notebook.init = async () => ({ ...outcome("notebook"), notebookPlan: { remote_effect: "none", reason: "isolated notebook fixture" } });
    notebook.applyLocal = async () => outcome("notebook");
    notebook.audit = async () => [];
    const registry = new RecipeRegistry([noop("mise"), noop("agent-hooks", ["mise"]), new BmadRecipe(), notebook, new LocalProject(runtime)]);
    const result = await registry.initRecipe("project", { targetDir: target, repoRoot: target, pjanglerRoot: root, homeDir: home, dryRun: false, force: false }, { plan, mode: "create" });
    const successful = !["provider-failure", "finalizer-failure"].includes(scenario);
    assert.equal(result.ok, successful, JSON.stringify(result.errors));
    assert.equal(finalizerCount, 1, "finalizer remains once, including external recovery/failure");
    assert.deepEqual(snapshotTree(target), finalSnapshot, "finalizer is followed by read-only audits only");
    assert.equal(existsSync(target), true, "external dispatch/finalizer latch prevents rollback deleting recovery");
    const phase = result.phases.find((entry) => entry.id === "project.optional:g33-companion");
    if(scenario === "optin-partial") {
      assert.equal(phase,undefined,"an explicit opt-in owner error must not be retried after linking");
      assert.equal(companionAtFinalizer,true);
      assert.equal(readFileSync(join(target,"_bmad","g33","apply-count"),"utf8"),"1");
      assert.ok(result.logs.some(entry=>entry.includes("g33 (error)")));
    } else if (["provider-failure", "unconfirmed"].includes(scenario)) {
      assert.equal(phase, undefined); assert.equal(linkedAtFinalizer, false); assert.equal(companionAtFinalizer, false);
    } else {
      assert.ok(phase); assert.equal(linkedAtFinalizer, true);
      const expected = scenario === "unavailable" ? "unavailable" : ["optout", "ordinary"].includes(scenario) ? "disabled" : scenario === "partial" ? "error" : "changed";
      assert.equal((result.bmadCompanion as { status: string }).status, expected);
      assert.equal(companionAtFinalizer, ["available", "partial", "finalizer-failure"].includes(scenario));
      assert.ok(result.phases.indexOf(phase) < result.phases.findIndex((entry) => entry.id === "project.registry:finalizer"));
      if (scenario === "partial") assert.ok(result.changedFiles.includes(companionPath), "optional partial writes retained without failing required fresh init");
    }
    console.log(`PASS ProjectRecipe enrollment topology ${scenario}`);
  }
  console.log("PJAN-167 ProjectRecipe topology: 9 cases passed; live provider/registry and owner API remain unverified.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
