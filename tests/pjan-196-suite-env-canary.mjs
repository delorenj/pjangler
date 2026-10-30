import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PASSTHROUGH, SUITE_PASSTHROUGH, OPERATOR_HOME_READERS, hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
import {
  PREAMBLE, PREAMBLE_EXCEPTIONS, REQUIRED_REGISTRATIONS, checkSuitePreambles, firstModuleRequest, readRunnerRegistry, registeredSuites, userInfoSites,
} from "../scripts/check-hermetic-test-env.mjs";

// PJAN-196 canary: the SUITE PROCESS itself is hermetic, standalone and under
// the runner, against a hostile parent env.
//
// PJAN-193 made every CHILD env an allowlist, but left the suite process with
// the operator's whole env: pjangler code a suite calls in-process (src
// bundles, dist/, inspectStatus, the notebook module, ...) read PLANE_*,
// TRELLO_*, GITHUB_TOKEN, OP_SERVICE_ACCOUNT_TOKEN, and os.homedir() was the
// real ~. tests/helpers/hermetic-suite.mjs, imported first by every registered
// suite, closes that. Three guards, all here:
//
// 1. Dynamic. A parent env is planted with NOVEL secret-shaped names (random,
//    so no denylist can know them), junk GITHUB_TOKEN / OP_SERVICE_ACCOUNT_TOKEN
//    / PLANE_API_KEY / TRELLO_*, override paths (HERMES_*, SKILLEX_HOME,
//    XDG_*) and a decoy HOME whose ~/.hermes/fleet.env holds a Plane key. Every
//    planted value carries one random marker. tests/pjan-196-suite-env-probe.mjs
//    runs real src functions in-process and must see none of it, both
//      a. standalone: `node tests/pjan-196-suite-env-probe.mjs`, and
//      b. under the runner: `node scripts/run-tests.mjs <probe>`.
//    The probe reports what it saw; the canary checks it against what was
//    planted rather than trusting the probe's own verdict.
// 2. Control. The same probe with its preamble line removed, in the same
//    hostile env, must FAIL and must report the planted names, the decoy home
//    and the planted Plane key. A probe that cannot see a leak proves nothing.
// 3. Static. scripts/check-hermetic-test-env.mjs (a gate in run-tests.mjs)
//    requires every registered suite's first import to be the preamble and the
//    guards to stay registered; its rules are exercised on synthetic trees and
//    the real tree must be clean. The registry of named passthroughs carries
//    no credential except the two documented ones.

const root = resolve(import.meta.dirname, "..");
const probe = join(root, "tests", "pjan-196-suite-env-probe.mjs");
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const CREDENTIAL = /^(PLANE_|TRELLO_|OP_)|_TOKEN$|_KEY$|_SECRET$|SECRET|PASSWORD/;

let checks = 0;
const checkpoint = (label) => { checks++; console.log(`PASS ${label}`); };
const probeReport = (run) => {
  const line = `${run.stdout}`.split("\n").reverse().find((text) => text.startsWith("PJAN-196 probe: "));
  assert.ok(line, `the probe printed no report:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(line.slice("PJAN-196 probe: ".length));
};

const scratch = hermeticScratch("pjan-196-canary-");
try {
  // ---- the hostile parent env ----------------------------------------------
  const marker = `pjan196-canary-${randomBytes(6).toString("hex")}`;
  const hex = () => randomBytes(5).toString("hex").toUpperCase();
  const decoyHome = join(scratch, "decoy-home");
  put(join(decoyHome, ".hermes", "fleet.env"), `PLANE_API_KEY=${marker}-fleet\nPLANE_33GOD_API_KEY=${marker}-fleet\n`);
  put(join(decoyHome, ".hermes", "agents-registry.yaml"), `# ${marker}\n`);
  put(join(decoyHome, ".agents", "skills.json"), JSON.stringify({ skills: [marker] }));
  const novel = [`PJ_CANARY_${hex()}_SECRET`, `ACME_${hex()}_API_KEY`, `X${hex()}_TOKEN`];
  const planted = {
    ...Object.fromEntries(novel.map((name) => [name, `${marker}-${name.toLowerCase()}`])),
    GITHUB_TOKEN: `${marker}-gh`,
    OP_SERVICE_ACCOUNT_TOKEN: `${marker}-op`,
    PLANE_API_KEY: `${marker}-plane`,
    PLANE_33GOD_API_KEY: `${marker}-plane-33god`,
    TRELLO_API_KEY: `${marker}-trello`,
    TRELLO_TOKEN: `${marker}-trello-token`,
    HERMES_FLEET_ENV: join(decoyHome, ".hermes", "fleet.env"),
    HERMES_AGENTS_REGISTRY: join(decoyHome, ".hermes", "agents-registry.yaml"),
    SKILLEX_HOME: join(decoyHome, `skillex-${marker}`),
    XDG_STATE_HOME: join(decoyHome, `state-${marker}`),
    XDG_CONFIG_HOME: join(decoyHome, `config-${marker}`),
  };
  // A COMPLETE env for the probe's parent: the allowlist plus the hostility.
  // hermeticEnv lets a fixture set HOME and XDG_*, which is how the decoy gets in.
  const hostile = hermeticEnv({ ...planted, HOME: decoyHome });

  const assertShielded = (report, how) => {
    assert.equal(report.shielded, true, `${how}: the preamble did not run`);
    for (const name of Object.keys(planted)) assert.equal(report.keys.includes(name), false, `${how}: planted ${name} reached in-process code`);
    for (const name of report.keys) assert.equal(CREDENTIAL.test(name), false, `${how}: credential-shaped ${name} reached in-process code`);
    assert.equal(report.planeKey33god || report.planeKeyDefault, false, `${how}: src resolvePlaneApiKey found the planted key`);
    for (const path of [report.home, report.agentsRegistry, report.notebookState]) {
      assert.equal(path.startsWith(decoyHome), false, `${how}: ${path} resolved into the decoy HOME`);
      assert.equal(path.includes(marker), false, `${how}: ${path} carries the planted marker`);
    }
    assert.match(report.home, /\/pj-suite-home-[^/]+$/, `${how}: home ${report.home} is not an isolated suite home`);
  };

  // 1a. standalone
  const standalone = spawnSync(process.execPath, [probe], { cwd: root, env: hostile, encoding: "utf8", timeout: 120_000 });
  assert.equal(standalone.status, 0, `standalone probe failed in the hostile env:\n${standalone.stdout}\n${standalone.stderr}`);
  assertShielded(probeReport(standalone), "standalone");
  checkpoint(`standalone: in-process src code sees none of ${Object.keys(planted).length} planted variables (incl. ${novel.join(", ")}) and not the decoy HOME`);

  // 1b. under the runner (its own process tree: the runner hands the probe the
  // hostile env unchanged, exactly as it hands any suite the operator's).
  const runner = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--no-typecheck", "--no-build", "pjan-196-suite-env-probe"], {
    cwd: root, env: hostile, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(runner.status, 0, `the runner failed the probe in the hostile env:\n${runner.stdout}\n${runner.stderr}`);
  assert.match(runner.stdout, /\] pjan-196-suite-env-probe \.\.\. PASS/, "the runner ran the probe");
  assert.match(runner.stdout, /attempted 1 {2}passed 1 {2}failed 0/, "the runner ran exactly the probe");
  checkpoint("under scripts/run-tests.mjs: the probe passes in the same hostile env");

  // 2. control: the same probe without its preamble must see the hostility.
  const probeText = readFileSync(probe, "utf8");
  const preambleLine = `import "${PREAMBLE}";\n`;
  assert.ok(probeText.startsWith(preambleLine), "the probe's first line is the preamble import");
  const helpers = pathToFileURL(join(root, "tests", "helpers")).href;
  // Under node_modules/.cache so its bare imports (esbuild) resolve as the probe's do.
  const unshielded = join(root, "node_modules", ".cache", `pjan-196-unshielded-probe-${process.pid}.mjs`);
  process.on("exit", () => rmSync(unshielded, { force: true }));
  put(unshielded, probeText.slice(preambleLine.length)
    .replaceAll('from "./helpers/', `from "${helpers}/`)
    .replaceAll("import.meta.dirname", JSON.stringify(join(root, "tests"))));
  const control = spawnSync(process.execPath, [unshielded], { cwd: root, env: hostile, encoding: "utf8", timeout: 120_000 });
  assert.notEqual(control.status, 0, `the probe passed WITHOUT its preamble:\n${control.stdout}`);
  const leaked = probeReport(control);
  assert.equal(leaked.shielded, false);
  for (const name of Object.keys(planted)) assert.ok(leaked.keys.includes(name), `the unshielded probe should have seen ${name}`);
  assert.equal(leaked.home, decoyHome, "the unshielded probe resolves the decoy HOME");
  assert.equal(leaked.planeKey33god, true, "the unshielded probe's src resolvePlaneApiKey finds the planted key");
  assert.equal(leaked.agentsRegistry, planted.HERMES_AGENTS_REGISTRY);
  checkpoint("control: without the preamble the same probe sees every planted name, the decoy HOME and the planted Plane key, and fails");

  // ---- 3. static ----------------------------------------------------------
  assert.equal(firstModuleRequest(`import "${PREAMBLE}";\nimport x from "../dist/a.js";`), PREAMBLE);
  assert.equal(firstModuleRequest(`import assert from "node:assert";\nimport "${PREAMBLE}";`), "node:assert", "a builtin first still means the preamble is not first");
  assert.equal(firstModuleRequest(`export { a } from "../src/a";\nimport "${PREAMBLE}";`), "../src/a", "a re-export is a module request too");
  assert.equal(firstModuleRequest(`// comment\nconst x = 1;\nimport { SUITE_HOME } from "${PREAMBLE}";`), PREAMBLE, "imports hoist: code before the import does not run first");
  assert.equal(firstModuleRequest("const x = 1;"), undefined);

  const tree = join(scratch, "tree");
  const runnerSource = (gates, suites) => `const GATES = [\n${gates.map(([n, s]) => `  [${JSON.stringify(n)}, ${JSON.stringify(s)}],`).join("\n")}\n];\nconst SUITES = [\n${suites.map((s) => `  ${JSON.stringify(s)},`).join("\n")}\n];\n`;
  const required = [...REQUIRED_REGISTRATIONS.suites];
  const writeTree = ({ gates = REQUIRED_REGISTRATIONS.gates, suites = [...required, "tests/plain.mjs"], scripts = {} } = {}) => {
    rmSync(tree, { recursive: true, force: true });
    put(join(tree, "scripts", "run-tests.mjs"), runnerSource(gates, suites));
    put(join(tree, "package.json"), JSON.stringify({ scripts }));
    for (const suite of [...required, "tests/plain.mjs", "tests/network.mjs"]) put(join(tree, suite), `import "${PREAMBLE}";\nimport x from "../dist/x.js";\n`);
  };
  writeTree();
  assert.deepEqual(checkSuitePreambles(tree, new Map()).violations, [], "a tree whose suites all start from the preamble is clean");
  put(join(tree, "tests", "plain.mjs"), `import x from "../dist/x.js";\nimport "${PREAMBLE}";\n`);
  assert.match(checkSuitePreambles(tree, new Map()).violations.join("\n"), /tests\/plain\.mjs {2}first import is "\.\.\/dist\/x\.js"/);
  assert.deepEqual(checkSuitePreambles(tree, new Map([["tests/plain.mjs", "why"]])).violations, [], "a listed exception may skip the preamble");
  writeTree();
  assert.match(checkSuitePreambles(tree, new Map([["tests/plain.mjs", "why"]])).violations.join("\n"), /stale preamble exception: it imports the preamble/);
  assert.match(checkSuitePreambles(tree, new Map([["tests/gone.mjs", "why"]])).violations.join("\n"), /tests\/gone\.mjs {2}stale preamble exception: not a registered suite/);
  writeTree({ scripts: { "test:network": "node tests/network.mjs" } });
  put(join(tree, "tests", "network.mjs"), 'import x from "../dist/x.js";\n');
  assert.match(checkSuitePreambles(tree, new Map()).violations.join("\n"), /tests\/network\.mjs {2}first import/, "a suite run only from package.json counts as registered");
  writeTree({ gates: [["check:lock", "scripts/check-package-lock-parity.mjs"]] });
  assert.match(checkSuitePreambles(tree, new Map()).violations.join("\n"), /gate check:hermetic-test-env .* is not registered in GATES/);
  for (const suite of required) {
    writeTree({ suites: required.filter((name) => name !== suite) });
    assert.match(checkSuitePreambles(tree, new Map()).violations.join("\n"), new RegExp(`${suite.replaceAll(".", "\\.")} is not registered in SUITES`));
  }
  // The real home only through operatorHome(): a direct os.userInfo() is a finding.
  assert.deepEqual(userInfoSites('import { userInfo } from "node:os";\nconst h = userInfo().homedir;'), [1]);
  assert.deepEqual(userInfoSites('import os from "os";\nconst h = os.userInfo().homedir;'), [2]);
  assert.deepEqual(userInfoSites('import { userInfo as who } from "node:os";'), [1]);
  assert.deepEqual(userInfoSites('const { userInfo } = require("node:os");'), [1]);
  assert.deepEqual(userInfoSites('import { operatorHome } from "./helpers/hermetic-suite.mjs";\nconst h = operatorHome();'), []);
  writeTree();
  put(join(tree, "tests", "plain.mjs"), `import "${PREAMBLE}";\nimport { userInfo } from "node:os";\n`);
  assert.match(checkSuitePreambles(tree, new Map()).violations.join("\n"), /tests\/plain\.mjs:2 {2}os\.userInfo\(\) reads the operator's real home/);
  writeTree({ suites: [...required, "tests/missing.mjs"] });
  assert.match(checkSuitePreambles(tree, new Map()).violations.join("\n"), /tests\/missing\.mjs {2}registered but missing/);
  checkpoint("checkSuitePreambles: first import, exceptions both ways, package.json suites, guard registration, no direct os.userInfo()");

  const real = checkSuitePreambles(root);
  assert.deepEqual(real.violations, [], `the real tree must be clean:\n${real.violations.join("\n")}`);
  const registry = readRunnerRegistry(root);
  assert.ok(registry.gates.some(([name, script]) => name === "check:hermetic-test-env" && script === "scripts/check-hermetic-test-env.mjs"), "check:hermetic-test-env stays registered");
  for (const suite of required) assert.ok(registry.suites.includes(suite), `${suite} stays registered`);
  assert.equal(PREAMBLE_EXCEPTIONS.size, 0, "no registered suite runs with the operator env in-process");
  checkpoint(`the real tree: ${real.suites.length} registered suites start from the preamble; the guards stay registered`);

  // ---- the passthrough registry --------------------------------------------
  const suites = new Set(registeredSuites(root));
  const credentials = Object.keys(SUITE_PASSTHROUGH).filter((name) => CREDENTIAL.test(name)).sort();
  assert.deepEqual(credentials, ["GITHUB_TOKEN", "PGPASSWORD"], "the only credentials a suite may keep are the installer contracts' GITHUB_TOKEN and the disposable test database's PGPASSWORD");
  assert.deepEqual([...SUITE_PASSTHROUGH.GITHUB_TOKEN.suites].sort(), ["tests/bmad-installer-contract-regressions.mjs", "tests/pjan-180-surface-oracle.mjs"], "GITHUB_TOKEN goes to the network-backed installer contracts only");
  for (const [name, { reason, suites: granted }] of Object.entries(SUITE_PASSTHROUGH)) {
    assert.ok(reason && reason.length > 20, `${name} needs a reason`);
    assert.ok(granted.length > 0, `${name} is granted to nobody`);
    for (const suite of granted) assert.ok(suites.has(suite), `${name} is granted to ${suite}, which is not a registered suite`);
    assert.equal(Object.hasOwn(PASSTHROUGH, name), false, `${name} is in both PASSTHROUGH and SUITE_PASSTHROUGH`);
  }
  for (const name of Object.keys(PASSTHROUGH)) assert.equal(CREDENTIAL.test(name), false, `PASSTHROUGH must carry no credential (${name})`);
  for (const name of ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
    assert.equal(Object.hasOwn(PASSTHROUGH, name), false, `${name} is not in the hermetic allowlist (the PJAN-196 TLS/proxy decision)`);
  }
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
    assert.equal(Object.hasOwn(SUITE_PASSTHROUGH, name), false, `${name} is granted to no suite (a proxy URL can carry credentials)`);
  }
  for (const suite of OPERATOR_HOME_READERS.keys()) assert.ok(suites.has(suite), `OPERATOR_HOME_READERS lists ${suite}, which is not a registered suite`);
  checkpoint("SUITE_PASSTHROUGH: every grant has a reason and a registered suite; GITHUB_TOKEN and PGPASSWORD are the only credentials; no proxy anywhere");

  console.log(`PJAN-196 suite env canary: ${checks} groups passed.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
