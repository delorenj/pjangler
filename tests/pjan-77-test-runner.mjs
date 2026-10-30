import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { SUITE_GRANTS } from "./helpers/hermetic-suite.mjs";

/**
 * A bundled TypeScript suite is a child like any other: hermeticEnv() plus the
 * operator variables its LAUNCHER suite is granted by name in the central
 * SUITE_PASSTHROUGH registry (tests/helpers/hermetic-env.mjs, PJAN-196). For
 * the Postgres-backed ones (pjan-80-*) that is PGHOST/PGPORT/PGUSER/PGPASSWORD/
 * PGDATABASE, PJ_TEST_ADMIN_DATABASE and PJANGLER_REQUIRE_DISPOSABLE_POSTGRES;
 * for the notebook suites it is nothing. The launcher's own process has
 * already been rebuilt by the hermetic-suite preamble, so a name that is not
 * granted is gone from it and cannot be forwarded by accident.
 *
 * CI is granted to nobody (PJAN-194). tests/pjan-77-notebook-hooks-capture.ts
 * used to widen its latency budgets on a shared runner (`process.env.CI ? 2.4 :
 * 1`, PJAN-132) and so needed it. Its budgets are now measured in CPU time and
 * by event order, which a busy machine cannot inflate, so the suite behaves
 * identically on a hosted runner and on a workstation and nothing bundled
 * reads CI. tests/pjan-193-env-allowlist-regressions.mjs fails if a bundled
 * suite reads it again without it being granted.
 *
 * `pass` overrides the forwarded names (pjan-193 uses it to prove forwarding).
 */
export function runTypescriptRegression(sourceName, { pass = SUITE_GRANTS } = {}) {
  const root = resolve(import.meta.dirname, "..");
  // Keep the ephemeral bundle under the package root. Dependencies are
  // intentionally externalized to mirror the shipped CLI, so Node must be
  // able to walk from the bundle to this package's node_modules directory.
  const temporary = mkdtempSync(join(root, ".pjan-77-test-build-"));
  const output = join(temporary, "regression.mjs");
  try {
    const build = spawnSync("npm", ["exec", "--", "esbuild", join(root, "tests", sourceName), "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=${output}`], {
      cwd: root,
      encoding: "utf8",
      env: hermeticEnv(),
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const run = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
      env: hermeticEnv({}, { pass }) });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    process.stdout.write(run.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
