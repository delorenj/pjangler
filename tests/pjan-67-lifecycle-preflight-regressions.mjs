import { BUNDLED_CHILD_GUARD } from "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(root, ".pjan-67-preflight-build-"));
const output = join(temporary, "regressions.mjs");

try {
  const build = spawnSync("npm", [
    "exec", "--", "esbuild",
    join(root, "tests", "pjan-67-lifecycle-preflight-regressions.ts"),
    "--bundle", "--packages=external", "--platform=node", "--format=esm",
    `--outfile=${output}`,
  ], { cwd: root, encoding: "utf8", env: hermeticEnv() });
  assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
  // PJAN-198: the bundled child carries the operator-home guard, judged as this
  // launcher, which OPERATOR_HOME_READERS lists for the live UV Copier
  // attestation (preflightTrustedCopier without homeDir, the production anchor).
  const run = spawnSync(process.execPath, [...BUNDLED_CHILD_GUARD.execArgv, output], {
    cwd: root,
    encoding: "utf8",
    env: hermeticEnv({ ...BUNDLED_CHILD_GUARD.env }),
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  process.stdout.write(run.stdout);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
