// PJAN-198: a dynamic guard on the one read HOME isolation cannot hide.
//
// The hermetic-suite preamble points HOME at a scratch directory, so
// os.homedir() and every `~` default resolve there. os.userInfo().homedir does
// not: it reads the passwd entry, the operator's REAL account home. That is
// deliberate in product code. src/lifecycle/preflight.ts anchors the Copier
// trust root to it (`options.homeDir ?? userInfo().homedir`, PJAN-67/PJAN-150)
// precisely so an ambient HOME cannot redirect it; tests inject a synthetic
// account home with `homeDir`, production MCP callers cannot. Product
// behaviour stays as it is, so the test side must make every such read
// visible instead.
//
// installOperatorHomeGuard(suite) wraps os.userInfo (the CommonJS export and,
// through syncBuiltinESMExports, every `import { userInfo } from "node:os"`
// binding, including the ones in esbuild bundles of src/) so the returned
// object's `homedir` is a getter. Reading `username`, `uid` and the rest is
// untouched; reading `homedir` from a suite that OPERATOR_HOME_READERS
// (tests/helpers/hermetic-env.mjs) does not list:
//   - is recorded with the stack that read it,
//   - throws at once, naming the list, so the failure points at the caller,
//   - and fails the process at exit even if the caller swallowed the throw.
// A listed suite reads the real value; those are read-only uses with a written
// reason.
//
// Two ways in:
//   - the preamble (tests/helpers/hermetic-suite.mjs) installs it for every
//     registered suite process, keyed by that suite;
//   - a bundled TypeScript suite runs in a CHILD of its launcher, which never
//     loads the preamble, so the launcher starts it with
//     BUNDLED_CHILD_GUARD from the preamble (`node --import
//     ./operator-home-guard-preload.mjs`, plus PJ_OPERATOR_HOME_GUARD_SUITE
//     naming the launcher). The child is judged as
//     its launcher: the launcher is the registered suite, and its
//     OPERATOR_HOME_READERS entry carries the reason.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { OPERATOR_HOME_READERS } from "./hermetic-env.mjs";

/** The unwrapped os.userInfo, captured before any guard. operatorHome() reads through this. */
export const accountUserInfo = os.userInfo;

/** The env name a bundled child's launcher sets to the launcher's suite path. */
export const GUARD_SUITE_ENV = "PJ_OPERATOR_HOME_GUARD_SUITE";

const STATE = Symbol.for("pjangler.operatorHomeGuard");

/** The installed guard's state, or undefined: { suite, allowed, reads: [{ stack }] }. */
export function operatorHomeGuard() {
  return globalThis[STATE];
}

/**
 * Wrap os.userInfo for `suite` (repo-relative). Idempotent: a second call keeps
 * the first suite.
 */
export function installOperatorHomeGuard(suite, readers = OPERATOR_HOME_READERS) {
  if (globalThis[STATE]) return globalThis[STATE];
  const state = { suite, allowed: readers.has(suite), reads: [] };
  globalThis[STATE] = state;
  if (state.allowed) return state;
  const refuse = () => {
    const error = new Error(`${suite || "this process"} read os.userInfo().homedir, the operator's REAL account home, in-process. `
      + "Pass a synthetic home explicitly (preflightTrustedCopier's homeDir), or list the suite in OPERATOR_HOME_READERS "
      + "in tests/helpers/hermetic-env.mjs with the read-only reason");
    state.reads.push({ stack: error.stack });
    throw error;
  };
  os.userInfo = function userInfo(...args) {
    const info = accountUserInfo.apply(this, args);
    const guarded = { ...info };
    Object.defineProperty(guarded, "homedir", { enumerable: true, configurable: true, get: refuse });
    return guarded;
  };
  syncBuiltinESMExports();
  process.on("exit", () => {
    if (!state.reads.length) return;
    process.stderr.write(`\nPJAN-198 operator-home guard: ${state.reads.length} in-process read(s) of the real account home from ${suite || "this process"}:\n`
      + state.reads.map(({ stack }) => `${stack}\n`).join("\n"));
    process.exitCode = 1;
  });
  return state;
}
