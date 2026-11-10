import "./helpers/hermetic-suite.mjs";
// PJAN-198 (finding 2, acceptance 2): PJAN75_CLI_SRC must actually SELECT an
// alternate source — the grant alone proves only that the value reaches the
// process (the canary covers that). The documented negative-control procedure
// is:
//
//   git archive main src | tar -x -C /tmp/pre-fix
//   PJAN75_CLI_SRC=/tmp/pre-fix/src/index.ts node tests/pjan-75-regressions.mjs
//
// This suite proves the procedure end to end with a planted alternate entry
// instead of a historical checkout:
//
//   - positive: with PJAN75_CLI_SRC set to a planted entry that prints a
//     marker and exits 42, the pjan-75 child runs THAT bundle — the marker
//     appears and the suite never reaches its own assertions;
//   - negative control: without the knob the same child bundles the real
//     src/index.ts and passes, with no marker;
//   - scoping: the grant stays pjan-75-only, so no unrelated suite can
//     acquire the knob.
//
// The children are spawned with hermeticEnv plus the knob as an explicit
// fixture: the preamble grant exists for the operator-shell procedure above;
// a test-spawned child receives its env from its parent, as always.
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv, hermeticScratch, suiteGrants } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = hermeticScratch("pjan-198-cli-src-");
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const MARKER = "PJAN198_ALT_ENTRY_SELECTED";
const planted = join(scratch, "alt-index.ts");
writeFileSync(
  planted,
  `// Planted by tests/pjan-198-pjan75-cli-src.mjs: a syntactically valid
// alternate entry that fails at once, so selection is proven by the child's
// behaviour, not by diffing bundles.
console.log(${JSON.stringify(MARKER)});
console.error("planted alternate src: exiting before any assertion");
process.exit(42);
`,
);

function runPjan75(extraEnv, timeout) {
  return spawnSync(process.execPath, [join(root, "tests", "pjan-75-regressions.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout,
    env: hermeticEnv(extraEnv),
  });
}

// Positive: the alternate source is the one bundled and driven. pjan-75 runs
// its checks against the bundled CLI and reports each as failed, so the
// marker — not an exit code — is the selection proof.
{
  const run = runPjan75({ PJAN75_CLI_SRC: planted }, 300_000);
  assert.notEqual(run.status, 0, `the suite must fail against the planted source\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.ok(
    run.stdout.includes(MARKER) || run.stderr.includes(MARKER),
    `the bundled CLI must be the planted entry\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );
  assert.match(run.stderr, /check\(s\) failed/, "the suite must report its checks failing against the alternate source");
  console.log("PASS PJAN75_CLI_SRC selects the planted alternate source (marker seen, checks reported failing)");
}

// Negative control: without the knob the child bundles the real src/index.ts
// and the suite passes; no marker can appear.
{
  const run = runPjan75({}, 300_000);
  assert.equal(run.status, 0, `the default run must pass\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.ok(run.stdout.includes("pjan-75 regressions passed"), "the default run must reach the suite's own verdict");
  assert.ok(!run.stdout.includes(MARKER) && !run.stderr.includes(MARKER), "the planted entry must not leak into a default run");
  console.log("PASS negative control: without the knob the real src/index.ts is bundled and the suite passes");
}

// Scoping: the grant names exactly one suite, so no other suite's preamble
// keeps the knob.
{
  assert.deepEqual(
    suiteGrants("tests/pjan-75-regressions.mjs").filter((name) => name === "PJAN75_CLI_SRC"),
    ["PJAN75_CLI_SRC"],
    "pjan-75 keeps the knob",
  );
  for (const suite of ["tests/pjan-23-regressions.mjs", "tests/pjan-196-suite-env-canary.mjs", "tests/pjan-198-operator-home-guard.mjs"]) {
    assert.ok(!suiteGrants(suite).includes("PJAN75_CLI_SRC"), `${suite} must not acquire the PJAN75_CLI_SRC grant`);
  }
  console.log("PASS the PJAN75_CLI_SRC grant stays suite-specific");
}

console.log("PJAN-198 PJAN75_CLI_SRC selection: 3 groups passed.");
