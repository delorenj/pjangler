// Shared harness for the PJAN-135 skills-root suites.
//
// Everything is real: the SOURCES are bundled (never dist/), repositories are
// real `git init` directories under /tmp with a hermetic git environment, and
// the skillex core is the bundled @delorenj/skillex. Nothing is mocked.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const repoRoot = resolve(import.meta.dirname, "..", "..");
export const skillexCli = join(repoRoot, "node_modules", "@delorenj", "skillex", "dist", "cli.js");

// Test-created git repositories must never discover an enclosing one.
process.env.GIT_CEILING_DIRECTORIES = "/tmp";

/**
 * Bundle the SOURCES into node_modules/.cache so bare imports resolve against the
 * repo's node_modules exactly as the CLI's do. The file stays until this process
 * exits so child processes (crash tests) can import the same code.
 */
export async function loadSources() {
  const bundle = join(repoRoot, "node_modules", ".cache", `pjan-135-harness-${process.pid}.mjs`);
  buildSync({
    stdin: {
      contents: [
        'export { RecipeRegistry } from "./src/recipes/registry";',
        'export { createMiseChecks, createAgentHooksChecks, createBmadChecks } from "./src/parity/rules";',
        'export * from "./src/parity/skill-roots";',
      ].join("\n"),
      resolveDir: repoRoot,
    },
    outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
  });
  process.on("exit", () => rmSync(bundle, { force: true }));
  const module = await import(pathToFileURL(bundle).href);
  return { ...module, bundle };
}

export function put(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) spawnSync("chmod", [mode.toString(8), path]);
}
export function skill(name, body = "") { return `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# ${name}\n${body}`; }
export function lstatSafe(path) { try { return lstatSync(path); } catch { return undefined; } }
export function readSafe(path) { try { return readFileSync(path, "utf8"); } catch (error) { return `<${error.code}>`; } }

export function hermeticGit(base) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: join(base, "xdg"),
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  return (cwd, ...args) => {
    const result = spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
}

/**
 * Every entry below `dir` except the .git directory: name, inode, mode, and link
 * text or bytes; plus the git index (`ls-files -s`). Equal snapshots mean the
 * repository is byte-for-byte (and inode-for-inode) unchanged.
 */
export function repoState(project) {
  const walk = (dir) => readdirSync(dir).sort().filter((name) => !(dir === project && name === ".git")).map((name) => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, stat.ino, stat.mode, stat.isSymbolicLink() ? `-> ${readlinkSync(path)}` : stat.isDirectory() ? walk(path) : createHash("sha256").update(readFileSync(path)).digest("hex")];
  });
  const index = existsSync(join(project, ".git"))
    ? spawnSync("git", ["ls-files", "-s"], { cwd: project, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).stdout
    : null;
  return { tree: walk(project), index };
}

/** A bare git repository under /tmp with nothing else in it. */
export function rawRepo(tag = "raw", { git = true } = {}) {
  const base = realpathSync(mkdtempSync(`/tmp/pjan-135-${tag}-`));
  const project = join(base, "project");
  mkdirSync(project, { recursive: true });
  const gitRun = hermeticGit(base);
  if (git) gitRun(project, "init", "-q");
  const R = join(project, ".agents", "skills");
  return {
    base, project, R, git: (...args) => gitRun(project, ...args), gitIn: gitRun,
    alias: (name = ".claude") => join(project, name, "skills"),
    close: () => { spawnSync("chmod", ["-R", "u+rwX", base]); rmSync(base, { recursive: true, force: true }); },
  };
}

/**
 * A project with a real temp catalog, skillex state under the fixture, and the
 * mise task wiring established (so it never decides fixability here).
 */
export async function skillFixture(sources, { select = ["alpha", "beta"], git = true, tag = "fx", catalogSkills = ["alpha", "beta", "gamma"] } = {}) {
  const f = rawRepo(tag, { git });
  const home = join(f.base, "home"), catalog = join(f.base, "registry");
  for (const path of [home, join(catalog, "all-skills"), join(catalog, "sets"), join(catalog, "packs")]) mkdirSync(path, { recursive: true });
  for (const name of catalogSkills) put(join(catalog, "all-skills", name, "SKILL.md"), skill(name));
  put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(f.project, ".agents", "skills.json"), `${JSON.stringify({ inherit_global: false, skills: select })}\n`);
  put(join(f.project, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  const saved = { registry: process.env.PJ_SKILLS_REGISTRY_ROOT, state: process.env.XDG_STATE_HOME };
  process.env.PJ_SKILLS_REGISTRY_ROOT = catalog;
  // skillex refuses state under any git work tree; keep it in this fixture.
  process.env.XDG_STATE_HOME = join(f.base, "state");
  const ctx = { repoRoot: f.project, targetDir: f.project, homeDir: home, pjanglerRoot: repoRoot, dryRun: false, force: false };
  const mise = sources.createMiseChecks().find((check) => check.id === "mise.config-root");
  const skills = sources.createAgentHooksChecks().find((check) => check.id === "skills.project-manifest");
  const cliRoots = sources.createBmadChecks().find((check) => check.id === "bmad.cli-roots");
  await mise.migrate(ctx, await mise.audit(ctx));
  const skillexEnv = { ...process.env, HOME: home, XDG_STATE_HOME: join(f.base, "state"), PJ_SKILLS_REGISTRY_ROOT: catalog };
  const skillex = (...args) => {
    const result = spawnSync(process.execPath, [skillexCli, ...args], { cwd: f.base, env: skillexEnv, encoding: "utf8", timeout: 60000 });
    return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const recipe = (check) => ({
    metadata: { id: check.id, name: check.title, description: "PJAN-135 regression", dependencies: [], commands: [], publicRuleIds: [check.id] },
    checks: [check],
    audit: async (c) => [await check.audit(c)],
    migrate: async (c) => [await check.migrate(c, await check.audit(c))],
  });
  return {
    ...f, home, catalog, ctx, skills, cliRoots, skillex, recipe,
    registry: (...checks) => new sources.RecipeRegistry(checks.map(recipe)),
    audit: (extra = {}) => skills.audit({ ...ctx, ...extra }),
    migrate: async (extra = {}) => skills.migrate({ ...ctx, ...extra }, await skills.audit({ ...ctx, ...extra })),
    close() {
      for (const [key, value] of [["PJ_SKILLS_REGISTRY_ROOT", saved.registry], ["XDG_STATE_HOME", saved.state]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      f.close();
    },
  };
}
