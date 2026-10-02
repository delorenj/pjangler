import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
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
const testRunner = readFileSync(join(root, "scripts", "run-tests.mjs"), "utf8");
const workflowsDir = join(root, ".github", "workflows");
const publishWorkflow = readFileSync(join(workflowsDir, "publish.yml"), "utf8");
const gitmodules = readFileSync(join(root, ".gitmodules"), "utf8");
const pgSource = readFileSync(join(root, "tests", "pg-registry-regressions.mjs"), "utf8");
const temp = mkdtempSync(join(tmpdir(), "pjangler-release-regression-"));

const indexOf = (needle) => {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `release.sh missing ${needle}`);
  return index;
};
const releaseCommit = 'git commit -m "release($RELEASE_TICKET_ID): $NEW"';

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
  // PJAN-154: the version pjangler's mise rules are measured on. 2026.7.5
  // predates the `script` hook deprecation the pjan-135 suites assert on.
  const miseVersion = publishWorkflow.indexOf("version: '2026.9.12'", miseSetupStep);
  const miseVerificationStep = publishWorkflow.indexOf("run: mise --version", miseSetupStep);
  const npmTestStep = publishWorkflow.indexOf("npm run test:coverage");
  const workflow = YAML.parse(publishWorkflow);

  // PJAN-163, PJAN-164: two jobs, both GitHub-hosted. `ci` tests on a clean
  // runner that lends the suite nothing this workflow did not install;
  // `publish` runs after it, and has to be hosted, because npm's OIDC trusted
  // publishing and provenance work only there. The repository is public, so a
  // standard hosted runner is free; the rule is no PAID runners.
  assert.deepEqual(Object.keys(workflow.jobs), ["ci", "publish"], "the workflow has exactly two jobs: ci, then publish");
  const ciJob = workflow.jobs.ci;
  const publishJob = workflow.jobs.publish;
  const ciSteps = ciJob.steps;
  const releaseSteps = publishJob.steps;
  assert.equal(publishJob.needs, "ci", "publish runs only after a green ci");
  assert.equal(ciJob["runs-on"], "ubuntu-latest", "ci runs on a clean GitHub-hosted runner, never the operator's host");
  assert.equal(publishJob["runs-on"], "ubuntu-latest", "publish runs on a GitHub-hosted runner, where npm OIDC works");

  // Every key and scalar in the parsed workflow, with its path. Comments are
  // not in the parse, so prose cannot trip these checks.
  const nodes = [];
  const walk = (node, path) => {
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        nodes.push({ path: [...path, key].join("."), key, value });
        walk(value, [...path, key]);
      }
    }
  };
  walk(workflow, []);

  // Every job in every workflow of this repository runs on a standard
  // GitHub-hosted runner (PJAN-164). The self-hosted runner ran as the
  // operator in his real HOME and lent the suite a newer mise, the Krebs
  // adapters and bun, which hid two broken suites (PJAN-154, PJAN-155), and
  // claude-code-action there would have written to his real ~/.claude. No job
  // may go back to it: not by label, runner group or expression. runs-on is
  // the plain string ubuntu-latest, a standard runner that a public repository
  // gets free; larger runners are billed. Parsed values only, so prose about
  // the old runner cannot trip this and a label cannot hide from it.
  const workflowFiles = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).sort();
  assert.deepEqual(workflowFiles, ["claude-code-review.yml", "claude.yml", "publish.yml"], "every workflow is checked below");
  for (const file of workflowFiles) {
    const parsed = YAML.parse(readFileSync(join(workflowsDir, file), "utf8"));
    const values = [];
    const collect = (node, path) => {
      if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) collect(value, [...path, key]);
      else values.push({ path: path.join("."), value: node });
    };
    collect(parsed, []);
    const selfHosted = values.filter(({ value }) => typeof value === "string" && /self-hosted|\bdelonet\b/i.test(value));
    assert.deepEqual(selfHosted.map(({ path }) => path), [], `${file} must not name a self-hosted runner label`);
    for (const [name, job] of Object.entries(parsed.jobs)) {
      assert.equal(job["runs-on"], "ubuntu-latest", `${file}: job ${name} must run on ubuntu-latest`);
    }
  }

  // The gate the release steps had inside ci: main pushes and v* tags, with the
  // actor guard against the bot's own release push.
  assert.equal(ciJob.if, "github.actor != 'github-actions[bot]'", "ci keeps the actor guard against a publish loop");
  assert.equal(
    publishJob.if,
    "github.actor != 'github-actions[bot]' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))",
    "publish runs for main pushes and v* tags, never for the bot's own push",
  );
  assert.equal(publishJob.environment, "release", "publish runs in the release environment");
  assert.equal(ciJob.environment, undefined, "ci publishes nothing, so it is not a release deployment");

  // Permissions, asserted rather than assumed, so widening one has to be a
  // deliberate edit here. ci only reads; publish gets the OIDC token npm
  // trusted publishing and provenance need, and contents: write for the
  // release commit and tag.
  assert.equal(workflow.permissions, undefined, "no workflow-level permissions may widen a job");
  assert.deepEqual(ciJob.permissions, { contents: "read" }, "ci only reads the repository");
  assert.deepEqual(
    publishJob.permissions,
    { "id-token": "write", contents: "write" },
    "publish gets id-token: write and contents: write, and nothing else",
  );
  const idTokens = nodes.filter(({ key }) => key === "id-token");
  assert.deepEqual(idTokens.map((node) => node.path), ["jobs.publish.permissions.id-token"], "id-token: write only on publish");
  assert.equal(publishJob.permissions["id-token"], "write", "npm OIDC trusted publishing needs the publish job's id-token");

  // Both jobs check out the same tree and bridge the canonical SSH submodule
  // URLs: ci for the tests, publish because prepublishOnly runs
  // check:submodules --remote --recursive --archive --npm.
  assert.match(
    gitmodules,
    /^\[submodule "templates\/commonproject"\]\n\tpath = templates\/commonproject\n\turl = git@github\.com:delorenj\/CommonProject\.git\n\tbranch = main\n$/,
    "canonical submodule metadata must retain the exact SSH URL",
  );
  const stepIndex = (steps, predicate, label) => {
    const index = steps.findIndex(predicate);
    assert.notEqual(index, -1, label);
    return index;
  };
  const bridgeRun = [
    'test -n "$(git config --local --get http.https://github.com/.extraheader)"',
    'git config --local url."https://github.com/".insteadOf "git@github.com:"',
    'test "$(git config --local --get url.https://github.com/.insteadof)" = "git@github.com:"',
    "",
  ].join("\n");
  const submoduleSetup = {};
  for (const [name, steps] of [["ci", ciSteps], ["publish", releaseSteps]]) {
    const checkout = stepIndex(steps, (step) => step.uses === "actions/checkout@v4", `${name} must check out the commit`);
    assert.deepEqual(
      steps[checkout].with,
      { submodules: "recursive", "fetch-depth": 0, "fetch-tags": true },
      `${name} checkout must fetch complete parent history/tags while retaining recursive submodules`,
    );
    const bridge = stepIndex(
      steps,
      (step) => step.name === "Bridge canonical SSH submodule URLs to checkout HTTPS credentials",
      `${name} must bridge canonical SSH URLs to HTTPS`,
    );
    assert.equal(steps[bridge].run, bridgeRun, `${name} transport bridge must be local, exact, and require checkout's persisted HTTPS credential`);
    const fetch = stepIndex(
      steps,
      (step) => step.name === "Fetch recursive submodule history and tags",
      `${name} must fetch real recursive submodule tags`,
    );
    assert.match(
      steps[fetch].run,
      /git submodule foreach --recursive[\s\S]*git fetch --unshallow --tags --force origin/,
      `${name} must unshallow recursive submodules and fetch their real tag refs`,
    );
    assert.ok(checkout < bridge && bridge < fetch, `${name}: checkout, then the transport bridge, then the recursive fetch`);
    submoduleSetup[name] = { bridge, fetch };
  }

  // ---- ci: tests, coverage and the ratchet; never a release ----
  // `npm test` delegates to scripts/run-tests.mjs, so the suite manifest lives
  // there. Both halves are checked: package.json must reach the runner, and the
  // runner must still list this suite.
  assert.equal(
    packageJson.scripts.test,
    "node scripts/run-tests.mjs",
    "the standard test surface must be the non-short-circuiting runner",
  );
  assert.match(
    testRunner,
    /^\s*"tests\/pjan-49-regressions\.mjs",$/m,
    "the post-verification npm test gate must include the PJAN-49 tag-drift regression",
  );
  const verifyTemplateTagsStep = stepIndex(
    ciSteps,
    (step) => step.name === "Verify CommonProject tag history",
    "ci must prove CommonProject tags exist",
  );
  assert.match(
    ciSteps[verifyTemplateTagsStep].run,
    /git -C templates\/commonproject describe --tags --abbrev=0 HEAD/,
    "ci must prove a real CommonProject tag is reachable before PJAN-49",
  );
  const ciInstall = stepIndex(ciSteps, (step) => step.run === "npm ci", "ci must install from the lockfile");
  const contractStep = stepIndex(
    ciSteps,
    (step) => step.run === "npm run test:bmad-installer-contract",
    "ci must run the actual pinned BMAD installer contract",
  );
  const npmTestStepIndex = stepIndex(ciSteps, (step) => step.run === "npm run test:coverage", "ci must run the suite under coverage");
  assert.ok(
    submoduleSetup.ci.bridge < submoduleSetup.ci.fetch &&
      submoduleSetup.ci.fetch < verifyTemplateTagsStep &&
      verifyTemplateTagsStep < npmTestStepIndex,
    "the transport bridge must precede recursive fetch, tag verification, and PJAN-49's npm test gate",
  );
  assert.ok(
    ciInstall < contractStep && contractStep < npmTestStepIndex,
    "ci must install dependencies, run the real BMAD contract, then run hermetic npm test",
  );
  assert.ok(miseVersion > miseSetupStep, "ci must request the known-compatible pinned mise version");
  assert.ok(
    miseSetupStep < miseVerificationStep && miseVerificationStep < npmTestStep,
    "ci must set up and explicitly verify mise before npm test",
  );
  const ratchet = stepIndex(ciSteps, (step) => step.name === "Coverage ratchet", "ci must keep the coverage ratchet");
  assert.equal(
    ciSteps[ratchet].run,
    "${{ github.ref == 'refs/heads/main' && 'npm run coverage:apply' || 'npm run coverage:check' }}",
    "on main the ratchet raises the floor; elsewhere it only reports",
  );
  assert.ok(npmTestStepIndex < ratchet, "the ratchet reads the coverage the suite just measured");
  for (const step of ciSteps) {
    const label = step.name ?? step.uses ?? step.run;
    assert.doesNotMatch(String(step.run ?? ""), /\bnpm\s+publish\b|release-version\.mjs|\bnpm\s+version\b/, `ci must not bump or publish: ${label}`);
    assert.doesNotMatch(String(step.run ?? ""), /\bgit\s+(?:commit|push)\b|\bgit\s+tag\s+-a\b/, `ci must not commit, tag or push: ${label}`);
  }

  // What a clean runner lacks, ci provides, so no suite passes by borrowing it
  // from a host or by skipping (PJAN-154, PJAN-155, PJAN-164).
  // pg-registry-regressions skips itself, exit 0, without postgres, psql or
  // bun; ci provides all three and runs it strict, so a missing one fails.
  assert.equal(ciJob.env.PJANGLER_REQUIRE_DISPOSABLE_POSTGRES, "1", "ci runs the PG harness strict: a missing capability fails, never skips");
  assert.deepEqual(ciJob.services.postgres.ports, ["5432:5432"], "ci's disposable postgres is on the standard port");
  assert.equal(String(ciJob.env.PGPORT), "5432", "PG clients reach the service on its port");
  const setupBun = ciSteps.find((step) => String(step.uses ?? "").startsWith("oven-sh/setup-bun@"));
  assert.ok(setupBun, "ci must provide the bun the PG round-trip harness runs under");
  assert.match(setupBun.uses, /^oven-sh\/setup-bun@[0-9a-f]{40}$/, "setup-bun is pinned to a full commit SHA");
  // pjan-23 and pjan-50 run the Krebs tp adapters, which pjangler never
  // vendors: ci fetches them and points PJ_TICKET_PROVIDER_ADAPTERS at them.
  const adapters = stepIndex(ciSteps, (step) => step.name === "Fetch the Krebs tp adapters", "ci must fetch the Krebs tp adapters");
  assert.match(ciSteps[adapters].run, /https:\/\/github\.com\/delorenj\/33GOD\.git/, "the adapters come from the public 33GOD repo");
  assert.match(ciSteps[adapters].run, /^echo "PJ_TICKET_PROVIDER_ADAPTERS=\$adapters" >> "\$GITHUB_ENV"$/m, "every later step sees the adapters");
  assert.ok(adapters < npmTestStepIndex, "the adapters are in place before the suite runs");

  // ---- the coverage floor, handed from ci to publish ----
  // The release commit stages .coverage-floor.json; on main, ci's ratchet has
  // just raised it, and the publish job's checkout still has the old one.
  const floorUpload = stepIndex(
    ciSteps,
    (step) => String(step.uses ?? "").startsWith("actions/upload-artifact@") && step.with?.path === ".coverage-floor.json",
    "ci must hand the coverage floor to publish as an artifact",
  );
  assert.ok(ratchet < floorUpload, "the floor is handed over after the ratchet raised it");
  assert.equal(ciSteps[floorUpload].with["include-hidden-files"], true, "upload-artifact skips dot-files unless told otherwise");
  assert.equal(ciSteps[floorUpload].with["if-no-files-found"], "error", "a missing floor must fail ci, not ship the old one");
  const floorName = ciSteps[floorUpload].with.name;
  const floorDownload = stepIndex(
    releaseSteps,
    (step) => String(step.uses ?? "").startsWith("actions/download-artifact@") && step.with?.name === floorName,
    "publish must download the coverage floor ci measured",
  );
  const floorDir = releaseSteps[floorDownload].with.path;
  assert.equal(floorDir, "${{ runner.temp }}/coverage-floor", "the floor is downloaded outside the workspace");
  const floorCopy = stepIndex(
    releaseSteps,
    (step) => /^cp "\$RUNNER_TEMP\/coverage-floor\/\.coverage-floor\.json" \.coverage-floor\.json$/m.test(String(step.run ?? "")),
    "publish must copy the measured floor over the checkout's",
  );
  assert.equal(ciSteps[floorUpload].if, "github.ref == 'refs/heads/main'", "the floor is handed over on main, where the ratchet raised it");
  for (const index of [floorDownload, floorCopy]) {
    assert.equal(releaseSteps[index].if, "github.ref == 'refs/heads/main'", "the floor is taken over on main, where the release commit is made");
  }

  // ---- publish: bump, npm publish --provenance over OIDC, commit ----
  const setupNode = stepIndex(releaseSteps, (step) => String(step.uses ?? "").startsWith("actions/setup-node@"), "publish must set up node");
  assert.equal(
    releaseSteps[setupNode].with?.["registry-url"],
    "https://registry.npmjs.org",
    "setup-node's registry-url writes the .npmrc npm publishes through",
  );
  const npmUpgrade = stepIndex(
    releaseSteps,
    (step) => /\bneed=11\.5\.1\b/.test(String(step.run ?? "")) && /npm install -g "npm@\^\$need"/.test(String(step.run ?? "")),
    "publish must ensure npm >= 11.5.1, the first npm with trusted publishing",
  );
  const releaseInstall = stepIndex(releaseSteps, (step) => step.run === "npm ci", "publish must install from the lockfile");
  const bump = stepIndex(releaseSteps, (step) => step.id === "bump", "publish must bump the version");
  const npmPublishStepIndex = stepIndex(
    releaseSteps,
    (step) => /^\s*npm publish\b/m.test(String(step.run ?? "")),
    "publish must run npm publish",
  );
  const releaseCommitStep = stepIndex(releaseSteps, (step) => step.name === "Commit the release", "publish must commit the release");
  assert.ok(
    submoduleSetup.publish.fetch < setupNode &&
      setupNode < npmUpgrade &&
      npmUpgrade < releaseInstall &&
      releaseInstall < bump &&
      bump < npmPublishStepIndex &&
      npmPublishStepIndex < releaseCommitStep,
    "publish: submodules, node, npm >= 11.5.1, npm ci, bump < publish < commit",
  );
  assert.ok(floorDownload < floorCopy && floorCopy < releaseCommitStep, "the measured floor is in the tree before the release commit");
  assert.equal(
    releaseSteps[releaseCommitStep].if,
    "github.ref == 'refs/heads/main' && steps.publish.outcome == 'success'",
    "the release commit is gated on the publish's own success",
  );

  // OIDC, with provenance, and no token. setup-node's .npmrc reads
  // NODE_AUTH_TOKEN and setup-node exports a placeholder when it is unset, so
  // it is set empty on the publish step (as before PJAN-161, when 1.4.6 shipped
  // with SLSA provenance): npm has nothing to use but the job's id-token.
  const publishStep = releaseSteps[npmPublishStepIndex];
  assert.equal(publishStep.name, "Publish to npm");
  assert.equal(publishStep.id, "publish");
  assert.equal(publishStep.run, "npm publish --provenance", "publish with provenance, over OIDC");
  assert.deepEqual(publishStep.env, { NODE_AUTH_TOKEN: "" }, "the publish step carries no npm token");
  const publishers = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.filter((step) => /\bnpm\s+publish\b/.test(String(step.run ?? ""))),
  );
  assert.equal(publishers.length, 1, "exactly one step in the workflow publishes");
  const tokenPath = `jobs.publish.steps.${npmPublishStepIndex}.env.NODE_AUTH_TOKEN`;
  for (const { path, value } of nodes.filter((node) => node.key === "NODE_AUTH_TOKEN")) {
    assert.equal(path, tokenPath, "NODE_AUTH_TOKEN may be set only on the publish step");
    assert.equal(value, "", `${path} must be empty: never a token, never from a secret`);
  }
  // No npm token anywhere: not in a step, not in prose. And no secret at all
  // in this workflow: publishing authenticates with the id-token alone.
  assert.doesNotMatch(publishWorkflow, /NPM_TOKEN/, "the workflow must not mention NPM_TOKEN, anywhere");
  const secretUses = nodes.filter(({ key, value }) => /secrets\./.test(key) || (typeof value === "string" && /secrets\./.test(value)));
  assert.deepEqual(secretUses.map((node) => node.path), [], "the workflow reads no secret; npm publishing is OIDC");
  assert.doesNotMatch(publishWorkflow, /_authToken|npm\s+(?:config\s+set|login|adduser)\b/, "nothing writes an npm credential");

  // Provenance cannot be switched off behind the flag's back: not by npm's env
  // override, package.json publishConfig, or the project .npmrc.
  assert.doesNotMatch(publishWorkflow, /NPM_CONFIG_PROVENANCE/i, "provenance must not be overridden through npm's env");
  assert.notEqual(packageJson.publishConfig?.provenance, false, "publishConfig must not turn provenance off");
  const npmrcPath = join(root, ".npmrc");
  if (existsSync(npmrcPath)) {
    const settings = readFileSync(npmrcPath, "utf8").split("\n").filter((line) => !/^\s*[;#]/.test(line));
    assert.ok(!settings.some((line) => /^\s*provenance\s*=\s*false\b/.test(line)), ".npmrc must not turn provenance off");
  }

  // PJAN-161: the release push is atomic, so a rejected main can never leave a
  // tag on a commit main never got. pjan-160-release-version-regressions owns
  // the commit step: it pins the exact command and proves it with real git.
  const pushes = Object.entries(workflow.jobs).flatMap(([name, job]) =>
    job.steps.flatMap((step) =>
      String(step.run ?? "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("#") && /\bgit\s+push\b/.test(line))
        .map((line) => ({ name, step: step.name, line })),
    ),
  );
  assert.equal(pushes.length, 1, "the workflow pushes exactly once");
  assert.equal(pushes[0].name, "publish", "only the publish job pushes");
  assert.equal(pushes[0].step, "Commit the release", "only the release commit step pushes");
  assert.match(pushes[0].line, /\bgit push --atomic origin HEAD:refs\/heads\/main "refs\/tags\/v/, "the release push must be atomic");
  assert.doesNotMatch(pushes[0].line, /--follow-tags/, "--follow-tags pushes each ref on its own");
  assert.ok(
    indexOf("require_clean_tree") < indexOf("versioning.sh\" bump"),
    "clean-tree gate must precede the version bump",
  );
  assert.ok(
    indexOf("npm install --package-lock-only --ignore-scripts") <
      indexOf(releaseCommit),
    "lockfile regeneration must be inside the release commit",
  );
  assert.doesNotMatch(
    source,
    /core\.hooksPath\s*=\s*\/dev\/null|--no-verify|GIT_GUARD_OFF/,
    "release must run repository hooks without any bypass",
  );
  assert.doesNotMatch(source, /release\(PJAN-44\)/, "release commits must not carry a stale hard-coded ticket");
  assert.match(source, /RELEASE_TICKET:-/, "release should accept an explicit ticket override");
  assert.match(source, /git branch --show-current/, "release should derive the ticket from its branch when possible");
  assert.match(source, /git log -1 --pretty=%s/, "release should fall back to the HEAD subject after the branch");
  assert.match(source, /\^PJAN-\[1-9\]\[0-9\]\*\$/, "release must validate the exact ticket format");
  assert.ok(
    indexOf('RELEASE_TICKET_ID="$(resolve_release_ticket)"') <
      indexOf(releaseCommit),
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
    source.lastIndexOf("npm run check:audit:prod", indexOf(releaseCommit)) <
      indexOf(releaseCommit),
    "production audit must rerun after the bumped lock is generated",
  );
  assert.match(source, /--resume-push/);
  assert.match(source, /would atomically resume pushing HEAD\+\$TARGET/);
  assert.match(source, /refs\/tags\/\$TARGET:refs\/tags\/\$TARGET/);
  assert.match(source, /npm publish "\$TARBALL"[\s\\\n]+--dry-run --ignore-scripts/);
  assert.match(source, /E404\|404 Not Found/);
  assert.match(source, /failed without a definitive 404/);
  assert.ok(
    source.lastIndexOf("preflight_publish_cli", indexOf(releaseCommit)) <
      indexOf(releaseCommit),
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
    source.lastIndexOf("npm run check:tracked-secrets", indexOf(releaseCommit)) <
      indexOf(releaseCommit),
    "payload secret gate must precede the final commit",
  );
  const commitIndex = indexOf(releaseCommit);
  const subjectVerificationIndex = source.indexOf("\nverify_release_commit_subject\n", commitIndex);
  const tagIndex = indexOf('git tag -a "$NEW" -m "$NEW" HEAD');
  assert.ok(indexOf('RELEASE_BASE_HEAD="$(git rev-parse HEAD)"') < commitIndex);
  assert.ok(commitIndex < subjectVerificationIndex && subjectVerificationIndex < tagIndex, "the final hook-mutated subject must be verified before tagging");
  assert.match(source, /expected="release\(\$\{RELEASE_TICKET_ID\}\): v\$\{NEW#v\}"/);
  assert.ok(indexOf('git rev-parse HEAD^') > commitIndex, "hook-safe transaction must verify the release parent");
  assert.ok(indexOf("git diff-tree --no-commit-id --name-only -r HEAD") > commitIndex, "hook-safe transaction must verify committed paths");
  assert.ok(source.lastIndexOf("require_clean_tree") > commitIndex, "post-commit hooks must leave a clean tree");
  assert.ok(source.lastIndexOf("inspect_tarball") > commitIndex, "the published tarball must be rebuilt after hooks");
  assert.ok(source.lastIndexOf("preflight_publish_cli") > commitIndex, "the rebuilt tarball must be preflighted after hooks");
  assert.ok(source.lastIndexOf("npm run check:tracked-secrets") > commitIndex, "the committed payload must be rescanned after hooks");
  assert.ok(tagIndex > source.lastIndexOf("npm run check:tracked-secrets"), "no release tag may exist before post-hook gates pass");
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

  // Execute the exact commit line from release.sh against a configured
  // rejecting hook. A normal commit must invoke it and leave HEAD untouched.
  const hookDir = join(temp, ".githooks");
  const hookSentinel = join(temp, "release-hook-ran");
  const commitHarness = join(temp, "release-commit-harness.sh");
  mkdirSync(hookDir);
  writeFileSync(
    join(hookDir, "pre-commit"),
    "#!/usr/bin/env sh\nprintf 'ran\\n' > \"$PJAN86_HOOK_SENTINEL\"\nexit 73\n",
  );
  chmodSync(join(hookDir, "pre-commit"), 0o755);
  git(["config", "core.hooksPath", ".githooks"]);
  writeFileSync(join(temp, "package.json"), '{"name":"fixture","version":"1.0.1"}\n');
  git(["add", "package.json"]);
  writeFileSync(
    commitHarness,
    `#!/usr/bin/env bash\nset -euo pipefail\nRELEASE_TICKET_ID=PJAN-86\nNEW=v1.0.1\n${releaseCommit}\n`,
  );
  chmodSync(commitHarness, 0o755);
  const beforeRejectedCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: temp, encoding: "utf8" }).stdout.trim();
  const rejectedCommit = spawnSync(commitHarness, [], {
    cwd: temp,
    encoding: "utf8",
    env: { ...process.env, PJAN86_HOOK_SENTINEL: hookSentinel },
  });
  assert.notEqual(rejectedCommit.status, 0, "configured pre-commit hook must block the release commit");
  assert.equal(readFileSync(hookSentinel, "utf8"), "ran\n");
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: temp, encoding: "utf8" }).stdout.trim(), beforeRejectedCommit);
  git(["restore", "--staged", "package.json"]);
  git(["restore", "package.json"]);
  git(["config", "--unset", "core.hooksPath"]);
  rmSync(hookDir, { recursive: true, force: true });
  rmSync(commitHarness, { force: true });
  rmSync(hookSentinel, { force: true });
  assert.equal(existsSync(hookSentinel), false);

  // A commit-msg hook may succeed after rewriting the requested subject. Run
  // the exact release commit plus its exact post-hook verifier and prove the
  // transaction stops before either the tag or push boundary.
  const subjectVerifier = source.match(/verify_release_commit_subject\(\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(subjectVerifier, "release subject verifier must remain independently testable");
  const rewriteHarness = join(temp, "release-subject-harness.sh");
  const tagBoundary = join(temp, "release-tag-boundary");
  const pushBoundary = join(temp, "release-push-boundary");
  mkdirSync(hookDir);
  writeFileSync(
    join(hookDir, "commit-msg"),
    "#!/usr/bin/env sh\nprintf '%s\\n' 'release(PJAN-86): v1.0.1 rewritten-by-hook' > \"$1\"\nexit 0\n",
  );
  chmodSync(join(hookDir, "commit-msg"), 0o755);
  git(["config", "core.hooksPath", ".githooks"]);
  writeFileSync(join(temp, "package.json"), '{"name":"fixture","version":"1.0.1"}\n');
  git(["add", "package.json"]);
  writeFileSync(
    rewriteHarness,
    `#!/usr/bin/env bash\nset -euo pipefail\ndie() { printf '%s\\n' "$1" >&2; exit 1; }\n${subjectVerifier}\nRELEASE_TICKET_ID=PJAN-86\nNEW=v1.0.1\n${releaseCommit}\nverify_release_commit_subject\n: > "$PJAN86_TAG_BOUNDARY"\ngit tag -a "$NEW" -m "$NEW" HEAD\n: > "$PJAN86_PUSH_BOUNDARY"\ngit push origin HEAD\n`,
  );
  chmodSync(rewriteHarness, 0o755);
  const beforeRewrittenCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: temp, encoding: "utf8" }).stdout.trim();
  const rewrittenCommit = spawnSync(rewriteHarness, [], {
    cwd: temp,
    encoding: "utf8",
    env: {
      ...process.env,
      PJAN86_TAG_BOUNDARY: tagBoundary,
      PJAN86_PUSH_BOUNDARY: pushBoundary,
    },
  });
  assert.notEqual(rewrittenCommit.status, 0, "a successful subject-rewriting hook must still abort release");
  assert.match(rewrittenCommit.stderr, /release hook changed the commit subject/);
  assert.notEqual(spawnSync("git", ["rev-parse", "HEAD"], { cwd: temp, encoding: "utf8" }).stdout.trim(), beforeRewrittenCommit, "the hook-modified commit itself should succeed before verification rejects it");
  assert.equal(spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: temp, encoding: "utf8" }).stdout.trim(), "release(PJAN-86): v1.0.1 rewritten-by-hook");
  assert.equal(spawnSync("git", ["tag", "--list", "v1.0.1"], { cwd: temp, encoding: "utf8" }).stdout.trim(), "");
  assert.equal(existsSync(tagBoundary), false, "subject mismatch must abort before tag creation");
  assert.equal(existsSync(pushBoundary), false, "subject mismatch must abort before push");
  git(["config", "--unset", "core.hooksPath"]);
  rmSync(hookDir, { recursive: true, force: true });
  rmSync(rewriteHarness, { force: true });

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
