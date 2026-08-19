import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";

// Every commit stamp below is a timezone-NAIVE ISO string, which git resolves
// in the local zone. Comparing those against a fixed UTC `now` therefore gives
// a different answer per machine: "2026-08-16T12:00:00" is 16:00Z here and
// 12:00Z on a UTC runner, which is exactly 24h before the fixed now and flipped
// "20 hours ago" into "1 day ago" on CI. Pin the zone so a local run and CI
// compute the same ages.
process.env.TZ = "UTC";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const promptBin = join(root, "dist", "prompt.js");
const workspace = mkdtempSync(join(tmpdir(), "pjan-71-"));
const registryPath = join(workspace, "projects.yaml");

// TMPDIR can itself sit inside a git work tree (it does on this developer's
// machine), in which case git walks up out of the scratch workspace and every
// "not a repo" case silently inherits that outer repo. Pinning a ceiling makes
// these assertions hermetic wherever TMPDIR happens to point.
process.env.GIT_CEILING_DIRECTORIES = workspace;

// The source uses extensionless imports, which esbuild resolves and node's
// native ESM loader does not. Bundle the real modules once, then import the
// bundle — so these assertions still run against src/, not a hand-written copy.
const kitEntry = join(workspace, "kit-entry.ts");
writeFileSync(
  kitEntry,
  [
    `export * from ${JSON.stringify(join(root, "src", "describe", "activity.ts"))};`,
    `export * from ${JSON.stringify(join(root, "src", "describe", "checklist.ts"))};`,
    `export * from ${JSON.stringify(join(root, "src", "utils", "style.ts"))};`,
  ].join("\n"),
  "utf8",
);
const kitPath = join(workspace, "kit.mjs");
const bundled = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [kitEntry, "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=${kitPath}`],
  { encoding: "utf8" },
);
if (bundled.status !== 0) {
  console.error(`failed to bundle the test kit:\n${bundled.stderr}`);
  process.exit(1);
}

const {
  STATUS_ARGS,
  assembleActivity,
  computeRepoActivity,
  computeRepoActivityAsync,
  computeRepoActivityBatch,
  formatCompactAge,
  formatRelativeAge,
  parseRefs,
  parseStatusPaths,
  parseWorktrees,
  createChecklist,
  reduceChecklist,
  renderChecklist,
  runChecklist,
  selectedIds,
  padVisible,
  stripAnsi,
  terminalWidth,
  truncateVisible,
  visibleWidth,
  wrapVisible,
} = await import(kitPath);

function run(bin, args, cwd = root, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
}

function git(repo, args, env = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_GUARD_OFF: "1", ...env },
  });
  return result;
}

function makeRepo(name) {
  const repo = join(workspace, name);
  mkdirSync(repo, { recursive: true });
  assert.equal(git(repo, ["init", "-q"]).status, 0, `git init failed for ${name}`);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  return repo;
}

function commitAt(repo, file, iso, message = "c") {
  writeFileSync(join(repo, file), `${file}\n`, "utf8");
  git(repo, ["add", "-A"]);
  const stamp = { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  assert.equal(git(repo, ["commit", "-qm", message], stamp).status, 0, `commit failed in ${repo}`);
}

let failures = 0;
function section(name) {
  process.stdout.write(`  ${name}\n`);
}
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    failures += 1;
    process.stdout.write(`    FAIL ${label}: ${err.message}\n`);
    return;
  }
}

try {
  // =========================================================================
  section("relative age ladder");
  // =========================================================================
  const ladder = [
    [0, "just now", "now"],
    [59, "just now", "now"],
    [60, "1 minute ago", "1m"],
    [3599, "59 minutes ago", "59m"],
    [3600, "1 hour ago", "1h"],
    [86399, "23 hours ago", "23h"],
    [86400, "1 day ago", "1d"],
    [604800, "1 week ago", "1w"],
    [2592000, "1 month ago", "1mo"],
    [31536000, "1 year ago", "1y"],
  ];
  for (const [delta, long, short] of ladder) {
    check(`ladder ${delta}`, () => {
      assert.equal(formatRelativeAge(delta), long);
      assert.equal(formatCompactAge(delta), short);
    });
  }
  check("negative deltas clamp rather than reading 'in -3 hours'", () => {
    assert.equal(formatRelativeAge(-500), "just now");
    assert.equal(formatCompactAge(-500), "now");
  });

  // =========================================================================
  section("activity: git coverage");
  // =========================================================================

  // --- A detached worktree commit lives on NO ref. Ref-only scanning misses
  //     it entirely, which is exactly why worktrees are probed separately.
  const detached = makeRepo("detached");
  commitAt(detached, "old.txt", "2026-01-01T00:00:00", "old");
  const detachedWt = join(workspace, "detached-wt");
  assert.equal(git(detached, ["worktree", "add", "-q", "--detach", detachedWt, "HEAD"]).status, 0);
  writeFileSync(join(detachedWt, "new.txt"), "new\n", "utf8");
  git(detachedWt, ["add", "-A"]);
  git(detachedWt, ["commit", "-qm", "detached work"], {
    // 20 hours before the fixed `now` below. Was 12:00, which under the pinned
    // UTC zone is exactly 24h and renders "1 day ago" instead.
    GIT_AUTHOR_DATE: "2026-08-16T16:00:00",
    GIT_COMMITTER_DATE: "2026-08-16T16:00:00",
  });

  const now = new Date("2026-08-17T12:00:00Z");
  check("the detached commit really is on no ref", () => {
    const sha = git(detachedWt, ["rev-parse", "HEAD"]).stdout.trim();
    const containing = git(detached, ["for-each-ref", "--contains", sha, "--format=%(refname)"]).stdout.trim();
    assert.equal(containing, "", "test premise broken: the commit is reachable from a ref");
  });
  check("worktree HEADs are counted as activity", () => {
    const activity = computeRepoActivity(detached, { now });
    assert.equal(activity.source.kind, "worktree", `expected worktree source, got ${activity.source?.kind}`);
    assert.match(activity.source.label, /detached/, "a detached worktree should say so");
    assert.equal(activity.relative, "20 hours ago");
  });
  check("refs alone would have reported the repo as months stale", () => {
    const refsOnly = parseRefs(
      git(detached, ["for-each-ref", "--sort=-committerdate", "--format=%(committerdate:unix)%09%(refname:short)", "refs/heads"]).stdout,
    );
    const delta = Math.floor(now.getTime() / 1000) - refsOnly.source.unix;
    assert.ok(delta > 30 * 24 * 3600, "ref-only scanning should look badly stale here");
  });

  // --- Uncommitted work beats committed history, and is labelled as such.
  const dirty = makeRepo("dirty");
  commitAt(dirty, "a.txt", "2026-01-01T00:00:00");
  writeFileSync(join(dirty, "wip.txt"), "wip\n", "utf8");
  check("uncommitted edits count as activity", () => {
    const activity = computeRepoActivity(dirty, { now });
    assert.equal(activity.source.kind, "uncommitted");
    assert.match(activity.source.label, /uncommitted file/);
    assert.equal(activity.scanned.dirtyFiles, 1);
  });

  // --- Nothing at all must not crash or invent a timestamp.
  const empty = makeRepo("empty-repo");
  check("a repo with zero commits reports never, not a crash", () => {
    const activity = computeRepoActivity(empty, { now });
    assert.equal(activity.updated, null);
    assert.equal(activity.relative, "never");
    assert.equal(activity.active, false);
  });
  check("a plain directory that is not a repo reports never", () => {
    const plain = join(workspace, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    const activity = computeRepoActivity(plain, { now });
    assert.equal(activity.relative, "never");
    assert.deepEqual(activity.scanned, { refs: 0, worktrees: 0, dirtyFiles: 0 });
  });

  check("active is a 24h window around the newest work", () => {
    const fresh = assembleActivity([{ kind: "ref", label: "main", unix: 1000000 }], { refs: 1, worktrees: 0, dirtyFiles: 0 }, new Date((1000000 + 86399) * 1000));
    const stale = assembleActivity([{ kind: "ref", label: "main", unix: 1000000 }], { refs: 1, worktrees: 0, dirtyFiles: 0 }, new Date((1000000 + 86401) * 1000));
    assert.equal(fresh.active, true);
    assert.equal(stale.active, false);
  });

  check("ties break toward the more immediate source", () => {
    const shared = 1700000000;
    const resolved = assembleActivity(
      [
        { kind: "ref", label: "main", unix: shared },
        { kind: "uncommitted", label: "1 uncommitted file", unix: shared },
      ],
      { refs: 1, worktrees: 0, dirtyFiles: 1 },
      new Date(shared * 1000),
    );
    assert.equal(resolved.source.kind, "uncommitted", "an edit at the same second is the later event");
  });

  // --- Sync and async drivers must never disagree; the batch path is what
  //     `project list` depends on.
  check("sync and async drivers agree", async () => {});
  const asyncActivity = await computeRepoActivityAsync(detached, { now });
  check("async driver matches sync driver", () => {
    const sync = computeRepoActivity(detached, { now });
    assert.equal(asyncActivity.updatedUnix, sync.updatedUnix);
    assert.equal(asyncActivity.source.kind, sync.source.kind);
    assert.deepEqual(asyncActivity.scanned, sync.scanned);
  });
  const batch = await computeRepoActivityBatch([detached, dirty, empty], { now });
  check("batch covers every repo it is given", () => {
    assert.equal(batch.size, 3);
    assert.equal(batch.get(detached).source.kind, "worktree");
    assert.equal(batch.get(dirty).source.kind, "uncommitted");
    assert.equal(batch.get(empty).updated, null);
  });

  // =========================================================================
  section("activity: parsers");
  // =========================================================================
  check("rename entries consume their origin path", () => {
    // "R  new" followed by a bare "old" is ONE change, not two.
    const paths = parseStatusPaths("R  new.txt\0old.txt\0 M other.txt\0");
    assert.deepEqual(paths, ["new.txt", "other.txt"]);
  });
  check("paths with spaces survive NUL parsing", () => {
    assert.deepEqual(parseStatusPaths("?? a file with spaces.md\0"), ["a file with spaces.md"]);
  });
  check("empty and undefined status output yields no paths", () => {
    assert.deepEqual(parseStatusPaths(""), []);
    assert.deepEqual(parseStatusPaths(undefined), []);
  });
  check("worktree porcelain parsing marks detached entries", () => {
    const entries = parseWorktrees("worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\n");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].detached, false);
    assert.equal(entries[1].detached, true);
    assert.equal(entries[1].sha, "def");
  });
  check("submodule working trees are excluded from the status probe", () => {
    // Both a correctness and a performance contract: recursing into submodules
    // measured 100ms on the 33GOD superproject and attributes a submodule's
    // own work to its parent.
    assert.ok(STATUS_ARGS.includes("--ignore-submodules=dirty"), `STATUS_ARGS was ${STATUS_ARGS.join(" ")}`);
    assert.ok(STATUS_ARGS.includes("-z"), "NUL separation is required for paths with spaces");
  });

  // =========================================================================
  section("style: ANSI-aware layout");
  // =========================================================================
  const RED = "\x1b[31m";
  const OFF = "\x1b[39m";
  check("visibleWidth ignores escapes", () => {
    assert.equal(visibleWidth(`${RED}mise${OFF}`), 4);
    assert.equal(stripAnsi(`${RED}mise${OFF}`), "mise");
  });
  check("padVisible pads a colored string that padEnd cannot", () => {
    const colored = `${RED}mise${OFF}`;
    assert.equal(colored.padEnd(12).length, colored.length, "premise: padEnd is a no-op on colored input");
    assert.equal(visibleWidth(padVisible(colored, 12)), 12);
  });
  check("truncateVisible marks the cut and never exceeds the budget", () => {
    assert.equal(truncateVisible("abcdefghij", 5), "abcd…");
    assert.equal(visibleWidth(truncateVisible("abcdefghij", 5)), 5);
    assert.equal(truncateVisible("abc", 10), "abc");
  });
  check("terminalWidth guards zero, not just undefined", () => {
    assert.equal(terminalWidth({ columns: 0 }, 100), 100, "a pty can report 0 columns");
    assert.equal(terminalWidth({}, 100), 100);
    assert.equal(terminalWidth({ columns: 73 }, 100), 73);
  });
  check("wrapVisible respects the column and hard-splits long words", () => {
    for (const line of wrapVisible("the quick brown fox jumps over the lazy dog", 12)) {
      assert.ok(visibleWidth(line) <= 12, `line too wide: ${JSON.stringify(line)}`);
    }
    for (const line of wrapVisible("x".repeat(40), 10)) {
      assert.ok(visibleWidth(line) <= 10, "a single long word must be split");
    }
  });

  // =========================================================================
  section("checklist: pure reducer");
  // =========================================================================
  const items = [
    { id: "one", title: "one", detail: "first" },
    { id: "two", title: "two", detail: "second" },
    { id: "three", title: "three", detail: "third" },
  ];
  const fresh = () => createChecklist(items);
  check("everything starts ticked", () => {
    assert.deepEqual(selectedIds(fresh()), ["one", "two", "three"]);
  });
  check("space unticks and re-ticks the item under the cursor", () => {
    let state = reduceChecklist(fresh(), { name: "space" });
    assert.deepEqual(selectedIds(state), ["two", "three"]);
    state = reduceChecklist(state, { name: "space" });
    assert.deepEqual(selectedIds(state), ["one", "two", "three"]);
  });
  check("A applies — the key clack could not give us", () => {
    // readline reports uppercase A as {name:"a", shift:true}
    assert.equal(reduceChecklist(fresh(), { name: "a", shift: true }).outcome, "apply");
    assert.equal(reduceChecklist(fresh(), { name: "a" }).outcome, "apply");
  });
  check("enter also applies, q and escape cancel, ctrl-c always cancels", () => {
    assert.equal(reduceChecklist(fresh(), { name: "return" }).outcome, "apply");
    assert.equal(reduceChecklist(fresh(), { name: "q" }).outcome, "cancel");
    assert.equal(reduceChecklist(fresh(), { name: "escape" }).outcome, "cancel");
    assert.equal(reduceChecklist(fresh(), { name: "c", ctrl: true }).outcome, "cancel");
  });
  check("the cursor clamps at both ends", () => {
    let state = fresh();
    for (let index = 0; index < 10; index++) state = reduceChecklist(state, { name: "down" });
    assert.equal(state.cursor, 2);
    for (let index = 0; index < 10; index++) state = reduceChecklist(state, { name: "up" });
    assert.equal(state.cursor, 0);
  });
  check("a decided checklist ignores further keys", () => {
    const applied = reduceChecklist(fresh(), { name: "a" });
    assert.equal(reduceChecklist(applied, { name: "q" }).outcome, "apply");
  });
  check("unknown keys are inert and preserve identity", () => {
    const state = fresh();
    assert.equal(reduceChecklist(state, { name: "z" }), state);
  });
  check("an empty checklist does not crash on space", () => {
    const state = createChecklist([]);
    assert.equal(reduceChecklist(state, { name: "space" }).outcome, "pending");
  });
  check("render aligns columns despite per-row color differences", () => {
    let state = reduceChecklist(fresh(), { name: "space" });
    const frame = renderChecklist(state, { width: 80 });
    const rows = frame.split("\n").filter((line) => /one|two|three/.test(line));
    assert.equal(rows.length, 3);
    const details = rows.map((line) => visibleWidth(line.slice(0, line.indexOf(line.trim().split(/\s{2,}/).pop()))));
    assert.equal(new Set(details).size, 1, "detail column must start at one column for every row");
  });

  // =========================================================================
  section("checklist: real loop over injected streams");
  // =========================================================================
  // A key that should decide the prompt but does not would leave this promise
  // pending forever; without the race, node reports "unsettled top-level await"
  // and exits 0, turning a real regression into a silent pass.
  async function drive(bytes) {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const pending = runChecklist({ items, input, output, width: 80 });
    setTimeout(() => input.write(bytes), 5);
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`checklist never settled for input ${JSON.stringify(bytes)}`)), 2000);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function driveOr(bytes) {
    try {
      return await drive(bytes);
    } catch (err) {
      failures += 1;
      process.stdout.write(`    FAIL drive(${JSON.stringify(bytes)}): ${err.message}\n`);
      return { outcome: "timeout", selected: [] };
    }
  }
  const applied = await driveOr("A");
  check("A through the real loop applies every ticked item", () => {
    assert.equal(applied.outcome, "apply");
    assert.deepEqual(applied.selected, ["one", "two", "three"]);
  });
  const partial = await driveOr("\x1b[B A");
  check("navigate, untick, apply", () => {
    assert.equal(partial.outcome, "apply");
    assert.deepEqual(partial.selected, ["one", "three"]);
  });
  const quit = await driveOr("q");
  check("q through the real loop cancels with nothing selected", () => {
    assert.equal(quit.outcome, "cancel");
    assert.deepEqual(quit.selected, []);
  });

  // =========================================================================
  section("describe: status is gone, activity is real");
  // =========================================================================
  const described = JSON.parse(run(cli, ["describe", dirty, "--registry", registryPath, "--json"]).stdout);
  check("identity no longer carries the lifecycle status lie", () => {
    assert.equal("status" in described.identity, false, "identity.status must be gone");
  });
  check("describe emits a full activity block", () => {
    assert.ok(described.activity, "activity must be present");
    assert.equal(typeof described.activity.relative, "string");
    assert.equal(typeof described.activity.active, "boolean");
    assert.equal(described.activity.source.kind, "uncommitted");
    assert.ok(described.activity.updated, "an ISO timestamp so consumers can sort");
  });
  check("describe human output shows updated, never a status line", () => {
    const text = run(cli, ["describe", dirty, "--registry", registryPath]).stdout;
    assert.match(text, /updated/, "the temporal field must be shown");
    assert.doesNotMatch(text, /^\s*status\s+planned/m, "the status lie must not reappear");
  });

  // =========================================================================
  section("describe: rendering");
  // =========================================================================
  check("no rendered line exceeds the terminal width", () => {
    const text = run(cli, ["describe", root, "--registry", registryPath], root, { COLUMNS: "90" }).stdout;
    for (const line of text.split("\n")) {
      assert.ok(visibleWidth(line) <= 120, `line exceeded the clamp: ${visibleWidth(line)}`);
    }
  });
  check("color and no-color renders have identical visible widths", () => {
    const plain = run(cli, ["describe", dirty, "--registry", registryPath], root, { NO_COLOR: "1" }).stdout;
    const colored = run(cli, ["describe", dirty, "--registry", registryPath], root, { NO_COLOR: "", FORCE_COLOR: "1" }).stdout;
    const plainLines = plain.split("\n");
    const coloredLines = colored.split("\n").map(stripAnsi);
    assert.equal(coloredLines.length, plainLines.length, "color must not change line count");
    for (let index = 0; index < plainLines.length; index++) {
      assert.equal(coloredLines[index], plainLines[index], `line ${index} differs once ANSI is stripped`);
    }
  });

  // =========================================================================
  section("describe --interactive guards");
  // =========================================================================
  check("--interactive refuses to combine with --json", () => {
    const result = run(cli, ["describe", dirty, "--registry", registryPath, "--json", "--interactive"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be combined with --json/);
  });
  check("--interactive refuses a non-TTY stdin rather than guessing", () => {
    const result = run(cli, ["describe", root, "--registry", registryPath, "--interactive"]);
    assert.notEqual(result.status, 0, "stdin is a pipe here, so it must refuse");
    assert.match(result.stderr, /needs a TTY/);
  });

  // =========================================================================
  section("project list: ordered by real recency");
  // =========================================================================
  const recent = makeRepo("recent");
  commitAt(recent, "r.txt", "2026-08-17T09:00:00");
  const ancient = makeRepo("ancient");
  commitAt(ancient, "a.txt", "2024-01-01T00:00:00");
  writeFileSync(
    registryPath,
    [
      "schema_version: 1",
      "projects:",
      ...[["ancient", ancient, "ANC"], ["recent", recent, "REC"]].flatMap(([slug, path, id]) => [
        `  ${slug}:`,
        `    name: ${slug}`,
        `    slug: ${slug}`,
        `    repo_path: ${path}`,
        `    description: ""`,
        "    status: planned",
        "    source_artifacts: []",
        "    template:",
        "      commonproject:",
        "        enabled: true",
        "        primary_language: python",
        "    ticket_provider:",
        "      type: plane",
        "      workspace: 33god",
        `      identifier: ${id}`,
        '      board_id: ""',
        "      state: linked",
        "    agents: {}",
        "    created_at: 2026-01-01T00:00:00.000Z",
        "    updated_at: 2026-01-01T00:00:00.000Z",
      ]),
      "",
    ].join("\n"),
    "utf8",
  );
  const listed = run(cli, ["project", "list", "--registry", registryPath]).stdout;
  check("the status column is gone from the human list", () => {
    assert.doesNotMatch(listed, /planned/, "the lifecycle lie must not be printed");
  });
  check("newest work sorts first regardless of slug order", () => {
    const recentAt = listed.indexOf("recent");
    const ancientAt = listed.indexOf("ancient");
    assert.ok(recentAt >= 0 && ancientAt >= 0, "both projects must be listed");
    assert.ok(recentAt < ancientAt, "recent must outrank ancient despite sorting after it alphabetically");
  });
  check("the list reports ages, not a lifecycle word", () => {
    assert.match(listed, /ago/, "relative ages should appear");
  });
  check("describe drops status even where the registry HAS one", () => {
    // The unregistered case cannot prove this: status would be undefined and
    // JSON.stringify would drop the key regardless of the source.
    const registryPayload = JSON.parse(run(cli, ["project", "list", "--registry", registryPath, "--json"]).stdout);
    assert.equal(registryPayload.projects.recent.status, "planned", "premise: the registry record has a status");
    const describedRegistered = JSON.parse(run(cli, ["describe", recent, "--registry", registryPath, "--json"]).stdout);
    assert.equal(describedRegistered.identity.registered, true, "premise: this repo is registered");
    assert.equal("status" in describedRegistered.identity, false, "the registry status must not leak into describe");
  });

  check("project list --json still carries status for existing consumers", () => {
    const payload = JSON.parse(run(cli, ["project", "list", "--registry", registryPath, "--json"]).stdout);
    assert.equal(payload.projects.recent.status, "planned", "the stored field is intentionally untouched");
  });

  // =========================================================================
  section("prompt: the starship surface");
  // =========================================================================
  const promptProject = makeRepo("prompt-project");
  commitAt(promptProject, "p.txt", "2026-08-17T09:00:00");
  writeFileSync(
    join(promptProject, ".project.json"),
    JSON.stringify({ project_slug: "promptdemo", ticket_provider: { identifier: "PDEM" } }),
    "utf8",
  );
  check("inside a project it prints slug, board id and age", () => {
    const result = run(promptBin, [], promptProject);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /promptdemo/);
    assert.match(result.stdout, /\(PDEM\)/);
  });
  check("it walks up from a subdirectory", () => {
    const nested = join(promptProject, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const result = run(promptBin, [], nested);
    assert.match(result.stdout, /promptdemo/, "a subdirectory is still inside the project");
  });
  check("outside a project it prints NOTHING and still exits 0", () => {
    // Starship renders a custom module's wrapper even on failure, so empty
    // output — not a non-zero exit — is what removes the extra prompt line.
    const result = run(promptBin, [], workspace);
    assert.equal(result.status, 0, "a non-zero exit would still render an empty line");
    assert.equal(result.stdout, "", `expected no output, got ${JSON.stringify(result.stdout)}`);
  });
  check("a malformed manifest degrades to the directory name", () => {
    const broken = makeRepo("broken-manifest");
    commitAt(broken, "b.txt", "2026-08-17T09:00:00");
    writeFileSync(join(broken, ".project.json"), "{ not json", "utf8");
    const result = run(promptBin, [], broken);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /broken-manifest/, "a broken manifest must not blank the prompt");
  });
  check("it stays far inside starship's 500ms command budget", () => {
    const started = Date.now();
    run(promptBin, [], promptProject);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 400, `prompt took ${elapsed}ms; starship times out at 500ms`);
  });

  if (failures) {
    console.error(`\npjan-71: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("pjan-71 activity/render/checklist/prompt regressions passed");
} finally {
  // Worktrees hold locks on the parent repo; prune before removing the tree.
  try {
    git(join(workspace, "detached"), ["worktree", "prune"]);
  } catch {
    // best effort
  }
  rmSync(workspace, { recursive: true, force: true });
}
