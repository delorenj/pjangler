// PJAN-174 — `pj crank`: project-native crank-mode toggles.
//
// The mapping under test is the only invented part of this command set: a
// registry project has nothing but NAMES correlating it to a zcrank tab —
// its display name, and the agent handles minted at init — so the
// candidate/ladder resolution (live-exact, redis-exact, live-prefix,
// project-name-as-is) is what can silently point a toggle at the wrong tab.
// Everything here pins that mapping with a faked redis-cli/zellij shell
// seam; the live smoke (real Redis + real zellij, `pj crank enable` from
// the tower-of-lost-things repo, whose tab is "Pile of Dumb Things") is run
// by hand.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pjan-174-"));
// The scratch CLI bundle leaves packages external; a symlinked node_modules
// lets it resolve @delorenj/skillex from the repo (same fix as pjan-87).
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");

// The crank kit bundles cleanly without the commander CLI.
import { spawnSync } from "node:child_process";
const esbuild = join(root, "node_modules", ".bin", "esbuild");
const kitOut = join(workspace, "crank-kit.mjs");
const kitBuilt = spawnSync(
  esbuild,
  [join(root, "src", "crank", "index.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=${kitOut}`],
  { encoding: "utf8" },
);
if (kitBuilt.status !== 0) {
  console.error(`failed to bundle the crank kit:\n${kitBuilt.stderr}`);
  process.exit(1);
}

const {
  buildCrankList,
  candidateNames,
  canon,
  crankTimestamp,
  formatCrankList,
  liveTabs,
  redis,
  renderLogRow,
  resolveTabForProject,
  tabDisplay,
} = await import(kitOut);

// ---------------------------------------------------------------------------
// Tab-name canonicalization (the zcrankctl contract)
// ---------------------------------------------------------------------------

console.log("canon: status suffixes are stripped the way zcrankctl strips them");
{
  assert.equal(tabDisplay("gruvato 🟢"), "gruvato");
  // WING-7: the attention painter's glyphs, and case/punctuation drift between a tab and its key.
  assert.equal(tabDisplay("Holocene 🔔"), "Holocene");
  assert.equal(tabDisplay("Flume ⚫"), "Flume");
  assert.equal(canon("green-in-between"), canon("GreenInBetween"));
  assert.equal(canon("intelliforia 🔔"), canon("Intelliforia"));
  assert.equal(tabDisplay("Holocene ✳"), "Holocene");
  assert.equal(tabDisplay("  padded  "), "padded");
  assert.equal(tabDisplay(undefined), "");
  assert.equal(canon("Pile of Dumb Things"), "pileofdumbthings");
  assert.equal(canon("PILE OF DUMB THINGS 🟡"), "pileofdumbthings");
}

console.log("resolve: a drifted live tab keeps the key it already has (WING-7)");
{
  const green = resolveTabForProject({ name: "green-in-between", agents: [] },
    [{ name: "green-in-between", position: 0 }], ["GreenInBetween"]);
  assert.equal(green.tab, "GreenInBetween");
  assert.equal(green.source, "live-exact");
  const navi = resolveTabForProject({ name: "Navi", agents: [] },
    [{ name: "IPM: Navi 🔔", position: 3 }], ["IPM", "Holocene"]);
  assert.equal(navi.tab, "IPM");
  const fresh = resolveTabForProject({ name: "Flume", agents: [] }, [{ name: "Flume ⚫", position: 1 }], []);
  assert.equal(fresh.tab, "Flume");
}

// ---------------------------------------------------------------------------
// Candidate names: project name + agent handles
// ---------------------------------------------------------------------------

console.log("candidates: agent handle minus role suffix slugifies onto the tab name");
{
  // The live case: registry "Tower of Lost Things", agent handle
  // "pile-of-dumb-things-pm", zellij tab "Pile of Dumb Things".
  const names = candidateNames({
    name: "Tower of Lost Things",
    agents: [{ handle: "pile-of-dumb-things-pm", role: "pm" }],
  });
  assert.deepEqual(names, ["Tower of Lost Things", "pile of dumb things"]);
}

console.log("candidates: no role suffix leaves the whole handle; dupes collapse");
{
  const names = candidateNames({
    name: "gruvato",
    agents: [
      { handle: "gruvato-pm", role: "pm" },       // -> "gruvato" (dupe of name)
      { handle: "some-scrum-master", role: "" },   // -> "some scrum master"
    ],
  });
  assert.deepEqual(names, ["gruvato", "some scrum master"]);
}

// ---------------------------------------------------------------------------
// Project → tab resolution ladder
// ---------------------------------------------------------------------------

console.log("resolution: agent handle matches a live tab the project name cannot");
{
  const live = [{ name: "Pile of Dumb Things", position: 2 }];
  const r = resolveTabForProject(
    { name: "Tower of Lost Things", agents: [{ handle: "pile-of-dumb-things-pm", role: "pm" }] },
    live,
    [],
  );
  assert.equal(r.source, "live-exact");
  assert.equal(r.tab, "Pile of Dumb Things");
  assert.equal(r.matched, "pile of dumb things");
  assert.equal(r.storedAsIs, false);
}

console.log("resolution: exact live match wins and uses the live tab's display name");
{
  const r = resolveTabForProject({ name: "Tower of Lost Things", agents: [] }, [{ name: "Tower of Lost Things", position: 2 }], []);
  assert.deepEqual(r, { tab: "Tower of Lost Things", source: "live-exact", matched: "Tower of Lost Things", storedAsIs: false });
}

console.log("resolution: live suffix glyphs are stripped before matching");
{
  const r = resolveTabForProject({ name: "gruvato", agents: [] }, [{ name: "gruvato 🟢", position: 0 }], []);
  assert.equal(r.source, "live-exact");
  assert.equal(r.tab, "gruvato", "the stored key must be the stripped name");
}

console.log("resolution: a stored Redis key matches before a fuzzy live prefix");
{
  const live = [{ name: "Tow", position: 0 }];
  const stored = ["Tower of Lost Things"];
  // "Tower of Lost Things" is an exact match on the STORED key (step 2),
  // which outranks the live prefix match "Tow" (step 3).
  const r = resolveTabForProject({ name: "Tower of Lost Things", agents: [] }, live, stored);
  assert.equal(r.source, "redis-exact");
  assert.equal(r.tab, "Tower of Lost Things");
}

console.log("resolution: prefix match either way against a live tab");
{
  const r1 = resolveTabForProject({ name: "Green", agents: [] }, [{ name: "GreenInBetween", position: 1 }], []);
  assert.equal(r1.source, "live-prefix");
  assert.equal(r1.tab, "GreenInBetween");
  const r2 = resolveTabForProject({ name: "Holocene Mobile", agents: [] }, [{ name: "Holocene", position: 3 }], []);
  assert.equal(r2.source, "live-prefix");
  assert.equal(r2.tab, "Holocene");
}

console.log("resolution: no match stores the project name as-is and says so");
{
  const r = resolveTabForProject({ name: "Brand New Project", agents: [] }, [], []);
  assert.deepEqual(r, { tab: "Brand New Project", source: "project-name", matched: "Brand New Project", storedAsIs: true });
}

console.log("resolution: live-exact finds the tab, and the tab keeps the key it already has");
{
  // The live tab is the authority on WHICH tab; its existing key is the authority on the
  // spelling, so an enable doesn't mint zcrank:tab:Flume next to zcrank:tab:flume (WING-7).
  const live = [{ name: "Flume", position: 0 }];
  const r = resolveTabForProject({ name: "Flume", agents: [] }, live, ["flume"]);
  assert.equal(r.source, "live-exact");
  assert.equal(r.tab, "flume");
  const both = resolveTabForProject({ name: "Flume", agents: [] }, live, ["flume", "Flume"]);
  assert.equal(both.tab, "Flume");
}

console.log("resolution: agent candidates also reach redis-exact and live-prefix");
{
  const r1 = resolveTabForProject(
    { name: "Tower of Lost Things", agents: [{ handle: "pile-of-dumb-things-pm", role: "pm" }] },
    [],
    ["Pile of Dumb Things"], // stored key, tab not open now
  );
  assert.equal(r1.source, "redis-exact");
  assert.equal(r1.tab, "Pile of Dumb Things");

  const r2 = resolveTabForProject(
    { name: "Tower of Lost Things", agents: [{ handle: "pile-of-dumb-things-pm", role: "pm" }] },
    [{ name: "Pile of Dumb", position: 2 }], // live prefix of the candidate
    [],
  );
  assert.equal(r2.source, "live-prefix");
  assert.equal(r2.tab, "Pile of Dumb");
}

// ---------------------------------------------------------------------------
// Redis shell seam
// ---------------------------------------------------------------------------

/** A fake redis-cli: hash + list store, exact command log. */
function fakeRedis() {
  const hashes = new Map(); // key -> { field: value }
  const lists = new Map();  // key -> string[]
  const calls = [];
  const shell = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command !== "redis-cli") return { stdout: "", status: 127 };
    const op = args[5];
    const rest = args.slice(6);
    if (op === "PING") return { stdout: "PONG\n", status: 0 };
    if (op === "HGET") {
      const [key, field] = rest;
      return { stdout: `${hashes.get(key)?.[field] ?? ""}\n`, status: 0 };
    }
    if (op === "HSET") {
      const [key, field, value] = rest;
      const h = hashes.get(key) ?? {};
      h[field] = value;
      hashes.set(key, h);
      return { stdout: "0\n", status: 0 };
    }
    if (op === "KEYS") {
      const [pattern] = rest;
      const prefix = pattern.replace(/\*$/, "");
      const keys = [...hashes.keys()].filter((k) => k.startsWith(prefix));
      return { stdout: keys.length ? `${keys.join("\n")}\n` : "", status: 0 };
    }
    if (op === "RPUSH") {
      const [key, row] = rest;
      const list = lists.get(key) ?? [];
      list.push(row);
      lists.set(key, list);
      return { stdout: `${list.length}\n`, status: 0 };
    }
    if (op === "LTRIM") {
      // apply the cap so the 500-row contract is exercised
      const [key, start] = rest;
      const list = lists.get(key) ?? [];
      if (start === "-500") {
        lists.set(key, list.slice(-500));
      }
      return { stdout: "OK\n", status: 0 };
    }
    if (op === "LRANGE") {
      const [key] = rest;
      const list = lists.get(key) ?? [];
      return { stdout: list.length ? `${list.join("\n")}\n` : "", status: 0 };
    }
    return { stdout: "", status: 0 };
  };
  return { shell, hashes, lists, calls };
}

console.log("redis seam: enable writes HSET enabled 1, logs enabled, caps at 500");
{
  const fake = fakeRedis();
  const store = redis({ shell: fake.shell });
  assert.equal(store.ping(), true, "the fake must answer PING");
  store.setTabEnabled("Holocene", true);
  store.pushLog("Holocene", "enabled", "pj crank enable", crankTimestamp(new Date("2026-10-20T12:00:00Z")));
  assert.equal(fake.hashes.get("zcrank:tab:Holocene").enabled, "1");
  assert.equal(fake.lists.get("zcrank:log:Holocene").length, 1);
  assert.deepEqual(
    JSON.parse(fake.lists.get("zcrank:log:Holocene")[0]),
    { ts: "2026-10-20T12:00:00Z", state: "enabled", action: "pj crank enable" },
  );
  // cap: 502 rows -> 500 survive
  for (let i = 0; i < 501; i++) store.pushLog("Holocene", "beat", `row ${i}`, crankTimestamp(new Date()));
  assert.equal(fake.lists.get("zcrank:log:Holocene").length, 500);
}

console.log("redis seam: absent key reads as undefined, not 0");
{
  const fake = fakeRedis();
  const store = redis({ shell: fake.shell });
  assert.equal(store.tabEnabled("nothing"), undefined);
}

console.log("redis seam: commands go to 127.0.0.1:6379 with --raw");
{
  const fake = fakeRedis();
  const store = redis({ shell: fake.shell });
  store.tabEnabled("x");
  assert.match(fake.calls[0], /^redis-cli --raw -h 127\.0\.0\.1 -p 6379 HGET zcrank:tab:x enabled$/);
}

// ---------------------------------------------------------------------------
// zellij shell seam
// ---------------------------------------------------------------------------

console.log("zellij seam: list-tabs runs env -u ZELLIJ ... timeout 5s and parses names");
{
  const seen = [];
  const shell = (command, args) => {
    seen.push([command, ...args].join(" "));
    if (command === "env" && args.includes("zellij")) {
      return {
        stdout: JSON.stringify([{ position: 0, name: "gruvato 🟢" }, { position: 2, name: "Pile of Dumb Things" }]),
        status: 0,
      };
    }
    return { stdout: "", status: 1 };
  };
  const tabs = liveTabs({ shell });
  assert.equal(seen[0], "env -u ZELLIJ -u ZELLIJ_SESSION_NAME timeout 5s zellij -s Workspace action list-tabs --json");
  assert.deepEqual(tabs, [
    { name: "gruvato 🟢", position: 0 },
    { name: "Pile of Dumb Things", position: 2 },
  ]);
}

console.log("zellij seam: no session / junk output degrade to an empty tab list");
{
  assert.deepEqual(liveTabs({ shell: () => ({ stdout: "", status: 1 }) }), []);
  assert.deepEqual(liveTabs({ shell: () => ({ stdout: "not json", status: 0 }) }), []);
}

// ---------------------------------------------------------------------------
// crank list assembly + rendering
// ---------------------------------------------------------------------------

console.log("list: every registry project gets a row; orphans are separate; ON/OFF/absent differ");
{
  const fake = fakeRedis();
  fake.hashes.set("zcrank:tab:gruvato", { enabled: "1" });
  fake.hashes.set("zcrank:tab:Holocene", { enabled: "0" });
  fake.hashes.set("zcrank:tab:IPM", { enabled: "1" }); // orphan: no project named IPM
  const store = redis({ shell: fake.shell });
  const report = buildCrankList({
    projects: [
      { slug: "gruvato", name: "gruvato", repoPath: "/x/gruvato", agents: [] },
      { slug: "holocene", name: "Holocene", repoPath: "/x/holocene", agents: [] },
      { slug: "momo", name: "Momo", repoPath: "/x/momo", agents: [] },
    ],
    live: [],
    storedTabs: ["gruvato", "Holocene", "IPM"],
    tabEnabled: (tab) => store.tabEnabled(tab),
  });
  assert.equal(report.rows.length, 3);
  const bySlug = Object.fromEntries(report.rows.map((row) => [row.slug, row]));
  assert.equal(bySlug.gruvato.crank, "ON");
  assert.equal(bySlug.gruvato.source, "redis-exact");
  assert.equal(bySlug.holocene.crank, "OFF");
  assert.equal(bySlug.momo.crank, "—", "absent key reads as never-toggled, not OFF");
  assert.deepEqual(report.orphans, [{ tab: "IPM", enabled: true }]);

  const text = formatCrankList(report);
  assert.match(text, /gruvato\s+ON/);
  assert.match(text, /Holocene\s+OFF/);
  assert.match(text, /IPM/);
  assert.match(text, /no matching project/);
}

console.log("list: an agent-matched tab is consumed, not orphaned");
{
  const fake = fakeRedis();
  fake.hashes.set("zcrank:tab:Pile of Dumb Things", { enabled: "1" });
  const store = redis({ shell: fake.shell });
  const report = buildCrankList({
    projects: [
      {
        slug: "tower-of-dumb-things",
        name: "Tower of Lost Things",
        repoPath: "/tmp/pjan-174/tower-of-lost-things",
        agents: [{ handle: "pile-of-dumb-things-pm", role: "pm" }],
      },
    ],
    live: [{ name: "Pile of Dumb Things", position: 2 }],
    storedTabs: ["Pile of Dumb Things"],
    tabEnabled: (tab) => store.tabEnabled(tab),
  });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].tab, "Pile of Dumb Things");
  assert.equal(report.rows[0].crank, "ON");
  assert.deepEqual(report.orphans, [], "the tab a project claims via its agent handle is never an orphan");
}

console.log("list: two projects resolving to one tab share it without orphaning");
{
  const fake = fakeRedis();
  fake.hashes.set("zcrank:tab:IntelliForia", { enabled: "1" });
  const store = redis({ shell: fake.shell });
  const report = buildCrankList({
    projects: [
      { slug: "intelliforia", name: "IntelliForia", repoPath: "/x", agents: [] },
      { slug: "intelliforia-mobile", name: "IntelliForia Mobile", repoPath: "/y", agents: [] },
    ],
    live: [{ name: "IntelliForia", position: 4 }],
    storedTabs: ["IntelliForia"],
    tabEnabled: (tab) => store.tabEnabled(tab),
  });
  assert.equal(report.rows.length, 2);
  assert.ok(report.rows.every((row) => row.tab === "IntelliForia"));
  assert.deepEqual(report.orphans, [], "a shared tab is consumed, never an orphan");
}

// ---------------------------------------------------------------------------
// Log rendering
// ---------------------------------------------------------------------------

console.log("log: rows render as 'ts  state  action'; junk rows pass through raw");
{
  const line = renderLogRow(JSON.stringify({ ts: "2026-10-20T12:00:00Z", state: "enabled", action: "pj crank enable" }));
  // padEnd(12): "enabled" + 5 spaces, no separator before action.
  assert.equal(line, "2026-10-20T12:00:00Z  enabled     pj crank enable");
  // renderLogRow returns null for non-JSON; the CLI prints the raw line then.
  assert.equal(renderLogRow("{{{not json"), null);
}

console.log("log: crankTimestamp drops milliseconds the way zcrankctl's date -u does");
{
  assert.equal(crankTimestamp(new Date("2026-10-20T12:34:56.789Z")), "2026-10-20T12:34:56Z");
}

// ---------------------------------------------------------------------------
// CLI surface (bundled, run against the fakes through the real commander tree)
// ---------------------------------------------------------------------------

console.log("cli: pj crank --help lists enable/disable/list/log");
{
  const built = spawnSync(
    esbuild,
    [
      join(root, "src", "index.ts"),
      "--bundle",
      "--external:@delorenj/skillex",
      "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      "--platform=node",
      "--format=esm",
      `--outfile=${join(workspace, "pj.mjs")}`,
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) {
    console.error(`failed to bundle the CLI:\n${built.stderr}`);
    process.exit(1);
  }
  const help = spawnSync(process.execPath, [join(workspace, "pj.mjs"), "crank", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  for (const word of ["enable", "disable", "list", "log"]) {
    assert.ok(help.stdout.includes(word), `crank --help must mention ${word}`);
  }
  const badTail = spawnSync(process.execPath, [join(workspace, "pj.mjs"), "crank", "log", "--tail", "zero"], { encoding: "utf8", cwd: workspace });
  assert.notEqual(badTail.status, 0, "--tail zero must be refused");
  const outside = spawnSync(process.execPath, [join(workspace, "pj.mjs"), "crank", "enable"], { encoding: "utf8", cwd: workspace });
  assert.notEqual(outside.status, 0, "crank enable outside a project must fail");
  assert.match(outside.stderr, /not inside a pjangler project/);
}

rmSync(workspace, { recursive: true, force: true });
console.log("\nPJAN-174 crank regressions: all green");
