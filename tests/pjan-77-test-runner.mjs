import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function runTypescriptRegression(sourceName) {
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
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const run = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    process.stdout.write(run.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
