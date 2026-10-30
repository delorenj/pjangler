import "./helpers/hermetic-suite.mjs";
// PJAN-144: dropping the legacy "registry" field from a project manifest.
//
// With the field, skillex resolves the project from the never-fetched
// ~/.agents/.cache registry clone while the global scope (no field) resolves
// from the catalog checkout. Here registry discovery is real: no
// PJ_SKILLS_REGISTRY_ROOT, so both catalogs are found the way they are on a host
// (a checkout at ~/code/skillex, a cache clone keyed by the registry URL). Real
// temp git catalogs, the REAL bundled @delorenj/skillex core, real rule objects.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, "node_modules", ".cache", `pjan-144-${process.pid}.mjs`);
buildSync({
  stdin: { contents: 'export { createMiseChecks, createAgentHooksChecks } from "./src/parity/rules";', resolveDir: root },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const { createMiseChecks, createAgentHooksChecks } = await import(pathToFileURL(bundle).href);
rmSync(bundle);
const mise = createMiseChecks().find((check) => check.id === "mise.config-root");
const skills = createAgentHooksChecks().find((check) => check.id === "skills.project-manifest");

const URL = "https://github.com/delorenj/skillex.git";
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const skill = (name) => `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# ${name}\n`;

async function fixture({ projectSkills, cacheOnly = [] }) {
  const base = realpathSync(mkdtempSync("/tmp/pjan-144-"));
  const home = join(base, "home"), project = join(base, "project");
  const checkout = join(home, "code", "skillex");
  const cache = join(home, ".agents", ".cache", "registries", URL.replace(/[^a-zA-Z0-9]/g, "_"));
  for (const catalog of [checkout, cache]) {
    for (const dir of ["all-skills", "sets", "packs"]) mkdirSync(join(catalog, dir), { recursive: true });
    put(join(catalog, "all-skills", "beta", "SKILL.md"), skill("beta"));
  }
  for (const name of cacheOnly) put(join(cache, "all-skills", name, "SKILL.md"), skill(name));
  const saved = { registry: process.env.PJ_SKILLS_REGISTRY_ROOT, state: process.env.XDG_STATE_HOME, ceiling: process.env.GIT_CEILING_DIRECTORIES };
  delete process.env.PJ_SKILLS_REGISTRY_ROOT;
  process.env.XDG_STATE_HOME = join(base, "state");
  process.env.GIT_CEILING_DIRECTORIES = "/tmp";
  const gitEnv = hermeticEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: join(base, "xdg"), GIT_CEILING_DIRECTORIES: "/tmp",
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" });
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  for (const catalog of [checkout, cache]) { git(catalog, "init", "-q"); git(catalog, "add", "-A"); git(catalog, "commit", "-qm", "catalog"); }
  put(join(home, ".agents", "skills.json"), '{"skills":["beta"]}\n');
  put(join(project, ".agents", "skills.json"), `${JSON.stringify({ inherit_global: true, registry: URL, skills: projectSkills }, null, 2)}\n`);
  put(join(project, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  git(project, "init", "-q");
  const ctx = { repoRoot: project, targetDir: project, homeDir: home, pjanglerRoot: root, dryRun: false, force: false };
  await mise.migrate(ctx, await mise.audit(ctx));
  return {
    ctx,
    manifest: () => JSON.parse(readFileSync(join(project, ".agents", "skills.json"), "utf8")),
    audit: (overrides = {}) => skills.audit({ ...ctx, ...overrides }),
    migrate: async (overrides = {}) => skills.migrate({ ...ctx, ...overrides }, await skills.audit({ ...ctx, ...overrides })),
    close() {
      for (const [key, value] of [["PJ_SKILLS_REGISTRY_ROOT", saved.registry], ["XDG_STATE_HOME", saved.state], ["GIT_CEILING_DIRECTORIES", saved.ceiling]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test("PJAN-144: an inherited skill re-selected through the cache clone previews and applies cleanly (HeyMa)", async () => {
  const f = await fixture({ projectSkills: ["beta"] });
  try {
    const before = await f.audit();
    assert.equal(before.fixable, true, JSON.stringify(before.details));
    const preview = await f.migrate({ dryRun: true });
    assert.notEqual(preview.status, "blocked", JSON.stringify(preview.details));
    assert.notEqual(preview.status, "partial", "the preview must not report the divergence the drop removes");
    assert.equal(f.manifest().registry, URL, "a preview writes nothing");
    const applied = await f.migrate();
    assert.equal(applied.status, "applied", JSON.stringify(applied.details));
    assert.equal("registry" in f.manifest(), false);
    assert.equal((await f.audit()).status, "pass");
  } finally { f.close(); }
});

test("PJAN-144: a project that only resolves through the cache clone keeps the field and says why", async () => {
  const f = await fixture({ projectSkills: ["legacy-only"], cacheOnly: ["legacy-only"] });
  try {
    const finding = await f.audit();
    assert.equal(finding.status, "fail");
    assert.match(finding.details.join("\n"), /blocked: kept the legacy registry field/);
    assert.doesNotMatch(finding.details.join("\n"), /Drop the legacy "registry" field/, "an unsafe drop is never offered as a fix");
    const preview = await f.migrate({ dryRun: true });
    assert.match(preview.details.join("\n"), /kept the legacy registry field/);
    const result = await f.migrate();
    assert.notEqual(result.status, "applied");
    assert.equal(f.manifest().registry, URL, "the field stays, so the project still resolves");
  } finally { f.close(); }
});
