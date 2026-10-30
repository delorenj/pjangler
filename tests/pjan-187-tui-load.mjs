import "./helpers/hermetic-suite.mjs";
// PJAN-187 — loadScreen must tell "the screen is not built" apart from "the screen is built
// but one of ITS imports cannot be resolved". Node raises ERR_MODULE_NOT_FOUND for both, so
// the old loader sent everyone to `npm run build` — useless advice when what is missing is
// the `ink` package in node_modules (a checkout without `npm ci`, or a global install whose
// node_modules was pruned), which only installing dependencies can fix.
//
// The classification is pinned here on REAL files with REAL dynamic imports:
//   - absent screen          -> TuiUnavailableError "not built (run: npm run build)"
//   - missing bare package   -> TuiUnavailableError naming the package and the importer,
//                              with an install remedy (never "npm run build")
//   - missing relative chunk -> same, naming the chunk path and the importer
//   - missing transitive dep -> same, naming the missing peer and the node_modules importer
//   - syntax error / a throw at evaluation / a screen-thrown error that merely CARRIES the
//     ERR_MODULE_NOT_FOUND code -> propagate unchanged, never disguised
//
// Plus one end-to-end case through the real CLI: a temp install (dist + package.json +
// node_modules assembled WITHOUT ink) whose `pj crank tui` must print the one-liner and exit
// 1, driven on a PTY against a throwaway redis-server — never 6379, the live crank Redis.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startThrowawayRedis } from "./pjan-182-crank-regressions-helpers.mjs";
import { runOnPty } from "./helpers/pty-run.mjs";

const root = resolve(import.meta.dirname, "..");
const pj = join(root, "dist", "index.js");
assert.ok(existsSync(pj), "dist/index.js missing: run `npm run build` first");
assert.ok(existsSync(join(root, "dist", "crank", "tui.js")), "dist/crank/tui.js missing: run `npm run build` first");

// The kit: loadScreen bundled out of src (inline source map so the lines these tests execute
// count toward c8 as src/tui/load.ts, not as a scratch file).
const workspace = mkdtempSync(join(tmpdir(), "pjan-187-load-"));
writeFileSync(
  join(workspace, "entry.ts"),
  `export { loadScreen, TuiUnavailableError } from ${JSON.stringify(join(root, "src/tui/load.ts"))};\n`,
);
const kitOut = join(workspace, "kit.mjs");
const built = spawnSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [join(workspace, "entry.ts"), "--bundle", "--packages=external", "--platform=node", "--format=esm", "--sourcemap=inline", `--outfile=${kitOut}`],
  { encoding: "utf8", env: hermeticEnv() },
);
if (built.status !== 0) {
  console.error(`failed to bundle the loadScreen kit:\n${built.stderr}`);
  process.exit(1);
}
const { loadScreen, TuiUnavailableError } = await import(kitOut);

const rs = await startThrowawayRedis();
let failed;
try {
  const dist = join(workspace, "dist", "crank");
  mkdirSync(dist, { recursive: true });
  const base = pathToFileURL(join(workspace, "dist", "index.js")).href;
  const screen = (name, code) => writeFileSync(join(dist, name), code);

  console.log("absent screen: TuiUnavailableError keeps the 'not built' guidance and the looked-for path");
  {
    await assert.rejects(loadScreen("./crank/absent.js", base), (error) => {
      assert.ok(error instanceof TuiUnavailableError);
      assert.match(error.message, /TUI screen \.\/crank\/absent\.js is not built \(run: npm run build\)/);
      assert.match(error.message, /looked for .*dist\/crank\/absent\.js/);
      assert.doesNotMatch(error.message, /dependencies are not installed/, "an absent screen is not a dependency problem");
      return true;
    });
  }

  console.log("built screen, missing bare package: names the package and the importer, remedy installs deps");
  {
    screen("needs-bare.js", "import 'no-such-package-pjan-187';\nexport const m = 1;\n");
    await assert.rejects(loadScreen("./crank/needs-bare.js", base), (error) => {
      assert.ok(error instanceof TuiUnavailableError, "the screen cannot run, so it is still unavailable");
      assert.match(error.message, /TUI screen \.\/crank\/needs-bare\.js is built but its dependencies are not installed/);
      assert.match(error.message, /cannot find package 'no-such-package-pjan-187' imported by .*\/dist\/crank\/needs-bare\.js/);
      assert.match(error.message, /run npm ci in this checkout, or reinstall the global package \(npm i -g @delorenj\/pjangler\)/);
      assert.doesNotMatch(error.message, /npm run build/, "the screen IS built; a rebuild cannot help");
      return true;
    });
  }

  console.log("built screen, missing relative chunk: names the chunk path and the importer");
  {
    screen("needs-chunk.js", "import './missing-chunk.js';\nexport const m = 1;\n");
    await assert.rejects(loadScreen("./crank/needs-chunk.js", base), (error) => {
      assert.ok(error instanceof TuiUnavailableError);
      assert.match(error.message, /is built but its dependencies are not installed/);
      assert.match(error.message, /cannot find module '.*\/dist\/crank\/missing-chunk\.js' imported by .*\/dist\/crank\/needs-chunk\.js/);
      assert.doesNotMatch(error.message, /npm run build/);
      return true;
    });
  }

  console.log("built screen, missing transitive dependency: names the missing peer and the node_modules importer");
  {
    mkdirSync(join(workspace, "node_modules", "transitive-pjan-187"), { recursive: true });
    writeFileSync(join(workspace, "node_modules", "transitive-pjan-187", "index.js"), "import 'missing-peer-pjan-187';\nexport const m = 1;\n");
    screen("needs-transitive.js", "import 'transitive-pjan-187';\nexport const m = 1;\n");
    await assert.rejects(loadScreen("./crank/needs-transitive.js", base), (error) => {
      assert.ok(error instanceof TuiUnavailableError);
      assert.match(error.message, /cannot find package 'missing-peer-pjan-187' imported by .*node_modules\/transitive-pjan-187\/index\.js/);
      assert.match(error.message, /run npm ci in this checkout/);
      return true;
    });
  }

  console.log("every other import failure propagates unchanged: never disguised as TuiUnavailableError");
  {
    screen("syntax.js", "export const = broken(\n");
    await assert.rejects(loadScreen("./crank/syntax.js", base), (error) => {
      assert.ok(!(error instanceof TuiUnavailableError), "a syntax error is its own error");
      assert.ok(error instanceof SyntaxError);
      return true;
    });

    screen("throws.js", "throw new Error('screen blew up on load');\n");
    await assert.rejects(loadScreen("./crank/throws.js", base), (error) => {
      assert.ok(!(error instanceof TuiUnavailableError), "a thrown error is its own error");
      assert.match(error.message, /screen blew up on load/);
      return true;
    });

    // a screen-thrown error that merely CARRIES the code is not Node's resolver failing: the
    // loader must not reword it just because the code matches.
    screen("fake.js", "const e = new Error('pretend the resolver failed'); e.code = 'ERR_MODULE_NOT_FOUND'; throw e;\n");
    await assert.rejects(loadScreen("./crank/fake.js", base), (error) => {
      assert.ok(!(error instanceof TuiUnavailableError), "an ERR_MODULE_NOT_FOUND with another cause is not ours to reword");
      assert.match(error.message, /pretend the resolver failed/);
      assert.equal(error.code, "ERR_MODULE_NOT_FOUND", "the original error arrives untouched");
      return true;
    });

    // the code gate leads: even a stack that NAMES the resolver's own frames cannot get an
    // error that is not ERR_MODULE_NOT_FOUND reworded — the two signals veto independently.
    screen("spoof.js", "const e = new Error('not from the resolver'); e.stack = \"Error: not from the resolver\\n    at finalizeResolution (node:internal/modules/esm/resolve:272:11)\\n    at Object.<anonymous> (spoof.js:1:1)\"; throw e;\n");
    await assert.rejects(loadScreen("./crank/spoof.js", base), (error) => {
      assert.ok(!(error instanceof TuiUnavailableError), "no ERR_MODULE_NOT_FOUND code, no rewording — whatever the stack claims");
      assert.match(error.message, /not from the resolver/);
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // End to end: the real CLI, from a real install whose node_modules lacks ink
  // -------------------------------------------------------------------------
  console.log("e2e: `pj crank tui` in an install without ink prints the one-liner and exits 1");
  {
    // A throwaway install: the built dist, a package.json, and node_modules assembled from
    // the real one MINUS ink — never by touching the real node_modules itself.
    const install = join(workspace, "install");
    mkdirSync(join(install, "dist"), { recursive: true });
    cpSync(join(root, "dist"), join(install, "dist"), { recursive: true });
    writeFileSync(join(install, "package.json"), `${JSON.stringify({ name: "@delorenj/pjangler", version: "0.0.0-local", type: "module" }, null, 2)}\n`);
    mkdirSync(join(install, "node_modules"));
    for (const entry of readdirSync(join(root, "node_modules"), { withFileTypes: true })) {
      if (entry.name === "ink") continue; // the screen's dependency this install is missing
      symlinkSync(join(root, "node_modules", entry.name), join(install, "node_modules", entry.name), entry.isDirectory() ? "dir" : "file");
    }
    assert.ok(!existsSync(join(install, "node_modules", "ink")), "the install must lack ink for this case");
    assert.ok(existsSync(join(install, "node_modules", "commander")), "the entry's own deps are present");

    // A PATH with what the crank path shells out to (redis-cli; no zellij: the degrade path).
    const which = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: hermeticEnv() }).stdout.trim();
    const bin = join(workspace, "bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["env", "timeout", "redis-cli"]) symlinkSync(which(tool), join(bin, tool));

    // A project to stand in, and a registry that does not exist (the manifest is enough).
    const project = join(workspace, "project");
    mkdirSync(project);
    writeFileSync(join(project, ".project.json"), JSON.stringify({ project_id: "pjan187", project_name: "Pjan187" }));

    const r = runOnPty({
      argv: [process.execPath, join(install, "dist", "index.js"), "crank", "tui"],
      cwd: project,
      env: hermeticEnv({
        PATH: bin,
        HOME: workspace,
        GIT_CEILING_DIRECTORIES: workspace,
        NO_COLOR: "1",
        TERM: "xterm-256color",
        ZCRANK_REDIS_HOST: "127.0.0.1",
        ZCRANK_REDIS_PORT: String(rs.port),
        PJ_PROJECT_REGISTRY: join(workspace, "absent-registry.yaml"),
      }),
      steps: [{ wait: "dependencies are not installed" }],
    });
    assert.equal(r.timedOut, false, r.output);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /TUI screen \.\/crank\/tui\.js is built but its dependencies are not installed/);
    assert.match(r.output, /cannot find package 'ink' imported by .*install\/dist\/crank\/tui\.js/);
    assert.match(r.output, /run npm ci in this checkout, or reinstall the global package \(npm i -g @delorenj\/pjangler\)/);
    assert.doesNotMatch(r.output, /npm run build/, "the screen is built; the operator is not sent to rebuild");
  }
} catch (error) {
  failed = error;
} finally {
  await rs.stop();
  rmSync(workspace, { recursive: true, force: true });
}
if (failed) throw failed;
console.log("PJAN-187 tui load regressions: all green");
