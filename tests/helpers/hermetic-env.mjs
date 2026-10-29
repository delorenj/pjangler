import { existsSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * PJAN-188: where a regression suite puts its scratch, and the env its children
 * run in, must not depend on the operator's shell.
 *
 * The concrete failure this guards: a suite placed its fixture (including the
 * isolated home, and with it XDG_STATE_HOME — the Skillex activation-receipt
 * directory) under `os.tmpdir()`. On this machine TMPDIR points inside the
 * ~/.claude git work tree, and the Skillex core refuses to touch a receipt
 * whose path has a `.git` ancestor (`E_RECEIPT_UNSAFE_PATH`), so
 * `tests/pjan-167-g33-companion.mjs` failed standalone while passing under
 * scripts/run-tests.mjs, whose HERMETIC_ENV happened to pin TMPDIR=/tmp. A
 * suite that only passes under the runner certifies nothing.
 *
 * Every suite that spawns pjangler now builds its scratch with
 * `hermeticScratch()` and its child env with `hermeticChildEnv()`, so
 * standalone and runner execution are equivalent by construction; the
 * runner's HERMETIC_ENV overlay is derived from the same function and kept
 * only as a backstop for a suite that forgets. tests/pjan-188-hermetic-canary
 * -regressions.mjs proves the isolation under a deliberately hostile env.
 */

/**
 * True when no ancestor of `candidate` (itself included) carries a `.git`
 * entry. Skillex's receipt check is a plain existence probe, so ANY `.git`
 * entry — a directory, a file, even an empty dir — disqualifies the base.
 */
function gitFree(candidate) {
  for (let current = resolve(candidate);; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return false;
    if (dirname(current) === current) return true;
  }
}

/**
 * A temporary base whose ancestor chain provably contains no `.git`, or a loud
 * error explaining the refusal. `/tmp` is preferred (the standard,
 * world-writable location); the configured TMPDIR is the fallback for a host
 * whose /tmp is poisoned (an incident this fleet has actually had). A base
 * that fails both probes cannot host a hermetic suite: every Skillex receipt
 * under it would refuse, so refusing loudly here beats a wall of red suites.
 */
export function pickHermeticTmpBase() {
  const candidates = ["/tmp", tmpdir()].map((path) => resolve(path)).filter((path, index, all) => all.indexOf(path) === index);
  for (const candidate of candidates) if (gitFree(candidate)) return candidate;
  throw new Error(
    `No git-free temporary directory exists (checked ${candidates.join(", ")}). `
      + "Every candidate has a .git ancestor, so Skillex activation receipts under it refuse with E_RECEIPT_UNSAFE_PATH. "
      + "Point TMPDIR at a directory outside any git work tree and rerun.",
  );
}

/** The hermetic base for this host, probed once at import. */
export const HERMETIC_TMP_BASE = pickHermeticTmpBase();

/** A suite's scratch directory: unique, and never inside a git work tree. */
export function hermeticScratch(prefix) {
  return mkdtempSync(join(HERMETIC_TMP_BASE, prefix.endsWith("-") ? prefix : `${prefix}-`));
}

/**
 * The env overlay every suite applies between the inherited operator env and
 * its own fixture values. Same keys, same values, one source of truth: the
 * runner imports this instead of keeping a second copy.
 *
 * - TMPDIR: children creating their own temps stay outside work trees.
 * - PLANE_ and TRELLO- keys: a suite must never carry production credentials;
 *   a plain `pj init` is live ingress without them.
 * - HERMES_FLEET_ENV: points at a file that never exists.
 * - PJ_G33_ADAPTER_MODULE and PJ_G33_ADAPTER_EXPORT: the operator's real
 *   adapter must not leak into a fixture whose g33 configuration is the thing
 *   under test.
 */
export function hermeticChildEnv(scratch) {
  return {
    TMPDIR: HERMETIC_TMP_BASE,
    PYTHONDONTWRITEBYTECODE: "1",
    PLANE_API_KEY: "",
    PLANE_DEFAULT_API_KEY: "",
    PLANE_33GOD_API_KEY: "",
    PLANE_AUTOMATICAI_API_KEY: "",
    PLANE_INTELLIFORIA_API_KEY: "",
    PLANE_LASERTOAST_API_KEY: "",
    TRELLO_KEY: "",
    TRELLO_API_KEY: "",
    TRELLO_TOKEN: "",
    HERMES_FLEET_ENV: join(scratch, "no-such-fleet.env"),
    PJ_G33_ADAPTER_MODULE: "",
    PJ_G33_ADAPTER_EXPORT: "",
  };
}
