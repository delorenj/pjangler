// PJAN-76 — BMAD is owned by bmad-method, not a frozen Skillex pack.
//
// pjangler used to pin `packs/bmad/<version>` in the Skillex registry and
// project it into `.agents/skills` as symlinks, duplicating what
// `bmad-method install` already writes there natively. Two sources of truth for
// the same files only had to survive until one moved: on 2026-08-18 the
// registry dropped `packs/bmad`, and every machine without a warm cache lost
// `pjangler project create` to "Pack bmad could not be resolved".
//
// The checks below pin the three properties that keep that from recurring:
//   1. nothing resolves a `bmad` pack any more, on a cold cache or otherwise;
//   2. `.agents/skills.json` never records `bmad-*`, so the installer is the
//      only writer of those paths;
//   3. the installer is only ever asked for the six supported CLI roots — no
//      .trae / .cline / .cursor / .qwen deluge.
//
// (3) is checked structurally rather than by installing, because the failure
// mode is a missing or widened `--tools`, and a real install is far too slow to
// run per-tool. The end-to-end proof that a create emits exactly six roots is
// in the create test below, which does run the real installer.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pjan-76-"));
process.env.GIT_CEILING_DIRECTORIES = workspace;

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
  }
}

process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

const rulesSource = readFileSync(join(root, "src", "parity", "rules.ts"), "utf8");
/**
 * Comments in this file legitimately DESCRIBE the retired pack, so a naive
 * scan of the whole source matches its own explanation and fails forever.
 * Everything asserted below is about code, so comments come out first.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const rulesCode = codeOnly(rulesSource);
const provisionCode = readFileSync(
  join(root, "templates", "commonproject", "template", ".mise", "scripts", "provision-packs.py"),
  "utf8",
).replace(/^\s*#.*$/gm, "").replace(/"""[\s\S]*?"""/g, "");

// ---------------------------------------------------------------------------
// 1. Neither side pins a BMAD pack any more.
//
// The TypeScript and the Python each carried their own copy of the pin, and
// removing only one leaves `project create` broken exactly as before — the
// Python is what Copier runs.
// ---------------------------------------------------------------------------
check("no BMAD pack is pinned implicitly on either side", () => {
  assert.doesNotMatch(rulesCode, /BMAD_PACK_VERSION/, "src/parity/rules.ts still pins a BMAD pack version");
  assert.doesNotMatch(rulesCode, /bmadPackEntry/, "src/parity/rules.ts still builds an implicit BMAD pack entry");
  assert.doesNotMatch(provisionCode, /BMAD_PACK_VERSION/, "provision-packs.py still pins a BMAD pack version");
  assert.doesNotMatch(provisionCode, /implicit_bmad_entry/, "provision-packs.py still builds an implicit BMAD pack entry");
  // The registry no longer ships packs/bmad at all, so any surviving path
  // construction is a resolution that will fail on a cold cache.
  assert.doesNotMatch(rulesCode, /["']packs\/bmad|"packs",\s*"bmad"/, "src/parity/rules.ts still builds a packs/bmad path");
  assert.doesNotMatch(provisionCode, /["']packs\/bmad|"packs",\s*"bmad"/, "provision-packs.py still builds a packs/bmad path");
});

// ---------------------------------------------------------------------------
// 2. The installer is only ever asked for the six supported CLI roots.
//
// bmad-method installs for every tool it knows unless `--tools` narrows it,
// which is how repos sprouted .trae, .cline, .cursor, .qwen and friends. One
// function builds the argv, so this asserts that function and that every
// invocation goes through it.
// ---------------------------------------------------------------------------
check("bmad-method is only ever invoked with the six supported --tools", () => {
  assert.match(
    rulesSource,
    /const BMAD_INSTALL_TOOLS = SUPPORTED_BMAD_TOOLS;/,
    "the installed tool list must be exactly the supported-CLI policy, not a second hand-maintained list",
  );

  const args = /function bmadInstallerArgs\([\s\S]*?\n}/.exec(rulesSource);
  assert.ok(args, "bmadInstallerArgs not found");
  assert.match(args[0], /"--tools",\s*\n?\s*BMAD_INSTALL_TOOLS\.join\(","\)/, "bmadInstallerArgs must pin --tools");

  // Every path that reaches the installer must go through that builder. A
  // direct spawn with its own argv is exactly how an unnarrowed install would
  // sneak back in.
  const spawns = [...rulesSource.matchAll(/spawnSync\(\s*invocation\.command\s*,\s*\[([^\]]*)\]/g)];
  assert.ok(spawns.length > 0, "expected at least one installer spawn");
  for (const spawn of spawns) {
    const argv = spawn[1];
    const narrowed = argv.includes("bmadInstallerArgs") || argv.includes('"--version"');
    assert.ok(narrowed, `installer spawned with un-narrowed argv: ${argv.trim()}`);
  }
});

// ---------------------------------------------------------------------------
// 3. A real create emits exactly the six supported roots, and BMAD skills come
//    from the installer rather than a pack.
//
// This runs the real `bmad-method` installer against a HOME with no registry
// cache at all — the machine state that turned the pack removal into an
// outage. It is the slow check in this file and the only one that proves the
// whole path.
// ---------------------------------------------------------------------------
check("a create on a cold cache installs BMAD and emits only supported CLI roots", () => {
  const home = join(workspace, "home");
  const target = join(workspace, "freshproj");
  mkdirSync(home, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [join(root, "dist", "index.js"), "project", "init", "--yes", "--apply", "--skip-board", "--target-dir", target, "--json"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 900_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_CONFIG_HOME: join(home, ".config"),
        GIT_CEILING_DIRECTORIES: workspace,
        NO_COLOR: "1",
      },
    },
  );
  assert.equal(result.status, 0, `project init failed:\n${result.stdout}\n${result.stderr}`);

  // BMAD came from the installer: a manifest with a version, and real skill
  // directories rather than symlinks into a pack cache.
  const manifest = join(target, "_bmad", "_config", "manifest.yaml");
  assert.ok(existsSync(manifest), "_bmad/_config/manifest.yaml missing — bmad-method did not install");
  assert.match(readFileSync(manifest, "utf8"), /^\s*version:\s*\S+/m, "installed BMAD manifest carries no version");

  const skills = readdirSync(join(target, ".agents", "skills"), { withFileTypes: true });
  const bmadSkills = skills.filter((entry) => entry.name.startsWith("bmad-"));
  assert.ok(bmadSkills.length > 0, "installer produced no bmad-* skills");
  for (const entry of bmadSkills) {
    assert.ok(
      !entry.isSymbolicLink(),
      `${entry.name} is a symlink — something is still projecting BMAD from a pack`,
    );
  }

  // The manifest must not claim them; two writers for one path is the bug.
  const declared = JSON.parse(readFileSync(join(target, ".agents", "skills.json"), "utf8"));
  const declaredBmad = (declared.skills ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter((name) => typeof name === "string" && name.startsWith("bmad-"));
  assert.deepEqual(declaredBmad, [], ".agents/skills.json records bmad-* skills that bmad-method owns");

  // The deluge check: only the six supported roots, nothing else.
  const SUPPORTED = [".claude", ".codex", ".gemini", ".copilot", ".opencode", ".kimi-code"];
  const ALLOWED_OTHER = [".agents", ".github", ".mise", ".git", ".gitignore", ".env.op", ".project.json", ".copier-answers.yml"];
  const unexpected = readdirSync(target)
    .filter((name) => name.startsWith("."))
    .filter((name) => !SUPPORTED.includes(name) && !ALLOWED_OTHER.includes(name));
  assert.deepEqual(unexpected, [], `bmad-method emitted unsupported CLI root(s): ${unexpected.join(", ")}`);
  for (const supported of SUPPORTED) {
    assert.ok(existsSync(join(target, supported)), `supported CLI root ${supported} was not created`);
  }

  // ...and the generated projections stay out of git.
  //
  // PJAN-82: no trailing slash. A trailing slash matches a directory only, and
  // the projection is not always a directory: bmad-method writes a real one
  // into .claude/.codex/.opencode while sync-skills.py projects
  // .gemini/.copilot/.kimi-code as a SYMLINK to ../.agents/skills. So
  // `.gemini/skills/` never matched, the `!.gemini/**` un-ignore won, and
  // `git add -A` staged three generated projections as tracked symlinks.
  const gitignore = readFileSync(join(target, ".gitignore"), "utf8").split(/\r?\n/);
  assert.ok(gitignore.includes("/.agents/skills"), ".gitignore must ignore the generated /.agents/skills");
  for (const supported of SUPPORTED) {
    assert.ok(gitignore.includes(`${supported}/skills`), `.gitignore must ignore the generated ${supported}/skills`);
    assert.ok(!gitignore.includes(`${supported}/skills/`), `${supported}/skills must have NO trailing slash — it can be a symlink`);
  }
});

if (failures.length) {
  console.error(`\npjan-76: ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("pjan-76 regressions passed");
