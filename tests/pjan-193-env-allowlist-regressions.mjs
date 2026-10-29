import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { HERMETIC_TMP_BASE, PASSTHROUGH, hermeticDefaultHome, hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
import { checkTree, scanSource } from "../scripts/check-hermetic-test-env.mjs";
import { BUNDLED_SUITE_PASSTHROUGH, runTypescriptRegression } from "./pjan-77-test-runner.mjs";

// PJAN-193: a child env is an ALLOWLIST. Two guards, both proven here.
//
// 1. Dynamic. Novel, secret-shaped variables are planted in THIS process's env
//    (a randomized PJ_CANARY_SECRET_<hex>, which no denylist can know about in
//    advance, plus GITHUB_TOKEN and OP_SERVICE_ACCOUNT_TOKEN set to junk), and
//    a real `pj` child is started with hermeticEnv(). The env is captured from
//    INSIDE that child (a --import preload that serializes process.env when the
//    pj process exits), never from hermeticEnv()'s return value: a check that
//    compares the helper's output with itself proves nothing ("Self-checks
//    derived from one source"). The child's env must hold none of the planted
//    names and nothing outside the documented allowlist.
//
// 2. Static. scripts/check-hermetic-test-env.mjs (also a gate in
//    scripts/run-tests.mjs) must flag every way a test file can hand a child
//    the operator env, honour a marked + listed exception, and refuse a marker
//    in an unlisted file and a stale exception. Each rule is exercised on a
//    synthetic source, and the real tests/ tree must be clean.

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let checks = 0;
function checkpoint(label) { checks++; console.log(`PASS ${label}`); }

const scratch = hermeticScratch("pjan-193-allowlist-");
try {
  // ---- 1. dynamic: what a real pj child actually sees ----------------------
  const novel = `PJ_CANARY_SECRET_${randomBytes(6).toString("hex").toUpperCase()}`;
  const planted = {
    [novel]: `canary-${randomBytes(8).toString("hex")}`,
    // Junk values, randomized and deliberately not shaped like any real token.
    GITHUB_TOKEN: `junk-${randomBytes(8).toString("hex")}`,
    OP_SERVICE_ACCOUNT_TOKEN: `junk-${randomBytes(8).toString("hex")}`,
    OPENROUTER_API_KEY: `junk-${randomBytes(8).toString("hex")}`,
    PLANE_33GOD_API_KEY: "junk-plane-key",
    SKILLEX_HOME: "/definitely/not/skillex",
    MISE_DATA_DIR: "/definitely/not/mise",
    XDG_CONFIG_HOME: "/definitely/not/xdg-config",
    NODE_OPTIONS: "--max-old-space-size=64",
  };
  const saved = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
  Object.assign(process.env, planted);
  try {
    const dump = join(scratch, "child-env.json");
    const preload = join(scratch, "dump-env.mjs");
    put(preload, `import { writeFileSync } from "node:fs";
process.on("exit", () => writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ pid: process.pid, argv: process.argv, env: process.env })));
`);
    const fixtureHome = join(scratch, "home");
    mkdirSync(fixtureHome, { recursive: true });
    const env = hermeticEnv({ HOME: fixtureHome, PJ_FIXTURE_VALUE: "kept" });
    const run = spawnSync(process.execPath, ["--import", preload, cli, "--version"], {
      cwd: scratch, env, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(run.status, 0, `pj --version must run:\n${run.stdout}\n${run.stderr}`);
    assert.equal(run.stdout.trim(), pkg.version, "the child must be the real pj CLI");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    assert.equal(seen.argv[1], cli, "the env was captured inside the pj process itself");
    assert.notEqual(seen.pid, process.pid);

    for (const name of Object.keys(planted)) {
      assert.equal(Object.hasOwn(seen.env, name), false, `${name} reached the pj child (value ${JSON.stringify(seen.env[name])})`);
    }
    // Not just the planted names: nothing outside the allowlist may arrive.
    const allowed = new Set([...Object.keys(PASSTHROUGH), "TMPDIR", "PYTHONDONTWRITEBYTECODE", "HOME", "PJ_FIXTURE_VALUE"]);
    const unexpected = Object.keys(seen.env).filter((name) => !allowed.has(name) && !/^LC_[A-Z]+$/.test(name));
    assert.deepEqual(unexpected, [], `variables outside the allowlist reached the pj child: ${unexpected.join(", ")}`);
    assert.equal(seen.env.HOME, fixtureHome, "the fixture HOME wins, never the operator's");
    assert.equal(seen.env.TMPDIR, HERMETIC_TMP_BASE, "TMPDIR is pinned to the git-free base");
    assert.equal(seen.env.PATH, process.env.PATH, "PATH is passed through so tools resolve");
    assert.equal(seen.env.PJ_FIXTURE_VALUE, "kept", "fixture values reach the child");
    checkpoint(`a real pj child sees none of ${Object.keys(planted).length} planted operator variables (incl. ${novel}) and nothing off the allowlist`);

    // Without a fixture HOME the child still never gets the operator's.
    const bare = spawnSync(process.execPath, ["--import", preload, cli, "--version"], {
      cwd: scratch, env: hermeticEnv(), encoding: "utf8", timeout: 60_000,
    });
    assert.equal(bare.status, 0, bare.stderr);
    const bareSeen = JSON.parse(readFileSync(dump, "utf8"));
    assert.equal(bareSeen.env.HOME, hermeticDefaultHome(), "an unset fixture HOME becomes the private hermetic home");
    assert.notEqual(bareSeen.env.HOME, saved.HOME ?? process.env.HOME);
    checkpoint("a child with no fixture HOME gets the private hermetic home, not the operator's");

    assert.throws(() => hermeticEnv({}, { pass: ["HOME"] }), /never passed through/);
    assert.throws(() => hermeticEnv({}, { pass: ["XDG_STATE_HOME"] }), /never passed through/);
    const passed = hermeticEnv({}, { pass: [novel, "PJ_NOT_SET_ANYWHERE_193"] });
    assert.equal(passed[novel], planted[novel], "a name listed in `pass` is copied");
    assert.equal(Object.hasOwn(passed, "PJ_NOT_SET_ANYWHERE_193"), false, "an unset `pass` name stays absent");
    assert.equal(Object.hasOwn(hermeticEnv({ TMPDIR: undefined }), "TMPDIR"), false, "a fixture undefined removes the key");
    checkpoint("`pass` copies only named variables and refuses HOME and XDG_*");

    // ---- the launcher of the bundled TypeScript suites ----------------------
    // A bundled suite is a child too. It sees the Postgres names it is listed
    // for and none of the planted credentials. CI is NOT passed (PJAN-194):
    // tests/pjan-77-notebook-hooks-capture.ts was its only reader, to widen a
    // latency budget on a shared runner (PJAN-132), and now measures CPU time
    // and event order instead. A suite that behaves differently on a hosted
    // runner than on a workstation is the flake this removes, so a bundled
    // suite that READS process.env.CI (assigning it, as the pjan-180 suites do
    // for their own children, is not reading it) must fail here and either
    // drop the dependency or list CI in BUNDLED_SUITE_PASSTHROUGH on purpose.
    const readsCi = readdirSync(join(root, "tests")).filter((name) => name.endsWith(".ts"))
      .filter((name) => /process\.env\.CI\b(?!\s*=[^=])|process\.env\[["']CI["']\](?!\s*=[^=])/.test(readFileSync(join(root, "tests", name), "utf8")));
    assert.equal(BUNDLED_SUITE_PASSTHROUGH.includes("CI"), readsCi.length > 0, `CI passthrough and CI readers disagree: passed=${BUNDLED_SUITE_PASSTHROUGH.includes("CI")}, read by ${JSON.stringify(readsCi)}`);
    const probe = join(scratch, "bundled-probe.ts");
    put(probe, 'process.stdout.write(JSON.stringify({ ci: process.env.CI ?? null, keys: Object.keys(process.env) }));\n');
    const bundledSees = (ci) => {
      const savedCi = process.env.CI;
      if (ci === undefined) delete process.env.CI; else process.env.CI = ci;
      const realWrite = process.stdout.write;
      let captured = "";
      process.stdout.write = (chunk) => { captured += chunk; return true; };
      try { runTypescriptRegression(relative(join(root, "tests"), probe)); } finally {
        process.stdout.write = realWrite;
        if (savedCi === undefined) delete process.env.CI; else process.env.CI = savedCi;
      }
      return JSON.parse(captured);
    };
    const withCi = bundledSees("true");
    assert.equal(withCi.ci, readsCi.length > 0 ? "true" : null, "CI reaches a bundled suite exactly when a bundled suite reads it");
    assert.equal(bundledSees(undefined).ci, null, "CI is passed through, never invented");
    for (const name of Object.keys(planted)) assert.equal(withCi.keys.includes(name), false, `${name} reached the bundled suite`);
    const bundledAllowed = new Set([...allowed, ...BUNDLED_SUITE_PASSTHROUGH]);
    assert.deepEqual(withCi.keys.filter((name) => !bundledAllowed.has(name) && !/^LC_[A-Z]+$/.test(name)), [], "nothing off the allowlist reached the bundled suite");
    checkpoint("a bundled TypeScript suite sees CI only if one reads it, and none of the planted credentials");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }

  // ---- 2. static: the checker flags every inheriting shape -----------------
  const kinds = (text, file = "x.mjs") => scanSource(text, file).filter((site) => !site.marked).map((site) => site.kind).sort();
  assert.deepEqual(kinds('spawnSync("git", [], { env: { ...process.env, A: "1" } });'), ["spread"]);
  assert.deepEqual(kinds("const e = { ...process.env };"), ["spread"]);
  assert.deepEqual(kinds("const e = Object.fromEntries(Object.entries(process.env).filter(Boolean));"), ["copy"]);
  assert.deepEqual(kinds("const e = Object.assign({}, process.env);"), ["copy"]);
  assert.deepEqual(kinds("const e = structuredClone(process.env);"), ["copy"]);
  assert.deepEqual(kinds('function run(env = process.env) { return spawnSync("x", [], { env }); }'), ["default"]);
  assert.deepEqual(kinds('spawnSync("x", [], { env: options.env ?? process.env });'), ["default", "pass"]);
  assert.deepEqual(kinds('spawnSync("x", [], { env: process.env });'), ["pass"]);
  assert.deepEqual(kinds('spawnSync("git", ["init"], { cwd });'), ["implicit"]);
  assert.deepEqual(kinds('spawnSync("git", ["init"]);'), ["implicit"]);
  assert.deepEqual(kinds('cp.execFileSync("git", ["init"], options);'), ["implicit (options not a literal)"]);
  assert.deepEqual(kinds('spawn("git", [], { cwd, ...options });'), ["implicit (options spread)"]);
  assert.deepEqual(kinds('new StdioClientTransport({ command: "node", args: [] });'), ["implicit"]);
  assert.deepEqual(kinds("runOnPty({ argv: [], steps: [] });"), ["implicit"]);
  assert.deepEqual(kinds('const s: string = "x"; spawnSync("x", [], { env: { ...(process.env as any) } });', "x.ts"), ["spread"]);
  // Aliasing and renaming: the shapes the literal `process.env` match missed.
  const spawnWith = (prelude, options = "{ env: base }") => `${prelude}\nspawnSync("git", [], ${options});`;
  assert.deepEqual(kinds(spawnWith("const base = process.env;")), ["alias", "pass"]);
  assert.deepEqual(kinds(spawnWith("const base = process.env;", '{ env: { ...base, X: "1" } }')), ["alias", "spread"]);
  assert.deepEqual(kinds(spawnWith("const { env } = process;", "{ env }")), ["alias", "pass"]);
  assert.deepEqual(kinds(spawnWith("const { env: operator } = process;", '{ env: { ...operator } }')), ["alias", "spread"]);
  assert.deepEqual(kinds(spawnWith("const { HOME, ...rest } = process.env;", "{ env: rest }")), ["alias", "pass"]);
  assert.deepEqual(kinds(spawnWith("let base; base = process.env;", "{ env: base }")), ["pass"]);
  assert.deepEqual(kinds(spawnWith("const a = process.env;\nconst b = a;", "{ env: b }")), ["alias", "alias", "pass"]);
  assert.deepEqual(kinds(spawnWith("", "{ env: { ...globalThis.process.env } }")), ["spread"]);
  assert.deepEqual(kinds(spawnWith("", '{ env: { ...process["env"] } }')), ["spread"]);
  assert.deepEqual(kinds(spawnWith('import p from "node:process";', "{ env: { ...p.env } }")), ["spread"]);
  assert.deepEqual(kinds(spawnWith('import * as p from "process";', "{ env: p.env }")), ["pass"]);
  assert.deepEqual(kinds(spawnWith('import { env } from "node:process";', "{ env }")), ["alias", "pass"]);
  assert.deepEqual(kinds(spawnWith('const p = require("node:process");', "{ env: p.env }")), ["pass"]);
  assert.deepEqual(kinds("const e = JSON.parse(JSON.stringify(process.env));"), ["copy"]);
  assert.deepEqual(kinds(spawnWith("", "{ env: Object.create(process.env) }")), ["copy"]);
  assert.deepEqual(kinds('spawnSync("x", [], { env: { ...(process.env as any) } });', "x.ts"), ["spread"]);
  assert.deepEqual(kinds('import { spawnSync as run } from "node:child_process";\nrun("x", [], { cwd });'), ["implicit"]);
  assert.deepEqual(kinds('import { spawnSync as run } from "node:child_process";\nrun("x", [], { env: process.env });'), ["pass"]);
  assert.deepEqual(kinds('import { execFile } from "node:child_process";\nconst sp = execFile; sp("x", []);'), ["implicit"]);
  assert.deepEqual(kinds('import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\npromisify(execFile)("x", []);'), ["implicit"]);
  assert.deepEqual(kinds('import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nawait run("x", [], { cwd });'), ["implicit"]);
  assert.deepEqual(kinds('import cp2 from "node:child_process";\ncp2.exec("ls");'), ["implicit"]);
  assert.deepEqual(kinds('import * as proc from "child_process";\nproc.execSync("ls");'), ["implicit"]);
  assert.deepEqual(kinds('const { spawnSync: go } = require("child_process");\ngo("x", []);'), ["implicit"]);
  assert.deepEqual(kinds('const cp = await import("node:child_process");\ncp.spawnSync("x", []);'), ["implicit"]);
  assert.deepEqual(kinds('import spawn from "cross-spawn";\nspawn("x", []);'), ["implicit"]);
  // An env that can be undefined is no env: node falls back to process.env.
  assert.deepEqual(kinds('spawnSync("x", [], { env: undefined });'), ["implicit (env may be undefined)"]);
  assert.deepEqual(kinds('spawnSync("x", [], { env: null });'), ["implicit (env may be undefined)"]);
  assert.deepEqual(kinds('spawnSync("x", [], { env: cond ? hermeticEnv() : undefined });'), ["implicit (env may be undefined)"]);
  assert.deepEqual(kinds('function run(args, env) { return spawnSync("x", args, { env }); }'), ["implicit (env may be undefined)"]);
  assert.deepEqual(kinds('const run = (args, env) => spawnSync("x", args, { env: env });'), ["implicit (env may be undefined)"]);
  assert.deepEqual(kinds('function run(args, { env }) { return spawnSync("x", args, { env }); }'), ["implicit (env may be undefined)"]);
  assert.deepEqual(kinds('function run(args, options) { return spawnSync("x", args, { env: options.env }); }'), ["implicit (env may be undefined)"]);
  assert.deepEqual(kinds('function run(args, env = hermeticEnv()) { return spawnSync("x", args, { env }); }'), [], "a parameter with a built default is a built env");
  assert.deepEqual(kinds('function run(args, { env = hermeticEnv() } = {}) { return spawnSync("x", args, { env }); }'), []);
  assert.deepEqual(kinds('const env = hermeticEnv(); spawnSync("x", [], { env });'), []);
  assert.deepEqual(kinds('spawnSync("x", [], { cwd, ...options, env: hermeticEnv() });'), [], "a spread BEFORE env cannot override it");
  assert.deepEqual(kinds('spawnSync("x", [], { cwd, env: hermeticEnv(), ...options });'), ["implicit (options spread after env)"]);
  // Not children, not inheritance:
  assert.deepEqual(kinds('spawnSync("git", [], { env: hermeticEnv({ A: "1" }) });'), []);
  assert.deepEqual(kinds("const m = /a(b)/.exec(text); db.exec(sql);"), []);
  assert.deepEqual(kinds("Object.assign(process.env, { HOME: home });"), [], "writing into this process's env copies nothing out");
  assert.deepEqual(kinds('const fixture = `spawnSync("git", [], { env: process.env }); ${"x"}`;'), [], "fixture source in a template literal is text, not a call");
  assert.deepEqual(kinds('const home = process.env.HOME; inspect({ env: process.env });'), [], "reading a variable or passing the suite's own env in-process builds no child env");
  assert.deepEqual(kinds("const { HOME, PATH } = process.env;"), [], "reading named variables is not holding the env");
  assert.deepEqual(kinds("const env = hermeticEnv(); const copy = { ...env, A: 1 };"), [], "spreading a built env is the normal idiom");
  assert.deepEqual(kinds('// hermetic-env: inherits -- build step\nspawnSync("npm", ["run", "build"]);'), []);
  checkpoint("scanSource flags spread, copy, default, pass and implicit inheritance, and nothing else");

  const tree = join(scratch, "tree");
  put(join(tree, "tests", "clean.mjs"), 'spawnSync("git", [], { env: hermeticEnv() });\n');
  put(join(tree, "tests", "helpers", "hermetic-env.mjs"), "export const copy = { ...process.env };\n");
  put(join(tree, "tests", "listed.mjs"), '// hermetic-env: inherits -- build step\nspawnSync("npm", ["run", "build"]);\n');
  const listed = new Map([["tests/listed.mjs", "build step"]]);
  assert.deepEqual(checkTree(tree, listed).violations, [], "a marked site in a listed file passes; the helper itself is exempt");
  assert.match(checkTree(tree, new Map()).violations.join("\n"), /tests\/listed\.mjs:2 {2}implicit: marked .* not in the EXCEPTIONS list/);
  assert.match(checkTree(tree, new Map([...listed, ["tests/clean.mjs", "x"]])).violations.join("\n"), /tests\/clean\.mjs {2}stale exception/);
  put(join(tree, "tests", "leaky.ts"), 'spawnSync(process.execPath, [cli], { env: { ...process.env, PJ: "1" } });\n');
  assert.match(checkTree(tree, listed).violations.join("\n"), /tests\/leaky\.ts:1 {2}spread/);
  checkpoint("checkTree enforces the exception list both ways: unlisted markers and stale entries fail");

  const real = checkTree(root);
  assert.deepEqual(real.violations, [], `the real tests/ tree must be clean:\n${real.violations.join("\n")}`);
  checkpoint(`the real tests/ tree is clean (${real.sites.length} marked inheriting site(s))`);

  console.log(`PJAN-193 env allowlist: ${checks} groups passed.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
