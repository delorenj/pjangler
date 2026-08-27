import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import {
  preflightCommonProjectTemplate,
  preflightHermesTemplate,
  preflightTrustedCopier,
  verifyTrustedCopierIdentity,
  type TrustedCopierIdentity,
} from "../src/lifecycle/preflight";
import { executeProjectInitPlan, planProjectInit } from "../src/project/index";

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

try {
  // This is an integration assertion, not a prerequisite for the hermetic
  // suite. On the release host it proves the installed UV Copier is accepted.
  const actual = preflightTrustedCopier({ targetDir: join(workspace, "actual-target") });
  if (actual.ok) {
    assert.equal(actual.layout, "uv-tool");
    assert.ok(actual.identity);
    assert.equal(actual.identity.executable, realpathSync(actual.identity.resolvedFrom));
    assert.equal(verifyTrustedCopierIdentity(actual.identity).ok, true);
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
    const context: HermesAgentContext = {
      targetDir: hermesTarget,
      targetRepo: "check-use",
      role: "pm",
      yes: true,
      quiet: true,
      dryRun: false,
      skipPlane: true,
      trustedCopier: hermesMutation.identity,
      deferredExternalEffects: { ticketBoard: false, systemd: false, owner: "hermes" },
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

  assert.equal(preflightCommonProjectTemplate(root).ok, true, "the vendored CommonProject template must satisfy lifecycle eligibility");
  assert.equal(preflightHermesTemplate(root).ok, true, "the vendored Hermes template must satisfy lifecycle eligibility");
  const untrustedTemplate = preflightHermesTemplate(root, { PJANGLER_HERMES_TEMPLATE: join(workspace, "untrusted-template") });
  assert.equal(untrustedTemplate.ok, false, "MCP must reject an unversioned Hermes template override");
  assert.match(untrustedTemplate.error ?? "", /version-locked|unavailable/);

  console.log("PJAN-67 lifecycle eligibility/provenance/check-use regressions: PASS");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
