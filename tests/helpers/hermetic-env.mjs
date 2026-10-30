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
 *
 * PJAN-196 (suite process): PJAN-193 isolated children only; the suite process
 * kept the operator's whole env, so pjangler code a suite called IN-PROCESS
 * read the operator's credentials and resolved os.homedir() to the real ~.
 * tests/helpers/hermetic-suite.mjs, every registered suite's first import,
 * rebuilds the suite's own env with hermeticEnv() and an isolated HOME, plus
 * the names SUITE_PASSTHROUGH below grants that suite. One allowlist, applied
 * at both boundaries.
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
 *   state; children are headless and non-interactive. (One caveat outside this
 *   helper's reach: the MCP SDK's StdioClientTransport merges HOME, LOGNAME,
 *   PATH, SHELL, TERM and USER from the operator env UNDER the env it is given.
 *   hermeticEnv's HOME/PATH/USER/LOGNAME win, so only SHELL and TERM, neither a
 *   credential, reach an MCP server child.)
 * - CI, GITHUB_*, RUNNER_*, npm_config_* / npm_package_* (npm run injects
 *   them), PG*, PJ_TICKET_PROVIDER_ADAPTERS: harness configuration. Since
 *   PJAN-196 the suite process does not see them either, unless the central
 *   SUITE_PASSTHROUGH registry below grants one to that suite by name; a suite
 *   forwards a granted name to its child with `pass` (or sets a fixture value).
 */

/*
 * PJAN-196 TLS / proxy decision. SSL_CERT_FILE, NODE_EXTRA_CA_CERTS and
 * HTTPS_PROXY / HTTP_PROXY / NO_PROXY (either case) are NOT in PASSTHROUGH:
 * - The hermetic suites never leave the machine. Their network peers are
 *   loopback fakes (the Plane/Trello adapter servers), throwaway redis and the
 *   disposable Postgres. A proxy variable would route curl/git/python traffic
 *   to those fakes through the operator's proxy (NO_PROXY decides, and an
 *   operator's NO_PROXY is not ours to trust), and a CA override changes which
 *   TLS peers a child accepts. Neither may differ between a workstation and CI.
 * - A proxy URL can carry credentials (`http://user:pass@proxy:3128`), and the
 *   rule since PJAN-193 is that no credential reaches a hermetic child.
 * - Only the network-backed release contracts (the real BMAD installer and the
 *   PJAN-180 surface oracle) talk to the internet. They get the two TLS trust
 *   anchors through SUITE_PASSTHROUGH below: public certificates, not secrets,
 *   and what a host behind a TLS-inspecting gateway needs to reach npm and
 *   GitHub at all. They do not get the proxy variables, for the credential
 *   reason above. Neither CI (ubuntu-latest) nor this fleet's hosts set any of
 *   the five today; a host that ever needs a proxy adds a SUITE_PASSTHROUGH
 *   entry scoped to those two contracts, with its reason.
 */

/**
 * PJAN-196: the ONE central registry of operator variables a SUITE PROCESS
 * keeps, beyond PASSTHROUGH, and which suites keep them.
 *
 * A suite process starts from tests/helpers/hermetic-suite.mjs (its first
 * import), which rebuilds process.env as `hermeticEnv({ HOME: <scratch> },
 * { pass: suiteGrants(<suite>) })`. Everything outside PASSTHROUGH, the pins
 * and these grants is deleted from the suite's own env before any pjangler
 * code is loaded, so in-process library calls and whatever they spawn see the
 * same allowlist a child does. A suite forwards a granted name to a child with
 * `hermeticEnv(fixture, { pass: SUITE_GRANTS })`; a name not granted here is
 * already gone from process.env and cannot be forwarded by anyone.
 *
 * Keyed by variable, valued by the reason and the suites (paths relative to
 * the repo root) that receive it. The only credentials in here are
 * GITHUB_TOKEN (the network-backed installer contracts, for the GitHub API
 * rate limit) and PGPASSWORD (the disposable test database); the PJAN-196
 * suite fails if any other credential-shaped name appears.
 */
const POSTGRES_SUITES = Object.freeze([
  "tests/pjan-80-cli-regressions.mjs",
  "tests/pjan-80-bootstrap-regressions.mjs",
  "tests/pjan-80-registry-consumers.mjs",
  "tests/pjan-80-consumer-concurrency.mjs",
  "tests/pjan-80-migration-regressions.mjs",
  "tests/pjan-80-registry-regressions.mjs",
  "tests/pg-registry-regressions.mjs",
  "tests/project-registry-regressions.mjs",
]);
const NETWORK_CONTRACTS = Object.freeze([
  "tests/bmad-installer-contract-regressions.mjs",
  "tests/pjan-180-surface-oracle.mjs",
]);
const grant = (reason, suites) => Object.freeze({ reason, suites: Object.freeze([...suites]) });
const POSTGRES = "Postgres connection settings: publish.yml's service container (PGHOST=localhost, PGUSER=postgres, trust auth) or the operator's local server. The Postgres-backed suites and the bundled suites they launch connect with them";
export const SUITE_PASSTHROUGH = Object.freeze({
  PGHOST: grant(POSTGRES, POSTGRES_SUITES),
  PGPORT: grant(POSTGRES, POSTGRES_SUITES),
  PGUSER: grant(POSTGRES, POSTGRES_SUITES),
  PGDATABASE: grant(POSTGRES, POSTGRES_SUITES),
  PGPASSWORD: grant(`${POSTGRES}. A credential, but only for a disposable test database the suites create and drop; CI uses trust auth and sets none`, POSTGRES_SUITES),
  PJ_TEST_ADMIN_DATABASE: grant("the database the Postgres suites connect to in order to CREATE/DROP their disposable databases", POSTGRES_SUITES),
  PJANGLER_REQUIRE_DISPOSABLE_POSTGRES: grant("publish.yml sets it so a missing postgres/psql/bun fails the job instead of skipping (pg-registry also sets it for its own strict-mode self-test child)", POSTGRES_SUITES),
  PJAN21_PG_HARNESS_SELF_TEST: grant("operator switch for pg-registry's harness self-test mode; the suite re-runs itself with it", ["tests/pg-registry-regressions.mjs"]),
  PJ_TICKET_PROVIDER_ADAPTERS: grant("publish.yml fetches the Krebs tp adapters and points here; on a workstation the suites find them as a sibling checkout instead", ["tests/pjan-23-regressions.mjs", "tests/pjan-50-regressions.mjs"]),
  PJ_PROPERTY_ITERATIONS: grant("operator knob: a longer property run", ["tests/pjan-135-skill-roots-property.mjs"]),
  PJ_PROPERTY_SEED: grant("operator knob: reproduce a property-run failure", ["tests/pjan-135-skill-roots-property.mjs"]),
  PJ_SKILLEX_TEST_TARBALL: grant("operator knob: test a local @delorenj/skillex tarball", ["tests/skillex-init-regressions.mjs"]),
  GITHUB_TOKEN: grant("the real BMAD installer resolves module tags through the GitHub API; publish.yml passes the job's read-only token so a shared runner IP does not exhaust the anonymous 60 requests/hour. The ONE deliberate credential passthrough", NETWORK_CONTRACTS),
  SSL_CERT_FILE: grant("TLS trust anchor for the real installer's npm/GitHub traffic (public certificates, not a secret; see the TLS/proxy decision above)", NETWORK_CONTRACTS),
  NODE_EXTRA_CA_CERTS: grant("TLS trust anchor for the real installer's npm/GitHub traffic (public certificates, not a secret; see the TLS/proxy decision above)", NETWORK_CONTRACTS),
  npm_config_cache: grant("the surface oracle's npx keeps the operator's chosen npm cache when one is configured", ["tests/pjan-180-surface-oracle.mjs"]),
});

/** The SUITE_PASSTHROUGH names granted to `suite` (a repo-relative path). */
export function suiteGrants(suite) {
  return Object.keys(SUITE_PASSTHROUGH).filter((name) => SUITE_PASSTHROUGH[name].suites.includes(suite));
}

/**
 * Suites allowed to resolve the operator's REAL home (the passwd entry, which
 * HOME isolation cannot hide) through `operatorHome()` in hermetic-suite.mjs,
 * each with the reason. Read-only uses only. Empty is the steady state.
 * scripts/check-hermetic-test-env.mjs fails a test file that calls
 * os.userInfo() itself instead of going through operatorHome().
 */
export const OPERATOR_HOME_READERS = new Map([
  ["tests/pjan-182-crank-interval-regressions.mjs",
    "engine parity: runs the operator's installed zcrank engine (~/.agents/tools/jev-clairic/bin/zcrank.py, read-only) against the same throwaway redis; skipped when it is not installed (CI)"],
  ["tests/pjan-67-trusted-lifecycle-regressions.mjs",
    "locates the UV-tool Copier under the OS account home (~/.local/share/uv/tools/copier, read-only), the same anchor src/lifecycle/preflight.ts trusts via userInfo(); a PATH or HOME lookup would find a different, untrusted copier"],
]);

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
