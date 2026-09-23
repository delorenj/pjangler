// PJAN-135: every CLI skills root becomes the alias skillex requires, losslessly.
//
// Everything here is real: real temp repositories (git init, real directories
// and symlinks), the REAL bundled @delorenj/skillex core against a real temp
// catalog, and the real rule objects from src/. Nothing is mocked; the only
// stand-in is the "earlier rule" in the second-pass test, which exists to model
// "some other migration removed the blocker" and is itself real filesystem work.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { PROJECT_CLI_ALIASES, inspectStatus } from "@delorenj/skillex";

const root = resolve(import.meta.dirname, "..");
// Bundle the SOURCES (never dist/) into node_modules/.cache so bare imports
// resolve against the repo's node_modules exactly as the CLI's do.
const bundle = join(root, "node_modules", ".cache", `pjan-135-${process.pid}.mjs`);
buildSync({
  stdin: {
    contents: [
      'export { RecipeRegistry } from "./src/recipes/registry";',
      'export { createMiseChecks, createAgentHooksChecks, createBmadChecks } from "./src/parity/rules";',
      'export { planSkillRoots, applySkillRoots, SUPPORTED_SKILLS_ALIASES, CANONICAL_CLI_SKILLS_ALIAS } from "./src/parity/skill-roots";',
    ].join("\n"),
    resolveDir: root,
  },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const { RecipeRegistry, createMiseChecks, createAgentHooksChecks, createBmadChecks, planSkillRoots, applySkillRoots,
  SUPPORTED_SKILLS_ALIASES, CANONICAL_CLI_SKILLS_ALIAS } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

const mise = createMiseChecks().find((check) => check.id === "mise.config-root");
const skills = createAgentHooksChecks().find((check) => check.id === "skills.project-manifest");
const cliRoots = createBmadChecks().find((check) => check.id === "bmad.cli-roots");
const recipe = (check) => ({
  metadata: { id: check.id, name: check.title, description: "PJAN-135 regression", dependencies: [], commands: [], publicRuleIds: [check.id] },
  checks: [check],
  audit: async (ctx) => [await check.audit(ctx)],
  migrate: async (ctx) => [await check.migrate(ctx, await check.audit(ctx))],
});

// Test-created git repositories must never discover an enclosing one.
process.env.GIT_CEILING_DIRECTORIES = "/tmp";

function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function skill(name, body = "") { return `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# ${name}\n${body}`; }

/** Every entry below `dir`: name, inode, mode, link text or bytes. Includes .git. */
function snapshot(dir) {
  if (!existsSync(dir) && !lstatSafe(dir)) return null;
  return readdirSync(dir).sort().map((name) => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, stat.ino, stat.mode, stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? snapshot(path) : readFileSync(path).toString("base64")];
  });
}
function lstatSafe(path) { try { return lstatSync(path); } catch { return undefined; } }
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fixture({ select = ["alpha", "beta"], git = true } = {}) {
  const base = realpathSync(mkdtempSync("/tmp/pjan-135-"));
  const project = join(base, "project"), home = join(base, "home"), catalog = join(base, "registry");
  for (const path of [project, home, join(catalog, "all-skills"), join(catalog, "sets"), join(catalog, "packs")]) mkdirSync(path, { recursive: true });
  for (const name of ["alpha", "beta", "gamma"]) put(join(catalog, "all-skills", name, "SKILL.md"), skill(name));
  put(join(home, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
  put(join(project, ".agents", "skills.json"), `${JSON.stringify({ inherit_global: false, skills: select })}\n`);
  put(join(project, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  const saved = { registry: process.env.PJ_SKILLS_REGISTRY_ROOT, state: process.env.XDG_STATE_HOME };
  process.env.PJ_SKILLS_REGISTRY_ROOT = catalog;
  // skillex refuses state under any git work tree; keep it in this fixture.
  process.env.XDG_STATE_HOME = join(base, "state");
  const ctx = { repoRoot: project, targetDir: project, homeDir: home, pjanglerRoot: root, dryRun: false, force: false };
  // The task wiring is a separate concern; establish it so it never decides fixability here.
  await mise.migrate(ctx, await mise.audit(ctx));
  // Hermetic git: no global config, hooks or excludes from the operator's machine.
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: join(base, "xdg"),
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const gitRun = (...args) => {
    const result = spawnSync("git", args, { cwd: project, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  if (git) gitRun("init", "-q");
  const status = async () => inspectStatus({ cwd: project, project, scope: "project", home, env: process.env, registryRoot: catalog });
  const R = join(project, ".agents", "skills");
  return {
    base, project, home, catalog, ctx, R, git: gitRun, status,
    alias: (name = ".claude") => join(project, name, "skills"),
    audit: () => skills.audit(ctx),
    migrate: async (extra = {}) => skills.migrate({ ...ctx, ...extra }, await skills.audit({ ...ctx, ...extra })),
    close() {
      for (const [key, value] of [["PJ_SKILLS_REGISTRY_ROOT", saved.registry], ["XDG_STATE_HOME", saved.state]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** BMAD's own durable metadata for `ids`, hashing the given files exactly as the installer records them. */
function bmadManifests(project, files) {
  const rows = Object.entries(files).map(([rel, content]) => {
    const [id, ...rest] = rel.split("/");
    return `"file","${rest.join("/")}","core","core/${id}/${rest.join("/")}","${createHash("sha256").update(content).digest("hex")}"`;
  });
  const ids = [...new Set(Object.keys(files).map((rel) => rel.split("/")[0]))];
  put(join(project, "_bmad", "_config", "files-manifest.csv"), `type,name,module,path,hash\n${rows.join("\n")}\n`);
  put(join(project, "_bmad", "_config", "skill-manifest.csv"),
    `canonicalId,name,description,module,path\n${ids.map((id) => `"${id}","${id}","fixture","core","_bmad/core/${id}/SKILL.md"`).join("\n")}\n`);
}

test("the six aliases are exactly the ones the bundled skillex core checks", () => {
  assert.deepEqual([...SUPPORTED_SKILLS_ALIASES], [...PROJECT_CLI_ALIASES]);
  assert.equal(CANONICAL_CLI_SKILLS_ALIAS, "../.agents/skills");
});

test("infra shape: real .claude/skills with BMAD dirs and duplicate legacy links is fixable, converts losslessly, then passes", async () => {
  const f = await fixture(); try {
    // .agents/skills: the canonical links (absolute, like the legacy writers made) plus one hand-authored skill.
    for (const name of ["alpha", "beta"]) {
      mkdirSync(f.R, { recursive: true });
      symlinkSync(join(f.catalog, "all-skills", name), join(f.R, name));
    }
    put(join(f.R, "fix-camlink", "SKILL.md"), skill("fix-camlink"));
    const claude = f.alias(".claude");
    for (const name of ["alpha", "beta"]) { mkdirSync(claude, { recursive: true }); symlinkSync(join(f.catalog, "all-skills", name), join(claude, name)); }
    put(join(claude, "bmad-agent-dev", "SKILL.md"), skill("bmad-agent-dev"));
    put(join(claude, "bmad-agent-dev", "steps", "one.md"), "step one\n");
    put(join(claude, ".system", "marker"), "codex system entry\n");
    symlinkSync("../../../gone", join(claude, "hallmark"));
    const inode = lstatSync(join(claude, "bmad-agent-dev")).ino;

    const before = await f.status();
    assert.equal(before.exit, 3);
    assert.equal(before.findings[0].code, "E_ACTIVATION_CONFLICT");
    const finding = await f.audit();
    assert.equal(finding.status, "fail");
    assert.equal(finding.fixable, true, JSON.stringify(finding.details));
    assert.match(finding.details.join("\n"), /\.claude\/skills: real directory with 5 entries/);

    const result = await f.migrate();
    assert.equal(result.status, "applied", JSON.stringify(result, null, 2));
    assert.equal(readlinkSync(claude), "../.agents/skills");
    assert.equal(lstatSync(join(f.R, "bmad-agent-dev")).ino, inode, "moved by rename(2), not copied");
    assert.equal(readFileSync(join(f.R, "bmad-agent-dev", "steps", "one.md"), "utf8"), "step one\n");
    assert.equal(readFileSync(join(f.R, ".system", "marker"), "utf8"), "codex system entry\n");
    assert.equal(readFileSync(join(f.R, "fix-camlink", "SKILL.md"), "utf8"), skill("fix-camlink"));
    assert.equal(lstatSafe(join(f.R, "hallmark")), undefined, "the dangling link is dropped, not moved");
    assert.ok(result.details.some((line) => /drop duplicate link \.claude\/skills\/alpha/.test(line)));
    for (const alias of SUPPORTED_SKILLS_ALIASES) assert.equal(realpathSync(join(f.project, alias)), f.R, alias);
    const after = await f.status();
    assert.equal(after.exit, 0, JSON.stringify(after.findings));
    assert.equal((await f.audit()).status, "pass");
    // Idempotent: a second run changes nothing at all.
    const settled = snapshot(f.base);
    const again = await f.migrate();
    assert.equal(again.status, "noop", JSON.stringify(again));
    assert.deepEqual(snapshot(f.base), settled);
  } finally { f.close(); }
});

test("a real-directory collision with differing content leaves that root untouched and blocks with the path", async () => {
  const f = await fixture(); try {
    put(join(f.R, "bmad-agent-pm", "SKILL.md"), skill("bmad-agent-pm", "installed copy\n"));
    const claude = f.alias(".claude");
    put(join(claude, "bmad-agent-pm", "SKILL.md"), skill("bmad-agent-pm", "locally edited copy\n"));
    put(join(claude, "bmad-other", "SKILL.md"), skill("bmad-other"));
    const untouched = snapshot(join(f.project, ".claude"));
    const rootBefore = snapshot(f.R);
    const finding = await f.audit();
    assert.equal(finding.fixable, false, "a blocked alias conflict is not auto-fixable");
    assert.match(finding.details.join("\n"), /blocked: \.claude\/skills\/bmad-agent-pm differs from \.agents\/skills\/bmad-agent-pm: SKILL\.md content differs/);
    const result = await f.migrate();
    assert.ok(["blocked", "partial"].includes(result.status), JSON.stringify(result));
    assert.match(result.details.join("\n"), /bmad-agent-pm differs/);
    assert.deepEqual(snapshot(join(f.project, ".claude")), untouched, "no entry of a blocked root moves, not even the clean one");
    assert.deepEqual(snapshot(f.R), rootBefore);
  } finally { f.close(); }
});

test("a dangling alias is replaced, an alias already reaching .agents/skills is left alone, and one to another target blocks naming it", async () => {
  const f = await fixture(); try {
    mkdirSync(f.R, { recursive: true });
    mkdirSync(join(f.project, ".codex"), { recursive: true });
    symlinkSync("../.agents/skillz", f.alias(".codex"));
    const elsewhere = join(f.base, "elsewhere-skills"); mkdirSync(elsewhere);
    mkdirSync(join(f.project, ".gemini"), { recursive: true });
    symlinkSync(elsewhere, f.alias(".gemini"));
    mkdirSync(join(f.project, ".opencode"), { recursive: true });
    symlinkSync(f.R, f.alias(".opencode"));
    const plan = planSkillRoots(f.project);
    const byAlias = Object.fromEntries(plan.aliases.map((entry) => [entry.alias, entry]));
    assert.equal(byAlias[".codex/skills"].state, "dangling");
    // Any spelling that reaches .agents/skills is the alias skillex accepts; skillex
    // migrate writes this absolute form and records its inode (review F15).
    assert.equal(byAlias[".opencode/skills"].state, "alias");
    assert.deepEqual(byAlias[".opencode/skills"].operations, []);
    assert.equal(byAlias[".gemini/skills"].state, "foreign-link");
    assert.match(plan.blocks.join("\n"), new RegExp(`\\.gemini/skills is a symlink to ${elsewhere}`));
    const applied = applySkillRoots(f.project, { dryRun: false });
    assert.equal(applied.ok, false);
    assert.equal(readlinkSync(f.alias(".codex")), "../.agents/skills");
    assert.equal(readlinkSync(f.alias(".opencode")), f.R, "an alias that reaches .agents/skills is never rewritten");
    assert.equal(readlinkSync(f.alias(".gemini")), elsewhere, "a foreign link is never replaced");
  } finally { f.close(); }
});

test("tracked content moves only when attested BMAD output, and is then untracked", async () => {
  const f = await fixture(); try {
    const claude = f.alias(".claude");
    const files = { "bmad-attested/SKILL.md": skill("bmad-attested"), "bmad-attested/data/table.csv": "a,b\n" };
    for (const [rel, content] of Object.entries(files)) put(join(claude, rel), content);
    bmadManifests(f.project, files);
    put(join(claude, "hand-authored", "SKILL.md"), skill("hand-authored"));
    f.git("add", "-f", ".claude/skills", "_bmad");
    f.git("commit", "-qm", "fixture");
    const untouched = snapshot(join(f.project, ".claude"));
    const blocked = await f.migrate();
    assert.match(blocked.details.join("\n"), /\.claude\/skills\/hand-authored is tracked in git and not attested BMAD installer output: \.claude\/skills\/hand-authored\/SKILL\.md is outside the BMAD generated inventory/);
    assert.deepEqual(snapshot(join(f.project, ".claude")), untouched, "tracked non-attested content blocks the whole root");
    // Once the hand-authored skill is moved by its owner, the attested rest converts.
    f.git("mv", ".claude/skills/hand-authored", "hand-authored");
    f.git("commit", "-qm", "owner moved it");
    const converted = await f.migrate();
    assert.equal(converted.status, "applied", JSON.stringify(converted, null, 2));
    assert.equal(readlinkSync(claude), "../.agents/skills");
    assert.equal(readFileSync(join(f.R, "bmad-attested", "data", "table.csv"), "utf8"), "a,b\n");
    assert.equal(f.git("ls-files", "--", ".claude"), "", "generated output is no longer tracked");
    assert.match(converted.details.join("\n"), /untrack 2 paths under \.claude\/skills/);
  } finally { f.close(); }
});

test("dry run writes nothing (tree, inodes and git index) and reports the plan as changed paths", async () => {
  const f = await fixture(); try {
    mkdirSync(f.R, { recursive: true });
    symlinkSync(join(f.catalog, "all-skills", "alpha"), join(f.R, "alpha"));
    const claude = f.alias(".claude");
    put(join(claude, "bmad-x", "SKILL.md"), skill("bmad-x"));
    symlinkSync(join(f.catalog, "all-skills", "alpha"), join(claude, "alpha"));
    put(join(f.project, ".gitignore"), "/.agents/skills\n/.claude/skills\n");
    f.git("add", "-A"); f.git("commit", "-qm", "fixture");
    const before = digest(snapshot(f.base));
    const preview = await f.migrate({ dryRun: true });
    assert.equal(digest(snapshot(f.base)), before, "dry run must not write anything anywhere");
    assert.notEqual(preview.status, "blocked", JSON.stringify(preview));
    assert.ok(preview.changedFiles.includes(join(claude, "bmad-x")) && preview.changedFiles.includes(join(f.R, "bmad-x")));
    assert.ok(preview.changedFiles.includes(join(claude, "alpha")));
    assert.match(preview.details.join("\n"), /would replace the emptied \.claude\/skills directory/);
  } finally { f.close(); }
});

test("an interrupted conversion re-plans from disk and converges", async () => {
  const f = await fixture(); try {
    const claude = f.alias(".claude");
    put(join(f.R, "bmad-big", "SKILL.md"), skill("bmad-big"));
    put(join(f.R, "bmad-big", "a.md"), "a\n");
    put(join(f.R, "bmad-big", "b.md"), "b\n");
    // Interruption state: part of a duplicate was already removed, one entry already moved.
    put(join(claude, "bmad-big", "a.md"), "a\n");
    put(join(f.R, "bmad-moved", "SKILL.md"), skill("bmad-moved"));
    put(join(claude, "bmad-rest", "SKILL.md"), skill("bmad-rest"));
    const plan = planSkillRoots(f.project);
    assert.equal(plan.clean, true, plan.blocks.join("\n"));
    assert.deepEqual(plan.aliases[0].operations.map((op) => op.kind), ["drop-duplicate-entry", "move-entry", "convert-alias"]);
    const result = await f.migrate();
    assert.equal(result.status, "applied", JSON.stringify(result, null, 2));
    assert.equal(readFileSync(join(f.R, "bmad-big", "b.md"), "utf8"), "b\n");
    assert.ok(existsSync(join(f.R, "bmad-rest", "SKILL.md")));
    assert.equal((await f.status()).exit, 0);
  } finally { f.close(); }
});

test("a stub counterpart wholly contained in the alias entry is replaced by it (ssbnk shape)", async () => {
  const f = await fixture(); try {
    const claude = f.alias(".claude");
    // .agents/skills holds only the tests a partial install left behind.
    put(join(f.R, "bmad-advanced-elicitation", "scripts", "tests", "test_pick.py"), "def test(): pass\n");
    put(join(claude, "bmad-advanced-elicitation", "SKILL.md"), skill("bmad-advanced-elicitation"));
    put(join(claude, "bmad-advanced-elicitation", "scripts", "pick.py"), "print('pick')\n");
    put(join(claude, "bmad-advanced-elicitation", "scripts", "tests", "test_pick.py"), "def test(): pass\n");
    const inode = lstatSync(join(claude, "bmad-advanced-elicitation")).ino;
    // A stub with ANY entry the complete copy lacks is not a subset: blocked.
    put(join(f.R, "bmad-other", "notes.md"), "only here\n");
    put(join(claude, "bmad-other", "SKILL.md"), skill("bmad-other"));
    const blocked = planSkillRoots(f.project);
    assert.match(blocked.blocks.join("\n"), /\.claude\/skills\/bmad-other differs from \.agents\/skills\/bmad-other: SKILL\.md is missing from the counterpart/);
    rmSync(join(f.R, "bmad-other"), { recursive: true });
    const plan = planSkillRoots(f.project);
    assert.equal(plan.clean, true, plan.blocks.join("\n"));
    assert.ok(plan.operations.some((op) => op.kind === "replace-subset-counterpart"));
    const result = await f.migrate();
    assert.equal(result.status, "applied", JSON.stringify(result, null, 2));
    assert.equal(lstatSync(join(f.R, "bmad-advanced-elicitation")).ino, inode, "the complete copy moved in by rename(2)");
    assert.equal(readFileSync(join(f.R, "bmad-advanced-elicitation", "scripts", "pick.py"), "utf8"), "print('pick')\n");
    assert.equal(readFileSync(join(f.R, "bmad-advanced-elicitation", "scripts", "tests", "test_pick.py"), "utf8"), "def test(): pass\n");
    assert.equal((await f.status()).exit, 0);
  } finally { f.close(); }
});

test("root collisions: legacy links outside the repo are replaced; a repo-owned differing shadow blocks", async () => {
  const f = await fixture(); try {
    mkdirSync(f.R, { recursive: true });
    const outside = join(f.base, "legacy-checkout", "skills", "alpha");
    put(join(outside, "SKILL.md"), skill("alpha", "older copy\n"));
    symlinkSync(outside, join(f.R, "alpha"));
    symlinkSync(join(f.base, "removed", "beta"), join(f.R, "beta"));
    const finding = await f.audit();
    assert.equal(finding.fixable, true, JSON.stringify(finding.details));
    assert.match(finding.details.join("\n"), /resolvable root collision/);
    const result = await f.migrate();
    assert.equal(result.status, "applied", JSON.stringify(result, null, 2));
    assert.ok(result.details.includes(`replaced legacy link .agents/skills/alpha -> ${outside}`), result.details.join("\n"));
    assert.ok(result.details.some((line) => line.startsWith("replaced legacy link .agents/skills/beta -> ") && line.endsWith("(dangling)")));
    assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), skill("alpha", "older copy\n"), "unlinking never touches the target");
    assert.equal(realpathSync(join(f.R, "alpha")), join(f.catalog, "all-skills", "alpha"));
    assert.equal((await f.status()).exit, 0);
  } finally { f.close(); }

  const g = await fixture({ select: ["alpha", "gamma"] }); try {
    mkdirSync(g.R, { recursive: true });
    put(join(g.project, "skills", "alpha", "SKILL.md"), skill("alpha", "repo-local override\n"));
    put(join(g.project, "skills", "gamma", "SKILL.md"), skill("gamma"));
    symlinkSync("../../skills/alpha", join(g.R, "alpha"));
    symlinkSync("../../skills/gamma", join(g.R, "gamma"));
    const finding = await g.audit();
    assert.equal(finding.fixable, false, JSON.stringify(finding.details));
    assert.match(finding.details.join("\n"), /repo-owned skill alpha shadows a selected catalog skill/);
    const result = await g.migrate();
    assert.ok(["blocked", "partial"].includes(result.status));
    assert.equal(readlinkSync(join(g.R, "alpha")), "../../skills/alpha", "a repo-owned override is never unlinked");
    // An identical repo-owned copy is not an override: it makes way.
    renameSync(join(g.project, "skills", "alpha"), join(g.base, "parked-alpha"));
    put(join(g.project, "skills", "alpha", "SKILL.md"), skill("alpha"));
    const cleared = await g.migrate();
    assert.equal(cleared.status, "applied", JSON.stringify(cleared, null, 2));
    assert.match(cleared.details.join("\n"), /repo-owned content is identical to the catalog skill/);
    assert.equal((await g.status()).exit, 0);
  } finally { g.close(); }
});

test("bmad.cli-roots reports a real skills root as an issue, fixable only when the shared plan is clean, and converts it", async () => {
  const f = await fixture(); try {
    mkdirSync(f.R, { recursive: true });
    put(join(f.R, "bmad-demo", "SKILL.md"), skill("bmad-demo"));
    put(join(f.alias(".claude"), "bmad-demo", "SKILL.md"), skill("bmad-demo"));
    put(join(f.alias(".codex"), "bmad-codex-only", "SKILL.md"), skill("bmad-codex-only"));
    const finding = await cliRoots.audit(f.ctx);
    assert.equal(finding.status, "fail");
    assert.equal(finding.fixable, true, JSON.stringify(finding.details));
    assert.match(finding.details.join("\n"), /\.claude\/skills is a real directory, not the \.\.\/\.agents\/skills alias/);
    const migrated = await cliRoots.migrate(f.ctx, finding);
    assert.equal(migrated.status, "applied", JSON.stringify(migrated, null, 2));
    for (const alias of SUPPORTED_SKILLS_ALIASES) assert.equal(readlinkSync(join(f.project, alias)), "../.agents/skills", alias);
    assert.ok(existsSync(join(f.R, "bmad-codex-only", "SKILL.md")));
    // A differing collision stays unfixable and untouched.
    rmSync(f.alias(".claude")); put(join(f.alias(".claude"), "bmad-demo", "SKILL.md"), "edited\n");
    const blocked = await cliRoots.audit(f.ctx);
    assert.equal(blocked.fixable, false);
    assert.match(blocked.details.join("\n"), /blocked: \.claude\/skills\/bmad-demo differs/);
  } finally { f.close(); }
});

test("migrate --all promotes a rule an earlier migration unblocked into one bounded second pass", async () => {
  const f = await fixture(); try {
    // skills.project-manifest is not fixable up front: .claude/skills collides
    // with a differing .agents/skills/bmad-agent-pm the "earlier" rule parks.
    put(join(f.R, "bmad-agent-pm", "SKILL.md"), "stale installer copy\n");
    put(join(f.alias(".claude"), "bmad-agent-pm", "SKILL.md"), skill("bmad-agent-pm"));
    const parked = join(f.project, "parked-bmad-agent-pm");
    const unblocker = {
      id: "fixture.park-stale-root-entry",
      title: "Park a stale .agents/skills entry (models an earlier rule, e.g. a BMAD reinstall)",
      audit: () => ({ id: "fixture.park-stale-root-entry", title: "park", status: existsSync(join(f.R, "bmad-agent-pm")) && !existsSync(parked) ? "fail" : "pass",
        summary: "stale entry", details: [], fixable: true }),
      migrate: (ctx, finding) => { renameSync(join(f.R, "bmad-agent-pm"), parked);
        return { id: finding.id, title: finding.title, status: "applied", summary: "parked", changedFiles: [parked], details: [] }; },
    };
    const registry = new RecipeRegistry([recipe(unblocker), recipe(skills)]);
    const pre = await skills.audit(f.ctx);
    assert.equal(pre.fixable, false, JSON.stringify(pre.details));
    const report = await registry.migrateAll(f.ctx);
    const result = report.results.find((item) => item.id === skills.id);
    assert.equal(result.status, "applied", JSON.stringify(report, null, 2));
    assert.ok(!result.details.some((line) => /not auto-fixable/.test(line)));
    assert.equal(report.ok, true);
    assert.equal(readlinkSync(f.alias(".claude")), "../.agents/skills");
    assert.equal((await f.status()).exit, 0);
  } finally { f.close(); }
});
