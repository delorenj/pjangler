import "./helpers/hermetic-suite.mjs";
// PJAN-208: a newer upstream BMAD stable must not break `pj init` for a project
// that is AT the verified installer pin.
//
// The failure was real but not where the ticket guessed. A fresh `pj init <name>`
// never read the dist-tags (the create transaction pins bmad.version to the
// installer pin), and a `warn` has not gated a project since PJAN-84. What broke
// was every `pj init` over an EXISTING project, including one created a minute
// earlier: with npm stable ahead of the pin, bmad.version reported a fixable
// `warn` ("behind stable"), `pj init -y` migrates every fixable non-pass finding,
// the unpinned migrate targets the dist-tag, and so init installed an
// UNVERIFIED stable over the pin and then failed its own postcondition audit
// (bmad.setup-scripts cannot attest the pinned scripts, bmad.cli-roots and
// skills.project-manifest drift). Every pin bump cured it only until upstream's
// next release.
//
// The hermetic suites never saw it because they seed the dist-tags cache with
// `latest == next == pin`, i.e. the one world in which no stable is ahead. This
// suite seeds a stable that IS ahead (derived from the pin, so it cannot rot
// when the pin moves). The real registry and the real installer are covered by
// the network contract, tests/bmad-installer-contract-regressions.mjs.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  BMAD_INSTALLER_FIXTURE_VERSION as PIN,
  createBmadInstallerFixture,
  createSkillPackFixture,
  createSkillexMiseFixture,
} from "./helpers/pack-fixture.mjs";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const scratch = hermeticScratch("pjan-208-pin-currency-");
let failures = 0;

// Derived from the production pin: three patch releases ahead is "a newer stable
// exists", whatever the pin is today. A stale `next` below it mirrors upstream,
// which leaves `next` on the last prerelease after cutting the release.
const [major, minor, patch] = PIN.split(".").map((part) => Number.parseInt(part, 10));
const NEWER_STABLE = `${major}.${minor}.${patch + 3}`;
const OLDER_THAN_PIN = "6.0.0";

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message}`);
  }
}

function executable(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

/** One isolated machine: its own HOME, dist-tags cache, skill catalog and installer. */
function machine(name, { installer = "logging" } = {}) {
  const base = join(scratch, name);
  const home = join(base, "home");
  const catalog = join(base, "catalog");
  const registry = join(base, "registry.yaml");
  const installLog = join(base, "installer.log");
  mkdirSync(join(home, ".cache", "pjangler"), { recursive: true });
  // Upstream has moved ahead of the pin: `latest` is newer, `next` lags it.
  writeFileSync(
    join(home, ".cache", "pjangler", "bmad-dist-tags.json"),
    JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: NEWER_STABLE, next: `${major}.${minor}.${patch + 1}-next.1` } }),
  );
  createSkillPackFixture(catalog);
  const fixture = createBmadInstallerFixture(catalog);
  // The fixture installs the pin. The wrapper records every install it is asked
  // for, and `landing-elsewhere` lands the manifest on another version, which is
  // what an installer that does not deliver the pin looks like.
  const wrapper = join(base, "bin", "bmad-method-wrapper");
  executable(wrapper, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "install") appendFileSync(${JSON.stringify(installLog)}, args.join(" ") + "\\n");
const run = spawnSync(${JSON.stringify(fixture)}, args, { encoding: "utf8" });
if (run.status === 0 && args[0] === "install" && ${JSON.stringify(installer)} === "landing-elsewhere") {
  const manifest = join(args[args.indexOf("--directory") + 1], "_bmad", "_config", "manifest.yaml");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/(installation:\\s*\\n\\s*version:)\\s*\\S+/, "$1 ${OLDER_THAN_PIN}"));
}
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
`);
  const env = hermeticEnv({
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(base, "state"),
    PATH: `${createSkillexMiseFixture(base)}:${process.env.PATH}`,
    SKILLEX_REGISTRY_ROOT: catalog,
    PJ_SKILLS_REGISTRY_ROOT: catalog,
    PJ_BMAD_INSTALLER: wrapper,
    GIT_CEILING_DIRECTORIES: scratch,
  });
  const cli = (args, cwd = base) => spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const installs = () => (existsSync(installLog) ? readFileSync(installLog, "utf8").split("\n").filter(Boolean) : []);
  return { base, registry, cli, installs };
}

function json(run, what) {
  assert.ok(run.stdout.trim(), `${what} printed no JSON\nstderr: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

const manifestPath = (target) => join(target, "_bmad", "_config", "manifest.yaml");
const installedVersion = (target) => readFileSync(manifestPath(target), "utf8").match(/installation:\s*\n\s*version:\s*(\S+)/)?.[1];
const bmadVersion = (report) => report.rules.find((rule) => rule.id === "bmad.version");

console.log("pjan-208 BMAD pin currency");
try {
  assert.ok(existsSync(CLI), `${CLI} is missing; run npm run build`);
  console.log(`  pin ${PIN}; seeded upstream stable ${NEWER_STABLE} (newer), next ${major}.${minor}.${patch + 1}-next.1 (stale)`);

  const m = machine("at-pin");
  const target = join(m.base, "Pin Currency Project");
  const common = ["--registry", m.registry, "--skip-board", "--apply", "--yes", "--no-tui", "--json"];

  check("fresh `pj init <name>` succeeds with a newer stable published", () => {
    const run = m.cli(["init", "pin-currency", "--target-dir", target, ...common]);
    const result = json(run, "create init");
    assert.equal(run.status, 0, `create init failed: ${JSON.stringify(result.errors)}`);
    assert.equal(result.mode, "create");
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(installedVersion(target), PIN, "a fresh project carries the verified pin, not the newer stable");
    assert.equal(m.installs().length, 1, `exactly one installer run for a fresh init: ${m.installs()}`);
  });

  check("an unpinned audit of that project reports the newer stable as an advisory pass", () => {
    const run = m.cli(["audit", target, "--registry", m.registry, "--rules", "bmad.version", "--json"]);
    assert.equal(run.status, 0, `audit must not fail the project: ${run.stdout}${run.stderr}`);
    const finding = bmadVersion(json(run, "audit"));
    assert.equal(finding.status, "pass", JSON.stringify(finding));
    assert.equal(finding.fixable, false, "an upstream release is news, not a fixable defect");
    assert.match(finding.summary, new RegExp(`matches the verified installer pin.*stable ${NEWER_STABLE.replaceAll(".", "\\.")} is newer`), finding.summary);
    assert.ok(finding.details.includes(`verified installer pin: ${PIN}`), `the pin stays visible: ${JSON.stringify(finding)}`);
    assert.ok(finding.details.includes(`stable latest: ${NEWER_STABLE}`), `the newer stable stays visible: ${JSON.stringify(finding)}`);
  });

  check("`pj init` over the existing project succeeds, keeps the pin, and runs no installer", () => {
    const before = m.installs().length;
    const run = m.cli(["init", "--target-dir", target, ...common]);
    const result = json(run, "sync init");
    assert.equal(result.mode, "sync");
    assert.equal(run.status, 0, `sync init failed on an upstream release: ${JSON.stringify(result.errors)}`);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(
      !result.selectedParityRules.includes("bmad.version"),
      `init must not select an upstream-currency advisory for migration: ${JSON.stringify(result.selectedParityRules)}`,
    );
    assert.ok(
      !result.phases.some((phase) => phase.id === "bmad.version"),
      "init must not run the bmad.version migration for a project at the pin",
    );
    assert.equal(m.installs().length, before, `init must not install the newer stable over the pin: ${m.installs().slice(before)}`);
    assert.equal(installedVersion(target), PIN, "the project stays at the verified pin");
    assert.equal(bmadVersion(result.audit).status, "pass", "the postcondition audit sees the advisory pass");
  });

  check("an explicit `pj migrate bmad.version` can still take the newer stable", () => {
    const run = m.cli(["migrate", "bmad.version", target, "--registry", m.registry, "--dry-run", "--json"]);
    const result = json(run, "migrate dry-run").results.find((entry) => entry.id === "bmad.version");
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.match(result.summary, new RegExp(`Would upgrade BMAD ${PIN.replaceAll(".", "\\.")} -> ${NEWER_STABLE.replaceAll(".", "\\.")}`), result.summary);
  });

  check("an install BEHIND the pin is still a fixable warn, not an advisory pass", () => {
    writeFileSync(
      manifestPath(target),
      readFileSync(manifestPath(target), "utf8").replace(/(installation:\s*\n\s*version:)\s*\S+/, `$1 ${OLDER_THAN_PIN}`),
    );
    const run = m.cli(["audit", target, "--registry", m.registry, "--rules", "bmad.version", "--json"]);
    const finding = bmadVersion(json(run, "audit"));
    assert.equal(finding.status, "warn", JSON.stringify(finding));
    assert.equal(finding.fixable, true, "an install that does not match the pin keeps its upgrade path");
    assert.match(finding.summary, new RegExp(`BMAD ${OLDER_THAN_PIN.replaceAll(".", "\\.")} is behind stable ${NEWER_STABLE.replaceAll(".", "\\.")}`), finding.summary);
  });

  check("an install AHEAD of the pin but behind stable is not mistaken for the pin", () => {
    const between = `${major}.${minor}.${patch + 1}`;
    writeFileSync(
      manifestPath(target),
      readFileSync(manifestPath(target), "utf8").replace(/(installation:\s*\n\s*version:)\s*\S+/, `$1 ${between}`),
    );
    const finding = bmadVersion(json(m.cli(["audit", target, "--registry", m.registry, "--rules", "bmad.version", "--json"]), "audit"));
    assert.equal(finding.status, "warn", `${between} is not the verified pin: ${JSON.stringify(finding)}`);
    assert.equal(finding.fixable, true);
  });

  // The other half of AC2: the advisory exemption is for the pin and nothing
  // else. An installer that does not deliver the pin still fails a fresh init,
  // because the create transaction audits against the exact pin.
  check("a fresh init whose installer lands a different version still fails", () => {
    const bad = machine("landing-elsewhere", { installer: "landing-elsewhere" });
    const badTarget = join(bad.base, "Mismatch Project");
    const run = bad.cli(["init", "mismatch", "--target-dir", badTarget, "--registry", bad.registry, "--skip-board", "--apply", "--yes", "--no-tui", "--json"]);
    const result = json(run, "mismatched create init");
    assert.notEqual(run.status, 0, "an install that is not the verified pin must fail init");
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) => new RegExp(`^bmad\\.version: .*BMAD ${OLDER_THAN_PIN.replaceAll(".", "\\.")} does not match pinned ${PIN.replaceAll(".", "\\.")}`).test(error)),
      `the mismatch is named: ${JSON.stringify(result.errors)}`,
    );
    assert.equal(existsSync(badTarget), false, "the failed fresh target is rolled back");
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} PJAN-208 regression(s) failed`);
  process.exit(1);
}
console.log("\nPJAN-208 pin currency regressions passed");
