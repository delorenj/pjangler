#!/usr/bin/env bash
# release.sh — cut a release in one clean, reviewable version commit.
#
# Transaction order:
#   clean tree -> remote/template gates -> npm ci/build/typecheck/tests -> auth
#   -> bump package + lock -> inspect exact tarball -> commit + annotated tag
#   -> atomically push the configured main ref + tag -> publish that tarball
#
# Usage:
#   release.sh [patch|minor|major]   bump level (default: patch)
#   release.sh --dry-run             run every non-mutating gate
#   release.sh --publish-current     retry publication only after proving the
#                                    current HEAD/tag are already on main
#   release.sh --resume-push         resume after a failed atomic git push
set -euo pipefail

# npm 12 in the normal Node 26 toolchain currently cannot publish tarballs
# (missing sigstore runtime module). Re-exec the entire release under the proven
# Node 24.6/npm 11 toolchain so every npm gate, pack, and publish uses one runtime.
SELF_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
if [ "${PJANGLER_RELEASE_RUNTIME_ACTIVE:-}" != "1" ]; then
  command -v mise >/dev/null 2>&1 || {
    echo "release: mise is required for the Node 24.6 release runtime" >&2; exit 1; }
  exec env PJANGLER_RELEASE_RUNTIME_ACTIVE=1 \
    mise exec node@24.6 -- "$SELF_PATH" "$@"
fi
NODE_RELEASE_VERSION="$(node --version)"
NPM_RELEASE_VERSION="$(npm --version)"
[[ "$NODE_RELEASE_VERSION" == v24.6.* ]] || {
  echo "release: expected Node 24.6.x, got $NODE_RELEASE_VERSION" >&2; exit 1; }
[[ "$NPM_RELEASE_VERSION" == 11.* ]] || {
  echo "release: expected npm 11.x, got $NPM_RELEASE_VERSION" >&2; exit 1; }

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPTS_DIR" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

LEVEL="patch"
DRY="${RELEASE_DRY_RUN:-}"
PUBLISH_CURRENT=""
RESUME_PUSH=""
REMOTE="${RELEASE_REMOTE:-origin}"
BRANCH="${RELEASE_BRANCH:-main}"
AUTH_CONFIG=""
AUTH_DIR=""
TARBALL=""
PACK_BASE="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
PACK_DIR=""
# Never let an inherited package credential reach npm ci, build scripts, or
# tests. Authenticated registry calls receive their own short-lived token below.
unset NODE_AUTH_TOKEN

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) LEVEL="$arg" ;;
    --dry-run|-n) DRY=1 ;;
    --publish-current) PUBLISH_CURRENT=1 ;;
    --resume-push) RESUME_PUSH=1 ;;
    *) echo "release: unknown arg '$arg' (expected patch|minor|major|--dry-run|--publish-current|--resume-push)" >&2; exit 2 ;;
  esac
done

log() { printf 'release: %s\n' "$1" >&2; }
die() { log "$1"; exit 1; }
cleanup_pack_dir() {
  if [ -n "$PACK_DIR" ] && [ -d "$PACK_DIR" ]; then
    case "$PACK_DIR" in
      "$PACK_BASE"/pjangler-pack.*) rm -rf -- "$PACK_DIR" ;;
      *) die "refusing to clean unexpected package directory: $PACK_DIR" ;;
    esac
  fi
  PACK_DIR=""
  TARBALL=""
}
cleanup() {
  if [ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ]; then
    case "$AUTH_DIR" in
      "$PACK_BASE"/pjangler-auth.*) rm -rf -- "$AUTH_DIR" ;;
      *) log "refusing to clean unexpected auth directory: $AUTH_DIR" ;;
    esac
  fi
  cleanup_pack_dir
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

# npm loads a project .npmrc from its current working directory even when a
# different userconfig is supplied. Run every authenticated command outside the
# repository so stale project credentials cannot override the runtime gh token.
registry_npm() (
  case "${REGISTRY%/}" in
    https://registry.npmjs.org)
      # Public registry; no auth needed for view. Publishing happens in CI via OIDC.
      npm "$@"
      ;;
    https://npm.pkg.github.com)
      local token
      [ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || die "registry auth directory is unavailable"
      token="$(gh auth token 2>/dev/null)" ||
        die "GitHub Packages auth unavailable; run gh auth login"
      [ -n "$token" ] || die "gh returned an empty auth token"
      cd "$AUTH_DIR"
      NODE_AUTH_TOKEN="$token" NPM_CONFIG_USERCONFIG="$AUTH_CONFIG" npm "$@"
      ;;
    *)
      die "unsupported registry in registry_npm: $REGISTRY"
      ;;
  esac
)

registry_config() {
  REGISTRY="$(node -e '
    const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
    process.stdout.write(pkg.publishConfig?.registry || "https://registry.npmjs.org");
  ')"
  case "${REGISTRY%/}" in
    https://npm.pkg.github.com)
      command -v gh >/dev/null 2>&1 || die "gh is required for GitHub Packages auth"
      ;;
    https://registry.npmjs.org)
      : # OIDC trusted publishing; auth happens in CI only
      ;;
    *)
      die "unsupported publishConfig.registry: $REGISTRY (expected GitHub Packages or npmjs.org)"
      ;;
  esac
}

registry_auth() {
  case "${REGISTRY%/}" in
    https://npm.pkg.github.com)
      AUTH_DIR="$(mktemp -d "$PACK_BASE/pjangler-auth.XXXXXX")"
      AUTH_CONFIG="$AUTH_DIR/.npmrc"
      # Keep only the environment-variable reference on disk; the token remains
      # process-local and is cleared by the EXIT trap.
      printf '%s\n' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >"$AUTH_CONFIG"
      chmod 600 "$AUTH_CONFIG"
      registry_npm whoami --registry="$REGISTRY" >/dev/null ||
        die "GitHub Packages authentication failed"
      ;;
    https://registry.npmjs.org)
      log "OIDC trusted publishing: no local auth needed; publish happens in CI"
      ;;
    *)
      die "registry configuration was not initialized"
      ;;
  esac
}

ensure_version_unused() {
  local output status
  set +e
  output="$(registry_npm view "$PACKAGE_NAME@${TARGET#v}" version \
    --registry="$REGISTRY" --json 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || die "$PACKAGE_NAME@${TARGET#v} already exists in $REGISTRY"
  printf '%s' "$output" | grep -Eq 'E404|404 Not Found' ||
    die "registry version lookup failed without a definitive 404 (status $status)"
  log "registry confirms $PACKAGE_NAME@${TARGET#v} is unused"
}

preflight_publish_cli() (
  cd "$PACK_DIR"
  NODE_AUTH_TOKEN= NPM_CONFIG_USERCONFIG=/dev/null npm publish "$TARBALL" \
    --dry-run --ignore-scripts --registry="$REGISTRY" >/dev/null ||
    die "npm exact-tarball publish preflight failed under Node $NODE_RELEASE_VERSION/npm $NPM_RELEASE_VERSION"
)

inspect_tarball() {
  local pack_json package_name package_version filename
  cleanup_pack_dir
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
registry_config

if [ -n "$PUBLISH_CURRENT" ]; then
  TARGET="$CUR"
  [ "$(git rev-list -n 1 "$TARGET" 2>/dev/null || true)" = "$(git rev-parse HEAD)" ] ||
    die "$TARGET must be an existing local tag on HEAD for publish retry"
  [ "$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk '{print $1}')" = "$(git rev-parse HEAD)" ] ||
    die "HEAD must already be pushed to $REMOTE/$BRANCH for publish retry"
  REMOTE_TAG="$(git ls-remote "$REMOTE" "refs/tags/$TARGET^{}" | awk '{print $1}')"
  [ "$REMOTE_TAG" = "$(git rev-parse HEAD)" ] ||
    die "$TARGET must already be an annotated remote tag on HEAD for publish retry"
elif [ -n "$RESUME_PUSH" ]; then
  TARGET="$CUR"
  [ "$(git rev-list -n 1 "$TARGET" 2>/dev/null || true)" = "$(git rev-parse HEAD)" ] ||
    die "$TARGET must be an existing local tag on HEAD for push resume"
  [ -z "$(git ls-remote --tags "$REMOTE" "refs/tags/$TARGET")" ] ||
    die "remote tag already exists: $TARGET (use --publish-current if main also points at HEAD)"
else
  TARGET="$NEXT"
  [ -z "$(git tag --list "$TARGET")" ] || die "local tag already exists: $TARGET"
  [ -z "$(git ls-remote --tags "$REMOTE" "refs/tags/$TARGET")" ] ||
    die "remote tag already exists: $TARGET"
fi

log "installing from the committed npm lockfile..."; npm ci
log "auditing production dependencies..."; npm run check:audit:prod
log "building..."; npm run build
log "typechecking..."; npm run typecheck
log "testing..."; npm test
log "requiring disposable PostgreSQL coverage..."
PJAN21_PG_HARNESS_SELF_TEST=0 PJANGLER_REQUIRE_DISPOSABLE_POSTGRES=1 \
  node tests/pg-registry-regressions.mjs

# Builds and tests may never smuggle generated or unrelated changes into the
# release commit.
require_clean_tree
inspect_tarball
preflight_publish_cli

# Only trusted, isolated registry commands receive a fresh token. All package
# installation, lifecycle scripts, builds, tests, and PG checks above ran with
# NODE_AUTH_TOKEN explicitly absent.
registry_auth
ensure_version_unused

if [ -n "$DRY" ]; then
  if [ -n "$PUBLISH_CURRENT" ]; then
    case "${REGISTRY%/}" in
      https://registry.npmjs.org)
        log "DRY RUN — gates passed; would inspect the exact $TARGET tarball from the already-pushed HEAD/tag. GitHub Actions OIDC workflow handles publishing. Nothing mutated."
        ;;
      *)
        log "DRY RUN — gates passed; would inspect and publish the exact $TARGET tarball from the already-pushed HEAD/tag. Nothing mutated."
        ;;
    esac
  elif [ -n "$RESUME_PUSH" ]; then
    case "${REGISTRY%/}" in
      https://registry.npmjs.org)
        log "DRY RUN — gates passed; would atomically resume pushing HEAD+$TARGET. GitHub Actions OIDC workflow handles publishing. Nothing mutated."
        ;;
      *)
        log "DRY RUN — gates passed; would atomically resume pushing HEAD+$TARGET, then publish the inspected tarball. Nothing mutated."
        ;;
    esac
  else
    case "${REGISTRY%/}" in
      https://registry.npmjs.org)
        log "DRY RUN — gates passed; would bump $CUR -> $NEXT, commit package+lock, inspect tarball, atomically push HEAD to $REMOTE/$BRANCH with $NEXT. GitHub Actions OIDC workflow handles publishing. Nothing mutated."
        ;;
      *)
        log "DRY RUN — gates passed; would bump $CUR -> $NEXT, commit package+lock, inspect tarball, atomically push HEAD to $REMOTE/$BRANCH with $NEXT, then publish the exact tarball. Nothing mutated."
        ;;
    esac
  fi
  exit 0
fi

if [ -n "$PUBLISH_CURRENT" ] || [ -n "$RESUME_PUSH" ]; then
  npm run check:tracked-secrets
  if [ -n "$RESUME_PUSH" ]; then
    git push --atomic "$REMOTE" \
      "HEAD:refs/heads/$BRANCH" \
      "refs/tags/$TARGET:refs/tags/$TARGET"
  fi
  case "${REGISTRY%/}" in
    https://registry.npmjs.org)
      log "tag pushed; GitHub Actions OIDC workflow will publish $PACKAGE_NAME@$TARGET"
      log "if the workflow did not publish, re-run the workflow from the GitHub Actions UI"
      exit 0
      ;;
    *)
      registry_npm publish "$TARBALL" \
        --registry="$REGISTRY" --access public
      PUBLISHED="$(registry_npm view \
        "$PACKAGE_NAME@${TARGET#v}" version --registry="$REGISTRY")"
      [ "$PUBLISHED" = "${TARGET#v}" ] || die "registry verification failed for $PACKAGE_NAME@$TARGET"
      log "published and verified $PACKAGE_NAME@$TARGET from $TARBALL"
      exit 0
      ;;
  esac
fi

NEW="$("$SCRIPTS_DIR/versioning.sh" bump "$LEVEL")"
[ "$NEW" = "$NEXT" ] || die "unexpected version bump: expected $NEXT, got $NEW"
# versioning.sh maintains generic manifests and creates a provisional tag. npm
# owns package-lock structure, so regenerate it and create the final tag only
# after the release commit exists.
git tag -d "$NEW" >/dev/null
npm install --package-lock-only --ignore-scripts
npm run check:lock
npm run check:audit:prod

git add package.json package-lock.json
[ -z "$(git diff --name-only)" ] ||
  die "version bump changed files outside package.json/package-lock.json"
[ "$(git diff --cached --name-only | sort)" = $'package-lock.json\npackage.json' ] ||
  die "release commit must contain exactly package.json and package-lock.json"
git diff --cached --check
inspect_tarball
preflight_publish_cli
npm run check:tracked-secrets

# All fallible package/provenance gates are complete before final refs exist.
# Disable repository hooks so the reviewed tree cannot be changed after the
# exact tarball is built and before the release commit is recorded.
git -c core.hooksPath=/dev/null commit -m "release(PJAN-44): $NEW"
git tag -a "$NEW" -m "$NEW" HEAD
require_clean_tree

# Commit and annotated tag become remotely durable together. A concurrent main
# update rejects this normal fast-forward push rather than overwriting it.
git push --atomic "$REMOTE" \
  "HEAD:refs/heads/$BRANCH" \
  "refs/tags/$NEW:refs/tags/$NEW"

case "${REGISTRY%/}" in
  https://registry.npmjs.org)
    log "tag pushed; GitHub Actions OIDC workflow will publish $PACKAGE_NAME@$NEW"
    ;;
  *)
    registry_npm publish "$TARBALL" \
      --registry="$REGISTRY" --access public
    PUBLISHED="$(registry_npm view \
      "$PACKAGE_NAME@${NEW#v}" version --registry="$REGISTRY")"
    [ "$PUBLISHED" = "${NEW#v}" ] || die "registry verification failed for $PACKAGE_NAME@$NEW"
    log "published and verified $PACKAGE_NAME@$NEW from $TARBALL"
    ;;
esac
