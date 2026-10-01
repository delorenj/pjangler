#!/usr/bin/env node
// Pick the version a green main push publishes (PJAN-160).
//
// Called by the 'Bump version from the published one' step in
// .github/workflows/publish.yml. Its `next` output names the npm publish and
// then the release commit and tag that follow it, so a wrong answer here fails
// all three -- or worse, ships under a name that already means something else.
//
// A version is TAKEN when either of these already has it:
//   - npm   (`npm view <name>@<version>` succeeds), or
//   - git   (a tag v<version> exists locally or on origin).
//
// Checking npm alone was the PJAN-160 bug. package.json said 1.5.0, npm had
// never seen 1.5.0 (latest 1.4.6), so the step shipped 1.5.0 "as-is" -- and
// `git tag v1.5.0` then died on the annotated v1.5.0 a human had already cut
// (2026-09-17, on d59c0ba). Every green main push failed at 'Commit the
// release' from then on. A taken version is skipped, never reused: an
// existing tag is never moved or deleted to make room.
//
// The bump itself is unchanged from the inline step it replaced: when
// package.json's version is free it ships as-is; otherwise the patch number is
// bumped past the higher of npm's latest and package.json, and keeps bumping
// until the candidate is free on BOTH npm and git. A tag therefore reserves
// its version even when npm never got it, which is why publish.yml publishes
// FIRST and commits and tags only after npm accepted the version: a failed
// publish leaves nothing behind, so its version is free again next run.
//
// Usage:
//   node scripts/release-version.mjs            # decide, run `npm version`, write `next` to $GITHUB_OUTPUT
//   node scripts/release-version.mjs --dry-run  # decide and print; change nothing
//
// RELEASE_ROOT overrides the package root so the CLI can be exercised against a
// scratch tree; tests/pjan-160-release-version-regressions.mjs does exactly that,
// once with fake `npm` and `git` on PATH and once in real Git repositories with
// only `npm` faked.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REMOTE = "origin";

/** Guard against lookups that report every candidate taken. */
const MAX_CANDIDATES = 1000;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(version) {
  const match = SEMVER.exec(String(version).trim());
  if (!match) throw new Error(`not a plain X.Y.Z version: ${JSON.stringify(version)}`);
  return match.slice(1, 4).map(Number);
}

/** The next patch version: 1.5.0 -> 1.5.1. */
export function nextPatch(version) {
  const [major, minor, patch] = parse(version);
  return `${major}.${minor}.${patch + 1}`;
}

/** The higher of two X.Y.Z versions, compared numerically (what `sort -V | tail -1` did). */
export function higherVersion(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i] ? a : b;
  }
  return a;
}

/**
 * Decide the version to release. Pure: every lookup is injected.
 *
 * @param {object} options
 * @param {string} options.localVersion package.json's version
 * @param {(version: string) => boolean} options.onNpm does npm already have this version?
 * @param {(version: string) => string | null} options.gitTag where tag v<version> exists ("origin", "local"), or null
 * @param {() => string} options.latestPublished npm's latest version ("0.0.0" when unknown)
 * @returns {{ next: string, bumped: boolean, skipped: { version: string, reasons: string[] }[] }}
 */
export function decideReleaseVersion({ localVersion, onNpm, gitTag, latestPublished }) {
  const takenBy = (version) => {
    const reasons = [];
    const tag = gitTag(version);
    if (tag) reasons.push(`git tag v${version} exists (${tag})`);
    if (onNpm(version)) reasons.push("published on npm");
    return reasons;
  };

  parse(localVersion);
  const skipped = [];
  let reasons = takenBy(localVersion);
  if (reasons.length === 0) return { next: localVersion, bumped: false, skipped };
  skipped.push({ version: localVersion, reasons });

  let candidate = nextPatch(higherVersion(latestPublished(), localVersion));
  for (let tries = 0; ; tries += 1) {
    if (tries >= MAX_CANDIDATES) {
      throw new Error(`no free version within ${MAX_CANDIDATES} patches of ${localVersion}; are the lookups broken?`);
    }
    reasons = takenBy(candidate);
    if (reasons.length === 0) return { next: candidate, bumped: true, skipped };
    skipped.push({ version: candidate, reasons });
    candidate = nextPatch(candidate);
  }
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function die(message) {
  console.error(`release-version: ${message}`);
  process.exit(1);
}

/** Every v* tag name, keyed by where it was found. Origin is read directly, so a stale local clone cannot hide one. */
function readGitTags(cwd) {
  // Explicit, because the decision must not depend on how the checkout was
  // configured. No --force: refreshing must never move a local tag either.
  // A failure here (a local tag that disagrees with origin's) is survivable --
  // the name is taken either way, and ls-remote below still reads origin.
  const fetch = run("git", ["fetch", "--tags", "--quiet", REMOTE], cwd);
  if (fetch.status !== 0) {
    console.log(`warning: git fetch --tags ${REMOTE} failed; reading ${REMOTE}'s tags directly instead`);
    if (fetch.stderr) console.log(fetch.stderr.trimEnd());
  }

  const local = run("git", ["tag", "--list", "v*"], cwd);
  if (local.status !== 0) die(`git tag --list failed:\n${local.stderr}`);
  const remote = run("git", ["ls-remote", "--tags", "--refs", REMOTE, "refs/tags/v*"], cwd);
  // Unlike npm's 404, an unreadable origin is not an answer. Guessing "free"
  // here is how a release collides with a tag; stop instead.
  if (remote.status !== 0) die(`git ls-remote --tags ${REMOTE} failed; cannot tell which versions are taken:\n${remote.stderr}`);

  const tags = new Map();
  for (const name of local.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) tags.set(name, "local");
  for (const line of remote.stdout.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (ref?.startsWith("refs/tags/")) tags.set(ref.slice("refs/tags/".length), REMOTE);
  }
  return tags;
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const root = resolve(process.env.RELEASE_ROOT ?? resolve(import.meta.dirname, ".."));
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const name = pkg.name;
  const localVersion = pkg.version;

  const tags = readGitTags(root);
  const decision = decideReleaseVersion({
    localVersion,
    gitTag: (version) => tags.get(`v${version}`) ?? null,
    // Any failure reads as "not on npm", exactly as the inline step had it: a
    // version npm does have still fails loudly at `npm publish`, never silently.
    onNpm: (version) => run("npm", ["view", `${name}@${version}`, "version"], root).status === 0,
    latestPublished: () => {
      const latest = run("npm", ["view", name, "version"], root);
      const version = latest.status === 0 ? latest.stdout.trim() : "";
      return SEMVER.test(version) ? version : "0.0.0";
    },
  });

  for (const { version, reasons } of decision.skipped) console.log(`${version} is taken: ${reasons.join("; ")}`);

  if (decision.bumped) {
    if (!dryRun) {
      const bump = spawnSync("npm", ["version", decision.next, "--no-git-tag-version"], { cwd: root, stdio: "inherit" });
      if (bump.status !== 0) die(`npm version ${decision.next} failed`);
    }
    console.log(`${localVersion} is taken; bumped to ${decision.next}`);
  } else {
    console.log(`${localVersion} is unpublished; shipping it as-is`);
  }

  if (dryRun) {
    console.log(`next=${decision.next} (dry run: package.json and $GITHUB_OUTPUT untouched)`);
  } else if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `next=${decision.next}\n`);
  } else {
    console.log(`next=${decision.next}`);
  }
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) main(process.argv.slice(2));
