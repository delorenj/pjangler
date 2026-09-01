import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  BMAD_INSTALLER_FIXTURE_VERSION,
  createBmadInstallerFixture,
  createSkillPackFixture,
} from "./helpers/pack-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "pjan-57-packed-lifecycle-"));
const packDir = join(temporary, "pack");
const installDir = join(temporary, "install");
const isolatedHome = join(temporary, "home");
const target = join(temporary, "Generated Project With Spaces");
const registry = join(temporary, "registry", "projects.yaml");
const fixtureRoot = join(temporary, "fixtures");
const selectedBmadPack = createSkillPackFixture(fixtureRoot);
const selectedBmadInstaller = createBmadInstallerFixture(fixtureRoot);
const supportedRoots = [".claude", ".codex", ".gemini", ".copilot", ".opencode", ".kimi-code"];
const unsupportedRoots = [".agent", ".adal", ".bob", ".cline", ".codebuddy", ".codewhale", ".cortex", ".cursor", ".factory", ".firebender", ".iflow", ".junie", ".kiro", ".kode", ".neovate", ".ona", ".qoder", ".qwen", ".trae", ".zcode", ".zencoder"];
let packedCli = "";

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

function runPacked(args, env, cwd = root, allowFailure = false) {
  return run(process.execPath, [packedCli, ...args], { env, cwd, allowFailure });
}

function runPackedJson(args, env, cwd = root) {
  const result = runPacked(args, env, cwd, true);
  assert.ok(result.stdout.trim(), `${args.join(" ")} produced no JSON\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed\n${JSON.stringify(payload, null, 2)}\n${result.stderr}`);
  return payload;
}

function initArgs(name, targetDir, registryPath) {
  return [
    "init", name,
    "--description", "Packed lifecycle acceptance",
    "--target-dir", targetDir,
    "--registry", registryPath,
    // This fixture is about scaffold/registry behaviour, not boards. Board
    // provisioning is on by default now, so say so rather than reaching a
    // provider (and failing the ingress gate when none answers).
    "--skip-board",
    "--apply", "--yes", "--no-tui", "--json",
  ];
}

try {
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
  // A backstop against development content leaking into the published package;
  // the inventory assertions above are what actually enforce hygiene. Raised
  // from 1_500_000 when the fleet contract module + contracts/fleet-contract.yaml
  // (PJAN-92) pushed a package that was already at 1_491_670 bytes over the line.
  //
  // Raised again from 1_750_000 (measured 1_754_340) by story 1.3. The previous
  // note said to shrink dist/*.map before raising this again, and that was NOT
  // done -- deliberately, and it is worth stating why. This delta is not map
  // bytes: dist/index.js grew 1_050_791 -> 1_099_648 and dist/mcp-server.js grew
  // 794_928 -> 916_683, because exposing the fleet tools over MCP pulls the whole
  // fleet module, the contract loader and yaml into that second bundle. Both maps
  // are byte-identical across the change. So the shrink the note asks for is
  // still owed and still the right fix -- it is DW-7, and dropping dist/*.map
  // from package.json `files` is an outward-facing publishing decision this
  // story declined to make on its own.
  assert.ok(tarballBytes < 1_850_000, `packed tarball unexpectedly large: ${tarballBytes} bytes`);

  // Extract the real npm artifact and link only the already-installed dependency
  // tree. This exercises the packed files without a second registry/network hit.
  run("tar", ["-xzf", tarball, "-C", installDir]);
  const packageDir = join(installDir, "package");
  symlinkSync(join(root, "node_modules"), join(packageDir, "node_modules"), "dir");
  packedCli = join(packageDir, "dist", "index.js");
  assert.equal(existsSync(packedCli), true, "packed artifact must contain the CLI bundle");

  const npmCache = join(temporary, "empty-npm-cache");
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
    npm_config_offline: "true",
    PJ_PROJECT_REGISTRY: registry,
    PJ_PACK_ROOT_PJTEST: selectedBmadPack,
    PJ_BMAD_INSTALLER: selectedBmadInstaller,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    delete baseEnv[key];
  }

  // Empty-cache offline default: the exact npm installer cannot be resolved,
  // and failure occurs before Copier, target creation, or registry persistence.
  const offlineTarget = join(temporary, "offline-preflight-target");
  const offlineRegistry = join(temporary, "offline-preflight-registry.yaml");
  const offlineEnv = { ...baseEnv, PJ_PROJECT_REGISTRY: offlineRegistry };
  delete offlineEnv.PJ_BMAD_INSTALLER;
  const offline = runPacked(initArgs("Offline Preflight", offlineTarget, offlineRegistry), offlineEnv, root, true);
  assert.notEqual(offline.status, 0, "empty-cache offline init must fail closed");
  const offlinePayload = JSON.parse(offline.stdout);
  assert.match((offlinePayload.errors ?? [offlinePayload.error]).join("\n"), /BMAD preflight failed.*installer.*unavailable/i);
  assert.equal(existsSync(offlineTarget), false, "failed preflight must not create the target");
  assert.equal(existsSync(offlineRegistry), false, "failed preflight must not persist the registry");

  // The prepared local installer passes preflight, then fails once during the
  // real install. ProjectRecipe must roll back the newly-created target so the
  // identical command can be retried without --force.
  const failOnceState = join(temporary, "installer-state", "failed-once");
  const retryEnv = { ...baseEnv, PJ_BMAD_FIXTURE_FAIL_ONCE_STATE: failOnceState };
  const firstAttempt = runPacked(initArgs("Requested PJAN 57 Name", target, registry), retryEnv, root, true);
  assert.notEqual(firstAttempt.status, 0, "injected installer failure must fail the transaction");
  const firstPayload = JSON.parse(firstAttempt.stdout);
  assert.match(firstPayload.errors.join("\n"), /Failed to run bmad-method install|injected hermetic BMAD install failure/);
  assert.equal(existsSync(target), false, "downstream failure must remove only the newly-created target");
  assert.equal(existsSync(registry), false, "failed transaction must not persist the registry");

  const initialized = runPackedJson(initArgs("Requested PJAN 57 Name", target, registry), retryEnv);
  assert.equal(initialized.ok, true, JSON.stringify(initialized.errors));
  assert.equal(initialized.mode, "create");
  assert.equal(initialized.audit?.ok, true, "ProjectRecipe must return its clean postcondition audit");
  assert.equal(initialized.migrationReport, undefined, "fresh init must not use selected/closure migration as repair");
  assert.deepEqual(initialized.selectedParityRules, []);
  assert.equal(initialized.phases.some((phase) => /migrate.?all/i.test(phase.id)), false);
  assert.equal(
    readFileSync(join(target, "_bmad", "_config", "manifest.yaml"), "utf8").includes(`version: ${BMAD_INSTALLER_FIXTURE_VERSION}`),
    true,
  );

  for (const cliRoot of supportedRoots) {
    const rootPath = join(target, cliRoot);
    assert.equal(existsSync(rootPath), true, `${cliRoot} missing`);
    assert.equal(lstatSync(rootPath).isDirectory(), true, `${cliRoot} must be a real configuration root`);
    assert.equal(existsSync(join(rootPath, "skills", "bmad-help", "SKILL.md")), true, `${cliRoot} lacks BMAD skill configuration`);
    // PJAN-76: the skills under each root are written by `bmad-method install`
    // and rewritten wholesale on every upgrade, so they are deliberately NOT
    // committed — `_bmad/_config/manifest.yaml` pins the version that
    // reproduces them. The root itself still holds tracked configuration.
    const trackedSkills = run("git", ["ls-files", "--error-unmatch", `${cliRoot}/skills`], { cwd: target, env: retryEnv, allowFailure: true });
    assert.notEqual(
      trackedSkills.status,
      0,
      `${cliRoot}/skills must stay out of the tree; bmad-method regenerates it`,
    );
    const ignored = run("git", ["check-ignore", "-q", `${cliRoot}/skills/`], { cwd: target, env: retryEnv, allowFailure: true });
    assert.equal(ignored.status, 0, `${cliRoot}/skills/ must be gitignored, not merely untracked`);
  }
  for (const cliRoot of unsupportedRoots) assert.equal(existsSync(join(target, cliRoot)), false, `unsupported generated root ${cliRoot}`);

  const configToml = readFileSync(join(target, "_bmad", "config.toml"), "utf8");
  assert.match(configToml, /^project_name = "Requested PJAN 57 Name"$/m);
  for (const name of ["core", "bmm", "bmb", "cis"]) {
    const config = join(target, "_bmad", name, "config.yaml");
    assert.equal(existsSync(config), true, `${name} config must exist for the enabled installer contract`);
    assert.match(
      readFileSync(config, "utf8"),
      /^project_name: "Requested PJAN 57 Name"$/m,
      `${name} must inherit the requested project_name rather than ${JSON.stringify(basename(target))}`,
    );
  }
  assert.equal(run("git", ["rev-list", "--count", "HEAD"], { cwd: target, env: retryEnv }).stdout.trim(), "1");
  assert.equal(run("git", ["status", "--porcelain"], { cwd: target, env: retryEnv }).stdout, "");
  assert.equal(
    run("git", ["log", "-1", "--format=%an <%ae>%n%cn <%ce>"], { cwd: target, env: retryEnv }).stdout.trim(),
    "Pjangler Lifecycle <pjangler@localhost.invalid>\nPjangler Lifecycle <pjangler@localhost.invalid>",
  );
  for (const key of ["user.name", "user.email"]) {
    const local = run("git", ["config", "--local", "--get", key], { cwd: target, env: retryEnv, allowFailure: true });
    assert.notEqual(local.status, 0, `${key} must not persist in repository-local Git config`);
  }

  const audit = runPackedJson(["audit", target, "--json"], retryEnv);
  assert.equal(audit.ok, true, JSON.stringify(audit.rules.filter((rule) => !["pass", "skip"].includes(rule.status))));

  const reinit = runPackedJson([
    "init", "--target-dir", target, "--registry", registry,
    "--skip-board",
    "--apply", "--yes", "--no-tui", "--json",
  ], retryEnv, target);
  assert.equal(reinit.ok, true, JSON.stringify(reinit.errors));
  assert.equal(reinit.mode, "sync");
  assert.deepEqual(reinit.changedFiles, [], "existing project sync must be idempotent");
  assert.deepEqual(reinit.selectedParityRules, [], "existing clean sync must not invoke migrate-all");
  assert.equal(run("git", ["rev-list", "--count", "HEAD"], { cwd: target, env: retryEnv }).stdout.trim(), "1", "re-init must not create another commit");

  for (let pass = 0; pass < 2; pass++) {
    const migrated = runPackedJson(["migrate", "--all", target, "--json"], retryEnv, target);
    assert.equal(migrated.ok, true);
    assert.deepEqual(migrated.selectedRules, []);
    assert.deepEqual(migrated.changedFiles, []);
  }
  assert.equal(run("git", ["status", "--porcelain"], { cwd: target, env: retryEnv }).stdout, "");

  console.log(`PJAN-57 packed generated-project lifecycle: PASS (${basename(tarball)}, ${tarballBytes} bytes, ${inventory.length} entries)`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
