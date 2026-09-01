// PJAN Epic 1 / Story 1.5: partial health that is truthful and actionable.
//
// Story 1.4 reports WHAT every domain observed. It cannot say whether the answer
// is TRUSTWORTHY or ACTIONABLE, and the two failures are separate:
//
//   1. AN AGGREGATE THAT CLAIMS HEALTH OVER AN UNREAD FLEET. `health.healthy` is
//      `fail === 0 && error === 0`, so a run in which three of nine domains have
//      no observer at all and every audit-fed domain is `unobserved` still reads
//      `healthy: true`. Nothing declared which gaps were AUTHORIZED: three
//      `unsupported` literals in source authorized themselves.
//   2. FINDINGS NOBODY CAN ACT ON. An observation carried no severity, no
//      observed-versus-desired pair, no repair class and no next action, and the
//      command exited 0 on every collected result -- so a machine client had to
//      parse prose to decide what to do.
//
// The bar, carried from story 1.4 and its two review passes:
//
//   * Every case runs the REAL built `dist/index.js` in a real subprocess.
//   * stdout is asserted non-empty and parseable BEFORE anything is asserted
//     about its content.
//   * Every invocation is bracketed by a content+mtime snapshot of the scratch
//     tree and the tracked contract.
//   * HOST-INDEPENDENT END TO END. DW-54 is the lesson: story 1.3's suite threw
//     `SkipSuite` for its whole body when a live source was absent, so on a
//     fresh clone nothing was verified. Every source here -- registries,
//     repositories, profiles, the hermes release checkout, the tracked template
//     submodule, the fleet contract and the audit report -- is CONSTRUCTED by
//     this file. There is no skip in it except the one for an unbuilt `dist/`.
//   * A verdict is pinned by a DELTA wherever an absolute assertion could be
//     satisfied by the fixture's own unrelated state. Story 1.4's review found
//     three assertions that could not fail; the pattern is copied deliberately.
//
// FRESHNESS AND THE CLOCK. Freshness is emitted as a bucket, never as an age, so
// two runs milliseconds apart bucket identically -- unless a day boundary falls
// between them. Every timestamp this suite writes is therefore FAR from its
// threshold: the current side is written at suite start (zero days old against a
// 180-day window) and the stale side is the year 2000. Nothing here is ever
// within a day of flipping.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const TRACKED_CONTRACT = join(ROOT, "contracts", "fleet-contract.yaml");

/** The four axes story 1.5 adds, spelled out so a silent narrowing in source fails a test. */
const APPLICABILITIES = ["required", "optional", "not_applicable", "deferred", "exception"];
const EVIDENCE = ["direct", "declared", "derived", "absent"];
const FRESHNESS = ["current", "stale", "unknown", "not_applicable"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const REPAIRS = ["automatic", "approval-gated", "blocked", "other-owner", "manual", "none"];
const VERDICTS = ["healthy", "unhealthy", "unproven"];
const EXIT_CATEGORIES = ["ok", "unhealthy", "incomplete"];
const MEMBER_CLASSES = ["healthy", "unhealthy", "incomplete", "deferred", "exception", "unclassified"];
const TRANSITION_KINDS = ["appeared", "resolved", "state_changed", "severity_changed", "evidence_changed"];
/** Mirrors FLEET_STATUS_EXIT_CODES in src/fleet/types.ts. */
const EXIT_CODES = { ok: 0, unhealthy: 10, incomplete: 11 };
const DATA_KEYS = [
  "contract_path", "contract_version", "scope",
  "totals", "health", "agents", "domains", "host", "findings", "probes", "transitions", "truncated",
];

const temp = mkdtempSync(join(tmpdir(), "fleet-health-"));
/**
 * Where injected CLI entries live and record what they saw.
 *
 * Deliberately OUTSIDE `temp`: every invocation asserts `temp` is byte-identical
 * before and after, so a shim writing its own bookkeeping inside it would be
 * indistinguishable from the command under test writing there.
 */
const shimRoot = mkdtempSync(join(tmpdir(), "fleet-health-shims-"));

let failures = 0;
let skipped = 0;

class SkipCase extends Error {}

function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP ${label}: ${reason}`);
}

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    if (error instanceof SkipCase) return;
    failures += 1;
    console.log(`  FAIL ${label}: ${String(error.message).split("\n")[0]}`);
  }
}

async function checkAsync(label, body) {
  try {
    await body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    if (error instanceof SkipCase) return;
    failures += 1;
    console.log(`  FAIL ${label}: ${String(error.message).split("\n")[0]}`);
  }
}

// ---------------------------------------------------------------------------
// A synthetic fleet, and a synthetic PACKAGE ROOT for it to be observed from
// ---------------------------------------------------------------------------

const GIT_IDENTITY = ["-c", "user.email=suite@invalid", "-c", "user.name=Suite", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];

function git(cwd, args) {
  return spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
}

const TEMPLATE_REMOTE = "https://github.com/delorenj/hermes-agent.git";
const HERMES_REMOTE = "https://github.com/delorenj/hermes-agent.git";

/**
 * A relocated package root, so the FLEET-SCOPED template facts are this suite's.
 *
 * `resolvePjanglerRoot()` walks up from the running `dist/index.js` for a
 * `package.json` beside `templates/commonproject/copier.yml`, and the provenance
 * core then reads `templates/hermes-agent` out of that root: its committed
 * gitlink, the URL `.gitmodules` declares, and whether its worktree is clean.
 *
 * Run from THIS checkout those three facts describe the operator's machine --
 * and `git status --porcelain` under a probe environment with `GIT_CONFIG_GLOBAL`
 * stripped reports untracked files a global excludes file would have hidden, so
 * the "clean" fact is host state wearing a fleet-fact's name. MEASURED: the same
 * submodule read clean through this repo's own git and dirty through the probe.
 *
 * So the suite builds its own root with its own template submodule, committed
 * clean, and every template fact then describes something this file created.
 */
function makePackageRoot(name, contractText) {
  const root = join(temp, name);
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "contracts"), { recursive: true });
  mkdirSync(join(root, "templates", "commonproject"), { recursive: true });
  cpSync(CLI, join(root, "dist", "index.js"));
  // The bundle keeps its runtime dependencies external, so a relocated
  // `dist/index.js` needs a `node_modules` to resolve them from. A SYMLINK, not
  // a copy: `snapshotTree` records a link by its target and never descends, so
  // the zero-write proof stays cheap and this suite never walks a dependency
  // tree it does not own.
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "pjangler-fixture", version: "0.0.0", type: "module" }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "templates", "commonproject", "copier.yml"), "# fixture\n", "utf8");
  writeFileSync(join(root, "contracts", "fleet-contract.yaml"), contractText, "utf8");

  const submodule = join(root, "templates", "hermes-agent");
  mkdirSync(submodule, { recursive: true });
  writeFileSync(join(submodule, "README.md"), "# hermes-agent fixture\n", "utf8");
  assert.equal(git(submodule, ["init", "--quiet"]).status, 0);
  assert.equal(git(submodule, ["add", "-A"]).status, 0);
  assert.equal(git(submodule, ["commit", "--quiet", "-m", "template"]).status, 0);
  assert.equal(git(submodule, ["remote", "add", "origin", TEMPLATE_REMOTE]).status, 0);

  writeFileSync(join(root, ".gitmodules"), [
    '[submodule "templates/hermes-agent"]',
    "\tpath = templates/hermes-agent",
    `\turl = ${TEMPLATE_REMOTE}`,
    "",
  ].join("\n"), "utf8");
  assert.equal(git(root, ["init", "--quiet"]).status, 0);
  // `add` on a directory that carries its own `.git` stages a MODE 160000
  // gitlink, which is exactly what `git ls-files --stage` has to answer with for
  // `template.gitlink` to have a desired side at all.
  git(root, ["add", ".gitmodules", "templates/hermes-agent"]);
  const staged = git(root, ["ls-files", "--stage", "--", "templates/hermes-agent"]).stdout;
  assert.match(staged, /^160000 [0-9a-f]{40} 0\t/u, `the fixture root must stage a gitlink, got ${JSON.stringify(staged)}`);
  return root;
}

/** A real hermes release checkout: an executable, an origin remote, and a known HEAD. */
function makeRelease(home) {
  const release = join(home, ".local", "share", "hermes-agent", "releases", "abc");
  mkdirSync(join(release, "bin"), { recursive: true });
  writeFileSync(join(release, "bin", "hermes"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(release, "bin", "hermes"), 0o755);
  assert.equal(git(release, ["init", "--quiet"]).status, 0);
  writeFileSync(join(release, "README.md"), "# hermes\n", "utf8");
  assert.equal(git(release, ["add", "-A"]).status, 0);
  assert.equal(git(release, ["commit", "--quiet", "-m", "release"]).status, 0);
  assert.equal(git(release, ["remote", "add", "origin", HERMES_REMOTE]).status, 0);
  const sha = git(release, ["rev-parse", "HEAD"]).stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/u);
  return { release, sha };
}

/** A repository with a role scaffold, an ignored runtime directory and a `.project.json`. */
function makeRepo(reposRoot, slug) {
  const dir = join(reposRoot, slug);
  const role = join(dir, "agents", "hermes", "pm");
  mkdirSync(join(role, "runtime"), { recursive: true });
  writeFileSync(join(role, "role.yaml"), "role: pm\n", "utf8");
  writeFileSync(join(dir, ".project.json"), `${JSON.stringify({
    project_slug: slug,
    ticket_provider: { type: "plane", workspace: "suite", identifier: slug.toUpperCase(), board_id: `board-${slug}` },
  }, null, 2)}\n`, "utf8");
  assert.equal(git(dir, ["init", "--quiet"]).status, 0);
  writeFileSync(join(dir, "README.md"), `# ${slug}\n`, "utf8");
  assert.equal(git(dir, ["add", "-A"]).status, 0);
  assert.equal(git(dir, ["commit", "--quiet", "-m", "seed"]).status, 0);
  return dir;
}

/** ISO instants FAR from every declared threshold. See the freshness note at the top. */
const NOW_ISO = new Date().toISOString();
const ANCIENT_ISO = "2000-01-01T00:00:00.000Z";

const scratchHome = join(temp, "home");
const reposRoot = join(temp, "repos");
const workdir = join(temp, "work");
const SLUGS = ["alpha", "beta"];

let RELEASE = "";
let RELEASE_SHA = "";

function agentRow(slug, overrides = {}) {
  const row = {
    repo: slug,
    role: "pm",
    display_name: `${slug} PM`,
    project_path: join(reposRoot, slug),
    role_dir: join(reposRoot, slug, "agents", "hermes", "pm"),
    profile_name: `${slug}-pm`,
    provisioned_at: NOW_ISO,
    plane: { workspace: "suite", project_id: `board-${slug}`, identifier: slug.toUpperCase() },
    bloodbank: { enabled: false, gateway_scope: "fleet", target_agent_id: `${slug}-pm` },
    systemd: { gateway_unit: `hermes-${slug}-pm-gateway.service` },
    hermes: {
      bin: join(RELEASE, "bin", "hermes"),
      repo: RELEASE,
      fleet_env: join(scratchHome, ".hermes", "fleet.env"),
      git_url: HERMES_REMOTE,
      git_ref: "main",
      git_sha: RELEASE_SHA,
    },
  };
  return { ...row, ...overrides };
}

function writeAgentRegistry(path, slugs, mutate = () => {}) {
  const agents = {};
  for (const slug of slugs) agents[`${slug}-pm`] = agentRow(slug);
  mutate(agents);
  writeFileSync(path, YAML.stringify({ schema_version: 1, agents }), "utf8");
  return path;
}

function writeProjectRegistry(path, slugs, confirmedAt = () => NOW_ISO) {
  const projects = {};
  for (const slug of slugs) {
    projects[slug] = {
      name: slug,
      slug,
      repo_path: join(reposRoot, slug),
      status: "active",
      ticket_provider: {
        type: "plane", workspace: "suite",
        identifier: slug.toUpperCase(), board_id: `board-${slug}`,
        board_confirmed_at: confirmedAt(slug),
        identifier_fetched_at: NOW_ISO,
      },
    };
  }
  writeFileSync(path, YAML.stringify({ schema_version: 1, projects }), "utf8");
  return path;
}

function seedScratch() {
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(scratchHome, ".hermes", "profiles"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "pjangler"), { recursive: true });
  mkdirSync(join(scratchHome, ".config", "hermes-agent-template"), { recursive: true });

  const made = makeRelease(scratchHome);
  RELEASE = made.release;
  RELEASE_SHA = made.sha;

  for (const slug of SLUGS) {
    makeRepo(reposRoot, slug);
    const dir = join(scratchHome, ".hermes", "profiles", `${slug}-pm`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "# GENERATED FILE -- DO NOT EDIT\nname: x\n", "utf8");
  }

  writeAgentRegistry(join(scratchHome, ".hermes", "agents-registry.yaml"), SLUGS);
  writeProjectRegistry(join(scratchHome, ".config", "pjangler", "projects.yaml"), SLUGS);

  writeFileSync(join(scratchHome, ".config", "hermes-agent-template", "config.toml"), [
    "[fleet]",
    `hermes_bin = "${join(RELEASE, "bin", "hermes")}"`,
    `hermes_repo = "${RELEASE}"`,
    `hermes_git_url = "${HERMES_REMOTE}"`,
    'hermes_git_ref = "main"',
    `hermes_git_sha = "${RELEASE_SHA}"`,
    "",
  ].join("\n"), "utf8");

  writeFileSync(join(scratchHome, ".hermes", "fleet.env"), [
    `HERMES_FLEET_HOME=${join(scratchHome, ".hermes")}`,
    `HERMES_FLEET_BIN=${join(RELEASE, "bin", "hermes")}`,
    `HERMES_FLEET_REPO=${RELEASE}`,
    `HERMES_FLEET_REGISTRY_FILE=${join(scratchHome, ".hermes", "agents-registry.yaml")}`,
    "",
  ].join("\n"), "utf8");
}

const isolation = {
  HOME: scratchHome,
  XDG_CONFIG_HOME: join(scratchHome, ".config"),
  XDG_DATA_HOME: join(scratchHome, ".local", "share"),
  XDG_STATE_HOME: join(scratchHome, ".local", "state"),
  XDG_CACHE_HOME: join(scratchHome, ".cache"),
  HERMES_FLEET_HOME: join(scratchHome, ".hermes"),
  HERMES_AGENTS_REGISTRY: join(scratchHome, ".hermes", "agents-registry.yaml"),
  HERMES_FLEET_REGISTRY_FILE: join(scratchHome, ".hermes", "agents-registry.yaml"),
  HERMES_FLEET_ENV: join(scratchHome, ".hermes", "fleet.env"),
  HERMES_TEMPLATE_CONFIG: join(scratchHome, ".config", "hermes-agent-template", "config.toml"),
  PJ_PROJECT_REGISTRY: join(scratchHome, ".config", "pjangler", "projects.yaml"),
  HERMES_TEMPLATE_RUNTIME_SCAFFOLD: join(scratchHome, ".hermes", "runtime-scaffold"),
  RUNTIME_SCAFFOLD_DIR: join(scratchHome, ".hermes", "runtime-scaffold"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  // TMPDIR can itself sit inside a git work tree on this machine, which would
  // make an unrelated checkout answer for every scratch repository below.
  GIT_CEILING_DIRECTORIES: realpathSync(temp),
  TMPDIR: temp,
  NO_COLOR: "1",
};

// ---------------------------------------------------------------------------
// Zero-write proof
// ---------------------------------------------------------------------------

function snapshotTree(label, root, entries = {}) {
  if (!existsSync(root)) { entries[`${label}:<absent>`] = "absent"; return entries; }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      const key = `${label}:${relative(root, path)}`;
      const stat = lstatSync(path);
      if (entry.isSymbolicLink()) { entries[key] = `link:${readlinkSync(path)}:${stat.mtimeMs}`; continue; }
      if (entry.isDirectory()) { entries[key] = `dir:${stat.mtimeMs}`; walk(path); continue; }
      if (!entry.isFile()) { entries[key] = `other:${stat.mode}:${stat.mtimeMs}`; continue; }
      let digest;
      try { digest = createHash("sha256").update(readFileSync(path)).digest("hex"); }
      catch { digest = `unreadable:${stat.mode}:${stat.size}`; }
      entries[key] = `${digest}:${stat.mtimeMs}`;
    }
  };
  walk(root);
  return entries;
}

/**
 * The surfaces a difference is ATTRIBUTABLE to the command under test.
 *
 * This suite's own isolated scratch tree -- which holds every registry, every
 * repository, both git checkouts and the fixture package roots -- and the
 * TRACKED contract, which nothing in this suite should ever touch. Deliberately
 * not this repository's `.git/index`: DW-70 records that the machine runs
 * parallel agents by design, so a change there is not attributable to one
 * invocation. Every path this suite actually exercises is under `temp`.
 */
function snapshotIsolated() {
  const entries = {};
  snapshotTree("temp", temp, entries);
  snapshotTree("contracts", join(ROOT, "contracts"), entries);
  return entries;
}

/** Run the built CLI and prove the run wrote nothing to a protected root. */
function cli(args, extraEnv = {}, cwd = workdir) {
  const before = snapshotIsolated();
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...isolation, ...extraEnv },
  });
  const after = snapshotIsolated();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => before[key] !== after[key]);
    for (const key of changed) console.log(`       ${key}: ${before[key] ?? "<missing>"} -> ${after[key] ?? "<missing>"}`);
    assert.fail(`pj ${args.join(" ")} wrote to a protected root: ${changed.join(", ")}`);
  }
  return result;
}

/** Run the CLI shipped INSIDE a fixture package root, so its own template facts apply. */
function cliAt(packageRoot, args, extraEnv = {}) {
  const before = snapshotIsolated();
  const result = spawnSync(process.execPath, [join(packageRoot, "dist", "index.js"), ...args], {
    cwd: workdir,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...isolation, ...extraEnv },
  });
  const after = snapshotIsolated();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => before[key] !== after[key]);
    for (const key of changed) console.log(`       ${key}: ${before[key] ?? "<missing>"} -> ${after[key] ?? "<missing>"}`);
    assert.fail(`fixture pj ${args.join(" ")} wrote to a protected root: ${changed.join(", ")}`);
  }
  return result;
}

function envelope(result) {
  assert.notEqual(result.stdout, "", "stdout was empty; a passing assertion on empty output proves nothing");
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { assert.fail(`stdout is not one complete JSON document (${result.stdout.length} bytes): ${error.message}`); }
  assert.equal(parsed.schema_version, 1, "envelope schema_version");
  return parsed;
}

function errorCode(parsed) {
  assert.equal(parsed.ok, false, `expected a failure envelope, got ok:true`);
  assert.equal(parsed.data, null, "a failure envelope must carry no data");
  return parsed.error.code;
}

/**
 * A successful status payload, with story 1.5's invariants checked on EVERY one.
 *
 * Checked here rather than in one case, for the reason story 1.4's review
 * recorded twice: an axis asserted in a single case is an axis that can go
 * missing on every other path and stay green.
 */
function status(result) {
  const parsed = envelope(result);
  assert.equal(parsed.ok, true, `expected ok:true, got ${JSON.stringify(parsed.error)}`);
  assert.equal(parsed.command, "fleet.status");
  for (const key of DATA_KEYS) assert.notEqual(parsed.data[key], undefined, `data.${key} must be present`);
  const data = parsed.data;

  assert.ok(VERDICTS.includes(data.health.verdict), `unknown verdict ${data.health.verdict}`);
  assert.ok(EXIT_CATEGORIES.includes(data.health.exit_category), `unknown exit category ${data.health.exit_category}`);
  assert.equal(typeof data.health.proven, "boolean");
  assert.deepEqual(Object.keys(data.health.members).sort(), [...MEMBER_CLASSES].sort());

  const everyObservation = [
    ...data.agents.flatMap((agent) => agent.observations),
    ...data.domains.flatMap((rollup) => rollup.observations),
  ];
  for (const observation of everyObservation) {
    assert.ok(APPLICABILITIES.includes(observation.applicability), `unknown applicability ${observation.applicability}`);
    assert.ok(EVIDENCE.includes(observation.evidence), `unknown evidence ${observation.evidence}`);
    assert.ok(FRESHNESS.includes(observation.freshness), `unknown freshness ${observation.freshness}`);
    assert.ok(SEVERITIES.includes(observation.severity), `unknown severity ${observation.severity}`);
    assert.ok(REPAIRS.includes(observation.repair), `unknown repair ${observation.repair}`);
    assert.ok(["read-only", "requires-authorization"].includes(observation.next_action_class));
    if (observation.state === "pass" || observation.state === "skip") continue;
    // AC7, on every non-pass, on every path.
    assert.ok(typeof observation.owner === "string" && observation.owner.length > 0,
      `${observation.domain}/${observation.field} is ${observation.state} and names no owner`);
    assert.ok(typeof observation.observed === "string" && observation.observed.length > 0,
      `${observation.domain}/${observation.field} carries no observed side`);
    assert.ok(typeof observation.desired === "string" && observation.desired.length > 0,
      `${observation.domain}/${observation.field} carries no desired side`);
    assert.ok(typeof observation.next_action === "string" && observation.next_action.length > 0,
      `${observation.domain}/${observation.field} names no next action`);
    // A recommended command is READ-ONLY unless it is labelled, and a labelled
    // one must name the authorization in the string itself.
    if (observation.next_action_class === "requires-authorization") {
      assert.match(observation.next_action, /bloodbank\.enabled/u,
        `a requires-authorization action must name the authorization: ${observation.next_action}`);
    }
  }
  for (const finding of data.host) {
    assert.ok(SEVERITIES.includes(finding.severity), `unknown host severity ${finding.severity}`);
    assert.ok(REPAIRS.includes(finding.repair), `unknown host repair ${finding.repair}`);
    if (finding.state === "pass" || finding.state === "skip") continue;
    assert.ok(typeof finding.owner === "string" && finding.owner.length > 0, `host ${finding.rule_id} names no owner`);
    assert.ok(typeof finding.next_action === "string" && finding.next_action.length > 0, `host ${finding.rule_id} names no next action`);
  }
  return data;
}

function agentNamed(data, id) {
  const found = data.agents.find((agent) => agent.agent_id === id);
  assert.ok(found, `agent ${id} must be in data.agents`);
  return found;
}

function observationsOf(data) {
  return [
    ...data.agents.flatMap((agent) => agent.observations),
    ...data.domains.flatMap((rollup) => rollup.observations),
  ];
}

// ---------------------------------------------------------------------------
// Contract variants: the only thing that can AUTHORIZE a gap
// ---------------------------------------------------------------------------

const TRACKED_TEXT = readFileSync(TRACKED_CONTRACT, "utf8");

function contractDocument() {
  return YAML.parse(TRACKED_TEXT);
}

function writeContract(name, document) {
  const path = join(temp, `contract-${name}.yaml`);
  writeFileSync(path, YAML.stringify(document, { lineWidth: 0 }), "utf8");
  return path;
}

/**
 * The two warnings this SYNTHETIC fleet raises that are properties of the
 * fixture rather than of the fleet.
 *
 * `hermes.fleet_env` and `fleet.registry_file` compare a row or a fleet file
 * against a value the host template config declares, and this fixture's config
 * declares neither. Authorizing them here is exactly what `allowed_warnings` is
 * for, and it is what makes the proven-clean case reachable at all -- the case
 * below then REMOVES one of them and asserts the verdict moves, so the
 * authorization is pinned by a delta rather than assumed.
 */
const FIXTURE_WARNINGS = [
  { rule_id: "hermes.fleet_env", reason: "This fixture declares no host-level fleet env pin to compare a row against.", owner: "hermes-agent-registry" },
  { rule_id: "fleet.registry_file", reason: "This fixture's template config declares no registry file to compare the fleet env against.", owner: "hermes-agent-registry" },
];

/** The tracked policy plus the fixture's own authorizations. */
function policyContract(mutate = () => {}) {
  const document = contractDocument();
  document.health_policy.allowed_warnings = [...document.health_policy.allowed_warnings, ...FIXTURE_WARNINGS];
  mutate(document);
  return document;
}

// ---------------------------------------------------------------------------
// Injected CLI entries: the documented PJ_FLEET_CLI_ENTRY observation seam
// ---------------------------------------------------------------------------

function entry(name, body) {
  const dir = join(shimRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "entry.mjs");
  writeFileSync(path, body, "utf8");
  return path;
}

const RECORD_PREAMBLE = `
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.argv[3] ?? "";
appendFileSync(join(HERE, "invocations"), REPO + "\\n");
`;

function invocationsOf(entryPath) {
  const file = join(entryPath.slice(0, entryPath.lastIndexOf("/")), "invocations");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function resetEntry(entryPath) {
  rmSync(join(entryPath.slice(0, entryPath.lastIndexOf("/")), "invocations"), { force: true });
}

function syntheticReport(rules) {
  return `${RECORD_PREAMBLE}
const rules = ${JSON.stringify(rules)};
const report = {
  repo: REPO,
  ok: rules.every((rule) => !(rule.status === "fail" && rule.scope !== "host")),
  hostOk: rules.every((rule) => rule.scope !== "host" || rule.status === "pass" || rule.status === "skip"),
  auditedAt: new Date().toISOString(),
  rules,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
process.exit(report.ok ? 0 : 1);
`;
}

const RULE = {
  scaffoldPass: { id: "hermes.pm-scaffold", title: "Scaffold parity", status: "pass", summary: "scaffold parity verified", details: [], fixable: true, scope: "project" },
  scaffoldFail: { id: "hermes.pm-scaffold", title: "Scaffold parity", status: "fail", summary: "18 orchestrator scaffold issue(s) detected", details: ["stale agents/hermes/pm/hermes"], fixable: true, scope: "project" },
  bindingPass: { id: "sot.project-json", title: "Project identity", status: "pass", summary: "identity parity verified", details: [], fixable: false, scope: "project" },
  profilePass: { id: "hermes.runtime-singleton", title: "Singleton runtime", status: "pass", summary: "singleton runtime contract satisfied", details: [], fixable: true, scope: "project" },
  runtimePass: { id: "hermes.untracked-runtimes", title: "Untracked runtimes", status: "pass", summary: "runtimes are untracked", details: [], fixable: true, scope: "project" },
  notebookSkip: { id: "notebook.remote-notebook", title: "Remote notebook", status: "skip", summary: "remote notebook was not observed", details: [], fixable: false, scope: "project" },
  bmadWarn: { id: "bmad.version", title: "BMAD currency", status: "warn", summary: "a newer BMAD release is published", details: [], fixable: false, scope: "project" },
  hostFail: { id: "hermes.profile-wiring", title: "Hermes profile wiring", status: "fail", summary: "the shared profile root is wired to the wrong home", details: [], fixable: false, scope: "host" },
};

/** Every audit-fed domain answered, so nothing is left `unobserved`. */
const CLEAN_RULES = [RULE.scaffoldPass, RULE.bindingPass, RULE.profilePass, RULE.runtimePass];

console.log("fleet health: four axes, one policy, one verdict a machine can act on");

try {
  if (!existsSync(CLI)) {
    skip("the whole suite", "dist/index.js is not built; run `npm run build` first");
    throw new SkipCase("unbuilt");
  }
  seedScratch();

  const cleanContract = writeContract("clean", policyContract());
  const cleanRoot = makePackageRoot("pkg-clean", readFileSync(cleanContract, "utf8"));
  const cleanShim = entry("clean", syntheticReport(CLEAN_RULES));

  // -- AC1 / AC2: the two verdicts are independent -------------------------

  check("a fully observed, fully authorized fleet is healthy, proven, and exit_category ok", () => {
    resetEntry(cleanShim);
    const result = cliAt(cleanRoot, ["fleet", "status", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim });
    assert.equal(result.status, 0, `a proven fleet must exit 0: ${result.stderr}`);
    const data = status(result);
    assert.equal(data.health.unobserved, 0, `nothing may be left unobserved: ${JSON.stringify(data.health)}`);
    assert.equal(data.health.healthy, true, "no observation may fail");
    assert.equal(data.health.complete, true);
    assert.equal(data.health.fleet_complete, true);
    assert.equal(data.health.unjustified, 0, "every non-pass must be authorized by the contract");
    assert.equal(data.health.stale, 0);
    assert.equal(data.health.verdict, "healthy");
    assert.equal(data.health.proven, true);
    assert.equal(data.health.exit_category, "ok");
    for (const observation of observationsOf(data)) {
      assert.notEqual(observation.applicability, undefined);
      assert.notEqual(observation.evidence, undefined);
      assert.notEqual(observation.freshness, undefined);
    }
  });

  check("removing ONE policy entry makes the fleet unproven and leaves health.healthy untouched", () => {
    // A DELTA against the case above, on the identical fleet: the only change is
    // one `allowed_warnings` entry. An absolute assertion here would be
    // satisfied by any of the fixture's other states.
    const provenData = (() => {
      resetEntry(cleanShim);
      return status(cliAt(cleanRoot, ["fleet", "status", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));
    })();

    const narrowed = writeContract("one-warning-removed", policyContract((document) => {
      document.health_policy.allowed_warnings = document.health_policy.allowed_warnings
        .filter((entryItem) => entryItem.rule_id !== "hermes.fleet_env");
    }));
    const narrowedRoot = makePackageRoot("pkg-one-warning-removed", readFileSync(narrowed, "utf8"));
    resetEntry(cleanShim);
    const data = status(cliAt(narrowedRoot, ["fleet", "status", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));

    assert.ok(data.health.unjustified >= 1, "the un-authorized warning must be counted as unjustified");
    assert.equal(data.health.proven, false, "an unjustified non-pass blocks proof");
    assert.equal(data.health.verdict, "unproven");
    assert.equal(data.health.exit_category, "incomplete");
    // THE POINT OF THE CASE: the two verdicts are independent.
    assert.equal(data.health.healthy, provenData.health.healthy, "health.healthy must be unchanged by an authorization change");
    assert.equal(data.health.healthy, true);
    assert.equal(data.health.failed, provenData.health.failed);
    const orphan = observationsOf(data).find((item) => item.rule_id === "hermes.fleet_env");
    assert.ok(orphan, "the warning must still be reported");
    assert.equal(orphan.justification, null, "and it must now carry no justification");
    assert.equal(orphan.severity, "medium", "an unjustified warn is medium where a justified one is low");
  });

  // -- AC3: a contract with no health_policy at all -------------------------

  check("a contract with no health_policy loads, validates, and authorizes nothing", () => {
    const bare = writeContract("no-policy", (() => {
      const document = contractDocument();
      delete document.health_policy;
      // Back to schema 1 as well: `health_policy` is a root key and a new root
      // key is a grammar change, so a contract without it is a schema-1
      // contract and must still load on this build.
      document.schema_version = 1;
      document.compatibility.max_schema_version = 1;
      return document;
    })());

    const validated = envelope(cli(["fleet", "contract", "validate", "--contract", bare, "--json"]));
    assert.equal(validated.ok, true, `a schema-1 contract must still validate: ${JSON.stringify(validated.error)}`);
    assert.equal(validated.data.schema_version, 1);

    const bareRoot = makePackageRoot("pkg-no-policy", readFileSync(bare, "utf8"));
    resetEntry(cleanShim);
    const data = status(cliAt(bareRoot, ["fleet", "status", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));
    assert.equal(data.health.proven, false, "a contract that authorizes nothing cannot produce a proven fleet");
    assert.ok(data.health.unjustified > 0, "every non-pass must be unjustified");
    for (const observation of observationsOf(data)) {
      if (!["warn", "skip", "unsupported"].includes(observation.state)) continue;
      assert.equal(observation.justification, null, `${observation.field} was justified by a contract that declares no policy`);
    }
    const finding = data.findings.find((item) => item.code === "health-policy-undeclared");
    assert.ok(finding, "a missing policy block must be named by a finding rather than failing the run");
    assert.match(finding.detail, /health_policy/u);
    assert.equal(finding.gating, true, "and it must be one of the reasons proof cannot be claimed");
  });

  // -- AC: deferred capabilities, declared and undeclared -------------------

  check("a contract-declared deferred capability is blocked, named, and does not reduce proof", () => {
    resetEntry(cleanShim);
    const data = status(cliAt(cleanRoot, ["fleet", "status", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));
    const systemd = agentNamed(data, "alpha-pm").observations.find((item) => item.domain === "systemd");
    assert.ok(systemd, "the systemd domain must still appear");
    assert.equal(systemd.state, "unsupported", "the state is unchanged; only the AUTHORIZATION is new");
    assert.equal(systemd.applicability, "deferred");
    assert.equal(systemd.evidence, "absent");
    assert.equal(systemd.repair, "blocked");
    assert.ok(systemd.justification, "a declared deferral must name the entry that authorizes it");
    assert.match(systemd.justification.policy, /^health_policy\.deferred_capabilities\[\d+\]$/u);
    assert.equal(systemd.justification.kind, "deferred_capability");
    assert.equal(systemd.justification.owner, "1.8", "the entry names the story that owns the observer");
    assert.match(systemd.next_action, /1\.8/u, "the next action must name the owning story");
    assert.equal(systemd.next_action_class, "read-only");
    assert.equal(systemd.severity, "low", "a justified unsupported is low");
    assert.equal(data.health.proven, true, "a declared deferral does not reduce proof");
  });

  check("the same capability with the policy entry removed is unjustified and blocks proof", () => {
    const stripped = writeContract("no-systemd-deferral", policyContract((document) => {
      document.health_policy.deferred_capabilities = document.health_policy.deferred_capabilities
        .filter((item) => item.domain !== "systemd");
    }));
    const strippedRoot = makePackageRoot("pkg-no-systemd-deferral", readFileSync(stripped, "utf8"));
    resetEntry(cleanShim);
    const data = status(cliAt(strippedRoot, ["fleet", "status", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: cleanShim }));
    const systemd = agentNamed(data, "alpha-pm").observations.find((item) => item.domain === "systemd");
    assert.equal(systemd.state, "unsupported", "the same observation, in the same state");
    assert.equal(systemd.justification, null, "and now authorized by nothing");
    assert.notEqual(systemd.applicability, "deferred");
    assert.notEqual(systemd.repair, "blocked", "nothing declares it blocked, so it is not");
    assert.equal(systemd.severity, "medium", "an unjustified unsupported outranks a justified one");
    assert.ok(data.health.unjustified >= 1);
    assert.equal(data.health.proven, false);
    assert.equal(data.health.verdict, "unproven");
  });

  // -- AC5: freshness is a bucket, and exactly one reading is stale ---------

  check("one stale board confirmation is one stale reading, and no age reaches data", () => {
    const agents = join(temp, "fresh-agents.yaml");
    const projects = join(temp, "fresh-projects.yaml");
    writeAgentRegistry(agents, SLUGS);
    // `beta`'s board was confirmed in the year 2000 against a 180-day window and
    // `alpha`'s at suite start: 26 years past the threshold and zero days short
    // of it. Neither is within a day of flipping, which is the constraint a
    // bucketed freshness axis imposes on its own fixtures.
    writeProjectRegistry(projects, SLUGS, (slug) => (slug === "beta" ? ANCIENT_ISO : NOW_ISO));
    const data = status(cli([
      "fleet", "status", "--json", "--contract", cleanContract,
      "--agent-registry", agents, "--project-registry", projects,
    ]));

    const stale = observationsOf(data).filter((item) => item.freshness === "stale");
    assert.equal(stale.length, 1, `exactly one reading must be stale, got ${stale.map((item) => `${item.agent_id}/${item.domain}`).join(", ")}`);
    assert.equal(stale[0].agent_id, "beta-pm");
    assert.equal(stale[0].domain, "project_binding");
    assert.equal(data.health.stale, 1);
    assert.equal(data.health.proven, false, "stale evidence cannot be proof");
    const alpha = agentNamed(data, "alpha-pm").observations
      .find((item) => item.domain === "project_binding" && item.source === "fleet-inventory");
    assert.equal(alpha.freshness, "current", "the agent inside the window must read current");

    // NO AGE, NO DURATION, NO TIMESTAMP. `data` has to be byte-identical across
    // two runs, and every one of those is what would break it.
    const serialized = JSON.stringify(data);
    assert.doesNotMatch(serialized, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u, "an ISO instant reached data");
    // Whole KEYS, not substrings: `"message"` contains `age` and `"package"`
    // contains it twice, and a scan that fires on either proves nothing about
    // determinism while making every future field name a hazard.
    assert.doesNotMatch(serialized, /"([a-z_]+_(ms|at|age|seconds)|age|duration|elapsed|timestamp|observed_at)":/u, "an age-shaped key reached data");

    const again = status(cli([
      "fleet", "status", "--json", "--contract", cleanContract,
      "--agent-registry", agents, "--project-registry", projects,
    ]));
    assert.deepEqual(again, data, "two runs over unchanged state must produce identical data");
    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  // -- AC4: four lifecycle values, and none of them claims activation -------

  check("a row declaring activation reports four separate lifecycle values and never routing-ready", () => {
    const agents = join(temp, "activated-agents.yaml");
    writeAgentRegistry(agents, SLUGS, (rows) => {
      rows["alpha-pm"].bloodbank = { enabled: true, gateway_scope: "fleet", target_agent_id: "alpha-pm" };
      // `beta` declares a routing record with NO activation flag at all, which
      // is the third value the pair `true`/`false` cannot express.
      rows["beta-pm"].bloodbank = { gateway_scope: "fleet", target_agent_id: "beta-pm" };
    });
    const data = status(cli(["fleet", "status", "--json", "--contract", cleanContract, "--agent-registry", agents]));

    const alpha = agentNamed(data, "alpha-pm");
    assert.deepEqual(Object.keys(alpha.lifecycle).sort(), ["activation", "capability_readiness", "desired_state", "observed_state"]);
    assert.equal(alpha.lifecycle.activation, "granted", "the strict flag is read verbatim");
    assert.equal(alpha.lifecycle.desired_state, "activated", "the registry declares the target");
    assert.equal(alpha.lifecycle.capability_readiness, "unproven", "nothing observed the gateway");
    assert.notEqual(alpha.lifecycle.capability_readiness, "ready");
    // NO FIELD MAY REPORT THE AGENT AS ROUTING-READY OR ACTIVATED. `desired_state`
    // is a statement of intent about the row; `observed_state` is the only field
    // that claims anything about the agent, and it cannot reach either state.
    assert.ok(!["routing_ready", "activated"].includes(alpha.lifecycle.observed_state),
      `observed_state claimed ${alpha.lifecycle.observed_state}`);

    const routing = alpha.observations.find((item) => item.domain === "bloodbank" && item.field === "agents.{agent_id}.bloodbank.gateway_scope");
    assert.ok(routing, "the routing record must be its own observation");
    assert.equal(routing.evidence, "declared", "a registry field nothing verified is declared evidence, never direct");

    const beta = agentNamed(data, "beta-pm");
    assert.equal(beta.lifecycle.activation, "undeclared");
    assert.equal(beta.lifecycle.desired_state, "routing_ready");
    const gate = beta.observations.find((item) => item.field === "agents.{agent_id}.bloodbank.enabled");
    assert.ok(gate, "the execution-authority field must be observed on its own");
    assert.equal(gate.state, "warn");
    assert.equal(gate.repair, "approval-gated", "the contract's own gate field decides the repair class");
    assert.equal(gate.next_action_class, "requires-authorization");
    assert.match(gate.next_action, /agents\.\{agent_id\}\.bloodbank\.enabled/u, "the action must name the authorization");
    assert.match(gate.next_action, /deny/u, "and the default it has to overcome");
    rmSync(agents, { force: true });
  });

  // -- AC6: a contradiction is recorded, never resolved ---------------------

  check("a store read that fails and an audit rule that passes on one field is a contradiction", () => {
    // `beta`'s profile directory is a symlink, which the contract declares
    // illegal and the store read proves. The audit rule for the same field
    // reports `pass`. Both readings are kept.
    const symlinked = join(scratchHome, ".hermes", "profiles", "beta-pm");
    const shared = join(scratchHome, ".hermes", "profiles", "shared-fixture");
    mkdirSync(shared, { recursive: true });
    rmSync(symlinked, { recursive: true, force: true });
    symlinkSync(shared, symlinked);
    try {
      const shim = entry("contradiction", syntheticReport([...CLEAN_RULES]));
      resetEntry(shim);
      const data = status(cli([
        "fleet", "status", "--live", "--json", "--contract", cleanContract, "--domain", "profile",
      ], { PJ_FLEET_CLI_ENTRY: shim }));

      const beta = agentNamed(data, "beta-pm");
      const readings = beta.observations.filter((item) => item.domain === "profile" && item.field === "agents.{agent_id}.profile_name");
      assert.equal(readings.length, 2, `both readings must be kept, got ${readings.length}`);
      assert.deepEqual([...new Set(readings.map((item) => item.state))].sort(), ["fail", "pass"]);
      assert.deepEqual([...new Set(readings.map((item) => item.source))].sort(), ["fleet-inventory", "recipe-audit"]);
      assert.equal(beta.domains.profile, "fail", "the worse state wins the rollup");

      const finding = data.findings.filter((item) => item.code === "status-contradiction");
      assert.equal(finding.length, 1, `exactly one contradiction finding, got ${finding.length}`);
      assert.equal(finding[0].agent_id, "beta-pm");
      assert.equal(finding[0].domain, "profile");
      assert.ok(typeof finding[0].source === "string" && finding[0].source.length > 0, "the finding must name its owner");
      assert.equal(data.health.contradictions, 1);
      assert.equal(data.health.complete, false, "a run that did not establish what is true is not complete");
      // Neither side is dropped and neither is chosen for being nicer.
      assert.ok(readings.some((item) => item.state === "pass"), "the favourable reading survives");
      assert.ok(readings.some((item) => item.state === "fail"), "and so does the unfavourable one");
    } finally {
      rmSync(symlinked, { force: true });
      mkdirSync(symlinked, { recursive: true });
      writeFileSync(join(symlinked, "config.yaml"), "# GENERATED FILE -- DO NOT EDIT\nname: x\n", "utf8");
      rmSync(shared, { recursive: true, force: true });
    }
  });

  // -- AC8: the repair class is read off real fields ------------------------

  check("a fixable project rule repairs automatically; a host rule routes to the host", () => {
    const shim = entry("repairs", syntheticReport([RULE.scaffoldFail, RULE.bindingPass, RULE.profilePass, RULE.runtimePass, RULE.hostFail]));
    resetEntry(shim);
    const data = status(cli(["fleet", "status", "--live", "--json", "--contract", cleanContract], { PJ_FLEET_CLI_ENTRY: shim }));

    const fixable = agentNamed(data, "alpha-pm").observations.find((item) => item.rule_id === "hermes.pm-scaffold");
    assert.ok(fixable, "the failing rule must be reported");
    assert.equal(fixable.repair, "automatic", "a fixable project rule has a migration recipe");
    assert.equal(fixable.next_action_class, "read-only");
    // The EXACT invocation, addressed by rule id and repository, and a dry run:
    // a next action a caller may run unread has to change nothing.
    assert.match(fixable.next_action, /^pjangler migrate hermes\.pm-scaffold \S+ --dry-run$/u,
      `next action must be the exact migrate invocation, got ${fixable.next_action}`);
    // The repository, home-redacted like every other path in `data` -- so the
    // assertion is on the suffix, never on an absolute path this suite cannot
    // predict (TMPDIR can itself live under the operator's home, and then the
    // whole prefix collapses to `~`).
    assert.ok(fixable.next_action.endsWith(`${join("repos", "alpha")} --dry-run`),
      `the action must name the repository the rule ran in: ${fixable.next_action}`);

    const host = data.host.find((item) => item.rule_id === "hermes.profile-wiring");
    assert.ok(host, "the host-scoped rule must reach data.host");
    assert.equal(host.repair, "other-owner", "no work in any repository changes a condition about this machine");
    assert.equal(host.next_action_class, "read-only");
    assert.equal(host.next_action.includes(reposRoot), false, "a host action must not route to a repository");
    assert.ok(typeof host.owner === "string" && host.owner.length > 0);
    // And it is in NEITHER verdict.
    for (const agent of data.agents) {
      assert.equal(agent.observations.some((item) => item.rule_id === "hermes.profile-wiring"), false,
        `${agent.agent_id} must not carry a host-scoped rule result`);
    }
  });

  check("an authorized skip is info and none; an unauthorized one is low and manual", () => {
    const shim = entry("skips", syntheticReport([...CLEAN_RULES, RULE.notebookSkip]));
    resetEntry(shim);
    const authorized = status(cli(["fleet", "status", "--live", "--json", "--contract", cleanContract], { PJ_FLEET_CLI_ENTRY: shim }));
    const allowed = observationsOf(authorized).find((item) => item.rule_id === "notebook.remote-notebook");
    assert.ok(allowed, "the skip must be reported");
    assert.equal(allowed.state, "skip");
    // Both readings are `not_applicable` -- that is what a skip MEANS, and the
    // axis says nothing about who authorized it. The authorization lives in
    // `justification`, and it is what moves the severity and the repair class.
    assert.equal(allowed.applicability, "not_applicable");
    assert.equal(allowed.justification?.kind, "allowed_skip");
    assert.match(allowed.justification.policy, /^health_policy\.allowed_skips\[\d+\]$/u);
    assert.equal(allowed.severity, "info");
    assert.equal(allowed.repair, "none");

    const stripped = writeContract("no-skip-allowance", policyContract((document) => {
      document.health_policy.allowed_skips = document.health_policy.allowed_skips
        .filter((item) => item.rule_id !== "notebook.remote-notebook");
    }));
    resetEntry(shim);
    const unauthorized = status(cli(["fleet", "status", "--live", "--json", "--contract", stripped], { PJ_FLEET_CLI_ENTRY: shim }));
    const orphan = observationsOf(unauthorized).find((item) => item.rule_id === "notebook.remote-notebook");
    assert.equal(orphan.state, "skip", "the state is identical; only the authorization moved");
    assert.equal(orphan.justification, null);
    assert.equal(orphan.applicability, "not_applicable");
    assert.equal(orphan.severity, "low");
    assert.equal(orphan.repair, "manual");
    assert.ok(unauthorized.health.unjustified > authorized.health.unjustified, "and the count must move with it");
  });

  // -- AC9: the sort ranks by priority, before every cap --------------------

  check("one gating finding among many low-severity ones survives both caps", () => {
    // Forty rules no domain table has heard of, each raising its own
    // `audit-rule-unmapped` (warn, medium, not gating), plus one contradiction
    // that IS gating -- produced last, by a symlinked profile whose audit half
    // reports pass, so arrival order buries it exactly where the report's cap
    // of 25 would drop it.
    const noisy = Array.from({ length: 40 }, (unused, index) => ({
      id: `zz.invented-${String(index).padStart(3, "0")}`,
      title: "an invented rule", status: "pass", summary: `invented rule ${index}`,
      details: [], fixable: false, scope: "project",
    }));
    const symlinked = join(scratchHome, ".hermes", "profiles", "beta-pm");
    const shared = join(scratchHome, ".hermes", "profiles", "shared-sort");
    mkdirSync(shared, { recursive: true });
    rmSync(symlinked, { recursive: true, force: true });
    symlinkSync(shared, symlinked);
    try {
      const shim = entry("sort", syntheticReport([...CLEAN_RULES, ...noisy]));
      resetEntry(shim);
      const args = ["fleet", "status", "--live", "--json", "--contract", cleanContract];
      const data = status(cli(args, { PJ_FLEET_CLI_ENTRY: shim }));
      assert.ok(data.findings.length > 25, `the fixture must exceed the report's finding cap, got ${data.findings.length}`);

      const gating = data.findings.filter((item) => item.gating);
      assert.ok(gating.length >= 1, "the fixture must produce at least one gating finding");
      const firstGating = data.findings.findIndex((item) => item.gating);
      assert.equal(firstGating, 0, "every gating finding must sort ahead of every non-gating one");
      assert.equal(data.findings.slice(0, gating.length).every((item) => item.gating), true);
      // Severity never increases down the list, within a gating band.
      const rank = (severity) => SEVERITIES.indexOf(severity);
      for (let index = 1; index < data.findings.length; index += 1) {
        const previous = data.findings[index - 1];
        const current = data.findings[index];
        if (previous.gating !== current.gating) continue;
        assert.ok(rank(previous.status_severity) <= rank(current.status_severity),
          `findings are out of severity order at ${index}: ${previous.status_severity} then ${current.status_severity}`);
      }
      // TOTAL, so both adapters agree: two findings that tie on every other axis
      // still order by `finding_id`.
      assert.equal(new Set(data.findings.map((item) => item.finding_id)).size, data.findings.length,
        "every finding id must be unique or the sort is not total");

      // THE HUMAN PATH APPLIES THE SORT BEFORE ITS CAP.
      const report = cli(args.filter((item) => item !== "--json"), { PJ_FLEET_CLI_ENTRY: shim });
      assert.equal(report.status, 0);
      const findingsBlock = report.stdout.slice(report.stdout.indexOf("▸ Findings"));
      assert.ok(findingsBlock.length > 0, "the report must have a findings block");
      assert.ok(findingsBlock.includes(gating[0].code), `the gating finding ${gating[0].code} was dropped by the report's cap`);
      assert.ok(findingsBlock.includes("more finding(s)"), "the fixture must actually engage the report's cap");

      // The observation block is ranked by the same comparator, so the one
      // `critical` reading is visible among the low-severity crowd.
      const priority = report.stdout.slice(
        report.stdout.indexOf("▸ Highest-priority observations"),
        report.stdout.indexOf("▸ Findings"),
      );
      assert.ok(priority.includes("beta-pm · profile"), "the proven profile failure must lead the observation block");
      assert.ok(priority.includes("critical"), "and it must be shown with its severity");
    } finally {
      rmSync(symlinked, { force: true });
      mkdirSync(symlinked, { recursive: true });
      writeFileSync(join(symlinked, "config.yaml"), "# GENERATED FILE -- DO NOT EDIT\nname: x\n", "utf8");
      rmSync(shared, { recursive: true, force: true });
    }
  });

  // -- AC10: six member buckets, over the SELECTION -------------------------

  check("every selected agent lands in exactly one member bucket, summing to the selection", () => {
    const shim = entry("members", syntheticReport([RULE.scaffoldFail, RULE.bindingPass, RULE.profilePass, RULE.runtimePass]));
    resetEntry(shim);
    const data = status(cli(["fleet", "status", "--live", "--json", "--contract", cleanContract], { PJ_FLEET_CLI_ENTRY: shim }));
    const total = Object.values(data.health.members).reduce((sum, count) => sum + count, 0);
    assert.equal(total, data.scope.selected_agents, "the six counts must sum to the SELECTED agents");
    assert.equal(total, data.agents.length);
    for (const agent of data.agents) {
      assert.ok(MEMBER_CLASSES.includes(agent.member_class), `unknown member class ${agent.member_class}`);
      assert.equal(data.health.members[agent.member_class] >= 1, true);
    }
    assert.ok(data.health.members.unhealthy >= 1, "a failing rule must put its agent in the unhealthy bucket");
  });

  check("a fleet clipped past the agent cap produces the same six counts as one under it", () => {
    // The cap is 500 records. 520 rows means 20 are never emitted -- and the
    // member counts must still describe all 520, which is the exact defect
    // story 1.4's review found twice on `by_state` and `health`.
    const slugs = Array.from({ length: 520 }, (unused, index) => `cap${String(index).padStart(4, "0")}`);
    const agents = join(temp, "cap-agents.yaml");
    const projects = join(temp, "cap-projects.yaml");
    const rows = {};
    for (const slug of slugs) rows[`${slug}-pm`] = agentRow(slug);
    writeFileSync(agents, YAML.stringify({ schema_version: 1, agents: rows }), "utf8");
    writeProjectRegistry(projects, slugs);

    const args = ["fleet", "status", "--json", "--domain", "registry", "--contract", cleanContract, "--agent-registry", agents, "--project-registry", projects];
    const clipped = status(cli(args));
    assert.equal(clipped.totals.agents, slugs.length, "every row must be counted");
    assert.ok(clipped.totals.emitted_agents < clipped.totals.agents, "the fixture must actually engage the agent cap");
    const total = Object.values(clipped.health.members).reduce((sum, count) => sum + count, 0);
    assert.equal(total, slugs.length, `the members must sum to every SELECTED agent, got ${total}`);
    assert.equal(clipped.scope.selected_agents, slugs.length);
    rmSync(agents, { force: true });
    rmSync(projects, { force: true });
  });

  // -- AC11: baseline correlation -------------------------------------------

  check("--baseline names every transition kind and says nothing about what did not move", () => {
    const baseAgents = join(temp, "diff-base-agents.yaml");
    const baseProjects = join(temp, "diff-base-projects.yaml");
    const nextAgents = join(temp, "diff-next-agents.yaml");
    const nextProjects = join(temp, "diff-next-projects.yaml");
    makeRepo(reposRoot, "gamma");
    makeRepo(reposRoot, "delta");
    mkdirSync(join(scratchHome, ".hermes", "profiles", "gamma-pm"), { recursive: true });
    mkdirSync(join(scratchHome, ".hermes", "profiles", "delta-pm"), { recursive: true });

    // BEFORE: alpha, beta, gamma. AFTER: alpha, beta, delta -- gamma leaves,
    // delta arrives, and `beta` acquires an identity conflict with `alpha`,
    // which moves its registry observation's state, severity AND evidence
    // (a conflict is computed across rows, so the reading becomes derived).
    writeAgentRegistry(baseAgents, ["alpha", "beta", "gamma"]);
    writeProjectRegistry(baseProjects, ["alpha", "beta", "gamma"]);
    writeAgentRegistry(nextAgents, ["alpha", "beta", "delta"], (rows) => { rows["beta-pm"].repo = "alpha"; });
    writeProjectRegistry(nextProjects, ["alpha", "beta", "delta"]);

    const baseArgs = ["fleet", "status", "--json", "--contract", cleanContract, "--agent-registry", baseAgents, "--project-registry", baseProjects];
    const baseline = join(temp, "diff-baseline.json");
    const baseResult = cli(baseArgs);
    status(baseResult);
    writeFileSync(baseline, baseResult.stdout, "utf8");

    const identical = status(cli([...baseArgs, "--baseline", baseline]));
    assert.deepEqual(identical.transitions, [], "a byte-identical baseline must produce no transitions");

    const nextArgs = ["fleet", "status", "--json", "--contract", cleanContract, "--agent-registry", nextAgents, "--project-registry", nextProjects, "--baseline", baseline];
    const data = status(cli(nextArgs));
    const kinds = new Set(data.transitions.map((item) => item.kind));
    for (const kind of TRANSITION_KINDS) {
      assert.ok(kinds.has(kind), `no ${kind} transition was reported; got ${[...kinds].sort().join(", ")}`);
    }
    for (const transition of data.transitions) {
      assert.match(transition.finding_id, /^[0-9a-f]{12}$/u, "a transition is joined on a stable finding id");
      if (transition.kind === "appeared") assert.equal(transition.from, null);
      if (transition.kind === "resolved") assert.equal(transition.to, null);
    }
    assert.ok(data.transitions.some((item) => item.kind === "appeared" && item.agent_id === "delta-pm"));
    assert.ok(data.transitions.some((item) => item.kind === "resolved" && item.agent_id === "gamma-pm"));

    // UNCHANGED FINDINGS EMIT NOTHING, and carry the same id on both sides.
    const baseDoc = JSON.parse(readFileSync(baseline, "utf8")).data;
    const baseAlpha = baseDoc.agents.find((agent) => agent.agent_id === "alpha-pm").observations
      .filter((item) => item.domain === "live_process").map((item) => item.finding_id);
    const nextAlpha = agentNamed(data, "alpha-pm").observations
      .filter((item) => item.domain === "live_process").map((item) => item.finding_id);
    assert.deepEqual(nextAlpha, baseAlpha, "an unchanged observation keeps its id");
    assert.ok(baseAlpha.length > 0);
    const moved = new Set(data.transitions.map((item) => item.finding_id));
    for (const id of nextAlpha) assert.equal(moved.has(id), false, `${id} did not change and must emit no transition`);

    rmSync(join(reposRoot, "gamma"), { recursive: true, force: true });
    rmSync(join(reposRoot, "delta"), { recursive: true, force: true });
    rmSync(join(scratchHome, ".hermes", "profiles", "gamma-pm"), { recursive: true, force: true });
    rmSync(join(scratchHome, ".hermes", "profiles", "delta-pm"), { recursive: true, force: true });
    for (const path of [baseAgents, baseProjects, nextAgents, nextProjects, baseline]) rmSync(path, { force: true });
  });

  check("an unreadable or unparseable baseline is INVALID_INPUT at exit 2, before anything spawns", () => {
    const shim = entry("baseline-guard", syntheticReport(CLEAN_RULES));
    resetEntry(shim);
    const missing = cli(["fleet", "status", "--live", "--json", "--baseline", join(temp, "no-such-baseline.json")], { PJ_FLEET_CLI_ENTRY: shim });
    const parsed = envelope(missing);
    assert.equal(errorCode(parsed), "INVALID_INPUT");
    assert.equal(missing.status, 2, `expected exit 2, got ${missing.status}`);
    assert.ok(JSON.stringify(parsed.error.details).includes("no-such-baseline.json"), "the error must name the path");
    assert.deepEqual(invocationsOf(shim), [], "no audit child may spawn before the flag is validated");

    const garbage = join(temp, "baseline-garbage.json");
    writeFileSync(garbage, "not json at all\n", "utf8");
    resetEntry(shim);
    const bad = cli(["fleet", "status", "--live", "--json", "--baseline", garbage], { PJ_FLEET_CLI_ENTRY: shim });
    assert.equal(errorCode(envelope(bad)), "INVALID_INPUT");
    assert.equal(bad.status, 2);
    assert.deepEqual(invocationsOf(shim), [], "an unparseable baseline must be refused before collection too");

    const wrongShape = join(temp, "baseline-wrong-shape.json");
    writeFileSync(wrongShape, JSON.stringify({ hello: "world" }), "utf8");
    const shaped = cli(["fleet", "status", "--json", "--baseline", wrongShape]);
    assert.equal(errorCode(envelope(shaped)), "INVALID_INPUT");
    assert.equal(shaped.status, 2, "valid JSON that is not a status document is still not a baseline");

    assert.equal(errorCode(envelope(cli(["fleet", "status", "--json", "--baseline", ""]))), "INVALID_INPUT");
    assert.equal(errorCode(envelope(cli(["fleet", "status", "--json", "--baseline", "--json"]))), "INVALID_INPUT");
    for (const path of [garbage, wrongShape]) rmSync(path, { force: true });
  });

  // -- AC12: the exit taxonomy is opt-in ------------------------------------

  check("--exit-code projects the category; without it every collected result is 0", () => {
    const failingShim = entry("exit-unhealthy", syntheticReport([RULE.scaffoldFail, RULE.bindingPass, RULE.profilePass, RULE.runtimePass]));
    resetEntry(failingShim);
    const unhealthy = cliAt(cleanRoot, ["fleet", "status", "--live", "--json", "--exit-code"], { PJ_FLEET_CLI_ENTRY: failingShim });
    const unhealthyData = status(unhealthy);
    assert.equal(unhealthyData.health.verdict, "unhealthy");
    assert.equal(unhealthy.status, EXIT_CODES.unhealthy, `an unhealthy verdict must exit ${EXIT_CODES.unhealthy}`);
    assert.equal(JSON.parse(unhealthy.stdout).ok, true, "and the envelope must stay ok:true with complete data");

    resetEntry(failingShim);
    const unhealthyDefault = cliAt(cleanRoot, ["fleet", "status", "--live", "--json"], { PJ_FLEET_CLI_ENTRY: failingShim });
    assert.equal(unhealthyDefault.status, 0, "without --exit-code the same run exits 0");
    assert.equal(status(unhealthyDefault).health.exit_category, "unhealthy", "and still carries the discriminant");

    // A default run leaves the audit half unread, which is `unproven` rather
    // than `unhealthy` only when nothing has been PROVEN wrong -- so the fleet
    // this uses is the clean one, read without --live.
    const unproven = cliAt(cleanRoot, ["fleet", "status", "--json", "--exit-code"]);
    const unprovenData = status(unproven);
    assert.equal(unprovenData.health.healthy, true, "nothing is proven wrong on this fleet");
    assert.equal(unprovenData.health.verdict, "unproven");
    assert.equal(unproven.status, EXIT_CODES.incomplete, `an unproven verdict must exit ${EXIT_CODES.incomplete}`);
    assert.equal(JSON.parse(unproven.stdout).ok, true);

    const unprovenDefault = cliAt(cleanRoot, ["fleet", "status", "--json"]);
    assert.equal(unprovenDefault.status, 0);
    assert.equal(status(unprovenDefault).health.exit_category, "incomplete");

    resetEntry(cleanShim);
    const ok = cliAt(cleanRoot, ["fleet", "status", "--live", "--json", "--exit-code"], { PJ_FLEET_CLI_ENTRY: cleanShim });
    assert.equal(status(ok).health.exit_category, "ok");
    assert.equal(ok.status, EXIT_CODES.ok, "a proven fleet exits 0 with or without the flag");

    // A COMMAND failure still wins: an unknown agent is exit 3, never 10 or 11.
    const notFound = cliAt(cleanRoot, ["fleet", "status", "--json", "--exit-code", "--agent", "definitely-not-registered"]);
    assert.equal(errorCode(envelope(notFound)), "NOT_FOUND");
    assert.equal(notFound.status, 3, "an unreadable request is not an unhealthy fleet and must not share its band");
  });

  // -- AC13: the two adapters agree, on the id the diff joins on ------------

  await checkAsync("finding ids are identical on the CLI and the MCP adapter", async () => {
    // Imported lazily: the SDK is a dev dependency and this is the only case
    // that needs it, so an environment without it fails HERE rather than
    // preventing the other nineteen cases from running at all.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const env = { ...process.env, ...isolation };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "dist", "mcp-server.js")], cwd: workdir, env });
    const client = new Client({ name: "fleet-health-suite", version: "1.0.0" });
    await client.connect(transport);
    try {
      const called = await client.callTool({ name: "pjangler_fleet_status", arguments: { contract: cleanContract, exitCode: true } });
      const mcp = JSON.parse(called.content.map((item) => (item.type === "text" ? item.text : "")).join(""));
      const cliRun = JSON.parse(cli(["fleet", "status", "--json", "--contract", cleanContract]).stdout);
      assert.equal(mcp.ok, true, `MCP must succeed: ${JSON.stringify(mcp.error)}`);
      assert.deepEqual(mcp.data, cliRun.data, "data must deep-equal across the two adapters");
      assert.equal(mcp.data.health.exit_category, cliRun.data.health.exit_category);
      const ids = (payload) => payload.agents.flatMap((agent) => agent.observations.map((item) => item.finding_id));
      assert.ok(ids(mcp.data).length > 0);
      assert.deepEqual(ids(mcp.data), ids(cliRun.data), "every finding_id must match");
    } finally {
      await client.close();
    }
  });

  // -- The gates that make this reachable on a fresh clone ------------------

  check("the suite, the README and the mise task all know about story 1.5", () => {
    const runner = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
    assert.match(runner, /tests\/fleet-health-regressions\.mjs/u, "a suite not listed in SUITES never runs");

    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const from = readme.indexOf("## Fleet status");
    const to = readme.indexOf("## Orienting in a repo");
    assert.ok(from >= 0 && to > from, "the README must still document fleet status");
    const section = readme.slice(from, to);
    for (const axis of ["applicability", "evidence", "freshness", "severity"]) {
      assert.ok(section.includes(axis), `the README must name the ${axis} axis`);
    }
    for (const verdict of VERDICTS) assert.ok(section.includes(`\`${verdict}\``), `the README must name the ${verdict} verdict`);
    for (const repair of REPAIRS) assert.ok(section.includes(`\`${repair}\``), `the README must name the ${repair} repair class`);
    for (const kind of TRANSITION_KINDS) assert.ok(section.includes(`\`${kind}\``), `the README must name the ${kind} transition`);
    assert.match(section, /--exit-code/u, "the README must document the exit projection");
    assert.match(section, /--baseline/u, "the README must document the baseline flag");
    assert.match(section, /health_policy/u, "the README must document what authorizes a gap");
    assert.match(readme, /`baseline`/u, "the MCP inputs must be documented");

    const mise = readFileSync(join(ROOT, "mise.toml"), "utf8");
    const task = mise.slice(mise.indexOf('[tasks."fleet:status"]') - 700, mise.indexOf('[tasks."fleet:status"]') + 400);
    assert.match(task, /--exit-code/u, "the fleet:status comment must name the opt-in exit projection");
    assert.match(task, /still exits 0/u, "and must keep stating that the default exits 0");
  });

  check("every declared vocabulary is exported and spelled the same in source", () => {
    const types = readFileSync(join(ROOT, "src", "fleet", "types.ts"), "utf8");
    const declared = (name) => {
      const match = new RegExp(`${name} = \\[([^\\]]+)\\]`, "u").exec(types);
      assert.ok(match, `${name} must be declared as a list`);
      return match[1].split(",").map((item) => item.trim().replace(/"/gu, "")).filter(Boolean);
    };
    assert.deepEqual(declared("FLEET_STATUS_APPLICABILITIES"), APPLICABILITIES);
    assert.deepEqual(declared("FLEET_STATUS_EVIDENCE"), EVIDENCE);
    assert.deepEqual(declared("FLEET_STATUS_FRESHNESS"), FRESHNESS);
    assert.deepEqual(declared("FLEET_STATUS_SEVERITIES"), SEVERITIES);
    assert.deepEqual(declared("FLEET_STATUS_SEVERITY_PRECEDENCE"), SEVERITIES);
    assert.deepEqual(declared("FLEET_STATUS_REPAIRS"), REPAIRS);
    assert.deepEqual(declared("FLEET_STATUS_VERDICTS"), VERDICTS);
    assert.deepEqual(declared("FLEET_STATUS_EXIT_CATEGORIES"), EXIT_CATEGORIES);
    assert.deepEqual(declared("FLEET_STATUS_MEMBER_CLASSES"), MEMBER_CLASSES);
    assert.deepEqual(declared("FLEET_STATUS_TRANSITION_KINDS"), TRANSITION_KINDS);

    // A PRECEDENCE CONSTANT NOTHING ITERATES IS DECORATION -- the exact defect
    // story 1.3's review found in FLEET_PROVENANCE_STATUS_PRECEDENCE.
    const health = readFileSync(join(ROOT, "src", "fleet", "health.ts"), "utf8");
    assert.match(health, /FLEET_STATUS_SEVERITY_PRECEDENCE as readonly FleetStatusSeverity\[\]\)\.indexOf/u,
      "compareStatusFindings must rank by iterating the declared severity precedence");
    assert.match(health, /for \(const member of FLEET_STATUS_MEMBER_PRECEDENCE\)/u,
      "classifyMember must resolve by walking the declared member precedence");
    assert.match(health, /for \(const bucket of FRESHNESS_PRECEDENCE\)/u,
      "the freshness fold must walk its declared precedence");
  });

  check("the deferred-work ledger records what this story leaves behind", () => {
    const ledger = readFileSync(join(ROOT, "_bmad-output", "implementation-artifacts", "deferred-work.md"), "utf8");
    assert.match(ledger, /spec-1-5-make-partial-health-truthful-and-actionable/u, "the ledger must name this story's spec as a source");
    assert.match(ledger, /health_policy/u, "and record what the policy block does and does not authorize");
  });
} catch (error) {
  if (!(error instanceof SkipCase)) throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(shimRoot, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} fleet health check(s) failed`);
  process.exit(1);
}
console.log(`fleet health regressions passed${skipped ? ` (${skipped} skipped)` : ""}`);
