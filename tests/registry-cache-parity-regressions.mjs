import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(root, ".registry-cache-parity-build-"));
const output = join(temporary, "regressions.mjs");

try {
  const build = spawnSync(
    "npm",
    [
      "exec",
      "--",
      "esbuild",
      join(root, "tests", "registry-cache-parity-regressions.ts"),
      "--bundle",
      "--packages=external",
      "--platform=node",
      "--format=esm",
      `--outfile=${output}`,
    ],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(build.status, 0, `${build.error ?? ""}\n${build.stdout ?? ""}${build.stderr ?? ""}`);
  const run = spawnSync(process.execPath, [output], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stdout ?? ""}${run.stderr ?? ""}`);
  process.stdout.write(run.stdout);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
