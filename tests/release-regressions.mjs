import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releasePath = join(root, ".mise", "scripts", "release.sh");
const source = readFileSync(releasePath, "utf8");
const pgSource = readFileSync(join(root, "tests", "pg-registry-regressions.mjs"), "utf8");
const temp = mkdtempSync(join(tmpdir(), "pjangler-release-regression-"));

const indexOf = (needle) => {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `release.sh missing ${needle}`);
  return index;
};

try {
  assert.ok(
    indexOf("require_clean_tree") < indexOf("versioning.sh\" bump"),
    "clean-tree gate must precede the version bump",
  );
  assert.ok(
    indexOf("npm install --package-lock-only --ignore-scripts") <
      indexOf('git -c core.hooksPath=/dev/null commit -m "release(PJAN-44): $NEW"'),
    "lockfile regeneration must be inside the release commit",
  );
  assert.ok(
    indexOf("inspect_tarball") < indexOf("git push --atomic"),
    "the exact tarball must be inspected before the remote release mutation",
  );
  assert.ok(
    indexOf("git push --atomic") < source.lastIndexOf('npm publish "$TARBALL"'),
    "release commit and tag must be pushed before publishing",
  );
  assert.match(source, /RELEASE_REMOTE:-origin/);
  assert.match(source, /RELEASE_BRANCH:-main/);
  assert.match(source, /HEAD:refs\/heads\/\$BRANCH/);
  assert.match(source, /refs\/tags\/\$NEW:refs\/tags\/\$NEW/);
  assert.match(source, /gh auth token 2>\/dev\/null/);
  assert.match(source, /mise exec node@24\.6 --/);
  assert.match(source, /expected npm 11\.x/);
  assert.doesNotMatch(source, /export NODE_AUTH_TOKEN/);
  assert.match(source, /NODE_AUTH_TOKEN="\$token" NPM_CONFIG_USERCONFIG=/);
  assert.ok(
    indexOf("unset NODE_AUTH_TOKEN") < indexOf('log "installing from the committed npm lockfile..."; npm ci'),
  );
  assert.ok(
    indexOf('log "testing..."') < source.indexOf("\nregistry_auth\n", indexOf("# Only trusted")),
    "credentials must be acquired only after install/build/test gates",
  );
  assert.match(source, /\$\{NODE_AUTH_TOKEN\}/);
  assert.match(source, /registry_npm\(\) \(/);
  assert.match(source, /cd "\$AUTH_DIR"/);
  assert.match(source, /mktemp -d "\$PACK_BASE\/pjangler-auth\.XXXXXX"/);
  assert.match(source, /"\$PACK_BASE"\/pjangler-auth\.\*\) rm -rf -- "\$AUTH_DIR"/);
  assert.match(source, /registry_npm whoami --registry=/);
  assert.match(source, /registry_npm view/);
  assert.match(source, /registry_npm publish "\$TARBALL"/);
  assert.ok(
    indexOf("printf '%s\\n' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}'") <
      indexOf('chmod 600 "$AUTH_CONFIG"'),
    "the auth config must exist before its mode is restricted",
  );
  assert.doesNotMatch(
    source,
    /NPM_CONFIG_USERCONFIG="\$AUTH_CONFIG" npm (?:whoami|view|publish)/,
    "authenticated npm commands must not run from the repository",
  );
  assert.match(source, /TARBALL="\$PACK_DIR\/\$filename"/);
  assert.match(source, /PJANGLER_REQUIRE_DISPOSABLE_POSTGRES=1/);
  assert.match(source, /PJAN21_PG_HARNESS_SELF_TEST=0 PJANGLER_REQUIRE/);
  assert.match(source, /npm run check:audit:prod/);
  assert.ok(
    source.lastIndexOf("npm run check:audit:prod") <
      indexOf('git -c core.hooksPath=/dev/null commit'),
    "production audit must rerun after the bumped lock is generated",
  );
  assert.match(source, /--resume-push/);
  assert.match(source, /would atomically resume pushing HEAD\+\$TARGET/);
  assert.match(source, /refs\/tags\/\$TARGET:refs\/tags\/\$TARGET/);
  assert.match(source, /npm publish "\$TARBALL"[\s\\\n]+--dry-run --ignore-scripts/);
  assert.match(source, /E404\|404 Not Found/);
  assert.match(source, /failed without a definitive 404/);
  assert.ok(
    source.lastIndexOf("preflight_publish_cli") <
      indexOf('git -c core.hooksPath=/dev/null commit'),
    "exact-tarball preflight must precede the final commit",
  );
  assert.ok(
    source.lastIndexOf("npm run check:tracked-secrets") <
      indexOf('git -c core.hooksPath=/dev/null commit'),
    "payload secret gate must precede the final commit",
  );
  assert.match(pgSource, /"ON_ERROR_STOP=1"/);
  assert.match(source, /mktemp -d "\$PACK_BASE\/pjangler-pack\.XXXXXX"/);
  assert.match(source, /--pack-destination "\$PACK_DIR"/);
  assert.match(source, /"\$PACK_BASE"\/pjangler-pack\.\*\) rm -rf -- "\$PACK_DIR"/);
  assert.match(source, /basename "\$filename"/);
  assert.match(
    source,
    /Array\.isArray\(parsed\) \? parsed : Object\.values\(parsed\)/,
    "tarball inspection must accept npm's array and keyed-object JSON formats",
  );
  assert.doesNotMatch(source, /op item get|--otp=|git add -A/);

  // Prove a dirty tree is rejected before npm, remote, auth, or bump commands.
  mkdirSync(join(temp, ".mise", "scripts"), { recursive: true });
  mkdirSync(join(temp, "templates", "commonproject"), { recursive: true });
  const copiedRelease = join(temp, ".mise", "scripts", "release.sh");
  cpSync(releasePath, copiedRelease);
  chmodSync(copiedRelease, 0o755);
  writeFileSync(join(temp, "templates", "commonproject", "copier.yml"), "_subdirectory: template\n");
  writeFileSync(join(temp, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');

  const git = (args) => {
    const result = spawnSync("git", args, { cwd: temp, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-q"]);
  git(["config", "user.name", "Release Regression"]);
  git(["config", "user.email", "release-regression@example.invalid"]);
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
  writeFileSync(join(temp, "dirty.txt"), "must block release\n");

  const fakeBin = join(temp, "fake-bin");
  mkdirSync(fakeBin);
  const npmSentinel = join(temp, "npm-was-called");
  const fakeNode = join(fakeBin, "node");
  const fakeNpm = join(fakeBin, "npm");
  writeFileSync(fakeNode, "#!/usr/bin/env sh\nif [ \"${1:-}\" = \"--version\" ]; then printf 'v24.6.0\\n'; exit 0; fi\nexit 96\n");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env sh\nif [ "\${1:-}" = "--version" ]; then printf '11.13.0\\n'; exit 0; fi\n: > "${npmSentinel}"\nexit 97\n`,
  );
  chmodSync(fakeNode, 0o755);
  chmodSync(fakeNpm, 0o755);
  const dirtyResult = spawnSync(copiedRelease, ["--dry-run"], {
    cwd: temp,
    encoding: "utf8",
    env: {
      ...process.env,
      PJANGLER_RELEASE_RUNTIME_ACTIVE: "1",
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    },
  });
  assert.notEqual(dirtyResult.status, 0);
  assert.match(dirtyResult.stderr, /working tree must be clean/);
  assert.equal(
    spawnSync("test", ["-e", npmSentinel]).status,
    1,
    "dirty-tree rejection must happen before npm is called",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("release regressions: PASS");
