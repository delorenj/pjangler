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
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const releasePath = join(root, ".mise", "scripts", "release.sh");
const source = readFileSync(releasePath, "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const publishWorkflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
const gitmodules = readFileSync(join(root, ".gitmodules"), "utf8");
const pgSource = readFileSync(join(root, "tests", "pg-registry-regressions.mjs"), "utf8");
const temp = mkdtempSync(join(tmpdir(), "pjangler-release-regression-"));

const indexOf = (needle) => {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `release.sh missing ${needle}`);
  return index;
};

try {
  assert.equal(
    packageJson.scripts["test:bmad-installer-contract"],
    "node tests/bmad-installer-contract-regressions.mjs",
    "the actual pinned-installer contract must remain an explicit release script",
  );
  assert.doesNotMatch(
    packageJson.scripts.test,
    /bmad-installer-contract/,
    "ordinary npm test must remain hermetic and offline-safe",
  );
  const miseAction = publishWorkflow.match(/jdx\/mise-action@([0-9a-f]{40})/);
  assert.ok(miseAction, "publish workflow must pin the official mise action to a full commit SHA");
  assert.doesNotMatch(
    publishWorkflow,
    /jdx\/mise-action@(?![0-9a-f]{40}(?:\s|#|$))\S+/,
    "publish workflow must not use a mutable mise action tag",
  );
  const miseSetupStep = publishWorkflow.indexOf(miseAction[0]);
  const miseVersion = publishWorkflow.indexOf("version: '2026.7.5'", miseSetupStep);
  const miseVerificationStep = publishWorkflow.indexOf("run: mise --version", miseSetupStep);
  const npmTestStep = publishWorkflow.indexOf("npm test");
  const npmPublishStep = publishWorkflow.indexOf("npm publish --provenance");
  const workflow = YAML.parse(publishWorkflow);
  const publishSteps = workflow.jobs.publish.steps;
  const checkoutStep = publishSteps.find((step) => step.uses === "actions/checkout@v4");
  assert.ok(checkoutStep, "publish workflow must check out the release commit");
  assert.deepEqual(
    checkoutStep.with,
    { submodules: "recursive", "fetch-depth": 0, "fetch-tags": true },
    "publish checkout must fetch complete parent history/tags while retaining recursive submodules",
  );
  const fetchSubmoduleTagsStep = publishSteps.findIndex(
    (step) => step.name === "Fetch recursive submodule history and tags",
  );
  const transportBridgeStep = publishSteps.findIndex(
    (step) => step.name === "Bridge canonical SSH submodule URLs to checkout HTTPS credentials",
  );
  const verifyTemplateTagsStep = publishSteps.findIndex(
    (step) => step.name === "Verify CommonProject tag history",
  );
  const npmTestStepIndex = publishSteps.findIndex((step) => step.run === "npm test");
  const npmPublishStepIndex = publishSteps.findIndex((step) => step.run === "npm publish --provenance");
  assert.match(
    gitmodules,
    /^\[submodule "templates\/commonproject"\]\n\tpath = templates\/commonproject\n\turl = git@github\.com:delorenj\/CommonProject\.git\n\tbranch = main\n\[submodule "templates\/hermes-agent"\]\n\tpath = templates\/hermes-agent\n\turl = git@github\.com:delorenj\/hermes-agent-template\.git\n\tbranch = main\n$/,
    "canonical submodule metadata must retain the exact SSH URLs",
  );
  assert.notEqual(transportBridgeStep, -1, "publish workflow must bridge canonical SSH URLs to HTTPS");
  assert.equal(
    publishSteps[transportBridgeStep].run,
    [
      'test -n "$(git config --local --get http.https://github.com/.extraheader)"',
      'git config --local url."https://github.com/".insteadOf "git@github.com:"',
      'test "$(git config --local --get url.https://github.com/.insteadof)" = "git@github.com:"',
      "",
    ].join("\n"),
    "publish transport bridge must be local, exact, and require checkout's persisted HTTPS credential",
  );
  assert.match(
    packageJson.scripts.test,
    /node tests\/pjan-49-regressions\.mjs/,
    "the post-verification npm test gate must include the PJAN-49 tag-drift regression",
  );
  assert.notEqual(fetchSubmoduleTagsStep, -1, "publish workflow must fetch real recursive submodule tags");
  assert.match(
    publishSteps[fetchSubmoduleTagsStep].run,
    /git submodule foreach --recursive[\s\S]*git fetch --unshallow --tags --force origin/,
    "publish workflow must unshallow recursive submodules and fetch their real tag refs",
  );
  assert.notEqual(verifyTemplateTagsStep, -1, "publish workflow must prove CommonProject tags exist");
  assert.match(
    publishSteps[verifyTemplateTagsStep].run,
    /git -C templates\/commonproject describe --tags --abbrev=0 HEAD/,
    "publish workflow must prove a real CommonProject tag is reachable before PJAN-49",
  );
  assert.ok(
    transportBridgeStep < fetchSubmoduleTagsStep &&
      fetchSubmoduleTagsStep < verifyTemplateTagsStep &&
      verifyTemplateTagsStep < npmTestStepIndex,
    "the transport bridge must precede recursive fetch, tag verification, and PJAN-49's npm test gate",
  );
  assert.ok(
    transportBridgeStep < npmPublishStepIndex && npmTestStepIndex < npmPublishStepIndex,
    "OIDC publication must remain behind the transport bridge and structurally verified npm test gate",
  );
  assert.ok(miseVersion > miseSetupStep, "publish workflow must request the known-compatible pinned mise version");
  assert.ok(
    miseSetupStep < miseVerificationStep && miseVerificationStep < npmTestStep,
    "publish workflow must set up and explicitly verify mise before npm test",
  );
  assert.match(publishWorkflow, /permissions:\n\s+id-token: write\n\s+contents: read/);
  assert.ok(npmTestStep < npmPublishStep, "OIDC publication must remain behind the complete npm test gate");
  assert.match(
    publishWorkflow.slice(npmPublishStep),
    /env:\n\s+NODE_AUTH_TOKEN: ""/,
    "OIDC publication must retain the explicitly empty npm auth token",
  );
  const contractStep = publishWorkflow.indexOf("npm run test:bmad-installer-contract");
  assert.notEqual(contractStep, -1, "publish workflow must run the actual pinned BMAD installer contract");
  assert.ok(
    publishWorkflow.indexOf("npm ci") < contractStep && contractStep < publishWorkflow.indexOf("npm test"),
    "publish workflow must install dependencies, run the real BMAD contract, then run hermetic npm test",
  );
  assert.ok(
    indexOf("require_clean_tree") < indexOf("versioning.sh\" bump"),
    "clean-tree gate must precede the version bump",
  );
  assert.ok(
    indexOf("npm install --package-lock-only --ignore-scripts") <
      indexOf('git -c core.hooksPath=/dev/null commit -m "release($RELEASE_TICKET_ID): $NEW"'),
    "lockfile regeneration must be inside the release commit",
  );
  assert.doesNotMatch(source, /release\(PJAN-44\)/, "release commits must not carry a stale hard-coded ticket");
  assert.match(source, /RELEASE_TICKET:-/, "release should accept an explicit ticket override");
  assert.match(source, /git branch --show-current/, "release should derive the ticket from its branch when possible");
  assert.match(source, /git log -1 --pretty=%s/, "release should fall back to the HEAD subject after the branch");
  assert.match(source, /\^PJAN-\[1-9\]\[0-9\]\*\$/, "release must validate the exact ticket format");
  assert.ok(
    indexOf('RELEASE_TICKET_ID="$(resolve_release_ticket)"') <
      indexOf('git -c core.hooksPath=/dev/null commit -m "release($RELEASE_TICKET_ID): $NEW"'),
    "the validated release ticket must be resolved before commit creation",
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
  // PJAN-61: the PRE-bump preflight must stay gated to the retry paths. On the
  // bump path the tree still carries CUR — the version just published — so an
  // ungated `npm publish --dry-run` there returns E403 forever, which broke
  // both `release` and `release --dry-run` from the first release onward.
  assert.match(
    source,
    /if \[ -n "\$PUBLISH_CURRENT" \] \|\| \[ -n "\$RESUME_PUSH" \]; then\n\s*preflight_publish_cli\n\s*fi/,
    "the pre-bump publish preflight must run only on --publish-current/--resume-push",
  );
  assert.ok(
    source.lastIndexOf("preflight_publish_cli") >
      source.lastIndexOf('NEW="$("$SCRIPTS_DIR/versioning.sh" bump'),
    "the bump path must still preflight the exact tarball AFTER the version bump",
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
  git(["checkout", "-qb", "test/PJAN-86-release-ticket"]);

  const ticketHelpers = source.match(/extract_release_ticket\(\) \{[\s\S]*?\n\}\nresolve_release_ticket\(\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(ticketHelpers, "release ticket helpers must remain independently testable");
  const ticketHarness = join(temp, "resolve-release-ticket.sh");
  writeFileSync(ticketHarness, `#!/usr/bin/env bash\nset -euo pipefail\ndie() { printf '%s\\n' "$1" >&2; exit 1; }\n${ticketHelpers}\nresolve_release_ticket\n`);
  chmodSync(ticketHarness, 0o755);
  const derivedTicket = spawnSync(ticketHarness, [], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, RELEASE_TICKET: "" },
  });
  assert.equal(derivedTicket.status, 0, derivedTicket.stderr);
  assert.equal(derivedTicket.stdout.trim(), "PJAN-86");
  const explicitTicket = spawnSync(ticketHarness, [], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, RELEASE_TICKET: "PJAN-99" },
  });
  assert.equal(explicitTicket.status, 0, explicitTicket.stderr);
  assert.equal(explicitTicket.stdout.trim(), "PJAN-99");
  const invalidTicket = spawnSync(ticketHarness, [], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, RELEASE_TICKET: "pjan-86 extra" },
  });
  assert.notEqual(invalidTicket.status, 0);
  assert.match(invalidTicket.stderr, /release ticket is missing or invalid/);

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
