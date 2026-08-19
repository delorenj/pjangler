import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emptyProjectRegistry, saveProjectRegistry, type ProjectRecord } from "../src/project/index";
import { DEFAULT_NOTEBOOK_LIMITS } from "../src/notebook/types";

const root = resolve(process.cwd());
const workspace = mkdtempSync(join(tmpdir(), "pjan-77-release-"));
let packageSpace: string | undefined;
let server: ChildProcessWithoutNullStreams | undefined;

function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.PJ_PROJECT_NOTEBOOK_SKILL_SOURCE;
  delete env.PJ_PROJECT_NOTEBOOK_SKILL_ROOT;
  delete env.PJ_SKILLS_REGISTRY_ROOT;
  delete env.OPEN_NOTEBOOK_PASSWORD;
  return env;
}

function runCli(entry: string, args: string[], env: NodeJS.ProcessEnv, cwd = root) {
  return spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function parseSingleJson(result: ReturnType<typeof runCli>, expectedStatus: number): Record<string, any> {
  assert.equal(result.status, expectedStatus, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, "", "JSON mode emits no Commander or human prose on stderr");
  assert.ok(result.stdout.trim().startsWith("{") && result.stdout.trim().endsWith("}"));
  return JSON.parse(result.stdout) as Record<string, any>;
}

function treeDigest(path: string): string {
  const hash = createHash("sha256");
  const walk = (current: string, prefix = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(full);
      hash.update(`${rel}\0${stat.mode & 0o777}\0${stat.size}\0`);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isSymbolicLink()) hash.update(readlinkSync(full));
      else hash.update(readFileSync(full));
    }
  };
  walk(path);
  return hash.digest("hex");
}

function project(repo: string, state: "planned" | "linked" = "linked"): ProjectRecord {
  return {
    name: "Built CLI Fixture", slug: "built-cli-fixture", repo_path: repo, description: "release fixture", status: "active", source_artifacts: [],
    template: { commonproject: { enabled: true, primary_language: "typescript" } },
    ticket_provider: { type: "plane", workspace: "33god", identifier: "BUILTCLI", board_id: "", state: "planned" }, agents: {},
    notebook: state === "linked"
      ? { state, notebook_id: "nb-built", notebook_name: "Built CLI Fixture", overview_note_id: "overview-built" }
      : { state, notebook_name: "Built CLI Fixture" },
    created_at: "2026-08-19T00:00:00.000Z", updated_at: "2026-08-19T00:00:00.000Z",
  };
}

function writeManifest(repo: string, record: ProjectRecord): void {
  writeFileSync(join(repo, ".project.json"), `${JSON.stringify({
    project_name: record.name, project_description: record.description, project_slug: record.slug, repo_path: repo,
    ticket_provider: record.ticket_provider, agents: {},
    notebook: { binding: record.notebook, policy: { enabled: true, session_start_enabled: false, session_capture_enabled: false } },
  }, null, 2)}\n`);
}

async function startFixtureServer(requestLog: string): Promise<{ port: number }> {
  const script = join(workspace, "fake-open-notebook.mjs");
  writeFileSync(script, `import http from "node:http"; import { appendFileSync } from "node:fs";
const log = process.argv[2];
const response = (res, value, status = 200) => { const body = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); };
const server = http.createServer((req, res) => { appendFileSync(log, String(req.method) + " " + String(req.url) + "\\n");
  if (req.url === "/api/auth/status") return response(res, { auth_enabled: false });
  if (req.url === "/api/config") return response(res, { version: "1.14.0" });
  if (req.url === "/api/notebooks") return response(res, [{ id: "nb-built", name: "Built CLI Fixture", description: "pjangler.project.v1:built-cli-fixture", archived: false }]);
  if (req.url?.startsWith("/api/notes?notebook_id=")) return response(res, [{ id: "note-built", title: "Built note", content: "bounded body", note_type: "note", created_at: null, updated_at: "2026-08-19T00:00:00.000Z" }]);
  response(res, { error: "not found" }, 404);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  server = spawn(process.execPath, [script, requestLog], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise<number>((resolvePort, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("fixture server did not start")), 5_000);
    server!.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const line = buffer.split("\n")[0];
      if (/^\d+$/u.test(line)) { clearTimeout(timeout); resolvePort(Number(line)); }
    });
    server!.once("error", reject);
    server!.once("exit", (code) => { if (code !== null && code !== 0) reject(new Error(`fixture server exited ${code}`)); });
  });
  return { port };
}

try {
  const build = spawnSync("npm", ["run", "build"], { cwd: root, env: cleanEnvironment(), encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
  const distEntry = join(root, "dist", "index.js");
  assert.ok(existsSync(distEntry));

  const requestLog = join(workspace, "requests.log");
  const fixture = await startFixtureServer(requestLog);
  const dryRepo = join(workspace, "dry-run-repo");
  const dryHome = join(workspace, "dry-home");
  const dryRegistry = join(workspace, "dry-registry.yaml");
  mkdirSync(dryRepo, { recursive: true });
  mkdirSync(dryHome, { recursive: true });
  const dryRegistryValue = emptyProjectRegistry();
  dryRegistryValue.notebook = { base_url: `http://127.0.0.1:${fixture.port}`, auth: { mode: "none" } };
  saveProjectRegistry(dryRegistryValue, dryRegistry);
  const dryEnv = cleanEnvironment({ HOME: dryHome, XDG_CONFIG_HOME: join(dryHome, ".config"), XDG_STATE_HOME: join(dryHome, ".state"), XDG_DATA_HOME: join(dryHome, ".data") });
  const beforeDryRun = treeDigest(workspace);
  const dryJson = runCli(distEntry, ["init", "Dry Run Project", "--description", "pure plan", "--target-dir", dryRepo, "--registry", dryRegistry, "--dry-run", "--no-tui", "--json"], dryEnv);
  assert.equal(dryJson.status, 0, `${dryJson.stdout}${dryJson.stderr}`);
  const dryPayload = JSON.parse(dryJson.stdout) as Record<string, any>;
  assert.deepEqual(dryPayload.notebookPlan.phases.map((item: { id: string }) => item.id), ["configuration", "binding-projection", "skill", "managed-hooks", "overview-note", "live-action"]);
  assert.equal(dryPayload.notebookPlan.plan.config.binding.notebook_name, "Dry Run Project", "repository display name, not slug, seeds the proposed remote name");
  assert.equal(dryPayload.notebookPlan.phases.find((item: { id: string }) => item.id === "overview-note").status, "requires-live");
  const dryHuman = runCli(distEntry, ["init", "Dry Run Project", "--description", "pure plan", "--target-dir", dryRepo, "--registry", dryRegistry, "--dry-run", "--no-tui"], dryEnv);
  assert.equal(dryHuman.status, 0, `${dryHuman.stdout}${dryHuman.stderr}`);
  for (const phase of ["configuration", "binding-projection", "skill", "managed-hooks", "overview-note", "live-action"]) assert.match(dryHuman.stdout, new RegExp(phase, "u"));
  assert.equal(treeDigest(workspace), beforeDryRun, "JSON and human pj init dry-runs make zero repo/Registry/HOME/XDG writes");
  assert.equal(existsSync(requestLog), false, "dry-run makes zero requests to the configured fake service");

  const cliRepo = join(workspace, "built-cli-repo");
  const cliRegistry = join(workspace, "built-cli-registry.yaml");
  const cliHome = join(workspace, "built-cli-home");
  mkdirSync(cliRepo, { recursive: true });
  const cliRecord = project(cliRepo, "linked");
  const cliRegistryValue = emptyProjectRegistry();
  cliRegistryValue.notebook = { base_url: `http://127.0.0.1:${fixture.port}`, auth: { mode: "none" }, limits: { ...DEFAULT_NOTEBOOK_LIMITS } };
  cliRegistryValue.projects[cliRecord.slug] = cliRecord;
  saveProjectRegistry(cliRegistryValue, cliRegistry);
  writeManifest(cliRepo, cliRecord);
  const cliEnv = cleanEnvironment({ HOME: cliHome, PJ_PROJECT_REGISTRY: cliRegistry, XDG_STATE_HOME: join(cliHome, ".state"), XDG_DATA_HOME: join(cliHome, ".data") });

  const status = parseSingleJson(runCli(distEntry, ["notebook", "status", cliRepo, "--local-only", "--json"], cliEnv), 0);
  assert.equal(status.command, "notebook.status");
  assert.equal(status.data.remote_check, "skip", "the built async status action is awaited before process exit");
  const get = parseSingleJson(runCli(distEntry, ["notebook", "get", "note", "note-built", cliRepo, "--json"], cliEnv), 0);
  assert.equal(get.command, "notebook.notes.get");
  assert.equal(get.data.note.id, "note-built", "a built nested CRUD action completes through parseAsync");
  for (const [args, command] of [
    [["notebook", "get", "note", "--json"], "notebook.notes.get"],
    [["notebook", "search", "notes", "--json"], "notebook.notes.search"],
    [["notebook", "status", cliRepo, "--unknown-option", "--json"], "notebook.status"],
    [["notebook", "list", "notes", cliRepo, "--limit", "not-a-number", "--json"], "notebook.notes.list"],
  ] as const) {
    const failed = parseSingleJson(runCli(distEntry, [...args], cliEnv), 2);
    assert.equal(failed.schema_version, 1);
    assert.equal(failed.ok, false);
    assert.equal(failed.command, command);
    assert.equal(failed.error.code, "INVALID_INPUT");
  }

  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", workspace], { cwd: root, env: cleanEnvironment(), encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  assert.equal(packed.status, 0, `${packed.stdout}${packed.stderr}`);
  const packedJson = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }> | Record<string, { filename: string; files: Array<{ path: string }> }>;
  const packedResult = Array.isArray(packedJson) ? packedJson[0] : Object.values(packedJson)[0];
  assert.ok(packedResult?.files.some((item) => item.path === "dist/assets/project-notebook-skill/export-manifest.json"));
  const tarball = join(workspace, packedResult!.filename);
  packageSpace = mkdtempSync(join(root, ".pjan-77 npm pack space "));
  const extracted = spawnSync("tar", ["-xzf", tarball, "-C", packageSpace], { encoding: "utf8" });
  assert.equal(extracted.status, 0, `${extracted.stdout}${extracted.stderr}`);
  const packedRoot = join(packageSpace, "package");
  const packedEntry = join(packedRoot, "dist", "index.js");

  const installRepo = join(workspace, "packed-install-repo");
  const installHome = join(workspace, "packed-install-home");
  const installRegistry = join(workspace, "packed-install-registry.yaml");
  mkdirSync(installRepo, { recursive: true });
  const installRecord = project(installRepo, "planned");
  const installRegistryValue = emptyProjectRegistry();
  installRegistryValue.projects[installRecord.slug] = installRecord;
  saveProjectRegistry(installRegistryValue, installRegistry);
  writeManifest(installRepo, installRecord);
  const installEnv = cleanEnvironment({ HOME: installHome, PJ_PROJECT_REGISTRY: installRegistry, XDG_DATA_HOME: join(installHome, ".data"), XDG_STATE_HOME: join(installHome, ".state"), PJ_PROJECT_NOTEBOOK_CLAUDE_SETTINGS: join(installHome, ".claude", "settings.json") });
  const installed = parseSingleJson(runCli(packedEntry, ["notebook", "migrate", installRepo, "--apply", "--json"], installEnv, packedRoot), 0);
  assert.equal(installed.command, "notebook.migrate");
  const skillLink = join(installHome, ".agents", "skills", "project-notebook");
  assert.ok(lstatSync(skillLink).isSymbolicLink());
  const firstLinkIdentity = lstatSync(skillLink).ino;
  const target = resolve(join(skillLink, ".."), readlinkSync(skillLink));
  assert.ok(target.startsWith(resolve(installHome, ".data", "pjangler", "skills", "project-notebook")), "clean npm-pack install uses only its verified XDG payload fallback");
  assert.ok(existsSync(join(target, "export-manifest.json")));
  const installedAgain = parseSingleJson(runCli(packedEntry, ["notebook", "migrate", installRepo, "--apply", "--json"], installEnv, packedRoot), 0);
  assert.equal(installedAgain.ok, true);
  assert.equal(lstatSync(skillLink).ino, firstLinkIdentity, "packed install is inode-idempotent");

  const exporterSpace = join(packageSpace, "exporter path with spaces");
  mkdirSync(join(exporterSpace, "scripts"), { recursive: true });
  mkdirSync(join(exporterSpace, "dist", "assets"), { recursive: true });
  cpSync(join(root, "scripts", "export-project-notebook-skill.mjs"), join(exporterSpace, "scripts", "export-project-notebook-skill.mjs"));
  cpSync(join(root, "dist", "assets", "project-notebook-skill"), join(exporterSpace, "dist", "assets", "project-notebook-skill"), { recursive: true });
  const exporter = spawnSync(process.execPath, [join(exporterSpace, "scripts", "export-project-notebook-skill.mjs")], { cwd: exporterSpace, env: cleanEnvironment(), encoding: "utf8" });
  assert.equal(exporter.status, 0, `${exporter.stdout}${exporter.stderr}`);
  assert.match(exporter.stdout, /verified tracked packed export/u, "exporter resolves a clean fallback from a path containing spaces");

  console.log("pjan-77 notebook built/package release gates: ok");
} finally {
  server?.kill("SIGTERM");
  if (packageSpace) rmSync(packageSpace, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
