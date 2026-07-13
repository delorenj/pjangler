#!/usr/bin/env bash
# release.sh — cut a release atomically, in ONE commit.
#
# Fixes the "bump-after-commit" double-commit: the version bump lands *inside*
# the release commit and the git tag sits *on* that commit. Order:
#   build (gate) -> test (gate) -> bump files -> ONE commit -> tag the commit
#   -> npm publish -> push
#
# `versioning.sh bump` also drops a tag at the current (pre-commit) HEAD; we
# force-move it onto the release commit so tag and version always agree.
#
# Usage:
#   release.sh [patch|minor|major]   bump level (default: patch)
#   release.sh --dry-run             run the gates + show intent, mutate nothing
#   RELEASE_DRY_RUN=1 release.sh      same, via env
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPTS_DIR" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

LEVEL="patch"
DRY="${RELEASE_DRY_RUN:-}"
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) LEVEL="$arg" ;;
    --dry-run|-n)      DRY=1 ;;
    *) echo "release: unknown arg '$arg' (expected patch|minor|major|--dry-run)" >&2; exit 2 ;;
  esac
done

log() { printf 'release: %s\n' "$1" >&2; }

# 0. preconditions -------------------------------------------------------------
[ -f "$REPO_ROOT/templates/commonproject/copier.yml" ] || {
  log "templates/ submodules not initialized; run: git submodule update --init --recursive"; exit 1; }

# npm ships the working tree, but a release commit only records the *committed*
# submodule pointer — warn if a submodule carries uncommitted work so git and
# the published tarball don't silently diverge.
if git submodule status --recursive 2>/dev/null | grep -q '^+'; then
  log "WARNING — a submodule's pointer differs from its checked-out commit."
fi
if ! git submodule foreach --quiet 'git diff --quiet && git diff --cached --quiet' 2>/dev/null; then
  log "WARNING — a submodule has uncommitted changes; commit & push it first if you want git to match npm."
fi

CUR="$("$SCRIPTS_DIR/versioning.sh" current)"

# 1. gates: build then test (tests exercise the built dist/) --------------------
log "building…"; npm run build
log "testing…"; npm test

if [ -n "$DRY" ]; then
  log "DRY RUN — would bump ($LEVEL) from $CUR, commit all changes, tag the commit, npm publish, and push. Nothing mutated."
  exit 0
fi

# 2. bump version files (package.json). versioning.sh also tags v<NEW> at the
#    current HEAD; step 4 moves that tag onto the release commit. -------------
NEW="$("$SCRIPTS_DIR/versioning.sh" bump "$LEVEL")"
log "$CUR -> $NEW"

# 3. ONE commit: the bump + freshly built dist + any pending work --------------
git add -A
git commit -m "release $NEW"

# 4. put the tag ON the release commit (versioning.sh created it pre-commit) ----
git tag -f -a "$NEW" -m "$NEW" HEAD

# 5. publish (fresh 1Password TOTP; a TOTP can't be injected statically) --------
npm publish --access public --otp="$(op item get NPM --vault DeLoSecrets --otp)"

# 6. push commit + tag ---------------------------------------------------------
git push --follow-tags

log "published $NEW ✓"
