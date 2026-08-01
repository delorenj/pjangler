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
      indexOf("git commit -m \"release(PJAN-44): $NEW\""),
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
  assert.match(source, /\$\{NODE_AUTH_TOKEN\}/);
  assert.match(source, /registry_npm\(\) \(/);
  assert.match(source, /cd "\$AUTH_DIR"/);
  assert.match(source, /mktemp -d "\$PACK_BASE\/pjangler-auth\.XXXXXX"/);
  assert.match(source, /"\$PACK_BASE"\/pjangler-auth\.\*\) rm -rf -- "\$AUTH_DIR"/);
  assert.match(source, /registry_npm whoami --registry=/);
  assert.match(source, /registry_npm view/);
  assert.match(source, /registry_npm publish "\$TARBALL"/);
  assert.doesNotMatch(
    source,
    /NPM_CONFIG_USERCONFIG="\$AUTH_CONFIG" npm (?:whoami|view|publish)/,
    "authenticated npm commands must not run from the repository",
  );
  assert.match(source, /TARBALL="\$PACK_DIR\/\$filename"/);
  assert.match(source, /PJANGLER_REQUIRE_DISPOSABLE_POSTGRES=1/);
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
  const fakeNpm = join(fakeBin, "npm");
  writeFileSync(fakeNpm, `#!/usr/bin/env sh\n: > "${npmSentinel}"\nexit 97\n`);
  chmodSync(fakeNpm, 0o755);
  const dirtyResult = spawnSync(copiedRelease, ["--dry-run"], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}` },
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
