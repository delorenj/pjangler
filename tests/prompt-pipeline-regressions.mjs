import "./helpers/hermetic-suite.mjs";
// The 33GOD pipeline segments of `pjangler-prompt` (src/prompt-pipeline.ts, src/prompt-refresh.ts):
//   - the cache contract: a foreign/garbage/wrong-version cache is ignored, an expired one is
//     hidden, a stale one is shown AND refreshed;
//   - the refresh lock: exclusive, and a dead child's lock is taken over;
//   - the formatting: `<candy U+10EF0D> project/total`, `⚡ crank ↑3d4h ↻5m ⏳2m` / `◌ crank off`, parts
//     omitted when unknown, `⚠ crank stalled` when the engine stopped scanning;
//   - the crank segment of a zellij pane: read DIRECTLY from the arbiter's resolved hash
//     (crank:p:<session>:terminal_<N>) and the engine heartbeat (crank:engine) over a tiny RESP2 client,
//     against a throwaway redis-server with crank.lua loaded: ON / OFF / not-watched / stalled / Redis down;
//   - the refresher's halves: candybar counting, and the project's crank outside zellij (the arbiter's verdict);
//   - end to end: the built dist/prompt.js prints the cached segments, reads crank straight from Redis in a
//     pane, and stays silent off-project.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { startThrowawayRedis } from "./pjan-182-crank-regressions-helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "prompt-pipeline-"));
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

writeFileSync(
  join(workspace, "entry.ts"),
  [
    `export * from ${JSON.stringify(join(root, "src/prompt-pipeline.ts"))};`,
    `export { formatPromptLine } from ${JSON.stringify(join(root, "src/prompt.ts"))};`,
    `export { candybarProjectName, countCandybars, readArbiterFacts, readCandybars, readCrank, sweepCacheDir, tabOnSinceMs, writeCacheAtomically } from ${JSON.stringify(join(root, "src/prompt-refresh.ts"))};`,
    `export { encodeCommand, parseResp, redisPipeline, replyToHash } from ${JSON.stringify(join(root, "src/crank/resp.ts"))};`,
  ].join("\n"),
);
const kitOut = join(workspace, "kit.mjs");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [join(workspace, "entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", "--sourcemap=inline", `--outfile=${kitOut}`],
  { encoding: "utf8", env: hermeticEnv() },
);
if (built.status !== 0) {
  console.error(`failed to bundle the prompt-pipeline kit:\n${built.stderr}`);
  process.exit(1);
}
const kit = await import(kitOut);
const {
  PIPELINE_CACHE_VERSION, PIPELINE_REFRESH_AFTER_MS, PIPELINE_EXPIRE_AFTER_MS, PIPELINE_LOCK_STALE_MS,
  pipelineCacheDir, pipelineCachePath, readPipelineCache, freshSegments, needsRefresh,
  formatCandybars, formatCrank, takeRefreshLock, CANDYBAR_GLYPH, maybeRefresh, formatPromptLine,
  countCandybars, readArbiterFacts, readCandybars, readCrank, sweepCacheDir, writeCacheAtomically, candybarProjectName,
  formatSpan, formatCountdown, CRANK_STALL_AFTER_MS, CRANK_READ_TIMEOUT_MS,
  crankFromArbiter, readPaneCrank, zellijPane, tabOnSinceMs,
  encodeCommand, parseResp, redisPipeline, replyToHash,
} = kit;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

const NOW = 1_800_000_000_000;
const projectRoot = join(workspace, "proj");
const cacheDir = join(workspace, "cache");

function cacheFile(extra = {}) {
  return {
    v: PIPELINE_CACHE_VERSION,
    writtenAtMs: NOW,
    root: projectRoot,
    candybars: { project: 3, total: 124 },
    crank: { enabled: true, interval: "5m", scope: "tab" },
    ...extra,
  };
}

console.log("cache location");
await test("PJ_PROMPT_CACHE_DIR wins, then XDG_CACHE_HOME, then ~/.cache", () => {
  assert.equal(pipelineCacheDir({ PJ_PROMPT_CACHE_DIR: "/x" }), "/x");
  assert.equal(pipelineCacheDir({ XDG_CACHE_HOME: "/xdg" }), "/xdg/pjangler/prompt");
  assert.equal(pipelineCacheDir({ HOME: "/h" }), "/h/.cache/pjangler/prompt");
});
await test("one file per (root, in-a-pane or not): a pane's cache holds no crank, so panes share it; outside a pane it is separate", () => {
  const env = { PJ_PROMPT_CACHE_DIR: cacheDir };
  const a = pipelineCachePath(projectRoot, { ...env, ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "3" });
  const b = pipelineCachePath(projectRoot, { ...env, ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "4" });
  const off = pipelineCachePath(projectRoot, env);
  assert.equal(a, b, "crank is read live per pane now, so the cache is not keyed per pane id");
  assert.notEqual(a, off, "the project-scope crank outside a pane never overwrites the pane's cache");
  assert.equal(a, pipelineCachePath(projectRoot, { ...env, ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "3" }));
  assert.notEqual(off, pipelineCachePath(join(workspace, "other"), env));
});

console.log("cache contract");
mkdirSync(cacheDir, { recursive: true });
const path = join(cacheDir, "c.json");
await test("a valid cache round-trips", () => {
  writeFileSync(path, JSON.stringify(cacheFile()));
  assert.deepEqual(readPipelineCache(path, projectRoot), cacheFile());
});
await test("absent, garbage, wrong version or another root's cache is ignored", () => {
  assert.equal(readPipelineCache(join(cacheDir, "missing.json"), projectRoot), undefined);
  writeFileSync(path, "{not json");
  assert.equal(readPipelineCache(path, projectRoot), undefined);
  writeFileSync(path, JSON.stringify(cacheFile({ v: 999 })));
  assert.equal(readPipelineCache(path, projectRoot), undefined);
  writeFileSync(path, JSON.stringify(cacheFile({ root: "/elsewhere" })));
  assert.equal(readPipelineCache(path, projectRoot), undefined);
  writeFileSync(path, JSON.stringify(cacheFile({ writtenAtMs: "soon" })));
  assert.equal(readPipelineCache(path, projectRoot), undefined);
});
await test("a malformed segment degrades to null alone, never the whole line", () => {
  writeFileSync(path, JSON.stringify(cacheFile({ candybars: { project: -1, total: 2 }, crank: { enabled: "yes", scope: "tab" } })));
  const cache = readPipelineCache(path, projectRoot);
  assert.equal(cache.candybars, null);
  assert.equal(cache.crank, null);
  writeFileSync(path, JSON.stringify(cacheFile({ crank: { enabled: true, scope: "moon" } })));
  assert.equal(readPipelineCache(path, projectRoot).crank, null);
});
await test("fresh and stale caches are shown; an expired or future one is hidden", () => {
  const cache = cacheFile();
  assert.deepEqual(freshSegments(cache, NOW + 1), { candybars: cache.candybars, crank: cache.crank });
  assert.deepEqual(freshSegments(cache, NOW + PIPELINE_REFRESH_AFTER_MS + 1).crank, cache.crank);
  assert.deepEqual(freshSegments(cache, NOW + PIPELINE_EXPIRE_AFTER_MS + 1), { candybars: null, crank: null });
  assert.deepEqual(freshSegments(cache, NOW - PIPELINE_REFRESH_AFTER_MS - 1), { candybars: null, crank: null });
  assert.deepEqual(freshSegments(undefined, NOW), { candybars: null, crank: null });
});
await test("refresh is wanted when absent, stale or from the future — not while fresh", () => {
  assert.equal(needsRefresh(undefined, NOW), true);
  assert.equal(needsRefresh(cacheFile(), NOW + 1000), false);
  assert.equal(needsRefresh(cacheFile(), NOW + PIPELINE_REFRESH_AFTER_MS + 1), true);
  assert.equal(needsRefresh(cacheFile(), NOW - 1), true);
});

console.log("refresh lock");
await test("the lock is exclusive until released or stale", () => {
  const lockCache = join(cacheDir, "lock-test.json");
  const lock = `${lockCache}.lock`;
  assert.equal(takeRefreshLock(lockCache, Date.now()), true);
  assert.equal(takeRefreshLock(lockCache, Date.now()), false);
  const old = (Date.now() - PIPELINE_LOCK_STALE_MS - 5_000) / 1000;
  utimesSync(lock, old, old);
  assert.equal(takeRefreshLock(lockCache, Date.now()), true, "a dead child's lock is taken over");
  rmSync(lock);
});
await test("PJ_PROMPT_NO_REFRESH=1 and a fresh cache both spawn nothing", () => {
  const p = join(cacheDir, "noref.json");
  assert.equal(maybeRefresh(projectRoot, p, undefined, NOW, { PJ_PROMPT_NO_REFRESH: "1" }), false);
  assert.equal(existsSync(`${p}.lock`), false);
  assert.equal(maybeRefresh(projectRoot, p, cacheFile(), NOW + 1, {}), false);
  assert.equal(existsSync(`${p}.lock`), false);
});

console.log("formatting");
await test("segments follow the age, in order, joined by ·", () => {
  const base = { root: projectRoot, slug: "pjangler", identifier: "PJAN", age: "3m", active: true };
  assert.equal(formatPromptLine(base), "pjangler (PJAN) · 3m");
  assert.equal(
    formatPromptLine({ ...base, candybars: { project: 3, total: 124 }, crank: { enabled: true, interval: "1h", scope: "tab" } }, NOW + 60_000),
    `pjangler (PJAN) · 3m · ${CANDYBAR_GLYPH} 3/124 · ⚡ crank ↻1h ⏳4m`,
    "crank is the LAST segment: a 1h tab that never ran is due at the next 5m tick",
  );
  assert.equal(formatPromptLine({ ...base, age: undefined, candybars: null, crank: { enabled: false, scope: "pane" } }), "pjangler (PJAN) · ◌ crank off");
});
await test("unknown is omitted, OFF is explicit", () => {
  assert.equal(CANDYBAR_GLYPH, String.fromCodePoint(0x10ef0d), "the candy glyph font's codepoint (scripts/build-prompt-font.py)");
  const fontScript = readFileSync(join(root, "scripts", "build-prompt-font.py"), "utf8");
  assert.match(fontScript, /"candy": \("candy\.svg", 0x10EF0D\)/, "the font builder puts the candy where the prompt prints it");
  assert.match(readFileSync(join(root, "assets", "prompt-glyphs", "candy.svg"), "utf8"), /<path d=/);
  assert.equal(formatCandybars({ project: 0, total: 7 }, {}), `${CANDYBAR_GLYPH} 0/7`);
  assert.equal(formatCandybars({ project: 0, total: 7 }, { PJ_PROMPT_CANDYBAR_GLYPH: "🍫" }), "🍫 0/7", "override for a machine without the font");
  assert.equal(formatCrank({ enabled: false, interval: "5m", scope: "tab" }), "◌ crank off");
  assert.equal(formatCrank({ enabled: true, scope: "project" }), "⚡ crank");
});
await test("uptime spans: two largest units, a zero second unit dropped", () => {
  const m = 60_000, h = 60 * m, d = 24 * h;
  assert.equal(formatSpan(0), "<1m");
  assert.equal(formatSpan(59_999), "<1m");
  assert.equal(formatSpan(22 * m + 59_000), "22m");
  assert.equal(formatSpan(5 * h), "5h");
  assert.equal(formatSpan(5 * h + 22 * m), "5h22m");
  assert.equal(formatSpan(3 * d + 4 * h + 59 * m), "3d4h");
  assert.equal(formatSpan(7 * d), "1w");
  assert.equal(formatSpan(10 * d + 5 * h), "1w3d");
  assert.equal(formatSpan(-5), "<1m", "a clock skew never prints a negative span");
});
await test("countdown: minutes, then seconds in the last minute, then now", () => {
  assert.equal(formatCountdown(4 * 60_000 + 59_999), "4m");
  assert.equal(formatCountdown(60_000), "1m");
  assert.equal(formatCountdown(59_999), "59s");
  assert.equal(formatCountdown(1_000), "1s");
  assert.equal(formatCountdown(999), "now");
  assert.equal(formatCountdown(-5_000), "now");
  assert.equal(formatCountdown(65 * 60_000), "1h5m");
  assert.equal(formatCountdown(6 * 3600_000), "6h");
});
await test("ON: uptime, interval, countdown — each from its own fact, each omitted when unknown", () => {
  const tick = 300_000;
  const on = { enabled: true, interval: "5m", scope: "tab", onSinceMs: NOW - (3 * 24 + 4) * 3600_000, engineScanMs: NOW - 60_000 };
  assert.equal(formatCrank(on, NOW + 2 * 60_000 + 30_000), "⚡ crank ↑3d4h ↻5m ⏳2m");
  assert.equal(formatCrank(on, NOW + tick - 42_000), "⚡ crank ↑3d4h ↻5m ⏳42s");
  assert.equal(formatCrank(on, NOW), "⚡ crank ↑3d4h ↻5m ⏳now", "a tick landing on now is the cron firing");
  assert.equal(formatCrank({ ...on, onSinceMs: undefined }, NOW + 1_000), "⚡ crank ↻5m ⏳4m");
  // A 1h tab that ran 20m ago: next at the first tick at/after last + 55m.
  const hourly = { enabled: true, interval: "1h", scope: "pane", lastRunMs: NOW - 20 * 60_000, onSinceMs: NOW - 22 * 60_000 };
  assert.equal(formatCrank(hourly, NOW), "⚡ crank ↑22m ↻1h ⏳35m");
  assert.equal(formatCrank({ ...hourly, interval: "banana" }, NOW), "⚡ crank ↑22m ↻banana", "no countdown for an interval we cannot schedule");
  assert.equal(formatCrank({ enabled: false, scope: "tab", onSinceMs: NOW - 1 }, NOW), "◌ crank off");
});
await test("an engine that stopped scanning is not cranking: stalled, judged when the cache was written", () => {
  const on = { enabled: true, interval: "5m", scope: "tab", onSinceMs: NOW - 3600_000, engineScanMs: NOW - 4 * 60_000 };
  assert.match(formatCrank(on, NOW + 14 * 60_000), /^⚡ crank ↑1h/, "an old cache of a healthy engine is not an alarm");
  assert.equal(formatCrank({ ...on, stalled: true, engineScanMs: NOW - 25 * 60_000 }, NOW), "⚠ crank stalled 25m ↻5m");
  assert.equal(formatCrank({ enabled: true, scope: "tab", stalled: true }, NOW), "⚠ crank stalled");
});
await test("the cache carries the timing facts, and drops garbage ones with the whole crank", () => {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, "timing.json");
  const crank = { enabled: true, interval: "5m", scope: "pane", onSinceMs: NOW - 1, lastRunMs: NOW - 2, engineScanMs: NOW - 3 };
  writeFileSync(path, JSON.stringify(cacheFile({ crank })));
  assert.deepEqual(readPipelineCache(path, projectRoot).crank, crank);
  for (const bad of [{ onSinceMs: "yesterday" }, { lastRunMs: -1 }, { engineScanMs: Number.POSITIVE_INFINITY }, { onSinceMs: 0 }, { stalled: "yes" }]) {
    writeFileSync(path, JSON.stringify(cacheFile({ crank: { ...crank, ...bad } })));
    assert.equal(readPipelineCache(path, projectRoot).crank, null, JSON.stringify(bad));
  }
});

console.log("crank, from the arbiter's resolved hash (pure)");
await test("zellijPane: the session and terminal_<N>, only when both are usable", () => {
  assert.deepEqual(zellijPane({ ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "9" }), { session: "Workspace", pane: "terminal_9" });
  assert.equal(zellijPane({ ZELLIJ_PANE_ID: "9" }), undefined, "no session: cannot address the hash");
  assert.equal(zellijPane({ ZELLIJ_SESSION_NAME: "Workspace" }), undefined);
  assert.equal(zellijPane({ ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "plugin-3" }), undefined);
  assert.equal(zellijPane({}), undefined);
});
await test("on=1: since, interval and last_run map straight over; the engine heartbeat is the scan age", () => {
  const hash = { on: "1", since: String(NOW - 3 * 86_400_000), interval: "1h", last_run: String(NOW - 20 * 60_000), decided_by: "tab", scan_ms: String(NOW - 60_000) };
  const state = crankFromArbiter(hash, { scan_ms: String(NOW - 90_000) }, NOW);
  assert.deepEqual(state, { enabled: true, scope: "tab", interval: "1h", onSinceMs: NOW - 3 * 86_400_000, lastRunMs: NOW - 20 * 60_000, engineScanMs: NOW - 90_000 });
  assert.equal(formatCrank(state, NOW), "⚡ crank ↑3d ↻1h ⏳35m");
  assert.equal(crankFromArbiter({ ...hash, decided_by: "pane" }, { scan_ms: String(NOW) }, NOW).scope, "pane");
  assert.equal(crankFromArbiter({ ...hash, decided_by: "unlisted" }, { scan_ms: String(NOW) }, NOW).scope, "tab");
  const bare = crankFromArbiter({ on: "1", last_run: "", since: "", interval: "soon" }, { scan_ms: String(NOW) }, NOW);
  assert.deepEqual(bare, { enabled: true, scope: "tab", engineScanMs: NOW }, "an empty or junk fact is unknown and left out, never guessed");
});
await test("on=0 renders OFF (no timing); a hash that says neither is no segment", () => {
  assert.deepEqual(crankFromArbiter({ on: "0", interval: "5m", decided_by: "pane" }, { scan_ms: String(NOW) }, NOW), { enabled: false, scope: "pane", interval: "5m" });
  assert.equal(formatCrank(crankFromArbiter({ on: "0" }, { scan_ms: String(NOW) }, NOW), NOW), "◌ crank off");
  assert.equal(crankFromArbiter({ on: "maybe" }, { scan_ms: String(NOW) }, NOW), undefined);
  assert.equal(formatCrank(crankFromArbiter({ on: "0" }, {}, NOW - 99 * 3600_000), NOW), "◌ crank off", "OFF is never an alarm, whatever the heartbeat");
});
await test("no hash: a fresh heartbeat means the engine does not watch this pane (nothing); none or an old one is stalled", () => {
  assert.equal(crankFromArbiter({}, { scan_ms: String(NOW - 60_000) }, NOW), undefined);
  assert.equal(crankFromArbiter(undefined, { scan_ms: String(NOW - CRANK_STALL_AFTER_MS) }, NOW), undefined, "exactly at the limit is still fresh");
  const old = crankFromArbiter({}, { scan_ms: String(NOW - 25 * 60_000) }, NOW);
  assert.deepEqual(old, { enabled: true, scope: "pane", stalled: true, engineScanMs: NOW - 25 * 60_000 });
  assert.equal(formatCrank(old, NOW), "⚠ crank stalled 25m");
  const none = crankFromArbiter({}, {}, NOW);
  assert.equal(formatCrank(none, NOW), "⚠ crank stalled", "no heartbeat at all: stalled, with no age to claim");
});
await test("a hash that exists while the engine went quiet: ON turns stalled (with the age and interval)", () => {
  const hash = { on: "1", since: String(NOW - 3600_000), interval: "5m", scan_ms: String(NOW - 30 * 60_000) };
  const quiet = crankFromArbiter(hash, { scan_ms: String(NOW - 25 * 60_000) }, NOW);
  assert.equal(quiet.stalled, true);
  assert.equal(formatCrank(quiet, NOW), "⚠ crank stalled 25m ↻5m");
  // the heartbeat key gone (TTL) but the pane's own scan_ms known: that is the age
  assert.equal(formatCrank(crankFromArbiter(hash, {}, NOW), NOW), "⚠ crank stalled 30m ↻5m");
});
await test("project outside zellij: the oldest `since` among the ON panes this tab governs", () => {
  const panes = [
    { on: "1", since: String(NOW - 9e6), tab: "HeyMa", tab_key: "heyma", keys: JSON.stringify(["HeyMa"]) },
    { on: "1", since: String(NOW - 5e6), tab: "HeyMa", tab_key: "heyma", keys: JSON.stringify(["HeyMa"]) },
    { on: "0", since: String(NOW - 9e8), tab: "HeyMa", tab_key: "heyma", keys: JSON.stringify(["HeyMa"]) },
    { on: "1", since: String(NOW - 9e7), tab: "Other", tab_key: "other", keys: JSON.stringify(["Other"]) },
    { on: "1", since: String(NOW - 8e6), tab: "renamed scratch", tab_key: "renamedscratch", keys: JSON.stringify(["james-brennan"]) },
  ];
  assert.equal(tabOnSinceMs(panes, "HeyMa 🟢", ["HeyMa"]), NOW - 9e6, "by governing key, and OFF panes never count");
  assert.equal(tabOnSinceMs(panes, "heyma", []), NOW - 9e6, "by tab name when no key is known");
  assert.equal(tabOnSinceMs(panes, "ipm", ["james-brennan"]), NOW - 8e6, "a rooted key governs a tab that is named something else");
  assert.equal(tabOnSinceMs(panes, "Nowhere", ["Nowhere"]), undefined);
  assert.equal(tabOnSinceMs([], "HeyMa", ["HeyMa"]), undefined);
});

console.log("RESP2 client (builtins only)");
await test("parseResp: every reply type, bulk strings by BYTE length, nested arrays, and a partial buffer is 'read more'", () => {
  const p = (text) => parseResp(Buffer.from(text, "utf8"));
  assert.deepEqual(p("+OK\r\n"), { value: "OK", next: 5 });
  assert.deepEqual(p(":42\r\n").value, 42);
  assert.equal(p("$-1\r\n").value, null);
  assert.equal(p("*-1\r\n").value, null);
  assert.deepEqual(p("-ERR boom\r\n").value, { error: "ERR boom" });
  assert.equal(p("$5\r\nhello\r\n").value, "hello");
  assert.equal(p("$4\r\n🟢\r\n").value, "🟢", "a 4-byte glyph is length 4");
  assert.deepEqual(p("*2\r\n$1\r\na\r\n*1\r\n:7\r\n").value, ["a", [7]]);
  assert.deepEqual(p("*0\r\n").value, []);
  assert.equal(p("$5\r\nhel"), undefined, "mid-bulk");
  assert.equal(p("*2\r\n$1\r\na\r\n"), undefined, "mid-array");
  assert.equal(p(""), undefined);
  assert.throws(() => p("?what\r\n"), /not RESP2/);
  assert.equal(encodeCommand(["HGETALL", "k🟢"]).toString("utf8"), "*2\r\n$7\r\nHGETALL\r\n$5\r\nk🟢\r\n");
  assert.deepEqual(replyToHash(["a", "1", "b", ""]), { a: "1", b: "" });
  assert.deepEqual(replyToHash([]), {});
  assert.equal(replyToHash("nope"), undefined);
});

console.log("refresher: candybar");
await test("counts registered (non-archived) rows, overall and for the project tag", () => {
  const rows = [
    { tags: ["project:HeyMa"], archived: false, enabled: true },
    { tags: ["project:HeyMa"], archived: false, enabled: false },
    { tags: ["project:HeyMa"], archived: true },
    { tags: ["project:heyma"] },
    { tags: "project:HeyMa" },
    null,
  ];
  assert.deepEqual(countCandybars(rows, "HeyMa"), { project: 2, total: 4 });
  assert.equal(countCandybars({ detail: "nope" }, "HeyMa"), null);
});
await test("reads $CANDYBAR_API_URL/candybars; an error or a dead API is null, not zero", async () => {
  let status = 200;
  const server = createServer((req, res) => {
    if (req.url !== "/candybars") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify([{ tags: ["project:proj"] }, { tags: [] }]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    mkdirSync(projectRoot, { recursive: true });
    // Outside git a dir is a candybar project only with .candybars/ or .candybar.toml (find_project).
    assert.deepEqual(await readCandybars(projectRoot, { CANDYBAR_API_URL: url }), { project: 0, total: 2 });
    writeFileSync(join(projectRoot, ".candybar.toml"), "");
    assert.deepEqual(await readCandybars(projectRoot, { CANDYBAR_API_URL: url }), { project: 1, total: 2 });
    status = 500;
    assert.equal(await readCandybars(projectRoot, { CANDYBAR_API_URL: url }), null);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(await readCandybars(projectRoot, { CANDYBAR_API_URL: url }), null);
});

await test("project name is candybar's: worktree -> main checkout, subdir -> toplevel, non-git -> .candybars ancestor", () => {
  const g = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: hermeticEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }) });
    assert.equal(r.status, 0, r.stderr);
  };
  const repo = join(workspace, "names", "HeyMa");
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  g(repo, "init", "-q");
  g(repo, "commit", "-q", "--allow-empty", "-m", "x");
  assert.equal(candybarProjectName(repo), "HeyMa");
  assert.equal(candybarProjectName(join(repo, "src", "deep")), "HeyMa");
  g(repo, "worktree", "add", "-q", join(workspace, "names", "heyma-wt"));
  assert.equal(candybarProjectName(join(workspace, "names", "heyma-wt")), "HeyMa");
  const loose = join(workspace, "loose", "proj", "sub");
  mkdirSync(join(workspace, "loose", "proj", ".candybars"), { recursive: true });
  mkdirSync(loose, { recursive: true });
  assert.equal(candybarProjectName(loose), "proj");
  assert.equal(candybarProjectName(join(workspace, "does-not-exist")), undefined);
  assert.deepEqual(countCandybars([{ tags: ["project:x"] }], undefined), { project: 0, total: 1 });
});

console.log("the prompt reads crank straight from a throwaway redis-server with the arbiter loaded");
{
  const redisServer = await startThrowawayRedis();
  const port = redisServer.port;
  const SESSION = "Workspace";
  const cli = (...args) => redisServer.cli(...args);
  const paneEnv = (pane, extra = {}) => ({ ZELLIJ_SESSION_NAME: SESSION, ZELLIJ_PANE_ID: String(pane), ZCRANK_REDIS_PORT: String(port), ...extra });
  /** The engine's scan of one pane, through the arbiter's own crank_scan (stamps since / last_run / the heartbeat). */
  const scan = (panes) => cli("FCALL", "crank_scan", "0", JSON.stringify({ session: SESSION, panes }), "test");
  const apply = (ops) => cli("FCALL", "crank_apply", "0", JSON.stringify(ops), "test");
  const pane = (n, tab, extra = {}) => ({ pane: `terminal_${n}`, tab, tab_key: tab.toLowerCase(), keys: [tab], owners: [tab], ...extra });
  try {
    const day = 86_400_000;
    const ranAt = Date.now() - 20 * 60_000;
    /** A pane that just appeared with a known history: the seed only applies to a new hash, so start clean. */
    const reseed = () => {
      cli("DEL", `crank:p:${SESSION}:terminal_9`, `crank:p:${SESSION}:terminal_10`);
      scan([pane(9, "HeyMa", { seed_since_ms: Date.now() - 3 * day, last_run_ms: ranAt }), pane(10, "Quiet")]);
    };
    apply([{ op: "tab", key: "HeyMa", enabled: true, interval: "1h" }, { op: "tab", key: "Quiet", enabled: false }]);
    reseed();
    await test("ON: ↑ uptime from the arbiter's since, ↻ interval, ⏳ countdown from last_run", async () => {
      const state = await readPaneCrank(paneEnv(9), Date.now());
      assert.equal(state.enabled, true);
      assert.equal(state.interval, "1h");
      assert.equal(state.scope, "tab");
      assert.equal(state.lastRunMs, ranAt);
      assert.ok(Math.abs(state.onSinceMs - (Date.now() - 3 * day)) < 10_000, "since is the seeded 3d ago");
      assert.ok(state.engineScanMs > Date.now() - 10_000, "the heartbeat of the scan that just ran");
      assert.equal(state.stalled, undefined);
      assert.match(formatCrank(state, Date.now()), /^⚡ crank ↑3d ↻1h ⏳\d+m$/);
    });
    await test("OFF renders '◌ crank off'", async () => {
      const state = await readPaneCrank(paneEnv(10), Date.now());
      assert.equal(state.enabled, false);
      assert.equal(formatCrank(state, Date.now()), "◌ crank off");
    });
    await test("a pane override OFF is the arbiter's verdict on that pane, decided_by pane", async () => {
      apply([{ op: "pane", owner: "HeyMa", pane: "terminal_9", value: "0" }]);
      scan([pane(9, "HeyMa"), pane(10, "Quiet")]);
      const state = await readPaneCrank(paneEnv(9), Date.now());
      assert.deepEqual([state.enabled, state.scope], [false, "pane"]);
      apply([{ op: "pane", owner: "HeyMa", pane: "terminal_9", value: "" }]);
      reseed();
      assert.equal((await readPaneCrank(paneEnv(9), Date.now())).enabled, true);
    });
    await test("no hash for this pane + a fresh heartbeat: the engine does not watch it, no segment", async () => {
      assert.equal(await readPaneCrank(paneEnv(77), Date.now()), undefined);
      assert.equal(await readPaneCrank({ ...paneEnv(9), ZELLIJ_SESSION_NAME: "Elsewhere" }, Date.now()), undefined, "another session's hash is not this one");
    });
    await test("no heartbeat at all: stalled; an old one with no hash: stalled with its age", async () => {
      const hb = cli("HGETALL", "crank:engine");
      cli("DEL", "crank:engine");
      const none = await readPaneCrank(paneEnv(77), Date.now());
      assert.equal(formatCrank(none, Date.now()), "⚠ crank stalled");
      cli("HSET", "crank:engine", "scan_ms", String(Date.now() - 25 * 60_000));
      assert.equal(formatCrank(await readPaneCrank(paneEnv(77), Date.now()), Date.now()), "⚠ crank stalled 25m");
      assert.match(formatCrank(await readPaneCrank(paneEnv(9), Date.now()), Date.now()), /^⚠ crank stalled 2[45]m ↻1h$/, "an ON pane under a quiet engine is not being cranked");
      assert.equal(formatCrank(await readPaneCrank(paneEnv(10), Date.now()), Date.now()), "◌ crank off");
      reseed();
      assert.ok(hb.length > 0);
    });
    await test("Redis down: no segment (never OFF), and it answers inside the budget", async () => {
      const t0 = Date.now();
      assert.equal(await readPaneCrank(paneEnv(9, { ZCRANK_REDIS_PORT: "1" }), Date.now()), undefined);
      assert.ok(Date.now() - t0 < CRANK_READ_TIMEOUT_MS + 100, `refused at once (${Date.now() - t0}ms)`);
      assert.equal(await readPaneCrank({}, Date.now()), undefined, "not in a zellij pane: nothing to read");
    });
    await test("a server that accepts and never answers is cut off at the hard timeout", async () => {
      const { createServer } = await import("node:net");
      const held = [];
      const mute = createServer((socket) => { held.push(socket); });
      await new Promise((r) => mute.listen(0, "127.0.0.1", r));
      try {
        const t0 = Date.now();
        assert.equal(await readPaneCrank(paneEnv(9, { ZCRANK_REDIS_PORT: String(mute.address().port) }), Date.now()), undefined);
        const took = Date.now() - t0;
        assert.ok(took >= CRANK_READ_TIMEOUT_MS - 10 && took < CRANK_READ_TIMEOUT_MS + 150, `${took}ms`);
      } finally {
        for (const socket of held) socket.destroy();
        await new Promise((r) => mute.close(r));
      }
    });
    await test("redisPipeline: ordered replies for a pipeline, a server error is a reply, not a failure", async () => {
      const replies = await redisPipeline({ host: "127.0.0.1", port }, [["PING"], ["HGET", "zcrank:tab:HeyMa", "interval"], ["NOSUCHCOMMAND"]], 1000);
      assert.equal(replies[0], "PONG");
      assert.equal(replies[1], "1h");
      assert.match(replies[2].error, /unknown command/i);
    });

    console.log("refresher: a project outside zellij — the arbiter's verdict for its tab, the oldest ON since, the heartbeat");
    const proj = join(workspace, "crank-proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, ".project.json"), JSON.stringify({ project_id: "heyma", project_name: "HeyMa" }));
    const savedPath = process.env.PATH;
    const savedPort = process.env.ZCRANK_REDIS_PORT;
    const savedCwd = process.cwd();
    // no zellij on PATH: the tab resolves by name from the stored key
    process.env.ZCRANK_REDIS_PORT = String(port);
    process.chdir(proj);
    try {
      cli("RPUSH", "zcrank:log:HeyMa", JSON.stringify({ ts: new Date(ranAt).toISOString().replace(/\.\d{3}Z$/, "Z"), state: "sent", action: "x" }));
      await test("ON: interval from the arbiter, last run from the beat log, since from the oldest ON pane, heartbeat fresh", async () => {
        const state = await readCrank(process.env, Date.now());
        assert.equal(state.scope, "project");
        assert.equal(state.enabled, true);
        assert.equal(state.interval, "1h");
        assert.ok(Math.abs(state.lastRunMs - ranAt) < 1000);
        assert.ok(Math.abs(state.onSinceMs - (Date.now() - 3 * day)) < 10_000);
        assert.equal(state.stalled, undefined);
        const facts = await readArbiterFacts(process.env);
        assert.ok(facts.panes.length >= 2);
      });
      await test("no engine heartbeat: stalled; OFF carries no timing; Redis down is null, not OFF", async () => {
        const saved = cli("HGET", "crank:engine", "scan_ms");
        cli("DEL", "crank:engine");
        assert.equal((await readCrank(process.env, Date.now())).stalled, true);
        cli("HSET", "crank:engine", "scan_ms", saved);
        apply([{ op: "tab", key: "HeyMa", enabled: false }]);
        assert.deepEqual(await readCrank(process.env, Date.now()), { enabled: false, interval: "1h", scope: "project" });
        process.env.ZCRANK_REDIS_PORT = "1";
        assert.equal(await readCrank(process.env, Date.now()), null);
      });
    } finally {
      process.chdir(savedCwd);
      process.env.PATH = savedPath;
      if (savedPort === undefined) delete process.env.ZCRANK_REDIS_PORT;
      else process.env.ZCRANK_REDIS_PORT = savedPort;
    }

    console.log("end to end: dist/prompt.js in a zellij pane reads the arbiter directly (no cache, no refresher)");
    apply([{ op: "tab", key: "HeyMa", enabled: true }]);
    reseed();
    await test("a pane outside every project prints the crank segment alone: ON, OFF, nothing, stalled, Redis down", () => {
      const bin = join(root, "dist", "prompt.js");
      assert.ok(existsSync(bin), "dist/prompt.js is built (npm run build)");
      const cacheDirE2e = join(workspace, "direct-cache");
      const run = (pane, extra = {}) => spawnSync(process.execPath, [bin], {
        cwd: workspace,
        encoding: "utf8",
        env: hermeticEnv({ PJ_PROMPT_CACHE_DIR: cacheDirE2e, PJ_PROMPT_NO_REFRESH: "1", ...paneEnv(pane), ...extra }),
      });
      const on = run(9);
      assert.equal(on.status, 0, on.stderr);
      assert.match(on.stdout, /^⚡ crank ↑3d ↻1h ⏳\d+m$/u, on.stdout);
      assert.equal(run(10).stdout, "◌ crank off");
      assert.equal(run(77).stdout, "", "a pane the engine does not watch");
      assert.equal(existsSync(cacheDirE2e), false, "no cache directory was even created: nothing cached, nothing refreshed");
      const saved = cli("HGET", "crank:engine", "scan_ms");
      cli("DEL", "crank:engine");
      assert.equal(run(77).stdout, "⚠ crank stalled");
      cli("HSET", "crank:engine", "scan_ms", saved);
      const t0 = Date.now();
      assert.equal(run(9, { ZCRANK_REDIS_PORT: "1" }).stdout, "", "Redis down: no segment, never OFF");
      assert.ok(Date.now() - t0 < 1500, "and it stays fast");
    });
    await test("inside a project in a pane: identity, the cached candybars, and crank from Redis, not from the cache", () => {
      const e2e = join(workspace, "direct-proj");
      mkdirSync(e2e, { recursive: true });
      writeFileSync(join(e2e, ".project.json"), JSON.stringify({ project_id: "direct", ticket_provider: { identifier: "DIR" } }));
      const env = hermeticEnv({ PJ_PROMPT_CACHE_DIR: join(workspace, "direct-proj-cache"), PJ_PROMPT_NO_REFRESH: "1", ...paneEnv(10) });
      const cachePath = pipelineCachePath(e2e, env);
      mkdirSync(join(workspace, "direct-proj-cache"), { recursive: true });
      // a cache that CLAIMS crank is ON: the pane's own answer (OFF) must win
      writeFileSync(cachePath, JSON.stringify({ ...cacheFile(), root: e2e, writtenAtMs: Date.now(), crank: { enabled: true, interval: "5m", scope: "tab" } }));
      const out = spawnSync(process.execPath, [join(root, "dist", "prompt.js")], { cwd: e2e, env, encoding: "utf8" });
      assert.match(out.stdout, new RegExp(`^direct \\(DIR\\)( · \\S+)? · ${CANDYBAR_GLYPH} 3/124 · ◌ crank off$`, "u"), out.stdout);
      const silent = spawnSync(process.execPath, [join(root, "dist", "prompt.js")], { cwd: e2e, env: { ...env, ZCRANK_REDIS_PORT: "1" }, encoding: "utf8" });
      assert.match(silent.stdout, new RegExp(`^direct \\(DIR\\)( · \\S+)? · ${CANDYBAR_GLYPH} 3/124$`, "u"), "Redis down: the cached crank is NOT shown in a pane either");
      const dir = { PJ_PROMPT_CACHE_DIR: join(workspace, "direct-proj-cache") };
      assert.notEqual(pipelineCachePath(e2e, env), pipelineCachePath(e2e, dir), "a pane's cache is its own (it holds no crank)");
      assert.equal(pipelineCachePath(e2e, env), pipelineCachePath(e2e, { ...dir, ...paneEnv(99) }), "...but not one per pane id: crank is no longer cached per pane");
    });
  } finally {
    await redisServer.stop();
  }
}

console.log("refresher: cache files");
await test("writes atomically into a missing dir; sweeps only day-old pipeline files", () => {
  const dir = join(workspace, "sweep", "nested");
  const keep = join(dir, "0123456789abcdef.json");
  writeCacheAtomically(keep, cacheFile());
  assert.deepEqual(readPipelineCache(keep, projectRoot), cacheFile());
  const old = (Date.now() - 2 * 24 * 3600_000) / 1000;
  for (const name of ["aaaaaaaaaaaaaaaa.json", "bbbbbbbbbbbbbbbb.json.lock", "cccccccccccccccc.json.123.tmp", "unrelated.txt"]) {
    writeFileSync(join(dir, name), "x");
    utimesSync(join(dir, name), old, old);
  }
  utimesSync(keep, old, old);
  assert.equal(sweepCacheDir(dir, Date.now(), keep), 3);
  assert.deepEqual(readdirSync(dir).sort(), ["0123456789abcdef.json", "unrelated.txt"]);
});

console.log("end to end: dist/prompt.js");
await test("prints cached segments inside a project; nothing outside", () => {
  const bin = join(root, "dist", "prompt.js");
  assert.ok(existsSync(bin), "dist/prompt.js is built (npm run build)");
  const proj = join(workspace, "e2e");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, ".project.json"), JSON.stringify({ project_id: "e2e", ticket_provider: { identifier: "E2E" } }));
  const e2eCache = join(workspace, "e2e-cache");
  const env = hermeticEnv({ PJ_PROMPT_CACHE_DIR: e2eCache, PJ_PROMPT_NO_REFRESH: "1" });
  const cachePath = pipelineCachePath(proj, env);
  mkdirSync(e2eCache, { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ ...cacheFile(), root: proj, writtenAtMs: Date.now() }));
  const run = (cwd) => spawnSync(process.execPath, [bin], { cwd, env, encoding: "utf8" });
  const inside = run(proj);
  assert.equal(inside.status, 0);
  assert.match(inside.stdout, new RegExp(`^e2e \\(E2E\\)( · \\S+)? · ${CANDYBAR_GLYPH} 3/124 · ⚡ crank ↻5m ⏳\\S+$`, "u"));
  const outside = run(workspace);
  assert.equal(outside.stdout, "");
  assert.equal(run(workspace).stdout, "", "no pane, no project: silent");
  // Expired cache: the identity line survives, the pipeline segments vanish.
  writeFileSync(cachePath, JSON.stringify({ ...cacheFile(), root: proj, writtenAtMs: Date.now() - PIPELINE_EXPIRE_AFTER_MS - 60_000 }));
  assert.doesNotMatch(run(proj).stdout, new RegExp(`${CANDYBAR_GLYPH}|crank`, "u"));
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).root, proj, "NO_REFRESH leaves the cache alone");
});

await test("a stale cache spawns the detached refresher, which writes the cache and releases the lock", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ tags: ["project:e2e-live"] }, { tags: [] }, { tags: [], archived: true }]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const proj = join(workspace, "e2e-live");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, ".project.json"), JSON.stringify({ project_id: "e2e-live" }));
    writeFileSync(join(proj, ".candybar.toml"), "");
    const env = hermeticEnv({
      PJ_PROMPT_CACHE_DIR: join(workspace, "e2e-live-cache"),
      CANDYBAR_API_URL: `http://127.0.0.1:${server.address().port}`,
      ZCRANK_REDIS_PORT: "1",
    });
    const run = () => spawnSync(process.execPath, [join(root, "dist", "prompt.js")], { cwd: proj, env, encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0);
    assert.doesNotMatch(first.stdout, new RegExp(CANDYBAR_GLYPH, "u"), "nothing cached yet");
    const cachePath = pipelineCachePath(proj, env);
    const deadline = Date.now() + 15_000;
    while (!(existsSync(cachePath) && !existsSync(`${cachePath}.lock`)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const cache = readPipelineCache(cachePath, proj);
    assert.ok(cache, "the detached child wrote the cache");
    assert.deepEqual(cache.candybars, { project: 1, total: 2 });
    assert.equal(cache.crank, null, "Redis down => crank unknown");
    assert.equal(existsSync(`${cachePath}.lock`), false, "lock released");
    assert.ok(run().stdout.endsWith(` · ${CANDYBAR_GLYPH} 1/2`));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

console.log(`prompt-pipeline: ${passed} passed`);
