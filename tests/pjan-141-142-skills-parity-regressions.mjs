// PJAN-141 / PJAN-142: skills.project-manifest must not report drift that is not there.
//
// PJAN-141: the activation receipt records the catalog commit it was written
// against. One commit to all-skills (a script in an unrelated skill) left all 38
// passing repositories failing with a single `write-receipt` change although no
// link moved. A receipt-only refresh is host bookkeeping: warn, never fail.
//
// PJAN-142: a component repository's own skill (bloodbank-integration, momo,
// pjangler's mise-versioning) can never be byte-identical to its catalog copy,
// because `skillex vendor` stamps `.source.yaml` on every vendored skill and a
// locally run skill leaves `__pycache__`. The repo-owned collision check must
// compare the SKILL, not the provenance.
//
// Everything is real: temp git repositories, a real git catalog, the REAL bundled
// @delorenj/skillex core, and the real rule objects bundled from src/.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { inspectStatus } from "@delorenj/skillex";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, "node_modules", ".cache", `pjan-141-142-${process.pid}.mjs`);
buildSync({
  stdin: {
    contents: [
      'export { RecipeRegistry } from "./src/recipes/registry";',
      'export { createMiseChecks, createAgentHooksChecks } from "./src/parity/rules";',
      'export { treesIdentical, skillContentIdentical } from "./src/parity/skill-roots";',
    ].join("\n"),
    resolveDir: root,
  },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const { RecipeRegistry, createMiseChecks, createAgentHooksChecks, treesIdentical, skillContentIdentical } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

const mise = createMiseChecks().find((check) => check.id === "mise.config-root");
const skills = createAgentHooksChecks().find((check) => check.id === "skills.project-manifest");
const recipe = (check) => ({
  metadata: { id: check.id, name: check.title, description: "PJAN-141/142 regression", dependencies: [], commands: [], publicRuleIds: [check.id] },
  checks: [check],
  audit: async (ctx) => [await check.audit(ctx)],
  migrate: async (ctx) => [await check.migrate(ctx, await check.audit(ctx))],
});

process.env.GIT_CEILING_DIRECTORIES = "/tmp";

function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function skill(name, body = "") { return `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# ${name}\n${body}`; }
const PROVENANCE = "origin:\n  type: vendored\n  source: component\n  upstream_path: skills/alpha\nmodified_locally: false\n";

async function fixture({ select = ["alpha"] } = {}) {
  const base = realpathSync(mkdtempSync("/tmp/pjan-141-142-"));
  const project = join(base, "project"), home = join(base, "home"), catalog = join(base, "registry");
  for (const path of [project, home, join(catalog, "all-skills"), join(catalog, "sets"), join(catalog, "packs")]) mkdirSync(path, { recursive: true });
  for (const name of ["alpha", "beta"]) put(join(catalog, "all-skills", name, "SKILL.md"), skill(name));
  put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(project, ".agents", "skills.json"), `${JSON.stringify({ inherit_global: false, skills: select })}\n`);
  put(join(project, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  const saved = { registry: process.env.PJ_SKILLS_REGISTRY_ROOT, state: process.env.XDG_STATE_HOME };
  process.env.PJ_SKILLS_REGISTRY_ROOT = catalog;
  process.env.XDG_STATE_HOME = join(base, "state");
  const ctx = { repoRoot: project, targetDir: project, homeDir: home, pjanglerRoot: root, dryRun: false, force: false };
  await mise.migrate(ctx, await mise.audit(ctx));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: join(base, "xdg"),
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (cwd) => (...args) => {
    const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  git(project)("init", "-q");
  // The catalog is a git repository, as ~/code/skillex/all-skills is.
  git(catalog)("init", "-q");
  git(catalog)("add", "-A");
  git(catalog)("commit", "-qm", "catalog");
  const R = join(project, ".agents", "skills");
  return {
    base, project, catalog, ctx, R, git: git(project), catalogGit: git(catalog),
    status: () => inspectStatus({ cwd: project, project, scope: "project", home, env: process.env, registryRoot: catalog }),
    audit: () => skills.audit(ctx),
    migrate: async () => skills.migrate(ctx, await skills.audit(ctx)),
    registry: () => new RecipeRegistry([recipe(skills)]),
    close() {
      for (const [key, value] of [["PJ_SKILLS_REGISTRY_ROOT", saved.registry], ["XDG_STATE_HOME", saved.state]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test("PJAN-141: a catalog commit that moves no link leaves the project in parity (warn, not fail)", async () => {
  const f = await fixture();
  try {
    await f.migrate();
    assert.equal((await f.audit()).status, "pass");
    // An unrelated skill changes in the catalog: exactly what 6b4aee3 did.
    put(join(f.catalog, "all-skills", "beta", "SKILL.md"), skill("beta", "edited upstream\n"));
    f.catalogGit("commit", "-qam", "edit an unselected skill");
    const status = await f.status();
    assert.deepEqual((status.data?.changes ?? []).map((change) => change.action), ["write-receipt"],
      `precondition: only the receipt is stale (${JSON.stringify(status.data?.changes)})`);
    const finding = await f.audit();
    assert.equal(finding.status, "warn", JSON.stringify(finding.details));
    assert.equal(finding.fixable, true);
    assert.match(finding.details.join("\n"), /only the activation receipt is stale/);
    const report = await f.registry().auditRecipes(f.ctx);
    assert.equal(report.ok, true, "a receipt-only refresh must not gate the project");
    // migrate still refreshes it.
    await f.migrate();
    assert.equal((await f.audit()).status, "pass");
  } finally { f.close(); }
});

test("PJAN-141: a missing link is still drift and still fails", async () => {
  const f = await fixture();
  try {
    await f.migrate();
    rmSync(join(f.R, "alpha"));
    put(join(f.catalog, "all-skills", "beta", "SKILL.md"), skill("beta", "edited upstream\n"));
    f.catalogGit("commit", "-qam", "edit");
    const finding = await f.audit();
    assert.equal(finding.status, "fail", JSON.stringify(finding.details));
    assert.ok(!finding.details.some((line) => /only the activation receipt is stale/.test(line)));
    assert.equal((await f.registry().auditRecipes(f.ctx)).ok, false);
  } finally { f.close(); }
});

/** A component repository that owns `alpha` and links it from its own projection root. */
function ownSkill(f, { body = "", pycache = true } = {}) {
  put(join(f.project, "skills", "alpha", "SKILL.md"), skill("alpha", body));
  if (pycache) put(join(f.project, "skills", "alpha", "scripts", "__pycache__", "run.cpython-314.pyc"), "bytecode\n");
  put(join(f.catalog, "all-skills", "alpha", ".source.yaml"), PROVENANCE);
  mkdirSync(f.R, { recursive: true });
  symlinkSync("../../skills/alpha", join(f.R, "alpha"));
  f.git("add", "skills");
  f.git("commit", "-qm", "component skill");
}

test("PJAN-142: a repo-owned skill identical to its vendored catalog copy makes way (provenance and bytecode aside)", async () => {
  const f = await fixture();
  try {
    ownSkill(f);
    const own = join(f.project, "skills", "alpha"), canon = join(f.catalog, "all-skills", "alpha");
    assert.equal(treesIdentical(own, canon), false, "precondition: byte identity cannot hold");
    assert.equal(skillContentIdentical(own, canon), true);
    const finding = await f.audit();
    assert.equal(finding.fixable, true, JSON.stringify(finding.details));
    assert.match(finding.details.join("\n"), /resolvable root collision: replace link \.agents\/skills\/alpha -> \.\.\/\.\.\/skills\/alpha: its repo-owned content is identical/);
    await f.migrate();
    assert.equal(realpathSync(join(f.R, "alpha")), realpathSync(canon), "the selected catalog skill is linked");
    assert.equal(readFileSync(join(own, "SKILL.md"), "utf8"), skill("alpha"), "the repository's own skill is untouched");
    assert.equal((await f.audit()).status, "pass");
  } finally { f.close(); }
});

test("PJAN-142: a repo-owned skill that differs from the catalog copy stays blocked", async () => {
  const f = await fixture();
  try {
    ownSkill(f, { body: "a local override\n" });
    const finding = await f.audit();
    assert.equal(finding.fixable, false);
    assert.match(finding.details.join("\n"), /blocked: repo-owned skill alpha shadows a selected catalog skill/);
    await f.migrate();
    assert.equal(readlinkSync(join(f.R, "alpha")), "../../skills/alpha", "a blocked override is never replaced");
  } finally { f.close(); }
});

test("PJAN-142: only the root provenance file is metadata; a nested .source.yaml is content", () => {
  const base = realpathSync(mkdtempSync("/tmp/pjan-142-nested-"));
  try {
    const left = join(base, "left"), right = join(base, "right");
    for (const dir of [left, right]) put(join(dir, "SKILL.md"), skill("alpha"));
    put(join(right, ".source.yaml"), PROVENANCE);
    assert.equal(skillContentIdentical(left, right), true);
    put(join(right, "references", ".source.yaml"), PROVENANCE);
    assert.equal(skillContentIdentical(left, right), false);
    rmSync(join(right, "references"), { recursive: true });
    put(join(left, "run.py"), "print('x')\n");
    assert.equal(skillContentIdentical(left, right), false, "authored source still counts");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
