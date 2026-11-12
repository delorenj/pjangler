import "./helpers/hermetic-suite.mjs";
// PJAN-210: pjangler never authors a version task in a mobile-deploy-hub app.
//
// Operator policy: a mobile app's version moves only through mobile-deploy-hub
// (`mise run deploy`). The hub reads and bumps it through the hooks in
// tools/ci/mobile-deploy.json and mints the release tag itself. The
// `mise.versioning` rule used to take over any repo it adopted: it deleted the
// loose `[tasks."version"]` table, wrote its own git-tag-backed `version`, added
// `version:bump*` and `version:sync` tasks, and wrote `.mise/version-files.conf`
// with `gittag .`. Adopting shortwave would have replaced its hub-backed
// `version` task (`node scripts/release/hub-version.mjs`) and handed the repo a
// way to bump and tag by hand, against the first line of its own mise.toml.
//
// A repo declares itself a hub app with tools/ci/mobile-deploy.json. For those
// the rule stands down: it reports "skip" naming the hub as the version
// authority and writes nothing, whether reached by init, audit or `migrate`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBmadInstallerFixture, createSkillPackFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");

let failures = 0;
function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message.split("\n")[0]}`);
    console.log(error.message.split("\n").slice(1).map((line) => `       ${line}`).join("\n"));
  }
}

/** The tasks a hub app owns, byte for byte as the hub's template wrote them. */
const HUB_VERSION_TASK = `[tasks."version"]
description = "Print the current version (the hub bumps it: mise run deploy)"
run = "node scripts/release/hub-version.mjs"
`;
const HUB_DEPLOY_TASK = `[tasks."deploy"]
description = "Deploy through mobile-deploy-hub (dry run by default)"
run = "gh workflow run deploy.yml"
`;
const HUB_SHIP_TASK = `[tasks."ship"]
description = "Ship through mobile-deploy-hub"
run = '''
set -eu
node "$HOME/.local/share/mobile-deploy-hub/deploy.mjs" ship
'''
`;
const HUB_MISE = `# Hubapp dev tasks. Versions move only through mobile-deploy-hub (mise run deploy): no bump, tag or device install here.

${HUB_VERSION_TASK}
${HUB_DEPLOY_TASK}
${HUB_SHIP_TASK}`;
const HUB_CONTRACT = `${JSON.stringify({
  schema: 2,
  project: { slug: "hubapp", name: "Hubapp" },
  version: { read: "node scripts/release/hub-version.mjs", bump: "node scripts/release/hub-version.mjs bump" },
}, null, 2)}\n`;

const scratch = hermeticScratch("pjan-210-");
let nextMachine = 0;

/** A hermetic machine plus an existing repo to adopt. */
function repo({ hub }) {
  const base = join(scratch, `m${nextMachine += 1}`);
  const home = join(base, "home");
  const catalog = join(base, "catalog");
  const target = join(base, "hubapp");
  mkdirSync(home, { recursive: true });
  mkdirSync(target, { recursive: true });
  createSkillPackFixture(catalog);
  writeFileSync(join(target, "mise.toml"), HUB_MISE);
  mkdirSync(join(target, "scripts", "release"), { recursive: true });
  writeFileSync(join(target, "scripts", "release", "hub-version.mjs"), "// hub version hooks\n");
  writeFileSync(join(target, "version.properties"), "versionName=0.1.0\nversionCode=1000\n");
  if (hub) {
    mkdirSync(join(target, "tools", "ci"), { recursive: true });
    writeFileSync(join(target, "tools", "ci", "mobile-deploy.json"), HUB_CONTRACT);
  }
  const fixture = {
    HOME: home,
    PATH: `${createSkillexMiseFixture(base)}:${process.env.PATH}`,
    PJ_SKILLS_REGISTRY_ROOT: catalog,
    PJ_BMAD_INSTALLER: createBmadInstallerFixture(catalog),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_STATE_HOME: join(base, "state"),
    GIT_CEILING_DIRECTORIES: base,
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    NO_COLOR: "1",
  };
  const git = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: target, encoding: "utf8", env: hermeticEnv(fixture) });
  assert.equal(git.status, 0, git.stderr);
  return { base, target, fixture, registry: join(base, "registry.yaml") };
}

function pj(r, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: r.base, encoding: "utf8", env: hermeticEnv(r.fixture), timeout: 600_000 });
  return { result, text: `${result.stdout}${result.stderr}` };
}

const adopt = (r) => pj(r, ["init", "hubapp", "--target-dir", r.target, "--registry", r.registry, "--skip-board", "--apply", "-y", "--no-tui"]);
const mise = (r) => readFileSync(join(r.target, "mise.toml"), "utf8");

console.log("pjan-210 hub versioning");
try {
  const hub = repo({ hub: true });

  check("the audit stands down for a hub app and names the hub as the version authority", () => {
    const audited = pj(hub, ["audit", hub.target, "--registry", hub.registry, "--rules", "mise.versioning", "--json"]);
    const rule = JSON.parse(audited.result.stdout).rules.find((entry) => entry.id === "mise.versioning");
    assert.ok(rule, `mise.versioning must be reported:\n${audited.text}`);
    assert.equal(rule.status, "skip");
    assert.equal(rule.fixable, false);
    assert.match(rule.summary, /mobile-deploy-hub/);
    assert.match(rule.summary, /version authority/);
    assert.match(rule.summary, /schema 2/);
  });

  check("migrating it by id writes nothing", () => {
    const before = mise(hub);
    const migrated = pj(hub, ["migrate", "mise.versioning", hub.target, "--registry", hub.registry, "--json"]);
    const outcome = JSON.parse(migrated.result.stdout).results?.find?.((entry) => entry.id === "mise.versioning");
    assert.equal(outcome?.status, "skipped", `the migration must report skipped:\n${migrated.text}`);
    assert.match(outcome.summary, /mobile-deploy-hub/);
    assert.deepEqual(outcome.changedFiles, []);
    assert.equal(mise(hub), before, `mise.toml must be byte-identical:\n${migrated.text}`);
    assert.equal(existsSync(join(hub.target, ".mise", "version-files.conf")), false);
    assert.equal(existsSync(join(hub.target, ".mise", "scripts", "versioning.sh")), false);
  });

  check("adopting a hub app leaves its version, deploy and ship tasks byte-identical and adds no version machinery", () => {
    const adopted = adopt(hub);
    assert.equal(adopted.result.status, 0, `adoption must succeed:\n${adopted.text}`);
    const after = mise(hub);
    for (const [name, block] of [["version", HUB_VERSION_TASK], ["deploy", HUB_DEPLOY_TASK], ["ship", HUB_SHIP_TASK]]) {
      assert.ok(after.includes(block), `the ${name} task must survive byte for byte`);
    }
    assert.ok(after.startsWith(HUB_MISE.split("\n")[0]), "the operator's header comment must survive");
    assert.doesNotMatch(after, /mise-versioning/, "no managed versioning block");
    assert.doesNotMatch(after, /version:(bump|sync|check)/, "no bump/sync/check task");
    assert.doesNotMatch(after, /versioning\.sh/, "no pjangler versioning script wired in");
    assert.equal(existsSync(join(hub.target, ".mise", "version-files.conf")), false, "no gittag manifest");
    assert.equal(existsSync(join(hub.target, ".mise", "scripts", "versioning.sh")), false, "no versioning script");
    assert.equal(readFileSync(join(hub.target, "version.properties"), "utf8"), "versionName=0.1.0\nversionCode=1000\n");
    assert.equal(readFileSync(join(hub.target, "tools", "ci", "mobile-deploy.json"), "utf8"), HUB_CONTRACT);
  });

  check("an adopted hub app stays in parity: the rule still stands down and a later migrate changes nothing", () => {
    const audited = JSON.parse(pj(hub, ["audit", hub.target, "--registry", hub.registry, "--rules", "mise.versioning", "--json"]).result.stdout);
    assert.equal(audited.rules.find((entry) => entry.id === "mise.versioning").status, "skip");
    const before = mise(hub);
    pj(hub, ["migrate", "mise.versioning", hub.target, "--registry", hub.registry, "--json"]);
    assert.equal(mise(hub), before, "a later migrate must not touch mise.toml");
    assert.equal(existsSync(join(hub.target, ".mise", "version-files.conf")), false);
  });

  // The control: without the hub contract the same repo IS taken over, so the
  // assertions above are discriminating and the rule still does its job.
  const plain = repo({ hub: false });
  check("without tools/ci/mobile-deploy.json the rule still installs the managed block", () => {
    const adopted = adopt(plain);
    assert.equal(adopted.result.status, 0, `adoption must succeed:\n${adopted.text}`);
    const after = mise(plain);
    assert.match(after, /# >>> mise-versioning >>>/);
    assert.match(after, /version:bump/);
    assert.ok(!after.includes(HUB_VERSION_TASK), "the loose version task is replaced by the managed one");
    assert.ok(existsSync(join(plain.target, ".mise", "version-files.conf")));
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures) {
  console.log(`pjan-210: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pjan-210: hub versioning regressions passed");
