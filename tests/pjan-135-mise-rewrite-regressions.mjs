// PJAN-135 review (F2): a mise.toml rewrite may change only what it means to.
//
// The adversarial review reproduced ten defects in the hook/task rewrite that
// `mise.config-root`, `secrets.env-op` and `skills.project-manifest` share:
// comment text inside a legacy `scripts` array became a hook command (a quoted
// `rm -f` in a comment ran on leave), valid hook forms were torn apart
// (`[hooks.enter]` shell tables, `[hooks]` postinstall/cd keys, multi-line
// strings, inline-table arrays), a stray materializer removal left an empty
// `[[hooks.cd]]` mise refuses to load, a retired writer claimed the operator's
// commands joined into the same hook, and every one of those reported
// `applied` with a passing re-audit. The legacy string skillex pin passed the
// audit while mise refused to install it, and a first migrate was not a fixed
// point.
//
// Every case here runs the REAL rule objects bundled from src/, in real temp
// repositories, and judges the result with the real TOML parser and the REAL
// mise binary (every MISE_* / XDG_* directory isolated under the fixture). The
// hook normalization below is written independently of src/ on purpose: it is
// mise's documented, measured meaning of each form (see the measurements in
// the rewrite module), not a copy of the code under test.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { parse as parseToml } from "smol-toml";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync("/tmp/pjan135-rewrite-");
after(() => rmSync(work, { recursive: true, force: true }));
// skillex refuses a state directory below a git work tree; keep every state
// root under this fixture.
for (const [key, dir] of [["XDG_STATE_HOME", "xdg-state"], ["XDG_CONFIG_HOME", "xdg-config"], ["XDG_CACHE_HOME", "xdg-cache"]]) {
  process.env[key] = join(work, dir);
}
process.env.GIT_CEILING_DIRECTORIES = "/tmp";

const bundle = join(root, "node_modules", ".cache", `pjan-135-rewrite-${process.pid}.mjs`);
buildSync({
  stdin: {
    contents: [
      'export { createMiseChecks, createMiseOpInjectChecks, createAgentHooksChecks, SKILLS_SYNC_TOOLS, verifyMiseHookRewrite } from "./src/parity/rules";',
      'export { WireMiseAgentHooks } from "./src/commands/AgentHooksCommands";',
    ].join("\n"),
    resolveDir: root,
  },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const rules = await import(pathToFileURL(bundle).href);
rmSync(bundle);
const mise = rules.createMiseChecks().find((check) => check.id === "mise.config-root");
const secrets = rules.createMiseOpInjectChecks().find((check) => check.id === "secrets.env-op");
const skills = rules.createAgentHooksChecks().find((check) => check.id === "skills.project-manifest");

const LINK = "'{{config_root}}/.mise/scripts/link-agentfiles.sh' '{{config_root}}'";
const MATERIALIZE = "'{{config_root}}/.mise/scripts/materialize-env.sh'";
const LOG = "'{{config_root}}/hooks.log'";

// ---------------------------------------------------------------------------
// mise's meaning of a hook definition, measured on mise 2026.9.12:
//   "cmd"                       one spawned `sh -o errexit -c cmd`
//   [hooks] K = ["a", "b"]      two separate spawned hooks (a failing a does not stop b)
//   { run = "cmd" }             one spawned hook
//   { script = "cmd" }          the same, deprecated spelling
//   { scripts = ["a", "b"] }    ONE spawned hook "a\nb" (a failing a stops b)
//   { shell = "bash", ... }     sourced into the operator's shell: kept verbatim
function normalizeDef(def) {
  if (typeof def === "string") return { run: def };
  if (typeof def.shell === "string" || def.run !== undefined) return def;
  const { script, scripts, ...rest } = def;
  if (typeof script === "string" && scripts === undefined) return { run: script, ...rest };
  if (Array.isArray(scripts) && script === undefined) return { run: scripts.join("\n"), ...rest };
  return def;
}
function hookModel(text) {
  const hooks = parseToml(text).hooks ?? {};
  return Object.fromEntries(Object.entries(hooks).map(([kind, value]) =>
    [kind, (Array.isArray(value) ? value : [value]).map(normalizeDef)]));
}
const withoutHooks = (text) => { const { hooks: _hooks, ...rest } = parseToml(text); return rest; };

/** The real mise, with no state, config, trust or session leaking in either direction. */
function miseEnv(state, trusted) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MISE_") && !key.startsWith("__MISE")));
  mkdirSync(join(state, "home"), { recursive: true });
  return {
    ...env,
    HOME: join(state, "home"),
    XDG_CONFIG_HOME: join(state, "xdg-config"),
    XDG_STATE_HOME: join(state, "xdg-state"),
    XDG_CACHE_HOME: join(state, "xdg-cache"),
    MISE_DATA_DIR: join(state, "data"),
    MISE_STATE_DIR: join(state, "state"),
    MISE_CACHE_DIR: join(state, "cache"),
    MISE_CONFIG_DIR: join(state, "config"),
    MISE_TRUSTED_CONFIG_PATHS: trusted,
  };
}
let stateCounter = 0;
const freshState = () => join(work, `mise-state-${stateCounter++}`);

/** Enter `repo` in a mise-activated bash, then leave it, exactly as an operator's prompt would. */
function enterAndLeave(repo) {
  const state = freshState();
  return spawnSync("bash", ["--noprofile", "--norc", "-c", [
    'eval "$(mise activate --no-hook-env bash)"',
    'cd "$1" && eval "$(mise hook-env --force --shell bash)"',
    'echo "PJ_SHELL_HOOK=${PJ_SHELL_HOOK:-unset}" >> "$1/hooks.log"',
    'cd "$2" && eval "$(mise hook-env --force --shell bash)"',
  ].join("\n"), "pjan-135-rewrite", repo, work], { cwd: work, env: miseEnv(state, repo), encoding: "utf8" });
}

/** `mise tasks ls` in the repo: does real mise load this config at all? */
function miseLoads(repo) {
  return spawnSync("mise", ["tasks", "ls"], { cwd: repo, env: miseEnv(freshState(), repo), encoding: "utf8" });
}

let repoCounter = 0;
function repoWith(text, extra = {}) {
  const repo = join(work, `repo ${repoCounter++}`);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "mise.toml"), text);
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n");
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  return repo;
}
const ctxFor = (repo, dryRun = false) => ({ repoRoot: repo, targetDir: repo, homeDir: join(work, "home"), pjanglerRoot: root, dryRun, force: false });
const read = (repo, rel = "mise.toml") => readFileSync(join(repo, rel), "utf8");
const logOf = (repo) => existsSync(join(repo, "hooks.log")) ? read(repo, "hooks.log") : "";

/** Run a real enter/leave and return the log it produced, then clear it. */
function hookRun(repo) {
  const ran = enterAndLeave(repo);
  const log = logOf(repo);
  rmSync(join(repo, "hooks.log"), { force: true });
  return { ...ran, log };
}

/** audit -> migrate -> (dry-run second pass writes nothing) -> second migrate is a byte no-op. */
async function migrateToFixedPoint(check, repo) {
  const ctx = ctxFor(repo);
  const first = await check.migrate(ctx, await check.audit(ctx));
  const written = read(repo);
  const dry = await check.migrate(ctxFor(repo, true), await check.audit(ctx));
  assert.equal(read(repo), written, "a dry run writes nothing");
  const second = await check.migrate(ctx, await check.audit(ctx));
  assert.equal(read(repo), written, `the first ${check.id} migrate is a fixed point:\n${written}`);
  assert.ok(!second.changedFiles.some((file) => file.endsWith("mise.toml")), `second ${check.id} pass rewrote mise.toml: ${JSON.stringify(second)}`);
  assert.ok(!dry.changedFiles.some((file) => file.endsWith("mise.toml")), `dry second pass would rewrite mise.toml: ${JSON.stringify(dry)}`);
  return { first, second, written };
}

function assertMiseClean(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /parse_error|Invalid TOML|deprecated|not supported|not found in mise tool registry/, `${label}: ${result.stderr}`);
}

// ---------------------------------------------------------------------------

test("legacy `scripts` arrays: comment text never becomes a command and never swallows one", async () => {
  const canary = "'{{config_root}}/canary'";
  const cases = {
    apostrophes: `[[hooks.enter]]
scripts = [
  "echo step-a >> ${LOG}",  # don't remove, codegen needs it
  "echo step-b >> ${LOG}",  # it's the cache warmer
]
`,
    quoted: `[[hooks.leave]]
scripts = [
  "echo leave-one >> ${LOG}",  # don't run "rm -f ${canary}" here
  "echo leave-two >> ${LOG}",
]
`,
    // The older [hooks] array path had the same scrape.
    "hooks-array": `[hooks]
enter = [
  "echo h-one >> ${LOG}",  # don't run "rm -f ${canary}" here
  # "echo commented-out >> ${LOG}",
  "echo h-two >> ${LOG}",  # it's fine
]
`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const repo = repoWith(text, { canary: "keep me\n" });
    const before = hookRun(repo);
    assert.equal(before.status, 0, before.stderr);
    assert.ok(existsSync(join(repo, "canary")), `${name}: the original leaves the canary alone`);
    // Not vacuous: real mise ran every real command of the original.
    for (const word of text.match(/echo ([\w-]+) >>(?=[^#\n]*(?:,|$))/gm).map((match) => match.split(" ")[1])) {
      if (word !== "commented-out") assert.match(before.log, new RegExp(`^${word}$`, "m"), `${name}: ${before.log}`);
    }
    assert.doesNotMatch(before.log, /commented-out/);
    const original = hookModel(text);

    const { first, written } = await migrateToFixedPoint(mise, repo);
    assert.equal(first.status, "applied", `${name}: ${JSON.stringify(first)}`);
    // The comments are still in the file, as comments.
    for (const comment of text.match(/#.*$/gm)) assert.ok(written.includes(comment.trim()), `${name}: lost ${comment}\n${written}`);
    // Every original hook is still there with exactly its commands, after the managed link hook.
    const model = hookModel(written);
    for (const [kind, defs] of Object.entries(original)) {
      const kept = kind === "enter" ? model.enter.filter((def) => def.run !== LINK) : model[kind];
      assert.deepEqual(kept, defs, `${name}: hooks.${kind}\n${written}`);
    }
    assert.deepEqual(model.enter.filter((def) => def.run === LINK).length, 1, `${name}: one managed link hook`);

    const afterRun = hookRun(repo);
    assertMiseClean(afterRun, name);
    assert.equal(afterRun.log, before.log, `${name}: real mise runs the same hooks, in order`);
    assert.ok(existsSync(join(repo, "canary")), `${name}: a quoted command inside a comment never runs`);
    assert.equal((await mise.audit(ctxFor(repo))).status, "pass", name);
  }
});

test("every other valid mise hook form keeps its meaning through the rewrite", async () => {
  const cases = {
    // mise's documented single-table sourced-shell form.
    "single shell table": `[hooks.enter]
shell = "bash"
script = "export PJ_SHELL_HOOK=1; echo shell-hook >> ${LOG}"
`,
    // Keys under [hooks] other than enter/leave are not pjangler's.
    "hooks keys": `[tools]
jq = "1.7"

[hooks]
postinstall = "echo POSTINSTALL-KEEP"
enter = "echo enter-a >> ${LOG}"
cd = "echo CD-KEEP >> ${LOG}"
`,
    // A line inside a multi-line string is not a table header.
    "multi-line string": `[[hooks.enter]]
run = """
[ -f .env ] || echo "no env" >> ${LOG}
"""

[tasks.build]
run = "echo build"
`,
    // An inline-table element is one hook, not one hook per value.
    "inline tables": `[hooks]
enter = [{ shell = "bash", script = "export PJ_SHELL_HOOK=2; echo inline-shell >> ${LOG}" }, "echo plain >> ${LOG}"]
`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const repo = repoWith(text);
    const before = hookRun(repo);
    assert.equal(before.status, 0, `${name}: ${before.stderr}`);
    assert.doesNotMatch(before.stderr, /parse_error/, `${name}: the fixture is valid for real mise`);
    // Not vacuous: real mise ran each hook of the original (and sourced the shell ones).
    const ran = { "single shell table": ["shell-hook", "PJ_SHELL_HOOK=1"], "hooks keys": ["enter-a", "CD-KEEP"],
      "multi-line string": ["no env"], "inline tables": ["inline-shell", "plain", "PJ_SHELL_HOOK=2"] }[name];
    for (const line of ran) assert.match(before.log, new RegExp(`^${line}$`, "m"), `${name}: ${before.log}`);
    const original = hookModel(text);

    const { first, written } = await migrateToFixedPoint(mise, repo);
    assert.equal(first.status, "applied", `${name}: ${JSON.stringify(first)}`);
    assert.doesNotThrow(() => parseToml(written), `${name}:\n${written}`);
    const model = hookModel(written);
    assert.deepEqual(model.enter[0], { run: LINK }, `${name}: the managed hook runs first\n${written}`);
    assert.deepEqual({ ...model, enter: model.enter.slice(1) }, { ...original, enter: original.enter ?? [] }, `${name}: every other hook, key and order is unchanged\n${written}`);
    const originalRest = withoutHooks(text);
    const rest = withoutHooks(written);
    for (const key of Object.keys(originalRest)) {
      if (key === "tasks") {
        for (const [task, body] of Object.entries(originalRest.tasks)) assert.deepEqual(rest.tasks[task], body, `${name}: tasks.${task}`);
      } else if (key !== "env") {
        assert.deepEqual(rest[key], originalRest[key], `${name}: ${key}`);
      }
    }

    const afterRun = hookRun(repo);
    assertMiseClean(afterRun, name);
    assert.equal(afterRun.log, before.log, `${name}: real mise runs the same hooks with the same effect`);
    assertMiseClean(miseLoads(repo), `${name} tasks ls`);
    assert.equal((await mise.audit(ctxFor(repo))).status, "pass", name);
  }
});

test("an owned materializer outside hooks.enter is removed as a whole hook, never leaving an empty table", async () => {
  const envOp = readFileSync(join(root, "templates", "commonproject", "template", ".env.op"), "utf8");
  const text = `[[hooks.cd]]
run = "op inject -i .env.op -o .env -f"

[[hooks.leave]]
run = "${MATERIALIZE.replace(/"/g, '\\"')}"

[[hooks.leave]]
script = "op inject -i .env.op > .env"

[[hooks.leave]]
run = "echo leave-keep >> ${LOG}"

[tasks.t]
run = "echo task-ran"
`;
  const repo = repoWith(text, { ".env.op": envOp, ".gitignore": ".env\n.env.*\n!.env.op\n" });
  const ctx = ctxFor(repo);
  const audited = await secrets.audit(ctx);
  assert.equal(audited.status, "fail");
  assert.ok(audited.details.some((detail) => /outside \[\[hooks\.enter\]\]/.test(detail)), JSON.stringify(audited.details));

  const { first, written } = await migrateToFixedPoint(secrets, repo);
  assert.equal(first.status, "applied", JSON.stringify(first));
  const model = hookModel(written);
  assert.equal(model.cd, undefined, `the owned cd hook is gone, table and all:\n${written}`);
  assert.deepEqual(model.leave, [{ run: `echo leave-keep >> ${LOG}` }], written);
  assert.deepEqual(model.enter, [{ run: MATERIALIZE }], written);
  assert.doesNotMatch(written, /^\[\[hooks\.(?:cd|leave)\]\]\s*\n\s*(?:\n|\[|$)/m, `no empty hook table:\n${written}`);
  assert.equal((await secrets.audit(ctx)).status, "pass");

  const run = spawnSync("mise", ["run", "t"], { cwd: repo, env: miseEnv(freshState(), repo), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /task-ran/);
  assertMiseClean(hookRun(repo), "after secrets.env-op");
});

test("a retired writer is removed per command; the operator's commands in the same hook survive and link-agentfiles runs once", async () => {
  const user = "'{{config_root}}/user.log'";
  const text = `[[hooks.enter]]
scripts = ["${LINK.replace(/"/g, '\\"')}", "echo USER-STEP-KEEP-ME >> ${user}"]
[[hooks.enter]]
scripts = ["python3 '{{config_root}}/.mise/scripts/provision-packs.py' --root '{{config_root}}'", "echo USER-STEP-TWO >> ${user}"]
`;
  const stubLink = "#!/bin/sh\necho link >> \"$1/link.log\"\n";
  const repo = repoWith(text, { ".mise/scripts/link-agentfiles.sh": stubLink, ".mise/scripts/provision-packs.py": "pass\n" });
  chmodSync(join(repo, ".mise/scripts/link-agentfiles.sh"), 0o755);
  const before = enterAndLeave(repo);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(read(repo, "user.log"), "USER-STEP-KEEP-ME\nUSER-STEP-TWO\n", "the original runs both operator steps");
  assert.equal(read(repo, "link.log"), "link\n");
  rmSync(join(repo, "user.log"));
  rmSync(join(repo, "link.log"));

  const { first, written } = await migrateToFixedPoint(mise, repo);
  assert.equal(first.status, "applied", JSON.stringify(first));
  const model = hookModel(written);
  assert.deepEqual(model.enter, [
    { run: LINK },
    { run: `echo USER-STEP-KEEP-ME >> ${user}` },
    { run: `echo USER-STEP-TWO >> ${user}` },
  ], written);
  assert.equal((await mise.audit(ctxFor(repo))).status, "pass");

  // Real mise, with the managed script swapped for a counting stub.
  writeFileSync(join(repo, ".mise/scripts/link-agentfiles.sh"), stubLink);
  const afterRun = enterAndLeave(repo);
  assertMiseClean(afterRun, "per-command removal");
  assert.equal(read(repo, "user.log"), "USER-STEP-KEEP-ME\nUSER-STEP-TWO\n", "both operator steps still run");
  assert.equal(read(repo, "link.log"), "link\n", "link-agentfiles runs exactly once per entry");
});

test("a retired writer inside a compound command is left for the operator and never reported done", async () => {
  const compound = "python3 '{{config_root}}/.mise/scripts/provision-packs.py' --root '{{config_root}}' && codegraph sync";
  const repo = repoWith(`[[hooks.enter]]\nrun = "${compound}"\n`);
  const ctx = ctxFor(repo);
  const migrated = await mise.migrate(ctx, await mise.audit(ctx));
  assert.equal(migrated.status, "partial", JSON.stringify(migrated));
  assert.ok(migrated.details.some((detail) => /by hand/.test(detail) && detail.includes("provision-packs.py")), JSON.stringify(migrated.details));
  const written = read(repo);
  assert.equal(hookModel(written).enter.filter((def) => def.run === compound).length, 1, `the compound hook is untouched:\n${written}`);
  const audited = await mise.audit(ctx);
  assert.equal(audited.status, "fail");
  assert.equal(audited.fixable, false, `only a manual edit remains: ${JSON.stringify(audited)}`);
  const again = await mise.migrate(ctx, audited);
  assert.equal(read(repo), written, "a second pass changes nothing");
  assert.equal(again.status, "partial");
});

test("skill sync from any hook kind, and under a commented table header, is removed; audit and migrate agree", async () => {
  const text = `[[hooks.postinstall]]
run = "mise run skills:sync"

[[hooks.enter]] # retired writer
run = "python3 '{{config_root}}/.mise/scripts/provision-packs.py' --root '{{config_root}}'"

[[hooks.enter]]
run = "echo keep >> ${LOG}"
`;
  const repo = repoWith(text);
  const ctx = ctxFor(repo);
  const audited = await mise.audit(ctx);
  assert.equal(audited.status, "fail");
  assert.equal(audited.fixable, true);
  const { first, written } = await migrateToFixedPoint(mise, repo);
  assert.equal(first.status, "applied", JSON.stringify(first));
  const model = hookModel(written);
  assert.equal(model.postinstall, undefined, written);
  assert.deepEqual(model.enter, [{ run: LINK }, { run: `echo keep >> ${LOG}` }], written);
  const clean = await mise.audit(ctx);
  assert.equal(clean.status, "pass", JSON.stringify(clean.details));
  assertMiseClean(hookRun(repo), "skill sync removal");
});

test("the first migrate is a fixed point on a file with no [env] and on one whose _.path is followed by a blank line", async () => {
  for (const text of [
    `[tools]\npython = "3.12"\n\n[tasks.build]\nrun = "echo build"\n`,
    `[env]\n_.path = [".mise/scripts", "agents/hermes/pm"]\n\n[tools]\npython = "3.12"\n`,
    `min_version = "2026.1.0"\n\n[tools]\npython = "3.12"\n`,
  ]) {
    const repo = repoWith(text);
    const { first, written } = await migrateToFixedPoint(mise, repo);
    assert.notEqual(first.status, "partial", JSON.stringify(first));
    const parsed = parseToml(written);
    assert.deepEqual(parsed.env._.path.slice(-2), [".mise/scripts", "agents/hermes/pm"]);
    for (const [key, value] of Object.entries(parseToml(text))) {
      if (key === "tasks") for (const [task, body] of Object.entries(value)) assert.deepEqual(parsed.tasks[task], body, `tasks.${task} is untouched:\n${written}`);
      else if (key !== "env") assert.deepEqual(parsed[key], value, `${key} is untouched:\n${written}`);
    }
    assert.equal((await mise.audit(ctxFor(repo))).status, "pass");
  }
});

test("the legacy string skillex pin is fixable drift in both audits, and migrate writes the approved table", async () => {
  const repo = repoWith("[env]\n_.path = [\".mise/scripts\", \"agents/hermes/pm\"]\n");
  const ctx = ctxFor(repo);
  await mise.migrate(ctx, await mise.audit(ctx));
  assert.equal((await mise.audit(ctx)).status, "pass");
  const table = read(repo);
  const legacy = table.replace(rules.SKILLS_SYNC_TOOLS, '{ "npm:@delorenj/skillex" = "0.1.1", node = "24" }');
  assert.notEqual(legacy, table);
  writeFileSync(join(repo, "mise.toml"), legacy);

  const audited = await mise.audit(ctx);
  assert.equal(audited.status, "fail", "mise 2026.9 refuses this pin, so it is not parity");
  assert.equal(audited.fixable, true);
  assert.ok(audited.details.some((detail) => /allow_low_downloads/.test(detail)), JSON.stringify(audited.details));
  // skills.project-manifest reads the same wiring.
  mkdirSync(join(work, "registry", "all-skills"), { recursive: true });
  mkdirSync(join(work, "registry", "sets"), { recursive: true });
  mkdirSync(join(work, "registry", "packs"), { recursive: true });
  const previous = process.env.PJ_SKILLS_REGISTRY_ROOT;
  process.env.PJ_SKILLS_REGISTRY_ROOT = join(work, "registry");
  try {
    const skillsFinding = await skills.audit(ctx);
    assert.equal(skillsFinding.status, "fail");
    assert.ok(skillsFinding.details.some((detail) => /allow_low_downloads/.test(detail)), JSON.stringify(skillsFinding.details));
  } finally {
    if (previous === undefined) delete process.env.PJ_SKILLS_REGISTRY_ROOT; else process.env.PJ_SKILLS_REGISTRY_ROOT = previous;
  }

  const { first, written } = await migrateToFixedPoint(mise, repo);
  assert.equal(first.status, "applied");
  assert.deepEqual(parseToml(written).tasks["skills:sync"].tools["npm:@delorenj/skillex"], { version: "0.1.1", allow_low_downloads: true });
  assert.equal((await mise.audit(ctx)).status, "pass");
  const info = spawnSync("mise", ["tasks", "info", "skills:sync", "--json"], { cwd: repo, env: miseEnv(freshState(), repo), encoding: "utf8" });
  assert.equal(info.status, 0, info.stderr);
  assert.deepEqual(JSON.parse(info.stdout).tools["npm:@delorenj/skillex"], { version: "0.1.1", allow_low_downloads: true });
});

test("a rewrite that cannot be made safely writes nothing and says why, dry or not", async () => {
  const cases = {
    // An operator's own task under the managed name: the canonical block would duplicate it.
    "foreign managed task": `[tasks."link:agentfiles"]\nrun = "echo mine"\n`,
    // A hook form pjangler does not edit; real mise still runs it.
    "dotted hooks key": `hooks.enter = "echo dotted >> ${LOG}"\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const repo = repoWith(text);
    for (const dryRun of [true, false]) {
      const ctx = ctxFor(repo, dryRun);
      const migrated = await mise.migrate(ctx, await mise.audit(ctx));
      assert.equal(migrated.status, "partial", `${name} dry=${dryRun}: ${JSON.stringify(migrated)}`);
      assert.ok(!migrated.changedFiles.some((file) => file.endsWith("mise.toml")), `${name}: mise.toml is not claimed`);
      assert.ok(migrated.details.some((detail) => /mise\.toml was not rewritten/.test(detail)), `${name}: ${JSON.stringify(migrated.details)}`);
      assert.equal(read(repo), text, `${name} dry=${dryRun}: nothing written`);
    }
  }
  const dotted = join(work, `repo ${repoCounter - 1}`);
  const ran = hookRun(dotted);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.log, /^dotted$/m, "the untouched file still works");
});

test("the guard rejects every corrupted output the old rewrite produced", async () => {
  const verifyMiseRewrite = rules.verifyMiseHookRewrite;
  assert.equal(typeof verifyMiseRewrite, "function", "the rewrite guard is exported for inspection");
  const bad = [
    // F1(b): an apostrophe in a comment fused two elements into garbage.
    ["link", `[[hooks.enter]]\nscripts = [\n  "echo step-a",  # don't remove, codegen needs it\n  "echo step-b",  # it's the cache warmer\n]\n`,
      `[[hooks.enter]]\nrun = "echo step-a\\nt remove, codegen needs it\\n  \\"echo step-b\\",  # it"\n`],
    // F4(b): postinstall deleted, cd orphaned into [tools].
    ["link", `[tools]\njq = "1.7"\n\n[hooks]\npostinstall = "echo POSTINSTALL-KEEP"\nenter = "echo enter-a"\ncd = "echo CD-KEEP"\n`,
      `[tools]\njq = "1.7"\ncd = "echo CD-KEEP"\n\n[[hooks.enter]]\nrun = "${LINK}"\n[[hooks.enter]]\nrun = "echo enter-a"\n`],
    // F4(d): one inline-table hook split into two spawned commands.
    ["link", `[hooks]\nenter = [{ shell = "bash", script = "export X=1" }, "echo plain"]\n`,
      `[[hooks.enter]]\nrun = "${LINK}"\n[[hooks.enter]]\nrun = "bash"\n[[hooks.enter]]\nrun = "export X=1"\n[[hooks.enter]]\nrun = "echo plain"\n`],
    // F2: an empty [[hooks.cd]] table.
    ["op", `[[hooks.cd]]\nrun = "op inject -i .env.op -o .env -f"\n`,
      `[[hooks.cd]]\n\n[[hooks.enter]]\nrun = "${MATERIALIZE}"\n`],
    // F3: the operator's step joined behind a retired writer was dropped.
    ["link", `[[hooks.enter]]\nscripts = ["python3 '{{config_root}}/.mise/scripts/provision-packs.py' --root '{{config_root}}'", "echo USER-STEP-TWO"]\n`,
      `[[hooks.enter]]\nrun = "${LINK}"\n`],
  ];
  for (const [owner, original, corrupted] of bad) {
    assert.doesNotThrow(() => parseToml(corrupted), "each corrupted output parses: only a semantic check can catch it");
    const verdict = verifyMiseRewrite(original, corrupted, owner);
    assert.equal(verdict.ok, false, `accepted:\n${corrupted}`);
    assert.match(verdict.reason, /hooks|tools/);
  }
});

test("mise.versioning: a multi-line run string is not torn apart, and a task it cannot replace is refused, never duplicated", async () => {
  const versioning = rules.createMiseChecks().find((check) => check.id === "mise.versioning");
  // A `[` line inside a multi-line string is not a table header.
  const multiline = `[tasks.version]\nrun = """\n[ -f VERSION ] && cat VERSION\n"""\n\n[tasks.build]\nrun = "echo build"\n`;
  const repo = repoWith(multiline);
  const { first, written } = await migrateToFixedPoint(versioning, repo);
  assert.equal(first.status, "applied", JSON.stringify(first));
  const parsed = parseToml(written);
  assert.deepEqual(parsed.tasks.build, { run: "echo build" });
  assert.equal(parsed.tasks.version.run, "'{{config_root}}/.mise/scripts/versioning.sh' current");
  assertMiseClean(miseLoads(repo), "versioning multi-line");

  // A managed name defined inline cannot be replaced in place: refused, untouched.
  const inline = `[tasks]\nversion = { run = "cat VERSION" }\n`;
  const refused = repoWith(inline);
  for (const dryRun of [true, false]) {
    const ctx = ctxFor(refused, dryRun);
    const result = await versioning.migrate(ctx, await versioning.audit(ctx));
    assert.equal(result.status, "partial", JSON.stringify(result));
    assert.ok(result.details.some((detail) => /mise\.toml was not rewritten/.test(detail)), JSON.stringify(result.details));
    assert.ok(!result.changedFiles.some((file) => file.endsWith("mise.toml")));
    assert.equal(read(refused), inline);
  }
});

test("WireMiseAgentHooks never writes a mise.toml that does not parse or drops meaning", async () => {
  // A project mise.config-root already migrated carries the managed skills:sync task.
  const repo = repoWith("[env]\n_.path = [\".mise/scripts\", \"agents/hermes/pm\"]\n");
  await mise.migrate(ctxFor(repo), await mise.audit(ctxFor(repo)));
  const before = read(repo);
  const previous = process.env.PJ_AGENT_HOOKS_LAYER;
  process.env.PJ_AGENT_HOOKS_LAYER = "1";
  try {
    const wired = await new rules.WireMiseAgentHooks({ targetDir: repo }).invoke();
    const after = read(repo);
    assert.doesNotThrow(() => parseToml(after), `WireMiseAgentHooks wrote invalid TOML (${wired.message}):\n${after}`);
    const parsedBefore = parseToml(before);
    const parsedAfter = parseToml(after);
    for (const [task, body] of Object.entries(parsedBefore.tasks)) assert.deepEqual(parsedAfter.tasks[task], body, `tasks.${task}`);
    assert.deepEqual(hookModel(after), hookModel(before), "hooks are not touched when there is no [hooks] enter array");
    if (after !== before) assert.ok(parsedAfter.tasks["hooks:sync"], "the agent-hooks tasks were added");
    assertMiseClean(miseLoads(repo), "after WireMiseAgentHooks");
  } finally {
    if (previous === undefined) delete process.env.PJ_AGENT_HOOKS_LAYER; else process.env.PJ_AGENT_HOOKS_LAYER = previous;
  }
});
