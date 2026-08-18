import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { RunCopierTemplate } from "../src/commands/hermes/RunCopierTemplate";
import type { HermesAgentContext } from "../src/commands/hermes/types";
import { hardenSubprocessEnvironment } from "../src/utils/child-environment";
import {
  HERMES_TEMPLATE_ATTESTATION,
  captureAttestedHermesTemplate,
  materializeTrustedHermesTemplate,
  preflightCommonProjectTemplate,
  preflightHermesTemplate,
  preflightRenderedHermes,
  preflightTrustedCopier,
  verifyTrustedHermesTemplateIdentity,
  verifyTrustedCopierIdentity,
  type TrustedCopierIdentity,
} from "../src/lifecycle/preflight";
import { executeProjectInitPlan, planProjectInit } from "../src/project/index";
import { ProjectRecipe, type ProjectRecipeRuntime } from "../src/recipes/ProjectRecipe";
import { RecipeRegistry } from "../src/recipes/registry";
import type { LifecycleRecipe } from "../src/recipes/types";
import { spawn as hardenedSpawn, spawnSync as hardenedSpawnSync } from "../src/utils/child-process";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pjan-67-preflight-contract-"));

function executable(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("base64url");
}

interface SyntheticUvCopier {
  home: string;
  entryPoint: string;
  launcher: string;
  identity: TrustedCopierIdentity;
}

/**
 * A hermetic UV package projection with the same receipt, venv, distribution,
 * entry-point, and PEP-376 RECORD boundaries as the installed tool. The
 * explicit homeDir/temporaryDir overrides are test-only; production anchors
 * provenance to the operating-system account home.
 */
function syntheticUvCopier(name: string): SyntheticUvCopier {
  const home = join(workspace, name, "home");
  const toolRoot = join(home, ".local", "share", "uv", "tools", "copier");
  const launcher = join(toolRoot, "bin", "copier");
  const entryPoint = join(home, ".local", "bin", "copier");
  const pythonReal = join(home, ".local", "share", "uv", "python", "cpython-test", "bin", "python3");
  const pythonLink = join(toolRoot, "bin", "python");
  const sitePackages = join(toolRoot, "lib", "python3.12", "site-packages");
  const distInfo = join(sitePackages, "copier-9.14.0.dist-info");
  const metadata = join(distInfo, "METADATA");
  const entryPoints = join(distInfo, "entry_points.txt");
  const record = join(distInfo, "RECORD");
  const copierMain = join(sitePackages, "copier", "__main__.py");
  const copierCli = join(sitePackages, "copier", "_cli.py");

  executable(pythonReal, "synthetic UV Python identity\n");
  mkdirSync(dirname(pythonLink), { recursive: true });
  symlinkSync(pythonReal, pythonLink);
  executable(launcher, `#!${pythonLink}\nimport sys\nfrom copier.__main__ import CopierApp\nsys.exit(CopierApp.run())\n`);
  mkdirSync(dirname(entryPoint), { recursive: true });
  symlinkSync(launcher, entryPoint);
  writeFileSync(join(toolRoot, "pyvenv.cfg"), "home = synthetic-uv-python\n", "utf8");
  writeFileSync(join(toolRoot, "uv-receipt.toml"), `[tool]\nrequirements = [{ name = "copier" }]\nentrypoints = [\n  { name = "copier", install-path = "${entryPoint}", from = "copier" },\n]\n`, "utf8");
  mkdirSync(dirname(copierMain), { recursive: true });
  mkdirSync(distInfo, { recursive: true });
  writeFileSync(copierMain, "from copier._cli import CopierApp\n", "utf8");
  writeFileSync(copierCli, "class CopierApp:\n    @staticmethod\n    def run(): return 0\n", "utf8");
  writeFileSync(metadata, "Metadata-Version: 2.4\nName: copier\nVersion: 9.14.0\n", "utf8");
  writeFileSync(entryPoints, "[console_scripts]\ncopier = copier.__main__:CopierApp.run\n", "utf8");

  const records: Array<[string, string]> = [
    ["../../../bin/copier", launcher],
    ["copier-9.14.0.dist-info/METADATA", metadata],
    ["copier-9.14.0.dist-info/entry_points.txt", entryPoints],
    ["copier/__main__.py", copierMain],
    ["copier/_cli.py", copierCli],
  ];
  writeFileSync(record, `${records.map(([relativePath, path]) => `${relativePath},sha256=${digest(path)},${readFileSync(path).byteLength}`).join("\n")}\ncopier-9.14.0.dist-info/RECORD,,\n`, "utf8");

  const result = preflightTrustedCopier({
    targetDir: join(workspace, name, "target"),
    env: { PATH: dirname(entryPoint) },
    homeDir: home,
    temporaryDir: join(workspace, name, "separate-os-temp"),
  });
  assert.equal(result.ok, true, `metadata-bound synthetic UV Copier must attest: ${result.error}`);
  assert.ok(result.identity);
  return { home, entryPoint, launcher, identity: result.identity };
}

function attest(path: string, homeDir: string, temporaryDir = join(workspace, "separate-os-temp")) {
  return preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: dirname(path) },
    homeDir,
    temporaryDir,
  });
}

function noopRecipe(id: string, dependencies: readonly string[] = []): LifecycleRecipe {
  return {
    metadata: {
      id,
      name: id,
      description: `${id} fixture`,
      dependencies,
      commands: [],
      publicRuleIds: [],
    },
    checks: [],
    async init(ctx) {
      return {
        recipeId: id,
        ok: true,
        dryRun: Boolean(ctx.dryRun),
        changedFiles: [],
        logs: [],
        errors: [],
        phases: [],
      };
    },
    audit() { return []; },
    migrate() { return []; },
  };
}

try {
  // This is an integration assertion, not a prerequisite for the hermetic
  // suite. On the release host it proves the installed UV Copier is accepted.
  const actual = preflightTrustedCopier({ targetDir: join(workspace, "actual-target") });
  let liveUvCopier: TrustedCopierIdentity | undefined;
  if (actual.ok) {
    assert.equal(actual.layout, "uv-tool");
    assert.ok(actual.identity);
    assert.equal(actual.identity.executable, realpathSync(actual.identity.resolvedFrom));
    assert.equal(verifyTrustedCopierIdentity(actual.identity).ok, true);
    liveUvCopier = actual.identity;
    console.log(`PJAN-67 live UV Copier attested: ${actual.identity.executable} (${actual.identity.version})`);
  } else {
    console.log(`PJAN-67 live UV Copier attestation skipped: ${actual.error}`);
  }

  const uv = syntheticUvCopier("metadata-bound-uv");
  assert.equal(uv.identity.layout, "uv-tool");
  assert.equal(uv.identity.executable, realpathSync(uv.entryPoint));

  // Matching launcher text in historical mutable layout allowlists is no
  // longer sufficient provenance.
  const mutableHome = join(workspace, "mutable-layouts", "home");
  const launcher = `#!/usr/bin/python3\nimport sys\nfrom copier.__main__ import CopierApp\nsys.exit(CopierApp.run())\n`;
  for (const [label, path] of [
    ["pip-user", join(mutableHome, ".local", "bin", "copier")],
    ["pipx", join(mutableHome, ".local", "pipx", "venvs", "copier", "bin", "copier")],
    ["pyenv", join(mutableHome, ".pyenv", "versions", "3.12.0", "bin", "copier")],
    ["Homebrew", join(workspace, "mutable-layouts", "opt", "homebrew", "bin", "copier")],
  ] as const) {
    executable(path, launcher);
    const rejected = attest(path, mutableHome);
    assert.equal(rejected.ok, false, `${label} layout/text alone must be rejected`);
    assert.match(rejected.error ?? "", /PATH-shadowed|canonical UV/);
  }

  const shadowDir = join(workspace, "shadow-bin");
  const shadow = join(shadowDir, "copier");
  const shadowEffect = join(workspace, "shadow-effect.log");
  executable(shadow, `#!/bin/sh\nprintf shadow-ran > "${shadowEffect}"\n`);
  const shadowed = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: `${shadowDir}${delimiter}${dirname(uv.entryPoint)}` },
    homeDir: uv.home,
    temporaryDir: join(workspace, "separate-os-temp"),
  });
  assert.equal(shadowed.ok, false, "the first PATH match must fail closed instead of falling through to trusted Copier");
  assert.match(shadowed.error ?? "", /PATH-shadowed/);
  assert.equal(existsSync(shadowEffect), false, "provenance resolution must never execute a PATH shadow");

  const targetCopier = join(workspace, "target", "bin", "copier");
  executable(targetCopier, launcher);
  const targetLocal = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: dirname(targetCopier) },
    homeDir: mutableHome,
    temporaryDir: join(workspace, "separate-os-temp"),
  });
  assert.equal(targetLocal.ok, false);
  assert.match(targetLocal.error ?? "", /target-local/);

  const osTemp = join(workspace, "os-temp");
  const tempCopier = join(osTemp, "bin", "copier");
  executable(tempCopier, launcher);
  const temporaryLocal = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: dirname(tempCopier) },
    homeDir: mutableHome,
    temporaryDir: osTemp,
  });
  assert.equal(temporaryLocal.ok, false);
  assert.match(temporaryLocal.error ?? "", /temporary-local/);

  // Check/use gap regression for the dedicated Hermes executor. The attested
  // launcher is replaced after preflight with an effect-writing program.
  const hermesMutation = syntheticUvCopier("hermes-check-use");
  const hermesEffect = join(workspace, "hermes-check-use-effect.log");
  executable(hermesMutation.launcher, `#!/bin/sh\nprintf ran > "${hermesEffect}"\n`);
  const hermesTarget = join(workspace, "hermes-check-use", "target");
  const hermesConfig = join(workspace, "hermes-check-use", "config.toml");
  const previousConfig = process.env.HERMES_TEMPLATE_CONFIG;
  process.env.HERMES_TEMPLATE_CONFIG = hermesConfig;
  try {
    const templatePreflight = preflightHermesTemplate(root);
    assert.equal(templatePreflight.ok, true, templatePreflight.error);
    assert.ok(templatePreflight.identity);
    const context: HermesAgentContext = {
      targetDir: hermesTarget,
      targetRepo: "check-use",
      role: "pm",
      yes: true,
      quiet: true,
      dryRun: false,
      skipPlane: true,
      trustedCopier: hermesMutation.identity,
      trustedHermesTemplate: templatePreflight.identity,
      deferredExternalEffects: { runtimeRepo: false, ticketBoard: false, systemd: false, owner: "hermes" },
    };
    const result = await new RunCopierTemplate(context).invoke();
    assert.equal(result.success, false);
    assert.match(result.message, /provenance revalidation failed|identity changed/);
  } finally {
    if (previousConfig === undefined) delete process.env.HERMES_TEMPLATE_CONFIG;
    else process.env.HERMES_TEMPLATE_CONFIG = previousConfig;
  }
  assert.equal(existsSync(hermesTarget), false, "Hermes check/use rejection must precede target writes");
  assert.equal(existsSync(hermesConfig), false, "Hermes check/use rejection must precede host config writes");
  assert.equal(existsSync(hermesEffect), false, "Hermes must not execute a replaced attested launcher");

  // The CommonProject executor observes the same last effect-free boundary.
  const projectMutation = syntheticUvCopier("project-check-use");
  const projectEffect = join(workspace, "project-check-use-effect.log");
  executable(projectMutation.launcher, `#!/bin/sh\nprintf ran > "${projectEffect}"\n`);
  const projectTarget = join(workspace, "project-check-use", "target");
  const plan = planProjectInit({
    name: "PJAN-67 Check Use",
    targetDir: projectTarget,
    projectSlug: "pjan-67-check-use",
    projectIdentifier: "PCU",
    registryPath: join(workspace, "project-check-use", "registry.yaml"),
    pjanglerRoot: root,
    apply: true,
    overwrite: false,
  });
  const projectResult = await executeProjectInitPlan(plan, {
    trustedCopier: projectMutation.identity,
    requireTrustedCopier: true,
  });
  assert.equal(projectResult.ok, false);
  assert.match(projectResult.errors.join("\n"), /provenance revalidation failed|identity changed/);
  assert.equal(existsSync(projectTarget), false, "CommonProject check/use rejection must precede target writes");
  assert.equal(existsSync(projectEffect), false, "CommonProject must not execute a replaced attested launcher");
  assert.equal(existsSync(plan.registryPath), false, "CommonProject check/use rejection must precede registry writes");

  // The project-owned boundary must repeat the handler's identity check before
  // its filesystem plan. A nested Copier check is too late because that plan
  // also owns .project.json and registry projection. These sentinels live
  // outside the target, so a rollback cannot disguise an ordering regression.
  const projectOwnedMutation = syntheticUvCopier("project-owned-check-use");
  const projectOwnedRoot = join(workspace, "project-owned-check-use");
  const projectOwnedTarget = join(projectOwnedRoot, "target");
  const projectOwnedRegistry = join(projectOwnedRoot, "registry.yaml");
  const projectOwnedConfig = join(projectOwnedRoot, "template-config.toml");
  const projectOwnedEffect = join(projectOwnedRoot, "effect.log");
  executable(projectOwnedMutation.launcher, `#!/bin/sh\nprintf ran > "${projectOwnedEffect}"\n`);
  const projectOwnedPlan = planProjectInit({
    name: "PJAN-67 Project Boundary",
    targetDir: projectOwnedTarget,
    projectSlug: "pjan-67-project-boundary",
    projectIdentifier: "PBOU",
    registryPath: projectOwnedRegistry,
    pjanglerRoot: root,
    provisionAgent: true,
    agentRole: "director",
    apply: true,
    live: true,
    provisionRuntimeRepo: true,
    provisionTicketBoard: true,
    enableSystemd: true,
  });
  let projectOwnedPlanCalls = 0;
  let projectOwnedGitCalls = 0;
  const projectOwnedRuntime: ProjectRecipeRuntime = {
    async executePlan(executedPlan) {
      projectOwnedPlanCalls += 1;
      mkdirSync(projectOwnedTarget, { recursive: true });
      writeFileSync(join(projectOwnedTarget, ".project.json"), "{}\n", "utf8");
      writeFileSync(projectOwnedRegistry, "projects: {}\n", "utf8");
      writeFileSync(projectOwnedConfig, "effect = true\n", "utf8");
      writeFileSync(projectOwnedEffect, "plan/provider/systemd effect\n", "utf8");
      return {
        ok: false,
        plan: executedPlan,
        logs: [],
        errors: ["injected effectful plan execution"],
        changedFiles: [join(projectOwnedTarget, ".project.json")],
      };
    },
    preflightBmad() { return { ok: true }; },
    runGit() {
      projectOwnedGitCalls += 1;
      writeFileSync(projectOwnedEffect, "git effect\n", "utf8");
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const projectOwnedRegistryBoundary = new RecipeRegistry([
    noopRecipe("mise"),
    noopRecipe("agent-hooks", ["mise"]),
    noopRecipe("bmad", ["agent-hooks"]),
    new ProjectRecipe(projectOwnedRuntime),
  ]);
  const projectOwnedResult = await projectOwnedRegistryBoundary.initRecipe(
    "project",
    {
      targetDir: projectOwnedTarget,
      repoRoot: projectOwnedTarget,
      pjanglerRoot: root,
      homeDir: projectOwnedMutation.home,
      dryRun: false,
      force: false,
      live: true,
      quiet: true,
    },
    {
      plan: projectOwnedPlan,
      mode: "create",
      trustedCopier: projectOwnedMutation.identity,
      requireTrustedCopier: true,
      quiet: true,
    },
  );
  assert.equal(projectOwnedResult.ok, false);
  assert.match(projectOwnedResult.errors.join("\n"), /provenance revalidation failed|identity changed/);
  assert.equal(projectOwnedPlanCalls, 0, "outer project identity rejection must precede the filesystem plan");
  assert.equal(projectOwnedGitCalls, 0, "outer project identity rejection must precede Git/system children");
  assert.equal(existsSync(projectOwnedTarget), false, "outer project identity rejection must create no target");
  assert.equal(existsSync(projectOwnedRegistry), false, "outer project identity rejection must create no registry");
  assert.equal(existsSync(projectOwnedConfig), false, "outer project identity rejection must create no host config");
  assert.equal(existsSync(projectOwnedEffect), false, "outer project identity rejection must trigger no process/provider/host effect");

  const ambientCredentials = {
    PLANE_API_KEY: "plane-grant",
    PLANE_33GOD_API_KEY: "plane-workspace-grant",
    TRELLO_KEY: "trello-grant",
    TRELLO_TOKEN: "trello-token",
    LINEAR_API_KEY: "linear-grant",
    SLACK_BOT_TOKEN: "slack-grant",
  };
  const hardened = hardenSubprocessEnvironment({
    ...ambientCredentials,
    PATH: "/trusted/copier/bin:/trusted/hermes/bin:/usr/bin",
    PJAN67_FUNCTIONAL_OVERRIDE: "preserved",
    LD_SDK_KEY: "non-loader-functional-value",
    PYTHONPATH: "/tmp/inject-python-path",
    PYTHONHOME: "/tmp/inject-python-home",
    PYTHONSTARTUP: "/tmp/inject-python-startup.py",
    PYTHONUSERBASE: "/tmp/inject-python-userbase",
    BASH_ENV: "/tmp/inject-bash-env",
    ENV: "/tmp/inject-shell-env",
    NODE_OPTIONS: "--require=/tmp/inject-node.cjs",
    NODE_PATH: "/tmp/inject-node-path",
    LD_PRELOAD: "/tmp/inject.so",
    LD_LIBRARY_PATH: "/tmp/inject-lib",
    LD_AUDIT: "/tmp/inject-audit.so",
    LD_AUDIT_64: "/tmp/inject-audit-64.so",
    LD_ASSUME_KERNEL: "2.6.32",
    LD_HWCAP_MASK: "0",
    GLIBC_TUNABLES: "glibc.cpu.hwcaps=-AVX2",
    DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
    DYLD_LIBRARY_PATH: "/tmp/inject-dyld-lib",
    "BASH_FUNC_pjan67_ambient_probe%%": "() { printf imported; }",
    BASHOPTS: "extdebug:sourcepath",
    SHELLOPTS: "braceexpand:hashall:interactive-comments:xtrace",
    BASH_COMPAT: "50",
    BASH_LOADABLES_PATH: "/tmp/inject-builtins",
    BASH_XTRACEFD: "2",
    PROMPT_COMMAND: "printf prompt-injected",
    PS4: "$(printf trace-injected)",
  });
  for (const key of [
    "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONUSERBASE",
    "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_AUDIT_64",
    "LD_ASSUME_KERNEL", "LD_HWCAP_MASK", "GLIBC_TUNABLES",
    "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
    "BASH_FUNC_pjan67_ambient_probe%%", "BASHOPTS", "SHELLOPTS",
    "BASH_COMPAT", "BASH_LOADABLES_PATH", "BASH_XTRACEFD", "PROMPT_COMMAND", "PS4",
  ]) {
    assert.equal(hardened[key], undefined, `subprocess hardening must remove ${key}`);
  }
  assert.equal(hardened.PYTHONNOUSERSITE, "1");
  assert.equal(hardened.PYTHONSAFEPATH, "1");
  assert.equal(
    hardened.PATH,
    "/trusted/copier/bin:/trusted/hermes/bin:/usr/bin",
    "subprocess hardening must preserve controlled executable resolution",
  );
  assert.equal(hardened.PJAN67_FUNCTIONAL_OVERRIDE, "preserved");
  assert.equal(hardened.LD_SDK_KEY, "non-loader-functional-value", "non-loader LD_* overrides must survive");
  for (const [key, value] of Object.entries(ambientCredentials)) {
    assert.equal(hardened[key], value, `subprocess hardening must preserve explicitly granted ${key}`);
  }

  // Keep a test-owned inventory of the documented GNU loader surface. This is
  // intentionally not imported from the implementation: omitting a loader
  // stem or its multilib spelling from the boundary must make the gate fail.
  const gnuLoaderControlStems = [
    "LD_ASSUME_KERNEL", "LD_AUDIT", "LD_BIND_NOT", "LD_BIND_NOW",
    "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_DYNAMIC_WEAK", "LD_HWCAP_MASK",
    "LD_LIBRARY_PATH", "LD_ORIGIN_PATH", "LD_POINTER_GUARD",
    "LD_PREFER_MAP_32BIT_EXEC", "LD_PRELOAD", "LD_PROFILE",
    "LD_PROFILE_OUTPUT", "LD_SHOW_AUXV", "LD_TRACE_LOADED_OBJECTS",
    "LD_TRACE_PRELINKING", "LD_USE_LOAD_BIAS", "LD_VERBOSE", "LD_WARN",
  ];
  const bashStartupAndTraceControls = [
    "BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS", "BASH_COMPAT",
    "BASH_LOADABLES_PATH", "BASH_XTRACEFD", "PROMPT_COMMAND",
    "PS0", "PS1", "PS2", "PS3", "PS4",
  ];
  const loaderAndShellFamilyFixture = Object.fromEntries([
    ...gnuLoaderControlStems.flatMap((key) => [key, `${key}_32`, `${key}_64`]),
    ...bashStartupAndTraceControls,
    "GLIBC_TUNABLES",
    "DYLD_FRAMEWORK_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "BASH_FUNC_python3%%",
    "BASH_FUNC_git%%",
    "BASH_FUNC_future_encoding",
  ].map((key) => [key, `blocked:${key}`]));
  const hardenedFamilies = hardenSubprocessEnvironment(
    {
      ...loaderAndShellFamilyFixture,
      LD_SDK_KEY: "preserved-source-value",
      PJAN67_FAMILY_FUNCTIONAL_OVERRIDE: "preserved-source-override",
    },
    {
      LD_AUDIT: "blocked:override-cannot-rearm-loader",
      "BASH_FUNC_python3%%": "() { printf override-cannot-rearm-shell; }",
      LD_SDK_KEY: "preserved-override-value",
    },
  );
  for (const key of Object.keys(loaderAndShellFamilyFixture)) {
    assert.equal(hardenedFamilies[key], undefined, `family hardening must remove ${key}`);
  }
  assert.equal(hardenedFamilies.LD_SDK_KEY, "preserved-override-value");
  assert.equal(hardenedFamilies.PJAN67_FAMILY_FUNCTIONAL_OVERRIDE, "preserved-source-override");

  const previousAmbientOnly = process.env.PJAN67_AMBIENT_PARENT_ONLY;
  process.env.PJAN67_AMBIENT_PARENT_ONLY = "must-not-be-merged";
  try {
    const minimalChild = hardenedSpawnSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      {
        encoding: "utf8",
        env: {
          PATH: "/controlled/child/path",
          PJAN67_FUNCTIONAL_OVERRIDE: "preserved",
          LD_SDK_KEY: "preserved-non-loader-key",
          NODE_OPTIONS: "--require=/must/not/load.cjs",
          LD_PRELOAD: "/must/not/load.so",
          LD_AUDIT_32: "/must/not/audit.so",
          GLIBC_TUNABLES: "glibc.malloc.check=3",
          "BASH_FUNC_pjan67_sync_probe%%": "() { printf imported; }",
          SHELLOPTS: "braceexpand:hashall:interactive-comments:xtrace",
          PS4: "TRACE-INJECTION:",
        },
      },
    );
    assert.equal(minimalChild.status, 0, minimalChild.stderr);
    const minimalEnvironment = JSON.parse(minimalChild.stdout) as Record<string, string>;
    assert.deepEqual(
      Object.keys(minimalEnvironment).sort(),
      ["PATH", "PJAN67_FUNCTIONAL_OVERRIDE", "LD_SDK_KEY", "PYTHONNOUSERSITE", "PYTHONSAFEPATH"].sort(),
      "an explicit minimal env must not be merged over ambient process.env",
    );
    assert.equal(minimalEnvironment.PATH, "/controlled/child/path");
    assert.equal(minimalEnvironment.PJAN67_FUNCTIONAL_OVERRIDE, "preserved");
    assert.equal(minimalEnvironment.LD_SDK_KEY, "preserved-non-loader-key");
    assert.equal(minimalEnvironment.PJAN67_AMBIENT_PARENT_ONLY, undefined);

    const bashFunctionChild = hardenedSpawnSync(
      "bash",
      ["-c", "if declare -F pjan67_sync_probe >/dev/null; then pjan67_sync_probe; else printf absent; fi"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          "BASH_FUNC_pjan67_sync_probe%%": "() { printf imported; }",
          SHELLOPTS: "braceexpand:hashall:interactive-comments:xtrace",
          PS4: "TRACE-INJECTION:",
        },
      },
    );
    assert.equal(bashFunctionChild.status, 0, bashFunctionChild.stderr);
    assert.equal(bashFunctionChild.stdout, "absent", "exported Bash functions must not enter a child shell");
    assert.equal(bashFunctionChild.stderr, "", "trace/startup controls must not activate in a child shell");

    const asyncChild = hardenedSpawn(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      {
        env: {
          PJAN67_ASYNC_OVERRIDE: "preserved",
          LD_SDK_KEY: "async-non-loader-key",
          NODE_PATH: "/must/not/resolve",
          DYLD_INSERT_LIBRARIES: "/must/not/load.dylib",
          LD_DEBUG_OUTPUT: "/must/not/write-loader-debug",
          LD_AUDIT_64: "/must/not/audit.so",
          "BASH_FUNC_pjan67_async_probe%%": "() { printf imported; }",
          BASH_XTRACEFD: "2",
          PS4: "TRACE-INJECTION:",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let asyncStdout = "";
    let asyncStderr = "";
    asyncChild.stdout.setEncoding("utf8");
    asyncChild.stderr.setEncoding("utf8");
    asyncChild.stdout.on("data", (chunk: string) => { asyncStdout += chunk; });
    asyncChild.stderr.on("data", (chunk: string) => { asyncStderr += chunk; });
    const asyncStatus = await new Promise<number | null>((resolveStatus, reject) => {
      asyncChild.once("error", reject);
      asyncChild.once("close", resolveStatus);
    });
    assert.equal(asyncStatus, 0, asyncStderr);
    const asyncEnvironment = JSON.parse(asyncStdout) as Record<string, string>;
    assert.deepEqual(
      Object.keys(asyncEnvironment).sort(),
      ["PJAN67_ASYNC_OVERRIDE", "LD_SDK_KEY", "PYTHONNOUSERSITE", "PYTHONSAFEPATH"].sort(),
      "async spawn must preserve the same explicit-minimal-env semantics",
    );
  } finally {
    if (previousAmbientOnly === undefined) delete process.env.PJAN67_AMBIENT_PARENT_ONLY;
    else process.env.PJAN67_AMBIENT_PARENT_ONLY = previousAmbientOnly;
  }

  assert.equal(preflightCommonProjectTemplate(root).ok, true, "the vendored CommonProject template must satisfy lifecycle eligibility");
  const templateRoot = join(root, "templates", "hermes-agent");
  const templateHead = hardenedSpawnSync("git", ["rev-parse", "HEAD"], {
    cwd: templateRoot,
    encoding: "utf8",
  });
  assert.equal(templateHead.status, 0, templateHead.stderr || templateHead.stdout);
  assert.equal(
    templateHead.stdout.trim(),
    HERMES_TEMPLATE_ATTESTATION.commit,
    "the checked-out Hermes submodule must equal the immutable attestation commit",
  );
  const attestedTree = hardenedSpawnSync("git", ["ls-tree", "-r", "--name-only", HERMES_TEMPLATE_ATTESTATION.commit], {
    cwd: templateRoot,
    encoding: "utf8",
  });
  assert.equal(attestedTree.status, 0, attestedTree.stderr || attestedTree.stdout);
  const expectedTemplateAssets = attestedTree.stdout
    .split(/\r?\n/)
    .filter((path) => path === "copier.yml" || path.startsWith("template/"))
    .sort();
  assert.deepEqual(
    Object.keys(HERMES_TEMPLATE_ATTESTATION.files).sort(),
    expectedTemplateAssets,
    "every Copier config/template/task byte must be bound to the pinned Git object",
  );
  for (const [relativePath, expected] of Object.entries(HERMES_TEMPLATE_ATTESTATION.files)) {
    const blob = hardenedSpawnSync("git", ["rev-parse", `${HERMES_TEMPLATE_ATTESTATION.commit}:${relativePath}`], {
      cwd: templateRoot,
      encoding: "utf8",
    });
    assert.equal(blob.status, 0, blob.stderr || blob.stdout);
    assert.equal(blob.stdout.trim(), expected.gitBlob, `${relativePath} blob id must come from the pinned tree`);
    const bytes = hardenedSpawnSync("git", ["show", `${HERMES_TEMPLATE_ATTESTATION.commit}:${relativePath}`], {
      cwd: templateRoot,
      encoding: null,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(bytes.status, 0, bytes.stderr?.toString() || bytes.stdout?.toString());
    assert.equal(
      createHash("sha256").update(bytes.stdout).digest("base64url"),
      expected.sha256,
      `${relativePath} package digest must be generated from its pinned Git blob`,
    );
  }
  assert.equal(preflightHermesTemplate(root).ok, true, "the vendored Hermes template must satisfy lifecycle eligibility");

  const mutableSnapshotRoot = join(workspace, "mutable-template-check-use");
  cpSync(templateRoot, mutableSnapshotRoot, { recursive: true });
  const capturedTemplate = captureAttestedHermesTemplate(mutableSnapshotRoot);
  assert.equal(capturedTemplate.ok, true, capturedTemplate.error);
  assert.ok(capturedTemplate.identity);
  const capturedTask = capturedTemplate.identity.files.find(
    (entry) => entry.path === "template/.scripts/05-fleet-env.sh",
  );
  assert.ok(capturedTask);
  writeFileSync(
    join(mutableSnapshotRoot, capturedTask.path),
    "#!/bin/sh\nprintf mutable-template-ran > /must-not-execute\n",
    "utf8",
  );
  writeFileSync(join(mutableSnapshotRoot, "template", "post-preflight-extra.sh"), "exit 99\n", "utf8");
  const immutableCopy = materializeTrustedHermesTemplate(capturedTemplate.identity);
  try {
    assert.match(immutableCopy.ref, /^[0-9a-f]{40}$/, "the private snapshot must expose an exact Git commit");
    if (process.platform === "linux") {
      assert.match(
        immutableCopy.source,
        new RegExp(`^git\\+/proc/${process.pid}/fd/[0-9]+$`),
        "Linux execution must use the already-open, unlinked bundle inode",
      );
    } else {
      assert.match(immutableCopy.source, /^git\+.*\.bundle$/, "portable execution must use a data-only bundle");
    }
    assert.deepEqual(
      readFileSync(join(immutableCopy.path, capturedTask.path)),
      Buffer.from(capturedTask.contentBase64, "base64"),
      "the execution snapshot must use captured bytes after the vendored path changes",
    );
    assert.equal(
      existsSync(join(immutableCopy.path, "template", "post-preflight-extra.sh")),
      false,
      "post-preflight extras must not enter the immutable execution snapshot",
    );

    // A private temp directory is not immutable merely because it was chmod'd:
    // its owner can rewrite it after final attestation. Copier must consume the
    // exact content-addressed commit instead of HEAD or working-tree bytes.
    const sameUidEffect = join(workspace, "same-uid-private-snapshot-effect");
    writeFileSync(
      join(immutableCopy.path, capturedTask.path),
      `#!/bin/sh\nprintf same-uid-ran > "${sameUidEffect}"\n`,
      "utf8",
    );
    const committedTask = hardenedSpawnSync(
      "git",
      ["-C", immutableCopy.path, "show", `${immutableCopy.ref}:${capturedTask.path}`],
      { encoding: null },
    );
    assert.equal(committedTask.status, 0, committedTask.stderr?.toString() || committedTask.stdout?.toString());
    assert.deepEqual(
      committedTask.stdout,
      Buffer.from(capturedTask.contentBase64, "base64"),
      "post-attestation same-user worktree edits must not change executed snapshot bytes",
    );

    if (liveUvCopier) {
      const sameUidTarget = join(workspace, "same-uid-private-snapshot-target");
      const copierResult = hardenedSpawnSync(
        liveUvCopier.executable,
        [
          "copy",
          immutableCopy.source,
          sameUidTarget,
          "--data", "target_repo=same-uid-private-snapshot",
          "--data", "role=pm",
          "--data", "agent_purpose=immutable snapshot regression",
          "--data", "model_provider=",
          "--data", "model_name=",
          "--data", "model_base_url=",
          "--data", "model_api_mode=",
          "--data", "model_key_env=",
          "--data", "profile_name=same-uid-private-snapshot-pm",
          "--data", "soul_tone=direct",
          "--data", "ticket_provider=plane",
          "--defaults",
          "--trust",
          `--vcs-ref=${immutableCopy.ref}`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SKIP_TELEGRAM: "1",
            SKIP_EMAIL: "1",
            SKIP_SLACK: "1",
            SKIP_HOST_STATE: "1",
            SKIP_RUNTIME_REPO: "1",
            SKIP_PLANE: "1",
            SKIP_BLOODBANK: "1",
            SKIP_SYSTEMD: "1",
            PJANGLER_PROJECT_ROOT: sameUidTarget,
          },
        },
      );
      assert.equal(copierResult.status, 0, copierResult.stderr || copierResult.stdout);
      assert.equal(existsSync(sameUidEffect), false, "same-user snapshot mutation must never execute");
      assert.deepEqual(
        readFileSync(join(sameUidTarget, ".scripts", "05-fleet-env.sh")),
        Buffer.from(capturedTask.contentBase64, "base64"),
        "real UV Copier must render the exact private snapshot commit",
      );
    }
  } finally {
    immutableCopy.cleanup();
  }

  if (process.platform === "linux") {
    const corruptedOpenCopy = materializeTrustedHermesTemplate(capturedTemplate.identity);
    const corruptedTarget = join(workspace, "same-uid-corrupted-open-snapshot-target");
    try {
      const openedBundle = corruptedOpenCopy.source.slice("git+".length);
      // Same-owner mode bits are not an immutability boundary. Prove the
      // stronger invariant: even a successful write through /proc can only
      // make the exact-ref data source fail closed, never select new bytes.
      chmodSync(openedBundle, 0o600);
      writeFileSync(openedBundle, "benign non-bundle replacement\n", "utf8");
      const rejected = hardenedSpawnSync(
        "git",
        ["clone", openedBundle, corruptedTarget],
        { encoding: "utf8" },
      );
      assert.notEqual(rejected.status, 0, "a modified opened bundle must fail Git validation");
      assert.equal(
        existsSync(join(corruptedTarget, "template", ".scripts", "05-fleet-env.sh")),
        false,
        "a modified opened snapshot must produce no executable template bytes",
      );
    } finally {
      corruptedOpenCopy.cleanup();
    }
  }
  const mutatedIdentity = {
    ...capturedTemplate.identity,
    files: capturedTemplate.identity.files.map((entry) => (
      entry.path === capturedTask.path
        ? { ...entry, contentBase64: Buffer.from("changed after capture").toString("base64") }
        : entry
    )),
  };
  assert.equal(
    verifyTrustedHermesTemplateIdentity(mutatedIdentity).ok,
    false,
    "an in-memory template replacement must be rejected before materialization",
  );

  if (liveUvCopier) {
    const liveSnapshotRoot = join(workspace, "live-immutable-template");
    cpSync(templateRoot, liveSnapshotRoot, { recursive: true });
    const liveCaptured = captureAttestedHermesTemplate(liveSnapshotRoot);
    assert.equal(liveCaptured.ok, true, liveCaptured.error);
    assert.ok(liveCaptured.identity);
    const mutableTask = join(liveSnapshotRoot, "template", ".scripts", "05-fleet-env.sh");
    writeFileSync(
      mutableTask,
      "#!/bin/sh\nprintf post-preflight-source-ran > \"$PJAN67_TEMPLATE_EFFECT\"\n",
      "utf8",
    );
    const immutableTarget = join(workspace, "live-immutable-target");
    const templateEffect = join(workspace, "live-immutable-template-effect");
    const previousEffect = process.env.PJAN67_TEMPLATE_EFFECT;
    process.env.PJAN67_TEMPLATE_EFFECT = templateEffect;
    try {
      const rendered = await new RunCopierTemplate({
        targetDir: immutableTarget,
        targetRepo: "immutable-template",
        role: "pm",
        yes: true,
        quiet: true,
        dryRun: false,
        skipPlane: true,
        trustedCopier: liveUvCopier,
        trustedHermesTemplate: liveCaptured.identity,
        deferredExternalEffects: {
          runtimeRepo: false,
          ticketBoard: false,
          systemd: false,
          owner: "hermes",
        },
      }).invoke();
      assert.equal(rendered.success, true, rendered.message);
    } finally {
      if (previousEffect === undefined) delete process.env.PJAN67_TEMPLATE_EFFECT;
      else process.env.PJAN67_TEMPLATE_EFFECT = previousEffect;
    }
    assert.equal(existsSync(templateEffect), false, "a post-preflight vendored task replacement must never execute");
    assert.deepEqual(
      readFileSync(join(immutableTarget, "agents", "hermes", "pm", ".scripts", "05-fleet-env.sh")),
      Buffer.from(
        liveCaptured.identity.files.find((entry) => entry.path === "template/.scripts/05-fleet-env.sh")!.contentBase64,
        "base64",
      ),
      "real Copier must render the exact captured task bytes",
    );
  }

  const symlinkedCanonicalRoot = join(workspace, "symlinked-canonical-root");
  const escapedCanonicalTemplates = join(workspace, "escaped-canonical-templates");
  mkdirSync(symlinkedCanonicalRoot, { recursive: true });
  cpSync(
    join(root, "templates", "hermes-agent"),
    join(escapedCanonicalTemplates, "hermes-agent"),
    { recursive: true },
  );
  symlinkSync(escapedCanonicalTemplates, join(symlinkedCanonicalRoot, "templates"), "dir");
  const escapedCanonical = preflightHermesTemplate(symlinkedCanonicalRoot);
  assert.equal(escapedCanonical.ok, false, "a symlinked template ancestor must not escape the pjangler root");
  assert.match(escapedCanonical.error ?? "", /escape|contain|symlink/i);

  const extraCanonicalRoot = join(workspace, "extra-canonical-template");
  cpSync(
    join(root, "templates", "hermes-agent"),
    join(extraCanonicalRoot, "templates", "hermes-agent"),
    { recursive: true },
  );
  writeFileSync(
    join(extraCanonicalRoot, "templates", "hermes-agent", "template", ".scripts", "unmanifested-task.sh"),
    "#!/bin/sh\nexit 99\n",
    "utf8",
  );
  const extraCanonical = preflightHermesTemplate(extraCanonicalRoot);
  assert.equal(extraCanonical.ok, false, "an unmanifested executable must fail the exact template inventory");
  assert.match(extraCanonical.error ?? "", /inventory.*extra.*unmanifested-task\.sh/i);

  const symlinkedAssetRoot = join(workspace, "symlinked-canonical-asset");
  cpSync(
    join(root, "templates", "hermes-agent"),
    join(symlinkedAssetRoot, "templates", "hermes-agent"),
    { recursive: true },
  );
  const symlinkedAsset = join(
    symlinkedAssetRoot,
    "templates",
    "hermes-agent",
    "template",
    ".scripts",
    "05-fleet-env.sh",
  );
  rmSync(symlinkedAsset);
  symlinkSync("01-config.sh", symlinkedAsset);
  const symlinkedCanonicalAsset = preflightHermesTemplate(symlinkedAssetRoot);
  assert.equal(symlinkedCanonicalAsset.ok, false, "a symlink inside the pinned tree must fail before effects");
  assert.match(symlinkedCanonicalAsset.error ?? "", /05-fleet-env\.sh.*not a regular file/i);

  const wrongModeRoot = join(workspace, "wrong-mode-canonical-template");
  cpSync(
    join(root, "templates", "hermes-agent"),
    join(wrongModeRoot, "templates", "hermes-agent"),
    { recursive: true },
  );
  chmodSync(
    join(wrongModeRoot, "templates", "hermes-agent", "template", "role.yaml.jinja"),
    0o755,
  );
  const wrongMode = preflightHermesTemplate(wrongModeRoot);
  assert.equal(wrongMode.ok, false, "Git executable-mode drift must fail before effects");
  assert.match(wrongMode.error ?? "", /executable mode mismatch/i);

  const missingParserRoot = join(workspace, "missing-parser-template");
  cpSync(
    join(root, "templates", "hermes-agent"),
    join(missingParserRoot, "templates", "hermes-agent"),
    { recursive: true },
  );
  rmSync(
    join(missingParserRoot, "templates", "hermes-agent", "template", ".scripts", "lib", "parse-fleet-env.py"),
  );
  const missingVendoredParser = preflightHermesTemplate(missingParserRoot);
  assert.equal(missingVendoredParser.ok, false, "the fleet parser is part of vendored Hermes eligibility");
  assert.match(missingVendoredParser.error ?? "", /parse-fleet-env\.py/);

  const missingLoaderRoot = join(workspace, "missing-loader-template");
  cpSync(
    join(root, "templates", "hermes-agent"),
    join(missingLoaderRoot, "templates", "hermes-agent"),
    { recursive: true },
  );
  rmSync(
    join(missingLoaderRoot, "templates", "hermes-agent", "template", ".scripts", "lib", "fleet-env.sh"),
  );
  const missingVendoredLoader = preflightHermesTemplate(missingLoaderRoot);
  assert.equal(missingVendoredLoader.ok, false, "the shared fleet loader is part of vendored Hermes eligibility");
  assert.match(missingVendoredLoader.error ?? "", /fleet-env\.sh/);

  const missingHeartbeatRoot = join(workspace, "missing-heartbeat-template");
  cpSync(
    join(root, "templates", "hermes-agent"),
    join(missingHeartbeatRoot, "templates", "hermes-agent"),
    { recursive: true },
  );
  rmSync(
    join(missingHeartbeatRoot, "templates", "hermes-agent", "template", ".scripts", "heartbeat.sh"),
  );
  const missingVendoredHeartbeat = preflightHermesTemplate(missingHeartbeatRoot);
  assert.equal(missingVendoredHeartbeat.ok, false, "the fleet-aware heartbeat is part of vendored Hermes eligibility");
  assert.match(missingVendoredHeartbeat.error ?? "", /heartbeat\.sh/);

  const tamperedCanonicalRoot = join(workspace, "tampered-canonical-template");
  const tamperedCanonicalTemplate = join(tamperedCanonicalRoot, "templates", "hermes-agent");
  cpSync(join(root, "templates", "hermes-agent"), tamperedCanonicalTemplate, { recursive: true });
  rmSync(join(tamperedCanonicalTemplate, ".git"), { recursive: true, force: true });
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    ["-c", "user.name=PJAN-67", "-c", "user.email=pjan-67@example.invalid", "commit", "--quiet", "-m", "fixture"],
  ]) {
    const git = hardenedSpawnSync("git", args, { cwd: tamperedCanonicalRoot, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  const committedHead = hardenedSpawnSync("git", ["rev-parse", "HEAD"], {
    cwd: tamperedCanonicalRoot,
    encoding: "utf8",
  }).stdout.trim();
  for (const relativeAsset of [
    "copier.yml",
    "template/role.yaml.jinja",
    "template/.scripts/05-fleet-env.sh",
    "template/.scripts/20-runtime-repo.sh",
    "template/.scripts/lib/fleet-env.sh",
    "template/.scripts/lib/parse-fleet-env.py",
    "template/.scripts/heartbeat.sh",
  ]) {
    const asset = join(tamperedCanonicalTemplate, relativeAsset);
    const pristine = readFileSync(asset, "utf8");
    writeFileSync(asset, `${pristine}\n# regular-file tamper with unchanged HEAD\n`, "utf8");
    const unchangedHead = hardenedSpawnSync("git", ["rev-parse", "HEAD"], {
      cwd: tamperedCanonicalRoot,
      encoding: "utf8",
    }).stdout.trim();
    assert.equal(unchangedHead, committedHead, "fixture HEAD must remain unchanged after a worktree byte tamper");
    const tampered = preflightHermesTemplate(tamperedCanonicalRoot);
    assert.equal(tampered.ok, false, `${relativeAsset} must be bound to the pinned template object, not current worktree bytes`);
    assert.match(tampered.error ?? "", /pinned|attest|integrity/i);
    writeFileSync(asset, pristine, "utf8");
  }

  const renderedTarget = join(workspace, "rendered-parser-attestation");
  const renderedRole = join(renderedTarget, "agents", "hermes", "pm");
  cpSync(
    join(root, "templates", "hermes-agent", "template", ".scripts"),
    join(renderedRole, ".scripts"),
    { recursive: true },
  );
  mkdirSync(join(renderedRole, ".runtime-scaffold"), { recursive: true });
  writeFileSync(join(renderedRole, "SOUL.md"), "fixture\n", "utf8");
  writeFileSync(join(renderedRole, "hermes"), "#!/bin/sh\n", "utf8");
  writeFileSync(join(renderedRole, ".gitignore"), "runtime/\n", "utf8");
  writeFileSync(join(renderedRole, ".runtime-scaffold", "README.md"), "fixture\n", "utf8");
  writeFileSync(
    join(renderedRole, "role.yaml"),
    "repo: parser-attestation\nrole: pm\nagent_id: parser-attestation-pm\n"
      + "bloodbank:\n  enabled: true\ndeployment:\n  local_only: true\n  systemd: deferred\n",
    "utf8",
  );
  writeFileSync(
    join(renderedTarget, ".project.json"),
    JSON.stringify({
      agents: {
        "parser-attestation-pm": {
          role: "pm",
          role_dir: "agents/hermes/pm",
          provisioning_state: "provisioned",
        },
      },
    }),
    "utf8",
  );
  const renderedOptions = {
    pjanglerRoot: root,
    targetDir: renderedTarget,
    roleDir: renderedRole,
    targetRepo: "parser-attestation",
    role: "pm",
    agentId: "parser-attestation-pm",
  };
  assert.equal(preflightRenderedHermes(renderedOptions).ok, true, "the complete rendered fixture must attest");

  const postRenderIdentity = preflightHermesTemplate(root);
  assert.equal(postRenderIdentity.ok, true, postRenderIdentity.error);
  assert.ok(postRenderIdentity.identity);
  const postRenderMutableTask = join(
    tamperedCanonicalTemplate,
    "template",
    ".scripts",
    "70-systemd.sh",
  );
  const postRenderPristine = readFileSync(postRenderMutableTask);
  writeFileSync(postRenderMutableTask, "#!/bin/sh\nexit 99\n", "utf8");
  try {
    const capturedPostcondition = preflightRenderedHermes({
      ...renderedOptions,
      pjanglerRoot: tamperedCanonicalRoot,
      trustedHermesTemplate: postRenderIdentity.identity,
    });
    assert.equal(
      capturedPostcondition.ok,
      true,
      "post-render eligibility must compare against pre-effect captured bytes, not a mutable vendored path",
    );
  } finally {
    writeFileSync(postRenderMutableTask, postRenderPristine);
  }

  const escapedRenderedTarget = join(workspace, "escaped-rendered-target");
  const escapedRenderedOutside = join(workspace, "escaped-rendered-outside");
  mkdirSync(escapedRenderedTarget, { recursive: true });
  cpSync(renderedRole, join(escapedRenderedOutside, "agents", "hermes", "pm"), { recursive: true });
  symlinkSync(join(escapedRenderedOutside, "agents"), join(escapedRenderedTarget, "agents"), "dir");
  writeFileSync(
    join(escapedRenderedTarget, ".project.json"),
    JSON.stringify({
      agents: {
        "parser-attestation-pm": {
          role: "pm",
          role_dir: "agents/hermes/pm",
          provisioning_state: "provisioned",
        },
      },
    }),
    "utf8",
  );
  const escapedRendered = preflightRenderedHermes({
    ...renderedOptions,
    targetDir: escapedRenderedTarget,
    roleDir: join(escapedRenderedTarget, "agents", "hermes", "pm"),
  });
  assert.equal(escapedRendered.ok, false, "a symlinked role ancestor must not escape the project target");
  assert.match(escapedRendered.error ?? "", /escape|contain|symlink/i);
  const renderedParser = join(renderedRole, ".scripts", "lib", "parse-fleet-env.py");
  const parserSource = readFileSync(renderedParser, "utf8");
  rmSync(renderedParser);
  const missingRenderedParser = preflightRenderedHermes(renderedOptions);
  assert.equal(missingRenderedParser.ok, false, "a rendered role without its fleet parser must fail eligibility");
  assert.match(missingRenderedParser.error ?? "", /parse-fleet-env\.py/);
  writeFileSync(renderedParser, `${parserSource}\n# tampered after render\n`, "utf8");
  const tamperedRenderedParser = preflightRenderedHermes(renderedOptions);
  assert.equal(tamperedRenderedParser.ok, false, "a rendered fleet parser must equal the attested vendored parser");
  assert.match(tamperedRenderedParser.error ?? "", /differs.*parse-fleet-env\.py/);
  writeFileSync(renderedParser, parserSource, "utf8");

  const renderedLoader = join(renderedRole, ".scripts", "lib", "fleet-env.sh");
  const loaderSource = readFileSync(renderedLoader, "utf8");
  rmSync(renderedLoader);
  const missingRenderedLoader = preflightRenderedHermes(renderedOptions);
  assert.equal(missingRenderedLoader.ok, false, "a rendered role without its shared fleet loader must fail eligibility");
  assert.match(missingRenderedLoader.error ?? "", /fleet-env\.sh/);
  writeFileSync(renderedLoader, `${loaderSource}\n# tampered after render\n`, "utf8");
  const tamperedRenderedLoader = preflightRenderedHermes(renderedOptions);
  assert.equal(tamperedRenderedLoader.ok, false, "a rendered shared fleet loader must equal the attested vendored loader");
  assert.match(tamperedRenderedLoader.error ?? "", /differs.*fleet-env\.sh/);
  writeFileSync(renderedLoader, loaderSource, "utf8");

  const renderedHeartbeat = join(renderedRole, ".scripts", "heartbeat.sh");
  const heartbeatSource = readFileSync(renderedHeartbeat, "utf8");
  rmSync(renderedHeartbeat);
  const missingRenderedHeartbeat = preflightRenderedHermes(renderedOptions);
  assert.equal(missingRenderedHeartbeat.ok, false, "a rendered role without its fleet-aware heartbeat must fail eligibility");
  assert.match(missingRenderedHeartbeat.error ?? "", /heartbeat\.sh/);
  writeFileSync(renderedHeartbeat, `${heartbeatSource}\n# tampered after render\n`, "utf8");
  const tamperedRenderedHeartbeat = preflightRenderedHermes(renderedOptions);
  assert.equal(tamperedRenderedHeartbeat.ok, false, "a rendered heartbeat must equal the attested vendored heartbeat");
  assert.match(tamperedRenderedHeartbeat.error ?? "", /differs.*heartbeat\.sh/);

  const untrustedTemplate = preflightHermesTemplate(root, { PJANGLER_HERMES_TEMPLATE: join(workspace, "untrusted-template") });
  assert.equal(untrustedTemplate.ok, false, "MCP must reject an unversioned Hermes template override");
  assert.match(untrustedTemplate.error ?? "", /version-locked|unavailable/);

  console.log("PJAN-67 lifecycle eligibility/provenance/check-use regressions: PASS");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
