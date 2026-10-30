import "./helpers/hermetic-suite.mjs";
// PJAN-184 — the `pj crank` command surface, end to end.
//
// pjan-174 and pjan-182 pin the pure resolution / interval math and the Ink screens in
// process. What they leave open is the commander wiring in src/crank/cli.ts: the argument
// checks, the order things are resolved in, what each subcommand prints, how a broken
// registry or a dead Redis degrades, and the interactive paths (the interval picker, the
// dashboard) behind a real terminal. Those are exactly where a refactor silently turns
// "stored under the project name as-is" into a wrong-tab write, so they are pinned here
// through the real built CLI (dist/index.js) against a throwaway redis-server.
//
// HARD RULE: nothing here touches 127.0.0.1:6379 (the live crank engine's Redis). Every
// child gets ZCRANK_REDIS_PORT of the throwaway server, and nothing runs FLUSHALL: keys
// are deleted by exact name on a server that exists only for this run.
//
// zellij is the one external binary a cold machine does not have. Two real PATH setups
// stand in for it, both reached through the code's own `env -u ZELLIJ timeout 5s zellij`
// call: a PATH with no zellij at all (the degrade path), and a PATH whose `zellij` is a
// shell script printing a tab list (the live-tab path). Nothing inside pj is replaced.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startThrowawayRedis } from "./pjan-182-crank-regressions-helpers.mjs";
import { runOnPty } from "./helpers/pty-run.mjs";

const root = resolve(import.meta.dirname, "..");
const pj = join(root, "dist", "index.js");
assert.ok(existsSync(pj), "dist/index.js missing: run `npm run build` first");
assert.ok(existsSync(join(root, "dist", "crank", "tui.js")), "dist/crank/tui.js missing: run `npm run build` first");

const workspace = mkdtempSync(join(tmpdir(), "pjan-184-cli-"));
const rs = await startThrowawayRedis();
let failed;

/** Absolute path of a binary on the real PATH. */
const which = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: hermeticEnv() }).stdout.trim();

try {
  // --- two PATHs: no zellij, and a zellij that prints $FAKE_ZELLIJ_TABS ---------------------
  const bin = (dir) => {
    mkdirSync(dir, { recursive: true });
    for (const tool of ["env", "timeout", "redis-cli", "cat"]) symlinkSync(which(tool), join(dir, tool));
    return dir;
  };
  const noZellij = bin(join(workspace, "bin-none"));
  const withZellij = bin(join(workspace, "bin-zellij"));
  writeFileSync(
    join(withZellij, "zellij"),
    '#!/bin/sh\ncase "$*" in *"action list-tabs --json"*) cat "$FAKE_ZELLIJ_TABS" ;; *) exit 2 ;; esac\n',
  );
  chmodSync(join(withZellij, "zellij"), 0o755);
  const tabsFile = join(workspace, "tabs.json");
  const setTabs = (...names) => writeFileSync(tabsFile, JSON.stringify(names.map((name, position) => ({ name, position }))));

  // --- projects on disk + a registry that knows two of them ---------------------------------
  const repos = join(workspace, "repos");
  const project = (dir, manifest) => {
    mkdirSync(join(repos, dir), { recursive: true });
    writeFileSync(join(repos, dir, ".project.json"), JSON.stringify(manifest));
    return join(repos, dir);
  };
  const alpha = project("alpha", { project_id: "alpha", project_name: "Manifest Alpha" });
  const beta = project("beta", { project_id: "beta" });
  const loner = project("loner", { project_slug: "loner", project_name: "Lone Wolf", agents: { "wolf-pm": { role: "pm" }, "wolf-sm": {} } });
  const nowhere = join(workspace, "no-project-here");
  mkdirSync(nowhere);
  const record = (slug, name, extra = "") => `  ${slug}:
    name: ${name}
    slug: ${slug}
    repo_path: ${join(repos, slug)}
    source_artifacts: []
    ticket_provider: {}
    agents:
${extra || "      {}"}
`;
  const registry = join(workspace, "registry.yaml");
  writeFileSync(
    registry,
    `schema_version: 1\nprojects:\n${record("alpha", "Alpha Project", "      alpha-pm:\n        role: pm\n      alpha-dev:\n        role: dev")}${record("beta", "Beta Works")}`,
  );
  const brokenRegistry = join(workspace, "broken.yaml");
  writeFileSync(brokenRegistry, "schema_version: 99\nprojects: {}\n");

  // hermeticEnv pins TMPDIR and passes NODE_V8_COVERAGE (c8) itself.
  const baseEnv = (path) => hermeticEnv({
    PATH: path,
    HOME: workspace,
    GIT_CEILING_DIRECTORIES: workspace,
    NO_COLOR: "1",
    ZCRANK_REDIS_HOST: "127.0.0.1",
    ZCRANK_REDIS_PORT: String(rs.port),
    PJ_PROJECT_REGISTRY: registry,
    FAKE_ZELLIJ_TABS: tabsFile,
  });
  const run = (args, { cwd = alpha, path = noZellij, env = {} } = {}) =>
    spawnSync(process.execPath, [pj, ...args], { cwd, encoding: "utf8", timeout: 30_000, env: { ...baseEnv(path), ...env } });
  const del = (...keys) => { for (const k of keys) rs.cli("DEL", k); };
  const keys = (pattern) => rs.cli("KEYS", pattern).split("\n").filter(Boolean).sort();
  const reset = () => { for (const k of keys("zcrank:*")) del(k); setTabs(); };

  // -------------------------------------------------------------------------
  console.log("enable / disable with no zellij: stored under the registry name as-is, and says so");
  {
    reset();
    const on = run(["crank", "enable", "--interval", "6h"]);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /ON\s+alpha\s+❯\s+Alpha Project/);
    assert.match(on.stdout, /interval 6h/);
    assert.match(on.stdout, /no live zellij tab or zcrank key matches "Alpha Project" — stored under the project name as-is/);
    assert.deepEqual(keys("zcrank:tab:*"), ["zcrank:tab:Alpha Project"], "the registry name beats the manifest's project_name");
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "enabled"), "1");
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "interval"), "6h");

    // the key now exists, so a second resolution is a redis-exact hit: no more "as-is" warning
    const again = run(["crank", "enable"]);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /as-is/);
    assert.match(again.stdout, /interval 6h/, "an interval-less non-TTY enable leaves the interval alone");

    const off = run(["crank", "disable"]);
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /OFF\s+alpha\s+❯\s+Alpha Project/);
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "enabled"), "0");
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "interval"), "6h", "disable does not touch the interval");

    // a project the registry has never heard of: the as-is warning on disable too
    reset();
    const lone = run(["crank", "disable"], { cwd: beta, env: { PJ_PROJECT_REGISTRY: join(workspace, "absent.yaml") } });
    assert.equal(lone.status, 0, lone.stderr);
    assert.match(lone.stdout, /OFF\s+beta\s+❯\s+beta/, "no registry, no manifest name: the slug is the tab name");
    assert.match(lone.stdout, /no live zellij tab or zcrank key matches "beta"/);
    assert.equal(rs.cli("HGET", "zcrank:tab:beta", "enabled"), "0");
  }

  console.log("enable: a live zellij tab is the authority, and a renamed tab's old key is merged away out loud");
  {
    reset();
    setTabs("Other 🟢", "Alpha Project 🔔");
    rs.cli("HSET", "zcrank:tab:alpha", "enabled", "0", "interval", "1d");
    rs.cli("RPUSH", "zcrank:log:alpha", JSON.stringify({ ts: "2026-10-01T00:00:00Z", state: "sent", action: "old life" }));
    const on = run(["crank", "enable"], { path: withZellij });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /ON\s+alpha\s+❯\s+Alpha Project/);
    assert.match(on.stdout, /tab renamed · alpha ❯ Alpha Project \(old key merged into the new one and removed\)/);
    assert.doesNotMatch(on.stdout, /as-is/, "a live tab matched");
    assert.match(on.stdout, /interval 1d/, "the old key's interval travelled with it");
    assert.deepEqual(keys("zcrank:tab:*"), ["zcrank:tab:Alpha Project"], "the status glyph never leaks into a key; the old spelling is gone");
    assert.equal(rs.cli("EXISTS", "zcrank:log:alpha"), "0");
    assert.match(rs.cli("LRANGE", "zcrank:log:Alpha Project", "0", "-1"), /old life/, "its history moved too");

    // disable follows the same live tab
    const off = run(["crank", "disable"], { path: withZellij });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "enabled"), "0");
  }

  console.log("project naming: the manifest names it when the registry has no record; handles come from the manifest");
  {
    reset();
    // `loner` is in no registry: manifest project_name wins over the slug
    const on = run(["crank", "enable", "--interval", "1h"], { cwd: loner });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /ON\s+loner\s+❯\s+Lone Wolf/);
    assert.equal(rs.cli("HGET", "zcrank:tab:Lone Wolf", "interval"), "1h");

    // ...and the agent handle's tab name (wolf-pm -> "wolf") is a candidate: a live "Wolf" tab is found by it
    reset();
    setTabs("Wolf");
    const viaHandle = run(["crank", "enable", "--interval", "1h"], { cwd: loner, path: withZellij });
    assert.equal(viaHandle.status, 0, viaHandle.stderr);
    assert.match(viaHandle.stdout, /ON\s+loner\s+❯\s+Wolf/);
    assert.doesNotMatch(viaHandle.stdout, /as-is/);
  }

  console.log("a broken registry is not fatal for enable/disable/log: the manifest is still a truthful answer");
  {
    reset();
    const on = run(["crank", "enable", "--interval", "5m"], { env: { PJ_PROJECT_REGISTRY: brokenRegistry } });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /ON\s+alpha\s+❯\s+Manifest Alpha/, "registry unusable -> manifest project_name");
    assert.equal(rs.cli("HGET", "zcrank:tab:Manifest Alpha", "enabled"), "1");
  }

  console.log("refusals: bad interval, outside a project, dead Redis -- each fails with its own words and writes nothing");
  {
    reset();
    for (const sub of [["enable"], ["disable"], ["log"]]) {
      const out = run(["crank", ...sub], { cwd: nowhere });
      assert.equal(out.status, 1, sub.join(" "));
      assert.match(out.stderr, /not inside a pjangler project/, sub.join(" "));
    }
    assert.deepEqual(keys("zcrank:*"), [], "nothing written outside a project");

    // the project is resolved BEFORE Redis is pinged: outside a project beats a dead Redis
    const both = run(["crank", "disable"], { cwd: nowhere, env: { ZCRANK_REDIS_PORT: "1" } });
    assert.match(both.stderr, /not inside a pjangler project/);

    const dead = { ZCRANK_REDIS_PORT: "1" };
    for (const sub of [["disable"], ["list"], ["enable", "--interval", "1h"]]) {
      const out = run(["crank", ...sub], { env: dead });
      assert.equal(out.status, 1, sub.join(" "));
      assert.match(out.stderr, /Redis is not answering at 127\.0\.0\.1:1/, sub.join(" "));
    }
    // log has no ping of its own: the first Redis call surfaces the dead server
    const log = run(["crank", "log"], { env: dead });
    assert.equal(log.status, 1);
    assert.match(log.stderr, /Redis is not answering at 127\.0\.0\.1:1/);
    assert.equal(run(["crank", "log", "--tail", "0"]).status, 1);
    assert.match(run(["crank", "log", "--tail", "1.5"]).stderr, /--tail needs a positive integer, got "1\.5"/);
  }

  console.log("log: empty, newest-last tail with counts, junk rows pass through raw");
  {
    reset();
    const empty = run(["crank", "log"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /no crank log rows for Alpha Project/);

    const rows = [
      JSON.stringify({ ts: "2026-10-20T10:00:00Z", state: "sent", action: "first" }),
      "{{{ not json",
      JSON.stringify({ ts: "2026-10-20T12:00:00Z", state: "waiting", action: "third" }),
    ];
    rs.cli("RPUSH", "zcrank:log:Alpha Project", ...rows);
    const all = run(["crank", "log"]);
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /crank log · Alpha Project \(3\/3 rows, newest last\)/);
    const lines = all.stdout.split("\n").filter((l) => /^(2026|\{\{\{)/.test(l));
    assert.deepEqual(lines, [
      "2026-10-20T10:00:00Z  sent        first",
      "{{{ not json",
      "2026-10-20T12:00:00Z  waiting     third",
    ]);
    const tail = run(["crank", "log", "--tail", "2"]);
    assert.match(tail.stdout, /\(2\/3 rows, newest last\)/);
    assert.doesNotMatch(tail.stdout, /first/);
    assert.match(tail.stdout, /third/);
    // a tail larger than the log shows the whole log
    assert.match(run(["crank", "log", "--tail", "99"]).stdout, /\(3\/3 rows/);
  }

  console.log("list: every registry project, ON/OFF/never, resolved tab, orphans; a dead Redis or bad registry fails loudly");
  {
    reset();
    setTabs("Alpha Project 🟢");
    rs.cli("HSET", "zcrank:tab:Alpha Project", "enabled", "1", "interval", "1h");
    rs.cli("HSET", "zcrank:tab:Beta Works", "enabled", "0");
    rs.cli("HSET", "zcrank:tab:Stranger", "enabled", "1");
    const out = run(["crank", "list"], { path: withZellij });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /alpha\s+Alpha Project\s+ON/);
    assert.match(out.stdout, /beta\s+Beta Works\s+OFF/);
    assert.match(out.stdout, /Stranger/);
    assert.match(out.stdout, /no matching project/);
    assert.match(out.stdout, /1h/);

    const bad = run(["crank", "list"], { env: { PJ_PROJECT_REGISTRY: brokenRegistry } });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /crank list failed: .*schema_version/);
  }

  console.log("a Redis that answers PING and then drops every command: failure with the command's own prefix, no ON/OFF line");
  {
    reset();
    // The ping gate passes, the next call finds the connection closed: the shape of a Redis that
    // dies (or is restarted) between the gate and the write.
    // (A separate process: runPj blocks this one with spawnSync, so an in-process server could not answer.)
    const flaky = spawn(process.execPath, ["-e", `
      const { createServer } = require("node:net");
      const server = createServer((socket) => {
        socket.on("error", () => {});
        socket.once("data", (data) => (/PING/i.test(data.toString()) ? socket.end("+PONG\\r\\n") : socket.destroy()));
      });
      server.listen(0, "127.0.0.1", () => console.log(server.address().port));
    `], { stdio: ["ignore", "pipe", "inherit"], env: hermeticEnv() });
    const port = await new Promise((resolve) => flaky.stdout.once("data", (d) => resolve(Number(d.toString().trim()))));
    const env = { ZCRANK_REDIS_PORT: String(port) };
    try {
      for (const sub of [["enable", "--interval", "1h"], ["disable"]]) {
        const out = run(["crank", ...sub], { env });
        assert.equal(out.status, 1, sub.join(" "));
        assert.match(out.stderr, /^✖ crank failed: Redis is not answering at 127\.0\.0\.1:\d+/, sub.join(" "));
        assert.equal(out.stdout, "", "no ON/OFF line for a write that did not land");
      }
    } finally {
      flaky.kill("SIGKILL");
    }
    assert.deepEqual(keys("zcrank:*"), [], "and the real server saw nothing");
  }

  console.log("tui and enable need a terminal: without one they refuse before touching Redis");
  {
    reset();
    const tui = run(["crank", "tui"]);
    assert.equal(tui.status, 1);
    assert.match(tui.stderr, /^✖ pj crank tui needs an interactive terminal \(stdin and stdout must be a TTY\)/, "the command's own gate, not the Ink runner's later one");
    assert.deepEqual(keys("zcrank:*"), []);
  }

  // -------------------------------------------------------------------------
  // A real terminal: the interval picker and the dashboard
  // -------------------------------------------------------------------------

  const onPty = (args, steps, { cwd = alpha, path = noZellij, env = {} } = {}) =>
    runOnPty({ argv: [process.execPath, pj, ...args], cwd, env: { ...baseEnv(path), TERM: "xterm-256color", ...env }, steps });
  const ENTER = "\r";

  console.log("pty: `crank enable` with no --interval asks; confirming the inherited default writes no override");
  {
    reset();
    const r = onPty(["crank", "enable"], [{ wait: "5m\\s+global", send: ENTER }, { wait: "interval 5m" }]);
    assert.equal(r.timedOut, false, r.output);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /\(•\) 5m\s+global/, "opens on the effective interval, the global badged");
    assert.match(r.output, /ON\s+alpha\s+❯\s+Alpha Project/);
    assert.match(r.output, /interval 5m \(inherits global 5m\)/);
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "enabled"), "1");
    assert.equal(rs.cli("HEXISTS", "zcrank:tab:Alpha Project", "interval"), "0", "picking what is already inherited changes nothing");
  }

  console.log("pty: choosing a different interval writes it; q aborts and leaves the crank as it was");
  {
    reset();
    const chose = onPty(["crank", "enable"], [{ wait: "5m\\s+global", send: "3" }, { wait: "\\(•\\) 6h", send: ENTER }, { wait: "interval 6h" }]);
    assert.equal(chose.status, 0, chose.output);
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "interval"), "6h");
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "enabled"), "1");

    reset();
    const aborted = onPty(["crank", "enable"], [{ wait: "5m\\s+global", send: "q" }, { wait: "aborted" }]);
    assert.equal(aborted.status, 0, aborted.output);
    assert.match(aborted.output, /aborted · crank left as it was for alpha/);
    assert.deepEqual(keys("zcrank:*"), [], "an abort writes nothing");
  }

  console.log("pty: a CLI whose Ink screens were never built says so instead of crashing");
  {
    reset();
    // the entry bundle alone, next to node_modules but with no crank/tui.js beside it
    const lonely = join(workspace, "lonely", "dist");
    mkdirSync(lonely, { recursive: true });
    symlinkSync(join(root, "node_modules"), join(workspace, "lonely", "node_modules"), "dir");
    copyFileSync(pj, join(lonely, "index.js"));
    const tui = runOnPty({
      argv: [process.execPath, join(lonely, "index.js"), "crank", "tui"],
      cwd: alpha, env: { ...baseEnv(noZellij), TERM: "xterm-256color" },
      steps: [{ wait: "not built" }],
    });
    assert.equal(tui.status, 1, tui.output);
    assert.match(tui.output, /TUI screen \.\/crank\/tui\.js is not built \(run: npm run build\)/);
    const enable = runOnPty({
      argv: [process.execPath, join(lonely, "index.js"), "crank", "enable"],
      cwd: alpha, env: { ...baseEnv(noZellij), TERM: "xterm-256color" },
      steps: [{ wait: "not built" }],
    });
    assert.equal(enable.status, 1, enable.output);
    assert.match(enable.output, /is not built/);
    assert.deepEqual(keys("zcrank:*"), [], "the picker failed before anything was written");
  }

  console.log("pty: `crank tui` runs the dashboard on the project's tab; t toggles and q quits; a dead Redis refuses to open");
  {
    reset();
    setTabs("Alpha Project");
    const r = onPty(["crank", "tui"], [
      { wait: "Next run", send: "t" },
      { wait: "● ON" },
      { wait: "pj crank enable", send: "q" },
    ], { path: withZellij });
    assert.equal(r.timedOut, false, r.output);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /tab Alpha Project/);
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "enabled"), "1", "the toggle in the terminal landed in Redis");
    assert.match(rs.cli("LRANGE", "zcrank:log:Alpha Project", "0", "-1"), /pj crank enable/);

    reset();
    const outside = onPty(["crank", "tui"], [{ wait: "not inside" }], { cwd: nowhere });
    assert.equal(outside.status, 1, outside.output);
    assert.match(outside.output, /not inside a pjangler project/, "on a terminal, a missing project is reported before Redis is considered");

    const dead = onPty(["crank", "tui"], [{ wait: "answering" }], { env: { ZCRANK_REDIS_PORT: "1" } });
    assert.equal(dead.status, 1, dead.output);
    assert.match(dead.output, /Redis is not answering at 127\.0\.0\.1:1/);
    assert.equal(dead.output.includes("Next run"), false, "the dashboard never opened");
  }
} catch (error) {
  failed = error;
} finally {
  await rs.stop();
  rmSync(workspace, { recursive: true, force: true });
}
if (failed) throw failed;
console.log("\nPJAN-184 crank CLI regressions: all green");
