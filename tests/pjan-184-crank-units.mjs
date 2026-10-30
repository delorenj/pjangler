import "./helpers/hermetic-suite.mjs";
// PJAN-184 — the small contracts the crank command leans on that no other suite pins:
//   - src/tui/load.ts: the TTY test and the lazy screen loader's three outcomes (a module,
//     "not built" as a TuiUnavailableError, any other import failure passed through);
//   - src/crank/index.ts: how a project's display name and agent handles are read off a
//     real .project.json, the row parser's defaults, and the log-replace edge cases.
//
// Everything runs real: real files in a temp dir, a real dynamic import, and a throwaway
// redis-server (never 6379) for the store. The bundle carries an inline source map so the
// lines these tests execute count toward c8 as src/ lines, not as a scratch file.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startThrowawayRedis } from "./pjan-182-crank-regressions-helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pjan-184-units-"));
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");

writeFileSync(
  join(workspace, "entry.ts"),
  [
    `export * from ${JSON.stringify(join(root, "src/crank/index.ts"))};`,
    `export * from ${JSON.stringify(join(root, "src/crank/controller.ts"))};`,
    `export { isInteractive, loadScreen, TuiUnavailableError } from ${JSON.stringify(join(root, "src/tui/load.ts"))};`,
  ].join("\n"),
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
const { createCrankController, isInteractive, loadScreen, TuiUnavailableError, parseLogRow, projectAgentsFor, projectNameFor, redis, renderLogRow } = await import(kitOut);

const rs = await startThrowawayRedis();
let failed;
try {
  console.log("isInteractive: only a terminal on BOTH ends");
  {
    assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
    assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: false } }), false, "piped stdout");
    assert.equal(isInteractive({ stdin: { isTTY: false }, stdout: { isTTY: true } }), false, "piped stdin");
    assert.equal(isInteractive({ stdin: {}, stdout: { isTTY: true } }), false, "unknown is not a terminal");
  }

  console.log("loadScreen: imports a built module, relative to the base it is given");
  {
    mkdirSync(join(workspace, "dist", "crank"), { recursive: true });
    writeFileSync(join(workspace, "dist", "crank", "tui.js"), "export const marker = 'screen-ok';\n");
    const mod = await loadScreen("./crank/tui.js", pathToFileURL(join(workspace, "dist", "index.js")).href);
    assert.equal(mod.marker, "screen-ok");
  }

  console.log("loadScreen: a screen that is not built is a TuiUnavailableError that says what to run");
  {
    const base = pathToFileURL(join(workspace, "dist", "index.js")).href;
    await assert.rejects(
      loadScreen("./crank/missing.js", base),
      (error) => {
        assert.ok(error instanceof TuiUnavailableError);
        assert.match(error.message, /TUI screen \.\/crank\/missing\.js is not built \(run: npm run build\)/);
        assert.match(error.message, new RegExp(`looked for .*${join("dist", "crank", "missing.js").replace(/[.\\]/g, "\\$&")}`));
        return true;
      },
    );
  }

  console.log("loadScreen: a screen that exists but is broken is NOT reported as 'not built'");
  {
    writeFileSync(join(workspace, "dist", "crank", "broken.js"), "throw new Error('screen blew up on load');\n");
    writeFileSync(join(workspace, "dist", "crank", "needs.js"), "import 'no-such-package-pjan-184';\n");
    const base = pathToFileURL(join(workspace, "dist", "index.js")).href;
    await assert.rejects(loadScreen("./crank/broken.js", base), (error) => {
      assert.ok(!(error instanceof TuiUnavailableError), "a thrown error is its own error");
      assert.match(error.message, /screen blew up on load/);
      return true;
    });
    // a missing DEPENDENCY of an existing screen is also ERR_MODULE_NOT_FOUND: the screen is
    // built, so since PJAN-187 the loader names the missing package and an install remedy
    // instead of telling the operator to rebuild.
    await assert.rejects(loadScreen("./crank/needs.js", base), (error) => {
      assert.ok(error instanceof TuiUnavailableError);
      assert.match(error.message, /is built but its dependencies are not installed/);
      assert.match(error.message, /cannot find package 'no-such-package-pjan-184'/);
      assert.doesNotMatch(error.message, /npm run build/);
      return true;
    });
  }

  console.log("projectNameFor / projectAgentsFor: registry first, then the manifest, then the slug");
  {
    const dir = (name, manifest) => {
      const d = join(workspace, name);
      mkdirSync(d);
      if (manifest !== undefined) writeFileSync(join(d, ".project.json"), manifest);
      return { root: d, slug: name, facts: undefined };
    };
    const good = dir("good", JSON.stringify({ project_name: "  Good Name  ", agents: { "good-pm": { role: "pm" }, "good-sm": { role: 7 }, "good-x": null } }));
    assert.equal(projectNameFor(good, "  Registry Name "), "Registry Name", "the registry wins, trimmed");
    assert.equal(projectNameFor(good, "   "), "Good Name", "a blank registry name falls through to the manifest");
    assert.equal(projectNameFor(good), "Good Name");
    assert.deepEqual(projectAgentsFor(good), [
      { handle: "good-pm", role: "pm" },
      { handle: "good-sm", role: "" },
      { handle: "good-x", role: "" },
    ], "a non-string role is no role");
    assert.deepEqual(
      projectAgentsFor(good, { "reg-pm": { role: "pm" }, "reg-x": {} }),
      [{ handle: "reg-pm", role: "pm" }, { handle: "reg-x", role: "" }],
      "registry agents replace the manifest's, they do not merge with them",
    );

    const odd = dir("odd", JSON.stringify({ project_name: 42, agents: ["not", "a", "map"] }));
    assert.equal(projectNameFor(odd), "odd", "a non-string project_name is ignored");
    assert.deepEqual(projectAgentsFor(odd), [], "an array of agents is not a handle map");
    assert.equal(projectNameFor(dir("blank", JSON.stringify({ project_name: "  " }))), "blank");
    assert.deepEqual(projectAgentsFor(dir("noagents", JSON.stringify({}))), []);

    const garbage = dir("garbage", "{ not json");
    assert.equal(projectNameFor(garbage), "garbage", "unparseable manifest -> the slug");
    assert.deepEqual(projectAgentsFor(garbage), []);
    const none = dir("none");
    assert.equal(projectNameFor(none), "none", "no manifest at all -> the slug");
    assert.deepEqual(projectAgentsFor(none), []);
  }

  console.log("log rows: a row with missing or mistyped fields still parses, with the documented defaults");
  {
    assert.deepEqual(parseLogRow("{}"), { ts: "", tsMs: 0, state: "?", action: "" });
    assert.deepEqual(parseLogRow('{"ts":5,"state":1,"action":[]}'), { ts: "", tsMs: 0, state: "?", action: "" });
    assert.equal(parseLogRow("nope"), undefined);
    assert.equal(parseLogRow('{"ts":"2026-10-20T12:00:00Z","state":"sent"}').tsMs, Date.parse("2026-10-20T12:00:00Z"));
    assert.equal(renderLogRow("{}"), `  ${"?".padEnd(12)}`);
  }

  console.log("controller: reads reuse the live-tab list for 30s; every write re-reads it, so a tab renamed under a running TUI is followed");
  {
    const store = redis({ port: rs.port });
    for (const k of rs.cli("KEYS", "zcrank:*").split("\n").filter(Boolean)) rs.cli("DEL", k);
    let now = Date.parse("2026-10-20T12:00:00Z");
    let tabs = [{ name: "Old Name", position: 0 }];
    let zellijCalls = 0;
    const controller = createCrankController({
      slug: "demo", project: { name: "Old Name", agents: [{ handle: "new-name-pm", role: "pm" }] }, store,
      live: () => { zellijCalls += 1; return tabs; }, clock: () => now,
    });
    assert.equal(controller.read().resolution.tab, "Old Name");
    assert.equal(controller.read().resolution.tab, "Old Name");
    assert.equal(zellijCalls, 1, "two reads inside the TTL cost one zellij call");

    // the operator renames the tab; a read inside the TTL still shows the cached tab...
    tabs = [{ name: "New Name", position: 0 }];
    now += 29_000;
    assert.equal(controller.read().resolution.tab, "Old Name");
    // ...but a write never trusts the cache, and the cache is refreshed by it
    controller.disable();
    assert.equal(zellijCalls, 2);
    assert.equal(rs.cli("HGET", "zcrank:tab:New Name", "enabled"), "0", "disable hit the renamed tab");
    assert.equal(rs.cli("EXISTS", "zcrank:tab:Old Name"), "0");
    assert.equal(controller.read().resolution.tab, "New Name");
    assert.equal(zellijCalls, 2, "the write's fresh read primed the cache");

    tabs = [{ name: "Newer Name", position: 0 }];
    controller.setInterval("1h");
    assert.equal(zellijCalls, 3, "setInterval re-reads too");
    assert.equal(rs.cli("HGET", "zcrank:tab:New Name", "interval"), "1h", "no live match -> the stored key the agent handle names");
    // past the TTL a plain read re-reads
    now += 31_000;
    controller.read();
    assert.equal(zellijCalls, 4);
    assert.equal(controller.slug, "demo");
    assert.equal(controller.name, "Old Name");
  }

  console.log("replaceLog: an empty replacement deletes the list; a non-empty one swaps it whole and leaves no scratch key");
  {
    const store = redis({ port: rs.port });
    rs.cli("RPUSH", "zcrank:log:T", "a", "b");
    store.replaceLog("T", ["c"]);
    assert.deepEqual(store.logRows("T"), ["c"]);
    assert.equal(rs.cli("KEYS", "zcrank:logtmp:*"), "");
    store.replaceLog("T", []);
    assert.equal(rs.cli("EXISTS", "zcrank:log:T"), "0");
    assert.deepEqual(store.logRows("T"), []);
  }
} catch (error) {
  failed = error;
} finally {
  await rs.stop();
  rmSync(workspace, { recursive: true, force: true });
}
if (failed) throw failed;
console.log("PJAN-184 crank units: ok");
