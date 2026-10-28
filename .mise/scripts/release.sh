#!/usr/bin/env bash
# release.sh — `mise run release`: hand a release to CI (PJAN-189).
#
# CI is the only publisher. Every green push to main publishes:
# .github/workflows/publish.yml bumps past every version npm or a v* tag has
# taken, runs `npm publish --provenance` over npm OIDC, then commits and tags
# the release (scripts/release-version.mjs, scripts/release-commit.mjs).
#
# This script used to be a second release path. It bumped, committed, tagged
# vX locally and pushed main plus the tag, and the tag's run published vX.
# That path is retired, and v* tags no longer start the workflow:
#   - It published twice. The same push moved main, and main's run found vX
#     taken by the tag and published vX+1 as well.
#   - The tag run and main's run were in different concurrency groups, so they
#     could publish at once: 1.5.21 (main) beat the v1.5.20 tag run, which then
#     failed with "Cannot implicitly apply the latest tag because 1.5.21 is
#     higher" (run 40718894891).
# What is left is a thin wrapper around the one path, pushing main:
#
#   release.sh [patch]       push HEAD to origin/main. CI tests it, bumps the
#                            patch, publishes and tags.
#   release.sh minor|major   first commit package.json and package-lock.json at
#                            the next minor/major, as release(PJAN-<n>): vX.Y.Z,
#                            then push. CI ships that version as-is, because
#                            nothing has taken it (no tag is made here).
#   release.sh --dry-run     say what would happen; change nothing.
#
# It never tags, never publishes and never forces: the push is a plain
# fast-forward of main, and it stops if HEAD does not fast-forward origin/main.
# --publish-current and --resume-push went with the tag path (and so did
# `mise run publish`). To retry a publish, re-run the main workflow; its bump
# step tags a version npm already has from that commit instead of publishing it
# again.
#
# tests/pjan-189-release-push-regressions.mjs runs this against a real bare
# origin; tests/release-regressions.mjs pins the ticket and commit helpers.
set -euo pipefail

LEVEL="patch"
DRY="${RELEASE_DRY_RUN:-}"
REMOTE="${RELEASE_REMOTE:-origin}"
BRANCH="${RELEASE_BRANCH:-main}"

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) LEVEL="$arg" ;;
    --dry-run|-n) DRY=1 ;;
    --publish-current|--resume-push)
      echo "release: $arg was retired with the v* tag release path (PJAN-189). CI is the only publisher: re-run the main workflow (gh run rerun <run-id> --failed)." >&2
      exit 2 ;;
    *) echo "release: unknown arg '$arg' (expected patch|minor|major|--dry-run)" >&2; exit 2 ;;
  esac
done

log() { printf 'release: %s\n' "$1" >&2; }
die() { log "$1"; exit 1; }
extract_release_ticket() {
  printf '%s\n' "$1" | grep -Eo 'PJAN-[1-9][0-9]*' | head -n 1 || true
}
resolve_release_ticket() {
  local ticket branch subject
  ticket="${RELEASE_TICKET:-}"
  if [ -z "$ticket" ]; then
    branch="$(git branch --show-current)"
    ticket="$(extract_release_ticket "$branch")"
  fi
  if [ -z "$ticket" ]; then
    subject="$(git log -1 --pretty=%s)"
    ticket="$(extract_release_ticket "$subject")"
  fi
  [[ "$ticket" =~ ^PJAN-[1-9][0-9]*$ ]] ||
    die "release ticket is missing or invalid; set RELEASE_TICKET=PJAN-<number> or release from a ticketed branch/commit"
  printf '%s\n' "$ticket"
}
verify_release_commit_subject() {
  local expected actual
  expected="release(${RELEASE_TICKET_ID}): v${NEW#v}"
  actual="$(git log -1 --pretty=%s)"
  [ "$actual" = "$expected" ] ||
    die "release hook changed the commit subject; expected '$expected', got '$actual'; nothing was pushed"
}
require_clean_tree() {
  [ -z "$(git status --porcelain=v1 --untracked-files=all)" ] ||
    die "working tree must be clean; commit PJAN work before releasing"
}

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPTS_DIR" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Refuse unrelated work before touching the remote or the version.
require_clean_tree

git fetch --quiet "$REMOTE" "$BRANCH" || die "cannot fetch $REMOTE/$BRANCH"
REMOTE_HEAD="$(git rev-parse FETCH_HEAD)"
git merge-base --is-ancestor "$REMOTE_HEAD" HEAD ||
  die "HEAD is not a fast-forward of $REMOTE/$BRANCH; rebase onto it first"

if [ "$LEVEL" != patch ]; then
  RELEASE_TICKET_ID="$(resolve_release_ticket)"
  PACKAGE_NAME="$(node -p 'require("./package.json").name')"
  CUR="$(node -p 'require("./package.json").version')"
  # main's package.json can lag npm: a release whose commit stayed off main
  # (scripts/release-commit.mjs) leaves it behind. Step from the higher of the
  # two, or a "minor" could land on a version already taken and be bumped to a
  # patch of it.
  LATEST="$(npm view "$PACKAGE_NAME" version 2>/dev/null || true)"
  NEW="v$(node --input-type=module -e '
    import { higherVersion } from "./scripts/release-version.mjs";
    const [current, latest, level] = process.argv.slice(1);
    const base = /^\d+\.\d+\.\d+$/.test(latest.trim()) ? higherVersion(current, latest.trim()) : current;
    const [major, minor] = base.split(".").map(Number);
    process.stdout.write(level === "major" ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`);
  ' "$CUR" "$LATEST" "$LEVEL")"
  if [ -n "$DRY" ]; then
    log "DRY RUN — would commit package.json and package-lock.json at $NEW (from $CUR; npm latest ${LATEST:-unknown}) as release($RELEASE_TICKET_ID): $NEW, then push HEAD to $REMOTE/$BRANCH for CI to publish and tag. Nothing mutated."
    exit 0
  fi
  npm version "${NEW#v}" --no-git-tag-version --ignore-scripts >/dev/null
  git add package.json package-lock.json
  [ -z "$(git diff --name-only)" ] ||
    die "version bump changed files outside package.json/package-lock.json"
  [ "$(git diff --cached --name-only | sort)" = $'package-lock.json\npackage.json' ] ||
    die "release commit must contain exactly package.json and package-lock.json"
  # Hooks are part of the repository's release policy and run normally; the
  # result is re-proved after they have had their chance to act.
  RELEASE_BASE_HEAD="$(git rev-parse HEAD)"
  git commit -m "release($RELEASE_TICKET_ID): $NEW"
  verify_release_commit_subject
  [ "$(git rev-parse HEAD^)" = "$RELEASE_BASE_HEAD" ] ||
    die "release hook changed HEAD topology; nothing was pushed"
  [ "$(git diff-tree --no-commit-id --name-only -r HEAD | sort)" = $'package-lock.json\npackage.json' ] ||
    die "release commit contains paths outside package.json/package-lock.json"
  [ "$(node -p 'require("./package.json").version')" = "${NEW#v}" ] ||
    die "release hook changed the committed version; nothing was pushed"
  require_clean_tree
fi

if [ "$(git rev-parse HEAD)" = "$REMOTE_HEAD" ]; then
  log "nothing to push: $REMOTE/$BRANCH is already at HEAD, and its own run publishes it (gh run list --branch $BRANCH)"
  exit 0
fi
if [ -n "$DRY" ]; then
  log "DRY RUN — would push HEAD ($(git rev-parse --short HEAD)) to $REMOTE/$BRANCH; CI publishes and tags it. Nothing mutated."
  exit 0
fi
# A plain push: fast-forward or rejected, never forced, and no tag.
git push "$REMOTE" "HEAD:refs/heads/$BRANCH"
log "pushed $(git rev-parse --short HEAD) to $REMOTE/$BRANCH; CI publishes and tags it (gh run watch)"
