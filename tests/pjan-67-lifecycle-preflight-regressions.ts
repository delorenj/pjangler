import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  preflightCommonProjectTemplate,
  preflightHermesTemplate,
  preflightTrustedCopier,
} from "../src/lifecycle/preflight";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pjan-67-preflight-contract-"));
const launcher = `#!/usr/bin/env python3
import sys
from copier.__main__ import CopierApp
sys.exit(CopierApp.run())
`;

function executable(path: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, launcher, "utf8");
  chmodSync(path, 0o755);
}

function attest(path: string, homeDir: string, systemRoots?: readonly string[]) {
  return preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: join(path, "..") },
    homeDir,
    // Synthetic supported layouts live under the host temp root. Override the
    // OS temp boundary only for this pure contract test; production never does.
    temporaryDir: join(workspace, "separate-os-temp"),
    systemRoots,
  });
}

try {
  const actual = preflightTrustedCopier({ targetDir: join(workspace, "actual-target") });
  if (actual.ok) {
    assert.match(actual.layout ?? "", /uv-tool|pip-user|pipx|pyenv-version|system/);
  } else {
    console.log(`PJAN-67 live installed-Copier attestation skipped: ${actual.error}`);
  }

  const syntheticHome = join(workspace, "home");
  const pipUser = join(syntheticHome, ".local", "bin", "copier");
  executable(pipUser);
  assert.equal(attest(pipUser, syntheticHome).ok, true, "pip --user console scripts are supported");

  const uvReal = join(syntheticHome, ".local", "share", "uv", "tools", "copier", "bin", "copier");
  executable(uvReal);
  rmSync(pipUser);
  symlinkSync(uvReal, pipUser);
  const uv = attest(pipUser, syntheticHome);
  assert.equal(uv.ok, true, `uv tool launchers are supported: ${uv.error}`);
  assert.equal(uv.layout, "uv-tool");

  const pipx = join(syntheticHome, ".local", "pipx", "venvs", "copier", "bin", "copier");
  executable(pipx);
  assert.equal(attest(pipx, syntheticHome).ok, true, "pipx console scripts are supported");

  const syntheticSystemRoot = join(workspace, "opt", "homebrew", "bin");
  const systemCopier = join(syntheticSystemRoot, "copier");
  executable(systemCopier);
  assert.equal(attest(systemCopier, syntheticHome, [syntheticSystemRoot]).ok, true, "system/Homebrew console scripts are supported");

  const shadowDir = join(workspace, "shadow-bin");
  const shadow = join(shadowDir, "copier");
  executable(shadow);
  const shadowed = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: `${shadowDir}${delimiter}${join(syntheticHome, ".local", "bin")}` },
    homeDir: syntheticHome,
    temporaryDir: join(workspace, "separate-os-temp"),
  });
  assert.equal(shadowed.ok, false, "the first PATH match must fail closed instead of falling through to a trusted Copier");
  assert.match(shadowed.error ?? "", /PATH-shadowed/);

  const targetCopier = join(workspace, "target", "bin", "copier");
  executable(targetCopier);
  const targetLocal = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: join(targetCopier, "..") },
    homeDir: syntheticHome,
    temporaryDir: join(workspace, "separate-os-temp"),
    systemRoots: [join(workspace, "target", "bin")],
  });
  assert.equal(targetLocal.ok, false);
  assert.match(targetLocal.error ?? "", /target-local/);

  const osTemp = join(workspace, "os-temp");
  const tempCopier = join(osTemp, "bin", "copier");
  executable(tempCopier);
  const temporaryLocal = preflightTrustedCopier({
    targetDir: join(workspace, "target"),
    env: { PATH: join(tempCopier, "..") },
    homeDir: syntheticHome,
    temporaryDir: osTemp,
    systemRoots: [join(osTemp, "bin")],
  });
  assert.equal(temporaryLocal.ok, false);
  assert.match(temporaryLocal.error ?? "", /temporary-local/);

  assert.equal(preflightCommonProjectTemplate(root).ok, true, "the vendored CommonProject template must satisfy lifecycle eligibility");
  assert.equal(preflightHermesTemplate(root).ok, true, "the vendored Hermes template must satisfy lifecycle eligibility");
  const untrustedTemplate = preflightHermesTemplate(root, { PJANGLER_HERMES_TEMPLATE: join(workspace, "untrusted-template") });
  assert.equal(untrustedTemplate.ok, false, "MCP must reject an unversioned Hermes template override");
  assert.match(untrustedTemplate.error ?? "", /version-locked|unavailable/);

  console.log("PJAN-67 lifecycle eligibility/provenance regressions: PASS");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
