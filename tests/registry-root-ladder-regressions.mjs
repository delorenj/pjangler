import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSkillPackFixture } from "./helpers/pack-fixture.mjs";

/**
 * Contract section 2 step 3 is an ORDERED LADDER of registry checkouts, not a
 * single root:
 *
 *   PJ_SKILLS_REGISTRY_ROOT | ~/.agents/.cache/registries/<sanitized-url> | ~/code/skillex
 *
 * The regression this file exists for: resolution used to stop at the first
 * candidate DIRECTORY that existed, then hard-bind to it. Because `sync-skills.py`
 * always creates the cache clone, the lower-priority checkouts became dead code —
 * and the cache is a clone of what has been *pushed*, so it routinely carries a
 * `packs/<name>/<version>/` directory that predates the rendering of that pack.
 *
 * The consequence was silent and severe: the same `name@version` resolved to an
 * UNSEALED copy (no pack.toml, inventory globbed from directory names) while an
 * attested, `[policy] sealed = true` copy sat one rung down. Sealing was skipped,
 * section 6 redundancy detection compared against the wrong root and found
 * nothing, and the repo audited GREEN with its declared pack fully shadowed.
 *
 * The rule under test: walk the ladder; contract order decides, except that a
 * root whose `pack.toml` positively attests the entry outranks one with no
 * `pack.toml` at all. Promotion can only TIGHTEN — it can never demote a sealed
 * pack, because contract order still breaks ties between two attested roots.
 *
 * And the security half: the ladder exists to walk past ABSENCE. A candidate that
 * is present-but-hostile (symlinked path component, symlinked pack.toml) must
 * still hard-fail with ZERO mutation, never be silently bypassed in favour of a
 * good checkout further down.
 */

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const CACHE_DIR_NAME = "https://github.com/delorenj/skillex.git".replace(/[^a-zA-Z0-9]/g, "_");
// The implicit BMAD pin runs whenever a manifest does not declare `bmad`; point
// it at a generated authenticated pack so these fixtures exercise the ladder,
// not a machine-specific registry checkout.
const bmadFixtureRoot = mkdtempSync(join(tmpdir(), "pjangler-ladder-bmad-fixture-"));
const bmadPackRoot = createSkillPackFixture(bmadFixtureRoot);

const PACK = "demo";
const VERSION = "2.0.0";
const SKILL = "alpha";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * @param {string} registryRoot
 * @param {"sealed"|"plain"|"unattested"} kind  `unattested` = no pack.toml at all
 * @param {string} version
 */
function writePack(registryRoot, kind, version = VERSION) {
  const packRoot = join(registryRoot, "packs", PACK, version);
  mkdirSync(join(packRoot, SKILL), { recursive: true });
  const skillBody = `# ${SKILL} (${kind})\n`;
  writeFileSync(join(packRoot, SKILL, "SKILL.md"), skillBody);
  if (kind === "unattested") return packRoot;

  let toml = `[pack]\nname = "${PACK}"\nversion = "${version}"\n\n[freeform]\nskills = ["${SKILL}"]\n`;
  if (kind === "sealed") toml += `\n[policy]\nsealed = true\n`;
  writeFileSync(join(packRoot, "pack.toml"), toml);

  if (kind === "sealed") {
    const lines = [
      `${sha256(toml)}  pack.toml`,
      `${sha256(skillBody)}  ${SKILL}/SKILL.md`,
    ].sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
    writeFileSync(join(packRoot, "SHA256SUMS"), `${lines.join("\n")}\n`);
  }
  return packRoot;
}

function makeFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `pjangler-ladder-${label}-`));
  const cache = join(home, ".agents", ".cache", "registries", CACHE_DIR_NAME);
  const fallback = join(home, "code", "skillex");
  const repo = join(home, "repo");
  mkdirSync(join(cache, "packs"), { recursive: true });
  mkdirSync(join(fallback, "packs"), { recursive: true });
  mkdirSync(join(repo, ".agents"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", "."], { cwd: repo }).status, 0);
  writeFileSync(
    join(repo, ".agents", "skills.json"),
    `${JSON.stringify(
      {
        $schema: "https://raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json",
        inherit_global: true,
        registry: "https://github.com/delorenj/skillex.git",
        packs: [{ name: PACK, version: VERSION }],
        skills: [],
      },
      null,
      2
    )}\n`
  );
  return { home, cache, fallback, repo };
}

function pj(args, fixture) {
  const env = {
    ...process.env,
    HOME: fixture.home,
    PJ_PACK_ROOT_PJTEST: bmadPackRoot,
  };
  delete env.PJ_SKILLS_REGISTRY_ROOT;
  return spawnSync("node", [cli, ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env,
  });
}

/** The pack root actually chosen, read off the materialized projection. */
function resolvedPackRoot(fixture) {
  pj(["migrate", "skills.project-manifest"], fixture);
  try {
    const target = readlinkSync(join(fixture.repo, ".agents", "skills", SKILL));
    return resolve(target, "..");
  } catch {
    return null;
  }
}

function auditPackError(fixture) {
  const out = pj(["audit"], fixture);
  const match = `${out.stdout}${out.stderr}`.match(/Skillex pack demo could not be resolved: ([^\n]*)/);
  return match ? match[1].trim() : null;
}

/** Nothing was projected into `.agents/skills`. */
function assertNoMutation(fixture, label) {
  let entries = [];
  try {
    entries = readdirSync(join(fixture.repo, ".agents", "skills"));
  } catch {
    entries = [];
  }
  assert.deepEqual(entries, [], `${label}: a rejected pack must produce ZERO mutation`);
}

const cleanup = [bmadFixtureRoot];
function fixture(label) {
  const made = makeFixture(label);
  cleanup.push(made.home);
  return made;
}

// ---------------------------------------------------------------------------
// Ladder ranking
// ---------------------------------------------------------------------------

{
  // THE REGRESSION. The cache carries an unrendered copy at the pinned version;
  // the rendered, sealed pack is one rung down. Before the fix the cache won,
  // sealing was skipped, and the repo audited green against the wrong root.
  const f = fixture("shadowed");
  writePack(f.cache, "unattested");
  const sealed = writePack(f.fallback, "sealed");
  assert.equal(
    resolvedPackRoot(f),
    sealed,
    "an unattested pack copy in a higher-priority checkout must not shadow the attested one"
  );
}

{
  // Promotion may only TIGHTEN: two attested roots fall back to contract order,
  // so a sealed pack in the cache is never demoted by a lower-priority checkout.
  const f = fixture("both-attested");
  const cached = writePack(f.cache, "sealed");
  writePack(f.fallback, "sealed");
  assert.equal(resolvedPackRoot(f), cached, "contract order must break ties between two attested roots");
}

{
  // The sharpest form of the same rule: a SEALED cache pack outranks an unsealed
  // (but still attested) copy below it. Attestation ranks, sealing is not traded.
  const f = fixture("no-downgrade");
  const cached = writePack(f.cache, "sealed");
  writePack(f.fallback, "plain");
  assert.equal(resolvedPackRoot(f), cached, "a sealed pack must never be downgraded by a lower-priority root");
}

{
  // A checkout that does not carry the PINNED version does not carry the pack;
  // the ladder has to walk past it rather than hard-fail on the first rung.
  const f = fixture("version-absent");
  writePack(f.cache, "sealed", "1.0.0");
  const sealed = writePack(f.fallback, "sealed", VERSION);
  assert.equal(resolvedPackRoot(f), sealed, "the ladder must walk past a checkout missing the pinned version");
}

{
  // `PJ_SKILLS_REGISTRY_ROOT` is EXCLUSIVE, not merely first: an explicitly
  // pinned root that lacks the pack must fail, never fall through to ~/code/skillex.
  const f = fixture("env-exclusive");
  writePack(f.fallback, "sealed");
  const out = spawnSync("node", [cli, "audit"], {
    cwd: f.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: f.home,
      PJ_PACK_ROOT_PJTEST: bmadPackRoot,
      PJ_SKILLS_REGISTRY_ROOT: join(f.home, "empty-registry"),
    },
  });
  assert.match(
    `${out.stdout}${out.stderr}`,
    /Skillex pack demo could not be resolved/,
    "an explicit PJ_SKILLS_REGISTRY_ROOT must not fall through to another checkout"
  );
}

// ---------------------------------------------------------------------------
// The ladder walks past ABSENCE only — never past a hostile candidate
// ---------------------------------------------------------------------------

{
  const f = fixture("symlinked-family");
  const sealed = writePack(f.fallback, "sealed");
  symlinkSync(join(f.fallback, "packs", PACK), join(f.cache, "packs", PACK));
  assert.match(
    auditPackError(f) ?? "",
    /Refusing symlinked pack path component/,
    "a symlinked packs/<name> must hard-fail, not be bypassed for a good checkout"
  );
  assert.notEqual(resolvedPackRoot(f), sealed, "a hostile candidate must not silently resolve elsewhere");
  assertNoMutation(f, "symlinked packs/<name>");
}

{
  const f = fixture("symlinked-version");
  const sealed = writePack(f.fallback, "sealed");
  mkdirSync(join(f.cache, "packs", PACK), { recursive: true });
  symlinkSync(join(sealed), join(f.cache, "packs", PACK, VERSION));
  assert.match(
    auditPackError(f) ?? "",
    /Refusing symlinked pack path component/,
    "a symlinked pack root must hard-fail"
  );
  assertNoMutation(f, "symlinked pack root");
}

{
  // The attestation probe reads pack.toml. It must refuse to follow a symlink
  // there rather than treat the link target's identity as this root's.
  const f = fixture("symlinked-manifest");
  const sealed = writePack(f.fallback, "sealed");
  const planted = join(f.cache, "packs", PACK, VERSION);
  mkdirSync(join(planted, SKILL), { recursive: true });
  writeFileSync(join(planted, SKILL, "SKILL.md"), "# planted\n");
  symlinkSync(join(sealed, "pack.toml"), join(planted, "pack.toml"));
  assert.match(
    auditPackError(f) ?? "",
    /Pack metadata is not a regular file/,
    "the attestation probe must never follow a symlinked pack.toml"
  );
  assertNoMutation(f, "symlinked pack.toml");
}

{
  // A present manifest is authoritative identity, not an unattested miss. A
  // wrong name in the high-priority checkout must not fall through to a good
  // lower-priority copy.
  const f = fixture("wrong-name");
  const planted = writePack(f.cache, "plain");
  writePack(f.fallback, "sealed");
  writeFileSync(
    join(planted, "pack.toml"),
    `[pack]\nname = "other"\nversion = "${VERSION}"\n\n[freeform]\nskills = ["${SKILL}"]\n`
  );
  assert.match(auditPackError(f) ?? "", /declares name "other"/);
  assertNoMutation(f, "wrong pack.toml name");
}

{
  // The same fail-closed rule applies to a pinned version mismatch.
  const f = fixture("wrong-version");
  const planted = writePack(f.cache, "plain");
  writePack(f.fallback, "sealed");
  writeFileSync(
    join(planted, "pack.toml"),
    `[pack]\nname = "${PACK}"\nversion = "9.9.9"\n\n[freeform]\nskills = ["${SKILL}"]\n`
  );
  assert.match(auditPackError(f) ?? "", /declares version "9\.9\.9"/);
  assertNoMutation(f, "wrong pack.toml version");
}

{
  // Unsupported TOML syntax on the authoritative inventory may never be
  // interpreted as an empty pack.
  const f = fixture("unsupported-inventory");
  const planted = writePack(f.cache, "plain");
  writeFileSync(
    join(planted, "pack.toml"),
    `[pack]\nname = "${PACK}"\nversion = "${VERSION}"\n\n[freeform]\nskills = { alpha = true }\n`
  );
  assert.match(auditPackError(f) ?? "", /\[freeform\]\.skills must be an array of strings/);
  assertNoMutation(f, "unsupported pack inventory");
}

{
  // The winning root is still fully validated: a symlink anywhere in the payload
  // fails the whole thing, with no partial projection.
  const f = fixture("payload-symlink");
  const sealed = writePack(f.fallback, "sealed");
  symlinkSync("/etc/passwd", join(sealed, SKILL, "leak.md"));
  assert.match(
    auditPackError(f) ?? "",
    /Pack payload may not contain symlinks/,
    "a symlink inside the chosen pack payload must still be rejected"
  );
  assertNoMutation(f, "payload symlink");
}

for (const home of cleanup) rmSync(home, { recursive: true, force: true });
console.log("registry root ladder regressions passed");
