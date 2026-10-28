import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildHermeticSuite } from "./helpers/hermetic-bundle.mjs";

// PJAN-180 real-installer surface oracle: a network/cache-backed release gate
// (like test:bmad-installer-contract), NOT part of the hermetic npm test. It
// fails, never skips. `mise run bmad:verify-surface <version>` runs it for one
// version with --print-fingerprint to produce the VERIFIED_BMAD_INSTALLERS line.
const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pjan-180-surface-oracle-build-"));
try {
  const output = join(scratch, "surface-oracle.mjs");
  await buildHermeticSuite({ root, entry: join(root, "tests", "pjan-180-surface-oracle.ts"), output, });
  const result = spawnSync(process.execPath, [output, ...process.argv.slice(2)], { cwd: root, encoding: "utf8", timeout: 30 * 60_000,
    env: {
      PATH: process.env.PATH, TMPDIR: "/tmp", NO_COLOR: "1", GIT_CEILING_DIRECTORIES: "/tmp",
      // npx keeps the operator's package cache; everything else is scratch.
      npm_config_cache: process.env.npm_config_cache || join(homedir(), ".npm"),
      npm_config_update_notifier: "false", npm_config_fund: "false",
      ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
    },
    maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  assert.equal(result.status, 0, `${result.stdout.slice(-4000)}\n${result.stderr.slice(-12000)}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
