#!/usr/bin/env node
// The pjangler test runner.
//
// It exists because `npm test` used to be one `a && b && c && ...` chain of 55
// suites. A single red suite short-circuited the shell, so the 20 suites listed
// after it never ran at all -- and a run that stops at the first failure cannot
// tell you whether you broke one thing or twenty. Every suite here is attempted
// on every run; the exit code and the closing summary are decided afterwards
// from the collected results.
//
// Typecheck is the one exception and runs first as a hard gate. `npm run build`
// bundles with esbuild --packages=external, which never typechecks, so a file
// that cannot compile still produces a clean dist. Suites exercise that dist,
// so running them against un-typechecked source reports fiction.
//
// Usage:
//   node scripts/run-tests.mjs                 # everything
//   node scripts/run-tests.mjs pjan-67 pjan-86 # only suites matching a filter
//   node scripts/run-tests.mjs --list          # print the suite list and exit
//   node scripts/run-tests.mjs --no-typecheck  # skip the typecheck gate (debugging only)
//   node scripts/run-tests.mjs --no-build      # skip the rebuild (debugging only)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Wall-clock ceiling for one suite. A hang must not wedge the whole run. */
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Suites whose failure is reported loudly but does not fail the run.
 *
 * Keyed by suite name, valued by the reason plus what a real fix requires.
 * This is for a failure that is genuinely environmental -- something this host
 * cannot satisfy -- never for a suite that is merely inconvenient. A quarantined
 * suite still executes on every run and still prints its full output on failure.
 * Empty is the correct steady state; anything in here is a debt with an owner.
 */
const QUARANTINED = new Map([
  // ["some-suite", "why it cannot pass here + what a fix requires"],
]);

/** Repository gates. Cheap, and a failure here invalidates the suites below. */
const GATES = [
  ["check:lock", "scripts/check-package-lock-parity.mjs"],
  ["check:submodules", "scripts/check-submodule-contract.mjs"],
  ["check:tracked-secrets", "scripts/check-tracked-secrets.mjs"],
  // PJAN-193: no test file hands a child the operator env (see SUITE_ENV below).
  ["check:hermetic-test-env", "scripts/check-hermetic-test-env.mjs"],
];

/**
 * Every regression suite, in execution order.
 *
 * This list is the single source of truth. package.json's `test` script is a
 * one-line delegation to this file precisely so a new suite is added in one
 * place and can never be silently dropped from the chain.
 */
const SUITES = [
  "tests/pjan-80-cli-regressions.mjs",
  "tests/pjan-80-bootstrap-regressions.mjs",
  "tests/pjan-80-registry-consumers.mjs",
  "tests/pjan-80-consumer-concurrency.mjs",
  "tests/pjan-80-migration-regressions.mjs",
  "tests/pjan-80-registry-regressions.mjs",
  "tests/package-lock-parity-regressions.mjs",
  "tests/portable-test-paths-regressions.mjs",
  "tests/release-regressions.mjs",
  "tests/pjan-160-release-version-regressions.mjs",
  "tests/pjan-189-release-push-regressions.mjs",
  "tests/submodule-contract-regressions.mjs",
  "tests/secret-publication-gate-regressions.mjs",
  "tests/bmad-version-surface-regressions.mjs",
  "tests/bmad-authority-regressions.mjs",
  "tests/coverage-ratchet-regressions.mjs",
  "tests/coverage-path-audit-regressions.mjs",
  "tests/parity-migrate-regressions.mjs",
  "tests/pjan-127-skills-core-regressions.mjs",
  "tests/pjan-128-skills-wiring-regressions.mjs",
  "tests/pjan-135-skill-roots-regressions.mjs",
  "tests/pjan-135-skill-roots-safety-regressions.mjs",
  "tests/pjan-135-skill-roots-property.mjs",
  "tests/pjan-135-guidance-commands-regressions.mjs",
  "tests/pjan-135-mise-hooks-regressions.mjs",
  "tests/pjan-135-mise-rewrite-regressions.mjs",
  "tests/pjan-141-142-skills-parity-regressions.mjs",
  "tests/pjan-176-bmad-installer-skills-regressions.mjs",
  "tests/pjan-144-registry-field-regressions.mjs",
  "tests/pjan-145-waiver-regressions.mjs",
  "tests/pjan-147-env-materialization-opt-out-regressions.mjs",
  "tests/pjan-57-lifecycle-recipes-regressions.mjs",
  "tests/pjan-167-g33-companion.mjs",
  "tests/pjan-188-hermetic-canary-regressions.mjs",
  "tests/pjan-193-env-allowlist-regressions.mjs",
  "tests/pjan-167-enrollment.mjs",
  "tests/pjan-177-g33-enrollment.mjs",
  "tests/pjan-178-g33-scoped-contract.mjs",
  "tests/pjan-179-g33-preupdate-gap.mjs",
  "tests/pjan-180-scoped-rollback.mjs",
  "tests/pjan-181-reserved-manifest-modules.mjs",
  "tests/pjan-184-tree-primitives-regressions.mjs",
  "tests/pjan-57-dogfood-regressions.mjs",
  "tests/generated-project-lifecycle-regressions.mjs",
  "tests/pjan-23-regressions.mjs",
  "tests/pjan-24-regressions.mjs",
  "tests/pjan-30-regressions.mjs",
  "tests/pjan-31a-regressions.mjs",
  "tests/pjan-169-obsidian-plugin-regressions.mjs",
  "tests/pjan-36-regressions.mjs",
  "tests/pjan-43-regressions.mjs",
  "tests/pjan-49-regressions.mjs",
  "tests/pjan-50-regressions.mjs",
  "tests/pjan-65-regressions.mjs",
  "tests/pjan-67-lifecycle-preflight-regressions.mjs",
  "tests/pjan-67-regressions.mjs",
  "tests/pjan-67-trusted-lifecycle-regressions.mjs",
  "tests/pjan-71-regressions.mjs",
  "tests/pjan-72-regressions.mjs",
  "tests/pjan-75-regressions.mjs",
  "tests/pjan-76-regressions.mjs",
  "tests/pjan-87-board-read-regressions.mjs",
  "tests/board-schema-regressions.mjs",
  "tests/pjan-126-gitignore-policy-regressions.mjs",
  "tests/skillex-init-regressions.mjs",
  "tests/pjan-84-registry-flag-regressions.mjs",
  "tests/pjan-84-finding-scope-regressions.mjs",
  "tests/pjan-84-orphan-adoption-regressions.mjs",
  "tests/pjan-130-init-target-regressions.mjs",
  "tests/mcp-catalog-regressions.mjs",
  "tests/mcp-server-regressions.mjs",
  "tests/project-registry-regressions.mjs",
  "tests/init-board-ingress-regressions.mjs",
  "tests/project-identity-regressions.mjs",
  "tests/project-identity-implicit-regressions.mjs",
  "tests/pg-registry-regressions.mjs",
  "tests/momo-lifecycle-plane-regressions.mjs",
  // PJAN-77 notebook suites. `npm run test:pjan-77` still runs these on their
  // own; they are listed individually here so a failure names one file.
  "tests/pjan-77-notebook-domain-regressions.mjs",
  "tests/pjan-77-notebook-adapter-contract.mjs",
  "tests/pjan-77-notebook-lifecycle-regressions.mjs",
  "tests/pjan-77-notebook-cli-contract.mjs",
  "tests/pjan-77-notebook-hooks-capture.mjs",
  "tests/pjan-77-notebook-security-isolation.mjs",
  "tests/pjan-77-notebook-release-gates.mjs",
  "tests/pjan-144-journal-notebook-service.mjs",
  "tests/pjan-174-crank-regressions.mjs",
  "tests/pjan-182-crank-interval-regressions.mjs",
  "tests/pjan-184-crank-cli.mjs",
  "tests/pjan-184-crank-units.mjs",
  "tests/pjan-186-crank-error-replies.mjs",
  "tests/pjan-187-tui-load.mjs",
  "tests/pjan-191-pty-run-regressions.mjs",
];

const args = process.argv.slice(2);
const filters = args.filter((arg) => !arg.startsWith("-"));
const listOnly = args.includes("--list");
const skipTypecheck = args.includes("--no-typecheck");
const skipBuild = args.includes("--no-build");

/** A step is selected when it has no filters to satisfy or matches one. */
const selects = (name) => filters.length === 0 || filters.some((f) => name.includes(f));

const steps = [
  ...GATES.filter(([name]) => selects(name)).map(([name, script]) => ({ name, script, kind: "gate" })),
  ...SUITES.filter((script) => selects(script)).map((script) => ({
    name: script.replace(/^tests\//, "").replace(/\.mjs$/, ""),
    script,
    kind: "suite",
  })),
];

if (listOnly) {
  for (const step of steps) console.log(`${step.kind === "gate" ? "gate " : "suite"}  ${step.name}`);
  console.log(`\n${steps.length} step(s)`);
  process.exit(0);
}

const duration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

if (!skipTypecheck) {
  process.stdout.write("gate  typecheck ... ");
  const started = Date.now();
  const typecheck = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"], {
    cwd: root,
    encoding: "utf8",
  });
  if (typecheck.status !== 0) {
    console.log(`FAIL (${duration(Date.now() - started)})`);
    process.stdout.write(typecheck.stdout ?? "");
    process.stderr.write(typecheck.stderr ?? "");
    console.error(
      "\ntypecheck failed. It is a hard gate: esbuild bundles without typechecking, so\n" +
        "every suite below would run against a dist that does not match this source.\n" +
        "No suite was attempted.",
    );
    process.exit(1);
  }
  console.log(`ok (${duration(Date.now() - started)})`);
}

// Typecheck proves the SOURCE compiles. It does not put that source into dist/,
// and every suite below runs dist/. Without this, a stale bundle lets all 67
// suites pass while certifying code that is no longer in the tree -- the run
// reports fiction just as loudly as an un-typechecked one does, and says so
// just as confidently. CI already builds before invoking this runner
// (`npm run build && c8 ... run-tests.mjs`), so only local runs were exposed --
// which is exactly where a human forms the belief "tests pass" before pushing.
if (!skipBuild) {
  process.stdout.write("gate  build ... ");
  const started = Date.now();
  const build = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) {
    console.log(`FAIL (${duration(Date.now() - started)})`);
    process.stdout.write(build.stdout ?? "");
    process.stderr.write(build.stderr ?? "");
    console.error("\nbuild failed. Every suite below runs dist/, so none was attempted.");
    process.exit(1);
  }
  console.log(`ok (${duration(Date.now() - started)})`);
}

/**
 * What a suite process gets: the operator env, unchanged (PJAN-193).
 *
 * Isolation lives one level down. Every child a suite starts (pj, git, mise,
 * copier, python, redis, the PTY driver, the bundled TypeScript suites) gets a
 * COMPLETE env from `hermeticEnv()` in tests/helpers/hermetic-env.mjs: an
 * explicit passthrough allowlist plus the suite's fixture values, inheriting
 * nothing else, so no operator credential or config override can reach one.
 * The `check:hermetic-test-env` gate above fails a test file that builds a
 * child env any other way, and tests/pjan-193-env-allowlist-regressions.mjs
 * proves from inside a real pj child that novel secret-shaped variables never
 * arrive.
 *
 * This runner used to overlay pins on the suite env (TMPDIR=/tmp, blanked
 * PLANE_/TRELLO_/PJ_G33_ keys, a missing HERMES_FLEET_ENV). That was the
 * PJAN-188 backstop for a suite that forgot to isolate its children, and it is
 * gone on purpose:
 *
 * - It no longer protected anything. Children never see the suite env, and a
 *   suite that forgets is now a red gate, not a silently masked run.
 * - It was the masking. A pin that holds only under the runner is how
 *   pjan-167-g33-companion passed here while failing standalone (PJAN-188).
 *   With no overlay, `node tests/<suite>.mjs` from the operator shell and this
 *   runner start the suite in the same env, so they are equivalent by
 *   construction rather than by a backstop.
 * - The suite process itself legitimately needs harness configuration that an
 *   allowlist here would have to duplicate: PGHOST/PGPORT/PGUSER and
 *   PJANGLER_REQUIRE_DISPOSABLE_POSTGRES (publish.yml's Postgres service),
 *   PJ_TICKET_PROVIDER_ADAPTERS (the Krebs adapters CI fetches),
 *   NODE_V8_COVERAGE (c8). Suites pass what a child needs by name.
 */
const SUITE_ENV = process.env;

const results = [];
for (const [index, step] of steps.entries()) {
  const label = `[${String(index + 1).padStart(2)}/${steps.length}] ${step.name}`;
  process.stdout.write(`${label} ... `);
  const started = Date.now();
  const run = spawnSync(process.execPath, [step.script], {
    cwd: root,
    encoding: "utf8",
    env: SUITE_ENV,
    timeout: SUITE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsed = Date.now() - started;
  const timedOut = run.error && run.error.code === "ETIMEDOUT";
  const ok = !run.error && run.status === 0;
  const quarantined = QUARANTINED.has(step.name);
  const status = ok ? "PASS" : timedOut ? "TIMEOUT" : "FAIL";
  console.log(`${status}${!ok && quarantined ? " (quarantined)" : ""} (${duration(elapsed)})`);
  if (!ok) {
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    if (run.error && !timedOut) console.error(String(run.error.message));
  }
  results.push({ ...step, status, ok, quarantined, elapsed });
}

const failed = results.filter((r) => !r.ok && !r.quarantined);
const quarantineFailures = results.filter((r) => !r.ok && r.quarantined);
const passed = results.filter((r) => r.ok);
const total = results.reduce((sum, r) => sum + r.elapsed, 0);

console.log(`\n${"=".repeat(72)}`);
console.log(
  `SUMMARY  attempted ${results.length}  passed ${passed.length}  failed ${failed.length}` +
    `  quarantined-failing ${quarantineFailures.length}  (${duration(total)})`,
);
console.log("=".repeat(72));

for (const result of quarantineFailures) {
  console.log(`QUARANTINED FAIL  ${result.name}`);
  console.log(`                  ${QUARANTINED.get(result.name)}`);
}
for (const result of failed) console.log(`${result.status.padEnd(8)}  ${result.name}`);

if (failed.length === 0) {
  console.log(
    quarantineFailures.length === 0
      ? "All suites passed."
      : "All non-quarantined suites passed. The quarantined failures above are still real debt.",
  );
}
process.exit(failed.length === 0 ? 0 : 1);
