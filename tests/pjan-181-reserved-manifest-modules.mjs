import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { createBmadInstallerFixture } from "./helpers/pack-fixture.mjs";

// PJAN-181: a legacy manifest "module" named like a BMAD-owned directory
// (`- name: custom`, version null, source unknown) makes bmad-method's
// _removeDeselectedModules delete _bmad/custom -- every team override and custom
// workflow -- and then crash. The pre-install step must drop that entry (and only
// that entry, byte-for-byte elsewhere) inside the update's backup window.
// The installer fixture mimics _removeDeselectedModules, so these assertions fail
// without the fix. Cold CI has no ~/code/skillex; everything lives in /tmp scratch.
const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join("/tmp", "pjan-181-reserved-"));
const cli = join(root, "dist", "index.js");
const isolatedHome = join(scratch, "home");
const catalog = join(scratch, "catalog");
const adapter = join(scratch, "adapter.mjs");
const seen = join(scratch, "installer-saw.json");
const failOnceState = join(scratch, "fail-once");
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
// Records what the installer was handed, then delegates to the fixture.
const recorder = join(scratch, "recording-installer.mjs");
put(recorder, `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
if(args[0]==='install'){
  const target=args[args.indexOf('--directory')+1];
  writeFileSync(${JSON.stringify(seen)},JSON.stringify({manifest:readFileSync(join(target,'_bmad','_config','manifest.yaml'),'utf8'),customExists:existsSync(join(target,'_bmad','custom'))}));
}
const run=spawnSync(${JSON.stringify(upstream)},args,{encoding:'utf8'});
process.stderr.write(run.stderr);
process.stdout.write(run.stdout);
process.exit(run.status??1);
`);
chmodSync(recorder, 0o755);

put(adapter, `
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
export async function companion(request) {
  const {operation,projectRoot}=request;
  const content=join(projectRoot,'_bmad','g33','companion.md');
  const mapping=join(projectRoot,'_bmad','_config','g33-mapping.json');
  const expected='PJangler reserved-module fixture companion\\n';
  const mapped='{"g33":"fixture reference"}\\n';
  const valid=existsSync(content)&&readFileSync(content,'utf8')===expected&&existsSync(mapping)&&readFileSync(mapping,'utf8')===mapped;
  const result=(status,summary,evidence=[])=>({schemaVersion:1,status,summary,details:['PJangler fixture only',request.reason],evidence});
  if(operation==='observe')return result(valid?'installed':'missing',valid?'Content and mappings observed':'Missing content or mapping',valid?['Exact companion bytes verified','Exact mapping bytes verified']:[]);
  if(operation==='plan')return result(valid?'unchanged':'planned',valid?'Companion converged':'Would reconcile fixture companion');
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

function run(target, args, expected, overrides = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: target, env: { ...env, ...overrides }, encoding: "utf8", timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  if (expected !== undefined) assert.equal(result.status, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.trim(), "CLI must produce real JSON");
  return JSON.parse(result.stdout);
}

const LEGACY_CUSTOM = [
  "  - name: custom",
  "    version: null",
  "    installDate: 2026-03-08T19:53:52.586Z",
  "    lastUpdated: 2026-07-13T13:21:25.699Z",
  "    source: unknown",
  "    npmPackage: null",
  "    repoUrl: null",
  "",
].join("\n");
const manifestText = ({ g33, custom = LEGACY_CUSTOM }) => [
  "installation:", "  version: 6.11.0", "  installDate: 2026-03-08T19:53:52.586Z",
  "modules:",
  "  - name: core", "    version: 6.11.0", "    source: built-in", "    npmPackage: null",
  custom.replace(/\n$/, ""),
  ...(g33 ? ["  - name: g33", "    version: 1.0.0", "    source: custom"] : []),
  "ides:", "  - claude-code", "  - codex", "",
].filter((line) => line !== "").join("\n");
const WITHOUT_CUSTOM = (g33) => manifestText({ g33, custom: "" });
const CUSTOM_FILES = {
  "config.toml": "[workflow]\nteam = \"override\"\n",
  "bmad-build.toml": "persistent_facts = [\"team fact\"]\n",
  "workflows/release/workflow.md": "# team release workflow\n",
};

/** An installed project at BMAD 6.11.0 with `_bmad/custom` content and a manifest built by `manifest`. */
function project(name, { g33 = false, manifest = manifestText({ g33 }) } = {}) {
  const target = join(scratch, name);
  mkdirSync(target);
  put(join(target, ".project.json"), JSON.stringify({
    project_id: name, project_name: name,
    ticket_provider: { type: "plane", state: "linked", workspace: "33god", board_id: "fixture-board" },
    // A linked 33god project defaults to g33 enrolment; opting out is what selects the plain (no whole-tree backup) path.
    bmad: { companion: g33 ? { adapter: { module: adapter, exportName: "companion", options: {} } } : { enabled: false } },
  }));
  put(join(target, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(target, ".agents", "skills", "bmad-fixture", "SKILL.md"), "Native BMAD CLI fixture\n");
  assert.equal(run(target, ["recipe", "run", "bmad"], 0).ok, true);
  put(join(target, "_bmad", "_config", "manifest.yaml"), manifest);
  for (const [file, text] of Object.entries(CUSTOM_FILES)) put(join(target, "_bmad", "custom", file), text);
  return { target, manifestPath: join(target, "_bmad", "_config", "manifest.yaml") };
}
const customIntact = (target) => {
  for (const [file, text] of Object.entries(CUSTOM_FILES)) {
    assert.equal(readFileSync(join(target, "_bmad", "custom", file), "utf8"), text, `_bmad/custom/${file} must survive`);
  }
};
const recorded = () => JSON.parse(readFileSync(seen, "utf8"));
const recording = { PJ_BMAD_INSTALLER: recorder };

try {
  for (const g33 of [false, true]) {
    const flavor = g33 ? "g33 path (whole-tree backup)" : "plain path";

    // 1. Dry run reports the eviction and writes nothing.
    {
      const { target, manifestPath } = project(`dry-${g33}`, { g33 });
      const before = snapshot(target);
      const preview = run(target, ["migrate", "bmad.version", "--dry-run"], 0);
      assert.equal(preview.results[0].status, "applied");
      assert.match(preview.results[0].details.join("\n"), /would remove legacy manifest module "custom" \(no version or source\)/);
      assert.deepEqual(snapshot(target), before, "dry run writes nothing");
      assert.match(readFileSync(manifestPath, "utf8"), /- name: custom/);
      rmSync(seen, { force: true });
      checkpoint(`bmad.version dry run reports the eviction without writing (${flavor})`);
    }

    // 2. A real run: the installer is handed the manifest minus the entry, byte-for-byte otherwise,
    //    and _bmad/custom survives the (fixture-mimicked) deselected-module removal.
    {
      const { target, manifestPath } = project(`real-${g33}`, { g33 });
      const upgraded = run(target, ["migrate", "bmad.version"], 0, recording);
      assert.equal(upgraded.results[0].status, "applied", JSON.stringify(upgraded.results[0]));
      assert.match(upgraded.results[0].details.join("\n"), /removed legacy manifest module "custom" \(no version or source\)/);
      assert.equal(recorded().manifest, WITHOUT_CUSTOM(g33), "installer saw the manifest with only the custom entry removed");
      assert.equal(recorded().customExists, true);
      assert.match(readFileSync(manifestPath, "utf8"), /version:\s*6\.12\.\d+/, "BMAD upgraded");
      customIntact(target);
      assert.equal(existsSync(join(target, "_bmad", "custom", ".gitignore")), false, "fixture crash path was not taken");
      checkpoint(`bmad.version evicts the legacy custom entry and keeps _bmad/custom (${flavor})`);
    }

    // 3. A failed update restores the manifest, entry included.
    {
      const { target, manifestPath } = project(`fail-${g33}`, { g33 });
      const original = readFileSync(manifestPath, "utf8");
      rmSync(failOnceState, { force: true });
      const failed = run(target, ["migrate", "bmad.version"], 1, { ...recording, PJ_BMAD_FIXTURE_FAIL_ONCE_STATE: failOnceState });
      assert.equal(failed.results[0].status, "blocked");
      assert.equal(readFileSync(manifestPath, "utf8"), original, "failed update restores the manifest byte-for-byte");
      customIntact(target);
      checkpoint(`a failed update restores the evicted entry (${flavor})`);
    }
  }

  // 4. bmad.scaffold shares the step (plain installed project, plain path).
  {
    const { target } = project("scaffold-real");
    // Make the scaffold rule find work to do: drop a sentinel file the installer rewrites.
    rmSync(join(target, "_bmad", "core", "config.yaml"), { force: true });
    const result = run(target, ["migrate", "bmad.scaffold"], undefined, recording);
    assert.equal(result.results[0].status, "applied", JSON.stringify(result.results[0]));
    assert.equal(recorded().manifest, WITHOUT_CUSTOM(false));
    assert.match(result.results[0].details.join("\n"), /removed legacy manifest module "custom"/);
    customIntact(target);
    checkpoint("bmad.scaffold evicts the legacy custom entry too");
  }

  // 5. Narrow on purpose: a reserved name WITH a version or source is not ours to drop,
  //    and ordinary modules without one are untouched.
  for (const [label, custom] of [
    ["a versioned custom entry", "  - name: custom\n    version: 1.2.3\n    source: unknown\n"],
    ["a custom entry with a real source", "  - name: custom\n    version: null\n    source: external\n"],
    ["a non-reserved name with null version/source", "  - name: tiller\n    version: null\n    source: unknown\n"],
  ]) {
    const { target, manifestPath } = project(`keep-${label.replace(/\W+/g, "-")}`, { manifest: manifestText({ g33: false, custom }) });
    const original = readFileSync(manifestPath, "utf8");
    rmSync(seen, { force: true });
    run(target, ["migrate", "bmad.version"], undefined, recording);
    assert.equal(recorded().manifest, original, `${label} is left alone`);
  }
  checkpoint("entries with a version/source, or outside the reserved set, are never dropped");

  // 6. Every reserved name is covered, and a manifest with nothing to drop is not rewritten.
  for (const name of ["custom", "scripts", "_config", "_memory", "memory", "render"]) {
    const entry = `  - name: ${name}\n    version: null\n    source: unknown\n`;
    const { target } = project(`reserved-${name}`, { manifest: manifestText({ g33: false, custom: entry }) });
    rmSync(seen, { force: true });
    const preview = run(target, ["migrate", "bmad.version", "--dry-run"], 0);
    assert.match(preview.results[0].details.join("\n"), new RegExp(`would remove legacy manifest module "${name}"`));
  }
  checkpoint("all six BMAD-reserved names are evicted when they carry no version/source");

  // 7. PJAN-185: a comment inside the modules list used to hide the legacy entry (split lines
  //    keep their line ending, which the blank/comment test never spanned). End to end through
  //    the bmad.version parity rule: the installer is handed the manifest minus the entry with
  //    every comment intact, and _bmad/custom survives.
  {
    const head = ["installation:", "  version: 6.11.0", "modules:", "  # the core module",
      "  - name: core", "    version: 6.11.0", "    source: built-in", "    npmPackage: null", "  # legacy entry below"];
    const manifest = [...head, ...LEGACY_CUSTOM.replace(/\n$/, "").split("\n"), "ides:", "  - claude-code", "  - codex"].join("\n");
    // Same manifest with only the legacy `custom` lines gone; both comments survive.
    const expected = [...head, "ides:", "  - claude-code", "  - codex"].join("\n");
    const { target } = project("commented-manifest", { g33: false, manifest });
    const preview = run(target, ["migrate", "bmad.version", "--dry-run"], 0);
    assert.match(preview.results[0].details.join("\n"), /would remove legacy manifest module "custom" \(no version or source\)/);
    rmSync(seen, { force: true });
    const upgraded = run(target, ["migrate", "bmad.version"], 0, recording);
    assert.equal(upgraded.results[0].status, "applied", JSON.stringify(upgraded.results[0]));
    assert.equal(recorded().manifest, expected, "the installer saw the manifest minus only the legacy entry, comments intact");
    assert.equal(recorded().customExists, true);
    customIntact(target);
    checkpoint("a comment inside modules: no longer blocks the legacy eviction (end to end)");
  }

  console.log(`PJAN-181 reserved manifest modules: ${checks} checkpoint groups passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
