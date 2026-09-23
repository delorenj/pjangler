import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function fixture() {
  const base = realpathSync(mkdtempSync("/tmp/pjan-127-"));
  const home = join(base, "home"), project = join(base, "project"), registry = join(base, "registry");
  for (const dir of [home, project, join(registry, "all-skills"), join(registry, "sets"), join(registry, "packs")]) mkdirSync(dir, { recursive: true });
  for (const name of ["alpha", "beta", "gamma"]) put(join(registry, "all-skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# ${name}\n`);
  put(join(home, ".agents", "skills.json"), JSON.stringify({ inherit_global: false, skills: ["alpha"] }) + "\n");
  put(join(project, "mise.toml"), '[env]\n_.path = [".mise/scripts"]\n');
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(base, "state"), PJ_SKILLS_REGISTRY_ROOT: registry,
    PJ_AGENT_HOOKS_LAYER: "0", PLANE_API_KEY: "", PLANE_33GOD_API_KEY: "", TRELLO_TOKEN: "", PYTHONDONTWRITEBYTECODE: "1" };
  const run = (args, cwd = root) => {
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.ok(result.stdout.trim().startsWith("{"), result.stderr + result.stdout);
    return { exit: result.status, report: JSON.parse(result.stdout) };
  };
  const migrate = (extra = []) => run(["migrate", "skills.project-manifest", project, ...extra]);
  const audit = () => run(["audit", project]).report.rules.find((item) => item.id === "skills.project-manifest");
  return { base, home, project, registry, env, run, migrate, audit, close: () => rmSync(base, { recursive: true, force: true }) };
}
function snapshot(path) {
  if (!existsSync(path)) return null;
  const walk = (dir) => readdirSync(dir).sort().map((name) => {
    const file = join(dir, name), stat = lstatSync(file, { bigint: true });
    return [name, String(stat.ino), String(stat.mode), stat.isSymbolicLink() ? readlinkSync(file) : stat.isDirectory() ? walk(file) : readFileSync(file).toString("base64")];
  });
  return walk(path);
}

test("fresh project uses public init and sync; audit and repeated migration converge", () => {
  const f = fixture(); try {
    const first = f.migrate(); assert.equal(first.exit, 0, JSON.stringify(first.report));
    const manifest = JSON.parse(readFileSync(join(f.project, ".agents", "skills.json"), "utf8"));
    assert.equal(manifest.inherit_global, true);
    assert.equal(realpathSync(join(f.project, ".agents", "skills", "alpha")), join(f.registry, "all-skills", "alpha"));
    assert.equal(f.audit().status, "pass");
    const before = snapshot(f.base);
    assert.equal(f.migrate().report.results[0].status, "noop");
    assert.deepEqual(snapshot(f.base), before);
  } finally { f.close(); }
});

test("existing inherit_global false and manifest bytes survive project migration", () => {
  const f = fixture(); try {
    const content = '{ "inherit_global": false, "skills": ["beta"], "exclude": ["alpha"] }\n';
    put(join(f.project, ".agents", "skills.json"), content);
    assert.equal(f.migrate().exit, 0);
    assert.equal(readFileSync(join(f.project, ".agents", "skills.json"), "utf8"), content);
    assert.deepEqual(readdirSync(join(f.project, ".agents", "skills")), ["beta"]);
    assert.equal(f.audit().status, "pass");
  } finally { f.close(); }
});

test("explicit project never mutates the nested invocation or global activation", () => {
  const f = fixture(); try {
    const nested = join(f.project, "packages", "nested"); mkdirSync(nested, { recursive: true });
    put(join(nested, ".agents", "skills.json"), '{"inherit_global":false,"skills":["gamma"]}\n');
    put(join(f.project, ".agents", "skills.json"), '{"inherit_global":false,"skills":["beta"]}\n');
    const before = snapshot(nested), global = snapshot(f.home);
    const result = f.run(["migrate", "skills.project-manifest", f.project], nested);
    assert.equal(result.exit, 0, JSON.stringify(result.report));
    assert.deepEqual(snapshot(nested), before); assert.deepEqual(snapshot(f.home), global);
    assert.equal(realpathSync(join(f.project, ".agents", "skills", "beta")), join(f.registry, "all-skills", "beta"));
  } finally { f.close(); }
});

test("declared set filters and exclusive packs use canonical catalog links", () => {
  const f = fixture(); try {
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(f.registry, "sets", "coding"), { recursive: true });
      symlinkSync(join(f.registry, "all-skills", name), join(f.registry, "sets", "coding", name));
    }
    put(join(f.project, ".agents", "skills.json"), '{"inherit_global":false,"sets":[{"name":"coding","exclude":["alpha"]}]}\n');
    assert.equal(f.migrate().exit, 0);
    assert.deepEqual(readdirSync(join(f.project, ".agents", "skills")), ["beta"]);
    const pack = join(f.registry, "packs", "coding", "1.0.0");
    put(join(pack, "pack.toml"), '[pack]\nname = "coding"\nversion = "1.0.0"\n[freeform]\nskills = ["gamma"]\n');
    mkdirSync(join(pack, "skills")); symlinkSync(join(f.registry, "all-skills", "gamma"), join(pack, "skills", "gamma"));
    const manifest = '{"inherit_global":false,"skills":["alpha"],"packs":["coding@1.0.0"]}\n';
    put(join(f.project, ".agents", "skills.json"), manifest);
    const result = f.migrate(); assert.equal(result.exit, 0, JSON.stringify(result.report));
    assert.equal(realpathSync(join(f.project, ".agents", "skills")), join(pack, "skills"));
    assert.equal(readFileSync(join(f.project, ".agents", "skills.json"), "utf8"), manifest);
  } finally { f.close(); }
});

test("core sync preserves installer real entries and correct foreign links without adoption", () => {
  const f = fixture(); try {
    put(join(f.project, ".agents", "skills.json"), '{"inherit_global":false,"skills":["beta"]}\n');
    const bmad = join(f.project, ".agents", "skills", "bmad-local"); put(join(bmad, "SKILL.md"), "Installer owned\n");
    symlinkSync(join(f.registry, "all-skills", "beta"), join(f.project, ".agents", "skills", "beta"));
    const before = snapshot(bmad), inode = lstatSync(bmad).ino;
    assert.equal(f.migrate().exit, 0);
    assert.equal(lstatSync(bmad).ino, inode); assert.deepEqual(snapshot(bmad), before);
    put(join(f.project, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
    assert.equal(f.migrate().exit, 0);
    assert.ok(lstatSync(join(f.project, ".agents", "skills", "beta")).isSymbolicLink());
  } finally { f.close(); }
});

// PJAN-135: the explicit skills:sync task and the canonical CLI aliases are
// written before the sync and independently of its outcome (retiring dead
// wiring no longer waits on skillex agreeing). A refused selection still writes
// no manifest, no activation root and no core state.
const SIX_ALIASES = [".claude", ".codex", ".gemini", ".copilot", ".opencode", ".kimi-code"];
function refusedWithoutActivation(f, result, manifest) {
  assert.notEqual(result.exit, 0);
  assert.equal(result.report.results[0].status, "partial", JSON.stringify(result.report));
  assert.equal(readFileSync(join(f.project, ".agents", "skills.json"), "utf8"), manifest, "the selection is never rewritten");
  assert.equal(existsSync(join(f.project, ".agents", "skills")), false, "no activation root");
  assert.deepEqual(readdirSync(join(f.project, ".agents")), ["skills.json"]);
  assert.equal(existsSync(join(f.base, "state")), false, "no core receipt or lock state");
  assert.deepEqual([...result.report.changedFiles].sort(), [join(f.project, "mise.toml"),
    ...SIX_ALIASES.flatMap((cli) => [join(f.project, cli), join(f.project, cli, "skills")])].sort());
}

test("malformed and legacy selections refuse without activation writes, with migration guidance", () => {
  for (const raw of ['{"skills":', '{"inherit_global":false,"skills":[{"name":"beta","source":"file:///legacy"}]}']) {
    const f = fixture(); try {
      put(join(f.project, ".agents", "skills.json"), raw);
      const home = snapshot(f.home); const result = f.migrate();
      refusedWithoutActivation(f, result, raw);
      assert.match(result.report.results[0].details.join("\n"), /skillex migrate --project/);
      assert.deepEqual(snapshot(f.home), home);
    } finally { f.close(); }
  }
});

test("unknown canonical selection and a differing CLI-root collision refuse without activation writes", () => {
  const f = fixture(); try {
    const missing = '{"inherit_global":false,"skills":["missing"]}\n';
    put(join(f.project, ".agents", "skills.json"), missing);
    refusedWithoutActivation(f, f.migrate(), missing);
  } finally { f.close(); }
  const g = fixture(); try {
    // Lossless real-directory aliases are converted now (tests/pjan-135-*); one
    // whose entry DIFFERS from its .agents/skills counterpart is still refused
    // and left exactly as it was.
    put(join(g.project, ".agents", "skills.json"), '{"inherit_global":false,"skills":["beta"]}\n');
    put(join(g.project, ".agents", "skills", "installer", "SKILL.md"), "Installer copy\n");
    put(join(g.project, ".claude", "skills", "installer", "SKILL.md"), "Foreign CLI data\n");
    const claude = snapshot(join(g.project, ".claude")), root = snapshot(join(g.project, ".agents", "skills"));
    const result = g.migrate();
    assert.notEqual(result.exit, 0);
    assert.match(result.report.results[0].details.join("\n"), /\.claude\/skills\/installer differs from \.agents\/skills\/installer/);
    assert.deepEqual(snapshot(join(g.project, ".claude")), claude);
    assert.deepEqual(snapshot(join(g.project, ".agents", "skills")), root);
  } finally { g.close(); }
});

test("dry-run of a valid selection plans complete activation without writing state", () => {
  const f = fixture(); try {
    put(join(f.project, ".agents", "skills.json"), '{"inherit_global":false,"skills":["beta"]}\n');
    const before = snapshot(f.base); const result = f.migrate(["--dry-run"]);
    assert.equal(result.exit, 0, JSON.stringify(result.report));
    assert.ok(result.report.changedFiles.includes(join(f.project, ".agents", "skills", "beta")));
    assert.deepEqual(snapshot(f.base), before);
  } finally { f.close(); }
});

test("migration retires enter/watch/provision scripts and preserves unrelated hooks", () => {
  const f = fixture(); try {
    put(join(f.project, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
    put(join(f.project, "mise.toml"), `[hooks]\nenter = ["python3 .mise/scripts/provision-packs.py", "sync-skills.py --scope project", "echo custom"]\nleave = ["echo bye"]\n[[watch_files]]\npatterns = [".agents/skills.json"]\ntask = "skills-sync"\n[tasks.skills-sync]\ndepends = ["skills-provision-packs"]\nrun = "sync-skills.py --scope project"\n[tasks.skills-provision-packs]\nrun = "python3 .mise/scripts/provision-packs.py"\n`);
    for (const file of ["sync-skills.py", "provision-packs.py"]) put(join(f.project, ".mise", "scripts", file), "legacy\n");
    const result = f.migrate(); assert.equal(result.exit, 0, JSON.stringify(result.report));
    const mise = readFileSync(join(f.project, "mise.toml"), "utf8");
    assert.match(mise, /skillex sync --scope project --project '\{\{config_root\}\}'/);
    assert.match(mise, /echo custom/); assert.match(mise, /echo bye/);
    assert.doesNotMatch(mise, /sync-skills\.py|provision-packs\.py|skills:provision|patterns = \["\.agents\/skills\.json"\]/);
    assert.equal(existsSync(join(f.project, ".mise", "scripts", "sync-skills.py")), false);
    assert.equal(f.audit().status, "pass"); assert.equal(f.migrate().report.results[0].status, "noop");
  } finally { f.close(); }
});
test("task audit checks the actual run and pin, not comments or other tasks", () => {
  const f = fixture(); try {
    put(join(f.project, ".agents", "skills.json"), '{"inherit_global":false,"skills":[]}\n');
    assert.equal(f.migrate().exit, 0);
    put(join(f.project, "mise.toml"), `# skillex sync --scope project --project '{{config_root}}'\n# "npm:@delorenj/skillex" = "0.1.1"\n[tasks.other]\nrun = "skillex sync --scope project --project '{{config_root}}'"\ntools = { "npm:@delorenj/skillex" = "0.1.1" }\n[tasks."skills:sync"]\nrun = "echo not wired"\n`);
    assert.equal(f.audit().status, "fail");
    assert.equal(f.migrate().exit, 0);
    assert.equal(f.audit().status, "pass");
    assert.match(readFileSync(join(f.project, "mise.toml"), "utf8"), /\[tasks.other\]/);
  } finally { f.close(); }
});

test("failed initial manifest publication reports no applied manifest write", () => {
  const f = fixture(); try {
    const inject = join(f.base, "fail-manifest.mjs");
    const destination = join(f.project, ".agents", "skills.json");
    put(inject, `import { promises as fs } from "node:fs";\nconst original = fs.link;\nfs.link = async function(source, destination, ...args) {\nif (destination === ${JSON.stringify(destination)}) { const error = new Error("injected publication failure"); error.code = "EIO"; throw error; }\nreturn original.call(this, source, destination, ...args);\n};\n`);
    f.env.NODE_OPTIONS = `--import ${inject}`;
    const result = f.migrate();
    assert.notEqual(result.exit, 0, JSON.stringify(result.report));
    // The task and aliases are independent progress (PJAN-135); the manifest is not claimed.
    assert.equal(result.report.results[0].status, "partial");
    assert.equal(result.report.changedFiles.includes(destination), false);
    assert.equal(existsSync(destination), false);
  } finally { f.close(); }
});
