// PJAN-189: every version CI publishes ends up tagged, and pushing main is the
// only way to publish.
//
// Two runs on 2026-10-28 published to npm and then lost the release push to a
// main that had moved under them (1.5.21 in run 40717543511, 1.5.23 in run
// 40728677950): the atomic push of main and the tag was rejected, and npm kept
// a version with no tag and no release commit. A third run, for the v1.5.20
// tag that `mise run release` pushed, published beside main's run and failed.
//
// Everything below runs real git against a local bare origin reached over
// file://. Only npm's registry answers are faked; `npm version` is the real
// npm. The fixture git reads no user or system config (so none of the host's
// global hooks or excludes), and discovery stops at this suite's scratch root,
// because TMPDIR can sit inside another work tree on the operator's machine.
//
//   1. scripts/release-commit.mjs, the 'Commit the release' step: main still at
//      the built commit; main moved before the push; main moved by a commit
//      that rewrites package.json, the lock and the coverage floor; main moved
//      DURING the push; a transient failure; an unreachable origin; a version
//      shipped as-is with nothing to commit; and the guards. Plus the control:
//      the pre-PJAN-189 inline step, run against the same moved main, strands
//      the version exactly as the two incidents did.
//   2. The re-run: a run whose publish succeeded and whose release push failed,
//      re-run: release-version.mjs answers action=tag and the version npm
//      already has gets its tag, instead of a second version of the same code.
//   3. .mise/scripts/release.sh, now a thin wrapper that pushes main: it never
//      tags, never publishes and never forces, and a minor bump composes with
//      CI's bump.
//   4. publish.yml's shape for AC2/AC3: no v* tag trigger, publish on main
//      only, and one npm-publish section across every ref.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { BOT, RELEASE_FILES, releaseSubject } from "../scripts/release-commit.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RELEASE_COMMIT = join(ROOT, "scripts", "release-commit.mjs");
const RELEASE_VERSION = join(ROOT, "scripts", "release-version.mjs");
const RELEASE_SH = join(ROOT, ".mise", "scripts", "release.sh");
const dir = mkdtempSync(join(tmpdir(), "pj-release-push-"));
let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${err.message.split("\n").join("\n        ")}`);
  }
}

// ---- hermetic git and a registry-only fake npm ------------------------------

const emptyXdg = join(dir, "xdg-empty");
mkdirSync(emptyXdg);
// The allowlist copies no GIT_* (a hook's GIT_DIR) and no npm_* (what `npm
// test` injects) from the operator, so neither needs filtering here.
const GIT_ENV = hermeticEnv();
Object.assign(GIT_ENV, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: dir,
  XDG_CONFIG_HOME: emptyXdg,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Release Fixture",
  GIT_AUTHOR_EMAIL: "release-fixture@example.invalid",
  GIT_COMMITTER_NAME: "Release Fixture",
  GIT_COMMITTER_EMAIL: "release-fixture@example.invalid",
  npm_config_cache: join(dir, "npm-cache"),
  npm_config_update_notifier: "false",
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed (${result.status}) in ${cwd}:\n${result.stderr}`);
  return result.stdout.trim();
}
const gitOk = (cwd, ...args) => spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).status === 0;

const realNpm = spawnSync("sh", ["-c", "command -v npm"], { encoding: "utf8", env: hermeticEnv() }).stdout.trim();
assert.ok(realNpm, "npm must be on PATH: `npm version` runs for real here");

// The registry is the one thing faked: `npm view` answers from FAKE_NPM_LATEST
// and FAKE_NPM_PUBLISHED ("version=gitHead ..."), in npm 11's shapes (one
// object for one match, an array for several). Every other npm command is the
// real npm, so `npm version` really rewrites package.json and the lock.
const fakeBin = join(dir, "fake-bin");
mkdirSync(fakeBin);
const NPM_LOG = join(dir, "npm.log");
writeFileSync(
  join(fakeBin, "npm"),
  `#!/bin/sh
printf 'npm %s\\n' "$*" >> "${NPM_LOG}"
if [ "$1" = view ]; then
  case "$2" in
    *'@>=0.0.0')
      set -- $FAKE_NPM_PUBLISHED
      [ $# -gt 0 ] || { echo "npm error code E404" >&2; exit 1; }
      [ $# -gt 1 ] && printf '['
      sep=""
      for pair in "$@"; do printf '%s{"version":"%s","gitHead":"%s"}' "$sep" "\${pair%%=*}" "\${pair#*=}"; sep=","; done
      [ $# -gt 1 ] && printf ']'
      printf '\\n'; exit 0 ;;
    ?*@*)
      v="\${2##*@}"
      for pair in $FAKE_NPM_PUBLISHED; do [ "\${pair%%=*}" = "$v" ] && { echo "$v"; exit 0; }; done
      echo "npm error code E404" >&2; exit 1 ;;
    *)
      [ -n "$FAKE_NPM_LATEST" ] && { echo "$FAKE_NPM_LATEST"; exit 0; }
      echo "npm error code E404" >&2; exit 1 ;;
  esac
fi
[ "$1" = publish ] && { echo "fake npm: nothing in this suite may publish" >&2; exit 97; }
exec "${realNpm}" "$@"
`,
);
chmodSync(join(fakeBin, "npm"), 0o755);
const PATH = `${fakeBin}${delimiter}${process.env.PATH}`;
const npmCalls = () => (existsSync(NPM_LOG) ? readFileSync(NPM_LOG, "utf8").trim().split("\n").filter(Boolean) : []);

// ---- fixtures ---------------------------------------------------------------

const NAME = "@delorenj/pjangler";
const pkgJson = (version, extra = {}) => `${JSON.stringify({ name: NAME, version, type: "module", ...extra }, null, 2)}\n`;
const lockJson = (version, extra = {}) =>
  `${JSON.stringify({ name: NAME, version, lockfileVersion: 3, requires: true, packages: { "": { name: NAME, version, ...extra } } }, null, 2)}\n`;
const floorJson = (lines) => `${JSON.stringify({ lines, statements: lines, functions: 70, branches: 75 }, null, 2)}\n`;

function writeRelease(cwd, version, floor) {
  writeFileSync(join(cwd, "package.json"), pkgJson(version));
  writeFileSync(join(cwd, "package-lock.json"), lockJson(version));
  writeFileSync(join(cwd, ".coverage-floor.json"), floorJson(floor));
}

let fixtureCount = 0;
const clone = (base, origin, name) => {
  git(base, "clone", "-q", pathToFileURL(origin).href, join(base, name));
  return join(base, name);
};

/**
 * A bare origin whose main is the v1.5.24 release commit (annotated tag on
 * origin), a developer commit B on top, and a CI clone checked out at B with
 * the bump to 1.5.25 and a raised floor in its tree: the publish job's state
 * right after 'Publish to npm'.
 */
function publishedRun() {
  fixtureCount += 1;
  const base = join(dir, `run-${fixtureCount}`);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  git(base, "init", "-q", "--bare", "--initial-branch=main", origin);
  // A default bare repository accepts forced, non-fast-forward updates, so a
  // forced push would succeed here and replace main. Every "main is untouched"
  // assertion below therefore also proves the script never forces.
  assert.equal(gitOk(origin, "config", "receive.denyNonFastForwards"), false, "origin must accept a forced push, so one would show");
  git(seed, "init", "-q", "--initial-branch=main");
  writeRelease(seed, "1.5.24", 80);
  writeFileSync(join(seed, "README.md"), "pjangler\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "chore(release): v1.5.24 [skip ci]");
  git(seed, "tag", "-a", "v1.5.24", "-m", "v1.5.24");
  writeFileSync(join(seed, "feature.txt"), "the change this run builds\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "feat: PJAN-189 the commit this run builds");
  git(seed, "push", "-q", origin, "main", "--follow-tags");
  const built = git(seed, "rev-parse", "HEAD");
  const ci = clone(base, origin, "ci");
  assert.equal(git(ci, "rev-parse", "HEAD"), built);
  writeRelease(ci, "1.5.25", 81);
  return { base, origin, ci, built };
}

/** Someone lands a commit on origin's main; `files` overrides what it writes. */
function moveMain({ base, origin }, files = { "README.md": "moved\n" }, name = "other") {
  const other = clone(base, origin, name);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(other, path), content);
  git(other, "add", ".");
  git(other, "commit", "-qm", "docs: PJAN-189 land first");
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

function releaseCommit(ci, { version = "1.5.25", built, env = {} } = {}) {
  return spawnSync(process.execPath, [RELEASE_COMMIT], {
    encoding: "utf8",
    env: {
      ...GIT_ENV,
      PATH,
      RELEASE_ROOT: ci,
      RELEASE_VERSION: version,
      GITHUB_SHA: built,
      RELEASE_PUSH_RETRY_MS: "0",
      ...env,
    },
  });
}

const show = (repo, rev, path) => git(repo, "show", `${rev}:${path}`);

/** Origin has an annotated v<version> on a release commit whose first parent is `built` and whose package.json and lock say <version>. */
function assertTagged(origin, version, built) {
  const tag = `v${version}`;
  assert.equal(git(origin, "cat-file", "-t", `refs/tags/${tag}`), "tag", `${tag} on origin is annotated`);
  const release = git(origin, "rev-parse", `refs/tags/${tag}^{commit}`);
  assert.equal(git(origin, "rev-parse", `${release}^1`), built, `${tag}'s first parent is the commit the run built`);
  assert.equal(JSON.parse(show(origin, release, "package.json")).version, version, `${tag}'s package.json carries ${version}`);
  const lock = JSON.parse(show(origin, release, "package-lock.json"));
  assert.equal(lock.version, version, `${tag}'s lock carries ${version}`);
  assert.equal(lock.packages[""].version, version, `${tag}'s lock root package carries ${version}`);
  assert.equal(git(origin, "log", "-1", "--format=%s", release), releaseSubject(version));
  assert.equal(git(origin, "log", "-1", "--format=%an <%ae>", release), `${BOT.name} <${BOT.email}>`, "the release commit is the bot's");
  assert.match(git(origin, "cat-file", "-p", `refs/tags/${tag}`), new RegExp(`^tagger ${BOT.name.replace(/[[\]]/g, "\\$&")} <`, "m"), "the tag is the bot's");
  const changed = git(origin, "diff-tree", "--no-commit-id", "--name-only", "-r", `${release}^1`, release).split("\n").filter(Boolean);
  assert.ok(changed.every((path) => RELEASE_FILES.includes(path)), `the release commit only touches the release files: ${changed}`);
  return release;
}

// ---- 1. the release push ----------------------------------------------------

test("main still at the built commit: the release commit and its tag land together", () => {
  const run = publishedRun();
  const result = releaseCommit(run.ci, { built: run.built });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const release = assertTagged(run.origin, "1.5.25", run.built);
  assert.equal(git(run.origin, "rev-parse", "refs/heads/main"), release, "main fast-forwarded to the release commit");
  assert.deepEqual(
    git(run.origin, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").split("\n").sort(),
    [".coverage-floor.json", "package-lock.json", "package.json"],
    "the release commit carries the bump and the measured floor",
  );
  assert.equal(JSON.parse(show(run.origin, "main", ".coverage-floor.json")).lines, 81, "the floor the ci job measured rides along");
  assert.match(result.stdout, /main and v1\.5\.25 landed together/);
});

test("main moved before the push: the tag lands on the release commit, main keeps the moving commit", () => {
  const run = publishedRun();
  const moved = moveMain(run);
  const result = releaseCommit(run.ci, { built: run.built });
  assert.equal(result.status, 0, `a published version whose main moved must still end tagged:\n${result.stdout}${result.stderr}`);
  const release = assertTagged(run.origin, "1.5.25", run.built);
  assert.equal(git(run.origin, "rev-parse", "refs/heads/main"), moved, "main is exactly the moving commit: not rewound, not rewritten");
  assert.equal(gitOk(run.origin, "merge-base", "--is-ancestor", release, "main"), false, "the release commit stays off main");
  assert.match(result.stdout, /::notice title=v1\.5\.25 is tagged off main::main moved to [0-9a-f]{40} after this run built/);
});

test("main moved by a commit that rewrites package.json, the lock and the floor: both sides keep their own", () => {
  const run = publishedRun();
  const movedPkg = pkgJson("1.5.24", { dependencies: { yaml: "^2.8.0" } });
  const movedLock = lockJson("1.5.24", { dependencies: { yaml: "^2.8.0" } });
  const movedFloor = floorJson(82.5);
  const moved = moveMain(run, { "package.json": movedPkg, "package-lock.json": movedLock, ".coverage-floor.json": movedFloor });
  const result = releaseCommit(run.ci, { built: run.built });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const release = assertTagged(run.origin, "1.5.25", run.built);
  assert.equal(git(run.origin, "rev-parse", "refs/heads/main"), moved);
  assert.equal(show(run.origin, "main", "package.json"), movedPkg.trim(), "the moving commit's package.json survives on main");
  assert.equal(show(run.origin, "main", "package-lock.json"), movedLock.trim(), "the moving commit's lock survives on main");
  assert.equal(show(run.origin, "main", ".coverage-floor.json"), movedFloor.trim(), "the moving commit's floor survives on main");
  assert.equal(show(run.origin, release, "package.json"), pkgJson("1.5.25").trim(), "the release is the built tree plus the bump, nothing from the moving commit");
  assert.equal(JSON.parse(show(run.origin, release, ".coverage-floor.json")).lines, 81, "the release carries the floor this run measured");
});

test("main moved DURING the push (after the ref advertisement): the atomic push fails whole, then the tag lands alone", () => {
  const run = publishedRun();
  const mover = clone(run.base, run.origin, "mover");
  writeFileSync(join(mover, "README.md"), "raced\n");
  git(mover, "commit", "-qam", "docs: PJAN-189 race the release push");
  const moved = git(mover, "rev-parse", "HEAD");
  // pre-push runs after git has read origin's refs and before it sends the
  // update, so main moves inside the push's own compare-and-swap window. Once.
  const sentinel = join(run.base, "raced");
  writeFileSync(
    join(run.ci, ".git", "hooks", "pre-push"),
    `#!/bin/sh\n[ -e "${sentinel}" ] && exit 0\n: > "${sentinel}"\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\ngit -C "${mover}" push -q origin main\n`,
  );
  chmodSync(join(run.ci, ".git", "hooks", "pre-push"), 0o755);
  const result = releaseCommit(run.ci, { built: run.built });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(sentinel), "the race really ran");
  assert.match(result.stderr, /atomic transaction failed|cannot lock ref/, "the first, atomic push lost the race");
  assertTagged(run.origin, "1.5.25", run.built);
  assert.equal(git(run.origin, "rev-parse", "refs/heads/main"), moved, "main is the commit that won the race");
});

test("a transient push failure with main unmoved is retried, and main still gets the release commit", () => {
  const run = publishedRun();
  const sentinel = join(run.base, "failed-once");
  writeFileSync(
    join(run.ci, ".git", "hooks", "pre-push"),
    `#!/bin/sh\n[ -e "${sentinel}" ] && exit 0\n: > "${sentinel}"\necho "simulated network failure" >&2\nexit 1\n`,
  );
  chmodSync(join(run.ci, ".git", "hooks", "pre-push"), 0o755);
  const result = releaseCommit(run.ci, { built: run.built });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /push attempt 1 of 4 failed; retrying/);
  const release = assertTagged(run.origin, "1.5.25", run.built);
  assert.equal(git(run.origin, "rev-parse", "refs/heads/main"), release, "an unmoved main is never settled with a tag-only push");
});

test("an origin that stays unreachable fails the step loudly, naming the published version", () => {
  const run = publishedRun();
  git(run.ci, "remote", "set-url", "origin", pathToFileURL(join(run.base, "gone.git")).href);
  const result = releaseCommit(run.ci, { built: run.built, env: { RELEASE_PUSH_ATTEMPTS: "2" } });
  assert.notEqual(result.status, 0, "npm has the version; a missing tag must never pass quietly");
  assert.match(result.stderr, /could not push v1\.5\.25 after 2 attempts\. npm already has 1\.5\.25/);
  assert.equal(gitOk(run.origin, "rev-parse", "--verify", "-q", "refs/tags/v1.5.25"), false);
});

test("a version shipped as-is with nothing to commit still gets a release commit and its tag", () => {
  // package.json already says 1.5.25 on the built commit and the floor did not
  // move: the old step printed "nothing to commit", exited 0 and tagged nothing.
  const run = publishedRun();
  git(run.ci, "commit", "-qam", "chore: PJAN-189 open 1.5.25 by hand");
  git(run.ci, "push", "-q", "origin", "main");
  const built = git(run.ci, "rev-parse", "HEAD");
  const result = releaseCommit(run.ci, { built });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const release = assertTagged(run.origin, "1.5.25", built);
  assert.equal(git(run.origin, "rev-parse", `${release}^{tree}`), git(run.origin, "rev-parse", `${built}^{tree}`), "an empty release commit");
  assert.equal(git(run.origin, "rev-parse", "refs/heads/main"), release);
});

test("a checkout that is not the built commit is refused before anything is committed", () => {
  const run = publishedRun();
  const parent = git(run.ci, "rev-parse", "HEAD^");
  const result = releaseCommit(run.ci, { built: parent });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to tag a release on a commit npm did not publish/);
  assert.equal(git(run.ci, "rev-parse", "HEAD"), run.built, "no release commit was made");
  assert.equal(gitOk(run.ci, "rev-parse", "--verify", "-q", "refs/tags/v1.5.25"), false, "no tag was made");
});

test("a tree whose package.json is not the published version is refused", () => {
  const run = publishedRun();
  const result = releaseCommit(run.ci, { built: run.built, version: "1.5.26" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\.json says 1\.5\.25, but npm accepted 1\.5\.26/);
  assert.equal(git(run.ci, "rev-parse", "HEAD"), run.built);
});

test("control: the pre-PJAN-189 inline step, against the same moved main, strands the version untagged", () => {
  // Verbatim from publish.yml before PJAN-189 (32536c3), with the bump's
  // output substituted. This is the step runs 40717543511 and 40728677950
  // failed in; the fixture reproduces their outcome.
  const oldStep = [
    "set -euo pipefail",
    'git config user.name  "github-actions[bot]"',
    'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
    "git add package.json package-lock.json .coverage-floor.json",
    'git commit -m "chore(release): v1.5.25 [skip ci]" || {',
    '  echo "nothing to commit"; exit 0; }',
    'git tag -a "v1.5.25" -m "v1.5.25"',
    'git push --atomic origin HEAD:refs/heads/main "refs/tags/v1.5.25"',
  ].join("\n");
  const run = publishedRun();
  const moved = moveMain(run);
  const result = spawnSync("bash", ["-c", oldStep], { cwd: run.ci, env: GIT_ENV, encoding: "utf8" });
  assert.notEqual(result.status, 0, "the old step failed on a moved main");
  assert.match(result.stderr, /rejected/);
  assert.equal(gitOk(run.origin, "rev-parse", "--verify", "-q", "refs/tags/v1.5.25"), false, "and origin got no tag: npm's 1.5.25 is stranded");
  assert.equal(git(run.origin, "rev-parse", "refs/heads/main"), moved);
});

// ---- 2. the re-run ----------------------------------------------------------

test("re-run after a failed release push tags the version npm already has instead of publishing another", () => {
  const run = publishedRun();
  // The CI checkout before the bump: package.json still at 1.5.24.
  git(run.ci, "checkout", "-q", "--", ".");
  const ciEnv = (extra) => ({ ...GIT_ENV, PATH, RELEASE_ROOT: run.ci, ...extra });
  const output1 = join(run.base, "attempt-1.out");
  const npmBefore = { FAKE_NPM_LATEST: "1.5.24", FAKE_NPM_PUBLISHED: "1.5.24=0000000000000000000000000000000000000000" };

  // Attempt 1: bump, (publish), then a release push that cannot reach origin.
  rmSync(NPM_LOG, { force: true });
  const bump1 = spawnSync(process.execPath, [RELEASE_VERSION], { encoding: "utf8", env: ciEnv({ ...npmBefore, GITHUB_OUTPUT: output1 }) });
  assert.equal(bump1.status, 0, bump1.stdout + bump1.stderr);
  assert.equal(readFileSync(output1, "utf8"), "next=1.5.25\naction=publish\n");
  assert.equal(JSON.parse(readFileSync(join(run.ci, "package.json"), "utf8")).version, "1.5.25", "the real npm version wrote the bump");
  git(run.ci, "remote", "set-url", "origin", pathToFileURL(join(run.base, "gone.git")).href);
  const push1 = releaseCommit(run.ci, { built: run.built, env: { RELEASE_PUSH_ATTEMPTS: "1" } });
  assert.notEqual(push1.status, 0, "attempt 1's release push failed");
  // npm accepted 1.5.25 from the built commit in attempt 1.
  const npmAfter = { FAKE_NPM_LATEST: "1.5.25", FAKE_NPM_PUBLISHED: `1.5.24=0000000000000000000000000000000000000000 1.5.25=${run.built}` };

  // Attempt 2 starts from a fresh checkout of the same commit, as a re-run does.
  const ci2 = clone(run.base, run.origin, "ci-rerun");
  git(ci2, "checkout", "-q", run.built);
  writeFileSync(join(ci2, ".coverage-floor.json"), floorJson(81));
  const output2 = join(run.base, "attempt-2.out");
  const bump2 = spawnSync(process.execPath, [RELEASE_VERSION], { encoding: "utf8", env: { ...ciEnv({ ...npmAfter, GITHUB_OUTPUT: output2 }), RELEASE_ROOT: ci2 } });
  assert.equal(bump2.status, 0, bump2.stdout + bump2.stderr);
  assert.equal(readFileSync(output2, "utf8"), "next=1.5.25\naction=tag\n", "the re-run must not choose 1.5.26");
  assert.equal(JSON.parse(readFileSync(join(ci2, "package.json"), "utf8")).version, "1.5.25");
  assert.equal(JSON.parse(readFileSync(join(ci2, "package-lock.json"), "utf8")).version, "1.5.25");
  const push2 = releaseCommit(ci2, { built: run.built });
  assert.equal(push2.status, 0, push2.stdout + push2.stderr);
  const release = assertTagged(run.origin, "1.5.25", run.built);
  assert.equal(git(run.origin, "rev-parse", "refs/heads/main"), release);
  assert.ok(!npmCalls().some((call) => /^npm publish\b/.test(call)), "nothing here publishes");

  // And a third run of the same commit finds nothing left to do.
  const ci3 = clone(run.base, run.origin, "ci-third");
  git(ci3, "checkout", "-q", run.built);
  const output3 = join(run.base, "attempt-3.out");
  const bump3 = spawnSync(process.execPath, [RELEASE_VERSION], { encoding: "utf8", env: { ...ciEnv({ ...npmAfter, GITHUB_OUTPUT: output3 }), RELEASE_ROOT: ci3 } });
  assert.equal(bump3.status, 0, bump3.stdout + bump3.stderr);
  assert.equal(readFileSync(output3, "utf8"), "next=1.5.25\naction=none\n");
  assert.equal(git(ci3, "status", "--porcelain"), "", "and changes nothing");
});

// ---- 3. release.sh: a thin wrapper that pushes main -------------------------

/** An origin at 1.5.22 and a developer clone holding release.sh and release-version.mjs, as the repo does. */
function devRepo() {
  fixtureCount += 1;
  const base = join(dir, `dev-${fixtureCount}`);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  mkdirSync(join(seed, ".mise", "scripts"), { recursive: true });
  mkdirSync(join(seed, "scripts"), { recursive: true });
  git(base, "init", "-q", "--bare", "--initial-branch=main", origin);
  git(seed, "init", "-q", "--initial-branch=main");
  writeRelease(seed, "1.5.22", 80);
  copyFileSync(RELEASE_SH, join(seed, ".mise", "scripts", "release.sh"));
  chmodSync(join(seed, ".mise", "scripts", "release.sh"), 0o755);
  copyFileSync(RELEASE_VERSION, join(seed, "scripts", "release-version.mjs"));
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "chore(release): v1.5.22 [skip ci]");
  git(seed, "push", "-q", origin, "main");
  const dev = clone(base, origin, "dev");
  writeFileSync(join(dev, "feature.txt"), "work\n");
  git(dev, "add", ".");
  git(dev, "commit", "-qm", "feat: PJAN-189 some work");
  return { base, origin, dev };
}

function releaseSh(dev, args = [], env = {}) {
  rmSync(NPM_LOG, { force: true });
  return spawnSync(join(dev, ".mise", "scripts", "release.sh"), args, {
    cwd: dev,
    encoding: "utf8",
    env: { ...GIT_ENV, PATH, FAKE_NPM_LATEST: "", FAKE_NPM_PUBLISHED: "", ...env },
  });
}

const tagsOn = (repo) => git(repo, "tag", "--list");

test("release.sh: pushes HEAD to main, and makes no tag and no publish", () => {
  const { origin, dev } = devRepo();
  const result = releaseSh(dev);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), git(dev, "rev-parse", "HEAD"));
  assert.equal(tagsOn(origin), "", "no tag reaches origin");
  assert.equal(tagsOn(dev), "", "no tag is made locally");
  assert.deepEqual(npmCalls(), [], "a patch release does not touch npm at all");
  assert.match(result.stderr, /CI publishes and tags it/);
});

test("release.sh: with nothing to push it says so and changes nothing", () => {
  const { origin, dev } = devRepo();
  git(dev, "push", "-q", "origin", "main");
  const result = releaseSh(dev);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /nothing to push/);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), git(dev, "rev-parse", "HEAD"));
});

test("release.sh: a dirty tree is refused before the remote is touched", () => {
  const { origin, dev } = devRepo();
  const before = git(origin, "rev-parse", "refs/heads/main");
  writeFileSync(join(dev, "dirty.txt"), "uncommitted\n");
  const result = releaseSh(dev);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /working tree must be clean/);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), before);
});

test("release.sh: a HEAD that does not fast-forward main is refused, and main is not forced", () => {
  const { base, origin, dev } = devRepo();
  const moved = moveMain({ base, origin });
  const result = releaseSh(dev);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a fast-forward of origin\/main/);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), moved);
});

test("release.sh minor: commits the bump from the higher of npm and package.json, untagged, and pushes it", () => {
  const { origin, dev } = devRepo();
  // main's package.json lags npm (1.5.22 vs 1.6.3) after releases whose
  // commits stayed off main. A minor stepped from package.json would be 1.6.0,
  // a version npm already has, and CI would turn it into 1.6.4.
  const result = releaseSh(dev, ["minor"], { RELEASE_TICKET: "PJAN-189", FAKE_NPM_LATEST: "1.6.3" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const head = git(dev, "rev-parse", "HEAD");
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), head);
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "release(PJAN-189): v1.7.0");
  assert.deepEqual(git(origin, "diff-tree", "--no-commit-id", "--name-only", "-r", "main").split("\n").sort(), ["package-lock.json", "package.json"]);
  assert.equal(JSON.parse(show(origin, "main", "package.json")).version, "1.7.0");
  const lock = JSON.parse(show(origin, "main", "package-lock.json"));
  assert.equal(lock.version, "1.7.0");
  assert.equal(lock.packages[""].version, "1.7.0", "the real npm version rewrote the lock");
  assert.equal(tagsOn(origin), "", "no tag: CI ships 1.7.0 because nothing has taken it");
  assert.equal(tagsOn(dev), "");

  // ...which is exactly what CI's bump then does with that commit.
  const output = join(dev, "..", "ci-bump.out");
  const ci = clone(join(dev, ".."), origin, "ci");
  const bump = spawnSync(process.execPath, [RELEASE_VERSION], {
    encoding: "utf8",
    env: { ...GIT_ENV, PATH, RELEASE_ROOT: ci, GITHUB_OUTPUT: output, FAKE_NPM_LATEST: "1.6.3", FAKE_NPM_PUBLISHED: "1.5.22=0000000000000000000000000000000000000000 1.6.3=0000000000000000000000000000000000000000" },
  });
  assert.equal(bump.status, 0, bump.stdout + bump.stderr);
  assert.equal(readFileSync(output, "utf8"), "next=1.7.0\naction=publish\n", "CI ships the minor as-is");
});

test("release.sh major with npm unreachable steps from package.json", () => {
  const { origin, dev } = devRepo();
  const result = releaseSh(dev, ["major"], { RELEASE_TICKET: "PJAN-189" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(show(origin, "main", "package.json")).version, "2.0.0");
  assert.equal(git(origin, "log", "-1", "--format=%s", "main"), "release(PJAN-189): v2.0.0");
});

test("release.sh --dry-run minor changes nothing and pushes nothing", () => {
  const { origin, dev } = devRepo();
  const before = { head: git(dev, "rev-parse", "HEAD"), origin: git(origin, "rev-parse", "refs/heads/main") };
  const result = releaseSh(dev, ["minor", "--dry-run"], { RELEASE_TICKET: "PJAN-189", FAKE_NPM_LATEST: "1.5.24" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /DRY RUN .* at v1\.6\.0 .*Nothing mutated/);
  assert.equal(git(dev, "rev-parse", "HEAD"), before.head);
  assert.equal(git(origin, "rev-parse", "refs/heads/main"), before.origin);
  assert.equal(git(dev, "status", "--porcelain"), "");
});

test("release.sh: the retired tag-path flags explain themselves and do nothing", () => {
  for (const flag of ["--publish-current", "--resume-push"]) {
    const { origin, dev } = devRepo();
    const before = git(origin, "rev-parse", "refs/heads/main");
    const result = releaseSh(dev, [flag]);
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.match(result.stderr, /retired with the v\* tag release path \(PJAN-189\)/);
    assert.equal(git(origin, "rev-parse", "refs/heads/main"), before);
  }
});

// ---- 4. publish.yml: one publishing path, one publish at a time -------------

test("publish.yml: v* tags start no run, and only main publishes", () => {
  const workflow = YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["push", "pull_request", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push, { branches: ["main"] }, "push triggers on main only: no tags, so no tag push ever publishes");
  assert.equal(
    workflow.jobs.publish.if,
    "github.actor != 'github-actions[bot]' && github.ref == 'refs/heads/main'",
    "the publish job runs for main and nothing else",
  );
  // No parsed expression anywhere still routes a tag ref somewhere.
  const ifs = [];
  const walk = (node) => {
    if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) (key === "if" ? ifs.push(String(value)) : walk(value));
  };
  walk(workflow);
  assert.deepEqual(ifs.filter((expr) => /refs\/tags/.test(expr)), [], "no condition mentions a tag ref");
});

test("publish.yml: one npm-publish section across every ref, and main runs queue in order", () => {
  const workflow = YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8"));
  assert.deepEqual(workflow.jobs.publish.concurrency, { group: "npm-publish", "cancel-in-progress": false }, "a fixed group, never per-ref, never cancelling");
  assert.equal(workflow.concurrency.group, "ci-${{ github.ref }}", "main runs queue behind each other");
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}", "only pull requests cancel a run in progress");
  assert.equal(workflow.jobs.ci.concurrency, undefined, "ci is not serialized across refs");
});

test("mise: `release` is the thin wrapper, and the retry-only `publish` task is gone", () => {
  const mise = readFileSync(join(ROOT, "mise.toml"), "utf8");
  assert.match(mise, /^\[tasks\.release\]\n(?:[^[\n].*\n)*run = "\{\{config_root\}\}\/\.mise\/scripts\/release\.sh"$/m);
  assert.doesNotMatch(mise, /^\[tasks\.publish\]/m);
  const code = readFileSync(RELEASE_SH, "utf8").split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /\bgit\s+tag\b|\bnpm\s+publish\b|--force|\bpush\s+-f\b|--follow-tags|--tags\b/, "release.sh never tags, publishes or forces");
});

console.log("");
rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`pjan-189 release push regressions: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("pjan-189 release push regressions passed");
