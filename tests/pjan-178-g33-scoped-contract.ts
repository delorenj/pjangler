import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { changedTreePaths, snapshotTree } from "../src/utils/tree-diff";
import {
  createG33CompanionCheck, enrollG33Companion, G33_BRIDGE_ADAPTER, G33_OWNED_SURFACES, G33_SKILL, runG33Companion, snapshotG33Surfaces,
} from "../src/bmad/companion";

// PJAN-178: the g33 no-write contract and the g33 write inventories cover only
// the surfaces g33 owns. The fleet sweep failed on writes elsewhere in busy repos
// (an experiment file, live agent state) and on a root-owned container data dir.
// Every scenario here is real: real files, real chmod, a real concurrent writer
// process, the REAL bundled skillex core over a scratch catalog (CI has no
// ~/code/skillex). Scratch lives in /tmp with GIT_CEILING_DIRECTORIES pinned.
const root = resolve(import.meta.dirname, "..");
const scratch = realpathSync(mkdtempSync("/tmp/pjan-178-scoped-contract-"));
const home = join(scratch, "home");
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
process.env.GIT_CEILING_DIRECTORIES = "/tmp";
process.env.HOME = home;
process.env.XDG_STATE_HOME = join(scratch, "state");
process.env.PJ_G33_ADAPTER_MODULE = "";
process.env.PJ_G33_ADAPTER_EXPORT = "";
put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}');
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// A bridge implementing the v1 contract against real files, served from the catalog.
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
const catalog = join(scratch, "catalog");
for (const name of ["all-skills", "sets", "packs"]) mkdirSync(join(catalog, name), { recursive: true });
put(join(catalog, "all-skills", G33_SKILL, "SKILL.md"), `---\nname: ${G33_SKILL}\ndescription: Scratch g33 fixture\n---\n# g33\n`);
put(join(catalog, "all-skills", G33_SKILL, "scripts", "g33_pjangler_bridge.mjs"), BRIDGE);
process.env.PJ_SKILLS_REGISTRY_ROOT = catalog;

const linked = { ticket_provider: { type: "plane", workspace: "33god", state: "linked", board_id: "fixture-board" } };
let seq = 0;
function project(name: string, adapter?: { module: string; exportName: string }): string {
  const dir = join(scratch, name);
  put(join(dir, ".project.json"), `${JSON.stringify({ project_id: name, ...linked, ...(adapter ? { bmad: { companion: { adapter } } } : {}) }, null, 2)}\n`);
  put(join(dir, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}');
  put(join(dir, ".agents", "skills", "bmad-fixture", "SKILL.md"), "Native BMAD fixture\n");
  put(join(dir, "experiments", "meter-llm-ab", "score.py"), "print('baseline')\n");
  return dir;
}
const ctx = (dir: string, dryRun = false) => ({ repoRoot: dir, dryRun, pjanglerRoot: root, homeDir: home });

/**
 * An owner adapter that, at `when` (import / observe / plan / apply), writes
 * each of `paths` (project-relative) with fresh bytes: the deterministic stand-in
 * for a concurrent agent writing during that window.
 */
function writingAdapter(when: string, paths: string[]): { module: string; exportName: string } {
  const module = join(scratch, `adapter-${++seq}-${when}.mjs`);
  const write = `for(const rel of ${JSON.stringify(paths)}){const p=join(ROOT,rel);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,String(Date.now())+Math.random());}`;
  put(module, `import {existsSync,mkdirSync,writeFileSync} from 'node:fs'; import {dirname,join} from 'node:path';
let ROOT=process.env.PJAN178_ROOT;
${when === "import" ? write : ""}
const r=(status,summary,evidence=[])=>({schemaVersion:1,status,summary,details:[],evidence});
export function companion(req){
  ROOT=req.projectRoot;
  if(req.operation===${JSON.stringify(when)}){${when === "import" ? "" : write}}
  const file=join(req.projectRoot,'_bmad','g33','companion.md'); const valid=existsSync(file);
  if(req.operation==='observe')return valid?r('installed','installed',['companion.md present']):r('missing','absent');
  if(req.operation==='plan')return r(valid?'unchanged':'planned',valid?'converged':'would write');
  mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,'fixture'); return r('changed','written');
}`);
  return { module, exportName: "companion" };
}
const rel = (dir: string, files: string[]) => files.map((file) => file.startsWith(dir) ? file.slice(dir.length + 1) : file);

try {
  // 1. A write OUTSIDE the owned surfaces during import / observe / plan / apply is not the adapter's.
  for (const when of ["import", "observe", "plan", "apply"]) {
    for (const dryRun of when === "apply" ? [false] : [true, false]) {
      const dir = project(`outside-${when}-${dryRun ? "dry" : "real"}`);
      process.env.PJAN178_ROOT = dir;
      const adapter = writingAdapter(when, ["experiments/meter-llm-ab/score.py", "agents/notes/live.md", ".claude/settings.local.json", "skills/ltf-framework/references/commands-and-budgets.md"]);
      put(join(dir, ".project.json"), `${JSON.stringify({ project_id: "outside", ...linked, bmad: { companion: { adapter } } }, null, 2)}\n`);
      const result = await runG33Companion(dir, dryRun, "repair");
      assert.equal(result.status, dryRun ? "planned" : "changed", `${when}/${dryRun}: ${JSON.stringify(result)}`);
      assert.doesNotMatch(result.details.join("\n"), /no-write/, `${when}: an out-of-scope write is no violation`);
      if (!dryRun) assert.deepEqual(rel(dir, result.changedFiles), ["_bmad", "_bmad/g33", "_bmad/g33/companion.md"],
        `${when}: the inventory holds g33's writes only: ${result.changedFiles}`);
      assert.notEqual(readFileSync(join(dir, "experiments", "meter-llm-ab", "score.py"), "utf8"), "print('baseline')\n", "the out-of-scope write really happened");
    }
  }
  console.log("PASS outside: out-of-scope writes during import/observe/plan/apply are neither violations nor g33 changes");

  // 2. The SAME kind of write INSIDE every owned surface is still a violation, path listed.
  const insideTargets: Record<string, string> = {
    _bmad: "_bmad/stray.md", ".agents": ".agents/stray.md",
    ".project.json": ".project.json", ".claude/skills": ".claude/skills/stray.md",
  };
  assert.deepEqual(Object.keys(insideTargets).filter((surface) => !G33_OWNED_SURFACES.includes(surface)), [], "every probed surface is owned");
  for (const when of ["import", "observe", "plan"]) {
    for (const [surface, target] of Object.entries(insideTargets)) {
      const dir = project(`inside-${when}-${surface.replace(/[^a-z]/g, "")}`);
      process.env.PJAN178_ROOT = dir;
      const adapter = writingAdapter(when, [target]);
      put(join(dir, ".project.json"), `${JSON.stringify({ project_id: "inside", ...linked, bmad: { companion: { adapter } } }, null, 2)}\n`);
      const result = await runG33Companion(dir, true, "audit");
      assert.equal(result.status, "error", `${when}/${surface}: ${JSON.stringify(result)}`);
      const message = result.details.find((line) => line.includes("no-write")) ?? "";
      assert.match(message, new RegExp(`violated the no-write ${when} contract: .*${join(dir, target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        `${when}/${surface}: the violation names the path: ${result.details}`);
      assert.ok(result.changedFiles.includes(join(dir, target)), `${when}/${surface}: the partial write is inventoried`);
    }
  }
  console.log("PASS inside: writes to _bmad, .agents, .project.json and CLI aliases still violate import/observe/plan, path named");

  // 2b. A top-level skills/ dir is the project's own content, never g33's: not an owned surface.
  assert.ok(!G33_OWNED_SURFACES.includes("skills"), "the top-level skills/ dir is read-only to g33");

  // 2c. A scoped root under a NON-directory ancestor must neither throw nor be walked through.
  {
    const dir = project("odd-ancestors");
    writeFileSync(join(dir, ".claude"), "a regular file where the tool dir would be");
    mkdirSync(join(scratch, "ext", ".codex", "skills", "a"), { recursive: true });
    writeFileSync(join(scratch, "ext", ".codex", "skills", "a", "SKILL.md"), "outside the repo\n");
    symlinkSync(join(scratch, "ext", ".codex"), join(dir, ".codex"));
    const before = snapshotG33Surfaces(dir);
    assert.equal(before.get(".claude"), `file:${createHash("sha256").update("a regular file where the tool dir would be").digest("hex")}:${statSync(join(dir, ".claude")).mode & 0o7777}`, "a file ancestor is recorded as itself");
    assert.equal(before.get(".codex"), `link:${join(scratch, "ext", ".codex")}`, "a symlinked ancestor is recorded as a link");
    assert.ok(![...before.keys()].some((key) => key.startsWith(".codex/") || key.startsWith(".claude/")), "neither is descended");
    writeFileSync(join(scratch, "ext", ".codex", "skills", "a", "SKILL.md"), "rewritten outside the repo\n");
    assert.deepEqual(changedTreePaths(dir, before, snapshotG33Surfaces(dir)), [], "a write behind the symlink is not the project's");
    process.env.PJAN178_ROOT = dir;
    const adapter = writingAdapter("never", []);
    put(join(dir, ".project.json"), `${JSON.stringify({ project_id: "odd", ...linked, bmad: { companion: { adapter } } }, null, 2)}\n`);
    const result = await runG33Companion(dir, false, "repair");
    assert.equal(result.status, "changed", JSON.stringify(result));
  }
  console.log("PASS ancestors: a file or symlink where a tool dir would be neither throws nor is walked through");

  // 3. The import violation lists the first 10 paths and a count, like observe/plan.
  {
    const dir = project("import-many");
    mkdirSync(join(dir, "_bmad"));
    process.env.PJAN178_ROOT = dir;
    const many = Array.from({ length: 12 }, (_, i) => `_bmad/stray-${String(i).padStart(2, "0")}.md`);
    const adapter = writingAdapter("import", many);
    put(join(dir, ".project.json"), `${JSON.stringify({ project_id: "many", ...linked, bmad: { companion: { adapter } } }, null, 2)}\n`);
    const result = await runG33Companion(dir, true, "audit");
    const message = result.details.find((line) => line.includes("no-write import")) ?? "";
    assert.ok(message.includes(join(dir, many[0]!)) && message.includes(join(dir, many[9]!)), message);
    assert.ok(!message.includes(join(dir, many[10]!)), "only the first 10 are spelled out");
    assert.match(message, /\(\+2 more\)$/, "12 stray files: 10 listed, 2 counted");
  }
  console.log("PASS import-list: the import violation lists the first 10 paths and counts the rest");

  // 4. Unreadable entries: outside scope they are invisible; inside they are fingerprinted, never thrown.
  if (isRoot) {
    console.log("SKIP unreadable: running as root, chmod 000 is not a barrier");
  } else {
    // The whole-tree default is unchanged for the other callers (copier inventory): it still throws.
    {
      const dir = project("default-throws");
      const locked = join(dir, "stacks", "ai", "fal-mcp-proxy", "data", "db");
      mkdirSync(locked, { recursive: true }); chmodSync(locked, 0o000);
      try { assert.throws(() => snapshotTree(dir), /EACCES/, "the unscoped default still refuses an unreadable tree"); }
      finally { chmodSync(locked, 0o755); }
    }
    // Companion: a chmod 000 container data dir outside scope, during dry and real runs.
    for (const dryRun of [true, false]) {
      const dir = project(`locked-companion-${dryRun ? "dry" : "real"}`);
      const locked = join(dir, "stacks", "ai", "fal-mcp-proxy", "data", "db");
      put(join(locked, "pg_control"), "root-owned container data");
      chmodSync(locked, 0o000);
      try {
        process.env.PJAN178_ROOT = dir;
        const adapter = writingAdapter("never", []);
        put(join(dir, ".project.json"), `${JSON.stringify({ project_id: "locked", ...linked, bmad: { companion: { adapter } } }, null, 2)}\n`);
        const result = await runG33Companion(dir, dryRun, "repair");
        assert.equal(result.status, dryRun ? "planned" : "changed", JSON.stringify(result));
      } finally { chmodSync(locked, 0o755); }
    }
    // Inside scope: an unreadable dir is stable (no violation), and a chmod of it is still caught.
    for (const mutate of [false, true]) {
      const dir = project(`locked-inside-${mutate ? "mutated" : "stable"}`);
      const locked = join(dir, "_bmad", "locked");
      put(join(locked, "secret.md"), "unreadable");
      chmodSync(locked, 0o000);
      try {
        const module = join(scratch, `locked-inside-${mutate}.mjs`);
        put(module, `import {chmodSync} from 'node:fs'; import {join} from 'node:path';
const r=(status)=>({schemaVersion:1,status,summary:status,details:[],evidence:[]});
export function companion(req){ if(req.operation==='plan'&&${mutate})chmodSync(join(req.projectRoot,'_bmad','locked'),0o100);
  return r(req.operation==='observe'?'missing':'planned'); }`);
        put(join(dir, ".project.json"), `${JSON.stringify({ project_id: "locked-inside", ...linked, bmad: { companion: { adapter: { module, exportName: "companion" } } } }, null, 2)}\n`);
        const result = await runG33Companion(dir, true, "audit");
        if (mutate) {
          assert.equal(result.status, "error", JSON.stringify(result));
          assert.match(result.details.join("\n"), new RegExp(`no-write plan contract: ${locked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        } else {
          assert.equal(result.status, "planned", `an unreadable owned dir neither throws nor violates: ${JSON.stringify(result)}`);
        }
      } finally { chmodSync(locked, 0o755); }
    }
    // Enrollment + companion through the real migrate path (the ~/docker failure).
    {
      const dir = project("locked-enroll");
      const locked = join(dir, "stacks", "ai", "fal-mcp-proxy", "data", "db");
      put(join(locked, "pg_control"), "root-owned container data");
      chmodSync(locked, 0o000);
      try {
        const check = createG33CompanionCheck();
        const audited = await check.audit(ctx(dir));
        assert.equal(audited.fixable, true, JSON.stringify(audited));
        const applied = await check.migrate(ctx(dir), audited);
        assert.equal(applied.status, "applied", JSON.stringify(applied));
        assert.deepEqual(JSON.parse(readFileSync(join(dir, ".project.json"), "utf8")).bmad.companion.adapter, G33_BRIDGE_ADAPTER);
        assert.equal((await check.audit(ctx(dir))).status, "pass");
      } finally { chmodSync(locked, 0o755); }
    }
    console.log("PASS unreadable: a chmod 000 dir outside scope fails neither enrollment nor companion; inside it is fingerprinted and a chmod is caught");
  }

  // 5. A REAL concurrent writer process during enrollment and the companion: never inventoried, never a violation.
  {
    const dir = project("concurrent");
    const counter = join(dir, "experiments", "meter-llm-ab", "score.py");
    const writer = spawn(process.execPath, ["-e",
      `const {renameSync,writeFileSync}=require('node:fs');let i=0;const tick=()=>{writeFileSync(${JSON.stringify(`${counter}.next`)},String(++i));renameSync(${JSON.stringify(`${counter}.next`)},${JSON.stringify(counter)});setImmediate(tick);};tick();`],
    { stdio: "ignore" });
    try {
      const read = () => Number(readFileSync(counter, "utf8")) || 0;
      for (let tries = 0; read() === 0 && tries < 200; tries++) await new Promise((done) => setTimeout(done, 10));
      const start = read();
      const enrolled = await enrollG33Companion(ctx(dir));
      const mid = read();
      assert.equal(enrolled.status, "enrolled", JSON.stringify(enrolled));
      assert.ok(mid > start, `the writer really wrote during enrollment (${start} -> ${mid})`);
      assert.ok(!enrolled.changedFiles.includes(counter), `enrollment never claims the concurrent write: ${enrolled.changedFiles}`);
      for (const path of [join(dir, ".agents", "skills", G33_SKILL), join(dir, ".project.json"), join(dir, ".agents", "skills.json")]) {
        assert.ok(enrolled.changedFiles.includes(path), `enrollment still records ${path}`);
      }
      const companion = await runG33Companion(dir, false, "repair");
      assert.ok(read() > mid, "the writer kept writing through the companion run");
      assert.equal(companion.status, "changed", JSON.stringify(companion));
      assert.deepEqual(rel(dir, companion.changedFiles), ["_bmad", "_bmad/g33", "_bmad/g33/companion.md"]);
    } finally { writer.kill("SIGKILL"); }
    assert.ok(existsSync(join(dir, "_bmad", "g33", "companion.md")));
  }
  console.log("PASS concurrent: a live writer outside scope during enrollment and companion is ignored; g33's own writes are recorded");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
