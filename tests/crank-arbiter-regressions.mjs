import "./helpers/hermetic-suite.mjs";
// pjangler's crank store speaks to the crank ARBITER (crank.lua, a Redis Functions library) and
// to nothing else: every write is ONE `FCALL crank_apply 0 <ops_json> pj`, and every on/off +
// interval verdict is `FCALL_RO crank_resolve`. This suite pins, against a real throwaway
// redis-server with the arbiter loaded (never 6379):
//   - batching: each pj command's writes are exactly one FCALL, never a bare HSET/RPUSH/DEL/RENAME;
//   - the log rows are the arbiter's, written only when a value really changed (an idempotent
//     enable writes nothing), with pj's own action strings;
//   - the rule is the arbiter's: pane override over tab, any OFF wins, longest interval wins;
//   - the edges come back as a list even when cjson encodes an empty one as {};
//   - "Function not found": `zcrankctl arbiter-load` once and one retry, else an error naming the fix;
//   - a failed write never reads as success.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { vendoredArbiterCode } from "./helpers/crank-arbiter.mjs";
import { startThrowawayRedis } from "./pjan-182-crank-regressions-helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "crank-arbiter-"));
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
writeFileSync(join(workspace, "entry.ts"), `export * from ${JSON.stringify(join(root, "src/crank/index.ts"))};\n`);
const kitOut = join(workspace, "kit.mjs");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [join(workspace, "entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", "--sourcemap=inline", `--outfile=${kitOut}`],
  { encoding: "utf8", env: hermeticEnv() },
);
if (built.status !== 0) {
  console.error(`failed to bundle the crank kit:\n${built.stderr}`);
  process.exit(1);
}
const { ARGV_LIMIT_BYTES, defaultShell, buildCrankContext, crankTimestamp, disableCrank, enableCrank, redis, setCrankInterval, storedTabKeys, storedTabRoots, snapshotCrank, keysNamingTab } = await import(kitOut);

const rs = await startThrowawayRedis();
const bare = await startThrowawayRedis({ arbiter: false });
const row = (ts, state, action = "") => JSON.stringify({ ts, state, action });
let failed;

/** A Shell that runs the real redis-cli and records every command line (zcrankctl is its own seam). */
function recordingShell(calls, { zcrankctl } = {}) {
  return (command, args, options) => {
    calls.push([command, ...args].join(" "));
    if (command === "zcrankctl") return zcrankctl ? zcrankctl(args) : { stdout: "", status: 127 };
    const r = spawnSync(command, args, { encoding: "utf8", env: hermeticEnv(), input: options?.input });
    if (r.error) return { stdout: "", status: 127, errorCode: r.error.code };
    return { stdout: r.stdout ?? "", status: r.status ?? 1, stderr: r.stderr ?? "" };
  };
}
const fcalls = (calls) => calls.filter((c) => /\bFCALL(_RO)? /.test(c) && !/--help/.test(c));
const writes = (calls) => calls.filter((c) => / (HSET|RPUSH|LTRIM|DEL|RENAME|SET|HDEL) /.test(c));
const flush = (server) => server.cli("FLUSHALL");
const log = (server, key) => server.cli("LRANGE", `zcrank:log:${key}`, "0", "-1").split("\n").filter(Boolean).map((r) => JSON.parse(r));

try {
  console.log("enable: one FCALL carries enabled + interval + root + the rename migration + the renamed row");
  {
    flush(rs);
    rs.cli("HSET", "zcrank:tab:GreenInBetween", "enabled", "0", "interval", "6h");
    rs.cli("RPUSH", "zcrank:log:GreenInBetween", row("2026-10-20T10:00:00Z", "sent", "old-1"));
    rs.cli("HSET", "zcrank:tab:green-in-between", "enabled", "0");
    rs.cli("SET", "zcrank:pane:GreenInBetween:terminal_3", "0");
    const calls = [];
    const store = redis({ port: rs.port, shell: recordingShell(calls) });
    const ctx = buildCrankContext({ name: "green in between", agents: [] }, [{ name: "green-in-between", position: 0 }], storedTabKeys(store), { identity: "/repos/gib", roots: {} });
    calls.length = 0;
    const result = enableCrank(store, ctx, { now: new Date("2026-10-30T00:00:00Z") });
    assert.deepEqual(result.renamed, [{ from: "GreenInBetween", to: "green-in-between" }]);
    const f = fcalls(calls);
    assert.equal(f.length, 1, `exactly one FCALL:\n${calls.join("\n")}`);
    assert.match(f[0], /FCALL crank_apply 0 \[.*\] pj$/);
    assert.deepEqual(writes(calls), [], "no bare write reaches Redis");
    assert.equal(rs.cli("HGET", "zcrank:tab:green-in-between", "enabled"), "1");
    assert.equal(rs.cli("HGET", "zcrank:tab:green-in-between", "root"), "/repos/gib");
    assert.equal(rs.cli("HGET", "zcrank:tab:green-in-between", "interval"), "6h", "the old key's interval is carried");
    assert.equal(rs.cli("EXISTS", "zcrank:tab:GreenInBetween"), "0");
    assert.equal(rs.cli("GET", "zcrank:pane:green-in-between:terminal_3"), "0", "an OFF pane override moves and stays OFF");
    assert.equal(rs.cli("EXISTS", "zcrank:pane:GreenInBetween:terminal_3"), "0");
    assert.deepEqual(log(rs, "green-in-between").map((r) => [r.state, r.action]), [
      ["sent", "old-1"],
      ["interval", "pj crank enable: interval 6h (carried from the old key)"],
      ["enabled", "pj crank enable"],
      ["renamed", "pj crank enable: GreenInBetween -> green-in-between"],
    ]);
  }

  console.log("an idempotent enable or disable changes nothing and writes no log row (the arbiter logs only real changes)");
  {
    flush(rs);
    const store = redis({ port: rs.port });
    const ctx = () => buildCrankContext({ name: "Holocene", agents: [] }, [], storedTabKeys(store), { identity: "/repos/holo", roots: storedTabRoots(store, storedTabKeys(store)) });
    enableCrank(store, ctx(), { now: new Date("2026-10-30T00:00:00Z") });
    enableCrank(store, ctx(), { now: new Date("2026-10-30T00:05:00Z") });
    assert.deepEqual(log(rs, "Holocene").map((r) => r.state), ["enabled"], "the second enable wrote nothing");
    disableCrank(store, "Holocene", new Date("2026-10-30T01:00:00Z"), "/repos/holo");
    disableCrank(store, "Holocene", new Date("2026-10-30T01:05:00Z"), "/repos/holo");
    assert.deepEqual(log(rs, "Holocene").map((r) => [r.state, r.action, r.ts]), [
      ["enabled", "pj crank enable", "2026-10-30T00:00:00Z"],
      ["disabled", "pj crank disable", "2026-10-30T01:00:00Z"],
    ]);
  }

  console.log("setCrankInterval: one FCALL; the other spellings lose their interval; reset logs the global it falls back to");
  {
    flush(rs);
    rs.cli("HSET", "zcrank:tab:Alpha", "enabled", "1", "interval", "1d");
    rs.cli("HSET", "zcrank:tab:alpha", "enabled", "1");
    rs.cli("HSET", "zcrank:config", "interval", "1h");
    const calls = [];
    const store = redis({ port: rs.port, shell: recordingShell(calls) });
    const keys = storedTabKeys(store);
    calls.length = 0;
    setCrankInterval(store, "alpha", keys, "6h", new Date("2026-10-30T00:00:00Z"), { root: "/repos/alpha" });
    assert.equal(fcalls(calls).length, 1);
    assert.deepEqual(writes(calls), []);
    assert.equal(rs.cli("HGET", "zcrank:tab:alpha", "interval"), "6h");
    assert.equal(rs.cli("HEXISTS", "zcrank:tab:Alpha", "interval"), "0", "the stale longer interval cannot beat the one just picked");
    assert.equal(rs.cli("HGET", "zcrank:tab:alpha", "root"), "/repos/alpha");
    assert.equal(log(rs, "alpha").at(-1).action, "pj crank tui: interval 6h");
    setCrankInterval(store, "alpha", keys, undefined, new Date("2026-10-30T00:10:00Z"));
    assert.equal(rs.cli("HEXISTS", "zcrank:tab:alpha", "interval"), "0");
    assert.equal(log(rs, "alpha").at(-1).action, "pj crank tui: interval reset to global (1h)");
  }

  console.log("the rule is the arbiter's: pane override beats tab, any OFF wins, longest interval wins, unlisted is OFF");
  {
    flush(rs);
    const store = redis({ port: rs.port });
    assert.deepEqual(store.resolve({ keys: [] }), { on: false, decidedBy: "unlisted", interval: "5m", inherited: true });
    rs.cli("HSET", "zcrank:tab:Tab", "enabled", "1", "interval", "1h");
    rs.cli("HSET", "zcrank:tab:tab", "enabled", "1", "interval", "6h");
    assert.deepEqual(store.resolve({ keys: ["Tab", "tab"] }), { on: true, decidedBy: "tab", interval: "6h", inherited: false });
    rs.cli("HSET", "zcrank:tab:tab", "enabled", "0");
    assert.equal(store.resolve({ keys: ["Tab", "tab"] }).on, false, "any OFF wins");
    rs.cli("HSET", "zcrank:tab:tab", "enabled", "1");
    rs.cli("SET", "zcrank:pane:Tab:terminal_9", "0");
    assert.deepEqual(store.resolve({ keys: ["Tab", "tab"], owners: ["Tab", "tab"], pane: "terminal_9" }).decidedBy, "pane");
    assert.equal(store.resolve({ keys: ["Tab", "tab"], owners: ["Tab", "tab"], pane: "terminal_9" }).on, false, "a pane override OFF beats the tab ON");
    assert.equal(store.resolve({ keys: ["Tab", "tab"], owners: ["Tab", "tab"], pane: "terminal_8" }).decidedBy, "tab", "another pane follows the tab");
    const snap = snapshotCrank(store, "tab", storedTabKeys(store), Date.parse("2026-10-30T00:00:00Z"));
    assert.equal(snap.enabled, true);
    assert.deepEqual([snap.interval, snap.inherited, snap.global], ["6h", false, "5m"]);
    assert.equal(snapshotCrank(store, "nothing", storedTabKeys(store), 0).enabled, undefined, "no key at all: unlisted, not OFF");
    assert.deepEqual(keysNamingTab("tab", storedTabKeys(store)), ["tab", "Tab"]);
  }

  console.log("edges: a toggle that flips a resolved pane returns the edge as a list; one that flips nothing returns []");
  {
    flush(rs);
    const store = redis({ port: rs.port });
    store.apply([{ op: "tab", key: "Edge", enabled: true }]);
    // the engine's scan creates the pane's resolved hash (crank_scan, the same Lua)
    const scan = JSON.stringify({ session: "Workspace", panes: [{ pane: "terminal_5", tab: "Edge", tab_key: "edge", keys: ["Edge"], owners: ["Edge"] }] });
    rs.cli("FCALL", "crank_scan", "0", scan, "test");
    assert.equal(rs.cli("HGET", "crank:p:Workspace:terminal_5", "on"), "1");
    const off = store.apply([{ op: "tab", key: "Edge", enabled: false }]);
    assert.equal(off.changed, 1);
    assert.deepEqual(off.results, [true]);
    assert.equal(off.edges.length, 1);
    assert.equal(rs.cli("HGET", "crank:p:Workspace:terminal_5", "on"), "0", "the arbiter re-resolved the pane in the same call");
    const again = store.apply([{ op: "tab", key: "Edge", enabled: false }]);
    assert.deepEqual(again, { changed: 0, results: [false], edges: [] }, "cjson's {} for an empty list reads as []");
    assert.deepEqual(store.apply([]), { changed: 0, results: [], edges: [] }, "no ops, no call");
  }

  console.log("Function not found: zcrankctl arbiter-load once, one retry; without it, an error that names the fix");
  {
    // no zcrankctl on PATH (127): the error says what to run
    const calls = [];
    const store = redis({ port: bare.port, shell: recordingShell(calls) });
    assert.throws(() => store.apply([{ op: "tab", key: "X", enabled: true }]), (e) => {
      assert.match(e.message, /the crank arbiter is not loaded in Redis at 127\.0\.0\.1:\d+ \(crank_apply: function not found\)/);
      assert.match(e.message, /run `zcrankctl arbiter-load`/);
      return true;
    });
    assert.equal(calls.filter((c) => c.startsWith("zcrankctl")).length, 1, "tried zcrankctl exactly once");
    assert.equal(bare.cli("EXISTS", "zcrank:tab:X"), "0", "nothing was written");
    // and a read says the same
    assert.throws(() => store.resolve({ keys: ["X"] }), /run `zcrankctl arbiter-load`/);
    assert.equal(calls.filter((c) => c.startsWith("zcrankctl")).length, 1, "once per store, not once per call");

    // a zcrankctl that loads the library: the call is retried and lands
    const loading = [];
    const healed = redis({
      port: bare.port,
      shell: recordingShell(loading, {
        zcrankctl: (args) => {
          assert.deepEqual(args, ["arbiter-load"]);
          const r = spawnSync("redis-cli", ["--raw", "-h", "127.0.0.1", "-p", String(bare.port), "FUNCTION", "LOAD", "REPLACE", vendoredArbiterCode()], { encoding: "utf8", env: hermeticEnv() });
          return { stdout: r.stdout, status: r.status ?? 1 };
        },
      }),
    });
    const result = healed.apply([{ op: "tab", key: "Healed", enabled: true }]);
    assert.equal(result.changed, 1);
    assert.equal(bare.cli("HGET", "zcrank:tab:Healed", "enabled"), "1");
    assert.equal(loading.filter((c) => c.startsWith("zcrankctl")).length, 1);
    assert.equal(fcalls(loading).length, 2, "the FCALL that failed, then the retry");

    // a zcrankctl that cannot load it: still the named error, no loop
    flush(bare);
    bare.cli("FUNCTION", "FLUSH");
    const broken = [];
    const stuck = redis({ port: bare.port, shell: recordingShell(broken, { zcrankctl: () => ({ stdout: "", status: 1 }) }) });
    assert.throws(() => stuck.apply([{ op: "tab", key: "X", enabled: true }]), /run `zcrankctl arbiter-load`/);
    assert.equal(fcalls(broken).length, 1, "no retry when the load failed");
  }

  console.log("a failed write never reads as success: a dead Redis and an unknown op both throw");
  {
    const gone = redis({ port: 1 });
    assert.throws(() => gone.apply([{ op: "tab", key: "x", enabled: true }]), /Redis is not answering at 127\.0\.0\.1:1/);
    assert.throws(() => gone.resolve({ keys: ["x"] }), /not answering/);
    const store = redis({ port: rs.port });
    assert.throws(() => store.apply([{ op: "nope" }]), /Redis error reply at .*unknown op nope at 1/);
  }
  console.log("a rename that merges a log past Linux's 128 KiB per-argument limit still lands, in ONE atomic FCALL (pjangler-4)");
  {
    flush(rs);
    // 400 rows of ~600 bytes: the merged replace_log op alone is ~250 KB, which no single argv string can carry
    const bigRows = Array.from({ length: 400 }, (_, i) => row(`2026-10-${String(1 + (i % 28)).padStart(2, "0")}T10:${String(i % 60).padStart(2, "0")}:00Z`, "checked", `${i}-${"x".repeat(520)}`));
    rs.cli("HSET", "zcrank:tab:GreenInBetween", "enabled", "0");
    for (let i = 0; i < bigRows.length; i += 50) rs.cli("RPUSH", "zcrank:log:GreenInBetween", ...bigRows.slice(i, i + 50));
    const calls = [];
    const store = redis({ port: rs.port, shell: recordingShell(calls) });
    const ctx = buildCrankContext({ name: "green in between", agents: [] }, [{ name: "green-in-between", position: 0 }], storedTabKeys(store), { identity: "/repos/gib", roots: {} });
    calls.length = 0;
    const result = enableCrank(store, ctx, { now: new Date("2026-10-30T00:00:00Z") });
    assert.deepEqual(result.renamed, [{ from: "GreenInBetween", to: "green-in-between" }]);
    const f = fcalls(calls);
    assert.equal(f.length, 1, "still exactly one FCALL: atomic");
    assert.ok(f.every((c) => c.length < ARGV_LIMIT_BYTES), "no argv string anywhere near the 128 KiB limit");
    assert.equal(rs.cli("EXISTS", "zcrank:log:GreenInBetween"), "0", "the old log is dropped");
    assert.equal(rs.cli("HGET", "zcrank:tab:green-in-between", "enabled"), "1");
    const merged = log(rs, "green-in-between");
    assert.equal(merged.filter((r) => r.state === "checked").length, 400, "every merged row survived, byte for byte");
    assert.equal(merged.at(-1).state, "renamed", "the renamed row still lands after the merge");
    assert.deepEqual(merged.filter((r) => r.state === "checked").map((r) => r.action), bigRows.map((r) => JSON.parse(r)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).map((r) => r.action));
    // a small payload keeps the plain argv path (the wire format the other suites pin)
    const small = [];
    redis({ port: rs.port, shell: recordingShell(small) }).apply([{ op: "tab", key: "tiny", enabled: true }]);
    assert.match(fcalls(small)[0], /FCALL crank_apply 0 \[.*\] pj$/);
    assert.doesNotMatch(fcalls(small)[0], /-X/);
  }

  console.log("defaultShell says WHY it could not run a command: the spawn error's code, not a collapsed 127 (pjangler-4)");
  {
    const huge = defaultShell("true", ["x".repeat(200_000)]);
    assert.equal(huge.status, 127);
    assert.equal(huge.errorCode, "E2BIG", "an over-long argument is E2BIG");
    const missing = defaultShell("pjangler-no-such-binary", []);
    assert.deepEqual([missing.status, missing.errorCode], [127, "ENOENT"]);
    assert.equal(defaultShell("true", []).errorCode, undefined, "a command that ran has no error code");
    const e2big = redis({ port: rs.port, shell: (command, args, options) => (args.includes("--help") ? defaultShell(command, args) : defaultShell("true", ["x".repeat(200_000)], options)) });
    assert.throws(() => e2big.apply([{ op: "tab", key: "x", enabled: true }]), (e) => /E2BIG/.test(e.message) && /argument list is too long/.test(e.message) && !/not answering/.test(e.message));
    const noCli = redis({ port: rs.port, shell: (command, args) => (args.includes("--help") ? { stdout: "", status: 127, errorCode: "ENOENT" } : { stdout: "", status: 127, errorCode: "ENOENT" }) });
    assert.throws(() => noCli.logRows("x"), /redis-cli is not installed/);
  }
} catch (error) {
  failed = error;
} finally {
  await rs.stop();
  await bare.stop();
  rmSync(workspace, { recursive: true, force: true });
}
if (failed) throw failed;
console.log("\ncrank arbiter store regressions: all green");
