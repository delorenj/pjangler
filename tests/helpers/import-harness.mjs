// PJAN-165: the disposable harness shared by the `pj import` suites.
//
// Everything here is throwaway and lives under the hermetic scratch base
// (tests/helpers/hermetic-env.mjs, never inside a git work tree):
//
// - a scratch directory holding every fixture repository, bare remote and the
//   isolated HOME the CLI children run with;
// - a uniquely named Postgres database, created and dropped here, behind a real
//   project-registry service (dist/project-registry-service.js) on an ephemeral
//   loopback port. Nothing reaches the live registry or the operator's databases;
// - every child (git, the CLI, the service) runs with a COMPLETE hermeticEnv(),
//   GIT_CEILING_DIRECTORIES pinned to the scratch base so no fixture command can
//   discover a repository above it, and the Postgres settings forwarded by the
//   suite's SUITE_PASSTHROUGH grants only.
//
// A suite imports "./helpers/hermetic-suite.mjs" first, then this module.
import { SUITE_GRANTS } from "./hermetic-suite.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { HERMETIC_TMP_BASE, hermeticEnv, hermeticScratch } from "./hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..", "..");

/** Every file, directory and link under `dir` with its mode and content hash. */
export function tree(dir) {
  const rows = [];
  function walk(at, rel = "") {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name), key = join(rel, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) rows.push([key, "link", readlinkSync(path)]);
      else if (stat.isDirectory()) { rows.push([key, "dir", stat.mode]); walk(path, key); }
      else rows.push([key, stat.mode, createHash("sha256").update(readFileSync(path)).digest("hex")]);
    }
  }
  walk(dir);
  return rows;
}

export const bytes = (path) => readFileSync(path).toString("base64");

/**
 * @param {string} label  names the scratch directory and the disposable database
 */
export async function startHarness(label) {
  const temp = hermeticScratch(label);
  const database = `${label.replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}_${process.pid}_${Date.now()}`;
  const home = join(temp, "home");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  const env = hermeticEnv({
    HOME: home,
    XDG_STATE_HOME: join(home, ".local/state"),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CEILING_DIRECTORIES: HERMETIC_TMP_BASE,
    GIT_CONFIG_NOSYSTEM: "1",
    PGHOST: process.env.PGHOST ?? "/var/run/postgresql",
    PGDATABASE: database,
    PJ_REGISTRY_PORT: "0",
  }, { pass: SUITE_GRANTS });
  const admin = new pg.Client({ host: env.PGHOST, database: process.env.PJ_TEST_ADMIN_DATABASE ?? "postgres" });
  let adminConnected = false, db, service, url, created = false;

  function run(command, args, cwd, options = {}) {
    const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30000, ...options, env });
    assert.ifError(r.error);
    return r;
  }
  function git(dir, ...args) {
    const r = run("git", args, dir);
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  /** `git` that is allowed to fail: returns the whole spawn result. */
  const gitTry = (dir, ...args) => run("git", args, dir);
  function repo(name, manifest = { project_id: name, agents: {} }, base = temp) {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q"); git(dir, "config", "user.name", "PJAN-165 Test"); git(dir, "config", "user.email", "pjan-165@localhost.invalid");
    writeFileSync(join(dir, ".gitignore"), "ignored/\n");
    writeFileSync(join(dir, "tracked"), "base\n");
    if (manifest) writeFileSync(join(dir, ".project.json"), `${JSON.stringify({ ...manifest, repo_path: dir }, null, 2)}\n`);
    git(dir, "add", "."); git(dir, "commit", "-qm", "PJAN-165 initialize disposable repository");
    return dir;
  }
  function bare(source, name) {
    const target = join(temp, `${name}.git`);
    git(temp, "clone", "--bare", source, target);
    return target;
  }
  /** `pj import <source> --json` from `parent` against the disposable registry. */
  function cli(parent, source, ...args) {
    const r = run(process.execPath, [join(root, "dist/index.js"), "import", source, "--registry", url, "--bindings-home", home, "--json", ...args], parent);
    let data;
    try { data = JSON.parse(r.stdout); } catch { throw new Error(`Invalid CLI JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`); }
    return { ...r, data };
  }
  /** `pj <args>` with no import wrapper (info, reindex, ...). */
  const pj = (cwd, ...args) => run(process.execPath, [join(root, "dist/index.js"), ...args], cwd);
  async function request(path, data) {
    const r = await fetch(`${url}${path}`, { method: data === undefined ? "GET" : "POST", ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { "content-type": "application/json" } }) });
    const result = await r.json();
    assert.equal(r.status, 200, JSON.stringify(result));
    return result;
  }
  const rows = async () => (await db.query("SELECT * FROM pjangler_index.projects ORDER BY project_id")).rows;

  async function stop() {
    if (service && service.exitCode === null) { service.kill("SIGTERM"); await new Promise((r) => service.once("exit", r)); }
    if (db) await db.end().catch(() => {});
    if (adminConnected) {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
    rmSync(temp, { recursive: true, force: true });
  }

  try {
    await admin.connect(); adminConnected = true;
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    db = new pg.Client({ host: env.PGHOST, database });
    await db.connect();
    let output = "";
    service = spawn(process.execPath, [join(root, "dist/project-registry-service.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout.on("data", (c) => { output += c; });
    service.stderr.on("data", (c) => { output += c; });
    for (let i = 0; i < 100; i++) {
      url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) break;
      if (service.exitCode !== null) throw new Error(output);
      await delay(50);
    }
    assert.ok(url, output);
    // From here every child that resolves a registry by default (the CLI, `flume roster`
    // inside the import gate) reaches THIS disposable service, never the live one.
    env.PJ_REGISTRY_URL = url; env.PJ_PROJECT_REGISTRY = url;
  } catch (error) {
    await stop();
    throw error;
  }

  return { root, temp, home, database, env, url, db, run, git, gitTry, repo, bare, cli, pj, request, rows, stop };
}
