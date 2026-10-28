import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildHermeticSuite } from "./helpers/hermetic-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pjan-177-g33-enrollment-build-"));
try {
  const output = join(scratch, "enrollment.mjs");
  await buildHermeticSuite({ root, entry: join(root, "tests", "pjan-177-g33-enrollment.ts"), output, external: [join(root, "tests", "helpers", "pack-fixture.mjs")] });
  const result = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NO_COLOR: "1", GIT_CEILING_DIRECTORIES: "/tmp" }, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
} finally { rmSync(scratch, { recursive: true, force: true }); }
