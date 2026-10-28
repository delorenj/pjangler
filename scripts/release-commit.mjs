#!/usr/bin/env node
// Commit, tag and push a release npm has just accepted (PJAN-189).
//
// Called by the 'Commit the release' step in .github/workflows/publish.yml,
// after 'Publish to npm' succeeded (or, on a re-run, after the bump step found
// that npm already has this commit's version and only its tag is missing). By
// then npm has <version> for good, so this step has one job: make sure that
// version ends up with an annotated v<version> tag on origin, every time.
//
// The release commit is always built on the commit this run built and
// published from (GITHUB_SHA): its first parent is that commit, and it carries
// package.json and package-lock.json at <version> plus the coverage floor the
// ci job measured. It is made even when nothing changed (--allow-empty): when
// package.json already said <version> and the floor did not move, the old
// step printed "nothing to commit", exited 0 and pushed no tag at all, so a
// version shipped as-is was never tagged.
//
// The push, in order:
//   1. main and the tag together, atomically (PJAN-161): both land or neither,
//      so main never gets a release commit without its tag, and a tag never
//      lands beside a main that could have taken its commit. --follow-tags
//      pushed each ref on its own, so a rejected main still landed the tag.
//   2. If that was rejected because main moved past the commit this run built
//      (someone pushed while the run sat between 'Publish to npm' and here),
//      push the tag alone. The release commit then stays off main, reachable
//      through its tag, exactly like the v1.5.21 and v1.5.23 backfills. This
//      is deliberate, and the only case where a tag lands without main: npm
//      already has the version, so the choice is a tag on an off-main commit
//      or no tag at all. Until PJAN-189 it was no tag at all: the rejection
//      failed the step, and npm kept a version with no tag and no release
//      commit (runs 40717543511 and 40728677950).
//   3. Anything else (a network error, a transient 5xx) is retried a few
//      times, then fails the step loudly: npm has the version, so it must
//      never go quiet.
//
// Why the tag-only fallback does not rebase or merge the release onto the moved
// main instead:
//   - AC1 wants the tag's first parent to be the commit that was built and
//     published. A rebased release commit would name a commit npm never saw.
//   - The moving commit may itself have changed package.json, the lock or the
//     floor. Re-applying this release's copies on top would overwrite them.
//   - The moving commit's own run is already queued behind this one (the
//     workflow's ci-<ref> concurrency group). It publishes and tags a superset
//     of this release, and its release push expects main to be exactly the
//     commit it built. A bot commit landed on top here would make THAT push
//     non-fast-forward in turn, so every concurrent push would cascade.
// main is never forced: every push here is a plain fast-forward-or-nothing, so
// a release commit that reached main is never taken off it again. A version
// whose release commit is off main is still taken (npm has it, the tag
// reserves it), so scripts/release-version.mjs bumps past it next time even
// though main's package.json lags behind.
//
// Environment:
//   RELEASE_VERSION   the version npm accepted (the bump step's `next`)
//   GITHUB_SHA        the commit this run built; HEAD must be exactly it
//   RELEASE_ROOT      repository root (default: this script's repository)
//   RELEASE_PUSH_ATTEMPTS, RELEASE_PUSH_RETRY_MS   retry budget (default 4, 5000)
//
// tests/pjan-189-release-push-regressions.mjs runs this script against real Git:
// a bare origin, main moved by a concurrent commit (one of them touching
// package.json, the lock and the floor), main moved in the middle of the push,
// and a transient push failure.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REMOTE = "origin";
const BRANCH = "main";

/** What the release commit stages. The bump writes the first two; the ci job measured the third. */
export const RELEASE_FILES = ["package.json", "package-lock.json", ".coverage-floor.json"];

/** The identity GitHub shows for the Actions bot, for the commit and the tag. */
export const BOT = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The release commit's message. [skip ci] is belt and braces against a publish
 * loop (a push made with the job's GITHUB_TOKEN starts no workflow anyway), and
 * GitHub also honours it for a TAG push whose commit carries it, which is what
 * keeps a re-pushed release tag from starting a run of an older publish.yml.
 */
export const releaseSubject = (version) => `chore(release): v${version} [skip ci]`;

function die(message) {
  console.error(`release-commit: ${message}`);
  process.exit(1);
}

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const root = resolve(process.env.RELEASE_ROOT ?? resolve(import.meta.dirname, ".."));
  const version = (process.env.RELEASE_VERSION ?? "").trim();
  const built = (process.env.GITHUB_SHA ?? "").trim();
  const attempts = Number(process.env.RELEASE_PUSH_ATTEMPTS ?? 4);
  const retryMs = Number(process.env.RELEASE_PUSH_RETRY_MS ?? 5000);
  if (!SEMVER.test(version)) die(`RELEASE_VERSION must be X.Y.Z, got ${JSON.stringify(version)}`);
  if (!SHA.test(built)) die(`GITHUB_SHA must be the full commit this run built, got ${JSON.stringify(built)}`);
  if (!Number.isInteger(attempts) || attempts < 1) die(`RELEASE_PUSH_ATTEMPTS must be a positive integer`);
  const tag = `v${version}`;

  const git = (args, options = {}) => spawnSync("git", args, { cwd: root, encoding: "utf8", ...options });
  const gitOut = (args, what) => {
    const result = git(args);
    if (result.status !== 0) die(`${what} failed (git ${args.join(" ")}):\n${result.stderr}`);
    return result.stdout.trim();
  };
  // The bot's identity for the commit and the tag, through the environment:
  // GIT_AUTHOR_*/GIT_COMMITTER_* beat any user.name/user.email, so an identity
  // a runner or a caller exported cannot end up on the release.
  const asBot = {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: BOT.name,
      GIT_AUTHOR_EMAIL: BOT.email,
      GIT_COMMITTER_NAME: BOT.name,
      GIT_COMMITTER_EMAIL: BOT.email,
    },
  };

  // The tag must name a child of the commit npm's provenance records. If the
  // checkout is anything else, stop before making a commit that says otherwise.
  const head = gitOut(["rev-parse", "HEAD"], "reading HEAD");
  if (head !== built) {
    die(`HEAD is ${head}, but this run built ${built}; refusing to tag a release on a commit npm did not publish`);
  }
  const pkgVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  if (pkgVersion !== version) {
    die(`package.json says ${pkgVersion}, but npm accepted ${version}; the release commit must carry the published version`);
  }

  gitOut(["add", "--", ...RELEASE_FILES], "staging the release files");
  // Hooks run as usual (there are none on a runner). --allow-empty: see the header.
  const commit = git(["commit", "--allow-empty", "--quiet", "-m", releaseSubject(version)], asBot);
  if (commit.status !== 0) die("git commit failed");
  const release = gitOut(["rev-parse", "HEAD"], "reading the release commit");
  if (gitOut(["rev-parse", "HEAD^1"], "reading the release commit's parent") !== built) {
    die(`the release commit's first parent is not ${built}`);
  }
  // Annotated: a release tag carries its tagger and date, and `git describe`
  // sees it. (The lightweight v1.4.3-v1.4.6 never reached origin under
  // --follow-tags, which pushes annotated tags only.)
  const tagged = git(["tag", "-a", tag, "-m", tag], asBot);
  if (tagged.status !== 0) die(`git tag -a ${tag} failed`);
  console.log(`release-commit: ${tag} -> ${release} (first parent ${built})`);

  const push = (refspecs) => git(["push", ...refspecs], { stdio: ["ignore", "inherit", "inherit"] }).status === 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (push(["--atomic", REMOTE, `HEAD:refs/heads/${BRANCH}`, `refs/tags/${tag}`])) {
      console.log(`release-commit: ${BRANCH} and ${tag} landed together on ${REMOTE}`);
      return;
    }
    const remote = git(["ls-remote", REMOTE, `refs/heads/${BRANCH}`]);
    const remoteMain = remote.status === 0 ? remote.stdout.split("\t")[0].trim() : "";
    if (SHA.test(remoteMain) && remoteMain !== built && remoteMain !== release) {
      if (push([REMOTE, `refs/tags/${tag}`])) {
        console.log(
          `::notice title=${tag} is tagged off main::${BRANCH} moved to ${remoteMain} after this run built ${built}. ` +
            `npm has ${version}; ${tag} names release commit ${release}, which stays off ${BRANCH}. ` +
            `${remoteMain}'s own run publishes and tags the next version.`,
        );
        return;
      }
    }
    if (attempt < attempts) {
      console.log(`release-commit: push attempt ${attempt} of ${attempts} failed; retrying`);
      sleep(retryMs);
    }
  }
  die(
    `could not push ${tag} after ${attempts} attempts. npm already has ${version}: push the tag by hand ` +
      `(git push ${REMOTE} refs/tags/${tag} from a clone holding ${release}), or re-run this job, ` +
      `whose bump step then tags the version npm has instead of publishing another.`,
  );
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
