import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createBmadInstallerFixture } from "./helpers/pack-fixture.mjs";

// This fixture proves PJangler's callable/CLI behavior ONLY. It is deliberately
// not an owner installer, owner API guess, or evidence of real g33 integration.
const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pjan-167-companion-"));
const cli = join(root, "dist", "index.js");
const isolatedHome = join(scratch, "home");
const catalog = join(scratch, "catalog");
const adapter = join(scratch, "callable-fixture.mjs");
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
let checks = 0;

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
if(args[0]==='install')writeFileSync(${JSON.stringify(join(scratch, 'updater-reached'))},'upstream invoked');
const run=spawnSync(${JSON.stringify(upstream)},args,{encoding:'utf8'});
if(run.status!==0)process.exit(run.status??1);
const target=args[args.indexOf('--directory')+1];
if(args[0]==='install')writeFileSync(join(target,'_bmad','_config','g33-mapping.json'),'upstream rewrite\\n');
process.stdout.write(run.stdout);
`);
// The wrapper is selected via the existing upstream installer override.
const { chmodSync } = await import("node:fs");
chmodSync(updatingInstaller, 0o755);
put(adapter, `
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
export async function companion(request) {
  const {operation,projectRoot,options}=request;
  if(request.schemaVersion!==1||request.moduleId!=='g33')throw new Error('wrong request contract');
  const content=join(projectRoot,'_bmad','g33','companion.md');
  const mapping=join(projectRoot,'_bmad','_config','g33-mapping.json');
  const expected='PJangler callable fixture companion\\n';
  const mapped='{"g33":"fixture reference"}\\n';
  const valid=existsSync(content)&&readFileSync(content,'utf8')===expected&&existsSync(mapping)&&readFileSync(mapping,'utf8')===mapped;
  const result=(status,summary,evidence=[])=>({schemaVersion:1,status,summary,details:['PJangler fixture only',request.reason],evidence,changedFiles:['fabricated-owner-path']});
  if(options.behavior==='unavailable')return result('unavailable','Owner source unavailable');
  if(options.behavior==='conflict')return result('conflict','Operator mapping conflict');
  if(options.behavior==='throw')throw new Error('Owner fixture threw');
  if(options.behavior==='metadata')return result(operation==='observe'?'installed':'unchanged','Metadata-only claim');
  if(options.behavior==='false-convergence')return result(operation==='observe'?'missing':'unchanged','False convergence',['metadata exists']);
  if(operation==='observe')return result(valid?'installed':'missing',valid?'Content and mappings observed':'Missing content or mapping',valid?['Exact companion bytes verified','Exact mapping bytes verified']:[]);
  if(operation==='plan')return result(valid?'unchanged':'planned',valid?'Companion converged':'Would reconcile fixture companion');
  if(operation!=='apply')throw new Error('unexpected operation');
  if(options.behavior==='no-op-apply')return result('unchanged','Did not actually install');
  for(const [path,text]of [[content,expected],[mapping,mapped]]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
  return result('changed','Applied fixture companion');
}
`);

const env = {
  ...process.env, HOME: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, ".config"), XDG_CACHE_HOME: join(isolatedHome, ".cache"),
  XDG_STATE_HOME: join(isolatedHome, ".local", "state"), XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
  PJ_PROJECT_REGISTRY: join(scratch, "registry.yaml"), PJ_SKILLS_REGISTRY_ROOT: catalog,
  PJ_BMAD_INSTALLER: upstream, PJ_G33_ADAPTER_MODULE: "", PJ_G33_ADAPTER_EXPORT: "",
  PLANE_API_KEY: "", PLANE_DEFAULT_API_KEY: "", PLANE_33GOD_API_KEY: "", PLANE_AUTOMATICAI_API_KEY: "", PLANE_INTELLIFORIA_API_KEY: "", PLANE_LASERTOAST_API_KEY: "",
  TRELLO_KEY: "", TRELLO_API_KEY: "", TRELLO_TOKEN: "", HERMES_FLEET_ENV: join(scratch, "no-fleet.env"),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};
put(join(isolatedHome, ".cache", "pjangler", "bmad-dist-tags.json"), JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.12.0", next: "6.12.0" } }));

function project(name, companion, enrolled = true) {
  const target = join(scratch, name);
  mkdirSync(target);
  put(join(target, ".project.json"), JSON.stringify({
    project_id: name, project_name: name,
    ...(enrolled ? { ticket_provider: { type: "plane", state: "linked", workspace: "33god", board_id: "fixture-board" } } : {}),
    bmad: { companion },
  }));
  put(join(target, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(target, ".agents", "skills", "bmad-fixture", "SKILL.md"), "Native BMAD CLI fixture\n");
  return target;
}
function run(target, args, expected = 0, overrides = {}, cliPath = cli) {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], { cwd: target, env: { ...env, ...overrides }, encoding: "utf8", timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.trim(), "CLI must produce real JSON");
  return JSON.parse(result.stdout);
}
const recipe = ["recipe", "run", "bmad"];
const configured = (options = {}) => ({ adapter: { module: adapter, exportName: "companion", options } });
function checkpoint(label) { checks++; console.log(`PASS ${label}`); }

try {
  const target = project("eligible", configured());
  const beforePreview = snapshot(target);
  const preview = run(target, [...recipe, "--dry-run"]);
  assert.equal(preview.bmadCompanion.status, "planned");
  assert.deepEqual(snapshot(target), beforePreview, "whole target including every file/directory must remain byte identical in preview");
  checkpoint("actual top-level recipe CLI whole-target no-write preview");

  const installed = run(target, recipe);
  assert.equal(installed.ok, true);
  assert.ok(["changed", "unchanged"].includes(installed.bmadCompanion.status));
  assert.ok(installed.changedFiles.includes(join(target, "_bmad", "g33", "companion.md")));
  assert.ok(installed.bmadCompanion.evidence.length);
  assert.equal(installed.bmadCompanion.schemaVersion, 1);
  assert.ok(!installed.bmadCompanion.changedFiles.includes("fabricated-owner-path"));
  assert.equal(existsSync(join(target, ".agents", "skills", "g33", "SKILL.md")), false, "reference-only fixture never synthesizes a SKILL");
  const native = join(target, ".agents", "skills", "bmad-help", "SKILL.md");
  const override = join(target, "_bmad", "custom", "operator.toml");
  put(native, "Operator protected native BMAD customization\n");
  put(override, "operator_override = true\n");
  const repeatedBefore = snapshot(target);
  const repeated = run(target, recipe);
  assert.equal(repeated.bmadCompanion.status, "unchanged");
  assert.deepEqual(repeated.changedFiles, []);
  assert.deepEqual(snapshot(target), repeatedBefore);
  checkpoint("repeat convergence and protected native BMAD/custom override bytes");

  // The v1 seam has no owner-supported pre-update protection handoff. Refuse
  // before the known-destructive upstream update, retaining native bytes and
  // mappings even if the optional owner is unavailable or explicitly disabled.
  const manifestPath = join(target, "_bmad", "_config", "manifest.yaml");
  put(manifestPath, readFileSync(manifestPath, "utf8").replace("version: 6.12.0", "version: 6.11.0") + "  - name: g33\n");
  const updateBefore = snapshot(target);
  const updatePreview = run(target, ["migrate", "bmad.version", "--dry-run"], 1);
  assert.equal(updatePreview.results[0].status, "blocked");
  assert.equal(updatePreview.results[0].bmadCompanion.status, "conflict");
  assert.deepEqual(snapshot(target), updateBefore);
  for (const options of [{}, {behavior:"unavailable"}, {behavior:"throw"}]) {
    const configuredManifest = JSON.parse(readFileSync(join(target, ".project.json"), "utf8"));
    configuredManifest.bmad.companion = configured(options);
    put(join(target, ".project.json"), JSON.stringify(configuredManifest));
    const before = snapshot(target);
    const upgraded = run(target, ["migrate", "bmad.version"], 1, { PJ_BMAD_INSTALLER: updatingInstaller });
    assert.equal(upgraded.results[0].status, "blocked");
    assert.deepEqual(upgraded.changedFiles, []);
    assert.equal(existsSync(join(scratch,"updater-reached")),false,"upstream updater must not run before preservation handoff");
    assert.deepEqual(snapshot(target), before);
    assert.equal(readFileSync(native, "utf8"), "Operator protected native BMAD customization\n");
    assert.equal(readFileSync(override, "utf8"), "operator_override = true\n");
    assert.equal(readFileSync(join(target, "_bmad", "_config", "g33-mapping.json"), "utf8"), '{"g33":"fixture reference"}\n');
  }
  // Scaffold repair must refuse before retired-state eviction too.
  const retired = join(target, ".agents", "skills", "bmad-retired-pack");
  const {symlinkSync} = await import("node:fs");
  symlinkSync(join(scratch, "absent-pack"), retired);
  rmSync(join(target, "_bmad", "core", "config.yaml"));
  const repairBefore = snapshot(target);
  assert.equal(run(target, ["migrate", "bmad.scaffold"], 1).results[0].status, "blocked");
  assert.deepEqual(snapshot(target), repairBefore);
  assert.equal(lstatSync(retired).isSymbolicLink(), true);
  put(join(target, "_bmad", "core", "config.yaml"), 'project_name: "eligible"\n');
  const configuredManifest = JSON.parse(readFileSync(join(target, ".project.json"), "utf8"));
  configuredManifest.bmad.companion = configured();
  put(join(target, ".project.json"), JSON.stringify(configuredManifest));
  put(manifestPath, readFileSync(manifestPath, "utf8").replace("version: 6.11.0", "version: 6.12.0"));
  checkpoint("forced BMAD update and scaffold repair refused before mutation; original native bytes and mappings retained");

  rmSync(retired);
  const availableAudit = run(target, ["audit", "--rules", "bmad.g33-companion"]);
  assert.equal(availableAudit.rules[0].status, "pass");
  const optedOut = project("optout", { enabled: false, adapter: { module: "./missing.mjs", exportName: "missing" } });
  const optout = run(optedOut, [...recipe, "--dry-run"], 0, { PJ_G33_ADAPTER_MODULE: adapter, PJ_G33_ADAPTER_EXPORT: "companion" });
  assert.equal(optout.bmadCompanion.status, "disabled");
  const existingManifest = JSON.parse(readFileSync(join(target, ".project.json"), "utf8"));
  existingManifest.bmad.companion.enabled = false;
  put(join(target, ".project.json"), JSON.stringify(existingManifest));
  const existingBefore = snapshot(target);
  assert.equal(run(target, recipe).bmadCompanion.status, "disabled");
  assert.deepEqual(snapshot(target), existingBefore, "opt-out preserves previously installed companion and all overrides");
  put(manifestPath, readFileSync(manifestPath, "utf8").replace("version: 6.12.0", "version: 6.11.0"));
  const disabledUpdateBefore = snapshot(target);
  assert.equal(run(target, ["migrate", "bmad.version"], 1).results[0].status, "blocked");
  assert.deepEqual(snapshot(target), disabledUpdateBefore);
  rmSync(join(target,"_bmad","g33"),{recursive:true});
  const declarationOnlyBefore=snapshot(target);
  assert.equal(run(target,["migrate","bmad.version"],1).results[0].status,"blocked");
  assert.deepEqual(snapshot(target),declarationOnlyBefore,"retained module declaration protects mappings even when content is absent");
  checkpoint("explicit disabled override wins over eligible enrollment and host adapter");

  // Declaration evidence is independent of which format supplies upstream
  // module selection. No tree is needed, and opt-out cannot erase evidence.
  for (const layout of ["toml-only", "yaml-without-g33", "yaml-only-g33"]) {
    const subject = project(`retained-${layout}`, { enabled: false });
    const importMarker = join(scratch, `import-${layout}`);
    const refusingAdapter = join(scratch, `refusing-${layout}.mjs`);
    put(refusingAdapter, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(importMarker)},'imported'); export function companion(){throw new Error('must not import');}`);
    const manifest = JSON.parse(readFileSync(join(subject, ".project.json"), "utf8"));
    manifest.bmad.companion.adapter = { module: refusingAdapter, exportName: "companion" };
    put(join(subject, ".project.json"), JSON.stringify(manifest));
    put(join(subject, "_bmad", "config.toml"), `[core]\nproject_name = "retained-${layout}"\n[modules.bmm]\n${layout === "yaml-only-g33" ? "" : "[modules.g33]\n"}`);
    if (layout !== "toml-only") put(join(subject, "_bmad", "_config", "manifest.yaml"), `installation:\n  version: 6.11.0\nmodules:\n  - name: core\n  - name: bmm\n${layout === "yaml-only-g33" ? "  - name: g33\n" : ""}`);
    const protectedNative = join(subject, ".agents", "skills", "bmad-help", "SKILL.md");
    const protectedOverride = join(subject, "_bmad", "custom", "operator.toml");
    const protectedMapping = join(subject, "_bmad", "_config", "g33-mapping.json");
    put(protectedNative, "Operator protected native BMAD customization\n");
    put(protectedOverride, "operator_override = true\n");
    put(protectedMapping, '{"g33":"operator mapping"}\n');
    chmodSync(protectedNative, 0o640);
    chmodSync(protectedOverride, 0o600);
    chmodSync(protectedMapping, 0o640);
    symlinkSync("absent-pack", join(subject, ".agents", "skills", "bmad-retired-pack"));
    symlinkSync("operator.toml", join(subject, "_bmad", "custom", "operator-link"));
    const before = snapshot(subject);
    for (const rule of ["bmad.scaffold", "bmad.version"]) {
      for (const preview of [true, false]) {
        // Version currency has no installed version without YAML, so that
        // path is a safe no-op. The disagreement case exercises update refusal.
        const noVersion = layout === "toml-only" && rule === "bmad.version";
        const result = run(subject, ["migrate", rule, ...(preview ? ["--dry-run"] : [])], noVersion ? 0 : 1,
          { PJ_BMAD_INSTALLER: updatingInstaller });
        assert.equal(result.results[0].status, noVersion ? "noop" : "blocked");
        if (!noVersion) assert.equal(result.results[0].bmadCompanion.status, "conflict");
        assert.deepEqual(result.changedFiles, []);
        assert.deepEqual(snapshot(subject), before, `${layout}/${rule}/${preview}: bytes, modes and links retained`);
        assert.equal(existsSync(join(scratch, "updater-reached")), false);
        assert.equal(existsSync(importMarker), false);
      }
    }
  }
  checkpoint("12 TOML-only and YAML/TOML disagreement repair/update preview/apply preservation cases; no updater/import/eviction");

  const ordinary = project("ordinary-33GOD-path", configured(), false);
  assert.equal(run(ordinary, [...recipe, "--dry-run"]).bmadCompanion.status, "disabled");
  const optedIn = project("optin", { ...configured(), enabled: true }, false);
  assert.equal(run(optedIn, [...recipe, "--dry-run"]).bmadCompanion.status, "planned");
  const impostor = project("impostor", configured());
  const impostorManifest = JSON.parse(readFileSync(join(impostor, ".project.json"), "utf8"));
  delete impostorManifest.project_id;
  put(join(impostor, ".project.json"), JSON.stringify(impostorManifest));
  assert.equal(run(impostor, [...recipe, "--dry-run"]).bmadCompanion.status, "disabled");
  checkpoint("non33god default off, explicit opt-in, real identity required");

  const unavailable = project("unavailable", {});
  const fresh = run(unavailable, recipe);
  assert.equal(fresh.ok, true, "missing optional installer must not fail fresh required BMAD initialization");
  assert.equal(fresh.bmadCompanion.status, "unavailable");
  assert.ok(existsSync(join(unavailable, "_bmad", "_config", "manifest.yaml")));
  const optionalAudit = run(unavailable, ["audit", "--rules", "bmad.g33-companion"]);
  assert.equal(optionalAudit.ok, true);
  assert.equal(optionalAudit.rules[0].status, "warn");
  const repair = run(unavailable, ["migrate", "bmad.g33-companion"], 1);
  assert.equal(repair.results[0].status, "partial");
  const missingSource = project("missing-source", { adapter: { module: "./missing.mjs", exportName: "owner" } });
  assert.equal(run(missingSource, [...recipe, "--dry-run"]).bmadCompanion.status, "unavailable");
  checkpoint("fresh BMAD survives absent optional installer, audit warns, explicit repair truthful");

  for (const behavior of ["unavailable", "conflict", "throw", "metadata", "false-convergence", "no-op-apply"]) {
    const subject = project(`owner-${behavior}`, configured({ behavior }));
    const expected = ["unavailable", "conflict"].includes(behavior) ? behavior : "error";
    const payload = run(subject, recipe);
    assert.equal(payload.ok, true);
    assert.equal(payload.bmadCompanion.status, expected);
    assert.equal(existsSync(join(subject, "_bmad", "g33")), false);
  }
  checkpoint("unavailable/conflict/throw/metadata-only/false convergence/no-op application stay truthful and optional");

  // Relative source and installed-package selection are portable; no production
  // hardcoded checkout path or assumed owner export is needed.
  const relative = project("relative", { enabled: true, adapter: { module: "./integration.mjs", exportName: "companion" } }, false);
  put(join(relative, "integration.mjs"), readFileSync(adapter));
  assert.equal(run(relative, recipe).bmadCompanion.status, "changed");
  for (const [label, specifier, exports] of [
    ["unconditional", "g33-callable-fixture", "./index.mjs"],
    ["import-only", "g33-callable-fixture", {import:"./index.mjs"}],
    ["import-subpath", "g33-callable-fixture/companion", {"./companion":{import:"./index.mjs"}}],
    ["dual", "g33-callable-fixture", {import:"./index.mjs",require:"./require.cjs"}],
  ]) {
    const packaged = project(`packaged-${label}`, {adapter:{module:specifier,exportName:"companion"}});
    put(join(packaged, "node_modules", "g33-callable-fixture", "package.json"), JSON.stringify({type:"module",exports}));
    put(join(packaged, "node_modules", "g33-callable-fixture", "index.mjs"), readFileSync(adapter));
    put(join(packaged, "node_modules", "g33-callable-fixture", "require.cjs"), "throw new Error('require condition selected incorrectly');");
    const before = snapshot(packaged);
    assert.equal(run(packaged, [...recipe,"--dry-run"]).bmadCompanion.status, "planned");
    assert.deepEqual(snapshot(packaged), before);
  }
  const fallbackRoot=join(scratch,"fallback-cli");
  const fallbackCli=join(fallbackRoot,"dist","index.js");
  put(fallbackCli,readFileSync(cli));
  put(join(fallbackRoot,"package.json"),JSON.stringify({name:"@delorenj/pjangler",type:"module"}));
  symlinkSync(join(root,"templates"),join(fallbackRoot,"templates"));
  for(const name of Object.keys(JSON.parse(readFileSync(join(root,"package.json"),"utf8")).dependencies)) {
    const path=join(fallbackRoot,"node_modules",name); mkdirSync(dirname(path),{recursive:true}); symlinkSync(join(root,"node_modules",name),path);
  }
  put(join(fallbackRoot,"node_modules","g33-fallback-fixture","package.json"),JSON.stringify({type:"module",exports:{"./companion":{import:"./index.mjs",require:"./wrong.cjs"}}}));
  put(join(fallbackRoot,"node_modules","g33-fallback-fixture","index.mjs"),readFileSync(adapter));
  put(join(fallbackRoot,"node_modules","g33-fallback-fixture","wrong.cjs"),"throw new Error('wrong fallback condition');");
  const fallback=project("fallback-package",{adapter:{module:"g33-fallback-fixture/companion",exportName:"companion"}});
  assert.equal(run(fallback,recipe).bmadCompanion.status,"unavailable","project cannot resolve fallback package before relocated PJangler is used");
  const fallbackBefore=snapshot(fallback);
  assert.equal(run(fallback,[...recipe,"--dry-run"],0,{},fallbackCli).bmadCompanion.status,"planned");
  assert.deepEqual(snapshot(fallback),fallbackBefore);
  const unresolved = project("resolution-errors", {adapter:{module:"g33-nonexistent-package/subpath",exportName:"companion"}});
  const missing = run(unresolved,[...recipe,"--dry-run"]).bmadCompanion;
  assert.equal(missing.status,"unavailable");
  assert.match(missing.details.join("\n"),/Project ESM resolution failed:[\s\S]*PJangler ESM resolution failed:/);
  checkpoint("relative source, ESM import-only/subpath/dual package resolution and both error contexts through actual recipe CLI");

  for (const field of ["bmad", "companion", "adapter", "options"]) {
    for (const [label, value] of [["false",false],["array",[]],["string","invalid"],["null",null]]) {
      const subject = project(`invalid-${field}-${label}`, configured());
      const manifest = JSON.parse(readFileSync(join(subject,".project.json"),"utf8"));
      if(field === "bmad") manifest.bmad=value;
      if(field === "companion") manifest.bmad.companion=value;
      if(field === "adapter") manifest.bmad.companion.adapter=value;
      if(field === "options") manifest.bmad.companion.adapter.options=value;
      put(join(subject,".project.json"),JSON.stringify(manifest));
      const importMarker = join(subject,"import-reached");
      const unsafeModule = join(scratch,`invalid-${field}-${label}.mjs`);
      put(unsafeModule,`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(importMarker)},'imported'); export {companion} from ${JSON.stringify(adapter)};`);
      if(field === "options") {
        manifest.bmad.companion.adapter.module=unsafeModule;
        put(join(subject,".project.json"),JSON.stringify(manifest));
      }
      const before = snapshot(subject);
      const payload=run(subject,[...recipe,"--dry-run"],0,{PJ_G33_ADAPTER_MODULE:unsafeModule,PJ_G33_ADAPTER_EXPORT:"companion"});
      assert.equal(payload.bmadCompanion.status,"error");
      assert.match(payload.bmadCompanion.details.join("\n"),/must be an object when present/);
      assert.deepEqual(snapshot(subject),before);
      assert.equal(existsSync(importMarker),false);
    }
  }
  const validOptions={boolean:false,array:["owner-specific",3,null],nested:{source:"./artifact",version:7}};
  const optionsModule=join(scratch,"valid-options.mjs");
  put(optionsModule,`import assert from 'node:assert/strict'; export {companion}; function companion(req){assert.deepEqual(req.options,${JSON.stringify(validOptions)}); return {schemaVersion:1,status:req.operation==='observe'?'missing':'planned',summary:'options retained',details:[],evidence:[]};}`);
  const optionsTarget=project("valid-options",{adapter:{module:optionsModule,exportName:"companion",options:validOptions}});
  assert.equal(run(optionsTarget,[...recipe,"--dry-run"]).bmadCompanion.summary,"options retained");
  // Positive controls: absent optional containers and uncoerced nested options.
  const absent = project("absent-containers", configured());
  const absentManifest=JSON.parse(readFileSync(join(absent,".project.json"),"utf8"));
  delete absentManifest.bmad; put(join(absent,".project.json"),JSON.stringify(absentManifest));
  assert.equal(run(absent,[...recipe,"--dry-run"],0,{PJ_G33_ADAPTER_MODULE:adapter,PJ_G33_ADAPTER_EXPORT:"companion"}).bmadCompanion.status,"planned"); // defaults supplied below
  checkpoint("all 16 malformed container variants rejected before import, absent optional containers valid");

  for (const [operation, mutation] of [["import","link"],["import","mode"],["plan","link"],["plan","mode"],["apply","link"]]) {
    const subject=project(`snapshot-${operation}-${mutation}`, {});
    const module=join(scratch,`snapshot-${operation}-${mutation}.mjs`);
    const dangling=join(subject,"dangling-link");
    const mutate=mutation==='link' ? `symlinkSync('nonexistent-target',${JSON.stringify(dangling)});` : `chmodSync(${JSON.stringify(subject)},0o700);`;
    chmodSync(subject,0o755);
    put(module,`import {symlinkSync,chmodSync} from 'node:fs';
      ${operation==='import'?mutate:''}
      export function companion(req){
        if(req.operation===${JSON.stringify(operation)}){${operation==='import'?'':mutate} ${operation==='apply'?"throw new Error('apply failed after write');":''}}
        return {schemaVersion:1,status:req.operation==='observe'?'missing':req.operation==='plan'?'planned':'changed',summary:'boundary fixture',details:[],evidence:[]};
      }`);
    const manifest=JSON.parse(readFileSync(join(subject,".project.json"),"utf8"));
    manifest.bmad.companion={adapter:{module,exportName:"companion"}};
    put(join(subject,".project.json"),JSON.stringify(manifest));
    const before=snapshot(subject);
    const payload=run(subject,operation==='apply'?recipe:[...recipe,"--dry-run"]);
    assert.equal(payload.bmadCompanion.status,"error");
    const changed=mutation==='link'?dangling:subject;
    assert.ok(payload.bmadCompanion.changedFiles.includes(changed),JSON.stringify(payload.bmadCompanion));
    assert.notDeepEqual(snapshot(subject),before,"independent fixture snapshot detects the violation");
    if(operation!=='apply')assert.match(payload.bmadCompanion.details.join("\n"),/no-write/);
  }
  checkpoint("import/plan dangling links and root chmod rejected; failed apply retains dangling-link write inventory");
  console.log(`PJAN-167 callable CLI fixture: ${checks} groups passed; actual owner installer integration BLOCKED (owner API/artifact unavailable).`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
