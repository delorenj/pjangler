// PJAN-135: the mise.toml pjangler writes must keep working on the mise it runs
// under, and the retired skills:sync task must stay retired everywhere.
//
// 1. mise 2026.7.8 deprecated `script` for spawned hook commands ("Use `run`
//    instead", removed in 2027.3.0) and pjangler emitted `[[hooks.enter]]
//    script = …` everywhere. Measured on mise 2026.9.12: `run` fires on entry
//    and on leave with the same cwd, the same {{config_root}} expansion and the
//    same `sh -o errexit -c` command line, and prints no warning. A `script`
//    array is joined with newlines into ONE such command, and a table with a
//    `shell` key is sourced into the operator's shell (not spawned, not
//    deprecated, and `run` there would execute the text as a file name).
// 2. The skills:sync mise task retired with the 2026-10-10 skill-operation-task
//    policy: no generator writes it, migrate deletes a carried copy, and skill
//    operations invoke skillex directly (`pj skills …` relays the bundled CLI).
//
// Real temp repositories, the real rule objects bundled from src/, and the
// real mise binary with every MISE_* directory isolated under the fixture.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { parse as parseToml } from "smol-toml";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync("/tmp/pjan135-mise-");
after(() => rmSync(work, { recursive: true, force: true }));
const bundle = join(root, "node_modules", ".cache", `pjan-135-mise-${process.pid}.mjs`);
buildSync({
  stdin: {
    contents: [
      'export { createMiseChecks } from "./src/parity/rules";',
      'export { WireMiseAgentHooks } from "./src/commands/AgentHooksCommands";',
    ].join("\n"),
    resolveDir: root,
  },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const { createMiseChecks, WireMiseAgentHooks } = await import(pathToFileURL(bundle).href);
rmSync(bundle);
const mise = createMiseChecks().find((check) => check.id === "mise.config-root");

/** The real mise, with no state, config, trust or session leaking in either direction. */
function miseEnv(state, trusted) {
  // hermeticEnv copies no MISE_*/__MISE* (session state) from the operator.
  return hermeticEnv({
    HOME: join(state, "home"),
    XDG_CONFIG_HOME: join(state, "xdg-config"),
    XDG_STATE_HOME: join(state, "xdg-state"),
    XDG_CACHE_HOME: join(state, "xdg-cache"),
    MISE_DATA_DIR: join(state, "data"),
    MISE_STATE_DIR: join(state, "state"),
    MISE_CACHE_DIR: join(state, "cache"),
    MISE_CONFIG_DIR: join(state, "config"),
    MISE_TRUSTED_CONFIG_PATHS: trusted,
  });
}

/** Enter `repo` in a mise-activated bash, then leave it, exactly as an operator's prompt would. */
function enterAndLeave(repo, state) {
  mkdirSync(join(state, "home"), { recursive: true });
  return spawnSync("bash", ["--noprofile", "--norc", "-c", [
    'eval "$(mise activate --no-hook-env bash)"',
    'cd "$1" && eval "$(mise hook-env --force --shell bash)"',
    'cd "$2" && eval "$(mise hook-env --force --shell bash)"',
  ].join("\n"), "pjan-135-hooks", repo, work], { cwd: work, env: miseEnv(state, repo), encoding: "utf8" });
}

function repoWith(name, text) {
  const repo = join(work, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "mise.toml"), text);
  writeFileSync(join(repo, "AGENTS.md"), "# Agent rules\n");
  return repo;
}

const ctxFor = (repo) => ({ repoRoot: repo, targetDir: repo, homeDir: join(work, "home"), pjanglerRoot: root, dryRun: false, force: false });

const log = "'{{config_root}}/hooks.log'";
const SHELL_HOOK = `[[hooks.enter]]
# sourced into the operator's shell: not spawned, not deprecated, never renamed
shell = "bash"
script = "echo shell-hook >> ${log}"`;
const LEGACY = `[env]
_.path = [".mise/scripts", "agents/hermes/pm"]

[[hooks.enter]]
script = "'{{config_root}}/.mise/scripts/link-agentfiles.sh'"
[[hooks.enter]]
# a foreign spawned hook, legacy spelling
script = "echo foreign-enter cwd=$PWD >> ${log}" # trailing comment kept
[[hooks.enter]]
scripts = [
  "echo array-a >> ${log}",
  "echo array-b >> ${log}",
]
${SHELL_HOOK}
[[hooks.leave]]
script = 'echo foreign-leave >> "{{config_root}}/hooks.log"'

[tasks.keep]
run = "echo untouched"
`;

test("legacy `script` hook tables are fixable drift; migrate renames them to `run` and real mise runs them the same, silently", async () => {
  const repo = repoWith("legacy hooks", LEGACY);
  const ctx = ctxFor(repo);

  // The fixture is not vacuous: real mise warns on exactly this file today.
  const before = enterAndLeave(repo, join(work, "mise-before"));
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stderr, /hook tables using `script` or `scripts` for spawned commands are deprecated/);
  const legacyLog = readFileSync(join(repo, "hooks.log"), "utf8");
  rmSync(join(repo, "hooks.log"));

  const audited = await mise.audit(ctx);
  assert.equal(audited.status, "fail");
  assert.equal(audited.fixable, true);
  const issue = audited.details.find((detail) => /spell the spawned command `script`\/`scripts`/.test(detail));
  // Both single-string hooks, the array and the leave hook; the `shell` table is not drift.
  assert.ok(issue, JSON.stringify(audited.details));
  assert.match(issue, /^4 hook table\(s\) .*\(line\(s\) 5, 8, 10, 19\)/);

  const migrated = await mise.migrate(ctx, audited);
  assert.equal(migrated.status, "applied", JSON.stringify(migrated));
  const text = readFileSync(join(repo, "mise.toml"), "utf8");
  // Pure key rename for a single string: quoting and trailing comment kept.
  assert.ok(text.includes(`run = "echo foreign-enter cwd=$PWD >> ${log}" # trailing comment kept`), text);
  assert.ok(text.includes(`[[hooks.leave]]\nrun = 'echo foreign-leave >> "{{config_root}}/hooks.log"'`), text);
  // An array becomes the one newline-joined command mise already ran for it.
  assert.equal(parseToml(text).hooks.enter.find((hook) => /array-a/.test(hook.run ?? "")).run,
    `echo array-a >> ${log}\necho array-b >> ${log}`);
  assert.ok(text.includes(SHELL_HOOK), "the shell hook survives byte-for-byte");
  assert.match(text, /^\[\[hooks\.enter\]\]\nrun = "'\{\{config_root\}\}\/\.mise\/scripts\/link-agentfiles\.sh' '\{\{config_root\}\}'"$/m);
  assert.match(text, /\[tasks\.keep\]\nrun = "echo untouched"/);
  for (const hook of [...parseToml(text).hooks.enter, ...parseToml(text).hooks.leave]) {
    assert.ok(hook.shell ? hook.script : hook.run && !("script" in hook) && !("scripts" in hook), JSON.stringify(hook));
  }

  const clean = await mise.audit(ctx);
  assert.equal(clean.status, "pass", JSON.stringify(clean.details));
  const again = await mise.migrate(ctx, clean);
  assert.equal(again.status, "noop");
  assert.equal(readFileSync(join(repo, "mise.toml"), "utf8"), text, "byte-idempotent");

  // Real mise: every hook still fires on entry and on leave, in order, with the
  // same cwd and config_root expansion, and nothing is deprecated any more.
  const after = enterAndLeave(repo, join(work, "mise-after"));
  assert.equal(after.status, 0, after.stderr);
  assert.doesNotMatch(after.stderr, /deprecated/, after.stderr);
  assert.equal(readFileSync(join(repo, "hooks.log"), "utf8"), legacyLog);
  assert.deepEqual(legacyLog.trim().split("\n"), [
    `foreign-enter cwd=${repo}`, "array-a", "array-b", "shell-hook", "foreign-leave",
  ]);
  // The managed hook ran for real, with its subject root.
  assert.ok(existsSync(join(repo, "CLAUDE.md")), "link-agentfiles.sh linked the agent files");
});

test("a rename that cannot parse is left for the operator, never written broken", async () => {
  const text = `[env]\n_.path = [".mise/scripts", "agents/hermes/pm"]\n\n[[hooks.enter]]\nrun = "echo a"\nscript = "echo b"\n[[hooks.leave]]\nscript = "echo c"\n`;
  const repo = repoWith("both keys", text);
  const ctx = ctxFor(repo);
  const audited = await mise.audit(ctx);
  assert.ok(audited.details.some((detail) => /spell the spawned command/.test(detail)), "still reported");
  const migrated = await mise.migrate(ctx, audited);
  assert.equal(migrated.status, "partial", "never reported as done");
  assert.ok(migrated.details.some((detail) => /left untouched \(renaming would not parse\)/.test(detail)), JSON.stringify(migrated));
  const written = readFileSync(join(repo, "mise.toml"), "utf8");
  assert.doesNotThrow(() => parseToml(written), written);
  assert.match(written, /^run = "echo a"\nscript = "echo b"$/m);
  // The table that CAN be renamed still is: one bad table never vetoes the rest.
  assert.match(written, /^\[\[hooks\.leave\]\]\nrun = "echo c"$/m);
});

test("skills:sync is retired: nothing writes it, migrate deletes a carried copy, and no template carries one", async () => {
  const OLD_TASK = `[tasks."skills:sync"]
description = "Reconcile this project's selected skills"
tools = { "npm:@delorenj/skillex" = { version = "0.1.2", allow_low_downloads = true }, node = "24" }
run = "skillex sync --scope project --project '{{config_root}}'"`;

  // (1) what mise.config-root writes on a fresh migrate: no skills task at all.
  const repo = repoWith("retire", "[env]\n_.path = [\".mise/scripts\", \"agents/hermes/pm\"]\n");
  const ctx = ctxFor(repo);
  await mise.migrate(ctx, await mise.audit(ctx));
  const written = readFileSync(join(repo, "mise.toml"), "utf8");
  assert.equal(parseToml(written).tasks["skills:sync"], undefined, written);
  assert.equal((await mise.audit(ctx)).status, "pass");

  // (2) what WireMiseAgentHooks appends: also none.
  const wired = repoWith("wired", "[env]\n");
  const previous = process.env.PJ_AGENT_HOOKS_LAYER;
  process.env.PJ_AGENT_HOOKS_LAYER = "1";
  try { assert.equal((await new WireMiseAgentHooks({ targetDir: wired }).invoke()).success, true); }
  finally { if (previous === undefined) delete process.env.PJ_AGENT_HOOKS_LAYER; else process.env.PJ_AGENT_HOOKS_LAYER = previous; }
  assert.equal(parseToml(readFileSync(join(wired, "mise.toml"), "utf8")).tasks["skills:sync"], undefined);

  // (3) + (4) both CommonProject copies
  const jinja = readFileSync(join(root, "templates", "commonproject", "template", "mise.toml.jinja"), "utf8")
    .replace(/\{%-? raw -?%\}|\{%-? endraw -?%\}/g, "")
    .replace(/^\{%-?.*-?%\}$/gm, "")
    .replace(/\{\{ project_name \}\}/g, "fixture");
  const templates = {
    "template/mise.toml.jinja": parseToml(jinja),
    "mise.toml": parseToml(readFileSync(join(root, "templates", "commonproject", "mise.toml"), "utf8")),
  };
  for (const [name, parsed] of Object.entries(templates)) {
    assert.equal(parsed.tasks["skills:sync"], undefined, name);
    for (const kind of ["enter", "leave"]) {
      for (const hook of parsed.hooks?.[kind] ?? []) assert.ok(hook.run && !("script" in hook), `${name} hooks.${kind}: ${JSON.stringify(hook)}`);
    }
  }

  // (5) The exact managed form every project carried until the 2026-10-10
  // retirement is fixable drift, and migrate deletes it: skill operations
  // invoke skillex directly, never a mise task.
  writeFileSync(join(repo, "mise.toml"), `${written.trimEnd()}\n\n${OLD_TASK}\n`);
  const carried = await mise.audit(ctx);
  assert.equal(carried.status, "fail", "a carried skills:sync task is drift");
  assert.equal(carried.fixable, true);
  assert.ok(carried.details.some((detail) => /Retire the skills:sync mise task/.test(detail)), JSON.stringify(carried.details));
  await mise.migrate(ctx, carried);
  const retiredText = readFileSync(join(repo, "mise.toml"), "utf8");
  assert.equal(parseToml(retiredText).tasks["skills:sync"], undefined, retiredText);
  assert.equal((await mise.audit(ctx)).status, "pass", JSON.stringify((await mise.audit(ctx)).details));

  // Real mise loads the retired file cleanly and no longer knows the task.
  const tasks = spawnSync("mise", ["tasks", "--json"], { cwd: repo, env: miseEnv(join(work, "mise-pin"), repo), encoding: "utf8" });
  assert.equal(tasks.status, 0, tasks.stderr);
  assert.equal(tasks.stderr, "", "no parse or deprecation warning");
  assert.ok(!JSON.parse(tasks.stdout).some((task) => task.name === "skills:sync"), "the task is gone from mise's registry");
});
