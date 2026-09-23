// PJAN-135: data-safety regressions for the CLI skills-root conversion.
//
// Each test is the reproduction of one confirmed review finding, run against
// real temp git repositories, the real filesystem and the real bundled
// @delorenj/skillex core (and its real CLI where the finding is a CLI flow).
// Invariants under test: nothing that is not a proven duplicate is destroyed;
// a blocked root is left exactly as it was; dry run, audit and apply use one
// plan and agree; the result is re-derived from disk.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadSources, lstatSafe, put, rawRepo, readSafe, repoRoot, repoState, skill, skillFixture } from "./helpers/skill-roots-harness.mjs";

const sources = await loadSources();
const { applySkillRoots, planSkillRoots, SUPPORTED_SKILLS_ALIASES } = sources;

const stripWould = (lines) => lines.filter((line) => !line.startsWith("blocked:")).map((line) => line.replace(/^would /, ""));

// ---------------------------------------------------------------------------
// Critical: self-referential duplicate proofs (review F1, F3, F9/A1, F9/A2)
// ---------------------------------------------------------------------------

test("F1/A1: a .agents/skills link back into the alias entry is never a duplicate; the only copy survives and the root blocks", async () => {
  const f = await skillFixture(sources, { tag: "f1" }); try {
    const claude = f.alias(".claude");
    put(join(claude, "myskill", "SKILL.md"), "hand authored only copy\n");
    mkdirSync(f.R, { recursive: true });
    symlinkSync("../../.claude/skills/myskill", join(f.R, "myskill"));
    const before = repoState(f.project);

    const direct = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(direct.ok, false, JSON.stringify(direct.details));
    assert.match(direct.blocks.join("\n"), /\.agents\/skills\/myskill.*(resolves|points) (back )?into/);
    assert.deepEqual(repoState(f.project), before, "a blocked root is left exactly as it was");

    const audit = await f.audit();
    assert.equal(audit.fixable, false, JSON.stringify(audit.details));
    const cli = await f.cliRoots.audit(f.ctx);
    assert.equal(cli.fixable, false, JSON.stringify(cli.details));
    const dry = await f.migrate({ dryRun: true });
    assert.notEqual(dry.status, "applied", JSON.stringify(dry));
    const applied = await f.migrate();
    assert.notEqual(applied.status, "applied", JSON.stringify(applied));
    assert.equal(readSafe(join(claude, "myskill", "SKILL.md")), "hand authored only copy\n");
    assert.equal(readSafe(join(f.R, "myskill", "SKILL.md")), "hand authored only copy\n");
    assert.ok(lstatSync(claude).isDirectory() && !lstatSync(claude).isSymbolicLink());
  } finally { f.close(); }
});

test("F1/s8: a counterpart link into another CLI root keeps both identical copies", () => {
  const f = rawRepo("f1s8"); try {
    for (const cli of [".claude", ".codex"]) put(join(f.alias(cli), "foo", "SKILL.md"), "identical\n");
    mkdirSync(f.R, { recursive: true });
    symlinkSync("../../.codex/skills/foo", join(f.R, "foo"));
    const before = repoState(f.project);
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills", ".codex/skills"] });
    assert.equal(result.ok, false, JSON.stringify(result.details));
    assert.deepEqual(repoState(f.project), before);
    for (const path of [f.alias(".claude"), f.alias(".codex"), f.R]) assert.equal(readSafe(join(path, "foo", "SKILL.md")), "identical\n", path);
  } finally { f.close(); }
});

test("F3: an alias link whose .agents/skills counterpart resolves back through it keeps the only pointer", () => {
  const f = rawRepo("f3"); try {
    const elsewhere = join(f.base, "elsewhere", "deep", "foo");
    put(join(elsewhere, "SKILL.md"), "real\n");
    mkdirSync(f.alias(".claude"), { recursive: true });
    mkdirSync(f.R, { recursive: true });
    symlinkSync(elsewhere, join(f.alias(".claude"), "foo"));
    symlinkSync("../../.claude/skills/foo", join(f.R, "foo"));
    const before = repoState(f.project);
    const dry = applySkillRoots(f.project, { dryRun: true, aliases: [".claude/skills"] });
    assert.equal(dry.ok, false, JSON.stringify(dry.details));
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(result.ok, false);
    assert.deepEqual(repoState(f.project), before);
    assert.equal(readSafe(join(f.alias(".claude"), "foo", "SKILL.md")), "real\n");
    assert.equal(readSafe(join(f.R, "foo", "SKILL.md")), "real\n");
  } finally { f.close(); }
});

test("F9/A2: a link into another CLI root's real entry is not that entry's duplicate; content survives every run and converges", () => {
  const f = rawRepo("a2"); try {
    put(join(f.alias(".opencode"), "code-review", "SKILL.md"), "opencode original\n");
    mkdirSync(f.alias(".claude"), { recursive: true });
    symlinkSync("../../.opencode/skills/code-review", join(f.alias(".claude"), "code-review"));
    mkdirSync(f.R, { recursive: true });
    let last;
    for (let run = 0; run < 3; run++) {
      last = applySkillRoots(f.project, { dryRun: false });
      for (const path of [f.alias(".claude"), f.alias(".opencode")]) {
        assert.equal(readSafe(join(path, "code-review", "SKILL.md")), "opencode original\n", `run ${run}: ${path}`);
      }
      if (last.ok) break;
    }
    assert.equal(last.ok, true, JSON.stringify(last));
    assert.equal(readSafe(join(f.R, "code-review", "SKILL.md")), "opencode original\n");
    assert.ok(lstatSync(join(f.R, "code-review")).isDirectory() && !lstatSync(join(f.R, "code-review")).isSymbolicLink());
    for (const alias of SUPPORTED_SKILLS_ALIASES) assert.equal(realpathSync(join(f.project, alias)), f.R, alias);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Critical: symlinked .agents (review F2, F9/A4)
// ---------------------------------------------------------------------------

test("F2/A4: .agents -> .claude blocks every conversion; nothing is dropped as its own duplicate", async () => {
  const f = rawRepo("f2"); try {
    for (const name of ["alpha", "beta"]) put(join(f.alias(".claude"), name, "SKILL.md"), `${name} only copy\n`);
    symlinkSync(".claude", join(f.project, ".agents"));
    const before = repoState(f.project);
    const plan = planSkillRoots(f.project);
    assert.equal(plan.clean, false);
    assert.equal(plan.operations.length, 0, "a symlinked .agents plans nothing at all");
    const result = applySkillRoots(f.project, { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.blocks.join("\n"), /\.agents is a symlink/);
    assert.deepEqual(repoState(f.project), before);
    for (const name of ["alpha", "beta"]) assert.equal(readSafe(join(f.alias(".claude"), name, "SKILL.md")), `${name} only copy\n`);
  } finally { f.close(); }
});

test("F2/s3: .agents -> a shared directory never moves project skills out of the repository", async () => {
  const f = rawRepo("f2s"); try {
    const shared = join(f.base, "shared-agents");
    put(join(shared, "skills", "common", "SKILL.md"), "common\n");
    put(join(f.alias(".claude"), "common", "SKILL.md"), "common\n");
    put(join(f.alias(".claude"), "proj", "SKILL.md"), "project only\n");
    symlinkSync(shared, join(f.project, ".agents"));
    const before = repoState(f.project);
    const sharedBefore = repoState(shared);
    const result = applySkillRoots(f.project, { dryRun: false });
    assert.equal(result.ok, false);
    assert.deepEqual(repoState(f.project), before);
    assert.deepEqual(repoState(shared), sharedBefore);
  } finally { f.close(); }
});

test("F2 through the rule: skills.project-manifest never deletes before skillex refuses a symlinked .agents", async () => {
  const f = await skillFixture(sources, { tag: "f2r" }); try {
    // Keep the manifest reachable through the symlinked .agents.
    renameSync(join(f.project, ".agents", "skills.json"), join(f.base, "skills.json"));
    readdirSync(join(f.project, ".agents")).length || spawnSync("rmdir", [join(f.project, ".agents")]);
    for (const name of ["alpha", "beta"]) put(join(f.alias(".claude"), name, "SKILL.md"), `${name} hand authored\n`);
    renameSync(join(f.base, "skills.json"), join(f.project, ".claude", "skills.json"));
    symlinkSync(".claude", join(f.project, ".agents"));
    const result = await f.migrate();
    assert.notEqual(result.status, "applied");
    for (const name of ["alpha", "beta"]) assert.equal(readSafe(join(f.alias(".claude"), name, "SKILL.md")), `${name} hand authored\n`);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// High: nested repositories and submodules (review F10)
// ---------------------------------------------------------------------------

test("F10/B1: a CLI skills root that is its own git clone is never relocated", () => {
  const f = rawRepo("b1"); try {
    const claude = f.alias(".claude");
    put(join(claude, "team-skill", "SKILL.md"), skill("team-skill"));
    put(join(claude, "TEAMFILE.md"), "team\n");
    f.gitIn(claude, "init", "-q");
    f.gitIn(claude, "remote", "add", "origin", "git@example:team/skills.git");
    f.gitIn(claude, "add", "-A"); f.gitIn(claude, "commit", "-qm", "team");
    const before = repoState(f.project);
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(result.ok, false);
    assert.match(result.blocks.join("\n"), /\.claude\/skills.*(its own git repository|another git work tree|nested git)/);
    assert.deepEqual(repoState(f.project), before);
  } finally { f.close(); }
});

test("F10/B2: a submodule at a CLI skills root is never relocated and the parent stays operable", () => {
  const f = rawRepo("b2"); try {
    const team = join(f.base, "team");
    put(join(team, "team-skill", "SKILL.md"), skill("team-skill"));
    mkdirSync(team, { recursive: true });
    f.gitIn(team, "init", "-q"); f.gitIn(team, "add", "-A"); f.gitIn(team, "commit", "-qm", "team");
    put(join(f.project, "README.md"), "parent\n");
    f.git("add", "-A"); f.git("commit", "-qm", "parent");
    f.git("submodule", "add", "-q", team, ".claude/skills");
    f.git("commit", "-qm", "submodule");
    const before = repoState(f.project);
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(result.ok, false);
    assert.deepEqual(repoState(f.project), before);
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: f.project, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    assert.equal(status.status, 0, status.stderr);
  } finally { f.close(); }
});

test("F10: an entry holding its own .git is never moved", () => {
  const f = rawRepo("b3"); try {
    const foo = join(f.alias(".claude"), "foo");
    put(join(foo, "SKILL.md"), skill("foo"));
    f.gitIn(foo, "init", "-q");
    const before = repoState(f.project);
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(result.ok, false);
    assert.match(result.blocks.join("\n"), /\.claude\/skills\/foo.*\.git/);
    assert.deepEqual(repoState(f.project), before);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Medium: tracked links (review F4, F13)
// ---------------------------------------------------------------------------

test("F4/F13: tracked alias links block: nothing is untracked, moved or deleted", async () => {
  const f = await skillFixture(sources, { tag: "f4" }); try {
    put(join(f.project, "skills", "mine", "SKILL.md"), skill("mine"));
    mkdirSync(f.alias(".claude"), { recursive: true });
    symlinkSync("../../vendor/all-skills/pilot", join(f.alias(".claude"), "pilot"));
    symlinkSync("../../skills/mine", join(f.alias(".claude"), "mine"));
    put(join(f.project, ".gitignore"), "/.agents/skills\n");
    f.git("add", "-f", ".claude", "skills", ".gitignore"); f.git("commit", "-qm", "links");
    const before = repoState(f.project);
    const direct = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(direct.ok, false);
    assert.match(direct.blocks.join("\n"), /\.claude\/skills\/mine.*tracked/);
    assert.match(direct.blocks.join("\n"), /\.claude\/skills\/pilot.*tracked/);
    assert.deepEqual(repoState(f.project), before);
    const migrated = await f.migrate();
    assert.notEqual(migrated.status, "applied");
    assert.equal(f.git("ls-files", "--", ".claude/skills"), ".claude/skills/mine\n.claude/skills/pilot\n");
    assert.equal(readlinkSync(join(f.alias(".claude"), "pilot")), "../../vendor/all-skills/pilot");
    assert.equal(readlinkSync(join(f.alias(".claude"), "mine")), "../../skills/mine");
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Medium: sibling-relative links (review F5, F12)
// ---------------------------------------------------------------------------

test("F5/F12: sibling-relative links survive in one run with their relative text, and dry run matches apply", async () => {
  const f = rawRepo("f5"); try {
    const claude = f.alias(".claude");
    put(join(claude, "foo", "SKILL.md"), "foo\n");
    put(join(claude, "agent-dev", "SKILL.md"), "agent dev\n");
    symlinkSync("foo", join(claude, "zed"));
    symlinkSync("foo", join(claude, "bar"));
    symlinkSync("agent-dev", join(claude, "dev"));
    const dry = applySkillRoots(f.project, { dryRun: true, aliases: [".claude/skills"] });
    assert.equal(dry.ok, true, JSON.stringify(dry.details));
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.details, stripWould(dry.details));
    for (const [name, target, content] of [["zed", "foo", "foo\n"], ["bar", "foo", "foo\n"], ["dev", "agent-dev", "agent dev\n"]]) {
      assert.equal(readlinkSync(join(f.R, name)), target, `${name} keeps its relative text`);
      assert.equal(readSafe(join(f.R, name, "SKILL.md")), content);
      assert.equal(readSafe(join(claude, name, "SKILL.md")), content);
    }
  } finally { f.close(); }
});

test("F5 through migrate --all: bmad.cli-roots never drops a link the skills conversion left behind", async () => {
  const f = await skillFixture(sources, { tag: "f5all" }); try {
    const claude = f.alias(".claude");
    put(join(claude, "foo", "SKILL.md"), "foo\n");
    symlinkSync("foo", join(claude, "zed"));
    const report = await f.registry(f.skills, f.cliRoots).migrateAll(f.ctx);
    const lines = report.results.flatMap((item) => item.details);
    assert.ok(!lines.some((line) => /drop dangling link .*zed/.test(line)), lines.join("\n"));
    assert.equal(readlinkSync(join(f.R, "zed")), "foo");
    assert.equal(readSafe(join(claude, "zed", "SKILL.md")), "foo\n");
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Medium: nested links and modes (review F6, F7)
// ---------------------------------------------------------------------------

test("F6: a nested link that climbs out of its entry blocks the move", () => {
  const f = rawRepo("f6a"); try {
    put(join(f.project, ".claude", "commands", "deploy.md"), "cmd\n");
    put(join(f.alias(".claude"), "foo", "SKILL.md"), "s\n");
    symlinkSync("../../commands", join(f.alias(".claude"), "foo", "commands"));
    const before = repoState(f.project);
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(result.ok, false);
    assert.match(result.blocks.join("\n"), /\.claude\/skills\/foo.*commands.*(leaves|escapes|outside)/);
    assert.deepEqual(repoState(f.project), before);
    assert.equal(readSafe(join(f.alias(".claude"), "foo", "commands", "deploy.md")), "cmd\n");
  } finally { f.close(); }
});

test("F6: same-text nested links that resolve to different content are not duplicates", () => {
  const f = rawRepo("f6b"); try {
    put(join(f.project, ".claude", "commands", "deploy.md"), "real claude cmd\n");
    put(join(f.project, ".agents", "commands", "deploy.md"), "different agents cmd\n");
    for (const base of [f.alias(".claude"), f.R]) {
      put(join(base, "foo", "SKILL.md"), "same\n");
      symlinkSync("../../commands", join(base, "foo", "commands"));
    }
    const before = repoState(f.project);
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(result.ok, false);
    assert.deepEqual(repoState(f.project), before);
    assert.equal(readSafe(join(f.alias(".claude"), "foo", "commands", "deploy.md")), "real claude cmd\n");
  } finally { f.close(); }
});

test("F7: executable bits are part of identity for both the duplicate and the stub rule", () => {
  for (const [label, arrange] of [
    ["duplicate", (f) => {
      put(join(f.alias(".claude"), "foo", "scripts", "run.sh"), "#!/bin/sh\necho foo\n", 0o755);
      put(join(f.R, "foo", "scripts", "run.sh"), "#!/bin/sh\necho foo\n", 0o644);
      return [join(f.alias(".claude"), "foo", "scripts", "run.sh")];
    }],
    ["stub", (f) => {
      put(join(f.R, "bar", "scripts", "b.sh"), "#!/bin/sh\necho bar\n", 0o755);
      put(join(f.alias(".claude"), "bar", "scripts", "b.sh"), "#!/bin/sh\necho bar\n", 0o644);
      put(join(f.alias(".claude"), "bar", "SKILL.md"), skill("bar"));
      return [join(f.R, "bar", "scripts", "b.sh")];
    }],
  ]) {
    const f = rawRepo(`f7${label}`); try {
      const executables = arrange(f);
      const before = repoState(f.project);
      const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
      assert.equal(result.ok, false, `${label}: ${JSON.stringify(result.details)}`);
      assert.deepEqual(repoState(f.project), before, label);
      for (const path of executables) assert.equal(statSync(path).mode & 0o111, 0o111, `${label}: ${path} stays executable`);
    } finally { f.close(); }
  }
});

// ---------------------------------------------------------------------------
// Medium: dry run / audit / apply agreement (review F8, F11)
// ---------------------------------------------------------------------------

test("F8: the whole-root plan is exactly what apply does across aliases", async () => {
  const f = await skillFixture(sources, { tag: "f8", select: [] }); try {
    put(join(f.alias(".claude"), "foo", "A"), "A\n");
    put(join(f.alias(".codex"), "foo", "A"), "A\n");
    put(join(f.alias(".codex"), "foo", "B"), "B\n");
    const codexInode = lstatSync(join(f.alias(".codex"), "foo")).ino;
    const plan = planSkillRoots(f.project);
    const dry = applySkillRoots(f.project, { dryRun: true });
    assert.equal(dry.ok, plan.clean);
    const audit = await f.cliRoots.audit(f.ctx);
    assert.equal(audit.fixable, plan.clean, JSON.stringify(audit.details));
    const result = applySkillRoots(f.project, { dryRun: false });
    assert.equal(result.ok, dry.ok, JSON.stringify({ dry: dry.details, apply: result.details }));
    assert.deepEqual(result.details, stripWould(dry.details));
    assert.equal(result.ok, true);
    assert.deepEqual(readdirSync(join(f.R, "foo")).sort(), ["A", "B"]);
    assert.equal(lstatSync(join(f.R, "foo")).ino, codexInode, "the complete copy moved in by rename(2)");
  } finally { f.close(); }
});

test("F11/D1: dry run reports what apply achieves when a moved real directory collides with a selected catalog skill", async () => {
  for (const identical of [false, true]) {
    const f = await skillFixture(sources, { tag: `d1${identical}` }); try {
      put(join(f.alias(".claude"), "alpha", "SKILL.md"), identical ? skill("alpha") : skill("alpha", "locally tweaked copy\n"));
      const dryReport = await f.registry(f.skills).migrateAll({ ...f.ctx, dryRun: true });
      const applyReport = await f.registry(f.skills).migrateAll(f.ctx);
      assert.equal(applyReport.ok, false, JSON.stringify(applyReport.results, null, 2));
      assert.equal(dryReport.ok, applyReport.ok, JSON.stringify({ dry: dryReport.results, apply: applyReport.results }, null, 2));
      assert.equal(dryReport.results[0].status, applyReport.results[0].status);
      assert.match(dryReport.results[0].details.join("\n"), /alpha.*real directory/);
      assert.equal(readSafe(join(f.R, "alpha", "SKILL.md")).includes("alpha"), true, "moved losslessly");
    } finally { f.close(); }
  }
});

test("F11/D2: dry run sees every root collision, not only the first", async () => {
  const f = await skillFixture(sources, { tag: "d2" }); try {
    mkdirSync(f.R, { recursive: true });
    symlinkSync("/nonexistent/alpha", join(f.R, "alpha"));
    put(join(f.R, "beta", "SKILL.md"), skill("beta", "local fork\n"));
    for (const alias of SUPPORTED_SKILLS_ALIASES) { mkdirSync(join(f.project, alias.split("/")[0]), { recursive: true }); symlinkSync("../.agents/skills", join(f.project, alias)); }
    const dryReport = await f.registry(f.skills).migrateAll({ ...f.ctx, dryRun: true });
    const applyReport = await f.registry(f.skills).migrateAll(f.ctx);
    assert.equal(applyReport.ok, false);
    assert.equal(dryReport.ok, false, JSON.stringify(dryReport.results, null, 2));
    assert.equal(dryReport.results[0].status, applyReport.results[0].status);
    assert.match(dryReport.results[0].details.join("\n"), /blocked: .*beta is a real directory/);
    assert.equal(readSafe(join(f.R, "beta", "SKILL.md")), skill("beta", "local fork\n"));
  } finally { f.close(); }
});

test("a blocked root collision leaves every other legacy link in place: no name loses its link while the sync is refused", async () => {
  // Found by the real-data e2e (pjangler, 33GOD): the collision loop replaced
  // resolvable legacy links one refusal at a time, then stopped at a blocking
  // one, so those names had neither their old link nor the catalog link.
  const f = await skillFixture(sources, { tag: "atomic", select: ["alpha", "beta", "gamma"] }); try {
    mkdirSync(f.R, { recursive: true });
    const legacy = join(f.base, "other-repo", "skills", "alpha");
    put(join(legacy, "SKILL.md"), skill("alpha", "older copy in another repository\n"));
    symlinkSync(legacy, join(f.R, "alpha"));
    put(join(f.R, "beta", "SKILL.md"), skill("beta", "local fork\n"));
    for (const alias of SUPPORTED_SKILLS_ALIASES) { mkdirSync(join(f.project, alias.split("/")[0]), { recursive: true }); symlinkSync("../.agents/skills", join(f.project, alias)); }
    const before = repoState(f.project);
    const audit = await f.audit();
    assert.equal(audit.fixable, false, JSON.stringify(audit.details));
    assert.match(audit.details.join("\n"), /blocked: .*beta is a real directory/);
    const dry = await f.migrate({ dryRun: true });
    const applied = await f.migrate();
    assert.equal(dry.status, applied.status);
    assert.equal(applied.status, "blocked", JSON.stringify(applied, null, 2));
    assert.equal(readlinkSync(join(f.R, "alpha")), legacy, "the resolvable legacy link is not replaced while beta blocks");
    assert.equal(readSafe(join(f.R, "alpha", "SKILL.md")), skill("alpha", "older copy in another repository\n"));
    assert.deepEqual(repoState(f.project), before);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// High: skillex's absolute aliases (review F15), with the real skillex CLI
// ---------------------------------------------------------------------------

test("F15: aliases skillex migrate --apply wrote are left alone and the repo converges (real skillex CLI)", async () => {
  const f = await skillFixture(sources, { tag: "f15", select: ["alpha"] }); try {
    mkdirSync(f.R, { recursive: true });
    const migrated = f.skillex("migrate", "--project", f.project, "--apply", "--json");
    assert.equal(migrated.exit, 0, migrated.stdout + migrated.stderr);
    const written = readlinkSync(f.alias(".claude"));
    assert.equal(written, f.R, "skillex migrate writes the absolute alias");
    const inode = lstatSync(f.alias(".claude")).ino;
    const result = await f.migrate();
    assert.equal(result.status, "applied", JSON.stringify(result, null, 2));
    assert.ok(!result.details.some((line) => /relink/.test(line)), result.details.join("\n"));
    assert.equal(lstatSync(f.alias(".claude")).ino, inode, "an alias skillex owns is never rewritten");
    assert.equal(f.skillex("sync", "--scope", "project", "--project", f.project).exit, 0);
    assert.equal(f.skillex("status", "--scope", "project", "--project", f.project).exit, 0);
    assert.equal((await f.audit()).status, "pass");
    const cli = await f.cliRoots.audit(f.ctx);
    assert.ok(!cli.details.some((line) => /must target/.test(line)), cli.details.join("\n"));
    assert.equal((await f.migrate()).status, "noop");
  } finally { f.close(); }
});

test("F15/s5: following pj's own guidance (skillex migrate --apply) and then pj migrate --all converges (real skillex CLI)", async () => {
  const f = await skillFixture(sources, { tag: "f15s5", select: ["alpha"] }); try {
    mkdirSync(f.R, { recursive: true });
    put(join(f.alias(".claude"), "localthing", "SKILL.md"), skill("localthing"));
    const migrated = f.skillex("migrate", "--project", f.project, "--apply", "--json");
    assert.notEqual(migrated.exit, 0, "skillex blocks the real .claude/skills");
    const report = await f.registry(f.skills, f.cliRoots).migrateAll(f.ctx);
    const skillsResult = report.results.find((item) => item.id === "skills.project-manifest");
    assert.equal(skillsResult.status, "applied", JSON.stringify(report, null, 2));
    assert.equal(readSafe(join(f.alias(".claude"), "localthing", "SKILL.md")), skill("localthing"));
    assert.equal(f.skillex("sync", "--scope", "project", "--project", f.project).exit, 0);
    const again = await f.registry(f.skills).migrateAll(f.ctx);
    assert.equal(again.ok, true, JSON.stringify(again, null, 2));
    assert.ok(again.results.every((item) => item.status === "noop"), JSON.stringify(again, null, 2));
    assert.equal((await f.audit()).status, "pass");
  } finally { f.close(); }
});

test("F15 end to end through the real pj CLI: skillex migrate --apply, then pj migrate, never breaks skillex ownership", async () => {
  // The pj CLI built from these sources into /tmp (never the repo's dist/).
  const work = mkdtempSync("/tmp/pjan-135-cli-");
  try {
    for (const name of ["node_modules", "package.json", "templates"]) symlinkSync(join(repoRoot, name), join(work, name));
    buildSync({ entryPoints: [join(repoRoot, "src", "index.ts")], outfile: join(work, "dist", "index.js"),
      bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning" });
    const f = await skillFixture(sources, { tag: "f15cli", select: ["alpha"] }); try {
      mkdirSync(f.R, { recursive: true });
      put(join(f.alias(".claude"), "localthing", "SKILL.md"), skill("localthing"));
      const env = { ...process.env, HOME: f.home, XDG_STATE_HOME: join(f.base, "state"), PJ_SKILLS_REGISTRY_ROOT: f.catalog,
        PJ_AGENT_HOOKS_LAYER: "0", PLANE_API_KEY: "", PLANE_33GOD_API_KEY: "", TRELLO_TOKEN: "" };
      const pj = (...args) => {
        const result = spawnSync(process.execPath, [join(work, "dist", "index.js"), ...args, "--json"], { cwd: f.base, env, encoding: "utf8", timeout: 120000 });
        assert.ok(result.stdout.trim().startsWith("{"), result.stderr + result.stdout);
        return { exit: result.status, report: JSON.parse(result.stdout) };
      };
      // The guidance pj audit prints for this repo, followed literally.
      const guidance = pj("audit", f.project).report.rules.find((rule) => rule.id === "skills.project-manifest").details.join("\n");
      assert.match(guidance, /pj skills migrate --project "[^"]+" --apply/);
      const skillexMigrate = f.skillex("migrate", "--project", f.project, "--apply");
      assert.notEqual(skillexMigrate.exit, 3, skillexMigrate.stdout + skillexMigrate.stderr);
      const absolute = readlinkSync(f.alias(".codex"));
      assert.equal(absolute, f.R, "skillex migrate writes absolute aliases");
      const inode = lstatSync(f.alias(".codex")).ino;
      const migrated = pj("migrate", "skills.project-manifest", f.project);
      assert.equal(migrated.exit, 0, JSON.stringify(migrated.report, null, 2));
      assert.equal(migrated.report.results[0].status, "applied");
      assert.equal(lstatSync(f.alias(".codex")).ino, inode, "the receipt-owned alias is untouched");
      assert.equal(pj("migrate", "bmad.cli-roots", f.project).report.results.every((item) => !item.details.some((line) => /relink|must target/.test(line))), true);
      assert.equal(lstatSync(f.alias(".codex")).ino, inode);
      assert.equal(f.skillex("sync", "--scope", "project", "--project", f.project).exit, 0);
      const again = f.skillex("migrate", "--project", f.project, "--apply");
      assert.doesNotMatch(again.stdout + again.stderr, /E_OWNERSHIP_CHANGED/);
      assert.equal(pj("audit", f.project).report.rules.find((rule) => rule.id === "skills.project-manifest").status, "pass");
      assert.equal(readSafe(join(f.R, "localthing", "SKILL.md")), skill("localthing"));
    } finally { f.close(); }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Two-phase apply: quarantine, journal, verification, rollback
// ---------------------------------------------------------------------------

test("a step that fails mid-apply rolls every earlier step back and leaves the repo exactly as it was", () => {
  const f = rawRepo("rb"); try {
    put(join(f.alias(".claude"), "a", "SKILL.md"), "a\n");
    put(join(f.alias(".claude"), "b", "SKILL.md"), "b\n");
    // rename(2) of a directory to a new parent needs write permission on it (to update ..).
    chmodSync(join(f.alias(".claude"), "b"), 0o555);
    const before = repoState(f.project);
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"] });
    assert.equal(result.ok, false);
    assert.match(result.blocks.join("\n"), /rolled back/);
    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(repoState(f.project), before);
    assert.equal(existsSync(join(f.project, ".agents", ".pjangler-quarantine")), false);
  } finally { f.close(); }
});

test("a post-apply mismatch found on disk is reversed from the journal and reported blocked", () => {
  const f = rawRepo("mm"); try {
    put(join(f.alias(".claude"), "a", "run.sh"), "#!/bin/sh\n", 0o644);
    const before = repoState(f.project);
    const result = applySkillRoots(f.project, { dryRun: false, aliases: [".claude/skills"],
      // A concurrent writer between the last step and verification.
      hooks: { beforeVerify: () => chmodSync(join(f.R, "a", "run.sh"), 0o755) } });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.blocks.join("\n"), /\.claude\/skills\/a.*run\.sh.*mode/);
    chmodSync(join(f.alias(".claude"), "a", "run.sh"), 0o644);
    assert.deepEqual(repoState(f.project), before);
  } finally { f.close(); }
});

test("an interrupted run blocks the next plan with its restore instructions, and following them restores the repo byte for byte", () => {
  const f = rawRepo("crash"); try {
    put(join(f.alias(".claude"), "a", "SKILL.md"), "a\n");
    put(join(f.alias(".claude"), "b", "SKILL.md"), "b\n");
    put(join(f.R, "c", "SKILL.md"), "c\n");
    put(join(f.alias(".claude"), "c", "SKILL.md"), "c\n");
    const before = repoState(f.project);
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(`file://${sources.bundle}`)}); m.applySkillRoots(${JSON.stringify(f.project)}, { dryRun: false });`],
    { env: { ...process.env, PJ_SKILL_ROOTS_CRASH_AFTER: "2" }, encoding: "utf8" });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    const plan = planSkillRoots(f.project);
    assert.equal(plan.clean, false);
    assert.equal(plan.operations.length, 0);
    const reason = plan.blocks.join("\n");
    const quarantine = join(f.project, ".agents", ".pjangler-quarantine");
    const [run] = readdirSync(quarantine);
    const restore = reason.match(/sh '([^']+restore\.sh)'/)?.[1];
    assert.equal(restore, join(quarantine, run, "restore.sh"), reason);
    const restored = spawnSync("sh", [restore], { encoding: "utf8" });
    assert.equal(restored.status, 0, restored.stderr);
    spawnSync("rm", ["-rf", join(quarantine, run)]);
    spawnSync("rmdir", [quarantine]);
    assert.deepEqual(repoState(f.project), before);
    const converged = applySkillRoots(f.project, { dryRun: false });
    assert.equal(converged.ok, true, JSON.stringify(converged));
    for (const name of ["a", "b", "c"]) assert.equal(readSafe(join(f.alias(".claude"), name, "SKILL.md")), `${name}\n`);
  } finally { f.close(); }
});

test("a crash after ANY step is reversed byte for byte by the restore command the next plan names", () => {
  const layouts = {
    // Every step kind: stub replacement, moves, duplicate drops, a sibling link,
    // a dangling link, a dangling alias, and absent aliases to create.
    everyKind: (f) => {
      put(join(f.R, "stub", "scripts", "t.py"), "t\n");
      put(join(f.alias(".claude"), "stub", "scripts", "t.py"), "t\n");
      put(join(f.alias(".claude"), "stub", "SKILL.md"), "stub\n");
      put(join(f.alias(".claude"), "moved", "SKILL.md"), "moved\n");
      put(join(f.R, "dup", "SKILL.md"), "dup\n");
      put(join(f.alias(".claude"), "dup", "SKILL.md"), "dup\n");
      symlinkSync("moved", join(f.alias(".claude"), "sibling"));
      symlinkSync("../../gone", join(f.alias(".claude"), "dangling"));
      put(join(f.alias(".codex"), "codex-only", "SKILL.md"), "codex\n");
      mkdirSync(join(f.project, ".gemini"), { recursive: true });
      symlinkSync("../.agents/nowhere", f.alias(".gemini"));
    },
    // No .agents at all: the run creates .agents and .agents/skills.
    noAgents: (f) => {
      put(join(f.alias(".claude"), "a", "SKILL.md"), "a\n");
      put(join(f.alias(".claude"), "b", "SKILL.md"), "b\n");
    },
  };
  for (const [name, arrange] of Object.entries(layouts)) {
    let crashed = 0;
    for (let after = 1; after < 60; after++) {
      const f = rawRepo(`crash-${name}`); try {
        arrange(f);
        const before = repoState(f.project);
        const child = spawnSync(process.execPath, ["--input-type=module", "-e",
          `const m = await import(${JSON.stringify(`file://${sources.bundle}`)}); m.applySkillRoots(${JSON.stringify(f.project)}, { dryRun: false });`],
        { env: { ...process.env, PJ_SKILL_ROOTS_CRASH_AFTER: String(after) }, encoding: "utf8" });
        if (child.signal !== "SIGKILL") {
          assert.equal(child.status, 0, child.stderr);
          break;
        }
        crashed++;
        const plan = planSkillRoots(f.project);
        assert.equal(plan.operations.length, 0, `${name}@${after}: a leftover quarantine blocks every operation`);
        const restore = plan.blocks.join("\n").match(/sh '([^']+restore\.sh)'/)?.[1];
        assert.ok(restore, `${name}@${after}: ${plan.blocks.join("\n")}`);
        const restored = spawnSync("sh", [restore], { encoding: "utf8" });
        assert.equal(restored.status, 0, `${name}@${after}: ${restored.stderr}`);
        assert.deepEqual(repoState(f.project), before, `${name}@${after}: the restore is exact`);
        assert.equal(applySkillRoots(f.project, { dryRun: false }).ok, true, `${name}@${after}: converges after the restore`);
      } finally { f.close(); }
    }
    assert.ok(crashed >= (name === "everyKind" ? 12 : 4), `${name}: only ${crashed} crash points exercised`);
  }
});

// ---------------------------------------------------------------------------
// Low, pre-existing: BMAD pack eviction (review F14)
// ---------------------------------------------------------------------------

test("F14: BMAD pack eviction leaves a skillex-owned bmad-* activation alone and reports what it removed", async () => {
  const f = await skillFixture(sources, { tag: "f14", select: ["bmad-html-workspace"], catalogSkills: ["alpha", "bmad-html-workspace"] }); try {
    const scaffold = sources.createBmadChecks().find((check) => check.id === "bmad.scaffold");
    const synced = await f.migrate();
    assert.equal(synced.status, "applied", JSON.stringify(synced, null, 2));
    const owned = join(f.R, "bmad-html-workspace");
    assert.ok(lstatSync(owned).isSymbolicLink());
    const retired = join(f.R, "bmad-retired-pack");
    symlinkSync(join(f.base, "registry-cache", "packs", "bmad", "bmad-retired-pack"), retired);
    const saved = process.env.PJ_BMAD_INSTALLER;
    process.env.PJ_BMAD_INSTALLER = "/bin/false";
    let result;
    try { result = await scaffold.migrate(f.ctx, await scaffold.audit(f.ctx)); }
    finally { if (saved === undefined) delete process.env.PJ_BMAD_INSTALLER; else process.env.PJ_BMAD_INSTALLER = saved; }
    assert.equal(result.status, "partial", "the installer failed after something was already evicted");
    assert.ok(lstatSafe(owned)?.isSymbolicLink(), "a receipt-owned selected activation is not retired pack state");
    assert.equal(lstatSafe(retired), undefined, "the retired pack link is evicted");
    assert.ok(result.changedFiles.includes(retired), `a blocked result still reports what it removed: ${JSON.stringify(result)}`);
    assert.equal((await f.audit()).status, "pass");
  } finally { f.close(); }
});
