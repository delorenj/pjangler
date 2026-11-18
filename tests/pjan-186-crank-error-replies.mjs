import "./helpers/hermetic-suite.mjs";
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
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
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
  { encoding: "utf8", env: hermeticEnv() },
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
    throws(() => store.tabRoot("victim"), new RegExp(`^Redis error reply at 127\\.0\\.0\\.1:${rs.port}: ${WT} \\(HGET zcrank:tab:victim root\\)$`));
    // the rule is the arbiter's, and the arbiter reads with pcall (jev-clairic engine-4, 2026-11-18): a
    // wrong-typed registry key is ABSENT to the rule (not "1"), so that tab reads closed and one
    // malformed key no longer fails every pane's resolve. The error reply is not swallowed for the
    // operator's own reads above (tabRoot/tabInterval/getKey/logRows still throw).
    const closed = store.resolve({ keys: ["victim"] });
    assert.equal(closed.on, false, "a wrong-typed tab key is not ON");
    assert.equal(closed.decidedBy, "tab", "listed but unreadable: decided off by the tab rule");
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
    throws(() => store.apply([{ op: "tab", key: "victim", enabled: true }]), /WRONGTYPE Operation against .* \(FCALL crank_apply 0 \[\{"op":"tab","key":"victim","enabled":true\}\] pj\)$/);
    throws(() => store.apply([{ op: "tab", key: "victim", interval: "1h" }]), /WRONGTYPE Operation against .* \(FCALL crank_apply 0 /);
    throws(() => store.apply([{ op: "log", key: "victim", row: "{}" }]), /WRONGTYPE Operation against .* \(FCALL crank_apply 0 /);
    assert.equal(rcli("TYPE", "zcrank:tab:victim"), "string", "the rejected write changed nothing");
    assert.equal(rcli("GET", "zcrank:tab:victim"), "untouched", "the value survived byte for byte");
    assert.equal(rcli("TYPE", "zcrank:log:victim"), "string", "the rejected log write created no list");
    assert.equal(rcli("LLEN", "zcrank:log:victim").trim(), "WRONGTYPE Operation against a key holding the wrong kind of value", "no log list was minted next to the string");
  }

  console.log("AC1: an error reply to crank_apply on the Shell seam (a real -e redis-cli: reply on stderr, exit 1) throws, naming the call");
  {
    const fake = (command, args) => {
      if (command !== "redis-cli") return { stdout: "", status: 127 };
      if (args[0] === "--help") return { stdout: "Usage: redis-cli [OPTIONS]\n  -e                 Return exit error code when command execution fails.\n", status: 0 };
      if (args[6] === "FCALL") return { stdout: "", status: 1, stderr: "ERR crank_apply: unknown op nope at 1\n" };
      return { stdout: "OK\n", status: 0 };
    };
    const store = redis({ shell: fake });
    throws(() => store.apply([{ op: "log", key: "T", row: "{}" }]), /^Redis error reply at 127\.0\.0\.1:6379: ERR crank_apply: unknown op nope at 1 \(FCALL crank_apply 0 /);
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
    assert.equal(rcli("HGET", "zcrank:tab:errtab", "enabled"), "ERR no such key", "a hash field may hold error-shaped text");
    assert.equal(JSON.parse(store.logRows("errlog")[0]).action, "(error) WRONGTYPE ERR all at once");
    assert.ok(store.tabKeys().includes("zcrank:tab:ERRnope"), "a key named like an error still lists");
    // and an error-shaped write round-trips through the arbiter: a pane override value is stored verbatim
    store.apply([{ op: "log", key: "errlog", row: "ERR no such key" }]);
    assert.equal(store.logRows("errlog").at(-1), "ERR no such key");
  }

  console.log("AC3: 'not answering' and 'error reply' are different messages, both keeping the endpoint");
  {
    const dead = redis({ port: 1 });
    throws(() => dead.getKey("x"), /^Redis is not answering at 127\.0\.0\.1:1 \(GET failed\)$/);
    const store = redis({ port: rs.port });
    clean("zcrank:tab:victim");
    rcli("SET", "zcrank:tab:victim", "x");
    throws(() => store.tabRoot("victim"), /^Redis error reply at 127\.0\.0\.1:\d+: WRONGTYPE Operation against .* \(HGET zcrank:tab:victim root\)$/);
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

  // The CLI end-to-end cases (AC4: crank log/list/enable/disable/tui on the tab registry) were
  // retired with the tab model in PJAN-214; crank v2 keeps no crank state in this store.
} catch (error) {
  failed = error;
} finally {
  await rs.stop();
  rmSync(workspace, { recursive: true, force: true });
}
if (failed) throw failed;
console.log("\nPJAN-186 crank error-reply regressions: all green");
