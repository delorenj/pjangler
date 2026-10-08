import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pjan-167-enrollment-build-"));
try {
  const output = join(scratch, "enrollment.mjs");
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
  await build({ entryPoints: [join(root, "tests", "pjan-167-enrollment.ts")],
    bundle: true, packages: "external", platform: "node", format: "esm", outfile: output,
    define: { "import.meta.dirname": JSON.stringify(join(root, "tests")) },
    external: [join(root, "tests", "helpers", "pack-fixture.mjs")],
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NO_COLOR: "1" }, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
} finally { rmSync(scratch, { recursive: true, force: true }); }
