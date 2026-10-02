// PJAN-160: the release version must be free on npm AND in git.
//
// 'Bump version from the published one' used to ask npm alone. package.json
// said 1.5.0, npm had never seen 1.5.0, so the step shipped it "as-is" -- and
// `git tag v1.5.0` then failed on the v1.5.0 tag a human had already cut. Every
// green main push died at 'Commit the release' after that. The decision now
// lives in scripts/release-version.mjs; this suite pins it.
//
// Three layers, all offline:
//   1. decideReleaseVersion() with injected npm and git lookups -- the four
//      fixtures (free, npm only, tag only, both) plus the loop and the base.
//   2. The CLI with fake `npm` and `git` on PATH, pinning the exact commands:
//      tags are fetched explicitly and without --force, origin is read
//      directly, an unreadable origin stops the release, and `next` reaches
//      $GITHUB_OUTPUT.
//   3. The CLI in isolated, real Git repositories: a bare origin carrying
//      annotated and lightweight tags, and a `--depth 1 --no-tags` clone of it.
//      Every git call is the real binary; only npm is faked, with controlled
//      responses. Layer 2's fake git answers by subcommand and never looks at a
//      repository, so this is the layer that shows the script's git commands
//      actually find the tags it claims to.
// Plus a structural check that publish.yml's publish job calls the script,
// publishes before it commits and tags, and pushes main and an annotated tag in
// one atomic push (PJAN-161), while the ci job releases nothing (PJAN-163); and
// section 5, which runs that release step against real Git: a rejected main
// must leave no tag behind on origin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

// ---- 3. the CLI in real Git repositories, with only npm faked ---------------

// Hermetic git: no user or system config (and so none of the host's global
// hooks), no inherited GIT_DIR from a hook that happens to run this suite, a
// fixed identity for the fixture commits and tags, and never a prompt.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
Object.assign(GIT_ENV, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Release Fixture",
  GIT_AUTHOR_EMAIL: "release-fixture@example.invalid",
  GIT_COMMITTER_NAME: "Release Fixture",
  GIT_COMMITTER_EMAIL: "release-fixture@example.invalid",
});

/** Run real git; throw with its stderr on failure. */
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed (${result.status}) in ${cwd}:\n${result.stderr}`);
  return result.stdout.trim();
}

/** Real git's exit status alone, for a probe that is expected to fail. */
const gitStatus = (cwd, ...args) => spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).status;

// The only fake on PATH in this layer is npm.
const npmOnly = join(dir, "npm-only-bin");
mkdirSync(npmOnly);
copyFileSync(join(bin, "npm"), join(npmOnly, "npm"));
chmodSync(join(npmOnly, "npm"), 0o755);
const REAL_PATH = `${npmOnly}${delimiter}${process.env.PATH}`;

const pkgJson = (version) => `${JSON.stringify({ name: "@delorenj/pjangler", version })}\n`;
let fixtureCount = 0;

/**
 * A bare origin whose main is two commits deep: "release 1.4.6" carries every
 * tag in `tags` ({ name: "annotated" | "lightweight" }), and "start 1.5.0" on
 * top of it is what a depth-1 clone receives. The tagged commit therefore lies
 * outside any shallow clone, as an old release tag does on a CI checkout.
 */
function makeOrigin(tags) {
  fixtureCount += 1;
  const base = join(dir, `real-${fixtureCount}`);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  git(base, "init", "-q", "--bare", "--initial-branch=main", origin);
  git(seed, "init", "-q", "--initial-branch=main");
  writeFileSync(join(seed, "package.json"), pkgJson("1.4.6"));
  git(seed, "add", "package.json");
  git(seed, "commit", "-qm", "release 1.4.6");
  const tagged = git(seed, "rev-parse", "HEAD");
  for (const [name, kind] of Object.entries(tags)) {
    if (kind === "annotated") git(seed, "tag", "-a", name, "-m", name);
    else if (kind === "lightweight") git(seed, "tag", name);
    else throw new Error(`unknown tag kind ${kind}`);
  }
  writeFileSync(join(seed, "package.json"), pkgJson("1.5.0"));
  git(seed, "commit", "-qam", "start 1.5.0");
  git(seed, "push", "-q", origin, "main", "--tags");
  for (const [name, kind] of Object.entries(tags)) {
    assert.equal(git(origin, "cat-file", "-t", `refs/tags/${name}`), kind === "annotated" ? "tag" : "commit", `fixture ${name} must be ${kind} on origin`);
  }
  return { base, origin, tagged };
}

/**
 * A `--depth 1 --no-tags` clone of the fixture's origin. file:// rather than a
 * plain path, because git ignores --depth on a local-path clone. Asserts the
 * clone really is shallow, tagless and missing the tagged commit, so every
 * tag the script sees afterwards came from origin.
 */
function shallowClone({ base, origin, tagged }, name = "clone") {
  const clone = join(base, name);
  git(base, "clone", "-q", "--depth", "1", "--no-tags", pathToFileURL(origin).href, clone);
  assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "true", "the clone must be shallow");
  assert.equal(git(clone, "tag", "--list"), "", "the clone must start with no tags");
  assert.notEqual(gitStatus(clone, "cat-file", "-e", `${tagged}^{commit}`), 0, "the tagged commit must lie outside the shallow clone");
  return clone;
}

const NPM_LIVE = { versions: "1.4.5 1.4.6", latest: "1.4.6" };

/** The release script, run in `clone` with real git and the fake npm. */
function realCli(clone, { npm = NPM_LIVE, args = [] } = {}) {
  rmSync(LOG, { force: true });
  rmSync(OUTPUT, { force: true });
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...GIT_ENV,
      PATH: REAL_PATH,
      RELEASE_ROOT: clone,
      GITHUB_OUTPUT: OUTPUT,
      FAKE_LOG: LOG,
      FAKE_NPM_VERSIONS: npm.versions,
      FAKE_NPM_LATEST: npm.latest,
    },
  });
  const calls = existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n") : [];
  const output = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : null;
  return { ...run, calls, output };
}

/** The "<version> is taken: ..." lines, in the order the script skipped them. */
const takenLines = (stdout) => stdout.split("\n").filter((line) => / is taken: /.test(line));

test("real git: the layer runs the real git binary and fakes only npm", () => {
  assert.deepEqual(readdirSync(npmOnly), ["npm"]);
  const resolved = spawnSync("sh", ["-c", "command -v git; command -v npm"], { encoding: "utf8", env: { ...GIT_ENV, PATH: REAL_PATH } });
  const [gitPath, npmPath] = resolved.stdout.trim().split("\n");
  assert.ok(gitPath && !gitPath.startsWith(dir), `git must be the real binary, got ${gitPath}`);
  assert.equal(npmPath, join(npmOnly, "npm"));
});

test("real git: an annotated tag only origin has reserves its version (AC1)", () => {
  const clone = shallowClone(makeOrigin({ "v1.5.0": "annotated" }));
  const run = realCli(clone);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(takenLines(run.stdout), ["1.5.0 is taken: git tag v1.5.0 exists (origin)"]);
  assert.equal(run.output, "next=1.5.1\n");
  assert.ok(run.calls.includes("npm version 1.5.1 --no-git-tag-version"), run.calls.join("\n"));
});

test("real git: a lightweight tag only origin has reserves its version (AC1)", () => {
  const clone = shallowClone(makeOrigin({ "v1.5.0": "lightweight" }));
  const run = realCli(clone);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(takenLines(run.stdout), ["1.5.0 is taken: git tag v1.5.0 exists (origin)"]);
  assert.equal(run.output, "next=1.5.1\n");
});

// The live shape after PJAN-160's first fix: an annotated v1.5.0 cut by hand
// and a v1.5.1 that a failed release left behind. Both are on origin, neither
// is on npm, and neither is in a shallow, tagless checkout.
const LIVE_TAGS = { "v1.4.6": "annotated", "v1.5.0": "annotated", "v1.5.1": "lightweight" };

test("real git: a shallow, tagless clone still sees every one of origin's tags", () => {
  const fixture = makeOrigin(LIVE_TAGS);
  const clone = shallowClone(fixture);
  const run = realCli(clone);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(takenLines(run.stdout), [
    "1.5.0 is taken: git tag v1.5.0 exists (origin)",
    "1.5.1 is taken: git tag v1.5.1 exists (origin)",
  ]);
  assert.equal(run.output, "next=1.5.2\n");
  assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "true", "reading tags must not unshallow the checkout");
});

test("real git: a non-forced fetch leaves a conflicting local tag in place, and it still reserves its version", () => {
  const fixture = makeOrigin(LIVE_TAGS);
  const clone = shallowClone(fixture);
  // Local v1.5.0 is lightweight on the clone's HEAD; origin's is annotated on
  // an older commit. Only a forced fetch would replace it.
  git(clone, "tag", "v1.5.0");
  const before = git(clone, "rev-parse", "refs/tags/v1.5.0");
  const run = realCli(clone);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^warning: git fetch --tags origin failed/m, "the clobber refusal must be reported, not hidden");
  assert.equal(git(clone, "rev-parse", "refs/tags/v1.5.0"), before, "the local tag must not be moved");
  assert.equal(git(clone, "cat-file", "-t", "refs/tags/v1.5.0"), "commit", "the local tag must stay lightweight, not become origin's");
  // However much of the fetch git kept, origin's v1.5.1 must still count: a
  // rejected fetch can leave it unfetched, and only ls-remote then sees it.
  assert.deepEqual(takenLines(run.stdout), [
    "1.5.0 is taken: git tag v1.5.0 exists (origin)",
    "1.5.1 is taken: git tag v1.5.1 exists (origin)",
  ]);
  assert.equal(run.output, "next=1.5.2\n");
});

test("real git: a tag only the local clone has reserves its version", () => {
  const fixture = makeOrigin(LIVE_TAGS);
  const clone = shallowClone(fixture);
  git(clone, "tag", "v1.5.2");
  const run = realCli(clone);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(takenLines(run.stdout), [
    "1.5.0 is taken: git tag v1.5.0 exists (origin)",
    "1.5.1 is taken: git tag v1.5.1 exists (origin)",
    "1.5.2 is taken: git tag v1.5.2 exists (local)",
  ]);
  assert.equal(run.output, "next=1.5.3\n");
  assert.equal(git(fixture.origin, "tag", "--list", "v1.5.2"), "", "deciding must never push a tag");
});

test("real git: consecutive collisions across origin, local and npm skip to the first free version", () => {
  const fixture = makeOrigin({ ...LIVE_TAGS, "v1.5.3": "annotated" });
  const clone = shallowClone(fixture);
  git(clone, "tag", "-a", "v1.5.2", "-m", "v1.5.2");
  // 1.5.4 is on npm under a dist-tag other than latest, so `latest` stays low
  // and the loop, not the base, has to walk past it.
  const run = realCli(clone, { npm: { versions: "1.4.5 1.4.6 1.5.4", latest: "1.4.6" } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(takenLines(run.stdout), [
    "1.5.0 is taken: git tag v1.5.0 exists (origin)",
    "1.5.1 is taken: git tag v1.5.1 exists (origin)",
    "1.5.2 is taken: git tag v1.5.2 exists (local)",
    "1.5.3 is taken: git tag v1.5.3 exists (origin)",
    "1.5.4 is taken: published on npm",
  ]);
  assert.equal(run.output, "next=1.5.5\n");
  assert.ok(run.calls.includes("npm version 1.5.5 --no-git-tag-version"), run.calls.join("\n"));
});

test("real git: with origin unreachable the release stops and writes no output", () => {
  const fixture = makeOrigin(LIVE_TAGS);
  const clone = shallowClone(fixture);
  git(clone, "tag", "v1.5.0");
  git(clone, "remote", "set-url", "origin", pathToFileURL(join(fixture.base, "gone.git")).href);
  const pkgBefore = readFileSync(join(clone, "package.json"), "utf8");
  const run = realCli(clone);
  assert.notEqual(run.status, 0, "unknown taken-ness must not ship, even with local tags in hand");
  assert.match(run.stderr, /git ls-remote --tags origin failed; cannot tell which versions are taken/);
  assert.equal(run.output, null, "no next may reach $GITHUB_OUTPUT");
  assert.ok(!run.calls.some((c) => c.startsWith("npm version")), run.calls.join("\n"));
  assert.equal(readFileSync(join(clone, "package.json"), "utf8"), pkgBefore, "package.json must be untouched");
});

// ---- 4. the workflow uses it, and publishes before it tags ------------------

test("publish.yml bumps with the script, publishes, and only then commits and tags", () => {
  const workflow = YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8"));
  // PJAN-163: the release lives in the publish job, on a GitHub-hosted runner
  // where npm OIDC works, after the self-hosted ci job has tested the commit.
  assert.equal(workflow.jobs.publish?.needs, "ci", "the publish job runs only after a green ci");
  const steps = workflow.jobs.publish.steps;
  const bump = steps.findIndex((s) => s.id === "bump");
  const commit = steps.findIndex((s) => s.name === "Commit the release");
  // Matched by the command, not its flags, so adding or dropping a flag does
  // not hide the step from this check.
  const publishers = steps.flatMap((s, i) => (/^\s*npm publish\b/m.test(String(s.run ?? "")) ? [i] : []));
  assert.equal(publishers.length, 1, "exactly one step runs npm publish");
  const [publish] = publishers;
  assert.notEqual(bump, -1, "the bump step must keep id: bump");
  assert.notEqual(commit, -1, "the release commit step must exist");
  assert.equal(steps[bump].run, "node scripts/release-version.mjs");
  assert.equal(steps[bump].if, "github.ref == 'refs/heads/main'");
  assert.ok(bump < publish, "the bump must come before the publish that reads it");
  assert.ok(publish < commit, "publish must come before the release commit and tag");
  assert.equal(steps[publish].run, "npm publish --provenance", "OIDC trusted publishing, with provenance (PJAN-163)");

  // The ci job releases nothing: no bump, no publish, no commit, tag or push.
  for (const step of workflow.jobs.ci.steps) {
    const run = String(step.run ?? "");
    assert.ok(step.id !== "bump" && step.id !== "publish" && step.name !== "Commit the release", `ci must not carry a release step: ${step.name ?? run}`);
    assert.doesNotMatch(run, /release-version\.mjs|\bnpm\s+publish\b|\bgit\s+(?:commit|push)\b|\bgit\s+tag\s+-a\b/, `ci must not release: ${step.name ?? run}`);
  }

  // Nothing between the bump and a successful publish may write to git: a
  // commit, tag or push there outlives a failed publish and burns its version.
  const gitWriters = steps.flatMap((s, i) => (/\bgit\s+(?:commit|push)\b|\bgit\s+tag\s+-a\b/.test(String(s.run ?? "")) ? [i] : []));
  assert.deepEqual(gitWriters, [commit], "only the release step commits, tags or pushes");

  // The release step runs only when the publish succeeded, by name, so a
  // continue-on-error publish cannot slip a failed one through.
  assert.equal(steps[publish].id, "publish");
  assert.equal(steps[commit].if, "github.ref == 'refs/heads/main' && steps.publish.outcome == 'success'");
  assert.ok(!steps[commit]["continue-on-error"], "a failed release commit must fail the run");

  const commitRun = steps[commit].run;
  assert.match(commitRun, /^git add package\.json package-lock\.json \.coverage-floor\.json$/m,
    "the release commit stages the bump and the coverage-floor raise, explicitly");
  assert.match(commitRun, /git tag -a "v\$\{\{ steps\.bump\.outputs\.next \}\}" -m "v\$\{\{ steps\.bump\.outputs\.next \}\}"/,
    "the release tag is annotated");
  // PJAN-161: main and the tag in one atomic push. --follow-tags pushed each
  // ref on its own, so a rejected main still landed the tag (section 5).
  assert.match(commitRun, /^git push --atomic origin HEAD:refs\/heads\/main "refs\/tags\/v\$\{\{ steps\.bump\.outputs\.next \}\}"$/m,
    "main and the release tag are pushed together, atomically");
  // The script's commands without its comments, which talk about --follow-tags.
  const commitCode = commitRun.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.equal(commitCode.match(/\bgit\s+push\b/g)?.length, 1, "the release step pushes exactly once");
  assert.doesNotMatch(commitCode, /--follow-tags/, "--follow-tags pushes each ref on its own");
  assert.doesNotMatch(commitRun, /git tag (-d|-f|--delete|--force)/, "an existing tag is never moved or deleted");
  assert.doesNotMatch(commitRun, /--force|\bpush\s+-f\b/, "the release push never forces");
});

// ---- 5. the release push, run against real Git (PJAN-161) ------------------

// publish.yml's 'Commit the release' script, verbatim except for the bump's
// output, run by bash in a real clone with the release bump in its tree. Only
// origin is local: a bare repository reached over file://.
function releaseStepScript(version) {
  const workflow = YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8"));
  const step = workflow.jobs.publish.steps.find((s) => s.name === "Commit the release");
  assert.ok(step, "the release commit step must exist");
  return step.run.replaceAll("${{ steps.bump.outputs.next }}", version);
}

/** The three files the release step stages, at `version`. */
function writeReleaseFiles(cwd, version, floor) {
  writeFileSync(join(cwd, "package.json"), pkgJson(version));
  writeFileSync(join(cwd, "package-lock.json"), `${JSON.stringify({ name: "@delorenj/pjangler", version, lockfileVersion: 3 })}\n`);
  writeFileSync(join(cwd, ".coverage-floor.json"), `${JSON.stringify({ lines: floor })}\n`);
}

/** A bare origin whose main is at 1.5.1, and a full CI clone of it with the bump to 1.5.2 in its tree. */
function releaseFixture() {
  fixtureCount += 1;
  const base = join(dir, `push-${fixtureCount}`);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  git(base, "init", "-q", "--bare", "--initial-branch=main", origin);
  git(seed, "init", "-q", "--initial-branch=main");
  writeReleaseFiles(seed, "1.5.1", 80);
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "chore(release): v1.5.1 [skip ci]");
  git(seed, "push", "-q", origin, "main");
  const ci = join(base, "ci");
  git(base, "clone", "-q", pathToFileURL(origin).href, ci);
  writeReleaseFiles(ci, "1.5.2", 81);
  return { base, origin, ci };
}

/** Someone else lands a commit on origin's main after the CI checkout. */
function moveMain({ base, origin }) {
  const other = join(base, "other");
  git(base, "clone", "-q", pathToFileURL(origin).href, other);
  writeFileSync(join(other, "README.md"), "moved\n");
  git(other, "add", "README.md");
  git(other, "commit", "-qm", "docs: land first");
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

const runReleaseStep = (ci, script) => spawnSync("bash", ["-c", script], { cwd: ci, env: GIT_ENV, encoding: "utf8" });
const originTag = (origin, name) => spawnSync("git", ["rev-parse", "--verify", "-q", `refs/tags/${name}`], { cwd: origin, env: GIT_ENV, encoding: "utf8" });

test("release push: on a current main, the release commit and the annotated tag land together", () => {
  const fixture = releaseFixture();
  const run = runReleaseStep(fixture.ci, releaseStepScript("1.5.2"));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const head = git(fixture.ci, "rev-parse", "HEAD");
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/main"), head, "origin's main is the release commit");
  assert.equal(git(fixture.origin, "log", "-1", "--format=%s", "main"), "chore(release): v1.5.2 [skip ci]");
  assert.equal(git(fixture.origin, "cat-file", "-t", "refs/tags/v1.5.2"), "tag", "the pushed tag is annotated");
  assert.equal(git(fixture.origin, "rev-parse", "refs/tags/v1.5.2^{commit}"), head, "the tag names the release commit");
  assert.deepEqual(
    git(fixture.origin, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").split("\n").sort(),
    [".coverage-floor.json", "package-lock.json", "package.json"],
    "the release commit carries exactly the bump and the coverage floor",
  );
});

test("release push: when main moved, the push is rejected and origin gets no tag", () => {
  const fixture = releaseFixture();
  const moved = moveMain(fixture);
  const run = runReleaseStep(fixture.ci, releaseStepScript("1.5.2"));
  assert.notEqual(run.status, 0, "a release push that loses to a moved main must fail the step");
  assert.match(run.stderr, /atomic push failed|rejected/);
  assert.equal(git(fixture.origin, "rev-parse", "refs/heads/main"), moved, "origin's main is untouched");
  assert.notEqual(originTag(fixture.origin, "v1.5.2").status, 0, "no v1.5.2 tag on origin for a commit main never got");
  assert.equal(git(fixture.ci, "cat-file", "-t", "refs/tags/v1.5.2"), "tag", "the tag stays local, never moved or deleted");
});

test("release push: control -- the old --follow-tags push leaks the tag onto origin", () => {
  // Pins why the push is atomic: with the pre-PJAN-161 line and the same moved
  // main, git lands the tag and rejects only main.
  const fixture = releaseFixture();
  moveMain(fixture);
  const script = releaseStepScript("1.5.2").replace(/^git push .*$/m, "git push origin HEAD:main --follow-tags");
  assert.match(script, /^git push origin HEAD:main --follow-tags$/m, "the control must replace the release push");
  const run = runReleaseStep(fixture.ci, script);
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.equal(originTag(fixture.origin, "v1.5.2").status, 0, "the non-atomic push left the tag on origin");
});

console.log("");
rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`pjan-160 release version regressions: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("pjan-160 release version regressions passed");
