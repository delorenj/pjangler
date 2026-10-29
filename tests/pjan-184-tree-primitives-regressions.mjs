import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { buildHermeticSuite } from "./helpers/hermetic-bundle.mjs";

// Hermetic wrapper (the pjan-178 pattern): bundle the .ts suite against src/
// and run it in a clean environment. No network.
const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pjan-184-tree-primitives-build-"));
try {
  const output = join(scratch, "tree-primitives.mjs");
  await buildHermeticSuite({ root, entry: join(root, "tests", "pjan-184-tree-primitives-regressions.ts"), output });
  const result = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", timeout: 120_000,
    env: hermeticEnv({ NO_COLOR: "1", GIT_CEILING_DIRECTORIES: "/tmp" }), maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
} finally { rmSync(scratch, { recursive: true, force: true }); }
