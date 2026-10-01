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
import {
  preflightCommonProjectTemplate,
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
    const skippedNote = actual.skipped?.length ? `; skipped ${actual.skipped.map((entry) => entry.path).join(", ")}` : "";
    console.log(`PJAN-67 live UV Copier attested: ${actual.identity.executable} (${actual.identity.version})${skippedNote}`);
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

  // PJAN-150: an inactive mise shim in the OS account's own shims directory is
  // not an executable candidate. mise creates `<home>/.local/share/mise/shims/
  // copier -> <...>/mise` when Copier is pip-installed into a mise Python; with
  // that Python inactive, executing it would fall back to the next PATH match.
  // Preflight passes over it WITHOUT executing it and attests the next match
  // with the unchanged UV contract. The fake `mise` writes an effect file if it
  // is ever run, so "skipped" can never quietly mean "executed".
  const separateTemp = join(workspace, "separate-os-temp");
  const miseEffect = join(workspace, "mise-shim-effect.log");
  const fakeMise = join(workspace, "mise-install", "bin", "mise");
  executable(fakeMise, `#!/bin/sh\nprintf mise-ran >> "${miseEffect}"\n`);
  const shimsDirOf = (home: string) => join(home, ".local", "share", "mise", "shims");

  const shimmed = syntheticUvCopier("inactive-mise-shim");
  const canonicalShim = join(shimsDirOf(shimmed.home), "copier");
  mkdirSync(dirname(canonicalShim), { recursive: true });
  symlinkSync(fakeMise, canonicalShim);
  const viaShim = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    // The shims dir is listed twice, as a doubly activated shell leaves it.
    env: { PATH: [dirname(canonicalShim), dirname(canonicalShim), dirname(shimmed.entryPoint)].join(delimiter) },
    homeDir: shimmed.home,
    temporaryDir: separateTemp,
  });
  assert.equal(viaShim.ok, true, `an inactive mise shim ahead of the UV entry must be skipped: ${viaShim.error}`);
  assert.equal(viaShim.layout, "uv-tool");
  assert.ok(viaShim.identity);
  assert.equal(viaShim.identity.resolvedFrom, shimmed.entryPoint, "the attested candidate is the PATH match after the shim");
  assert.equal(viaShim.identity.executable, realpathSync(shimmed.entryPoint));
  assert.deepEqual(viaShim.skipped, [{ path: canonicalShim, realPath: realpathSync(fakeMise), reason: "inactive-mise-shim" }]);
  assert.equal(verifyTrustedCopierIdentity(viaShim.identity).ok, true);
  assert.equal(existsSync(miseEffect), false, "resolution must never execute a skipped mise shim");

  // The identity pin still guards the launcher reached through the skip.
  executable(shimmed.launcher, `#!/bin/sh\nprintf replaced > "${join(workspace, "shim-check-use-effect.log")}"\n`);
  const shimRevalidation = verifyTrustedCopierIdentity(viaShim.identity);
  assert.equal(shimRevalidation.ok, false, "a launcher replaced after a shim-skipping preflight must fail revalidation");
  assert.match(shimRevalidation.error ?? "", /identity changed/);
  assert.equal(existsSync(join(workspace, "shim-check-use-effect.log")), false);

  // Only that exact shape is skipped. Each of these precedes a trusted UV
  // entry on PATH and must still fail closed on the first match.
  const shadowedUv = syntheticUvCopier("mise-shim-negatives");
  const shadowEffectRuns = join(workspace, "mise-shim-negative-effect.log");
  const precedingShadow = (label: string, entryDir: string, env: NodeJS.ProcessEnv = {}) => {
    const result = preflightTrustedCopier({
      targetDir: join(workspace, "target"),
      env: { ...env, PATH: `${entryDir}${delimiter}${dirname(shadowedUv.entryPoint)}` },
      homeDir: shadowedUv.home,
      temporaryDir: separateTemp,
    });
    assert.equal(result.ok, false, `${label} must fail closed instead of being skipped`);
    assert.match(result.error ?? "", /PATH-shadowed/, label);
    assert.deepEqual(result.skipped, [], `${label} is not an inactive mise shim`);
    return result;
  };

  // A regular file in the canonical shims dir is a program, not a shim link.
  const regularShim = join(shimsDirOf(shadowedUv.home), "copier");
  executable(regularShim, `#!/bin/sh\nprintf regular-ran >> "${shadowEffectRuns}"\n`);
  precedingShadow("a regular file in the account's mise shims dir", dirname(regularShim));
  rmSync(regularShim);

  // A symlink in the canonical shims dir that does not resolve to `mise`.
  const notMise = join(workspace, "not-mise", "bin", "mise-wrapper");
  executable(notMise, `#!/bin/sh\nprintf wrapper-ran >> "${shadowEffectRuns}"\n`);
  symlinkSync(notMise, regularShim);
  precedingShadow("a shims-dir symlink whose target is not named mise", dirname(regularShim));
  rmSync(regularShim);

  // A mise-shaped symlink anywhere else, even where the environment claims
  // mise's data lives: the shims anchor is the OS account, never HOME,
  // MISE_DATA_DIR or XDG_DATA_HOME.
  const ambientHome = join(workspace, "ambient-home");
  const ambientShims = shimsDirOf(ambientHome);
  mkdirSync(ambientShims, { recursive: true });
  symlinkSync(fakeMise, join(ambientShims, "copier"));
  precedingShadow("a mise-shaped symlink in an environment-nominated shims dir", ambientShims, {
    HOME: ambientHome,
    MISE_DATA_DIR: join(ambientHome, ".local", "share", "mise"),
    XDG_DATA_HOME: join(ambientHome, ".local", "share"),
  });
  const otherDir = join(workspace, "other-bin");
  mkdirSync(otherDir, { recursive: true });
  symlinkSync(fakeMise, join(otherDir, "copier"));
  precedingShadow("a mise-shaped symlink in a non-canonical dir", otherDir);
  assert.equal(existsSync(shadowEffectRuns), false, "rejected shadows must not be executed");

  // A skipped shim with nothing after it is "not found", and names the shim.
  const loneShim = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: dirname(canonicalShim) },
    homeDir: shimmed.home,
    temporaryDir: separateTemp,
  });
  assert.equal(loneShim.ok, false);
  assert.match(loneShim.error ?? "", /not found on PATH/);
  assert.match(loneShim.error ?? "", /mise shim/);
  assert.ok(loneShim.error?.includes(canonicalShim), `the not-found error must name the skipped shim: ${loneShim.error}`);
  assert.deepEqual(loneShim.skipped?.map((entry) => entry.path), [canonicalShim]);

  // A shim followed only by an untrusted copier: the next match fails closed
  // and the error still says what was skipped.
  const afterShim = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: `${dirname(canonicalShim)}${delimiter}${shadowDir}` },
    homeDir: shimmed.home,
    temporaryDir: separateTemp,
  });
  assert.equal(afterShim.ok, false, "a shim never promotes an untrusted next match");
  assert.match(afterShim.error ?? "", /PATH-shadowed/);
  assert.ok(afterShim.error?.includes(canonicalShim));
  assert.equal(existsSync(shadowEffect), false);

  // Skipped entries get the same containment as candidates: a shims dir under
  // the target or the temporary directory is refused, not skipped.
  for (const label of ["target", "temporary"] as const) {
    const containerRoot = join(workspace, `shims-in-${label}`, label);
    const home = join(containerRoot, "home");
    const shim = join(shimsDirOf(home), "copier");
    mkdirSync(dirname(shim), { recursive: true });
    symlinkSync(fakeMise, shim);
    const contained = preflightTrustedCopier({
      targetDir: label === "target" ? containerRoot : join(workspace, "target"),
      env: { PATH: `${dirname(shim)}${delimiter}${dirname(uv.entryPoint)}` },
      homeDir: home,
      temporaryDir: label === "temporary" ? containerRoot : separateTemp,
    });
    assert.equal(contained.ok, false, `a shims dir under the ${label} dir must be refused`);
    assert.match(contained.error ?? "", new RegExp(`${label}-local`));
    assert.ok(contained.error?.includes(shim), `${label}: the refusal names the shim`);
  }
  // ...and so is a canonical shim whose mise binary lives in the temporary dir.
  const tempMise = join(workspace, "temp-mise-os-temp", "bin", "mise");
  executable(tempMise, `#!/bin/sh\nprintf temp-mise-ran >> "${miseEffect}"\n`);
  const tempMiseHome = syntheticUvCopier("temp-mise-shim");
  const tempMiseShim = join(shimsDirOf(tempMiseHome.home), "copier");
  mkdirSync(dirname(tempMiseShim), { recursive: true });
  symlinkSync(tempMise, tempMiseShim);
  const tempMiseResult = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: `${dirname(tempMiseShim)}${delimiter}${dirname(tempMiseHome.entryPoint)}` },
    homeDir: tempMiseHome.home,
    temporaryDir: join(workspace, "temp-mise-os-temp"),
  });
  assert.equal(tempMiseResult.ok, false);
  assert.match(tempMiseResult.error ?? "", /temporary-local/);
  assert.equal(existsSync(miseEffect), false, "no mise shim fixture may ever be executed");

  // Check/use gap regression for the CommonProject executor. The attested
  // launcher is replaced after preflight with an effect-writing program.
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

  console.log("PJAN-67 lifecycle eligibility/provenance/check-use regressions: PASS");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
