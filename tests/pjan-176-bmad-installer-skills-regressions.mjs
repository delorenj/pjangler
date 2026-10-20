// PJAN-176: skills the BMAD installer provides satisfy the inherited Skillex selection.
//
// The global selection inherits the Skillex `bmad` pack; bmad-method writes the
// same skills as real directories under .agents/skills and lists them in
// _bmad/_config/skill-manifest.csv. skillex then refused every BMAD project
// (E_ACTIVATION_CONFLICT on foreign content), and every real `pj init` rolled
// back (E_OWNERSHIP_CHANGED: init links the pack, bmad.scaffold writes over the
// links). pjangler hands those names over: a project exclusion plus a receipt
// release, under skillex's activation lock. Real content is never touched.
//
// Real temp git repositories, a real git catalog, the REAL bundled
// @delorenj/skillex core, and the real rule objects bundled from src/. The live
// proof is a real `pj init` against the real bmad-method installer (PJAN-176).
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { readActivationReceipt } from "@delorenj/skillex";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, "node_modules", ".cache", `pjan-176-${process.pid}.mjs`);
buildSync({
  stdin: {
    contents: [
      'export { createMiseChecks, createAgentHooksChecks } from "./src/parity/rules";',
      'export { reconcileInstallerSkills } from "./src/parity/skills";',
    ].join("\n"),
    resolveDir: root,
  },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const { createMiseChecks, createAgentHooksChecks, reconcileInstallerSkills } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

const mise = createMiseChecks().find((check) => check.id === "mise.config-root");
const skills = createAgentHooksChecks().find((check) => check.id === "skills.project-manifest");

process.env.GIT_CEILING_DIRECTORIES = "/tmp";

function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function skill(name, body = "") { return `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# ${name}\n${body}`; }
const INSTALLED = skill("bmad-alpha", "the installer's copy\n");

async function fixture({ projectExclude } = {}) {
  const base = realpathSync(mkdtempSync("/tmp/pjan-176-"));
  const project = join(base, "project"), home = join(base, "home"), catalog = join(base, "registry");
  for (const path of [project, home, join(catalog, "all-skills"), join(catalog, "sets"), join(catalog, "packs")]) mkdirSync(path, { recursive: true });
  for (const name of ["bmad-alpha", "beta"]) put(join(catalog, "all-skills", name, "SKILL.md"), skill(name));
  // Inherited, as the real global bmad pack is.
  put(join(home, ".agents", "skills.json"), '{"skills":["bmad-alpha","beta"]}\n');
  put(join(project, ".agents", "skills.json"), `${JSON.stringify({ inherit_global: true, skills: [], ...(projectExclude ? { exclude: projectExclude } : {}) })}\n`);
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
  };
  git(project)("init", "-q");
  git(catalog)("init", "-q");
  git(catalog)("add", "-A");
  git(catalog)("commit", "-qm", "catalog");
  const R = join(project, ".agents", "skills");
  return {
    project, ctx, R,
    /** What bmad-method leaves: a real skill directory plus its manifest row. */
    install({ listed = true } = {}) {
      rmSync(join(R, "bmad-alpha"), { recursive: true, force: true });
      put(join(R, "bmad-alpha", "SKILL.md"), INSTALLED);
      put(join(project, "_bmad", "_config", "skill-manifest.csv"), "canonicalId,name,description,module,path\n"
        + (listed ? '"bmad-alpha","bmad-alpha","Fixture","core","_bmad/core/bmad-alpha/SKILL.md"\n' : ""));
    },
    manifest: () => JSON.parse(readFileSync(join(project, ".agents", "skills.json"), "utf8")),
    receiptLinks: async () => Object.keys((await readActivationReceipt(project, { home, env: process.env })).document?.data?.links ?? {}),
    audit: () => skills.audit(ctx),
    migrate: async (overrides = {}) => skills.migrate({ ...ctx, ...overrides }, await skills.audit({ ...ctx, ...overrides })),
    close() {
      for (const [key, value] of [["PJ_SKILLS_REGISTRY_ROOT", saved.registry], ["XDG_STATE_HOME", saved.state]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function untouched(f) {
  const stat = lstatSync(join(f.R, "bmad-alpha"));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "the installer's directory stays a real directory");
  assert.equal(readFileSync(join(f.R, "bmad-alpha", "SKILL.md"), "utf8"), INSTALLED, "the installer's content is untouched");
}

test("PJAN-176: an installer copy colliding with an inherited selection is excluded, the rest still syncs", async () => {
  const f = await fixture();
  try {
    f.install();
    const finding = await f.audit();
    assert.equal(finding.status, "fail", "precondition: skillex refuses at the installer's directory");
    assert.equal(finding.fixable, true, JSON.stringify(finding.details));
    const preview = await f.migrate({ dryRun: true });
    assert.notEqual(preview.status, "blocked", JSON.stringify(preview.details));
    assert.match(preview.details.join("\n"), /would exclude bmad-alpha/);
    assert.equal(f.manifest().exclude, undefined, "a preview writes nothing");
    const result = await f.migrate();
    assert.equal(result.status, "applied", JSON.stringify(result.details));
    assert.deepEqual(f.manifest().exclude, ["bmad-alpha"]);
    untouched(f);
    assert.ok(lstatSync(join(f.R, "beta")).isSymbolicLink(), "the remaining selection is activated");
    assert.equal((await f.audit()).status, "pass");
    assert.equal((await f.migrate()).status, "noop", "the handoff is idempotent");
  } finally { f.close(); }
});

test("PJAN-176: an installer that replaced a receipt-owned link (pj init order) is released and excluded", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.migrate()).status, "applied");
    const link = join(realpathSync(f.R), "bmad-alpha");
    assert.ok((await f.receiptLinks()).includes(link), "precondition: Skillex owns the bmad-alpha link");
    f.install();
    const finding = await f.audit();
    assert.equal(finding.status, "fail");
    assert.match(finding.details.join("\n"), /E_OWNERSHIP_CHANGED/);
    assert.equal(finding.fixable, true, JSON.stringify(finding.details));
    // The BMAD rules run this right after the installer.
    const handoff = await reconcileInstallerSkills(f.ctx);
    assert.equal(handoff.ok, true, JSON.stringify(handoff.details));
    assert.match(handoff.details.join("\n"), /release receipt ownership of \.agents\/skills\/bmad-alpha/);
    assert.ok(!(await f.receiptLinks()).includes(link), "the receipt no longer claims the installer's directory");
    assert.deepEqual(f.manifest().exclude, ["bmad-alpha"]);
    untouched(f);
    assert.equal((await f.audit()).status, "pass");
  } finally { f.close(); }
});

test("PJAN-176: a real directory the installer manifest does not list keeps blocking", async () => {
  const f = await fixture();
  try {
    f.install({ listed: false });
    const finding = await f.audit();
    assert.equal(finding.fixable, false, JSON.stringify(finding.details));
    assert.match(finding.details.join("\n"), /blocked: \.agents\/skills\/bmad-alpha is a real directory/);
    await f.migrate();
    assert.equal(f.manifest().exclude, undefined);
    untouched(f);
  } finally { f.close(); }
});

test("PJAN-176: operator exclusions are kept", async () => {
  const f = await fixture({ projectExclude: ["beta"] });
  try {
    f.install();
    assert.equal((await f.migrate()).status, "applied");
    assert.deepEqual(f.manifest().exclude, ["beta", "bmad-alpha"]);
    assert.equal((await f.audit()).status, "pass");
  } finally { f.close(); }
});
