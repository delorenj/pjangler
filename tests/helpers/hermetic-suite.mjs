// PJAN-196: the suite-process preamble. Every registered suite imports this
// module FIRST:
//
//   import "./helpers/hermetic-suite.mjs";
//
// ESM evaluates a module's imports depth-first in source order, so this runs
// before any pjangler code (src bundles, dist/, the notebook module, the crank
// controller, ...) is loaded, and before the suite body.
//
// What it does: it rebuilds THIS process's env through the same allowlist a
// child gets (tests/helpers/hermetic-env.mjs), so in-process library calls see
// what a child sees:
//
// - process.env becomes `hermeticEnv({ HOME: <scratch home> }, { pass:
//   suiteGrants(<this suite>) })`: PASSTHROUGH (PATH, locale, TZ, USER,
//   LOGNAME, NODE_V8_COVERAGE), the pins (TMPDIR = the git-free hermetic base,
//   PYTHONDONTWRITEBYTECODE) and the names SUITE_PASSTHROUGH grants this suite
//   by name (the Postgres settings, the Krebs adapter path, the installer
//   contracts' GITHUB_TOKEN, ...). Every other variable is DELETED from the
//   live env: every credential (PLANE_*, TRELLO_*, *_TOKEN, *_API_KEY, OP_*),
//   every tool override (MISE_*, SKILLEX_*, PJ_*, NODE_OPTIONS) and every
//   XDG_* the operator set.
// - HOME is a fresh empty directory under the hermetic base, removed at exit,
//   so os.homedir() (Node reads $HOME) resolves there and anything defaulting
//   to ~ (Recipe.ts, boardQuery's ~/.hermes/fleet.env, the notebook state,
//   ~/.agents, ~/.config) reads and writes scratch. XDG_* are unset, so XDG
//   lookups fall back under that home. It is a different directory from
//   hermeticDefaultHome(), so a child still starts from a pristine home.
//
// Why a preamble rather than the runner: it is the one mechanism that makes
// `node tests/<suite>.mjs` from an operator shell and scripts/run-tests.mjs
// identical by construction. A runner-side env would hold only under the
// runner, which is exactly the masking that hid PJAN-188. The runner therefore
// keeps handing a suite the env it was started with; the preamble does the
// rest in both cases. scripts/check-hermetic-test-env.mjs fails a registered
// suite whose first import is not this module, and
// tests/pjan-196-suite-env-canary.mjs proves the result dynamically, standalone
// and under the runner, against planted credentials and a decoy HOME.
//
// What it cannot do: an operator NODE_OPTIONS (--require/--import) is applied
// by node before any module runs. And c8's NODE_V8_COVERAGE is read by node at
// startup; it stays in the env (PASSTHROUGH) so children keep reporting.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { HERMETIC_TMP_BASE, OPERATOR_HOME_READERS, hermeticEnv, suiteGrants } from "./hermetic-env.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");

/** The entry script, repo-relative ("tests/x.mjs"); "" when there is none (node -e). */
function entrySuite() {
  const entry = process.argv[1];
  if (!entry) return "";
  let path = resolve(entry);
  try { path = realpathSync(path); } catch { /* keep the resolved path */ }
  return relative(repoRoot, path).split(sep).join("/");
}

/** This process's suite, repo-relative. */
export const SUITE = entrySuite();
/** The operator variables SUITE_PASSTHROUGH grants this suite (the names, not values). */
export const SUITE_GRANTS = Object.freeze(suiteGrants(SUITE));
/** The isolated HOME this suite process runs with. */
export const SUITE_HOME = mkdtempSync(join(HERMETIC_TMP_BASE, "pj-suite-home-"));
process.on("exit", () => rmSync(SUITE_HOME, { recursive: true, force: true }));

const next = hermeticEnv({ HOME: SUITE_HOME }, { pass: SUITE_GRANTS });
for (const name of Object.keys(process.env)) if (!Object.hasOwn(next, name)) delete process.env[name];
Object.assign(process.env, next);

/** Marks the process as shielded; tests/pjan-196-suite-env-canary.mjs and helpers can check it. */
globalThis[Symbol.for("pjangler.hermeticSuite")] = Object.freeze({ suite: SUITE, home: SUITE_HOME, grants: SUITE_GRANTS });

/**
 * The operator's REAL home, from the passwd entry (HOME no longer names it).
 * Only for a suite listed in OPERATOR_HOME_READERS (hermetic-env.mjs), with its
 * reason; everyone else gets an error naming that list.
 */
export function operatorHome() {
  if (!OPERATOR_HOME_READERS.has(SUITE)) {
    throw new Error(`${SUITE || "this process"} may not read the operator's real home: add it to OPERATOR_HOME_READERS in tests/helpers/hermetic-env.mjs with the reason`);
  }
  return userInfo().homedir;
}
