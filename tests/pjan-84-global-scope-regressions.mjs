// PJAN-84: `sync-skills.py --scope global` and the ONE symlink relaxation it needed.
//
// The global sync could not run at all:
//   ValueError: Refusing symlinked destination directory: ~/.agents/skills
// `assert_real_directory_chain` demanded that the whole destination path be real
// directories, and the canonical topology IS a symlink
// (`~/.agents/skills -> <skillex>/skill-sets/global`). So nothing maintained the
// global farm; it was correct only because it had been reconciled by hand.
//
// That refusal was not arbitrary. Every containment assertion in the engine is
// LEXICAL, and a lexical guard is sound only over a symlink-free path: if the
// alias may be a symlink, anyone who can write `~/.agents` repoints it at
// `~/.ssh` or a repo, and the engine then runs `os.symlink()` and `shutil.rmtree()`
// inside the attacker's chosen directory while every containment check still
// passes, because they compare strings under `$HOME`.
//
// So the relaxation has to be exact, and this suite is what pins it: the
// canonical shape is admitted, and each way of bending it is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE_SOURCE = join(ROOT, "templates", "commonproject", "template", ".mise", "scripts", "sync-skills.py");
const temporary = [];
let failures = 0;

function check(label, body) {
  try {
    body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message.split("\n")[0]}`);
  }
}

function skill(directory, name) {
  const path = join(directory, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return path;
}

/**
 * A hermetic HOME mirroring the real canonical topology:
 *   <home>/.agents/skills -> <home>/code/skillex/skill-sets/global
 *   <home>/.claude/skills -> ../.agents/skills          (relative form)
 *   <home>/.codex/skills  -> <home>/.agents/skills      (absolute form)
 * The engine must live at <root>/.mise/scripts/, because it refuses to act on a
 * root it does not belong to.
 */
function lab({ declared = ["alpha", "beta"] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pjan-84-global-"));
  temporary.push(home);
  const registry = join(home, "code", "skillex");
  const farm = join(registry, "skill-sets", "global");
  mkdirSync(farm, { recursive: true });
  mkdirSync(join(registry, "all-skills"), { recursive: true });
  mkdirSync(join(home, ".agents", ".cache"), { recursive: true });
  const sources = {};
  for (const name of declared) sources[name] = skill(join(registry, "all-skills"), name);

  symlinkSync(farm, join(home, ".agents", "skills"), "dir");
  writeFileSync(
    join(home, ".agents", "skills.json"),
    `${JSON.stringify({ scope: "global", skills: declared.map((name) => ({ name, source: `file://${sources[name]}` })) }, null, 2)}\n`,
  );
  for (const [cli, target] of [[".claude", "../.agents/skills"], [".codex", join(home, ".agents", "skills")]]) {
    mkdirSync(join(home, cli), { recursive: true });
    symlinkSync(target, join(home, cli, "skills"), "dir");
  }
  // The engine belongs to $HOME at global scope.
  const engine = join(home, ".mise", "scripts", "sync-skills.py");
  mkdirSync(dirname(engine), { recursive: true });
  cpSync(ENGINE_SOURCE, engine);
  return { home, registry, farm, engine, sources };
}

function sync(lab, extra = []) {
  return spawnSync("python3", [lab.engine, "--scope", "global", ...extra], {
    cwd: lab.home,
    encoding: "utf8",
    env: { ...process.env, HOME: lab.home, PJ_SKILLS_REGISTRY_ROOT: lab.registry },
  });
}

console.log("pjan-84 global scope + alias relaxation");
try {
  check("the canonical topology runs, and projects into the farm", () => {
    const it = lab();
    rmSync(join(it.farm, "alpha"), { force: true });
    const result = sync(it);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const projected = readdirSync(it.farm).sort();
    assert.deepEqual(projected, ["alpha", "beta"], `farm holds exactly the declared skills: ${projected.join(", ")}`);
  });

  check("a second run is a no-op", () => {
    const it = lab();
    assert.equal(sync(it).status, 0);
    const second = sync(it);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /0 new\/updated symlink\(s\), 0 stale link\(s\) removed/);
  });

  check("an alias resolving OUTSIDE every managed root is refused", () => {
    const it = lab();
    const elsewhere = join(it.home, "not-a-registry");
    mkdirSync(elsewhere, { recursive: true });
    unlinkSync(join(it.home, ".agents", "skills"));
    symlinkSync(elsewhere, join(it.home, ".agents", "skills"), "dir");
    const result = sync(it);
    assert.notEqual(result.status, 0, "an arbitrary alias target must be refused");
    assert.match(result.stderr, /does not resolve into a managed registry root/);
  });

  check("an alias resolving into the FETCHED-INTO cache root is refused", () => {
    // ~/.agents/.cache is a managed root for reconcile, but sync_registry()
    // clones and pulls arbitrary remote repositories into it. A projection there
    // would be rewritten by whoever controls the registry.
    const it = lab();
    const inCache = join(it.home, ".agents", ".cache", "planted");
    mkdirSync(inCache, { recursive: true });
    unlinkSync(join(it.home, ".agents", "skills"));
    symlinkSync(inCache, join(it.home, ".agents", "skills"), "dir");
    const result = sync(it);
    assert.notEqual(result.status, 0, "the cache root must never host the projection");
    assert.match(result.stderr, /does not resolve into a managed registry root/);
  });

  check("an intermediate symlink is judged by where it RESOLVES, not by its shape", () => {
    // <registry>/skill-sets becomes a symlink, so the alias reaches the farm
    // through two hops. That is admissible: `resolve()` collapses them once, the
    // resolved path is real and inside the managed root, and every mutation
    // addresses THAT path — `revalidate_cli_dir` re-resolves and re-compares
    // before each one, so re-pointing a hop mid-run cannot redirect a write.
    const inside = lab();
    const real = join(inside.registry, "real-sets");
    mkdirSync(join(real, "global"), { recursive: true });
    rmSync(join(inside.registry, "skill-sets"), { recursive: true, force: true });
    symlinkSync(real, join(inside.registry, "skill-sets"), "dir");
    const admitted = sync(inside);
    assert.equal(admitted.status, 0, `resolving inside a managed root is admitted: ${admitted.stderr}`);

    // The same shape pointing OUT of every managed root is refused — which is
    // the case that matters, because that is how a planted alias would turn the
    // engine's lexical containment checks into arbitrary directory destruction.
    const outside = lab();
    const escape = join(outside.home, "escape-hatch");
    mkdirSync(join(escape, "global"), { recursive: true });
    rmSync(join(outside.registry, "skill-sets"), { recursive: true, force: true });
    symlinkSync(escape, join(outside.registry, "skill-sets"), "dir");
    const refused = sync(outside);
    assert.notEqual(refused.status, 0, "a hop that escapes the managed roots must be refused");
    assert.match(refused.stderr, /does not resolve into a managed registry root/);
  });

  check("a world-writable component in the resolved chain is refused", () => {
    const it = lab();
    chmodSync(join(it.registry, "skill-sets"), 0o777);
    const result = sync(it);
    chmodSync(join(it.registry, "skill-sets"), 0o755);
    assert.notEqual(result.status, 0, "a world-writable chain component must be refused");
    assert.match(result.stderr, /world-writable/);
  });

  check("group-write is ALLOWED: the real checkout is 0775", () => {
    // Load-bearing. A "no group-write" rule would refuse the very topology this
    // relaxation exists to admit.
    const it = lab();
    chmodSync(join(it.registry, "skill-sets"), 0o775);
    chmodSync(it.farm, 0o775);
    const result = sync(it);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  check("PROJECT scope still refuses a symlinked .agents/skills", () => {
    // The relaxation is global-only. A generated project always owns a real
    // .agents/skills, and pjangler's TypeScript mirror asserts the same.
    const it = lab();
    const repo = join(it.home, "repo");
    mkdirSync(join(repo, ".mise", "scripts"), { recursive: true });
    mkdirSync(join(repo, ".agents"), { recursive: true });
    mkdirSync(join(repo, ".claude"), { recursive: true });
    cpSync(ENGINE_SOURCE, join(repo, ".mise", "scripts", "sync-skills.py"));
    writeFileSync(join(repo, ".agents", "skills.json"), `${JSON.stringify({ inherit_global: false, skills: [] })}\n`);
    symlinkSync(it.farm, join(repo, ".agents", "skills"), "dir");
    symlinkSync("../.agents/skills", join(repo, ".claude", "skills"), "dir");
    const result = spawnSync("python3", [join(repo, ".mise", "scripts", "sync-skills.py"), "--scope", "project", "--root", repo], {
      cwd: repo, encoding: "utf8", env: { ...process.env, HOME: it.home, PJ_SKILLS_REGISTRY_ROOT: it.registry },
    });
    assert.notEqual(result.status, 0, "a project may not reach its projection through a symlink");
    assert.match(result.stderr, /alias target is not a real directory/);
  });

  check("global reconcile does not treat all of $HOME as its territory", () => {
    // At global scope `cli_dirs_base` is $HOME. Passing it as the project root
    // would make "inside the project root" mean "anywhere under $HOME" — every
    // skill source on the machine — and the farm would reclaim every undeclared
    // link it holds. Global scope keeps the managed-root test only.
    const it = lab();
    const outside = skill(join(it.home, "other"), "outside-skill");
    symlinkSync(outside, join(it.farm, "outside-undeclared"), "dir");
    const result = sync(it);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(
      readdirSync(it.farm).includes("outside-undeclared"),
      "an undeclared link pointing outside the managed roots survives a global sync",
    );
  });

  check("a dangling link is still reclaimed at global scope", () => {
    const it = lab();
    symlinkSync(join(it.registry, "all-skills", "vanished"), join(it.farm, "dangling"), "dir");
    const result = sync(it);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!readdirSync(it.farm).includes("dangling"), "a link that resolves to nothing is reclaimed wherever it points");
  });

  check("--reconcile-dry-run removes nothing", () => {
    const it = lab();
    symlinkSync(join(it.registry, "all-skills", "vanished"), join(it.farm, "dangling"), "dir");
    const result = sync(it, ["--reconcile-dry-run"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /would remove .*dangling/);
    assert.ok(readdirSync(it.farm).includes("dangling"), "a dry run reports and removes nothing");
  });
} finally {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}

if (failures) {
  console.error(`pjan-84 global scope: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pjan-84 global scope regressions passed");
