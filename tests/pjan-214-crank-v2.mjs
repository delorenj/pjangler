import "./helpers/hermetic-suite.mjs";
// PJAN-214: crank v2. A crank is one live interactive agent session (cli + session id + pid
// and its start time), clocked by its own Candybar; the project's `.project.json` `crank` block
// over the install's crank.toml decides whether and how often. The tab model is gone.
//
// Pinned here:
//   - policy resolution and its provenance (project > global > default), interval grammar
//   - cron generation (staggered, Candybar-legal) and the next-fire reader agree
//   - the manifest pj writes is TOML Candybar can read back field for field
//   - identity refuses anything that is not a proven interactive agent (this test process)
//   - the built CLI: enable/interval/config/status/disable against a real temp project, a
//     throwaway redis-server (the legacy tab switch it retires) and a Candybar that is down
//   - hook mode never fails a session start
// Never 6379: the live Redis. Candybar is pointed at a closed port, never the live API.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
import { startThrowawayRedis } from "./pjan-182-crank-regressions-helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const pj = join(root, "dist", "index.js");
assert.ok(existsSync(pj), "dist/index.js missing: run `mise run build` first");

const workspace = hermeticScratch("pjan-214");
symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
writeFileSync(
  join(workspace, "entry.ts"),
  [
    `export * from ${JSON.stringify(join(root, "src/crank/policy.ts"))};`,
    `export { bindingName, identifyAgent, manifestSpec, renderManifest, manifestPath, BINDING_TAG, CRANK_TAG } from ${JSON.stringify(join(root, "src/crank/binding.ts"))};`,
    `export { nextFire } from ${JSON.stringify(join(root, "src/crank/sessions.ts"))};`,
    `export { createCrankController } from ${JSON.stringify(join(root, "src/crank/controller.ts"))};`,
    `export { parse as parseToml } from "smol-toml";`,
  ].join("\n"),
);
const kitOut = join(workspace, "kit.mjs");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [join(workspace, "entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", "--sourcemap=inline", `--outfile=${kitOut}`],
  { encoding: "utf8", env: hermeticEnv() },
);
if (built.status !== 0) {
  console.error(`failed to bundle the crank v2 kit:\n${built.stderr}`);
  process.exit(1);
}
const kit = await import(kitOut);
const {
  normaliseInterval, intervalSeconds, intervalCron, resolvePolicy, coerceValue, updateProjectBlock, readProjectBlock,
  bindingName, identifyAgent, manifestSpec, renderManifest, manifestPath, nextFire, createCrankController, parseToml,
  CrankPolicyError,
} = kit;

const project = (name, extra = {}) => {
  const dir = join(workspace, "repos", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".project.json"), JSON.stringify({ project_id: name, project_name: `${name[0].toUpperCase()}${name.slice(1)} Project`, ...extra }, null, 4) + "\n");
  return dir;
};

console.log("interval grammar: <N>m (1-59), <N>h (1-23), 1d; spelled-out units normalise; the rest is absent");
{
  assert.equal(normaliseInterval("5m"), "5m");
  assert.equal(normaliseInterval(" 15 min "), "15m");
  assert.equal(normaliseInterval("2hr"), "2h");
  assert.equal(normaliseInterval("1day"), "1d");
  for (const bad of ["0m", "60m", "24h", "2d", "5s", "", "fast", 5, null, undefined]) assert.equal(normaliseInterval(bad), undefined, String(bad));
  assert.equal(intervalSeconds("15m"), 900);
  assert.equal(intervalSeconds("6h"), 21600);
  assert.equal(intervalSeconds("1d"), 86400);
}

console.log("cron: staggered by the binding name, Candybar-legal 5 fields, and the next-fire reader agrees with the step");
{
  const seed = "crank-claude-1c2336c3-3407216";
  assert.equal(intervalCron("1m", seed), "* * * * *");
  const five = intervalCron("5m", seed);
  assert.match(five, /^[0-4]-59\/5 \* \* \* \*$/);
  assert.equal(intervalCron("5m", seed), five, "same seed, same phase");
  assert.match(intervalCron("1h", seed), /^\d{1,2} \* \* \* \*$/);
  assert.match(intervalCron("6h", seed), /^\d{1,2} [0-5]-23\/6 \* \* \*$/);
  assert.match(intervalCron("1d", seed), /^\d{1,2} (9|1[0-8]) \* \* \*$/);
  assert.throws(() => intervalCron("90m", seed), CrankPolicyError);
  // two different sessions on 5m do not all land on the same minute
  const phases = new Set(Array.from({ length: 20 }, (_, i) => intervalCron("5m", `crank-claude-x-${i}`).split("-")[0]));
  assert.ok(phases.size > 1, "stagger spreads phases");
  // the reader walks the same cron: consecutive fires are exactly one interval apart
  const now = new Date(2026, 10, 18, 10, 7, 30).getTime();
  for (const interval of ["5m", "15m", "1h", "6h"]) {
    const cron = intervalCron(interval, seed);
    const a = nextFire(cron, now);
    const b = nextFire(cron, a);
    assert.ok(a > now, `${interval}: next fire is in the future`);
    assert.equal(b - a, intervalSeconds(interval) * 1000, `${interval}: ${cron}`);
  }
  assert.equal(nextFire("*/5 * 1 * *", now), undefined, "day-of-month crons are not guessed at");
}

console.log("policy: project block > global crank.toml > built-in default, each value with its source");
{
  const none = resolvePolicy(undefined, {}, "/g");
  assert.deepEqual([none.enabled, none.enabledSource, none.interval, none.intervalSource, none.declared], [false, "default", "5m", "default", false]);
  const global = { enabled_by_default: true, default_interval: "1h", prompt: "keep going", officer_profile: "ops", officer_max_turns: 9, zellij_session: "Desk" };
  const inherit = resolvePolicy({}, global, "/g");
  assert.deepEqual([inherit.enabled, inherit.enabledSource, inherit.interval, inherit.intervalSource, inherit.prompt, inherit.promptSource], [true, "global", "1h", "global", "keep going", "global"]);
  assert.deepEqual([inherit.officerProfile, inherit.officerMaxTurns, inherit.zellijSession, inherit.declared], ["ops", 9, "Desk", true]);
  const own = resolvePolicy({ enabled: false, interval: "15m", prompt: "ship PJAN-214", target: "v2 live", rules: ["no force push", "", 3] }, global, "/g");
  assert.deepEqual([own.enabled, own.enabledSource, own.interval, own.intervalSource, own.prompt, own.promptSource, own.target], [false, "project", "15m", "project", "ship PJAN-214", "project", "v2 live"]);
  assert.deepEqual(own.rules, ["no force push"], "non-string and blank rules are dropped");
  const garbage = resolvePolicy({ interval: "every so often" }, { default_interval: "nope", officer_max_turns: 99 }, "/g");
  assert.deepEqual([garbage.interval, garbage.intervalSource, garbage.officerMaxTurns], ["5m", "default", 6], "a bad value falls through, never sticks");
}

console.log("config values: typed per key, with the reason when refused");
{
  assert.equal(coerceValue("enabled", "on"), true);
  assert.equal(coerceValue("enabled_by_default", "0"), false);
  assert.equal(coerceValue("interval", "30 min"), "30m");
  assert.equal(coerceValue("officer_max_turns", "4"), 4);
  assert.deepEqual(coerceValue("rules", "a; b\nc"), ["a", "b", "c"]);
  assert.deepEqual(coerceValue("rules", '["x","y"]'), ["x", "y"]);
  assert.throws(() => coerceValue("enabled", "maybe"), /expected true\/false/);
  assert.throws(() => coerceValue("interval", "90m"), /not an interval/);
  assert.throws(() => coerceValue("officer_max_turns", "50"), /1-20/);
  assert.throws(() => coerceValue("rules", "[1]"), /array of strings/);
}

console.log(".project.json edits: keep every other key, the file's indent and the block's unknown keys; an empty block is removed");
{
  const dir = project("keeper", { ticket_provider: { type: "plane" }, crank: { triggers: ["later"] } });
  updateProjectBlock(dir, (b) => ({ ...b, enabled: true, interval: "15m" }));
  const text = readFileSync(join(dir, ".project.json"), "utf8");
  assert.match(text, /^\{\n {4}"project_id"/, "4-space indent kept");
  const manifest = JSON.parse(text);
  assert.deepEqual(manifest.ticket_provider, { type: "plane" });
  assert.deepEqual(manifest.crank, { triggers: ["later"], enabled: true, interval: "15m" });
  updateProjectBlock(dir, () => ({}));
  assert.equal(readProjectBlock(dir), undefined);
  assert.ok(!("crank" in JSON.parse(readFileSync(join(dir, ".project.json"), "utf8"))));
  writeFileSync(join(dir, ".project.json"), JSON.stringify({ crank: "on" }));
  assert.throws(() => readProjectBlock(dir), /"crank" must be an object/);
}

console.log("naming + manifest: crank-<cli>-<sid8>-<pid>, and the TOML reads back as the spec");
{
  assert.equal(bindingName({ cli: "claude", sessionId: "1C2336C3-6819-407b", pid: 3407216 }), "crank-claude-1c2336c3-3407216");
  assert.equal(bindingName({ cli: "open-code", sessionId: "ses_ABCdef123456", pid: 7 }), "crank-opencode-abcdef12-7");
  assert.equal(bindingName({ cli: "", sessionId: "", pid: 1 }), "crank-agent-nosid-1");
  const identity = { cli: "claude", sessionId: "1c2336c3-6819-407b-85c9-f3b4ac1bf37b", pid: 3407216, pidStart: "123456789", zellijSession: "Desk", paneId: "56", cwd: "/x" };
  const policy = resolvePolicy({ enabled: true, interval: "15m" }, {}, "/g");
  const spec = manifestSpec(identity, policy, { root: "/repo/alpha", slug: "alpha" }, new Date("2026-11-18T12:00:00Z"));
  assert.equal(spec.name, "crank-claude-1c2336c3-3407216");
  assert.deepEqual(spec.argv.slice(-3), ["crank", "fire", spec.name]);
  assert.equal(manifestPath("/repo/alpha", spec.name), "/repo/alpha/.candybars/crank-claude-1c2336c3-3407216.candybar.toml");
  const doc = parseToml(renderManifest(spec)).candybar;
  assert.equal(doc.name, spec.name);
  assert.equal(doc.schedule, intervalCron("15m", spec.name));
  assert.deepEqual([...doc.tags], ["crank", "crank-session", "cli:claude"]);
  assert.equal(doc.runner.kind, "exec");
  assert.deepEqual([...doc.runner.argv], spec.argv);
  assert.equal(doc.runner.workdir, "/repo/alpha");
  assert.deepEqual({ ...doc.runner.env }, {
    CRANK_BINDING: spec.name, CRANK_CLI: "claude", CRANK_SESSION_ID: identity.sessionId, CRANK_PID: "3407216", CRANK_PID_START: "123456789",
    CRANK_ZELLIJ_SESSION: "Desk", CRANK_PANE_ID: "56", CRANK_PROJECT_ROOT: "/repo/alpha", CRANK_PROJECT: "alpha", CRANK_INTERVAL: "15m",
  });
  assert.ok(!doc.tags.some((t) => t.startsWith("project:")), "Candybar adds project:<repo> itself");
}

console.log("identity: this test process is not an interactive agent, and every refusal says why");
{
  const env = { ...process.env };
  delete env.ZELLIJ_SESSION_NAME;
  const notAgent = identifyAgent({ cli: "claude", sessionId: "00000000-0000-0000-0000-000000000000", pid: process.pid }, "Desk");
  assert.equal(notAgent.ok, false);
  assert.ok(notAgent.reason && notAgent.reason.length > 5, notAgent.reason);
  const dead = identifyAgent({ cli: "codex", sessionId: "x", pid: 2 ** 22 + 7 }, "Desk");
  assert.equal(dead.ok, false);
  const nothing = identifyAgent({ cli: "kimi" }, "Desk");
  assert.equal(nothing.ok, false);
}

console.log("controller: toggle and interval go through the project block, then attach / detach / re-clock");
{
  const dir = project("ctl");
  const calls = [];
  const controller = createCrankController({
    project: { root: dir, slug: "ctl" },
    sessions: async () => [],
    attach: async (p) => { calls.push(["attach", p.slug]); return { attached: ["crank-claude-a-1"], skipped: ["pane 9: not an agent"] }; },
    detach: async (r) => { calls.push(["detach", r]); return [{ name: "crank-claude-a-1", reason: "disabled", archived: true }]; },
    reclock: async (r) => { calls.push(["reclock", r]); return ["crank-claude-a-1"]; },
    log: () => [],
  });
  assert.match(await controller.toggle(), /crank ON · 1 session\(s\) attached, 1 wait/);
  assert.equal(readProjectBlock(dir).enabled, true);
  assert.match(await controller.setInterval("1h"), /interval 1h · 1 live crank\(s\) re-clocked/);
  assert.equal(readProjectBlock(dir).interval, "1h");
  assert.match(await controller.setInterval(undefined), /interval 5m \(global default\)/);
  assert.equal(readProjectBlock(dir).interval, undefined);
  assert.match(await controller.toggle(), /crank OFF · 1 crank\(s\) ended/);
  assert.equal(readProjectBlock(dir).enabled, false);
  assert.deepEqual(calls.map((c) => c[0]), ["attach", "reclock", "reclock", "detach"]);
  const view = await createCrankController({ project: { root: dir, slug: "ctl" }, sessions: async () => { throw new Error("candybar down"); }, log: () => [] }).read();
  assert.equal(view.sessionsReadable, false);
  assert.equal(view.sessionsError, "candybar down");
}

// ---------------------------------------------------------------------------
// The built CLI, end to end
// ---------------------------------------------------------------------------

const closedPort = await new Promise((done) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});
const rs = await startThrowawayRedis();
let failed;
try {
  const which = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: hermeticEnv() }).stdout.trim();
  const bin = join(workspace, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["env", "timeout", "redis-cli", "cat", "git"]) symlinkSync(which(tool), join(bin, tool));
  const alpha = project("alpha");
  const registry = join(workspace, "registry.yaml");
  writeFileSync(registry, `schema_version: 1\nprojects:\n  alpha:\n    name: Alpha Project\n    slug: alpha\n    repo_path: ${alpha}\n    source_artifacts: []\n    ticket_provider: {}\n    agents: {}\n`);
  const config = join(workspace, "config");
  const state = join(workspace, "state");
  const env = hermeticEnv({
    PATH: bin,
    HOME: workspace,
    XDG_CONFIG_HOME: config,
    CRANK_STATE_DIR: state,
    GIT_CEILING_DIRECTORIES: workspace,
    NO_COLOR: "1",
    ZCRANK_REDIS_HOST: "127.0.0.1",
    ZCRANK_REDIS_PORT: String(rs.port),
    CANDYBAR_API_URL: `http://127.0.0.1:${closedPort}`,
    PJ_PROJECT_REGISTRY: registry,
  });
  const run = (args, opts = {}) => spawnSync(process.execPath, [pj, "crank", ...args], { cwd: opts.cwd ?? alpha, encoding: "utf8", timeout: 30_000, env: { ...env, ...(opts.env ?? {}) }, input: opts.input ?? "" });

  console.log("cli: status outside any crank config is OFF from the built-in default, and an unreachable Candybar is 'unknown', not 'none'");
  {
    const out = run(["status"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /crank · alpha {2}OFF \(built-in default\)/);
    assert.match(out.stdout, /interval {2}5m \(built-in default\)/);
    assert.match(out.stdout, /sessions unknown: Candybar unreadable/);
    assert.doesNotMatch(out.stdout, /no live crank sessions/);
    const json = JSON.parse(run(["status", "--json"]).stdout);
    assert.equal(json.sessions, null);
    assert.ok(json.sessionsError);
    assert.equal(json.policy.enabled, false);
  }

  console.log("cli: --global config writes crank.toml under XDG_CONFIG_HOME and the project inherits it");
  {
    assert.equal(run(["config", "set", "default_interval", "1h", "--global"]).status, 0);
    assert.equal(run(["enable", "--global"]).status, 0);
    const toml = readFileSync(join(config, "33god", "crank.toml"), "utf8");
    assert.match(toml, /default_interval = "1h"/);
    assert.match(toml, /enabled_by_default = true/);
    const json = JSON.parse(run(["status", "--json"]).stdout);
    assert.deepEqual([json.policy.enabled, json.policy.enabledSource, json.policy.interval, json.policy.intervalSource], [true, "global", "1h", "global"]);
    const bad = run(["config", "set", "default_interval", "90m", "--global"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not an interval/);
    assert.equal(run(["disable", "--global"]).status, 0);
    assert.match(readFileSync(join(config, "33god", "crank.toml"), "utf8"), /enabled_by_default = false/);
  }

  console.log("cli: enable --interval writes the block, turns the legacy tab switch off, and never prompts without a TTY");
  {
    rs.cli("HSET", "zcrank:tab:Alpha Project", "enabled", "1");
    const out = run(["enable", "--interval", "15m", "--no-attach"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /ON {2}alpha every 15m \(\.project\.json\)/);
    assert.match(out.stdout, /legacy tab switch zcrank:tab:Alpha Project turned off/);
    assert.equal(rs.cli("HGET", "zcrank:tab:Alpha Project", "enabled"), "0");
    assert.deepEqual(readProjectBlock(alpha), { enabled: true, interval: "15m" });
  }

  console.log("cli: config set/get/unset edit the project block; unknown keys are refused by name");
  {
    assert.equal(run(["config", "set", "prompt", "Finish PJAN-214, then stop"]).status, 0);
    assert.equal(run(["config", "set", "rules", "never force push; ask before deleting data"]).status, 0);
    assert.equal(run(["config", "get", "prompt"]).stdout.trim(), "Finish PJAN-214, then stop");
    assert.deepEqual(readProjectBlock(alpha).rules, ["never force push", "ask before deleting data"]);
    const status = run(["status"]).stdout;
    assert.match(status, /prompt {4}Finish PJAN-214, then stop \(\.project\.json\)/);
    assert.match(status, /rule {6}never force push/);
    assert.equal(run(["config", "unset", "rules"]).status, 0);
    assert.equal(readProjectBlock(alpha).rules, undefined);
    const unknown = run(["config", "set", "tab", "Alpha"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown project key "tab"/);
  }

  console.log("cli: interval default drops the override and follows the global default");
  {
    const out = run(["interval", "default"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /interval 1h \(global crank\.toml\)/);
    assert.equal(readProjectBlock(alpha).interval, undefined);
  }

  console.log("cli: disable writes OFF first, so a Candybar that is down cannot leave the project ON");
  {
    const out = run(["disable"]);
    assert.equal(readProjectBlock(alpha).enabled, false, "the policy is OFF whatever Candybar said");
    assert.match(out.stdout, /OFF {2}alpha/);
    assert.equal(out.status, 1, "the unreachable Candybar is reported, not swallowed");
    assert.match(out.stderr, /crank disable failed/);
  }

  console.log("cli: hook mode never fails a session start: outside a project it skips, logs a line, exits 0");
  {
    const elsewhere = join(workspace, "not-a-project");
    mkdirSync(elsewhere, { recursive: true });
    const out = run(["attach", "--hook"], { cwd: elsewhere, input: JSON.stringify({ session_id: "abc", cwd: elsewhere, hook_event_name: "SessionStart" }) });
    assert.equal(out.status, 0, out.stderr);
    const log = readFileSync(join(state, "hooks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const last = log.at(-1);
    assert.equal(last.status, "skipped", JSON.stringify(last));
    const detach = run(["detach", "--hook"], { cwd: elsewhere, input: JSON.stringify({ session_id: "abc", cwd: elsewhere, reason: "exit" }) });
    assert.equal(detach.status, 0, detach.stderr);
  }
} catch (error) {
  failed = error;
} finally {
  await rs.stop();
}
if (failed) throw failed;
console.log("\nPJAN-214 crank v2: all green");
