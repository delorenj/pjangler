import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildSync } from "esbuild";
import pg from "pg";
import { registryRequest } from "../src/project/index";
import { linkProjectBoard } from "../src/project/identity";
import { persistProjectNotebookBinding, resolveNotebookProjectBySlug } from "../src/notebook/config";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "pjan80-consumer-cas-"));
const database = `pjan80_consumer_${process.pid}_${Date.now()}`;
const host = process.env.PGHOST ?? "/var/run/postgresql";
const admin = new pg.Client({ host, database: process.env.PJ_TEST_ADMIN_DATABASE ?? "postgres" });
let service: ChildProcess | undefined;
let connected = false;
const originalFetch = globalThis.fetch;
const path = join(temporary, ".project.json");
const read = () => JSON.parse(readFileSync(path, "utf8"));
const write = (value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
try {
  await admin.connect(); connected = true;
  await admin.query(`CREATE DATABASE "${database}"`);
  const entry = join(temporary, "service.mjs");
  buildSync({ entryPoints: [join(root, "src/project-registry-service.ts")], outfile: entry, bundle: true, platform: "node", format: "esm", packages: "external" });
  symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
  service = spawn(process.execPath, [entry], { env: { ...process.env, PGHOST: host, PGDATABASE: database, PJ_REGISTRY_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  service.stdout!.on("data", chunk => { output += chunk; });
  service.stderr!.on("data", chunk => { output += chunk; });
  let url: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) break;
    if (service.exitCode !== null) throw new Error(output);
    await delay(50);
  }
  assert.ok(url, output);
  write({ project_id: "px", project_name: "Pilot", ticket_provider: { type: "plane", workspace: "33god", identifier: "PX", board_id: "initial-board", state: "planned", x_provider: "keep" }, notebook: { policy: { enabled: false, session_capture_enabled: false }, binding: { state: "linked", notebook_id: "initial-notebook", overview_note_id: "overview", x_extension: "keep" } }, x_unknown: { keep: true } });
  registryRequest(url, "POST", "/v1/index", { manifest_path: path });

  let resolved = resolveNotebookProjectBySlug("PX", url);
  write({ ...read(), notebook: { ...read().notebook, binding: { ...read().notebook.binding, notebook_id: "operator-notebook" } } });
  const operatorBytes = readFileSync(path, "utf8");
  assert.throws(() => persistProjectNotebookBinding(resolved, { ...resolved.project.notebook!, notebook_id: "stale-notebook" }), /Concurrent manifest change conflicts/);
  assert.equal(readFileSync(path, "utf8"), operatorBytes, "notebook save must never overwrite the operator's concurrent binding");

  resolved = resolveNotebookProjectBySlug("px", url);
  write({ ...read(), x_unknown: { keep: true, concurrent: true }, notebook: { ...read().notebook, policy: { ...read().notebook.policy, session_capture_enabled: true } } });
  persistProjectNotebookBinding(resolved, { ...resolved.project.notebook!, notebook_id: "next-notebook" }, { enabled: true });
  assert.equal(read().notebook.binding.notebook_id, "next-notebook");
  assert.equal(read().notebook.binding.x_extension, "keep");
  assert.deepEqual(read().notebook.policy, { enabled: true, session_capture_enabled: true }, "nonconflicting policy edits merge through the same service baseline");
  assert.equal(read().x_unknown.concurrent, true);
  persistProjectNotebookBinding(resolved, { ...resolved.project.notebook!, notebook_id: "another-notebook" });
  assert.equal(read().notebook.binding.notebook_id, "another-notebook", "a reused resolved context carries the refreshed baseline after its own successful write");

  globalThis.fetch = async () => {
    write({ ...read(), ticket_provider: { ...read().ticket_provider, board_id: "operator-board" } });
    return new Response(JSON.stringify([{ id: "target-board", identifier: "PX", name: "Pilot" }]));
  };
  await assert.rejects(linkProjectBoard({ slug: "PX", boardId: "target-board", registryPath: url, apply: true, env: { PLANE_API_KEY: "test-placeholder", PLANE_BASE_URL: "http://unused.test" }, home: temporary }), /Concurrent manifest change conflicts/);
  assert.equal(read().ticket_provider.board_id, "operator-board", "provider lookup races must not erase a newer board binding");

  globalThis.fetch = async () => {
    write({ ...read(), x_unknown: { ...read().x_unknown, during_provider_lookup: true } });
    return new Response(JSON.stringify([{ id: "target-board", identifier: "PX", name: "Pilot" }]));
  };
  await linkProjectBoard({ slug: "px", boardId: "target-board", registryPath: url, apply: true, env: { PLANE_API_KEY: "test-placeholder", PLANE_BASE_URL: "http://unused.test" }, home: temporary });
  assert.equal(read().ticket_provider.board_id, "target-board");
  assert.equal(read().ticket_provider.x_provider, "keep");
  assert.equal(read().x_unknown.during_provider_lookup, true);
  assert.equal(read().notebook.policy.session_capture_enabled, true);
  console.log("pjan-80 real PostgreSQL consumer concurrency regressions: ok");
} finally {
  globalThis.fetch = originalFetch;
  if (service && service.exitCode === null) {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => service!.once("exit", () => resolve()));
  }
  if (connected) {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
  rmSync(temporary, { recursive: true, force: true });
}
