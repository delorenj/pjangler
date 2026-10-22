import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProjectRecipe, type ProjectRecipeRuntime } from "../src/recipes/ProjectRecipe";
import { BmadRecipe } from "../src/recipes/BmadRecipe";
import { RecipeRegistry } from "../src/recipes/registry";
import { NotebookRecipe } from "../src/recipes/NotebookRecipe";
import { snapshotTree } from "../src/utils/tree-diff";
import { createG33CompanionCheck, enrollG33Companion, g33Enrollability, G33_BRIDGE_ADAPTER, G33_SKILL } from "../src/bmad/companion";
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
function catalog(kind: "full" | "empty" | "nobridge" | "unproven"): string {
  const withSkill = kind !== "empty";
  const dir = join(scratch, `catalog-${kind}`);
  for (const name of ["all-skills", "sets", "packs"]) mkdirSync(join(dir, name), { recursive: true });
  if (withSkill) {
    put(join(dir, "all-skills", G33_SKILL, "SKILL.md"), `---\nname: ${G33_SKILL}\ndescription: Scratch g33 fixture\n---\n# g33\n`);
    if (kind === "full") put(join(dir, "all-skills", G33_SKILL, "scripts", "g33_pjangler_bridge.mjs"), BRIDGE);
    // An owner whose apply claims 'changed' but whose observation never reports 'installed'.
    if (kind === "unproven") put(join(dir, "all-skills", G33_SKILL, "scripts", "g33_pjangler_bridge.mjs"),
      `const r=(status,evidence=[])=>({schemaVersion:1,status,summary:status,details:[],evidence});
export function g33Companion(req){ if(req.operation==='observe')return r('missing'); if(req.operation==='plan')return r('planned'); return r('changed'); }`);
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

type Scenario = { name: string; prelinked?: boolean; workspace?: string; companion?: Record<string, unknown>; catalog?: "full" | "empty" | "nobridge" };
async function topology(scenario: Scenario) {
  process.env.PJ_SKILLS_REGISTRY_ROOT = catalog(scenario.catalog ?? "full");
  const target = join(scratch, scenario.name);
  const binding = { type: "plane", workspace: scenario.workspace ?? "33god", identifier: "PROB", identifier_source: "provider",
    ...(scenario.prelinked ? { board_id: "fixture-board", state: "linked", board_confirmed_at: "2026-10-04T00:00:00Z" } : { board_id: "", state: "planned" }) };
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
          if (!scenario.prelinked) assert.equal(existsSync(linkPath(target)), false, "nothing is enrolled while the board is only planned");
          if (scenario.prelinked) continue; // the manifest already carried the link; a rewrite would clobber enrollment
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
    const r = await topology({ name: "prelinked", prelinked: true });
    assert.equal(r.result.ok, true, JSON.stringify(r.result.errors));
    assert.equal(r.enrollment?.status, "changed", JSON.stringify({ phases: r.result.phases, logs: r.result.logs }));
    assert.deepEqual(r.parsed.bmad.companion.adapter, G33_BRIDGE_ADAPTER);
    assert.equal(r.result.phases.find((entry) => entry.id === "bmad.g33-companion")?.status, "changed", "the BMAD pass itself installed through the adapter");
    assert.ok(existsSync(join(r.target, "_bmad", "g33", "companion.md")));
    assert.ok(!r.result.logs.some((line) => line.includes("not configured")), "no premature 'not configured' from the BMAD pass");
    assert.equal(r.result.phases.filter((entry) => entry.id === "project.optional:g33-enrollment").length, 1, "enrolled exactly once");
    console.log("PASS prelinked: a board linked at plan time is enrolled before the BMAD pass");
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
    process.env.PJ_G33_ADAPTER_EXPORT = "owner";
    try {
      const before = snapshotTree(dir);
      assert.equal((await enrollG33Companion(ctx)).status, "already-configured");
      assert.deepEqual(snapshotTree(dir), before);
    } finally { process.env.PJ_G33_ADAPTER_MODULE = ""; process.env.PJ_G33_ADAPTER_EXPORT = ""; }
    console.log("PASS direct: PJ_G33_ADAPTER_* counts as configured");
  }
  for (const [name, adapter, env] of [["module", { module: "./owner.mjs" }, {}], ["export", { exportName: "owner" }, {}], ["env-module", {}, { PJ_G33_ADAPTER_MODULE: "pkg" }]] as const) {
    const { dir, ctx } = direct(`half-${name}`, { ...linked, bmad: { companion: { adapter } } });
    Object.assign(process.env, env);
    try {
      const before = snapshotTree(dir);
      const result = await enrollG33Companion(ctx);
      assert.equal(result.status, "skipped", name);
      assert.match(result.summary, /half-configured \((exportName|module) is missing\)/);
      assert.deepEqual(snapshotTree(dir), before, "a half-configured adapter is reported, never completed");
    } finally { process.env.PJ_G33_ADAPTER_MODULE = ""; }
  }
  console.log("PASS direct: half-configured adapter is an advisory naming the missing half");
  {
    // A set replaces the skills root and enabling beside it derives a set dir in the shared catalog.
    const { dir, ctx } = direct("sets", linked);
    put(join(dir, ".agents", "skills.json"), '{"inherit_global":false,"sets":["myset"]}');
    const catalogRoot = process.env.PJ_SKILLS_REGISTRY_ROOT!;
    put(join(catalogRoot, "all-skills", "set-member", "SKILL.md"), "---\nname: set-member\ndescription: Scratch set member\n---\n");
    mkdirSync(join(catalogRoot, "sets", "myset"), { recursive: true });
    symlinkSync("../../all-skills/set-member", join(catalogRoot, "sets", "myset", "set-member"));
    const beforeCatalog = snapshotTree(catalogRoot);
    const beforeProject = snapshotTree(dir);
    const result = await enrollG33Companion(ctx);
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.match(result.summary, /a set replaces the project skills root/);
    assert.match(result.details.join("\n"), /pj skills enable skill/);
    assert.deepEqual(snapshotTree(catalogRoot), beforeCatalog, "the shared catalog is never written");
    assert.deepEqual(snapshotTree(dir), beforeProject, "the project is untouched");
    console.log("PASS direct: a project selecting a set is skipped, catalog untouched");
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

  // pj migrate bmad.g33-companion: the audit reports the enrollable project as a fixable
  // warn without writing, and migrate enrolls, installs and re-audits to pass.
  const check = createG33CompanionCheck();
  const migrateProject = (name: string, extra: Record<string, unknown> = {}, id = linked) => {
    const made = direct(name, { ...id, ...extra });
    return { ...made, dry: { ...made.ctx, dryRun: true } };
  };
  {
    const { dir, ctx, dry } = migrateProject("migrate");
    const before = snapshotTree(dir);
    const audited = await check.audit(ctx);
    assert.equal(audited.status, "warn");
    assert.equal(audited.fixable, true);
    assert.equal(audited.summary, "g33 enrollable: eligible 33god project has no companion adapter");
    assert.match(audited.details.join("\n"), /pj migrate bmad\.g33-companion/);
    assert.deepEqual(snapshotTree(dir), before, "the audit is read-only: no activation, no manifest write");
    assert.equal((await g33Enrollability(ctx)).enrollable, true);

    const preview = await check.migrate(dry, audited);
    assert.equal(preview.status, "applied", JSON.stringify(preview));
    assert.deepEqual(preview.changedFiles, []);
    assert.match(preview.details.join("\n"), /g33 enrollment \(planned\)/);
    assert.deepEqual(snapshotTree(dir), before, "a migrate dry run writes nothing");

    const applied = await check.migrate(ctx, audited);
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    assert.match(applied.details.join("\n"), /g33 enrollment: activated/, "migrate reports the enrollment lines");
    assert.match(applied.details.join("\n"), /g33 \((changed|unchanged)\)/);
    for (const path of [linkPath(dir), join(dir, ".project.json"), join(dir, "_bmad", "g33", "companion.md")]) {
      assert.ok(existsSync(path), path);
      assert.ok(applied.changedFiles.some((file) => file === path || file === path.slice(dir.length + 1)), `changedFiles records ${path}: ${applied.changedFiles}`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".project.json"), "utf8")).bmad.companion.adapter, G33_BRIDGE_ADAPTER);
    const after = await check.audit(ctx);
    assert.equal(after.status, "pass", JSON.stringify(after));
    assert.equal(after.fixable, false);
    const settled = snapshotTree(dir);
    assert.equal((await check.migrate(ctx, after)).status, "noop", "converged: a second migrate is a noop");
    assert.deepEqual(snapshotTree(dir), settled);
    console.log("PASS migrate: audit warn fixable (read-only), dry run writes nothing, migrate enrolls and re-audits to pass");
  }
  {
    // Not enrollable: the audit is the pre-PJAN-177 audit, never fixable by enrollment.
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ["optout", { bmad: { companion: { enabled: false } } }, linked],
      ["configured", { bmad: { companion: { adapter: { module: preconfigured, exportName: "custom" } } } }, linked],
      ["ineligible", {}, { project_id: "direct", ticket_provider: { type: "plane", workspace: "other", state: "linked", board_id: "b" } }],
    ];
    for (const [name, extra, id] of cases) {
      const { dir, ctx, dry } = migrateProject(`not-${name}`, extra, id as typeof linked);
      const before = snapshotTree(dir);
      assert.equal((await g33Enrollability(ctx)).enrollable, false, name);
      const audited = await check.audit(ctx);
      assert.ok(!audited.summary.startsWith("g33 enrollable"), `${name}: ${audited.summary}`);
      if (name === "optout" || name === "ineligible") { assert.equal(audited.status, "skip", name); assert.equal(audited.fixable, false, name); }
      if (name === "configured") assert.equal(audited.status, "warn", "a configured adapter keeps the companion's own audit");
      assert.deepEqual(snapshotTree(dir), before, `${name}: audit writes nothing`);
      const preview = await check.migrate(dry, audited);
      assert.doesNotMatch(preview.details.join("\n"), /g33 enrollment \(planned\)/, `${name}: no enrollment is planned: ${JSON.stringify(preview)}`);
      if (name !== "configured") assert.equal(preview.status, "skipped", name);
      const real = await check.migrate(ctx, audited);
      assert.doesNotMatch(real.details.join("\n"), /g33 enrollment: activated/, `${name}: nothing enrolled`);
      assert.equal(existsSync(linkPath(dir)), false, `${name}: nothing enrolled`);
    }
    console.log("PASS migrate: opted-out, configured and ineligible projects keep their audit and are never enrolled");
  }
  {
    // Host-state rule: a missing catalog skill is an advisory result, not a crash or a fail.
    const { dir, ctx } = migrateProject("migrate-catalog-missing");
    process.env.PJ_SKILLS_REGISTRY_ROOT = catalog("empty");
    try {
      const audited = await check.audit(ctx);
      assert.equal(audited.status, "warn");
      const before = snapshotTree(dir);
      const result = await check.migrate(ctx, audited);
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.match(result.details.join("\n"), new RegExp(`pj skills enable skill ${G33_SKILL}`));
      assert.deepEqual(snapshotTree(dir), before, "nothing was written");
    } finally { process.env.PJ_SKILLS_REGISTRY_ROOT = catalog("full"); }
    const partial = migrateProject("migrate-nobridge");
    process.env.PJ_SKILLS_REGISTRY_ROOT = catalog("nobridge");
    try {
      const result = await check.migrate(partial.ctx, await check.audit(partial.ctx));
      assert.equal(result.status, "partial", "a partial activation is reported as partial with its writes");
      assert.ok(result.changedFiles.length > 0);
    } finally { process.env.PJ_SKILLS_REGISTRY_ROOT = catalog("full"); }
    console.log("PASS migrate: a missing or bridge-less catalog skill is blocked/partial with the retry hint");
  }
  {
    // A fixer must verify its own postcondition: an adapter that cannot prove installation is not 'applied'.
    const { dir, ctx } = migrateProject("migrate-postcondition");
    const audited = await check.audit(ctx);
    process.env.PJ_SKILLS_REGISTRY_ROOT = catalog("unproven");
    try {
      const result = await check.migrate(ctx, audited);
      assert.equal(result.status, "partial", JSON.stringify(result));
      assert.match(result.summary, /did not establish an installed owner observation/);
    } finally { process.env.PJ_SKILLS_REGISTRY_ROOT = catalog("full"); }
    console.log("PASS migrate: unproven installation after apply is partial, never applied");
    void dir;
  }
  {
    // Registry level: the rule is fixable in the audit and migrateRules actually runs it.
    const { dir, ctx } = migrateProject("registry");
    const registry = new RecipeRegistry([noop("mise"), noop("agent-hooks", ["mise"]), new BmadRecipe()]);
    const audit = await registry.auditRecipes(ctx);
    const rule = audit.rules.find((entry) => entry.id === "bmad.g33-companion");
    assert.ok(rule, "the rule is registered");
    assert.ok((rule.status === "warn" || rule.status === "fail") && rule.fixable, `migrate --all selects failing+fixable rules: ${JSON.stringify(rule)}`);
    const report = await registry.migrateRules(ctx, [rule.id]);
    const entry = report.results.find((result) => result.id === "bmad.g33-companion");
    assert.equal(entry?.status, "applied", JSON.stringify(report.results));
    assert.ok(existsSync(linkPath(dir)) && existsSync(join(dir, "_bmad", "g33", "companion.md")));
    const post = (await registry.auditRecipes(ctx)).rules.find((candidate) => candidate.id === "bmad.g33-companion");
    assert.equal(post?.status, "pass", JSON.stringify(post));
    console.log("PASS migrate: RecipeRegistry selects the rule, migrates it, and the re-audit passes");
  }
  console.log("PJAN-177 g33 enrollment: 8 topology scenarios, 6 direct checks and 5 migrate checks passed; live board and the real skillex catalog remain unverified here.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
