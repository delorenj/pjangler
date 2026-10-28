import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildHermeticSuite } from "./helpers/hermetic-bundle.mjs";

// Hermetic wrapper (the pjan-178 pattern): bundle the .ts suite against src/
// and run it in a clean environment. No network.
const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pjan-180-scoped-rollback-build-"));
try {
  const output = join(scratch, "scoped-rollback.mjs");
  await buildHermeticSuite({ root, entry: join(root, "tests", "pjan-180-scoped-rollback.ts"), output, });
  const result = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", timeout: 300_000,
    env: { PATH: process.env.PATH, TMPDIR: "/tmp", NO_COLOR: "1", GIT_CEILING_DIRECTORIES: "/tmp" }, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
} finally { rmSync(scratch, { recursive: true, force: true }); }
