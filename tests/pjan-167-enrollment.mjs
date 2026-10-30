import "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { buildHermeticSuite } from "./helpers/hermetic-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pjan-167-enrollment-build-"));
try {
  const output = join(scratch, "enrollment.mjs");
  await buildHermeticSuite({ root, entry: join(root, "tests", "pjan-167-enrollment.ts"), output, external: [join(root, "tests", "helpers", "pack-fixture.mjs")] });
  const result = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", timeout: 120_000,
    env: hermeticEnv({ NO_COLOR: "1" }), maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
} finally { rmSync(scratch, { recursive: true, force: true }); }
