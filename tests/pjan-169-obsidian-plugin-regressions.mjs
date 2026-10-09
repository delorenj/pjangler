import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { createBmadInstallerFixture, createSkillPackFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";

// PJAN-169: `pj init --obsidian-plugin` is a normal project init whose
// CommonProject render is the Obsidian community-plugin variant (the canonical
// obsidianmd/obsidian-sample-plugin layered over the base skeleton). Everything
// here goes through the REAL CLI, the REAL copier and the REAL template; the
// assertions read the files on disk.

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const templateRoot = join(root, "templates", "commonproject");
const PLUGIN_FILES = [
  "manifest.json",
  "versions.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "esbuild.config.mjs",
  "eslint.config.mts",
  "version-bump.mjs",
  "styles.css",
  ".editorconfig",
  ".npmrc",
  "src/main.ts",
  "src/settings.ts",
  ".github/workflows/lint.yml",
  ".github/workflows/release.yml",
  ".mise/tasks/plugin/link",
];
let lifecycleEnv = {};

function invoke(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...lifecycleEnv },
    maxBuffer: 32 * 1024 * 1024,
  });
}

function run(args, cwd) {
  const result = invoke(args, cwd);
  if (result.status !== 0) {
    throw new Error(`command failed: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...lifecycleEnv } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function walk(dir, skip = new Set([".git", "_bmad", "node_modules"])) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...walk(path, skip));
    else out.push(path);
  }
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), "pjan-169-"));
try {
  const homeDir = join(tmp, "home");
  mkdirSync(homeDir);
  const fixtureRoot = join(tmp, "bmad-fixtures");
  const registry = join(tmp, "projects.yaml");
  lifecycleEnv = {
    HOME: homeDir,
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_STATE_HOME: join(tmp, "state"),
    PATH: `${createSkillexMiseFixture(tmp)}:${process.env.PATH}`,
    SKILLEX_REGISTRY_ROOT: fixtureRoot,
    PJ_SKILLS_REGISTRY_ROOT: fixtureRoot,
    PJ_AGENT_HOOKS_LAYER: "0",
    PJ_PACK_ROOT_PJTEST: createSkillPackFixture(fixtureRoot),
    PJ_BMAD_INSTALLER: createBmadInstallerFixture(fixtureRoot),
    GIT_CEILING_DIRECTORIES: tmp,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    npm_config_cache: join(tmp, "empty-npm-cache"),
    npm_config_offline: "true",
  };

  // --- template contract --------------------------------------------------
  const copier = YAML.parse(readFileSync(join(templateRoot, "copier.yml"), "utf8"));
  assert.deepEqual(Object.values(copier.project_type.choices).sort(), ["base", "obsidian-plugin"]);
  assert.equal(copier.project_type.default, "base");
  // A `when: false` question is never written to .copier-answers.yml, so a
  // re-copy would forget the type and re-render the shared files as base.
  assert.equal(copier.project_type.when, undefined, "project_type must be a recorded (asked) question");
  const templatePaths = walk(join(templateRoot, "template"), new Set()).map((path) => relative(join(templateRoot, "template"), path));
  const variantPaths = templatePaths.filter((path) => path.includes("is_obsidian_plugin"));
  assert.ok(variantPaths.length >= PLUGIN_FILES.length - 1, `variant paths: ${variantPaths.join(", ")}`);
  for (const path of templatePaths) {
    // npm pack silently drops these basenames from the published tarball.
    // .agents/hooks/.gitignore already does (PJAN-170); nothing may join it.
    if (path === ".agents/hooks/.gitignore") continue;
    assert.doesNotMatch(path, /(^|\/)\.(gitignore|npmrc)$/, `${path} would vanish from the npm package`);
  }
  for (const path of walk(join(templateRoot, "template", ".github", "workflows"), new Set())) {
    const text = readFileSync(path, "utf8");
    // Hosted runner minutes are billed and the budget is $0.
    assert.doesNotMatch(text, /runs-on:\s*\[?\s*(ubuntu|macos|windows)-/, `${path} uses a GitHub-hosted runner`);
  }

  // --- planning -----------------------------------------------------------
  const pluginDir = join(tmp, "obsidian-tag-wrangler");
  const planned = JSON.parse(run([
    "init", "obsidian-tag-wrangler", "--obsidian-plugin", "--description", "Wrangle tags: fast",
    "--registry", registry, "--skip-board", "--dry-run", "--json",
  ], tmp));
  const plannedCopier = planned.actions.find((action) => action.kind === "copier.copy.commonproject");
  assert.equal(plannedCopier.data.project_type, "obsidian-plugin");
  assert.ok(plannedCopier.command.includes("project_type=obsidian-plugin"));
  assert.ok(plannedCopier.command.includes("--vcs-ref=HEAD"), "PJAN-49 pin must survive");
  assert.equal(planned.project.template.commonproject.project_type, "obsidian-plugin");
  assert.equal(planned.project.template.commonproject.primary_language, "typescript");

  const legacyAlias = JSON.parse(run([
    "project", "init", "alias-plugin", "--obsidian-plugin", "--registry", registry, "--skip-board", "--dry-run", "--json",
  ], tmp));
  assert.equal(legacyAlias.project.template.commonproject.project_type, "obsidian-plugin", "the deprecated `project init` alias takes the flag too");

  const plainPlan = JSON.parse(run(["init", "plain-thing", "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp));
  assert.equal(plainPlan.actions.find((action) => action.kind === "copier.copy.commonproject").data.project_type, "base");
  assert.equal("project_type" in plainPlan.project.template.commonproject, false, "a base record gains no key");
  assert.equal(plainPlan.project.template.commonproject.primary_language, "python");

  const wrongLanguage = invoke(["init", "py-plugin", "--obsidian-plugin", "--primary-language", "python", "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp);
  assert.notEqual(wrongLanguage.status, 0);
  assert.match(wrongLanguage.stdout, /written in typescript or javascript, not python/);

  // --- real render ----------------------------------------------------------
  const applied = JSON.parse(run([
    "init", "obsidian-tag-wrangler", "--obsidian-plugin", "--description", "Wrangle tags: fast",
    "--registry", registry, "--skip-board", "--apply", "--yes", "--no-tui", "--json",
  ], tmp));
  assert.equal(applied.ok, true, JSON.stringify(applied.errors));
  assert.ok(applied.logs.includes("commonproject: rendered as obsidian-plugin"), applied.logs.join("\n"));
  for (const rel of [...PLUGIN_FILES, ".project.json", ".copier-answers.yml", "AGENTS.md", "mise.toml", ".github/workflows/code-review.yml"]) {
    assert.ok(existsSync(join(pluginDir, rel)), `${rel} must be rendered`);
  }
  assert.equal(git(pluginDir, "status", "--porcelain"), "", "init must leave a clean, committed tree");

  const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
  assert.equal(manifest.id, "tag-wrangler", "the catalog rejects an id containing obsidian");
  assert.equal(manifest.name, "Tag Wrangler", "a slug-style project name reads as words, without obsidian");
  assert.equal(manifest.description, "Wrangle tags: fast.", "the catalog wants a sentence");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(JSON.parse(readFileSync(join(pluginDir, "versions.json"), "utf8"))["1.0.0"], manifest.minAppVersion);
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  assert.equal(pkg.name, "obsidian-tag-wrangler");
  assert.equal(JSON.parse(readFileSync(join(pluginDir, "package-lock.json"), "utf8")).name, pkg.name);
  const main = readFileSync(join(pluginDir, "src", "main.ts"), "utf8");
  assert.match(main, /export default class TagWranglerPlugin extends Plugin/);
  // eslint-plugin-obsidianmd fails on the starter's own sample names/snippets.
  for (const sample of ["MyPlugin", "SampleModal", "SampleSettingTab", "mySetting", "console.log('setInterval')"]) {
    assert.ok(!main.includes(sample) && !readFileSync(join(pluginDir, "src", "settings.ts"), "utf8").includes(sample), `${sample} must not ship`);
  }
  const release = readFileSync(join(pluginDir, ".github", "workflows", "release.yml"), "utf8");
  assert.ok(release.includes("${{ secrets.GITHUB_TOKEN }}"), "GitHub expressions must survive verbatim");
  assert.equal(YAML.parse(release).jobs.build["runs-on"].join(","), "self-hosted,Linux,delonet");
  for (const path of walk(pluginDir)) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /\{%|\{\{\s*(plugin_|project_|is_obsidian)/, `${relative(pluginDir, path)} kept unrendered Jinja`);
  }

  const record = JSON.parse(readFileSync(join(pluginDir, ".project.json"), "utf8"));
  assert.deepEqual(record.template.commonproject, { enabled: true, primary_language: "typescript", project_type: "obsidian-plugin" });
  const answers = YAML.parse(readFileSync(join(pluginDir, ".copier-answers.yml"), "utf8"));
  assert.equal(answers.project_type, "obsidian-plugin");
  const ignore = readFileSync(join(pluginDir, ".gitignore"), "utf8").split("\n");
  for (const line of ["# CommonProject repository contract", "!.env.op", "/.agents/skills", "node_modules/", "/main.js", "*.map", "/data.json"]) {
    assert.ok(ignore.includes(line), `.gitignore must carry ${line}`);
  }
  // mise-versioning keeps manifest.json/versions.json in step and never tags:
  // a tag made before the bump is committed ships the old manifest.
  assert.match(readFileSync(join(pluginDir, ".mise", "version-files.conf"), "utf8"), /\njson package\.json\nobsidian manifest\.json\n$/);
  assert.ok(lstatSync(join(pluginDir, ".mise", "tasks", "plugin", "link")).mode & 0o100, "plugin:link must be executable");

  const versioning = join(pluginDir, ".mise", "scripts", "versioning.sh");
  git(pluginDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "anchor");
  const bumped = spawnSync(versioning, ["bump", "patch"], {
    cwd: pluginDir, encoding: "utf8",
    env: { ...process.env, ...lifecycleEnv, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" },
  });
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.equal(JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8")).version, "1.0.1");
  assert.equal(JSON.parse(readFileSync(join(pluginDir, "versions.json"), "utf8"))["1.0.1"], manifest.minAppVersion);
  assert.equal(JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).version, "1.0.1");
  assert.match(readFileSync(join(pluginDir, "manifest.json"), "utf8"), /^\{\n\t"id"/, "tab indentation must survive the bump");
  assert.equal(git(pluginDir, "tag", "--list").trim(), "", "bumping must not tag the pre-bump commit");
  git(pluginDir, "checkout", "-q", "--", ".");

  // --- re-running init keeps the type and the language ------------------------
  const resync = JSON.parse(run(["init", "--target-dir", pluginDir, "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp));
  assert.equal(resync.mode, "sync");
  assert.equal(resync.actions.some((action) => action.kind === "copier.copy.commonproject"), false, "sync never re-renders");
  assert.equal(resync.project.template.commonproject.project_type, "obsidian-plugin");
  assert.equal(resync.project.template.commonproject.primary_language, "typescript", "re-init must not reset the language to python");

  // provenance.copier must keep every answer it does not own, and write
  // valid YAML for a description that needs quoting.
  const projectJson = JSON.parse(readFileSync(join(pluginDir, ".project.json"), "utf8"));
  writeFileSync(join(pluginDir, ".project.json"), `${JSON.stringify({ ...projectJson, project_description: "Sync notes: fast" }, null, 2)}\n`);
  const migrated = JSON.parse(run(["migrate", "provenance.copier", pluginDir, "--registry", registry, "--json"], tmp));
  assert.ok(JSON.stringify(migrated).includes(".copier-answers.yml"), JSON.stringify(migrated));
  const reanswered = YAML.parse(readFileSync(join(pluginDir, ".copier-answers.yml"), "utf8"));
  assert.equal(reanswered.project_description, "Sync notes: fast");
  assert.equal(reanswered.project_type, "obsidian-plugin", "migrate must not erase project_type");
  const reaudit = JSON.parse(run(["audit", pluginDir, "--rules", "provenance.copier", "--registry", registry, "--json"], tmp));
  assert.equal(reaudit.rules.find((rule) => rule.id === "provenance.copier").status, "pass");

  // --- the type is fixed at creation ---------------------------------------
  const basePlan = join(tmp, "plain-adopted");
  run(["init", "plain-adopted", "--registry", registry, "--skip-board", "--apply", "--yes", "--no-tui", "--json"], tmp);
  for (const rel of [...PLUGIN_FILES, "src", ".mise/tasks"]) assert.ok(!existsSync(join(basePlan, rel)), `a base render carries no ${rel}`);
  assert.doesNotMatch(readFileSync(join(basePlan, "AGENTS.md"), "utf8"), /Obsidian community plugin/);
  const baseIgnore = readFileSync(join(basePlan, ".gitignore"), "utf8").split("\n");
  assert.ok(!baseIgnore.includes("node_modules/") && !baseIgnore.includes("/main.js"), "base .gitignore gains no plugin lines");
  const refused = invoke(["init", "--target-dir", basePlan, "--obsidian-plugin", "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp);
  assert.notEqual(refused.status, 0, "an existing non-plugin repo cannot be retyped");
  assert.match(refused.stdout, /would render nothing/);
  // ...but adopting a repo that already IS a plugin records the type.
  writeFileSync(join(basePlan, "manifest.json"), JSON.stringify({ id: "adopted", minAppVersion: "1.4.0", version: "0.1.0" }));
  const adopted = JSON.parse(run(["init", "--target-dir", basePlan, "--obsidian-plugin", "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp));
  assert.equal(adopted.project.template.commonproject.project_type, "obsidian-plugin");
  assert.equal(adopted.actions.some((action) => action.kind === "copier.copy.commonproject"), false);
  assert.ok(adopted.proposedOperations.includes("parity:mise.versioning"), "a recorded plugin with a base version-files.conf fails mise.versioning");
  writeFileSync(join(basePlan, "versions.json"), "{}\n");
  const adoptedApply = JSON.parse(run(["init", "--target-dir", basePlan, "--obsidian-plugin", "--registry", registry, "--skip-board", "--apply", "--yes", "--no-tui", "--json"], tmp));
  assert.equal(adoptedApply.ok, true, JSON.stringify(adoptedApply.errors));
  assert.equal(JSON.parse(readFileSync(join(basePlan, ".project.json"), "utf8")).template.commonproject.project_type, "obsidian-plugin");
  assert.match(readFileSync(join(basePlan, ".mise", "version-files.conf"), "utf8"), /^obsidian manifest\.json$/m, "adoption must switch versioning to the plugin's files");

  // No record at all is still adoption, not creation: nothing is rendered, so
  // the repo must already be a plugin.
  const unregistered = join(tmp, "unregistered-repo");
  mkdirSync(unregistered);
  git(unregistered, "init", "-q");
  writeFileSync(join(unregistered, "pyproject.toml"), "[project]\nname = 'x'\n");
  const unregisteredRefused = invoke(["init", "--target-dir", unregistered, "--obsidian-plugin", "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp);
  assert.notEqual(unregisteredRefused.status, 0, unregisteredRefused.stdout);
  assert.match(unregisteredRefused.stdout, /would render nothing/);
  const emptyClone = invoke(["init", "--obsidian-plugin", "--registry", registry, "--skip-board", "--dry-run", "--json"], unregistered);
  assert.notEqual(emptyClone.status, 0, "init from inside an unregistered clone adopts it, so it must refuse too");
  writeFileSync(join(unregistered, "manifest.json"), JSON.stringify({ id: "unreg", minAppVersion: "1.5.0", version: "0.2.0" }));
  const unregisteredPlugin = JSON.parse(run(["init", "--target-dir", unregistered, "--obsidian-plugin", "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp));
  assert.equal(unregisteredPlugin.project.template.commonproject.project_type, "obsidian-plugin");
  assert.equal(unregisteredPlugin.project.template.commonproject.primary_language, "typescript");

  // A manifest with no template block records no language: recordFromManifest's
  // invented "typescript" must not be inherited.
  const templateless = join(tmp, "templateless");
  mkdirSync(templateless);
  git(templateless, "init", "-q");
  writeFileSync(join(templateless, ".project.json"), `${JSON.stringify({ project_name: "templateless", project_description: "", project_id: "templateless", repo_path: templateless, ticket_provider: { type: "plane", workspace: "33god", identifier: "TPLS", board_id: "" }, agents: {} }, null, 2)}\n`);
  const templatelessPlan = JSON.parse(run(["init", "--target-dir", templateless, "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp));
  assert.equal(templatelessPlan.project.template.commonproject.primary_language, "python");

  // Restating the recorded type keeps a recorded language the type allows.
  const jsPlugin = join(tmp, "js-plugin");
  mkdirSync(jsPlugin);
  git(jsPlugin, "init", "-q");
  writeFileSync(join(jsPlugin, "manifest.json"), JSON.stringify({ id: "js", minAppVersion: "1.5.0", version: "0.1.0" }));
  writeFileSync(join(jsPlugin, ".project.json"), `${JSON.stringify({ project_name: "js-plugin", project_description: "", project_id: "js-plugin", repo_path: jsPlugin, ticket_provider: { type: "plane", workspace: "33god", identifier: "JSPL", board_id: "" }, agents: {}, template: { commonproject: { enabled: true, primary_language: "javascript", project_type: "obsidian-plugin" } } }, null, 2)}\n`);
  const jsPlan = JSON.parse(run(["init", "--target-dir", jsPlugin, "--obsidian-plugin", "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp));
  assert.equal(jsPlan.project.template.commonproject.primary_language, "javascript");

  // A registry row whose repo is gone is re-created fresh, under any type.
  run(["init", "ghost-plugin", "--registry", registry, "--skip-board", "--apply", "--yes", "--no-tui", "--json"], tmp);
  rmSync(join(tmp, "ghost-plugin"), { recursive: true, force: true });
  const ghost = JSON.parse(run(["init", "ghost-plugin", "--obsidian-plugin", "--registry", registry, "--skip-board", "--dry-run", "--json"], tmp));
  assert.equal(ghost.actions.find((action) => action.kind === "copier.copy.commonproject").data.project_type, "obsidian-plugin");

  console.log("pjan-169 obsidian-plugin regressions: ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
