import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { backupToSnapshot, captureTreeBackup } from "../src/utils/tree-restore";
import { snapshotTree } from "../src/utils/tree-diff";
import { G33_INVENTORY_FAILED, G33_OWNED_SURFACES, runBmadUpdateWithCompanionPreservation } from "../src/bmad/companion";
import {
  acquireBmadUpdateLock, captureScopedBackup, deriveBmadUpdateScope, openDisplacedStash, parseInstallerDirectoryLines,
  processStartId, restoreScopedBackup, type BmadUpdateScope,
} from "../src/bmad/update-scope";
import { installerFingerprint } from "../src/bmad/verified-installers";

// PJAN-180 hermetic suite: real files, real chmod, real separate writer
// processes, no network. The real-installer proof is the network oracle
// (tests/pjan-180-surface-oracle.mjs); this suite pins the mechanism. Each
// block names the mutation that must break it.
const scratch = realpathSync(mkdtempSync("/tmp/pjan-180-rollback-"));
const home = join(scratch, "home");
const tmp = join(scratch, "tmp");
process.env.GIT_CEILING_DIRECTORIES = "/tmp";
process.env.HOME = home;
process.env.XDG_STATE_HOME = join(scratch, "state");
process.env.XDG_CONFIG_HOME = join(scratch, "config");
process.env.TMPDIR = tmp;
process.env.CI = "true";
process.env.NO_COLOR = "1";
process.env.BMAD_EXTERNAL_MODULES_CACHE = join(scratch, "no-external-modules");
process.env.PJ_G33_ADAPTER_MODULE = "";
process.env.PJ_G33_ADAPTER_EXPORT = "";
for (const dir of [home, tmp, process.env.XDG_CONFIG_HOME]) mkdirSync(dir, { recursive: true });
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const read = (path: string) => readFileSync(path, "utf8");
const exists = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };

/** Run `script` (CommonJS) in a SEPARATE node process: the concurrent agent. */
function writerProcess(script: string): void {
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: hermeticEnv() });
  assert.equal(run.status, 0, `writer process failed: ${run.stderr}`);
}
const writerScript = (ops: Record<string, string | null>, base: string) => `
const fs=require('node:fs'),path=require('node:path');const base=${JSON.stringify(base)};
for (const [rel,text] of Object.entries(${JSON.stringify(ops)})) {
  const p=path.join(base,rel);
  if (text===null) { fs.rmSync(p,{force:true}); continue; }
  if (rel.endsWith('/')) { fs.mkdirSync(p,{recursive:true}); continue; }
  fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,text);
}`;

// A bmad-method-shaped package. It is never executed; only its data files are read.
const pkg = join(scratch, "pkg", "bmad-method");
put(join(pkg, "package.json"), JSON.stringify({ name: "bmad-method", version: "9.9.9-fixture" }));
put(join(pkg, "tools", "installer", "bmad-cli.js"), "// fixture\n");
put(join(pkg, "tools", "installer", "ide", "platform-codes.yaml"), `platforms:
  claude-code: { name: Claude, installer: { target_dir: .claude/skills } }
  codex: { name: Codex, installer: { target_dir: .agents/skills } }
  github-copilot: { name: Copilot, installer: { target_dir: .agents/skills, commands_target_dir: .github/agents } }
  opencode: { name: OpenCode, installer: { target_dir: .agents/skills, commands_target_dir: .opencode/commands } }
  zcode: { name: ZCode, installer: { target_dir: .zcode/skills } }
  cline: { name: Cline, installer: { target_dir: .cline/skills } }
  kilo: { name: Kilo, installer: { target_dir: .agents/skills } }
`);
put(join(pkg, "src", "core-skills", "module.yaml"), `code: core
output_folder:
  default: "_bmad-output"
  result: "{project-root}/{value}"
directories:
  - "{output_folder}"
`);
put(join(pkg, "src", "bmm-skills", "module.yaml"), `code: bmm
planning_artifacts:
  default: "{output_folder}/planning-artifacts"
  result: "{project-root}/{value}"
project_knowledge:
  default: "docs"
  result: "{project-root}/{value}"
`);
const fingerprint = installerFingerprint(pkg);
const verified = { [fingerprint]: "9.9.9-fixture" };
const TOOLS = ["claude-code", "codex", "github-copilot", "opencode", "zcode"];
const installer = { root: pkg, entry: join(pkg, "tools", "installer", "bmad-cli.js"), version: "9.9.9-fixture" };
const derive = (dir: string, opts: { verified?: Record<string, string> } = {}) =>
  deriveBmadUpdateScope(dir, { tools: TOOLS, installer, companionSurfaces: G33_OWNED_SURFACES, verified: opts.verified ?? verified });

// A g33 owner adapter fixture (PJangler boundary only, not real g33): apply
// writes into A (_bmad/g33) and B (_bmad/_memory), and can fail.
const adapter = join(scratch, "adapter.mjs");
put(adapter, `import {existsSync,mkdirSync,writeFileSync} from 'node:fs'; import {dirname,join} from 'node:path';
const r=(status,summary,evidence=[])=>({schemaVersion:1,status,summary,details:[],evidence});
export function companion(req){
  const file=join(req.projectRoot,'_bmad','g33','companion.md'); const valid=existsSync(file);
  if(req.operation==='observe')return valid?r('installed','installed',['companion.md present']):r('missing','absent');
  if(req.operation==='plan')return r(valid?'unchanged':'planned',valid?'converged':'would write');
  for(const [rel,text] of [['_bmad/g33/companion.md','fixture'],['_bmad/_memory/g33-note.md','g33 note']]){const p=join(req.projectRoot,rel);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text);}
  if(req.options.behavior==='fail-apply')return r('error','apply failed after writing');
  return r('changed','written');
}`);
const linked = { ticket_provider: { type: "plane", workspace: "33god", state: "linked", board_id: "fixture-board" } };

/** An installed BMAD project with concurrent-agent content outside the surface. */
function project(name: string, behavior = "ok"): string {
  const dir = join(scratch, name);
  put(join(dir, ".project.json"), `${JSON.stringify({ project_id: name, ...linked, bmad: { companion: { adapter: { module: adapter, exportName: "companion", options: { behavior } } } } }, null, 2)}\n`);
  put(join(dir, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(dir, ".agents", "skills", "bmad-help", "SKILL.md"), "---\nname: bmad-help\n---\nnative\n");
  put(join(dir, "_bmad", "_config", "manifest.yaml"), "installation:\n  version: 6.11.0\nmodules:\n  - name: core\n  - name: bmm\nides:\n  - claude-code\n  - cline\n  - not-a-platform\n");
  put(join(dir, "_bmad", "core", "config.yaml"), "project_name: fixture\n");
  put(join(dir, "_bmad", "_memory", "agent-state.md"), "agent state v1\n");
  put(join(dir, "src", "old.ts"), "export const old = 1;\n");
  put(join(dir, "docs", "readme.md"), "readme v1\n");
  return dir;
}

/** A fake installer PROCESS: writes the installer surface (A + structural), then exits `code`. */
const fakeInstaller = join(scratch, "fake-installer.cjs");
put(fakeInstaller, `const fs=require('node:fs'),path=require('node:path');
const [dir,code]=process.argv.slice(2);
const w=(rel,text)=>{const p=path.join(dir,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
w('_bmad/_config/manifest.yaml','installation:\\n  version: 6.12.1\\n');
w('_bmad/core/config.yaml','project_name: rewritten\\n');
w('.agents/skills/bmad-help/SKILL.md','---\\nname: bmad-help\\n---\\nupstream\\n');
w('.claude/skills/bmad-help/SKILL.md','upstream claude copy\\n');
w('.zcode/skills/bmad-help/SKILL.md','upstream zcode copy\\n');
w('.opencode/commands/bmad-help.md','pointer\\n');
w('_bmad-custom-backup-temp/bmm/custom.md','temp\\n');
fs.mkdirSync(path.join(dir,'_bmad-output'),{recursive:true});
process.stdout.write('│  Created directories:\\n│    output folder: _bmad-output\\n');
process.exit(Number(code));`);
const runFake = (dir: string, code: number) => () => {
  const run = spawnSync(process.execPath, [fakeInstaller, dir, String(code)], { encoding: "utf8", env: hermeticEnv() });
  return { ok: run.status === 0, error: run.status === 0 ? undefined : `installer exited ${run.status}`, stdout: run.stdout };
};

try {
  // D. deriveBmadUpdateScope: the declared surface, and every fail-closed fallback.
  {
    const dir = project("derive");
    const scope = derive(dir);
    assert.equal(scope.mode, "declared", scope.reason);
    assert.deepEqual(scope.ides, ["claude-code", "cline", "codex", "github-copilot", "opencode", "zcode"], "manifest ides ∪ tools ∩ platforms; unknown ids skipped");
    for (const rel of ["_bmad", "_bmad-custom-backup-temp", "_bmad-modified-backup-temp", ".agents/skills", ".claude/skills", ".cline/skills",
      ".github/agents", ".github/copilot-instructions.md", ".github/copilot-instructions.md.bak", ".opencode/commands", ".zcode/skills", ".codex/skills"]) {
      assert.ok(scope.installerRoots.includes(rel), `A holds ${rel}: ${scope.installerRoots}`);
    }
    assert.ok(!scope.installerRoots.includes(".github"), ".github as a whole is never A");
    assert.deepEqual(scope.companionRoots, [".agents", ".project.json", "_bmad/_memory", "_bmad/memory"]);
    assert.deepEqual(scope.structuralPaths, ["_bmad-output", "_bmad-output/planning-artifacts", "docs"], "predicted defaults, normalized");
    assert.ok(scope.directoryKeys.includes("output_folder") && scope.directoryKeys.includes("planning_artifacts"));

    const unverified = derive(dir, { verified: {} });
    assert.equal(unverified.mode, "whole-tree");
    assert.equal(unverified.reason, `bmad-method 9.9.9-fixture installer ${fingerprint.slice(0, 12)} is not surface-verified; run mise run bmad:verify-surface 9.9.9-fixture`);
    assert.equal(deriveBmadUpdateScope(dir, { tools: TOOLS, installer: { reason: "PJ_BMAD_INSTALLER is not a bmad-method package" }, companionSurfaces: G33_OWNED_SURFACES, verified }).reason,
      "PJ_BMAD_INSTALLER is not a bmad-method package");

    put(join(dir, "_bmad", "config.toml"), '[core]\noutput_folder = "custom-out"\n[modules.bmm]\nplanning_artifacts = "{project-root}/plans"\n');
    assert.deepEqual(derive(dir).structuralPaths, ["custom-out", "docs", "plans"], "existing values win over predicted defaults");
    put(join(dir, "_bmad", "config.toml"), "[core\nbroken");
    assert.match(derive(dir).reason, /config\.toml is not parseable TOML/, "an unparseable config.toml is whole-tree");
    rmSync(join(dir, "_bmad", "config.toml"));
    const manifest = read(join(dir, "_bmad", "_config", "manifest.yaml"));
    put(join(dir, "_bmad", "_config", "manifest.yaml"), "ides: [unclosed\n");
    assert.match(derive(dir).reason, /manifest\.yaml is unparseable/);
    put(join(dir, "_bmad", "_config", "manifest.yaml"), manifest);

    mkdirSync(join(dir, "tooling", "claude-skills"), { recursive: true });
    rmSync(join(dir, ".claude"), { recursive: true, force: true });
    mkdirSync(join(dir, ".claude"));
    symlinkSync("../tooling/claude-skills", join(dir, ".claude", "skills"));
    assert.ok(derive(dir).installerRoots.includes("tooling/claude-skills"), "an in-repo link adds its target as an A root");
    // unlink, not rmSync: Node 24.6 (the release runtime) follows a symlink to a
    // directory in rmSync and throws EISDIR.
    unlinkSync(join(dir, ".claude", "skills"));
    mkdirSync(join(scratch, "outside-skills"), { recursive: true });
    symlinkSync(join(scratch, "outside-skills"), join(dir, ".claude", "skills"));
    assert.equal(derive(dir).reason, ".claude/skills resolves outside the repo via .claude/skills");
    assert.equal(derive(dir).mode, "whole-tree");
  }
  pass("derive: manifest ides ∪ tools, handler files, carve-outs, defaults; unverified/unparseable/outside-link fall back to whole-tree");

  // U1. backupToSnapshot reproduces snapshotTree exactly (mutation: any format drift lists every A file as changed).
  {
    const dir = join(scratch, "u1");
    put(join(dir, "a", "ro.txt"), "read only");
    chmodSync(join(dir, "a", "ro.txt"), 0o444);
    put(join(dir, "a", "exec.sh"), "#!/bin/sh\n");
    chmodSync(join(dir, "a", "exec.sh"), 0o755);
    mkdirSync(join(dir, "empty"));
    symlinkSync("a/ro.txt", join(dir, "link"));
    symlinkSync("missing-target", join(dir, "dangling"));
    assert.deepEqual(backupToSnapshot(captureTreeBackup(dir)), snapshotTree(dir));
  }
  pass("U1 backupToSnapshot(captureTreeBackup(D)) deepEquals snapshotTree(D) over files, dirs, links and modes 0444/0755");

  // U2. A separate process mutates A and outside paths; the rollback restores A only.
  {
    const dir = project("u2");
    const scope = derive(dir);
    const before = snapshotTree(dir);
    const sb = captureScopedBackup(dir, scope);
    writerProcess(writerScript({
      "_bmad/core/config.yaml": "clobbered", ".zcode/skills/bmad-x/SKILL.md": "new in A", ".agents/skills/bmad-help/SKILL.md": "clobbered",
      "src/new.ts": "export const fresh = 1;", "docs/readme.md": "readme v2", "src/old.ts": null,
    }, dir));
    const undone = restoreScopedBackup(dir, sb, { companionChanged: "none" });
    assert.ok(!undone.details.some((line) => line.startsWith("rollback incomplete")), undone.details.join("\n"));
    const after = snapshotTree(dir);
    for (const [rel, value] of before) {
      if (rel === "_bmad" || rel.startsWith("_bmad/") || rel === ".agents/skills" || rel.startsWith(".agents/skills/")) assert.equal(after.get(rel), value, `A restored: ${rel}`);
    }
    assert.equal(exists(join(dir, ".zcode")), false, "A's created root and its absent ancestor are gone");
    assert.equal(read(join(dir, "src", "new.ts")), "export const fresh = 1;", "outside creation survives");
    assert.equal(read(join(dir, "docs", "readme.md")), "readme v2", "outside edit survives");
    assert.equal(exists(join(dir, "src", "old.ts")), false, "outside deletion is not resurrected");
  }
  pass("U2 restoreScopedBackup reverts a separate process's writes in A and leaves its outside writes alone");

  // U3. Structural (C) paths: identity only.
  {
    const scopeFor = (dir: string): BmadUpdateScope => ({ ...derive(dir), structuralPaths: ["_bmad-output", "notes", "moved-from", "mismatch"] });
    // a. absent, created with a concurrent file inside: kept with the file.
    const a = project("u3a");
    const sbA = captureScopedBackup(a, scopeFor(a));
    writerProcess(writerScript({ "_bmad-output/planning-artifacts/prd.md": "agent PRD", "notes/": "" }, a));
    restoreScopedBackup(a, sbA, { companionChanged: "none" });
    assert.equal(read(join(a, "_bmad-output", "planning-artifacts", "prd.md")), "agent PRD", "a file in C is never unlinked (mutation: rmSync recursive)");
    // b. absent and still empty: removed.
    assert.equal(exists(join(a, "notes")), false, "an absent-before, still-empty C dir is removed");
    // c. a same-inode move is renamed back; d. an inode mismatch is reported, untouched.
    const c = project("u3c");
    put(join(c, "moved-from", "story.md"), "story");
    put(join(c, "mismatch", "keep.md"), "keep");
    const sbC = captureScopedBackup(c, scopeFor(c));
    mkdirSync(join(c, "deep"));
    renameSync(join(c, "moved-from"), join(c, "deep", "moved-to"));
    // An EXDEV-style move: copy + remove, so the new dir has a different inode.
    put(join(c, "elsewhere-copy", "keep.md"), read(join(c, "mismatch", "keep.md")));
    rmSync(join(c, "mismatch"), { recursive: true });
    const undone = restoreScopedBackup(c, sbC, {
      companionChanged: "none",
      installerStdout: "│  Moved directories:\n│    a: moved-from → deep/moved-to\n│    b: mismatch → elsewhere-copy\n",
    });
    assert.equal(read(join(c, "moved-from", "story.md")), "story", "same dev+ino move renamed back");
    assert.equal(exists(join(c, "deep")), false, "the move's created parent goes once empty");
    assert.ok(undone.details.includes("moved, not located: mismatch"), undone.details.join("\n"));
    assert.equal(read(join(c, "elsewhere-copy", "keep.md")), "keep", "an inode mismatch is never touched");
    assert.equal(exists(join(c, "mismatch")), false, "nor is the old path recreated");
    assert.deepEqual(parseInstallerDirectoryLines("\x1b[36m│  Moved directories:\n│    output folder: _bmad-output → deep/new-out\x1b[39m\n│\n│  Created directories:\n│    planning artifacts: plans\n"),
      { moved: [{ name: "output folder", from: "_bmad-output", to: "deep/new-out" }], created: [{ name: "planning artifacts", path: "plans" }] });
  }
  pass("U3 structural paths: concurrent files kept, empty created dirs removed, same-inode moves renamed back, mismatches reported");

  // U4. The per-repo lock (mutation: drop O_EXCL and a second taker wins).
  {
    const dir = project("u4");
    const first = acquireBmadUpdateLock(dir);
    assert.equal(first.ok, true);
    const live = acquireBmadUpdateLock(dir);
    assert.equal(live.ok, false);
    assert.equal((live as { error: string }).error, `another pj BMAD update is running on this repo (pid ${process.pid})`);
    if (first.ok) first.release();
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", env: hermeticEnv() });
    const lockPath = (acquireBmadUpdateLock(dir) as { ok: true; path: string; release(): void });
    lockPath.release();
    writeFileSync(lockPath.path, dead.stdout);
    const taken = acquireBmadUpdateLock(dir);
    assert.equal(taken.ok, true, "a dead holder's lock is taken over");
    if (taken.ok) { assert.ok(read(taken.path).startsWith(String(process.pid)), "the lock holds the holder's pid"); taken.release(); }
  }
  pass("U4 lock: a live pid blocks with its pid named; a dead pid's lock is taken over");

  // U5. Displaced bytes are stashed, deduplicated, and never under the repo or TMPDIR.
  {
    const dir = project("u5");
    const sb = captureScopedBackup(dir, derive(dir));
    writerProcess(writerScript({
      ".agents/skills/my-own-skill/notes.md": "agent notes", ".claude/skills/dup/a.md": "same bytes", ".zcode/skills/dup/b.md": "same bytes",
    }, dir));
    const undone = restoreScopedBackup(dir, sb, { companionChanged: "none" });
    const line = undone.details.find((detail) => detail.startsWith("rollback displaced"));
    assert.ok(line, undone.details.join("\n"));
    const stashDir = line!.slice(line!.indexOf("recover from ") + "recover from ".length);
    assert.ok(relative(dir, stashDir).startsWith(".."), "never under the repo");
    assert.ok(relative(tmp, stashDir).startsWith(".."), "never under TMPDIR");
    assert.ok(stashDir.startsWith(join(process.env.XDG_STATE_HOME!, "pjangler", "bmad-rollback")));
    const index = JSON.parse(read(join(stashDir, "index.json"))) as { rel: string; kind: string; object?: string }[];
    const note = index.find((entry) => entry.rel === ".agents/skills/my-own-skill/notes.md");
    assert.ok(note?.object, "the in-A write is in the stash index");
    assert.equal(read(join(stashDir, "objects", note!.object!)), "agent notes", "the displaced bytes are recoverable (mutation: skip the stash)");
    assert.equal(readdirSync(join(stashDir, "objects")).length, 2, "identical bytes are stored once");
    assert.equal(exists(join(dir, ".agents", "skills", "my-own-skill")), false);
    for (let run = 0; run < 6; run++) { const extra = openDisplacedStash(dir); put(join(dir, "_bmad", "x.md"), String(run)); extra.put("_bmad/x.md"); extra.close(); }
    assert.equal(readdirSync(dirname(stashDir)).length, 5, "the newest 5 runs per repo are kept");
  }
  pass("U5 stash: displaced bytes kept content-addressed, deduped, pruned to 5 runs, outside the repo and TMPDIR");

  // U6. B narrowing: restore exactly the companion inventory.
  {
    const run = (mode: "list" | "all" | "none") => {
      const dir = project(`u6-${mode}`);
      const sb = captureScopedBackup(dir, derive(dir));
      // An agent edits .agents/skills.json before the companion window.
      writerProcess(writerScript({ ".agents/skills.json": '{"agent":"edit"}' }, dir));
      // The companion window writes g33-note.md and lists it.
      writerProcess(writerScript({ "_bmad/_memory/g33-note.md": "g33" }, dir));
      const listed = [join(dir, "_bmad/_memory/g33-note.md")];
      restoreScopedBackup(dir, sb, { companionChanged: mode === "list" ? listed : mode });
      return dir;
    };
    const narrowed = run("list");
    assert.equal(exists(join(narrowed, "_bmad", "_memory", "g33-note.md")), false, "the listed companion write is undone (mutation: B never restored)");
    assert.equal(read(join(narrowed, ".agents", "skills.json")), '{"agent":"edit"}', "the unlisted concurrent edit survives (mutation: B restored fully)");
    assert.equal(read(join(narrowed, "_bmad", "_memory", "agent-state.md")), "agent state v1\n");
    const all = run("all");
    assert.equal(read(join(all, ".agents", "skills.json")), '{"inherit_global":false,"skills":[]}\n', "'all' (inventory failed) restores all of B");
    const none = run("none");
    assert.equal(read(join(none, "_bmad", "_memory", "g33-note.md")), "g33", "'none' (companion never started) leaves B alone");
  }
  pass("U6 B: only the companion's listed paths are restored; 'all' when its inventory failed; untouched when it never started");

  // H1. The full update with a REAL concurrent writer PROCESS and a failing installer process.
  const concurrentWrites = {
    "src/new.ts": "export const fresh = 1;\n", "docs/readme.md": "readme v2\n", "src/old.ts": null,
    "_bmad-output/planning-artifacts/prd.md": "agent PRD\n", "notes/": "",
    ".agents/skills.json": '{"agent":"edit"}\n', ".agents/skills/my-own-skill/notes.md": "agent notes\n",
    "_bmad/_memory/agent-state.md": "agent state v2\n",
  };
  const failedUpdate = async (dir: string, scope: BmadUpdateScope | undefined, installerCode: number) => {
    const projectJson = JSON.parse(read(join(dir, ".project.json"))) as Record<string, unknown>;
    const writes = { ...concurrentWrites, ".project.json": `${JSON.stringify({ ...projectJson, agent_note: "edited" }, null, 2)}\n` };
    let writer: ReturnType<typeof spawn> | undefined;
    const done = join(scratch, `${relative(scratch, dir)}.writer-done`);
    const result = await runBmadUpdateWithCompanionPreservation(dir, {
      hadManifestG33: false, hadTomlG33: false, ...(scope ? { scope } : {}),
      beforeInstall: () => {
        // A separate process, running WHILE the installer runs.
        writer = spawn(process.execPath, ["-e", `${writerScript(writes, dir)};require('node:fs').writeFileSync(${JSON.stringify(done)},'1');`], { stdio: "ignore", env: hermeticEnv() });
        return { changedFiles: [], details: [] };
      },
      runInstaller: () => {
        const run = runFake(dir, installerCode)();
        const until = Date.now() + 15_000;
        while (!existsSync(done) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        assert.ok(existsSync(done), "the concurrent writer finished inside the update window");
        return run;
      },
    });
    writer?.kill();
    return result;
  };
  {
    const dir = project("h1");
    const scope = derive(dir);
    const before = snapshotTree(dir);
    const result = await failedUpdate(dir, scope, 1);
    assert.equal(result.ok, false);
    assert.ok(!result.details.some((line) => line.startsWith("rollback incomplete")), result.details.join("\n"));
    assert.ok(result.details.some((line) => line.startsWith("rollback scope: declared")), result.details.join("\n"));
    const after = snapshotTree(dir);
    for (const [rel, value] of before) {
      if (rel === "_bmad" || (rel.startsWith("_bmad/") && !rel.startsWith("_bmad/_memory")) || rel.startsWith(".agents/skills/")) assert.equal(after.get(rel), value, `installer surface restored: ${rel}`);
    }
    for (const gone of [".zcode", ".claude", ".opencode", "_bmad-custom-backup-temp", ".agents/skills/my-own-skill"]) assert.equal(exists(join(dir, gone)), false, `undone: ${gone}`);
    assert.equal(read(join(dir, "src", "new.ts")), "export const fresh = 1;\n", "the writer's new file outside survives");
    assert.equal(read(join(dir, "docs", "readme.md")), "readme v2\n", "the writer's edit outside survives");
    assert.equal(exists(join(dir, "src", "old.ts")), false, "the writer's deletion outside stands");
    assert.equal(read(join(dir, "_bmad-output", "planning-artifacts", "prd.md")), "agent PRD\n", "the writer's file in a C dir survives");
    assert.equal(exists(join(dir, "notes")), true, "the writer's empty dir outside survives");
    assert.equal(read(join(dir, ".agents", "skills.json")), '{"agent":"edit"}\n', "the writer's B edit survives (companion never ran)");
    assert.equal((JSON.parse(read(join(dir, ".project.json"))) as { agent_note?: string }).agent_note, "edited", "the writer's .project.json edit survives");
    assert.equal(read(join(dir, "_bmad", "_memory", "agent-state.md")), "agent state v2\n", "the writer's memory edit survives");
    const stashLine = result.details.find((line) => line.startsWith("rollback displaced"))!;
    const stashDir = stashLine.slice(stashLine.indexOf("recover from ") + 13);
    assert.ok((JSON.parse(read(join(stashDir, "index.json"))) as { rel: string }[]).some((entry) => entry.rel === ".agents/skills/my-own-skill/notes.md"),
      "the writer's in-A note is reverted AND recoverable from the stash");

    // Mutation: whole-tree mode loses every outside write.
    const whole = project("h1-whole");
    const wholeResult = await failedUpdate(whole, undefined, 1);
    assert.ok(wholeResult.details.includes("rollback scope: whole-tree (no declared installer scope was derived)"), wholeResult.details.join("\n"));
    assert.equal(exists(join(whole, "src", "new.ts")), false, "whole-tree mode deletes the concurrent new file (the PJAN-180 defect)");
    assert.equal(read(join(whole, "docs", "readme.md")), "readme v1\n", "whole-tree mode reverts the concurrent edit");
  }
  pass("H1 failed update + REAL concurrent writer process: every installer write undone, every outside/B write kept, in-A write stashed");

  // H2. Companion failure: its A and listed B writes go, the agent's memory edit stays.
  {
    const dir = project("h2", "fail-apply");
    const result = await runBmadUpdateWithCompanionPreservation(dir, {
      hadManifestG33: false, hadTomlG33: false, scope: derive(dir),
      beforeInstall: () => { writerProcess(writerScript({ "_bmad/_memory/agent-state.md": "agent state v2\n" }, dir)); return {}; },
      runInstaller: runFake(dir, 0),
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(!result.details.some((line) => line.startsWith("rollback incomplete")), result.details.join("\n"));
    assert.equal(exists(join(dir, "_bmad", "g33")), false, "companion write in A is gone");
    assert.equal(exists(join(dir, "_bmad", "_memory", "g33-note.md")), false, "companion write in B (listed) is gone");
    assert.equal(read(join(dir, "_bmad", "_memory", "agent-state.md")), "agent state v2\n", "the concurrent memory edit stays");
    assert.equal(exists(join(dir, ".zcode")), false, "the installer's new tool root is gone");
    assert.equal(exists(join(dir, ".opencode")), false);
  }
  pass("H2 companion failure: companion writes in A and listed B undone; an unlisted concurrent B edit kept; installer roots removed");

  // H3. An unreadable dir OUTSIDE the surface no longer fails the update (mutation: whole-tree capture throws EACCES).
  if (!isRoot) {
    const dir = project("h3");
    put(join(dir, "data", "secret", "pg_control"), "root-owned container data");
    chmodSync(join(dir, "data", "secret"), 0o000);
    try {
      const ok = await runBmadUpdateWithCompanionPreservation(dir, {
        hadManifestG33: false, hadTomlG33: false, scope: derive(dir), runInstaller: runFake(dir, 0),
      });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.ok(ok.changedFiles.includes(join(dir, ".zcode", "skills", "bmad-help", "SKILL.md")), "success inventory is scoped and real");
      assert.ok(ok.changedFiles.includes(join(dir, "_bmad", "g33", "companion.md")));
      assert.ok(!ok.changedFiles.some((path) => path.startsWith(join(dir, "data"))), "nothing outside is read");
      const failDir = project("h3-fail");
      put(join(failDir, "data", "secret", "pg_control"), "root-owned container data");
      chmodSync(join(failDir, "data", "secret"), 0o000);
      try {
        const rolled = await failedUpdate(failDir, derive(failDir), 1);
        assert.equal(rolled.ok, false);
        assert.ok(!rolled.details.some((line) => /EACCES|rollback incomplete/.test(line)), rolled.details.join("\n"));
        assert.equal(read(join(failDir, "src", "new.ts")), "export const fresh = 1;\n");
        // Mutation: whole-tree mode throws on the unreadable dir before anything runs.
        await assert.rejects(runBmadUpdateWithCompanionPreservation(failDir, { hadManifestG33: false, hadTomlG33: false, runInstaller: runFake(failDir, 1) }), /EACCES/);
      } finally { chmodSync(join(failDir, "data", "secret"), 0o755); }
    } finally { chmodSync(join(dir, "data", "secret"), 0o755); }
    pass("H3 a chmod 000 dir outside the surface: update succeeds, rollback succeeds, no EACCES (whole-tree still throws)");

    // H4. An unreadable dir INSIDE the surface blocks before eviction or installer.
    const inside = project("h4");
    mkdirSync(join(inside, "_bmad", "bmm", "locked"), { recursive: true });
    chmodSync(join(inside, "_bmad", "bmm", "locked"), 0o000);
    const manifestBefore = read(join(inside, "_bmad", "_config", "manifest.yaml"));
    let installerRan = false;
    let evicted = false;
    try {
      const blocked = await runBmadUpdateWithCompanionPreservation(inside, {
        hadManifestG33: false, hadTomlG33: false, scope: derive(inside),
        beforeInstall: () => { evicted = true; return {}; },
        runInstaller: () => { installerRan = true; return runFake(inside, 0)(); },
      });
      assert.equal(blocked.ok, false);
      assert.match(blocked.error ?? "", /^unreadable entry inside BMAD-owned surface _bmad\/bmm\/locked/);
      assert.equal(installerRan || evicted, false, "neither eviction nor installer ran");
      assert.equal(read(join(inside, "_bmad", "_config", "manifest.yaml")), manifestBefore);
      assert.equal(exists(join(inside, ".zcode")), false);
    } finally { chmodSync(join(inside, "_bmad", "bmm", "locked"), 0o755); }
    pass("H4 an unreadable entry inside the surface blocks before eviction and installer (fail closed)");
  }

  // R1. The installer lowercases manifest ide ids; so must the declared scope (review: a `Cline` id was outside A).
  {
    const dir = project("r1-case");
    put(join(dir, "_bmad", "_config", "manifest.yaml"), "installation:\n  version: 6.11.0\nides:\n  - Cline\n  - CLAUDE-CODE\n");
    const scope = derive(dir);
    assert.equal(scope.mode, "declared", scope.reason);
    assert.ok(scope.ides.includes("cline"), `a capitalized manifest id resolves to its platform: ${scope.ides}`);
    assert.ok(scope.installerRoots.includes(".cline/skills"), "its target dir is class A (mutation: case-sensitive match)");
    const sb = captureScopedBackup(dir, scope);
    writerProcess(writerScript({ ".cline/skills/bmad-help/SKILL.md": "installer wrote this" }, dir));
    restoreScopedBackup(dir, sb, { companionChanged: "none" });
    assert.equal(exists(join(dir, ".cline")), false, "the capitalized id's target is rolled back");
  }
  pass("R1 manifest ide ids resolve case-insensitively, as the installer's handler lookup does");

  // R2. WDS subfolders are created INSIDE an existing design_artifacts dir (official-modules.js wds_folders).
  {
    const cache = join(scratch, "wds-cache");
    put(join(cache, "wds", "module.yaml"), `code: wds
design_artifacts:
  default: "design-artifacts"
  result: "{project-root}/{value}"
directories:
  - "{design_artifacts}"
wds_folders:
  - A-Product-Brief
  - B-Trigger-Map
  - C-Scenarios
`);
    const previous = process.env.BMAD_EXTERNAL_MODULES_CACHE;
    process.env.BMAD_EXTERNAL_MODULES_CACHE = cache;
    try {
      const dir = project("r2-wds");
      mkdirSync(join(dir, "design-artifacts", "C-Scenarios"), { recursive: true });
      put(join(dir, "design-artifacts", "brief-notes.md"), "operator notes");
      const scope = derive(dir);
      assert.equal(scope.mode, "declared", scope.reason);
      for (const rel of ["design-artifacts", "design-artifacts/A-Product-Brief", "design-artifacts/B-Trigger-Map", "design-artifacts/C-Scenarios"]) {
        assert.ok(scope.structuralPaths.includes(rel), `C holds ${rel}: ${scope.structuralPaths}`);
      }
      const sb = captureScopedBackup(dir, scope);
      writerProcess(writerScript({
        "design-artifacts/A-Product-Brief/": "", "design-artifacts/B-Trigger-Map/story.md": "an agent's story",
      }, dir));
      restoreScopedBackup(dir, sb, { companionChanged: "none" });
      assert.equal(exists(join(dir, "design-artifacts", "A-Product-Brief")), false, "an empty subfolder created in the window is removed (mutation: identity-only for the parent)");
      assert.equal(read(join(dir, "design-artifacts", "B-Trigger-Map", "story.md")), "an agent's story", "a subfolder holding a file is kept");
      assert.equal(exists(join(dir, "design-artifacts", "C-Scenarios")), true, "a subfolder that pre-existed is kept");
      assert.equal(read(join(dir, "design-artifacts", "brief-notes.md")), "operator notes");
    } finally {
      if (previous === undefined) delete process.env.BMAD_EXTERNAL_MODULES_CACHE; else process.env.BMAD_EXTERNAL_MODULES_CACHE = previous;
    }
  }
  pass("R2 wds_folders children of an existing design_artifacts dir: new empty ones removed, populated or pre-existing kept");

  // R3. A file that vanishes between lstat and read is "absent" for a restore-time capture, an error for the initial one.
  {
    const dir = join(scratch, "r3");
    const seed = () => {
      rmSync(dir, { recursive: true, force: true });
      put(join(dir, "a", "keep.txt"), "keep");
      put(join(dir, "a", "gone.txt"), "gone");
      put(join(dir, "a", "sub", "gone2.txt"), "gone2");
      symlinkSync("keep.txt", join(dir, "a", "gone-link"));
    };
    seed();
    const vanish = (full: string) => {
      if (/gone/.test(full)) rmSync(full, { recursive: true, force: true });
    };
    assert.throws(() => captureTreeBackup(dir, dir, new Map(), { beforeRead: vanish }), /ENOENT/, "the initial capture stays strict");
    seed();
    const tolerant = captureTreeBackup(dir, dir, new Map(), { beforeRead: vanish, tolerateVanished: true });
    assert.ok(tolerant.has("a/keep.txt"), "the stable file is captured");
    assert.equal(tolerant.has("a/gone.txt"), false, "the vanished file is absent, not an error (mutation: no ENOENT tolerance)");
    assert.equal(tolerant.has("a/gone-link"), false, "a vanished link too");
    assert.equal(tolerant.has("a/sub/gone2.txt"), false);
  }
  pass("R3 a restore-time capture treats a vanished entry as absent; the initial capture still throws");

  // R4. Real churn inside A (a separate process creating and deleting files) must not abort the restore.
  {
    const dir = project("r4-churn");
    const scope = derive(dir);
    const sb = captureScopedBackup(dir, scope);
    const churnDir = join(dir, "_bmad", "churn");
    mkdirSync(churnDir, { recursive: true });
    const churn = spawn(process.execPath, ["-e", `const fs=require('node:fs'),path=require('node:path');const d=${JSON.stringify(churnDir)};
for(;;){for(let i=0;i<600;i++)fs.writeFileSync(path.join(d,'f'+i),'x');for(let i=0;i<600;i++)fs.rmSync(path.join(d,'f'+i),{force:true});}`], { stdio: "ignore", env: hermeticEnv() });
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      let aborted = 0;
      for (let trial = 0; trial < 120; trial++) {
        writeFileSync(join(dir, "_bmad", "core", "config.yaml"), "clobbered");
        writeFileSync(join(dir, ".agents", "skills", "bmad-help", "SKILL.md"), "clobbered");
        const undone = restoreScopedBackup(dir, sb, { companionChanged: "none" });
        if (undone.details.some((line) => /ENOENT/.test(line))) aborted++;
        assert.equal(read(join(dir, "_bmad", "core", "config.yaml")), "project_name: fixture\n", `trial ${trial}: the restore reached the damaged file`);
        assert.equal(read(join(dir, ".agents", "skills", "bmad-help", "SKILL.md")), "---\nname: bmad-help\n---\nnative\n", `trial ${trial}`);
      }
      assert.equal(aborted, 0, "no restore aborted on a vanished churn file");
    } finally { churn.kill("SIGKILL"); }
  }
  pass("R4 churn inside A: 120 restores each reached the damaged files (mutation: ENOENT aborts the surface restore)");

  // R5. Host state never fails the update: an unusable state dir degrades the lock and the stash to advisories.
  {
    const stateFile = join(scratch, "state-is-a-file");
    writeFileSync(stateFile, "not a directory");
    const savedState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateFile;
    try {
      const dir = project("r5-ok");
      const lock = acquireBmadUpdateLock(dir);
      assert.equal(lock.ok, true, "an unusable state dir is not a held lock (mutation: mkdir throws)");
      assert.match((lock as { advisory?: string }).advisory ?? "", /lock unavailable/);
      if (lock.ok) lock.release();
      const ok = await runBmadUpdateWithCompanionPreservation(dir, { hadManifestG33: false, hadTomlG33: false, scope: derive(dir), runInstaller: runFake(dir, 0) });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.ok(ok.details.some((line) => /lock unavailable/.test(line)), ok.details.join("\n"));

      const failDir = project("r5-fail");
      const before = snapshotTree(failDir);
      const rolled = await failedUpdate(failDir, derive(failDir), 1);
      assert.equal(rolled.ok, false);
      assert.ok(!rolled.details.some((line) => line.startsWith("rollback incomplete")), rolled.details.join("\n"));
      assert.ok(rolled.details.some((line) => /could not stash/.test(line)), `an unwritable stash is reported:\n${rolled.details.join("\n")}`);
      for (const [rel, value] of before) {
        if (rel === "_bmad" || (rel.startsWith("_bmad/") && !rel.startsWith("_bmad/_memory")) || rel.startsWith(".agents/skills/")) assert.equal(snapshotTree(failDir).get(rel), value, `restored: ${rel}`);
      }
      assert.equal(exists(join(failDir, ".agents", "skills", "my-own-skill")), false, "the in-A note is reverted even without a stash");
      assert.equal(read(join(failDir, "src", "new.ts")), "export const fresh = 1;\n");
    } finally { process.env.XDG_STATE_HOME = savedState; }
  }
  pass("R5 an unusable state dir degrades the lock and stash to advisories; the update and its rollback still work");

  // R6. A recycled pid is not the holder: the lock records the process start time.
  {
    const dir = project("r6");
    const start = processStartId(process.pid);
    assert.ok(start, "this host can read a process start time");
    const first = acquireBmadUpdateLock(dir) as { ok: true; path: string; release(): void };
    first.release();
    writeFileSync(first.path, `${process.pid}:${start}`);
    const held = acquireBmadUpdateLock(dir);
    assert.equal(held.ok, false, "same pid, same start time: the holder is alive");
    writeFileSync(first.path, `${process.pid}:${start}-recycled`);
    const recycled = acquireBmadUpdateLock(dir);
    assert.equal(recycled.ok, true, "same pid, different start time: a recycled pid, stale (mutation: pid-only liveness)");
    if (recycled.ok) recycled.release();
    writeFileSync(first.path, String(process.pid));
    assert.equal(acquireBmadUpdateLock(dir).ok, false, "a legacy pid-only lock with a live pid still blocks");
    const old = new Date(Date.now() - 7 * 3600_000);
    utimesSync(first.path, old, old);
    const aged = acquireBmadUpdateLock(dir);
    assert.equal(aged.ok, true, "a lock older than the maximum update age is stale even with a live pid");
    if (aged.ok) aged.release();
  }
  pass("R6 lock: pid + start time; a recycled pid and an over-age lock are stale; a legacy pid-only lock still blocks");


  // H5. The companion's inventory failure widens B to 'all'.
  assert.equal(G33_INVENTORY_FAILED, "Could not inventory partial g33 writes");

  console.log(`PJAN-180 scoped rollback: ${checks} checkpoint groups passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
