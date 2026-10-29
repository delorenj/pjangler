import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * PJAN-188 / PJAN-193: where a regression suite puts its scratch, and the env
 * its children run in, must not depend on the operator's shell.
 *
 * PJAN-188 (scratch): a suite placed its fixture (including the isolated home,
 * and with it XDG_STATE_HOME, the Skillex activation-receipt directory) under
 * `os.tmpdir()`. On this machine TMPDIR points inside the ~/.claude git work
 * tree, and the Skillex core refuses to touch a receipt whose path has a `.git`
 * ancestor (`E_RECEIPT_UNSAFE_PATH`), so `tests/pjan-167-g33-companion.mjs`
 * failed standalone while passing under scripts/run-tests.mjs. `hermeticScratch`
 * is the fix: a scratch base with no `.git` anywhere above it.
 *
 * PJAN-193 (child env): PJAN-188 isolated children with an OVERLAY,
 * `{ ...process.env, ...pins }`, that pinned TMPDIR and blanked a fixed list
 * of PLANE_/TRELLO_/PJ_G33_ keys. That is a denylist: every other variable on
 * the operator's machine (GITHUB_TOKEN, OP_SERVICE_ACCOUNT_TOKEN,
 * OPENROUTER_API_KEY, MISE_* and SKILLEX_* overrides, PJ_*, HOME, XDG_*, ...)
 * still reached every child, and every NEW one did too, silently.
 * `hermeticEnv` replaces it with an allowlist: a COMPLETE child env made of
 * the passthrough names below, the pins, and the suite's own fixture values,
 * inheriting nothing else. scripts/check-hermetic-test-env.mjs fails any test
 * file that builds a child env from process.env some other way, and
 * tests/pjan-193-env-allowlist-regressions.mjs proves from inside a real pj
 * child that novel secret-shaped variables never arrive.
 *
 * No overlay helper is kept. Everything that used one has migrated, and an
 * overlay is exactly the shape that lets an unlisted variable through.
 */

/**
 * True when no ancestor of `candidate` (itself included) carries a `.git`
 * entry. Skillex's receipt check is a plain existence probe, so ANY `.git`
 * entry (a directory, a file, even an empty dir) disqualifies the base.
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
 * The names a child may inherit from the operator env, each with the reason
 * it has to. Absent names stay absent; nothing is invented. Every other
 * variable is dropped, including every credential and every tool override.
 */
export const PASSTHROUGH = Object.freeze({
  // node, git, python3, uv, copier, mise, redis-server/redis-cli, sh and the
  // fixtures' own shims must resolve. Suites that need a narrower PATH (the
  // crank and Plane-adapter suites) set PATH as a fixture value.
  PATH: "tool resolution",
  // Locale: git, python and the shells decode and print UTF-8 by it, and the
  // suite process (which inherits it) compares against what children print.
  LANG: "locale",
  LANGUAGE: "locale",
  LC_ALL: "locale",
  // The suite computes expected timestamps in its own zone; a child in another
  // zone would format them differently.
  TZ: "time zone the suite itself runs in",
  // Identity, not a credential: libpq/node-postgres default the database user
  // to USER, and git/python fall back to it for the account name.
  USER: "account name",
  LOGNAME: "account name",
  // c8 collects child-process coverage through this directory. Node also
  // re-injects it into a child whose env omits it (PJAN-184), but passing it
  // states the dependency instead of relying on that.
  NODE_V8_COVERAGE: "c8 child-process coverage",
});

/** Locale categories, LC_CTYPE through LC_IDENTIFICATION: same reason as LANG. */
const PASSTHROUGH_PATTERN = /^LC_[A-Z]+$/;

/*
 * Deliberately NOT passed through:
 * - HOME and XDG_*: a suite supplies isolated ones. A child without HOME would
 *   fall back to the passwd entry (the operator's real home) in node, mise and
 *   uv, so hermeticEnv always sets HOME: the fixture's, or a private empty one.
 * - TERM: every PTY suite pins `xterm-256color` itself, so a run from a dumb
 *   terminal, a pane, or CI (no TERM) renders identically. Piped children get
 *   none, which is what a non-interactive run is.
 * - NODE_OPTIONS: `npm run test:coverage` sets --max-old-space-size for c8
 *   and the runner; children do not need it, and an operator NODE_OPTIONS
 *   (--require/--import) would inject code into every pj child. A suite that
 *   needs a preload sets it as a fixture value.
 * - DISPLAY, WAYLAND_DISPLAY, SSH_*, COLUMNS, LINES, SHELL: interactive-session
 *   state; children are headless and non-interactive.
 * - CI, GITHUB_*, RUNNER_*, npm_config_* / npm_package_* (npm run injects
 *   them), PG*, PJ_TICKET_PROVIDER_ADAPTERS: harness configuration. The suite
 *   process still sees them (the runner gives a suite the operator env, see
 *   scripts/run-tests.mjs) and a suite whose child needs one names it with
 *   `pass` or sets it as a fixture value.
 */

/** Never passable: the suite must supply isolated values, not the operator's. */
const NEVER_PASSED = (name) => name === "HOME" || name.startsWith("XDG_");

let privateHome;
/**
 * The HOME a child gets when its suite does not supply one: an empty
 * directory under the hermetic base, one per suite process, removed on exit.
 */
export function hermeticDefaultHome() {
  if (!privateHome) {
    privateHome = mkdtempSync(join(HERMETIC_TMP_BASE, "pj-hermetic-home-"));
    const created = privateHome;
    process.on("exit", () => rmSync(created, { recursive: true, force: true }));
  }
  return privateHome;
}

/**
 * A COMPLETE env for a child process: the PASSTHROUGH names (and LC_*) that
 * are set in the operator env, any extra names listed in `pass`, the pins, and
 * then `fixture`, which wins. A fixture value of `undefined` removes the key.
 *
 * Pins:
 * - TMPDIR: the git-free hermetic base, so a child's own temps never land in a
 *   work tree (PJAN-188).
 * - PYTHONDONTWRITEBYTECODE: Python helpers must not drop __pycache__ into
 *   fixtures or the repo.
 * - HOME: hermeticDefaultHome() unless the fixture sets one.
 *
 * No credential blanking is needed: nothing outside the allowlist is copied,
 * and with HOME isolated the file fallbacks (~/.hermes/fleet.env,
 * ~/.config/zshyzsh/secrets.zsh) resolve inside the fixture.
 *
 * @param {Record<string, string | undefined>} [fixture]
 * @param {{ pass?: string[] }} [options] `pass`: extra operator variables this
 *   child genuinely needs (for example PGHOST for the Postgres suites). HOME and
 *   XDG_* are refused.
 */
export function hermeticEnv(fixture = {}, { pass = [] } = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (Object.hasOwn(PASSTHROUGH, name) || PASSTHROUGH_PATTERN.test(name))) env[name] = value;
  }
  for (const name of pass) {
    if (NEVER_PASSED(name)) throw new Error(`hermeticEnv: ${name} is never passed through; set an isolated value in the fixture instead`);
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.TMPDIR = HERMETIC_TMP_BASE;
  env.PYTHONDONTWRITEBYTECODE = "1";
  if (!Object.hasOwn(fixture, "HOME")) env.HOME = hermeticDefaultHome();
  for (const [name, value] of Object.entries(fixture)) {
    if (value === undefined) delete env[name];
    else env[name] = String(value);
  }
  return env;
}

/** TEMPORARY during the PJAN-193 migration; removed once nothing imports it. */
export function hermeticChildEnv(scratch) {
  return {
    TMPDIR: HERMETIC_TMP_BASE, PYTHONDONTWRITEBYTECODE: "1",
    PLANE_API_KEY: "", PLANE_DEFAULT_API_KEY: "", PLANE_33GOD_API_KEY: "", PLANE_AUTOMATICAI_API_KEY: "",
    PLANE_INTELLIFORIA_API_KEY: "", PLANE_LASERTOAST_API_KEY: "", TRELLO_KEY: "", TRELLO_API_KEY: "", TRELLO_TOKEN: "",
    HERMES_FLEET_ENV: join(scratch, "no-such-fleet.env"), PJ_G33_ADAPTER_MODULE: "", PJ_G33_ADAPTER_EXPORT: "",
  };
}
