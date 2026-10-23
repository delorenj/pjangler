import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { snapshotTree, type TreeSnapshot } from "../src/utils/tree-diff";
import {
  G33_BRIDGE_ADAPTER, G33_OWNED_SURFACES, G33_SKILL, runBmadUpdateWithCompanionPreservation,
} from "../src/bmad/companion";
import {
  BMAD_BACKUP_TEMP_ROOTS, BMAD_HANDLER_FILES, captureScopedBackup, deriveBmadUpdateScope, parseInstallerDirectoryLines, restoreScopedBackup,
  within, type BmadInstallerPackage, type BmadUpdateScope,
} from "../src/bmad/update-scope";
import { installerFingerprint, VERIFIED_BMAD_INSTALLERS } from "../src/bmad/verified-installers";
import {
  BMAD_INSTALLER_VERSION, bmadInstallerArgs, bmadUpgradeChannelArgs, invokeBmadInstallerProcess, resolveBmadInstallerPackage,
} from "../src/parity/rules";
import { SUPPORTED_BMAD_TOOLS } from "../src/recipes/supported-clis";

// PJAN-180 REAL-INSTALLER ORACLE (network/cache-backed; fails, never skips).
//
// 1. Every fingerprint in VERIFIED_BMAD_INSTALLERS reproduces from its version,
//    and the production pin is listed (bumping the pin without verifying fails).
// 2. For each scenario the real installer's whole-tree diff stays inside the
//    declared surface (A ∪ C ∪ absent ancestors ∪ moved C subtrees) and never
//    touches B. Each oracle mutation (a derivation missing one rule) must be
//    caught as an escape.
// 3. Restore round-trips: capture, real installer, restoreScopedBackup ->
//    the whole tree is byte-identical to before.
// 4. End to end through runBmadUpdateWithCompanionPreservation with the real
//    installer, a real v1 bridge adapter from a catalog, and a real writer process.
//
// Usage: node tests/pjan-180-surface-oracle.mjs [--version <v>] [--print-fingerprint]
const argv = process.argv.slice(2);
const only = argv.includes("--version") ? argv[argv.indexOf("--version") + 1] : undefined;
const printFingerprint = argv.includes("--print-fingerprint");
if (argv.includes("--version") && !only) throw new Error("--version needs a value");

const scratch = realpathSync(mkdtempSync("/tmp/pjan-180-oracle-"));
const home = join(scratch, "home");
process.env.HOME = home;
process.env.XDG_STATE_HOME = join(scratch, "state");
process.env.XDG_CONFIG_HOME = join(scratch, "config");
process.env.TMPDIR = join(scratch, "tmp");
process.env.GIT_CEILING_DIRECTORIES = "/tmp";
process.env.CI = "true";
process.env.NO_COLOR = "1";
process.env.FORCE_COLOR = "0";
process.env.PJ_G33_ADAPTER_MODULE = "";
process.env.PJ_G33_ADAPTER_EXPORT = "";
delete process.env.PJ_BMAD_INSTALLER;
delete process.env.BMAD_EXTERNAL_MODULES_CACHE;
for (const dir of [home, process.env.XDG_CONFIG_HOME, process.env.TMPDIR]) mkdirSync(dir!, { recursive: true });
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const TOOLS = [...SUPPORTED_BMAD_TOOLS];
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const read = (path: string) => readFileSync(path, "utf8");
const exists = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
let seq = 0;

function fail(message: string): never {
  throw new Error(`PJAN-180 SURFACE ORACLE FAILED: ${message}`);
}

// ---------------------------------------------------------------------------
// The installer under test
// ---------------------------------------------------------------------------

function resolvePackage(version: string): Required<Pick<BmadInstallerPackage, "root" | "entry" | "version">> {
  const pkg = resolveBmadInstallerPackage(version);
  if (!pkg.root || !pkg.entry || !pkg.version) fail(`bmad-method@${version} did not resolve: ${pkg.reason}`);
  return { root: pkg.root, entry: pkg.entry, version: pkg.version };
}

// A g33 owner-bridge fixture served from a scratch catalog (the pjan-178 BRIDGE pattern).
const catalog = join(scratch, "catalog");
for (const name of ["all-skills", "sets", "packs"]) mkdirSync(join(catalog, name), { recursive: true });
put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}');
put(join(catalog, "all-skills", G33_SKILL, "SKILL.md"), `---\nname: ${G33_SKILL}\ndescription: Scratch g33 fixture\n---\n# g33\n`);
put(join(catalog, "all-skills", G33_SKILL, "scripts", "g33_pjangler_bridge.mjs"), `import {existsSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs'; import {dirname,join,resolve} from 'node:path'; import {fileURLToPath} from 'node:url';
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
  for(const [rel,text] of [['_bmad/g33/companion.md','bridge fixture'],...(req.options.behavior==='fail-apply'?[['_bmad/_memory/g33-note.md','g33 note']]:[])]){const p=join(req.projectRoot,rel);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text);}
  if(req.options.behavior==='fail-apply')return result('error','apply failed after writing');
  return result('changed','written');
}`);
process.env.PJ_SKILLS_REGISTRY_ROOT = catalog;

function project(name: string): string {
  const dir = join(scratch, `${name}-${++seq}`);
  put(join(dir, ".project.json"), `${JSON.stringify({ project_id: name, project_name: name }, null, 2)}\n`);
  put(join(dir, "src", "old.ts"), "export const old = 1;\n");
  put(join(dir, "docs", "readme.md"), "readme v1\n");
  return dir;
}

type Pkg = ReturnType<typeof resolvePackage>;

function runInstaller(pkg: Pkg, dir: string, options: { modules?: string[]; extra?: string[] } = {}) {
  return invokeBmadInstallerProcess(dir, options.modules ?? ["bmm"], pkg.version, options.extra ?? [], pkg);
}

function installed(pkg: Pkg, name: string, modules = ["bmm"]): string {
  const dir = project(name);
  const run = runInstaller(pkg, dir, { modules });
  if (!run.ok) fail(`baseline install for ${name} failed: ${run.error}`);
  return dir;
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

const changedKeys = (before: TreeSnapshot, after: TreeSnapshot) =>
  [...new Set([...before.keys(), ...after.keys()])].filter((rel) => rel !== "." && before.get(rel) !== after.get(rel)).sort();

/** Escapes of the real diff from the declared surface, plus every touch of B. */
function escapes(scope: BmadUpdateScope, pre: TreeSnapshot, post: TreeSnapshot, stdout: string): string[] {
  const diff = changedKeys(pre, post);
  const a = scope.installerRoots;
  const bInA = scope.companionRoots.filter((b) => a.some((root) => b !== root && within(b, root)));
  const inA = (rel: string) => a.some((root) => within(rel, root)) && !bInA.some((b) => within(rel, b));
  const inB = (rel: string) => scope.companionRoots.some((root) => within(rel, root)) && !inA(rel);
  const absentPre = (rel: string) => !pre.has(rel);
  // Created ancestors: on the chain from a root's first missing ancestor down to the root.
  const chainRoots = [...a, ...scope.companionRoots, ...scope.structuralPaths];
  const onAbsentChain = (rel: string) => absentPre(rel) && chainRoots.some((root) => within(root, rel));
  const reported = parseInstallerDirectoryLines(stdout);
  const moved = [
    ...scope.structuralPaths.filter((rel) => pre.get(rel)?.startsWith("dir:") && !post.has(rel)),
    ...reported.moved.map((move) => move.to.replace(/^\{project-root\}\/?/, "")),
  ];
  const inMoved = (rel: string) => moved.some((root) => within(rel, root) || (absentPre(rel) && within(root, rel)));
  const out: string[] = [];
  for (const rel of diff) {
    if (inA(rel) || scope.structuralPaths.includes(rel) || onAbsentChain(rel) || inMoved(rel)) {
      if (inB(rel) && !onAbsentChain(rel)) out.push(`B touched: ${rel}`);
      continue;
    }
    out.push(`escape: ${rel}`);
  }
  return out;
}

function assertContained(label: string, scope: BmadUpdateScope, pre: TreeSnapshot, post: TreeSnapshot, stdout: string): void {
  const found = escapes(scope, pre, post, stdout);
  if (found.length) fail(`${label}: the real installer wrote outside the declared surface:\n  ${found.slice(0, 30).join("\n  ")}`);
}

function assertMutationCaught(label: string, mutated: BmadUpdateScope, pre: TreeSnapshot, post: TreeSnapshot, stdout: string): void {
  const found = escapes(mutated, pre, post, stdout);
  if (!found.length) fail(`oracle mutation "${label}" reported no escape: the oracle cannot see that rule`);
}

const without = (scope: BmadUpdateScope, drop: (rel: string) => boolean, field: "installerRoots" | "structuralPaths" = "installerRoots"): BmadUpdateScope =>
  ({ ...scope, [field]: scope[field].filter((rel) => !drop(rel)) });

function platformRoots(pkg: Pkg, ids: string[]): Set<string> {
  const platforms = (YAML.parse(read(join(pkg.root, "tools", "installer", "ide", "platform-codes.yaml"))) as { platforms: Record<string, { installer?: Record<string, string> }> }).platforms;
  const roots = new Set<string>();
  for (const id of ids) {
    for (const field of ["target_dir", "commands_target_dir"]) { const value = platforms[id]?.installer?.[field]; if (value) roots.add(value); }
    for (const file of BMAD_HANDLER_FILES[id] ?? []) roots.add(file);
  }
  return roots;
}

/**
 * One scenario: derive, snapshot, run the real installer, check containment;
 * optionally restore and require a byte-identical round trip.
 */
async function scenario(pkg: Pkg, verified: Record<string, string>, label: string, dir: string, options: {
  modules?: string[]; extra?: string[]; expectFail?: boolean; roundTrip?: boolean;
  run?: () => Promise<{ ok: boolean; stdout: string; error?: string }>;
  mutations?: [string, (scope: BmadUpdateScope) => BmadUpdateScope][];
}) {
  const scope = deriveBmadUpdateScope(dir, { tools: TOOLS, installer: pkg, companionSurfaces: G33_OWNED_SURFACES, verified });
  if (scope.mode !== "declared") fail(`${label}: scope is not declared: ${scope.reason}`);
  const pre = snapshotTree(dir);
  const sb = options.roundTrip ? captureScopedBackup(dir, scope) : undefined;
  const run = options.run ? await options.run() : runInstaller(pkg, dir, { modules: options.modules, extra: options.extra });
  if (Boolean(options.expectFail) === run.ok) fail(`${label}: installer ${run.ok ? "succeeded" : `failed (${run.error})`} unexpectedly`);
  const post = snapshotTree(dir);
  assert.ok(changedKeys(pre, post).length > 0, `${label}: the installer changed something`);
  assertContained(label, scope, pre, post, run.stdout);
  for (const [name, mutate] of options.mutations ?? []) assertMutationCaught(`${name} (${label})`, mutate(scope), pre, post, run.stdout);
  if (sb) {
    const undone = restoreScopedBackup(dir, sb, { companionChanged: "none", installerStdout: run.stdout });
    if (undone.details.some((line) => line.startsWith("rollback incomplete"))) fail(`${label}: ${undone.details.join("\n")}`);
    const restored = snapshotTree(dir);
    const drift = changedKeys(pre, restored);
    if (drift.length) fail(`${label}: restore round-trip left ${drift.length} difference(s): ${drift.slice(0, 20).join(", ")}`);
  }
  return { scope, pre, post, run };
}

/**
 * Run pjangler's exact installer invocation and SIGKILL it, like a crash
 * mid-update, the moment `marker` exists (polled) or stdout matches `stdout`.
 */
function killWhen(pkg: Pkg, dir: string, extra: string[], when: { marker?: string; stdout?: RegExp }): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [pkg.entry, ...bmadInstallerArgs(dir, ["bmm"], extra)],
      { env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let killed = false;
    const kill = () => { if (!killed) { killed = true; child.kill("SIGKILL"); } };
    child.stdout.on("data", (chunk) => { stdout += chunk; if (when.stdout?.test(stdout)) kill(); });
    const poll = setInterval(() => { if (when.marker && existsSync(when.marker)) kill(); }, 2);
    child.on("exit", () => {
      clearInterval(poll);
      done({ ok: !killed, stdout, error: killed ? "killed mid-update" : "installer finished before the kill point was seen" });
    });
  });
}

// ---------------------------------------------------------------------------

try {
  // 1. Fingerprints.
  const listed = Object.entries(VERIFIED_BMAD_INSTALLERS);
  const versions = only ? [only] : [...new Set([BMAD_INSTALLER_VERSION, ...listed.map(([, version]) => version)])];
  if (!only) {
    for (const [fingerprint, version] of listed) {
      const actual = installerFingerprint(resolvePackage(version).root);
      if (actual !== fingerprint) fail(`bmad-method ${version} fingerprint ${actual} does not reproduce the listed ${fingerprint}`);
    }
    const pin = installerFingerprint(resolvePackage(BMAD_INSTALLER_VERSION).root);
    if (!Object.hasOwn(VERIFIED_BMAD_INSTALLERS, pin)) {
      fail(`the production pin bmad-method ${BMAD_INSTALLER_VERSION} (installer ${pin}) is not in VERIFIED_BMAD_INSTALLERS; run mise run bmad:verify-surface ${BMAD_INSTALLER_VERSION}`);
    }
    pass(`fingerprints: ${listed.length} listed installer(s) reproduce and the pin ${BMAD_INSTALLER_VERSION} is verified`);
  }

  for (const version of versions) {
    const pkg = resolvePackage(version);
    const fingerprint = installerFingerprint(pkg.root);
    const verified = { [fingerprint]: pkg.version };
    console.log(`-- bmad-method ${pkg.version} installer ${fingerprint.slice(0, 12)} (${pkg.root})`);
    const stable = /^\d+\.\d+\.\d+$/.test(pkg.version);
    const channel = (dir: string) => bmadUpgradeChannelArgs(dir, pkg.version);


    // S1 fresh.
    await scenario(pkg, verified, "S1 fresh", project("s1"), {});
    pass(`${version} S1 fresh install stays inside the surface`);

    // S2 full update with tool roots absent beforehand.
    {
      assert.ok(stable, `${version}: the oracle versions are exact releases`);
      const dir = installed(pkg, "s2");
      rmSync(join(dir, ".zcode"), { recursive: true, force: true });
      rmSync(join(dir, ".opencode"), { recursive: true, force: true });
      await scenario(pkg, verified, "S2 update", dir, { extra: channel(dir), roundTrip: true });
    }
    pass(`${version} S2 --action update --all-stable with .zcode/.opencode absent: contained, round-trips`);

    const handlerFiles = Object.values(BMAD_HANDLER_FILES).flat();
    // S3 quick-update driven by manifest ides, with handler files seeded.
    {
      const dir = installed(pkg, "s3");
      const manifestPath = join(dir, "_bmad", "_config", "manifest.yaml");
      const manifest = YAML.parse(read(manifestPath)) as Record<string, unknown>;
      manifest.ides = ["cline", "kilo", "rovo-dev"];
      put(manifestPath, YAML.stringify(manifest));
      put(join(dir, ".cline", "skills", "bmad-help", "SKILL.md"), "---\nname: bmad-help\n---\nstale\n");
      put(join(dir, ".kilocodemodes"), YAML.stringify({ customModes: [{ slug: "bmad-dev", name: "BMAD" }, { slug: "mine", name: "Mine" }] }));
      put(join(dir, ".rovodev", "prompts.yml"), YAML.stringify({ prompts: [{ name: "bmad-help", content_file: "x" }, { name: "mine", content_file: "y" }] }));
      const manifestOnly = ["cline", "kilo", "rovo-dev"];
      await scenario(pkg, verified, "S3 quick-update", dir, {
        roundTrip: true,
        mutations: [
          ["drop manifest ides", (scope) => {
            const keep = platformRoots(pkg, TOOLS);
            const dropped = platformRoots(pkg, manifestOnly);
            return without(scope, (rel) => dropped.has(rel) && !keep.has(rel));
          }],
          ["drop HANDLER_FILES", (scope) => without(scope, (rel) => handlerFiles.includes(rel))],
        ],
      });
    }
    pass(`${version} S3 quick-update with manifest ides [cline,kilo,rovo-dev]: contained, round-trips; dropping ides/handler files is caught`);

    // S4 copilot instructions with BMAD markers and a .bak.
    {
      const dir = installed(pkg, "s4");
      put(join(dir, ".github", "copilot-instructions.md"), "<!-- BMAD:START -->\nbmad content\n<!-- BMAD:END -->\n");
      put(join(dir, ".github", "copilot-instructions.md.bak"), "operator instructions\n");
      put(join(dir, ".github", "workflows", "ci.yml"), "on: push\n");
      await scenario(pkg, verified, "S4 copilot markers", dir, {
        extra: channel(dir), roundTrip: true,
        mutations: [["drop HANDLER_FILES", (scope) => without(scope, (rel) => handlerFiles.includes(rel))]],
      });
    }
    pass(`${version} S4 copilot-instructions markers + .bak: contained, round-trips; dropping handler files is caught`);

    // S5 operator custom + modified files: a clean run, then a SIGKILL while the backup temps exist.
    {
      const seed = (dir: string) => {
        put(join(dir, "_bmad", "bmm", "my-custom-note.md"), "operator note\n");
        appendFileSync(join(dir, "_bmad", "bmm", "module-help.csv"), "\n# operator edit\n");
      };
      const clean = installed(pkg, "s5-clean");
      seed(clean);
      await scenario(pkg, verified, "S5 custom files", clean, { extra: channel(clean), roundTrip: true });
      assert.equal(read(join(clean, "_bmad", "bmm", "my-custom-note.md")), "operator note\n");
      const killed = installed(pkg, "s5-killed");
      seed(killed);
      await scenario(pkg, verified, "S5 killed mid-update", killed, {
        expectFail: true, roundTrip: true,
        run: () => killWhen(pkg, killed, channel(killed), { marker: join(killed, "_bmad-custom-backup-temp") }),
        mutations: [["drop the backup-temp roots", (scope) => without(scope, (rel) => BMAD_BACKUP_TEMP_ROOTS.includes(rel))]],
      });
    }
    pass(`${version} S5 operator custom/modified files (and a SIGKILL with the backup temps on disk): contained, round-trips; dropping backup temps is caught`);

    // S6 output_folder deleted beforehand.
    {
      const dir = installed(pkg, "s6");
      rmSync(join(dir, "_bmad-output"), { recursive: true, force: true });
      await scenario(pkg, verified, "S6 output folder recreated", dir, { extra: channel(dir), roundTrip: true });
    }
    pass(`${version} S6 a deleted output_folder is recreated inside C and rolled back`);

    // S7 a real mid-install EACCES: exit 1.
    const lockable = (dir: string) => {
      const preferred = join(dir, "_bmad", "bmm", "v6-shims");
      if (existsSync(preferred)) return preferred;
      fail(`${version}: _bmad/bmm/v6-shims is missing; pick another real _bmad/bmm subdir for S7`);
    };
    if (!isRoot) {
      const dir = installed(pkg, "s7");
      const locked = lockable(dir);
      chmodSync(locked, 0o555);
      try { await scenario(pkg, verified, "S7 mid-install EACCES", dir, { extra: channel(dir), expectFail: true, roundTrip: true }); }
      finally { chmodSync(locked, 0o755); }
      pass(`${version} S7 a real mid-install EACCES (exit 1): contained, round-trips`);
    }

    // S8 a moved output_folder, discovered from stdout and config.
    {
      const dir = installed(pkg, "s8");
      put(join(dir, "_bmad-output", "planning-artifacts", "prd.md"), "agent PRD\n");
      const { run } = await scenario(pkg, verified, "S8 output folder move", dir, {
        extra: [...channel(dir), "--set", "core.output_folder=deep/new-out"], roundTrip: true,
      });
      assert.deepEqual(parseInstallerDirectoryLines(run.stdout).moved.map((move) => move.to), ["deep/new-out"], `stdout reports the move:\n${run.stdout}`);
      assert.equal(read(join(dir, "_bmad-output", "planning-artifacts", "prd.md")), "agent PRD\n", "the moved PRD is back in place");
    }
    pass(`${version} S8 --set core.output_folder=deep/new-out: the move is reported, contained, and renamed back`);

    // S8b a crash right after the move: no config names the destination yet, only stdout does.
    {
      const dir = installed(pkg, "s8b");
      put(join(dir, "_bmad-output", "planning-artifacts", "prd.md"), "agent PRD\n");
      const extra = [...channel(dir), "--set", "core.output_folder=deep/new-out"];
      await scenario(pkg, verified, "S8b killed after the move", dir, {
        expectFail: true, roundTrip: true,
        run: () => killWhen(pkg, dir, extra, { stdout: /→ deep\/new-out/ }),
      });
      assert.equal(read(join(dir, "_bmad-output", "planning-artifacts", "prd.md")), "agent PRD\n");
      assert.equal(exists(join(dir, "deep")), false, "the move's created parent is gone");
    }
    pass(`${version} S8b SIGKILL right after the move report: the destination comes from stdout alone and is renamed back`);

    // S9 an in-repo link for a tool root.
    {
      const dir = installed(pkg, "s9");
      rmSync(join(dir, ".claude", "skills"), { recursive: true, force: true });
      mkdirSync(join(dir, "tooling", "claude-skills"), { recursive: true });
      symlinkSync("../tooling/claude-skills", join(dir, ".claude", "skills"));
      const derived = deriveBmadUpdateScope(dir, { tools: TOOLS, installer: pkg, companionSurfaces: G33_OWNED_SURFACES, verified });
      assert.ok(derived.installerRoots.includes("tooling/claude-skills"), derived.installerRoots.join(","));
      await scenario(pkg, verified, "S9 symlinked tool root", dir, {
        extra: channel(dir), roundTrip: true,
        mutations: [["drop symlink resolution", (scope) => without(scope, (rel) => rel === "tooling/claude-skills")]],
      });
    }
    pass(`${version} S9 .claude/skills -> ../tooling/claude-skills: contained, round-trips; dropping link resolution is caught`);

    // S10 adding the external tea module (test_artifacts is a predicted C path).
    {
      // TEA's newer tags dropped the src/module.yaml the 6.12.x registry expects, so pin the last good tag.
      const teaPin = ["--pin", "tea=v1.27.2"];
      // Warm the external-module cache the way a previous install would.
      const warm = project("s10-warm");
      const warmed = runInstaller(pkg, warm, { modules: ["bmm", "tea"], extra: teaPin });
      if (!warmed.ok) fail(`warming the tea module cache failed (network?): ${warmed.error}`);
      const dir = installed(pkg, "s10");
      const derived = deriveBmadUpdateScope(dir, { tools: TOOLS, installer: pkg, companionSurfaces: G33_OWNED_SURFACES, verified });
      const predicted = derived.structuralPaths.filter((rel) => /test-artifacts/.test(rel));
      assert.ok(predicted.length, `tea's test_artifacts is predicted: ${derived.structuralPaths}`);
      await scenario(pkg, verified, "S10 add tea", dir, {
        modules: ["bmm", "tea"], extra: [...channel(dir), ...teaPin], roundTrip: true,
        mutations: [["drop the default prediction", (scope) => without(scope, (rel) => predicted.includes(rel), "structuralPaths")]],
      });
    }
    pass(`${version} S10 adding external tea: test_artifacts predicted, contained, round-trips; dropping the prediction is caught`);

    // ------------------------------------------------------------------
    // E2E through runBmadUpdateWithCompanionPreservation.
    const enrolled = async (name: string, behavior?: string): Promise<string> => {
      const dir = installed(pkg, name);
      const manifest = JSON.parse(read(join(dir, ".project.json"))) as Record<string, unknown>;
      put(join(dir, ".project.json"), `${JSON.stringify({ ...manifest, ticket_provider: { type: "plane", workspace: "33god", state: "linked", board_id: "fixture-board" } }, null, 2)}\n`);
      put(join(dir, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
      // The activation a skillex enable makes (enrollG33Companion itself refuses here: the
      // installer's real .claude/skills dir is a foreign CLI alias to skillex), and the
      // adapter block enrollment writes, pointing at the catalog's real v1 bridge.
      symlinkSync(join(catalog, "all-skills", G33_SKILL), join(dir, ".agents", "skills", G33_SKILL));
      const configured = JSON.parse(read(join(dir, ".project.json")));
      configured.bmad = { companion: { adapter: { ...G33_BRIDGE_ADAPTER, ...(behavior ? { options: { behavior } } : {}) } } };
      put(join(dir, ".project.json"), `${JSON.stringify(configured, null, 2)}\n`);
      return dir;
    };
    const update = (dir: string, scope: BmadUpdateScope | undefined, beforeInstall?: () => void, afterInstaller?: () => void) =>
      runBmadUpdateWithCompanionPreservation(dir, {
        hadManifestG33: false, hadTomlG33: false, ...(scope ? { scope } : {}),
        beforeInstall: () => { beforeInstall?.(); return {}; },
        runInstaller: () => { const run = invokeBmadInstallerProcess(dir, ["bmm"], pkg.version, channel(dir), pkg); afterInstaller?.(); return run; },
      });
    const deriveFor = (dir: string) => deriveBmadUpdateScope(dir, { tools: TOOLS, installer: pkg, companionSurfaces: G33_OWNED_SURFACES, verified });
    const aSnapshot = (dir: string, scope: BmadUpdateScope) => {
      const snap = snapshotTree(dir, { roots: scope.installerRoots });
      for (const rel of [...snap.keys()]) if (rel.startsWith("_bmad/_memory") || rel.startsWith("_bmad/memory")) snap.delete(rel);
      return snap;
    };
    /** A SEPARATE process that writes while the installer runs; the update waits for it inside its window. */
    const concurrentWriter = (dir: string) => {
      const done = `${dir}.writer-done`;
      const projectJson = JSON.parse(read(join(dir, ".project.json")));
      const ops: Record<string, string | null> = {
        "src/new.ts": "export const fresh = 1;\n", "docs/readme.md": "readme v2\n", "src/old.ts": null,
        "_bmad-output/planning-artifacts/prd.md": "agent PRD\n", "notes/": "",
        ".project.json": `${JSON.stringify({ ...projectJson, agent_note: "edited" }, null, 2)}\n`,
        ".agents/skills.json": '{"inherit_global":false,"skills":[],"agent_note":"edited"}\n',
        ".agents/skills/my-own-skill/notes.md": "agent notes\n",
      };
      const script = `const fs=require('node:fs'),path=require('node:path');const base=${JSON.stringify(dir)};
for (const [rel,text] of Object.entries(${JSON.stringify(ops)})) { const p=path.join(base,rel);
  if (text===null) { fs.rmSync(p,{force:true}); continue; }
  if (rel.endsWith('/')) { fs.mkdirSync(p,{recursive:true}); continue; }
  fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,text); }
fs.writeFileSync(${JSON.stringify(done)},'1');`;
      return {
        start: () => { spawn(process.execPath, ["-e", script], { stdio: "ignore" }); },
        wait: () => {
          const until = Date.now() + 30_000;
          while (!existsSync(done) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          if (!existsSync(done)) fail("the concurrent writer did not finish inside the update window");
        },
      };
    };
    const assertWriterSurvived = (dir: string, label: string) => {
      assert.equal(read(join(dir, "src", "new.ts")), "export const fresh = 1;\n", `${label}: new file outside kept`);
      assert.equal(read(join(dir, "docs", "readme.md")), "readme v2\n", `${label}: edit outside kept`);
      assert.equal(exists(join(dir, "src", "old.ts")), false, `${label}: deletion outside stands`);
      assert.equal(read(join(dir, "_bmad-output", "planning-artifacts", "prd.md")), "agent PRD\n", `${label}: PRD in a C dir kept`);
      assert.equal(exists(join(dir, "notes")), true, `${label}: empty dir outside kept`);
      assert.equal(JSON.parse(read(join(dir, ".project.json"))).agent_note, "edited", `${label}: .project.json edit kept`);
      assert.match(read(join(dir, ".agents", "skills.json")), /agent_note/, `${label}: .agents/skills.json edit kept`);
    };

    // E1 installer failure (S7) with a real concurrent writer process.
    if (!isRoot) {
      const dir = await enrolled("e1");
      const scope = deriveFor(dir);
      assert.equal(scope.mode, "declared", scope.reason);
      const locked = lockable(dir);
      chmodSync(locked, 0o555);
      const preA = aSnapshot(dir, scope);
      const writer = concurrentWriter(dir);
      let result;
      try { result = await update(dir, scope, writer.start, writer.wait); }
      finally { chmodSync(locked, 0o755); }
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.ok(!result.details.some((line) => line.startsWith("rollback incomplete")), result.details.join("\n"));
      chmodSync(locked, 0o555);
      const postA = aSnapshot(dir, scope);
      chmodSync(locked, 0o755);
      assert.deepEqual(changedKeys(preA, postA), [], "the installer surface is byte-identical to before");
      assertWriterSurvived(dir, "E1");
      assert.equal(exists(join(dir, ".agents", "skills", "my-own-skill")), false, "the in-A write is reverted");
      const stashLine = result.details.find((line) => line.startsWith("rollback displaced"));
      assert.ok(stashLine, result.details.join("\n"));
      const stashDir = stashLine!.slice(stashLine!.indexOf("recover from ") + 13);
      assert.ok((JSON.parse(read(join(stashDir, "index.json"))) as { rel: string }[]).some((entry) => entry.rel === ".agents/skills/my-own-skill/notes.md"),
        "and recoverable from the stash");

      // Mutation: whole-tree mode loses the concurrent writes outside.
      const whole = await enrolled("e1-whole");
      const lockedWhole = lockable(whole);
      chmodSync(lockedWhole, 0o555);
      const wholeWriter = concurrentWriter(whole);
      try { await update(whole, undefined, wholeWriter.start, wholeWriter.wait); }
      finally { chmodSync(lockedWhole, 0o755); }
      assert.equal(exists(join(whole, "src", "new.ts")), false, "whole-tree mode deletes the concurrent new file");
      pass(`${version} E1 real installer failure + real concurrent writer: installer surface identical, outside/B writes kept, in-A write stashed`);
    }

    // E2 companion failure: its writes go, a concurrent memory edit stays, re-created tool roots go.
    {
      const dir = await enrolled("e2", "fail-apply");
      put(join(dir, "_bmad", "_memory", "agent-state.md"), "agent state v1\n");
      rmSync(join(dir, ".zcode"), { recursive: true, force: true });
      rmSync(join(dir, ".opencode"), { recursive: true, force: true });
      const result = await update(dir, deriveFor(dir), () => {
        const edit = spawnSync(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(join(dir, "_bmad", "_memory", "agent-state.md"))},'agent state v2\\n')`]);
        assert.equal(edit.status, 0);
      });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.ok(!result.details.some((line) => line.startsWith("rollback incomplete")), result.details.join("\n"));
      assert.equal(exists(join(dir, "_bmad", "g33")), false, "companion write in A gone");
      assert.equal(exists(join(dir, "_bmad", "_memory", "g33-note.md")), false, "companion write in B gone");
      assert.equal(read(join(dir, "_bmad", "_memory", "agent-state.md")), "agent state v2\n", "the concurrent memory edit stays");
      assert.equal(exists(join(dir, ".zcode")), false, ".zcode re-created by the installer is removed");
      assert.equal(exists(join(dir, ".opencode")), false, ".opencode re-created by the installer is removed");
    }
    pass(`${version} E2 companion failure: companion writes gone, concurrent memory edit kept, re-created tool roots removed`);

    // E3 an unreadable dir OUTSIDE the surface: the update and an E1-style rollback both work.
    if (!isRoot) {
      const dir = await enrolled("e3");
      put(join(dir, "data", "secret", "pg_control"), "container data");
      chmodSync(join(dir, "data", "secret"), 0o000);
      try {
        const ok = await update(dir, deriveFor(dir));
        assert.equal(ok.ok, true, JSON.stringify(ok));
        assert.ok(!ok.changedFiles.some((path) => path.startsWith(join(dir, "data"))));
        const failing = await enrolled("e3-fail");
        put(join(failing, "data", "secret", "pg_control"), "container data");
        chmodSync(join(failing, "data", "secret"), 0o000);
        const locked = lockable(failing);
        chmodSync(locked, 0o555);
        const writer = concurrentWriter(failing);
        try {
          const rolled = await update(failing, deriveFor(failing), writer.start, writer.wait);
          assert.equal(rolled.ok, false);
          assert.ok(!rolled.details.some((line) => /EACCES.*data|rollback incomplete/.test(line)), rolled.details.join("\n"));
          assertWriterSurvived(failing, "E3");
          // Mutation: whole-tree capture throws on the unreadable dir.
          await assert.rejects(update(failing, undefined), /EACCES/);
        } finally { chmodSync(locked, 0o755); chmodSync(join(failing, "data", "secret"), 0o755); }
      } finally { chmodSync(join(dir, "data", "secret"), 0o755); }
      pass(`${version} E3 chmod 000 data/secret outside: the update succeeds and the rollback succeeds without EACCES`);

      // E4 an unreadable dir INSIDE the surface blocks before the installer.
      const inside = await enrolled("e4");
      rmSync(join(inside, ".zcode"), { recursive: true, force: true });
      mkdirSync(join(inside, "_bmad", "bmm", "locked"));
      chmodSync(join(inside, "_bmad", "bmm", "locked"), 0o000);
      const manifestBefore = read(join(inside, "_bmad", "_config", "manifest.yaml"));
      try {
        const blocked = await update(inside, deriveFor(inside));
        assert.equal(blocked.ok, false);
        assert.match(blocked.error ?? "", /unreadable entry inside BMAD-owned surface _bmad\/bmm\/locked/);
      } finally { chmodSync(join(inside, "_bmad", "bmm", "locked"), 0o755); }
      assert.equal(read(join(inside, "_bmad", "_config", "manifest.yaml")), manifestBefore);
      for (const absent of ["_bmad-custom-backup-temp", "_bmad-modified-backup-temp", ".zcode"]) assert.equal(exists(join(inside, absent)), false, absent);
      pass(`${version} E4 chmod 000 under _bmad/bmm: blocked before the installer, nothing written`);
    }

    // E5 tripwire: one appended line makes the installer unverified.
    {
      const copy = join(scratch, `tripwire-${version}`, "bmad-method");
      cpSync(pkg.root, copy, { recursive: true });
      appendFileSync(join(copy, "tools", "installer", "ide", "_config-driven.js"), "\n// tripwire\n");
      const dir = project("e5");
      const copied = { root: copy, entry: join(copy, "tools", "installer", "bmad-cli.js"), version: pkg.version };
      const tripped = deriveBmadUpdateScope(dir, { tools: TOOLS, installer: copied, companionSurfaces: G33_OWNED_SURFACES, verified });
      assert.equal(tripped.mode, "whole-tree");
      assert.match(tripped.reason, new RegExp(`^bmad-method ${version.replaceAll(".", "\\.")} installer [0-9a-f]{12} is not surface-verified; run mise run bmad:verify-surface ${version.replaceAll(".", "\\.")}$`));
      // Mutation: treating every installer as verified declares the scope.
      const always = { ...verified, [installerFingerprint(copy)]: pkg.version };
      assert.equal(deriveBmadUpdateScope(dir, { tools: TOOLS, installer: copied, companionSurfaces: G33_OWNED_SURFACES, verified: always }).mode, "declared");
    }
    pass(`${version} E5 tripwire: a one-line installer change is not surface-verified (whole-tree)`);

    // E6 a tool root resolving outside the repo.
    {
      const dir = installed(pkg, "e6");
      rmSync(join(dir, ".claude", "skills"), { recursive: true, force: true });
      mkdirSync(join(scratch, "outside-claude-skills"), { recursive: true });
      symlinkSync(join(scratch, "outside-claude-skills"), join(dir, ".claude", "skills"));
      const scope = deriveFor(dir);
      assert.equal(scope.mode, "whole-tree");
      assert.equal(scope.reason, ".claude/skills resolves outside the repo via .claude/skills");
    }
    pass(`${version} E6 .claude/skills outside the repo: whole-tree with the reason`);

    // E7 PJ_BMAD_INSTALLER: a fake script is whole-tree; the real entry resolves.
    {
      const fake = join(scratch, "fake-installer.mjs");
      put(fake, "#!/usr/bin/env node\nprocess.exit(0);\n");
      process.env.PJ_BMAD_INSTALLER = fake;
      try {
        const resolved = resolveBmadInstallerPackage(version);
        assert.deepEqual(resolved, { reason: "PJ_BMAD_INSTALLER is not a bmad-method package" });
        const scope = deriveBmadUpdateScope(project("e7"), { tools: TOOLS, installer: resolved, companionSurfaces: G33_OWNED_SURFACES, verified });
        assert.equal(scope.mode, "whole-tree");
        process.env.PJ_BMAD_INSTALLER = pkg.entry;
        assert.deepEqual(resolveBmadInstallerPackage(version), { root: pkg.root, entry: pkg.entry, version: pkg.version });
      } finally { delete process.env.PJ_BMAD_INSTALLER; }
    }
    pass(`${version} E7 PJ_BMAD_INSTALLER fake script: whole-tree; the real entry resolves to its package`);

    if (printFingerprint) console.log(`VERIFIED_BMAD_INSTALLERS entry: "${fingerprint}": "${pkg.version}",`);
  }
  console.log(`PJAN-180 surface oracle: ${checks} checkpoint groups passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
