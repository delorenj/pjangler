import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProjectRecipe, type ProjectRecipeRuntime } from "../src/recipes/ProjectRecipe";
import { BmadRecipe } from "../src/recipes/BmadRecipe";
import { RecipeRegistry } from "../src/recipes/registry";
import { NotebookRecipe } from "../src/recipes/NotebookRecipe";
import { snapshotTree } from "../src/utils/tree-diff";
import { enrollG33Companion, G33_BRIDGE_ADAPTER, G33_SKILL } from "../src/bmad/companion";
import type { ProjectInitPlan } from "../src/project/index";

// PJAN-177: a fresh, linked 33god project is enrolled in the g33 companion (skill
// activated, adapter block written) before the companion runs. The real
// ProjectRecipe/BmadRecipe topology and the REAL bundled skillex core run over a
// scratch catalog; only the board/registry/BMAD-installer boundaries are
// filesystem stand-ins. The catalog carries a bridge implementing the v1
// observe/plan/apply contract against real files, because CI has no ~/code/skillex.
const root = resolve(import.meta.dirname, "..");
const { createBmadInstallerFixture } = await import(join(root, "tests", "helpers", "pack-fixture.mjs"));
const scratch = realpathSync(mkdtempSync("/tmp/pjan-177-enrollment-"));
const home = join(scratch, "home");
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
// Skillex refuses receipts under any ancestor holding a .git, and TMPDIR can sit inside a repo: scratch in /tmp.
process.env.GIT_CEILING_DIRECTORIES = "/tmp";
process.env.HOME = home;
process.env.XDG_STATE_HOME = join(scratch, "state");
process.env.PJ_BMAD_INSTALLER = createBmadInstallerFixture(scratch);
process.env.PJ_PROJECT_REGISTRY = join(scratch, "registry.yaml");
process.env.PJ_G33_ADAPTER_MODULE = "";
process.env.PJ_G33_ADAPTER_EXPORT = "";
put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}');
put(join(home, ".cache", "pjangler", "bmad-dist-tags.json"), JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.12.0", next: "6.12.0" } }));

const BRIDGE = `import {existsSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs'; import {dirname,join,resolve} from 'node:path'; import {fileURLToPath} from 'node:url';
const moduleRoot=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const result=(status,summary,evidence=[])=>({schemaVersion:1,status,summary,details:[],evidence});
export function g33Companion(req){
  let active=false; try{active=realpathSync(join(req.projectRoot,'.agents','skills','${G33_SKILL}'))===moduleRoot;}catch{}
  const file=join(req.projectRoot,'_bmad','g33','companion.md'); const valid=existsSync(file);
  if(req.operation==='observe'){
    if(!active)return result('missing','g33 skill is not activated in this project');
    return valid?result('installed','installed',['activation resolves to '+moduleRoot,'companion.md present']):result('missing','companion content absent');
  }
  if(req.operation==='plan')return result(valid?'unchanged':'planned',valid?'converged':'would write companion.md');
  mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,'bridge fixture'); return result('changed','written');
}`;
function catalog(kind: "full" | "empty" | "nobridge"): string {
  const withSkill = kind !== "empty";
  const dir = join(scratch, `catalog-${kind}`);
  for (const name of ["all-skills", "sets", "packs"]) mkdirSync(join(dir, name), { recursive: true });
  if (withSkill) {
    put(join(dir, "all-skills", G33_SKILL, "SKILL.md"), `---\nname: ${G33_SKILL}\ndescription: Scratch g33 fixture\n---\n# g33\n`);
    if (kind === "full") put(join(dir, "all-skills", G33_SKILL, "scripts", "g33_pjangler_bridge.mjs"), BRIDGE);
  }
  return dir;
}
const preconfigured = join(scratch, "custom-adapter.mjs");
put(preconfigured, `import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
export function custom(req){ const result=(status)=>({schemaVersion:1,status,summary:status,details:[],evidence:['custom']});
  const file=join(req.projectRoot,'_bmad','g33','custom.md');
  if(req.operation==='observe')return result(globalThis.__x?'installed':'missing');
  if(req.operation==='plan')return result('planned');
  mkdirSync(join(req.projectRoot,'_bmad','g33'),{recursive:true}); writeFileSync(file,'custom'); globalThis.__x=true; return result('changed'); }`);

const outcome = (id: string) => ({ recipeId: id, ok: true, dryRun: false, changedFiles: [], logs: [], errors: [], phases: [] });
const noop = (id: string, dependencies: string[] = []) => ({ metadata: { id, name: id, description: "isolated topology", dependencies, commands: [], publicRuleIds: [] }, checks: [],
  init: async () => outcome(id), audit: async () => [], migrate: async () => [] });
const linkPath = (target: string) => join(target, ".agents", "skills", G33_SKILL);

type Scenario = { name: string; workspace?: string; companion?: Record<string, unknown>; catalog?: "full" | "empty" | "nobridge" };
async function topology(scenario: Scenario) {
  process.env.PJ_SKILLS_REGISTRY_ROOT = catalog(scenario.catalog ?? "full");
  const target = join(scratch, scenario.name);
  const binding = { type: "plane", workspace: scenario.workspace ?? "33god", identifier: "PROB", identifier_source: "provider", board_id: "", state: "planned" };
  const manifest: Record<string, unknown> = { project_id: `enrollment-${scenario.name}`, project_name: scenario.name, project_description: "topology fixture", repo_path: target, agents: {},
    ticket_provider: binding, custom_key: { keep: ["me"] }, ...(scenario.companion ? { bmad: { companion: scenario.companion } } : {}) };
  const project = { name: scenario.name, project_id: manifest.project_id, slug: manifest.project_id, repo_path: target, description: "topology fixture", ticket_provider: binding, agents: {},
    template: { commonproject: { enabled: true, primary_language: "typescript" } }, status: "active", source_artifacts: [], created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z" };
  const registryPath = join(scratch, `${scenario.name}-registry.json`);
  const plan = { ok: true, apply: true, dryRun: false, live: false, registryPath, project, manifest, actions: [
    { kind: "project.write-manifest", path: join(target, ".project.json"), manifest },
    { kind: "ticket-provider.create-or-link", enabled: true, live: false, provider: "plane", workspace: binding.workspace, identifier: "PROB", repoPath: target, boardName: scenario.name, description: "topology fixture", boardId: "", state: "planned" },
    { kind: "registry.upsert", registryPath, slug: manifest.project_id, project },
  ] } as unknown as ProjectInitPlan;
  let linkAtFinalizer = false;
  const runtime: ProjectRecipeRuntime = {
    preflightBmad: () => ({ ok: true, details: [] }),
    runGit: () => ({ status: 0, stdout: "", stderr: "" }),
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
          assert.equal(existsSync(linkPath(target)), false, "nothing is enrolled while the board is only planned");
          Object.assign(binding, { board_id: "fixture-board", state: "linked", board_confirmed_at: "2026-10-04T00:00:00Z" });
          project.ticket_provider = binding;
          put(join(target, ".project.json"), JSON.stringify(manifest)); changedFiles.push(join(target, ".project.json"));
        } else if (action.kind === "registry.upsert") {
          linkAtFinalizer = existsSync(linkPath(target));
          put(registryPath, JSON.stringify(action.project)); changedFiles.push(registryPath);
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
  const manifestText = readFileSync(join(target, ".project.json"), "utf8");
  return {
    result, target, manifestText, parsed: JSON.parse(manifestText) as Record<string, any>, linkAtFinalizer,
    enrollment: result.phases.find((entry) => entry.id === "project.optional:g33-enrollment"),
    companion: result.bmadCompanion as { status: string; summary: string } | undefined,
    skills: JSON.parse(readFileSync(join(target, ".agents", "skills.json"), "utf8")) as { skills: string[] },
  };
}
const order = (r: Awaited<ReturnType<typeof topology>>, ...ids: string[]) => {
  const at = ids.map((id) => r.result.phases.findIndex((entry) => entry.id === id));
  assert.ok(at.every((index) => index >= 0) && at.every((index, i) => i === 0 || at[i - 1]! < index), `phase order ${ids.join(" < ")}: ${at}`);
};

try {
  {
    const r = await topology({ name: "enroll" });
    assert.equal(r.result.ok, true, JSON.stringify(r.result.errors));
    assert.equal(r.enrollment?.status, "changed", JSON.stringify({ phases: r.result.phases, logs: r.result.logs, errors: r.result.errors }));
    assert.ok(lstatSync(linkPath(r.target)).isSymbolicLink(), "the skill is a real activation link");
    assert.equal(realpathSync(linkPath(r.target)), realpathSync(join(process.env.PJ_SKILLS_REGISTRY_ROOT!, "all-skills", G33_SKILL)), "the link resolves into the scratch catalog");
    assert.ok(r.skills.skills.includes(G33_SKILL), "skills.json selects the g33 skill");
    assert.deepEqual(r.parsed.bmad.companion.adapter, G33_BRIDGE_ADAPTER);
    assert.deepEqual(r.parsed.custom_key, { keep: ["me"] }, "every other manifest key is preserved");
    assert.equal(r.parsed.ticket_provider.state, "linked");
    assert.equal(r.manifestText, `${JSON.stringify(r.parsed, null, 2)}\n`, "manifest keeps the write-manifest formatting convention");
    assert.equal(r.companion?.status, "changed", JSON.stringify(r.companion));
    assert.ok(existsSync(join(r.target, "_bmad", "g33", "companion.md")), "the companion installed through the adapter");
    assert.equal(r.linkAtFinalizer, true);
    order(r, "project.optional:g33-enrollment", "project.optional:g33-companion", "project.registry:finalizer");
    for (const path of [linkPath(r.target), join(r.target, ".project.json"), join(r.target, ".agents", "skills.json")]) {
      assert.ok(r.enrollment!.changedFiles.includes(path) && r.result.changedFiles.includes(path), `enrollment records ${path}`);
    }
    assert.ok(r.result.logs.some((line) => line === `g33 enrollment: activated ${G33_SKILL} and wrote bmad.companion.adapter`), r.result.logs.join("\n"));
    assert.ok(!r.result.logs.some((line) => line.includes("not configured")));
    console.log("PASS enroll: eligible, unconfigured project is activated, wired and installed");
  }
  {
    const r = await topology({ name: "options-only", companion: { adapter: { options: { keep: "me" } } } });
    assert.equal(r.enrollment?.status, "changed");
    assert.deepEqual(r.parsed.bmad.companion.adapter, { options: { keep: "me" }, ...G33_BRIDGE_ADAPTER }, "adapter.options survive enrollment");
    assert.equal(r.companion?.status, "changed");
    console.log("PASS options-only: adapter.options preserved");
  }
  {
    const r = await topology({ name: "optout", companion: { enabled: false } });
    assert.equal(r.result.ok, true);
    assert.match(r.enrollment!.message!, /enrollment \(skipped\): skipped: g33 explicitly disabled/, "an opt-out is a skip, not an error");
    assert.equal(existsSync(linkPath(r.target)), false);
    assert.deepEqual(r.skills.skills, []);
    assert.deepEqual(r.parsed.bmad, { companion: { enabled: false } }, "an explicit opt-out is untouched");
    assert.equal(r.companion?.status, "disabled");
    assert.equal(existsSync(join(r.target, "_bmad", "g33")), false);
    console.log("PASS optout: enabled:false untouched");
  }
  {
    const adapter = { module: preconfigured, exportName: "custom", options: { n: 1 } };
    const r = await topology({ name: "preconfigured", companion: { adapter } });
    assert.equal(r.result.ok, true);
    assert.equal(r.enrollment?.status, "unchanged", "a configured adapter is recognised, not re-enrolled");
    assert.deepEqual(r.enrollment?.changedFiles, []);
    assert.equal(r.companion?.status, "changed", "the owner's own adapter still runs");
    assert.ok(existsSync(join(r.target, "_bmad", "g33", "custom.md")));
    assert.deepEqual(r.parsed.bmad.companion.adapter, adapter, "a configured adapter is not overwritten");
    assert.equal(existsSync(linkPath(r.target)), false);
    console.log("PASS preconfigured: existing adapter not overwritten");
  }
  {
    const r = await topology({ name: "catalog-missing", catalog: "empty" });
    assert.equal(r.result.ok, true, `init stays ok: ${JSON.stringify(r.result.errors)}`);
    assert.deepEqual(r.result.errors, []);
    assert.equal(r.enrollment?.status, "skipped");
    assert.match(r.enrollment!.message!, /Optional g33 enrollment \(error\)/);
    assert.equal(r.parsed.bmad, undefined, "no adapter is written for a skill that did not activate");
    assert.equal(existsSync(linkPath(r.target)), false);
    assert.equal(r.companion?.status, "unavailable");
    assert.equal(r.companion?.summary, "Optional g33 installer is not configured");
    const log = r.result.logs.join("\n");
    assert.match(log, /g33 enrollment \(error\): could not activate/);
    assert.match(log, new RegExp(`pj skills enable skill ${G33_SKILL}`));
    assert.ok(r.result.phases.every((entry) => entry.status !== "failed"), "no phase fails");
    assert.equal(existsSync(r.target), true, "no rollback latch");
    console.log("PASS catalog-missing: advisory only, companion reports not configured");
  }
  {
    const r = await topology({ name: "nobridge", catalog: "nobridge" });
    assert.equal(r.result.ok, true, JSON.stringify(r.result.errors));
    assert.equal(r.enrollment?.status, "skipped");
    assert.ok(lstatSync(linkPath(r.target)).isSymbolicLink(), "the skill did activate");
    assert.ok(r.enrollment!.changedFiles.includes(linkPath(r.target)), "the partial activation is still inventoried");
    assert.equal(r.parsed.bmad, undefined, "an adapter pointing at a bridge that is not there is never written");
    assert.match(r.result.logs.join("\n"), /bridge is not in the project/);
    assert.equal(r.companion?.summary, "Optional g33 installer is not configured");
    console.log("PASS nobridge: activation without a bridge writes no adapter");
  }
  {
    const r = await topology({ name: "ineligible", workspace: "another-workspace" });
    assert.equal(r.result.ok, true);
    assert.match(r.enrollment!.message!, /enrollment \(skipped\): skipped: not a registered linked 33god project/);
    assert.equal(existsSync(linkPath(r.target)), false);
    assert.equal(r.parsed.bmad, undefined);
    assert.deepEqual(r.skills.skills, []);
    assert.equal(r.companion?.status, "disabled");
    console.log("PASS ineligible: non-33god workspace enrolls nothing");
  }

  // Direct contract: dry run, env-configured adapter, malformed manifest.
  const direct = (name: string, manifest: unknown, text?: string) => {
    const dir = join(scratch, `direct-${name}`);
    put(join(dir, ".project.json"), text ?? `${JSON.stringify(manifest, null, 2)}\n`);
    put(join(dir, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}');
    return { dir, ctx: { repoRoot: dir, dryRun: false, pjanglerRoot: root, homeDir: home } };
  };
  const linked = { project_id: "direct", ticket_provider: { type: "plane", workspace: "33god", state: "linked", board_id: "b" } };
  process.env.PJ_SKILLS_REGISTRY_ROOT = catalog("full");
  {
    const { dir, ctx } = direct("dry", linked);
    const before = snapshotTree(dir);
    const planned = await enrollG33Companion({ ...ctx, dryRun: true });
    assert.equal(planned.status, "planned");
    assert.match(planned.details.join("\n"), new RegExp(G33_SKILL));
    assert.deepEqual(planned.changedFiles, []);
    assert.deepEqual(snapshotTree(dir), before, "a dry run writes nothing: no skills.json edit, no link, no manifest");
    assert.equal(existsSync(linkPath(dir)), false);
    const real = await enrollG33Companion(ctx);
    assert.equal(real.status, "enrolled", JSON.stringify(real));
    assert.ok(existsSync(linkPath(dir)));
    assert.equal((await enrollG33Companion(ctx)).status, "already-configured", "idempotent: the written adapter counts as configured");
    console.log("PASS direct: dry run writes nothing, apply enrolls once");
  }
  {
    const { dir, ctx } = direct("env", linked);
    process.env.PJ_G33_ADAPTER_MODULE = "some-owner-package";
    try {
      const before = snapshotTree(dir);
      assert.equal((await enrollG33Companion(ctx)).status, "already-configured");
      assert.deepEqual(snapshotTree(dir), before);
    } finally { process.env.PJ_G33_ADAPTER_MODULE = ""; }
    console.log("PASS direct: PJ_G33_ADAPTER_* counts as configured");
  }
  for (const [name, text] of [["json", "{not json"], ["shape", JSON.stringify({ ...linked, bmad: [] })]] as const) {
    const { dir, ctx } = direct(`bad-${name}`, undefined, text);
    const before = snapshotTree(dir);
    const result = await enrollG33Companion(ctx);
    assert.equal(result.status, "error", name);
    assert.match(result.details.join("\n"), /pj skills enable skill/);
    assert.deepEqual(snapshotTree(dir), before, "a malformed manifest is reported, never rewritten");
  }
  console.log("PASS direct: malformed manifests are advisories");
  console.log("PJAN-177 g33 enrollment: 7 topology scenarios and 4 direct checks passed; live board and the real skillex catalog remain unverified here.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
