import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "pjan-57-packed-lifecycle-"));
const packDir = join(temporary, "pack");
const installDir = join(temporary, "install");
const isolatedHome = join(temporary, "home");
const target = join(temporary, "Generated Project With Spaces");
const registry = join(temporary, "registry", "projects.yaml");
const selectedBmadPack = resolve(process.env.PJ_BMAD_PACK_ROOT?.trim() || "/home/delorenj/code/skillex/packs/bmad/6.10.1-next.31");
const supportedRoots = [".claude", ".codex", ".gemini", ".copilot", ".opencode", ".kimi-code"];
const unsupportedRoots = [".agent", ".adal", ".bob", ".cline", ".codebuddy", ".codewhale", ".cortex", ".cursor", ".factory", ".firebender", ".iflow", ".junie", ".kiro", ".kode", ".neovate", ".ona", ".qoder", ".qwen", ".trae", ".zcode", ".zencoder"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function runJson(command, args, env, cwd = root) {
  const result = run(command, args, { env, cwd, allowFailure: true });
  assert.ok(result.stdout.trim(), `${command} ${args.join(" ")} produced no JSON\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${JSON.stringify(payload, null, 2)}\n${result.stderr}`);
  return payload;
}

try {
  assert.equal(existsSync(selectedBmadPack), true, `BMAD pack fixture missing: ${selectedBmadPack}`);
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });

  run("npm", ["pack", "--pack-destination", packDir], { cwd: root });
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = join(packDir, tarballs[0]);
  const tarballBytes = statSync(tarball).size;
  const inventory = run("tar", ["-tzf", tarball]).stdout.trim().split("\n");
  assert.ok(inventory.includes("package/templates/commonproject/copier.yml"));
  assert.ok(inventory.includes("package/templates/commonproject/template/.env.op"));
  assert.ok(inventory.includes("package/templates/commonproject/template/.mise/scripts/materialize-env.sh"));
  for (const forbidden of [
    "package/templates/commonproject/_bmad/",
    "package/templates/commonproject/tests/",
    "package/templates/commonproject/.augment/",
    "package/templates/commonproject/.pytest_cache/",
  ]) {
    assert.equal(inventory.some((path) => path.startsWith(forbidden)), false, `packed development content: ${forbidden}`);
  }
  assert.equal(inventory.some((path) => path.includes("/__pycache__/") || path.endsWith(".pyc")), false, "packed artifact must exclude Python caches");
  assert.ok(tarballBytes < 1_500_000, `packed tarball unexpectedly large: ${tarballBytes} bytes`);

  const npmCache = join(temporary, "npm-cache");
  const baseEnv = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    XDG_CACHE_HOME: join(isolatedHome, ".cache"),
    XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
    XDG_STATE_HOME: join(isolatedHome, ".local", "state"),
    MISE_CONFIG_DIR: join(isolatedHome, ".config", "mise"),
    MISE_CACHE_DIR: join(isolatedHome, ".cache", "mise"),
    MISE_DATA_DIR: join(isolatedHome, ".local", "share", "mise"),
    MISE_STATE_DIR: join(isolatedHome, ".local", "state", "mise"),
    npm_config_cache: npmCache,
    PJ_PROJECT_REGISTRY: registry,
    PJ_BMAD_PACK_ROOT: selectedBmadPack,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  run("npm", ["install", "--prefix", installDir, "--ignore-scripts", tarball], { env: baseEnv });
  const binary = join(installDir, "node_modules", ".bin", "pjangler");
  assert.equal(existsSync(binary), true, "isolated tarball install must expose pjangler binary");
  const env = { ...baseEnv, PATH: `${join(installDir, "node_modules", ".bin")}:${process.env.PATH}` };

  const initialized = runJson(binary, [
    "init", "Requested PJAN 57 Name",
    "--description", "Packed lifecycle acceptance",
    "--target-dir", target,
    "--registry", registry,
    "--apply", "--yes", "--no-tui", "--json",
  ], env);
  assert.equal(initialized.ok, true, JSON.stringify(initialized.errors));
  assert.equal(initialized.mode, "create");
  assert.equal(initialized.audit?.ok, true, "ProjectRecipe must return its clean postcondition audit");
  assert.equal(initialized.migrationReport, undefined, "fresh init must not use selected/closure migration as repair");
  assert.deepEqual(initialized.selectedParityRules, []);
  assert.equal(initialized.phases.some((phase) => /migrate.?all/i.test(phase.id)), false);

  for (const cliRoot of supportedRoots) {
    const rootPath = join(target, cliRoot);
    assert.equal(existsSync(rootPath), true, `${cliRoot} missing`);
    assert.equal(lstatSync(rootPath).isDirectory(), true, `${cliRoot} must be a real configuration root`);
    assert.equal(existsSync(join(rootPath, "skills", "bmad-help", "SKILL.md")), true, `${cliRoot} lacks BMAD skill configuration`);
    const tracked = run("git", ["ls-files", "--error-unmatch", `${cliRoot}/skills`], { cwd: target, env, allowFailure: true });
    assert.equal(tracked.status, 0, `${cliRoot}/skills must survive the initial commit\n${tracked.stderr}`);
  }
  for (const cliRoot of unsupportedRoots) assert.equal(existsSync(join(target, cliRoot)), false, `unsupported generated root ${cliRoot}`);

  const configToml = readFileSync(join(target, "_bmad", "config.toml"), "utf8");
  assert.match(configToml, /^project_name = "Requested PJAN 57 Name"$/m);
  for (const name of readdirSync(join(target, "_bmad"))) {
    const config = join(target, "_bmad", name, "config.yaml");
    if (existsSync(config) && /^project_name:/m.test(readFileSync(config, "utf8"))) {
      assert.match(readFileSync(config, "utf8"), /^project_name: Requested PJAN 57 Name$/m, `${name} project_name`);
    }
  }
  assert.equal(run("git", ["rev-list", "--count", "HEAD"], { cwd: target, env }).stdout.trim(), "1");
  assert.equal(run("git", ["status", "--porcelain"], { cwd: target, env }).stdout, "");

  const audit = runJson(binary, ["audit", target, "--json"], env);
  assert.equal(audit.ok, true, JSON.stringify(audit.rules.filter((rule) => !["pass", "skip"].includes(rule.status))));

  const reinit = runJson(binary, [
    "init", "--target-dir", target, "--registry", registry,
    "--apply", "--yes", "--no-tui", "--json",
  ], env, target);
  assert.equal(reinit.ok, true, JSON.stringify(reinit.errors));
  assert.equal(reinit.mode, "sync");
  assert.deepEqual(reinit.changedFiles, [], "existing project sync must be idempotent");
  assert.deepEqual(reinit.selectedParityRules, [], "existing clean sync must not invoke migrate-all");
  assert.equal(run("git", ["rev-list", "--count", "HEAD"], { cwd: target, env }).stdout.trim(), "1", "re-init must not create another commit");

  for (let pass = 0; pass < 2; pass++) {
    const migrated = runJson(binary, ["migrate", "--all", target, "--json"], env, target);
    assert.equal(migrated.ok, true);
    assert.deepEqual(migrated.selectedRules, []);
    assert.deepEqual(migrated.changedFiles, []);
  }
  assert.equal(run("git", ["status", "--porcelain"], { cwd: target, env }).stdout, "");

  console.log(`PJAN-57 packed generated-project lifecycle: PASS (${basename(tarball)}, ${tarballBytes} bytes, ${inventory.length} entries)`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
