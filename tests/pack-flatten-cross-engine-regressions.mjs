// PACKS-CONTRACT section 3b: CROSS-ENGINE conformance gate.
//
// Three independent engines implement section 3b, in two languages and three
// repos. The first two ship in this repository and are always compared; the
// third is added only when PJ_SKILLEX_REPO explicitly selects a checkout:
//
//   1. pjangler TypeScript   src/parity/pack.ts       -> expandPackInventory()
//   2. the fanout engine     templates/commonproject/template/.mise/scripts/
//                            sync-skills.py           -> flatten_pack_inventory()
//   3. skillex Python        src/skillex/core/loader.py -> resolve_inventory()
//
// Each of the three previously had its OWN regression suite asserting its OWN
// expected leaf count, so all three could be green while disagreeing about the
// same pack — which is exactly what happened: pjangler capped the expansion at
// one level and pinned 67, while the two Python engines descended and pinned 73.
// Every suite passed. Nothing in CI could see it, because nothing in CI ever
// compared one engine's answer to another's.
//
// This suite is that comparison. It always runs pjangler and sync-skills.py over
// the SAME generated pack root, optionally adding Skillex and its real
// hermes-base reference pack. Every enabled engine must produce byte-identical
// `(name, relpath)` output. A constant is not evidence of agreement; only a diff
// is.
//
// It is deliberately NOT a count assertion. A count would still pass if two
// engines projected the same NUMBER of skills from different paths.

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSkillPackFixture } from "./helpers/pack-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const syncSkills = join(
  root,
  "templates",
  "commonproject",
  "template",
  ".mise",
  "scripts",
  "sync-skills.py"
);
const explicitSkillexRepo = process.env.PJ_SKILLEX_REPO?.trim();
const explicitHermesBasePack = process.env.PJ_PACK_ROOT_HERMES_BASE?.trim();
const skillexRepo = explicitSkillexRepo ? resolve(explicitSkillexRepo) : undefined;
const hermesBasePack = explicitHermesBasePack ? resolve(explicitHermesBasePack) : undefined;
const temporaries = [];
// `pj migrate` also materializes the implicit BMAD pin, which has to resolve
// somewhere before it will project anything at all. Irrelevant to section 3b —
// `linksUnder` filters it back out — but it must be satisfied for the run to
// reach the pack under test. `sync-skills.py` carries no such implicit pin.
const bmadFixtureRoot = mkdtempSync(join(tmpdir(), "pjangler-xengine-bmad-fixture-"));
temporaries.push(bmadFixtureRoot);
const selectedBmadPack = createSkillPackFixture(bmadFixtureRoot);
// The SSOT projection, committed in the skillex checkout and regenerated with
//   skillex pack inventory packs/hermes-base/0.18.2 --json > <this file>
// Both this suite and skillex's own pytest suite read it, so the reference pack's
// expected projection exists exactly ONCE across the two repos.
const goldenPath = skillexRepo
  ? join(skillexRepo, "tests", "fixtures", "flatten-reference-hermes-base-0.18.2.json")
  : undefined;
const runHermesReferenceCheck = Boolean(skillexRepo && hermesBasePack && goldenPath);
let checked = 0;
let maximumEngineCount = 2;

function makeTemp(label) {
  const dir = mkdtempSync(join(tmpdir(), `pjangler-${label}-`));
  temporaries.push(dir);
  return dir;
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result.stdout;
}

/** Canonical, diffable rendering of a projection. The unit of comparison. */
function canonical(pairs) {
  return `${JSON.stringify(
    [...pairs].sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0)),
    null,
    2
  )}\n`;
}

/**
 * Read a directory of projected skill symlinks back into `(name, relpath)`.
 *
 * `packRoot` is the filter: both fanout engines also project the implicit BMAD
 * pin, and only members of the pack under test are being compared here.
 */
function linksUnder(skillsDir, packRoot) {
  if (!existsSync(skillsDir)) return [];
  const pairs = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const link = join(skillsDir, name);
    if (!lstatSync(link).isSymbolicLink()) continue;
    const target = resolve(dirname(link), readlinkSync(link));
    if (target !== packRoot && !target.startsWith(`${packRoot}/`)) continue;
    pairs.push({ name, relpath: relative(packRoot, target).split("\\").join("/") });
  }
  return pairs;
}

function writeManifest(repo, packEntry) {
  writeFile(
    join(repo, ".agents", "skills.json"),
    `${JSON.stringify(
      {
        $schema: "https://raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json",
        scope: "project",
        // Hermetic on purpose: the host's global manifest must not be able to
        // add, remove or override a member and make the engines look different
        // (or, worse, look the same) for a reason that has nothing to do with 3b.
        inherit_global: false,
        registry: "https://github.com/delorenj/skillex.git",
        packs: [packEntry],
        skills: [],
      },
      null,
      2
    )}\n`
  );
}

function makeRepo(label, packEntry) {
  const repo = makeTemp(label);
  writeFileSync(join(repo, "mise.toml"), "[env]\n_.path = [\".mise/scripts\"]\n");
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n");
  writeManifest(repo, packEntry);
  return repo;
}

// ---------------------------------------------------------------------------
// The three engines, each driven through its REAL entry point.
// ---------------------------------------------------------------------------

/** Engine 1: pjangler TypeScript, via the projection `pj migrate` actually writes. */
function projectWithPjangler(packEntry, packRoot, registryRoot) {
  const repo = makeRepo("xengine-ts", packEntry);
  run("node", [cli, "migrate", "skills.project-manifest", repo, "--json"], {
    env: {
      PJ_SKILLS_REGISTRY_ROOT: registryRoot,
      PJ_PACK_ROOT_PJTEST: selectedBmadPack,
    },
  });
  return linksUnder(join(repo, ".agents", "skills"), packRoot);
}

/** Engine 2: the `sync-skills.py` fanout, via the CLI skill dirs it actually writes. */
function projectWithSyncSkills(packEntry, packRoot, registryRoot) {
  const repo = makeRepo("xengine-py-fanout", packEntry);
  const home = makeTemp("xengine-home");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  // PJAN-82: install the engine into the fixture at the SAME path a generated
  // project carries it, and hand it the root explicitly. The script refuses to
  // act on a repo it does not live in — that guard is what stops a parent mise
  // config's enter hook from reshaping whichever child repo you cd'd into — so
  // running the template copy in place against a foreign cwd is exactly the
  // shape it now rejects, and testing it that way would test nothing real.
  const engine = join(repo, ".mise", "scripts", "sync-skills.py");
  mkdirSync(dirname(engine), { recursive: true });
  cpSync(syncSkills, engine);
  run("python3", [engine, "--scope", "project", "--root", repo], {
    cwd: repo,
    env: { HOME: home, PJ_SKILLS_REGISTRY_ROOT: registryRoot },
  });
  return linksUnder(join(repo, ".claude", "skills"), packRoot);
}

/** Engine 3: the skillex library, via `skillex pack inventory --json`. */
function projectWithSkillex(packRoot) {
  assert.ok(skillexRepo, "PJ_SKILLEX_REPO is required for the optional Skillex engine");
  const stdout = run("uv", ["run", "--project", skillexRepo, "skillex", "pack", "inventory", packRoot, "--json"], {
    cwd: skillexRepo,
  });
  return JSON.parse(stdout).skills;
}

/**
 * A three-level pack, built here rather than borrowed from the registry.
 *
 * Self-contained on purpose: this fixture is what makes the gate UNCONDITIONAL.
 * The registry's `hermes-base` is the real conformance case but it is an
 * optional checkout, and a gate that silently skips is the failure mode this
 * whole suite exists to remove.
 *
 * Every branch is chosen to break a specific wrong implementation:
 *   `grp/one`               a depth-1 leaf   — the only one a one-level cap finds
 *   `grp/mid/two`           a depth-2 leaf   — dropped by a one-level cap
 *   `grp/mid/deeper/three`  a depth-3 leaf   — dropped by a two-level cap
 *   `solo/references/inner` a SKILL.md under a skill's own support tree — projecting
 *                           it means the engine descended into something that IS a
 *                           skill, which no depth limit would catch
 *   `grp/_skip`, `grp/.hid` section 3 skip rules, applied at every level
 *   `hollow/`               a container whose whole subtree yields nothing
 */
function makeThreeLevelRegistry() {
  const registry = makeTemp("xengine-registry");
  const pack = join(registry, "packs", "xengine-flat", "1.0.0");
  writeFile(
    join(pack, "pack.toml"),
    [
      "[pack]",
      'name = "xengine-flat"',
      'version = "1.0.0"',
      "",
      "[freeform]",
      'skills = ["grp", "hollow", "solo"]',
      "",
      "[policy]",
      "flatten = true",
      "",
    ].join("\n")
  );
  writeFile(join(pack, "solo", "SKILL.md"), "# solo\n");
  writeFile(join(pack, "solo", "references", "inner", "SKILL.md"), "# archived, not a skill\n");
  writeFile(join(pack, "grp", "DESCRIPTION.md"), "# grp\n");
  writeFile(join(pack, "grp", "one", "SKILL.md"), "# one\n");
  writeFile(join(pack, "grp", "_skip", "SKILL.md"), "# underscore\n");
  writeFile(join(pack, "grp", ".hid", "SKILL.md"), "# dot\n");
  writeFile(join(pack, "grp", "mid", "DESCRIPTION.md"), "# mid\n");
  writeFile(join(pack, "grp", "mid", "two", "SKILL.md"), "# two\n");
  writeFile(join(pack, "grp", "mid", "deeper", "DESCRIPTION.md"), "# deeper\n");
  writeFile(join(pack, "grp", "mid", "deeper", "three", "SKILL.md"), "# three\n");
  writeFile(join(pack, "hollow", "DESCRIPTION.md"), "# hollow\n");
  return { registry, pack };
}

/** Run both repository-contained engines, plus Skillex when explicitly enabled. */
function assertEnginesAgree(label, packEntry, packRoot, registryRoot) {
  const engines = [
    ["pjangler (TypeScript)", projectWithPjangler(packEntry, packRoot, registryRoot)],
    ["sync-skills.py (fanout)", projectWithSyncSkills(packEntry, packRoot, registryRoot)],
  ];
  if (skillexRepo) engines.push(["skillex (Python library)", projectWithSkillex(packRoot)]);
  const renderedEngines = engines.map(([name, pairs]) => [name, canonical(pairs)]);

  const [referenceName, reference] = renderedEngines[0];
  for (const [name, rendered] of renderedEngines.slice(1)) {
    if (rendered !== reference) {
      // Print the actual disagreement: a bare "not equal" on two 73-element
      // arrays is unreadable, and the useful signal is always the few paths
      // one engine reached and the other did not.
      const a = new Set(JSON.parse(reference).map((s) => s.relpath));
      const b = new Set(JSON.parse(rendered).map((s) => s.relpath));
      const onlyA = [...a].filter((p) => !b.has(p));
      const onlyB = [...b].filter((p) => !a.has(p));
      assert.fail(
        `${label}: section 3b engines disagree.\n` +
          `  ${referenceName}: ${a.size} skills\n` +
          `  ${name}: ${b.size} skills\n` +
          `  only in ${referenceName}: ${JSON.stringify(onlyA)}\n` +
          `  only in ${name}: ${JSON.stringify(onlyB)}`
      );
    }
  }
  checked += 1;
  maximumEngineCount = Math.max(maximumEngineCount, renderedEngines.length);
  return JSON.parse(reference);
}

try {
  if (!skillexRepo) {
    console.log("optional Skillex engine skipped; set PJ_SKILLEX_REPO to enable it");
  }
  // -------------------------------------------------------------------------
  // 1. The synthetic three-level pack. Always runs, depends on no checkout.
  // -------------------------------------------------------------------------
  {
    const { registry, pack } = makeThreeLevelRegistry();
    const projection = assertEnginesAgree(
      "three-level fixture",
      { name: "xengine-flat", version: "1.0.0" },
      pack,
      registry
    );

    // Pinned independently of the engines, so a THREE-way regression that keeps
    // the engines mutually consistent still fails here.
    assert.deepEqual(
      projection,
      [
        { name: "three", relpath: "grp/mid/deeper/three" },
        { name: "two", relpath: "grp/mid/two" },
        { name: "one", relpath: "grp/one" },
        { name: "solo", relpath: "solo" },
      ],
      "section 3b descends while a node is a container and stops at the first SKILL.md"
    );
    const paths = projection.map((skill) => skill.relpath);
    assert.equal(
      paths.includes("solo/references/inner"),
      false,
      "a directory that IS a skill is never descended into"
    );
    for (const skipped of ["grp/_skip", "grp/.hid"]) {
      assert.equal(paths.includes(skipped), false, `${skipped} is skipped at every level`);
    }
    assert.equal(paths.includes("hollow"), false, "an empty container projects nothing");
  }

  // -------------------------------------------------------------------------
  // 2. The real reference pack, plus the committed SSOT projection.
  //
  //    The golden lives in the skillex checkout and is read by BOTH suites, so
  //    "how many leaves does hermes-base flatten to" is written down once rather
  //    than once per engine — the arrangement that let 67 and 73 coexist.
  // -------------------------------------------------------------------------
  if (runHermesReferenceCheck) {
    assert.equal(existsSync(join(hermesBasePack, "pack.toml")), true, `explicit Hermes pack is invalid: ${hermesBasePack}`);
    assert.equal(existsSync(goldenPath), true, `explicit Skillex golden projection is missing: ${goldenPath}`);
    const registryRoot = resolve(hermesBasePack, "..", "..", "..");
    const projection = assertEnginesAgree(
      "hermes-base 0.18.2",
      { name: "hermes-base", version: "0.18.2" },
      hermesBasePack,
      registryRoot
    );

    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    assert.equal(golden.pack, "hermes-base");
    assert.equal(golden.version, "0.18.2");
    assert.equal(golden.flattened, true);
    assert.deepEqual(
      projection,
      golden.skills,
      `every engine must reproduce ${goldenPath} exactly`
    );
    // Restated from the golden, never hard-coded: the number is data here.
    assert.equal(
      projection.length,
      golden.skills.length,
      `hermes-base 0.18.2 projects ${golden.skills.length} leaf skills`
    );
    assert.equal(
      new Set(projection.map((skill) => skill.name)).size,
      projection.length,
      "the reference pack must carry no duplicate leaf basenames"
    );
  } else {
    console.log(
      "optional Hermes real-pack comparison skipped; set both PJ_PACK_ROOT_HERMES_BASE and PJ_SKILLEX_REPO"
    );
  }

  assert.ok(checked >= 1, "the cross-engine gate must actually compare at least one pack");
  console.log(
    `pack flatten cross-engine (PACKS-CONTRACT 3b) regressions passed ` +
      `(${checked} pack(s), up to ${maximumEngineCount} engines)`,
  );
} finally {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
}
