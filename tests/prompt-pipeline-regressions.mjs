import "./helpers/hermetic-suite.mjs";
// The 33GOD pipeline segments of `pjangler-prompt` (src/prompt-pipeline.ts, src/prompt-refresh.ts):
//   - the cache contract: a foreign/garbage/wrong-version cache is ignored, an expired one is
//     hidden, a stale one is shown AND refreshed;
//   - the refresh lock: exclusive, and a dead child's lock is taken over;
//   - the formatting: `🍫 project/total`, `⚡ crank 5m` / `◌ crank off`, omitted when unknown;
//   - the refresher's pure halves: candybar counting and the engine's crank_enabled rule;
//   - end to end: the built dist/prompt.js prints the cached segments, and stays silent off-project.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "prompt-pipeline-"));
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

writeFileSync(
  join(workspace, "entry.ts"),
  [
    `export * from ${JSON.stringify(join(root, "src/prompt-pipeline.ts"))};`,
    `export { formatPromptLine } from ${JSON.stringify(join(root, "src/prompt.ts"))};`,
    `export { countCandybars, engineCrankFor, readCandybars } from ${JSON.stringify(join(root, "src/prompt-refresh.ts"))};`,
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
  formatCandybars, formatCrank, takeRefreshLock, maybeRefresh, formatPromptLine,
  countCandybars, engineCrankFor, readCandybars,
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
    formatPromptLine({ ...base, candybars: { project: 3, total: 124 }, crank: { enabled: true, interval: "1h", scope: "tab" } }),
    "pjangler (PJAN) · 3m · 🍫 3/124 · ⚡ crank 1h",
  );
  assert.equal(formatPromptLine({ ...base, age: undefined, candybars: null, crank: { enabled: false, scope: "pane" } }), "pjangler (PJAN) · ◌ crank off");
});
await test("unknown is omitted, OFF is explicit", () => {
  assert.equal(formatCandybars({ project: 0, total: 7 }), "🍫 0/7");
  assert.equal(formatCrank({ enabled: false, interval: "5m", scope: "tab" }), "◌ crank off");
  assert.equal(formatCrank({ enabled: true, scope: "project" }), "⚡ crank");
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
    assert.deepEqual(await readCandybars(projectRoot, { CANDYBAR_API_URL: url }), { project: 1, total: 2 });
    status = 500;
    assert.equal(await readCandybars(projectRoot, { CANDYBAR_API_URL: url }), null);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(await readCandybars(projectRoot, { CANDYBAR_API_URL: url }), null);
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
  assert.match(inside.stdout, /^e2e \(E2E\)( · \S+)? · 🍫 3\/124 · ⚡ crank 5m$/);
  const outside = run(workspace);
  assert.equal(outside.stdout, "");
  // Expired cache: the identity line survives, the pipeline segments vanish.
  writeFileSync(cachePath, JSON.stringify({ ...cacheFile(), root: proj, writtenAtMs: Date.now() - PIPELINE_EXPIRE_AFTER_MS - 60_000 }));
  assert.doesNotMatch(run(proj).stdout, /🍫|crank/);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).root, proj, "NO_REFRESH leaves the cache alone");
});

console.log(`prompt-pipeline: ${passed} passed`);
