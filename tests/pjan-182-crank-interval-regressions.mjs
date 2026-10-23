// PJAN-182 — crank intervals, the rename migration, and the first Ink screens.
//
// What can silently go wrong, and so what is pinned here:
//   - the due / next-run math is a CONTRACT with zcrank.py (GRACE, always-due 5m, longest
//     interval across spellings, beat-row filtering): off by one tick and a 1h tab either
//     fires at 65m or hammers every 5m;
//   - the rename migration DELETES keys: it must remove the old spellings of THIS tab and
//     nothing a sibling tab (colon head, prefix) owns;
//   - the Ink screens must render real state and drive real writes.
//
// HARD RULE: nothing here touches the real Redis on 6379 (the live crank engine reads it
// every five minutes). Every write goes to a throwaway `redis-server` on a free port,
// reached through ZCRANK_REDIS_PORT. No fixtures stand in for Redis; only zellij's live-tab
// list is injected (there is no zellij to fake on a cold machine).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeStdin, FakeStdout, startThrowawayRedis, waitFor } from "./pjan-182-crank-regressions-helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pjan-182-"));
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");

// --- bundle the SOURCES (never a stale dist) into one kit ---------------------------------
import { writeFileSync } from "node:fs";
writeFileSync(
  join(workspace, "kit-entry.ts"),
  [
    `export * from ${JSON.stringify(join(root, "src/crank/index.ts"))};`,
    `export * from ${JSON.stringify(join(root, "src/crank/controller.ts"))};`,
    `export * from ${JSON.stringify(join(root, "src/crank/tui.tsx"))};`,
    `export * from ${JSON.stringify(join(root, "src/tui/index.ts"))};`,
  ].join("\n"),
);
const kitOut = join(workspace, "kit.mjs");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [join(workspace, "kit-entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", "--jsx=automatic", `--outfile=${kitOut}`],
  { encoding: "utf8" },
);
if (built.status !== 0) {
  console.error(`failed to bundle the crank kit:\n${built.stderr}`);
  process.exit(1);
}
const kit = await import(kitOut);
const {
  applyRenameMigration, beatRows, buildCrankContext, buildCrankList, createCrankController, disableCrank, effectiveInterval,
  enableCrank, formatCrankList, formatDuration, isDue, lastRunMs, longestInterval, mergeLogRows, nextRunMs, parseInterval,
  planRenameMigration, redis, redisEndpoint, redisGlobEscape, setCrankInterval, snapshotCrank, storedTabKeys, tabDisplay,
  resolveTabForProject, pickInterval, runCrankDashboard, intervalOptions,
} = kit;

const T = (iso) => Date.parse(iso);
const row = (ts, state, action = "") => JSON.stringify({ ts, state, action });

// ---------------------------------------------------------------------------
// Pure contract math
// ---------------------------------------------------------------------------

console.log("interval parsing: only 5m|1h|6h|1d, garbage is absent");
{
  for (const ok of ["5m", "1h", "6h", "1d"]) assert.equal(parseInterval(ok), ok);
  for (const bad of ["", " ", "15m", "1H", "2d", "forever", "5", undefined, null]) assert.equal(parseInterval(bad), undefined, `${bad}`);
  assert.equal(parseInterval(" 1h "), "1h", "redis --raw padding is tolerated");
  assert.equal(longestInterval(["5m", "6h", "1h", "garbage"]), "6h");
  assert.equal(longestInterval([undefined, "nope"]), undefined);
}

console.log("effective interval: the longest set on any key wins, else the global default");
{
  assert.deepEqual(effectiveInterval(["1h", "6h", undefined], "5m"), { interval: "6h", inherited: false });
  assert.deepEqual(effectiveInterval([undefined, "bogus"], "1d"), { interval: "1d", inherited: true });
  assert.deepEqual(effectiveInterval([], "5m"), { interval: "5m", inherited: true });
  // an explicit 5m on one key and 1h on another: longest, not "most recent"
  assert.equal(effectiveInterval(["5m", "1h"], "6h").interval, "1h");
}

console.log("beat rows: pjangler-written states never count as a run; newest across all logs");
{
  const logA = [row("2026-10-20T10:00:00Z", "sent"), row("2026-10-20T12:00:00Z", "enabled", "pj crank enable"), row("2026-10-20T12:30:00Z", "interval"), row("2026-10-20T12:40:00Z", "renamed"), row("2026-10-20T12:50:00Z", "disabled"), "not json"];
  const logB = [row("2026-10-20T11:00:00Z", "waiting"), row("2026-10-20T09:00:00Z", "done")];
  assert.deepEqual(beatRows([logA, logB]).map((r) => r.state), ["waiting", "sent", "done"]);
  assert.equal(lastRunMs([logA, logB]), T("2026-10-20T11:00:00Z"), "newest beat across both logs; the later pjangler rows are ignored");
  assert.equal(lastRunMs([[row("2026-10-20T12:00:00Z", "enabled")], []]), undefined, "only pjangler rows -> never run");
  assert.equal(lastRunMs([[]]), undefined);
}

console.log("due: <=5m is always due; slower tabs are due from last + interval - GRACE");
{
  const last = T("2026-10-20T12:00:00Z");
  assert.equal(isDue("5m", last, last), true, "5m is every tick, even a second after a run");
  assert.equal(isDue("5m", undefined, last), true);
  assert.equal(isDue("1h", undefined, last), true, "never ran -> due");
  assert.equal(isDue("1h", last, T("2026-10-20T12:54:59Z")), false);
  assert.equal(isDue("1h", last, T("2026-10-20T12:55:00Z")), true, "GRACE: 55m, not 65m");
  assert.equal(isDue("6h", last, T("2026-10-20T17:54:59Z")), false);
  assert.equal(isDue("6h", last, T("2026-10-20T17:55:00Z")), true);
  assert.equal(isDue("1d", last, T("2026-10-21T11:55:00Z")), true);
  assert.equal(isDue("1d", last, T("2026-10-21T11:54:59Z")), false);
}

console.log("next run: first 5-minute tick at/after max(now, last + interval - GRACE); none when OFF");
{
  const last = T("2026-10-20T12:00:00Z");
  const on = (interval, lastRun, nowMs) => nextRunMs({ enabled: true, interval, lastRun, nowMs });
  assert.equal(nextRunMs({ enabled: false, interval: "5m", lastRun: last, nowMs: last }), undefined);
  assert.equal(on("5m", last, T("2026-10-20T12:01:10Z")), T("2026-10-20T12:05:00Z"));
  assert.equal(on("5m", last, T("2026-10-20T12:05:00Z")), T("2026-10-20T12:05:00Z"), "a tick landing on now is now");
  assert.equal(on("5m", undefined, T("2026-10-20T12:06:00Z")), T("2026-10-20T12:10:00Z"));
  assert.equal(on("5m", last, T("2026-10-20T13:00:01Z")), T("2026-10-20T13:05:00Z"), "5m ignores last run entirely");
  // 1h after a run at 12:00:00 -> due 12:55:00, which is itself a tick
  assert.equal(on("1h", last, T("2026-10-20T12:10:00Z")), T("2026-10-20T12:55:00Z"));
  // run at 12:02 -> due 12:57 -> first tick at/after is 13:00
  assert.equal(on("1h", T("2026-10-20T12:02:00Z"), T("2026-10-20T12:10:00Z")), T("2026-10-20T13:00:00Z"));
  // overdue slow tab: the next tick after NOW, not the long-past due time
  assert.equal(on("1h", last, T("2026-10-20T15:01:00Z")), T("2026-10-20T15:05:00Z"));
  assert.equal(on("6h", last, T("2026-10-20T12:10:00Z")), T("2026-10-20T17:55:00Z"));
  assert.equal(on("1d", last, T("2026-10-20T12:10:00Z")), T("2026-10-21T11:55:00Z"));
  assert.equal(on("1h", undefined, T("2026-10-20T12:01:00Z")), T("2026-10-20T12:05:00Z"), "never ran -> next tick");
  // consistency: the displayed next run is always a moment the due rule agrees to fire
  for (const interval of ["5m", "1h", "6h", "1d"]) {
    for (const offsetMin of [0, 3, 59, 61, 400, 1500]) {
      const now = last + offsetMin * 60_000 + 17_000;
      const next = on(interval, last, now);
      assert.ok(next >= now && next % 300_000 === 0, `${interval}+${offsetMin}m: a tick at or after now`);
      assert.ok(isDue(interval, last, next), `${interval}+${offsetMin}m: due when it arrives`);
      assert.ok(next - 300_000 < now || !isDue(interval, last, next - 300_000), `${interval}+${offsetMin}m: and not a tick earlier than necessary`);
    }
  }
}

console.log("durations read as a countdown");
{
  assert.equal(formatDuration(9), "9s");
  assert.equal(formatDuration(252), "4m 12s");
  assert.equal(formatDuration(3780), "1h 03m");
  assert.equal(formatDuration(90000), "1d 1h");
}

console.log("redis endpoint: env overrides, defaults unchanged, garbage ignored");
{
  assert.deepEqual(redisEndpoint({}), { host: "127.0.0.1", port: 6379 });
  assert.deepEqual(redisEndpoint({ ZCRANK_REDIS_HOST: "redis.test", ZCRANK_REDIS_PORT: "6400" }), { host: "redis.test", port: 6400 });
  assert.equal(redisEndpoint({ ZCRANK_REDIS_PORT: "abc" }).port, 6379);
  assert.equal(redisEndpoint({ ZCRANK_REDIS_PORT: "99999" }).port, 6379);
}

// ---------------------------------------------------------------------------
// Rename planning (pure)
// ---------------------------------------------------------------------------

const none = () => undefined;
function plan(project, live, stored, intervals = none, chosenInterval) {
  const ctx = buildCrankContext(project, live, stored);
  return planRenameMigration({ resolution: ctx.resolution, candidates: ctx.candidates, storedKeys: stored, live, intervals, chosenInterval });
}

console.log("rename plan: case/punctuation drift -> the live spelling wins, the old key goes");
{
  const p = plan({ name: "green-in-between", agents: [] }, [{ name: "green-in-between 🟢", position: 0 }], ["GreenInBetween", "Holocene"], (k) => (k === "GreenInBetween" ? "6h" : undefined));
  assert.deepEqual(p, { target: "green-in-between", oldKeys: ["GreenInBetween"], carryInterval: "6h" });
}

console.log("rename plan: a renamed project finds its old key through the agent-handle tab name");
{
  const project = { name: "tower-of-lost-things", agents: [{ handle: "pile-of-dumb-things-pm", role: "pm" }] };
  // the operator renamed the tab from "tower-of-lost-things" to "Pile of Dumb Things"
  const p = plan(project, [{ name: "Pile of Dumb Things 🟡", position: 4 }], ["tower-of-lost-things", "gruvato"], (k) => (k === "tower-of-lost-things" ? "1h" : undefined));
  assert.equal(p.target, "Pile of Dumb Things");
  assert.deepEqual(p.oldKeys, ["tower-of-lost-things"], "old name is a candidate; unrelated gruvato is not");
  assert.equal(p.carryInterval, "1h");
}

console.log("rename plan: colon/prefix siblings are never old names; another live tab's key is never old");
{
  // project navi owns the live tab "IPM: Navi"; the shared "IPM" key and prefix "Navi Mobile" are other tabs'.
  const live = [{ name: "IPM: Billing", position: 1 }, { name: "IPM: Navi", position: 2 }, { name: "Navi Mobile", position: 3 }];
  const p = plan({ name: "Navi", agents: [] }, live, ["IPM", "Navi Mobile", "IPM: Billing", "navi"]);
  assert.equal(p.target, "IPM: Navi");
  assert.deepEqual(p.oldKeys, ["navi"], "only the key whose canon equals the project name");
  // a key that is canon-equal to the project name but ALSO another live tab's own spelling stays put
  const p2 = plan({ name: "Flume", agents: [] }, [{ name: "Flume", position: 0 }, { name: "flume ", position: 1 }], ["flume"]);
  assert.equal(p2.target, "Flume");
  assert.deepEqual(p2.oldKeys, ["flume"], "same canon as the target: it IS this tab's old spelling");
  // live-prefix: project "Pile" is a prefix of the live tab; the sibling key "Pile of Dumb Things Two" is another tab's.
  const p3 = plan({ name: "Pile", agents: [] }, [{ name: "Pile of Dumb Things", position: 0 }], ["Pile of Dumb Things Two"]);
  assert.equal(p3.target, "Pile of Dumb Things");
  assert.deepEqual(p3.oldKeys, [], "a prefix sibling is never an old name");
  // a stored key equal to the project name wins resolution (redis-exact): no live target, so no migration at all
  assert.equal(plan({ name: "Pile", agents: [] }, [{ name: "Pile of Dumb Things", position: 0 }], ["Pile"]), undefined);
}

console.log("rename plan: nothing live -> no migration; a chosen interval beats a carried one; target's own interval beats both");
{
  assert.equal(plan({ name: "Holocene", agents: [] }, [], ["holocene"]), undefined);
  assert.equal(plan({ name: "Brand New", agents: [] }, [], []), undefined);
  const live = [{ name: "Holocene", position: 0 }];
  assert.equal(plan({ name: "Holocene", agents: [] }, live, ["holocene"], (k) => (k === "holocene" ? "6h" : undefined), "1h").carryInterval, undefined);
  assert.equal(plan({ name: "Holocene", agents: [] }, live, ["holocene", "Holocene"], (k) => (k === "holocene" ? "6h" : "1d")).carryInterval, undefined);
  assert.equal(plan({ name: "Holocene", agents: [] }, live, ["holocene", "HOLOCENE"], (k) => (k === "holocene" ? "1h" : k === "HOLOCENE" ? "6h" : undefined)).carryInterval, "6h", "longest across old keys");
}

console.log("log merge: sorted by ts, capped at the 500 newest, bad rows kept at the front");
{
  const a = [row("2026-10-20T10:00:00Z", "sent", "a1"), row("2026-10-20T12:00:00Z", "sent", "a2")];
  const b = [row("2026-10-20T11:00:00Z", "sent", "b1")];
  assert.deepEqual(mergeLogRows([b], a).map((r) => JSON.parse(r).action), ["a1", "b1", "a2"]);
  const many = Array.from({ length: 450 }, (_, i) => row(new Date(T("2026-10-01T00:00:00Z") + i * 60_000).toISOString().replace(/\.\d+Z/, "Z"), "sent", `x${i}`));
  const more = Array.from({ length: 300 }, (_, i) => row(new Date(T("2026-10-01T00:00:30Z") + i * 60_000).toISOString().replace(/\.\d+Z/, "Z"), "sent", `y${i}`));
  const merged = mergeLogRows([more], many);
  assert.equal(merged.length, 500);
  assert.equal(JSON.parse(merged.at(-1)).action, "x449", "newest survives");
  const stamps = merged.map((r) => Date.parse(JSON.parse(r).ts));
  assert.deepEqual(stamps, [...stamps].sort((x, y) => x - y), "chronological");
  assert.equal(mergeLogRows([["junk"]], [row("2026-10-20T10:00:00Z", "sent")])[0], "junk");
}

console.log("glob escape: a tab name with redis glob characters matches only itself");
{
  assert.equal(redisGlobEscape("a[b]*?^c"), "a\\[b\\]\\*\\?\\^c");
  assert.equal(redisGlobEscape("plain name"), "plain name");
}

console.log("list: INTERVAL column shows the effective interval and marks inherited ones");
{
  const report = buildCrankList({
    projects: [{ slug: "holo", name: "Holocene", repoPath: "/x", agents: [] }, { slug: "flume", name: "Flume", repoPath: "/y", agents: [] }],
    live: [],
    storedTabs: ["Holocene", "Flume", "Orphan"],
    tabEnabled: (t) => (t === "Orphan" ? "0" : "1"),
    tabInterval: (t) => (t === "Holocene" ? "6h" : undefined),
    globalInterval: "1h",
  });
  assert.deepEqual(report.rows.map((r) => [r.slug, r.interval, r.inherited]), [["holo", "6h", false], ["flume", "1h", true]]);
  assert.deepEqual(report.orphans.map((o) => [o.tab, o.interval, o.inherited]), [["Orphan", "1h", true]]);
  const text = formatCrankList(report).replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(text, /INTERVAL/);
  assert.match(text, /holo\s+Holocene\s+ON\s+6h\s*$/m);
  assert.match(text, /flume\s+Flume\s+ON\s+1h \(global\)/);
}

// ---------------------------------------------------------------------------
// Everything below talks to a REAL throwaway redis-server
// ---------------------------------------------------------------------------

const rs = await startThrowawayRedis();
assert.notEqual(rs.port, 6379);
process.env.ZCRANK_REDIS_PORT = String(rs.port);
process.env.ZCRANK_REDIS_HOST = "127.0.0.1";
const store = redis();
assert.equal(store.endpoint, `127.0.0.1:${rs.port}`, "the env override must steer pjangler at the throwaway redis");
let failed;

try {
  assert.equal(store.ping(), true);
  const flush = () => rs.cli("FLUSHALL");
  const dump = () => Object.fromEntries(rs.cli("KEYS", "*").split("\n").filter(Boolean).sort().map((k) => [k, rs.cli("TYPE", k)]));

  console.log("redis accessors: interval round-trips, garbage and absent read as undefined, global falls back to 5m");
  {
    flush();
    assert.equal(store.tabInterval("t"), undefined);
    store.setTabInterval("t", "6h");
    assert.equal(rs.cli("HGET", "zcrank:tab:t", "interval"), "6h");
    assert.equal(store.tabInterval("t"), "6h");
    rs.cli("HSET", "zcrank:tab:t", "interval", "every-now-and-then");
    assert.equal(store.tabInterval("t"), undefined, "garbage ignored");
    store.clearTabInterval("t");
    assert.equal(rs.cli("HEXISTS", "zcrank:tab:t", "interval"), "0");
    assert.equal(store.globalInterval(), "5m");
    rs.cli("HSET", "zcrank:config", "interval", "1d");
    assert.equal(store.globalInterval(), "1d");
    rs.cli("HSET", "zcrank:config", "interval", "bogus");
    assert.equal(store.globalInterval(), "5m", "garbage global falls back");
    flush();
  }

  console.log("migration applied: drift key merged away; interval carried; logs merged in order; panes + old keys gone");
  {
    flush();
    // the operator's tab is now "green-in-between"; the old key is GreenInBetween (WING-7 drift)
    rs.cli("HSET", "zcrank:tab:GreenInBetween", "enabled", "0", "interval", "6h");
    rs.cli("RPUSH", "zcrank:log:GreenInBetween", row("2026-10-20T10:00:00Z", "sent", "old-1"), row("2026-10-20T12:00:00Z", "waiting", "old-2"));
    rs.cli("HSET", "zcrank:tab:green-in-between", "enabled", "0");
    rs.cli("RPUSH", "zcrank:log:green-in-between", row("2026-10-20T11:00:00Z", "done", "new-1"));
    rs.cli("SET", "zcrank:pane:GreenInBetween:terminal_3", "1");
    rs.cli("SET", "zcrank:pane:GreenInBetween:terminal_4", "0");
    // siblings that must survive: colon head, prefix, and a pane key of a colon-named other tab
    rs.cli("HSET", "zcrank:tab:IPM", "enabled", "1", "interval", "1d");
    rs.cli("SET", "zcrank:pane:IPM:terminal_1", "1");
    rs.cli("HSET", "zcrank:tab:green-in-between-two", "enabled", "1");
    rs.cli("SET", "zcrank:pane:GreenInBetween:sub:terminal_9", "1");
    rs.cli("RPUSH", "zcrank:log:IPM", row("2026-10-20T09:00:00Z", "sent", "ipm-1"));

    const live = [{ name: "green-in-between 🟢", position: 0 }, { name: "IPM: Billing", position: 1 }];
    const ctx = buildCrankContext({ name: "green-in-between", agents: [] }, live, storedTabKeys(store));
    const res = enableCrank(store, ctx, { now: new Date("2026-10-20T13:00:00Z") });

    assert.equal(res.tab, "green-in-between");
    assert.deepEqual(res.renamed, [{ from: "GreenInBetween", to: "green-in-between" }]);
    assert.equal(res.interval, "6h");
    assert.equal(rs.cli("HGET", "zcrank:tab:green-in-between", "enabled"), "1");
    assert.equal(rs.cli("HGET", "zcrank:tab:green-in-between", "interval"), "6h", "interval carried over");
    assert.equal(rs.cli("EXISTS", "zcrank:tab:GreenInBetween"), "0", "old tab key removed");
    assert.equal(rs.cli("EXISTS", "zcrank:log:GreenInBetween"), "0", "old log removed");
    assert.equal(rs.cli("EXISTS", "zcrank:pane:GreenInBetween:terminal_3", "zcrank:pane:GreenInBetween:terminal_4"), "0", "old pane overrides removed");
    const log = rs.cli("LRANGE", "zcrank:log:green-in-between", "0", "-1").split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((r) => r.action), ["old-1", "new-1", "old-2", "pj crank enable", "pj crank enable: GreenInBetween -> green-in-between"], "merged by ts, then the enable rows");
    assert.deepEqual(log.slice(-2).map((r) => r.state), ["enabled", "renamed"]);
    // siblings untouched
    assert.equal(rs.cli("HGET", "zcrank:tab:IPM", "enabled"), "1");
    assert.equal(rs.cli("HGET", "zcrank:tab:IPM", "interval"), "1d");
    assert.equal(rs.cli("EXISTS", "zcrank:pane:IPM:terminal_1"), "1");
    assert.equal(rs.cli("EXISTS", "zcrank:tab:green-in-between-two"), "1", "a prefix sibling is another tab");
    assert.equal(rs.cli("EXISTS", "zcrank:pane:GreenInBetween:sub:terminal_9"), "1", "pane key of tab 'GreenInBetween:sub' is not this tab's");
    assert.equal(rs.cli("LLEN", "zcrank:log:IPM"), "1");
    assert.equal(rs.cli("KEYS", "zcrank:logtmp:*"), "", "no scratch key left behind");
  }

  console.log("migration applied: renamed project, agent-handle tab; chosen interval wins; 500 cap; glob chars in the old name");
  {
    flush();
    const old = "Weird [tab]*";
    rs.cli("HSET", `zcrank:tab:${old}`, "enabled", "1", "interval", "1d");
    rs.cli("SET", `zcrank:pane:${old}:terminal_7`, "0");
    rs.cli("SET", "zcrank:pane:Weird Xtab:terminal_7", "0");
    const base = T("2026-10-01T00:00:00Z");
    const mk = (n, off, tag) => Array.from({ length: n }, (_, i) => row(new Date(base + (i * 2 + off) * 60_000).toISOString().replace(/\.\d+Z/, "Z"), "sent", `${tag}${i}`));
    rs.cli("RPUSH", `zcrank:log:${old}`, ...mk(400, 0, "o"));
    rs.cli("HSET", "zcrank:tab:weird-tab", "enabled", "0");
    rs.cli("RPUSH", "zcrank:log:weird-tab", ...mk(300, 1, "n"));
    const ctx = buildCrankContext({ name: "weird tab", agents: [] }, [{ name: "weird-tab", position: 0 }], storedTabKeys(store));
    assert.deepEqual(ctx.resolution.liveTab, "weird-tab");
    const res = enableCrank(store, ctx, { interval: "1h", now: new Date("2026-10-30T00:00:00Z") });
    assert.deepEqual(res.renamed, [{ from: old, to: "weird-tab" }]);
    assert.equal(rs.cli("HGET", "zcrank:tab:weird-tab", "interval"), "1h", "the interval chosen in the same breath beats the carried 1d");
    assert.equal(rs.cli("EXISTS", `zcrank:tab:${old}`), "0");
    assert.equal(rs.cli("EXISTS", `zcrank:pane:${old}:terminal_7`), "0", "escaped glob matched the real pane key");
    assert.equal(rs.cli("EXISTS", "zcrank:pane:Weird Xtab:terminal_7"), "1", "and nothing a glob '*'/'[ ]' would also have matched");
    assert.equal(rs.cli("LLEN", "zcrank:log:weird-tab"), "500");
    const last = JSON.parse(rs.cli("LINDEX", "zcrank:log:weird-tab", "-1"));
    assert.equal(last.state, "renamed");
    const states = rs.cli("LRANGE", "zcrank:log:weird-tab", "-3", "-1").split("\n").map((l) => JSON.parse(l).state);
    assert.deepEqual(states, ["interval", "enabled", "renamed"]);
  }

  console.log("enable with nothing live: today's behaviour, no migration, nothing deleted");
  {
    flush();
    rs.cli("HSET", "zcrank:tab:holocene", "enabled", "0", "interval", "1h");
    rs.cli("HSET", "zcrank:tab:Holocene", "enabled", "0");
    const ctx = buildCrankContext({ name: "Holocene", agents: [] }, [], storedTabKeys(store));
    const res = enableCrank(store, ctx, { now: new Date("2026-10-20T13:00:00Z") });
    assert.deepEqual(res.renamed, []);
    assert.equal(rs.cli("EXISTS", "zcrank:tab:holocene"), "1");
    assert.equal(rs.cli("HGET", `zcrank:tab:${ctx.resolution.tab}`, "enabled"), "1");
  }

  console.log("set / reset interval: written under the key, cleared from other spellings, logged as 'interval'");
  {
    flush();
    rs.cli("HSET", "zcrank:tab:Flume", "enabled", "1", "interval", "6h");
    rs.cli("HSET", "zcrank:tab:flume", "enabled", "1");
    const keys = storedTabKeys(store);
    setCrankInterval(store, "flume", keys, "1h", new Date("2026-10-20T13:00:00Z"));
    assert.equal(rs.cli("HGET", "zcrank:tab:flume", "interval"), "1h");
    assert.equal(rs.cli("HEXISTS", "zcrank:tab:Flume", "interval"), "0", "else 6h would still win");
    let snap = snapshotCrank(store, "flume", keys, T("2026-10-20T13:00:00Z"));
    assert.deepEqual([snap.interval, snap.inherited, snap.override], ["1h", false, "1h"]);
    setCrankInterval(store, "flume", keys, undefined, new Date("2026-10-20T13:01:00Z"));
    snap = snapshotCrank(store, "flume", keys, T("2026-10-20T13:01:00Z"));
    assert.deepEqual([snap.interval, snap.inherited, snap.override, snap.global], ["5m", true, undefined, "5m"]);
    const rows = rs.cli("LRANGE", "zcrank:log:flume", "0", "-1").split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.state), ["interval", "interval"]);
    assert.match(rows[1].action, /reset to global \(5m\)/);
    assert.equal(snap.lastRunMs, undefined, "pjangler's own rows are not runs");
  }

  console.log("snapshot: several keys name one tab -> ON only if all ON, longest interval, newest run across logs");
  {
    flush();
    rs.cli("HSET", "zcrank:tab:Flume", "enabled", "1", "interval", "1h");
    rs.cli("HSET", "zcrank:tab:flume", "enabled", "1", "interval", "6h");
    rs.cli("RPUSH", "zcrank:log:Flume", row("2026-10-20T12:00:00Z", "sent"), row("2026-10-20T12:30:00Z", "enabled"));
    rs.cli("RPUSH", "zcrank:log:flume", row("2026-10-20T11:00:00Z", "waiting"));
    rs.cli("HSET", "zcrank:config", "interval", "1d");
    const now = T("2026-10-20T13:00:00Z");
    let snap = snapshotCrank(store, "Flume", storedTabKeys(store), now);
    assert.equal(snap.enabled, true);
    assert.equal(snap.interval, "6h");
    assert.equal(snap.global, "1d");
    assert.equal(snap.lastRunMs, T("2026-10-20T12:00:00Z"));
    assert.equal(snap.due, false);
    assert.equal(snap.nextRunMs, T("2026-10-20T17:55:00Z"));
    assert.deepEqual(snap.beats.map((b) => b.state), ["sent", "waiting"]);
    assert.equal(snap.log.length, 3);
    rs.cli("HSET", "zcrank:tab:flume", "enabled", "0");
    snap = snapshotCrank(store, "Flume", storedTabKeys(store), now);
    assert.equal(snap.enabled, false, "any OFF spelling turns the tab OFF (the engine's rule)");
    assert.equal(snap.nextRunMs, undefined);
    flush();
    assert.equal(snapshotCrank(store, "nothing", [], now).enabled, undefined);
  }

  // -------------------------------------------------------------------------
  // The real CLI from dist/, non-TTY paths, against the throwaway redis
  // -------------------------------------------------------------------------

  const pj = join(root, "dist", "index.js");
  assert.ok(existsSync(pj), "dist/index.js missing: run `npm run build` first");
  assert.ok(existsSync(join(root, "dist", "crank", "tui.js")), "dist/crank/tui.js missing: the TUI screens are a separate build entry");
  const runPj = (args, env = {}) => spawnSync(process.execPath, [pj, ...args], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ZCRANK_REDIS_PORT: String(rs.port), ZCRANK_REDIS_HOST: "127.0.0.1", NO_COLOR: "1", ...env },
  });

  console.log("cli: `pj crank enable --interval` validates, writes, and non-TTY enable never prompts");
  {
    flush();
    const bad = runPj(["crank", "enable", "--interval", "15m"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--interval needs one of 5m, 1h, 6h, 1d/);
    assert.equal(rs.cli("KEYS", "zcrank:tab:*"), "", "a rejected interval writes nothing");

    const ok = runPj(["crank", "enable", "--interval", "1h"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /ON\s+\S+\s+❯/);
    assert.match(ok.stdout, /interval 1h/);
    const keys = rs.cli("KEYS", "zcrank:tab:*").split("\n").filter(Boolean);
    assert.equal(keys.length, 1, `exactly one tab key, got ${keys}`);
    assert.equal(rs.cli("HGET", keys[0], "enabled"), "1");
    assert.equal(rs.cli("HGET", keys[0], "interval"), "1h");

    // no --interval and no TTY: enable without touching the interval
    const again = runPj(["crank", "enable"]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(rs.cli("HGET", keys[0], "interval"), "1h", "interval left alone");
    const dis = runPj(["crank", "disable"]);
    assert.equal(dis.status, 0, dis.stderr);
    assert.equal(rs.cli("HGET", keys[0], "enabled"), "0");
  }

  console.log("cli: `pj crank tui` without a TTY fails clearly; a dead Redis fails clearly");
  {
    const tui = runPj(["crank", "tui"]);
    assert.equal(tui.status, 1);
    assert.match(tui.stderr, /interactive terminal/);
    const down = runPj(["crank", "enable", "--interval", "1h"], { ZCRANK_REDIS_PORT: "1" });
    assert.equal(down.status, 1);
    assert.match(down.stderr, /Redis is not answering at 127\.0\.0\.1:1/);
  }

  console.log("lazy loading: the entry bundle never imports ink or react");
  {
    const { readFileSync } = await import("node:fs");
    const entry = readFileSync(pj, "utf8");
    assert.doesNotMatch(entry, /from ["']ink["']/);
    assert.doesNotMatch(entry, /from ["']react["']/);
    assert.match(readFileSync(join(root, "dist", "crank", "tui.js"), "utf8"), /from ["']ink["']/);
    const help = runPj(["crank", "--help"]);
    assert.match(help.stdout, /tui/);
    assert.match(runPj(["crank", "enable", "--help"]).stdout, /--interval <interval>/);
  }

  // -------------------------------------------------------------------------
  // Ink: real components, fake terminal streams, real redis behind the controller
  // -------------------------------------------------------------------------

  const ESC = "\u001b";
  const RIGHT = `${ESC}[C`;
  const LEFT = `${ESC}[D`;
  const ink = (stdin, stdout) => ({ stdin, stdout, stderr: new FakeStdout(), ink: { debug: true, patchConsole: false } });

  console.log("ink picker: preselects the effective interval, arrows move, enter confirms");
  {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const done = pickInterval({ slug: "demo", tab: "Pile of Dumb Things", effective: "5m", inherited: true, global: "5m" }, ink(stdin, stdout));
    await waitFor(() => stdout.frame().includes("(•) 5m"), "picker first frame");
    const first = stdout.frame();
    assert.match(first, /Pile of Dumb Things/);
    assert.match(first, /inherits global \(5m\)/);
    assert.match(first, /\(•\) 5m\s+global/, "the global default is badged");
    assert.match(first, /\( \) 1h/);
    assert.match(first, /esc q\s+abort/);
    stdin.press(RIGHT);
    await waitFor(() => stdout.frame().includes("(•) 1h"), "arrow moves the radio");
    stdin.press("3");
    await waitFor(() => stdout.frame().includes("(•) 6h"), "digit jumps");
    stdin.press(LEFT);
    await waitFor(() => stdout.frame().includes("(•) 1h"), "left moves back");
    stdin.press("\r");
    assert.equal(await done, "1h");
  }

  console.log("ink picker: esc / q abort without choosing; an override is shown as one");
  {
    for (const key of [ESC, "q"]) {
      const stdin = new FakeStdin();
      const stdout = new FakeStdout();
      const done = pickInterval({ slug: "demo", tab: "t", effective: "6h", inherited: false, global: "5m" }, ink(stdin, stdout));
      await waitFor(() => stdout.frame().includes("(•) 6h"), "opens on the override");
      assert.match(stdout.frame(), /project override \(global is 5m\)/);
      stdin.press(key);
      assert.equal(await done, null);
    }
  }

  console.log("ink picker: a non-TTY terminal is refused before Ink touches it");
  {
    const stdout = new FakeStdout();
    stdout.isTTY = false;
    await assert.rejects(
      pickInterval({ slug: "demo", tab: "t", effective: "5m", inherited: true, global: "5m" }, { stdin: new FakeStdin(), stdout }),
      /interactive terminal/,
    );
  }

  console.log("ink dashboard: renders real state, toggles, sets/resets the interval, ticks, quits");
  {
    flush();
    rs.cli("HSET", "zcrank:tab:Pile of Dumb Things", "enabled", "0");
    // a beat 9 minutes ago and one of pjangler's own rows after it
    const now0 = Date.now();
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z/, "Z");
    rs.cli("RPUSH", "zcrank:log:Pile of Dumb Things", row(iso(now0 - 9 * 60_000), "sent", "answered the migration question"), row(iso(now0 - 60_000), "disabled", "pj crank disable"));
    const controller = createCrankController({
      slug: "tower-of-lost-things",
      project: { name: "tower-of-lost-things", agents: [{ handle: "pile-of-dumb-things-pm", role: "pm" }] },
      store,
      live: () => [{ name: "Pile of Dumb Things 🟢", position: 2 }],
    });
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const finished = runCrankDashboard(controller, { ...ink(stdin, stdout), alternateScreen: false, refreshMs: 150 });
    await waitFor(() => stdout.frame().includes("Next run"), "dashboard first frame");
    let f = stdout.frame();
    assert.match(f, /tower-of-lost-things/);
    assert.match(f, /tab Pile of Dumb Things/);
    assert.match(f, /live tab "Pile of Dumb Things" via live exact/);
    assert.match(f, /○ OFF/);
    assert.match(f, /\(•\) 5m\s+global/);
    assert.match(f, /inherits global \(5m\)/);
    assert.match(f, /Next run\s+off/);
    assert.match(f, /9m 0\ds ago\s+sent\s+answered the migration question/, "last runs show beat rows with their age");
    assert.doesNotMatch(f.split("Log (")[0].split("Last runs")[1] ?? "", /pj crank disable/, "pjangler rows are not 'runs'");
    assert.match(f, /Log \(2 rows\)/);
    assert.match(f, /pj crank disable/, "...but they are in the log tail");
    assert.match(f, /space t\s+toggle/);

    stdin.press("t");
    await waitFor(() => stdout.frame().includes("● ON"), "toggle ON");
    assert.equal(rs.cli("HGET", "zcrank:tab:Pile of Dumb Things", "enabled"), "1");
    assert.match(stdout.frame(), /Next run\s+in \d+m \d\ds/, "a countdown when ON");
    assert.match(stdout.frame(), /pj crank enable/);

    // the countdown really ticks
    const a = stdout.frame().match(/Next run\s+in ([^(]+)\(/)?.[1];
    await waitFor(() => (stdout.frame().match(/Next run\s+in ([^(]+)\(/)?.[1] ?? a) !== a, "countdown changes within a few seconds", 7000);

    stdin.press("2");
    await waitFor(() => stdout.frame().includes("(•) 1h"), "digit applies the interval");
    assert.equal(rs.cli("HGET", "zcrank:tab:Pile of Dumb Things", "interval"), "1h");
    assert.match(stdout.frame(), /project override \(global is 5m\)/);
    stdin.press(RIGHT);
    await waitFor(() => stdout.frame().includes("(•) 6h"), "right arrow applies the next interval");
    assert.equal(rs.cli("HGET", "zcrank:tab:Pile of Dumb Things", "interval"), "6h");
    // a long interval after a recent run: next run is the 5h55m-from-last tick, not the next 5 minutes
    assert.match(stdout.frame(), /Next run\s+in (5h|4h) \d\dm/);

    stdin.press("r");
    await waitFor(() => stdout.frame().includes("inherits global (5m)"), "r resets to global");
    assert.equal(rs.cli("HEXISTS", "zcrank:tab:Pile of Dumb Things", "interval"), "0");

    // an external change shows up on the periodic re-read
    rs.cli("HSET", "zcrank:config", "interval", "1d");
    await waitFor(() => stdout.frame().includes("inherits global (1d)"), "re-reads redis on its own");
    assert.match(stdout.frame(), /\(•\) 1d\s+global/);

    stdin.press(" ");
    await waitFor(() => stdout.frame().includes("○ OFF"), "space toggles OFF");
    assert.equal(rs.cli("HGET", "zcrank:tab:Pile of Dumb Things", "enabled"), "0");
    assert.match(stdout.frame(), /Next run\s+off/);

    stdin.press("q");
    await finished;
  }

  console.log("ink dashboard: toggling ON runs the rename migration and says so");
  {
    flush();
    rs.cli("HSET", "zcrank:tab:tower-of-lost-things", "enabled", "0", "interval", "1d");
    rs.cli("RPUSH", "zcrank:log:tower-of-lost-things", row("2026-10-19T08:00:00Z", "sent", "from the old name"));
    const controller = createCrankController({
      slug: "tower-of-lost-things",
      project: { name: "tower-of-lost-things", agents: [{ handle: "pile-of-dumb-things-pm", role: "pm" }] },
      store,
      live: () => [{ name: "Pile of Dumb Things", position: 2 }],
    });
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const finished = runCrankDashboard(controller, { ...ink(stdin, stdout), alternateScreen: false, refreshMs: 5000 });
    await waitFor(() => stdout.frame().includes("Next run"), "first frame");
    stdin.press("t");
    await waitFor(() => /renamed tower-of-lost-things -> Pile of Dumb Things/.test(stdout.frame()), "flash names the rename");
    assert.equal(rs.cli("EXISTS", "zcrank:tab:tower-of-lost-things"), "0");
    assert.equal(rs.cli("HGET", "zcrank:tab:Pile of Dumb Things", "interval"), "1d", "carried");
    assert.equal(rs.cli("HGET", "zcrank:tab:Pile of Dumb Things", "enabled"), "1");
    assert.match(stdout.frame(), /tab Pile of Dumb Things/);
    stdin.press(ESC);
    await finished;
  }

  console.log("ink dashboard: a Redis that goes away mid-run shows an error line, does not crash");
  {
    flush();
    const dead = redis({ port: 1 });
    const controller = {
      slug: "x", name: "x",
      read: () => { throw new Error("Redis is not answering at 127.0.0.1:1"); },
      enable: () => { throw new Error("nope"); }, disable: () => {}, setInterval: () => {},
    };
    assert.equal(dead.ping(), false);
    // first read happens in useState: the dashboard cannot start without one, so the CLI pings first;
    // here prove the periodic re-read path degrades instead of unmounting.
    let calls = 0;
    const flaky = {
      ...controller,
      read: () => {
        calls += 1;
        if (calls > 1) throw new Error("Redis is not answering at 127.0.0.1:1");
        return createCrankController({ slug: "x", project: { name: "Solo", agents: [] }, store, live: () => [] }).read();
      },
    };
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const finished = runCrankDashboard(flaky, { ...ink(stdin, stdout), alternateScreen: false, refreshMs: 100 });
    await waitFor(() => stdout.frame().includes("Redis is not answering"), "error line");
    stdin.press("q");
    await finished;
  }

  console.log("intervalOptions: exactly the four, global badged");
  {
    assert.deepEqual(intervalOptions("1h").map((o) => [o.value, o.badge]), [["5m", undefined], ["1h", "global"], ["6h", undefined], ["1d", undefined]]);
  }
} catch (error) {
  failed = error;
} finally {
  await rs.stop();
  rmSync(workspace, { recursive: true, force: true });
}
if (failed) throw failed;
console.log("PJAN-182 crank interval suite: ok");
