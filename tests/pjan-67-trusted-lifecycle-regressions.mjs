import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import YAML from "yaml";
import {
  BMAD_INSTALLER_FIXTURE_VERSION,
  createBmadInstallerFixture,
  createBmadPackFixture,
} from "./helpers/bmad-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const serverPath = join(root, "dist", "mcp-server.js");
const installed = spawnSync("which", ["copier"], { encoding: "utf8" });
if (installed.status !== 0 || !installed.stdout.trim()) {
  console.log("PJAN-67 trusted lifecycle integration: SKIP (Copier is not installed)");
  process.exit(0);
}
const installedPython = spawnSync("which", ["python3"], { encoding: "utf8" });
assert.equal(installedPython.status, 0, installedPython.stderr);
const realPython = realpathSync(installedPython.stdout.trim());

const temporary = mkdtempSync(join(root, ".pjan-67-trusted-lifecycle-"));
const enclosingProjectManifest = join(temporary, ".project.json");
const enclosingProjectManifestBefore = '{"project_name":"PJAN-67 enclosing sentinel","agents":{}}\n';
writeFileSync(enclosingProjectManifest, enclosingProjectManifestBefore, "utf8");
const enclosingGit = spawnSync("git", ["init", "--quiet"], { cwd: temporary, encoding: "utf8" });
assert.equal(enclosingGit.status, 0, enclosingGit.stderr);
const isolatedHome = join(temporary, "home");
const fakeBin = join(temporary, "bin");
const registryPath = join(temporary, "projects.yaml");
const providerAdapters = join(temporary, "providers");
const effectLog = join(temporary, "effects.log");
const providerLog = join(temporary, "provider.log");
const interpreterLoadLog = join(temporary, "interpreter-load.log");
const bmadInvocationLog = join(temporary, "bmad-invocations.log");
const interpreterInjectionRoot = join(temporary, "interpreter-injection");
const bashEnvSentinel = join(interpreterInjectionRoot, "bash-env.sh");
const nodeOptionsPackage = join(interpreterInjectionRoot, "pjan67-node-options");
const preloadSource = join(interpreterInjectionRoot, "preload.c");
const preloadLibrary = join(interpreterInjectionRoot, "preload.so");
const auditSource = join(interpreterInjectionRoot, "audit.c");
const auditLibrary = join(interpreterInjectionRoot, "audit.so");
const templateConfig = join(isolatedHome, ".config", "hermes-agent-template", "config.toml");
const fleetHome = join(isolatedHome, ".hermes");
const fleetEnvPath = join(fleetHome, "fleet.env");
const fakeHermes = join(fakeBin, "hermes");
const pjanglerWrapper = join(fakeBin, "pj");
const fixtureRoot = join(temporary, "fixtures");
const selectedBmadPack = createBmadPackFixture(fixtureRoot);
const selectedBmadInstaller = createBmadInstallerFixture(fixtureRoot);
const fleetAuthoritySentinel = "fleet-rehydrated-sentinel";

function executable(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

mkdirSync(interpreterInjectionRoot, { recursive: true });
mkdirSync(nodeOptionsPackage, { recursive: true });
writeFileSync(join(nodeOptionsPackage, "package.json"), '{"type":"commonjs"}\n', "utf8");
writeFileSync(
  join(nodeOptionsPackage, "index.js"),
  `require("node:fs").appendFileSync(process.env.PJAN67_INTERPRETER_LOG, "node-options-loaded\\n", "utf8");\n`,
  "utf8",
);
writeFileSync(
  join(interpreterInjectionRoot, "sitecustomize.py"),
  `from pathlib import Path\nwith Path(${JSON.stringify(interpreterLoadLog)}).open("a", encoding="utf-8") as stream:\n    stream.write("sitecustomize-loaded\\n")\n`,
  "utf8",
);
writeFileSync(
  bashEnvSentinel,
  `printf 'bash-env-loaded:%s\\n' "$0" >> "$PJAN67_INTERPRETER_LOG"\n`,
  "utf8",
);
writeFileSync(preloadSource, `
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>

__attribute__((constructor)) static void pjan67_mark_load(void) {
  const char *path = getenv("PJAN67_INTERPRETER_LOG");
  if (path == NULL || path[0] == '\\0') return;
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0) return;
  const char marker[] = "ld-preload-loaded\\n";
  (void)write(fd, marker, sizeof(marker) - 1);
  (void)close(fd);
}
`, "utf8");
const compiledPreload = spawnSync("cc", ["-shared", "-fPIC", "-o", preloadLibrary, preloadSource], {
  encoding: "utf8",
});
assert.equal(compiledPreload.status, 0, `${compiledPreload.stdout}${compiledPreload.stderr}`);
writeFileSync(auditSource, `
#define _GNU_SOURCE
#include <fcntl.h>
#include <link.h>
#include <stdlib.h>
#include <unistd.h>

unsigned int la_version(unsigned int version) {
  const char *path = getenv("PJAN67_INTERPRETER_LOG");
  if (path != NULL && path[0] != '\\0') {
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd >= 0) {
      const char marker[] = "ld-audit-loaded\\n";
      (void)write(fd, marker, sizeof(marker) - 1);
      (void)close(fd);
    }
  }
  return LAV_CURRENT;
}
`, "utf8");
const compiledAudit = spawnSync("cc", ["-shared", "-fPIC", "-o", auditLibrary, auditSource], {
  encoding: "utf8",
});
assert.equal(compiledAudit.status, 0, `${compiledAudit.stdout}${compiledAudit.stderr}`);

const injectionKeysPattern = [
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_AUDIT_64",
  "LD_ASSUME_KERNEL",
  "LD_HWCAP_MASK",
  "GLIBC_TUNABLES",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "BASH_FUNC_.*",
  "BASHOPTS",
  "SHELLOPTS",
  "BASH_COMPAT",
  "BASH_LOADABLES_PATH",
  "BASH_XTRACEFD",
  "PROMPT_COMMAND",
  "PS4",
].join("|");
const inspectChildEnvironment = `env | grep -E '^(${injectionKeysPattern})=' >> "$PJAN67_INTERPRETER_LOG" || true`;

executable(fakeHermes, `#!/bin/sh
${inspectChildEnvironment}
printf 'local-hermes:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
printf 'ld-sdk:%s\n' "\${LD_SDK_KEY:-missing}" >> "$PJAN67_EFFECT_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:hermes:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
if [ "$1" = profile ] && [ "$2" = create ]; then
  mkdir -p "$HOME/.hermes/profiles/$3"
fi
exit 0
`);

executable(pjanglerWrapper, `#!/bin/sh
${inspectChildEnvironment}
printf 'runtime-migrate:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:pjangler:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
exec "${process.execPath}" "${join(root, "dist", "index.js")}" "$@"
`);

executable(join(fakeBin, "python3"), `#!/bin/sh
${inspectChildEnvironment}
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:python3:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
exec "${realPython}" "$@"
`);

executable(join(fakeBin, "systemctl"), `#!/bin/sh
${inspectChildEnvironment}
printf 'systemctl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:systemctl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
case "$*" in
  *is-system-running*) printf '%s\n' running; exit 0 ;;
  *is-active*consumer.service*) printf '%s\n' inactive; exit 4 ;;
  *is-enabled*consumer.service*) printf '%s\n' not-found; exit 4 ;;
  *is-active*) printf '%s\n' active; exit 0 ;;
  *is-enabled*) printf '%s\n' enabled; exit 0 ;;
esac
exit 0
`);

const installedGit = spawnSync("which", ["git"], { encoding: "utf8" });
assert.equal(installedGit.status, 0, installedGit.stderr);
const realGit = realpathSync(installedGit.stdout.trim());
executable(join(fakeBin, "git"), `#!/bin/sh
${inspectChildEnvironment}
printf 'git:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
exec "${realGit}" "$@"
`);

executable(join(providerAdapters, "plane.sh"), `#!/bin/sh
${inspectChildEnvironment}
printf 'provider:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
printf 'provider:%s\n' "$*" >> "$PJAN67_PROVIDER_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:provider:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
printf '%s\n' '{"board_id":"trusted-positive-board"}'
`);
copyFileSync(join(providerAdapters, "plane.sh"), join(providerAdapters, "trello.sh"));
chmodSync(join(providerAdapters, "trello.sh"), 0o755);

executable(join(fakeBin, "curl"), `#!/bin/sh
${inspectChildEnvironment}
printf 'curl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
printf 'curl:%s\n' "$*" >> "$PJAN67_PROVIDER_LOG"
if env | grep -Fq '${fleetAuthoritySentinel}'; then
  printf 'authority-visible:curl:%s\n' "$*" >> "$PJAN67_EFFECT_LOG"
fi
case "$*" in
  *'-X GET'*) printf '%s\n' '{"results":[]}' ;;
  *'-X POST'*) printf '%s\n' '{"id":"trusted-positive-board"}' ;;
  *) printf '%s\n' '{}' ;;
esac
`);

mkdirSync(dirname(templateConfig), { recursive: true });
const bmadCache = join(isolatedHome, ".cache", "pjangler", "bmad-dist-tags.json");
mkdirSync(dirname(bmadCache), { recursive: true });
writeFileSync(bmadCache, JSON.stringify({
  fetchedAt: Date.now(),
  distTags: { next: BMAD_INSTALLER_FIXTURE_VERSION, latest: BMAD_INSTALLER_FIXTURE_VERSION },
}), "utf8");
writeFileSync(templateConfig, `[fleet]
hermes_bin = "${fakeHermes}"
hermes_repo = "${join(temporary, "hermes-agent") }"
pjangler_bin = "${pjanglerWrapper}"
hermes_git_url = "https://example.invalid/hermes.git"
hermes_git_ref = "main"
hermes_git_sha = "0000000000000000000000000000000000000000"
runtime_scaffold_dir = "${join(temporary, "runtime-scaffold") }"
fleet_env = "${join(fleetHome, "fleet.env") }"
registry_file = "${join(fleetHome, "agents-registry.yaml") }"
oauth_file = "${join(fleetHome, "auth.json") }"
codex_home = "${join(isolatedHome, ".codex") }"
canonical_skills_dir = "${join(temporary, "skills") }"
canonical_pm_config = "${join(fleetHome, "config.yaml") }"
symlinked_runtime_skills = []

[github]
runtime_repo_owner = ""

[plane]
base = "https://plane.example.invalid"
workspace = "test"
`, "utf8");
mkdirSync(fleetHome, { recursive: true });
const supportedFleetConfig = [
  `export PLANE_API_KEY=${fleetAuthoritySentinel}`,
  `export PLANE_33GOD_API_KEY=${fleetAuthoritySentinel}`,
  `export PLANE_DYNAMIC_WORKSPACE_API_KEY=${fleetAuthoritySentinel}`,
  `export TRELLO_KEY=${fleetAuthoritySentinel}`,
  `export TRELLO_TOKEN=${fleetAuthoritySentinel}`,
  `export LINEAR_API_KEY=${fleetAuthoritySentinel}`,
  "export LD_SDK_KEY=preserved-non-loader-functional-value",
  "",
].join("\n");
writeFileSync(fleetEnvPath, supportedFleetConfig, "utf8");

const serverEnv = {
  ...process.env,
  HOME: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, ".config"),
  // Provenance is anchored to the OS account, not ambient HOME. Execute the
  // actual metadata-bound UV tool while keeping all runtime/host state inside
  // the isolated HOME fixture.
  PATH: `${dirname(installed.stdout.trim())}:${fakeBin}:${process.env.PATH}`,
  HERMES_TEMPLATE_CONFIG: templateConfig,
  HERMES_FLEET_HOME: fleetHome,
  HERMES_FLEET_ENV: fleetEnvPath,
  HERMES_FLEET_REGISTRY_FILE: join(fleetHome, "agents-registry.yaml"),
  HERMES_BIN: fakeHermes,
  HERMES_AGENT_REPO: join(temporary, "hermes-agent"),
  PJANGLER_BIN: pjanglerWrapper,
  PJ_PROJECT_REGISTRY: registryPath,
  PJ_BMAD_PACK_ROOT: selectedBmadPack,
  PJ_BMAD_INSTALLER: selectedBmadInstaller,
  PJ_BMAD_FIXTURE_INVOCATION_LOG: bmadInvocationLog,
  PJ_TICKET_PROVIDER_ADAPTERS: providerAdapters,
  PLANE_API_KEY: "trusted-positive-test-key",
  TRELLO_KEY: "trusted-positive-test-key",
  TRELLO_TOKEN: "trusted-positive-test-token",
  // These remain dormant in the Node MCP server and execute only if a
  // controlled Copier/template/host/external child inherits them.
  PYTHONPATH: interpreterInjectionRoot,
  PYTHONHOME: interpreterInjectionRoot,
  PYTHONSTARTUP: join(interpreterInjectionRoot, "sitecustomize.py"),
  PYTHONUSERBASE: interpreterInjectionRoot,
  BASH_ENV: bashEnvSentinel,
  ENV: bashEnvSentinel,
  NODE_OPTIONS: "--require=pjan67-node-options",
  NODE_PATH: interpreterInjectionRoot,
  LD_PRELOAD: preloadLibrary,
  LD_LIBRARY_PATH: interpreterInjectionRoot,
  LD_AUDIT: auditLibrary,
  LD_AUDIT_64: auditLibrary,
  LD_ASSUME_KERNEL: "2.6.32",
  LD_HWCAP_MASK: "0",
  GLIBC_TUNABLES: "glibc.cpu.hwcaps=-AVX2",
  DYLD_INSERT_LIBRARIES: preloadLibrary,
  DYLD_LIBRARY_PATH: interpreterInjectionRoot,
  "BASH_FUNC_python3%%": "() { printf 'bash-function-loaded\\n' >> \"$PJAN67_INTERPRETER_LOG\"; command python3 \"$@\"; }",
  BASHOPTS: "extdebug:sourcepath",
  SHELLOPTS: "braceexpand:hashall:interactive-comments:xtrace",
  BASH_COMPAT: "50",
  BASH_LOADABLES_PATH: interpreterInjectionRoot,
  BASH_XTRACEFD: "2",
  PROMPT_COMMAND: "printf prompt-control-loaded",
  PS4: "$(printf 'bash-trace-loaded\\n' >> \"$PJAN67_INTERPRETER_LOG\")",
  LD_SDK_KEY: "preserved-non-loader-functional-value",
  PJAN67_EFFECT_LOG: effectLog,
  PJAN67_PROVIDER_LOG: providerLog,
  PJAN67_INTERPRETER_LOG: interpreterLoadLog,
};

function assertEnclosingProjectUntouched(label) {
  assert.equal(
    readFileSync(enclosingProjectManifest, "utf8"),
    enclosingProjectManifestBefore,
    `${label}: provisioning must not climb into an enclosing checkout manifest`,
  );
}

function assertNoUngrantAuthority(label) {
  const effects = existsSync(effectLog) ? readFileSync(effectLog, "utf8") : "";
  assert.doesNotMatch(effects, /authority-visible:/, `${label}: FLEET_ENV provider authority must not reach any child`);
  assert.equal(existsSync(providerLog), false, `${label}: no-board grant must invoke no provider`);
}

function assertNoInterpreterInjection(label) {
  const loads = existsSync(interpreterLoadLog) ? readFileSync(interpreterLoadLog, "utf8") : "";
  assert.equal(loads, "", `${label}: MCP-controlled child loaded ambient interpreter code: ${loads}`);
}

function readOptional(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function assertFilesUnchanged(snapshot, label) {
  for (const [path, before] of snapshot) {
    assert.deepEqual(readOptional(path), before, `${label}: unexpected mutation at ${path}`);
  }
}

function decodeNulEnvironment(stdout) {
  return new Map(
    stdout
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry.includes("="))
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

function renderedImporterEnvironment(fleetPath) {
  return {
    HOME: isolatedHome,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HERMES_FLEET_ENV: fleetPath,
    HERMES_TEMPLATE_CONFIG: join(temporary, "missing-template-config.toml"),
    SKIP_PLANE: "1",
    LANG: "C.UTF-8",
  };
}

function payload(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string", JSON.stringify(result));
  return JSON.parse(text);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: serverEnv,
});
const client = new Client({ name: "pjan-67-trusted-positive", version: "1.0.0" });

try {
  await client.connect(transport);

  // The rendered fleet parser is executable lifecycle policy, not an optional
  // template asset. Its vendored attestation must fail before Copier can write
  // the target or any provider/host child can observe the request.
  const vendoredFleetParser = join(
    root,
    "templates",
    "hermes-agent",
    "template",
    ".scripts",
    "lib",
    "parse-fleet-env.py",
  );
  const heldFleetParser = join(temporary, "held-parse-fleet-env.py");
  const missingParserTarget = join(temporary, "missing-parser-mcp-target");
  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const missingParserHostSnapshot = new Map([
    [templateConfig, readOptional(templateConfig)],
    [registryPath, readOptional(registryPath)],
    [join(fleetHome, "agents-registry.yaml"), readOptional(join(fleetHome, "agents-registry.yaml"))],
    [fleetEnvPath, readOptional(fleetEnvPath)],
  ]);
  renameSync(vendoredFleetParser, heldFleetParser);
  let missingParserResult;
  try {
    missingParserResult = await client.callTool({
      name: "pjangler_project_init",
      arguments: {
        name: "Missing Parser MCP Target",
        targetDir: missingParserTarget,
        slug: "missing-parser-mcp-target",
        provisionAgent: true,
        agentRole: "pm",
        apply: true,
        live: false,
        skipPlane: true,
      },
    });
  } finally {
    renameSync(heldFleetParser, vendoredFleetParser);
  }
  const missingParserPayload = payload(missingParserResult);
  assert.equal(missingParserResult.isError, true, JSON.stringify(missingParserPayload));
  assert.match(JSON.stringify(missingParserPayload), /parse-fleet-env\.py/);
  assert.equal(existsSync(missingParserTarget), false, "missing parser rejection must precede target creation");
  assert.equal(existsSync(effectLog), false, "missing parser rejection must precede Hermes/systemd/provider children");
  assert.equal(existsSync(providerLog), false, "missing parser rejection must precede provider effects");
  assert.equal(existsSync(interpreterLoadLog), false, "missing parser rejection must precede controlled child startup");
  assertFilesUnchanged(missingParserHostSnapshot, "missing vendored parser MCP rejection");
  assertEnclosingProjectUntouched("missing vendored parser MCP rejection");

  const vendoredFleetLoader = join(
    root,
    "templates",
    "hermes-agent",
    "template",
    ".scripts",
    "lib",
    "fleet-env.sh",
  );
  const heldFleetLoader = join(temporary, "held-fleet-env.sh");
  const missingLoaderTarget = join(temporary, "missing-loader-mcp-target");
  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const missingLoaderHostSnapshot = new Map([
    [templateConfig, readOptional(templateConfig)],
    [registryPath, readOptional(registryPath)],
    [join(fleetHome, "agents-registry.yaml"), readOptional(join(fleetHome, "agents-registry.yaml"))],
    [fleetEnvPath, readOptional(fleetEnvPath)],
  ]);
  renameSync(vendoredFleetLoader, heldFleetLoader);
  let missingLoaderResult;
  try {
    missingLoaderResult = await client.callTool({
      name: "pjangler_project_init",
      arguments: {
        name: "Missing Loader MCP Target",
        targetDir: missingLoaderTarget,
        slug: "missing-loader-mcp-target",
        provisionAgent: true,
        agentRole: "pm",
        apply: true,
        live: false,
        skipPlane: true,
      },
    });
  } finally {
    renameSync(heldFleetLoader, vendoredFleetLoader);
  }
  const missingLoaderPayload = payload(missingLoaderResult);
  assert.equal(missingLoaderResult.isError, true, JSON.stringify(missingLoaderPayload));
  assert.match(JSON.stringify(missingLoaderPayload), /fleet-env\.sh/);
  assert.equal(existsSync(missingLoaderTarget), false, "missing loader rejection must precede target creation");
  assert.equal(existsSync(effectLog), false, "missing loader rejection must precede Hermes/systemd/provider children");
  assert.equal(existsSync(providerLog), false, "missing loader rejection must precede provider effects");
  assert.equal(existsSync(interpreterLoadLog), false, "missing loader rejection must precede controlled child startup");
  assertFilesUnchanged(missingLoaderHostSnapshot, "missing vendored loader MCP rejection");
  assertEnclosingProjectUntouched("missing vendored loader MCP rejection");

  const target = join(temporary, "trusted-project");
  rmSync(interpreterLoadLog, { force: true });
  rmSync(bmadInvocationLog, { force: true });
  const createdResult = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      targetDir: target,
      projectName: "trusted-project",
      projectSlug: "trusted-project",
      dryRun: false,
      skipPlane: true,
    },
  });
  const created = payload(createdResult);
  assert.notEqual(createdResult.isError, true, JSON.stringify(created));
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  assert.equal(created.audit?.ok, true, JSON.stringify(created.audit?.rules?.filter((rule) => !["pass", "skip"].includes(rule.status))));
  assert.equal(existsSync(join(target, ".project.json")), true);
  const bmadInvocations = readFileSync(bmadInvocationLog, "utf8");
  assert.match(bmadInvocations, /^--version$/m, "project preflight must probe the pinned BMAD fixture");
  assert.match(bmadInvocations, /^install /m, "project lifecycle must run the pinned BMAD installer");
  assertNoInterpreterInjection("trusted project create");
  assertEnclosingProjectUntouched("trusted project create");

  const copierAnswersBefore = readFileSync(join(target, ".copier-answers.yml"), "utf8");
  rmSync(join(target, ".project.json"));
  rmSync(interpreterLoadLog, { force: true });
  const syncedResult = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "trusted-project",
      targetDir: target,
      slug: "trusted-project",
      apply: true,
      skipPlane: true,
    },
  });
  const synced = payload(syncedResult);
  assert.notEqual(syncedResult.isError, true, JSON.stringify(synced));
  assert.equal(synced.ok, true, JSON.stringify(synced.errors));
  assert.equal(synced.mode, "sync");
  assert.equal(readFileSync(join(target, ".copier-answers.yml"), "utf8"), copierAnswersBefore, "existing sync must not rerun Copier");
  assertNoInterpreterInjection("trusted project sync");
  assertEnclosingProjectUntouched("trusted project sync");

  // Every MCP entry point that can reach Hermes must keep the no-board grant
  // authoritative even after the real rendered _lib.sh sources fleet.env.
  // Child wrappers observe the entire environment without relying on source
  // text assertions, and the fleet sentinel is deliberately absent from the
  // parent MCP process environment.
  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const dedicatedNoBoardResult = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: {
      targetDir: target,
      targetRepo: "trusted-project",
      role: "authority-dedicated",
      apply: true,
      local: true,
      live: false,
      skipPlane: true,
    },
  });
  const dedicatedNoBoard = payload(dedicatedNoBoardResult);
  assert.equal(typeof dedicatedNoBoard.success, "boolean", JSON.stringify(dedicatedNoBoard));
  assertNoUngrantAuthority("dedicated Hermes no-board path");
  assertNoInterpreterInjection("dedicated Hermes no-board path");
  assertEnclosingProjectUntouched("dedicated Hermes no-board path");

  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const projectInitNoBoardTarget = join(temporary, "authority-project-init");
  const projectInitNoBoardResult = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Authority Project Init",
      targetDir: projectInitNoBoardTarget,
      slug: "authority-project-init",
      provisionAgent: true,
      agentRole: "authority-project-init",
      apply: true,
      live: false,
      skipPlane: true,
    },
  });
  const projectInitNoBoard = payload(projectInitNoBoardResult);
  assert.equal(typeof projectInitNoBoard.ok, "boolean", JSON.stringify(projectInitNoBoard));
  assertNoUngrantAuthority("project-init no-board path");
  assertNoInterpreterInjection("project-init no-board path");
  assertEnclosingProjectUntouched("project-init no-board path");

  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const bootstrapNoBoardTarget = join(temporary, "authority-bootstrap");
  const bootstrapNoBoardResult = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      targetDir: bootstrapNoBoardTarget,
      projectName: "Authority Bootstrap",
      projectSlug: "authority-bootstrap",
      provisionAgent: true,
      agentRole: "authority-bootstrap",
      dryRun: false,
      local: true,
      live: false,
      skipPlane: true,
    },
  });
  const bootstrapNoBoard = payload(bootstrapNoBoardResult);
  assert.equal(typeof bootstrapNoBoard.ok, "boolean", JSON.stringify(bootstrapNoBoard));
  assertNoUngrantAuthority("bootstrap no-board path");
  assertNoInterpreterInjection("bootstrap no-board path");
  assertEnclosingProjectUntouched("bootstrap no-board path");

  // A readable empty fleet registry makes registry parity repairable, allowing
  // the selected non-board external tail itself (rather than an earlier
  // lifecycle blocker) to be exercised.
  writeFileSync(join(fleetHome, "agents-registry.yaml"), "agents: {}\n", "utf8");
  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const dedicatedNoBoardExternalResult = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: {
      targetDir: target,
      targetRepo: "trusted-project",
      role: "authority-external",
      apply: true,
      local: false,
      live: true,
      provisionRuntimeRepo: true,
      enableSystemd: true,
      skipPlane: true,
    },
  });
  const dedicatedNoBoardExternal = payload(dedicatedNoBoardExternalResult);
  assert.notEqual(dedicatedNoBoardExternalResult.isError, true, JSON.stringify(dedicatedNoBoardExternal));
  assert.equal(dedicatedNoBoardExternal.success, true, JSON.stringify(dedicatedNoBoardExternal));
  const noBoardExternalEffects = readFileSync(effectLog, "utf8");
  assert.match(noBoardExternalEffects, /runtime-migrate:/, "non-board runtime grant must reach its selected child");
  assert.match(noBoardExternalEffects, /systemctl:--user enable --now/, "non-board systemd grant must reach its selected child");
  assertNoUngrantAuthority("dedicated Hermes selected non-board external path");
  assertNoInterpreterInjection("dedicated Hermes selected non-board external path");
  assertEnclosingProjectUntouched("dedicated Hermes selected non-board external path");

  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const deployedResult = await client.callTool({
    name: "pjangler_deploy_hermes_agent",
    arguments: {
      targetDir: target,
      targetRepo: "trusted-project",
      role: "director",
      apply: true,
      local: false,
      live: true,
      provisionRuntimeRepo: true,
      provisionTicketBoard: true,
      enableSystemd: true,
      ticketProvider: "plane",
    },
  });
  const deployed = payload(deployedResult);
  assert.notEqual(deployedResult.isError, true, JSON.stringify(deployed));
  assert.equal(deployed.success, true, JSON.stringify(deployed.errors));
  const effectText = readFileSync(effectLog, "utf8");
  assert.equal((readFileSync(providerLog, "utf8").match(/-X POST/g) ?? []).length, 1, "the granted board provider must create exactly once");
  assert.match(effectText, /runtime-migrate:/, "the granted runtime phase must execute");
  assert.match(effectText, /systemctl:--user enable --now/, "the granted systemd phase must execute");
  assert.match(effectText, /ld-sdk:preserved-non-loader-functional-value/, "non-loader LD_* overrides must reach intended children");
  const deferredSummary = deployed.logs.find((line) => line.includes("Applied deferred Hermes external effects")) ?? "";
  for (const script of ["20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    assert.equal((deferredSummary.match(new RegExp(script.replace(".", "\\."), "g")) ?? []).length, 1, `${script} must be dispatched exactly once`);
  }
  assert.ok(effectText.indexOf("local-hermes:") < effectText.indexOf("curl:-fsS"), "local rendering must precede the deferred provider effect");
  const deployedRole = YAML.parse(readFileSync(join(target, "agents", "hermes", "director", "role.yaml"), "utf8"));
  assert.equal(deployedRole.deployment.local_only, false, "successful live deployment must clear temporary local-only metadata");
  assert.equal(deployedRole.deployment.systemd, "required", "successful systemd grant must persist required deployment metadata");
  assertNoInterpreterInjection("trusted dedicated Hermes deploy");
  assertEnclosingProjectUntouched("trusted dedicated Hermes deploy");

  rmSync(effectLog, { force: true });
  rmSync(providerLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const projectTailTarget = join(temporary, "trusted-project-tail");
  const projectTailResult = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      targetDir: projectTailTarget,
      projectName: "trusted-project-tail",
      projectSlug: "trusted-project-tail",
      projectIdentifier: "TAIL",
      dryRun: false,
      provisionAgent: true,
      agentRole: "director",
      local: false,
      live: true,
      provisionRuntimeRepo: true,
      provisionTicketBoard: true,
      enableSystemd: true,
      skipPlane: false,
      ticketProvider: "trello",
    },
  });
  const projectTail = payload(projectTailResult);
  assert.notEqual(projectTailResult.isError, true, JSON.stringify(projectTail));
  assert.equal(projectTail.ok, true, JSON.stringify(projectTail.errors));
  const phaseIds = projectTail.phases.map((phase) => phase.id);
  const eligibilityIndex = phaseIds.indexOf("project.audit:eligibility");
  const gitIndex = phaseIds.indexOf("project.git");
  const providerIndex = phaseIds.indexOf("project.external:ticket-provider");
  const hermesIndex = phaseIds.indexOf("project.external:hermes");
  const postconditionIndex = phaseIds.indexOf("project.audit");
  assert.ok(
    eligibilityIndex >= 0 && eligibilityIndex < gitIndex && gitIndex < providerIndex,
    "project eligibility and ordinary local Git work must complete before the provider tail",
  );
  assert.ok(providerIndex < hermesIndex && hermesIndex < postconditionIndex, "project external phases must precede only the read-only postcondition audit");
  assert.equal((readFileSync(providerLog, "utf8").match(/create_board/g) ?? []).length, 1, "project-owned board grant must invoke its adapter exactly once");
  const projectDeferredSummary = projectTail.logs.find((line) => line.includes("Applied deferred Hermes external effects")) ?? "";
  for (const script of ["20-runtime-repo.sh", "42-ticket-provider.sh", "70-systemd.sh", "80-registry.sh"]) {
    assert.equal((projectDeferredSummary.match(new RegExp(script.replace(".", "\\."), "g")) ?? []).length, 1, `project owner must dispatch ${script} exactly once`);
  }
  const projectRole = YAML.parse(readFileSync(join(projectTailTarget, "agents", "hermes", "director", "role.yaml"), "utf8"));
  assert.equal(projectRole.deployment.local_only, false);
  assert.equal(projectRole.deployment.systemd, "required");
  assertNoInterpreterInjection("trusted project-owned Hermes deploy");
  assertEnclosingProjectUntouched("trusted project-owned Hermes deploy");

  // The generic parity surfaces are MCP-reachable independently of project
  // initialization. Exercise the direct audit/migrate/describe paths against
  // a rendered Hermes project so Git and systemd children cannot regress
  // behind the project/Hermes command wrappers already covered above.
  rmSync(effectLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const auditResult = await client.callTool({
    name: "pjangler_audit_project",
    arguments: { targetDir: projectTailTarget, json: true },
  });
  const audit = payload(auditResult);
  assert.notEqual(auditResult.isError, true, JSON.stringify(audit));
  const auditEffects = readFileSync(effectLog, "utf8");
  assert.match(auditEffects, /git:ls-files --stage/, "audit must exercise the Hermes Git-index child");
  assert.match(auditEffects, /systemctl:--user is-system-running/, "audit must exercise the systemd postcondition query");
  assertNoInterpreterInjection("direct MCP audit path");

  rmSync(effectLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const migrateResult = await client.callTool({
    name: "pjangler_migrate_project",
    arguments: {
      targetDir: projectTailTarget,
      ruleId: "hermes.untracked-runtimes",
      dryRun: false,
    },
  });
  const migration = payload(migrateResult);
  assert.notEqual(migrateResult.isError, true, JSON.stringify(migration));
  assert.equal(migration.ok, true, JSON.stringify(migration));
  assert.match(readFileSync(effectLog, "utf8"), /git:ls-files --stage/, "migration must exercise the Hermes Git-index child");
  assertNoInterpreterInjection("direct MCP migration path");

  rmSync(effectLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const describeResult = await client.callTool({
    name: "pjangler_describe_project",
    arguments: { targetDir: projectTailTarget, registryPath, json: true },
  });
  const description = payload(describeResult);
  assert.notEqual(describeResult.isError, true, JSON.stringify(description));
  const describeEffects = readFileSync(effectLog, "utf8");
  assert.match(describeEffects, /git:/, "describe must exercise its activity/parity Git children");
  assert.match(describeEffects, /systemctl:--user is-system-running/, "describe must exercise nested lifecycle systemd queries");
  assertNoInterpreterInjection("direct MCP describe path");

  // Generic recipe execution is a separate MCP dispatch path. Its current
  // public catalog is filesystem-only; the source gate ensures any future
  // child added beneath it must use the same boundary.
  const genericTarget = join(temporary, "generic-mise-recipe");
  mkdirSync(genericTarget, { recursive: true });
  rmSync(interpreterLoadLog, { force: true });
  const genericResult = await client.callTool({
    name: "pjangler_run_recipe",
    arguments: { recipe: "mise", targetDir: genericTarget, apply: true },
  });
  const generic = payload(genericResult);
  assert.notEqual(genericResult.isError, true, JSON.stringify(generic));
  assert.equal(generic.success, true, JSON.stringify(generic.errors));
  assert.equal(existsSync(join(genericTarget, "mise.toml")), true, "generic recipe apply must remain functional");
  assertNoInterpreterInjection("generic MCP recipe path");

  // The direct migration tool reaches the absolute Node BMAD installer
  // without project-init's lifecycle wrapper. This is the install twin of the
  // --version probe asserted during trusted project creation above.
  rmSync(bmadInvocationLog, { force: true });
  rmSync(interpreterLoadLog, { force: true });
  const bmadMigrationResult = await client.callTool({
    name: "pjangler_migrate_project",
    arguments: { targetDir: genericTarget, ruleId: "bmad.scaffold", dryRun: false },
  });
  const bmadMigration = payload(bmadMigrationResult);
  assert.notEqual(bmadMigrationResult.isError, true, JSON.stringify(bmadMigration));
  assert.equal(bmadMigration.ok, true, JSON.stringify(bmadMigration));
  assert.match(readFileSync(bmadInvocationLog, "utf8"), /^install /m, "direct BMAD migration must invoke the installer");
  assertNoInterpreterInjection("direct BMAD install migration path");

  // Exercise the importer from Copier's real rendered output, not a source
  // text assertion or a stubbed template. A fleet file is data: shell
  // functions (including a readonly function named `builtin`) are rejected
  // without execution, and a complete raw frame is staged before any record
  // may reach the provisioning shell.
  const renderedRole = join(target, "agents", "hermes", "director");
  const renderedLibrary = join(renderedRole, ".scripts", "_lib.sh");
  const renderedParser = join(renderedRole, ".scripts", "lib", "parse-fleet-env.py");
  assert.equal(existsSync(renderedLibrary), true, "trusted Copier must render the fleet library");
  assert.equal(existsSync(renderedParser), true, "trusted Copier must render the isolated fleet parser");

  const mutationSentinelPaths = [
    join(target, ".project.json"),
    join(renderedRole, "role.yaml"),
    join(renderedRole, ".scripts", ".provision.log"),
    registryPath,
    join(fleetHome, "agents-registry.yaml"),
    fleetEnvPath,
    templateConfig,
    effectLog,
    providerLog,
  ];
  const mutationSnapshot = new Map(
    mutationSentinelPaths.map((path) => [path, readOptional(path)]),
  );
  const renderedFleetBefore = readFileSync(fleetEnvPath);
  const builtinHijackMarker = join(temporary, "fleet-builtin-hijack.log");
  const maliciousFleet = [
    "export PJAN67_ATOMIC_FIRST=must-not-escape",
    "builtin() {",
    `  command printf 'builtin-hijack-executed\\n' >> ${JSON.stringify(builtinHijackMarker)}`,
    "  return 0",
    "}",
    "export -f builtin",
    "readonly -f builtin",
    "",
  ].join("\n");
  writeFileSync(fleetEnvPath, maliciousFleet, "utf8");
  const builtinHijack = spawnSync(
    "bash",
    [
      "-c",
      'if source "$1"; then status=0; else status=$?; fi; set +e; env -0; exit "$status"',
      "pjan67-rendered-builtin-hijack",
      renderedLibrary,
    ],
    { env: renderedImporterEnvironment(fleetEnvPath) },
  );
  writeFileSync(fleetEnvPath, renderedFleetBefore);
  assert.notEqual(builtinHijack.status, 0, "readonly builtin function fleet input must fail closed");
  assert.match(builtinHijack.stderr.toString("utf8"), /fleet environment import failed/);
  assert.equal(decodeNulEnvironment(builtinHijack.stdout).has("PJAN67_ATOMIC_FIRST"), false);
  assert.equal(existsSync(builtinHijackMarker), false, "fleet input must never execute as shell code");
  assertFilesUnchanged(mutationSnapshot, "rendered readonly-builtin rejection");

  const missingFleet = join(temporary, "missing-rendered-fleet.env");
  const rawFrameCases = new Map([
    [
      "malformed",
      Buffer.from("PJANGLER_FLEET_ENV_V1\0PJAN67_ATOMIC_FIRST=leaked\0MALFORMED\0PJANGLER_FLEET_ENV_END\0\0"),
    ],
    [
      "duplicate",
      Buffer.from("PJANGLER_FLEET_ENV_V1\0PJAN67_ATOMIC_FIRST=one\0PJAN67_ATOMIC_FIRST=two\0PJANGLER_FLEET_ENV_END\0\0"),
    ],
    ["truncated", Buffer.from("PJANGLER_FLEET_ENV_V1\0PJAN67_ATOMIC_FIRST=leaked\0")],
    [
      "unterminated",
      Buffer.from("PJANGLER_FLEET_ENV_V1\0PJAN67_ATOMIC_FIRST=leaked\0PJANGLER_FLEET_ENV_END\0"),
    ],
  ]);
  for (const [caseName, payloadBytes] of rawFrameCases) {
    const streamPath = join(temporary, `rendered-${caseName}.frames`);
    writeFileSync(streamPath, payloadBytes);
    const frameResult = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; exec {fleet_fd}< <(/usr/bin/cat "$2"); fleet_pid=$!; '
          + 'if import_fleet_environment_stream "$fleet_fd" "$fleet_pid"; then status=0; else status=$?; fi; '
          + 'set +e; env -0; exit "$status"',
        `pjan67-rendered-${caseName}`,
        renderedLibrary,
        streamPath,
      ],
      { env: renderedImporterEnvironment(missingFleet) },
    );
    assert.notEqual(frameResult.status, 0, `${caseName} frame must fail closed`);
    assert.match(frameResult.stderr.toString("utf8"), /fleet environment frame rejected/);
    assert.equal(
      decodeNulEnvironment(frameResult.stdout).has("PJAN67_ATOMIC_FIRST"),
      false,
      `${caseName} frame partially mutated the provisioning shell`,
    );
    assertFilesUnchanged(mutationSnapshot, `rendered ${caseName} frame rejection`);
  }

  console.log("PJAN-67 trusted Copier/MCP child-boundary regressions: PASS");
} finally {
  await client.close().catch(() => undefined);
  rmSync(temporary, { recursive: true, force: true });
}
