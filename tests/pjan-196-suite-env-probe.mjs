import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { HERMETIC_TMP_BASE, PASSTHROUGH, SUITE_PASSTHROUGH } from "./helpers/hermetic-env.mjs";

// PJAN-196 probe: what pjangler code running IN THIS SUITE PROCESS sees.
//
// A suite process starts from tests/helpers/hermetic-suite.mjs, which rebuilds
// its env through the child allowlist and points HOME at a scratch home. This
// probe loads real src/ functions in-process (bundled from source, never
// dist/) that read credentials from the env and default paths to the home:
//
//   resolvePlaneApiKey     PLANE_API_KEY, PLANE_<WS>_API_KEY, then ~/.hermes/fleet.env
//   hermesAgentsRegistryPath  HERMES_AGENTS_REGISTRY, then ~/.hermes/agents-registry.yaml
//   notebookStateRoot      XDG_STATE_HOME, then $HOME/.local/state
//
// and asserts they see none of the operator's env and resolve the isolated
// home. It holds in whatever env it is started from: the operator's shell,
// scripts/run-tests.mjs, or the hostile env tests/pjan-196-suite-env-canary.mjs
// plants (novel secret-shaped names, junk tokens, a decoy HOME with a populated
// fleet.env). The canary also runs a copy of this file with the preamble line
// removed and requires it to FAIL, so a probe that cannot see a leak is caught.
//
// The last line of output is `PJAN-196 probe: <json>`, what the probe saw, for
// the canary to check against what it planted.

const root = resolve(import.meta.dirname, "..");
const shield = globalThis[Symbol.for("pjangler.hermeticSuite")];
const bundle = join(root, "node_modules", ".cache", `pjan-196-probe-${process.pid}.mjs`);
process.on("exit", () => rmSync(bundle, { force: true }));
buildSync({
  stdin: {
    contents: [
      'export { resolvePlaneApiKey } from "./src/project/boardQuery";',
      'export { hermesAgentsRegistryPath } from "./src/project/identity";',
      'export { notebookStateRoot } from "./src/notebook/state";',
    ].join("\n"),
    resolveDir: root,
  },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});
const { resolvePlaneApiKey, hermesAgentsRegistryPath, notebookStateRoot } = await import(pathToFileURL(bundle).href);

// What the in-process code saw. Values are never printed, only whether they exist.
const seen = {
  shielded: Boolean(shield),
  // hermetic-env: inherits -- reports the NAMES in-process code sees (never values); builds no child env
  keys: Object.keys(process.env).sort(),
  home: homedir(),
  tmpdir: tmpdir(),
  planeKey33god: resolvePlaneApiKey("33god") !== undefined,
  planeKeyDefault: resolvePlaneApiKey(undefined) !== undefined,
  agentsRegistry: hermesAgentsRegistryPath(),
  notebookState: notebookStateRoot(),
};

let checks = 0;
const checkpoint = (label) => { checks++; console.log(`PASS ${label}`); };
try {
  assert.ok(shield, "the suite preamble did not run: in-process code sees the operator env");
  const grants = new Set(Object.keys(SUITE_PASSTHROUGH).filter((name) => SUITE_PASSTHROUGH[name].suites.includes(shield.suite)));
  const allowed = new Set([...Object.keys(PASSTHROUGH), ...grants, "HOME", "TMPDIR", "PYTHONDONTWRITEBYTECODE"]);
  const outside = seen.keys.filter((name) => !allowed.has(name) && !/^LC_[A-Z]+$/.test(name));
  assert.deepEqual(outside, [], `operator variables reached in-process code: ${outside.join(", ")}`);
  checkpoint(`in-process env holds only the allowlist (${seen.keys.length} names, none outside it)`);

  assert.equal(seen.planeKey33god, false, "resolvePlaneApiKey('33god') found a Plane key (env or ~/.hermes/fleet.env)");
  assert.equal(seen.planeKeyDefault, false, "resolvePlaneApiKey() found a Plane key (env or ~/.hermes/fleet.env)");
  checkpoint("src resolvePlaneApiKey finds no credential in the env or the home's fleet.env");

  const realHome = userInfo().homedir;
  assert.equal(seen.home, shield.home, "os.homedir() is not the suite's isolated home");
  assert.ok(seen.home.startsWith(join(HERMETIC_TMP_BASE, "pj-suite-home-")), `home ${seen.home} is not under the hermetic base`);
  assert.notEqual(seen.home, realHome, "os.homedir() is the operator's real home");
  assert.equal(seen.agentsRegistry, join(shield.home, ".hermes", "agents-registry.yaml"), "src hermesAgentsRegistryPath() left the isolated home");
  assert.equal(seen.notebookState.startsWith(join(shield.home, ".local", "state") + "/"), true, `src notebookStateRoot() is ${seen.notebookState}, outside the isolated home`);
  assert.equal(seen.tmpdir, HERMETIC_TMP_BASE, "os.tmpdir() is not the git-free hermetic base");
  checkpoint("src homedir()/XDG defaults resolve inside the isolated suite home, never the operator's");
} finally {
  console.log(`PJAN-196 probe: ${JSON.stringify(seen)}`);
}
console.log(`PJAN-196 suite env probe: ${checks} groups passed.`);
