#!/usr/bin/env bash
# release.sh — cut a release in one clean, reviewable version commit.
#
# Transaction order:
#   clean tree -> remote/template/auth gates -> npm ci/build/typecheck/tests
#   -> bump package + lock -> commit + annotated tag -> inspect exact tarball
#   -> atomically push the configured main ref + tag -> publish that tarball
#
# Usage:
#   release.sh [patch|minor|major]   bump level (default: patch)
#   release.sh --dry-run             run every non-mutating gate
#   release.sh --publish-current     retry publication only after proving the
#                                    current HEAD/tag are already on main
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPTS_DIR" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

LEVEL="patch"
DRY="${RELEASE_DRY_RUN:-}"
PUBLISH_CURRENT=""
REMOTE="${RELEASE_REMOTE:-origin}"
BRANCH="${RELEASE_BRANCH:-main}"
AUTH_CONFIG=""
TARBALL=""
PACK_BASE="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
PACK_DIR=""

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) LEVEL="$arg" ;;
    --dry-run|-n) DRY=1 ;;
    --publish-current) PUBLISH_CURRENT=1 ;;
    *) echo "release: unknown arg '$arg' (expected patch|minor|major|--dry-run|--publish-current)" >&2; exit 2 ;;
  esac
done

log() { printf 'release: %s\n' "$1" >&2; }
die() { log "$1"; exit 1; }
cleanup() {
  unset NODE_AUTH_TOKEN || true
  if [ -n "$AUTH_CONFIG" ] && [ -f "$AUTH_CONFIG" ]; then
    rm -f -- "$AUTH_CONFIG"
  fi
  if [ -n "$PACK_DIR" ] && [ -d "$PACK_DIR" ]; then
    case "$PACK_DIR" in
      "$PACK_BASE"/pjangler-pack.*) rm -rf -- "$PACK_DIR" ;;
      *) log "refusing to clean unexpected package directory: $PACK_DIR" ;;
    esac
  fi
}
trap cleanup EXIT

require_clean_tree() {
  [ -z "$(git status --porcelain=v1 --untracked-files=all)" ] ||
    die "working tree must be clean; commit PJAN work before releasing"
  git submodule foreach --quiet \
    'test -z "$(git status --porcelain=v1 --untracked-files=all)"' >/dev/null ||
    die "initialized submodules must be clean"
}

next_version() {
  node -e '
    const [version, level] = process.argv.slice(1);
    let [major, minor, patch] = version.replace(/^v/, "").split(".").map(Number);
    if (level === "major") [major, minor, patch] = [major + 1, 0, 0];
    else if (level === "minor") [minor, patch] = [minor + 1, 0];
    else patch += 1;
    process.stdout.write(`v${major}.${minor}.${patch}`);
  ' "$1" "$2"
}

registry_auth() {
  REGISTRY="$(node -e '
    const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
    process.stdout.write(pkg.publishConfig?.registry || "https://registry.npmjs.org");
  ')"
  case "${REGISTRY%/}" in
    https://npm.pkg.github.com)
      command -v gh >/dev/null 2>&1 || die "gh is required for GitHub Packages auth"
      NODE_AUTH_TOKEN="$(gh auth token 2>/dev/null)" ||
        die "GitHub Packages auth unavailable; run gh auth login"
      [ -n "$NODE_AUTH_TOKEN" ] || die "gh returned an empty auth token"
      export NODE_AUTH_TOKEN
      AUTH_CONFIG="$(mktemp "${TMPDIR:-/tmp}/pjangler-npmrc.XXXXXX")"
      chmod 600 "$AUTH_CONFIG"
      # Keep only the environment-variable reference on disk; the token remains
      # process-local and is cleared by the EXIT trap.
      printf '%s\n' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >"$AUTH_CONFIG"
      NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" npm whoami --registry="$REGISTRY" >/dev/null ||
        die "GitHub Packages authentication failed"
      ;;
    *)
      die "unsupported publishConfig.registry: $REGISTRY (expected GitHub Packages)"
      ;;
  esac
}

inspect_tarball() {
  local pack_json package_name package_version filename
  PACK_DIR="$(mktemp -d "$PACK_BASE/pjangler-pack.XXXXXX")"
  pack_json="$(npm pack --json --ignore-scripts --pack-destination "$PACK_DIR")" ||
    die "npm pack failed"
  filename="$(printf '%s' "$pack_json" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
      if (entries.length !== 1 || !entries[0].filename) process.exit(1);
      process.stdout.write(entries[0].filename);
    });
  ')" || die "could not resolve the exact npm tarball"
  [ "$(basename "$filename")" = "$filename" ] || die "npm returned an unsafe tarball filename"
  TARBALL="$PACK_DIR/$filename"
  [ -f "$TARBALL" ] || die "npm pack did not create $TARBALL"

  package_name="$(node -p 'require("./package.json").name')"
  package_version="$(node -p 'require("./package.json").version')"
  printf '%s' "$pack_json" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      const [entry] = Array.isArray(parsed) ? parsed : Object.values(parsed);
      const [name, version] = process.argv.slice(1);
      if (entry.name !== name || entry.version !== version || !entry.integrity || !entry.shasum) process.exit(1);
    });
  ' "$package_name" "$package_version" || die "tarball metadata does not match package.json"

  for path in package/package.json package/dist/index.js package/dist/mcp-server.js \
    package/templates/commonproject/copier.yml package/templates/hermes-agent/template/role.yaml.jinja \
    package/.mise/scripts/versioning.sh package/.mise/scripts/link-agentfiles.sh; do
    tar -tzf "$TARBALL" | grep -Fx "$path" >/dev/null ||
      die "tarball missing required path: $path"
  done
  log "inspected exact tarball $TARBALL"
}

# Refuse unrelated work before even probing or building.
require_clean_tree
[ -f "$REPO_ROOT/templates/commonproject/copier.yml" ] ||
  die "templates/ submodules not initialized; run: git submodule update --init --recursive"

# A release can only reference commits that clean consumers can fetch/archive.
npm run check:submodules -- --remote --recursive --archive --npm

git fetch --quiet "$REMOTE" "$BRANCH" || die "cannot fetch $REMOTE/$BRANCH"
REMOTE_HEAD="$(git rev-parse FETCH_HEAD)"
git merge-base --is-ancestor "$REMOTE_HEAD" HEAD ||
  die "HEAD is not a fast-forward of $REMOTE/$BRANCH"

CUR="$("$SCRIPTS_DIR/versioning.sh" current)"
NEXT="$(next_version "$CUR" "$LEVEL")"
PACKAGE_NAME="$(node -p 'require("./package.json").name')"

# Authenticate and prove the target package version is unused before mutation.
registry_auth
if [ -n "$PUBLISH_CURRENT" ]; then
  TARGET="$CUR"
  [ "$(git rev-list -n 1 "$TARGET" 2>/dev/null || true)" = "$(git rev-parse HEAD)" ] ||
    die "$TARGET must be an existing local tag on HEAD for publish retry"
  [ "$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk '{print $1}')" = "$(git rev-parse HEAD)" ] ||
    die "HEAD must already be pushed to $REMOTE/$BRANCH for publish retry"
  REMOTE_TAG="$(git ls-remote "$REMOTE" "refs/tags/$TARGET^{}" | awk '{print $1}')"
  [ "$REMOTE_TAG" = "$(git rev-parse HEAD)" ] ||
    die "$TARGET must already be an annotated remote tag on HEAD for publish retry"
else
  TARGET="$NEXT"
  [ -z "$(git tag --list "$TARGET")" ] || die "local tag already exists: $TARGET"
  [ -z "$(git ls-remote --tags "$REMOTE" "refs/tags/$TARGET")" ] ||
    die "remote tag already exists: $TARGET"
fi
if NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" npm view "$PACKAGE_NAME@${TARGET#v}" version \
  --registry="$REGISTRY" >/dev/null 2>&1; then
  die "$PACKAGE_NAME@${TARGET#v} already exists in $REGISTRY"
fi

log "installing from the committed npm lockfile..."; npm ci
log "building..."; npm run build
log "typechecking..."; npm run typecheck
log "testing..."; npm test
log "requiring disposable PostgreSQL coverage..."
PJANGLER_REQUIRE_DISPOSABLE_POSTGRES=1 node tests/pg-registry-regressions.mjs

# Builds and tests may never smuggle generated or unrelated changes into the
# release commit.
require_clean_tree

if [ -n "$DRY" ]; then
  if [ -n "$PUBLISH_CURRENT" ]; then
    log "DRY RUN — gates passed; would inspect and publish the exact $TARGET tarball from the already-pushed HEAD/tag. Nothing mutated."
  else
    log "DRY RUN — gates passed; would bump $CUR -> $NEXT, commit package+lock, inspect tarball, atomically push HEAD to $REMOTE/$BRANCH with $NEXT, then publish the exact tarball. Nothing mutated."
  fi
  exit 0
fi

if [ -n "$PUBLISH_CURRENT" ]; then
  inspect_tarball
  npm run check:tracked-secrets
  NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" npm publish "$TARBALL" \
    --registry="$REGISTRY" --access public
  PUBLISHED="$(NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" npm view \
    "$PACKAGE_NAME@${TARGET#v}" version --registry="$REGISTRY")"
  [ "$PUBLISHED" = "${TARGET#v}" ] || die "registry verification failed for $PACKAGE_NAME@$TARGET"
  log "published and verified $PACKAGE_NAME@$TARGET from $TARBALL"
  exit 0
fi

NEW="$("$SCRIPTS_DIR/versioning.sh" bump "$LEVEL")"
[ "$NEW" = "$NEXT" ] || die "unexpected version bump: expected $NEXT, got $NEW"
# versioning.sh maintains generic manifests and creates a provisional tag. npm
# owns package-lock structure, so regenerate it and create the final tag only
# after the release commit exists.
git tag -d "$NEW" >/dev/null
npm install --package-lock-only --ignore-scripts
npm run check:lock

git add package.json package-lock.json
[ -z "$(git diff --name-only)" ] ||
  die "version bump changed files outside package.json/package-lock.json"
[ "$(git diff --cached --name-only | sort)" = $'package-lock.json\npackage.json' ] ||
  die "release commit must contain exactly package.json and package-lock.json"
git diff --cached --check
git commit -m "release(PJAN-44): $NEW"
git tag -a "$NEW" -m "$NEW" HEAD

inspect_tarball
npm run check:tracked-secrets

# Commit and annotated tag become remotely durable together. A concurrent main
# update rejects this normal fast-forward push rather than overwriting it.
git push --atomic "$REMOTE" \
  "HEAD:refs/heads/$BRANCH" \
  "refs/tags/$NEW:refs/tags/$NEW"

NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" npm publish "$TARBALL" \
  --registry="$REGISTRY" --access public
PUBLISHED="$(NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" npm view \
  "$PACKAGE_NAME@${NEW#v}" version --registry="$REGISTRY")"
[ "$PUBLISHED" = "${NEW#v}" ] || die "registry verification failed for $PACKAGE_NAME@$NEW"

log "published and verified $PACKAGE_NAME@$NEW from $TARBALL"
