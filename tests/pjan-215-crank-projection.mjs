import "./helpers/hermetic-suite.mjs";
// PJAN-215: crank v2's live projection in Redis. A v2 binding (one crank per agent session, its own
// Candybar) is mirrored by the arbiter (crank.lua crank_attach / crank_fire / crank_end / crank_get)
// into crank:b:<binding> + crank:idx:pane:<session>:<pane>, which the shell prompt reads in the same
// pipelined round trip as the legacy crank:p hash.
//
// Pinned here, against a throwaway redis-server running the vendored arbiter:
//   - attach is idempotent (since kept, no edge), fire stamps last_fire and re-creates an expired hash,
//     an interval change in the v2 grammar (7m, 2h) is an edge and moves the TTL, end drops the pointer
//   - the legacy engine cannot clobber a v2 pane: crank_scan and crank_apply never touch crank:b/idx
//   - crank_get refuses a pointer whose hash now names another pane
//   - pj's store and projector write through it, and a dead Redis is a receipt, never a throw
//   - the prompt: a bound pane renders from the binding (wins over the legacy hash), counts down to
//     next_due, goes "stalled" after two intervals + 5m, and an arbiter without crank_get falls back
// Never 6379: the live Redis.

import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
import { startThrowawayRedis } from "./pjan-182-crank-regressions-helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = hermeticScratch("pjan-215");
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
writeFileSync(
  join(workspace, "entry.ts"),
  [
    `export { redis } from ${JSON.stringify(join(root, "src/crank/index.ts"))};`,
    `export { redisProjector, projectionFacts } from ${JSON.stringify(join(root, "src/crank/binding.ts"))};`,
    `export { intervalCron, nextFire } from ${JSON.stringify(join(root, "src/crank/policy.ts"))};`,
    `export { crankFromBinding, formatCrank, readPaneCrank, v2IntervalMs } from ${JSON.stringify(join(root, "src/prompt-pipeline.ts"))};`,
  ].join("\n"),
);
const kitOut = join(workspace, "kit.mjs");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [join(workspace, "entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", "--sourcemap=inline", `--outfile=${kitOut}`],
  { encoding: "utf8", env: hermeticEnv() },
);
if (built.status !== 0) {
  console.error(`failed to bundle the crank projection kit:\n${built.stderr}`);
  process.exit(1);
}
const { redis, redisProjector, projectionFacts, intervalCron, nextFire, crankFromBinding, formatCrank, readPaneCrank, v2IntervalMs } = await import(kitOut);

let failures = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`ok - ${name}`);
  } catch (error) {
    failures++;
    results.push(`not ok - ${name}\n  ${error instanceof Error ? error.stack : error}`);
  }
}

const NAME = "crank-claude-1c2336c3-1815192";
const facts = (extra = {}) => ({
  binding: NAME, cli: "claude", session_id: "1c2336c3-aaaa", pid: 1815192, pid_start: "52620715",
  project: "pjangler", root: "/r", zellij_session: "Workspace", pane: "19", interval: "5m",
  schedule: "1-59/5 * * * *", candybar_id: "c-1", next_due: 1795050000000, ...extra,
});

// ---------------------------------------------------------------------------
// Pure: the prompt's v2 mapping
// ---------------------------------------------------------------------------

await test("v2IntervalMs mirrors policy.ts's grammar", () => {
  assert.equal(v2IntervalMs("7m"), 420_000);
  assert.equal(v2IntervalMs("2h"), 7_200_000);
  assert.equal(v2IntervalMs("1d"), 86_400_000);
  for (const bad of ["0m", "60m", "24h", "2d", "5", "", undefined]) assert.equal(v2IntervalMs(bad), undefined, String(bad));
});

await test("crankFromBinding: empty reply is no binding; a binding is ON with its own facts", () => {
  assert.equal(crankFromBinding({}, 0), undefined);
  assert.equal(crankFromBinding(undefined, 0), undefined);
  const now = 1_800_000_000_000;
  const state = crankFromBinding({ binding: NAME, interval: "7m", since: String(now - 3_600_000), last_fire: String(now - 60_000), next_due: String(now + 120_000) }, now);
  assert.deepEqual(state, { enabled: true, scope: "session", interval: "7m", intervalMs: 420_000, onSinceMs: now - 3_600_000, lastRunMs: now - 60_000, nextDueMs: now + 120_000, engineScanMs: now - 60_000 });
  assert.equal(formatCrank(state, now), "⚡ crank ↑1h ↻7m ⏳2m");
});

await test("crankFromBinding: stalled after two intervals + 5m (never sooner than 15m); the attach counts before a first fire", () => {
  const now = 1_800_000_000_000;
  const fresh = crankFromBinding({ binding: NAME, interval: "5m", since: String(now - 14 * 60_000) }, now);
  assert.equal(fresh.stalled, undefined);
  const stale = crankFromBinding({ binding: NAME, interval: "5m", since: String(now - 16 * 60_000) }, now);
  assert.equal(stale.stalled, true);
  assert.equal(formatCrank(stale, now), "⚠ crank stalled 16m ↻5m");
  const hourly = crankFromBinding({ binding: NAME, interval: "1h", since: String(now - 3 * 3_600_000), last_fire: String(now - 2 * 3_600_000) }, now);
  assert.equal(hourly.stalled, undefined, "1h: 2h since the last fire is inside 2h5m");
});

await test("formatCrank rolls a passed next_due forward by whole intervals", () => {
  const now = 1_800_000_000_000;
  const state = crankFromBinding({ binding: NAME, interval: "5m", since: String(now - 600_000), last_fire: String(now - 240_000), next_due: String(now - 60_000) }, now);
  assert.equal(formatCrank(state, now), "⚡ crank ↑10m ↻5m ⏳4m");
});

await test("the countdown reads the binding's own cron (a 7m cron wraps at the hour; whole-interval math would not)", () => {
  const now = new Date(2026, 10, 18, 12, 59, 30).getTime();
  const state = crankFromBinding({ binding: NAME, interval: "7m", schedule: "3-59/7 * * * *", since: String(now - 600_000), last_fire: String(now - 300_000), next_due: String(now - 120_000) }, now);
  assert.equal(nextFire("3-59/7 * * * *", now), new Date(2026, 10, 18, 13, 3, 0).getTime());
  assert.equal(formatCrank(state, now), "⚡ crank ↑10m ↻7m ⏳3m");
});

await test("a reclock restarts the stall clock; an expired pointer is stalled, never off", () => {
  const now = 1_800_000_000_000;
  const reclocked = crankFromBinding({ binding: NAME, interval: "5m", since: String(now - 3 * 3_600_000), last_fire: String(now - 2 * 3_600_000), reclocked_ms: String(now - 60_000) }, now);
  assert.equal(reclocked.stalled, undefined);
  const expired = crankFromBinding({ binding: NAME, pane: "terminal_19", expired: "1" }, now);
  assert.deepEqual(expired, { enabled: true, scope: "session", stalled: true });
  assert.equal(formatCrank(expired, now), "⚠ crank stalled");
});

await test("projectionFacts derives the staggered schedule and next fire when the record has none (a fire from runner env)", () => {
  const now = Date.parse("2026-11-18T12:00:30Z");
  const out = projectionFacts({ name: NAME, cli: "claude", sessionId: "s", pid: 1, pidStart: "2", projectSlug: "p", projectRoot: "/r", zellijSession: "Workspace", paneId: "19", interval: "5m", schedule: "", candybarId: "c" }, now);
  assert.equal(out.schedule, intervalCron("5m", NAME));
  assert.equal(out.next_due, nextFire(out.schedule, now));
  assert.equal(out.pane, "19");
});

// ---------------------------------------------------------------------------
// Lua against a throwaway redis-server
// ---------------------------------------------------------------------------

const rs = await startThrowawayRedis();
const json = (raw) => JSON.parse(raw);
const fcall = (fn, payload) => json(rs.cli("FCALL", fn, "0", JSON.stringify(payload), "test"));
const hash = (key) => {
  const lines = rs.cli("HGETALL", key).split("\n");
  const out = {};
  for (let i = 0; i + 1 < lines.length; i += 2) out[lines[i]] = lines[i + 1];
  return out;
};
const bkey = `crank:b:${NAME}`;
const N4 = "crank-claude-44444444-4";
const ptr = "crank:idx:pane:Workspace:terminal_19";

try {
  await test("crank_attach creates the binding hash, the pane pointer and one 'on' edge; a repeat changes nothing", () => {
    const first = fcall("crank_attach", facts());
    assert.equal(first.created, true);
    assert.equal(first.edges.length, 1);
    assert.equal(first.edges[0].cause, "attach");
    const h = hash(bkey);
    assert.equal(h.on, "1");
    assert.equal(h.pane, "terminal_19");
    assert.equal(h.pid_start, "52620715");
    assert.equal(rs.cli("GET", ptr), NAME);
    assert.equal(rs.cli("SISMEMBER", "crank:idx:bindings", bkey), "1");
    const ttl = Number(rs.cli("PTTL", bkey));
    assert.ok(ttl > 3_500_000 && ttl <= 3_600_000, `5m binding keeps the 1h floor TTL, got ${ttl}`);
    const again = fcall("crank_attach", facts());
    assert.equal(again.created, false);
    assert.ok(!Array.isArray(again.edges) || again.edges.length === 0, "an idempotent attach emits nothing");
    assert.equal(hash(bkey).since, h.since, "since is kept");
  });

  await test("crank_fire stamps last_fire, counts fires, records the class; an interval change (v2 grammar) is an edge and moves the TTL", () => {
    const out = fcall("crank_fire", facts({ interval: "2h", last_class: "working", last_officer: "poke", last_officer_ms: 1795000000000 }));
    assert.equal(out.edges.length, 1);
    assert.deepEqual([out.edges[0].field, out.edges[0].from, out.edges[0].to, out.edges[0].cause], ["interval", "5m", "2h", "fire"]);
    const h = hash(bkey);
    assert.equal(h.fires, "1");
    assert.ok(Number(h.last_fire) > 0);
    assert.equal(h.last_class, "working");
    assert.equal(h.interval, "2h");
    assert.ok(Number(rs.cli("PTTL", bkey)) > 5.9 * 3_600_000, "TTL is three intervals");
    assert.ok(Number(rs.cli("PTTL", ptr)) > 11.9 * 3_600_000, "the pointer lives twice as long (an expired hash reads as stalled)");
    assert.ok(Number(rs.cli("PTTL", `crank:t:b:${NAME}`)) > 5.9 * 3_600_000, "the binding's stream expires with it");
    assert.ok(Number(h.reclocked_ms) > 0, "an interval change restarts the stall clock");
    fcall("crank_fire", facts({ interval: "2h", last_class: "waiting" }));
    assert.equal(hash(bkey).fires, "2");
    assert.equal(hash(bkey).last_class, "waiting");
  });

  await test("a bad interval is ignored, never stored", () => {
    fcall("crank_fire", facts({ interval: "90m" }));
    assert.equal(hash(bkey).interval, "2h");
  });

  await test("crank_get follows the pane pointer, and refuses one whose hash names another pane", () => {
    const got = rs.cli("FCALL_RO", "crank_get", "0", "Workspace", "terminal_19");
    assert.match(got, new RegExp(NAME));
    assert.equal(rs.cli("FCALL_RO", "crank_get", "0", "Workspace", "19"), got, "N or terminal_N");
    assert.equal(rs.cli("FCALL_RO", "crank_get", "0", "Workspace", "terminal_18"), "");
    rs.cli("SET", "crank:idx:pane:Workspace:terminal_7", NAME);
    assert.equal(rs.cli("FCALL_RO", "crank_get", "0", "Workspace", "terminal_7"), "", "a stale pointer is no binding");
    rs.cli("DEL", "crank:idx:pane:Workspace:terminal_7");
  });

  await test("the legacy engine cannot clobber a v2 pane: crank_scan and crank_apply leave crank:b and its pointer alone", () => {
    const before = hash(bkey);
    rs.cli("FCALL", "crank_scan", "0", JSON.stringify({ session: "Workspace", panes: [{ pane: "terminal_19", tab: "pjangler", tab_key: "pjangler", keys: [], owners: [] }] }), "zcrank");
    rs.cli("FCALL", "crank_scan", "0", JSON.stringify({ session: "Workspace", panes: [] }), "zcrank");
    rs.cli("FCALL", "crank_apply", "0", JSON.stringify([{ op: "tab", key: "pjangler", enabled: false }]), "pj");
    assert.deepEqual(hash(bkey), before);
    assert.equal(rs.cli("GET", ptr), NAME);
  });

  await test("a fire after the hash expired re-creates it (cause reappear) from the facts it carries", () => {
    rs.cli("DEL", bkey);
    const out = fcall("crank_fire", facts({ interval: "2h" }));
    assert.equal(out.created, true);
    assert.equal(out.edges[0].cause, "reappear");
    assert.equal(hash(bkey).fires, "1");
  });

  await test("crank_end emits on -> ended with the reason, deletes the hash, drops only its own pointer", () => {
    const out = fcall("crank_end", { binding: NAME, reason: "pane_closed", detail: "gone" });
    assert.equal(out.ended, true);
    assert.deepEqual([out.edges[0].to, out.edges[0].cause, out.edges[0].detail], ["ended", "pane_closed", "gone"]);
    assert.equal(rs.cli("EXISTS", bkey), "0");
    assert.equal(rs.cli("EXISTS", ptr), "0");
    assert.equal(rs.cli("SISMEMBER", "crank:idx:bindings", bkey), "0");
    const stream = rs.cli("XRANGE", `crank:t:b:${NAME}`, "-", "+");
    assert.match(stream, /pane_closed/);
    // another binding now owns the pane: ending the old one (hash long gone) must not drop it
    rs.cli("SET", ptr, "crank-codex-deadbeef-1");
    const late = fcall("crank_end", { binding: NAME, reason: "orphan_reaped", zellij_session: "Workspace", pane: "19" });
    assert.equal(late.ended, false);
    assert.equal(rs.cli("GET", ptr), "crank-codex-deadbeef-1");
    rs.cli("DEL", ptr);
  });

  await test("an ended binding never comes back: a late fire is refused and cannot take the successor's pane", () => {
    const successor = "crank-claude-cccc2222-200";
    fcall("crank_attach", facts({ binding: successor, interval: "1d" }));
    assert.equal(rs.cli("GET", ptr), successor);
    const late = fcall("crank_fire", facts());
    assert.equal(late.refused, "ended");
    assert.equal(late.reason, "orphan_reaped", "the tombstone holds the LAST end reason");
    assert.equal(rs.cli("EXISTS", bkey), "0");
    assert.equal(rs.cli("GET", ptr), successor);
    const tombTtl = Number(rs.cli("PTTL", `crank:b:${NAME}:ended`));
    assert.ok(tombTtl > 2.9 * 86_400_000, `tombstone outlives any hash (3d), got ${tombTtl}`);
    assert.ok(Number(rs.cli("PTTL", `crank:t:b:${NAME}`)) > 0, "the ended binding's stream still expires");
    fcall("crank_end", { binding: successor, reason: "explicit" });
  });

  await test("a fire never steals a pane another binding holds; attach does claim it", () => {
    const a = "crank-claude-aaaa0001-301";
    const b = "crank-claude-bbbb0002-302";
    const pane3 = "crank:idx:pane:Workspace:terminal_3";
    fcall("crank_attach", facts({ binding: a, pane: "3" }));
    fcall("crank_attach", facts({ binding: b, pane: "3" }));
    assert.equal(rs.cli("GET", pane3), b);
    fcall("crank_fire", facts({ binding: a, pane: "3" }));
    assert.equal(rs.cli("GET", pane3), b);
    for (const name of [a, b]) fcall("crank_end", { binding: name, reason: "explicit" });
  });

  await test("an attach prunes index members whose hash expired; a pointer that outlived its hash reads expired", () => {
    const gone = "crank-claude-dddd0004-404";
    fcall("crank_attach", facts({ binding: gone, pane: "4" }));
    rs.cli("DEL", `crank:b:${gone}`);
    assert.equal(rs.cli("FCALL_RO", "crank_get", "0", "Workspace", "4").split("\n").join(" "), `binding ${gone} pane terminal_4 expired 1`);
    const other = "crank-claude-eeee0005-505";
    fcall("crank_attach", facts({ binding: other, pane: "5" }));
    assert.equal(rs.cli("SISMEMBER", "crank:idx:bindings", `crank:b:${gone}`), "0");
    fcall("crank_end", { binding: gone, reason: "orphan_reaped", zellij_session: "Workspace", pane: "4" });
    assert.equal(rs.cli("FCALL_RO", "crank_get", "0", "Workspace", "4"), "", "ended: no pointer, nothing to say");
    fcall("crank_end", { binding: other, reason: "explicit" });
  });

  await test("a malformed binding name is refused", () => {
    assert.equal(fcall("crank_attach", facts({ binding: "zcrank:tab:x" })).error, "binding must be crank-<cli>-<sid8>-<pid>");
  });

  // -------------------------------------------------------------------------
  // pj's writers
  // -------------------------------------------------------------------------

  await test("the store's binding() writes through the arbiter and throws on a refusal", () => {
    const store = redis({ port: rs.port });
    const n2 = "crank-claude-22222222-2";
    assert.equal(store.binding("crank_attach", facts({ binding: n2 })).created, true);
    assert.throws(() => store.binding("crank_attach", facts({ binding: "nope" })), /refused crank_attach/);
    assert.equal(store.binding("crank_end", { binding: n2, reason: "explicit" }).ended, true);
    assert.equal(store.binding("crank_fire", facts({ binding: n2 })).refused, "ended", "a refusal by tombstone is an answer, not a throw");
  });

  await test("redisProjector is fail-open: a dead Redis leaves a receipt in projection.jsonl, never a throw", () => {
    const saved = { port: process.env.ZCRANK_REDIS_PORT, state: process.env.CRANK_STATE_DIR };
    const state = join(workspace, "state");
    process.env.CRANK_STATE_DIR = state;
    try {
      process.env.ZCRANK_REDIS_PORT = String(rs.port);
      redisProjector("crank_attach", facts({ binding: N4 }));
      assert.equal(rs.cli("GET", ptr), N4, "the live path wrote");
      process.env.ZCRANK_REDIS_PORT = "1";
      assert.doesNotThrow(() => redisProjector("crank_fire", facts({ binding: N4 })));
      const rows = readFileSync(join(state, "projection.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].fn, "crank_fire");
      assert.equal(rows[0].binding, N4);
      assert.match(rows[0].error, /not answering/);
    } finally {
      for (const [k, v] of [["ZCRANK_REDIS_PORT", saved.port], ["CRANK_STATE_DIR", saved.state]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  // -------------------------------------------------------------------------
  // The prompt's read
  // -------------------------------------------------------------------------

  const paneEnv = { ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "19", ZCRANK_REDIS_HOST: "127.0.0.1", ZCRANK_REDIS_PORT: String(rs.port) };

  await test("prompt: a bound pane renders from its binding, over the legacy hash the engine wrote OFF", async () => {
    rs.cli("FCALL", "crank_scan", "0", JSON.stringify({ session: "Workspace", panes: [{ pane: "terminal_19", tab: "pjangler", tab_key: "pjangler", keys: [], owners: [] }] }), "zcrank");
    assert.equal(hash("crank:p:Workspace:terminal_19").on, "0");
    const state = await readPaneCrank(paneEnv, Date.now());
    assert.equal(state.scope, "session");
    assert.equal(state.enabled, true);
    assert.equal(state.interval, "5m");
  });

  await test("prompt: once the binding ends the legacy hash decides again", async () => {
    fcall("crank_end", { binding: N4, reason: "explicit" });
    const state = await readPaneCrank(paneEnv, Date.now());
    assert.equal(state.enabled, false);
    assert.equal(state.scope, "tab");
  });

  await test("prompt: an arbiter without crank_get (not reloaded yet) falls back to the legacy hash", async () => {
    const bare = await startThrowawayRedis({ arbiter: false });
    try {
      bare.cli("HSET", "crank:p:Workspace:terminal_19", "on", "1", "decided_by", "tab", "interval", "5m", "since", String(Date.now() - 60_000));
      bare.cli("HSET", "crank:engine", "scan_ms", String(Date.now()));
      const state = await readPaneCrank({ ...paneEnv, ZCRANK_REDIS_PORT: String(bare.port) }, Date.now());
      assert.equal(state.enabled, true);
      assert.equal(state.scope, "tab");
    } finally {
      await bare.stop();
    }
  });
} finally {
  await rs.stop();
}

console.log(results.join("\n"));
if (failures) {
  console.error(`${failures} PJAN-215 test(s) failed`);
  process.exit(1);
}
console.log(`PJAN-215 crank projection: ${results.length} passed`);
assert.ok(existsSync(kitOut));
