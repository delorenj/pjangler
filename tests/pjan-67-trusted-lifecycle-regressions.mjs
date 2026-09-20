import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  BMAD_INSTALLER_FIXTURE_VERSION,
  createBmadInstallerFixture,
  createSkillPackFixture,
  createSkillexMiseFixture,
} from "./helpers/pack-fixture.mjs";
import {
  materializeCommittedSubmodule,
  readGitCommitFile,
} from "./helpers/committed-submodule.mjs";

const root = resolve(import.meta.dirname, "..");
const installed = spawnSync("which", ["copier"], { encoding: "utf8" });
if (installed.status !== 0 || !installed.stdout.trim()) {
  console.log("PJAN-67 trusted lifecycle integration: SKIP (Copier is not installed)");
  process.exit(0);
}

const temporary = mkdtempSync(join(root, ".pjan-67-trusted-lifecycle-"));
const skillState = mkdtempSync("/tmp/pjan-67-state-");
process.on("exit", () => rmSync(skillState, { recursive: true, force: true }));
const skillMise = createSkillexMiseFixture(temporary);
const fixturePjanglerRoot = join(temporary, "committed-parent-fixture");
mkdirSync(join(fixturePjanglerRoot, "dist"), { recursive: true });
copyFileSync(join(root, "package.json"), join(fixturePjanglerRoot, "package.json"));
copyFileSync(join(root, "dist", "index.js"), join(fixturePjanglerRoot, "dist", "index.js"));
copyFileSync(join(root, "dist", "mcp-server.js"), join(fixturePjanglerRoot, "dist", "mcp-server.js"));
const fixtureVersioning = join(fixturePjanglerRoot, ".mise", "scripts", "versioning.sh");
mkdirSync(dirname(fixtureVersioning), { recursive: true });
writeFileSync(fixtureVersioning, readGitCommitFile(root, "HEAD", ".mise/scripts/versioning.sh"), "utf8");
chmodSync(fixtureVersioning, 0o755);
materializeCommittedSubmodule(
  root,
  "templates/commonproject",
  join(fixturePjanglerRoot, "templates", "commonproject"),
);

const serverPath = join(fixturePjanglerRoot, "dist", "mcp-server.js");
const enclosingProjectManifest = join(temporary, ".project.json");
const enclosingProjectManifestBefore = '{"project_name":"PJAN-67 enclosing sentinel","agents":{}}\n';
writeFileSync(enclosingProjectManifest, enclosingProjectManifestBefore, "utf8");
const enclosingGit = spawnSync("git", ["init", "--quiet"], { cwd: temporary, encoding: "utf8" });
assert.equal(enclosingGit.status, 0, enclosingGit.stderr);
const isolatedHome = join(temporary, "home");
const fakeBin = join(temporary, "bin");
const registryPath = join(temporary, "projects.yaml");
const providerAdapters = join(temporary, "providers");
const providerLog = join(temporary, "provider.log");
const templateConfig = join(isolatedHome, ".config", "hermes-agent-template", "config.toml");
const fixtureRoot = join(temporary, "fixtures");
const selectedBmadPack = createSkillPackFixture(fixtureRoot);
const selectedBmadInstaller = createBmadInstallerFixture(fixtureRoot);

function executable(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

executable(join(providerAdapters, "plane.sh"), `#!/bin/sh
printf 'provider:%s\n' "$*" >> "$PJAN67_PROVIDER_LOG"
printf '%s\n' '{"board_id":"trusted-positive-board","identifier":"TRUST"}'
`);
copyFileSync(join(providerAdapters, "plane.sh"), join(providerAdapters, "trello.sh"));
chmodSync(join(providerAdapters, "trello.sh"), 0o755);

executable(join(fakeBin, "curl"), `#!/bin/sh
printf 'curl:%s\n' "$*" >> "$PJAN67_PROVIDER_LOG"
# plane.sh calls: curl -sS -o <body> -D <headers> -w '%{http_code}' -X <M> <url>
# and captures stdout as the status. Honour -o/-D/-w, or the JSON body lands on
# stdout where the status belongs and the caller reports "invalid HTTP status".
out=""; hdr=""; wfmt=""; prev=""
for a in "$@"; do
  case "$prev" in
    -o) out="$a" ;;
    -D) hdr="$a" ;;
    -w) wfmt="$a" ;;
  esac
  prev="$a"
done
case "$*" in
  *'-X GET'*projects/trusted-positive-board/*)
    payload='{"id":"trusted-positive-board","identifier":"TRUST"}' ;;
  *'-X GET'*) payload='{"results":[]}' ;;
  *'-X POST'*) payload='{"id":"trusted-positive-board","identifier":"TRUST"}' ;;
  *) payload='{}' ;;
esac
if [ -n "$hdr" ]; then printf 'HTTP/1.1 200\r\n\r\n' > "$hdr"; fi
if [ -n "$out" ]; then printf '%s\n' "$payload" > "$out"; else printf '%s\n' "$payload"; fi
if [ -n "$wfmt" ]; then printf '%s' "$wfmt" | sed 's/%{http_code}/200/'; fi
exit 0
`);

mkdirSync(dirname(templateConfig), { recursive: true });
const bmadCache = join(isolatedHome, ".cache", "pjangler", "bmad-dist-tags.json");
mkdirSync(dirname(bmadCache), { recursive: true });
writeFileSync(bmadCache, JSON.stringify({
  fetchedAt: Date.now(),
  distTags: { next: BMAD_INSTALLER_FIXTURE_VERSION, latest: BMAD_INSTALLER_FIXTURE_VERSION },
}), "utf8");
// `src/project/boardUrl.ts` still resolves the Plane instance and workspace
// through this file. Without a fixture copy the run falls back to the real
// DEFAULT_PLANE_BASE, so an unexpected board URL would name a live host.
writeFileSync(templateConfig, `[plane]
base = "https://plane.example.invalid"
workspace = "test"
`, "utf8");

const serverEnv = {
  ...process.env,
  HOME: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, ".config"),
  // Provenance is anchored to the OS account, not ambient HOME. Execute the
  // actual metadata-bound UV tool while keeping all runtime/host state inside
  // the isolated HOME fixture.
  PATH: `${skillMise}:${dirname(installed.stdout.trim())}:${fakeBin}:${process.env.PATH}`,
  XDG_STATE_HOME: skillState,
  SKILLEX_REGISTRY_ROOT: fixtureRoot,
  PJ_SKILLS_REGISTRY_ROOT: fixtureRoot,
  HERMES_TEMPLATE_CONFIG: templateConfig,
  PJ_PROJECT_REGISTRY: registryPath,
  PJ_PACK_ROOT_PJTEST: selectedBmadPack,
  PJ_BMAD_INSTALLER: selectedBmadInstaller,
  PJ_TICKET_PROVIDER_ADAPTERS: providerAdapters,
  PLANE_API_KEY: "trusted-positive-test-key",
  TRELLO_KEY: "trusted-positive-test-key",
  TRELLO_TOKEN: "trusted-positive-test-token",
  PJAN67_PROVIDER_LOG: providerLog,
};

function assertEnclosingProjectUntouched(label) {
  assert.equal(
    readFileSync(enclosingProjectManifest, "utf8"),
    enclosingProjectManifestBefore,
    `${label}: provisioning must not climb into an enclosing checkout manifest`,
  );
}

function assertNoUngrantedProvider(label) {
  assert.equal(existsSync(providerLog), false, `${label}: no-board grant must invoke no provider`);
}

function payload(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string", JSON.stringify(result));
  return JSON.parse(text);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: fixturePjanglerRoot,
  env: serverEnv,
});
const client = new Client({ name: "pjan-67-trusted-positive", version: "1.0.0" });

try {
  await client.connect(transport);
  const target = join(temporary, "trusted-project");
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
  assertEnclosingProjectUntouched("trusted project create");

  const copierAnswersBefore = readFileSync(join(target, ".copier-answers.yml"), "utf8");
  rmSync(join(target, ".project.json"));
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
  assertEnclosingProjectUntouched("trusted project sync");

  rmSync(providerLog, { force: true });
  const projectInitNoBoardTarget = join(temporary, "authority-project-init");
  const projectInitNoBoardResult = await client.callTool({
    name: "pjangler_project_init",
    arguments: {
      name: "Authority Project Init",
      targetDir: projectInitNoBoardTarget,
      slug: "authority-project-init",
      // Both no-board fixtures slugify to the same proposed identifier, so pin
      // them apart rather than have the second collide in the registry.
      identifier: "APIN",
      apply: true,
      live: false,
      skipPlane: true,
    },
  });
  const projectInitNoBoard = payload(projectInitNoBoardResult);
  assert.equal(typeof projectInitNoBoard.ok, "boolean", JSON.stringify(projectInitNoBoard));
  assertNoUngrantedProvider("project-init no-board path");
  assertEnclosingProjectUntouched("project-init no-board path");

  rmSync(providerLog, { force: true });
  const bootstrapNoBoardTarget = join(temporary, "authority-bootstrap");
  const bootstrapNoBoardResult = await client.callTool({
    name: "pjangler_bootstrap_33god_project",
    arguments: {
      parentDir: temporary,
      targetDir: bootstrapNoBoardTarget,
      projectName: "Authority Bootstrap",
      projectSlug: "authority-bootstrap",
      projectIdentifier: "ABOO",
      dryRun: false,
      local: true,
      live: false,
      skipPlane: true,
    },
  });
  const bootstrapNoBoard = payload(bootstrapNoBoardResult);
  assert.equal(typeof bootstrapNoBoard.ok, "boolean", JSON.stringify(bootstrapNoBoard));
  assertNoUngrantedProvider("bootstrap no-board path");
  assertEnclosingProjectUntouched("bootstrap no-board path");

  rmSync(providerLog, { force: true });
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
      local: false,
      live: true,
      provisionTicketBoard: true,
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
  const postconditionIndex = phaseIds.indexOf("project.audit");
  assert.ok(
    eligibilityIndex >= 0 && eligibilityIndex < gitIndex && gitIndex < providerIndex,
    "project eligibility and ordinary local Git work must complete before the provider tail",
  );
  assert.ok(providerIndex < postconditionIndex, "project external phases must precede only the read-only postcondition audit");
  assert.equal((readFileSync(providerLog, "utf8").match(/create_board/g) ?? []).length, 1, "project-owned board grant must invoke its adapter exactly once");
  assertEnclosingProjectUntouched("trusted project-owned board deploy");

  console.log("PJAN-67 trusted Copier create/sync/deferred-external regressions: PASS");
} finally {
  await client.close().catch(() => undefined);
  rmSync(temporary, { recursive: true, force: true });
}
