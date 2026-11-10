import { BUNDLED_CHILD_GUARD, SUITE, operatorHome } from "./helpers/hermetic-suite.mjs";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { OPERATOR_HOME_READERS, hermeticEnv, hermeticScratch } from "./helpers/hermetic-env.mjs";
import { GUARD_SUITE_ENV, operatorHomeGuard } from "./helpers/operator-home-guard.mjs";

// PJAN-198: the operator-home guard, proven against real src.
//
// src/lifecycle/preflight.ts anchors the Copier trust root to the OS account
// home, `options.homeDir ?? userInfo().homedir`, on purpose (PJAN-67/PJAN-150):
// an ambient HOME must not redirect it. The hermetic-suite preamble therefore
// cannot hide that read by isolating HOME, and src does not change for tests.
// Instead tests/helpers/operator-home-guard.mjs makes every in-process read of
// os.userInfo().homedir from a suite OPERATOR_HOME_READERS does not list throw
// and fail the process. This suite runs small scripts that start from the
// preamble as an UNLISTED suite and calls the real, bundled src function:
//
//   - preflightTrustedCopier WITHOUT homeDir must fail, naming the list and the
//     src frame; WITH a synthetic homeDir it must not;
//   - userInfo().username stays readable; only homedir is guarded;
//   - a read the caller swallows still fails the process at exit;
//   - CommonJS require("node:os") is guarded as well as ESM imports;
//   - a bundled TypeScript suite's CHILD, started with BUNDLED_CHILD_GUARD, is
//     judged as its launcher: unlisted fails, listed reads the real home.

const root = resolve(import.meta.dirname, "..");
const cache = join(root, "node_modules", ".cache");
const tag = `pjan-198-guard-${process.pid}`;
const preamble = pathToFileURL(join(root, "tests", "helpers", "hermetic-suite.mjs")).href;
const bundle = join(cache, `${tag}-src.mjs`);
const written = [bundle];
process.on("exit", () => { for (const path of written) rmSync(path, { force: true }); });
mkdirSync(cache, { recursive: true });
buildSync({
  stdin: { contents: 'export { preflightTrustedCopier } from "./src/lifecycle/preflight";', resolveDir: root },
  outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning",
});

const scratch = hermeticScratch("pjan-198-guard-");
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

/** Write a script under node_modules/.cache (an UNLISTED suite path) and run it. */
let seq = 0;
function runScript(body, { preambleFirst = true, execArgv = [], env = {} } = {}) {
  const path = join(cache, `${tag}-${++seq}.mjs`);
  written.push(path);
  writeFileSync(path, `${preambleFirst ? `import ${JSON.stringify(preamble)};\n` : ""}${body}\n`);
  return spawnSync(process.execPath, [...execArgv, path], { cwd: root, encoding: "utf8", timeout: 120_000, env: hermeticEnv(env) });
}
const out = (run) => `status ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;

let checks = 0;
const checkpoint = (label) => { checks++; console.log(`PASS ${label}`); };

// ---- this suite process itself ---------------------------------------------
const guard = operatorHomeGuard();
assert.ok(guard, "the preamble installed the operator-home guard");
assert.equal(guard.suite, SUITE);
assert.equal(SUITE, "tests/pjan-198-operator-home-guard.mjs");
assert.equal(guard.allowed, false, "this suite is not in OPERATOR_HOME_READERS");
assert.throws(() => operatorHome(), /may not read the operator's real home: add it to OPERATOR_HOME_READERS/);
checkpoint("the preamble installs the guard for its own suite; operatorHome() refuses an unlisted suite");

// ---- an unlisted suite calling real src ------------------------------------
const importSrc = `import { preflightTrustedCopier } from ${JSON.stringify(pathToFileURL(bundle).href)};`;
const target = join(scratch, "target");

const withoutHome = runScript(`${importSrc}
const result = preflightTrustedCopier({ targetDir: ${JSON.stringify(target)}, env: { PATH: "/nonexistent" } });
console.log("RESULT", JSON.stringify(result));`);
assert.notEqual(withoutHome.status, 0, `preflightTrustedCopier without homeDir passed in an unlisted suite:\n${out(withoutHome)}`);
assert.match(withoutHome.stderr, /read os\.userInfo\(\)\.homedir, the operator's REAL account home, in-process/);
assert.match(withoutHome.stderr, /OPERATOR_HOME_READERS/);
assert.match(withoutHome.stderr, /at preflightTrustedCopier \(/, "the stack names the src function that read it");
assert.doesNotMatch(withoutHome.stdout, /RESULT/, "the read throws at the call, before src can use the real home");
checkpoint("src preflightTrustedCopier WITHOUT homeDir, in an unlisted suite: throws at the read and fails, naming the list and the src frame");

const syntheticHome = join(scratch, "account-home");
mkdirSync(syntheticHome, { recursive: true });
const withHome = runScript(`${importSrc}
const result = preflightTrustedCopier({ targetDir: ${JSON.stringify(target)}, env: { PATH: "/nonexistent" }, homeDir: ${JSON.stringify(syntheticHome)} });
console.log("RESULT", JSON.stringify(result));`);
assert.equal(withHome.status, 0, `preflightTrustedCopier WITH a synthetic homeDir failed:\n${out(withHome)}`);
assert.match(withHome.stdout, /RESULT \{"ok":false,"error":"copier not found on PATH"/, "src ran to its own verdict");
checkpoint("src preflightTrustedCopier WITH a synthetic homeDir: no real-home read, src runs to its own verdict");

const username = runScript(`import { userInfo } from "node:os";
console.log("USER", typeof userInfo().username, typeof userInfo().uid);`);
assert.equal(username.status, 0, out(username));
assert.match(username.stdout, /USER string number/);
checkpoint("userInfo().username and uid stay readable; only homedir is guarded");

const swallowed = runScript(`import { userInfo } from "node:os";
let home; try { home = userInfo().homedir; } catch { home = "fallback"; }
console.log("HOME", home);`);
assert.notEqual(swallowed.status, 0, `a swallowed real-home read passed:\n${out(swallowed)}`);
assert.match(swallowed.stdout, /HOME fallback/);
assert.match(swallowed.stderr, /PJAN-198 operator-home guard: 1 in-process read\(s\) of the real account home/);
checkpoint("a read the caller swallows still fails the process at exit");

const commonjs = runScript(`import { createRequire } from "node:module";
const os = createRequire(import.meta.url)("node:os");
console.log(os.userInfo().homedir);`);
assert.notEqual(commonjs.status, 0, `require("node:os").userInfo().homedir passed:\n${out(commonjs)}`);
assert.match(commonjs.stderr, /OPERATOR_HOME_READERS/);
checkpoint("CommonJS require(\"node:os\") is guarded as well as ESM imports");

// ---- a bundled child, judged as its launcher -------------------------------
const childBody = `import { userInfo } from "node:os";
console.log("ENV", ${JSON.stringify(GUARD_SUITE_ENV)} in process.env);
console.log("HOMEDIR", userInfo().homedir);`;
const asUnlisted = runScript(childBody, { preambleFirst: false, execArgv: BUNDLED_CHILD_GUARD.execArgv, env: { ...BUNDLED_CHILD_GUARD.env } });
assert.equal(BUNDLED_CHILD_GUARD.env[GUARD_SUITE_ENV], SUITE, "a launcher's children are judged as the launcher");
assert.notEqual(asUnlisted.status, 0, `a bundled child of an unlisted launcher read the real home:\n${out(asUnlisted)}`);
assert.match(asUnlisted.stdout, /ENV false/, "the preload removes the launcher name from the child env");
assert.match(asUnlisted.stderr, new RegExp(`${SUITE.replaceAll(".", "\\.")} read os\\.userInfo\\(\\)\\.homedir`));
const listed = "tests/pjan-67-lifecycle-preflight-regressions.mjs";
assert.ok(OPERATOR_HOME_READERS.has(listed));
const asListed = runScript(childBody, { preambleFirst: false, execArgv: BUNDLED_CHILD_GUARD.execArgv, env: { [GUARD_SUITE_ENV]: listed } });
assert.equal(asListed.status, 0, `a bundled child of a listed launcher was refused:\n${out(asListed)}`);
const childHome = asListed.stdout.match(/HOMEDIR (.+)/)?.[1];
assert.ok(childHome && childHome.startsWith("/"), "a listed launcher's child reads the real account home");
assert.notEqual(childHome, hermeticEnv().HOME, "the account home is not the child's isolated HOME");
const noSuite = runScript(childBody, { preambleFirst: false, execArgv: BUNDLED_CHILD_GUARD.execArgv });
assert.notEqual(noSuite.status, 0, "the preload refuses to run without a launcher name");
assert.match(noSuite.stderr, /PJ_OPERATOR_HOME_GUARD_SUITE is not set/);
checkpoint("bundled child: judged as its launcher (unlisted fails, listed reads the real home), and the launcher name never reaches child code");

console.log(`PJAN-198 operator-home guard: ${checks} groups passed.`);
