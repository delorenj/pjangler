import "./helpers/hermetic-suite.mjs";
import { createSkillPackFixture, createBmadInstallerFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
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
//   3. the installer is only ever asked for the seven supported CLI roots — no
//      .trae / .cline / .cursor / .qwen deluge.
//
// (3) is checked structurally rather than by installing, because the failure
// mode is a missing or widened `--tools`, and a real install is far too slow to
// run per-tool. The end-to-end proof that an init emits exactly seven roots is
// in the create test below, which does run the real installer.

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workspace = hermeticScratch("pjan-76-");
createSkillPackFixture(join(workspace, "catalog"));
const skillexBin = createSkillexMiseFixture(workspace);
const bmadInstaller = createBmadInstallerFixture(workspace);
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
assert.equal(existsSync(join(root, "templates", "commonproject", "template", ".mise", "scripts", "provision-packs.py")), false, "the duplicate provisioner is retired");
const provisionCode = "";

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
// 2. The installer is only ever asked for the seven supported CLI roots.
//
// bmad-method installs for every tool it knows unless `--tools` narrows it,
// which is how repos sprouted .trae, .cline, .cursor, .qwen and friends. One
// function builds the argv, so this asserts that function and that every
// invocation goes through it.
// ---------------------------------------------------------------------------
check("bmad-method is only ever invoked with the seven supported --tools", () => {
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
// 3. A real init emits exactly the seven supported roots, and BMAD skills come
//    from the installer rather than a pack.
//
// This runs the real `bmad-method` installer against a HOME with no registry
// cache at all — the machine state that turned the pack removal into an
// outage. It is the slow check in this file and the only one that proves the
// whole path.
// ---------------------------------------------------------------------------
check("an init on a cold cache installs BMAD and emits only supported CLI roots", () => {
  const home = join(workspace, "home");
  const target = join(workspace, "freshproj");
  // The registry defaults to the SERVICE at http://localhost:8764, so an
  // unpinned create here registered `freshproj` in the operator's real Postgres
  // — pointing at this temp dir, which is deleted on exit. `pj doctor` then
  // reported a broken row forever, and, worse, the next run of this file hit
  // "Project slug already exists in registry: freshproj" and could never pass
  // again. registryClient.isRegistryServiceLocation() treats anything that is
  // not ^https?:// as a fixture file, so a path here routes the whole registry
  // through YAML inside the workspace. The env var covers any child the CLI
  // spawns without the flag; the flag pins the create itself.
  const registry = join(workspace, "registry.yaml");
  const globalIgnore = join(home, ".config", "git", "ignore");
  mkdirSync(join(home, ".config", "git"), { recursive: true });
  const SUPPORTED = [".claude", ".codex", ".gemini", ".copilot", ".opencode", ".kimi-code", ".zcode"];
  // skillex (>=0.4.3) also aliases Kimi CLI's own `.kimi/skills` in every project.
  // No BMAD tool backs it, so it is not a supported CLI projection, but it is not
  // the deluge this check hunts either: it is one symlink skillex itself owns.
  const SKILLEX_ALIAS_ROOTS = [".kimi"];
  writeFileSync(globalIgnore, `${[...SUPPORTED, ...SKILLEX_ALIAS_ROOTS].map((clientRoot) => `${clientRoot}/`).join("\n")}\n`);

  const isolatedEnv = hermeticEnv({
    PATH: `${skillexBin}:${process.env.PATH}`, PJ_SKILLS_REGISTRY_ROOT: join(workspace, "catalog"), PJ_BMAD_INSTALLER: bmadInstaller,
    PJ_PROJECT_REGISTRY: registry,
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CEILING_DIRECTORIES: workspace,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: globalIgnore,
    NO_COLOR: "1",
  });

  const result = spawnSync(
    process.execPath,
    [join(root, "dist", "index.js"), "project", "init", "--yes", "--apply", "--skip-board", "--registry", registry, "--target-dir", target, "--json"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 900_000,
      env: isolatedEnv,
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
  const ALLOWED_OTHER = [".agents", ".github", ".mise", ".git", ".gitignore", ".env.op", ".project.json", ".copier-answers.yml"];
  const unexpected = readdirSync(target)
    .filter((name) => name.startsWith("."))
    .filter((name) => !SUPPORTED.includes(name) && !SKILLEX_ALIAS_ROOTS.includes(name) && !ALLOWED_OTHER.includes(name));
  assert.deepEqual(unexpected, [], `bmad-method emitted unsupported CLI root(s): ${unexpected.join(", ")}`);
  for (const supported of SUPPORTED) {
    assert.ok(existsSync(join(target, supported)), `supported CLI root ${supported} was not created`);
  }

  // Retired link provenance is verified against the real CLI entrypoint on the
  // freshly initialized project, with this suite's isolated HOME/cache/registry.
  const cli = join(root, "dist", "index.js");
  const migrate = (dryRun = false, project = target, env = isolatedEnv) => {
    const result = spawnSync(process.execPath, [cli, "migrate", "bmad.scaffold", project, "--json", ...(dryRun ? ["--dry-run"] : [])], {
      cwd: workspace, encoding: "utf8", env, timeout: 120_000,
    });
    const report = JSON.parse(result.stdout);
    return { result, rule: report.results.find((entry) => entry.id === "bmad.scaffold") };
  };
  // The installer follows an existing selected catalog link even though the
  // eviction planner must preserve it. Refuse the collision before invocation.
  const selectedProject = join(workspace, "selected-project");
  const selectedCatalog = join(workspace, "selected-catalog");
  const selectedSkill = join(selectedCatalog, "all-skills", "bmad-help");
  const selectedLink = join(selectedProject, ".agents", "skills", "bmad-help");
  mkdirSync(selectedSkill, { recursive: true });
  mkdirSync(join(selectedProject, ".agents", "skills"), { recursive: true });
  writeFileSync(join(selectedSkill, "SKILL.md"), "CUSTOM SELECTED CATALOG BYTES\n");
  writeFileSync(join(selectedProject, ".agents", "skills.json"), JSON.stringify({ inherit_global: false, skills: ["bmad-help"] }));
  writeFileSync(join(selectedProject, ".project.json"), JSON.stringify({ name: "selected-project", version: "1.0.0" }));
  symlinkSync(selectedSkill, selectedLink);
  const selectedEnv = { ...isolatedEnv, PJ_SKILLS_REGISTRY_ROOT: selectedCatalog };
  for (const dryRun of [true, false]) {
    const blocked = migrate(dryRun, selectedProject, selectedEnv);
    assert.notEqual(blocked.result.status, 0);
    assert.equal(blocked.rule.status, "blocked", JSON.stringify(blocked.rule));
    assert.match(JSON.stringify(blocked.rule), /\.agents\/skills\/bmad-help/);
    assert.deepEqual(blocked.rule.changedFiles, []);
    assert.equal(readlinkSync(selectedLink), selectedSkill);
    assert.equal(readFileSync(join(selectedSkill, "SKILL.md"), "utf8"), "CUSTOM SELECTED CATALOG BYTES\n");
  }

  // A lexical retired-pack path can pass through a symlinked registry parent
  // into a personal tree. Neither preview nor apply may claim its deletion.
  const aliasProject = join(workspace, "alias-project");
  const aliasCatalog = join(workspace, "alias-catalog");
  const personalTree = join(workspace, "personal-tree");
  const aliasParent = join(aliasCatalog, "packs", "bmad");
  const aliasSource = join(personalTree, "6.0.0", "skills", "bmad-personal");
  const aliasLink = join(aliasProject, ".agents", "skills", "bmad-personal");
  mkdirSync(join(aliasProject, ".agents", "skills"), { recursive: true });
  mkdirSync(join(aliasCatalog, "packs"), { recursive: true });
  mkdirSync(aliasSource, { recursive: true });
  writeFileSync(join(aliasSource, "SKILL.md"), "UNRELATED USER BYTES\n");
  writeFileSync(join(aliasProject, ".agents", "skills.json"), JSON.stringify({ inherit_global: false, skills: [] }));
  writeFileSync(join(aliasProject, ".project.json"), JSON.stringify({ name: "alias-project", version: "1.0.0" }));
  symlinkSync(personalTree, aliasParent);
  symlinkSync(join(aliasParent, "6.0.0", "skills", "bmad-personal"), aliasLink);
  const aliasEnv = { ...isolatedEnv, PJ_SKILLS_REGISTRY_ROOT: aliasCatalog };
  for (const dryRun of [true, false]) {
    const blocked = migrate(dryRun, aliasProject, aliasEnv);
    assert.notEqual(blocked.result.status, 0);
    assert.equal(blocked.rule.status, "blocked", JSON.stringify(blocked.rule));
    assert.match(JSON.stringify(blocked.rule), /\.agents\/skills\/bmad-personal/);
    assert.doesNotMatch(JSON.stringify(blocked.rule), /retired BMAD pack symlink/);
    assert.deepEqual(blocked.rule.changedFiles, []);
    assert.equal(readlinkSync(aliasLink), join(aliasParent, "6.0.0", "skills", "bmad-personal"));
    assert.equal(readFileSync(join(aliasSource, "SKILL.md"), "utf8"), "UNRELATED USER BYTES\n");
  }
  const canonical = join(target, ".agents", "skills");
  const custom = join(workspace, "personal-skill");
  mkdirSync(custom);
  writeFileSync(join(custom, "SKILL.md"), "personal bytes\n");
  const personal = join(canonical, "bmad-my-personal");
  symlinkSync(custom, personal);
  const pendingPack = join(workspace, "catalog", "packs", "bmad", "6.0.0", "skills", "bmad-pending");
  const pendingLink = join(canonical, "bmad-pending");
  symlinkSync(pendingPack, pendingLink);
  const blocked = migrate();
  assert.notEqual(blocked.result.status, 0, "unknown link must refuse migration");
  assert.equal(blocked.rule.status, "blocked");
  assert.match(JSON.stringify(blocked.rule), /\.agents\/skills\/bmad-my-personal/);
  assert.doesNotMatch(JSON.stringify(blocked.rule), /removed retired BMAD pack symlink/);
  assert.equal(readlinkSync(personal), custom);
  assert.equal(readlinkSync(pendingLink), pendingPack, "a later conflict must prevent earlier proven removals");
  assert.equal(readFileSync(join(custom, "SKILL.md"), "utf8"), "personal bytes\n");

  // The same refusal must happen for a dangling custom link and in dry-run.
  rmSync(personal);
  symlinkSync(join(workspace, "unknown-missing-skill"), personal);
  assert.equal(migrate(true).rule.status, "blocked");
  assert.equal(lstatSync(personal).isSymbolicLink(), true);
  assert.equal(lstatSync(pendingLink).isSymbolicLink(), true);
  rmSync(personal);
  rmSync(pendingLink);

  // Every supported physical skill root, canonical included: live absolute,
  // live relative, and dangling pack targets. Unlink only the projection.
  const allRoots = [canonical, ...SUPPORTED.map((name) => join(target, name, "skills"))];
  const pack = join(workspace, "catalog", "packs", "bmad", "6.0.0", "skills");
  const links = [];
  for (const [index, skillRoot] of allRoots.entries()) {
    // Init's CLI aliases point to canonical: replace the alias with an empty
    // physical directory so each projection can be verified independently.
    if (lstatSync(skillRoot).isSymbolicLink()) rmSync(skillRoot);
    mkdirSync(skillRoot, { recursive: true });
    const name = `bmad-retired-${index}`;
    const destination = join(skillRoot, name);
    const source = join(pack, name);
    if (index !== 2) {
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "SKILL.md"), `retired-${index}\n`);
    }
    symlinkSync(index % 2 ? relative(skillRoot, source) : source, destination);
    links.push({ destination, source, index });
  }
  const preview = migrate(true);
  assert.equal(preview.rule.status, "applied", JSON.stringify(preview.rule));
  for (const { destination } of links) {
    assert.ok(preview.rule.changedFiles.includes(destination), `preview missed ${destination}`);
    assert.equal(lstatSync(destination).isSymbolicLink(), true, `preview mutated ${destination}`);
  }
  const applied = migrate();
  assert.equal(applied.result.status, 0, JSON.stringify(applied.rule));
  for (const { destination, source, index } of links) {
    assert.ok(applied.rule.changedFiles.includes(destination), `cleanup missed ${destination}`);
    assert.match(applied.rule.details.join("\n"), new RegExp(`removed retired BMAD pack symlink .*bmad-retired-${index}`));
    assert.equal(existsSync(destination), false, `retired link survived at ${destination}`);
    if (index !== 2) assert.equal(readFileSync(join(source, "SKILL.md"), "utf8"), `retired-${index}\n`);
  }
  const repeated = migrate();
  assert.equal(repeated.result.status, 0, JSON.stringify(repeated.rule));
  assert.doesNotMatch(repeated.rule.details.join("\n"), /retired BMAD pack symlink/);

  // A foreign skills-root alias must not redirect cleanup into another tree.
  const alias = join(target, ".zcode", "skills");
  rmSync(alias, { recursive: true, force: true });
  const foreign = join(workspace, "foreign-skills");
  mkdirSync(foreign);
  const foreignLink = join(foreign, "bmad-foreign");
  symlinkSync(join(pack, "bmad-foreign"), foreignLink);
  symlinkSync(foreign, alias);
  const refusedAlias = migrate();
  assert.equal(refusedAlias.rule.status, "blocked");
  assert.match(JSON.stringify(refusedAlias.rule), /\.zcode\/skills/);
  assert.ok(lstatSync(foreignLink).isSymbolicLink());
  assert.equal(readlinkSync(alias), foreign);
  rmSync(alias);
  mkdirSync(alias);
  const cliCustom = join(alias, "bmad-my-cli-custom");
  symlinkSync(relative(alias, custom), cliCustom);
  const refusedCli = migrate(true);
  assert.equal(refusedCli.rule.status, "blocked");
  assert.match(JSON.stringify(refusedCli.rule), /\.zcode\/skills\/bmad-my-cli-custom/);
  assert.equal(readlinkSync(cliCustom), relative(alias, custom));
  assert.equal(readFileSync(join(custom, "SKILL.md"), "utf8"), "personal bytes\n");

  // ...and the generated projections stay out of git through the effective
  // global policy. The repository contract keeps only canonical `.agents`.
  const gitignore = readFileSync(join(target, ".gitignore"), "utf8").split(/\r?\n/);
  assert.ok(gitignore.includes("/.agents/skills"), ".gitignore must ignore the generated /.agents/skills");
  for (const supported of SUPPORTED) {
    assert.ok(!gitignore.includes(`!${supported}/`), `.gitignore must not unignore the local ${supported} projection`);
    assert.ok(!gitignore.includes(`${supported}/skills`), `.gitignore must not duplicate global policy for ${supported}/skills`);
    const ignored = spawnSync("git", ["check-ignore", "-q", `${supported}/skills`], {
      cwd: target,
      encoding: "utf8",
      env: isolatedEnv,
    });
    assert.equal(ignored.status, 0, `${supported}/skills must be ignored by the effective global policy`);
  }
});

function snapshot(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) return { link: readlinkSync(path) };
  if (stat.isDirectory()) return Object.fromEntries(readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]));
  return { bytes: readFileSync(path).toString("base64") };
}

// Exercise both shared planner callers, including a cached version response so
// bmad.version reaches the preflight without touching the network or real HOME.
for (const ruleId of ["bmad.scaffold", "bmad.version"]) {
  for (const linkKind of ["absolute", "relative"]) {
    for (const scenario of [
      "outside-parent", "prefix-sibling", "configured-checkout", "legacy-checkout",
      "cache-parent-escape", "cancelled-alias", "direct-source-alias", "current-noncolliding",
      "retired-live", "retired-dangling", "physical-dotdot", "cache-checkout",
    ]) {
      check(`${ruleId} ${linkKind} ${scenario} preserves the provenance boundary`, () => {
        const base = join(workspace, ruleId, linkKind, scenario);
        const project = join(base, "project"), home = join(base, "home"), catalog = join(base, "catalog");
        const skills = join(project, ".agents", "skills");
        const name = scenario === "current-noncolliding" ? "bmad-html-workspace" : "bmad-help";
        const link = join(skills, name);
        const packSuffix = ["packs", "bmad", "6.0.0", "skills", name];
        mkdirSync(skills, { recursive: true });
        for (const dir of [home, ...["all-skills", "sets", "packs"].map((name) => join(catalog, name))]) mkdirSync(dir, { recursive: true });
        writeFileSync(join(project, ".project.json"), JSON.stringify({ project_name: "project", bmad: { companion: { enabled: false } } }));
        writeFileSync(join(project, ".agents", "skills.json"), JSON.stringify({ inherit_global: false, skills: scenario === "current-noncolliding" ? [name] : [] }));
        if (ruleId === "bmad.version") {
          mkdirSync(join(project, "_bmad", "_config"), { recursive: true });
          writeFileSync(join(project, "_bmad", "_config", "manifest.yaml"), "installation:\n  version: 1.0.0\nmodules:\n  - name: core\n");
          mkdirSync(join(home, ".cache", "pjangler"), { recursive: true });
          writeFileSync(join(home, ".cache", "pjangler", "bmad-dist-tags.json"), JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.13.0", next: "6.13.0" } }));
        }
        let source = join(catalog, ...packSuffix), raw = source;
        if (scenario === "outside-parent") source = raw = join(base, ...packSuffix);
        if (scenario === "prefix-sibling") source = raw = join(`${catalog}-sibling`, ...packSuffix);
        if (scenario === "configured-checkout") source = raw = join(catalog, "unrelated", ...packSuffix);
        if (scenario === "legacy-checkout") source = raw = join(home, "code", "skillex", "unrelated", ...packSuffix);
        if (scenario === "cache-parent-escape") source = raw = join(home, ".agents", ".cache", ...packSuffix);
        if (scenario === "cache-checkout") source = raw = join(home, ".agents", ".cache", "registries", "checkout", ...packSuffix);
        if (scenario === "current-noncolliding") source = raw = join(catalog, "all-skills", name);
        if (scenario === "cancelled-alias") {
          mkdirSync(join(base, "private", "nested"), { recursive: true });
          symlinkSync(join(base, "private", "nested"), join(base, "alias"));
          source = join(base, "private", "catalog", ...packSuffix);
          raw = `${base}/alias/../catalog/${packSuffix.join("/")}`;
          // The normalized trusted path also exists, but is NOT the raw target.
          mkdirSync(join(catalog, ...packSuffix), { recursive: true });
          writeFileSync(join(catalog, ...packSuffix, "SKILL.md"), "TRUSTED DECOY\n");
        }
        if (scenario === "direct-source-alias") {
          symlinkSync(join(base, "private"), join(catalog, "packs", "bmad"));
          source = join(base, "private", "6.0.0", "skills", name);
        }
        if (scenario === "physical-dotdot") {
          mkdirSync(join(base, "physical"), { recursive: true });
          raw = `${base}/physical/../catalog/${packSuffix.join("/")}`;
        }
        if (scenario !== "retired-dangling") {
          mkdirSync(source, { recursive: true });
          writeFileSync(join(source, "SKILL.md"), "USER SOURCE BYTES\n");
        }
        // relative() normalizes alias/.. away; relativize only the prefix.
        const text = linkKind === "absolute" ? raw : `${relative(skills, base)}/${raw.slice(base.length + 1)}`;
        symlinkSync(text, link);
        if (scenario !== "retired-dangling") assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), "USER SOURCE BYTES\n");
        const allowed = ["retired-live", "retired-dangling", "physical-dotdot", "cache-checkout"].includes(scenario);
        // A valid sibling must not be evicted if any conflict is found later.
        const pending = join(skills, "bmad-aaa-pending");
        const pendingTarget = join(catalog, "packs", "bmad", "6.0.0", "skills", "bmad-aaa-pending");
        symlinkSync(pendingTarget, pending);
        const before = snapshot(project), sourceBefore = snapshot(source), catalogBefore = snapshot(catalog);
        const env = hermeticEnv({
          HOME: home, XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".state"),
          TMPDIR: base, PJ_SKILLS_REGISTRY_ROOT: catalog, PJ_BMAD_INSTALLER: bmadInstaller,
          PJ_PROJECT_REGISTRY: join(base, "registry.yaml"), GIT_CEILING_DIRECTORIES: workspace,
        });
        for (const [run, dryRun] of [true, false, false].entries()) {
          const result = spawnSync(process.execPath, [join(root, "dist", "index.js"), "migrate", ruleId, project, "--json", ...(dryRun ? ["--dry-run"] : [])], {
            cwd: base, encoding: "utf8", env, timeout: 120_000,
          });
          assert.equal(result.error, undefined);
          const report = JSON.parse(result.stdout);
          const finding = report.results.find((entry) => entry.id === ruleId);
          assert.ok(finding, result.stdout);
          if (!allowed) {
            assert.equal(result.status, 1, result.stdout);
            assert.equal(finding.status, "blocked", result.stdout);
            assert.deepEqual(finding.changedFiles, []);
            assert.match(JSON.stringify(finding), new RegExp(`\\.agents/skills/${name}`));
            assert.match(JSON.stringify(finding), /review and relocate .*link before retrying/);
            assert.doesNotMatch(JSON.stringify(finding), /retired BMAD pack symlink/);
            assert.equal(readlinkSync(link), text);
            assert.equal(readlinkSync(pending), pendingTarget);
            assert.deepEqual(snapshot(project), before, "refusal mutated project");
            assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), "USER SOURCE BYTES\n");
          } else {
            assert.equal(result.status, 0, result.stdout);
            if (run < 2) {
              assert.ok(finding.changedFiles.includes(link), result.stdout);
              assert.match(finding.details.join("\n"), /retired BMAD pack symlink \.agents\/skills\/bmad-help/);
            } else {
              assert.doesNotMatch(finding.details.join("\n"), /retired BMAD pack symlink/);
            }
            if (dryRun) {
              assert.equal(readlinkSync(link), text);
              assert.deepEqual(snapshot(project), before, "preview mutated project");
            } else {
              assert.equal(lstatSync(link).isSymbolicLink(), false, "installer must replace retired activation with its own directory");
              assert.equal(existsSync(pending), false);
            }
          }
          assert.deepEqual(snapshot(source), sourceBefore, "source bytes changed");
          assert.deepEqual(snapshot(catalog), catalogBefore, "catalog bytes changed");
        }
      });
    }
  }
}

if (failures.length) {
  console.error(`\npjan-76: ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("pjan-76 regressions passed");
