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
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const {
  createCrankController, isInteractive, loadScreen, TuiUnavailableError, parseLogRow, projectAgentsFor, projectNameFor, redis, renderLogRow,
  // PJAN-201
  ENGINE_DEFAULT_JOB_ID, engineBlockedLabel, engineSources, engineSummary, liveTabs, livePanes, parseEngineStatus, projectIdentity,
  readEngineStatus, unknownEngineStatus, withTabOwners,
  // PJAN-201 review
  liveTabsWithOwners, ownerMemoReader, resolvePaneCwds, paneCwdCachePath, LIVE_OWNERS_TTL_MS, PANE_CWD_TTL_SECONDS,
} = await import(kitOut);

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

  // -------------------------------------------------------------------------
  // PJAN-201: project identity, tab ownership, engine health
  // -------------------------------------------------------------------------

  console.log("projectIdentity: a repo, its linked worktree, a subdirectory and a symlink all name the MAIN worktree; a submodule is its own repo");
  {
    const base = hermeticScratch("pjan-201-identity");
    try {
      const env = hermeticEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CEILING_DIRECTORIES: base });
      const git = (cwd, ...args) => {
        const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
        assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      };
      const lib = join(base, "lib");
      mkdirSync(lib);
      git(lib, "init", "-q");
      git(lib, "commit", "-q", "--allow-empty", "-m", "lib");
      const main = join(base, "main");
      mkdirSync(main);
      git(main, "init", "-q");
      git(main, "commit", "-q", "--allow-empty", "-m", "init");
      git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "sub");
      git(main, "worktree", "add", "-q", join(main, ".worktrees", "x"), "-b", "x");
      mkdirSync(join(main, "deep", "er"), { recursive: true });
      symlinkSync(main, join(base, "link"), "dir");
      mkdirSync(join(base, "plain"));

      const mainReal = realpathSync(main);
      assert.equal(projectIdentity(main), mainReal);
      assert.equal(projectIdentity(join(main, "deep", "er")), mainReal, "a subdirectory");
      assert.equal(projectIdentity(join(main, ".worktrees", "x")), mainReal, "a linked worktree maps to its main repo");
      assert.equal(projectIdentity(join(base, "link")), mainReal, "realpath'd through a symlink");
      // The pinned rule is the first `worktree <path>` line verbatim. For a submodule whose gitdir was
      // absorbed into the superproject (`submodule add`), that line is the gitdir, not the checkout:
      // still its own identity, never the superproject's, but the value is .git/modules/<name>.
      assert.equal(projectIdentity(join(main, "sub")), realpathSync(join(main, ".git", "modules", "sub")), "an absorbed submodule is its own repo, never the superproject");
      assert.notEqual(projectIdentity(join(main, "sub")), mainReal);
      // a nested repo with its own .git directory (how the 33GOD components live on this box) is its checkout path
      const nested = join(main, "nested");
      mkdirSync(nested);
      git(nested, "init", "-q");
      assert.equal(projectIdentity(nested), realpathSync(nested), "a standalone repo nested in another is its own identity");
      assert.equal(projectIdentity(join(base, "plain")), undefined, "not a git dir");
      assert.equal(projectIdentity(join(base, "missing")), undefined, "a directory that does not exist");
      assert.equal(projectIdentity(undefined), undefined);
      assert.equal(projectIdentity("  "), undefined);

      // the Shell seam: exact command (bounded by timeout 2s), a timeout is no identity, results are memoised per cwd
      const calls = [];
      const cache = new Map();
      const shell = (command, args) => {
        calls.push([command, ...args]);
        return args.includes("/slow") ? { stdout: "", status: 124 } : { stdout: `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n\nworktree /elsewhere\n`, status: 0 };
      };
      assert.equal(projectIdentity(main, { shell, cache }), mainReal);
      assert.equal(projectIdentity(main, { shell, cache }), mainReal);
      assert.equal(projectIdentity("/slow", { shell, cache }), undefined, "timeout (124) => no identity");
      assert.equal(projectIdentity("/slow", { shell, cache }), undefined);
      assert.equal(calls.length, 2, "one git call per cwd within a scan");
      assert.deepEqual(calls[0], ["timeout", "2s", "git", "-C", main, "worktree", "list", "--porcelain"]);
      assert.equal(projectIdentity(main, { shell: () => ({ stdout: "worktree /nowhere/at/all\n", status: 0 }) }), undefined, "an identity that cannot be realpath'd is none");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log("livePanes / liveTabs: parse the REAL list-panes and list-tabs JSON captured from the Workspace session");
  const realPanesJson = readFileSync(join(root, "tests", "data", "pjan-201-live-list-panes.json"), "utf8");
  const realTabsJson = readFileSync(join(root, "tests", "data", "pjan-201-live-list-tabs.json"), "utf8");
  const seen = [];
  const zellij = (command, args) => {
    seen.push([command, ...args]);
    return { stdout: args.includes("list-panes") ? realPanesJson : realTabsJson, status: 0 };
  };
  const realPanes = livePanes({ shell: zellij });
  const realTabs = liveTabs({ shell: zellij });
  {
    assert.deepEqual(seen[0], ["env", "-u", "ZELLIJ", "-u", "ZELLIJ_SESSION_NAME", "timeout", "8s", "zellij", "-s", "Workspace", "action", "list-panes", "--json", "--all"]);
    assert.equal(realPanes.length, JSON.parse(realPanesJson).length);
    const jb = realPanes.find((pane) => pane.id === 122);
    assert.deepEqual(jb, { id: 122, tabId: 30, tabPosition: 1, tabName: "ipm 🟢", isPlugin: false, cwd: "/home/delorenj/code/james-brennan" });
    assert.equal(realPanes.find((pane) => pane.id === 16).cwd, undefined, "pane_cwd is absent for some panes: unknown, not empty");
    assert.equal(realPanes.find((pane) => pane.id === 77).isPlugin, true);
    assert.equal(realTabs.find((tab) => tab.name === "ipm 🟢").id, 30, "list-tabs carries the stable tab_id");
    // unreadable output is [] — never a throw
    assert.deepEqual(livePanes({ shell: () => ({ stdout: "not json", status: 0 }) }), []);
    assert.deepEqual(livePanes({ shell: () => ({ stdout: "", status: 1 }) }), []);
    assert.deepEqual(livePanes({ shell: () => ({ stdout: "{}", status: 0 }) }), []);
  }

  console.log("tab ownership: strict plurality of terminal panes' identities; a tie, no cwd, or only plugins means no owner");
  {
    // Every cwd in the capture is itself a repo root, so identity == cwd here. This stands in for
    // git ONLY in this section: the real-git identity rules are the section above.
    const idOf = (cwd) => cwd;
    const owned = withTabOwners(realTabs, realPanes, idOf);
    const ipm = owned.find((tab) => tab.id === 30);
    // the live reality today: james-brennan's pane and the operator's pjangler pane share the tab
    assert.equal(ipm.owner, undefined, "1 vs 1 is a tie: no owner");
    assert.deepEqual(ipm.ownedPanes, { "/home/delorenj/code/james-brennan": 1, "/home/delorenj/code/33GOD/pjangler": 1 });
    assert.equal(owned.find((tab) => tab.name === "Wingman").owner, undefined, "panes without pane_cwd are ignored: no identified pane, no owner");
    assert.equal(owned.find((tab) => tab.name === "Wingman").ownedPanes, undefined);
    assert.equal(owned.find((tab) => tab.name === "Milkshake").owner, "/home/delorenj/code/Milkshake");
    assert.equal(owned.find((tab) => tab.name === "deckard").owner, "/home/delorenj/code/deckard");

    const without = (id) => realPanes.filter((pane) => pane.id !== id);
    assert.equal(withTabOwners(realTabs, without(150), idOf).find((tab) => tab.id === 30).owner, "/home/delorenj/code/james-brennan", "drop the second pane: the lone identity owns it");
    const extra = { ...realPanes.find((pane) => pane.id === 150), id: 9001 };
    assert.equal(withTabOwners(realTabs, [...realPanes, extra], idOf).find((tab) => tab.id === 30).owner, "/home/delorenj/code/33GOD/pjangler", "2 vs 1 is a strict plurality");
    const three = [...realPanes, { ...extra, id: 9002 }, { ...extra, id: 9003 }];
    assert.equal(withTabOwners(realTabs, three, idOf).find((tab) => tab.id === 30).owner, "/home/delorenj/code/33GOD/pjangler");
    // 2 vs 2 is a tie again
    const tie = [...realPanes, extra, { ...realPanes.find((pane) => pane.id === 122), id: 9004 }];
    assert.equal(withTabOwners(realTabs, tie, idOf).find((tab) => tab.id === 30).owner, undefined);
    // a plugin pane never votes, and panes whose cwd has no identity are ignored (not counted against)
    const plugin = { ...realPanes.find((pane) => pane.id === 150), id: 9005, isPlugin: true };
    assert.equal(withTabOwners(realTabs, [...without(150), plugin], idOf).find((tab) => tab.id === 30).owner, "/home/delorenj/code/james-brennan");
    const noGit = (cwd) => (cwd.endsWith("pjangler") ? undefined : cwd);
    assert.equal(withTabOwners(realTabs, realPanes, noGit).find((tab) => tab.id === 30).owner, "/home/delorenj/code/james-brennan", "an unidentified pane is ignored");
    // panes join tabs by tab_id, falling back to position when a tab has no id
    const byPosition = withTabOwners(realTabs.map(({ id, ...rest }) => rest), realPanes, idOf);
    assert.equal(byPosition.find((tab) => tab.name === "Milkshake").owner, "/home/delorenj/code/Milkshake");
    assert.equal(withTabOwners([], realPanes, idOf).length, 0);
  }

  console.log("pane cwd memory: zellij withholds pane_cwd, the shared pane-cwds.json fills it (same id + tab, 6h), one retry covers the rest");
  {
    const base = mkdtempSync(join(tmpdir(), "pjan-201-cwds-"));
    try {
      const gitIn = (cwd, ...args) => spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
        encoding: "utf8", env: hermeticEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }),
      });
      const repoA = join(base, "alpha");
      const repoB = join(base, "beta");
      for (const repo of [repoA, repoB]) {
        mkdirSync(repo);
        gitIn(repo, "init", "-q", "-b", "main");
        gitIn(repo, "commit", "-q", "--allow-empty", "-m", "init");
      }
      const A = realpathSync(repoA);
      const B = realpathSync(repoB);
      const row = (id, tabId, cwd, extra = {}) => ({ id, is_plugin: false, tab_id: tabId, tab_position: tabId, tab_name: `t${tabId}`, ...(cwd ? { pane_cwd: cwd } : {}), ...extra });
      const full = [row(1, 5, repoA), row(2, 5, repoA), row(3, 5, repoB), row(4, 6, repoB), row(5, 6, null), row(9, 5, null, { is_plugin: true })];
      const thin = [row(1, 5, null), row(2, 5, null), row(3, 5, repoB), row(4, 6, null), row(5, 6, null), row(9, 5, null, { is_plugin: true })];
      const panesOf = (rows) => rows.map((r) => ({ id: r.id, tabId: r.tab_id, tabPosition: r.tab_position, tabName: r.tab_name, isPlugin: r.is_plugin, cwd: r.pane_cwd }));
      const cachePath = join(base, "state", "pane-cwds.json");
      const T0 = Date.parse("2026-11-04T10:00:00Z");

      // call 1 (zellij reports): the memory is written in the engine's shape, plugins never
      resolvePaneCwds(() => panesOf(full), { nowMs: T0, cachePath });
      const stored = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.deepEqual(Object.keys(stored).sort(), ["1", "2", "3", "4"], "terminal panes with a cwd only (pane 5 never reported, plugin 9 is not a terminal)");
      assert.deepEqual(stored["1"], { cwd: repoA, tab_id: 5, ts: T0 / 1000 });

      // call 2 (zellij withholds most): the memory fills 1, 2 and 4; pane 5 stays unknown
      const filled = resolvePaneCwds(() => panesOf(thin), { nowMs: T0 + 60_000, cachePath });
      assert.deepEqual(filled.map((p) => p.cwd), [repoA, repoA, repoB, repoB, undefined, undefined]);
      const owners = withTabOwners([{ name: "t5", position: 5, id: 5 }, { name: "t6", position: 6, id: 6 }], filled, (cwd) => (cwd === repoA ? A : B));
      assert.equal(owners[0].owner, A, "2 alpha vs 1 beta");
      assert.equal(owners[1].owner, B);

      // a remembered cwd is scoped to its pane AND tab, bounded by the TTL, never trusted when corrupt
      assert.equal(resolvePaneCwds(() => panesOf([row(1, 9, null)]), { nowMs: T0 + 120_000, cachePath })[0].cwd, undefined, "same pane id on another tab (id reuse after a restart)");
      resolvePaneCwds(() => panesOf([row(1, 5, repoA)]), { nowMs: T0, cachePath });
      assert.equal(resolvePaneCwds(() => panesOf([row(1, 5, null)]), { nowMs: T0 + (PANE_CWD_TTL_SECONDS + 1) * 1000, cachePath })[0].cwd, undefined, "expired");
      for (const bad of [{ "1": { cwd: repoA, tab_id: 5, ts: "abc" } }, { "1": { cwd: repoA, tab_id: 5, ts: null } }, { "1": "junk", "2": ["x"] }, ["not", "an", "object"]]) {
        writeFileSync(cachePath, JSON.stringify(bad));
        assert.equal(resolvePaneCwds(() => panesOf([row(1, 5, null)]), { nowMs: T0, cachePath })[0].cwd, undefined, `corrupt entry ${JSON.stringify(bad)}`);
      }
      writeFileSync(cachePath, "not json at all");
      assert.equal(resolvePaneCwds(() => panesOf([row(1, 5, repoA)]), { nowMs: T0, cachePath })[0].cwd, repoA, "an unreadable memory is just empty");
      // gone panes are pruned
      resolvePaneCwds(() => panesOf([row(2, 5, repoA)]), { nowMs: T0 + 1000, cachePath });
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(cachePath, "utf8"))), ["2"]);
      // a fetch that finds nothing leaves the memory alone; one that throws is []
      assert.deepEqual(resolvePaneCwds(() => [], { cachePath }), []);
      assert.deepEqual(resolvePaneCwds(() => { throw new Error("zellij gone"); }, { cachePath }), []);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(cachePath, "utf8"))), ["2"]);
      // an unwritable memory costs only stability
      assert.equal(resolvePaneCwds(() => panesOf([row(1, 5, repoA)]), { cachePath: join(cachePath, "nope", "x.json") })[0].cwd, repoA);

      // retries: only while terminal panes stay unknown, and only as many as asked
      rmSync(cachePath, { force: true });
      let calls = 0;
      const flaky = () => { calls++; return panesOf([row(1, 5, calls > 1 ? repoA : null), row(2, 5, repoA)]); };
      assert.equal(resolvePaneCwds(flaky, { retries: 1, nowMs: T0, cachePath })[0].cwd, repoA);
      assert.equal(calls, 2);
      calls = 0;
      resolvePaneCwds(flaky, { retries: 3, nowMs: T0 + 5000, cachePath });
      assert.equal(calls, 1, "pane 1 is remembered now: no retry needed");

      // the env override is the engine's own variable
      assert.equal(paneCwdCachePath({ ZCRANK_CWD_CACHE: "/x/y.json" }), "/x/y.json");
      assert.match(paneCwdCachePath({}), /\.local\/state\/zcrank\/pane-cwds\.json$/);

      // end to end through the shell seam: liveTabsWithOwners = list-tabs + list-panes(+memory) + real git
      rmSync(cachePath, { force: true });
      const tabsJson = JSON.stringify([{ name: "ipm 🟢", position: 0, tab_id: 5 }, { name: "other", position: 1, tab_id: 6 }]);
      let phase = "full";
      const argvs = [];
      const shell = (command, args) => {
        argvs.push(args);
        if (args.includes("list-tabs")) return { stdout: tabsJson, status: 0 };
        if (args.includes("list-panes")) return { stdout: JSON.stringify(phase === "full" ? full : thin), status: 0 };
        return spawnSync(command, args, { encoding: "utf8", env: hermeticEnv() });
      };
      const first = liveTabsWithOwners({ shell, cachePath, nowMs: T0 });
      assert.deepEqual(first.map((t) => t.owner), [A, B]);
      phase = "thin";
      const second = liveTabsWithOwners({ shell, cachePath, nowMs: T0 + 30_000, retries: 0 });
      assert.deepEqual(second.map((t) => t.owner), [A, B], "zellij withheld the cwds; the owners did not flap");
      rmSync(cachePath, { force: true });
      const cold = liveTabsWithOwners({ shell, cachePath, nowMs: T0 + 40_000, retries: 0 });
      assert.deepEqual(cold.map((t) => t.owner), [B, undefined], "no memory: tab 5 keeps only the pane that reported, tab 6 has none");

      // Both sides, ONE memory file: whatever pj writes the engine's resolve_panes reads, and back.
      // Skipped where the engine is not installed (CI); on the dev box this is the real module.
      const engineBin = join(process.env.HOME ?? "", ".agents/tools/jev-clairic/bin");
      if (existsSync(join(engineBin, "zcrank_identity.py"))) {
        const engine = (cache, panesJson, now) => {
          const py = [
            "import json,sys; sys.path.insert(0, sys.argv[1]); import zcrank_identity as z",
            "panes = z.resolve_panes(lambda: json.loads(sys.argv[2]), now=float(sys.argv[3]))",
            "print(json.dumps({str(k): v for k, v in z.owners_from_panes(panes).items()}))",
          ].join("\n");
          const r = spawnSync("python3", ["-c", py, engineBin, JSON.stringify(panesJson), String(now)], { encoding: "utf8", env: hermeticEnv({ ZCRANK_CWD_CACHE: cache }) });
          assert.equal(r.status, 0, r.stderr);
          return JSON.parse(r.stdout);
        };
        const shared = join(base, "shared", "pane-cwds.json");
        resolvePaneCwds(() => panesOf(full), { nowMs: T0, cachePath: shared });           // pj remembers
        const engineView = engine(shared, thin, T0 / 1000 + 60);                          // engine fills from pj's file
        const pjView = Object.fromEntries(withTabOwners([{ name: "t5", position: 5, id: 5 }, { name: "t6", position: 6, id: 6 }],
          resolvePaneCwds(() => panesOf(thin), { nowMs: T0 + 60_000, cachePath: shared }), (cwd) => (cwd === repoA ? A : B)).filter((t) => t.owner).map((t) => [String(t.id), t.owner]));
        assert.deepEqual(engineView, pjView, "same inputs, same owners");
        assert.deepEqual(engineView, { "5": A, "6": B });
        rmSync(shared, { force: true });
        engine(shared, full, T0 / 1000);                                                  // engine remembers
        const fromEngine = resolvePaneCwds(() => panesOf(thin), { nowMs: T0 + 60_000, cachePath: shared });
        assert.deepEqual(fromEngine.map((p) => p.cwd), [repoA, repoA, repoB, repoB, undefined, undefined], "pj fills from the engine's file");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log("git budget: past it, no more identity lookups (not cached); within it, normal");
  {
    const cache = new Map();
    assert.equal(projectIdentity("/tmp", { cache, budget: { totalMs: -1 } }), undefined, "budget already spent");
    assert.equal(cache.has("/tmp"), false, "an out-of-budget lookup is not cached as 'no identity'");
    const spent = { totalMs: 60_000 };
    projectIdentity(process.cwd(), { budget: spent });
    assert.ok(spent.untilMs > Date.now(), "the first git call starts the clock");
  }

  console.log("owner memo: owners outlive a list-tabs; renames are seen at once; a new tab or the TTL re-reads");
  {
    let now = 1_000_000;
    let reads = 0;
    let tabs = [{ name: "ipm 🟢", position: 0, id: 30 }, { name: "x", position: 1, id: 31 }];
    const read = () => { reads++; return tabs.map((t) => (t.id === 30 ? { ...t, owner: "/jb", ownedPanes: { "/jb": 2 } } : { ...t })); };
    const reader = ownerMemoReader({ clock: () => now, read, tabs: () => tabs.map((t) => ({ ...t })) });
    assert.equal(reader()[0].owner, "/jb");
    assert.equal(reads, 1);
    now += 60_000;
    tabs = [{ name: "something else", position: 0, id: 30 }, { name: "x", position: 1, id: 31 }];
    const renamed = reader();
    assert.equal(reads, 1, "no list-panes for a toggle one minute later");
    assert.deepEqual(renamed.map((t) => [t.name, t.owner]), [["something else", "/jb"], ["x", undefined]], "the new name, the remembered owner");
    tabs = [...tabs, { name: "new", position: 2, id: 40 }];
    reader();
    assert.equal(reads, 2, "a tab nobody has looked up re-reads");
    now += LIVE_OWNERS_TTL_MS + 1;
    reader();
    assert.equal(reads, 3, "the TTL re-reads");
    tabs = [];
    assert.deepEqual(reader(), [], "no live tabs is just empty");
  }

  // The 24h of REAL usage_audit rows for job 777c511a009c (completed beats from 2026-11-03T15:25Z
  // to 21:35Z, then the engine refusing every tick), trimmed to the fields the reader uses.
  const AUDIT = readFileSync(join(root, "tests", "data", "pjan-201-usage-audit.jsonl"), "utf8");
  const NOW = Date.parse("2026-11-04T14:45:00Z");
  const localHHMM = (iso) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  console.log("engine health: the real audit says refused for the daily token cap, with the beats, tokens and resume instant");
  {
    const status = parseEngineStatus(AUDIT, { cap: 10_000_000, nowMs: NOW });
    assert.equal(status.known, true);
    assert.equal(status.jobId, ENGINE_DEFAULT_JOB_ID);
    assert.equal(status.outcome, "refused");
    assert.equal(status.tokenBlocked, true);
    assert.equal(status.reason, "daily token limit reached (10,000,000)");
    assert.equal(status.lastTickMs, Date.parse("2026-11-04T14:41:01.408Z"));
    assert.equal(status.beats24h, 15);
    assert.equal(status.tokens24h, 10_108_474);
    assert.equal(status.cap, 10_000_000);
    // oldest first: the 15:25:25.545Z beat (860,279 tokens) ages out at 15:25:25.545Z next day and the sum is under the cap
    assert.equal(status.resumeMs, Date.parse("2026-11-04T15:25:25.545Z"));
    assert.equal(status.refusedSinceMs, Date.parse("2026-11-03T21:41:06.558Z"), "the unbroken run of refusals since the last real beat");
    // the cap falls back to the number in the refusal itself
    assert.equal(parseEngineStatus(AUDIT, { nowMs: NOW }).cap, 10_000_000);
    assert.equal(parseEngineStatus(AUDIT, { nowMs: NOW }).resumeMs, status.resumeMs);

    const label = engineBlockedLabel(status);
    assert.equal(label, `blocked: daily token cap — resumes ≈ ${localHHMM("2026-11-04T15:30:00Z")}`, "the estimate is shown as the first 5-minute tick at/after the resume instant");
    const summary = engineSummary(status);
    assert.equal(summary.tone, "warn");
    assert.match(summary.text, /^REFUSING since 17h \d\dm ago: daily token limit reached \(10,000,000\) · last tick 3m ago · 15 beats \/ 10\.1M tokens in 24h of 10\.0M · resumes ≈ \d\d:\d\d$/);
  }

  console.log("engine health: the resume instant walks the window oldest-first until the sum is under the cap");
  {
    // a lower cap needs TWO beats to age out: 10,108,474 - 860,279 = 9,248,195 (still over 9M), minus 750,017 = 8,498,178
    const status = parseEngineStatus(AUDIT, { cap: 9_000_000, nowMs: NOW });
    assert.equal(status.resumeMs, Date.parse("2026-11-03T15:40:51.468Z") + 24 * 3600_000);
    // already under the cap in the window (the refusal row is stale): resume is now
    assert.equal(parseEngineStatus(AUDIT, { cap: 20_000_000, nowMs: NOW }).resumeMs, NOW);
    // a later `now`: the oldest beat has left the 24h window, so the tokens drop below the cap
    const later = parseEngineStatus(AUDIT, { cap: 10_000_000, nowMs: Date.parse("2026-11-04T15:26:00Z") });
    assert.equal(later.beats24h, 14);
    assert.equal(later.tokens24h, 10_108_474 - 860_279);
    assert.equal(later.resumeMs, Date.parse("2026-11-04T15:26:00Z"));
  }

  console.log("engine health: a cranking engine, other refusals, a failed tick, other jobs and garbage lines");
  {
    const lines = AUDIT.trim().split("\n");
    const cranked = lines.filter((line) => JSON.parse(line).status === "completed").join("\n");
    const ok = parseEngineStatus(cranked, { cap: 10_000_000, nowMs: Date.parse("2026-11-03T21:45:00Z") });
    assert.equal(ok.outcome, "cranked");
    assert.equal(ok.tokenBlocked, false);
    assert.equal(ok.reason, undefined);
    assert.equal(engineBlockedLabel(ok), undefined, "a healthy engine blocks nothing");
    assert.equal(engineSummary(ok).tone, "ok");
    assert.match(engineSummary(ok).text, /^last tick 9m ago \(cranked\) · 15 beats/);

    const busy = JSON.stringify({ ts: "2026-11-04T14:44:00Z", job_id: ENGINE_DEFAULT_JOB_ID, status: "skipped", total_tokens: 0, economics_reason: "daily run limit reached (96)" });
    const runLimit = parseEngineStatus(`${AUDIT}${busy}\n`, { cap: 10_000_000, nowMs: NOW });
    assert.equal(runLimit.outcome, "refused");
    assert.equal(runLimit.tokenBlocked, false);
    assert.equal(runLimit.resumeMs, undefined, "no resume estimate for a refusal this module does not model");
    assert.equal(engineBlockedLabel(runLimit), "blocked: daily run limit reached (96)");

    const failed = JSON.stringify({ ts: "2026-11-04T14:44:00Z", job_id: ENGINE_DEFAULT_JOB_ID, status: "failed", total_tokens: 0 });
    const other = parseEngineStatus(`${AUDIT}${failed}\n`, { cap: 10_000_000, nowMs: NOW });
    assert.equal(other.outcome, "other");
    assert.equal(engineBlockedLabel(other), undefined);
    assert.match(engineSummary(other).text, /last tick 1m ago \(failed\)/);

    const elsewhere = JSON.stringify({ ts: "2026-11-04T14:44:30Z", job_id: "someone-else", status: "completed", total_tokens: 99 });
    assert.equal(parseEngineStatus(`${AUDIT}${elsewhere}\n`, { cap: 10_000_000, nowMs: NOW }).lastTickMs, Date.parse("2026-11-04T14:41:01.408Z"), "other jobs' rows are not this engine's");

    const messy = `{not json\n\n[1,2]\n${JSON.stringify({ job_id: ENGINE_DEFAULT_JOB_ID, status: "completed" })}\n${AUDIT}garbage tail`;
    const parsed = parseEngineStatus(messy, { cap: 10_000_000, nowMs: NOW });
    assert.equal(parsed.known, true, "garbage lines and rows with no ts are skipped, the rest still read");
    assert.equal(parsed.beats24h, 15);
    assert.equal(parseEngineStatus("garbage\n{\n", { nowMs: NOW }).known, false);
    assert.equal(parseEngineStatus("", { nowMs: NOW }).known, false);
    assert.equal(engineSummary(parseEngineStatus("", { nowMs: NOW })).text, "engine status unknown");
    assert.equal(engineBlockedLabel(unknownEngineStatus(NOW)), undefined, "no claim when unknown");

    // not ticking at all: the last row is old
    const stalled = parseEngineStatus(cranked, { cap: 10_000_000, nowMs: Date.parse("2026-11-04T14:45:00Z") });
    assert.match(engineBlockedLabel(stalled), /^blocked: engine not ticking \(last tick 17h \d\dm ago\)$/);
    assert.equal(engineSummary(stalled).tone, "warn");
  }

  console.log("engine health: reading from disk is bounded, honours the env overrides, and never throws");
  {
    const dir = hermeticScratch("pjan-201-audit");
    try {
      const audit = join(dir, "usage_audit.jsonl");
      writeFileSync(audit, AUDIT);
      const jobs = join(dir, "jobs.json");
      writeFileSync(jobs, JSON.stringify({ jobs: [{ id: "other", economics: { max_daily_tokens: 1 } }, { id: ENGINE_DEFAULT_JOB_ID, economics: { max_daily_tokens: 9_000_000 } }] }));
      const viaEnv = readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: audit }, sources: { jobsPath: jobs } });
      assert.equal(viaEnv.known, true);
      assert.equal(viaEnv.cap, 9_000_000, "max_daily_tokens from jobs.json wins over the number in the refusal text");
      assert.equal(viaEnv.resumeMs, Date.parse("2026-11-03T15:40:51.468Z") + 24 * 3600_000);
      assert.deepEqual(engineSources({ PJ_CRANK_USAGE_AUDIT: "/a/b", PJ_CRANK_JOB_ID: "abc" }).auditPath, "/a/b");
      assert.equal(engineSources({ PJ_CRANK_JOB_ID: "abc" }).jobId, "abc");
      assert.equal(engineSources({}).jobId, ENGINE_DEFAULT_JOB_ID);
      assert.match(engineSources({}).auditPath, /\.hermes\/profiles\/33god-pm\/cron\/usage_audit\.jsonl$/);
      assert.match(engineSources({}).jobsPath, /\.hermes\/profiles\/33god-pm\/cron\/jobs\.json$/);
      const otherJob = readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: audit, PJ_CRANK_JOB_ID: "nope" }, sources: { jobsPath: jobs } });
      assert.equal(otherJob.known, false, "a job with no rows is unknown, not 'healthy'");

      // garbage jobs.json: the cap falls back to the refusal text
      writeFileSync(jobs, "{{{ nope");
      assert.equal(readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: audit }, sources: { jobsPath: jobs } }).cap, 10_000_000);
      // a missing audit file, a directory where the file should be, an empty file
      assert.equal(readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: join(dir, "missing.jsonl") } }).known, false);
      assert.equal(readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: dir } }).known, false);
      writeFileSync(join(dir, "empty.jsonl"), "");
      assert.equal(readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: join(dir, "empty.jsonl") } }).known, false);
      writeFileSync(join(dir, "garbage.jsonl"), `${String.fromCharCode(0, 1)} garbage\n{"job_id":\n`);
      assert.equal(readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: join(dir, "garbage.jsonl") } }).known, false);

      // bounded tail: 3MB of other jobs' filler ahead of the real rows. A 64KB tail still finds the
      // real rows (and drops the partial first line); a tail smaller than the rows sees nothing.
      const filler = JSON.stringify({ ts: "2026-10-01T00:00:00Z", job_id: "filler", status: "completed", total_tokens: 1, pad: "x".repeat(900) });
      const big = join(dir, "big.jsonl");
      writeFileSync(big, `${(filler + "\n").repeat(3500)}${AUDIT}`);
      const tailed = readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: big }, tailBytes: 64 * 1024, sources: { jobsPath: join(dir, "none.json") } });
      assert.equal(tailed.known, true);
      assert.equal(tailed.lastTickMs, Date.parse("2026-11-04T14:41:01.408Z"));
      assert.equal(readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: big }, tailBytes: 1 }).known, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("engine status: a future-dated row never becomes the last tick; a FIFO where the audit file should be is unknown, not a hang");
  {
    const dir = mkdtempSync(join(tmpdir(), "pjan-201-audit-"));
    try {
      const future = `${JSON.stringify({ ts: "2999-01-01T00:00:00Z", job_id: ENGINE_DEFAULT_JOB_ID, status: "completed", total_tokens: 5 })}\n`;
      const clean = parseEngineStatus(AUDIT, { nowMs: NOW });
      const skewed = parseEngineStatus(AUDIT + future, { nowMs: NOW });
      assert.equal(skewed.lastTickMs, clean.lastTickMs, "the 2999 row is ignored");
      assert.equal(skewed.outcome, clean.outcome);
      assert.equal(skewed.tokens24h, clean.tokens24h);
      assert.equal(parseEngineStatus(future, { nowMs: NOW }).known, false, "only a future row = no claim");
      const fifo = join(dir, "audit.fifo");
      if (spawnSync("mkfifo", [fifo]).status === 0) {
        assert.equal(readEngineStatus({ nowMs: NOW, env: { PJ_CRANK_USAGE_AUDIT: fifo } }).known, false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
} catch (error) {
  failed = error;
} finally {
  await rs.stop();
  rmSync(workspace, { recursive: true, force: true });
}
if (failed) throw failed;
console.log("PJAN-184 crank units: ok");
