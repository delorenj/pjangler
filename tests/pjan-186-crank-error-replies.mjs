// PJAN-186 — a Redis error reply must throw, never pose as a value or a successful write.
//
// `redis-cli --raw` prints a server error reply (WRONGTYPE, ERR no such key, ...) on STDOUT
// and exits 0, so the pre-fix store returned the error text as if it were the value: reads
// showed "WRONGTYPE ..." as a tab's enabled flag and log rows, and writes that the server
// rejected "succeeded". The fix sends -e (exit non-zero on an error reply, reply on stderr),
// classifies redis-cli's own failures as "not answering", and refuses an redis-cli too old
// to know -e. Pinned here, unit level against a REAL throwaway redis-server and end to end
// through the built CLI.
//
// Two replies cannot be reached through the public store against a real server (LTRIM only
// fails after RPUSH already has, RENAME only on a scratch key the store itself just pushed):
// those two go through the Shell seam, faked to behave exactly like a real `redis-cli -e`
// (verified against redis-cli 8.0.2: reply text on stderr, exit 1).
//
// HARD RULE: nothing here touches 127.0.0.1:6379 (the live crank engine's Redis). Every
// redis-cli call passes the throwaway server's -p PORT, and nothing runs FLUSHALL: keys are
// deleted by exact name on a server that exists only for this run.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startThrowawayRedis } from "./pjan-182-crank-regressions-helpers.mjs";
import { runOnPty } from "./helpers/pty-run.mjs";

const root = resolve(import.meta.dirname, "..");
const pj = join(root, "dist", "index.js");
assert.ok(existsSync(pj), "dist/index.js missing: run `npm run build` first");
assert.ok(existsSync(join(root, "dist", "crank", "tui.js")), "dist/crank/tui.js missing: run `npm run build` first");

// --- unit kit: the store bundled with an inline source map (c8 counts src/ lines) --------
const workspace = mkdtempSync(join(tmpdir(), "pjan-186-units-"));
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
writeFileSync(
  join(workspace, "entry.ts"),
  `export { redis } from ${JSON.stringify(join(root, "src/crank/index.ts"))};\n`,
);
const kitOut = join(workspace, "kit.mjs");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [join(workspace, "entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", "--sourcemap=inline", `--outfile=${kitOut}`],
  { encoding: "utf8" },
);
if (built.status !== 0) {
  console.error(`failed to bundle the units kit:\n${built.stderr}`);
  process.exit(1);
}
const { redis } = await import(kitOut);

const rs = await startThrowawayRedis();
const rcli = (...args) => rs.cli(...args);
/** assert.throws-style, but matching error.message (Node's regex form matches toString). */
const throws = (fn, re, what = "expected a throw") => {
  try {
    fn();
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), re, what);
    return;
  }
  assert.fail(`${what}: no throw`);
};
let failed;
try {
  /** Every non-empty key this suite touches, so a section never sees the last one's keys. */
  const clean = (...keys) => { for (const k of keys) rcli("DEL", k); };

  console.log("AC1: every read of a wrong-typed key throws, showing the reply, the endpoint and the command");
  {
    clean("zcrank:tab:victim", "zcrank:log:victim", "zcrank:pane:victim");
    rcli("SET", "zcrank:tab:victim", "a plain string, not a hash");
    rcli("SET", "zcrank:log:victim", "a plain string, not a list");
    rcli("RPUSH", "zcrank:pane:victim", "a list, not a string");
    const store = redis({ port: rs.port });
    const WT = "WRONGTYPE Operation against a key holding the wrong kind of value";
    throws(() => store.tabEnabled("victim"), new RegExp(`^Redis error reply at 127\\.0\\.0\\.1:${rs.port}: ${WT} \\(HGET zcrank:tab:victim enabled\\)$`));
    throws(() => store.tabInterval("victim"), /WRONGTYPE Operation against .* \(HGET zcrank:tab:victim interval\)$/);
    throws(() => store.getKey("zcrank:pane:victim"), /WRONGTYPE Operation against .* \(GET zcrank:pane:victim\)$/);
    throws(() => store.logRows("victim"), /WRONGTYPE Operation against .* \(LRANGE zcrank:log:victim 0 -1\)$/);
  }

  console.log("AC1: every write to a wrong-typed key throws, and nothing landed");
  {
    clean("zcrank:tab:victim", "zcrank:log:victim");
    rcli("SET", "zcrank:tab:victim", "untouched");
    rcli("SET", "zcrank:log:victim", "untouched");
    const store = redis({ port: rs.port });
    throws(() => store.setTabEnabled("victim", true), /WRONGTYPE Operation against .* \(HSET zcrank:tab:victim enabled 1\)$/);
    throws(() => store.setTabInterval("victim", "1h"), /WRONGTYPE Operation against .* \(HSET zcrank:tab:victim interval 1h\)$/);
    throws(() => store.pushLog("victim", "enabled", "pj crank enable", "2026-10-28T00:00:00Z"), /WRONGTYPE Operation against .* \(RPUSH zcrank:log:victim /);
    assert.equal(rcli("TYPE", "zcrank:tab:victim"), "string", "the rejected HSET changed nothing");
    assert.equal(rcli("GET", "zcrank:tab:victim"), "untouched", "the value survived byte for byte");
    assert.equal(rcli("TYPE", "zcrank:log:victim"), "string", "the rejected RPUSH created no list");
    assert.equal(rcli("LLEN", "zcrank:log:victim").trim(), "WRONGTYPE Operation against a key holding the wrong kind of value", "no log list was minted next to the string");
  }

  console.log("AC1: LTRIM on a wrong-typed key and RENAME of a missing key throw (Shell seam, mirroring real `redis-cli -e`)");
  {
    // A real -e redis-cli answers these with the reply on stderr and exit 1; a real server
    // cannot reach them through the public store (RPUSH would fail first / the scratch key
    // was just pushed), so the seam reproduces the verified real behaviour.
    const fake = (command, args) => {
      if (command !== "redis-cli") return { stdout: "", status: 127 };
      if (args[0] === "--help") return { stdout: "Usage: redis-cli [OPTIONS]\n  -e                 Return exit error code when command execution fails.\n", status: 0 };
      const op = args[6];
      if (op === "RPUSH") return { stdout: "1\n", status: 0 };
      if (op === "LTRIM") return { stdout: "", status: 1, stderr: "WRONGTYPE Operation against a key holding the wrong kind of value\n" };
      if (op === "RENAME") return { stdout: "", status: 1, stderr: "ERR no such key\n" };
      if (op === "PING") return { stdout: "PONG\n", status: 0 };
      return { stdout: "OK\n", status: 0 };
    };
    const store = redis({ shell: fake });
    throws(() => store.pushLog("T", "enabled", "a", "2026-10-28T00:00:00Z"), /WRONGTYPE Operation against .* \(LTRIM zcrank:log:T -500 -1\)$/);
    throws(() => store.replaceLog("T", ["row"]), /ERR no such key \(RENAME zcrank:logtmp:\S+ zcrank:log:T\)$/);
  }

  console.log("AC1: ping() keeps its meaning — true only on PONG");
  {
    assert.equal(redis({ port: rs.port }).ping(), true);
    assert.equal(redis({ port: 1 }).ping(), false, "a dead port is a false, not a throw");
  }

  console.log("AC2: values that legitimately begin with ERR / WRONGTYPE / (error) still read back as values");
  {
    clean("zcrank:pane:err", "zcrank:tab:errtab", "zcrank:log:errlog", "zcrank:tab:ERRnope");
    rcli("SET", "zcrank:pane:err", "WRONGTYPE Operation against a key holding the wrong kind of value");
    rcli("SET", "zcrank:pane:err2", "ERR no such key");
    rcli("HSET", "zcrank:tab:errtab", "enabled", "ERR no such key");
    rcli("RPUSH", "zcrank:log:errlog", JSON.stringify({ ts: "2026-10-28T00:00:00Z", state: "sent", action: "(error) WRONGTYPE ERR all at once" }));
    rcli("HSET", "zcrank:tab:ERRnope", "enabled", "1");
    const store = redis({ port: rs.port });
    assert.equal(store.getKey("zcrank:pane:err"), "WRONGTYPE Operation against a key holding the wrong kind of value");
    assert.equal(store.getKey("zcrank:pane:err2"), "ERR no such key");
    assert.equal(store.tabEnabled("errtab"), "ERR no such key", "a hash field may hold error-shaped text");
    assert.equal(JSON.parse(store.logRows("errlog")[0]).action, "(error) WRONGTYPE ERR all at once");
    assert.ok(store.tabKeys().includes("zcrank:tab:ERRnope"), "a key named like an error still lists");
    // and the error-shaped writes round-trip: setKey on the pane key, HSET via the store
    store.setKey("zcrank:pane:err", "ERR no such key");
    assert.equal(store.getKey("zcrank:pane:err"), "ERR no such key");
  }

  console.log("AC3: 'not answering' and 'error reply' are different messages, both keeping the endpoint");
  {
    const dead = redis({ port: 1 });
    throws(() => dead.getKey("x"), /^Redis is not answering at 127\.0\.0\.1:1 \(GET failed\)$/);
    const store = redis({ port: rs.port });
    clean("zcrank:tab:victim");
    rcli("SET", "zcrank:tab:victim", "x");
    throws(() => store.tabEnabled("victim"), /^Redis error reply at 127\.0\.0\.1:\d+: WRONGTYPE Operation against .* \(HGET zcrank:tab:victim enabled\)$/);
    // a server that dies mid-command (answers PING, drops the rest) is still "not answering":
    // redis-cli prints its own "Error: ..." on stderr, which is not a reply
    const dropped = (command, args) => {
      if (args[0] === "--help") return { stdout: "Usage: redis-cli\n  -e x\n", status: 0 };
      if (args.includes("PING")) return { stdout: "PONG\n", status: 0 };
      return { stdout: "", status: 1, stderr: "Error: Server closed the connection\n" };
    };
    throws(() => redis({ shell: dropped }).getKey("x"), /^Redis is not answering at 127\.0\.0\.1:6379 \(GET failed\)$/);
  }

  console.log("AC5: a redis-cli whose --help lacks -e is refused by name, not silently regressed");
  {
    const oldFake = (command, args) => {
      if (command !== "redis-cli") return { stdout: "", status: 127 };
      if (args[0] === "--help") return { stdout: "Usage: redis-cli [OPTIONS] [cmd [arg [arg ...]]]\n  -h <hostname>      Server hostname (default: 127.0.0.1).\n", status: 0 };
      return { stdout: "PONG\n", status: 0 };
    };
    const store = redis({ shell: oldFake });
    throws(() => store.ping(), /redis-cli is too old for the crank store at 127\.0\.0\.1:6379: no -e flag \(needs redis-tools >= 6\.2\)/);
    throws(() => store.getKey("x"), /redis-cli is too old /, "every use refuses, not just ping");
  }

  // -------------------------------------------------------------------------
  // End to end: the built CLI turns a store error into one ✖ line and exit 1
  // -------------------------------------------------------------------------

  const which = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  const bin = join(workspace, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["env", "timeout", "redis-cli", "cat"]) symlinkSync(which(tool), join(bin, tool));
  const alpha = join(workspace, "repos", "alpha");
  mkdirSync(alpha, { recursive: true });
  writeFileSync(join(alpha, ".project.json"), JSON.stringify({ project_id: "alpha", project_name: "Alpha Project" }));
  const registry = join(workspace, "registry.yaml");
  writeFileSync(registry, `schema_version: 1\nprojects:\n  alpha:\n    name: Alpha Project\n    slug: alpha\n    repo_path: ${alpha}\n    source_artifacts: []\n    ticket_provider: {}\n    agents: {}\n`);
  const baseEnv = {
    PATH: bin,
    HOME: workspace,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    GIT_CEILING_DIRECTORIES: workspace,
    NO_COLOR: "1",
    ZCRANK_REDIS_HOST: "127.0.0.1",
    ZCRANK_REDIS_PORT: String(rs.port),
    PJ_PROJECT_REGISTRY: registry,
    ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
  };
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [pj, ...args], { cwd: alpha, encoding: "utf8", timeout: 30_000, env: { ...baseEnv, ...env } });
  const TAB = "zcrank:tab:Alpha Project";
  const LOG = "zcrank:log:Alpha Project";

  console.log("AC4: crank log — a wrong-typed log key is one ✖ line and exit 1, never rows");
  {
    clean(TAB, LOG);
    rcli("SET", LOG, "a plain string, not a list");
    const out = run(["crank", "log"]);
    assert.equal(out.status, 1, out.stderr);
    const lines = out.stderr.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `one line, not a stack trace:\n${out.stderr}`);
    assert.match(lines[0], /^✖ Redis error reply at 127\.0\.0\.1:\d+: WRONGTYPE Operation against .* \(LRANGE zcrank:log:Alpha Project 0 -1\)$/);
    assert.equal(out.stdout, "", "no rows were shown as data");
  }

  console.log("AC4: crank list — a wrong-typed tab key fails the report instead of printing it");
  {
    clean(TAB, LOG);
    rcli("SET", TAB, "a plain string, not a hash");
    const out = run(["crank", "list"]);
    assert.equal(out.status, 1, out.stderr);
    const lines = out.stderr.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `one line:\n${out.stderr}`);
    assert.match(lines[0], /^✖ crank list failed: Redis error reply at 127\.0\.0\.1:\d+: WRONGTYPE Operation against .* \(HGET zcrank:tab:Alpha Project enabled\)$/);
    assert.equal(out.stdout, "", "no half report was printed");
  }

  console.log("AC4: crank enable / enable --interval / disable — a rejected write is a ✖, never ON or OFF");
  {
    for (const args of [["enable", "--interval", "1h"], ["enable"], ["disable"]]) {
      clean(TAB, LOG);
      rcli("SET", TAB, "a plain string, not a hash");
      const out = run(["crank", ...args]);
      assert.equal(out.status, 1, `${args.join(" ")}: ${out.stderr}`);
      const lines = out.stderr.split("\n").filter(Boolean);
      assert.equal(lines.length, 1, `${args.join(" ")}: one line:\n${out.stderr}`);
      assert.match(lines[0], /^✖ crank failed: Redis error reply at 127\.0\.0\.1:\d+: WRONGTYPE Operation against /);
      assert.equal(out.stdout, "", `${args.join(" ")}: no ON/OFF line for a write that did not land`);
      assert.equal(rcli("TYPE", TAB), "string", `${args.join(" ")}: the key was not minted into a hash`);
    }
  }

  console.log("AC4: crank tui — a store error at open is the CLI's ✖, not an Ink crash frame");
  {
    clean(TAB, LOG);
    rcli("SET", TAB, "a plain string, not a hash");
    const r = runOnPty({
      argv: [process.execPath, pj, "crank", "tui"],
      cwd: alpha,
      env: { ...baseEnv, TERM: "xterm-256color" },
      steps: [{ wait: "Redis error reply" }],
      timeout: 20_000,
      settleMs: 1500,
    });
    assert.equal(r.timedOut, false, r.output);
    assert.equal(r.status, 1, r.output);
    const lines = r.output.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1, `one line, no Ink error frame:\n${r.output}`);
    assert.match(lines[0], /✖ crank tui failed: Redis error reply at 127\.0\.0\.1:\d+: WRONGTYPE Operation against .* \(HGET zcrank:tab:Alpha Project enabled\)/);
    assert.ok(!r.output.includes("dist/index.js"), "no source excerpt");
    assert.ok(!r.output.includes("Next run"), "the dashboard never opened");
  }
} catch (error) {
  failed = error;
} finally {
  await rs.stop();
  rmSync(workspace, { recursive: true, force: true });
}
if (failed) throw failed;
console.log("\nPJAN-186 crank error-reply regressions: all green");
