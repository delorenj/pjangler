// PJAN-72 — ticket-provider deep links.
//
// Three surfaces share one derivation, and the whole point of the ticket is
// that they cannot disagree. So the derivation is tested directly against
// src/, and both executable surfaces are then exercised end to end rather than
// asserted about.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pjan-72-"));

// TMPDIR can itself sit inside a git work tree on this developer's machine.
// Every fixture below therefore carries its own `.git`, so branch resolution
// can never silently walk up into an enclosing repository and report ITS
// branch — which is exactly the failure this ticket's branch-inference would
// otherwise ship.
process.env.GIT_CEILING_DIRECTORIES = workspace;

const esbuild = join(root, "node_modules", ".bin", "esbuild");

// `external` mirrors the shipped build, which leaves node_modules on disk. It
// has to be off for anything executed from the scratch workspace: the bundle
// lands outside the repo, where node cannot resolve `commander` and friends.
function bundle(entrySources, outName, { external = true, entryIsSource = false } = {}) {
  const entry = entryIsSource
    ? entrySources[0]
    : join(workspace, `${outName}-entry.ts`);
  if (!entryIsSource) {
    writeFileSync(entry, entrySources.map((s) => `export * from ${JSON.stringify(s)};`).join("\n"), "utf8");
  }
  const out = join(workspace, `${outName}.mjs`);
  const built = spawnSync(
    esbuild,
    [
      entry,
      "--bundle",
      ...(external
        ? ["--packages=external"]
        : // Inlined CJS dependencies (commander) still call `require` at load
          // time, which ESM output has no binding for. The shipped build never
          // hits this because it leaves those packages external.
          [
            "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
          ]),
      "--platform=node",
      "--format=esm",
      `--outfile=${out}`,
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) {
    console.error(`failed to bundle ${outName}:\n${built.stderr}`);
    process.exit(1);
  }
  return out;
}

const kitPath = bundle(
  [join(root, "src", "project", "boardUrl.ts"), join(root, "src", "project", "openUrl.ts")],
  "kit",
);

const {
  DEFAULT_PLANE_BASE,
  boardUrl,
  currentBranch,
  extractTicketRef,
  isHeadless,
  normalizeTicketRef,
  osc8,
  planeBase,
  readTicketProvider,
  readTomlScalar,
  resolveBoardUrl,
  resolveTemplateConfigPath,
} = await import(kitPath);

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

/** A project fixture that is its own git repo, on `branch`. */
function fixture(name, { provider, branch = "main", detached = false } = {}) {
  const dir = join(workspace, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  if (provider !== null) {
    writeFileSync(
      join(dir, ".project.json"),
      JSON.stringify({ project_slug: name, ticket_provider: provider }, null, 2),
      "utf8",
    );
  }
  writeFileSync(
    join(dir, ".git", "HEAD"),
    detached ? "9f1c2b3d4e5f60718293a4b5c6d7e8f900112233\n" : `ref: refs/heads/${branch}\n`,
    "utf8",
  );
  return dir;
}

const PLANE = { type: "plane", workspace: "33god", identifier: "PJAN", board_id: "board-uuid" };
const BASE_ENV = { PLANE_BASE: "https://plane.delo.sh" };

// --------------------------------------------------------------------------
console.log("boardUrl: derivation");

test("plane falls back to the board's work-item view", () => {
  assert.equal(
    boardUrl(PLANE, { env: BASE_ENV }),
    "https://plane.delo.sh/33god/projects/board-uuid/issues",
  );
});

test("plane with an explicit ref uses the workspace-scoped browse route", () => {
  assert.equal(
    boardUrl(PLANE, { ref: "71", env: BASE_ENV }),
    "https://plane.delo.sh/33god/browse/PJAN-71",
  );
});

test("plane infers the ref from the branch", () => {
  assert.equal(
    boardUrl(PLANE, { branch: "fix/PJAN-67-mcp-fail-closed", env: BASE_ENV }),
    "https://plane.delo.sh/33god/browse/PJAN-67",
  );
});

test("an explicit ref beats branch inference", () => {
  assert.equal(
    boardUrl(PLANE, { ref: "PJAN-9", branch: "fix/PJAN-67-mcp-fail-closed", env: BASE_ENV }),
    "https://plane.delo.sh/33god/browse/PJAN-9",
  );
});

test("a foreign but same-workspace ref resolves (browse is workspace-scoped)", () => {
  assert.equal(
    boardUrl(PLANE, { ref: "DECK-21", env: BASE_ENV }),
    "https://plane.delo.sh/33god/browse/DECK-21",
  );
});

test("trello opens the board and does not pretend to resolve a ref", () => {
  const trello = { type: "trello", identifier: "AAA", board_id: "abc123" };
  assert.equal(boardUrl(trello, { env: BASE_ENV }), "https://trello.com/b/abc123");
  assert.equal(boardUrl(trello, { ref: "AAA-5", env: BASE_ENV }), "https://trello.com/b/abc123");
});

test("no board_id yields undefined rather than a guessed URL", () => {
  assert.equal(boardUrl({ ...PLANE, board_id: "" }, { env: BASE_ENV }), undefined);
  assert.equal(boardUrl({ ...PLANE, board_id: undefined }, { env: BASE_ENV }), undefined);
});

test("an unknown provider yields undefined", () => {
  assert.equal(boardUrl({ type: "jira", board_id: "x" }, { env: BASE_ENV }), undefined);
});

test("an absent provider yields undefined", () => {
  assert.equal(boardUrl(undefined, { env: BASE_ENV }), undefined);
});

test("a missing type defaults to plane", () => {
  assert.equal(
    boardUrl({ workspace: "33god", board_id: "b", identifier: "PJAN" }, { env: BASE_ENV }),
    "https://plane.delo.sh/33god/projects/b/issues",
  );
});

// --------------------------------------------------------------------------
console.log("ticket references");

test("branch refs are extracted case-insensitively and normalized upward", () => {
  assert.equal(extractTicketRef("fix/PJAN-67-mcp-fail-closed", "PJAN"), "PJAN-67");
  assert.equal(extractTicketRef("feature/pjan-4-thing", "PJAN"), "PJAN-4");
  assert.equal(extractTicketRef("PJAN-12", "PJAN"), "PJAN-12");
});

test("a foreign prefix never reads as this project's ref", () => {
  assert.equal(extractTicketRef("fix/XPJAN-3-thing", "PJAN"), undefined);
  assert.equal(extractTicketRef("fix/PJANX-3-thing", "PJAN"), undefined);
});

test("a branch with no ref yields undefined", () => {
  assert.equal(extractTicketRef("main", "PJAN"), undefined);
  assert.equal(extractTicketRef(undefined, "PJAN"), undefined);
  assert.equal(extractTicketRef("fix/PJAN-67", undefined), undefined);
});

test("a regex-special identifier is escaped, not interpreted", () => {
  assert.equal(extractTicketRef("fix/A.C-5", "A.C"), "A.C-5");
  assert.equal(extractTicketRef("fix/ABC-5", "A.C"), undefined);
});

test("normalizeTicketRef completes bare numbers and uppercases prefixes", () => {
  assert.equal(normalizeTicketRef("71", "PJAN"), "PJAN-71");
  assert.equal(normalizeTicketRef("pjan-71", "PJAN"), "PJAN-71");
  assert.equal(normalizeTicketRef("DECK-21", "PJAN"), "DECK-21");
  assert.equal(normalizeTicketRef("  71  ", "PJAN"), "PJAN-71");
});

test("normalizeTicketRef rejects what it cannot resolve", () => {
  assert.equal(normalizeTicketRef("garbage", "PJAN"), undefined);
  assert.equal(normalizeTicketRef("PJAN-", "PJAN"), undefined);
  assert.equal(normalizeTicketRef("-5", "PJAN"), undefined);
  assert.equal(normalizeTicketRef("", "PJAN"), undefined);
  assert.equal(normalizeTicketRef("71", undefined), undefined);
});

// --------------------------------------------------------------------------
console.log("plane base resolution");

test("PLANE_BASE wins and loses its trailing slash", () => {
  assert.equal(planeBase({ PLANE_BASE: "https://plane.example.com/" }, workspace), "https://plane.example.com");
});

test("the template config supplies the base when env is silent", () => {
  const home = join(workspace, "home-with-config");
  mkdirSync(join(home, ".config", "hermes-agent-template"), { recursive: true });
  writeFileSync(
    join(home, ".config", "hermes-agent-template", "config.toml"),
    '[github]\nrunt = ""\n\n[plane]\n# comment\nbase = "https://plane.internal.example"\nworkspace = "acme"\n',
    "utf8",
  );
  assert.equal(planeBase({}, home), "https://plane.internal.example");
});

test("an absent config falls back to the fleet default", () => {
  assert.equal(planeBase({}, join(workspace, "home-empty")), DEFAULT_PLANE_BASE);
  assert.equal(DEFAULT_PLANE_BASE, "https://plane.delo.sh");
});

test("the config workspace is used when the manifest omits one", () => {
  const home = join(workspace, "home-ws");
  mkdirSync(join(home, ".config", "hermes-agent-template"), { recursive: true });
  writeFileSync(
    join(home, ".config", "hermes-agent-template", "config.toml"),
    '[plane]\nbase = "https://p.example"\nworkspace = "acme"\n',
    "utf8",
  );
  assert.equal(
    boardUrl({ type: "plane", board_id: "b", identifier: "X" }, { env: {}, home }),
    "https://p.example/acme/projects/b/issues",
  );
});

test("readTomlScalar reads quoted, bare, and commented values, and respects sections", () => {
  const toml = '[a]\nkey = "in-a"\n[plane]\nbase = "https://x"\nbare = plain # trailing\n';
  assert.equal(readTomlScalar(toml, "plane", "base"), "https://x");
  assert.equal(readTomlScalar(toml, "plane", "bare"), "plain");
  assert.equal(readTomlScalar(toml, "a", "key"), "in-a");
  assert.equal(readTomlScalar(toml, "plane", "key"), undefined);
  assert.equal(readTomlScalar(toml, "missing", "base"), undefined);
});

test("resolveTemplateConfigPath honors HERMES_TEMPLATE_CONFIG then XDG then home", () => {
  // Synthetic roots rather than a literal /home/<user>: the repo's
  // portable-test-paths gate rejects machine-shaped home paths in tests, and it
  // is right to — they are how a suite quietly becomes unrunnable elsewhere.
  const fakeHome = join(workspace, "synthetic-home");
  const fakeXdg = join(workspace, "synthetic-xdg");
  assert.equal(
    resolveTemplateConfigPath({ HERMES_TEMPLATE_CONFIG: join(workspace, "x.toml") }, fakeHome),
    join(workspace, "x.toml"),
  );
  assert.equal(
    resolveTemplateConfigPath({ XDG_CONFIG_HOME: fakeXdg }, fakeHome),
    join(fakeXdg, "hermes-agent-template", "config.toml"),
  );
  assert.equal(
    resolveTemplateConfigPath({}, fakeHome),
    join(fakeHome, ".config", "hermes-agent-template", "config.toml"),
  );
});

// Drift tripwire, not a behaviour test: `EnsureTemplateConfig.ts` owns the twin
// of the resolver above and cannot be imported here without dragging the
// command layer into the prompt bundle. This only proves the two still name the
// same file — if it fires, reconcile them by hand.
test("TRIPWIRE: EnsureTemplateConfig still names the same config path", () => {
  const source = readFileSync(join(root, "src", "commands", "hermes", "EnsureTemplateConfig.ts"), "utf8");
  assert.ok(
    source.includes('"hermes-agent-template", "config.toml"'),
    "EnsureTemplateConfig.resolveTemplateConfigPath drifted from boardUrl.resolveTemplateConfigPath",
  );
  assert.ok(source.includes("HERMES_TEMPLATE_CONFIG"), "env override drifted");
});

// --------------------------------------------------------------------------
console.log("repo facts");

test("currentBranch reads .git/HEAD without shelling out", () => {
  assert.equal(currentBranch(fixture("branchy", { provider: PLANE, branch: "fix/PJAN-67-x" })), "fix/PJAN-67-x");
});

test("currentBranch walks up from a subdirectory", () => {
  const dir = fixture("nested", { provider: PLANE, branch: "feature/PJAN-8-y" });
  const sub = join(dir, "src", "deep");
  mkdirSync(sub, { recursive: true });
  assert.equal(currentBranch(sub), "feature/PJAN-8-y");
});

test("a detached HEAD has no branch", () => {
  assert.equal(currentBranch(fixture("detached", { provider: PLANE, detached: true })), undefined);
});

test("currentBranch follows the .git-as-a-file form used by worktrees", () => {
  const real = join(workspace, "wt-gitdir");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "HEAD"), "ref: refs/heads/wt/PJAN-31-z\n", "utf8");
  const dir = join(workspace, "wt-project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${real}\n`, "utf8");
  assert.equal(currentBranch(dir), "wt/PJAN-31-z");
});

test("readTicketProvider survives a malformed manifest", () => {
  const dir = join(workspace, "broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".project.json"), "{not json", "utf8");
  assert.equal(readTicketProvider(dir), undefined);
});

test("resolveBoardUrl composes the walk, the manifest, and the branch", () => {
  const dir = fixture("full", { provider: PLANE, branch: "fix/PJAN-67-mcp" });
  assert.equal(resolveBoardUrl(dir, undefined, BASE_ENV), "https://plane.delo.sh/33god/browse/PJAN-67");
  assert.equal(resolveBoardUrl(dir, "3", BASE_ENV), "https://plane.delo.sh/33god/browse/PJAN-3");
});

test("resolveBoardUrl outside any project yields undefined", () => {
  const bare = join(workspace, "no-project");
  mkdirSync(bare, { recursive: true });
  assert.equal(resolveBoardUrl(bare, undefined, BASE_ENV), undefined);
});

// --------------------------------------------------------------------------
console.log("opening");

test("osc8 wraps the url in a hyperlink escape", () => {
  assert.equal(osc8("https://x", "label"), "\u001b]8;;https://x\u0007label\u001b]8;;\u0007");
  assert.ok(osc8("https://x").includes("https://x"));
});

test("ssh and a missing display both read as headless", () => {
  assert.equal(isHeadless({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, "linux"), true);
  assert.equal(isHeadless({}, "linux"), true);
  assert.equal(isHeadless({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), false);
  assert.equal(isHeadless({ DISPLAY: ":0" }, "linux"), false);
  assert.equal(isHeadless({}, "darwin"), false);
  // ssh outranks a forwarded display: the browser would open on the wrong host.
  assert.equal(isHeadless({ DISPLAY: ":0", SSH_CONNECTION: "x" }, "linux"), true);
});

// --------------------------------------------------------------------------
console.log("surfaces (end to end)");

const promptBin = join(root, "dist", "prompt.js");
// Built from src/, not from dist/: this asserts what the source does now,
// which is the only thing a regression suite can honestly claim.
const cliBundle = bundle([join(root, "src", "index.ts")], "cli", { external: false, entryIsSource: true });

function run(bin, args, cwd, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...BASE_ENV, ...env },
  });
}

const live = fixture("live", { provider: PLANE, branch: "fix/PJAN-67-mcp-fail-closed" });
const outside = join(workspace, "outside");
mkdirSync(outside, { recursive: true });

test("prompt --url prints the branch's work item and exits 0", () => {
  const r = run(promptBin, ["--url"], live);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "https://plane.delo.sh/33god/browse/PJAN-67\n");
});

test("prompt --url takes an explicit ref", () => {
  const r = run(promptBin, ["--url", "71"], live);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "https://plane.delo.sh/33god/browse/PJAN-71");
});

test("prompt --url outside a project prints nothing and exits non-zero", () => {
  const r = run(promptBin, ["--url"], outside);
  assert.equal(r.stdout, "");
  assert.notEqual(r.status, 0);
});

test("the bare prompt contract is unchanged by --url", () => {
  const r = run(promptBin, [], live);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith("live (PJAN)"), `unexpected prompt line: ${JSON.stringify(r.stdout)}`);
  assert.ok(!r.stdout.includes("\n"), "the prompt line must stay a single line");
  const quiet = run(promptBin, [], outside);
  assert.equal(quiet.stdout, "");
  assert.equal(quiet.status, 0);
});

test("board --print resolves the same URL as the prompt", () => {
  const viaPrompt = run(promptBin, ["--url"], live).stdout.trim();
  const viaCli = run(cliBundle, ["board", "--print"], live);
  assert.equal(viaCli.status, 0, viaCli.stderr);
  assert.equal(viaCli.stdout.trim(), viaPrompt);
});

test("board --print accepts a ref", () => {
  const r = run(cliBundle, ["board", "--print", "DECK-21"], live);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "https://plane.delo.sh/33god/browse/DECK-21");
});

test("board outside a project fails loudly instead of opening nothing", () => {
  const r = run(cliBundle, ["board", "--print"], outside);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No ticket board here/);
});

test("board on a headless host prints a link rather than launching", () => {
  const r = run(cliBundle, ["board"], live, {
    DISPLAY: "",
    WAYLAND_DISPLAY: "",
    SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("https://plane.delo.sh/33god/browse/PJAN-67"), r.stdout);
  assert.match(r.stdout, /no display/);
});

// --------------------------------------------------------------------------
rmSync(workspace, { recursive: true, force: true });
if (failures) {
  console.error(`\nPJAN-72 regressions: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nPJAN-72 board deep-link regressions passed");
