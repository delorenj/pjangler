import { BUNDLED_CHILD_GUARD, SUITE_GRANTS } from "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
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
  const result = spawnSync(process.execPath, [...BUNDLED_CHILD_GUARD.execArgv, output, ...process.argv.slice(2)], { cwd: root, encoding: "utf8", timeout: 30 * 60_000,
    env: hermeticEnv({
      ...BUNDLED_CHILD_GUARD.env, NO_COLOR: "1", GIT_CEILING_DIRECTORIES: "/tmp",
      // No npm_config_cache (PJAN-198): the oracle's npx caches under the
      // oracle's own scratch HOME, cold like a CI runner. `npm run` injects
      // npm_config_cache=~/.npm; the preamble deletes it (it is granted to no
      // suite), so the operator's real ~/.npm is not written however this runs.
      npm_config_update_notifier: "false", npm_config_fund: "false",
    }, { pass: SUITE_GRANTS }),
    maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  assert.equal(result.status, 0, `${result.stdout.slice(-4000)}\n${result.stderr.slice(-12000)}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
