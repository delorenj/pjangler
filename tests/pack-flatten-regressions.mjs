// PACKS-CONTRACT section 3b: flattened (nested) packs.
//
// Upstream Hermes groups skills under CONTAINER directories, each carrying a
// DESCRIPTION.md, and resolves both SKILL.md roots and those DESCRIPTION.md files
// with the SAME depth-agnostic walk — agent/skill_utils.py::iter_skill_index_files,
// called from agent/prompt_builder.py:1670 and :1718. Upstream nests three deep in
// places (mlops/{evaluation,inference,models}/), so the container model has no
// depth limit. That nesting is upstream's data model, and packs/hermes-base is a
// verifiable mirror of it, so the pack is NOT normalized on disk. The five
// container-less CLIs get a flat view because the expansion happens at PROJECTION
// time, which is what this suite pins.
//
// (agent/skill_bundles.py is NOT the mechanism: its scan_bundles() globs
// *.yaml/*.yml out of <HERMES_HOME>/skill-bundles and never walks a skill tree.)
//
// The two load-bearing invariants:
//   1. `flatten` is OFF by default — every pre-existing pack must behave exactly
//      as it did before, including failing on a container with no SKILL.md.
//   2. Expansion is a DESCENT of unbounded depth that stops at the first SKILL.md
//      on each branch. A grandchild of a container IS a member; a SKILL.md inside
//      an already-resolved skill's references/ never is.

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSkillPackFixture } from "./helpers/pack-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const temporaries = [];
const bmadFixtureRoot = mkdtempSync(join(tmpdir(), "pjangler-flatten-bmad-fixture-"));
temporaries.push(bmadFixtureRoot);
const selectedBmadPack = createSkillPackFixture(bmadFixtureRoot);
const explicitHermesBasePack = process.env.PJ_PACK_ROOT_HERMES_BASE?.trim();
const explicitSkillexRepo = process.env.PJ_SKILLEX_REPO?.trim();
const hermesBasePack = explicitHermesBasePack ? resolve(explicitHermesBasePack) : undefined;
// The SSOT projection for the reference pack, committed in the skillex checkout
// and regenerated with `skillex pack inventory <pack> --json`. Read here AND by
// skillex's pytest suite, so the expected answer exists in exactly one file.
const skillexRepo = explicitSkillexRepo ? resolve(explicitSkillexRepo) : undefined;
const goldenProjectionPath = skillexRepo
  ? join(skillexRepo, "tests", "fixtures", "flatten-reference-hermes-base-0.18.2.json")
  : undefined;
const runHermesReferenceCheck = Boolean(hermesBasePack && goldenProjectionPath);

function run(args, env) {
  const result = spawnSync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PJ_PACK_ROOT_PJTEST: selectedBmadPack, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`command failed: node ${cli} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runAllowFailure(args, env) {
  const result = spawnSync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PJ_PACK_ROOT_PJTEST: selectedBmadPack, ...env },
  });
  if (!result.stdout.trim()) {
    throw new Error(`command produced no stdout: node ${cli} ${args.join(" ")}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `pjangler-${name}-`));
  temporaries.push(repo);
  writeFileSync(join(repo, "mise.toml"), "[env]\n_.path = [\".mise/scripts\"]\n");
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n");
  return repo;
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeManifest(repo, manifest) {
  writeFile(join(repo, ".agents", "skills.json"), `${JSON.stringify(
    {
      $schema: "https://raw.githubusercontent.com/delorenj/skillex/main/skills.schema.json",
      inherit_global: true,
      registry: "https://github.com/delorenj/skillex.git",
      ...manifest,
    },
    null,
    2,
  )}\n`);
}

/**
 * The reference NESTED layout, mirroring the shape hermes-base actually has —
 * including a container of containers, which is where a one-level cap breaks.
 *
 * `flattenPolicy` writes `[policy] flatten = true`; leaving it off is how this
 * suite proves the feature is opt-in.
 */
function makeFlatPack(label, { flattenPolicy = true, withDuplicate = false, packToml = true, into, version = "1.0.0" } = {}) {
  let pack = into;
  if (pack) {
    mkdirSync(pack, { recursive: true });
  } else {
    pack = mkdtempSync(join(tmpdir(), `pjangler-${label}-`));
    temporaries.push(pack);
  }

  const declared = ["solo", "bundle-a", "bundle-b", "empty-bundle"];
  if (packToml) {
    writeFile(
      join(pack, "pack.toml"),
      [
        "[pack]",
        'name = "demo-flat"',
        `version = "${version}"`,
        "",
        "[freeform]",
        `skills = [${declared.map((name) => `"${name}"`).join(", ")}]`,
        "",
        "[policy]",
        ...(flattenPolicy ? ["flatten = true"] : []),
        "",
      ].join("\n"),
    );
  }

  // A declared entry that IS a skill: taken as-is, never expanded. The descent
  // stops at its SKILL.md, so the archived SKILL.md in its references/ (exactly
  // what upstream's SKILL_SUPPORT_DIRS pruning exists for) is unreachable.
  writeFile(join(pack, "solo", "SKILL.md"), "# solo\n");
  writeFile(join(pack, "solo", "references", "notes.md"), "solo notes\n");
  writeFile(join(pack, "solo", "references", "archived", "SKILL.md"), "# archived\n");

  // A container. DESCRIPTION.md is upstream's bundle metadata: it stays in the
  // pack (and in the payload) and is never projected.
  writeFile(join(pack, "bundle-a", "DESCRIPTION.md"), "# bundle a\n");
  writeFile(join(pack, "bundle-a", "alpha", "SKILL.md"), "# alpha\n");
  writeFile(join(pack, "bundle-a", "beta", "SKILL.md"), "# beta\n");
  // Section 3 skip rules apply unchanged to container children.
  writeFile(join(pack, "bundle-a", "_staging", "SKILL.md"), "# underscore\n");
  writeFile(join(pack, "bundle-a", ".hidden", "SKILL.md"), "# dot\n");
  writeFile(join(pack, "bundle-a", "not-a-skill", "README.md"), "# no SKILL.md\n");

  writeFile(join(pack, "bundle-b", "DESCRIPTION.md"), "# bundle b\n");
  writeFile(join(pack, "bundle-b", "gamma", "SKILL.md"), "# gamma\n");
  // A container of containers, mirroring upstream's mlops/{evaluation,...}/.
  // `deep` carries no SKILL.md, so the descent continues through it — twice, to
  // pin that the expansion has no depth limit at all.
  writeFile(join(pack, "bundle-b", "deep", "DESCRIPTION.md"), "# deep\n");
  writeFile(join(pack, "bundle-b", "deep", "nested", "SKILL.md"), "# nested\n");
  writeFile(join(pack, "bundle-b", "deep", "deeper", "way-down", "SKILL.md"), "# way down\n");
  if (withDuplicate) {
    writeFile(join(pack, "bundle-a", "clash", "SKILL.md"), "# clash a\n");
    writeFile(join(pack, "bundle-b", "clash", "SKILL.md"), "# clash b\n");
  }

  // A container that projects nothing: must WARN, never be silently dropped and
  // never be reported as a skill missing its SKILL.md.
  writeFile(join(pack, "empty-bundle", "DESCRIPTION.md"), "# empty\n");

  return pack;
}

function projectedLinks(repo) {
  const skillsDir = join(repo, ".agents", "skills");
  if (!existsSync(skillsDir)) return new Map();
  const links = new Map();
  for (const name of readdirSync(skillsDir).sort()) {
    if (name.startsWith("bmad-")) continue;
    const path = join(skillsDir, name);
    if (!lstatSync(path).isSymbolicLink()) continue;
    links.set(name, resolve(dirname(path), readlinkSync(path)));
  }
  return links;
}

try {
  // ---------------------------------------------------------------------------
  // 1. A flattened pack projects LEAF skills at their real leaf paths.
  // ---------------------------------------------------------------------------
  {
    const pack = makeFlatPack("flatten-basic");
    const repo = makeRepo("flatten-basic-repo");
    writeManifest(repo, { packs: [{ name: "demo-flat", version: "1.0.0" }], skills: [] });
    const env = { PJ_PACK_ROOT_PJTEST: selectedBmadPack, PJ_PACK_ROOT_DEMO_FLAT: pack };

    run(["migrate", "skills.project-manifest", repo, "--json"], env);
    const links = projectedLinks(repo);

    assert.deepEqual(
      [...links.keys()],
      ["alpha", "beta", "gamma", "nested", "solo", "way-down"],
      "a flattened pack projects leaf basenames at any depth, not container names",
    );
    // The whole point: a member path is NO LONGER `<root>/<name>`, and it is not
    // capped at `<root>/<container>/<name>` either.
    assert.equal(links.get("alpha"), join(pack, "bundle-a", "alpha"));
    assert.equal(links.get("beta"), join(pack, "bundle-a", "beta"));
    assert.equal(links.get("gamma"), join(pack, "bundle-b", "gamma"));
    assert.equal(links.get("nested"), join(pack, "bundle-b", "deep", "nested"), "a grandchild of a container IS a member");
    assert.equal(
      links.get("way-down"),
      join(pack, "bundle-b", "deep", "deeper", "way-down"),
      "the descent has no depth limit",
    );
    assert.equal(links.get("solo"), join(pack, "solo"), "a declared entry with its own SKILL.md is taken as-is");

    for (const absent of ["bundle-a", "bundle-b", "empty-bundle", "deep", "deeper", "_staging", ".hidden", "not-a-skill"]) {
      assert.equal(links.has(absent), false, `${absent} must never be projected`);
    }
    // The descent stops at the first SKILL.md on a branch, so a skill's own
    // support subtree can never contribute a second member.
    assert.equal(links.has("archived"), false, "a SKILL.md under a resolved skill's references/ is not a member");

    // Declared pack members are projected as symlinks and are NOT expanded into
    // skills[] — unchanged by flattening.
    // (The implicit BMAD pin still expands into skills[] — that is unrelated and
    // deliberately unchanged; only the DECLARED pack is asserted here.)
    const manifest = JSON.parse(readFileSync(join(repo, ".agents", "skills.json"), "utf8"));
    assert.deepEqual(
      manifest.skills.filter((entry) => !entry.name.startsWith("bmad-")),
      [],
      "a declared pack must not be hand-expanded into skills[]",
    );

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"], env));
    const finding = audit.rules.find((rule) => rule.id === "skills.project-manifest");
    assert.equal(finding.status, "pass", JSON.stringify(finding));
    // The container that projects nothing is REPORTED, and reported as an
    // advisory rather than as a missing skill.
    assert.match(finding.summary, /"empty-bundle" is a container that contributes no skills/);
    // A deeper nest is no longer a loss, so there is nothing left to report about
    // it — the old "one-level flattening does not expand" advisory is gone.
    assert.doesNotMatch(
      JSON.stringify(finding),
      /does not expand|sub-containers/,
      "a nested container is expanded, not reported as unreachable",
    );
    assert.deepEqual(finding.details, [], "an advisory is not a failure and must not become a detail");
    assert.doesNotMatch(
      JSON.stringify(finding),
      /is missing a regular SKILL\.md/,
      "a container must never be reported as a skill missing its SKILL.md",
    );

    const rerun = JSON.parse(run(["migrate", "skills.project-manifest", repo, "--json"], env));
    assert.equal(
      rerun.results.find((entry) => entry.id === "skills.project-manifest").status,
      "noop",
      "a flattened projection must be idempotent",
    );
  }

  // ---------------------------------------------------------------------------
  // 2. flatten is OFF by default: the SAME pack without `[policy] flatten` still
  //    fails exactly the way it always did, because a container is not a skill.
  // ---------------------------------------------------------------------------
  {
    const pack = makeFlatPack("flatten-default-off", { flattenPolicy: false });
    const repo = makeRepo("flatten-default-off-repo");
    writeManifest(repo, { packs: [{ name: "demo-flat", version: "1.0.0" }], skills: [] });
    const env = { PJ_PACK_ROOT_PJTEST: selectedBmadPack, PJ_PACK_ROOT_DEMO_FLAT: pack };

    const report = JSON.parse(runAllowFailure(["migrate", "skills.project-manifest", repo, "--json"], env));
    const result = report.results.find((entry) => entry.id === "skills.project-manifest");
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.match(result.details.join("\n"), /bundle-a is missing a regular SKILL\.md/);
    assert.equal(existsSync(join(repo, ".agents", "skills")), false, "rejection must precede project mutation");
  }

  // ---------------------------------------------------------------------------
  // 3. The manifest flag turns flattening on for a pack with no pack.toml, and
  //    without it the container is simply not inventory at all.
  // ---------------------------------------------------------------------------
  {
    const pack = makeFlatPack("flatten-manifest-flag", { packToml: false });
    const env = { PJ_PACK_ROOT_PJTEST: selectedBmadPack, PJ_PACK_ROOT_DEMO_FLAT: pack };

    const flattened = makeRepo("flatten-manifest-flag-on");
    writeManifest(flattened, { packs: [{ name: "demo-flat", flatten: true }], skills: [] });
    run(["migrate", "skills.project-manifest", flattened, "--json"], env);
    assert.deepEqual(
      [...projectedLinks(flattened).keys()],
      ["alpha", "beta", "gamma", "nested", "solo", "way-down"],
      "manifest flatten:true must expand a pack.toml-less pack",
    );

    const plain = makeRepo("flatten-manifest-flag-off");
    writeManifest(plain, { packs: [{ name: "demo-flat" }], skills: [] });
    run(["migrate", "skills.project-manifest", plain, "--json"], env);
    assert.deepEqual(
      [...projectedLinks(plain).keys()],
      ["solo"],
      "without flatten a pack.toml-less pack sees only child dirs that carry a SKILL.md",
    );
  }

  // ---------------------------------------------------------------------------
  // 4. include/exclude apply to the FINAL flattened names.
  // ---------------------------------------------------------------------------
  {
    const pack = makeFlatPack("flatten-filters");
    const env = { PJ_PACK_ROOT_PJTEST: selectedBmadPack, PJ_PACK_ROOT_DEMO_FLAT: pack };

    const excluded = makeRepo("flatten-exclude");
    writeManifest(excluded, { packs: [{ name: "demo-flat", version: "1.0.0", exclude: ["beta"] }], skills: [] });
    run(["migrate", "skills.project-manifest", excluded, "--json"], env);
    assert.deepEqual([...projectedLinks(excluded).keys()], ["alpha", "gamma", "nested", "solo", "way-down"]);

    const included = makeRepo("flatten-include");
    writeManifest(included, { packs: [{ name: "demo-flat", version: "1.0.0", include: ["alpha", "solo"] }], skills: [] });
    run(["migrate", "skills.project-manifest", included, "--json"], env);
    assert.deepEqual([...projectedLinks(included).keys()], ["alpha", "solo"]);

    // A container name is NOT a flattened name, so it filters nothing.
    const byContainer = makeRepo("flatten-exclude-container");
    writeManifest(byContainer, { packs: [{ name: "demo-flat", version: "1.0.0", exclude: ["bundle-a"] }], skills: [] });
    run(["migrate", "skills.project-manifest", byContainer, "--json"], env);
    assert.deepEqual(
      [...projectedLinks(byContainer).keys()],
      ["alpha", "beta", "gamma", "nested", "solo", "way-down"],
    );
  }

  // ---------------------------------------------------------------------------
  // 5. Duplicate leaf basenames inside ONE pack are an ERROR — the pack is
  //    ambiguous and nothing may be projected from it.
  // ---------------------------------------------------------------------------
  {
    const pack = makeFlatPack("flatten-duplicate", { withDuplicate: true });
    const repo = makeRepo("flatten-duplicate-repo");
    writeManifest(repo, { packs: [{ name: "demo-flat", version: "1.0.0" }], skills: [] });
    const env = { PJ_PACK_ROOT_PJTEST: selectedBmadPack, PJ_PACK_ROOT_DEMO_FLAT: pack };

    const report = JSON.parse(runAllowFailure(["migrate", "skills.project-manifest", repo, "--json"], env));
    const result = report.results.find((entry) => entry.id === "skills.project-manifest");
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.match(result.details.join("\n"), /flattens to a duplicate skill name "clash"/);
    assert.equal(existsSync(join(repo, ".agents", "skills")), false, "an ambiguous pack must not mutate the project");
  }

  // ---------------------------------------------------------------------------
  // 6. Section 6 redundancy sees LEAF names: a hand-expanded entry pointing at a
  //    leaf of a declared flattened pack is redundant and must be dropped, while
  //    an entry pointing outside the pack is the user's and must survive.
  // ---------------------------------------------------------------------------
  {
    const pack = makeFlatPack("flatten-redundancy");
    const repo = makeRepo("flatten-redundancy-repo");
    const override = join(repo, ".agents", "skills.bak", "gamma");
    writeFile(join(override, "SKILL.md"), "# customized\n");
    writeManifest(repo, {
      packs: [{ name: "demo-flat", version: "1.0.0" }],
      skills: [
        { name: "alpha", source: `file://${join(pack, "bundle-a", "alpha")}` },
        { name: "gamma", source: `file://${override}` },
      ],
    });
    const env = { PJ_PACK_ROOT_PJTEST: selectedBmadPack, PJ_PACK_ROOT_DEMO_FLAT: pack };

    const before = JSON.parse(runAllowFailure(["audit", repo, "--json"], env));
    const beforeFinding = before.rules.find((rule) => rule.id === "skills.project-manifest");
    assert.match(beforeFinding.details.join("\n"), /duplicates 1 declared pack member\(s\).*alpha/);

    run(["migrate", "skills.project-manifest", repo, "--json"], env);
    const manifest = JSON.parse(readFileSync(join(repo, ".agents", "skills.json"), "utf8"));
    assert.deepEqual(
      manifest.skills.filter((entry) => !entry.name.startsWith("bmad-")),
      [{ name: "gamma", source: `file://${override}` }],
      "a leaf entry inside the pack is redundant; an override outside it survives",
    );
    // The surviving override wins the name, so the pack no longer projects gamma.
    assert.deepEqual([...projectedLinks(repo).keys()], ["alpha", "beta", "nested", "solo", "way-down"]);
  }

  // ---------------------------------------------------------------------------
  // 6b. Section 6 rule (b): an entry pointing at ANOTHER VERSION of the declared
  //     pack family is redundant when its name is one the pack provides. For a
  //     flattened pack that name is the LEAF's, which appears only in the
  //     expanded inventory — the raw declared list would miss it entirely.
  // ---------------------------------------------------------------------------
  {
    const registry = mkdtempSync(join(tmpdir(), "pjangler-flatten-family-"));
    temporaries.push(registry);
    const family = join(registry, "packs", "demo-flat");
    makeFlatPack("flatten-family-current", { into: join(family, "1.0.0"), version: "1.0.0" });
    makeFlatPack("flatten-family-old", { into: join(family, "0.9.0"), version: "0.9.0" });

    const repo = makeRepo("flatten-family-repo");
    const outside = join(repo, "vendor", "alpha");
    writeFile(join(outside, "SKILL.md"), "# vendored\n");
    writeManifest(repo, {
      packs: [{ name: "demo-flat", version: "1.0.0" }],
      skills: [
        // Same family, older version, LEAF name -> redundant.
        { name: "beta", source: `file://${join(family, "0.9.0", "bundle-a", "beta")}` },
        // Same family, older version, CONTAINER name -> NOT a name the pack
        // provides, so clause (b) must not match and the entry must survive.
        { name: "bundle-a", source: `file://${join(family, "0.9.0", "bundle-a")}` },
        // Outside the family entirely -> the user's, must survive and override.
        { name: "alpha", source: `file://${outside}` },
      ],
    });
    const env = { PJ_PACK_ROOT_PJTEST: selectedBmadPack, PJ_SKILLS_REGISTRY_ROOT: registry };

    run(["migrate", "skills.project-manifest", repo, "--json"], env);
    const manifest = JSON.parse(readFileSync(join(repo, ".agents", "skills.json"), "utf8"));
    assert.deepEqual(
      manifest.skills.filter((entry) => !entry.name.startsWith("bmad-")),
      [
        { name: "bundle-a", source: `file://${join(family, "0.9.0", "bundle-a")}` },
        { name: "alpha", source: `file://${outside}` },
      ],
      "a sibling-version LEAF entry is redundant; a container name and an out-of-family entry survive",
    );
    const links = projectedLinks(repo);
    assert.equal(links.get("beta"), join(family, "1.0.0", "bundle-a", "beta"), "the declared version wins");
    assert.equal(links.has("alpha"), false, "a surviving skills[] entry overrides the pack member");
  }

  // ---------------------------------------------------------------------------
  // 7. The real reference pack, when explicitly selected.
  //
  //    hermes-base/0.18.2 declares 18 entries: 4 already carry their own
  //    SKILL.md and 14 are containers. The descent resolves every SKILL.md root
  //    in the tree — the ones one level down PLUS the six under `mlops`'s own
  //    sub-containers (evaluation/, inference/, models/, each with its own
  //    DESCRIPTION.md). A one-level cap would silently drop those six.
  //
  //    The EXPECTED COUNT IS NOT WRITTEN HERE. It is read from the golden
  //    projection committed in the skillex checkout, which skillex's own pytest
  //    suite reads too. Two suites keeping two private copies of this number is
  //    exactly how 67 (here) and 73 (there) stayed green side by side; there is
  //    now one copy, and `pack-flatten-cross-engine-regressions.mjs` proves all
  //    enabled engines reproduce it (pjangler/sync always, Skillex explicitly).
  // ---------------------------------------------------------------------------
  if (runHermesReferenceCheck) {
    assert.equal(existsSync(join(hermesBasePack, "pack.toml")), true, `explicit Hermes pack is invalid: ${hermesBasePack}`);
    assert.equal(existsSync(goldenProjectionPath), true, `explicit Skillex golden projection is missing: ${goldenProjectionPath}`);
    const repo = makeRepo("flatten-hermes-base");
    writeManifest(repo, { packs: [{ name: "hermes-base", version: "0.18.2" }], skills: [] });
    const env = { PJ_PACK_ROOT_PJTEST: selectedBmadPack, PJ_PACK_ROOT_HERMES_BASE: hermesBasePack };

    run(["migrate", "skills.project-manifest", repo, "--json"], env);
    const links = projectedLinks(repo);
    const golden = JSON.parse(readFileSync(goldenProjectionPath, "utf8"));
    assert.equal(
      links.size,
      golden.skills.length,
      `hermes-base 0.18.2 flattens to ${golden.skills.length} leaf skills, got ${links.size}`,
    );
    // Not just the count: every projected name must land on the golden's path.
    for (const skill of golden.skills) {
      assert.equal(links.get(skill.name), join(hermesBasePack, ...skill.relpath.split("/")), skill.name);
    }
    assert.equal(new Set(links.keys()).size, links.size, "hermes-base must carry no duplicate leaf basenames");

    for (const flat of ["computer-use", "dogfood", "hermes-desktop-plugins", "yuanbao"]) {
      assert.equal(links.get(flat), join(hermesBasePack, flat), `${flat} carries its own SKILL.md and is taken as-is`);
    }
    for (const container of ["apple", "creative", "github", "mlops", "software-development", "evaluation", "inference", "models"]) {
      assert.equal(links.has(container), false, `${container} is a container, not a skill`);
    }
    // Unbounded depth, proven against the real tree: these six sit under
    // `mlops/<sub-container>/` and are exactly what a one-level cap loses.
    for (const [grandchild, container] of [
      ["lm-evaluation-harness", "evaluation"],
      ["weights-and-biases", "evaluation"],
      ["vllm", "inference"],
      ["llama-cpp", "inference"],
      ["audiocraft", "models"],
      ["segment-anything", "models"],
    ]) {
      assert.equal(
        links.get(grandchild),
        join(hermesBasePack, "mlops", container, grandchild),
        `${grandchild} sits two levels down and must still be projected`,
      );
    }
    assert.equal(links.get("excalidraw"), join(hermesBasePack, "creative", "excalidraw"));
    // A leaf that ALSO carries a DESCRIPTION.md is still a skill: SKILL.md is the
    // discriminator, DESCRIPTION.md never is.
    assert.equal(
      links.get("ocr-and-documents"),
      join(hermesBasePack, "productivity", "ocr-and-documents"),
      "a leaf with its own DESCRIPTION.md is a skill, not a container",
    );

    // `software-development` has NO DESCRIPTION.md and is still a valid
    // container: the DESCRIPTION.md is upstream metadata, not the discriminator.
    assert.equal(existsSync(join(hermesBasePack, "software-development", "DESCRIPTION.md")), false);
    assert.equal(
      links.get("systematic-debugging"),
      join(hermesBasePack, "software-development", "systematic-debugging"),
      "software-development must still expand without a DESCRIPTION.md",
    );
    // Container-level files are never projected.
    assert.equal(links.has("DESCRIPTION.md"), false);

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"], env));
    const finding = audit.rules.find((rule) => rule.id === "skills.project-manifest");
    assert.equal(finding.status, "pass", JSON.stringify(finding));
    // Nothing under `mlops` is out of reach any more, so there is no advisory to
    // emit about it — and none about a container contributing nothing either.
    assert.doesNotMatch(
      JSON.stringify(finding),
      /does not expand|sub-containers|contributes no skills/,
      "every hermes-base container resolves; nothing is reported as unreachable",
    );
  } else {
    console.log(
      "optional Hermes reference assertions skipped; set both PJ_PACK_ROOT_HERMES_BASE and PJ_SKILLEX_REPO",
    );
  }

  // ---------------------------------------------------------------------------
  // A flattened LEAF name is lifted straight off the filesystem, so it must ALSO
  // match the canonical name shape (contract 3b). Without flatten a pack.toml
  // pack projects exactly the strings its author typed into `[freeform].skills`;
  // flatten is the one place an upstream directory name becomes a symlink name in
  // six CLI skill directories, where `-rf`, `--help`, `*` and embedded control
  // characters are argv- and glob-hostile. Skipped with a warning, never fatal.
  // ---------------------------------------------------------------------------
  {
    const pack = mkdtempSync(join(tmpdir(), "pjangler-flatten-hostile-"));
    temporaries.push(pack);
    writeFile(
      join(pack, "pack.toml"),
      [
        "[pack]",
        'name = "demo-flat"',
        'version = "1.0.0"',
        "",
        "[freeform]",
        'skills = ["grp", "allbad"]',
        "",
        "[policy]",
        "flatten = true",
        "",
      ].join("\n"),
    );
    // Every hostile basename is distinct across the two containers, so a run
    // WITHOUT the canonical gate projects them all rather than tripping the
    // duplicate-name error first — that is what makes this case discriminating.
    const hostile = ["*", "--help", "-rf", "a\nb", "con:", "tab\there", "SKILL.md-ish", "Upper"];
    const hostileAllBad = ["-delete", "?glob"];
    writeFile(join(pack, "grp", "DESCRIPTION.md"), "# grp\n");
    for (const name of [...hostile, "good-leaf"]) {
      writeFile(join(pack, "grp", name, "SKILL.md"), "# leaf\n");
    }
    // A container whose ONLY leaves are hostile still has to be reported, not
    // silently emptied.
    writeFile(join(pack, "allbad", "DESCRIPTION.md"), "# allbad\n");
    for (const name of hostileAllBad) writeFile(join(pack, "allbad", name, "SKILL.md"), "# leaf\n");

    const repo = makeRepo("flatten-hostile-repo");
    writeManifest(repo, { packs: [{ name: "demo-flat", version: "1.0.0" }], skills: [] });
    const env = { PJ_PACK_ROOT_PJTEST: selectedBmadPack, PJ_PACK_ROOT_DEMO_FLAT: pack };

    run(["migrate", "skills.project-manifest", repo, "--json"], env);
    const links = projectedLinks(repo);
    assert.deepEqual(
      [...links.keys()],
      ["good-leaf"],
      "only canonically-named leaves are projected; a hostile basename is skipped",
    );
    for (const name of [...hostile, ...hostileAllBad]) {
      assert.equal(links.has(name), false, `hostile leaf ${JSON.stringify(name)} must never be projected`);
    }
    // And nothing hostile reached ANY CLI skills directory either.
    for (const cli of [".claude", ".codex", ".gemini", ".copilot", ".opencode", ".kimi-code"]) {
      const dir = join(repo, cli, "skills");
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        assert.match(
          name,
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
          `${cli}/skills holds a non-canonical entry ${JSON.stringify(name)}`,
        );
      }
    }

    const audit = JSON.parse(runAllowFailure(["audit", repo, "--json"], env));
    const finding = audit.rules.find((rule) => rule.id === "skills.project-manifest");
    // A skip is an advisory, never a failure: one odd upstream directory must not
    // brick a whole pack.
    assert.equal(finding.status, "pass", JSON.stringify(finding));
    assert.match(finding.summary, /is not a canonical skill name/);
    assert.match(finding.summary, /"allbad" is a container that contributes no skills/);
    assert.deepEqual(finding.details, [], "an advisory is not a failure and must not become a detail");
  }

  console.log("pack flatten (PACKS-CONTRACT 3b) regressions passed");
} finally {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
}
