import "./helpers/hermetic-suite.mjs";
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
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { readActivationReceipt, sync } from "@delorenj/skillex";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, "node_modules", ".cache", `pjan-176-${process.pid}.mjs`);
buildSync({
  stdin: {
    contents: [
      'export { createMiseChecks, createAgentHooksChecks } from "./src/parity/rules";',
      'export { reconcileInstallerSkills, handOffInstallerSkills } from "./src/parity/skills";',
    ].join("\n"),
    resolveDir: root,
  },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const { createMiseChecks, createAgentHooksChecks, reconcileInstallerSkills, handOffInstallerSkills } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

const mise = createMiseChecks().find((check) => check.id === "mise.config-root");
const skills = createAgentHooksChecks().find((check) => check.id === "skills.project-manifest");

process.env.GIT_CEILING_DIRECTORIES = "/tmp";

function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function skill(name, body = "") { return `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# ${name}\n${body}`; }
const INSTALLED = skill("bmad-alpha", "the installer's copy\n");

async function fixture({ projectExclude, projectSkills = [], inherit = true } = {}) {
  const base = realpathSync(mkdtempSync("/tmp/pjan-176-"));
  const project = join(base, "project"), home = join(base, "home"), catalog = join(base, "registry");
  for (const path of [project, home, join(catalog, "all-skills"), join(catalog, "sets"), join(catalog, "packs")]) mkdirSync(path, { recursive: true });
  for (const name of ["bmad-alpha", "beta"]) put(join(catalog, "all-skills", name, "SKILL.md"), skill(name));
  // Inherited, as the real global bmad pack is.
  put(join(home, ".agents", "skills.json"), '{"skills":["bmad-alpha","beta"]}\n');
  put(join(project, ".agents", "skills.json"), `${JSON.stringify({ inherit_global: inherit, skills: projectSkills, ...(projectExclude ? { exclude: projectExclude } : {}) })}\n`);
  put(join(project, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  const saved = { registry: process.env.PJ_SKILLS_REGISTRY_ROOT, state: process.env.XDG_STATE_HOME };
  process.env.PJ_SKILLS_REGISTRY_ROOT = catalog;
  process.env.XDG_STATE_HOME = join(base, "state");
  const ctx = { repoRoot: project, targetDir: project, homeDir: home, pjanglerRoot: root, dryRun: false, force: false };
  await mise.migrate(ctx, await mise.audit(ctx));
  const gitEnv = hermeticEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: join(base, "xdg"), GIT_CEILING_DIRECTORIES: "/tmp",
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" });
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
    project, ctx, R, home, catalog,
    syncOptions: { cwd: project, project, scope: "project", home, env: process.env, registryRoot: catalog },
    /** What bmad-method leaves: a real skill directory plus its manifest row. */
    install({ listed = true } = {}) {
      rmSync(join(R, "bmad-alpha"), { recursive: true, force: true });
      put(join(R, "bmad-alpha", "SKILL.md"), INSTALLED);
      put(join(project, "_bmad", "_config", "skill-manifest.csv"), "canonicalId,name,description,module,path\n"
        + (listed ? '"bmad-alpha","bmad-alpha","Fixture","core","_bmad/core/bmad-alpha/SKILL.md"\n' : ""));
    },
    /** The installer stops providing bmad-alpha (removed module, BMAD uninstalled). */
    uninstall() {
      rmSync(join(R, "bmad-alpha"), { recursive: true, force: true });
      put(join(project, "_bmad", "_config", "skill-manifest.csv"), "canonicalId,name,description,module,path\n");
    },
    manifestText: () => readFileSync(join(project, ".agents", "skills.json"), "utf8"),
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

test("PJAN-176: an exclusion pjangler wrote is withdrawn once the installer stops providing the skill", async () => {
  const f = await fixture({ projectExclude: ["beta"] });
  try {
    f.install();
    await f.migrate();
    assert.deepEqual(f.manifest().exclude, ["beta", "bmad-alpha"]);
    f.uninstall();
    const finding = await f.audit();
    assert.equal(finding.status, "warn", "a stale handoff exclusion is surfaced, not silently passing");
    assert.equal(finding.fixable, true);
    assert.match(finding.details.join("\n"), /stale exclusion: bmad-alpha/);
    await f.migrate();
    assert.deepEqual(f.manifest().exclude, ["beta"], "only pjangler's own exclusion is withdrawn");
    assert.equal(realpathSync(join(f.R, "bmad-alpha")), realpathSync(join(f.catalog, "all-skills", "bmad-alpha")), "the inherited catalog skill returns");
    assert.equal((await f.audit()).status, "pass");
  } finally { f.close(); }
});

test("PJAN-176: an installer copy of an explicitly selected skill keeps blocking (the operator's call)", async () => {
  const f = await fixture({ projectSkills: ["bmad-alpha"], inherit: false });
  try {
    f.install();
    const finding = await f.audit();
    assert.equal(finding.fixable, false, JSON.stringify(finding.details));
    assert.match(finding.details.join("\n"), /also selects explicitly/);
    const before = f.manifestText();
    await f.migrate();
    assert.equal(f.manifestText(), before, "an explicit selection is never excluded");
    untouched(f);
  } finally { f.close(); }
});

test("PJAN-176: nothing is excluded beside a set (skillex refuses exclusions there)", async () => {
  const f = await fixture();
  try {
    f.install();
    put(join(f.project, ".agents", "skills.json"), `${JSON.stringify({ sets: ["team"] })}\n`);
    const before = f.manifestText();
    const handoff = await handOffInstallerSkills(f.ctx);
    assert.match(handoff.skipped ?? "", /a set replaces the project skills root/);
    assert.deepEqual(handoff.changedFiles, []);
    assert.equal(f.manifestText(), before);
  } finally { f.close(); }
});

test("PJAN-176: an interrupted skillex operation's journal is left for skillex to recover", async () => {
  const f = await fixture();
  try {
    await f.migrate();
    // Drop bmad-alpha from the selection and interrupt the sync mid-operation,
    // as SIGINT does: the receipt keeps a pending journal on the bmad-alpha link.
    put(join(f.home, ".agents", "skills.json"), '{"skills":["beta"]}\n');
    const receiptText = async () => { try { return readFileSync((await readActivationReceipt(f.project, { home: f.home, env: process.env })).path, "utf8"); } catch { return ""; } };
    let pending = false;
    const signal = { get aborted() { return pending; } };
    const poll = setInterval(async () => { if ((await receiptText()).includes('"pending"')) pending = true; }, 0);
    const interrupted = await sync({ ...f.syncOptions, signal });
    clearInterval(poll);
    const receipt = await readActivationReceipt(f.project, { home: f.home, env: process.env });
    // A sync that finished before the journal was observed proves nothing.
    assert.notEqual(receipt.document?.data?.pending, undefined, `precondition: the sync was interrupted mid-operation (${JSON.stringify(interrupted.findings)})`);
    put(join(f.home, ".agents", "skills.json"), '{"skills":["bmad-alpha","beta"]}\n');
    f.install();
    const before = JSON.stringify(receipt.document.data);
    const handoff = await handOffInstallerSkills(f.ctx);
    assert.match(handoff.skipped ?? "", /interrupted skillex operation/);
    const after = await readActivationReceipt(f.project, { home: f.home, env: process.env });
    assert.equal(JSON.stringify(after.document?.data), before, "the receipt is untouched while skillex owes a recovery");
    assert.equal((await f.audit()).fixable, false, "the audit does not send the operator into the handoff");
  } finally { f.close(); }
});

test("PJAN-176: an invalid project manifest is skillex's finding, never a handoff crash (gruvato)", async () => {
  const f = await fixture();
  try {
    f.install();
    put(join(f.project, ".agents", "skills.json"), `${JSON.stringify({ sets: ["one", "two"] })}\n`);
    const before = f.manifestText();
    const handoff = await handOffInstallerSkills(f.ctx);
    assert.match(handoff.skipped ?? "", /project skills manifest is invalid/);
    const finding = await f.audit();
    assert.equal(finding.status, "fail");
    assert.match(finding.details.join("\n"), /E_SET_CONFLICT/);
    assert.equal(f.manifestText(), before);
  } finally { f.close(); }
});

test("PJAN-144: the legacy registry field is fixable drift; migrate drops only that key, in place", async () => {
  const f = await fixture();
  try {
    await f.migrate();
    const manifestPath = join(f.project, ".agents", "skills.json");
    put(manifestPath, `${JSON.stringify({ $schema: "s", inherit_global: true, registry: "https://github.com/delorenj/skillex.git", skills: [], exclude: ["beta"] }, null, 2)}\n`);
    const finding = await f.audit();
    assert.equal(finding.status, "fail", JSON.stringify(finding.details));
    assert.equal(finding.fixable, true);
    assert.match(finding.details.join("\n"), /Drop the legacy "registry" field/);
    const preview = await f.migrate({ dryRun: true });
    assert.ok(preview.changedFiles.includes(manifestPath));
    assert.match(f.manifestText(), /"registry"/, "a preview writes nothing");
    await f.migrate();
    assert.deepEqual(Object.keys(f.manifest()), ["$schema", "inherit_global", "skills", "exclude"], "every other key kept, in order");
    assert.deepEqual(f.manifest().exclude, ["beta"]);
    assert.equal((await f.audit()).status, "pass");
  } finally { f.close(); }
});
