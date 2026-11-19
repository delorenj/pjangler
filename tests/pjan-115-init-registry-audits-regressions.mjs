import "./helpers/hermetic-suite.mjs";
// PJAN-115: `pj init` honors --registry when PLANNING (planProjectInit receives
// it, so registry.upsert writes the chosen registry) but dropped it in every
// audit along the init path. With an override, the plan wrote registry A while
// the audits judged the project against the default registry:
//
//   sync pre-audit   runAudit(target) omitted the registryPath argument
//   recipe audits    lifecycleContext(...) carried no registryPath, so
//                    ProjectRecipe's transactionContext (spread into the
//                    eligibility audit, the selected-rule migrations and the
//                    postcondition audit) answered about the default registry
//
// The observable damage went beyond reporting: the notebook.binding migration
// selected by the pre-audit resolved the DEFAULT registry, so an
// `init --registry chosen --apply` projected the default registry's binding
// into .project.json while the transaction was writing the chosen one.
//
// The fixture mirrors the defect's shape: the chosen registry agrees with the
// repo's manifest, the default registry carries a drifted binding. The
// pre-fix behavior of every case below was recorded by building the reverted
// source and running this exact scenario against it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { createBmadInstallerFixture, createSkillPackFixture, createSkillexMiseFixture } from "./helpers/pack-fixture.mjs";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "index.js");
const temporary = [];
let failures = 0;
let lifecycleEnv = {};

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message}`);
  }
}

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: hermeticEnv({ GIT_CEILING_DIRECTORIES: temporary[0] ?? tmpdir(), ...lifecycleEnv, ...env }),
    maxBuffer: 32 * 1024 * 1024,
  });
}

function json(result) {
  return JSON.parse(result.stdout);
}

/** An orphan-style sync target carrying a notebook binding in its manifest. */
function syncTarget(root, slug) {
  const dir = join(root, slug);
  mkdirSync(join(dir, "_bmad"), { recursive: true });
  mkdirSync(join(dir, ".agents"), { recursive: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, "mise.toml"), "[env]\n");
  writeFileSync(join(dir, ".copier-answers.yml"), `_src_path: x\nproject_name: ${slug}\n`);
  writeFileSync(
    join(dir, ".project.json"),
    `${JSON.stringify({ project_name: slug, project_slug: slug, repo_path: dir, notebook: { binding: { state: "planned" } } }, null, 2)}\n`,
  );
  assert.equal(existsSync(join(dir, ".git")), false, "the sync fixture has no git root — adoption is the path under test");
  return dir;
}

console.log("pjan-115 init --registry audit propagation");
try {
  const root = hermeticScratch("pjan-115-init-registry-");
  temporary.push(root);
  mkdirSync(join(root, "home", ".cache", "pjangler"), { recursive: true });
  writeFileSync(join(root, "home", ".cache", "pjangler", "bmad-dist-tags.json"), JSON.stringify({ fetchedAt: Date.now(), distTags: { latest: "6.11.1-next.1", next: "6.11.1-next.1" } }));
  const fixtureRoot = join(root, "skill-registry");
  createSkillPackFixture(fixtureRoot);
  lifecycleEnv = {
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "home", ".cache"),
    XDG_STATE_HOME: join(root, "state"),
    PATH: `${createSkillexMiseFixture(root)}:${process.env.PATH}`,
    SKILLEX_REGISTRY_ROOT: fixtureRoot,
    PJ_SKILLS_REGISTRY_ROOT: fixtureRoot,
    PJ_BMAD_INSTALLER: createBmadInstallerFixture(fixtureRoot),
  };

  // Two registries and two sync targets. The chosen registry agrees with each
  // manifest ({state: planned}); the default registry carries the SAME project
  // with a drifted binding, so a registry-blind audit reports drift while a
  // registry-aware one passes. Records are built through the real planning API
  // so the YAML is exactly what loadProjectRegistry validates.
  const projectBundle = join(root, "project-api.cjs");
  buildSync({ entryPoints: [join(ROOT, "src", "project", "index.ts")], bundle: true, platform: "node", format: "cjs", outfile: projectBundle, logLevel: "silent" });
  const { planProjectInit, loadProjectRegistry, saveProjectRegistry } = createRequire(import.meta.url)(projectBundle);
  const chosen = join(root, "chosen.yaml");
  const def = join(root, "default.yaml");
  const targets = {};
  const chosenReg = loadProjectRegistry(chosen);
  const defaultReg = loadProjectRegistry(def);
  for (const [slug, registryFile] of [["chosen-audit", chosen], ["default-audit", def]]) {
    const dir = syncTarget(root, slug);
    targets[slug] = dir;
    const plan = planProjectInit({
      name: slug,
      projectSlug: slug,
      targetDir: dir,
      registryPath: registryFile,
      scaffold: false,
      skipPlane: true,
      pjanglerRoot: ROOT,
      now: new Date(),
    });
    chosenReg.projects[slug] = { ...plan.project, notebook: { state: "planned" } };
    defaultReg.projects[slug] = { ...plan.project, notebook: { state: "planned", notebook_id: `nb-elsewhere-${slug}` } };
  }
  saveProjectRegistry(chosenReg, chosen);
  saveProjectRegistry(defaultReg, def);

  const target = targets["chosen-audit"];

  check("sync pre-audit judges the --registry override (binding passes under the chosen registry)", () => {
    const plan = json(cli(["init", "--target-dir", target, "--registry", chosen, "--dry-run", "--no-tui", "--json"]));
    assert.equal(plan.registryPath, chosen, "sanity: the plan itself targets the chosen registry");
    const binding = plan.audit.rules.find((rule) => rule.id === "notebook.binding");
    assert.equal(binding.status, "pass", `the chosen registry agrees with the manifest, so the pre-audit must pass: ${binding.summary}`);
    assert.equal(
      plan.proposedOperations.includes("parity:notebook.binding"),
      false,
      "no notebook.binding migration may be proposed when the chosen registry is already in agreement",
    );
  });

  check("sync pre-audit reports not-registered under an override that does not know the project", () => {
    const absent = join(root, "no-such-registry.yaml");
    const plan = json(cli(["init", "--target-dir", target, "--registry", absent, "--dry-run", "--no-tui", "--json"], { PJ_PROJECT_REGISTRY: def }));
    const configuration = plan.audit.rules.find((rule) => rule.id === "notebook.configuration");
    assert.equal(configuration.status, "fail", "the chosen (absent) registry has never heard of this project");
    assert.match(configuration.summary, /not registered/i);
  });

  check("no --registry keeps judging the default registry (unchanged behavior)", () => {
    const plan = json(cli(["init", "--target-dir", target, "--dry-run", "--no-tui", "--json"], { PJ_PROJECT_REGISTRY: def }));
    const binding = plan.audit.rules.find((rule) => rule.id === "notebook.binding");
    assert.equal(binding.status, "fail", "the default registry's drifted binding must still be reported");
    assert.match(binding.summary, /drifted/);
    assert.equal(
      plan.proposedOperations.includes("parity:notebook.binding"),
      true,
      "the drifted default binding must still propose its fixable migration",
    );
  });

  check("apply: the recipe's audits and migrations judge the chosen registry, not the default", () => {
    // The default registry (PJ_PROJECT_REGISTRY) carries the drifted binding,
    // so a registry-blind pre-audit selects the notebook.binding migration and
    // projects the DEFAULT registry's binding into .project.json. With the fix
    // the pre-audit passes under the chosen registry, nothing default-shaped
    // is selected, and the transaction converges on the chosen one.
    const applied = cli(
      ["init", "--target-dir", target, "--registry", chosen, "--skip-board", "--apply", "-y", "--no-tui", "--json"],
      { PJ_PROJECT_REGISTRY: def },
    );
    assert.equal(applied.status, 0, `apply must converge against the chosen registry: ${applied.stdout}${applied.stderr}`);
    const result = json(applied);
    assert.equal(result.ok, true, JSON.stringify(result.errors ?? []));
    const binding = (result.audit?.rules ?? []).find((rule) => rule.id === "notebook.binding");
    assert.equal(binding?.status, "pass", "the postcondition audit must judge the transaction by the chosen registry");
    const manifest = JSON.parse(readFileSync(join(target, ".project.json"), "utf8"));
    assert.equal(
      manifest.notebook?.binding?.notebook_id ?? undefined,
      undefined,
      `the default registry's binding must not leak into the manifest: ${JSON.stringify(manifest.notebook?.binding)}`,
    );
  });

  check("apply without --registry still resolves the default registry (unchanged behavior)", () => {
    const target2 = targets["default-audit"];
    const applied = cli(["init", "--target-dir", target2, "--skip-board", "--apply", "-y", "--no-tui", "--json"], { PJ_PROJECT_REGISTRY: def });
    assert.equal(applied.status, 0, `default apply must converge as it always did: ${applied.stdout}${applied.stderr}`);
    const manifest = JSON.parse(readFileSync(join(target2, ".project.json"), "utf8"));
    assert.equal(
      manifest.notebook?.binding?.notebook_id,
      "nb-elsewhere-default-audit",
      `the default registry's binding must still be projected when no override is given: ${JSON.stringify(manifest.notebook?.binding)}`,
    );
  });
} finally {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}

if (failures) {
  console.error(`pjan-115 init --registry audit propagation: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pjan-115 init registry audit regressions passed");
