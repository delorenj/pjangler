import "./helpers/hermetic-suite.mjs";
// The 33GOD pipeline segments of `pjangler-prompt` (src/prompt-pipeline.ts, src/prompt-refresh.ts):
//   - the cache contract: a foreign/garbage/wrong-version cache is ignored, an expired one is
//     hidden, a stale one is shown AND refreshed;
//   - the refresh lock: exclusive, and a dead child's lock is taken over;
//   - the formatting: `<candy U+10EF0D> project/total`, `⚡ crank ↑3d4h ↻5m ⏳2m` / `◌ crank off`, parts
//     omitted when unknown, `⚠ crank stalled` when the engine stopped scanning;
//   - crank uptime: the engine's per-pane continuity (on_since.json) sharpened by `enabled` rows;
//   - the refresher's pure halves: candybar counting and the engine's crank_enabled rule;
//   - end to end: the built dist/prompt.js prints the cached segments, and stays silent off-project.

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
    `export { candybarProjectName, countCandybars, engineCrankFor, paneOnSinceMs, readCandybars, readCrank, readEngineContinuity, sweepCacheDir, tabOnSinceMs, writeCacheAtomically, zcrankStateDir } from ${JSON.stringify(join(root, "src/prompt-refresh.ts"))};`,
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
  countCandybars, engineCrankFor, readCandybars, readCrank, sweepCacheDir, writeCacheAtomically, candybarProjectName,
  formatSpan, formatCountdown, CRANK_STALL_AFTER_MS, PANE_ONLY_ROOT,
  paneOnSinceMs, tabOnSinceMs, readEngineContinuity, zcrankStateDir,
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
await test("one file per (root, pane): two panes in one repo never share crank state", () => {
  const env = { PJ_PROMPT_CACHE_DIR: cacheDir };
  const a = pipelineCachePath(projectRoot, { ...env, ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "3" });
  const b = pipelineCachePath(projectRoot, { ...env, ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "4" });
  const off = pipelineCachePath(projectRoot, env);
  assert.notEqual(a, b);
  assert.notEqual(a, off);
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

console.log("crank uptime");
await test("pane: the engine's since, sharpened by the enable log", () => {
  const since = NOW, m = 60_000;
  assert.equal(paneOnSinceMs(since, {}, NOW), since);
  assert.equal(paneOnSinceMs(since, { enabledMs: since - 4 * m }, NOW), since - 4 * m, "enabled at :01, first seen at :05");
  assert.equal(paneOnSinceMs(since, { enabledMs: since - 5 * m }, NOW), since, "a tick or more earlier is an older run");
  assert.equal(paneOnSinceMs(since, { enabledMs: since + 3 * m }, NOW), since, "an idempotent re-enable changes nothing");
  assert.equal(paneOnSinceMs(since, { disabledMs: since + 2 * m, enabledMs: since + 3 * m }, NOW), since + 3 * m, "OFF then ON between two scans: a new run");
  assert.equal(paneOnSinceMs(since, { enabledMs: since + 2 * m, disabledMs: since + 3 * m }, NOW), since, "OFF last (a pane override keeps it ON): the engine's run");
  // Already ON when tracking began: reach back to the enable, unless an OFF came after it.
  assert.equal(paneOnSinceMs(since, { enabledMs: since - 9 * 24 * 60 * m }, NOW, since), since - 9 * 24 * 60 * m);
  assert.equal(paneOnSinceMs(since, { enabledMs: since - 9e6, disabledMs: since - 5e6 }, NOW, since), since);
  assert.equal(paneOnSinceMs(since + 5 * m, { enabledMs: since - 9e6 }, NOW, since), since + 5 * m, "turned ON after tracking began");
  // Not seen by the engine yet: only an enable newer than its last scan.
  assert.equal(paneOnSinceMs(undefined, { enabledMs: NOW - 1_000 }, NOW - 2_000), NOW - 1_000);
  assert.equal(paneOnSinceMs(undefined, { enabledMs: NOW - 3_000 }, NOW - 2_000), undefined, "the engine scanned after and did not see it ON");
  assert.equal(paneOnSinceMs(undefined, {}, NOW), undefined);
  assert.equal(paneOnSinceMs(undefined, { enabledMs: NOW - 1_000 }, undefined), NOW - 1_000, "no engine record at all");
});
await test("project (no pane): the oldest engine-tracked run on its tab; the log alone is unknown", () => {
  const engine = { scanMs: NOW, panes: { terminal_1: { sinceMs: NOW - 9e6, tab: "heyma" }, terminal_2: { sinceMs: NOW - 5e6, tab: "heyma" }, terminal_3: { sinceMs: NOW - 9e7, tab: "other" } } };
  assert.equal(tabOnSinceMs(engine, "HeyMa 🟢"), NOW - 9e6);
  assert.equal(tabOnSinceMs(engine, "Nowhere"), undefined);
  assert.equal(tabOnSinceMs(undefined, "HeyMa"), undefined);
});
await test("on_since.json: v1 shape only; junk rows dropped, junk files ignored", () => {
  const dir = join(workspace, "zstate");
  mkdirSync(dir, { recursive: true });
  const env = { ZCRANK_STATE_DIR: dir };
  assert.equal(zcrankStateDir(env), dir);
  assert.equal(zcrankStateDir({ HOME: "/h" }), "/h/.local/state/zcrank");
  assert.equal(readEngineContinuity(env), undefined, "absent");
  writeFileSync(join(dir, "on_since.json"), JSON.stringify({
    v: 1, scan_ts: "2026-11-18T16:10:00Z", fresh_since: "2026-11-17T00:00:00Z",
    panes: { terminal_2: { since: "2026-11-15T12:00:00Z", tab: "gruvato" }, terminal_3: { since: "soon" }, terminal_4: null },
  }));
  assert.deepEqual(readEngineContinuity(env), {
    scanMs: Date.parse("2026-11-18T16:10:00Z"),
    panes: { terminal_2: { sinceMs: Date.parse("2026-11-15T12:00:00Z"), tab: "gruvato" } },
    freshSinceMs: Date.parse("2026-11-17T00:00:00Z"),
  });
  for (const junk of ["nope", "[]", JSON.stringify({ v: 2, scan_ts: "2026-11-18T16:10:00Z", panes: {} }), JSON.stringify({ v: 1, scan_ts: "2026-11-18T16:10:00.5Z", panes: {} })]) {
    writeFileSync(join(dir, "on_since.json"), junk);
    assert.equal(readEngineContinuity(env), undefined, junk);
  }
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

console.log("refresher: crank (zcrank.py crank_enabled parity)");
function fakeStore(tabs = {}, panes = {}) {
  return {
    tabEnabled: (key) => tabs[key],
    getKey: (key) => panes[key],
  };
}
await test("unlisted tab = OFF", () => {
  assert.deepEqual(engineCrankFor(fakeStore(), "Skillex", "terminal_1", [], {}).enabled, false);
});
await test("tab ON, status suffix stripped", () => {
  const v = engineCrankFor(fakeStore({ gruvato: "1" }), "gruvato 🟢", "terminal_1", ["gruvato"], {});
  assert.equal(v.enabled, true);
  assert.equal(v.decidedBy, "tab");
});
await test("any OFF across spellings wins", () => {
  const store = fakeStore({ "green-in-between": "1", GreenInBetween: "0" });
  assert.equal(engineCrankFor(store, "green-in-between", undefined, ["green-in-between", "GreenInBetween"], {}).enabled, false);
});
await test("a key whose root is the tab's owner names the tab (PJAN-201)", () => {
  const store = fakeStore({ ipm: "1" });
  const v = engineCrankFor(store, "James Brennan", "terminal_2", ["ipm"], { owner: "/code/jb", roots: { ipm: "/code/jb" } });
  assert.equal(v.enabled, true);
  assert.deepEqual(v.keys, ["ipm"]);
  assert.equal(engineCrankFor(store, "James Brennan", "terminal_2", ["ipm"], { owner: "/code/other", roots: { ipm: "/code/jb" } }).enabled, false);
});
await test("a pane override beats its tab both ways", () => {
  assert.deepEqual(
    engineCrankFor(fakeStore({ HeyMa: "0" }, { "zcrank:pane:HeyMa:terminal_9": "1" }), "HeyMa", "terminal_9", ["HeyMa"], {}),
    { enabled: true, decidedBy: "pane", keys: ["HeyMa"] },
  );
  assert.equal(engineCrankFor(fakeStore({ HeyMa: "1" }, { "zcrank:pane:HeyMa:terminal_9": "0" }), "HeyMa", "terminal_9", ["HeyMa"], {}).enabled, false);
  // An override on a pane that is not this one changes nothing.
  assert.equal(engineCrankFor(fakeStore({ HeyMa: "1" }, { "zcrank:pane:HeyMa:terminal_8": "0" }), "HeyMa", "terminal_9", ["HeyMa"], {}).enabled, true);
});
await test("a pane override under an unstored tab name still counts (engine reads key ∪ name)", () => {
  const v = engineCrankFor(fakeStore({}, { "zcrank:pane:Fresh:terminal_4": "1" }), "Fresh", "terminal_4", [], {});
  assert.equal(v.enabled, true);
  assert.equal(v.decidedBy, "pane");
});

console.log("refresher: crank against a throwaway Redis and a fake zellij");
{
  const redisServer = await startThrowawayRedis();
  const shimDir = join(workspace, "shim");
  mkdirSync(shimDir, { recursive: true });
  const zellij = join(shimDir, "zellij");
  const fakeZellij = (mode) => writeFileSync(zellij, [
    "#!/bin/sh",
    mode === "fail" ? "exit 1" : "",
    'case "$*" in',
    `  *list-panes*) echo '[{"id":9,"tab_id":4,"tab_position":4,"tab_name":"HeyMa 🟢","is_plugin":false},{"id":9,"tab_id":4,"tab_position":4,"tab_name":"HeyMa 🟢","is_plugin":true}]' ;;`,
    `  *list-tabs*) echo '[{"tab_id":4,"position":4,"name":"HeyMa 🟢"}]' ;;`,
    "esac",
  ].join("\n"), { mode: 0o755 });
  const savedPath = process.env.PATH;
  const savedPort = process.env.ZCRANK_REDIS_PORT;
  process.env.PATH = `${shimDir}:${savedPath}`;
  process.env.ZCRANK_REDIS_PORT = String(redisServer.port);
  const proj = join(workspace, "crank-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, ".project.json"), JSON.stringify({ project_id: "heyma", project_name: "HeyMa" }));
  const savedCwd = process.cwd();
  process.chdir(proj);
  const zstate = join(workspace, "zstate-live");
  mkdirSync(zstate, { recursive: true });
  const paneEnv = { ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "9", ZCRANK_STATE_DIR: zstate };
  try {
    redisServer.cli("HSET", "zcrank:tab:HeyMa", "enabled", "1", "interval", "1h");
    await test("this pane's live tab decides, status suffix stripped, interval read", () => {
      fakeZellij("ok");
      assert.deepEqual(readCrank(paneEnv), { enabled: true, interval: "1h", scope: "tab" });
    });
    await test("a pane override OFF beats the tab ON", () => {
      redisServer.cli("SET", "zcrank:pane:HeyMa:terminal_9", "0");
      assert.deepEqual(readCrank(paneEnv), { enabled: false, interval: "1h", scope: "pane" });
      redisServer.cli("DEL", "zcrank:pane:HeyMa:terminal_9");
    });
    await test("ON: uptime from the engine's record for THIS pane, last run from the beat log", () => {
      const now = Date.now();
      const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
      const since = Math.floor((now - 3 * 24 * 3600_000) / 1000) * 1000;
      const scan = Math.floor((now - 60_000) / 1000) * 1000;
      const ran = Math.floor((now - 20 * 60_000) / 1000) * 1000;
      writeFileSync(join(zstate, "on_since.json"), JSON.stringify({ v: 1, scan_ts: iso(scan), panes: { terminal_9: { since: iso(since), tab: "heyma" }, terminal_8: { since: iso(now - 60_000), tab: "heyma" } } }));
      redisServer.cli("RPUSH", "zcrank:log:HeyMa", JSON.stringify({ ts: iso(ran), state: "sent", action: "x" }));
      assert.deepEqual(readCrank(paneEnv), { enabled: true, interval: "1h", scope: "tab", onSinceMs: since, lastRunMs: ran, engineScanMs: scan });
      // The engine stopped scanning 20m ago: stalled, decided now (at write time).
      const old = scan - 20 * 60_000;
      writeFileSync(join(zstate, "on_since.json"), JSON.stringify({ v: 1, scan_ts: iso(old), panes: { terminal_9: { since: iso(since), tab: "heyma" } } }));
      assert.equal(readCrank(paneEnv).stalled, true);
      // OFF carries no timing at all.
      redisServer.cli("SET", "zcrank:pane:HeyMa:terminal_9", "0");
      assert.deepEqual(readCrank(paneEnv), { enabled: false, interval: "1h", scope: "pane" });
      redisServer.cli("DEL", "zcrank:pane:HeyMa:terminal_9", "zcrank:log:HeyMa");
      rmSync(join(zstate, "on_since.json"));
    });
    await test("pane-only (no project): the pane's answer, never the project fallback", () => {
      assert.equal(readCrank(paneEnv, Date.now(), { paneOnly: true }).enabled, true);
      fakeZellij("fail");
      assert.equal(readCrank({}, Date.now(), { paneOnly: true }), null);
      fakeZellij("ok");
    });
    await test("a Workspace pane that cannot see itself has NO answer (never the project's)", () => {
      fakeZellij("fail");
      assert.equal(readCrank(paneEnv), null);
      fakeZellij("ok");
      assert.equal(readCrank({ ...paneEnv, ZELLIJ_PANE_ID: "77" }), null, "pane missing from the list");
    });
    await test("outside the Workspace session: the project's own switch", () => {
      fakeZellij("fail");
      const v = readCrank({ ZCRANK_STATE_DIR: zstate });
      assert.equal(v.scope, "project");
      assert.equal(v.enabled, true);
    });
    await test("Redis down => null, not OFF", () => {
      process.env.ZCRANK_REDIS_PORT = "1";
      assert.equal(readCrank(paneEnv), null);
    });
  } finally {
    process.chdir(savedCwd);
    process.env.PATH = savedPath;
    if (savedPort === undefined) delete process.env.ZCRANK_REDIS_PORT;
    else process.env.ZCRANK_REDIS_PORT = savedPort;
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
  // Outside every project but inside a zellij pane: the pane's crank line alone.
  const paneEnv = hermeticEnv({ PJ_PROMPT_CACHE_DIR: e2eCache, PJ_PROMPT_NO_REFRESH: "1", ZELLIJ_SESSION_NAME: "Workspace", ZELLIJ_PANE_ID: "41" });
  const panePath = pipelineCachePath(PANE_ONLY_ROOT, paneEnv);
  const runPane = () => spawnSync(process.execPath, [bin], { cwd: workspace, env: paneEnv, encoding: "utf8" });
  assert.equal(runPane().stdout, "", "nothing cached for this pane yet");
  writeFileSync(panePath, JSON.stringify({ ...cacheFile(), root: PANE_ONLY_ROOT, candybars: null, writtenAtMs: Date.now(),
    crank: { enabled: true, interval: "5m", scope: "tab", onSinceMs: Date.now() - 22 * 60_000 - 5_000 } }));
  assert.match(runPane().stdout, /^⚡ crank ↑22m ↻5m ⏳\S+$/u);
  assert.equal(run(workspace).stdout, "", "no pane, no project: silent");
  assert.notEqual(panePath, pipelineCachePath(PANE_ONLY_ROOT, { ...paneEnv, ZELLIJ_PANE_ID: "42" }), "keyed per pane");
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
