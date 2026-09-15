import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { buildSync } from "esbuild";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(root, ".pjan-80-migration-"));
const writes = [];
let registry = { schema_version: 1, projects: {}, __registry_status: {}, notebook: { base_url: "https://new.example", defaults: { enabled: false } } };
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (request.method === "POST") writes.push({ path: request.url, body });
  let payload;
  if (request.url === "/health") payload = { ok: true };
  else if (request.url === "/v1/registry" || request.url === "/v1/reindex") payload = registry;
  else if (request.url === "/v1/index") {
    const manifest = JSON.parse(readFileSync(body.manifest_path, "utf8"));
    const id = manifest.project_id;
    registry.projects[id] = { ...manifest, slug: id, repo_path: dirname(body.manifest_path) };
    registry.__registry_status[id] = { status: "ok", manifest_path: body.manifest_path };
    payload = { project_id: id, ok: true };
  } else if (request.url === "/v1/settings") {
    registry.notebook = body.notebook;
    payload = { ok: true };
  } else if (request.url === "/v1/rebuild") payload = { ok: true, receipt_path: body.receipt_path };
  else { response.statusCode = 404; payload = { error: "unknown fixture endpoint" }; }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const receipt = join(temporary, "receipt.json");
const legacyPath = join(temporary, "legacy.yaml");
const script = join(root, "scripts/migrate-project-registry.mjs");
function run(executable, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd, env: { ...process.env, PJ_PROJECT_REGISTRY: endpoint, PJ_REGISTRY_URL: endpoint }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", reject);
    child.once("exit", status => resolve({ status, stdout, stderr }));
  });
}
const migrate = () => run(script, ["--legacy", legacyPath, "--url", endpoint, "--receipt", receipt, "--apply"]);
function manifest(name, value) {
  const repo = join(temporary, name);
  mkdirSync(repo, { recursive: true });
  const path = join(repo, ".project.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function legacy(projects, notebook = undefined) { writeFileSync(legacyPath, YAML.stringify({ projects, ...(notebook ? { notebook } : {}) })); }
async function rejectsBeforeWrites(projects, expression, paths) {
  legacy(projects);
  const before = paths.map(path => readFileSync(path, "utf8"));
  const count = writes.length;
  const result = await migrate();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, expression);
  assert.equal(writes.length, count, "preflight conflicts must precede every service mutation");
  assert.deepEqual(paths.map(path => readFileSync(path, "utf8")), before, "preflight conflicts must precede every manifest write");
}
try {
  const path = manifest("canonical", { project_slug: "PX", project_name: "Manifest wins", ticket_provider: { type: "plane", board_id: "current-board", board_url: "https://metadata.example/current", nested: { live: true } }, custom: { local: true }, agents: {} });
  const old = { px: { repo_path: dirname(path), name: "Old name", ticket_provider: { board_id: "old-board", workspace: "old-workspace", nested: { live: false, missing: "fill" } }, custom: { local: false, missing: true } } };
  old.px.agents = { removed: { role: "pm" } };
  const emptyUrl = manifest("empty-url", { project_id: "empty-url", ticket_provider: { type: "none" } });
  old["empty-url"] = { repo_path: dirname(emptyUrl), ticket_provider: { board_url: "" } };
  const oldNotebook = { base_url: "https://old.example", defaults: { enabled: true, session_capture_enabled: false }, limits: { note_max_bytes: 4096 } };
  legacy(old, oldNotebook);
  const first = await migrate();
  assert.equal(first.status, 0, first.stderr);
  const firstText = readFileSync(path, "utf8");
  const current = JSON.parse(firstText);
  assert.equal(current.project_id, "px");
  assert.deepEqual(current.agents, {}, "an explicit manifest agent map must not revive legacy roles");
  assert.equal(current.project_slug, undefined);
  assert.equal(current.project_name, "Manifest wins");
  assert.equal(current.ticket_provider.board_id, "current-board");
  assert.equal(current.ticket_provider.board_url, "https://metadata.example/current");
  assert.equal(JSON.parse(readFileSync(emptyUrl, "utf8")).ticket_provider.board_url, undefined, "empty legacy URL placeholders stay absent");
  assert.deepEqual(current.ticket_provider.nested, { live: true, missing: "fill" });
  assert.deepEqual(current.custom, { local: true, missing: true });
  assert.equal(registry.notebook.base_url, "https://new.example");
  assert.equal(registry.notebook.defaults.enabled, false);
  assert.equal(registry.notebook.defaults.session_capture_enabled, false);
  registry.notebook.base_url = "https://newer.example";
  registry.notebook.limits.note_max_bytes = 8192;
  const settingsWrites = writes.filter(item => item.path === "/v1/settings").length;
  const second = await migrate();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(path, "utf8"), firstText, "rerun keeps manifest bytes identical");
  assert.equal(JSON.parse(second.stdout).projects[0].changed, false);
  assert.equal(registry.notebook.base_url, "https://newer.example");
  assert.equal(registry.notebook.limits.note_max_bytes, 8192);
  assert.equal(writes.filter(item => item.path === "/v1/settings").length, settingsWrites, "rerun does not rewrite newer settings");

  await rejectsBeforeWrites({ first: { repo_path: dirname(path) }, second: { repo_path: dirname(path) } }, /Duplicate legacy repo_path/, [path]);
  const duplicate = manifest("duplicate", { project_id: "pX" });
  await rejectsBeforeWrites({ px: { repo_path: dirname(path) }, alias: { repo_path: dirname(duplicate) } }, /Duplicate project_id px/, [path, duplicate]);
  for (const value of ["x".repeat(129), "bad.id", "bad_id", "trailing-", 42]) {
    const invalid = manifest("invalid", { project_id: value });
    await rejectsBeforeWrites({ invalid: { repo_path: dirname(invalid) } }, /Invalid project_id|project_id is required/, [invalid]);
  }
  const collision = manifest("existing-collision", { project_id: "px" });
  await rejectsBeforeWrites({ collision: { repo_path: dirname(collision) } }, /Project ID collision px/, [collision]);
  const symlinkRepo = join(temporary, "symlink");
  mkdirSync(symlinkRepo);
  symlinkSync(path, join(symlinkRepo, ".project.json"));
  await rejectsBeforeWrites({ link: { repo_path: symlinkRepo } }, /Expected regular manifest/, [path]);

  const cli = join(temporary, "cli.mjs");
  buildSync({ entryPoints: [join(root, "src/index.ts")], bundle: true, packages: "external", platform: "node", format: "esm", outfile: cli });
  for (const [args, route, body, cwd] of [
    [["reindex"], "/v1/index", { manifest_path: path }, dirname(path)],
    [["reindex", "PX"], "/v1/index", { manifest_path: path }, root],
    [["reindex", "--all"], "/v1/reindex", {}, root],
    [["reindex", "--receipt", receipt], "/v1/rebuild", { receipt_path: receipt }, root],
  ]) {
    const result = await run(cli, [...args, "--json"], cwd);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(writes.at(-1), { path: route, body });
  }
  const count = writes.length;
  const incompatible = await run(cli, ["reindex", "PX", "--all", "--json"]);
  assert.equal(incompatible.status, 1);
  assert.equal(writes.length, count);
  console.log("PJAN-80 migration: authoritative manifests, rerun settings, preflight collisions and CLI reindex passed");
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
