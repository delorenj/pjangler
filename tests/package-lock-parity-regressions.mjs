import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "pjangler-lock-parity-"));
const fixtureScriptDir = join(temp, "scripts");
const fixtureChecker = join(fixtureScriptDir, "check-package-lock-parity.mjs");

const writeJson = (path, value) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const runChecker = () => spawnSync(process.execPath, [fixtureChecker], {
  cwd: temp,
  encoding: "utf8",
});

try {
  mkdirSync(fixtureScriptDir);
  cpSync(join(root, "scripts", "check-package-lock-parity.mjs"), fixtureChecker);

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  writeJson(join(temp, "package.json"), pkg);
  writeJson(join(temp, "package-lock.json"), lock);

  const exact = runChecker();
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /package-lock parity: PASS/);

  delete lock.packages[""].bin["pjangler-prompt"];
  writeJson(join(temp, "package-lock.json"), lock);

  const omittedPromptBin = runChecker();
  assert.notEqual(
    omittedPromptBin.status,
    0,
    "lock parity must reject a root bin map that omits pjangler-prompt",
  );
  assert.match(omittedPromptBin.stderr, /root bin map differs/);
  assert.doesNotMatch(omittedPromptBin.stdout, /package-lock parity: PASS/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("package-lock root metadata parity regressions passed (omitted pjangler-prompt rejected)");
