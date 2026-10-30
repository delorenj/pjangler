import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { createBmadInstallerFixture } from "./helpers/pack-fixture.mjs";

// PJAN-179: an enrolled g33 whose owner observe cannot work on the OLD BMAD
// (the bridge reports `unavailable` below 6.12) must not deadlock the update that
// would fix it. This fixture adapter models exactly that and nothing about the
// real owner: it is a PJangler-boundary fixture, not evidence of real g33.
// Cold CI has no ~/code/skillex; everything lives in /tmp scratch.
const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join("/tmp", "pjan-179-gap-"));
const cli = join(root, "dist", "index.js");
const isolatedHome = join(scratch, "home");
const catalog = join(scratch, "catalog");
const adapter = join(scratch, "gap-adapter.mjs");
const reached = join(scratch, "updater-reached");
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
let checks = 0;
const checkpoint = (label) => { checks++; console.log(`PASS ${label}`); };

function snapshot(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return stat.isSymbolicLink() ? ["link", readlinkSync(path)] : stat.isDirectory()
    ? ["dir", stat.mode, readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))])]
    : ["file", stat.mode, readFileSync(path).toString("base64")];
}

put(join(isolatedHome, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
for (const name of ["all-skills", "sets", "packs"]) mkdirSync(join(catalog, name), { recursive: true });
const upstream = createBmadInstallerFixture(scratch);
const updatingInstaller = join(scratch, "update-installer.mjs");
put(updatingInstaller, `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
if(args[0]==='install')writeFileSync(${JSON.stringify(reached)},'upstream invoked');
const run=spawnSync(${JSON.stringify(upstream)},args,{encoding:'utf8'});
if(run.status!==0)process.exit(run.status??1);
const target=args[args.indexOf('--directory')+1];
if(args[0]==='install')writeFileSync(join(target,'_bmad','_config','g33-mapping.json'),'upstream rewrite\\n');
process.stdout.write(run.stdout);
`);
chmodSync(updatingInstaller, 0o755);

// observe: on BMAD < 6.12 the resolver predates --project-root, so the owner cannot verify
// (`behavior` picks what it says instead); on >= 6.12 it observes the real content.
// plan and apply work on any layout, like the real bridge.
put(adapter, `
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
export async function companion(request) {
  const {operation,projectRoot,options}=request;
  const b=options.behavior??'gap';
  const content=join(projectRoot,'_bmad','g33','companion.md');
  const mapping=join(projectRoot,'_bmad','_config','g33-mapping.json');
  const expected='PJangler gap fixture companion\\n';
  const mapped='{"g33":"fixture reference"}\\n';
  const valid=existsSync(content)&&readFileSync(content,'utf8')===expected&&existsSync(mapping)&&readFileSync(mapping,'utf8')===mapped;
  const manifest=join(projectRoot,'_bmad','_config','manifest.yaml');
  const version=existsSync(manifest)?(readFileSync(manifest,'utf8').match(/version:\\s*(\\S+)/)?.[1]??'0.0.0'):'0.0.0';
  const [major,minor]=version.split('.').map((part)=>Number.parseInt(part,10));
  const old=major<6||(major===6&&minor<12);
  const result=(status,summary,evidence=[])=>({schemaVersion:1,status,summary,details:['PJangler gap fixture only',request.reason],evidence});
  if(operation==='observe'){
    if(b==='always-unavailable')return result('unavailable','BMAD customization resolver predates --project-root (BMAD < 6.12); upgrade BMAD');
    if(old&&b==='gap')return result('unavailable','BMAD customization resolver predates --project-root (BMAD < 6.12); upgrade BMAD');
    if(old&&b==='old-error')return result('error','Owner observe crashed on the old layout');
    if(old&&b==='old-conflict')return result('conflict','Operator mapping conflict on the old layout');
    if(!old&&b==='new-conflict-until-applied'&&!valid)return result('conflict','Merge conflict until the owner applies');
    return result(valid?'installed':'missing',valid?'Content and mappings observed':'Missing content or mapping',valid?['Exact companion bytes verified','Exact mapping bytes verified']:[]);
  }
  if(operation==='plan'){
    if(b==='plan-error')return result('error','Owner plan failed');
    return result(valid?'unchanged':'planned',valid?'Companion converged':'Would reconcile fixture companion');
  }
  if(operation!=='apply')throw new Error('unexpected operation');
  for(const [path,text]of [[content,expected],[mapping,mapped]]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
  return result('changed','Applied fixture companion');
}
`);

const env = hermeticEnv({
  HOME: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, ".config"), XDG_CACHE_HOME: join(isolatedHome, ".cache"),
  XDG_STATE_HOME: join(isolatedHome, ".local", "state"), XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
  PJ_PROJECT_REGISTRY: join(scratch, "registry.yaml"), PJ_SKILLS_REGISTRY_ROOT: catalog,
  PJ_BMAD_INSTALLER: upstream, HERMES_FLEET_ENV: join(scratch, "no-fleet.env"),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: "/tmp",
});
put(join(isolatedHome, ".cache", "pjangler", "bmad-dist-tags.json"), JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.12.0", next: "6.12.0" } }));

function run(target, args, expected = 0, overrides = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: target, env: { ...env, ...overrides }, encoding: "utf8", timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.trim(), "CLI must produce real JSON");
  return JSON.parse(result.stdout);
}
const setBehavior = (target, behavior) => {
  const manifest = JSON.parse(readFileSync(join(target, ".project.json"), "utf8"));
  manifest.bmad.companion = { adapter: { module: adapter, exportName: "companion", options: { behavior } } };
  put(join(target, ".project.json"), JSON.stringify(manifest));
};
const operatorOverride = (target) => join(target, "_bmad", "custom", "operator.toml");
const updateEnv = { PJ_BMAD_INSTALLER: updatingInstaller };

/**
 * An enrolled project whose BMAD is still 6.11.0 with the g33 companion present
 * (what the PJAN-177 sweep left in bloodbank, candystore and srvls).
 * `installed: false` removes the companion content so the owner PLAN is `planned`
 * rather than `unchanged`.
 */
function oldEnrolledProject(name, behavior, installed = true) {
  const target = join(scratch, name);
  mkdirSync(target);
  put(join(target, ".project.json"), JSON.stringify({
    project_id: name, project_name: name,
    ticket_provider: { type: "plane", state: "linked", workspace: "33god", board_id: "fixture-board" },
    bmad: { companion: { adapter: { module: adapter, exportName: "companion", options: { behavior: "no-gap" } } } },
  }));
  put(join(target, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(target, ".agents", "skills", "bmad-fixture", "SKILL.md"), "Native BMAD CLI fixture\n");
  assert.equal(run(target, ["recipe", "run", "bmad"]).ok, true);
  const manifestPath = join(target, "_bmad", "_config", "manifest.yaml");
  put(manifestPath, readFileSync(manifestPath, "utf8").replace(/version:\s*\S+/, "version: 6.11.0") + "  - name: g33\n");
  put(operatorOverride(target), "operator_override = true\n");
  if (!installed) rmSync(join(target, "_bmad", "g33"), { recursive: true });
  setBehavior(target, behavior);
  return { target, manifestPath };
}
const assertUntouched = (target, before, label) => {
  assert.deepEqual(snapshot(target), before, label);
  assert.equal(readFileSync(operatorOverride(target), "utf8"), "operator_override = true\n");
};

try {
  // 1. The deadlock itself: pre-update observe is `unavailable`, the plan is fine.
  for (const installed of [true, false]) {
    const label = installed ? "plan unchanged" : "plan planned";
    const { target, manifestPath } = oldEnrolledProject(installed ? "gap-converged" : "gap-planned", "gap", installed);
    const before = snapshot(target);

    const preview = run(target, ["migrate", "bmad.version", "--dry-run"]);
    assert.equal(preview.results[0].status, "applied", `dry run reports the planned upgrade (${label})`);
    assert.match(preview.results[0].summary, /Would upgrade BMAD 6\.11\.0 -> /);
    const previewText = preview.results[0].details.join("\n");
    assert.match(previewText, /g33 pre-update observation gap \(unavailable\)/);
    assert.match(previewText, /post-update apply and re-observation are mandatory/);
    assert.equal(preview.results[0].bmadCompanion.status, installed ? "unchanged" : "planned");
    assertUntouched(target, before, "dry run writes nothing");
    assert.equal(existsSync(reached), false);

    const upgraded = run(target, ["migrate", "bmad.version"], 0, updateEnv);
    assert.equal(upgraded.results[0].status, "applied", `update applied (${label})`);
    assert.equal(existsSync(reached), true, "the installer ran");
    rmSync(reached);
    assert.match(readFileSync(manifestPath, "utf8"), /version:\s*6\.12\.1/);
    assert.match(upgraded.results[0].details.join("\n"), /g33 pre-update observation gap \(unavailable\)/, "the gap stays on the record of the applied update");
    assert.ok(upgraded.results[0].bmadCompanion.evidence.length, "post-update re-observation carries owner evidence");
    // PJAN-180: a fake installer is not a bmad-method package, so the rollback scope stays whole-tree, and says so.
    assert.ok(upgraded.results[0].details.includes("rollback scope: whole-tree (PJ_BMAD_INSTALLER is not a bmad-method package)"), upgraded.results[0].details.join("\n"));
    assert.equal(readFileSync(join(target, "_bmad", "_config", "g33-mapping.json"), "utf8"), '{"g33":"fixture reference"}\n', "upstream mapping rewrite was restored");
    assert.equal(readFileSync(operatorOverride(target), "utf8"), "operator_override = true\n");
    assert.equal(run(target, ["audit", "--rules", "bmad.g33-companion"]).rules[0].status, "pass");
    assert.equal(run(target, ["audit", "--rules", "bmad.version"]).rules[0].status, "pass");
    checkpoint(`pre-update observe unavailable upgrades and audits pass (${label})`);
  }

  // 2. Post-update verification stays mandatory: the new BMAD still cannot observe -> full rollback.
  {
    const { target, manifestPath } = oldEnrolledProject("post-still-unavailable", "always-unavailable");
    const before = snapshot(target);
    const failed = run(target, ["migrate", "bmad.version"], 1, updateEnv);
    assert.equal(failed.results[0].status, "blocked");
    assert.equal(existsSync(reached), true, "the installer ran before the post-update verification failed");
    rmSync(reached);
    assert.deepEqual(failed.changedFiles, []);
    assert.ok(failed.results[0].details.includes("rollback scope: whole-tree (PJ_BMAD_INSTALLER is not a bmad-method package)"), failed.results[0].details.join("\n"));
    assertUntouched(target, before, "failed post-update observation rolls back the whole tree");
    assert.match(readFileSync(manifestPath, "utf8"), /version:\s*6\.11\.0/);
    checkpoint("post-update observe still failing rolls back, blocked, tree restored");
  }

  // 3. A pre-update observe that ERRORS is still a stop, before the installer runs.
  for (const behavior of ["old-error", "plan-error"]) {
    // Companion absent so the plan is `planned`: only the observe/plan stop itself can block.
    const { target } = oldEnrolledProject(`stop-${behavior}`, behavior, false);
    const before = snapshot(target);
    const preview = run(target, ["migrate", "bmad.version", "--dry-run"], 1);
    assert.equal(preview.results[0].status, "blocked", `${behavior}: dry run is blocked`);
    const blocked = run(target, ["migrate", "bmad.version"], 1, updateEnv);
    assert.equal(blocked.results[0].status, "blocked");
    assert.equal(existsSync(reached), false, `${behavior}: installer must not run`);
    assertUntouched(target, before, `${behavior}: nothing written`);
  }
  checkpoint("pre-update observe error and owner plan error still block before the installer");

  // 4. A pre-update observe CONFLICT is tolerated like an unavailable one, and a first post-update
  //    observe that conflicts until the owner applies is tolerated too.
  for (const behavior of ["old-conflict", "new-conflict-until-applied"]) {
    const { target, manifestPath } = oldEnrolledProject(`conflict-${behavior}`, behavior, behavior === "old-conflict");
    const preview = run(target, ["migrate", "bmad.version", "--dry-run"]);
    assert.equal(preview.results[0].status, "applied", behavior);
    const upgraded = run(target, ["migrate", "bmad.version"], 0, updateEnv);
    assert.equal(upgraded.results[0].status, "applied", behavior);
    rmSync(reached, { force: true });
    assert.match(readFileSync(manifestPath, "utf8"), /version:\s*6\.12\.1/);
  }
  checkpoint("tolerated conflict gaps (pre-update and first post-update observe)");

  // 5. The boundary is not loosened: opted-out-with-retained-state and adapter-not-configured stay blocked.
  {
    const { target } = oldEnrolledProject("boundary-optout", "gap");
    const manifest = JSON.parse(readFileSync(join(target, ".project.json"), "utf8"));
    manifest.bmad.companion.enabled = false;
    put(join(target, ".project.json"), JSON.stringify(manifest));
    const before = snapshot(target);
    assert.equal(run(target, ["migrate", "bmad.version"], 1, updateEnv).results[0].status, "blocked");
    assertUntouched(target, before, "opt-out with retained g33 state");
  }
  {
    const { target } = oldEnrolledProject("boundary-unconfigured", "gap");
    const manifest = JSON.parse(readFileSync(join(target, ".project.json"), "utf8"));
    delete manifest.bmad.companion.adapter;
    put(join(target, ".project.json"), JSON.stringify(manifest));
    const before = snapshot(target);
    const blocked = run(target, ["migrate", "bmad.version"], 1, updateEnv);
    assert.equal(blocked.results[0].status, "blocked");
    assert.match(blocked.results[0].summary, /adapter is not configured/);
    assertUntouched(target, before, "adapter not configured");
    assert.equal(existsSync(reached), false);
  }
  checkpoint("g33BmadUpdateBoundary still blocks opt-out-with-retained-state and unconfigured adapter");

  // 6. Strict callers keep their behavior: the audit does not tolerate the gap.
  {
    const { target } = oldEnrolledProject("audit-strict", "gap");
    assert.notEqual(run(target, ["audit", "--rules", "bmad.g33-companion"]).rules[0].status, "pass");
  }
  checkpoint("audit still treats an unavailable observe as not-pass");
  console.log(`PJAN-179 pre-update gap: ${checks} checkpoint groups passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
