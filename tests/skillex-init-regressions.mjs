import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createBmadInstallerFixture, createSkillPackFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const tmp = realpathSync(mkdtempSync("/tmp/pjangler-skillex-init-"));
const home = join(tmp, "home"), catalog = join(tmp, "catalog");
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
createSkillPackFixture(catalog);
const installer = createBmadInstallerFixture(tmp);
const bin = createSkillexMiseFixture(tmp);
put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
  XDG_CACHE_HOME: join(tmp, "cache"), XDG_STATE_HOME: join(tmp, "state"),
  XDG_DATA_HOME: join(tmp, "data"), XDG_CONFIG_HOME: join(home, ".config"),
  PJ_SKILLS_REGISTRY_ROOT: catalog, PJ_BMAD_INSTALLER: installer,
  PJ_AGENT_HOOKS_LAYER: "0", PYTHONDONTWRITEBYTECODE: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1", PLANE_API_KEY: "", PLANE_33GOD_API_KEY: "", TRELLO_TOKEN: "" };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? tmp, env: options.env ?? env, encoding: "utf8", timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.error, undefined, String(result.error));
  if (!options.allowFailure) assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function json(cli, args, options = {}) { return JSON.parse(run(process.execPath, [cli, ...args, "--json"], options).stdout); }
function assertProject(cli, project) {
  const source = join(project, ".agents", "skills.json");
  const manifest = JSON.parse(readFileSync(source, "utf8"));
  assert.equal(manifest.inherit_global, true);
  assert.deepEqual(manifest.skills, []);
  const mise = readFileSync(join(project, "mise.toml"), "utf8");
  assert.match(mise, /skillex sync --scope project --project '\{\{config_root\}\}'/);
  assert.match(mise, /"npm:@delorenj\/skillex" = \{ version = "0\.1\.1", allow_low_downloads = true \}, node = "24"/);
  for (const name of ["sync-skills.py", "provision-packs.py", "provision-bmad-skills.py"]) assert.equal(existsSync(join(project, ".mise", "scripts", name)), false);
  const skills = join(project, ".agents", "skills");
  const installed = readdirSync(skills).filter((name) => name.startsWith("bmad-"));
  assert.ok(installed.length > 0);
  for (const name of installed) assert.equal(lstatSync(join(skills, name)).isSymbolicLink(), false);
  const installerInode = lstatSync(join(skills, installed[0])).ino;
  put(join(skills, "local-custom", "SKILL.md"), "Local content survives\n");
  const desired = '{ "inherit_global": false, "skills": ["pjtest-architecture"] }\n';
  put(source, desired);
  const migrateArgs = ["migrate", "skills.project-manifest", project];
  const first = json(cli, migrateArgs); assert.equal(first.ok, true);
  assert.equal(realpathSync(join(skills, "pjtest-architecture")), join(catalog, "all-skills", "pjtest-architecture"));
  assert.equal(readFileSync(source, "utf8"), desired);
  assert.equal(lstatSync(join(skills, installed[0])).ino, installerInode);
  assert.equal(readFileSync(join(skills, "local-custom", "SKILL.md"), "utf8"), "Local content survives\n");
  const second = json(cli, migrateArgs); assert.equal(second.results[0].status, "noop");
  const audit = json(cli, ["audit", project], { allowFailure: true });
  assert.equal(audit.rules.find((rule) => rule.id === "skills.project-manifest").status, "pass");
  for (const bad of ["../sentinel", ".", "..", "/absolute"]) {
    const bytes = JSON.stringify({ inherit_global: false, skills: [bad] }) + "\n";
    put(source, bytes);
    const rejected = run(process.execPath, [cli, ...migrateArgs, "--json"], { allowFailure: true });
    assert.notEqual(rejected.status, 0);
    assert.equal(JSON.parse(rejected.stdout).results[0].status, "blocked");
    assert.equal(readFileSync(source, "utf8"), bytes);
    assert.equal(lstatSync(join(skills, installed[0])).ino, installerInode);
  }
  put(source, desired);
  return { mise, installed };
}
try {
  const packDir = join(tmp, "pack"); mkdirSync(packDir);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: root }).stdout);
  const info = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const tarball = join(packDir, info.filename);
  assert.ok(!info.files.some((file) => /(?:sync-skills|provision-packs)\.py$/.test(file.path)));
  const install = join(tmp, "installed");
  const args = ["install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", tarball];
  // Prepublication acceptance can supply the exact prepared core artifact.
  // This only affects the isolated fixture; the package dependency stays a registry pin.
  if (process.env.PJ_SKILLEX_TEST_TARBALL) args.push(process.env.PJ_SKILLEX_TEST_TARBALL);
  run("npm", args);
  const installed = join(install, "node_modules", "@delorenj", "pjangler");
  assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).dependencies["@delorenj/skillex"], "0.1.1");
  const results = [];
  for (const [label, cli] of [["source", join(root, "dist", "index.js")], ["installed", join(installed, "dist", "index.js")]]) {
    const project = join(tmp, `${label} project`);
    const initialized = json(cli, ["init", "SkillexParity", "--target-dir", project, "--registry", join(tmp, `${label}-registry.yaml`), "--skip-board", "--apply", "--yes", "--no-tui"]);
    assert.equal(initialized.ok, true, JSON.stringify(initialized.errors));
    assert.equal(initialized.audit?.ok, true, JSON.stringify(initialized.audit));
    results.push(assertProject(cli, project));
  }
  assert.deepEqual(results[0], results[1]);
  console.log("Skillex source and npm-installed bootstrap, repeated parity, inheritance and preservation passed");
} finally { rmSync(tmp, { recursive: true, force: true }); }
