// PJAN-160: the release version must be free on npm AND in git.
//
// 'Bump version from the published one' used to ask npm alone. package.json
// said 1.5.0, npm had never seen 1.5.0, so the step shipped it "as-is" -- and
// `git tag v1.5.0` then failed on the v1.5.0 tag a human had already cut. Every
// green main push died at 'Commit the release' after that. The decision now
// lives in scripts/release-version.mjs; this suite pins it.
//
// Two layers, both offline:
//   1. decideReleaseVersion() with injected npm and git lookups -- the four
//      fixtures (free, npm only, tag only, both) plus the loop and the base.
//   2. The CLI with fake `npm` and `git` on PATH, proving the wiring: tags are
//      fetched explicitly, origin is read directly, an unreadable origin stops
//      the release, and `next` reaches $GITHUB_OUTPUT.
// Plus a structural check that publish.yml still calls the script and tags in
// a form --follow-tags actually pushes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import YAML from "yaml";
import { decideReleaseVersion, higherVersion, nextPatch } from "../scripts/release-version.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "release-version.mjs");
const dir = mkdtempSync(join(tmpdir(), "pj-release-version-"));
let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/** Injected lookups over fixed sets, recording what was asked. */
function world({ npm = [], tags = {}, latest = "0.0.0" }) {
  const asked = { npm: [], git: [], latest: 0 };
  return {
    asked,
    onNpm: (version) => {
      asked.npm.push(version);
      return npm.includes(version);
    },
    gitTag: (version) => {
      asked.git.push(version);
      return tags[`v${version}`] ?? null;
    },
    latestPublished: () => {
      asked.latest += 1;
      return latest;
    },
  };
}

// ---- 1. the decision ------------------------------------------------------

test("fixture: free on npm and git ships package.json's version as-is", () => {
  const w = world({ latest: "1.4.6" });
  const decision = decideReleaseVersion({ localVersion: "1.5.0", ...w });
  assert.deepEqual(decision, { next: "1.5.0", bumped: false, skipped: [] });
  assert.equal(w.asked.latest, 0, "a free version needs no npm latest lookup");
});

test("fixture: on npm only bumps past it", () => {
  const w = world({ npm: ["1.4.6", "1.5.0"], latest: "1.5.0" });
  const decision = decideReleaseVersion({ localVersion: "1.5.0", ...w });
  assert.equal(decision.next, "1.5.1");
  assert.equal(decision.bumped, true);
  assert.deepEqual(decision.skipped, [{ version: "1.5.0", reasons: ["published on npm"] }]);
});

test("fixture: git tag only (the PJAN-160 case) bumps past it", () => {
  // The live state on cca1e3f: package.json 1.5.0, npm latest 1.4.6, and an
  // annotated v1.5.0 on origin that npm never saw.
  const w = world({ npm: ["1.4.6"], tags: { "v1.5.0": "origin" }, latest: "1.4.6" });
  const decision = decideReleaseVersion({ localVersion: "1.5.0", ...w });
  assert.equal(decision.next, "1.5.1", "1.5.0 is taken by its tag even though npm never saw it");
  assert.equal(decision.bumped, true);
  assert.deepEqual(decision.skipped, [{ version: "1.5.0", reasons: ["git tag v1.5.0 exists (origin)"] }]);
});

test("fixture: on npm and tagged bumps past it, naming both reasons", () => {
  const w = world({ npm: ["1.5.0"], tags: { "v1.5.0": "origin" }, latest: "1.5.0" });
  const decision = decideReleaseVersion({ localVersion: "1.5.0", ...w });
  assert.equal(decision.next, "1.5.1");
  assert.deepEqual(decision.skipped, [
    { version: "1.5.0", reasons: ["git tag v1.5.0 exists (origin)", "published on npm"] },
  ]);
});

test("a local-only tag counts as taken too", () => {
  const w = world({ tags: { "v1.5.0": "local" }, latest: "1.4.6" });
  assert.equal(decideReleaseVersion({ localVersion: "1.5.0", ...w }).next, "1.5.1");
});

test("keeps bumping until the candidate is free on BOTH npm and git", () => {
  const w = world({
    npm: ["1.5.0", "1.5.2"],
    tags: { "v1.5.0": "origin", "v1.5.1": "origin", "v1.5.3": "local" },
    latest: "1.5.2",
  });
  const decision = decideReleaseVersion({ localVersion: "1.5.0", ...w });
  // Base is max(npm latest 1.5.2, local 1.5.0) = 1.5.2, so the first candidate
  // is 1.5.3 (tagged locally), then 1.5.4.
  assert.equal(decision.next, "1.5.4");
  assert.deepEqual(
    decision.skipped.map((s) => s.version),
    ["1.5.0", "1.5.3"],
  );
});

test("a candidate taken only by a tag after the base is skipped", () => {
  const w = world({ npm: ["1.5.0"], tags: { "v1.5.1": "origin" }, latest: "1.5.0" });
  assert.equal(decideReleaseVersion({ localVersion: "1.5.0", ...w }).next, "1.5.2");
});

test("the base is the higher of npm latest and package.json (sort -V semantics)", () => {
  const ahead = world({ npm: ["1.4.6"], tags: { "v1.4.6": "origin" }, latest: "1.10.0" });
  assert.equal(decideReleaseVersion({ localVersion: "1.4.6", ...ahead }).next, "1.10.1");
  const behind = world({ npm: ["1.9.0"], latest: "1.9.0" });
  assert.equal(decideReleaseVersion({ localVersion: "1.9.0", ...behind }).next, "1.9.1");
  assert.equal(higherVersion("1.10.0", "1.9.9"), "1.10.0", "comparison is numeric, not lexical");
  assert.equal(nextPatch("1.5.9"), "1.5.10");
});

test("never returns a version that any lookup reports taken", () => {
  for (let seed = 0; seed < 50; seed += 1) {
    const npm = [];
    const tags = {};
    for (let patch = 0; patch < 12; patch += 1) {
      if ((seed * 7 + patch * 3) % 5 === 0) npm.push(`2.0.${patch}`);
      if ((seed * 5 + patch * 11) % 4 === 0) tags[`v2.0.${patch}`] = "origin";
    }
    const w = world({ npm, tags, latest: npm.at(-1) ?? "0.0.0" });
    const { next } = decideReleaseVersion({ localVersion: "2.0.0", ...w });
    assert.ok(!npm.includes(next) && !tags[`v${next}`], `seed ${seed} chose taken ${next}`);
  }
});

test("lookups that call everything taken fail loudly instead of looping", () => {
  assert.throws(
    () => decideReleaseVersion({ localVersion: "1.0.0", onNpm: () => true, gitTag: () => "origin", latestPublished: () => "1.0.0" }),
    /no free version/,
  );
});

test("a malformed package.json version is rejected", () => {
  assert.throws(() => decideReleaseVersion({ localVersion: "1.5", ...world({}) }), /not a plain X\.Y\.Z/);
});

// ---- 2. the CLI, with fake npm and git on PATH -----------------------------

const bin = join(dir, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "git"),
  `#!/bin/sh
printf 'git %s\\n' "$*" >> "$FAKE_LOG"
case "$1" in
  fetch)
    [ "\${FAKE_GIT_FETCH_STATUS:-0}" = 0 ] || { echo "! [rejected] v1.5.0 -> v1.5.0 (would clobber existing tag)" >&2; exit 1; }
    exit 0 ;;
  tag)
    for t in $FAKE_GIT_LOCAL_TAGS; do printf '%s\\n' "$t"; done
    exit 0 ;;
  ls-remote)
    [ "\${FAKE_GIT_LSREMOTE_STATUS:-0}" = 0 ] || { echo "fatal: unable to access origin" >&2; exit 128; }
    for t in $FAKE_GIT_REMOTE_TAGS; do printf '5189dc75d3a8e7a2a120ec71abf46d1a25386e37\\trefs/tags/%s\\n' "$t"; done
    exit 0 ;;
esac
echo "fake git: unexpected $*" >&2
exit 99
`,
);
writeFileSync(
  join(bin, "npm"),
  `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$FAKE_LOG"
case "$1" in
  view)
    case "$2" in
      ?*@*)
        v="\${2##*@}"
        for p in $FAKE_NPM_VERSIONS; do [ "$p" = "$v" ] && { echo "$v"; exit 0; }; done
        echo "npm error code E404" >&2; exit 1 ;;
      *)
        [ -n "$FAKE_NPM_LATEST" ] && { echo "$FAKE_NPM_LATEST"; exit 0; }
        echo "npm error code E404" >&2; exit 1 ;;
    esac ;;
  version) exit 0 ;;
esac
echo "fake npm: unexpected $*" >&2
exit 99
`,
);
chmodSync(join(bin, "git"), 0o755);
chmodSync(join(bin, "npm"), 0o755);

const pkgRoot = join(dir, "pkg");
mkdirSync(pkgRoot);
writeFileSync(join(pkgRoot, "package.json"), '{"name":"@delorenj/pjangler","version":"1.5.0"}\n');
const LOG = join(dir, "calls.log");
const OUTPUT = join(dir, "github-output");

function cli({ args = [], env = {} } = {}) {
  rmSync(LOG, { force: true });
  rmSync(OUTPUT, { force: true });
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      RELEASE_ROOT: pkgRoot,
      GITHUB_OUTPUT: OUTPUT,
      FAKE_LOG: LOG,
      FAKE_GIT_LOCAL_TAGS: "",
      FAKE_GIT_REMOTE_TAGS: "",
      FAKE_NPM_VERSIONS: "",
      FAKE_NPM_LATEST: "",
      ...env,
    },
  });
  const calls = existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n") : [];
  const output = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : null;
  return { ...run, calls, output };
}

const LIVE = { FAKE_NPM_VERSIONS: "1.4.5 1.4.6", FAKE_NPM_LATEST: "1.4.6", FAKE_GIT_REMOTE_TAGS: "v1.4.1 v1.4.2 v1.5.0" };

test("CLI, tag only (the cca1e3f state): bumps to 1.5.1 and writes next", () => {
  const run = cli({ env: { ...LIVE, FAKE_GIT_LOCAL_TAGS: "v1.4.1 v1.4.2 v1.5.0" } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.output, "next=1.5.1\n");
  assert.match(run.stdout, /^1\.5\.0 is taken: git tag v1\.5\.0 exists \(origin\)$/m);
  assert.match(run.stdout, /^1\.5\.0 is taken; bumped to 1\.5\.1$/m, "the bump message is unchanged");
  assert.ok(run.calls.includes("npm version 1.5.1 --no-git-tag-version"), run.calls.join("\n"));
});

test("CLI fetches tags explicitly, without --force, before reading origin", () => {
  const run = cli({ env: LIVE });
  const fetch = run.calls.findIndex((c) => c.startsWith("git fetch"));
  const lsRemote = run.calls.findIndex((c) => c.startsWith("git ls-remote"));
  assert.notEqual(fetch, -1, "tags must be fetched explicitly");
  assert.ok(fetch < lsRemote, "fetch must come first");
  assert.equal(run.calls[fetch], "git fetch --tags --quiet origin");
  assert.equal(run.calls[lsRemote], "git ls-remote --tags --refs origin refs/tags/v*");
  assert.ok(!run.calls.some((c) => /--force|\btag -d\b|\bpush\b/.test(c)), "an existing tag is never moved or deleted");
});

test("CLI, free: ships as-is with the unchanged message and no npm version", () => {
  const run = cli({ env: { FAKE_NPM_VERSIONS: "1.4.6", FAKE_NPM_LATEST: "1.4.6", FAKE_GIT_REMOTE_TAGS: "v1.4.2" } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.output, "next=1.5.0\n");
  assert.match(run.stdout, /^1\.5\.0 is unpublished; shipping it as-is$/m);
  assert.ok(!run.calls.some((c) => c.startsWith("npm version")), run.calls.join("\n"));
});

test("CLI, on npm only: bumps from npm's latest", () => {
  const run = cli({ env: { FAKE_NPM_VERSIONS: "1.5.0", FAKE_NPM_LATEST: "1.5.0" } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.output, "next=1.5.1\n");
  assert.match(run.stdout, /^1\.5\.0 is taken: published on npm$/m);
});

test("CLI, both: a local-only tag on the next patch is skipped as well", () => {
  const run = cli({ env: { FAKE_NPM_VERSIONS: "1.5.0", FAKE_NPM_LATEST: "1.5.0", FAKE_GIT_REMOTE_TAGS: "v1.5.0", FAKE_GIT_LOCAL_TAGS: "v1.5.1" } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.output, "next=1.5.2\n");
  assert.match(run.stdout, /^1\.5\.1 is taken: git tag v1\.5\.1 exists \(local\)$/m);
});

test("CLI: a failed fetch is survivable, origin is still read directly", () => {
  const run = cli({ env: { ...LIVE, FAKE_GIT_FETCH_STATUS: "1" } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /warning: git fetch --tags origin failed/);
  assert.equal(run.output, "next=1.5.1\n", "origin's v1.5.0 must still count");
});

test("CLI: an unreadable origin stops the release instead of guessing", () => {
  const run = cli({ env: { ...LIVE, FAKE_GIT_LSREMOTE_STATUS: "128" } });
  assert.notEqual(run.status, 0, "unknown taken-ness must not ship");
  assert.match(run.stderr, /cannot tell which versions are taken/);
  assert.equal(run.output, null, "no next may reach $GITHUB_OUTPUT");
  assert.ok(!run.calls.some((c) => c.startsWith("npm version")), "package.json must be untouched");
});

test("CLI --dry-run decides but changes nothing", () => {
  const run = cli({ args: ["--dry-run"], env: LIVE });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /next=1\.5\.1 \(dry run/);
  assert.equal(run.output, null);
  assert.ok(!run.calls.some((c) => c.startsWith("npm version")));
});

// ---- 3. the workflow still uses it ------------------------------------------

test("publish.yml runs the script as the bump step and tags so --follow-tags pushes", () => {
  const workflow = YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8"));
  const steps = workflow.jobs.ci.steps;
  const bump = steps.findIndex((s) => s.id === "bump");
  const commit = steps.findIndex((s) => s.name === "Commit the release");
  const publish = steps.findIndex((s) => s.run === "npm publish --provenance");
  assert.notEqual(bump, -1, "the bump step must keep id: bump");
  assert.equal(steps[bump].run, "node scripts/release-version.mjs");
  assert.equal(steps[bump].if, "github.ref == 'refs/heads/main'");
  assert.ok(bump < commit && commit < publish, "bump, then commit and tag, then publish");
  const commitRun = steps[commit].run;
  assert.match(commitRun, /git tag -a "v\$\{\{ steps\.bump\.outputs\.next \}\}" -m "v\$\{\{ steps\.bump\.outputs\.next \}\}"/,
    "a lightweight tag is never pushed by --follow-tags");
  assert.match(commitRun, /git push origin HEAD:main --follow-tags/);
  assert.doesNotMatch(commitRun, /git tag (-d|-f|--delete|--force)/, "an existing tag is never moved or deleted");
});

console.log("");
rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`pjan-160 release version regressions: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("pjan-160 release version regressions passed");
