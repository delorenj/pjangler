import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createBmadInstallerFixture } from "./helpers/pack-fixture.mjs";
import { HERMETIC_TMP_BASE, hermeticChildEnv, hermeticScratch, pickHermeticTmpBase } from "./helpers/hermetic-env.mjs";

// PJAN-188 canary: a suite that isolates itself through tests/helpers/
// hermetic-env.mjs passes identically standalone, under scripts/run-tests.mjs,
// and in CI — even when the surrounding environment is actively hostile.
//
// The regression it guards against is real history: pjan-167-g33-companion
// failed standalone (`recipe run bmad --dry-run` → "skills.project-manifest:
// 10 Skillex finding(s)") while passing under the runner, because the suite's
// scratch — and with it the isolated home and XDG_STATE_HOME, the Skillex
// activation-receipt directory — landed under the operator's TMPDIR inside the
// ~/.claude git work tree, and the Skillex core refuses any receipt whose path
// has a .git ancestor (E_RECEIPT_UNSAFE_PATH). The runner's TMPDIR=/tmp
// overlay masked it. If a suite once again passes only under the runner, this
// canary fails, because it manufactures the hostile environment itself instead
// of borrowing this machine's.
//
// The hostility, in order:
//   - TMPDIR points INSIDE a git repository the canary creates (so a helper
//     that regresses to plain os.tmpdir() puts its scratch, home and receipt
//     state back inside a source repository and the recipe below fails);
//   - HOME is a populated fake home (a global skills selection, a Skillex
//     checkout mapping, a gitconfig) that would change behavior if inherited;
//   - PLANE_*/TRELLO_* carry junk credentials; SKILLEX_* and PJ_G33_ADAPTER_*
//     point at nonexistent paths.
//
// Then the canary runs exactly what PJAN-167 runs — a 33god-enrolled project
// and `recipe run bmad --dry-run` — through the helper's scratch and env, and
// asserts the hermetic outcome: planned, exit 0, no Skillex refusal.

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

// 1. The hostile world, built with the real (unpoisoned) tmpdir first.
const hostileRoot = mkdtempSync(join(tmpdir(), "pjan-188-hostile-"));
const hostileRepo = join(hostileRoot, "source-repo");
const hostileTmp = join(hostileRepo, "tmp");
const hostileHome = join(hostileRoot, "home");
const cleanGit = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: process.env.PATH, HOME: hostileHome };
const gitInit = spawnSync("git", ["init", "--quiet", hostileRepo], { encoding: "utf8", env: cleanGit });
assert.equal(gitInit.status, 0, `hostile repo must initialize:\n${gitInit.stderr}`);
put(join(hostileRepo, "README.md"), "a source repository the fixture must not be hosted in\n");
mkdirSync(hostileTmp, { recursive: true });
// A populated fake home: a global skills selection, a machine-local Skillex
// checkout mapping, and a git identity — all observable if HOME leaks.
put(join(hostileHome, ".agents", "skills.json"), JSON.stringify({ skills: ["hostile-global-skill"] }, null, 2) + "\n");
put(join(hostileHome, ".agents", "skills", "hostile-global-skill", "SKILL.md"), "---\nname: hostile-global-skill\n---\nhostile global skill\n");
put(join(hostileHome, ".config", "skillex", "sources.local.toml"), "[checkouts]\nall-skills = \"/definitely/not/a/checkout\"\n");
put(join(hostileHome, ".gitconfig"), "[user]\n\tname = Hostile Operator\n\temail = hostile@example.invalid\n");
put(join(hostileHome, "fleet.env"), "HERMES_SOMETHING=hostile\n");

const hostileEnv = {
  HOME: hostileHome,
  PLANE_API_KEY: "junk-plane-key", PLANE_DEFAULT_API_KEY: "junk", PLANE_33GOD_API_KEY: "junk-33god",
  PLANE_AUTOMATICAI_API_KEY: "junk", PLANE_INTELLIFORIA_API_KEY: "junk", PLANE_LASERTOAST_API_KEY: "junk",
  TRELLO_KEY: "junk", TRELLO_API_KEY: "junk", TRELLO_TOKEN: "junk",
  SKILLEX_HOME: "/definitely/not/skillex", SKILLEX_SOURCE_ROOT: "/definitely/not/here",
  PJ_G33_ADAPTER_MODULE: "/definitely/not/an-adapter.mjs", PJ_G33_ADAPTER_EXPORT: "hostileExport",
  HERMES_FLEET_ENV: join(hostileHome, "fleet.env"),
  XDG_STATE_HOME: join(hostileHome, ".local", "state"), XDG_CONFIG_HOME: join(hostileHome, ".config"),
  XDG_CACHE_HOME: join(hostileHome, ".cache"), XDG_DATA_HOME: join(hostileHome, ".local", "share"),
};

// 2. Poison this process's TMPDIR: from here on, os.tmpdir() returns a path
// INSIDE the hostile repository. A regressed hermeticScratch() — one that goes
// back to mkdtempSync(join(tmpdir(), ...)) — hosts the fixture (and its
// receipt state) inside that repo and fails the recipe below.
process.env.TMPDIR = hostileTmp;
assert.equal(tmpdir(), hostileTmp, "canary must poison TMPDIR before building its fixture");

let checks = 0;
let scratchRoot = "";
function checkpoint(label) { checks++; console.log(`PASS ${label}`); }

try {
  // 3. Helper contract, asserted under the poisoned TMPDIR.
  const base = pickHermeticTmpBase();
  assert.notEqual(base, hostileTmp, "the hermetic base must not be the poisoned TMPDIR");
  for (let current = base; ; current = dirname(current)) {
    assert.equal(existsSync(join(current, ".git")), false, `${current} must not carry .git`);
    if (dirname(current) === current) break;
  }
  assert.equal(base, HERMETIC_TMP_BASE, "the import-time base and a fresh probe must agree");

  const scratch = hermeticScratch("pjan-188-canary-");
  scratchRoot = scratch;
  for (let current = scratch; ; current = dirname(current)) {
    assert.equal(existsSync(join(current, ".git")), false, `scratch ancestor ${current} must not carry .git`);
    if (dirname(current) === current) break;
  }
  const pins = hermeticChildEnv(scratch);
  assert.equal(pins.TMPDIR, HERMETIC_TMP_BASE, "child TMPDIR must be pinned to the hermetic base");
  assert.equal(pins.PJ_G33_ADAPTER_MODULE, "", "child PJ_G33_ADAPTER_MODULE must be blanked");
  assert.equal(pins.PLANE_33GOD_API_KEY, "", "child PLANE_33GOD_API_KEY must be blanked");
  assert.equal(pins.HERMES_FLEET_ENV, join(scratch, "no-such-fleet.env"), "child HERMES_FLEET_ENV must point at nothing");
  checkpoint("hermetic base and child-env pins hold under a poisoned TMPDIR");

  // 4. The PJAN-167 fixture pattern, built entirely through the helper.
  const isolatedHome = join(scratch, "home");
  const catalog = join(scratch, "catalog");
  const adapter = join(scratch, "callable-fixture.mjs");
  put(join(isolatedHome, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  for (const name of ["all-skills", "sets", "packs"]) mkdirSync(join(catalog, name), { recursive: true });
  const upstream = createBmadInstallerFixture(scratch);
  put(adapter, `
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
export async function companion(request) {
  const {operation,projectRoot}=request;
  const content=join(projectRoot,'_bmad','g33','companion.md');
  const mapping=join(projectRoot,'_bmad','_config','g33-mapping.json');
  const expected='PJangler callable fixture companion\\n';
  const mapped='{"g33":"fixture reference"}\\n';
  const valid=existsSync(content)&&readFileSync(content,'utf8')===expected&&existsSync(mapping)&&readFileSync(mapping,'utf8')===mapped;
  const result=(status,summary,evidence=[])=>({schemaVersion:1,status,summary,details:[],evidence,changedFiles:[]});
  if(operation==='observe')return result(valid?'installed':'missing',valid?'Content and mappings observed':'Missing content or mapping');
  if(operation==='plan')return result(valid?'unchanged':'planned',valid?'Companion converged':'Would reconcile fixture companion');
  if(operation!=='apply')throw new Error('unexpected operation');
  for(const [path,text]of [[content,expected],[mapping,mapped]]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
  return result('changed','Applied fixture companion');
}
`);
  put(join(isolatedHome, ".cache", "pjangler", "bmad-dist-tags.json"), JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.12.0", next: "6.12.0" } }));
  const target = join(scratch, "eligible");
  mkdirSync(target);
  put(join(target, ".project.json"), JSON.stringify({
    project_id: "eligible", project_name: "eligible",
    ticket_provider: { type: "plane", state: "linked", workspace: "33god", board_id: "fixture-board" },
    bmad: { companion: { adapter: { module: adapter, exportName: "companion", options: {} } } },
  }));
  put(join(target, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(target, ".agents", "skills", "bmad-fixture", "SKILL.md"), "Native BMAD CLI fixture\n");

  // 5. The hostile operator env, the helper's isolation, then the suite's own
  // fixture values — exactly the layering a hermetic suite uses.
  const env = {
    ...process.env, ...hostileEnv, ...hermeticChildEnv(scratch),
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, ".config"), XDG_CACHE_HOME: join(isolatedHome, ".cache"),
    XDG_STATE_HOME: join(isolatedHome, ".local", "state"), XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
    PJ_PROJECT_REGISTRY: join(scratch, "registry.yaml"), PJ_SKILLS_REGISTRY_ROOT: catalog,
    PJ_BMAD_INSTALLER: upstream,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  };

  // 6. The exact command that failed standalone in PJAN-167.
  const run = spawnSync(process.execPath, [cli, "recipe", "run", "bmad", "--dry-run", "--json"], {
    cwd: target, env, encoding: "utf8", timeout: 120_000, maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `recipe run bmad --dry-run must succeed against a hostile environment:\n${run.stdout}\n${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.errors, [], "no phase errors, in particular no Skillex refusal");
  assert.doesNotMatch(run.stdout, /E_RECEIPT_UNSAFE_PATH/, "the Skillex receipt must never sit inside a source repository");
  assert.doesNotMatch(run.stdout, /Skillex finding/, "the skills phase must not carry Skillex findings");
  assert.equal(payload.bmadCompanion.status, "planned", "the hostile PJ_G33_ADAPTER_MODULE must not reach the fixture adapter's verdict");
  const skillsPhase = [...(payload.phases ?? []), ...(payload.dependencyResults ?? []).flatMap((d) => d.phases ?? [])].find((p) => p.id === "skills.project-manifest");
  assert.equal(skillsPhase?.status, "planned", JSON.stringify(skillsPhase));
  checkpoint("recipe run bmad --dry-run is hermetic against a hostile TMPDIR/HOME/credentials env");
  console.log(`PJAN-188 hermetic canary: ${checks} groups passed; standalone, runner and CI are equivalent by construction.`);
} finally {
  rmSync(hostileRoot, { recursive: true, force: true });
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
}
