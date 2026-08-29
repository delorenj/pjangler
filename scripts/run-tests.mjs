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
//   node scripts/run-tests.mjs --no-typecheck  # skip the gate (debugging only)

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

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
];

/**
 * Every regression suite, in execution order.
 *
 * This list is the single source of truth. package.json's `test` script is a
 * one-line delegation to this file precisely so a new suite is added in one
 * place and can never be silently dropped from the chain.
 */
const SUITES = [
  "tests/package-lock-parity-regressions.mjs",
  "tests/portable-test-paths-regressions.mjs",
  "tests/release-regressions.mjs",
  "tests/submodule-contract-regressions.mjs",
  "tests/secret-publication-gate-regressions.mjs",
  "tests/bmad-version-surface-regressions.mjs",
  "tests/bmad-transaction-regressions.mjs",
  "tests/bmad-authority-regressions.mjs",
  "tests/parity-migrate-regressions.mjs",
  "tests/hermes-profile-inheritance-regressions.mjs",
  "tests/pjan-57-lifecycle-recipes-regressions.mjs",
  "tests/pjan-57-dogfood-regressions.mjs",
  "tests/generated-project-lifecycle-regressions.mjs",
  "tests/pack-flatten-regressions.mjs",
  "tests/pack-flatten-cross-engine-regressions.mjs",
  "tests/registry-cache-parity-regressions.mjs",
  "tests/registry-root-ladder-regressions.mjs",
  "tests/pjan-23-regressions.mjs",
  "tests/pjan-24-regressions.mjs",
  "tests/pjan-28-regressions.mjs",
  "tests/pjan-30-regressions.mjs",
  "tests/pjan-31a-regressions.mjs",
  "tests/pjan-36-regressions.mjs",
  "tests/pjan-43-regressions.mjs",
  "tests/pjan-48-regressions.mjs",
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
  "tests/pjan-86-hermes-deploy-regressions.mjs",
  "tests/pjan-87-board-read-regressions.mjs",
  "tests/skillex-init-regressions.mjs",
  "tests/pjan-84-global-scope-regressions.mjs",
  "tests/pjan-84-registry-flag-regressions.mjs",
  "tests/pjan-84-finding-scope-regressions.mjs",
  "tests/pjan-84-orphan-adoption-regressions.mjs",
  "tests/fleet-shared-bloodbank-regressions.mjs",
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
];

const args = process.argv.slice(2);
const filters = args.filter((arg) => !arg.startsWith("-"));
const listOnly = args.includes("--list");
const skipTypecheck = args.includes("--no-typecheck");

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

/**
 * A regression suite must never carry the operator's production credentials.
 *
 * Board provisioning stopped being gated on `--live` (a plain `pj init` is the
 * designated ingress and has to deliver a board), which made the suite's
 * inherited `PLANE_33GOD_API_KEY` live ammunition: one run created seven real
 * boards in the 33god workspace before anyone noticed. Blanking the credentials
 * here makes the whole suite hermetic by construction — the adapter is
 * unreachable, so `pj init` takes its no-credential path.
 *
 * Suites that WANT a provider (tests/pjan-30-regressions.mjs) inject their own
 * stub adapter and fake key, which override these.
 *
 * This is the second line of defence, not the first: the legacy
 * `~/.config/zshyzsh/secrets.zsh` fallback is a FILE, and redirecting
 * XDG_CONFIG_HOME here would change what the Hermes template suites read. The
 * first line is `--skip-board` on every fixture bootstrap, which states the
 * intent where the intent lives.
 */
const HERMETIC_ENV = {
  PLANE_API_KEY: "",
  PLANE_DEFAULT_API_KEY: "",
  PLANE_33GOD_API_KEY: "",
  PLANE_AUTOMATICAI_API_KEY: "",
  PLANE_INTELLIFORIA_API_KEY: "",
  PLANE_LASERTOAST_API_KEY: "",
  TRELLO_KEY: "",
  TRELLO_API_KEY: "",
  TRELLO_TOKEN: "",
  HERMES_FLEET_ENV: join(root, "scripts", "no-such-fleet.env"),
};

const results = [];
for (const [index, step] of steps.entries()) {
  const label = `[${String(index + 1).padStart(2)}/${steps.length}] ${step.name}`;
  process.stdout.write(`${label} ... `);
  const started = Date.now();
  const run = spawnSync(process.execPath, [step.script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...HERMETIC_ENV },
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
