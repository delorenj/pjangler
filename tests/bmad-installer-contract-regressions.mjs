import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

// This is a network/cache-backed release contract, intentionally separate from
// the ordinary hermetic npm test suite. It must fail (never skip) when the exact
// package cannot be resolved, so the publish workflow cannot certify a fixture
// while the real installer is unavailable or incompatible.
const root = resolve(import.meta.dirname, "..");
const packageName = "bmad-method";
const requiredVersion = "6.11.1-next.1";
const requiredIntegrity = "sha512-lsiLmjummAmXz6ls7mmszKc8HePKfAEsmVwFbblPbssOeY5fi4wBdxw4YiOXjOaCtzwSe1bIjR8kXcLQu99v1w==";
const packageSpec = `${packageName}@${requiredVersion}`;
const requestedProjectName = "PJAN 57 Installer Contract Delta";
const optionalModules = ["bmm", "bmb", "cis"];
const enabledModules = ["core", ...optionalModules];
const supportedTools = ["claude-code", "codex", "gemini", "github-copilot", "opencode", "kimi-code"];
const temporary = mkdtempSync(join(tmpdir(), "pjan-57-real-bmad-contract-"));
const target = join(temporary, "target-basename-must-not-win");

function diagnostics(result) {
  return [
    result.error?.message,
    result.stdout,
    result.stderr,
    result.signal ? `signal: ${result.signal}` : undefined,
  ].filter(Boolean).join("\n").trim().slice(-12_000);
}

function runRequired(command, args, purpose, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      CI: "true",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout,
  });
  if (result.status !== 0) {
    throw new Error(
      `REAL BMAD INSTALLER CONTRACT FAILED: ${purpose} for immutable ${packageSpec}. ` +
      "This publish gate does not skip when npm/network/cache resolution is unavailable.\n" +
      diagnostics(result),
    );
  }
  return result;
}

function metadataRecord(value) {
  const records = Array.isArray(value) ? value : [value];
  return records.find((entry) => entry && typeof entry === "object" && entry.version === requiredVersion);
}

try {
  const rulesSource = readFileSync(join(root, "src", "parity", "rules.ts"), "utf8");
  const productionPin = rulesSource.match(/export const BMAD_INSTALLER_VERSION\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(
    productionPin,
    requiredVersion,
    `real installer contract must exercise the production pin, expected ${requiredVersion}, received ${productionPin ?? "no pin"}`,
  );

  const metadataResult = runRequired(
    "npm",
    ["view", packageSpec, "version", "dist.integrity", "--json"],
    "resolving pinned package metadata from the configured npm registry/cache",
    60_000,
  );
  let metadata;
  try {
    metadata = metadataRecord(JSON.parse(metadataResult.stdout));
  } catch (error) {
    throw new Error(`REAL BMAD INSTALLER CONTRACT FAILED: npm returned invalid metadata JSON for ${packageSpec}: ${error.message}`);
  }
  assert.ok(metadata, `npm metadata did not include exact version ${requiredVersion}`);
  assert.equal(metadata["dist.integrity"] ?? metadata.dist?.integrity, requiredIntegrity, `${packageSpec} integrity drift`);

  const versionProbe = runRequired("npx", ["-y", packageSpec, "--version"], "executing the pinned installer version probe");
  assert.match(
    `${versionProbe.stdout}\n${versionProbe.stderr}`,
    new RegExp(`(^|\\D)${requiredVersion.replaceAll(".", "\\.")}($|\\D)`),
    `installer binary must report ${requiredVersion}`,
  );

  assert.notEqual(basename(target), requestedProjectName, "contract target basename must differ from the requested project name");
  mkdirSync(target, { recursive: true });
  runRequired(
    "npx",
    [
      "-y",
      packageSpec,
      "install",
      "--yes",
      "--directory",
      target,
      "--modules",
      optionalModules.join(","),
      "--tools",
      supportedTools.join(","),
      "--set",
      `core.project_name=${requestedProjectName}`,
    ],
    "installing core plus bmm,bmb,cis with a nontrivial requested project name",
  );

  const configToml = readFileSync(join(target, "_bmad", "config.toml"), "utf8");
  const tomlProjectName = configToml.match(/^project_name\s*=\s*"((?:\\.|[^"\\])*)"\s*$/m)?.[1];
  assert.notEqual(tomlProjectName, undefined, "_bmad/config.toml must contain core.project_name");
  assert.equal(JSON.parse(`"${tomlProjectName}"`), requestedProjectName, "_bmad/config.toml project_name");

  for (const moduleName of enabledModules) {
    const configPath = join(target, "_bmad", moduleName, "config.yaml");
    const config = YAML.parse(readFileSync(configPath, "utf8"));
    assert.equal(
      config?.project_name,
      requestedProjectName,
      `_bmad/${moduleName}/config.yaml must inherit the requested project_name, not target basename ${JSON.stringify(basename(target))}`,
    );
  }

  const manifest = YAML.parse(readFileSync(join(target, "_bmad", "_config", "manifest.yaml"), "utf8"));
  assert.equal(manifest?.installation?.version, requiredVersion, "installed manifest version must match the exact package pin");
  const installedModules = new Set((manifest?.modules ?? []).map((entry) => entry?.name));
  for (const moduleName of enabledModules) {
    assert.equal(installedModules.has(moduleName), true, `${moduleName} must be enabled in the real installer manifest`);
  }

  console.log(`Real BMAD installer project_name contract passed (${packageSpec}, core+bmm+bmb+cis)`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
